// Inject the absolute site URL into search metadata, and generate the crawler
// files that depend on it. Shared by the Pages build and the mobile bundle; the
// Go server does the same substitution in internal/server/seo.go.
//
// Why a placeholder and not a hardcoded URL: canonical and og:url MUST be
// absolute (Google will not accept a relative URL for either), but the domain is
// chosen at deploy time, not at author time. A build that ships a relative
// canonical silently loses canonicalisation, so this FAILS CLOSED when the site
// URL is missing or when any placeholder survives into the output.
//
// Exports used by both build scripts. No dependencies (node stdlib only), same
// rule as the rest of signal/web.

/** Normalise and validate a site URL, or return "" if unusable. */
export function normalizeSiteURL(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  if (/\s/.test(s)) return "";
  return s;
}

/**
 * Substitute {{SITE_URL}} everywhere in an HTML document.
 * Throws if the URL is missing or a placeholder survives — see above.
 */
export function injectSiteURL(html, siteURL, pageName) {
  const base = normalizeSiteURL(siteURL);
  if (!base) {
    throw new Error(
      `${pageName}: site URL is missing or not an absolute http(s) URL. ` +
      `Canonical and og:url cannot be relative — pass --site-url or set SIGNAL_SITE_URL.`
    );
  }
  const out = html.replace(/\{\{SITE_URL\}\}/g, base);
  // ANY {{...}} token, not just [A-Z_]+. The narrow pattern only caught
  // upper-case placeholders, so {{SITE_URL2}}, {{site_url}} and {{SIGNAL-URL}}
  // were substituted by nothing, detected by nothing, and shipped — a broken
  // canonical, which is exactly the silent failure this guard exists to stop.
  // The Go twin (internal/server/seo.go) had the identical hole.
  const left = out.match(/\{\{[^}]*\}\}/g);
  if (left) {
    throw new Error(`${pageName}: unsubstituted placeholder(s) left in output: ${[...new Set(left)].join(", ")}`);
  }
  return out;
}

/**
 * robots.txt.
 *
 * The room/report paths are deliberately ALLOWED even though they are noindexed.
 * Per Google: "If a page is disallowed from crawling through the robots.txt file,
 * then any information about indexing or serving rules will not be found and will
 * therefore be ignored" — so a Disallow here would make the X-Robots-Tag noindex
 * invisible and get the infinite room-URL space indexed instead. Allow crawling,
 * exclude from the index.
 */
export function robotsTxt(siteURL) {
  const base = normalizeSiteURL(siteURL);
  return `# robots.txt — ${base}
# Room and report paths are intentionally ALLOWED here. They are excluded from the
# index with an X-Robots-Tag: noindex header, and that header is only ever read by
# a crawler that is allowed to fetch the URL. Disallowing them here would silently
# defeat the noindex and put an unbounded set of share links into the index.

User-agent: *
Allow: /

# No search value; saves crawl budget.
Disallow: /api/
Disallow: /ws/
Disallow: /app.js
Disallow: /sw.js

Sitemap: ${base}/sitemap.xml
`;
}

/**
 * sitemap.xml. Only the pages that are meant to be indexed: the landing page, the
 * blog index + every guide, and the privacy policy. Room URLs are deliberately absent — one per
 * transfer, unbounded, and excluded from the index anyway.
 * Sitemap inclusion is a weak canonicalisation signal, which is why the pages
 * also carry rel=canonical.
 */
export function sitemapXml(siteURL, lastmod) {
  const base = normalizeSiteURL(siteURL);
  const stamp = (lastmod || new Date().toISOString().slice(0, 10));
  const urls = [
    { loc: `${base}/`, pri: "1.0", freq: "weekly" },
    { loc: `${base}/blog`, pri: "0.8", freq: "weekly" },
    { loc: `${base}/blog/send-large-files-no-size-limit`, pri: "0.7", freq: "monthly" },
    { loc: `${base}/blog/wetransfer-alternative`, pri: "0.7", freq: "monthly" },
    { loc: `${base}/blog/send-files-without-account`, pri: "0.7", freq: "monthly" },
    { loc: `${base}/blog/is-p2p-file-sharing-safe`, pri: "0.7", freq: "monthly" },
    { loc: `${base}/blog/send-large-videos-photos`, pri: "0.7", freq: "monthly" },
    { loc: `${base}/privacy`, pri: "0.3", freq: "yearly" },
    { loc: `${base}/contact`, pri: "0.3", freq: "yearly" },
    { loc: `${base}/architecture`, pri: "0.5", freq: "monthly" },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${stamp}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.pri}</priority>
  </url>`).join("\n")}
</urlset>
`;
}
