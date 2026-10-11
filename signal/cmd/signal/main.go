package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	srvpkg "signal/internal/server"
)

func mustDur(key, def string) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		v = def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		log.Fatalf("bad %s=%q", key, os.Getenv(key))
	}
	return d
}

func mustInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		log.Fatalf("bad %s=%q", key, v)
	}
	return n
}

func main() {
	cfg := srvpkg.Config{
		Addr:             envOr("SIGNAL_ADDR", "127.0.0.1:8090"),
		BaseURL:          envOr("SIGNAL_PUBLIC_BASE_URL", "http://localhost:8090"),
		WebDir:           envOr("SIGNAL_WEB_DIR", "web"),
		Grace:            mustDur("SIGNAL_GRACE", "10s"),
		PingInterval:     mustDur("SIGNAL_PING", "25s"),
		MaxMsg:           mustInt("SIGNAL_MAX_MSG", 32768),
		TurnHost:         os.Getenv("TURN_HOST"),
		TurnSecret:       os.Getenv("TURN_SECRET"),
		TurnTTL:          mustDur("TURN_TTL", "3600s"),
		TurnRealm:        envOr("TURN_REALM", "p2pfilesharing"),
		Turn2Host:        os.Getenv("TURN2_HOST"),
		Turn2Secret:      os.Getenv("TURN2_SECRET"),
		StunURL:          envOr("STUN_URL", "stun:stun.l.google.com:19302"),
		RateCreatePerMin: mustInt("RATE_CREATE_PER_MIN", 10),
		RateTurnPerMin:   mustInt("RATE_TURN_PER_MIN", 30),
		RateReportPerMin: mustInt("RATE_REPORT_PER_MIN", 5),
		ReportLog:        strings.TrimSpace(os.Getenv("REPORT_LOG")),
		UsageFile:        strings.TrimSpace(os.Getenv("USAGE_FILE")),
		MetricsPassword:  os.Getenv("METRICS_PASSWORD"),
		RateNearbyPerMin: mustInt("RATE_NEARBY_PER_MIN", 20),
		TrustProxy:       os.Getenv("TRUST_PROXY") == "1",
		AdminToken:       os.Getenv("ADMIN_TOKEN"),
		AllowedOrigins:   envList("SIGNAL_ALLOWED_ORIGINS"),
		EnableDebug:      os.Getenv("SIGNAL_DEBUG") == "1",
		PublicMetrics:    os.Getenv("SIGNAL_PUBLIC_METRICS") == "1",
		// Public frontend origin, used for canonical/og:url/robots/sitemap. Falls
		// back to PUBLIC_BASE_URL (correct for a single-host deployment). On a
		// split deployment the two differ and this MUST be set, or every canonical
		// would point at the API host.
		SiteURL: os.Getenv("SIGNAL_SITE_URL"),
		// Reported in signal-config.json so a client on a stale cached config
		// can tell an operator exactly which build it is running.
		AppVersion: envOr("SIGNAL_VERSION", "dev"),
		// Split deployment: the face lives on Pages, so this host serves API
		// only and never a duplicate copy of the site.
		DisableUI: os.Getenv("SIGNAL_DISABLE_UI") == "1",
	}
	srv, err := srvpkg.New(cfg)
	if err != nil {
		log.Fatalf("load web dir: %v", err)
	}
	// Timeouts close the Slowloris class: without ReadHeaderTimeout a client
	// can hold a connection open indefinitely by dribbling request headers and
	// starve the accept loop. WriteTimeout is deliberately unset — hijacked
	// WebSockets manage their own write deadlines, and a server-wide write
	// deadline would sever live signaling connections mid-room.
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: mustDur("SIGNAL_READ_HEADER_TIMEOUT", "10s"),
		IdleTimeout:       mustDur("SIGNAL_IDLE_TIMEOUT", "60s"),
		MaxHeaderBytes:    mustInt("SIGNAL_MAX_HEADER_BYTES", 16<<10),
		ErrorLog:          log.New(os.Stderr, "http: ", log.LstdFlags),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Printf("signal listening on %s (turn=%v turn2=%v grace=%s)",
			cfg.Addr, cfg.TurnHost != "" && cfg.TurnSecret != "",
			cfg.Turn2Host != "" && cfg.Turn2Secret != "", cfg.Grace)
		if err := httpSrv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()
	<-ctx.Done()
	log.Print("signal: draining (15s)")
	stop()
	shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutCtx) // stops listeners; hijacked WS conns are detached
	srv.Shutdown()                // bye + hang up every peer
	log.Print("signal: bye")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envList parses a comma-separated env value, ignoring empty entries so
// "A,,B" and a trailing comma behave. Returns nil when unset, which lets the
// server package substitute its defaults.
func envList(key string) []string {
	v := os.Getenv(key)
	if v == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
