// Cloudflare Pages build for the web client.
//   SIGNAL_URL=https://signal.yourdomain.com node build-pages.mjs
// Output: dist/ — plain static files. No dependencies (node stdlib only).
//
// Why a build step exists: the Go server bakes asset hashes into HTML
// (?v=) and serves assets with a 1h max-age. Pages serves the files you give
// it, so hashing has to happen here instead: app.js is minified (see
// minify-js.mjs) and emitted with a content-hash filename, every page
// references it explicitly, and _headers gives it long-lived immutable
// caching. The 205-byte backend config is INLINED into each page instead of
// shipped as a file: it was a parser-blocking classic script costing a full
// request for ~200 bytes, and the HTML is max-age=0 anyway, so inlining has
// identical freshness with one fewer round trip.
//
// Fails closed if signal/web/app.js ever loses window.SIGNAL_URL support, or
// if a page stops loading /app.js literally (the injection anchor).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineCss } from "./inline-css.mjs";
import { minifyJs } from "./minify-js.mjs";
import { injectSiteURL, normalizeSiteURL, robotsTxt, sitemapXml } from "./seo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "dist");
const BLOG_SLUGS = [
  "send-large-files-no-size-limit",
  "wetransfer-alternative",
  "send-files-without-account",
  "is-p2p-file-sharing-safe",
  "send-large-videos-photos",
];
// Blog posts live in blog/<slug>.html so the extensionless post URLs
// (/blog/<slug>) resolve via html_handling, exactly like /receive does.
// Adding a post = one source file here + one slug in BLOG_SLUGS + the Go
// asset map + sitemap twins (seo.mjs here, seo.go there). All four must move
// together or one host serves a page the other 404s.
const PAGES = ["index.html", "receive.html", "report.html", "privacy.html", "contact.html", "blog.html",
  ...BLOG_SLUGS.map(s => `blog/${s}.html`)];
// qrcode.js ships (prefetched on idle, never linked). Both stylesheets are
// INLINED into the HTML by inlineCss() — shipping them separately would only
// reintroduce the very request this build exists to remove. app.js is NOT in
// this list: it ships minified under a content-hash name (see below), and a
// bare app.js in dist/ would be tens of KB of unreachable duplicate weight.
const ASSETS = ["qrcode.js", "sw.js", "og.png", "favicon.svg", "favicon.ico", "apple-touch-icon.png"];

const flag = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const SIGNAL_URL = (flag("--signal-url") || process.env.SIGNAL_URL || "").replace(/\/+$/, "");
if (!SIGNAL_URL) {
  console.error("build-pages: SIGNAL_URL (env or --signal-url) is required, e.g. https://signal.example.com");
  process.exit(1);
}
if (!/^https?:\/\//i.test(SIGNAL_URL)) {
  console.error(`build-pages: SIGNAL_URL must be http(s), got ${SIGNAL_URL}`);
  process.exit(1);
}
// The PUBLIC frontend origin — what canonical/og:url/sitemap must point at. It
// is NOT the signal backend: on a split deployment those are different hosts,
// and a canonical pointing at the API host would tell Google the wrong address
// for the page. Fail closed rather than emit a relative or wrong canonical.
const SITE_URL = (flag("--site-url") || process.env.SITE_URL || process.env.SIGNAL_SITE_URL || SIGNAL_URL).replace(/\/+$/, "");
if (!normalizeSiteURL(SITE_URL)) {
  console.error(`build-pages: --site-url / SITE_URL must be an absolute http(s) URL, got ${SITE_URL}`);
  process.exit(1);
}

const read = f => readFileSync(join(here, f), "utf8");
if (!read("app.js").includes("window.SIGNAL_URL")) {
  console.error("build-pages: REFUSING — app.js has no window.SIGNAL_URL support (apiUrl/wsUrl/originOf).");
  process.exit(1);
}

// The room id is read out of location.pathname by initReceiver(), so a rewrite
// that drops it turns every share link into a dead end. Two settings interact
// to break that, in files that live in different parts of the repo (this one,
// and wrangler.jsonc at the root), so both are checked here.
if (!existsSync(join(here, "..", "..", "wrangler.jsonc"))) {
  console.error("build-pages: REFUSING — no wrangler.jsonc at the repo root. The asset directory " +
    "and html_handling must be declared there for `wrangler deploy` to serve this build.");
  process.exit(1);
}
// Parse wrangler.jsonc (JSONC: JSON plus // comments) rather than regex-matching
// it. A regex over the raw text is brittle here — nested objects defeat [^}]*,
// and a comment mentioning "html_handling" would fake a pass. Both settings are
// load-bearing for this build, so they are read as values.
const wranglerPath = join(here, "..", "..", "wrangler.jsonc");
let wranglerCfg;
try {
  wranglerCfg = JSON.parse(readFileSync(wranglerPath, "utf8").replace(/^\s*\/\/.*$/gm, ""));
} catch (e) {
  console.error(`build-pages: REFUSING — could not parse wrangler.jsonc: ${e.message}`);
  process.exit(1);
}
if (wranglerCfg.assets?.html_handling !== "auto-trailing-slash") {
  // "none" is not a safe alternative: with it, "/" stops resolving to
  // index.html and the site root 404s. The _redirects targets are extensionless
  // precisely to suit this setting — see the comment above _redirects.
  console.error('build-pages: REFUSING — wrangler.jsonc assets.html_handling must be ' +
    '"auto-trailing-slash" (that is what makes / resolve to index.html).\n' +
    '  "none" makes the site root 404 instead.');
  process.exit(1);
}
if (wranglerCfg.assets?.directory !== "./signal/web/dist") {
  console.error(`build-pages: REFUSING — wrangler.jsonc assets.directory is ` +
    `${JSON.stringify(wranglerCfg.assets?.directory)}, but this build writes ./signal/web/dist. ` +
    "`wrangler deploy` would ship nothing.");
  process.exit(1);
}

// Mirror of the Go server's security headers (internal/server/security.go), so
// the Pages deployment is hardened identically. Two hosts serving the same app
// must not have different postures — the split deployment is exactly the case
// where a header added on one side silently goes missing on the other.
// The room id is a share-link secret, hence no-referrer (not same-origin).
// The CSP lives in its own const so the framing-relaxed twin below cannot
// drift from it: only frame-ancestors/X-Frame-Options may differ between them.
const CSP_BASE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src *; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const CSP_FRAMABLE = CSP_BASE.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
// Cloudflare MERGES every matching _headers block (it does not override), so a
// framing header in /* would duplicate the per-path one below — and browsers
// enforce the stricter of two X-Frame-Options and the intersection of two
// CSPs, silently re-denying the exception. Framing therefore lives ONLY in
// per-path blocks: DENY everywhere, SAMEORIGIN on the two architecture paths
// the wrapper embeds same-origin.
const frameDeny = `  X-Frame-Options: DENY
  Content-Security-Policy: ${CSP_BASE}`;
const frameSame = `  X-Frame-Options: SAMEORIGIN
  Content-Security-Policy: ${CSP_FRAMABLE}`;
// Unlisted static files (icons, robots.txt, sitemap.xml) inherit the frameless
// /* remainder: none of them is an interactive document, so there is nothing
// to clickjack. If a future interactive page ships without its own block, the
// totals check below fails closed.
const securityHeaders = () => `\
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(), microphone=(), camera=(), interest-cohort=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains

# Cloudflare Pages cache policy (replaces the Go static cache for this deployment)
`;

// Build into a staging directory and swap on success. Wiping DIST first meant
// a fail-closed guard firing part-way through left a HALF-BUILT dist/ (assets
// plus whichever pages had been written) instead of the previous good bundle —
// and a `|| true`, a Makefile, or any retried build that reused the stale
// directory would then publish it. Verified: an abort after the wipe left 9
// files, missing three pages and _headers/_redirects/robots/sitemap.
const STAGE = DIST + ".staging";
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const f of ASSETS) copyFileSync(join(here, f), join(STAGE, f));
// Security contact (RFC 9116): fixed path, must exist verbatim in dist/.
// Fail closed like everything else this build emits — no silent omission.
mkdirSync(join(STAGE, ".well-known"), { recursive: true });
copyFileSync(join(here, ".well-known/security.txt"), join(STAGE, ".well-known/security.txt"));
// Interactive architecture viewer (archify artifact): ships verbatim, like the
// file above. It must NOT join PAGES — that pipeline injects config, inlines
// CSS, and aborts without APP_TAG, all of which would corrupt a standalone
// viewer.
copyFileSync(join(here, "architecture.html"), join(STAGE, "architecture.html"));
// Generated viewer embedded by the wrapper above. Same verbatim treatment;
// it is linked only from /architecture, never advertised alone.
copyFileSync(join(here, "architecture-viewer.html"), join(STAGE, "architecture-viewer.html"));

// Two addresses, deliberately distinct: SIGNAL_URL is the API every request
// goes to, SIGNAL_SITE_URL is the host a person opens. In a split deployment
// they differ, and conflating them is what makes share links point at a host
// that serves no UI.
const cfgBody = `window.SIGNAL_URL = ${JSON.stringify(SIGNAL_URL)};\nwindow.SIGNAL_SITE_URL = ${JSON.stringify(SITE_URL)};`;
// Fail closed: a URL smuggling `</script` would break out of the inline block
// this config is injected into below. The SIGNAL_URL/SITE_URL shape checks
// above already reject almost everything; this rejects the rest.
if (/<\/script/i.test(cfgBody)) {
  console.error("build-pages: REFUSING — backend/site URL contains </script.");
  process.exit(1);
}

// app.js ships minified under a content-hash name, immutable for a year. The
// hash covers the MINIFIED bytes (what is actually served), so any source
// change — even a comment-only one the minifier strips — still yields a new
// filename exactly when the served bytes change... in the other direction:
// a comment-only edit yields the SAME filename, and that is correct, because
// the served bytes are identical.
const appMin = minifyJs(read("app.js"));
if (!appMin.includes("window.SIGNAL_URL")) {
  console.error("build-pages: REFUSING — minified app.js lost window.SIGNAL_URL support.");
  process.exit(1);
}
const appHash = createHash("sha256").update(appMin, "utf8").digest("hex").slice(0, 10);
const appName = `app.${appHash}.js`;
writeFileSync(join(STAGE, appName), appMin);

// app.js is deferred so it never blocks first paint; the inlined config runs
// during parsing (classic inline script, zero fetch), so SIGNAL_URL is set by
// the time app.js evaluates SIGBASE. The stylesheets are inlined (see
// inline-css.mjs).
const APP_TAG = '<script src="/app.js" defer>';
const shellCss = read("styles.css"), statesCss = read("states.css");
for (const p of PAGES) {
  let html = read(p);
  if (!html.includes(APP_TAG)) {
    console.error(`build-pages: ${p} no longer loads ${APP_TAG} — fix the page or this build.`);
    process.exit(1);
  }
  try { html = inlineCss(html, shellCss, statesCss, p); }
  catch (e) { console.error(`build-pages: ${e.message}`); process.exit(1); }
  // Search metadata: absolute canonical/og:url. Throws (and aborts) if the site
  // URL is unusable or a placeholder survives — a page with a broken canonical
  // looks fine and silently loses canonicalisation.
  try { html = injectSiteURL(html, SITE_URL, p); }
  catch (e) { console.error(`build-pages: ${e.message}`); process.exit(1); }
  html = html.replace(APP_TAG, () => `<script>${cfgBody}</script>\n<script src="/${appName}" defer>`);
  if (/signal-config\.[0-9a-f]+\.js/.test(html)) {
    console.error(`build-pages: REFUSING — ${p} still references a signal-config.*.js file (config is inlined now).`);
    process.exit(1);
  }
  // Blog posts live one directory down; the staging dir starts empty, so the
  // parent must exist before the write (flat pages never noticed).
  mkdirSync(join(STAGE, dirname(p)), { recursive: true });
  writeFileSync(join(STAGE, p), html);
}

writeFileSync(join(STAGE, "_headers"), `${securityHeaders()}
/${PAGES.join("\n/")}
/  Cache-Control: public, max-age=0, must-revalidate
${frameDeny}
# Blog: HTML like the pages above, but requested at extensionless URLs (/blog,
# /blog/<slug>) that never equal these file paths — so they get their own
# blocks. Same policy: revalidate every time, 304 when unchanged.
# (The Go server sends no-cache for HTML; the effect is identical.)
/blog
  Cache-Control: public, max-age=0, must-revalidate
${frameDeny}
/blog/*
  Cache-Control: public, max-age=0, must-revalidate
${frameDeny}
# Interactive architecture viewer: a stable public page like the ones above,
# requested at the extensionless /architecture that auto-trailing-slash
# resolves to architecture.html. Same policy: revalidate every time.
# (The Go server sends no-cache for HTML; the effect is identical.)
/architecture
  Cache-Control: public, max-age=0, must-revalidate
${frameSame}
/architecture-viewer
  Cache-Control: public, max-age=0, must-revalidate
${frameSame}
# Room and report paths are share-link SECRETS — a room id is the bearer token
# for a live transfer — and must never enter a search index. The Go server sends
# this header in single-origin mode (internal/server/seo.go); without it here the
# split deployment silently served every share link as indexable, since
# receive.html declares "index,follow" and /r/<id> 200-rewrites to it.
#
# robots.txt deliberately ALLOWS these paths: a Disallow stops the crawler
# fetching the URL, and X-Robots-Tag is only honoured by a crawler that fetched
# it.
/r/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: public, max-age=0, must-revalidate
${frameDeny}
/report/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: public, max-age=0, must-revalidate
${frameDeny}
/report.html
  X-Robots-Tag: noindex, nofollow
${frameDeny}
/${appName}
  Cache-Control: public, max-age=31536000, immutable
${frameDeny}
/qrcode.js
  Cache-Control: public, max-age=3600, must-revalidate
${frameDeny}
/sw.js
  Cache-Control: public, max-age=0, must-revalidate
${frameDeny}

# The remotely-updatable backend address. Cross-origin on purpose: the config
# host and the backend host are independent, so a page served anywhere must be
# able to read it. Never cached, so a change is visible on the very next launch.
#
# The service worker does NOT cache this path (it only precaches the app shell),
# so the only cache that could serve it stale is the HTTP cache — hence
# no-store here and cache-busting in the client request.
/signal-config.json
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, OPTIONS
  Cache-Control: no-store, no-cache, must-revalidate
  Vary: Origin
${frameDeny}
`);

// Pages serves static files only, so the paths the Go server serves via explicit
// routes need rewrites here. Without these the SPLIT deployment is broken in a
// way nobody would notice locally: /privacy 404s, and — far worse — every
// /r/<room> share link and every /report/<room> link 404s, because Pages has no
// router and no SPA fallback.
//
// Routing.
//
// Targets are EXTENSIONLESS. Cloudflare resolves /receive to receive.html itself
// (html_handling "auto-trailing-slash", set in wrangler.jsonc), and that same
// setting 307s any .html request to its extensionless form — including the
// target of a 200 rewrite. So:
//
//   /r/<id> -> /receive.html   200 then 307 -> /receive   room id GONE
//   /r/<id> -> /receive        200, resolved to receive.html
//
// initReceiver() parses the id out of location.pathname, so the first form
// leaves the recipient on a page with no room to join while the sender sees a
// perfectly normal link. The 301 aliases below are likewise unnecessary: the
// platform already maps /privacy -> privacy.html.
//
// The rewrites are 200 rather than 301 precisely so /r/<id> stays in the
// address bar. A redirect would move the client off the room path before any JS
// runs.
writeFileSync(join(STAGE, "_redirects"), `/privacy-policy  /privacy  301
/blog/  /blog  301
/r/*  /receive  200
/report/*  /report  200
`);

// The 200-rewrite targets must be extensionless. This is the invariant that
// actually protects share links, and it is checked on the generated file rather
// than assumed: with html_handling "auto-trailing-slash", a .html target is
// 307'd to its extensionless form AFTER the rewrite lands, so /r/<id> would
// resolve to /receive with the room id gone.
const generatedRedirects = readFileSync(join(STAGE, "_redirects"), "utf8");
for (const line of generatedRedirects.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const [, to, code] = t.split(/\s+/);
  if (code === "200" && /\.html$/.test(to || "")) {
    console.error(`build-pages: REFUSING — 200-rewrite target "${to}" ends in .html.\n` +
      "  Cloudflare would 307 it to the extensionless form and strip the room id\n" +
      "  from every share link. Use the extensionless path; see _redirects above.");
    process.exit(1);
  }
}


writeFileSync(join(STAGE, "robots.txt"), robotsTxt(SITE_URL));
writeFileSync(join(STAGE, "sitemap.xml"), sitemapXml(SITE_URL));

// ── The remotely-updatable backend address ─────────────────────────────────
// This single file is what makes a backend change shippable without rebuilding
// anything. An installed APK (and the web build) fetch it at startup and adopt
// whatever backend it names; the address baked into the app is only a fallback.
//
// Change SIGNAL_URL, redeploy, and every already-installed app follows on its
// next launch. That is the whole mechanism.
//
// _headers must send Access-Control-Allow-Origin for this path: the config host
// and the page host can differ, so the fetch is cross-origin and would
// otherwise be blocked. That detail is the difference between this working and
// silently falling back to the baked value.
const remoteConfig = {
  // Bumped by hand when the address changes; shown in the app so a user on a
  // stale cached config can tell the operator which build they are running.
  // It is the hash of the baked addresses (not the app hash): an app-only
  // change must not look like a backend move.
  version: createHash("sha256").update(cfgBody).digest("hex").slice(0, 10),
  signalUrl: SIGNAL_URL,
  updatedAt: new Date().toISOString(),
};
writeFileSync(join(STAGE, "signal-config.json"), JSON.stringify(remoteConfig, null, 2) + "\n");

// Every guard has passed: swap the staging directory into place. rmSync+rename
// rather than copying into DIST, so dist/ is never observed half-written and the
// previous good bundle survives any failure above.
rmSync(DIST, { recursive: true, force: true });
renameSync(STAGE, DIST);

console.log(`build-pages: ${PAGES.length} pages + ${ASSETS.length} assets + ${appName} (${Buffer.byteLength(appMin, "utf8")} B minified) → ${DIST}`);
console.log(`build-pages: SIGNAL_URL=${SIGNAL_URL}`);
console.log(`build-pages: SITE_URL=${SITE_URL}  (canonical / og:url / sitemap origin)`);
