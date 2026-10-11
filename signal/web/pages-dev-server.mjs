// Minimal stand-in for Cloudflare Pages/Workers static assets, for verifying
// the dist/ build locally. Honours _redirects (301s and 200 rewrites) so room
// links are exercised the same way they will be in production.
//
// Models wrangler.jsonc assets.html_handling, because that setting is what
// broke the first live deploy: with the Cloudflare default, /receive.html 307s
// to /receive, which fired on the /r/* rewrite target and stripped the room id.
// The first version of this server did not model it, so the bug passed every
// local check and only appeared once deployed. Set HTML_HANDLING=none to
// reproduce that failure on purpose.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "dist");
const PORT = Number(process.env.PORT || 5173);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

// Parse _redirects: "<from> <to> <code>"
const redirects = existsSync(join(DIST, "_redirects"))
  ? readFileSync(join(DIST, "_redirects"), "utf8")
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
      .map(l => { const [from, to, code] = l.split(/\s+/); return { from, to, code: Number(code || 200) }; })
  : [];

const send = (res, code, body, type) => {
  res.writeHead(code, { "Content-Type": type || "text/plain" });
  res.end(body);
};

// Mirrors wrangler.jsonc assets.html_handling. "auto-trailing-slash" is the
// Cloudflare default and rewrites /foo.html -> /foo with a 307; override the
// env var to reproduce the production bug locally.
const HTML_HANDLING = process.env.HTML_HANDLING
  || (() => {
      try {
        // dist/ -> signal/web -> signal -> repo root. Three levels, not two:
        // signal/wrangler.jsonc does not exist, and a try/catch that silently
        // falls back to the Cloudflare default hides exactly the mismatch this
        // is meant to surface.
        const cfg = JSON.parse(readFileSync(join(DIST, "..", "..", "..", "wrangler.jsonc"), "utf8")
          .replace(/^\s*\/\/.*$/gm, ""));
        return cfg.assets?.html_handling || "auto-trailing-slash";
      } catch (e) {
        console.warn(`pages-dev-server: could not read wrangler.jsonc (${e.message}); ` +
          "assuming html_handling=auto-trailing-slash, which reproduces the first-deploy bug");
        return "auto-trailing-slash";
      }
    })();

// Models wrangler.jsonc assets.html_handling = "auto-trailing-slash", which does
// TWO things, and the first version here only did one of them — so every
// extensionless path 404'd locally while working in production:
//
//   1. /foo.html  ->  307  /foo      (canonicalise away the extension)
//   2. /foo       ->  serves foo.html, and / -> index.html  (resolve to disk)
//
// (2) is what makes the extensionless _redirects targets work at all: /r/<id>
// 200-rewrites to /receive, and only the resolution half turns that into
// receive.html.
//
// Override HTML_HANDLING=none to reproduce the first deploy's broken behaviour
// (a .html rewrite target being 307'd, stripping the room id from share links).
function applyHtmlHandling(p) {
  if (HTML_HANDLING === "none") return p;
  const isFile = q => {
    // join(DIST, "/") collapses to DIST itself, which exists and is a
    // directory — so a bare "/" must be excluded or every request would look
    // like an exact asset hit and the root would redirect to itself forever.
    if (q === "/" || q === "") return false;
    const f = join(DIST, q);
    return existsSync(f) && statSync(f).isFile();
  };
  // The index file canonicalises to "/" specifically. Redirecting it to
  // "/index" would 404, and redirecting "/" to itself would loop.
  if (p === "/") return isFile("/index.html") ? "/index.html" : p;
  // The .html canonicalisation must be tested BEFORE the exact-asset case, or
  // /receive.html is served as-is and the 307 never happens — which is how a
  // .html rewrite target would look deceptively fine here.
  if (p.endsWith(".html")) {
    const stripped = p.slice(0, -5) || "/";
    if (isFile(stripped) || isFile(p)) return { redirect: stripped };
  }
  if (isFile(p)) return p;                     // exact asset
  if (isFile(p + ".html")) return p + ".html"; // extensionless -> the file
  return p;
}

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);

  for (const r of redirects) {
    // /r/* style: prefix match, tail appended to the target.
    if (r.from.endsWith("/*")) {
      const base = r.from.slice(0, -1);
      if (p.startsWith(base)) {
        const tail = p.slice(base.length);
        if (r.code === 301) { res.writeHead(301, { Location: r.to + tail }); return res.end(); }
        p = r.to; // 200 rewrite
        break;
      }
    } else if (p === r.from) {
      if (r.code === 301) { res.writeHead(301, { Location: r.to }); return res.end(); }
      p = r.to;
      break;
    }
  }

  // "/" is resolved by applyHtmlHandling (to /index.html, no redirect). It must
  // not be rewritten here: that would make it /index.html, which then
  // canonicalises back to "/" — a self-redirect loop on the site root.
  const handled = applyHtmlHandling(p);
  if (typeof handled === "object") {
    res.writeHead(307, { Location: handled.redirect });
    return res.end();
  }
  p = handled;

  // Confinement must be a PATH BOUNDARY, not a string prefix. startsWith(DIST)
  // also accepts a sibling whose name begins with "dist" (dist.bak, dist-old),
  // and new URL(req.url, base) normalises ".." BEFORE decodeURIComponent runs,
  // so %2f reintroduces it afterwards: /..%2fdist-old%2fsecret.txt resolved to
  // dist-old/secret.txt and was served. Verified before the fix (200).
  // path.relative is the correct primitive: ".." escapes always start with "..".
  const file = join(DIST, p);
  const rel = relative(DIST, file);
  const escapes = rel === "" || rel === ".." || rel.startsWith(".." + sep) ||
                  isAbsolute(rel);
  if (escapes || !existsSync(file) || !statSync(file).isFile()) {
    return send(res, 404, "not found");
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`serving dist/ on http://127.0.0.1:${PORT}`));
