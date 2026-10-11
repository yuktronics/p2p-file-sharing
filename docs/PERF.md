# PERF.md — first-visit load performance

Target: the time from "user opens the link" to "user can act" (drop a file, or
press Download) on a mid-range phone. Everything below is measured, not
estimated: real Chrome, cold cache, service worker bypassed, throttled to a
mobile 4G profile.

## Method

- **Two servers, one window.** A pre-optimization build (`git archive HEAD`
  binary + reconstructed pre-split assets) runs on `:8091`, the current one on
  `:8090`. Measurements **alternate A/B in ABBA order inside a single run**, so
  tunnel and edge drift hit both arms equally. 11 pairs per page.
- **Cold every time**: `Network.clearBrowserCache`, `setCacheDisabled`, and
  `setBypassServiceWorker` — otherwise the service worker turns a "first visit"
  measurement into a repeat visit (this happened once and is why the bypass is
  in the harness).
- **Throttle**: 150 ms RTT, 1.6 Mbps down, 750 Kbps up (DevTools "Fast 4G"-ish).
- **Metrics**: PerformanceObserver for LCP/long-tasks/CLS, Navigation Timing for
  TTFB/DCL/load, Resource Timing for bytes. Medians reported with min…max spread.
- CLS is attributed to the nodes that actually move
  (`layout-shift.sources[].node` + previous/current rects), not eyeballed.

Harness lives outside the repo (`~/.perf/`): `ab.mjs` (A/B), `cls.mjs` +
`cls-rect.mjs` (layout-shift attribution), `repeat.mjs` (service-worker repeat
visit), `shots.mjs` (visual), `responsive.mjs` (viewport guard).

## What changed

| Change | Effect on the first-visit path |
|---|---|
| `app.js` moved to `<head defer>` and self-boots | 39 KB of script no longer sits between the parser and first paint. Was the single biggest local cost: FCP landed *after* `window.load` |
| Both stylesheets **inlined** (shell in `<head>`, deferred half before `</body>`) | Removes the render-blocking stylesheet request entirely — one full RTT. The deferred half still parses after the shell can paint, at zero request cost |
| CSS split into shell (`styles.css`) + deferred (`states.css`) | Only what is above the fold can block paint. Marketing/transfer/terminal styles never gate it |
| `qrcode.js` no longer linked; fetched on idle, awaited when a room is made | 12 KB moves off the critical path; the receiver never fetches it at all |
| `/healthz` probe, scroll reveal, preconnect → `requestIdleCallback` | Nothing competes with critical resources for bandwidth or main thread |
| Nav made reflow-proof (`nowrap`, clamped pill/select widths, shed extras < 940px) | Kills the intermittent nav reflow (see CLS below) |
| `sw.js` static-shell cache (assets only, never documents/API/WS) | Repeat visit: 0.6 KB transferred instead of 66.7 KB |
| `app.js` minified + content-hashed, config inlined (Pages only) | 59.7 KB → 27.6 KB brotli, one request removed — see "Bundle shipping" below |

Two hosts run the same transform so they cannot drift: `internal/server/static.go`
`inlineStyles` (Go server) and `signal/web/inline-css.mjs` (Pages build).
Both **fail closed** if a page stops using
the expected anchors, and the Go side is pinned by `static_test.go`.

## Results (throttled 4G, 11 interleaved pairs, medians)

### Sender page `/`

| Metric | Before | After | Change |
|---|---|---|---|
| First Contentful Paint | 676 ms | **352 ms** | **−47.9 %** |
| Largest Contentful Paint | 676 ms | **352 ms** | **−47.9 %** |
| DOM Interactive | 633 ms | **267 ms** | **−57.8 %** |
| window.load | 636 ms | 542 ms | −14.8 % |
| Render-blocking bytes | 60.7 KB | **50.2 KB** | −17.4 % |
| HTTP requests | 5 | **4** | −20 % |
| Total transferred | 66.4 KB | 66.7 KB | +0.4 % |
| CLS | 0.008 | **0.000** | −100 % |

FCP spread: before 652–756 ms, after 276–372 ms — the distributions do not overlap.

### Receiver page `/receive`

| Metric | Before | After | Change |
|---|---|---|---|
| First Contentful Paint | 628 ms | **288 ms** | **−54.1 %** |
| Largest Contentful Paint | 628 ms | **360 ms** | −42.7 % |
| DOM Interactive | 645 ms | **236 ms** | −63.4 % |
| Render-blocking bytes | 60.7 KB | **38.4 KB** | **−36.7 %** |
| HTTP requests | 5 | **3** | −40 % |
| Total transferred | 63.5 KB | **51.8 KB** | **−18.4 %** |
| CLS | 0.023 | 0.014 | −40.5 % |

### Repeat visit (service worker + HTTP cache warm)

| Page | FCP | load | transferred | requests |
|---|---|---|---|---|
| `/` | 352 ms | 267 ms | **0.6 KB** | 4 |
| `/receive` | 296 ms | 222 ms | **0.6 KB** | 3 |

### Bundle shipping (Pages): minify + hash + inline the config

The Pingdom HAR of the live Pages deployment showed three requests, of which
**the largest was avoidable**: `app.js` at 181 KB uncompressed / **59.7 KB brotli**
served with `max-age=3600, must-revalidate`, and a 205-byte
`signal-config.<hash>.js` costing a full request as a parser-blocking classic
script before `app.js` even starts downloading.

| Change | What it removed |
|---|---|
| `minify-js.mjs` at build time | comments, blank lines, indentation — **181 KB → 89 KB raw, 59.7 KB → 27.6 KB brotli (−54 %)** |
| content-hash filename `app.<hash>.js` + `immutable` for a year | the `must-revalidate` round trip on every cold load, and the service worker gets a cache-first URL |
| backend config **inlined** into the HTML | one request (~200 bytes, of which the request cost was ~100× the payload) |

**Why a hand-rolled minifier and not a dependency:** the repo is stdlib-only, and
the transform has to be auditable. `minify-js.mjs` therefore refuses to join
lines — every newline in the source survives into the output, so automatic
semicolon insertion behaves exactly as written and the entire "minifier changed
the grammar" class is closed by construction. The one genuinely subtle case is
`/`: comment, division, or regex literal. It uses the standard
previous-token heuristic, and where the answer is ambiguous (`a / b`, `a / /re/`)
it keeps the space rather than risk corrupting the file.

**Verification is behavioural, not visual.** `tests/world.mjs` accepts
`P2PFILESHARING_APP_SRC`, so the cancel (83/83) and integrity (13/13) harnesses run
against the *minified bundle*; the build also re-checks that `window.SIGNAL_URL`
survives minification, and routes-harness asserts the room-id regex is still in
the shipped bytes and that exactly one hashed bundle exists in `dist/`.

### Measured: bundle shipping (throttled 4G, 9 interleaved pairs, cold cache)

| Metric | Baseline | After | Change |
|---|---|---|---|
| First Contentful Paint (`/`) | 660 ms | **576 ms** | **−12.7 %** |
| First Contentful Paint (`/receive`) | 796 ms | **624 ms** | **−21.6 %** |
| `window.load` | 1444 ms | **1006 ms** | −30.3 % |
| DOMContentLoaded | 1440 ms | **1003 ms** | −30.3 % |
| Total transferred | 314.4 KB | **221.7 KB** | **−29.5 %** |
| Render-blocking bytes | 236.1 KB | **143.3 KB** | **−39.3 %** |
| HTTP requests | 8 | **7** | −12.5 % |
| CLS | 0.000 | 0.000 | — |

FCP spreads do not overlap: 636–708 ms baseline vs 520–680 ms after. Repeat
visits are unchanged (78.3 → 78.4 KB, the SW serves the bundle cache-first); the
win is entirely on the cold path, which is where a first-time visitor lives.

## Honest caveats

- **Sender total bytes are flat (+0.4 %) on first visit.** The 12 KB QR encoder
  is now *prefetched* (after first paint) instead of blocking, so it still shows
  up inside the measurement window. That is the intended trade: instant QR when
  the first file is added, in exchange for nothing on the critical path. The
  receiver, which never needs a QR, is a real −18.4 %.
- **FCP is now bounded by the HTML document itself** (one RTT + ~16 KB gz). The
  next win would be trimming the inlined CSS or the markup, not another
  scheduling trick.
- **CLS 0.000 vs 0.023 is measured at 800×600 in headless Chrome.** The 0.023
  case was real and reproducible: reserving width for the server pill and
  clamping the `<select>` overflowed the 800 px row, which squeezed the wordmark
  into two lines (nav 35 px → 52 px). Fixed by making the bar reflow-proof, not
  by re-tuning the reservation.

## Defects found by measuring (not by looking)

1. **FCP was after `window.load`** locally — 39 KB of classic script in the body
   blocked the first paint. Found by noticing FCP > load.
2. **CLS 0.023 nav reflow**, from the width reservations meant to *fix* CLS.
   Found by attributing shift sources to nodes and rects.
3. **Mobile grid regression from the CSS split**: the marketing block was
   appended after the responsive media queries, so its `repeat(3,1fr)` beat the
   phone 1-column rule — 113 px-wide cards on a 390 px screen. Found by
   screenshotting a phone viewport; now guarded by `responsive.mjs`.
4. **Pre-existing mobile nav defect**: the wordmark wrapped to two lines at
   390 px *and* 768 px before any of this work (clipped by `overflow-x:hidden`).
   Now `nowrap`, and below 480 px the wordmark collapses to the logo mark.
