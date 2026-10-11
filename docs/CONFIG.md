# CONFIG.md — signal v4 environment

All settings are env vars. Invalid values fail fast at startup with the variable name.

Defaults are **fail-closed**: anything usable as an abuse amplifier is off
unless an operator turns it on, and anything that could leak a room secret
through a browser is blocked outright. See `docs/SECURITY.md` for the reasoning
behind each default.

| Variable | Default | Meaning |
|---|---|---|
| `SIGNAL_ADDR` | `127.0.0.1:8090` | Listen address |
| `SIGNAL_PUBLIC_BASE_URL` | `http://localhost:8090` | Builds share `url`; host is loop-guard reference only (no URL shortening here) |
| `SIGNAL_SITE_URL` | falls back to `SIGNAL_PUBLIC_BASE_URL` | Public **frontend** origin, used for `canonical`, `og:url`, `robots.txt` and `sitemap.xml`. Must be absolute — the server refuses to start otherwise. Set this on a split deployment (Pages frontend + own backend) or every canonical points at the API host. |
| `SIGNAL_VERSION` | `dev` | Reported in `GET /signal-config.json` so a client on a stale cached config can tell you which build it is running |
| `window.SIGNAL_CONFIG_URL` (build-time, optional) | unset | Overrides which config document the client fetches at startup. Unset in practice: `build-pages.mjs` does not emit it, and the same-origin `signal-config.json` path covers every current deployment. If you do emit it, it must name the **stable frontend host**, never the backend — that inversion is the whole mechanism. See docs/REMOTE-CONFIG.md |
| `SIGNAL_WEB_DIR` | `./web` | Web asset dir. Also holds `/privacy` and the `/debug` smoke page (served only when `SIGNAL_DEBUG=1`) |
| `SIGNAL_GRACE` | `10s` (code default) | Room is deleted this long after the sender's WS drops, and receivers get `bye`. **Production runs `2h`** (verified on the VPS). It must comfortably exceed `SIGNAL_PING`: the room is gone the instant the grace expires, so a grace shorter than the server's dead-peer detection leaves the sender's retry loop with no room to rejoin to and the share is unrecoverable. Not a "how long is a receiver left waiting" knob. |
| `SIGNAL_PING` | `25s` | Server WS ping interval (dead-peer detection). **Do not lower to ≤5s**: the read deadline is `2*Ping+10s`, so a shorter ping kills every client that keeps its own 20s keepalive — the socket dies with no error and the transfer stalls. Production runs 25s, safely above the client's 20s. |
| `SIGNAL_MAX_MSG` | `32768` | Max WS message bytes (SDP/ICE fit; larger → close 1009) |
| `TURN_HOST` | unset | Primary TURN hostname for `iceServers` (e.g. `turn.example.com`). Unset → skipped |
| `TURN_SECRET` | unset | coturn `--static-auth-secret` for primary. Unset → primary skipped |
| `TURN2_HOST` / `TURN2_SECRET` | unset | Secondary provider, appended after primary (rescues provider blacklists — see FIREWALL-TRAVERSAL.md §4) |
| `TURN_TTL` | `3600s` | Credential lifetime (also the `username` expiry prefix) |
| `TURN_REALM` | `p2pfilesharing` | Returned for operator reference only |
| `STUN_URL` | `stun:stun.l.google.com:19302` | First entry of `iceServers` |
| `RATE_CREATE_PER_MIN` | `10` | Room creates per IP per minute (burst = same). `DELETE /api/rooms/{id}` shares this bucket — deletion fans out (`bye` + peer closes), so it is lifecycle work under the same limit. Over → `429 rate_limited` + `Retry-After: 60` |
| `RATE_TURN_PER_MIN` | `30` | TURN-cred fetches per IP per minute. Checked **before** the room lookup, so probes of unknown IDs spend budget instead of bypassing it. Over → `429 rate_limited` + `Retry-After: 60` |
| `RATE_REPORT_PER_MIN` | `5` | Abuse reports per IP per minute. Over → `429 rate_limited` + `Retry-After: 60` |
| `REPORT_LOG` | unset | File that abuse reports are appended to as JSON Lines. Unset = memory only, so every report is lost on restart. Created `0600` inside a `0700` dir; rotates past 4 MiB. See docs/SECURITY.md |
| `USAGE_FILE` | unset | File holding the anonymous success counter (`{"ok":N}`). Unset = the count resets on restart. Written at most once a minute, never on the request path. No identifier is stored — see the counter section in `signal/web/privacy.html` |
| `METRICS_PASSWORD` | unset | Unlocks `/metrics` in a browser with a password box. Unset = bearer-token-only, unchanged. Sent as a header, never a query param, so it stays out of history and access logs. Rate limited to 10 attempts/min per IP. Deliberately NOT the same secret as `ADMIN_TOKEN` |
| `RATE_NEARBY_PER_MIN` | `20` | Nearby-code lookups per IP per minute. A code is 4 digits (9 000 values, 1000–9999), so without this the whole space is walkable in ~9k requests and every live nearby room is enumerated. Over → `429 rate_limited` + `Retry-After: 60` |
| `ADMIN_TOKEN` | unset | Operator bearer token. Unset → admin surface returns `503 admin_disabled` (fail closed). Also required for `/metrics` unless `SIGNAL_PUBLIC_METRICS=1` |
| `TRUST_PROXY` | unset | Set `1` behind a trusted LB to rate-limit on the **proxy-appended (rightmost)** `X-Forwarded-For` entry instead of the TCP peer. **Only honoured when the direct peer is loopback/private** — otherwise anyone could send their own header to mint a fresh bucket per request. The rightmost entry is deliberate: Caddy and nginx *append* to whatever the client sent, so the leftmost entry is attacker-controlled. Verified live before the fix: 40 requests with 40 distinct forged leftmost values returned 40×201 / 0×429 |
| `SIGNAL_ALLOWED_ORIGINS` | local dev + `https://*.pages.dev` | Comma-separated CORS allowlist. Entries are exact origins (`https://a.example`), wildcard subdomains (`https://*.pages.dev`, matches subdomains but **not** the parent or a lookalike suffix) or wildcard ports (`http://localhost:*`). Anything else → `403`. Same-origin always allowed. Set this to your own domain when self-hosting the frontend |

> `http://localhost` is **deliberately not on the list.** On a desktop it is whatever dev server
> happens to be running, and permitting that origin hands room creation to any unrelated local
> page. The symptom of getting this wrong is quiet: the server returns `201` and the app still
> says "server unreachable", because CORS is enforced by the browser and the server never sees
> a failing request. Setting `SIGNAL_ALLOWED_ORIGINS` **replaces** the built-in default list, so
> a custom value must re-list every origin you need.
>
> **Do not add the API host** (`https://api-<app>.example.com`) to the list. It does
> nothing: `sameOrigin()` already allows any request whose `Origin` matches the request's own
> `Host`, so an API-hosted page never reaches the allowlist. Listing it implies the list is what
> grants that access, which is the belief that leads someone to "fix" the list by removing an
> entry that mattered. Asserted by `TestAPIHostNeedsNoAllowlistEntry`.
| `SIGNAL_DEBUG` | unset | Set `1` to expose the `/debug` WS smoke harness. Off by default: it creates rooms and drives WebSocket exchanges on demand, which is a ready-made abuse tool in production |
| `SIGNAL_PUBLIC_METRICS` | unset | Set `1` to serve `/metrics` without the admin token. Default requires it (and 404s when no `ADMIN_TOKEN` is configured, so the surface is not even confirmed) |
| `SIGNAL_READ_HEADER_TIMEOUT` | `10s` | Closes the Slowloris class: without it a client can dribble request headers and hold a connection open indefinitely |
| `SIGNAL_IDLE_TIMEOUT` | `60s` | Keep-alive idle timeout. `WriteTimeout` is deliberately **unset** — hijacked WebSockets manage their own write deadlines and a server-wide one would sever live signaling |
| `SIGNAL_MAX_HEADER_BYTES` | `16384` | Request header cap |
| `SIGNAL_DISABLE_UI` | unset | Set `1` on an API-only host: every page and asset route 404s and `robots.txt` becomes `User-agent: * / Disallow: /`. This is what keeps a split deployment from serving a second copy of the site — duplicate content across two hosts is a SEO problem, not a cosmetic one |
