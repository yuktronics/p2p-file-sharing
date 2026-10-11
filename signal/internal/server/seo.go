package server

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Search-engine metadata, mirroring signal/web/seo.mjs.
//
// The pages carry {{SITE_URL}} placeholders because the domain is decided at
// deploy time, not at author time — and canonical/og:url must be absolute, since
// Google rejects a relative canonical URL outright. Substitution happens once at
// load time, and it fails closed: if the site URL is unset, or a placeholder
// somehow survives, the server refuses to start rather than silently serving a
// page with a broken canonical (which would quietly cost canonicalisation).

var siteURLPlaceholder = regexp.MustCompile(`\{\{SITE_URL\}\}`)

// ANY {{...}} token, not just [A-Z_]+. The narrow pattern only caught
// upper-case placeholders, so {{SITE_URL2}}, {{site_url}} and {{SIGNAL-URL}}
// were substituted by nothing, detected by nothing, and served with a broken
// canonical. The JS twin (signal/web/seo.mjs injectSiteURL) had the same hole
// and both must be widened together.
var leftoverPlaceholder = regexp.MustCompile(`\{\{[^}]*\}\}`)

// injectSiteURL replaces {{SITE_URL}} with the given absolute site URL.
// Returns an error rather than a partially substituted document.
func injectSiteURL(html, siteURL string) (string, error) {
	base := strings.TrimRight(siteURL, "/")
	if base == "" || (!strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://")) {
		return "", fmt.Errorf("seo: SiteURL is not an absolute http(s) URL (set SIGNAL_SITE_URL, or SIGNAL_PUBLIC_BASE_URL)")
	}
	out := siteURLPlaceholder.ReplaceAllString(html, base)
	if m := leftoverPlaceholder.FindString(out); m != "" {
		return "", fmt.Errorf("seo: unsubstituted placeholder %q left in page", m)
	}
	return out, nil
}

// injectSiteURL is the Server-bound form used during load.
func (s *Server) injectSiteURL(html string) (string, error) {
	return injectSiteURL(html, s.cfg.SiteURL)
}

// Robots rules.
//
// One deliberate subtlety, and it is the whole reason this file exists:
// Google's documentation states that "if a page is disallowed from crawling
// through the robots.txt file, then any information about indexing or serving
// rules will not be found and will therefore be ignored". So room pages
// (/r/{id}, /report/{id}) are ALLOWED in robots.txt and excluded from the index
// with an X-Robots-Tag header instead. A Disallow would make the noindex
// invisible and get an unbounded set of share links indexed — the failure mode
// this is written to avoid.
const robotsBody = `# Room and report paths are intentionally ALLOWED here. They are excluded from the
# index with an X-Robots-Tag: noindex header, and that header is only read by a
# crawler that is allowed to fetch the URL. Disallowing them would silently
# defeat the noindex.

User-agent: *
Allow: /

# No search value; saves crawl budget.
Disallow: /api/
Disallow: /ws/
Disallow: /app.js
Disallow: /sw.js

Sitemap: %s/sitemap.xml
`

// robotsTxt renders robots.txt with the absolute sitemap URL.
func (s *Server) robotsTxt() string {
	return fmt.Sprintf(robotsBody, strings.TrimRight(s.cfg.SiteURL, "/"))
}

// sitemapXML lists only the pages meant to be indexed. Room URLs are absent on
// purpose: one per transfer, unbounded, and noindexed anyway. The blog index
// and every guide are listed: they are evergreen, people-first content (not
// doorway pages), and internal links run both ways between them and /.
func (s *Server) sitemapXML() string {
	base := strings.TrimRight(s.cfg.SiteURL, "/")
	stamp := s.static.lastModUTC()
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>%s/</loc>
    <lastmod>%s</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>%s/blog</loc>
    <lastmod>%s</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>%s/blog/send-large-files-no-size-limit</loc>
    <lastmod>%s</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>%s/blog/wetransfer-alternative</loc>
    <lastmod>%s</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>%s/blog/send-files-without-account</loc>
    <lastmod>%s</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>%s/blog/is-p2p-file-sharing-safe</loc>
    <lastmod>%s</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>%s/blog/send-large-videos-photos</loc>
    <lastmod>%s</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>%s/privacy</loc>
    <lastmod>%s</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>%s/contact</loc>
    <lastmod>%s</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>%s/architecture</loc>
    <lastmod>%s</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>
`, base, stamp, base, stamp, base, stamp, base, stamp, base, stamp, base, stamp, base, stamp, base, stamp, base, stamp, base, stamp)
}

// remoteConfigJSON is the document every client fetches at startup to learn
// where the backend lives NOW (see docs/DEPLOY.md — "changing the backend").
//
// The Go server serves it too, for two reasons. It makes the mechanism uniform
// across all three hosts (Pages, the Go server, the app bundle). And more
// practically: a same-origin client always asks for /signal-config.json, so a
// self-hosted deployment would otherwise log a 404 on every page load — noise
// that trains everyone to ignore the console, right where a genuine config
// failure would otherwise be visible.
//
// In a split deployment this file is served by the static frontend host instead.
// Here it names this server's own public base URL.
func (s *Server) remoteConfigJSON() string {
	return fmt.Sprintf("{\n  \"version\": %q,\n  \"signalUrl\": %q,\n  \"updatedAt\": %q\n}\n",
		s.cfg.AppVersion, strings.TrimRight(s.cfg.BaseURL, "/"), time.Now().UTC().Format(time.RFC3339))
}

// noindexRoom marks per-room URLs out of the index. Sent as a header rather than
// a meta tag because /r/{id} and /receive are the SAME file — only the handler
// knows which variant is being served.
func noindexRoom(h http.Header) {
	h.Set("X-Robots-Tag", "noindex, nofollow")
}

// noindex wraps a static handler so every response it produces carries
// X-Robots-Tag: noindex, nofollow. Must be applied BEFORE any other handler
// writes headers, so the header survives.
func (c *staticCache) noindex(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noindexRoom(w.Header())
		next(w, r)
	}
}

// framable relaxes the framing policy for static documentation pages that
// are MEANT to be embedded (the /architecture wrapper embeds its viewer).
// It replaces DENY with SAMEORIGIN and narrows frame-ancestors to 'self'.
// This does not open clickjacking: these responses carry no per-user state,
// no cookies or sessions exist to ride along, and there is nothing to click
// that changes state. Must wrap OUTSIDE the static handler (after
// securityHeaders), like noindex above.
func (c *staticCache) framable(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Content-Security-Policy", strings.Replace(
			h.Get("Content-Security-Policy"),
			"frame-ancestors 'none'", "frame-ancestors 'self'", 1))
		next(w, r)
	}
}
