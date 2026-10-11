# DEPLOY.md — split hosting: Go backend (self-hosted) + Cloudflare Pages frontend

Target topology (no domain purchase required to start):

```
phone / browser  ──https──>  Cloudflare Pages        (signal/web  → dist/)
        │                       static, global edge, free
        └──https/wss──────>   your server (Go binary)  room lifecycle, signaling,
                              127.0.0.1:8090 behind a TLS proxy   TURN creds, abuse
        (STUN/TURN ladder; direct P2P means the data path usually
         never touches the server at all)
```

Both sides call the API cross-origin, which is why the server ships CORS
(`serveCORS` in `internal/server/server.go`) and the client carries a
`SIGNAL_URL` build setting (`apiUrl`/`wsUrl`/`originOf` in `app.js`).
The nav's server pill shows the configured host and whether `/healthz` answers,
so a wrong URL is visible before the first upload instead of surfacing as
"server unreachable".

## 1. Backend on your server (Go, unchanged)

```sh
git clone <repo> && cd p2p-file-sharing/signal
go build -o /usr/local/bin/signal ./cmd/signal     # go1.25+, stdlib only
```

systemd unit (`/etc/systemd/system/signal.service`):

```ini
[Unit]
Description=p2p file sharing signal
After=network-online.target

[Service]
ExecStart=/usr/local/bin/signal
Environment=SIGNAL_ADDR=127.0.0.1:8090
Environment=SIGNAL_PUBLIC_BASE_URL=https://signal.yourdomain.com
Environment=SIGNAL_WEB_DIR=/var/lib/signal/web      # optional: still serves its own UI
Environment=TRUST_PROXY=1                           # behind Caddy/nginx
Environment=TURN_HOST=...  Environment=TURN_SECRET=...   # optional
Environment=ADMIN_TOKEN=...                              # optional (fail-closed if unset)
User=signal
Restart=always

[Install]
WantedBy=multi-user.target
```

TLS in front (WebSockets need it; Caddy is the shortest path):

```caddyfile
signal.yourdomain.com {
    reverse_proxy 127.0.0.1:8090
}
```

Checklist: `curl https://signal.yourdomain.com/healthz` → `ok`;
`curl -X POST https://signal.yourdomain.com/api/rooms -d '{"files":[{"name":"a","size":1}],"nearby":true}'`
→ 201. `/debug` hosts the WS loopback harness but is **404 by default** — start the server
with `SIGNAL_DEBUG=1` to get it (see docs/CONFIG.md).

## 2. Frontend on Cloudflare (free)

Static assets, served by **Workers** — `wrangler.jsonc` in the repo root is the
config, and it is authoritative. The dashboard is Workers, not Pages (the two
read the same `_headers` / `_redirects` output, but the dashboard section differs).

1. Push the repo to GitHub and connect it (Settings → Builds).
2. Build settings, exactly as `wrangler.jsonc` documents them:
   - Root directory: **empty** (repo root)
   - Build command: `node signal/web/build-pages.mjs`
   - Deploy command: `npx wrangler deploy`
   - Build variables: `SIGNAL_URL` (the backend) and `SITE_URL` (the frontend)
3. Deploy. The custom domain is optional — the free workers.dev hostname is
   fine while you decide. The Go server's `SIGNAL_PUBLIC_BASE_URL` and the
   build's `SIGNAL_URL` both point at the **backend**, while `SITE_URL` is what
   canonicals and share links use.

> Worker rename: `wrangler.jsonc` names the worker `p2p-file-sharing` with the
> product. The first deploy under the new name provisions a *new* Worker — move
> the custom domain to it afterwards (dashboard → worker → Domains & Routes).

What the build does (`signal/web/build-pages.mjs`, stdlib only, fails closed):
copies the three pages + assets, emits `signal-config.<hash>.js` (so a backend
URL change is a new filename — no stale-cache traps), injects it before
`/app.js`, and writes `dist/_headers` with the cache policy that the Go static
server used to provide (HTML revalidates, assets 1h, config immutable).

The Go server also serves the same UI from `signal/web` unchanged (same-origin
mode: no `SIGNAL_URL` → the client talks to its own host). Either host works
independently; the Pages one is the public face.

## 4. TURN (optional, decide later)

Direct P2P covers most home/café/campus networks. Symmetric corporate NATs
need a relay: set `TURN_HOST`/`TURN_SECRET` (coturn REST API) on the Go
server — nothing else changes; the client already requests the ladder. See
FIREWALL-TRAVERSAL.md.
