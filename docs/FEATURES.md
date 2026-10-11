# FEATURES.md — signal v4 checklist

Status: `done` · `wip` · `todo` · `deferred` (with reason).

## Rooms (REST)
- [x] `done` Create room: `POST /api/rooms {files[], nearby}` → `{id, nearby, url}` (10-char ID, 4-digit nearby)
- [x] `done` Get room: `GET /api/rooms/{id}` → `{files, senderOnline, nearby}`
- [x] `done` Delete room: `DELETE /api/rooms/{id}` → 204 (also kills WS peers with `bye`)
- [x] `done` Validation: 1–20 files, name non-empty, 0 < size ≤ 50GiB → 400 otherwise
- [x] `done` Per-IP rate limit on create (`RATE_CREATE_PER_MIN`, default 10) → 429 + `Retry-After: 60`
- [x] `done` Per-IP rate limit on TURN creds (`RATE_TURN_PER_MIN`, default 30); `TRUST_PROXY` for XFF

## Signaling (WebSocket-first)
- [x] `done` `GET /ws/rooms/{id}?role=sender|receiver&peer={id}` — minimal RFC 6455, stdlib only
- [x] `done` Frame schema `{from,to,kind,payload}`; kinds: `offer|answer|ice|join|bye|presence|files|ping`
- [x] `done` Routing: `to:sender` → sender; `to:receivers` → broadcast; `to:{peerID}` → direct
- [x] `done` Server ping/pong (25s) + read deadlines — dead peers reaped, no half-open leaks
- [x] `done` Single sender enforced (second sender rejected with policy close)
- [x] `done` Presence events on join/leave: `{kind:presence, peers:[...], senderOnline}`
- [x] `done` Sender-drop grace (default 10s, `SIGNAL_GRACE`): receivers held, `bye` only after grace
- [x] `done` Late-join offer mailbox: cached broadcast offer replayed to receivers joining after the offer
- [ ] `todo` Binary frames (protobuf) — only if JSON routing shows in profiles
- [ ] `deferred` Redis pub/sub multi-node — single node first (see ARCHITECTURE.md §2.1 trigger)

## TURN credentials (FIREWALL-TRAVERSAL.md §3)
- [x] `done` `GET /api/rooms/{id}/turn` → coturn-REST HMAC-SHA1 creds + ordered `iceServers`
      (stun → turn UDP → turn TCP → turns 443)
- [x] `done` TTL configurable (`TURN_TTL`, default 3600s); disabled cleanly when no provider set (410 + reason)
- [x] `done` Secondary provider (`TURN2_HOST`/`TURN2_SECRET`) appended after primary (provider-blacklist fallback)

## Ops
- [x] `done` `GET /healthz`, `GET /metrics` (rooms_active, ws_conns, signals_routed, turn_minted)
- [x] `done` Static asset offload: preloaded into RAM at startup (zero disk I/O), ETag + 304
      revalidation, `Cache-Control: public,max-age=3600` for assets / `no-cache` for HTML,
      gzip pre-compressed once (qrcode.js 56KB → 11.7KB wire). Fail-fast on missing files.
- [x] `done` Browser-first audit: QR, chunking, backpressure, speed/ETA, themes (Dark / Light),
      icons, OTP, link building all run client-side. Server keeps only what MUST be
      central: room-ID uniqueness, TURN HMAC secret, presence fan-out, metrics.
- [x] `done` Per-product service port map (8090 p2p-file-sharing, 8091+ reserved) on the shared
      cloud firewall edge runbook.
      Loopback-only bind, one systemd unit per product, Caddy the sole public listener
- [x] `done` All config via env (docs/CONFIG.md); fail-fast on bad values
- [x] `done` Graceful shutdown: SIGTERM/SIGINT → stop listeners, 15s drain, bye + hang up every peer
- [x] `done` Product UI served: `/` sender + code entry, `/r/{id}` receiver, `/app.js` (explicit
      whitelist; adapted to wire v1: WS signaling, `/turn` ICE, presence/bye). `styles.css` and
      `states.css` are deliberately NOT routes — they are inlined into the pages at load/build
      time, so serving them separately would re-add a render-blocking request
- [x] `done` `/debug` dev-only loopback smoke page
- [x] `done` Prometheus exposition (`p2pfilesharing_*` HELP/TYPE/counter/gauge)

## Abuse (launch-blocking)
- [x] `done` Public report: `POST /api/rooms/{id}/report {reason, contact?}` (reasons: spam/malware/phishing/csam/other; rate-limited 5/min/IP) + `/report/{id}` page linked from receiver
- [x] `done` Operator disable: `POST /api/admin/rooms/{id}/disable` (Bearer `ADMIN_TOKEN`) → peers get bye+hangup, tombstone kept (cap 1000)
- [x] `done` Disabled rooms read `451 room_disabled` (REST) and WS-close `4401` (receiver shows disabled notice); nearby code freed; reports on disabled rooms still filed, answering `200 already_disabled`
- [x] `done` Inbox: `GET /api/admin/reports`; empty token → `503 admin_disabled` (fail closed, not silent 401)

## Client pipeline (frontend builds against WIRE-PROTOCOL.md)
- [x] `done` Selective download (DataChannel file protocol v2): per-file ⬇ buttons + Download-all,
      sender serves `want`/`wantAll` FIFO with per-file header/chunks/eof, addressed by stable `fid`
      (indices shift when the sender edits its list, which would silently re-point a request)
- [x] `done` One peer connection per receiver: a single PC cannot serve two receivers (both answer
      the same `offer`, the second `setRemoteDescription` fails in the wrong signaling state, so the
      second tab silently never gets files). The sender keeps a `Map<peerId, Link>` and addresses
      `to:<peerID>`, so two receiver tabs both transfer, each with its own queue, and one receiver
      reloading no longer disturbs another's in-flight transfer
- [x] `done` Reconnect after a peer reloads: each of the sender's links is disposable
      (`ensureLink`/`rebuildLink`, generation-stamped + `dead`-flagged so late events from a replaced
      PC are ignored), rebuilt on `dc.close`, a failed connection state, or a `presence` frame; the
      receiver drops a dead PC before queueing a want. The server also drops its offer mailbox when
      the last receiver leaves, and never mailboxes a peer-addressed offer — a cached offer pointed
      at a peer that no longer exists, so a refreshed receiver answered a dead remote description
      and its channel never opened. Verified across 3 refresh cycles
- [x] `done` One terminal state for a receive that will not complete (`endRx`): `bye`, channel close,
      ICE failure, sender offline past the 10s grace, sender removing the file, and "request that
      never started" all share it, so none of them can leave a frozen progress bar, a `⏳` row, or a
      watchdog nagging about a stall the sender caused on purpose
- [x] `done` Request watchdog: a `want` with no `header` is re-asked once over a rebuilt link at 10s
      and fails loudly at 25s. A click made while `presence` reports the sender offline does not queue
      at all — it says so and stays retryable. The stall watchdog is no longer cleared on success, so
      a second download in the same session is still guarded
- [x] `done` Live file-list sync: sender add/remove rewrites the manifest over its own WS
      (`files` frame, sender-only, rebroadcast to receivers); removed files vanish from an already-open
      receiver page and are unrequestable. Receiver opens signaling on load (PC stays lazy) so it
      can learn about removals before anyone presses Download
- [x] `done` Interrupted transfers fail loudly, never half-save: file deleted mid-stream, sender tab
      closed (10s grace off the `presence` frame, since a closed channel lingers ~30s on an SCTP
      timeout), receiver tab closed (sender stops pushing via presence), or `bye`/failed connection
- [x] `done` The sender never claims success it did not deliver: `sendFile` returns `sent`/`aborted`/
      `error` and `pumpQueue` announces "all requested files sent" only when every queued file was
      actually sent on a live channel. An explicit Stop or a sender-side file removal is reported as
      what it was ("cancelled — you removed it mid-transfer", "nothing was saved by the receiver")
- [x] `done` Resettable sharing: Stop kills room + closes peer/channel and returns to file-picking
      state (edit list, re-share) — no refresh ever needed
- [x] `done` Zero-click start: the **first file starts the share**. There is no "Create private link"
      button to find and no "Add files" button competing with the drop zone — adding a file (click,
      drag, paste, or picker) mints the room and the link, and the zone then collapses to a slim
      always-valid drop strip. A "Start sharing again" control appears only after a deliberate Stop,
      which is the single case where the user is not adding anything new
- [x] `done` Drag & drop that works on Linux: reads `dataTransfer.items` (GNOME Files populates
      `items` and leaves `files` EMPTY, so reading only `files` was a silent no-op on Ubuntu),
      `preventDefault` on both `dragover` and `drop` (otherwise the browser navigates to the file),
      a `dragDepth` counter so `dragleave` on a child can't flicker the highlight, and a
      document-level drop so a miss on the compact zone can't navigate away and lose the share
- [x] `done` Delivery evidence (`ack`, WIRE-PROTOCOL.md): the receiver confirms each file *after*
      the write finishes, which is the only thing that lets the sender say "received" instead of
      guessing. A prominent Received panel, per-file ✓ badges, and a sealed completion animation
      are all gated on it; 20s of silence after `eof` degrades to "sent · no confirmation"
- [x] `done` End-to-end integrity (any file type: APK, ZIP, media…): the sender's `eof` carries
      the exact byte count + SHA-256 of what it sent (pure-JS incremental digest — no secure
      context needed for LAN `http://` shares; chunks clamped to the peer's
      `sctp.maxMessageSize` for cross-browser links). The receiver verifies count + digest
      before anything reaches disk: truncation or bit-flips fail loudly (row ❌, named
      shortfall), nothing is saved (a streaming partial is removed best-effort), and no
      `ack` is ever sent — so a corrupt file can no longer arrive wearing a ✓ (e.g. an APK
      that then refuses to install). Covered by `signal/web/tests/integrity-harness.mjs`
      (13 cases: truncation, bit-flip, slow-writer races, back-to-back close race, empty
      file, legacy-sender compat, real-sender roundtrip + digest truth, chunk clamp)
- [x] `done` Receiver cancel (`cancel` frame, WIRE-PROTOCOL.md): a ✕ button, visible only while a
      download is actually going, tells the sender to stop pushing over the still-open channel —
      the sender aborts at the next chunk and holds the link instead of reporting a failure, so a
      retry is instant and no `eof`/`ack` ever follows. Both sides reset progress widgets to zero,
      restore the rows to retryable, and say "nothing was saved"; unsolicited late headers are
      refused and post-cancel `eof` chatter stays silent for 30s. Covered by a 22-case Node harness
      (`signal/web/tests/cancel-harness.mjs`: mid-stream/pending/idle/done/partial/all-retry/late-frame
      + sender stop-and-recover + watchdog/offline/remove regressions)
- [x] `done` Link visual with six distinct states — `waiting` (dashed wire, slow search sweep),
      `linked` (solid wire, one calm pulse), `flowing` (speed-scaled packets, hot ends), `done`
      (sealed green wire, delivery sweep, tick), `lost` (red dashes, recoiling ends), `off`.
      A "hand joining" clasp — both devices reach for the middle, clasp, ring pulses out of the
      join point — fires the first time a receiver actually appears, and again on every reconnect
- [x] `done` Completion animation themed to the transfer instead of confetti: data chips leave the
      sender, travel the actual pipe, and pop into ticks at the receiver end, so the payoff lands
      on the thing the user was already watching
- [x] `done` 256KB chunks + bounded flow control (HIGH 4MB / LOW 1MB). `waitDrain` listens for
      `bufferedamountlow` **and** polls, and always gives up after 20s — trusting that event alone
      froze transfers permanently the moment a receiver backed up (observed: 16.5MB of 225MB).
- [x] `done` Progress rendering coalesced into one `requestAnimationFrame` (was ~10 DOM writes +
      3 string formats per 256KB chunk ≈ 160 forced style invalidations/sec, which starved the
      message handler and stopped SCTP from draining on Firefox)
- [x] `done` Streaming disk writes (directory pick → per-file stream; Blob fallback; Safari = Blob)
- [x] `done` TURN via `/turn` endpoint (ordered ladder), presence-driven UX (join notices, offline warnings)
- [x] `done` Hardened client transport: outbound WS frames queue until socket open (never drop the
      offer), `room.url` accepted absolute-or-path, QR + nearby code in one compact handoff panel
- [x] `done` Local QR generation (vendored MIT `qrcode-generator`, `web/qrcode.js`, SVG inline — no third party)
- [x] `done` Remotely-updatable backend address (docs/REMOTE-CONFIG.md): every client fetches
      `/signal-config.json` at startup and adopts the backend it names, with the compiled-in
      address demoted to a fallback (plus a last-known-good cache in localStorage). Moving the
      backend is now a push to the static host — deployed frontends follow on next load, with no
      rebuild. The bundle bakes the *config host*, which is
      stable, not the backend, which is not. The value is remote input so it is validated
      (absolute http(s), no embedded credentials) before it can steer a request; failures
      degrade to the previous value rather than breaking the app; room creation awaits it so a
      room is never created on a stale host. Verified by a test that builds the bundle once,
      swaps the config, and asserts traffic moves while the bundle's file hashes stay identical
- [x] `done` Two themes only, plainly named `Dark` and `Light` (was Ember/Midnight/Paper):
      Midnight removed, legacy `sd-theme` values migrated in place so upgrading users keep their
      choice instead of being reset
- [x] `done` Search optimisation: absolute canonical + full Open Graph/Twitter cards on
      every **indexable** page (`/`, `/privacy` — `report.html` is `noindex` and has
      no canonical or OG by design), `WebSite` + `SoftwareApplication` JSON-LD (the documented way to state a site-name
      preference), generated `robots.txt` + `sitemap.xml`, 1200x630 share card and real icon files.
      Written from Google Search Central, which changed two answers: **FAQ rich results were removed
      in May 2026** (so no `FAQPage` markup, despite the page having an FAQ), and **a `robots.txt`
      disallow silently defeats a `noindex`** — so the unbounded `/r/<room>` space is left crawlable
      and excluded via `X-Robots-Tag`, not `Disallow`, which would have got every share link indexed.
      Costs +0.9 KB gzipped with no measurable FCP change; 14 Go tests + a browser verifier.
      **Still open:** the H1 is a tagline, not a description.
- [x] `done` Backend security hardening (docs/SECURITY.md): CORS `*` → origin allowlist, nearby-code
      brute force rate limited (a 4-digit code is only 9 000 values), 16 KB request body cap → 413,
      filename validation against traversal + bidi/extension spoofing, `TRUST_PROXY=1` no longer
      spoofable (header only trusted from a private/loopback peer), `/debug` + `/metrics` fail closed,
      security headers (CSP, `no-referrer` — the room id is a share-link secret, `frame-ancestors
      'none'`), Slowloris timeouts, and a 32-peer cap per room so a room id is not an amplification
      primitive. 17 dedicated tests, each naming the attack it blocks
- [x] `done` Public privacy policy at `/privacy`: states
      what the server sees and what it never does — the P2P claim is verifiable, the bytes never
      reach the server. Served by the Go server and emitted by the Pages build, so the two
      deployments cannot drift from it
- [x] `done` Blog at `/blog` + 5 evergreen guides (`/blog/<slug>`): large files
      (no size limit), WeTransfer-vs-P2P comparison, no-signup sharing, P2P safety
      explainer, creator guide (4K/RAW). Each post: keyword-first title/description,
      absolute canonical + `og:type=article`, `BlogPosting` + `BreadcrumbList`
      JSON-LD (no `FAQPage`, no `aggregateRating`), inline SVG diagrams
      (zero extra requests, crawlable text), comparison tables, FAQ
      `<details>`, CTA + related-post links. Index ships `Blog` JSON-LD and links
      every post; home FAQ/nav/footer link both ways. Served identically by the
      Go server (explicit route map + slug allowlist, unknown slugs 404) and the
      Pages build (`blog.html` + `blog/<slug>.html`, extensionless); sitemap twins
      (`seo.go`/`seo.mjs`) list index (0.8) + posts (0.7); API-only hosts 404 the
      subtree. Pinned by `TestBlogPagesAreCanonicalAndIndexable`, the sitemap
      `want` map, and routes-harness check 10 (resolve + link + sitemap agreement).
- [x] `done` First-visit load budget (docs/PERF.md): `app.js` deferred (never blocks paint),
      both stylesheets inlined (no render-blocking request), QR encoder prefetched on idle
      instead of linked, `/healthz`+reveal+preconnect moved to idle, reflow-proof nav, and a
      static-shell service worker. Measured A/B against the pre-optimization build in the same
      window (11 interleaved pairs, cold cache, SW bypassed, throttled 4G): sender FCP
      676→352ms (−48%), receiver FCP 628→288ms (−54%), render-blocking bytes −17%/−37%,
      requests −20%/−40%, CLS 0.008→0.000; repeat visit 66.7KB→0.6KB. Two hosts share one
      fail-closed transform (Go `inlineStyles`, JS `inline-css.mjs` for Pages)
- [x] `done` Pages build ships a MINIFIED, content-hashed app bundle (`app.<hash>.js`,
      `minify-js.mjs`) cached `immutable` for a year, and INLINES the 205-byte backend
      config instead of shipping it as a parser-blocking script file. `minify-js.mjs`
      never joins lines (ASI-safe) and is validated by running the cancel (83/83) +
      integrity (13/13) harnesses against the minified bundle via `P2PFILESHARING_APP_SRC`,
      not by inspection. Same A/B window, 9 pairs, throttled 4G: sender FCP 660→576ms
      (−12.7%), receiver FCP 796→624ms (−21.6%), `load` −30%, total transferred
      −29.5%, render-blocking bytes −39.3%, requests −12.5%, CLS 0.000 both arms.
      Repeat visit unchanged (app bundle cache-first from the SW). `sw.js` v3: the
      `app.<hash>.js` pattern is cache-first, bare `/app.js` stays network-first
      (Go single-origin twins carry no content hash, so a cached copy IS the last deploy)
- [x] `done` Transport escalation UX (rung display Direct/Relayed via getStats, auto `restartIce()` on failed, stuck warning)
- [x] `done` Stall hardening (silent-freeze class): receiver binary path fully synchronous
      (ArrayBuffer mode, fire-and-forget ordered stream writes, close with timeout), sender
      send loop try/catch, 15s no-progress watchdogs both sides with one auto `restartIce()`,
      `dc.onerror` + `window.onerror` surfaced into chat
- [x] `done` Renegotiation-safe signaling (perfect negotiation lite): sender polite (answers every
      offer with rollback on glare), receiver impolite (own restart offer wins), all offers flow
      through `onnegotiationneeded` — restarts can no longer wedge the transfer
- [ ] `todo` Parallel DataChannels for striping (break SCTP head-of-line blocking — the remaining
      structural lever, see BENCHMARKS.md)
- [x] `done` First benchmarks run (docs/BENCHMARKS.md): ~10KB/conn idle, ~1.1µs/send fan-out,
      67µs routed RTT, 500-join storm in 194ms; follow-up: 50k/512MB still needs pool work + VM re-run
- [x] `done` Chunk-size sweep recorded honestly (docs/BENCHMARKS.md): 1MB/4MB never complete,
      16KB–256KB all 12–26MB/s, and the 64KB "44% win" was single-run noise (26.0 → 16.3 on repeat)
