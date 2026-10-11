# BENCHMARKS.md — signal v4 baseline (dev host, not VM)

Host: mid-range x86-64 laptop (6-core class), loopback. Method: `go test -bench`
in `signal/internal/server/bench_test.go`. Go heap only (RSS + kernel socket
memory extra, ~4KB/conn).

## Results (2026-09-27)

| Bench | Result | Notes |
|---|---|---|
| Idle receivers (2000 parked) | **18.9MB heap → ~9.9KB/conn** | Matches research band (Go ~10–15KB). Buffer shrink 64→16 showed no idle-heap change (buffers empty when parked) — wins appear under backlog |
| Fan-out (1 sender → 100 receivers) | **~1112 ns/send (~900k sends/s)** | Server-side routing enqueue only; receivers not reading (buffers absorb+drop) |
| Routed round-trip (loopback) | **~67µs** | App-level A→B→A through router; the budget ICE trickle actually experiences (internet adds its own RTT) |
| Join storm (500 rapid joins) | **194ms, ~28KB/join** | Presence is O(n²) — fine at 500, flagged as the storm-readiness risk |

## vs ARCHITECTURE.md §3 acceptance

- **50k idle < 512MB? MARGINAL.** 10KB heap + ~4KB kernel ≈ 14KB/conn → 50k ≈ 700MB.
  Path to target: shrink per-peer buffers 64→16, pool frame byte slices, coalesce presence.
- **Trickle RTT p99 < 50ms loopback?** Not yet measured — needs a dedicated RTT bench (WS echo + routing).
- **Reconnect storm 5k/10s?** Not yet run. Known risk found during benching: join presence is
  **O(n²)** (every join broadcasts to all peers) — a 2000-dial storm took ~90s. Fix before claiming
  storm readiness: presence deltas, or join batching.

## End-to-end file transfer (browser DataChannel, same PC)

Two Chromium windows on one host, sha256-verified. `CHUNK` is settable with `?chunk=<bytes>`
(Clamped to 16KB–256KB); default **256KB**.

| Run | File | Result |
|---|---|---|
| 120MB, 256KB chunks | `fileA.bin` | sha256 **MATCH**, **21.8–23.3 MB/s**, 0 page errors, sender `buffered=3.5MB` (under the 4MB cap) |

### Chunk-size sweep — no win, and the first result was noise
120MB over a loopback DTLS/SCTP channel, varying only the chunk size:

| Chunk | Outcome |
|---|---|
| 1MB, 4MB | **Never complete** — 0 bytes after 180s. Oversized messages stall the channel outright. |
| 16KB–256KB | All land at **12–26 MB/s** with heavy run-to-run variance. |
| 64KB repeat | 26.0 MB/s, then **16.3 MB/s** on an identical re-run. |

The apparent "44% win" for 64KB was **noise** — a single sweep run cannot resolve a difference
smaller than the variance. Conclusion: chunk size is not the lever; 256KB is kept as the default
with the 16KB–256KB clamp as a guard rail against the failure mode above. Don't re-run a
one-sample sweep and quote it as a result.

### What actually moved the number
The original 16.5MB/s ceiling was a **self-inflicted deadlock**, not a NAT or a SCTP limit:
`waitDrain()` waited only on `bufferedamountlow`, which does not fire on a backed-up channel, so
the send loop wedged forever at the first byte past the old 16MB high-water mark. Fixes, in order
of measured effect:
- Bounded drain: listen **and** poll every 40ms **and** hard-cap at 20s. Pinned by case **S6** in
  `signal/web/tests/cancel-harness.mjs`, which fills the stub channel's `bufferedAmount` above
  HIGH_WATER, asserts the sender stops issuing sends, then drains it and asserts the transfer
  resumes and reaches `eof`. (It could not be written until `world.mjs` learned a raisable
  `bufferedAmount`; while that was hard-coded to 0, deleting the backpressure gate entirely still
  passed the suite.)
- Water marks 16MB/8MB → **4MB/1MB**, so a slow receiver cannot build a 16MB backlog.
- Coalesced every progress DOM write into a single `requestAnimationFrame` on both sides. The
  receiver was doing ~10 DOM writes + 3 `fmt()` per 256KB chunk (~160 forced style invalidations/s),
  starving its own message handler until SCTP stopped draining.
- Re-armable stall watchdogs (one restart per 30s, re-armed on new stalls) instead of one-shot
  via a dead boolean.

**Next measured step, not yet attempted:** parallel DataChannels. One reliable-ordered channel
head-of-line blocks every later message, so striping N channels and reassembling per chunk
sequence is the remaining structural lever. Expect it to matter far more on lossy/Wi-Fi paths
than on loopback.

## Honesty notes
- Idle test has join-storm + server read-deadline (10s in test config) churn artifacts; treat
  9.9KB as order-of-magnitude, not a datasheet figure.
- Fan-out number excludes TCP/TLS and reader cost — pure routing throughput ceiling.
- Same-PC numbers are a ceiling, not a network result. Chromium only: Playwright cannot drive a
  system Firefox, so the Firefox main-thread-starvation diagnosis (progress renders blocking
  `onmessage`) is inferred from symptoms, **not reproduced** on a second engine.
- Re-run on the target 1GB micro VM before quoting capacity; loopback ≠ internet.
