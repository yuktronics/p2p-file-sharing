# Overcoming strict NATs/firewalls for P2P file transfer

> Companion to `ARCHITECTURE.md`. Research synthesis (benchmarks, vendor docs, RFCs) — not lab-verified yet.
> Validation plan in §7.

## 0. Baseline numbers (why this matters)

- ~75–85% of consumer sessions connect direct (host + srflx via STUN); **15–25% need TURN**
  (Chrome UMA via GetStream; Twilio: "~85% STUN is all you need"). Enterprise: **40–60% need TURN**.
- With TURN properly configured, residual ICE failure is **~1.9%** (Fippo's call-failure analysis).
- Those relayed sessions are **100% of server bandwidth cost** — every byte crosses the server twice (in+out).

## 1. Know the enemy: three grades of restrictive network

| Grade | Policy | What dies | Survivor |
|---|---|---|---|
| 1 | UDP blocked, TCP open | host/srflx media, TURN/UDP | TURN/TCP :3478 |
| 2 | Port allowlist (80/443 only) | everything not on 80/443 | **TURN/TLS :443** (real TLS, public cert, valid SNI) |
| 3 | TLS-intercepting proxy or SNI allowlist | TURN/TLS (cert fails closed; proxy expects HTTP) | admin allowlist — or server relay over WSS (§5) |

Notes: `turns:` on **5349 alone is a trap** — correct TLS, wrong port, fails the same allowlist. Run TLS on **443**.
Browsers do NOT support RFC 6062 TCP allocations — keep UDP relay enabled server-side; only the client→relay
leg goes TCP. `iceTransportPolicy: 'relay'` is a diagnostic, never a production default (forces LAN pairs onto relay).

## 2. The bypass ladder (offer all rungs, ICE picks cheapest first)

```
host → srflx → TURN/UDP:3478 → TURN/TCP:3478 → TURN/TLS:443 → server relay (WSS)
```

| Rung | Added one-way latency | Throughput cost | Unlocks |
|---|---|---|---|
| TURN/UDP | +20–40ms | ~0 (proper congestion control) | symmetric NATs |
| TURN/TCP | +30–55ms | ~−20% (473→381 Mb/s, Xirsys/iceperf); HOL stalls at loss | UDP-blocked nets |
| TURN/TLS | +35–60ms | ~−50% (→223 Mb/s); TLS hs + double encryption | 443-only / DPI nets |
| WSS relay | highest (TCP+TLS+framing, stacked CC) | slowest, but looks like plain HTTPS | TLS-intercept proxies, auth proxies |

Client config (cheapest-first, short-lived creds minted by signal):

```js
const iceServers = [
  { urls: 'stun:stun.example.com:3478' },
  { urls: 'turn:turn.example.com:3478?transport=udp', username, credential },
  { urls: 'turn:turn.example.com:3478?transport=tcp', username, credential },
  { urls: 'turns:turn.example.com:443?transport=tcp', username, credential },
];
```

## 3. coturn config for maximum traversal (skeleton)

```
listening-port=3478
tls-listening-port=443
alt-listening-port=80
alt-tls-listening-port=5349
fingerprint
realm=turn.example.com
use-auth-secret
static-auth-secret=<32B-random>   # or: lt-cred-mech + user=… (not both)
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
cipher-list="ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384"
no-tlsv1
no-tlsv1_1
# NOTE: do NOT set no-tcp-relay (Allocate then fails like an auth error)
denied-peer-ip=10.0.0.0-10.255.255.255,192.168.0.0-192.168.255.255,172.16.0.0-172.31.255.255
external-ip=<PUBLIC-IP>
min-port=49152 max-port=65535
# perf levers from ARCHITECTURE.md: --udp-recvmmsg --multiplex-peer (+ --udp-gso)
```

Ops notes: binding <1024 needs `setcap cap_net_bind_service=+ep`; `alt-tls-listening-port` defaults to
TLS-port+1 (443 → silently grabs 444, override it); port 443 can't be shared with a web server — second IP
or SNI-routing proxy (`nginx stream { ssl_preread on; }`, or `sslh`). Verify with
`openssl s_client -connect turn.example.com:443 -servername turn.example.com` (must chain-verify; an
employer CA here means MITM → TURN is dead on that network). Probe in-browser with `iceTransportPolicy:'relay'`
+ 5s timer: silence = path blocked, not merely unpreferred.

## 4. Managed vs self-hosted (firewall-traversal price board)

| Provider | Firewall-relevant endpoints | Price |
|---|---|---|
| Cloudflare TURN (anycast, 330+ cities, <50ms for ~95%) | UDP 3478+443, TCP 3478+80, TLS 5349+443 | **$0.05/GB**, 1TB free |
| Twilio NTS (9 regions, TLS1.2-only) | UDP/TCP :3478, TLS/TCP :443 | $0.40 US/EU, $0.60–0.80 APAC |
| Xirsys (12 regions) | UDP/TCP :80/:3478, TLS :443/:5349 | $39/50GB → $0.09/GB at 2TB |
| Self-hosted coturn | whatever you configure | VM + egress (budget $0.001–0.01/GB; AWS ~$0.09/GB, ×2 for relay) |

Start managed (Cloudflare). Self-host when relayed volume × margin beats VM + egress + ops.
Watch out: some corporates blacklist published provider IP ranges (seen with Twilio) — keep a secondary
provider config as fallback; log which TURN host fails.

## 5. Last resort: server relay (when even TURN/TLS dies)

Two designs, escalate in order:

1. **Server-as-WebRTC-peer** (Pion/str0m headless endpoint joins as middlebox; sender→server→receiver
   DataChannels forwarded in userspace). No published per-core forwarding benchmark found — model as
   CPU-bound (2× DTLS-SCTP decrypt/re-encrypt) at ~100s of concurrent bulk sessions/core in Go/Rust;
   never Python/aiortc for the hot path. ⚠️ Privacy: TURN can't decrypt DTLS, but server-peer
   **terminates** it — add per-file E2E (AES-GCM, key in link hash) if the brand promises E2E.
2. **WSS chunk relay**: sender streams 1–4MB chunks over WSS/HTTPS, server forwards to receiver WSS
   (stream to temp file/R2, never hold GBs in RAM; backpressure via `bufferedAmount`/WS-pause; hash-verify;
   delete on complete/abort; cap e.g. 10GB/transfer). Passes TLS-intercepting and authenticated HTTP
   proxies that kill ICE/DTLS entirely. Slowest rung — say so in UX.

## 6. Automatic escalation + UX (show the rung, not a spinner)

Detection signals: `iceConnectionState` (`failed` = all pairs dead, `disconnected` = consent loss),
`connectionState`, consent-freshness timeout, relay-candidate absence after 8–10s of `checking`.

```
start P2P (all rungs offered)
  on checking>10s, 0 relay candidates → ICE restart with TURN emphasised
  on failed / disconnected>5–10s     → restartIce() with escalated iceServers
  on TURN/TLS failed twice           → offer server-peer, then WSS relay
```

Copy per stage:
- `Connecting directly…` → `Direct path blocked — trying relay…`
- `Strict firewall detected — encrypted relay, may be slower.`
- `Strict network — server relay • slower, keep tab open. Large files take N× longer.`
- Sender gone: `Sender disconnected — [Notify sender]` (push/email ping; P2P needs them online).

Business rule: free = P2P (+ tiny relay quota, e.g. 1GB/day); paywalled relay cache (e.g. $5/50GB ≈
$0.10/GB) covers Cloudflare $0.05/GB at 2× margin once relay share exceeds a few % of volume.
At ToffeeShare-claimed scale (50TB/mo fully relayed ≈ $2.5–4.5k/mo) uncapped free relay is ruinous — cap it.

## 7. Validation plan (before claiming it works)
- Trickle-ICE matrix per rung (UDP blocked via firewall rule, 443-only via port filter, MITM via mitmproxy):
  expect relay candidates at each survivable rung, silence with diagnosis at grade 3.
- `turnutils_uclient -Y packet` per transport: record NIC TX pps + sys CPU (UDP vs TCP vs TLS).
- E2E file transfer on simulated 2% loss: TURN/UDP vs TLS vs WSS — expect 200–300ms stalls on TCP rungs.
- Log rung distribution in production (which transport won per session) — drives TURN placement + pricing.

## 8. Key sources
- RTMA "Forcing TURN over TCP 443" (grades, 443-vs-5349, coturn gotchas, cost table); rtcquickstart firewalls
  guide (WSS:443 + sslh multiplexing); LiveKit firewall KB (transport priority order); GetStream STUN/TURN
  (75–80% direct baseline); Fippo 1.9% residual-fail; Xirsys/iceperf TCP-vs-TLS throughput; RFC 8835 (browsers
  must support TURN/TCP+TLS, ICE-TCP); Chrome CONNECT-proxy bugs (auth-proxy TURN failure); Ant Media
  restricted-networks guide (coturn 80/443 + client config); mediasoup corporate thread (provider blacklists,
  TURN:443 usually open); Cloudflare/Twilio/Xirsys TURN docs + pricing.
