# p2p file sharing v4 — research-backed architecture (clean slate)

> Previous Go prototype (signaling + UI) removed after a full research pass.
> Git history retains it (`c8614ad` and earlier). This doc is the decision record.

## 0. Verdict: can we beat Go on raw performance?

**Signaling (WebSocket fan-out): yes, ~1.3–1.5x single-node** — but it is lever #4, not #1.

| Stack | Independent numbers found | Source |
|---|---|---|
| Rust `wtx` / `tokio-tungstenite` | Top async echo throughput (~300–500k msgs/s); 100k conns: ~8.5KB/conn, p99 ~3.1ms | c410-f3r matrix (open methodology); 3-month Rust-vs-Go study |
| C++ uWebSockets (bare uWS / Bun `publish()`) | ~5KB/conn idle; top broadcast fan-out; 20k reconnect storm absorbed (slowly, 9s) | EvilMartians 2026; Lemire 2023 |
| Go (`gobwas/ws`, `nbio`, `greatws`, fasthttp) | ~0.5–1GB per 1M idle conns; 717–790k TPS echo; naive `gorilla`+net/http ~20GB/1M | lesismal matrix; Druva 1M report |
| `gorilla/websocket` specifically | Trails modern libs (~2x slower connect, fat per-conn buffers) | lesismal matrix |

Discount vendor claims (Bun 7x, monoio 2–3x, C10M demos) — directionally right, absolute values rigged.
Thread-per-core + io_uring (`monoio`) only wins >4 cores and loses latency at low conn counts; `tokio-uring` is
effectively unmaintained. DPDK/kernel-bypass matters at Mpps/10M-conn scale — Enterprise-grade overkill for us.

**File transfer path: no server language matters at all.** Bytes go browser→browser over SCTP/DTLS/UDP.
Browser SCTP windows are small and fixed, so throughput ≈ window/RTT and collapses with latency; the pipeline is
`disk → JS → socket buffer → net → JS → disk`, slowest stage wins. WebTransport/QUIC (0-RTT, no sender HOL-block,
~20% faster bulk in studies) is **client↔server only** — it cannot do sender↔receiver P2P, so DataChannel stays.

**Where CPU/bandwidth really go** (LiveKit, Discord, Jitsi, coturn writeups agree):
1. TURN relay — 15–25% of sessions relay, and that minority is ~100% of server bandwidth cost. coturn is
   kernel-bound (UDP TX path); `--udp-recvmmsg` + UDP-GSO nearly **doubles** forwarding rate (~+91% TX pps,
   ~2.8x CPU efficiency); `--multiplex-peer` removes the 16k-session port cap.
2. TLS handshakes on churn — ECDSA P-256 + TLS 1.3 + resumption is the cheapest 10x; terminate at edge.
3. Per-connection memory + timer batching — decides max conns/box (2–10KB idle target).
4. Signaling language — 10–50% at most, only visible past ~100k conns/box.
5. Client pipeline tuning (chunks, backpressure, disk writes) — decides user-felt MB/s.

## 1. Topology (target)

```
                    ┌──────────── signal ────────────┐
 sender ──WSS──► LB ┤  stateless WS rooms            ├─WSS──► receiver
                    │  presence via Redis pub/sub    │
                    └──────────── TURN ──────────────┘
 STUN (public: Google/Cloudflare)      coturn ×2 (EU + US, DNS-RR)
      │ direct P2P (srflx/host, ~75-85%) │ relayed (~15-25%, metered)
      └──────── DataChannel SCTP/DTLS ───┘
```

- Rooms are **pinned to one signal node** (LiveKit pattern); signaling bridge proxies if we ever multi-node.
- TURN creds are short-lived, minted by signal via TURN REST API (`--use-auth-secret`).
- Paid tier funds relay: free = P2P only; paid = TURN priority + offline relay cache.

## 2. Component decisions

### 2.1 Signaling — Phase 1: modern Go + WebSocket (verifiable today, single binary)
- Drop HTTP long-poll (300ms–1s trickle latency) → **WebSocket trickle**, REST kept for room create/get.
- Modern WS lib (`gobwas/ws` or `coder/websocket`), **not** `gorilla` (2x slower per matrix).
- JSON frames now (debuggable); binary (protobuf/flatbuffers, LiveKit-style) only if profiling demands.
- Stateless + Redis pub/sub for presence/rooms (LiveKit `RedisRouter` pattern); coalesced heartbeats (15s);
  connection draining on SIGTERM; `/metrics` (conns, trickle RTT, RSS/conn).
- Phase 2 trigger (any of): >200k concurrent conns/box, GC-driven p99 regressions, or multi-core relay
  saturation → port to **Rust (`wtx`/tungstenite on tokio; `monoio` only if >4 cores saturated)**.
  Wire protocol stays identical, so the swap is painless. uWS/Bun is the alternate max-fan-out pick.

### 2.2 TURN — coturn, tuned, at the edge
- Flags: `--udp-recvmmsg --multiplex-peer` (+ `--udp-gso` where kernel/NIC allow), `relay-threads` ≈ cores,
  RSS on good NICs, one port-range per core behind L4 LB at scale.
- Placement beats hardware: 2× cheap 1–2 vCPU VMs (EU + US to start), DNS round-robin, TLS 443 listener,
  `max-bps`/`bps-capacity` caps, Let's Encrypt.
- Until ~80–90 TB/mo relayed, **managed TURN (Cloudflare $0.05/GB) beats self-hosted egress** — start managed.
- Self-host test rig: 3 nodes (loadgen / server / peer) with `turnutils_uclient -Y packet`; trust NIC TX pps,
  not generator-side numbers.

### 2.3 Client transfer pipeline (where user-felt MB/s lives)
- Chunks **256KB** (safe under ~1MB browser max), event-driven backpressure (`bufferedamountlow`), never
  sleep-polling; keep pipe full (bandwidth-delay product).
- 2–4 parallel DataChannels for multi-file (dodge per-stream ordered-delivery stalls; SCTP streams share
  congestion control, so cap it).
- Receiver writes: **File System Access streaming → disk** (Chrome/Edge, constant memory) → OPFS fallback
  (Firefox) → Blob assembly only for Safari (~4GB cap). This is the biggest large-file win.
- Trickle ICE aggressively; prefer host/srflx; show honest speed/ETA/sparkline (already in UI v3).

### 2.4 Edge & TLS
- Terminate TLS at LB/edge; ECDSA P-256, TLS 1.3 only, session resumption; HSTS.
- Static UI on CDN with immutable caching; signal nodes regional (EU/US/APAC as users dictate).

## 3. Acceptance benchmarks (run before calling it fast)
- Signal: 50k idle WS conns < 512MB RSS; ICE-trickle RTT p99 < 50ms loopback; reconnect storm 5k/10s absorbed.
- TURN: `uclient` packet flood — record NIC TX pps + sys CPU; GSO/recvmmsg on vs off.
- E2E: 1GB file, LAN (<1ms) and simulated 50ms RTT — report MB/s + receiver peak RSS (streaming vs Blob).

## 4. Build order
1. Signal v4: WS-first rooms + presence + REST creds minting (Go, single binary).
2. Client pipeline: 256KB chunks, backpressure events, parallel channels, streaming writes.
3. TURN: managed first, coturn rig + tuning when bill justifies.
4. Scale-out: Redis bus, room pinning, region-aware selection, draining.
5. Phase-2 language port only on measured trigger (§2.1).

## 5. Key sources
- WS matrices: lesismal/go-websocket-benchmark; c410-f3r fastest-websocket; Lemire Bun-vs-Node 2023;
  EvilMartians 2026; Druva 1M-Go; MigratoryData/oatpp C10M (vendor, discounted).
- WebRTC arch: LiveKit SFU/distributed/mesh docs + `redisrouter.go`; Cloudflare Calls anycast + TURN;
  Discord Elixir/Rust scaling posts; Jitsi JVB perf eval; ShareDrop/PairDrop technical docs.
- OS/protocol: monoio benchmarks; coturn `PerformanceIterationLog` (recvmmsg/GSO/multiplex-peer) + TURN wiki;
  Helsinki DataChannel/SCTP-window paper; W3C WebTransport explainer (client-server only); kTLS/offload notes.
