# WIRE-PROTOCOL.md — signal v4, version 1

Transport: WebSocket (`/ws/rooms/{id}`), text frames carrying one JSON object per line of schema below.
REST (`/api/rooms…`) only for lifecycle + TURN creds — never for SDP/ICE.

## Connect
`GET /ws/rooms/{id}?role=sender|receiver&peer={peerID}`
- `peerID` optional (server mints `rx-<rand>` / keeps `sender`). Must match `from` on send.
- One sender per room: a second `role=sender` gets close code **4400** (`duplicate_sender`).
  The one exception is a rejoin by the ID that already holds the sender slot — see the peer
  identity rule under *Frame schema*; a reconnect must retry until one is accepted.
- Unknown room → HTTP 404 before upgrade (no WS).

## Frame schema
```json
{ "from": "sender", "to": "receivers", "kind": "offer|answer|ice|join|bye|presence|files|ping",
  "payload": "<string, SDP/ICE JSON or empty>", "seq": 12 }
```
- `seq` is server-assigned on relay (monotonic per room); clients must NOT set it (ignored).
- `from` MUST name a peer currently registered in the room (`?peer=` at connect); a frame
  whose `from` is not a live peer is dropped silently. The server never rewrites `from`.
- **A peer ID names exactly one live connection.** Re-registering an ID whose socket is
  still up is refused (close **4400**), as is a receiver claiming the sender's own ID.
  Without this, any peer could take over another's routing slot: frames addressed to that
  ID would go to the attacker, the victim's send channel would become unreachable, and
  `from` would then arrive claiming the sender's identity.
  `TestPeerIDIsExclusive` in `internal/server/security_test.go`.
- **An ID whose socket the server has proven dead MAY be re-registered**, and the displaced
  connection is terminated by the server (`bye`, then hang up) so the ID is served by exactly
  one connection. Liveness is the discriminator: it is recorded only when a **write** to that
  socket fails, which is the server's only proof — a backgrounded mobile tab sends nothing, so
  its reader sits on the deadline for a full `2*SIGNAL_PING+10s`.
  This is not a loosening for its own sake: refusing these made the **mobile reconnect
  impossible**. A sender that switches to WhatsApp to send the link has its socket killed by
  the OS, and its rejoin arrives while the server still holds the old entry — verified live,
  it was closed with `4400 duplicate_sender` and the client-side recovery was silently inert.
  The client must therefore **retry with backoff until a socket actually opens**: a single
  attempt is not enough, because the server's proof can take up to one `SIGNAL_PING`.
  Residual risk: anyone holding a peer ID (the presence payload discloses every ID to every
  room member) can turn a peer off inside the window before its death is detected. The
  displaced socket sees the `bye`, so the takeover is visible rather than silent.
  `TestSenderReconnectAfterFrozenSocket`, `TestReconnectDisplacesDeadPeer`.
- **Client-originated kinds are only `offer`, `answer`, `ice`, `join`, `ping`.** `presence` and
  `bye` are server statements about room state — the clients treat a `presence` with
  `senderOnline:false` as authoritative and fail every in-flight transfer on it — so a peer
  cannot send them. `files` is handled by the server on the sender's behalf.
- `payload` cap 32KB (`SIGNAL_MAX_MSG`): larger → close **1009**.
- `ping`: client→server keepalive (server also pings every `SIGNAL_PING`; answer with any frame).

## Routing rules
- `to: "sender"` → delivered to the sender peer only.
- `to: "receivers"` → broadcast to all receiver peers (sender never receives these).
- `to: "<peerID>"` → direct to that peer (either direction).
- Anything else → dropped + counted (see `/metrics`), connection stays open.
- Broadcast to zero peers → dropped silently (normal for early sender frames;
  offers are additionally mailboxed — see below).
- Concurrent peers per room are capped (32, `maxPeersPerRoom`); over the cap → close **1008**.
  The cap counts *distinct* peer IDs, which is why IDs cannot be reused.

## One peer connection per receiver
A single `RTCPeerConnection` cannot serve two receivers. Both answer the same
`offer`, and the second `setRemoteDescription` lands in the wrong signaling state
("Called in wrong state: stable"), so the second tab silently never gets files.
The sender therefore keeps **one link per receiver peer** (`to: "<peerID>"`), and
rebuilds a link on its own when that peer goes away — which also means one receiver
reloading no longer disturbs anyone else's in-flight transfer.

Each link carries its own queue, so "all requested files sent" is per peer.

## Offer mailbox (late join)
Only **unaddressed** (`to: "receivers"`) sender offers are mailboxed. A
peer-addressed offer names one receiver's DTLS identity and ICE session, so
replaying it to a different receiver would have that receiver answer a description
that can never connect. A late joiner instead gets its own offer, sent on the
`presence` frame that announces it — reliable, because the receiver's socket is
already open when it arrives and the presence frame is broadcast to everyone in
the room. (The client never sends a `join` frame; all eight frames it originates
are ping/files/answer/ice/offer. `join` is accepted server-side for tolerance.)

**The cache is dropped when the last receiver leaves.** A cached offer describes a
DTLS/SCTP association with a peer that no longer exists, so a receiver that refreshed
would answer a dead remote description: both sides look negotiated, the data channel
never opens, and its wants queue forever. With the entry gone, the sender's fresh
(re)offer is what the rejoining receiver negotiates from.

## Reconnecting after a peer reloads
A reloaded tab is a **new peer id** with an empty PC, and the peer's old link dies
without reporting it promptly (a closed data channel lingers ~30s on an SCTP timeout).
Reconnection therefore cannot depend on any single close event. Independent triggers,
so one missed signal is not a dead session:
- sender: for **each** link, `dc.close`, or `connectionState` `failed`/`closed` → close
  that PC, build a fresh one for that peer, and let `onnegotiationneeded` re-offer;
- sender: a `presence` frame → drop the links of peers that are gone, build a link for
  every receiver that doesn't have one, and re-offer to each;
- receiver: on picking a file, a `rPc` whose channel is closed or whose connection
  state is `failed`/`closed` → drop it and build a new one before queueing the want.

Rebuilds are generation-stamped, so a late `close` from a channel that has already
been replaced cannot tear down the healthy link that took its place, and a build
that resolves after a newer one is discarded instead of attaching itself. Each link
also carries a `dead` flag, so events from a replaced peer connection are ignored
rather than being attributed to the replacement.

## Presence
Server emits to the whole room on every join/leave:
```json
{ "from": "server", "to": "receivers", "kind": "presence",
  "payload": "{\"peers\":[\"rx-abc\"],\"senderOnline\":true}", "seq": 7 }
```
(The sender receives presence frames addressed to it as well when it is the only peer.)
Presence is also the only *instant* signal that a peer went away: a data channel lingers ~30s
on an SCTP/DTLS timeout after a tab closes, so clients act on presence rather than waiting
for `close` to tell them the counterpart is gone.

## Live file manifest (`files`)
The sender owns the manifest for the life of the share and may rewrite it at any time.
- S→server: `{"from":"sender","to":"receivers","kind":"files","payload":"{\"files\":[…]}"}`.
  The payload carries the **full** list (not a delta) as `{"id","name","size","mime"}` per entry;
  cap 20 files. A frame from anyone other than the room's sender is dropped and counted in
  `/metrics` (`route_errors`).
- **Every entry is validated exactly as `POST /api/rooms` validates it** (`validFileMeta`):
  no path separators, no control characters or bidi/zero-width overrides, no trailing dot or
  space, no Windows device name (`CON`, `NUL`, `COM1`…), name ≤ 255 bytes, size > 0 and
  ≤ 50 GiB, mime ≤ 128 bytes, and `id` ≤ 64 bytes with no quote, backslash, angle bracket, `=`
  or whitespace (it reaches a `querySelector` on the receiver). This frame is the only way a
  filename can change after creation, so skipping the check let a sender push names that
  `POST /api/rooms` rejects — verified live: `../../etc/passwd` was a 400 on create and was
  then served to receivers via this frame. `TestFileNameValidation` asserts both paths.
- server→receivers only: the store replaces `room.Files` and rebroadcasts the same payload
  (fresh `seq`). The sender is deliberately **not** echoed to — it already knows its own list.
- `id` is the stable per-file key (see DataChannel §v2). Receivers reconcile on it: added ids
  render new rows, ids that disappear are marked removed and stop being requestable, ids
  already saved stay marked saved. Receivers therefore open signaling on page load (not on
  first click) so removals reach them before any download starts; the peer connection itself
  is still created lazily, on first pick or first offer.

## DataChannel file protocol v2 (request-based, `fid`-addressed)
Receiver picks files; sender streams on demand over the single ordered channel. Files are
addressed by a **stable `id`**, never by list index: the sender can add or remove files while
streaming, which shifts indices and would silently re-point a receiver's "file 3" at a
different file.
- R→S: `{"t":"want","fid":"f3a91c2e","idx":2}` (one file) or `{"t":"wantAll"}`. Queued sender-side
  FIFO; receiver-side wants queue until the channel opens. `fid` is authoritative; `idx` is
  redundant legacy that old senders need.
- S→R per file: `{"t":"header","fid","idx":N,"name","size","mime"}`, then binary chunks
  (≤256KB ArrayBuffer, clamped to the peer's `sctp.maxMessageSize`), then
  `{"t":"eof","fid","idx":N,"bytes":B,"sha256":"…"}`, where `bytes` is the exact
  count sent and `sha256` its hex digest. Files stream one at a time.
- R→S per file: `{"t":"ack","fid":"f3a91c2e"}`, sent **only after the write finished
  AND verified** — after `WritableStream.close()` resolves, or after the blob
  download was triggered for a buffered file. Never sent for a partial, failed,
  or unverified file. `ack` therefore means *byte-identical*, not just *complete*.
- Receiver verification (mandatory): on `eof` the receiver compares its own byte
  count against `size` **and** `bytes`, and its own incremental SHA-256 digest
  against `sha256`. Any mismatch → loud failure (row ❌, named shortfall), nothing
  saved (a streaming partial is removed from disk best-effort), no `ack`.
  Senders from before this fieldset omit `bytes`/`sha256`: the header-size check
  still guards truncation. Unknown `t`/fields are ignored both ways, so the
  change is purely additive (still protocol v1).
- R→S at any point: `{"t":"cancel"}` — the receiver stopped the download on purpose
  (✕ button, visible only mid-download). The sender clears that link's queue, aborts
  the in-flight file at the next chunk so no `eof` follows and no `ack` is ever owed,
  resets that attempt's progress display, and holds the link for the next pick instead
  of reporting a failure. Unknown-`t` senders ignore it (same compatibility as `ack`);
  the receiver's link stays open either way, so a retry just re-wants.

### Why `ack` exists
Without it the sender can only make claims about *its own* device: it knows bytes
left the buffer and `eof` went out, and nothing more. It cannot tell "the receiver
saved this" from "the channel died two chunks later". The wire protocol had no way
to express delivery, so any "received" wording on the sender page would have been
a guess.

`ack` is that missing bit of evidence, and it is the **only** thing that unlocks the
"Received" state:

- `sent` = bytes left the sender. Safe to say on queue drain.
- `received` = the receiver confirmed the write **and the integrity check** (`ack`
  is only sent after count + SHA-256 verify). Safe to say on `ack`, and only then.
- 20s of silence after `eof` → the file is shown as `sent · no confirmation`, never
  as `received`.

**Compatibility:** purely additive and receiver→sender, so an old sender ignores it
(it matches no case) and an old receiver never sends it — which degrades to the
`sent · no confirmation` state rather than to a false "received". `t` values
outside the documented set are ignored by both sides.

## Close semantics
- Sender WS drops → room enters grace (`SIGNAL_GRACE`, default 10s). Receivers stay connected, get
  `presence` with `senderOnline:false`. Sender reconnect within grace revives the room.
- Grace expires → server sends `{kind:bye}` to receivers, closes with **1000**, deletes room
  (nearby code freed). `GET /api/rooms/{id}` → 404 afterwards.
- `DELETE /api/rooms/{id}` → immediate `bye` + close, no grace.
- Close codes the server sends: `1000` normal/bye, `1002` protocol violation (reserved bits,
  fragmented or oversized control frame, bad opcode, interleaved message, stray continuation,
  unmasked client frame),
  `1008` room full only, `1009` message too big, `1011` join failed,
  `4400` duplicate peer ID, `4401` room disabled. Shutdown is `1000` with a `bye` frame — there
  is no `1001` path. The close *reason* is the code plus a short UTF-8 string (up to 123 bytes,
  the RFC 6455 control-frame limit); codes that must never appear on the wire (`1005`, `1006`,
  `1015`, and the reserved `1016-2999`) are normalised to `1000` rather than echoed.

### Client behaviour on a terminal event
Every way a receive can end that will not complete — `bye`, data-channel close, ICE
failure, sender offline past the 10s presence grace, the sender removing that file,
or a request that never started — goes through **one** terminal state, so the UI
always lands truthful rather than half-finished:
- nothing half-written is kept (buffered chunks are dropped, a streaming writer is aborted);
- the row is marked `❌` and the log names the actual reason;
- the stall watchdog is left armed but idle, so a **later** download in the same
  session is still guarded (it used to be cleared on the first success);
- a request whose `header` never arrives is retried once over a rebuilt link at 10s
  and fails at 25s, instead of sitting at `⏳` forever;
- a click made while `presence` says the sender is offline does not queue at all —
  it says the sender is offline and leaves the button usable for a retry.

## TURN credentials (REST, not WS)`GET /api/rooms/{id}/turn` → `200`:
```json
{ "ttl": 3600, "iceServers": [
  { "urls": "stun:stun.l.google.com:19302" },
  { "urls": "turn:turn.example.com:3478?transport=udp", "username": "171…:a1b2", "credential": "<hmac>" },
  { "urls": "turn:turn.example.com:3478?transport=tcp", "username": "…", "credential": "…" },
  { "urls": "turns:turn.example.com:443?transport=tcp", "username": "…", "credential": "…" } ] }
```
`username = "<expiryUnix>:<rand4>"`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`
(coturn `--use-auth-secret` REST API). No `TURN_SECRET` → `410 {error:turn_disabled}`.
Order is cheapest-first per FIREWALL-TRAVERSAL.md §2 — clients must NOT reorder.

## Versioning
This is version 1. Additive `kind` values are minor (old clients ignore unknown kinds).
Any breaking change → version 2 with a `v` param on connect and a migration note here.

## Abuse (REST + close code)
- `POST /api/rooms/{id}/report {"reason":"spam|malware|phishing|csam|other","contact?":""}` →
  `201 {status:received}`; `400 bad_reason`; `404` unknown; `429` over limit; `503`
  `{error:report_not_persisted}` when the durable log could not be written. A report on
  an already-disabled room is still **filed** and answers `200
  {status:received, note:"already_disabled"}` — not an error, because there is nothing
  left to act on and the record is the point. (`451` is the *read* result for a
  disabled room, below, not a report result.)
- `POST /api/usage` `{n}` → `204` — anonymous success counter. The receiver posts
  `{n:1}` once per file it saved AND sha256-verified, then forgets it; all
  batching is server-side, where increments accumulate in memory and are written
  out as one batch on a 60s timer. No identifier is sent and none is recorded.
  Always `204`, including for malformed input: a counter must never be able to
  surface a failure into a transfer. Rate limited per IP (600/min — high enough
  that a shared NAT address does not spend a real receiver's budget) and each
  submission is capped, so it cannot be used as an amplifier. Absent on an older
  server, where the client's request simply 404s and is ignored. Backed by
  `USAGE_FILE`; see internal/server/usage.go and docs/CONFIG.md.
- `GET /api/admin/reports` (Bearer `ADMIN_TOKEN`) → `200 {reports:[...]}`; `401` wrong token;
  `503 admin_disabled` when no token configured.
- `POST /api/admin/rooms/{id}/disable {"reason":"..."}` → peers get `bye` + hangup, room deleted,
  tombstone kept: `200 {status:disabled}` (repeat → `already_disabled`); `404` unknown.
- Disabled room reads: REST `GET /api/rooms/{id}` → `451 {error:room_disabled, reason}`.
- Disabled room joins: handshake succeeds, then server closes with code **4401** + reason text
  (browsers can't read HTTP error statuses from WS handshakes). Clients show a disabled notice.

## DataChannel file protocol v2 (request-based)
Receiver picks files; sender streams on demand over the single ordered channel. See
"Live file manifest" above for the `fid` keying rules.
- R→S: `{"t":"want","fid","idx"}` (one file) or `{"t":"wantAll"}`. Queued sender-side FIFO;
  receiver-side wants queue until the channel opens. `idx` = index into room `files` (legacy
  fallback for senders that predate `fid`).
- S→R per file: `{"t":"header","fid","idx":N,"name","size","mime"}`, then binary chunks
  (≤256KB ArrayBuffer, clamped to the peer's `sctp.maxMessageSize`), then
  `{"t":"eof","fid","idx":N,"bytes":B,"sha256":"…"}`, where `bytes` is the exact
  count sent and `sha256` its hex digest. Files stream one at a time.

### Flow control (no wire change)
The single ordered channel is throttled entirely by `RTCDataChannel.bufferedAmount`; there is no
credit/ack frame. Sender sends only while `bufferedAmount <= 4MB` and waits for it to fall back
under 1MB. The wait listens for `bufferedamountlow` *and* polls every 40ms *and* is capped at 20s —
`bufferedamountlow` is not dependable on a backed-up channel and waiting on it alone wedged the
send loop forever. Either peer may restart the connection via `restartIce()` (same room, same link)
when 15s pass with no progress; rate-limited to one restart per 30s so a recurring stall can recover.
- Reselecting works: stop/reshare resets sender state; receiver tracks per-file
  saved state by `fid`. Re-wanting an unsaved file re-queues it.

### Interruption semantics
A transfer that loses its file or its peer must **fail loudly**; it must never half-save or hang.
Every path below calls the same `failRx(reason)`, which discards buffered chunks, aborts the
file writer, marks the row ❌, and states in chat that nothing was saved.
- **File removed mid-transfer** — the `files` frame names a `fid` currently in flight: the sender
  aborts that send, the receiver fails the download and the row disappears entirely.
- **Sender tab closed** — the data channel would linger ~30s, so the receiver keys off the
  `presence` frame with `senderOnline:false` and fails after a 10s grace period (cancelled if bytes
  resume, in case they come back). `bye`, `dc.close`, a `failed` connection state and a
  not-open channel each fail it immediately.
- **Receiver tab closed** — the server's `presence` frame reports zero receivers instantly; the
  sender clears its queue and stops pushing bytes at nothing.
- **Receiver cancel (`{"t":"cancel"}`)** — deliberately NOT a failure: neither side goes through
  `failRx`/`endRx`. Both reset that attempt's progress to zero, restore the rows to retryable,
  and say "nothing was saved"; the link stays open so the next `want` resumes instantly.

