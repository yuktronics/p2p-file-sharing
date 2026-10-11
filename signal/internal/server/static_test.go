package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The first-visit budget depends on this transform, so it is pinned by tests:
// a silent skip would put a render-blocking <link> back on the critical path and
// nobody would notice until the numbers regressed in production.

func servePage(t *testing.T, path string) (*httptest.Server, string) {
	t.Helper()
	srv, err := New(testConfig())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return ts, string(b)
}

func TestPagesInlineBothStylesheets(t *testing.T) {
	for _, page := range []string{"/", "/receive", "/report/abc", "/blog", "/blog/is-p2p-file-sharing-safe"} {
		_, html := servePage(t, page)

		// No render-blocking stylesheet request may survive.
		if strings.Contains(html, `<link rel="stylesheet"`) {
			t.Fatalf("%s: still has a <link rel=stylesheet> — inlining was skipped", page)
		}
		if strings.Contains(html, "styles.css") {
			t.Fatalf("%s: still references styles.css", page)
		}
		// The shell must be in <head> (before any body content) so the first
		// paint needs nothing but the document.
		headEnd := strings.Index(html, "</head>")
		shellAt := strings.Index(html, "<style>")
		if shellAt < 0 || shellAt > headEnd {
			t.Fatalf("%s: shell <style> not in <head> (at %d, head ends %d)", page, shellAt, headEnd)
		}
		// The deferred half must come last, just before </body>.
		deferAt := strings.Index(html, "<style data-deferred>")
		if deferAt < 0 || deferAt < headEnd {
			t.Fatalf("%s: deferred <style> missing or misplaced (at %d)", page, deferAt)
		}
		if strings.Index(html[deferAt:], "</body>") < 0 {
			t.Fatalf("%s: deferred <style> is not before </body>", page)
		}
		// Real content from both halves, so an empty file can't pass.
		if !strings.Contains(html, "p2p file sharing") {
			t.Fatalf("%s: shell CSS content missing", page)
		}
		if !strings.Contains(html, ".term-body") {
			t.Fatalf("%s: deferred CSS content missing", page)
		}
	}
}

func TestInlineStylesRejectsDriftedAnchors(t *testing.T) {
	c := &staticCache{files: map[string]*staticFile{
		"/styles.css": {raw: []byte("a{color:red}")},
		"/states.css": {raw: []byte(".term{color:blue}")},
	}}
	cases := map[string]string{
		"no shell link":    "<html><head></head><body></body></html>",
		"no deferred link": `<html><head><link rel="stylesheet" href="/styles.css"></head><body></body></html>`,
		"no body":          `<html><head><link rel="stylesheet" href="/styles.css"></head>` + deferredLinks,
	}
	for name, html := range cases {
		if _, err := c.inlineStyles(html); err == nil {
			t.Fatalf("%s: want error, got nil — a drifted page would silently skip inlining", name)
		}
	}
}

func TestInlinedPageStillSendsGzipAndETag(t *testing.T) {
	ts, _ := servePage(t, "/")
	req, _ := http.NewRequest("GET", ts.URL+"/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("ETag") == "" {
		t.Fatal("no ETag on the inlined page")
	}
	if !strings.Contains(resp.Header.Get("Cache-Control"), "no-cache") {
		t.Fatalf("HTML must revalidate, got %q", resp.Header.Get("Cache-Control"))
	}
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("inlined HTML should still be served pre-compressed")
	}
}

// The minifier must not touch anything inside a quoted string. A blind
// whitespace collapse turned `content:"Hello, world: friend"` into
// `content:"Hello,world:friend"`, so any punctuation in a CSS string value was
// silently corrupted. The JS twin (inline-css.mjs) had the same bug plus a
// worse one: its String.replace expanded $&, $` and $' inside the spliced CSS.
func TestMinifyCSSPreservesQuotedStrings(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{`a{content:"Hello, world: friend"}`, `a{content:"Hello, world: friend"}`},
		{`a{content:"$&"}`, `a{content:"$&"}`},
		{"a{content:\"$`\"}", "a{content:\"$`\"}"},
		{`.msg.me::before{content:"$";color:var(--su)}`, `.msg.me::before{content:"$";color:var(--su)}`},
		{`a{content:'it\'s fine';color:red}`, `a{content:'it\'s fine';color:red}`},
		{`a{background:url("a b.png")}`, `a{background:url("a b.png")}`},
	} {
		if got := minifyCSS(tc.in); got != tc.want {
			t.Errorf("minifyCSS(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	// The real sheetsheets must round-trip without losing content.
	// testConfig points WebDir at ../../web, so reach the sheetsheets the same way.
	for _, name := range []string{"styles.css", "states.css"} {
		src, err := os.ReadFile(filepath.Join("..", "..", "web", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		out := minifyCSS(string(src))
		if strings.Count(out, `"`)%2 != 0 {
			t.Errorf("%s: minified output has an unbalanced number of quotes — a string was truncated", name)
		}
		if strings.Contains(out, "$&") && !strings.Contains(string(src), "$&") {
			t.Errorf("%s: minified output invented a $& sequence", name)
		}
		if len(out) >= len(string(src)) {
			t.Errorf("%s: minified output (%d) is not smaller than the source (%d)", name, len(out), len(src))
		}
	}
}

func TestStylesheetsAreNotServedAsSeparateFiles(t *testing.T) {
	srv, err := New(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	// They exist as sources for the inline transform, but a route for them would
	// mean a page could go back to paying for the request.
	for _, p := range []string{"/styles.css", "/states.css"} {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s = %d, want 404 (stylesheets are inlined, not served)", p, resp.StatusCode)
		}
	}
}

func TestServiceWorkerIsNoCache(t *testing.T) {
	ts, _ := servePage(t, "/sw.js")
	resp, err := http.Get(ts.URL + "/sw.js")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Cache-Control"); !strings.Contains(got, "no-cache") {
		t.Fatalf("sw.js Cache-Control = %q, want no-cache (a pinned worker can never update)", got)
	}
}

// A shared cache must not serve the gzip variant to a client that cannot decode
// it. The body varies by Accept-Encoding, so Vary has to say so — without it a
// CDN or corporate proxy is entitled to store gzip under the bare /app.js URL.
// The old code set no Vary at all (serveCORS adds Vary: Origin only for
// cross-origin requests), so this was one misconfigured proxy away from every
// visitor getting an unparseable script.
func TestGzipSendsVaryAcceptEncoding(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest("GET", ts.URL+"/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected a gzipped asset, got Content-Encoding %q", resp.Header.Get("Content-Encoding"))
	}
	if v := resp.Header.Get("Vary"); !strings.Contains(v, "Accept-Encoding") {
		t.Errorf("Vary = %q, want it to include Accept-Encoding", v)
	}
}

// "gzip;q=0" is an explicit refusal. A substring test for "gzip" matched it and
// served a gzipped body to a client that had asked not to receive one.
func TestGzipHonoursExplicitRefusal(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   bool
	}{
		{"gzip", true},
		{"gzip, deflate", true},
		{"deflate, gzip;q=1.0", true},
		{"*", true},
		{"gzip;q=0", false},
		{"gzip;q=0.0", false},
		{"gzip;q=0.001", true},
		{"deflate", false},
		{"", false},
		{"identity", false},
		{"GZIP", true}, // token is case-insensitive
	} {
		if got := acceptsGzip(tc.header); got != tc.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", tc.header, got, tc.want)
		}
	}

	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	req, _ := http.NewRequest("GET", ts.URL+"/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip;q=0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ce := resp.Header.Get("Content-Encoding"); ce != "" {
		t.Fatalf("Content-Encoding = %q for a client that refused gzip", ce)
	}
	// And the body must still be valid JavaScript, not compressed bytes.
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "function") && !strings.Contains(string(body), "=>") {
		t.Errorf("uncompressed body does not look like the script (%d bytes)", len(body))
	}
}
