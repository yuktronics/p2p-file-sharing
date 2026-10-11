// Routing invariants for the Cloudflare build.
//
// These are the checks that would have caught the two production bugs found on
// the first live deploy:
//
//   1. /r/<id> 200-rewrote to /receive.html, then Cloudflare's default
//      html_handling 307'd it to /receive — dropping the room id. The recipient
//      arrived at a page with no room to join, and the sender saw a normal link.
//   2. /privacy 301'd to /privacy.html, which 307'd back to /privacy: an
//      infinite redirect loop, on a page linked from the nav of every page.
//
// Both are invisible in unit tests and obvious in a browser, which is why they
// are asserted here against the real dist/ output rather than left to review.
//
// Run: node tests/routes-harness.mjs   (after a build)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..");
const DIST = join(WEB, "dist");
const ROOT = join(WEB, "..", "..");

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
  return cond;
};

// The harness is useless if it silently passes on a missing build, so refuse
// outright rather than reporting a green run over nothing.
if (!existsSync(DIST)) {
  console.error("routes: no dist/ — run `node build-pages.mjs` first.");
  process.exit(1);
}

const redirects = readFileSync(join(DIST, "_redirects"), "utf8")
  .split("\n").map(l => l.trim())
  .filter(l => l && !l.startsWith("#"))
  .map(l => {
    const [from, to, code] = l.split(/\s+/);
    return { from, to, code: Number(code || 200) };
  });

const cfg = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")
  .replace(/^\s*\/\/.*$/gm, ""));

// ---- 1. html_handling must be the Cloudflare default ----------------------
// Not a preference: "none" makes "/" stop resolving to index.html, so the site
// root 404s. Its side effect (a .html request 307s to the extensionless form,
// firing on 200-rewrite targets too) is what check 4 and check 5 exist to
// survive.
ok(cfg.assets?.html_handling === "auto-trailing-slash",
  `assets.html_handling is "auto-trailing-slash" (got ${JSON.stringify(cfg.assets?.html_handling)})`);

// ---- 2. asset directory must match where the build writes -----------------
ok(cfg.assets?.directory === "./signal/web/dist",
  `assets.directory points at the build output (got ${JSON.stringify(cfg.assets?.directory)})`);

// ---- 3. no redirect loop --------------------------------------------------
// A rule whose target is itself a rule's source can bounce forever. /privacy ->
// /privacy.html is only safe because no rule matches /privacy.html; if the
// platform re-adds automatic .html handling, that assumption breaks silently.
const bySource = new Map(redirects.map(r => [r.from, r]));
let loops = [];
for (const r of redirects) {
  let cur = r.to, hops = 0;
  const seen = new Set([r.from]);
  while (bySource.has(cur) && hops < 10) {
    if (seen.has(cur)) { loops.push(`${r.from} -> ... -> ${cur}`); break; }
    seen.add(cur);
    cur = bySource.get(cur).to;
    hops++;
  }
}
ok(loops.length === 0, `no redirect loops (${loops.join("; ") || "none"})`);

// ---- 4. room links must keep the room id ---------------------------------
// The 200 rewrite target must NOT be something html_handling would rewrite, and
// the rewrite must be 200 (not 301) so /r/<id> stays in the address bar for
// initReceiver() to parse.
const room = bySource.get("/r/*");
ok(!!room, "/r/* rule exists");
ok(room?.code === 200, `/r/* is a 200 rewrite so location.pathname keeps the id (got ${room?.code})`);
// The target must be EXTENSIONLESS. This is the bug from the first deploy:
// html_handling 307s a .html target to its extensionless form after the rewrite
// lands, so /r/<id> resolved to /receive with the room id stripped — and the
// recipient's initReceiver() then had nothing to join.
ok(!/\.html$/.test(room?.to || ""),
  `/r/* target is extensionless so no 307 strips the room id (got ${room?.to})`);
// ...and the extensionless target must still resolve to a real file, which is
// what html_handling is for. Asserting only "not .html" would pass on a typo.
ok(existsSync(join(DIST, (room?.to || "") + ".html")),
  `${room?.to} resolves to a real file on disk (${room?.to}.html)`);

// ---- 5. report links likewise --------------------------------------------
const report = bySource.get("/report/*");
ok(!!report && report.code === 200, "/report/* is a 200 rewrite");
ok(!/\.html$/.test(report?.to || ""),
  `/report/* target is extensionless (got ${report?.to})`);
ok(existsSync(join(DIST, (report?.to || "") + ".html")),
  `${report?.to} resolves to a real file on disk`);

// ---- 5b. the site root must resolve ---------------------------------------
// The failure that pushed html_handling from "none" back to the default: with
// The platform maps "/" to index.html; assert the precondition that makes that
// work, not a _redirects rule that does not exist.
ok(cfg.assets?.html_handling !== "none" && existsSync(join(DIST, "index.html")),
  '"/" can resolve to index.html (html_handling on and the file is present)');

// ---- 6. every alias has a real target file --------------------------------
// A 301 to a missing file is a 404 one hop later, and only in production.
// Targets are extensionless and reach disk via html_handling, so accept either
// the literal path or its .html form.
const missing = redirects
  .map(r => r.to)
  .filter(t => t.startsWith("/") && !t.includes("*"))
  .filter(t => !existsSync(join(DIST, t)) && !existsSync(join(DIST, t + ".html")));
ok(missing.length === 0, `every rewrite target exists in dist/ (missing: ${missing.join(", ") || "none"})`);

// ---- 7. the nav links must resolve ---------------------------------------
// The nav is the one place a broken alias is guaranteed to be hit, so check
// the shipped HTML rather than assuming the routes cover it. Same
// extensionless-or-.html resolution as above.
const index = readFileSync(join(DIST, "index.html"), "utf8");
const navLinks = [...index.matchAll(/href="(\/[^"#?]*)"/g)].map(m => m[1]);
const uniqueLinks = [...new Set(navLinks)];
const resolvable = l => existsSync(join(DIST, l)) || existsSync(join(DIST, l + ".html"));
const unroutable = uniqueLinks.filter(l => {
  if (l === "/") return !resolvable("/index.html");
  if (resolvable(l)) return false;
  return !redirects.some(r => (r.from.endsWith("/*") ? l.startsWith(r.from.slice(0, -1)) : r.from === l));
});
ok(unroutable.length === 0,
  `every nav link resolves to a file or a rule (unroutable: ${unroutable.join(", ") || "none"})`);

// ---- 8. room + report paths must be noindex -----------------------------
// A room id is the bearer secret for a live transfer. The Go server sends
// X-Robots-Tag in single-origin mode (internal/server/seo.go); the split
// deployment had no equivalent, so every share link was served indexable
// (receive.html declares "index,follow" and /r/<id> 200-rewrites to it).
const headers = readFileSync(join(DIST, "_headers"), "utf8");
const blockFor = pat => {
  const lines = headers.split("\n");
  const i = lines.findIndex(l => l.trim() === pat);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) out.push(lines[j].trim());
  return out.join(" ");
};
for (const path of ["/r/*", "/report/*"]) {
  const block = blockFor(path);
  ok(!!block && /X-Robots-Tag:\s*noindex/i.test(block),
    `${path} sends X-Robots-Tag: noindex (got ${JSON.stringify(block)})`);
}
// robots.txt must NOT disallow them, or the crawler never fetches the URL and
// therefore never reads the noindex header — the exact inversion that would
// put every share link into the index.
const robots = readFileSync(join(DIST, "robots.txt"), "utf8");
ok(!/^Disallow:\s*\/r\//m.test(robots) && !/^Disallow:\s*\/report\//m.test(robots),
  "robots.txt allows /r/ and /report/ so the noindex header is actually read");

// ---- 8a. security.txt ships verbatim and stays fetchable -----------------
// RFC 9116 contact file: researchers must find it, so it is a real file in
// dist (not a rewrite) and robots must not disallow its path.
const secPath = join(DIST, ".well-known/security.txt");
ok(existsSync(secPath), ".well-known/security.txt exists in dist");
const secBody = existsSync(secPath) ? readFileSync(secPath, "utf8") : "";
ok(/^Contact:\s*\S+/m.test(secBody) && /^Expires:\s*\S+/m.test(secBody),
  "security.txt carries Contact and Expires");
ok(!/^Disallow:\s*\/\.well-known\//m.test(robots),
  "robots.txt does not disallow /.well-known/");

// ---- 8b. the Pages host must carry the SAME security headers as the Go host -
// In the split deployment the Pages host is the one every user actually loads,
// so a header dropped there is the header users get. Only the two noindex
// blocks were checked, which meant dropping Referrer-Policy — the header
// security.go names as protecting the room-id share secret — still passed 17/17.
// TestSecurityHeadersPresent pins the Go side; this pins the Pages side against
// the same list.
const globalBlock = blockFor("/*");
ok(!!globalBlock, "_headers has a /* block (global security headers)");
for (const h of [
  "X-Content-Type-Options: nosniff",
  "Referrer-Policy: no-referrer",
]) {
  const key = h.split(":")[0].toLowerCase();
  ok(new RegExp(key.replace(/[-]/g, "\\-") + ":", "i").test(globalBlock || ""),
    `/* block sets ${h} (got ${JSON.stringify(globalBlock)})`);
}
// Framing lives ONLY in per-path blocks: Cloudflare merges every matching
// block, so X-Frame-Options / CSP in /* would duplicate the per-path ones and
// browsers would enforce the stricter copy. Every listed path therefore
// carries its own framing headers — DENY except the two architecture paths.
// blockFor addresses single-path blocks; the PAGES-shared block (/, /receive,
// /report.html, …) is covered by the totals below instead.
for (const p of ["/blog", "/blog/*", "/r/*", "/report/*",
  "/qrcode.js", "/sw.js", "/signal-config.json"]) {
  const block = blockFor(p);
  ok(!!block && /X-Frame-Options:\s*DENY/i.test(block), `${p} denies framing`);
  ok(!!block && /frame-ancestors 'none'/.test(block), `${p} CSP denies framing`);
}

// The pages must be INLINED, not left linking the stylesheets: a silently
// skipped inline-css transform puts a render-blocking <link> back on the
// critical path (measured cost of the regression: FCP -48%/-54%).
for (const page of ["index.html", "receive.html", "report.html", "privacy.html", "contact.html",
  "blog.html",
  "blog/send-large-files-no-size-limit.html",
  "blog/wetransfer-alternative.html",
  "blog/send-files-without-account.html",
  "blog/is-p2p-file-sharing-safe.html",
  "blog/send-large-videos-photos.html"]) {
  const html = readFileSync(join(DIST, page), "utf8");
  ok(!/<link[^>]+href="\/styles\.css"/.test(html), `${page} has no render-blocking /styles.css link`);
  ok(!/<link[^>]+href="\/states\.css"/.test(html), `${page} has no /states.css link`);
  ok(/<style>[\s\S]*<\/style>/.test(html), `${page} has inlined CSS`);
  ok(!html.includes("{{"), `${page} has no surviving build placeholder`);
}

// ---- 10. blog: every post resolves, links both ways, sitemap agrees -----
// The blog is the indexable content hub: a post that 404s in production while
// 200ing locally (or vice versa) is a silent SEO hole. Assert the dist/ files,
// the extensionless resolution, the cross-links, and sitemap agreement here.
{
  const slugs = [
    "send-large-files-no-size-limit",
    "wetransfer-alternative",
    "send-files-without-account",
    "is-p2p-file-sharing-safe",
    "send-large-videos-photos",
  ];
  ok(existsSync(join(DIST, "blog.html")), "blog.html exists (serves /blog)");
  for (const s of slugs) {
    const f = join(DIST, "blog", s + ".html");
    ok(existsSync(f), `blog/${s}.html exists (serves /blog/${s})`);
    if (!existsSync(f)) continue;
    const html = readFileSync(f, "utf8");
    // Extensionless canonical + og:url: a .html canonical would 307 under
    // html_handling and fork the canonical (same trap as the /r/* bug).
    ok(html.includes(`<link rel="canonical" href="{{SITE_URL}}/blog/${s}">`) || html.includes("/blog/" + s + '">'),
      `blog/${s} canonical points at the extensionless post URL`);
    ok(/\.html/.test(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || "") === false,
      `blog/${s} canonical has no .html extension`);
    // Structured data crawlers rank on.
    ok(html.includes('"@type":"BlogPosting"'), `blog/${s} ships BlogPosting JSON-LD`);
    ok(html.includes('"@type":"BreadcrumbList"'), `blog/${s} ships BreadcrumbList JSON-LD`);
    // Both-ways internal linking: post -> index, post -> sibling posts, home -> post.
    ok(html.includes('href="/blog"') || html.includes("href='/blog'") || html.includes('href="/blog"'),
      `blog/${s} links back to the blog index`);
    const others = slugs.filter(o => o !== s);
    const linkedOthers = others.filter(o => html.includes(`/blog/${o}`));
    ok(linkedOthers.length >= 2,
      `blog/${s} links to ${linkedOthers.length} sibling posts (want >= 2, got ${linkedOthers.join(", ") || "none"})`);
  }
  const blogIndex = readFileSync(join(DIST, "blog.html"), "utf8");
  const unlinked = slugs.filter(s => !blogIndex.includes(`/blog/${s}`));
  ok(unlinked.length === 0, `blog index links every post (missing: ${unlinked.join(", ") || "none"})`);
  ok(blogIndex.includes('"@type":"Blog"'), "blog index ships Blog JSON-LD");
  // Sitemap must agree with the files on disk: a post missing from the sitemap
  // is undiscoverable; a sitemap URL with no file is a crawl error.
  const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
  const missingFromSitemap = slugs.filter(s => !sitemap.includes(`/blog/${s}<`));
  ok(missingFromSitemap.length === 0,
    `sitemap lists every post (missing: ${missingFromSitemap.join(", ") || "none"})`);
  // Every internal /blog/* link across ALL pages must resolve to a file.
  const allHtml = ["index.html", "receive.html", "report.html", "privacy.html", "contact.html", "blog.html",
    ...slugs.map(s => `blog/${s}.html`)];
  const badBlogLinks = [];
  for (const page of allHtml) {
    const html = readFileSync(join(DIST, page), "utf8");
    for (const m of html.matchAll(/href="(\/blog[^"#?]*)"/g)) {
      // Normalise a trailing slash: /blog/ and /blog are the same index
      // (the former 301s to the latter on both hosts).
      const norm = m[1].replace(/\/+$/, "") || "/";
      const fileFor = norm === "/blog" ? "blog.html" : norm.slice(1) + ".html";
      if (!existsSync(join(DIST, fileFor))) badBlogLinks.push(`${page} -> ${m[1]}`);
    }
  }
  ok(badBlogLinks.length === 0, `every /blog link resolves to a file (${badBlogLinks.join("; ") || "all good"})`);
}

// ---- 10b. architecture experience ships whole ---------------------------
// The viewer + fullscreen wrapper travel together: the wrapper embeds the
// viewer, the sitemap advertises /architecture, and any internal link to it
// must resolve. A half-shipped pair (wrapper without viewer) is a blank page.
{
  ok(existsSync(join(DIST, "architecture.html")), "dist has architecture.html (wrapper)");
  ok(existsSync(join(DIST, "architecture-viewer.html")), "dist has architecture-viewer.html");
  const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
  ok(sitemap.includes("/architecture<"), "sitemap lists /architecture");
  const badArchLinks = [];
  for (const page of ["index.html", "receive.html", "report.html", "privacy.html", "blog.html"]) {
    const html = readFileSync(join(DIST, page), "utf8");
    for (const m of html.matchAll(/href="(\/architecture[^"#?]*)"/g)) {
      const fileFor = m[1] === "/architecture" ? "architecture.html" : m[1].slice(1) + ".html";
      if (!existsSync(join(DIST, fileFor))) badArchLinks.push(`${page} -> ${m[1]}`);
    }
  }
  ok(badArchLinks.length === 0, `every /architecture link resolves (${badArchLinks.join("; ") || "all good"})`);
}

// ---- 10c. framable architecture pages relax framing — and only they do ----
// The /architecture wrapper embeds its viewer same-origin, so those two paths
// override DENY with SAMEORIGIN (see framable() in seo.go). Every other page
// must keep denying, or the exception leaked.
{
  for (const p of ["/architecture", "/architecture-viewer"]) {
    const block = blockFor(p);
    ok(!!block && /X-Frame-Options:\s*SAMEORIGIN/i.test(block), `${p} allows same-origin framing`);
    ok(!!block && /frame-ancestors 'self'/.test(block), `${p} CSP narrows frame-ancestors to 'self'`);
  }
  // The /* block must NOT set framing headers itself: with merge semantics
  // they would duplicate every per-path one and re-deny the exception.
  ok(!/X-Frame-Options:/i.test(globalBlock || "") && !/Content-Security-Policy:/i.test(globalBlock || ""),
    "global block carries no framing headers (per-path only)");
  // Totals pin the whole file: 10 DENY blocks (PAGES-shared + 9 singles),
  // 2 SAMEORIGIN (architecture pair), nothing else.
  const headersText = readFileSync(join(DIST, "_headers"), "utf8");
  ok((headersText.match(/X-Frame-Options:\s*DENY/gi) || []).length === 10, "10 DENY blocks");
  ok((headersText.match(/X-Frame-Options:\s*SAMEORIGIN/gi) || []).length === 2, "2 SAMEORIGIN blocks");
  ok((headersText.match(/frame-ancestors 'none'/g) || []).length === 10, "10 deny-ancestors CSPs");
  ok((headersText.match(/frame-ancestors 'self'/g) || []).length === 2, "2 self-ancestors CSPs");
}

// ---- 9. the client must be able to find the room id in the path ----------
// Guards the assumption the whole /r/* scheme rests on: app.js parses the id
// out of location.pathname. If that parsing changes, /r/* stops working and
// this build should say so rather than shipping a link that cannot be opened.
// The bundle ships minified under a content-hash name — resolve it the same
// way section 11 does, and test the exact bytes served, not the source.
const { readdirSync: _ls } = await import("node:fs");
const _bundled = _ls(join(DIST)).filter(f => /^app\.[0-9a-f]+\.js$/.test(f));
ok(_bundled.length === 1, `dist/ holds exactly one hashed app bundle (found ${_bundled.length})`);
const appJs = readFileSync(join(DIST, _bundled[0]), "utf8");
ok(/parts\[0\]\s*===\s*["']r["']\s*\?\s*parts\[1\]/.test(appJs),
  "app.js still parses the room id out of location.pathname");


// ---- 11. the dev server must confine paths to dist/ -------------------------
// Confine means a PATH BOUNDARY. `file.startsWith(DIST)` also accepts a sibling
// whose name merely begins with "dist" (dist.bak, dist-old), and new URL(req.url)
// normalises ".." BEFORE decodeURIComponent runs — so %2f reintroduces it
// afterwards. /..%2fdist-old%2fsecret.txt resolved outside dist/ and was served.
const DEV_PORT = 5199;
{
  const { spawn } = await import("node:child_process");
  // A SIBLING of dist/, sharing its name prefix — dist-old, not dist/dist-old,
  // which would sit inside the served root and escape nothing.
  const sibling = join(WEB, "dist-old");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "secret.txt"), "SECRET-OUTSIDE");
  // The script lives in web/, not tests/ (this file's own directory).
  const srv = spawn(process.execPath, [join(WEB, "pages-dev-server.mjs")], {
    cwd: WEB, env: { ...process.env, PORT: String(DEV_PORT) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Surface a startup failure instead of reporting it as "server never came up".
  let spawnErr = "";
  srv.stderr.on("data", d => { spawnErr += d.toString(); });
  srv.on("error", e => { spawnErr += String(e); });
  const base = `http://127.0.0.1:${DEV_PORT}`;
  // The Pages build emits app.js minified under a content-hash name
  // (app.<hex>.js, immutable). Discover it from dist/ rather than hardcoding:
  // a hardcoded name would pass against a stale bundle and prove nothing.
  const { readdirSync } = await import("node:fs");
  const hashed = readdirSync(join(WEB, "dist")).filter(f => /^app\.[0-9a-f]+\.js$/.test(f));
  ok(hashed.length === 1, `dist/ holds exactly one hashed app bundle (found ${hashed.length})`);
  const appUrl = "/" + (hashed[0] || "app.js");
  const wait = async () => {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + appUrl, { redirect: "manual" }); if (r.status) return true; }
      catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };
  try {
    ok(await wait(), `pages-dev-server came up${spawnErr ? " (stderr: " + spawnErr.trim().slice(0, 300) + ")" : ""}`);
    // The in-dist control must still work, or the guard is just breaking things.
    ok((await fetch(base + appUrl)).status === 200, "in-dist asset still served");
    for (const u of [
      "/..%2fdist-old%2fsecret.txt",
      "/%2e%2e%2fdist-old%2fsecret.txt",
      "/../dist-old/secret.txt",
      "/..%5cdist-old%5csecret.txt",
    ]) {
      // A refused connection is also a pass — the point is that no file outside
      // dist/ is ever served, and fetch throws when nothing is listening.
      let leaked = false, code = 0;
      try {
        const r = await fetch(base + u);
        code = r.status;
        leaked = (await r.text()).includes("SECRET-OUTSIDE");
      } catch { code = "refused"; }
      ok(!leaked, `${u} must not reach a sibling directory (got ${code})`);
    }
  } finally {
    srv.kill();
    rmSync(sibling, { recursive: true, force: true });
  }
}

// ---- 12. browser translation: nothing blocks it, user data is excluded ----
// Strategy is browser-handled translation (no shipped dictionaries), so two
// things must hold: (a) no blanket translate="no" on <html>/<body> that would
// silently disable it everywhere; (b) user-controlled file names, the room
// code and the brand survive machine translation unmangled.
{
  const pages = ["index.html", "receive.html", "report.html", "privacy.html", "contact.html", "blog.html"];
  for (const page of pages) {
    const html = readFileSync(join(DIST, page), "utf8");
    ok(!/<html[^>]*translate\s*=\s*["']?no/i.test(html) && !/<body[^>]*translate\s*=\s*["']?no/i.test(html),
      `${page} does not blanket-disable translation`);
    ok(/class="brand"[^>]*translate\s*=\s*"no"/.test(html),
      `${page} brand lockup is excluded from translation`);
  }
  const idx = readFileSync(join(DIST, "index.html"), "utf8");
  ok(/id="nearbyCode"[^>]*translate\s*=\s*"no"/.test(idx),
    "room code is excluded from translation");
  ok(/<span translate="no">p2p file sharing<\/span>/.test(idx),
    "footer brand is excluded from translation");
  // File names render client-side: assert on the shipped bundle, not source.
  // The only translate="no" the bundle can carry comes from the row templates.
  ok(appJs.includes('translate="no"'),
    "shipped bundle excludes file names from translation");
}

// ---- 12. nav bars stay structurally uniform --------------------------------
// The receive-page regression was a control OUTSIDE .nav-links (flex
// space-between flung it to the bar's far edge). Pages legitimately differ in
// links, so this pins structure, not content: every nav control lives inside
// .nav-links, every nav links /contact, and nav divs balance.
{
  const navPages = ["index.html", "receive.html", "privacy.html", "blog.html", "contact.html",
    "blog/is-p2p-file-sharing-safe.html", "blog/send-files-without-account.html",
    "blog/send-large-files-no-size-limit.html", "blog/send-large-videos-photos.html",
    "blog/wetransfer-alternative.html"];
  for (const page of navPages) {
    const html = readFileSync(join(DIST, page), "utf8");
    const nav = html.match(/<nav class="top">[\s\S]*?<\/nav>/);
    ok(!!nav, `${page} has a top nav`);
    if (!nav) continue;
    const inner = nav[0].replace(/<svg[\s\S]*?<\/svg>/g, "");
    for (const id of ["themeBtn", "soundBtn"]) {
      if (!inner.includes(`id="${id}"`)) continue;
      const openPos = inner.indexOf('<div class="nav-links">');
      const btnPos = inner.indexOf(`id="${id}"`);
      const closePos = inner.indexOf("</div>", openPos);
      ok(openPos < btnPos && btnPos < closePos, `${page} #${id} sits inside .nav-links`);
    }
    ok(inner.includes('href="/contact"'), `${page} nav links /contact`);
    const opens = (inner.match(/<div\b/g) || []).length;
    const closes = (inner.match(/<\/div>/g) || []).length;
    ok(opens === closes, `${page} nav divs balance (${opens} opens)`);
  }
}

console.log(`\n${pass}/${pass + fail} green`);
process.exit(fail ? 1 : 0);
