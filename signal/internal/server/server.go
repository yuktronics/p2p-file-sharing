package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"signal/internal/rooms"
)

// Config mirrors docs/CONFIG.md.
type Config struct {
	Addr         string
	BaseURL      string
	WebDir       string
	Grace        time.Duration
	PingInterval time.Duration
	MaxMsg       int
	TurnHost     string
	TurnSecret   string
	TurnTTL      time.Duration
	TurnRealm    string
	Turn2Host    string
	Turn2Secret  string
	StunURL      string

	RateCreatePerMin int
	RateTurnPerMin   int
	RateReportPerMin int
	// ReportLog is the file abuse reports are appended to. Empty keeps them
	// in memory only, which loses every report on restart.
	ReportLog string
	// UsageFile persists the anonymous success counter. Empty = the count
	// resets on restart. Holds one integer and nothing else.
	UsageFile string
	// MetricsPassword unlocks /metrics in a browser (see metricsgate.go).
	// Unset = the bearer-token-only behaviour, unchanged. Kept separate from
	// AdminToken on purpose: one is pasted into scripts, the other into a web
	// page, and conflating them means a leaked page password is a leaked admin
	// API credential.
	MetricsPassword  string
	RateNearbyPerMin int
	// RateUsagePerMin bounds anonymous success-counter posts per client IP.
	// Not env-wired on purpose: it is a fixed product decision (the counter is
	// one integer, and the client batches deltas), not an operator dial. It is a
	// Config field rather than a constant so the rate-limit test can inject a
	// drained limiter BEFORE New starts reapLoop — swapping s.usageLimit
	// afterwards raced the sweep goroutine, which `go test -race` caught.
	RateUsagePerMin int
	TrustProxy      bool
	AdminToken      string
	AllowedOrigins  []string
	EnableDebug     bool
	PublicMetrics   bool
	SiteURL         string
	AppVersion      string
	// DisableUI makes this an API-only host: every UI/asset route 404s and
	// robots.txt disallows everything. Set it on split deployments where the
	// face lives on Pages — otherwise the API host serves a duplicate site.
	// Zero value (serve UI) keeps dev, tests and single-origin mode unchanged.
	DisableUI bool
}

type Server struct {
	cfg   Config
	store *rooms.Store
	mux   *http.ServeMux

	wsConns     atomic.Int64
	turnMinted  atomic.Int64
	roomCreates atomic.Int64
	framesIn    atomic.Int64
	rateLimited atomic.Int64
	writeErrors atomic.Int64
	routeErrors atomic.Int64
	// reportLogErrors counts reports the durable log refused (or could not
	// rotate). Abuse reporting silently lost durability for months because this
	// error was discarded; the counter is the operator's only signal.
	reportLogErrors atomic.Int64

	createLimit  *Limiter
	turnLimit    *Limiter
	reportLimit  *Limiter
	usageLimit   *Limiter
	metricsLimit *Limiter
	usageOK      atomic.Int64
	usageDirty   atomic.Int32
	usageFile    string
	nearbyLimit  *Limiter
	static       *staticCache
}

func New(cfg Config) (*Server, error) {
	if cfg.RateCreatePerMin <= 0 {
		cfg.RateCreatePerMin = 10
	}
	if cfg.RateTurnPerMin <= 0 {
		cfg.RateTurnPerMin = 30
	}
	if cfg.RateReportPerMin <= 0 {
		cfg.RateReportPerMin = 5
	}
	if cfg.RateNearbyPerMin <= 0 {
		cfg.RateNearbyPerMin = 20
	}
	if cfg.RateUsagePerMin <= 0 {
		cfg.RateUsagePerMin = usagePerMin
	}
	// Durations are defaulted here too, not just the rate limits: PingInterval
	// and Grace reach time.NewTicker/time.Timer per connection, and a
	// non-positive interval panics. cmd/signal validates them via mustDur, but
	// New is public and any other caller passing a zero Config would crash the
	// process from inside a request goroutine.
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = 25 * time.Second
	}
	if cfg.Grace <= 0 {
		cfg.Grace = 10 * time.Second
	}
	if cfg.MaxMsg <= 0 {
		cfg.MaxMsg = 32768
	}
	if len(cfg.AllowedOrigins) == 0 {
		cfg.AllowedOrigins = defaultAllowedOrigins()
	}
	// The canonical/origin URL comes from SIGNAL_SITE_URL when set, otherwise it
	// falls back to SIGNAL_PUBLIC_BASE_URL. Both are the same thing in a
	// single-host deployment, but the split deployment (Pages frontend + own Go
	// backend) needs them to differ: canonicals and og:url must point at the
	// FRONTEND, not the API host.
	if cfg.SiteURL == "" {
		cfg.SiteURL = cfg.BaseURL
	}
	s := &Server{
		cfg: cfg, store: rooms.NewStore(cfg.Grace), mux: http.NewServeMux(),
		createLimit:  NewLimiter(cfg.RateCreatePerMin, time.Minute),
		turnLimit:    NewLimiter(cfg.RateTurnPerMin, time.Minute),
		reportLimit:  NewLimiter(cfg.RateReportPerMin, time.Minute),
		usageLimit:   NewLimiter(cfg.RateUsagePerMin, time.Minute),
		metricsLimit: NewLimiter(metricsPasswordPerMin, time.Minute),
		nearbyLimit:  NewLimiter(cfg.RateNearbyPerMin, time.Minute),
	}
	s.store.SetMaxPeers(maxPeersPerRoom)
	// Attach the durable abuse-report log. A bad path must not take the whole
	// server down — reports would then be lost silently, which is the failure
	// this exists to prevent — so the error is surfaced on /metrics and
	// reporting falls back to memory.
	if cfg.ReportLog != "" {
		if rl, err := rooms.OpenReportLog(cfg.ReportLog); err != nil {
			log.Printf("report log disabled: %v (reports stay in memory only)", err)
		} else {
			s.store.SetReportLog(rl)
		}
	}

	if cfg.UsageFile != "" {
		s.usageFile = cfg.UsageFile
	}
	s.startUsagePersist()

	// Substitute the absolute site URL into each page's search metadata. Set
	// before loadStatic so it runs inside the single load pass, before hashing.
	siteCfg := cfg.SiteURL
	assets, err := loadStatic(cfg.WebDir, map[string]struct {
		file       string
		ctype      string
		html       bool
		standalone bool
	}{"/": {"index.html", "text/html; charset=utf-8", true, false},
		"/receive": {"receive.html", "text/html; charset=utf-8", true, false},
		"/report":  {"report.html", "text/html; charset=utf-8", true, false},
		// Public privacy policy. Google Play requires a reachable policy URL in
		// the store listing, so it has to be served by the product itself rather
		// than living in a repo README nobody can open.
		"/privacy": {"privacy.html", "text/html; charset=utf-8", true, false},
		"/contact": {"contact.html", "text/html; charset=utf-8", true, false},
		// Blog: index + one evergreen guide per slug. Served as explicit
		// route->file entries like every other page — no directory serving.
		// The slugs are allowlisted again in handleBlog, so an unknown
		// /blog/<slug> 404s rather than leaking a filesystem probe.
		"/blog":                                {"blog.html", "text/html; charset=utf-8", true, false},
		"/blog/send-large-files-no-size-limit": {"blog/send-large-files-no-size-limit.html", "text/html; charset=utf-8", true, false},
		"/blog/wetransfer-alternative":         {"blog/wetransfer-alternative.html", "text/html; charset=utf-8", true, false},
		"/blog/send-files-without-account":     {"blog/send-files-without-account.html", "text/html; charset=utf-8", true, false},
		"/blog/is-p2p-file-sharing-safe":       {"blog/is-p2p-file-sharing-safe.html", "text/html; charset=utf-8", true, false},
		"/blog/send-large-videos-photos":       {"blog/send-large-videos-photos.html", "text/html; charset=utf-8", true, false},
		// Dev-only harness, self-contained (own inline <style>, no external
		// stylesheet) → exempt from the inline-CSS transform.
		"/debug": {"debug.html", "text/html; charset=utf-8", true, true},
		// Both stylesheets are loaded as SOURCES for the inline transform
		// (static.go inlineStyles) — they have no route because the HTML no
		// longer references them: a separate render-blocking request is exactly
		// what the inline form exists to avoid.
		"/styles.css": {"styles.css", "text/css; charset=utf-8", false, false},
		"/states.css": {"states.css", "text/css; charset=utf-8", false, false},
		"/app.js":     {"app.js", "text/javascript; charset=utf-8", false, false},
		"/qrcode.js":  {"qrcode.js", "text/javascript; charset=utf-8", false, false},
		"/sw.js":      {"sw.js", "text/javascript; charset=utf-8", false, false},
		// Social share card (referenced by og:image / twitter:image on every
		// page) and real icon files. Google reads favicons from a real URL far
		// more reliably than from the inline data: URI the pages also carry.
		"/og.png":               {"og.png", "image/png", false, false},
		// Interactive architecture viewer (archify artifact). Standalone page
		// with its own styles: exempt from the inline-CSS transform like
		// /debug, but it still gets ETag/gzip below.
		"/architecture": {"architecture.html", "text/html; charset=utf-8", true, true},
		// Fullscreen wrapper around the viewer above (own file: the viewer is
		// generated, this chrome is hand-authored — never merge them).
		"/architecture-viewer": {"architecture-viewer.html", "text/html; charset=utf-8", true, true},
		// Security contact (RFC 9116). Plain text, no transforms to apply.
		// Served on BOTH hosts deliberately: researchers probe the API host
		// too, and contact info is not site content, so the DisableUI
		// no-second-copy rule does not apply to it.
		"/.well-known/security.txt": {".well-known/security.txt", "text/plain; charset=utf-8", false, false},
		"/favicon.svg":          {"favicon.svg", "image/svg+xml", false, false},
		"/favicon.ico":          {"favicon.ico", "image/x-icon", false, false},
		"/apple-touch-icon.png": {"apple-touch-icon.png", "image/png", false, false},
	},
		// Substitute the absolute site URL into each page's search metadata.
		// Runs inside the load pass, before the ETag is computed over the final
		// bytes — so a page's ETag changes when the site URL changes, which is
		// correct: the served document genuinely differs.
		func(html string) (string, error) { return injectSiteURL(html, siteCfg) },
	)
	if err != nil {
		return nil, err
	}
	// Fail closed on blog drift in either direction: every allowlisted slug
	// must have a loaded page, and every loaded /blog/* page must be
	// allowlisted. Otherwise one host serves (or the sitemap advertises) a URL
	// the other 404s — the classic split-deployment failure.
	for slug, route := range blogSlugs {
		if _, ok := assets.files[route]; !ok {
			return nil, fmt.Errorf("static blog %s: no asset loaded for route %s", slug, route)
		}
	}
	for route := range assets.files {
		if !strings.HasPrefix(route, "/blog/") {
			continue
		}
		found := false
		for _, r := range blogSlugs {
			if r == route {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("static blog: route %s loaded but not allowlisted in blogSlugs", route)
		}
	}
	s.static = assets
	s.routes()
	go s.reapLoop()
	return s, nil
}

func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serveCORS) }

// serveCORS wraps the mux with the security headers and the CORS allowlist.
// The Pages frontend is cross-origin by design, so CORS is required — but it is
// an ALLOWLIST, not "*": with "*" any website a user visits could mint rooms
// and file abuse reports against them using that user's browser.
func (s *Server) serveCORS(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	s.securityHeaders(h, r)
	origin := r.Header.Get("Origin")
	if origin != "" {
		if !originAllowed(origin, r, s.cfg.AllowedOrigins) {
			// Not allowed: no CORS headers at all. A browser caller gets a CORS
			// error instead of a silent success; a non-browser caller (curl, the
			// app) is unaffected because it sends no Origin.
			w.WriteHeader(http.StatusForbidden)
			return
		}
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		// Authorization (bearer token for /metrics and /api/admin/*) and
		// X-Metrics-Password (browser door for /metrics) must be listed, or a
		// preflighted cross-origin fetch carrying them is blocked by the
		// browser even from an allowlisted origin.
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Metrics-Password")
		h.Set("Access-Control-Max-Age", "86400")
		h.Add("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		// Same no-store as every other API answer: the pill is polled from
		// browsers and any shared cache may serve a stale backend as live.
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("ok"))
	})
	// Security contact for researchers (see signal/web/.well-known/security.txt).
	// No noindex: this file exists to be found. Registered BEFORE the DisableUI
	// gate on purpose: researchers probe the API host too, and contact info is
	// not site content, so the no-second-copy rule does not apply to it.
	s.mux.HandleFunc("GET /.well-known/security.txt", s.static.handler("/.well-known/security.txt"))
	if s.cfg.DisableUI {
		// API-only host (split deployment: the face lives on Pages). Every
		// UI/asset route 404s so the API host never serves a second copy of
		// the site — duplicate content across hosts confuses crawlers and
		// users alike. Registered FIRST and returns early so no UI route can
		// exist to conflict with these.
		// What stays: /healthz, /metrics, /api/*, /ws/*, /signal-config.json
		// (clients must still learn the backend address from here), and a
		// restrictive robots.txt so nothing on this host is indexed.
		for _, p := range []string{"/", "/r/{id}", "/report", "/report/", "/report/{id}", "/receive",
			"/privacy", "/privacy-policy", "/contact", "/architecture", "/architecture-viewer", "/blog", "/blog/", "/blog/{slug}", "/debug",
			"/app.js", "/qrcode.js", "/sw.js",
			"/og.png", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png",
			"/sitemap.xml"} {
			s.mux.HandleFunc("GET "+p, func(w http.ResponseWriter, r *http.Request) {
				http.NotFound(w, r)
			})
		}
		s.mux.HandleFunc("GET /robots.txt", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			io.WriteString(w, "User-agent: *\nDisallow: /\n")
		})
		// API surface only. Duplicated here (rather than falling through) so this
		// branch returns early and no UI route can ever conflict with the 404s.
		s.mux.HandleFunc("POST /api/usage", s.handleUsage)
		s.mux.HandleFunc("POST /api/rooms", s.handleCreate)
		s.mux.HandleFunc("GET /api/rooms/{id}", s.handleGet)
		s.mux.HandleFunc("DELETE /api/rooms/{id}", s.handleDelete)
		s.mux.HandleFunc("POST /api/rooms/{id}/report", s.handleReport)
		s.mux.HandleFunc("GET /api/admin/reports", s.handleAdminReports)
		s.mux.HandleFunc("POST /api/admin/rooms/{id}/disable", s.handleAdminDisable)
		s.mux.HandleFunc("GET /api/rooms/{id}/turn", s.handleTURN)
		s.mux.HandleFunc("GET /api/nearby/{code}", s.handleNearby)
		s.mux.HandleFunc("GET /ws/rooms/{id}", s.handleWS)
		s.mux.HandleFunc("GET /signal-config.json", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			io.WriteString(w, s.remoteConfigJSON())
		})
		s.mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
			if s.serveMetricsGate(w, r) {
				return
			}
			s.handleMetrics(w, r)
		})
		return
	}
	// Crawler files, generated because both depend on the absolute site URL
	// (see seo.go for why room paths are allowed here despite being noindexed).
	s.mux.HandleFunc("GET /robots.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		io.WriteString(w, s.robotsTxt())
	})
	s.mux.HandleFunc("GET /sitemap.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		io.WriteString(w, s.sitemapXML())
	})
	// The remotely-updatable backend address. Clients fetch this at startup and
	// adopt whatever it names; the address baked into an installed app is only a
	// fallback. no-store is load-bearing — a cached copy is what makes a backend
	// change appear to be ignored. See docs/DEPLOY.md.
	s.mux.HandleFunc("GET /signal-config.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		io.WriteString(w, s.remoteConfigJSON())
	})
	// Metrics are counters only (no ids, no IPs), but they are still an
	// operational picture an attacker can probe against, and a scrape load.
	// Default: admin token required. Opt back in with PUBLIC_METRICS=1.
	s.mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		if s.serveMetricsGate(w, r) {
			return
		}
		s.handleMetrics(w, r)
	})
	s.mux.HandleFunc("POST /api/usage", s.handleUsage)
	s.mux.HandleFunc("POST /api/rooms", s.handleCreate)
	s.mux.HandleFunc("GET /api/rooms/{id}", s.handleGet)
	s.mux.HandleFunc("DELETE /api/rooms/{id}", s.handleDelete)
	s.mux.HandleFunc("POST /api/rooms/{id}/report", s.handleReport)
	s.mux.HandleFunc("GET /api/admin/reports", s.handleAdminReports)
	s.mux.HandleFunc("POST /api/admin/rooms/{id}/disable", s.handleAdminDisable)
	s.mux.HandleFunc("GET /api/rooms/{id}/turn", s.handleTURN)
	s.mux.HandleFunc("GET /api/nearby/{code}", s.handleNearby)
	s.mux.HandleFunc("GET /ws/rooms/{id}", s.handleWS)
	// Product UI + debug harness via preloaded cache (static.go): ETag/304,
	// gzip, zero disk I/O. Explicit route→file map — no directory serving.
	s.mux.HandleFunc("GET /", s.handleIndex)
	// Per-room URLs: an unbounded set (one per transfer), never meant to be in
	// an index. Marked with a header rather than a meta tag because /r/{id} and
	// /receive are the SAME file — only the handler knows which is being served.
	// These paths stay ALLOW-listed in robots.txt on purpose: a disallow there
	// would stop crawlers reading this header at all (see seo.go).
	s.mux.HandleFunc("GET /r/{id}", s.static.noindex(s.static.handler("/receive")))
	s.mux.HandleFunc("GET /report/{id}", s.static.noindex(s.static.handler("/report")))
	// Bare /report serves the same form (the page reads the id from the path
	// and degrades to manual entry without one — see report.html). Trailing
	// slash 301s to the canonical, mirroring /blog above.
	s.mux.HandleFunc("GET /report", s.static.noindex(s.static.handler("/report")))
	s.mux.HandleFunc("GET /report/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/report", http.StatusMovedPermanently)
	})
	s.mux.HandleFunc("GET /receive", s.static.handler("/receive"))
	s.mux.HandleFunc("GET /privacy", s.static.handler("/privacy"))
	s.mux.HandleFunc("GET /contact", s.static.handler("/contact"))
	// Interactive system diagram (archify). A stable public page, indexable
	// like the blog — not a room secret. 404s on the API host with the rest.
	// /architecture is the fullscreen-capable wrapper; /architecture-viewer is
	// the generated viewer it embeds (linked only from the wrapper, never
	// advertised alone).
	s.mux.HandleFunc("GET /architecture", s.static.framable(s.static.handler("/architecture")))
	s.mux.HandleFunc("GET /architecture-viewer", s.static.framable(s.static.handler("/architecture-viewer")))
	// Blog index, with and without the trailing slash. The posts hang off
	// GET /blog/{slug} below, allowlisted by slug.
	s.mux.HandleFunc("GET /blog", s.static.handler("/blog"))
	// Trailing slash redirects rather than serving a duplicate: the canonical
	// is /blog, and the Pages host 301s identically (see _redirects in
	// build-pages.mjs) — so both hosts agree and no second indexable copy
	// exists to fork the canonical.
	s.mux.HandleFunc("GET /blog/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/blog", http.StatusMovedPermanently)
	})
	s.mux.HandleFunc("GET /blog/{slug}", s.handleBlog)
	s.mux.HandleFunc("GET /app.js", s.static.handler("/app.js"))
	s.mux.HandleFunc("GET /qrcode.js", s.static.handler("/qrcode.js"))
	// Icons and the social share card. Real files so crawlers and platforms can
	// fetch them by URL; the pages also carry an inline data: icon, which needs
	// no request and costs nothing on the critical path.
	s.mux.HandleFunc("GET /og.png", s.static.handler("/og.png"))
	s.mux.HandleFunc("GET /favicon.svg", s.static.handler("/favicon.svg"))
	s.mux.HandleFunc("GET /favicon.ico", s.static.handler("/favicon.ico"))
	s.mux.HandleFunc("GET /apple-touch-icon.png", s.static.handler("/apple-touch-icon.png"))
	// Service worker for the static shell. Served from the root scope (any
	// deeper path would not control /), and must never be cached long or a
	// new worker can never take over. The stylesheets are inlined into the
	// HTML, so they have no route here (see loadStatic's asset map).
	s.static.forever("/sw.js")
	s.mux.HandleFunc("GET /sw.js", s.static.handler("/sw.js"))
	// The /debug harness creates rooms and drives WebSocket exchanges on demand:
	// convenient in dev, a ready-made abuse tool in production. Off unless
	// DEBUG=1 (see docs/CONFIG.md).
	s.mux.HandleFunc("GET /debug", func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.EnableDebug {
			http.NotFound(w, r)
			return
		}
		s.static.handler("/debug")(w, r)
	})
	// Also reachable at the conventional /privacy-policy path some store
	// listings assume, so a hand-typed URL never 404s.
	s.mux.HandleFunc("GET /privacy-policy", s.static.handler("/privacy"))
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	s.static.handler("/")(w, r)
}

// blogSlugs allowlists every servable post slug. /blog/{slug} matches ANY
// single segment, so without this an unknown slug would either leak a
// filesystem probe or — worse — be served a 200 with the wrong content.
// Unknown slugs 404 loudly instead.
var blogSlugs = map[string]string{
	"send-large-files-no-size-limit": "/blog/send-large-files-no-size-limit",
	"wetransfer-alternative":         "/blog/wetransfer-alternative",
	"send-files-without-account":     "/blog/send-files-without-account",
	"is-p2p-file-sharing-safe":       "/blog/is-p2p-file-sharing-safe",
	"send-large-videos-photos":       "/blog/send-large-videos-photos",
}

func (s *Server) handleBlog(w http.ResponseWriter, r *http.Request) {
	route, ok := blogSlugs[r.PathValue("slug")]
	if !ok {
		http.NotFound(w, r)
		return
	}
	s.static.handler(route)(w, r)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	// Room manifests carry attacker-chosen filenames and room IDs ride in URLs;
	// nothing here should sit in a browser or proxy cache.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	for _, m := range []struct{ name, help, typ, val string }{
		{"rooms_active", "Rooms currently stored", "gauge", itoa(s.store.RoomCount())},
		{"ws_conns", "WebSocket peers connected", "gauge", itoa64(s.wsConns.Load())},
		{"signals_routed", "Signaling frames delivered total", "counter", itoa64(s.store.Routed())},
		{"frames_dropped", "Frames dropped on full peer buffers total", "counter", itoa64(s.store.Dropped())},
		{"turn_minted", "TURN credential sets minted total", "counter", itoa64(s.turnMinted.Load())},
		{"rooms_created", "Rooms created total", "counter", itoa64(s.roomCreates.Load())},
		{"frames_in", "Signaling frames received total", "counter", itoa64(s.framesIn.Load())},
		{"rate_limited", "Requests rejected with 429 total", "counter", itoa64(s.rateLimited.Load())},
		{"write_errors", "Writer pump send failures total", "counter", itoa64(s.writeErrors.Load())},
		{"route_errors", "Signaling frames rejected by router total", "counter", itoa64(s.routeErrors.Load())},
		{"report_log_errors", "Abuse reports not durably persisted (total)", "counter", itoa64(s.reportLogErrors.Load())},
		// Persistence is opt-in, so an operator has no other way to confirm it
		// is actually on. "memory" means reports die with the process.
		{"report_log", "Abuse report persistence: file path, or memory", "gauge", metaString(s.store.ReportLogPath())},
		// Anonymous success count: files saved AND sha256-verified on the
		// receiver. No identifier is recorded, so this is a usage statistic
		// rather than tracking. See internal/server/usage.go.
		{"files_completed", "Files successfully received and verified total", "counter", itoa64(s.usageOK.Load())},
		{"files_completed_persistent", "1 if the count survives a restart", "gauge", oneOrZero(s.usageFile != "")},
	} {
		w.Write([]byte("# HELP p2pfilesharing_" + m.name + " " + m.help + "\n" +
			"# TYPE p2pfilesharing_" + m.name + " " + m.typ + "\n" +
			"p2pfilesharing_" + m.name + " " + m.val + "\n"))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// metaString renders a string metric value. Prometheus exposition is
// line-oriented, so a value containing a newline would forge extra samples —
// escape backslash and newline, and quote. An empty value reads as "memory".
func oneOrZero(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func metaString(s string) string {
	if s == "" {
		s = "memory"
	}
	return `"` + strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`).Replace(s) + `"`
}

func itoa64(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !s.createLimit.Allow(clientIP(r, s.cfg), time.Now()) {
		s.rateLimited.Add(1)
		w.Header().Set("Retry-After", "60")
		writeJSON(w, 429, map[string]string{"error": "rate_limited"})
		return
	}
	capBody(w, r)
	var body struct {
		Files  []rooms.FileMeta `json:"files"`
		Nearby bool             `json:"nearby"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		if code, ok := rejectIfOversized(err); ok {
			writeJSON(w, code, map[string]string{"error": "body_too_large"})
			return
		}
		writeJSON(w, 400, map[string]string{"error": "invalid_body"})
		return
	}
	if len(body.Files) == 0 || len(body.Files) > 20 {
		writeJSON(w, 400, map[string]string{"error": "bad_files"})
		return
	}
	for _, f := range body.Files {
		if !validFileMeta(f) {
			writeJSON(w, 400, map[string]string{"error": "bad_file"})
			return
		}
	}
	room := s.store.Create(body.Files, body.Nearby)
	s.roomCreates.Add(1)
	writeJSON(w, 201, map[string]any{
		"id": room.ID, "nearby": room.NearbyCode, "url": s.cfg.BaseURL + "/r/" + room.ID,
	})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	snap, ok := s.store.SnapshotOf(id)
	if !ok {
		if reason, dis := s.store.Disabled(id); dis {
			writeJSON(w, 451, map[string]string{"error": "room_disabled", "reason": reason})
			return
		}
		writeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	writeJSON(w, 200, map[string]any{
		"id": snap.ID, "files": snap.Files, "senderOnline": snap.SenderOnline, "nearby": snap.Nearby,
	})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	// Room deletion is cheap per call but fans out (bye broadcast + closes), so
	// bound it with the same lifecycle bucket as creation. Still answers 204 for
	// unknown rooms: the ID is the secret, and a distinguishable response would
	// turn this into a presence oracle.
	if !s.createLimit.Allow(clientIP(r, s.cfg), time.Now()) {
		s.rateLimited.Add(1)
		w.Header().Set("Retry-After", "60")
		writeJSON(w, 429, map[string]string{"error": "rate_limited"})
		return
	}
	s.byeAndClose(r.PathValue("id"))
	w.WriteHeader(204)
}

func (s *Server) handleNearby(w http.ResponseWriter, r *http.Request) {
	// A nearby code is 4 digits — only 9 000 values. Without this limit the
	// whole code space can be walked in ~9k requests, which both enumerates
	// every live nearby room and hands the attacker a joinable room id. Throttled
	// hard because a human types a code at most a handful of times.
	if !s.nearbyLimit.Allow(clientIP(r, s.cfg), time.Now()) {
		s.rateLimited.Add(1)
		w.Header().Set("Retry-After", "60")
		writeJSON(w, 429, map[string]string{"error": "rate_limited"})
		return
	}
	room, ok := s.store.GetByNearby(r.PathValue("code"))
	if !ok {
		// Same answer whether the code does not exist or the room is gone: a
		// distinguishable response turns this into a room-presence oracle.
		writeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": room.ID, "url": "/r/" + room.ID})
}

func (s *Server) handleTURN(w http.ResponseWriter, r *http.Request) {
	// Rate-limit BEFORE the existence check. The old order answered 404 for
	// unknown rooms without spending budget, so an attacker could walk the room
	// space for free while legitimate callers paid — the limit only bound the
	// callers who already held a valid ID.
	if !s.turnLimit.Allow(clientIP(r, s.cfg), time.Now()) {
		s.rateLimited.Add(1)
		w.Header().Set("Retry-After", "60")
		writeJSON(w, 429, map[string]string{"error": "rate_limited"})
		return
	}
	if _, ok := s.store.Get(r.PathValue("id")); !ok {
		writeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	servers := []any{map[string]string{"urls": s.cfg.StunURL}}
	// Primary then secondary provider (secondary rescues provider blacklists —
	// see FIREWALL-TRAVERSAL.md §4). Each provider: UDP, TCP, TLS:443 (cheapest first).
	for _, p := range []struct{ host, secret string }{
		{s.cfg.TurnHost, s.cfg.TurnSecret},
		{s.cfg.Turn2Host, s.cfg.Turn2Secret},
	} {
		if p.host == "" || p.secret == "" {
			continue
		}
		user, cred := rooms.MintTURN(p.secret, s.cfg.TurnTTL, time.Now())
		s.turnMinted.Add(1)
		servers = append(servers,
			map[string]string{"urls": "turn:" + p.host + ":3478?transport=udp", "username": user, "credential": cred},
			map[string]string{"urls": "turn:" + p.host + ":3478?transport=tcp", "username": user, "credential": cred},
			map[string]string{"urls": "turns:" + p.host + ":443?transport=tcp", "username": user, "credential": cred},
		)
	}
	if len(servers) == 1 {
		writeJSON(w, 410, map[string]string{"error": "turn_disabled"})
		return
	}
	writeJSON(w, 200, map[string]any{"ttl": int64(s.cfg.TurnTTL / time.Second), "iceServers": servers})
}

// byeAndClose broadcasts bye then closes all peer channels (writers send bye+hang up).
func (s *Server) byeAndClose(roomID string) {
	s.store.Broadcast(roomID, rooms.Frame{From: "server", To: "receivers", Kind: "bye"})
	for _, ch := range s.store.Delete(roomID) {
		close(ch)
	}
}

// sweepAll reaps every rate limiter's idle buckets. All six, deliberately: this
// used to omit usageLimit and metricsLimit, so their maps grew one entry per
// distinct client IP for the life of the process. POST /api/usage is
// unauthenticated and consults its limiter BEFORE validating anything, which made
// it a free, permanently retained allocation primitive — and IPv6 source
// rotation turns one client into millions of retained buckets.
//
// Extracted from reapLoop so a test can drive the real sweep rather than
// reimplementing it (a test that calls Limiter.Sweep itself passes even when
// reapLoop forgets to).
func (s *Server) sweepAll(now time.Time) {
	s.createLimit.Sweep(now)
	s.turnLimit.Sweep(now)
	s.reportLimit.Sweep(now)
	s.nearbyLimit.Sweep(now)
	s.usageLimit.Sweep(now)
	s.metricsLimit.Sweep(now)
}

func (s *Server) reapLoop() {
	// Tick often enough that bye follows grace expiry promptly; sweep is O(rooms).
	interval := s.cfg.Grace / 2
	if interval > time.Second {
		interval = time.Second
	}
	if interval < 100*time.Millisecond {
		interval = 100 * time.Millisecond
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for range t.C {
		// ExpireSweep already deleted the rooms and returned peer channels.
		// Closing a channel makes its writer pump send bye + hang up.
		for _, exp := range s.store.ExpireSweep(time.Now()) {
			for _, ch := range exp.Sends {
				close(ch)
			}
		}
		s.sweepAll(time.Now())
	}
}

// Shutdown closes every room (writers send bye + hang up) for graceful exit.
// Call after http.Server.Shutdown so no new requests arrive.
func (s *Server) Shutdown() {
	for _, ch := range s.store.Shutdown() {
		close(ch)
	}
}

// clientIP returns the request source for rate limiting.
//
// Behind a trusted proxy (TRUST_PROXY) the request comes from Caddy, which
// APPENDS the address it observed to any X-Forwarded-For the client already
// sent (Caddy's default, as is nginx's $proxy_add_x_forwarded_for). The
// resulting list is therefore client-controlled up to the last entry:
//
//	X-Forwarded-For: 203.0.113.9, 198.51.100.7
//	                 ^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^
//	                 the client's own   written by our proxy
//
// Taking the LEFTMOST entry therefore hands every caller a fresh rate-limit
// bucket per request, which is what RATE_NEARBY_PER_MIN exists to prevent. Take
// the RIGHTMOST instead: it is the one entry our own trusted hop wrote.
//
// trustProxyHeader still gates this — it requires the direct peer to be
// loopback/private, so a client cannot reach the server directly and assert a
// header of its own. Falls back to the socket peer address.
func clientIP(r *http.Request, cfg Config) string {
	if trustProxyHeader(cfg.TrustProxy, r.RemoteAddr) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.LastIndexByte(xff, ','); i >= 0 {
				return strings.TrimSpace(xff[i+1:])
			}
			return strings.TrimSpace(xff)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
