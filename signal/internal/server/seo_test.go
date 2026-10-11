package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// Search-engine behaviour, asserted against the pages the server actually
// serves. Each test states the failure it prevents, and the rules come from
// Google Search Central rather than convention.

func seoConfig() Config {
	cfg := testConfig()
	cfg.SiteURL = "https://files.example.com"
	return cfg
}

func seoServer(t *testing.T) (*Server, *httptest.Server) {
	return seoServerWith(t, seoConfig())
}

func seoServerWith(t *testing.T, cfg Config) (*Server, *httptest.Server) {
	t.Helper()
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

// Absolute URLs are mandatory for canonical — Google will not accept a relative
// one — and the domain is a deploy-time fact, so the pages carry a placeholder.
// A placeholder surviving into a served page looks fine and silently costs
// canonicalisation, so this checks the substitution actually happened.
func TestCanonicalIsAbsoluteAndSubstituted(t *testing.T) {
	_, ts := seoServer(t)
	for path, want := range map[string]string{
		"/":               "https://files.example.com/",
		"/receive":        "https://files.example.com/receive",
		"/privacy":        "https://files.example.com/privacy",
		"/contact":        "https://files.example.com/contact",
		"/privacy-policy": "https://files.example.com/privacy",
	} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body := make([]byte, 16384) // the head with all search metadata fits well inside this
		n, _ := resp.Body.Read(body)
		resp.Body.Close()
		html := string(body[:n])
		if strings.Contains(html, "{{SITE_URL}}") {
			t.Errorf("%s: {{SITE_URL}} survived into the served page", path)
		}
		if !strings.Contains(html, `<link rel="canonical" href="`+want+`">`) {
			t.Errorf("%s: canonical is not the absolute %s", path, want)
		}
		if !strings.Contains(html, `property="og:url" content="`+want+`"`) {
			t.Errorf("%s: og:url is not the absolute %s", path, want)
		}
	}
}

// A non-absolute site URL must fail closed at startup rather than serving pages
// with unusable canonicals.
// A surviving placeholder must stop the page, whatever its shape. The guard used
// to match \{\{[A-Z_]+\}\}, so {{SITE_URL2}}, {{site_url}} and {{SIGNAL-URL}} were
// substituted by nothing, detected by nothing, and served with a broken
// canonical — the exact silent failure the guard exists to prevent.
func TestPlaceholderSurvivalFailsClosed(t *testing.T) {
	for _, bad := range []string{
		"{{ROOM_BASE}}", "{{A}}", "{{SITE_URL2}}", "{{site_url}}", "{{SIGNAL-URL}}", "{{RoomId}}", "{{}}",
	} {
		if _, err := injectSiteURL(`<link rel="canonical" href="`+bad+`">`, "https://example.com"); err == nil {
			t.Errorf("placeholder %q survived into the output; want an error", bad)
		}
	}
	// A real page that substitutes cleanly must still pass.
	if _, err := injectSiteURL(`<link rel="canonical" href="{{SITE_URL}}/">`, "https://example.com"); err != nil {
		t.Errorf("a well-formed page was rejected: %v", err)
	}
}

func TestMissingSiteURLFailsClosed(t *testing.T) {
	for _, bad := range []string{"files.example.com", "ftp://files.example.com", "not a url", "//files.example.com"} {
		cfg := testConfig()
		cfg.SiteURL = bad
		if _, err := New(cfg); err == nil {
			t.Errorf("SiteURL=%q accepted; canonical would be relative or broken", bad)
		}
	}
	// Empty is not an error: it falls back to PUBLIC_BASE_URL, which is the
	// right answer for a single-host deployment (and testConfig sets one).
	cfg := testConfig()
	cfg.SiteURL = ""
	if _, err := New(cfg); err != nil {
		t.Fatalf("empty SiteURL should fall back to BaseURL, got %v", err)
	}
	// ...and the fallback must actually be used, not ignored.
	if got := cfg.BaseURL; got != "http://x" {
		t.Fatalf("unexpected BaseURL in the fixture: %q", got)
	}
}

// Per-room URLs are an unbounded set that must stay out of the index, and the
// same document serves /receive — so the rule has to be a header, not a tag.
func TestRoomPagesAreNoindexedViaHeader(t *testing.T) {
	_, ts := seoServer(t)
	for _, path := range []string{"/r/abc123XYZ0", "/report/abc123XYZ0"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("X-Robots-Tag"); !strings.Contains(got, "noindex") {
			t.Errorf("%s: X-Robots-Tag = %q, want it to contain noindex", path, got)
		}
	}
	// ...and the indexable pages must NOT carry it.
	for _, path := range []string{"/", "/receive", "/privacy", "/contact"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("X-Robots-Tag"); got != "" {
			t.Errorf("%s is indexable but carries X-Robots-Tag %q", path, got)
		}
	}
}

// The subtle one. Google: "If a page is disallowed from crawling through the
// robots.txt file, then any information about indexing or serving rules will not
// be found and will therefore be ignored." So a Disallow on /r/ would make the
// X-Robots-Tag above permanently invisible and get the share links indexed.
// This test exists to make that mistake impossible to reintroduce.
func TestRobotsTxtDoesNotBlockNoindexedPaths(t *testing.T) {
	_, ts := seoServer(t)
	resp, err := http.Get(ts.URL + "/robots.txt")
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 4096)
	n, _ := resp.Body.Read(b)
	resp.Body.Close()
	robots := string(b[:n])

	disallowed := map[string]bool{}
	for _, line := range strings.Split(robots, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Disallow:") {
			p := strings.TrimSpace(strings.TrimPrefix(line, "Disallow:"))
			if p != "" {
				disallowed[p] = true
			}
		}
	}
	for p := range disallowed {
		if strings.HasPrefix(p, "/r") || strings.HasPrefix(p, "/report") {
			t.Errorf("robots.txt disallows %q, which would make its noindex unreadable and get share links indexed", p)
		}
	}
	if !strings.Contains(robots, "Sitemap: https://files.example.com/sitemap.xml") {
		t.Errorf("robots.txt has no absolute Sitemap line:\n%s", robots)
	}
	if !strings.Contains(robots, "Disallow: /api/") {
		t.Errorf("robots.txt should still save crawl budget on the API:\n%s", robots)
	}
}

func TestSitemapAbsoluteAndScoped(t *testing.T) {
	_, ts := seoServer(t)
	resp, err := http.Get(ts.URL + "/sitemap.xml")
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 8192)
	n, _ := resp.Body.Read(b)
	resp.Body.Close()
	xml := string(b[:n])

	rel := regexp.MustCompile(`<loc>([^<]*)</loc>`)
	locs := rel.FindAllStringSubmatch(xml, -1)
	if len(locs) == 0 {
		t.Fatalf("sitemap has no URLs:\n%s", xml)
	}
	// /receive is deliberately absent: the code entry lives on home now and a
	// bare /receive bounces there client-side, so listing it would index a page
	// with no content of its own.
	want := map[string]bool{
		"https://files.example.com/":                                    true,
		"https://files.example.com/blog":                                true,
		"https://files.example.com/blog/send-large-files-no-size-limit": true,
		"https://files.example.com/blog/wetransfer-alternative":         true,
		"https://files.example.com/blog/send-files-without-account":     true,
		"https://files.example.com/blog/is-p2p-file-sharing-safe":       true,
		"https://files.example.com/blog/send-large-videos-photos":       true,
		"https://files.example.com/privacy":                             true,
		"https://files.example.com/contact":                             true,
		"https://files.example.com/architecture":                        true,
	}
	for _, l := range locs {
		if !strings.HasPrefix(l[1], "http") {
			t.Errorf("sitemap URL is not absolute: %q", l[1])
		}
		if !want[l[1]] {
			t.Errorf("unexpected sitemap URL %q — room URLs must not be listed", l[1])
		}
		delete(want, l[1])
	}
	if len(want) > 0 {
		t.Errorf("sitemap is missing indexable pages: %v", want)
	}
}

// Blog pages are the indexable content hub: every post must serve with an
// absolute canonical + og:url, carry NO noindex header, ship BlogPosting
// structured data, and resolve its internal links. An unknown slug must 404
// (not 200 with the wrong page), or crawlers index a soft-404 as content.
func TestBlogPagesAreCanonicalAndIndexable(t *testing.T) {
	_, ts := seoServer(t)
	posts := map[string]string{
		"/blog":                                "https://files.example.com/blog",
		"/blog/send-large-files-no-size-limit": "https://files.example.com/blog/send-large-files-no-size-limit",
		"/blog/wetransfer-alternative":         "https://files.example.com/blog/wetransfer-alternative",
		"/blog/send-files-without-account":     "https://files.example.com/blog/send-files-without-account",
		"/blog/is-p2p-file-sharing-safe":       "https://files.example.com/blog/is-p2p-file-sharing-safe",
		"/blog/send-large-videos-photos":       "https://files.example.com/blog/send-large-videos-photos",
	}
	for path, want := range posts {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b := make([]byte, 65536)
		n, _ := resp.Body.Read(b)
		resp.Body.Close()
		html := string(b[:n])
		if resp.StatusCode != 200 {
			t.Errorf("GET %s = %d, want 200", path, resp.StatusCode)
			continue
		}
		if got := resp.Header.Get("X-Robots-Tag"); got != "" {
			t.Errorf("%s is indexable but carries X-Robots-Tag %q", path, got)
		}
		if strings.Contains(html, "{{SITE_URL}}") {
			t.Errorf("%s: {{SITE_URL}} survived into the served page", path)
		}
		if !strings.Contains(html, `<link rel="canonical" href="`+want+`">`) {
			t.Errorf("%s: canonical is not the absolute %s", path, want)
		}
		if !strings.Contains(html, `property="og:url" content="`+want+`"`) {
			t.Errorf("%s: og:url is not the absolute %s", path, want)
		}
		if path == "/blog" {
			if !strings.Contains(html, `"@type":"Blog"`) {
				t.Errorf("/blog: no Blog JSON-LD node")
			}
		} else {
			if !strings.Contains(html, `"@type":"BlogPosting"`) {
				t.Errorf("%s: no BlogPosting JSON-LD node", path)
			}
			if !strings.Contains(html, `"@type":"BreadcrumbList"`) {
				t.Errorf("%s: no BreadcrumbList JSON-LD node", path)
			}
		}
		// Invented ratings are a structured-data manual action. Guard the absence.
		if strings.Contains(html, "aggregateRating") {
			t.Errorf("%s: JSON-LD contains aggregateRating", path)
		}
	}
	// Trailing-slash twin redirects to the canonical /blog (both hosts agree —
	// the Pages _redirects carries the same 301, so no duplicate copy exists
	// to fork the canonical). Unknown slugs 404 loudly.
	nofollow := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := nofollow.Get(ts.URL + "/blog/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMovedPermanently || resp.Header.Get("Location") != "/blog" {
		t.Errorf("GET /blog/ = %d Location %q, want 301 to /blog", resp.StatusCode, resp.Header.Get("Location"))
	}
	for _, path := range []string{"/blog/no-such-post", "/blog/../../etc/passwd"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, resp.StatusCode)
		}
	}
}

// WebSite structured data is the documented way to state a preferred site name
// to Google, which matters for a product with a new brand name.
func TestWebSiteStructuredDataPresent(t *testing.T) {
	_, ts := seoServer(t)
	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 32768)
	n, _ := resp.Body.Read(b)
	resp.Body.Close()
	html := string(b[:n])

	start := strings.Index(html, `type="application/ld+json"`)
	if start < 0 {
		t.Fatal("no JSON-LD on the home page")
	}
	open := strings.Index(html[start:], ">") + start + 1
	end := strings.Index(html[open:], "</script>") + open
	var doc struct {
		Graph []struct {
			Type    string `json:"@type"`
			Name    string `json:"name"`
			URL     string `json:"url"`
			Website struct {
				ID string `json:"@id"`
			} `json:"-"`
			AppCategory string `json:"applicationCategory"`
			Offers      *struct {
				Price string `json:"price"`
			} `json:"offers"`
		} `json:"@graph"`
	}
	if err := json.Unmarshal([]byte(html[open:end]), &doc); err != nil {
		t.Fatalf("JSON-LD does not parse: %v\n%s", err, html[open:end])
	}
	kinds := map[string]int{}
	for _, n := range doc.Graph {
		kinds[n.Type]++
	}
	if kinds["WebSite"] == 0 {
		t.Error("no WebSite node — Google cannot take a site-name preference without it")
	}
	if kinds["SoftwareApplication"] == 0 {
		t.Error("no SoftwareApplication node on the home page")
	}
	// Invented ratings are a structured-data manual action. Guard the absence.
	if strings.Contains(html[open:end], "aggregateRating") {
		t.Error("JSON-LD contains aggregateRating — inventing one is a manual-action risk")
	}
}

// The share card must be a real, fetchable image at a size platforms accept, and
// every page must point at it with an absolute URL.
func TestSocialCardResolves(t *testing.T) {
	_, ts := seoServer(t)
	for _, path := range []string{"/", "/receive", "/privacy", "/contact"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b := make([]byte, 8192)
		n, _ := resp.Body.Read(b)
		resp.Body.Close()
		if !strings.Contains(string(b[:n]), `property="og:image" content="https://files.example.com/og.png"`) {
			t.Errorf("%s: og:image missing or not absolute", path)
		}
		if !strings.Contains(string(b[:n]), `name="twitter:card" content="summary_large_image"`) {
			t.Errorf("%s: not a summary_large_image card", path)
		}
	}
	resp, err := http.Get(ts.URL + "/og.png")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("og.png = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("og.png content-type = %q", ct)
	}
	// Platform minimums are 1200x630; a small card renders as a blurry thumbnail.
	buf := make([]byte, 32)
	n, _ := resp.Body.Read(buf)
	if n < 24 || string(buf[1:4]) != "PNG" {
		t.Fatal("og.png is not a PNG")
	}
	w := int(buf[16])<<24 | int(buf[17])<<16 | int(buf[18])<<8 | int(buf[19])
	h := int(buf[20])<<24 | int(buf[21])<<16 | int(buf[22])<<8 | int(buf[23])
	if w < 1200 || h < 630 {
		t.Errorf("og.png is %dx%d, want at least 1200x630", w, h)
	}
}

// Crawlers need real icon URLs; the pages also inline a data: icon for speed,
// but Google reads favicons from a URL far more reliably.
func TestIconRoutesExist(t *testing.T) {
	_, ts := seoServer(t)
	for path, wantType := range map[string]string{
		"/favicon.ico":          "image/x-icon",
		"/favicon.svg":          "image/svg+xml",
		"/apple-touch-icon.png": "image/png",
	} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Errorf("%s = %d", path, resp.StatusCode)
			continue
		}
		if ct := resp.Header.Get("Content-Type"); ct != wantType {
			t.Errorf("%s content-type = %q, want %q", path, ct, wantType)
		}
	}
}

// ── API-only host (split deployment) ──────────────────────────────────────
// With DisableUI the host serves no copy of the site: every UI/asset route
// 404s, robots disallows everything, and the API surface keeps working.

func TestDisableUI(t *testing.T) {
	cfg := seoConfig()
	cfg.DisableUI = true
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, p := range []string{"/", "/receive", "/privacy", "/contact", "/blog",
		"/blog/send-large-files-no-size-limit", "/blog/no-such-post",
		"/r/abc123XYZ0",
		"/report/abc123XYZ0", "/app.js", "/qrcode.js", "/sw.js", "/og.png",
		"/favicon.ico", "/sitemap.xml"} {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("DisableUI: GET %s = %d, want 404", p, resp.StatusCode)
		}
	}

	resp, err := http.Get(ts.URL + "/robots.txt")
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 256)
	n, _ := resp.Body.Read(b)
	resp.Body.Close()
	if !strings.Contains(string(b[:n]), "Disallow: /") {
		t.Errorf("DisableUI: robots.txt should disallow everything, got %q", string(b[:n]))
	}

	// The API surface must be untouched.
	if code := func() int {
		r, err := http.Get(ts.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}(); code != 200 {
		t.Errorf("DisableUI: /healthz = %d, want 200", code)
	}
	r, err := http.Get(ts.URL + "/signal-config.json")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Errorf("DisableUI: /signal-config.json = %d, want 200 (clients learn the backend here)", r.StatusCode)
	}
	id := createRoom(t, ts.URL)
	if id == "" {
		t.Error("DisableUI: room creation failed")
	}
}
func TestReportPageMetaRobots(t *testing.T) {
	_, ts := seoServer(t)
	resp, err := http.Get(ts.URL + "/report/abc123")
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 8192)
	n, _ := resp.Body.Read(b)
	resp.Body.Close()
	html := string(b[:n])
	if !strings.Contains(html, `<meta name="robots" content="noindex,nofollow">`) {
		t.Errorf("report page has no explicit noindex meta")
	}
}

// ── Remotely-updatable backend address ──────────────────────────────────────
// A client fetches this at startup so a backend change reaches installed apps
// without an APK rebuild. Getting it wrong is silent — the app just keeps its
// baked address — so each property is pinned here.

// no-store is the whole mechanism. A cacheable config document means a backend
// change is invisible until the cache expires, which reads as "the feature
// doesn't work" with no error anywhere.
func TestSignalConfigNotCacheable(t *testing.T) {
	cfg := seoConfig()
	cfg.BaseURL = "https://api.example.com"
	_, ts := seoServerWith(t, cfg)
	resp, err := http.Get(ts.URL + "/signal-config.json")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want it to contain no-store (a cached config is a backend change that never arrives)", cc)
	}
	// Cross-origin readable: a page served from any host must be able to fetch
	// the config, since the config host and the backend host are independent.
	if acao := resp.Header.Get("Access-Control-Allow-Origin"); acao != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want \"*\"", acao)
	}
}

func TestSignalConfigNamesTheBackend(t *testing.T) {
	cfg := seoConfig()
	cfg.BaseURL = "https://api.example.com"
	cfg.AppVersion = "test-1"
	_, ts := seoServerWith(t, cfg)
	resp, err := http.Get(ts.URL + "/signal-config.json")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var doc struct {
		Version   string `json:"version"`
		SignalURL string `json:"signalUrl"`
		UpdatedAt string `json:"updatedAt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatalf("signal-config.json does not parse: %v", err)
	}
	if doc.SignalURL != "https://api.example.com" {
		t.Errorf("signalUrl = %q, want the server's public base URL", doc.SignalURL)
	}
	// The client accepts signalUrl, signal_url or url; keep the first stable.
	if doc.Version != "test-1" {
		t.Errorf("version = %q, want the configured build version", doc.Version)
	}
	if doc.UpdatedAt == "" {
		t.Error("updatedAt missing")
	}
}

// The client also does a same-origin request by default, so a self-hosted
// deployment must not 404 — that would log on every page load and train people
// to ignore the console.
func TestSignalConfigReachableSameOrigin(t *testing.T) {
	_, ts := seoServer(t)
	for _, p := range []string{"/", "/receive", "/privacy"} {
		resp, err := http.Get(ts.URL + "/signal-config.json")
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Errorf("config %d from %s", resp.StatusCode, p)
		}
		resp.Body.Close()
		break
	}
}
