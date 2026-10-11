# DNS-ROUTING.md — routing an app under `example.com`

The operational reference for putting a new app in front of users: which DNS
records, which Caddy block, which systemd unit, in what order, and how to check
each step worked. Covers all three deployment modes in one place, because the
difference between them is only *which records exist*, not how routing works.

Companion to `DEPLOY-VPS.md` (first-time server setup) and `REMOTE-CONFIG.md`
(moving a backend later).

---

## The one rule

```
the FACE (what users see)  →  orange  (Cloudflare proxy)
the ENGINE (API + WebSocket)  →  grey  (DNS only)
TURN  →  grey
```

### Why the API must never be orange-clouded

Not a style preference — a correctness requirement, and it comes out of the
security work.

The server trusts `X-Forwarded-For` **only** when the direct peer is
loopback/private (`trustProxyHeader` in `security.go`), and then it reads the
**rightmost** entry — the one your own proxy appended — not the leftmost, which
is whatever the caller sent. If Cloudflare proxies the API, the peer becomes a
Cloudflare *public* IP, so the header is correctly ignored, and every client on
the internet collapses into **one** rate-limit bucket: 10 rooms/min shared by
everyone, with per-client limits silently dead.

TURN is simpler still: Cloudflare's proxy only speaks HTTP, and TURN is raw UDP.
A proxied TURN record fails every allocation.

---

## Naming convention

Fix it once and every app afterwards is a copy-paste:

```
<app>.example.com           the face
api-<app>.example.com       its engine (hybrid only)
turn-<app>.example.com      its TURN (only if it has one)
```

Working example used throughout: app id `files`.

---

## Mode A — Pages only

Static app. Nothing on your server; no SSH, no ops, no cost.

### DNS (Cloudflare)

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `files` | `<project>.pages.dev` | orange |

You do not add this by hand. Pages → **Settings → Custom domains** → add the
name; Cloudflare creates the record and issues the certificate, because the
domain is in the same account.

### Setup

```bash
cd signal/web
SIGNAL_URL= SITE_URL=https://files.example.com node build-pages.mjs
```

Deploy `dist/`. Done.

---

## Mode B — hybrid (face on Pages, engine on the VPS)

This is the file-sharing app's shape.

### DNS

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `files` | `<project>.pages.dev` | orange *(auto-created)* |
| A | `api-files` | `<VPS IP>` | **grey** |
| A | `turn-files` | `<VPS IP>` | **grey** |

### Cloud firewall ingress (console — the real firewall)

Networking → firewall / security lists → add ingress rules:

| Port | Protocol | Why |
|---|---|---|
| 443 | TCP | HTTPS for the grey-clouded names, and TURN/TLS |
| 80 | TCP | ACME HTTP-01 — Caddy cannot get a certificate without it |
| 3478 | TCP + UDP | TURN on its standard port |
| 443 | UDP | TURN over UDP — a *different* port space from TCP 443, so no conflict with Caddy |

### On the box

```bash
sudo install -d -m 0750 -o root -g signal /etc/apps/files
sudo nano /etc/apps/files/signal.env      # see the reference below
sudo chmod 600 /etc/apps/files/signal.env
sudo chown root:signal /etc/apps/files/signal.env

sudo cp /etc/systemd/system/signal@.service /etc/systemd/system/ 2>/dev/null \
  || sudo cp /path/to/docs/deploy/signal@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now signal@files
sudo journalctl -u signal@files -n 20 --no-pager
```

### Caddy block

```caddy
api-files.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8090 {
		header_up X-Forwarded-Proto {scheme}
	}
	log { output discard }     # a request log records every room id = a share link
}
```

```bash
sudo systemctl reload caddy
```

---

## Mode C — VPS only

One hostname serves the HTML *and* the API, because the Go server already serves
both. **No CORS at all** — same origin — and the app's `SITE_URL` is this same
hostname.

### DNS

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `files` | `<VPS IP>` | **grey** |

### Caddy block

```caddy
files.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8090     # serves /, /r/*, /api/*, /ws/* from one origin
	log { output discard }
}
```

The env file sets `SIGNAL_ALLOWED_ORIGINS` to nothing meaningful, because there
is no cross-origin call to make.

### Deploying the assets

Note the directory difference, verified against the server's load-time whitelist:
the Pages build **inlines** `styles.css`/`states.css` away, but the Go server
needs them on disk as *sources* for its own inline transform. So:

- Mode A/B → deploy `signal/web/dist/` to Pages
- Mode C → deploy `signal/web/` to `/opt/apps/files/web/` (**not** `dist/`)

---

## Reference: `/etc/apps/<app>/signal.env`

```ini
# Public address of THIS server.
SIGNAL_PUBLIC_BASE_URL=https://api-files.example.com

# The FRONTEND origin. On a split deployment this must be the Pages site, not
# the API host, or every canonical URL, og:url and sitemap entry points at the
# API instead. For mode C (single origin) it is the same hostname as above.
# SIGNAL_SITE_URL, not SITE_URL: the latter is build-pages.mjs's input and this
# server never reads it.
SIGNAL_SITE_URL=https://files.example.com

SIGNAL_VERSION=1.0.0

# Loopback + a per-app port. Two apps must never share a port.
SIGNAL_ADDR=127.0.0.1:8090
SIGNAL_WEB_DIR=/opt/apps/files/web

SIGNAL_GRACE=30s
SIGNAL_PING=25s
SIGNAL_MAX_MSG=32768

STUN_URL=stun:stun.l.google.com:19302
# Omit TURN_HOST/TURN_SECRET for an app that does not need a relay.
TURN_HOST=turn-files.example.com
TURN_SECRET=<shared with coturn>
TURN_TTL=3600s
TURN_REALM=example.com

RATE_CREATE_PER_MIN=10
RATE_TURN_PER_MIN=30
RATE_REPORT_PER_MIN=5
RATE_NEARBY_PER_MIN=20

# Success-counter + abuse-report durability. Both are opt-in: unset keeps them
# memory-only (fail closed), so the count resets on restart and reports die
# with the process. Per-app subdirectory — two apps sharing one file would
# silently merge their counts/logs. The template unit already grants
# /var/lib/signal as writable state.
# Create the dir first: the report log creates it on startup, but the usage
# flush does not — install -d -m 0700 -o signal -g signal /var/lib/signal/files
#USAGE_FILE=/var/lib/signal/files/usage.json
#REPORT_LOG=/var/lib/signal/files/reports.jsonl

ADMIN_TOKEN=<per app; gates /metrics and /api/admin/*>

# The only proxy in front is Caddy on the same host, so trusting its
# X-Forwarded-For is safe and makes rate limits per-client rather than
# per-proxy. This stays safe precisely BECAUSE the API is grey-clouded.
TRUST_PROXY=1

# One line covers every app you will ever add. The wildcard matches subdomains
# only — not the bare domain, and not example.com.evil.tld.
SIGNAL_ALLOWED_ORIGINS=https://*.example.com
```

---

## Order of operations

The step people get wrong is cert issuance: **Caddy cannot get a certificate for
a name that does not resolve yet.** A TLS error almost always means "the record
isn't there", not "Caddy is broken".

```
1. Create the DNS A record (grey)          ─┐ DNS first
2. dig +short api-files.example.com      ─┘ verify before going further
3. Write the env file
4. systemctl enable --now signal@files
5. Add the Caddy block; reload caddy        → certificate issued here
6. Verify from OUTSIDE the box (see below)
```

For Pages apps there is no ordering trap: Cloudflare owns both the record and
the certificate.

---

## Verify

From your workstation, not the box — a curl from the VPS proves nothing about
the public path.

```bash
# 1. the name resolves
dig +short api-files.example.com

# 2. TLS is valid and the chain verifies
curl -sSI https://api-files.example.com/healthz | head -3

# 3. the API answers and the security headers are present
curl -sS https://api-files.example.com/healthz
curl -sSI https://api-files.example.com/healthz | grep -iE 'content-security|referrer-policy|x-frame|cache-control'

# 4. third-party origins are refused (CORS allowlist working)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api-files.example.com/api/rooms \
  -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"a.bin","size":1}]}'          # → 403

# 5. the page itself
curl -sSI https://files.example.com/ | head -5
curl -sS https://files.example.com/robots.txt | tail -2
```

Then the real test — open the app on a phone and complete a transfer. With TURN
configured, turn the phone's Wi-Fi off first: that is the case that fails without
a relay.

---

## Redirect rules: what they are for

Cloudflare **Redirect Rules** issue an HTTP 301/302. They are the right tool for
a small number of URL-level decisions:

| Use | Source | Target |
|---|---|---|
| www → apex | `https://www.*` | `https://${1}` |
| Retiring an old app name | `https://old.example.com/*` | `https://files.example.com/${1}` |
| Short marketing link | `https://example.com/s/*` | `https://files.example.com/${1}` |
| http → https | automatic | no rule needed |

**They are the wrong tool for routing to your server.** A redirect to
`http://<VPS-IP>:8090` makes the browser validate a certificate against a bare IP
address, which fails outright. APIs get a grey A record; that is all.

DNS records are unlimited; redirect rules are a small allowance on free plans
(the dashboard shows your exact number). Keep structure in DNS.

---

## The wildcard option

You *can* add `* → <VPS IP>, grey`, so every `api-*` name lands on the box with no
DNS work per app. Explicit records still win over a wildcard, so Pages apps are
unaffected.

**The footgun:** create a Pages app, forget its explicit record, and it silently
falls through to the wildcard and hits your VPS — a confusing 404 instead of an
obvious misconfiguration. Either skip the wildcard, or keep the record list
somewhere generated rather than in someone's memory.

---

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Caddy will not issue a cert | A record missing or not propagated | `dig +short <name>`; cloud-firewall ingress for port 80 |
| App says "server unreachable" | Wrong `SIGNAL_SITE_URL`, or the API hostname is orange-clouded | `curl -sSI https://api-…/healthz` from a phone's network |
| Everyone shares one rate-limit bucket | The API got orange-clouded | It must be grey; that is what makes `TRUST_PROXY=1` safe |
| Cross-origin requests blocked | The app's own domain not in the allowlist | Use `https://*.example.com` rather than listing each app |
| TURN allocations fail | TURN record orange, or 3478/443-UDP closed in the cloud firewall | `sudo ss -lunp \| grep -E '3478\|443'` |
| Transfer fails on mobile data only | Relay unreachable | Repeat with Wi-Fi off; check UDP ingress |
| Room works, share link 404s | `SIGNAL_PUBLIC_BASE_URL` wrong | Must be the public https URL, never `127.0.0.1` |
