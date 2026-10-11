# SECURITY.md — threat model and hardening

What this service actually is, decides what "secure" means here. A P2P file
transfer has an unusually small attack surface on the server: **file bytes never
reach it**. The server creates rooms, relays SDP/ICE, hands out short-lived TURN
credentials, and gets out of the way. So the threats that matter are about
*access* and *amplification*, not data exfiltration.

Everything below is enforced by `internal/server/security.go` and covered by
`internal/server/security_test.go` — each test names the attack it blocks, so
deleting a protection fails a test rather than passing quietly.

## What an attacker wants

| Goal | Lever | Mitigation |
|---|---|---|
| Read a transferred file | — | **Not possible by design.** Bytes go peer-to-peer over a DTLS-encrypted data channel; the server has no code path that sees them |
| Join someone's transfer | Room ID in a share link / QR | 10 chars from a 62-char alphabet (~59 bits). Not guessable. The ID *is* the secret |
| Enumerate nearby transfers | `/api/nearby/{code}` | 4 digits is only 9 000 values (1000–9999), so the whole space is walkable in ~9k requests. Rate limited (20/min/IP); a miss is indistinguishable from a gone room (deleted or never existed), so it is not a presence oracle — but a hit necessarily returns the joinable room, that is the feature |
| Abuse the service as a spam engine | `POST /api/rooms` | 10/min/IP, burst-capped, in-memory buckets swept after 2 idle windows |
| Exhaust memory | One huge request | 16 KB body cap on every JSON handler → `413`, not a generic 400. The largest legitimate body is 20 file entries (~8 KB) |
| Exhaust memory / CPU | Many peers on one room | 32 peers per room (`ErrRoomFull` → close 1008). Each peer multiplies the work of every routed frame, so an unbounded count is an amplification primitive even with the create limit in place |
| Exhaust CPU / fan-out | Unbounded `DELETE` + `TURN` probes | `DELETE /api/rooms/{id}` shares the create bucket (10/min/IP) — it broadcasts `bye` and closes every peer, so it is not free work. `GET .../turn` is rate-limited **before** the room lookup, so walking unknown IDs spends budget instead of bypassing it |
| Cache a manifest or room read | Browser / proxy cache | Every JSON API answer carries `Cache-Control: no-store` — manifests hold attacker-chosen filenames and IDs ride in URLs, so neither should sit in a shared cache |
| Spoof a filename peer-to-peer | DataChannel `header.name` (never sees the server) | The receiver validates `header.name` against the same `validFileMeta` name rules before any byte reaches disk (`validRecvName` in `app.js`): bidi/zero-width, device names, trailing dot/space, separators. Invalid → loud failure, nothing saved, no `ack` |
| Hold connections open | Slowloris | `ReadHeaderTimeout` 10s, `IdleTimeout` 60s, 16 KB header cap. `WriteTimeout` deliberately unset — hijacked WebSockets own their write deadlines and a server-wide one would sever live signaling |
| Drive the API from a malicious page | CORS | Was `*`. Now an allowlist (see below); unlisted origins get `403`, not a silent success |
| Bypass rate limits | Spoofed `X-Forwarded-For` | Two layers. (1) `clientIP` takes the **rightmost** XFF entry, not the leftmost: Caddy and nginx append to whatever the client sent, so the leftmost entry is the client's own and taking it gave every caller a fresh bucket per request — 40 forged values produced 40×201 and 0×429 where the un-forged run split 30/10. (2) The header is only believed at all when the direct peer is loopback/private, so a directly-reachable service cannot be fed one. `TestForwardedForTakesProxyAppendedHop` |
| Trick a receiver with a filename | Attacker-controlled `name` | Rejected for path separators, `.`/`..`, control chars, NUL, bidi overrides/isolates and zero-width marks. The name becomes a download name on the *receiver's* device |
| Leak a room ID via `Referer` | Share link in the address bar | `Referrer-Policy: no-referrer` (not `same-origin` — a third-party resource would still get it), plus `frame-ancestors 'none'` and `X-Frame-Options: DENY` against clickjacking |
| Run injected script | Any XSS | CSP. The UI is entirely self-hosted: no CDN, no analytics, no inline event handlers |
| Use the dev tooling in production | `/debug` | Gated on `SIGNAL_DEBUG=1`. It creates rooms and drives WebSocket exchanges on request — convenient in dev, a ready-made abuse tool in production |
| Probe the service's load | `/metrics` | Gated on the admin token by default; `404` (not `401`) when no `ADMIN_TOKEN` is configured, so the surface isn't even confirmed |
| Reach the admin surface | `ADMIN_TOKEN` | Unset → `503 admin_disabled`. Constant-time comparison. Fail-closed |

## CORS is an allowlist, not `*`

A Cloudflare Pages frontend is cross-origin by design, so CORS is genuinely required. But `*` meant any website
a user visited could mint rooms and file abuse reports against them using that
user's browser.

Default allowlist: `localhost`/`127.0.0.1` on any port,
`https://*.pages.dev`. Operators self-hosting a frontend on their own domain
must set `SIGNAL_ALLOWED_ORIGINS` — see `docs/CONFIG.md`.

Two bypasses are specifically closed and tested:

- `https://*.example.com` matches `a.example.com` and `a.b.example.com`, but
  **not** `example.com` and **not** `example.com.evil.tld`.
- Same-origin comparisons strip the default port, so `https://x:443` equals
  host `x`. A browser behind TLS termination sends `http://…` while the app
  behind the proxy sees the same host, so the scheme is ignored deliberately.

## What is deliberately NOT protected

Honest boundaries, so nobody mistakes this for a stronger claim than it makes:

- **The room ID is the security boundary.** Anyone holding it can join that
  transfer — that is the design of a share link. Hardening the server does not
  change it; a leaked link is a leaked transfer.
- **The WebSocket handshake inherits the CORS allowlist.** A cross-origin
  upgrade with a foreign `Origin:` is refused (403); an absent `Origin:`
  (native shell, non-browser client) is allowed. Room IDs are already
  unguessable, so a cross-site WebSocket hijack still requires the room ID
  and adds no reach.
- **A peer ID can be taken over inside the liveness-detection window.** A peer ID
  names exactly one live connection, and re-registering one whose socket is still
  up is refused (close 4400). But the server can only prove a socket dead when a
  **write** to it fails, and that can take up to one `SIGNAL_PING`. Anyone holding
  a peer ID — the presence payload discloses every ID to every room member — can
  register it inside that window and displace the holder. The displaced socket is
  closed by the server, so the takeover is **visible** (`bye`) rather than silent,
  and it does not grow `peers`, so `MaxPeers` still binds. This is the price of the
  mobile reconnect: a sender that switches to WhatsApp to send the link has its
  socket killed by the OS, and refusing its rejoin made the bug permanent — the
  rejoin arrived while the server still held the old entry and was closed with
  4400 `duplicate_sender`, verified live. Room membership is the trust boundary
  here; this refines an existing capability rather than granting a new one.
  `TestSenderReconnectAfterFrozenSocket`, `TestReconnectDisplacesDeadPeer`.
- **TURN relays see encrypted traffic volume.** With a relay in the path the
  operator can observe that a connection happened and how many bytes crossed
  it. Contents stay end-to-end encrypted. This is stated in the privacy policy
  rather than glossed over.
- **No request logging.** Good for privacy, bad for abuse forensics. The
  tradeoff is deliberate; the metrics counters are the only visibility.
- **TLS is the proxy's job.** The service speaks plain HTTP and sets HSTS only
  when it is behind something that terminates TLS (`X-Forwarded-Proto: https`),
  because telling a plaintext listener it is secure would be a lie.
- **The abuse-report log is attacker-controlled input downstream.** `REPORT_LOG`
  stores reporter-supplied names and contact strings verbatim. Any operator
  tooling that renders the log as HTML must escape it — the server's own UI
  never renders it, so this caveat lives with the tooling, not the server.
- **`security.txt` expiry is a calendar item.** The `Expires` field in
  `signal/web/.well-known/security.txt` is a static date; refresh it yearly
  or scanners will flag the file as stale.

## Verification

```sh
cd signal
go vet ./...
go test ./...                    # includes 17 security tests
```

Live checks against a running server:

```sh
# unlisted origin is refused
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8090/api/rooms \
  -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"a.bin","size":1}]}'          # → 403

# oversized body
python3 -c "print('{\"files\":[{\"name\":\"'+'A'*70000+'\",\"size\":1}]}')" > /tmp/big.json
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8090/api/rooms \
  -H 'Content-Type: application/json' --data-binary @/tmp/big.json   # → 413

# traversal + bidi-spoofed filenames
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8090/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"../../etc/passwd","size":1}]}'              # → 400

# brute force the 4-digit code
for i in $(seq 0 39); do curl -s -o /dev/null -w '%{http_code} ' \
  localhost:8090/api/nearby/$(printf '%04d' $i); done                # 404s then 429s
```

The CSP is verified in a real browser, not assumed: `~/.perf/csp-smoke.mjs`
loads every page, drives the full sender flow (which is where deferred code
runs), and fails on any console error or policy violation. A policy that breaks
the app is worse than no policy.
