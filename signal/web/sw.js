// sw.js — static-shell cache for repeat visits. Deliberately narrow:
//   · only static assets are cached (app.<hash>.js / app.js / qrcode.js), never
//     documents, the REST API or WebSockets — a stale room list or a stale
//     SIGNAL_URL would be a real bug. The stylesheets and the backend config
//     are inlined into the HTML, so they travel with the document.
//   · content-hash URLs (Pages: /app.<hex>.js) are immutable by construction →
//     cache-first. A new deploy is a new cache key and propagates instantly.
//   · bare URLs (Go single-origin twins: /app.js?v=<etag>, /qrcode.js) carry no
//     content hash, so a cached copy IS the previous deploy's file —
//     network-first, never served stale (see below).
//   · everything else (documents, /api/*, /ws/*) → network only, no fallback to
//     cache, so a receiver can never be served a stale page.
// Bumped whenever the precache list changes. Nothing builds this file, so it is
// a literal an operator must edit — which is why the offline-shell cache had to
// be dropped rather than relied on (see PRECACHE).
const VERSION = "shell-v3";
const IMMUTABLE = /^\/app\.[0-9a-f]+\.js$/;
const CACHEABLE = /^\/(app\.js|qrcode\.js)(\?.*)?$/;
const PRECACHE = [];
// "/" is deliberately NOT precached: the fetch handler classifies it as a
// document and refuses to answer from cache, so caching it was dead weight and
// the "offline shell" claim could never hold. There is no offline shell.
const ALL = [...PRECACHE];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(VERSION)
      // Individually, so one 404 can't fail the whole install.
      .then(c => Promise.all(ALL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // signal backend lives elsewhere
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/ws/")) return;
  if (p === "/healthz" || p === "/metrics") return;
  const isDoc = req.mode === "navigate" || p === "/" || /^\/(r|receive|report)/.test(p);
  if (isDoc) return;                                     // documents: network only

  if (IMMUTABLE.test(p)) {
    e.respondWith(caches.open(VERSION).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { c.put(req, r.clone()); return r; }))));
    return;
  }
  if (!CACHEABLE.test(p)) return;

  // NETWORK-FIRST, not stale-while-revalidate. These URLs carry no content hash,
// so a cached copy IS the previous deploy's app.js. Serving it first ran old
// code against a new server and a new config for one page load after every
// release — meaning a security or protocol fix shipped in app.js did not reach a
// returning visitor until their second visit. Network-first costs one round trip
// on a repeat visit and never runs stale code.
  e.respondWith(
    fetch(req)
      .then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() =>
        // Offline: a cached asset beats nothing, but it must never be presented
        // as fresh. Documents still fall through to the network above, so this
        // only ever serves a script the visitor already had.
        caches.open(VERSION).then(c => c.match(req)).then(hit => hit || Response.error())
      )
  );
});
