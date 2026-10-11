# Changing the backend address without rebuilding the frontend

The address of the Go backend used to be baked into the frontend bundle at build
time. That meant a backend move meant a rebuild and redeploy of every frontend,
and users on a cached copy waiting for it to expire before a one-line address
change reached them. **That loop is gone.**

## How it works

Every client probes the backend address it already has. Only when that address
stops answering does the client fetch `signal-config.json` and adopt whatever
backend it names. The address compiled into the app is a **fallback**.

```
   app starts
       │
       ├─ probe /healthz on the address we already know
       │     │
       │     ├─ 200 ──────────────► use it. Done. No config request at all.
       │     │
       │     └─ dead ──► probe the other known address
       │                    │
       │                    └─ also dead ──► GET /signal-config.json
       │                                          │
       │                                          ├─ valid + answers ──► adopt,
       │                                          │                       remember it
       │                                          └─ anything else ──► keep the last
       │                                                              address, report
       │                                                              it as dead
```

**A normal launch issues no config request.** The reachability probe is the same
`/healthz` call the backend pill was already making, so the happy path costs
nothing extra — one request, not two, and not one more than before this existed.

The operationally important inversion: **the bundle bakes in the config host (never
changes), not the backend address (changes often).**

### Change the backend

1. Rebuild the static frontend with the new backend (or just edit the deployed
   `signal-config.json`):
   ```sh
   cd signal/web
   SIGNAL_URL=https://new-backend.example.com SITE_URL=https://your-frontend \
     node build-pages.mjs
   ```
2. Deploy.
3. **Retire the old backend.**

Step 3 is the one behavioural consequence worth being explicit about. The app
only consults the config when its current backend has stopped answering, so while
both are up, users stay on the old one — which is the correct reading of "this
one is working". Retiring the old backend is what makes the move automatic, and
it is what you would do anyway. For a graceful handover, drain the old one rather
than expecting the new address to pull users across by itself.

## Why each layer is there

`app.js` resolves the address in stages, and each stage covers a real failure:

| Stage | Source | Covers |
|---|---|---|
| 1 | last adopted address (`localStorage`) | Survives a backend move without re-fetching; also the first candidate to probe |
| 2 | `window.SIGNAL_URL` (baked) | The build-time fallback, and the second candidate if the remembered one is dead |
| 3 | `window.SIGNAL_CONFIG_URL` (baked) + `localStorage` | **Only reached when 1 and 2 both fail to answer.** Where the new backend is looked up |
| 4 | `window.SIGNAL_CONFIG_URL` absent | The web build: same-origin `/signal-config.json`, nothing baked |

Stage 3 being last is the design, not an accident — see above.

## The parts that are easy to get wrong

These were each found by testing, not by reasoning:

**`Cache-Control: no-store` is the whole mechanism.** If the config document is
cacheable — by the HTTP cache or the service worker — a backend change is
invisible until the cache expires, and there is no error anywhere. The client
also sends `cache:"no-store"` and a cache-busting parameter. Pinned by
`TestSignalConfigNotCacheable`.

**CORS on that path.** The config host and the page host can differ, so the fetch
is cross-origin. Without `Access-Control-Allow-Origin` on
`signal-config.json`, the client silently keeps the baked address while
same-origin setups work — a bug that looks like "the update works for some
users and not others". Set in `_headers` for Pages and on the route for the Go
server.

**The address is remote input and is validated *and verified* before use.** Only
absolute `http(s)` origins with a hostname and no embedded credentials are
accepted. Beyond that, the app probes what the config names and adopts it only
if it actually answers — so a stale or hand-edited config cannot point the app
at a black hole. Anything else is refused and the previous value kept, so a bad
config degrades to "no change" rather than "app broken, or aimed at someone
else's server with our share links".

**Room creation awaits the address.** `postJSON` — the single choke point for
state-creating writes — calls `ensureBackend()` first. Without that, a room could
be created on the stale host and then shared from the new one, which breaks in a
genuinely confusing way.

**The backend pill reads the address asynchronously.** It used to read it
synchronously at setup, so it named the baked host while the app actually talked
to another. That pill is the one place an operator looks to see which backend is
live; showing a stale value is worse than showing nothing.

**Failures are loud-ish.** A config fetch that falls back logs a warning and sets
`window.__backendConfigFresh = false`. Failing soft is right — the app must still
start — but *silently* turning "the remote update is broken" into "the remote
update does nothing" is the worst version of this bug to debug. (It cost real
time during development: a duplicated `/signal-config.json/signal-config.json`
path 404'd, the client fell back quietly, and the app looked unchanged.)

## Testing it

```sh
cd signal && go build -o ~/.perf/signal-bin ./cmd/signal
node ~/.perf/backend-swap-test.mjs
```

The test reproduces the deployment shape rather than mocking it: two real Go
backends, an "app host" serving the bundle, and a cross-origin "config host"
serving a mutable `signal-config.json`. It builds the bundle **once**, then:

- asserts traffic lands on backend A
- asserts that **while A still answers, the config is not fetched at all** — the
  "no request on a normal launch" half of the design, asserted directly
- retires backend A, as you would after a real move
- asserts traffic lands on B
- asserts the bundle's file hashes are byte-identical to step 1 — i.e. that no
  rebuild happened, which is the actual claim
- kills the config host with no reachable backend and asserts the app still
  starts and names the address
- feeds six hostile/malformed configs and asserts each is refused
- feeds a valid config as a positive control, proving the fetch path really does
  adopt when it should

## What this does not do

- **A backend move needs the old one retired.** The app only looks up the config
  when its current backend stops answering. Both up → users stay on the old one.
- **It is not instant.** Even once the old backend is gone, the change lands on
  the app's next launch. There is no push channel to a running app; adding one
  would mean server-initiated messages over the existing WebSocket, which would
  also have to survive the sender's tab being the only connected peer.
- **The config host is a single point of truth.** If Pages is down at the moment
  a backend moves, apps cannot discover the new one and stay on the dead address
  until it comes back. That is the safe direction — a stale backend beats no
  backend — but it is a real dependency during a migration.
- **Old frontends pinned to a retired backend can never self-heal** if the config host
  stays unreachable. Nothing else in the app can teach it a new address.
