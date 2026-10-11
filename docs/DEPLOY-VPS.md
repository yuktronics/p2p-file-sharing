# DEPLOY-VPS.md — walkthrough for a fresh VPS

Ubuntu LTS, x86-64, on any cloud VPS. Every step is a command you run, with an
explanation of what it does and a check that tells you it worked. Nothing here
is a black box: if a step fails you will know which one.

Run steps in order. Each one ends with a verification — do not skip it, because a
later step will fail in a confusing way if the earlier one silently half-worked.

### Which config file to use, and when

`docs/deploy/` holds ready-made files. They are **not** all used at once:

| File | Used when |
|---|---|
| `signal.service` | **Always.** Copy to `/etc/systemd/system/` (step 7) |
| `Caddyfile` | **Only if you pick step 10 Option B (sslh)** — it binds `:8080` so sslh can own public `:443`. For the simple path, step 8 gives you a 4-line inline config instead, which binds `:443` directly |
| `turnserver.conf` | **Always** (step 9) — start from it, it is heavily commented |
| `sslh.conf` | **Only if you pick step 10 Option B** |

The default path (steps 8 + 9, no sslh) is the shortest and works for home,
school and most mobile networks. Options A/B in step 10 buy you the last ICE
rung for strict corporate firewalls.

---

## What you need before starting

| Thing | Value | Notes |
|---|---|---|
| Backend domain | **pick one now** — e.g. `signal.example.com` | Used for TLS, TURN and share links. Used throughout, so set it once: `export DOMAIN=signal.example.com` |
| Frontend (Pages) URL | decided after step 12 | Needed for the CORS allowlist |
| A DNS A record for `DOMAIN` | your VM's public IP | **Do this first.** TLS will not issue a certificate until the name resolves here |

If you have not picked a domain yet, Cloudflare gives you a free
`*.trycloudflare.com` via a tunnel, but that hostname changes on every restart —
fine for testing, wrong for TURN, because clients cache the address. For TURN you
want a stable name. Simplest stable option: buy a domain, or use
`nip.io`-style names if your DNS provider supports it.

Find your public IP on the box:

```bash
curl -s ifconfig.me
```

---

## Step 1 — look at the machine before you change it

```bash
free -h; nproc; df -h /; uname -m
```

Expect ~1 GB RAM to be plenty. The server holds rooms **in memory only** — there
is no database, so this is not a machine that grows with use. What it does need
is **egress bandwidth**, because when a TURN relay is in the path every byte is
forwarded twice through this box.

Check what is already listening and what the firewall currently allows:

```bash
sudo ss -tulnp
sudo ufw status verbose || echo "ufw not active"
sudo iptables -S | head -20
```

> **On most clouds, this is the part that catches everyone.** Ingress is controlled
> by the **firewall / security list in the cloud console**, not by iptables or ufw inside
> the VM. A port can be wide open locally and still be unreachable from the
> internet. You said you can open ports — these are the ones:
>
> | Port | Protocol | Why |
> |---|---|---|
> | 22 | TCP | your SSH (already open) |
> | 80 | TCP | ACME HTTP-01 challenge + redirects |
> | 443 | TCP | HTTPS **and** TURN/TLS (see step 9) |
> | 3478 | TCP + UDP | TURN on its standard port |
> | 443 | UDP | TURN over UDP 443 — different space from TCP 443, no conflict |
>
> Console path: **Networking → Firewall → your security list → Security
> Lists → Add Ingress Rules**. Add a rule for each row above, source
> `0.0.0.0/0` (TURN must be public).

---

## Step 2 — packages

```bash
sudo apt update
sudo apt install -y ca-certificates curl ufw
```

Caddy (automatic HTTPS) and coturn (the relay) get installed later, separately,
so you can see what each one does.

---

## Step 3 — a non-root service user

Never run the server as root. It listens on a high port and needs no privilege
beyond that:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin signal
sudo install -d -m 0755 /opt/signal
sudo install -d -m 0755 /opt/signal/web
sudo install -d -m 0750 -o root -g signal /etc/signal
```

---

## Step 4 — get the binary and assets across

Built here as a **static** binary, so the box needs no Go toolchain and no libc
compatibility games:

```bash
# on your workstation
scp signal web -r ubuntu@<VM-IP>:/tmp/
```

On the box:

```bash
sudo install -m 0755 /tmp/signal /opt/signal/signal
sudo cp -a /tmp/web/. /opt/signal/web/
sudo chown -R root:signal /opt/signal
/opt/signal/signal -h 2>&1 | head -3 || true
```

Nothing is written to disk at runtime, so `/opt/signal` can stay root-owned and
read-only to the service.

> Prefer to build from source instead? `git clone` the repo and
> `CGO_ENABLED=0 go build -o signal ./signal/cmd/signal`. The service is stdlib
> only, so the build is hermetic.

---

## Step 5 — generate the secrets

Two secrets, generated **on the box** so they never travel:

```bash
sudo openssl rand -hex 32 | sudo tee /etc/signal/turn-secret  >/dev/null
sudo openssl rand -hex 32 | sudo tee /etc/signal/admin-token  >/dev/null
sudo chmod 600 /etc/signal/turn-secret /etc/signal/admin-token
```

The **TURN secret must be byte-identical to what coturn uses** (step 8). That
shared secret is what lets the Go server mint credentials itself with
HMAC-SHA1, so the two never need a database. Keep `/etc/signal/turn-secret` as
the single source of truth and read it into coturn's config from there.

---

## Step 6 — the environment file

```bash
sudo nano /etc/signal/signal.env
```

```
# Public address of THIS server — used to build the share links.
SIGNAL_PUBLIC_BASE_URL=https://signal.example.com

# Where the frontend lives. Must be the Pages site, NOT this backend, or every
# canonical URL, og:url and sitemap entry points at the API host. Fix in step 12.
# The name is SIGNAL_SITE_URL (the prefix matters) - bare SITE_URL is the
# BUILD-time variable for build-pages.mjs and is ignored by this server.
SIGNAL_SITE_URL=https://your-app.pages.dev

SIGNAL_VERSION=PASTE_GIT_REV_PARSE_HEAD_AT_DEPLOY
# The commit hash of the source this binary was built from — NOT a static
# version. /signal-config.json reports it, so "what code is live" is always
# answerable (see Redeploy below). A static 1.0.0 hid a stale binary for days
# in Oct 2026.

# Loopback only — a reverse proxy in front provides the public :443.
SIGNAL_ADDR=127.0.0.1:8090
SIGNAL_WEB_DIR=/opt/signal/web

# Room outlives the sender's tab by this long, so a receiver who is mid-download
# is not cut off the moment they open the link — and so a sender who switched to
# WhatsApp can still rejoin. THIS IS THE VALUE PRODUCTION RUNS (verified on the
# VPS), and it is deliberately far above SIGNAL_PING: the room is deleted the
# instant the grace expires, so a grace shorter than the server's dead-peer
# detection means there is no room left to rejoin to and the sender's retry loop
# cannot recover the share no matter how long it tries.
#
# 10s here would have done exactly that. Do not shorten it without reading
# SIGNAL_PING below: grace must exceed ping, with room to spare.
SIGNAL_GRACE=2h
SIGNAL_PING=25s
SIGNAL_MAX_MSG=32768

STUN_URL=stun:stun.l.google.com:19302
TURN_HOST=signal.example.com
TURN_SECRET=PASTE_FROM_/etc/signal/turn-secret
TURN_TTL=3600s
TURN_REALM=signal.example.com

# Per-IP rate limits. The nearby limit matters most: a 4-digit code is only
# 9 000 values, so without it the whole space is walkable in ~9k requests.
RATE_CREATE_PER_MIN=10
RATE_TURN_PER_MIN=30
RATE_REPORT_PER_MIN=5
RATE_NEARBY_PER_MIN=20

# Gates /api/admin/* and /metrics. Unset would disable them (fail closed).
ADMIN_TOKEN=PASTE_FROM_/etc/signal/admin-token

# Caddy is on the same host, so trusting its X-Forwarded-For makes the rate
# limits per-client instead of per-proxy. The server reads the rightmost entry
# (the one Caddy appended); the leftmost is whatever the caller sent.
TRUST_PROXY=1

# Which browser origins may call the API.
SIGNAL_ALLOWED_ORIGINS=https://*.pages.dev

# /debug and /metrics are OFF by default. Enable only while debugging.
# SIGNAL_DEBUG=1
```

Then lock it down and inject the secrets without hand-typing them:

```bash
sudo sed -i "s#^TURN_SECRET=.*#TURN_SECRET=$(sudo cat /etc/signal/turn-secret)#" /etc/signal/signal.env
sudo sed -i "s#^ADMIN_TOKEN=.*#ADMIN_TOKEN=$(sudo cat /etc/signal/admin-token)#" /etc/signal/signal.env
sudo chmod 600 /etc/signal/signal.env
sudo chown root:signal /etc/signal/signal.env
grep -cE '^(TURN_SECRET|ADMIN_TOKEN)=[0-9a-f]{64}$' /etc/signal/signal.env
```

That last command must print `2`. If it prints less, a secret is malformed and the
server will refuse to start.

---

## Step 7 — systemd, with a sandbox

```bash
sudo cp /tmp/signal.service /etc/systemd/system/signal.service
sudo systemctl daemon-reload
sudo systemctl enable --now signal
```

The unit in `docs/deploy/signal.service` runs the process as `signal` with
`NoNewPrivileges`, `ProtectSystem=strict`, a syscall filter and
`LockPersonality`. It has no write access to anything, which is why there are no
upload or log directories — the server keeps rooms in memory and logs to
journald only.

Check it:

```bash
systemctl status signal --no-pager
sudo journalctl -u signal -n 30 --no-pager
curl -sS http://127.0.0.1:8090/healthz     # → ok
```

`/healthz` is the one endpoint that is public on purpose — the app's backend pill
probes it to tell the user which server they are on.

Real API check, including the rate limiter:

```bash
curl -sS -X POST http://127.0.0.1:8090/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"smoke.bin","size":1024}],"nearby":true}'
# → {"id":"...","nearby":"1234","url":"https://signal.example.com/r/..."}
```

And the page itself, with its security headers:

```bash
curl -sSI http://127.0.0.1:8090/ | grep -iE 'content-security|referrer-policy|x-frame'
```

---

## Step 8 — TLS in front (Caddy)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Caddy obtains and renews the certificate itself. Point it at the backend:

```bash
sudo nano /etc/caddy/Caddyfile
```

```
signal.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8090
	log {
		output discard
	}
}
```

> `output discard` is deliberate. A request log records every room id, and a room
> id *is* the share link — see `docs/SECURITY.md`.

```bash
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Verify from outside (do this from your workstation, not the box):

```bash
curl -sSI https://signal.example.com/healthz
curl -sS https://signal.example.com/robots.txt | head -3
```

If TLS fails, check in this order: does the A record point here
(`dig +short signal.example.com`), is 80/443 open in the **cloud firewall security list**,
and `sudo journalctl -u caddy -n 40`.

### If you also run sslh — the :80 trap

Once `sslh` owns public TCP :443 (Step 10), Caddy can no longer hold it and the
layout becomes `:80` Caddy, `:443` sslh, `:8080` Caddy, UDP `:443` Caddy for
HTTP/3. Use `docs/deploy/Caddyfile` rather than the block above.

**Caddy must keep a public TCP :80 listener.** It is the only port left where
ACME HTTP-01 can be solved: TLS-ALPN-01 needs TCP :443 (sslh has it), and the
`:8080` backend does not offer the `acme-tls/1` ALPN.

The trap is *how quietly* it fails. Caddy does not attempt renewal until roughly
day 60 of a 90-day certificate, so if that listener is ever removed:

- days 1-60 — nothing happens, nothing is logged, every check still passes
- day 60 — Caddy tries to renew, fails, and still says nothing
- day 90 — both certificates lapse and the product is offline

DNS-01 would remove the dependency entirely, but the distro Caddy package ships
**no** DNS provider modules — check with
`caddy list-modules | grep tls.issuance.acme.dns` (empty on stock Ubuntu). Using
it means replacing the packaged binary with an `xcaddy` build and losing
apt-managed updates, so the trade is not worth it here.

Install the watchdog and the 60-day fuse becomes a same-day alarm:

```bash
sudo install -m 0755 docs/deploy/cert-watchdog /usr/local/sbin/cert-watchdog
sudo install -m 0644 docs/deploy/cert-watchdog.service /etc/systemd/system/
sudo install -m 0644 docs/deploy/cert-watchdog.timer  /etc/systemd/system/
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.acme-backup
sudo systemctl daemon-reload
sudo systemctl enable --now cert-watchdog.timer
```

Daily it checks that Caddy still holds `:80`, that each certificate exists and
how long it has left, and inside a 14-day window it restarts Caddy once to give
renewal another attempt. Failures are non-zero exits, so they surface in
`systemctl list-timers` instead of passing silently. Read them with:

```bash
systemctl list-timers cert-watchdog.timer
sudo journalctl -t cert-watchdog -n 20 --no-pager
```

The alarm tells you to restore the `:80` site from
`/etc/caddy/Caddyfile.acme-backup`, which is why the copy above matters — a
backup that was never taken is worse than not mentioning one.

Test the failure paths, not just the happy path. A check that has only ever
returned 0 is indistinguishable from one that checks nothing:

```bash
ACME_PORT=8099 NO_RESTART=1 /usr/local/sbin/cert-watchdog   # must exit non-zero
```

---

## Step 9 — TURN (coturn)

Without this, transfers fail outright on carrier-grade NAT and many corporate and
mobile networks — the app returns `turn_disabled` and falls back to direct only.

```bash
sudo apt install -y coturn
```

Start from the tuned config in `docs/deploy/turnserver.conf`. Every option there
is deliberate — the defaults lose whole classes of network. Two things to set:

```bash
sudo cp /etc/turnserver.conf /etc/turnserver.conf.bak
sudo nano /etc/turnserver.conf
```

Then set the two values that must match step 5, and point the certificate at the
one Caddy already has (rather than running a second ACME client on the same
domain):

```bash
sudo sed -i "s#^static-auth-secret=.*#static-auth-secret=$(sudo cat /etc/signal/turn-secret)#" /etc/turnserver.conf
sudo sed -i 's#^realm=.*#realm=signal.example.com#' /etc/turnserver.conf

# Point coturn at the certificate Caddy already obtained, rather than running a
# second ACME client on the same domain. Caddy 2 stores certs as <domain>.crt
# and <domain>.key under /var/lib/caddy/.local/share/caddy/ — note the
# extensions: they are NOT letsencrypt-style fullchain.pem / privkey.pem.
CERT=$(sudo find /var/lib/caddy -type f -name "*.crt" -path "*signal.example.com*" 2>/dev/null | head -1)
echo "caddy cert: $CERT"
sudo sed -i "s#^cert=.*#cert=$CERT#; s#^pkey=.*#pkey=${CERT%.crt}.key#" /etc/turnserver.conf
sudo chmod 640 /etc/turnserver.conf
sudo systemctl enable --now coturn
```

If `$CERT` comes back empty, Caddy has not issued a certificate yet — it only does
so after actually serving a request for that hostname. Hit
`https://signal.example.com/healthz` once, wait a few seconds, re-run the `find`.

Verify:

```bash
sudo systemctl status coturn --no-pager
sudo ss -lunp | grep -E '3478|5349'      # UDP 3478 listening
sudo journalctl -u coturn -n 20 --no-pager
```

And that the server hands out credentials against it:

```bash
curl -sS http://127.0.0.1:8090/api/rooms/FAKEID/turn    # → 404 (room unknown)
ROOM=$(curl -sS -X POST http://127.0.0.1:8090/api/rooms -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"t.bin","size":10}]}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -sS "http://127.0.0.1:8090/api/rooms/$ROOM/turn" | head -c 400
```

You should see four `iceServers` entries with HMAC credentials whose username
starts with an expiry timestamp. That is the proof the shared secret matches.

---

## Step 10 — share TCP :443 between HTTPS and TURN/TLS — **optional, read this**

The app offers four TURN rungs. The last one,
`turns:signal.example.com:443?transport=tcp`, is the only one that gets through
a "ports 80/443 only" corporate firewall — exactly the networks that need TURN
most. But TCP :443 is the only port where HTTPS works, so Caddy already has it.

Two clean options, in order of preference:

**Option A — a second public IP (simplest).** Most clouds let you attach another
public IP to the instance. Give coturn its own IP, run TLS on :443 there, and
there is no contention at all:

```bash
# console: Networking -> firewall -> ... or "Secondary IP"? then:
sudo sed -i 's#^tls-listening-port=.*#tls-listening-port=443#' /etc/turnserver.conf
# set TURN_HOST in /etc/signal/signal.env to the second IP's domain, then:
sudo systemctl restart coturn signal
```

**Option B — multiplex by SNI (`sslh`).** One IP. `sslh` takes public TCP :443,
reads the TLS SNI, and forwards: `turn.<domain>` → coturn, everything else →
Caddy. UDP :443 already goes straight to coturn (different port space), so the
whole ladder works on one address.

```bash
sudo apt install -y sslh
sudo cp /etc/sslh/sslh-config /etc/sslh/sslh-config.bak
# then paste the config from docs/deploy/sslh.conf into /etc/sslh/sslh-config
sudo systemctl enable --now sslh
```

For option B, Caddy must move off public :443 — it should listen on
`127.0.0.1:8080` and sslh forwards there. `docs/deploy/Caddyfile` has that shape.

**Option C — skip it.** Transfers still work on home/school Wi-Fi and most
mobile data; they fail on strict corporate networks. If you take this, note it
as a known limitation before shipping to Play.

Whichever you pick, verify the rung you expect to work:

```bash
# Option A or B:
openssl s_client -connect signal.example.com:443 -servername turn.signal.example.com </dev/null 2>&1 | grep -E 'subject=|Verify return'
# UDP 443 is independent and should just be listening:
sudo ss -lunp | grep ':443'
```

---

## Step 11 — lock down the host

The server binds loopback only, so the host itself needs no new ports beyond
what TLS and TURN need. Keep SSH and drop the rest:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw enable && sudo ufw status numbered
```

If SSH was allowed by a different rule name, do not lock yourself out — verify
in a second terminal before closing this one.

---

## Step 12 — deploy the frontend and point the backend at it

The frontend is a static site on Cloudflare Pages; the backend serves only the
API. Build it here and deploy:

```bash
cd signal/web
SIGNAL_URL=https://signal.example.com \
SITE_URL=https://your-app.pages.dev \
  node build-pages.mjs
```

Deploy `dist/` to Pages (drag-and-drop in the dashboard, or the Pages git
integration). Then confirm the two files that matter:

```bash
curl -sS https://your-app.pages.dev/signal-config.json
curl -sS https://your-app.pages.dev/robots.txt
curl -sSI https://your-app.pages.dev/signal-config.json | grep -iE 'access-control|cache-control'
```

`signal-config.json` is how you will move the backend later **without
rebuilding the app** — edit that one file, redeploy. See
`docs/REMOTE-CONFIG.md`.

Finally, tell the backend where the frontend is, so the CORS allowlist and the
canonicals are right:

```bash
sudo sed -i 's#^SIGNAL_SITE_URL=.*#SIGNAL_SITE_URL=https://your-app.pages.dev#' /etc/signal/signal.env
sudo sed -i 's#^SIGNAL_ALLOWED_ORIGINS=.*#SIGNAL_ALLOWED_ORIGINS=https://*.pages.dev#' /etc/signal/signal.env
sudo systemctl restart signal
```

---

## Step 13 — end-to-end check from a browser

Open `https://your-app.pages.dev` on a phone and a laptop:

1. Laptop: drop a file → a QR and a 4-digit code appear.
2. Phone: open **Receive**, enter the code.
3. Confirm the transfer completes and the receiver's row shows **Saved**.
4. Turn the phone's Wi-Fi off (mobile data only) and repeat. **If this works, TURN
   is doing its job.** If it fails, the relay is not reachable — go back to
   step 9 and check the VNC security list for UDP 3478 and UDP 443.

Cross-check the security posture end to end:

```bash
# third-party origin must be refused
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://signal.example.com/api/rooms \
  -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"a.bin","size":1}]}'          # → 403

# dev surfaces are closed. /debug is 404 outright (SIGNAL_DEBUG unset).
# /metrics is 401 once ADMIN_TOKEN is configured — this walkthrough's step 6
# does configure it. 404 is what you get with no ADMIN_TOKEN at all, which is
# the stronger posture (the surface is not even confirmed).
curl -s -o /dev/null -w '%{http_code}\n' https://signal.example.com/debug   # → 404
curl -s -o /dev/null -w '%{http_code}\n' https://signal.example.com/metrics # → 401 (404 with no ADMIN_TOKEN)

# brute force the 4-digit code
for i in $(seq 0 30); do curl -s -o /dev/null -w '%{http_code} ' \
  https://signal.example.com/api/nearby/$(printf '%04d' $i); done          # 404s then 429s
```

---

## Step 14 — operations

```bash
sudo journalctl -u signal -f              # live log
sudo systemctl restart signal             # ~instant, rooms are in memory only
curl -sS -H "Authorization: Bearer $(sudo cat /etc/signal/admin-token)" \
  https://signal.example.com/metrics | head
```

Rooms live in memory, so **a restart drops every in-flight transfer**. The grace
period is what protects a receiver who is mid-download when you do it; drain
outside a transfer window.

Backup list is short and boring: `/etc/signal/*` (secrets + env). Nothing else is
worth backing up — there is no database and no user data on disk, by design.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Caddy will not issue a cert | A record not resolving, or 80 blocked in the **security list** | `dig +short $DOMAIN`; check cloud-firewall ingress |
| App says "server unreachable" | Wrong `SIGNAL_URL`, or the CORS allowlist lacks the Pages origin | `curl -sSI https://$DOMAIN/healthz` from a phone's network, not the box |
| Transfers fail on mobile data only | TURN unreachable | `sudo ss -lunp \| grep 3478`; then UDP 3478 + 443 in the security list |
| TURN returns 401 | Secret mismatch between coturn and the env file | Both must contain the same `static-auth-secret` / `TURN_SECRET` |
| `rooms_created` not moving in metrics | Wrong admin token | `sudo cat /etc/signal/admin-token` |
| Room works, share link 404s | `SIGNAL_PUBLIC_BASE_URL` wrong | It must be the public https URL, not `127.0.0.1` |

---

## Redeploy — ship current source

Every hardening commit re-opens the gap until it is live. Redeploy from a
clean, committed HEAD (template-unit paths, as in `docs/DNS-ROUTING.md`):

```bash
# on the workstation, from the repo root
git status --short          # must be empty
VER=$(git rev-parse HEAD)
cd signal && CGO_ENABLED=0 go build -o /tmp/signal-$VER ./cmd/signal && cd ..
scp /tmp/signal-$VER ubuntu@<VM-IP>:/tmp/
```

```bash
# on the box (<app> is the template-unit name, e.g. files)
sudo cp /opt/signal/signal /opt/signal/signal.prev
sudo install -m 0755 /tmp/signal-$VER /opt/signal/signal
sudo sed -i "s#^SIGNAL_VERSION=.*#SIGNAL_VERSION=$VER#" /etc/apps/<app>/signal.env
sudo systemctl restart signal@<app>
curl -sS http://127.0.0.1:8090/healthz     # → ok
```

Verify what is live — version first, behavior second:

```bash
curl -s https://api-<app>.example.com/signal-config.json
# → {"version":"<must equal $VER>", ...}
curl -s -D - -o /dev/null https://api-<app>.example.com/healthz | grep -i cache-control
# → Cache-Control: no-store
```

Freshness check (anytime, no SSH — answers "is prod behind source"):

```bash
LIVE=$(curl -s https://api-<app>.example.com/signal-config.json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
[ "$LIVE" = "$(git rev-parse HEAD)" ] && echo FRESH || echo "STALE (live $LIVE)"
```

Rollback is one step (re-set the version line to the previous hash after):

```bash
sudo install -m 0755 /opt/signal/signal.prev /opt/signal/signal
sudo systemctl restart signal@<app>
```

A restart drops in-memory rooms, so redeploy outside a transfer window
(`rooms_active` via `scripts/metrics.sh` tells you).
