package server

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// staticFile is one preloaded web asset: raw + gzipped bytes, ETag, policy.
type staticFile struct {
	ctype      string
	raw        []byte
	gz         []byte // nil when too small to matter
	etag       string
	html       bool
	noStore    bool // long-lived URL that must always revalidate (sw.js)
	standalone bool // self-contained HTML: skip the inline-CSS transform
}

// staticCache preloads every servable file at startup: zero disk I/O per
// request, ETag/304 revalidation, gzip pre-compressed once. The browser does
// the caching work; the server just says "not modified".
type staticCache struct {
	files map[string]*staticFile
	// inject rewrites each HTML document after the CSS transform, before hashing.
	// Used to substitute {{SITE_URL}} in the search metadata (canonical, og:url)
	// — see seo.go. Set before loadStatic processes anything.
	inject func(string) (string, error)
	// loadedAt is the build time of the asset set, used as the sitemap lastmod.
	loadedAt time.Time
}

// lastModUTC is the sitemap's <lastmod>. There is no VCS here and the assets are
// baked into the binary, so the honest value is when this process loaded them.
func (c *staticCache) lastModUTC() string {
	t := c.loadedAt
	if t.IsZero() {
		t = time.Now()
	}
	return t.UTC().Format("2006-01-02")
}

// loadStatic preloads and transforms the asset set. inject, when non-nil,
// rewrites each HTML document after the CSS transform and before hashing (used
// to substitute {{SITE_URL}} — see seo.go). It is a parameter rather than a
// field set afterwards because it runs DURING the load pass; assigning it post
// load would silently never fire.
func loadStatic(webDir string, assets map[string]struct {
	file  string
	ctype string
	html  bool
	// standalone = self-contained page (its own inline <style>, no external
	// stylesheet), so the inline-CSS transform must not touch it. The dev-only
	// /debug harness is the one such page.
	standalone bool
}, inject func(string) (string, error),
) (*staticCache, error) {
	c := &staticCache{files: map[string]*staticFile{}, loadedAt: time.Now(), inject: inject}
	for route, a := range assets {
		raw, err := os.ReadFile(filepath.Join(webDir, a.file))
		if err != nil {
			return nil, fmt.Errorf("static %s: %w", a.file, err)
		}
		c.files[route] = &staticFile{ctype: a.ctype, raw: raw, html: a.html, standalone: a.standalone}
	}
	// Version asset URLs inside HTML (cache-busting): /app.js → /app.js?v=<etag8>.
	// HTML itself is no-cache, so the next page load after a deploy picks up new
	// URLs instantly while asset bodies stay hard-cached for an hour.
	vers := map[string]string{}
	for route, f := range c.files {
		if f.html {
			continue
		}
		sum := sha256.Sum256(f.raw)
		etag := hex.EncodeToString(sum[:16])
		f.etag = `"` + etag + `"`
		vers[route] = etag[:8]
	}
	for _, f := range c.files {
		if !f.html {
			continue
		}
		html := string(f.raw)
		// Standalone pages (the /debug dev harness) carry their own <style> and
		// must skip the transform — but they still need an ETag computed below,
		// or an empty etag would match an absent If-None-Match and answer 304
		// to everyone.
		if !f.standalone {
			inlined, err := c.inlineStyles(html)
			if err != nil {
				return nil, err
			}
			html = inlined
			for assetRoute, v := range vers {
				html = strings.ReplaceAll(html, `"`+assetRoute+`"`, `"`+assetRoute+`?v=`+v+`"`)
				html = strings.ReplaceAll(html, `'`+assetRoute+`'`, `'`+assetRoute+`?v=`+v+`'`)
			}
		}
		// Search metadata last, so the site URL cannot be mangled by a version
		// rewrite and the ETag below covers the final bytes.
		if c.inject != nil {
			injected, err := c.inject(html)
			if err != nil {
				return nil, err
			}
			html = injected
		}
		f.raw = []byte(html)
		sum := sha256.Sum256(f.raw)
		f.etag = `"` + hex.EncodeToString(sum[:16]) + `"`
	}
	for _, f := range c.files {
		if len(f.raw) > 1024 {
			var buf bytes.Buffer
			gz, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			if err != nil {
				return nil, err
			}
			if _, err := gz.Write(f.raw); err != nil {
				return nil, err
			}
			if err := gz.Close(); err != nil {
				return nil, err
			}
			f.gz = buf.Bytes()
		}
	}
	return c, nil
}

// forever marks a route as always-revalidate: its URL is stable, so a cached
// copy would pin an old worker (or old script) forever. Only for sw.js.
func (c *staticCache) forever(route string) {
	if f, ok := c.files[route]; ok {
		f.noStore = true
	}
}

// Anchors for the inline-CSS transform. A page that stops using them is a build
// error, not something to silently skip: skipping would quietly put a
// render-blocking <link> back on the first-visit critical path.
const (
	shellLink     = `<link rel="stylesheet" href="/styles.css">`
	deferredLinks = `<link rel="preload" as="style" href="/states.css" onload="this.onload=null;this.rel='stylesheet'">` + "\n" +
		`<noscript><link rel="stylesheet" href="/states.css"></noscript>` + "\n"
)

// inlineStyles folds both stylesheets into the document: the above-the-fold
// shell goes in <head> (so first paint needs no extra round trip) and the
// deferred half goes just before </body> (parsed only once the shell can paint,
// and costing zero requests). Mirrors signal/web/inline-css.mjs, which the
// Pages build and the mobile bundle use — same transform, three hosts.
func (c *staticCache) inlineStyles(html string) (string, error) {
	shell, states := c.files["/styles.css"], c.files["/states.css"]
	if shell == nil || states == nil {
		return "", errors.New("static: /styles.css and /states.css must be loaded to inline them")
	}
	switch {
	case !strings.Contains(html, shellLink):
		return "", errors.New("static: page no longer links /styles.css — update inlineStyles")
	case !strings.Contains(html, deferredLinks):
		return "", errors.New("static: page no longer preloads /states.css — update inlineStyles")
	case !strings.Contains(html, "</body>"):
		return "", errors.New("static: page has no </body> for the deferred styles")
	}
	// strings.Replace, not regexp: it is a literal replacement with no $ expansion,
	// so a stylesheet containing "$&" or "$`" cannot rewrite the emitted page.
	html = strings.Replace(html, shellLink, "<style>"+minifyCSS(string(shell.raw))+"</style>", 1)
	html = strings.Replace(html, deferredLinks, "", 1)
	return strings.Replace(html, "</body>",
		"<style data-deferred>"+minifyCSS(string(states.raw))+"</style>\n</body>", 1), nil
}

// minifyCSS strips comments and collapses whitespace. Deliberately not a full
// minifier — the win is transfer size, and any real parser is out of scope for
// a stdlib-only server.
//
// Quoted strings are copied verbatim. A blind whitespace collapse rewrote
// `content:"Hello, world: friend"` into `content:"Hello,world:friend"`, so any
// punctuation inside a string value was silently corrupted. The JS twin is
// inline-css.mjs minifyCss and must keep the same behaviour.
func minifyCSS(css string) string {
	const punct = "{}:;,"
	var b strings.Builder
	b.Grow(len(css))
	for i := 0; i < len(css); {
		c := css[i]
		// Comment.
		if c == '/' && i+1 < len(css) && css[i+1] == '*' {
			if j := strings.Index(css[i+2:], "*/"); j >= 0 {
				i += 2 + j + 2
				continue
			}
		}
		// Quoted string: copy to the closing quote, honouring backslash escapes.
		if c == '"' || c == '\'' {
			q := c
			b.WriteByte(c)
			j := i + 1
			for j < len(css) {
				if css[j] == '\\' && j+1 < len(css) {
					b.WriteString(css[j : j+2])
					j += 2
					continue
				}
				b.WriteByte(css[j])
				if css[j] == q {
					j++
					break
				}
				if css[j] == '\n' { // unterminated: stop, do not swallow the file
					break
				}
				j++
			}
			i = j
			continue
		}
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' {
			// Collapse the run; drop it entirely when it only wraps punctuation.
			j := i
			for j < len(css) && strings.ContainsRune(" \t\n\r\f", rune(css[j])) {
				j++
			}
			var next byte
			if j < len(css) {
				next = css[j]
			}
			var prev byte
			if s := b.String(); s != "" {
				prev = s[len(s)-1]
			}
			if strings.IndexByte(punct, next) >= 0 || strings.IndexByte(punct, prev) >= 0 {
				i = j
				continue
			}
			b.WriteByte(' ')
			i = j
			continue
		}
		if c == ';' && i+1 < len(css) && css[i+1] == '}' {
			i++ // ;}
			continue
		}
		b.WriteByte(c)
		i++
	}
	return strings.TrimSpace(b.String())
}

// acceptsGzip reports whether Accept-Encoding really accepts gzip. The previous
// substring test also matched "gzip;q=0", an explicit refusal that crawlers and
// strict clients send — so those clients were handed a gzipped body they had
// asked not to receive, and would either fail to decode or ignore it.
func acceptsGzip(header string) bool {
	if header == "" {
		return false
	}
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(part, ";")
		name = strings.ToLower(strings.TrimSpace(name))
		if name != "gzip" && name != "*" {
			continue
		}
		// Default q is 1. Any explicit q=0 (or 0.0, 0.00 …) is a refusal.
		for _, p := range strings.Split(params, ";") {
			k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
			if ok && strings.EqualFold(strings.TrimSpace(k), "q") {
				if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && q <= 0 {
					return false
				}
			}
		}
		return true
	}
	return false
}

func (c *staticCache) handler(route string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, ok := c.files[route]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("If-None-Match") == f.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		h := w.Header()
		h.Set("Content-Type", f.ctype)
		h.Set("ETag", f.etag)
		if f.html {
			// HTML changes most often and is tiny: always revalidate, 304 when same.
			h.Set("Cache-Control", "no-cache")
		} else if f.noStore {
			// Stable URL + must-never-be-stale (service worker).
			h.Set("Cache-Control", "no-cache")
		} else {
			// Versioned-by-content in practice (hash in ETag): cache hard,
			// revalidate cheaply. No `immutable` — same-URL updates must propagate.
			h.Set("Cache-Control", "public, max-age=3600")
		}
		raw := f.raw
		if f.gz != nil && acceptsGzip(r.Header.Get("Accept-Encoding")) {
			h.Set("Content-Encoding", "gzip")
			raw = f.gz
		}
		// The response body varies by Accept-Encoding, so any shared cache must
		// key on it. Without this a CDN or corporate proxy is entitled to store
		// the gzip variant under the bare /app.js URL and replay it to a client
		// that cannot decode it — which fails the whole script. serveCORS adds
		// Vary: Origin for cross-origin requests only, so it never covered the
		// content encoding.
		h.Add("Vary", "Accept-Encoding")
		h.Set("Content-Length", itoa(len(raw)))
		w.Write(raw)
	}
}
