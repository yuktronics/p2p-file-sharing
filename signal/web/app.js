// p2p file sharing v4 — wire protocol v1 (WebSocket signaling + /turn ICE).
// UX layer carried over from v2 (themes, radial, chat, confetti, OTP).
// Perf upgrades: 256KB chunks, event backpressure, directory-streaming writes.
const FALLBACK_STUN = [{ urls: "stun:stun.l.google.com:19302" }];

// ── Backend address: baked fallback + remotely updatable ────────────────────
//
// window.SIGNAL_URL is injected at build time. That alone would mean a backend
// change forces a rebuild and redeploy of every frontend — a slow loop for a
// one-line address change.
//
// So the baked value is a FALLBACK, not the answer. At startup the client asks a
// config host where the backend lives NOW and adopts it. Changing the backend
// becomes: edit signal-config.json on the static host and push. A deployed
// frontend picks it up on next load, with no rebuild at all.
//
// Layers, in order:
//   1. window.SIGNAL_CONFIG_URL — absolute URL of the config document. It points
//      at the stable static frontend host, which does NOT change when the
//      backend does — that is the whole point.
//   2. <origin>/signal-config.json — same-origin, so the web build gets remote
//      updates for free with nothing baked in at all.
//   3. last known good (localStorage) — a returning user who is offline still
//      gets the right backend instantly.
//   4. window.SIGNAL_URL — the baked fallback.
//
// SIGBASE is a `let`, not a `const`, because refreshBackend() reassigns it.
// Every reader goes through apiUrl/wsUrl/originOf at call time, so they all
// observe the update without further changes.
let SIGBASE = (() => { try { return String(window.SIGNAL_URL || "").replace(/\/+$/, ""); } catch { return ""; } })();

// The origin that serves the UI, as opposed to the API. These are the same host
// in a single-origin deployment and different hosts in a split one (UI on Pages,
// API on the VPS). Anything a human opens, or copies into a chat, must use this
// one: a link built from the API origin points at a host that serves no UI.
let SITEBASE = (() => { try { return String(window.SIGNAL_SITE_URL || "").replace(/\/+$/, ""); } catch { return ""; } })();

// Only absolute http(s) origins are accepted. The config document is remote
// input — fetched at runtime from a host we do not control at that moment — so
// it is validated before it can steer a single API call. Anything implausible is
// ignored and the previous value kept, so a corrupted or hostile config degrades
// to "no change" rather than "app broken".
function validBackend(u) {
  if (typeof u !== "string") return false;
  const s = u.trim().replace(/\/+$/, "");
  if (!s) return false;
  let p;
  try { p = new URL(s); } catch { return false; }
  if (p.protocol !== "https:" && p.protocol !== "http:") return false;
  if (!p.hostname) return false;
  // Embedded credentials would end up in every share link.
  if (p.username || p.password) return false;
  return s;
}

function originOfRaw() {
  try {
    const o = window.location && window.location.origin;
    return o && o !== "null" ? o : "";
  } catch { return ""; }
}

function configUrl() {
  const explicit = (() => { try { return String(window.SIGNAL_CONFIG_URL || "").trim(); } catch { return ""; } })();
  if (explicit) {
    // Must itself be absolute: a relative one would resolve against the shell's
    // own origin, which is precisely the mistake this mechanism exists to avoid.
    try { if (new URL(explicit).protocol) return explicit; } catch { return ""; }
    return "";
  }
  const o = originOfRaw();
  return o ? o + "/signal-config.json" : "";
}

const CONFIG_CACHE_KEY = "sd-backend-url";
let backendReady = null;

// Surfaced so a misconfigured config URL is not invisible. Failing soft is
// right (the app must still start), but silence turns "the remote update is
// broken" into "the remote update does nothing", which is the worst version of
// this bug to debug. The backend pill shows the address actually in use, so the
// two together tell the whole story.
// Surfaced so a misconfigured config host is not invisible. Failing soft is
// right (the app must still start), but silence turns "the remote update is
// broken" into "the remote update does nothing", which is the worst version of
// this bug to debug.
function markConfig(fetched, why) {
  window.__backendConfigFetched = fetched;
  window.__backendConfigWhy = why || "";
  if (fetched) {
    try { console.info(`[config] backend address refreshed from the config host (${why})`); } catch {}
  } else if (why) {
    try { console.warn(`[config] ${why}`); } catch {}
  }
}

// Reachability probe. Short timeout on purpose: a dead backend must not stall
// startup, and this is the very same /healthz call the backend pill makes
// anyway, so on the happy path it costs no extra request.
async function backendReachable(base, ms) {
  if (!base) return false;
  try {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, ms || 2500);
    let r;
    try { r = await fetch(base + "/healthz", { cache: "no-store", signal: ctl ? ctl.signal : undefined }); }
    finally { clearTimeout(timer); }
    return r.ok;
  } catch { return false; }
}

// Resolve which backend to use.
//
// The config host is NOT consulted on a normal launch. A backend move is
// discovered the only way that costs nothing: the address we already have stops
// answering, and only then do we ask the config host where the new one is.
//
//   1. try the last address we adopted (localStorage), else the baked one
//   2. if it answers → use it. No config request, no added latency.
//   3. if it does not, try the other address we know
//   4. only now pay for a config fetch, and verify what it names before trusting it
//   5. nothing works → keep the last address and report it as unreachable
//
// Consequence worth stating plainly: a backend move is picked up automatically
// when the OLD backend goes away. While both are up, users stay on the old one —
// which is the correct reading of "this one is answering".
async function resolveBackend() {
  const baked = SIGBASE;
  let cached = "";
  try { cached = validBackend(localStorage.getItem(CONFIG_CACHE_KEY)); } catch {}
  // A web build bakes nothing, so SIGBASE is empty and the backend is this very
  // origin. Probing location.origin first is what keeps the self-hosted case at
  // zero config requests — without it, "no baked address" looks identical to
  // "backend unknown" and every first visit goes to the config host.
  const self = baked ? "" : originOfRaw();

  // 1–3. Everything we already know. Taken on every normal launch; issues no
  // config request at all.
  for (const candidate of [cached || baked || self, baked || self]) {
    if (!candidate) continue;
    SIGBASE = candidate;
    if (await backendReachable(SIGBASE)) {
      markConfig(false, "");
      window.__backendConfigFresh = true;
      return SIGBASE;
    }
  }

  // 4. Everything we know is dead. Now the config fetch is worth its request.
  const url = configUrl();
  let why = "no known backend is reachable";
  if (url) {
    try {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, 4000);
      let res;
      try {
        // cache:"no-store" plus a cache-buster: an intermediary cache must not
        // be able to resurrect the address that just died.
        res = await fetch(url + (url.includes("?") ? "&" : "?t=") + Date.now(),
          { cache: "no-store", signal: ctl ? ctl.signal : undefined });
      } finally { clearTimeout(timer); }
      if (!res.ok) throw new Error("config http " + res.status);
      const cfg = await res.json();
      const next = validBackend(cfg && (cfg.signalUrl || cfg.signal_url || cfg.url));
      if (!next) throw new Error("config had no usable signalUrl");
      // Trust the config only if it names something that actually answers. A
      // config is remote input; verifying it is what stops a stale or
      // hand-edited file from pointing the app at a black hole.
      SIGBASE = next;
      if (await backendReachable(next)) {
        try { localStorage.setItem(CONFIG_CACHE_KEY, next); } catch {}
        markConfig(true, next);
        window.__backendConfigFresh = true;
        return next;
      }
      why = `config named ${next} but it did not answer`;
    } catch (e) {
      why = "config fetch failed: " + ((e && e.message) || String(e));
    }
  }

  // 5. Nothing usable. Keep the last address so share links and retries still
  // have somewhere to point; the UI reports it as unreachable.
  SIGBASE = cached || baked;
  markConfig(false, why);
  window.__backendConfigFresh = false;
  return SIGBASE;
}

// ensureBackend resolves once the address is as fresh as we can make it.
// Awaited before anything that CREATES server-side state, because a room created
// against a stale host and then shared from the new host breaks confusingly.
function ensureBackend() {
  if (!backendReady) backendReady = resolveBackend();
  return backendReady;
}

const apiUrl = p => (/^https?:\/\//i.test(p) ? p : SIGBASE + p);
function wsUrl(roomId, role, peer) {
  if (!SIGBASE) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws/rooms/${roomId}?role=${role}&peer=${encodeURIComponent(peer)}`;
  }
  const u = new URL(SIGBASE);
  return `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/ws/rooms/${roomId}?role=${role}&peer=${encodeURIComponent(peer)}`;
}
function originOf() {
  try { return SIGBASE ? new URL(SIGBASE).origin : location.origin; }
  catch { return location.origin; }
}

// Where a human-facing link must point. Deliberately NOT originOf(): that is
// the API, and on a split deployment the two are different hosts.
function siteOrigin() {
  if (SITEBASE) { try { return new URL(SITEBASE).origin; } catch {} }
  // Not configured. The page's own origin is the right guess for a web build,
  // and it is also correct in the single-origin deployment where the Go server
  // serves the UI.
  return originOfRaw();
}

// Build the link a person actually shares.
//
// The server returns an absolute URL built from its own PUBLIC_BASE_URL. On a
// split deployment that names the API host, which serves no UI — so using it
// verbatim hands out a link that 404s for the recipient while looking entirely
// plausible on the sender's screen. Keep only the path the server chose (it owns
// the room id and the route) and graft it onto the site origin.
//
// That path is still remote input, so it is parsed rather than concatenated, and
// its leading slashes are collapsed to exactly one. Concatenating a raw
// "//host/path" gives "https://site//host/path" — still the right host, so not an
// open redirect, but a double-slash path is ambiguous and some parsers read it
// as protocol-relative. Exactly one leading slash makes the guarantee checkable:
// the result is always the site origin plus a plain absolute path.
function roomShareUrl(serverUrl) {
  let path = "/";
  try {
    const u = new URL(String(serverUrl || ""), "https://placeholder.invalid");
    path = (u.pathname || "/") + (u.search || "");
  } catch {
    const raw = String(serverUrl || "");
    path = raw.startsWith("/") ? raw : "/";
  }
  path = path.replace(/^\/+/, "/");
  if (!path.startsWith("/")) path = "/" + path;
  return siteOrigin() + path;
}
// Chunk size: measured across 16KB..256KB on a 96MB loopback transfer, all sizes
// land in the same 12-26MB/s band with heavy run-to-run variance (64KB scored 26.0
// then 16.3 on repeat runs) — so chunk size buys us nothing in this range and 256KB
// stays as the shipped, proven value. Above 256KB it is actively harmful: 1MB and
// 4MB chunks NEVER complete (0 bytes after 180s), so the clamp is a guard rail.
// See docs/BENCHMARKS.md. Overridable via ?chunk= for benchmarking only.
const CHUNK = (() => {
  const q = Number(new URLSearchParams(location.search).get("chunk"));
  return Number.isFinite(q) && q >= 16384 && q <= 262144 ? q : 262144;
})();
// Keep very little in flight. A big backlog hides a slow receiver and is what
// pushed us into the waitDrain wedge (see waitDrain) — 4MB/1MB keeps SCTP honest.
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

function rid(n = 8) {
  const a = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = ""; crypto.getRandomValues(new Uint8Array(n)).forEach(v => s += a[v % a.length]);
  return s;
}
async function postJSON(url, body) {
  // Resolve the live backend address first. This is the choke point for every
  // state-creating POST, so awaiting here guarantees a room is never created on
  // a stale host and then shared from a different one — the failure mode that
  // makes a remotely-updated backend look broken.
  await ensureBackend();
  const r = await fetch(apiUrl(url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}
async function fetchIce(roomId) {
  try {
    const r = await fetch(apiUrl(`/api/rooms/${roomId}/turn`));
    if (r.ok) {
      const j = await r.json();
      if (j.iceServers && j.iceServers.length) return j.iceServers;
    }
  } catch {}
  return FALLBACK_STUN;
}
// openSignal: WS v1 frames {from,to,kind,payload,seq}. onMsg per frame, onState('closed').
function openSignal(roomId, role, peer, onMsg, onState) {
  const sock = new WebSocket(wsUrl(roomId, role, peer));
  // Queue frames sent before the socket opens (e.g. the sender's offer fired
  // immediately after connect) — dropping them deadlocks the transfer.
  const queue = [];
  const send = o => {
    const s = JSON.stringify(o);
    if (sock.readyState === 1) { try { sock.send(s); } catch {} }
    else if (sock.readyState === 0) queue.push(s);
  };
  sock.onopen = () => { while (queue.length && sock.readyState === 1) sock.send(queue.shift()); };
  sock.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch {} };
  sock.onclose = e => { clearInterval(ka); onState && onState("closed", e); };
  sock.onerror = () => {};
  const ka = setInterval(() => send({ from: peer, to: "sender", kind: "ping", payload: "" }), 20000);
  return {
    send,
    close: () => { clearInterval(ka); sock.close(); },
    // Liveness, for the caller's reconnect logic. A closed socket is NOT
    // reconnectable in place: openSignal builds a fresh WebSocket, so the caller
    // must build a fresh handle too.
    isOpen: () => sock.readyState === 1,
    isClosed: () => sock.readyState === 3,
  };
}
function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1000) return (n / 1024).toFixed(1) + " KB";
  return Math.max(0, Math.round(n)) + " B";
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// CSS.escape for use inside a selector. Prefers the platform implementation and
// falls back to a spec-shaped one, because a missing CSS global must not turn
// into a thrown selector (which is what this replaces).
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, c => "\\" + c);
}
// Mirror of the server's validFileMeta name rules (internal/server/security.go).
// The DataChannel header.name arrives peer-to-peer and never passes through the
// REST/WS validation, so a malicious sender could otherwise push bidi-spoofed,
// device-reserved or traversal-adjacent names straight to the receiver's disk.
// Fail closed: an invalid name is rejected before any save, never sanitised
// into a different file the user did not ask for.
function validRecvName(name) {
  if (typeof name !== "string" || !name || name.length > 255) return false;
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) return false;
  for (const ch of name) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f || c === 0x200e || c === 0x200f ||
        (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) return false;
  }
  if (name.trim() === "" || name.replace(/\./g, "").trim() === "") {
    // Covers "..." and names that are only dots/spaces — traversal in disguise
    // on some filesystems. The server checks Trim(name,".")==""; also refuse
    // whitespace-only here since it renders blank in the row.
    let dotsOnly = true;
    for (const ch of name) if (ch !== "." && ch !== " " && ch !== "\t") { dotsOnly = false; break; }
    if (dotsOnly) return false;
  }
  if (name.endsWith(".") || name.endsWith(" ")) return false;
  let stem = name.split(".")[0].toLowerCase().replace(/[ .]+$/, "");
  if (stem === "con" || stem === "prn" || stem === "aux" || stem === "nul") return false;
  if (stem.length === 4 && (stem.startsWith("com") || stem.startsWith("lpt"))) {
    const d = stem.charCodeAt(3);
    if (d >= 49 && d <= 57) return false;
  }
  return true;
}
// --- micro-sound engine (WebAudio, no assets, muteable, persisted) ---
function soundOn() { try { return localStorage.getItem("sd-sound") !== "off"; } catch { return true; } }
function setSoundOn(on) { try { localStorage.setItem("sd-sound", on ? "on" : "off"); } catch {} }
let __ac = null, __master = null;
function ac() {
  if (!soundOn()) return null;
  try {
    __ac = __ac || new (window.AudioContext || window.webkitAudioContext)();
    if (!__master) {
      __master = __ac.createGain();
      __master.gain.value = 0.9;
      const comp = __ac.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 6;
      __master.connect(comp); comp.connect(__ac.destination);
    }
    if (__ac.state === "suspended") __ac.resume();
    return __ac;
  } catch { return null; }
}
function blip(freq = 660, dur = 0.12, type = "sine", vol = 0.2, when = 0) {
  const ctx = ac();
  if (!ctx) return;
  try {
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(__master || ctx.destination);
    o.frequency.setValueAtTime(freq, t); o.type = type;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
  } catch {}
}
// tone = fundamental + quiet octave-up shimmer for warmth (still zero assets)
function tone(freq, dur, type = "sine", vol = 0.2, when = 0) {
  blip(freq, dur, type, vol, when);
  blip(freq * 2, dur * 0.9, "sine", vol * 0.25, when);
}
function sfx(name) {
  if (!soundOn()) return;
  // NB: sound is NOT gated on prefers-reduced-motion — that preference is
  // about motion (vestibular), not audio. Mute lives solely in .soundBtn.
  try {
    if (name === "pop") tone(520, 0.12, "triangle", 0.22);
    else if (name === "copy") { tone(740, 0.1, "sine", 0.2); tone(1108, 0.14, "sine", 0.18, 0.07); }
    else if (name === "join") { tone(392, 0.14, "triangle", 0.22); tone(587, 0.16, "triangle", 0.22, 0.09); }
    else if (name === "send") tone(880, 0.09, "sine", 0.16);
    else if (name === "done") { tone(523, 0.14, "sine", 0.24); tone(659, 0.14, "sine", 0.24, 0.1); tone(784, 0.16, "sine", 0.24, 0.2); tone(1047, 0.3, "sine", 0.2, 0.3); }
    else if (name === "err") { blip(220, 0.16, "square", 0.12); blip(165, 0.28, "square", 0.12, 0.13); }
  } catch {}
}
function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}
function chat(who, text) {
  const c = document.getElementById("chat");
  if (!c) return;
  const d = document.createElement("div");
  d.className = "msg " + who;
  const t = document.createElement("span");
  t.className = "t";
  try {
    const dt = new Date();
    t.textContent = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0") + ":" + String(dt.getSeconds()).padStart(2, "0");
  } catch { t.textContent = ""; }
  d.textContent = text;
  d.appendChild(t);
  c.appendChild(d); c.scrollTop = c.scrollHeight;
  while (c.children.length > 40) c.firstChild.remove();
}
function setRadial(pct) {
  const r = document.getElementById("radial"), t = document.getElementById("radialTxt");
  if (r) r.style.setProperty("--val", Math.max(0, Math.min(100, pct)));
  if (t) t.textContent = Math.round(Math.max(0, Math.min(100, pct))) + "%";
}
function setStats(done, total, speed) {
  const s = id => document.getElementById(id);
  if (s("statSent")) s("statSent").textContent = total ? `${fmt(done)} / ${fmt(total)}` : fmt(done);
  if (s("statSpeed")) s("statSpeed").textContent = speed > 0 ? fmt(speed) + "/s" : "—";
  if (s("statEta")) s("statEta").textContent = speed > 0 && total ? Math.max(0, Math.ceil((total - done) / speed)) + "s" : "—";
  const pipe = document.getElementById("pipe");
  if (pipe) pipe.style.setProperty("--flow", speed > 8e6 ? ".5s" : speed > 2e6 ? ".9s" : "1.6s");
}
function iconFor(name) {
  const e = (name.split(".").pop() || "").toLowerCase();
  if (["mp4", "mov", "mkv", "webm"].includes(e)) return "🎬";
  if (["mp3", "wav", "flac", "ogg"].includes(e)) return "🎵";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "🖼️";
  if (["pdf"].includes(e)) return "📕";
  if (["zip", "rar", "7z", "tar", "gz"].includes(e)) return "🗜️";
  if (["doc", "docx", "txt", "md"].includes(e)) return "📝";
  if (["xls", "xlsx", "csv"].includes(e)) return "📊";
  return "📄";
}
function chime(ok = true) {
  if (!soundOn()) return;
  if (ok) sfx("done");
  else sfx("err");
}
// ── the link visual ────────────────────────────────────────────────────────
// One state machine drives the pipe on BOTH pages, so the sender and the
// receiver show the same link in the same condition. Entering a "peer is
// here" state from a "nobody is here" state fires the handshake.
let pipeState = "off";
function setPipeState(next, label) {
  const p = document.getElementById("pipe");
  if (label) setPipeLabel(label);
  // terminal status pills mirror the link state (sender page has them)
  try {
    const ps = document.getElementById("pillSignal"), pp = document.getElementById("pillPeer"), pt = document.getElementById("pillPath");
    if (ps) {
      const live = next === "linked" || next === "flowing" || next === "done";
      ps.textContent = "signal: " + (next === "off" ? "idle" : next);
      ps.className = "pill" + (live ? " live" : next === "lost" ? " bad" : next === "waiting" ? " warn" : "");
    }
    if (pp) {
      const live = next === "linked" || next === "flowing" || next === "done";
      pp.textContent = "peer: " + (live ? (next === "flowing" ? "streaming" : next === "done" ? "done ✓" : "connected ✓") : next === "waiting" ? "waiting…" : "—");
      pp.className = "pill" + (live ? " live" : "");
    }
    if (pt && label) pt.textContent = "path: " + String(label).slice(0, 42);
  } catch {}
  if (!p) { pipeState = next; return; }
  if (pipeState === next) return;
  const prev = pipeState;
  pipeState = next;
  p.hidden = next === "off";
  p.dataset.state = next;
  const wasLive = prev === "linked" || prev === "flowing" || prev === "done";
  const isLive = next === "linked" || next === "flowing" || next === "done";
  if (isLive && !wasLive) { claspNow(); sfx("join"); }
  if (next === "done") sfx("done");
  if (next === "lost") sfx("err");
}
function setPipeLabel(t) {
  const el = document.getElementById("pipeLabel");
  if (el) el.textContent = t;
}
// "hand joining": the two devices reach for the middle, clasp, and a ring
// pulses out of the join point. Reruns cleanly on reconnect.
function claspNow() {
  const p = document.getElementById("pipe");
  if (!p || RM) return;
  p.classList.remove("do-clasp");
  void p.offsetWidth;
  p.classList.add("do-clasp");
  setTimeout(() => p.classList.remove("do-clasp"), 1850);
}
// ── completion ─────────────────────────────────────────────────────────────
// Deliberately not confetti: the story of this animation IS the transfer.
// Data chips leave your device, travel the actual pipe, and pop into ticks on
// the receiver's end. Whatever the link looks like right now is the frame the
// chips are drawn against, so the payoff lands on the thing the user was
// already watching.
function deliveredShow(label) {
  const p = document.getElementById("pipe");
  if (p) { p.dataset.state = "done"; pipeState = "done"; }
  const r = document.getElementById("radial");
  if (r) { r.classList.add("full"); r.classList.remove("busy"); }
  // Perspective matters: the sender celebrates delivery *there*, the receiver
  // celebrates arrival *here*. Callers pass their side's wording.
  setPipeLabel(label || "Delivered — confirmed on their device ✓");
  chipStream();
}
function undeliverDial() {
  const r = document.getElementById("radial");
  if (r) { r.classList.remove("full"); r.classList.add("busy"); }
}
function chipStream() {
  if (RM) return;
  const cv = document.getElementById("confetti"), p = document.getElementById("pipe");
  const tr = p && p.querySelector(".track");
  if (!cv || !tr) return;
  const rect = tr.getBoundingClientRect();
  if (rect.width < 40) return;
  const ctx = cv.getContext("2d");
  cv.width = innerWidth; cv.height = innerHeight;
  const cs = getComputedStyle(document.documentElement);
  const cols = ["--p", "--s", "--a"].map(v => (cs.getPropertyValue(v) || "").trim()).filter(Boolean);
  const PER = 0.085, LIFE = 0.6, TRAIL = 26;
  const chips = Array.from({ length: 16 }, (_, i) => ({
    t: -i * PER, y: rect.top + rect.height / 2 + (Math.random() - .5) * 9,
    s: 3.5 + Math.random() * 2.5, c: cols[i % cols.length] || "#7c6cff", pop: 0,
  }));
  let last = performance.now();
  (function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, cv.width, cv.height);
    let alive = false;
    for (const c of chips) {
      c.t += dt;
      if (c.t < 0) { alive = true; continue; }
      const k = c.t / PER;
      if (k <= 1) {
        alive = true;
        const x = rect.left + k * rect.width;
        ctx.save();
        ctx.globalAlpha = .3; ctx.fillStyle = c.c;
        ctx.fillRect(x - TRAIL, c.y - c.s / 2, TRAIL, c.s);
        ctx.globalAlpha = 1; ctx.fillStyle = c.c;
        const d = c.s * 2;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x - d / 2, c.y - d / 2, d, d, c.s); ctx.fill(); }
        else ctx.fillRect(x - d / 2, c.y - d / 2, d, d);
        ctx.restore();
      } else if (c.pop < LIFE) {
        alive = true; c.pop += dt;
        const q = c.pop / LIFE, e = 1 - Math.pow(1 - q, 2);
        ctx.save();
        ctx.globalAlpha = 1 - q; ctx.strokeStyle = c.c; ctx.lineWidth = 2.4 * (1 - q) + .4;
        ctx.beginPath(); ctx.arc(rect.left + rect.width, c.y, 4 + e * 19, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    if (alive) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  })(performance.now());
}
// Two themes, named for what they are. The keys were "sweet"/"midnight"/
// "lemonade"; "midnight" is gone and the survivors are "dark"/"light", so the
// selector, the <option> label and the saved preference all agree.
const THEMES = ["dark", "light"];
const DEFAULT_THEME = "dark";
// Old key -> new key. A user who had "midnight" (a dark theme) lands on "dark",
// which is the closest survivor, rather than silently getting the theme reset.
const THEME_ALIASES = { sweet: "dark", midnight: "dark", lemonade: "light" };

function resolveTheme(stored) {
  if (THEMES.includes(stored)) return stored;
  if (stored && THEME_ALIASES[stored]) return THEME_ALIASES[stored];
  return DEFAULT_THEME;
}

function initTheme() {
  const raw = localStorage.getItem("sd-theme");
  const saved = resolveTheme(raw);
  // Rewrite the stored value once if it was a legacy key, so the migration is
  // not repeated on every load.
  if (raw !== saved) localStorage.setItem("sd-theme", saved);
  document.documentElement.dataset.theme = saved;
  // Icon button showing the CURRENT theme; click cycles dark ↔ light. The old
  // <select id="themeSel"> is gone from every page — anything still carrying
  // that id is ignored rather than rebuilt.
  const btn = document.getElementById("themeBtn");
  const glyph = t => (t === "light" ? "☀" : "☾");
  if (btn) {
    btn.textContent = glyph(saved);
    btn.onclick = () => {
      const next = THEMES[(THEMES.indexOf(resolveTheme(document.documentElement.dataset.theme)) + 1) % THEMES.length];
      document.documentElement.dataset.theme = next;
      localStorage.setItem("sd-theme", next);
      btn.textContent = glyph(next);
      toast(`Theme: ${next[0].toUpperCase() + next.slice(1)} ✦`);
      sfx("pop");
    };
  }
}
// trackTransport: rung display (Direct vs Relayed + protocol) via getStats and
// automatic recovery — restartIce once on 'failed', stuck-warning on long
// 'disconnected' (FIREWALL-TRAVERSAL.md §6 escalation, client half).
function trackTransport(pc, onRung, onEvent) {
  let restarted = false, discTimer = 0;
  const pair = async () => {
    try {
      const st = await pc.getStats();
      let sel = null;
      st.forEach(r => { if (r.type === "candidate-pair" && (r.nominated || r.selected)) sel = r; });
      if (!sel) return null;
      const rem = st.get(sel.remoteCandidateId);
      return rem ? { type: rem.candidateType, proto: rem.protocol } : null;
    } catch { return null; }
  };
  const tick = async () => {
    const p = await pair();
    if (p) onRung(`${p.type === "relay" ? "Relayed (firewall)" : "Direct"} · ${p.type}/${p.proto}`);
  };
  const iv = setInterval(tick, 2000);
  pc.addEventListener("iceconnectionstatechange", async () => {
    const stt = pc.iceConnectionState;
    if (stt === "connected" || stt === "completed") { tick(); clearTimeout(discTimer); }
    else if (stt === "failed" && !restarted) {
      restarted = true;
      onEvent("failed");
      try { await pc.restartIce(); } catch {}
    } else if (stt === "disconnected") {
      clearTimeout(discTimer);
      discTimer = setTimeout(() => {
        if (pc.iceConnectionState === "disconnected") onEvent("stuck");
      }, 8000);
    }
  });
  return { stop: () => { clearInterval(iv); clearTimeout(discTimer); } };
}

// ---------------------------------------------------------------------------
// First-visit load budget. The critical path is HTML + styles.css only:
//   · app.js is loaded with `defer` (self-boots below) so 37KB of script never
//     stands between the parser and first paint.
//   · states.css (transfer/terminal/below-fold) loads non-blocking.
//   · qrcode.js is prefetched during idle time and awaited when a room is made.
//   · /healthz probe + service worker wait for idle so they never compete.
// ---------------------------------------------------------------------------
let __qr = null;
function qrReady() {
  if (__qr) return __qr;
  __qr = new Promise((res, rej) => {
    if (typeof qrcode === "function") return res(qrcode);
    const s = document.createElement("script");
    s.src = "/qrcode.js";
    s.onload = () => (typeof qrcode === "function" ? res(qrcode) : rej(new Error("qrcode missing")));
    s.onerror = () => rej(new Error("qrcode failed to load"));
    document.head.appendChild(s);
  });
  return __qr;
}
function onIdle(fn, timeout = 2000) {
  // requestIdleCallback where available, else a macrotask. `timeout` guarantees
  // the callback still runs on a busy main thread.
  try {
    if (typeof requestIdleCallback === "function") return requestIdleCallback(fn, { timeout });
  } catch {}
  return setTimeout(fn, 1);
}

// Incremental SHA-256 (standard algorithm, no dependency): the transfer's
// end-to-end integrity check. SubtleCrypto is deliberately NOT used — it needs
// a secure context, and LAN shares over plain http://192.168.x.y don't have one.
function sha256New() {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  let lo = 0, hi = 0, pend = new Uint8Array(0);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function block(v, o) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) w[i] = (v[o++] << 24) | (v[o++] << 16) | (v[o++] << 8) | v[o++];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  function feed(v) {
    const joined = new Uint8Array(pend.length + v.length);
    joined.set(pend, 0); joined.set(v, pend.length);
    const n = joined.length - (joined.length % 64);
    for (let o = 0; o < n; o += 64) block(joined, o);
    pend = joined.slice(n);
  }
  return {
    update(data) {
      const v = data instanceof Uint8Array ? data : new Uint8Array(data);
      const add = v.length * 8, nl = (lo + add) >>> 0;
      if (nl < lo) hi = (hi + 1) >>> 0;
      lo = nl; hi = (hi + Math.floor(add / 4294967296)) >>> 0;
      if (v.length) feed(v);
    },
    hex() {
      const ml = pend.length;
      const pad = new Uint8Array((((ml + 9 + 63) >> 6) << 6) - ml);
      pad[0] = 0x80;
      const dv = new DataView(pad.buffer);
      dv.setUint32(pad.length - 8, hi); dv.setUint32(pad.length - 4, lo);
      feed(pad);
      return [...H].map(x => (x >>> 0).toString(16).padStart(8, "0")).join("");
    },
  };
}

// The wire can only carry what the PEER negotiated: pc.sctp.maxMessageSize is
// the remote's ceiling (Safari ≈ 64KB, Chrome ≈ 256KB). Slicing bigger than
// that makes send() throw mid-file on cross-browser links, so clamp to it.
// Same speed band per BENCHMARKS.md — the clamp is pure insurance.
function chunkCap(pc) {
  try {
    const m = pc && pc.sctp && pc.sctp.maxMessageSize;
    if (Number.isFinite(m) && m >= 1024) return Math.max(1024, Math.min(CHUNK, Math.floor(m)));
  } catch {}
  return CHUNK;
}

// Flow control gate. `bufferedamountlow` is NOT reliable enough to trust alone:
// it only fires when bufferedAmount drops below bufferedAmountLowThreshold, and
// on a backed-up or wedged channel it simply never fires. The old version waited
// on that event with no poll and no timeout, so one slow receiver froze the
// transfer forever at HIGH_WATER (observed: 16.5MB of 225MB, then dead).
// Now we listen AND poll, and we always give up waiting after `cap` ms — a
// slightly-too-full channel is far better than a permanently wedged send loop.
function waitDrain(dc, cap = 20000) {
  return new Promise(res => {
    if (dc.bufferedAmount <= LOW_WATER) return res();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dc.removeEventListener("bufferedamountlow", onLow);
      clearInterval(poll);
      clearTimeout(capT);
      res();
    };
    const onLow = () => { if (dc.bufferedAmount <= LOW_WATER) finish(); };
    dc.addEventListener("bufferedamountlow", onLow);
    const poll = setInterval(onLow, 40);
    const capT = setTimeout(finish, cap);
  });
}

// ---------- SENDER ----------
async function initSender() {
  const drop = document.getElementById("drop");
  if (!drop) return;
  window.addEventListener("error", e => chat("sys", "❌ Error: " + (e.message || "unknown") + " — screenshot this if it repeats."));
  initCodeEntry();
  // The sender's signaling-socket liveness. `sigLive` goes false the moment the
  // socket closes (which a backgrounded mobile tab does immediately) and true
  // again on reconnect. The sender's own UI must never claim to be waiting for
  // a receiver while the server has already marked it gone — that mismatch is
  // what made this bug look unfixable from the receiver's side.
  let sigLive = false, sigRetryT = 0;
  // Reconnect backoff for the sender, reset only when a socket actually opens.
  // Declared here rather than inside start(): the close handler that increments
  // it is reachable from the first socket too, so a later `let` would be a TDZ
  // landmine on an early close.
  let sigTries = 0, saidPaused = false, saidRejoining = false, sigEverLive = false;
  const SIG_RETRY_MIN = 500, SIG_RETRY_MAX = 4000, SIG_RETRY_MAX_N = 24;
  const logSender = t => { const el = document.getElementById("status"); if (el) el.textContent = t; };
  const picker = document.getElementById("picker");
  const fileList = document.getElementById("fileList");
  const addBtn = document.getElementById("addBtn");
  const restartBtn = document.getElementById("restartBtn");
  const totalHint = document.getElementById("totalHint");
  const pickerRow = document.getElementById("pickerRow");
  let files = [];
  let roomId = null, sig = null, started = false;
  let rungText = ""; // set by trackTransport; read by sendFile (function scope!)

  // Stable per-file ids. The DataChannel addresses files by id, not array index,
  // so removing a file mid-session can't make a receiver's request resolve to a
  // different file (indices shift the moment anything is spliced out).
  let fidSeq = 0;
  const fidOf = f => f.fid || (f.fid = "f" + (++fidSeq) + "-" + Math.random().toString(36).slice(2, 7));
  const manifest = () => files.map(f => ({ id: fidOf(f), name: f.name, size: f.size, mime: f.type || "application/octet-stream" }));
  // Per-file badge: what the sender knows for certain about each file.
  // queued → sending → sent (no confirmation) → received ✓
  const badgeFor = f => f._got ? `<span class="fstate" data-s="got">✓ received</span>`
    : f._aborted ? `<span class="fstate" data-s="stale">stopped</span>`
    : f._sending ? `<span class="fstate" data-s="sending">sending</span>`
    : f._sent ? `<span class="fstate" data-s="await">sent · unconfirmed</span>` : "";
  const render = () => {
    fileList.innerHTML = files.map(f =>
      `<div class="frow"><div class="ficon">${iconFor(f.name)}</div><div class="fmeta"><div class="fname" translate="no">${esc(f.name)}</div><div class="fsize">${fmt(f.size)}</div></div>${badgeFor(f)}<button class="frm" data-fid="${fidOf(f)}" aria-label="remove ${esc(f.name)}">✕</button></div>`).join("");
    fileList.querySelectorAll(".frm").forEach(b => b.onclick = e => { e.stopPropagation(); removeFile(b.dataset.fid); });
    const total = files.reduce((a, f) => a + f.size, 0);
    if (totalHint) totalHint.textContent = files.length ? `${files.length} file${files.length > 1 ? "s" : ""} · ${fmt(total)}` : "";
    // The row holds only "+ Add more" and the size summary, so it earns its space
    // only once there is a list worth adding to.
    if (pickerRow) pickerRow.hidden = !files.length;
    // The first file starts the share automatically, so the only reason a
    // "start" control ever appears is after a deliberate Stop.
    if (restartBtn) restartBtn.hidden = started || !files.length;
    // No "Create private link" button exists: the first file starts the share, so
    // the zone collapses to a slim "add another" strip for the rest of the session.
    if (drop) drop.classList.toggle("compact", files.length > 0);
  };
  // The Received panel: the strongest, most permanent statement on the page.
  // It only ever says "received" for files the receiver explicitly confirmed, so
  // it can never overstate what actually happened.
  const recvPanel = document.getElementById("recvPanel");
  const recvList = document.getElementById("recvList");
  const recvCount = document.getElementById("recvCount");
  function paintRecv() {
    if (!recvList) return;
    const got = files.filter(f => f._got || f._sent);
    const n = files.filter(f => f._got).length;
    if (recvCount) recvCount.textContent = `${n} / ${files.length}`;
    if (recvPanel) recvPanel.classList.toggle("live", n > 0);
    // The panel only exists once a receiver has actually saved something.
    if (recvPanel) recvPanel.hidden = !(n > 0);
    if (!got.length) {
      recvList.innerHTML = `<div class="recv-empty">Nothing confirmed yet. A file ticks here the moment the receiver saves it.</div>`;
      return;
    }
    recvList.innerHTML = got.map(f =>
      `<div class="recv-item${f._got ? "" : " stale"}"><span class="tick">${f._got ? "✓" : "?"}</span>` +
      `<span class="rn" translate="no">${esc(f.name)}</span><span class="rs">${f._got ? fmt(f.size) : "sent · no confirmation"}</span></div>`).join("");
  }
  // Re-badge one row in place so the Received state never replays the row
  // entry animation (render() would).
  function paintBadge(f) {
    const row = fileList.querySelector(`.frm[data-fid="${cssEscape(fidOf(f))}"]`);
    if (!row) return;
    const old = row.parentElement.querySelector(".fstate");
    const html = badgeFor(f);
    if (html) {
      if (old) old.outerHTML = html;
      else row.insertAdjacentHTML("beforebegin", html);
    } else if (old) old.remove();
  }
  function noteReceived(f) {
    f._got = true;
    paintBadge(f);
    paintRecv();
    // A received file is the only honest definition of "delivered".
    const outstanding = files.filter(x => x._sending || (x._sent && !x._got));
    if (!outstanding.length && links.size) {
      setStep(3);
      deliveredShow();
      toast("Everything they asked for is on their device ✓");
      chat("sys", "All done — the receiver confirmed every file.");
    }
  }
  // Remove a file and tell everyone. Live receivers drop it from their list
  // immediately; a send already in flight for it is aborted.
  function removeFile(fid) {
    const i = files.findIndex(f => fidOf(f) === fid);
    if (i < 0) return;
    const [gone] = files.splice(i, 1);
    if (gone._sending) { gone._aborted = true; chat("sys", `Stopped sending ${gone.name} — you removed it.`); }
    render();
    if (started) {
      syncFiles();
      chat("sys", `Removed ${gone.name} — receivers can no longer see or fetch it.`);
    }
  }
  // Push the current manifest to the room. The server validates that we are the
  // sender, stores it (so late-joining receivers get it too) and rebroadcasts.
  function syncFiles() {
    if (!sig || !roomId) return;
    sig.send({ from: "sender", to: "receivers", kind: "files", payload: JSON.stringify({ files: manifest() }) });
  }
  const add = list => {
    const picked = [...list].filter(Boolean);
    if (!picked.length) { toast("That drop had no files in it"); return; }
    const room = picked.slice(0, Math.max(0, 20 - files.length));
    if (!room.length) { toast("Max 20 files per room"); return; }
    files.push(...room); room.forEach(fidOf);
    render();
    // The first file IS the start of the share — there is no button to press.
    // Every later file just publishes into the room that already exists.
    if (started) {
      syncFiles();
      chat("sys", `Added ${room.length} file${room.length > 1 ? "s" : ""} — receivers see it now.`);
    } else {
      chat("sys", `Added ${room.length} file${room.length > 1 ? "s" : ""} (${fmt(room.reduce((a, f) => a + f.size, 0))}) — creating your private link…`);
      start();
    }
  };
  drop.onclick = () => picker.click();
  drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } };
  // ── drag & drop ──────────────────────────────────────────────────────────
  // Three Linux/Chrome traps, each of which made "drop files here" silently do
  // nothing on Ubuntu:
  //  1. preventDefault() is required on BOTH dragover and drop, or the browser
  //     refuses the drop and navigates to the file.
  //  2. Nautilus delivers the payload as `items`; reading only
  //     `dataTransfer.files` yields an EMPTY FileList for those drags, which is
  //     indistinguishable from a no-op.
  //  3. dragleave also fires when the cursor crosses a child element, so the
  //     highlight flickers and a slow drag can land with no "over" styling.
  let dragDepth = 0;
  const hasFiles = dt => [...(dt?.types || [])].some(t => t === "Files" || t === "application/x-moz-file");
  // items[] is only readable DURING the event — files[] would be empty by the
  // time an await resolved — so the File objects are pulled out synchronously.
  const filesFrom = dt => {
    const out = [];
    if (!dt) return out;
    if (dt.items && dt.items.length) {
      for (const it of dt.items) {
        if (it.kind !== "file") continue;
        const f = it.getAsFile && it.getAsFile();
        if (f) out.push(f);
      }
    }
    if (out.length) return out;
    return [...(dt.files || [])];
  };
  const showDrag = on => drop.classList.toggle("over", on);
  drop.addEventListener("dragenter", e => { e.preventDefault(); if (!hasFiles(e.dataTransfer)) return; dragDepth++; showDrag(true); });
  drop.addEventListener("dragover", e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; // marks this a valid target
    if (hasFiles(e.dataTransfer)) showDrag(true);
  });
  drop.addEventListener("dragleave", e => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrag(false); });
  drop.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0; showDrag(false);
    add(filesFrom(e.dataTransfer));
  });
  // A drop that misses the zone must not navigate away and lose everything. The
  // zone shrinks once files exist, so accept files anywhere on the page.
  document.addEventListener("dragover", e => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  document.addEventListener("drop", e => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (drop.contains(e.target)) return; // already handled by the zone
    const got = filesFrom(e.dataTransfer);
    if (got.length) add(got);
  });
  document.addEventListener("paste", e => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length && !started) { add(fs); toast("Pasted from clipboard 📋"); }
  });
  picker.onchange = () => { add(picker.files); picker.value = ""; };
  if (addBtn) addBtn.onclick = () => picker.click();
  if (restartBtn) restartBtn.onclick = () => start();
  // QR + nearby code share one merged handoff panel (no tabs).
  render();

  // Full local reset: back to file-picking state, no refresh needed.
  // File list is kept so the user can delete/replace entries and re-share.
  function resetShare(msg) {
    started = false;
    shareAlive = false;
    if (sendWd) { clearInterval(sendWd); sendWd = null; }
    if (sig) { try { sig.close(); } catch {} sig = null; }
    for (const id of [...links.keys()]) dropLink(id, "");
    outQ = [];
    roomId = null;
    // A stopped share is not an outage, so the next one must not inherit the old
    // share's comeback state — otherwise its first presence announces "Back
    // online ✓ — the link works again" for a share that never went anywhere.
    clearTimeout(sigRetryT); sigRetryT = 0;
    sigTries = 0; saidPaused = false; saidRejoining = false; sigEverLive = false; sigLive = false;
    for (const f of files) { f._sent = false; f._sentT = 0; f._got = false; f._sending = false; f._aborted = false; }
    document.getElementById("room").hidden = true;
    document.getElementById("liveCard").hidden = true;
    document.getElementById("handoffCard").hidden = true;
    document.getElementById("termCard").hidden = true;
    document.body.classList.remove("sharing");
    const bar = document.getElementById("bar");
    bar.hidden = true; bar.value = 0;
    setRadial(0); setStats(0, 0, 0);
    setPipeState("off");
    undeliverDial();
    document.getElementById("stats").textContent = "";
    document.getElementById("status").textContent = "";
    const badge = document.getElementById("liveBadge");
    if (badge) badge.innerHTML = `<span class="dot" style="background:var(--mut);animation:none"></span> idle — no room yet`;
    setStep(0);
    render();
    paintRecv();
    toast("Sharing stopped.");
    chat("sys", msg || "Stopped.");
  }

  function setStep(n) {
    ["st1", "st2", "st3"].forEach((id, i) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle("on", i === n - 1);
      el.classList.toggle("done", i < n - 1);
    });
    const b = document.getElementById("liveBadge");
    if (b) b.innerHTML = n === 1 ? `<span class="dot pulse"></span> live — waiting for receiver`
      : n === 2 ? `<span class="dot pulse"></span> connected — sending…` : `<span class="dot"></span> done ✓`;
  }

  async function start() {
    if (!files.length || started) return;
    started = true; shareAlive = true; render();
    const meta = manifest();
    let room;
    try { room = await postJSON("/api/rooms", { files: meta, nearby: true }); }
    catch { toast("Could not create link — server unreachable"); started = false; render(); return; }
    roomId = room.id;
    // Share links point at the UI host, never at the API: the server's own URL
    // is built from PUBLIC_BASE_URL, which on a split deployment is a host that
    // serves no UI. The path is the server's to choose; the origin is not.
    const url = roomShareUrl(room.url);
    document.getElementById("room").hidden = false;
    document.getElementById("shareUrl").value = url;
    document.getElementById("nearbyCode").textContent = room.nearby || "—";
    const qrBox = document.getElementById("qr");
    // The QR encoder is ~12KB gzipped and only needed once a room exists, so it
    // is NOT on the first-visit path: it is prefetched on idle and awaited here
    // (worst case the idle prefetch never ran and this fetch costs one RTT).
    try {
      await qrReady();
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0 });
    } catch { qrBox.innerHTML = `<span class="hint">QR failed — use the link.</span>`; }
    qrBox.style.display = "block";
    const bar = document.getElementById("bar"); bar.hidden = false; bar.value = 0;
    setRadial(0); setStats(0, files.reduce((a, f) => a + f.size, 0), 0);
    document.getElementById("liveCard").hidden = false;
    document.getElementById("handoffCard").hidden = false;
    document.getElementById("termCard").hidden = false;
    document.body.classList.add("sharing");
    setPipeState("waiting", "Looking for a receiver…");
    paintRecv();
    document.getElementById("copy").onclick = async () => {
      await navigator.clipboard.writeText(url).catch(() => {});
      const box = document.querySelector(".linkbox");
      if (box) { box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); }
      toast("Link copied ✓");
      chat("me", "Link copied — send it to your receiver.");
    };
    document.getElementById("nativeShare").onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: "p2p file sharing", text: "Download my files", url }); } catch {} }
      else { await navigator.clipboard.writeText(url).catch(() => {}); toast("Link copied ✓"); }
    };
    document.getElementById("stopBtn").onclick = async () => {
      if (roomId) { try { await fetch(apiUrl(`/api/rooms/${roomId}`), { method: "DELETE" }); } catch {} }
      resetShare("Sharing stopped — link is dead. Edit the list and share again, no refresh needed.");
    };
    chat("me", `Room live 🎉 ${files.length} file${files.length > 1 ? "s" : ""} — share the link or nearby code ${room.nearby || ""}.`);
    chat("sys", "Waiting for receiver… keep this tab open.");
    // The 2×2 dashboard fits the viewport on desktop — only scroll on narrow screens.
    if (matchMedia("(max-width: 900px)").matches) {
      document.getElementById("handoffCard").scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "nearest" });
    }

    // (peer connections + data channels are built by ensureLink(), below, one per
    // receiver, so each can be torn down and rebuilt without touching the others)
    // Named, not an inline arrow: a reopened socket needs the SAME handler, and
    // duplicating ~60 lines of frame routing for the reconnect path is how the
    // two copies would drift.
    const sigMsg = async m => {
      const peer = m.from;
      if (m.kind === "answer" || m.kind === "offer" || m.kind === "ice") {
        if (!peer) return;
        // A receiver that reloaded is a brand-new peer id that has no link yet;
        // build one on demand rather than dropping the only offer we'll get.
        const l = await ensureLink(peer);
        if (!l) return;
        if (m.kind === "answer") {
          // Guard the state machine the way the offer branch below does. The
          // receiver also offers (onnegotiationneeded fires once the sender's
          // transceiver arrives), so glare is routine here, not theoretical: an
          // answer landing in have-remote-offer throws, and the early return
          // skipped l.linked — leaving a fully working link reported as not
          // connected, and printing raw WebRTC text to the user.
          if (l.pc.signalingState === "have-remote-offer") {
            try { await l.pc.setLocalDescription({ type: "rollback" }); } catch {}
          }
          try { await l.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(m.payload))); }
          catch (err) { chat("sys", "Answer could not be applied — renegotiating."); restartLink(peer); return; }
          if (!l.linked) {
            l.linked = true;
            setStep(2); toast("Receiver connected"); chat("peer", "Receiver joined 👋 — they pick files, you stream on demand.");
          } else chat("sys", "Connection re-established ✓");
        } else if (m.kind === "offer") {
          // Polite side: always answer (rollback a local offer first on glare).
          try {
            if (l.pc.signalingState !== "stable") { try { await l.pc.setLocalDescription({ type: "rollback" }); } catch {} }
            await l.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(m.payload)));
            const answer = await l.pc.createAnswer();
            await l.pc.setLocalDescription(answer);
            tx({ from: "sender", to: peer, kind: "answer", payload: JSON.stringify(answer) });
            if (l.linked) chat("sys", "Connection re-established ✓");
          } catch (err) { chat("sys", "Offer rejected: " + (err.message || err)); }
        } else if (m.kind === "ice") {
          try { await l.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(m.payload))); } catch {}
        }
      } else if (m.kind === "presence") {
        try {
          const p = JSON.parse(m.payload);
          // The server broadcasts presence to every peer right after a successful
          // Join, so this frame — not the browser's own socket state — is the proof
          // that we are back in the room.
          //
          // It has to be. The server upgrades the WebSocket BEFORE it runs Join, so
          // the browser's `onopen` fires even for a connection that is about to be
          // refused with 4400. Announcing success on socket open claimed "Back
          // online ✓" for the first reconnect attempt on a phone, which is exactly
          // the attempt the server refuses. A sender would be told the link worked
          // while it did not.
          if (!sigLive) {
            // `returning` distinguishes "we came back" from "this share just
            // started". Both arrive as the first presence after a Join, and
            // sigLive is false for both; announcing "Back online ✓ — the link
            // works again" on a brand new share would be nonsense.
            const returning = sigEverLive;
            sigLive = true;
            sigEverLive = true;
            sigTries = 0;
            saidPaused = false;
            saidRejoining = false;
            if (returning) {
              logSender("Back online — the link works again.");
              chat("sys", "Back online ✓ — the link works again.");
            }
          }
          const rx = (p.peers || []).filter(x => x !== "sender");
          if (rx.length) {
            // The first receiver of the session gets "joining" language; any
            // later one is a reconnection (a refresh makes the browser a brand
            // new peer id), and the user should be able to see that the sender
            // noticed and rebuilt rather than silently serving a dead link.
            if (!links.size && !linksEver) chat("sys", "Receiver in room — establishing encrypted link…");
            else if (!links.size) chat("sys", "Rebuilding the link — a receiver reconnected. 🔁");
            // Give every receiver its own peer connection. Waiting for an offer
            // instead would be fine too, but offering eagerly means a receiver that
            // reloaded gets picked up on the presence frame rather than only when
            // it happens to speak first.
            for (const id of rx) if (!links.has(id) || links.get(id).dead) ensureLink(id);
          }
          // Presence is the only instant signal that a receiver's tab closed
          // (the data channel would linger for 30s+ waiting on an SCTP timeout).
          for (const id of [...links.keys()]) if (!rx.includes(id)) dropLink(id, "they left the room");
        } catch {}
      } else if (m.kind === "bye") {
        toast("Room closed by server.");
      }
    };
    sig = openSignal(roomId, "sender", "sender", sigMsg, onSigState);
    for (const f of outQ.splice(0)) sig.send(f);
    window.addEventListener("beforeunload", () => { if (!roomId) return; try { navigator.sendBeacon(apiUrl(`/api/rooms/${roomId}`), new Blob([], { type: "text/plain" })); } catch {} });

    // ── Mobile: the sender's socket dies the moment the tab is backgrounded ──
    //
    // Sharing from a phone means switching to WhatsApp, which backgrounds the
    // browser — and mobile browsers (iOS Safari, Chrome Android, and every in-app
    // WebView) FREEZE a backgrounded tab's JS, tearing down its WebSocket. The
    // server then clears its sender slot and every receiver is told
    // `senderOnline: false`, even though the room and its file list stay readable
    // (SIGNAL_GRACE keeps the room for hours), so receivers saw the files and
    // were then told the sender was gone on every click.
    //
    // Recovery is: notice the drop, say so, and reconnect. Reconnecting re-runs
    // Join, which restores the sender slot and makes the server broadcast
    // senderOnline:true to everyone waiting.
    //
    // The retry is NOT optional and this is where the first attempt at this fix
    // failed. The server cannot tell the socket is gone until a write to it
    // fails — up to SIGNAL_PING, since a frozen tab sends nothing and the reader
    // sits on its deadline. So the first reconnect arrives while the server still
    // holds the old entry and is refused as a duplicate (close 4400). Verified
    // live: the reconnect closed with 4400 "duplicate_sender" and the mobile fix
    // was silently inert. The server now displaces a peer it has PROVEN dead, and
    // this side must keep retrying until that proof lands — one attempt is not
    // enough, and giving up silently is what made this look unfixable.
    const reopenSignal = () => {
      // One attempt at a time, and "attempt" includes CONNECTING. Guarding only
      // on isOpen() (readyState 1) let a foreground event — onVisible fires on
      // every tap, focus and pageshow, exactly what a user staring at their phone
      // generates — open a second socket while the first was still connecting.
      // Two sockets then raced: one joined and the other was refused, the stale
      // refusal nulled the live handle below, and the orphaned live socket kept
      // squatting the sender slot server-side (browsers auto-answer WS pings),
      // so every later retry was refused 4400 forever while receivers saw
      // senderOnline:true. The receiver already guards this way
      // (`rSig && !rSig.isClosed()`); the sender did not.
      if (!roomId || !started || (sig && !sig.isClosed())) return;
      if (sigTries >= SIG_RETRY_MAX_N) {
        // Give up on THIS burst, not on the share. The budget used to be a one-way
        // trip: sigTries only ever resets when presence arrives, so once it hit
        // the cap every later return to the tab re-printed "Couldn't rejoin",
        // opened no sockets, and left the sender permanently bricked on a link
        // its receivers could still see. A sender who switches to WhatsApp twice
        // never recovers without restarting the share by hand.
        //
        // So: stop hammering, say so, and start again when the tab comes back.
        // onVisible clears the budget, and that is the only thing that should.
        sigTries = 0;
        saidPaused = false; saidRejoining = false;
        logSender("Link lost — still listening; it reconnects when you come back to this tab.");
        chat("sys", "Still trying to get back to the room — nothing was shared away, and it reconnects by itself the moment you return to this tab.");
        setPipeState("waiting", "Waiting to rejoin — come back to this tab to retry");
        return;
      }
      // No success callback here on purpose: the socket opening proves nothing,
      // because the server upgrades before it runs Join and then refuses the
      // connection. sigMsg's presence handler is where a rejoin is confirmed.
      // No identity check on the close is needed: the guard above means a newer
      // socket can only exist after this one closed, and a browser delivers each
      // socket's close exactly once — so a close always belongs to the current
      // handle. (An earlier revision had the check; it was removed because no test
      // could reach it without replaying a duplicate close browsers never send.)
      sig = openSignal(roomId, "sender", "sender", sigMsg, onSigState);
      for (const f of outQ.splice(0)) sig.send(f);
    };
    // A closed socket is not reusable, so this is what makes recovery possible at
    // all: without a state callback the close was completely silent and the page
    // kept saying "waiting for receiver" while the server had marked it gone.
    function onSigState(state, e) {
      if (state !== "closed") return;
      onSigDown(e);
    }
    function onSigDown(e) {
      if (!roomId || !started) return;
      sigLive = false;
      sig = null;              // a closed handle is not reusable
      const dup = e && e.code === 4400;
      // A dead signaling socket means this tab was frozen, so every WebRTC session
      // it was carrying died too: the DTLS/SCTP keepalives stopped with the tab's
      // timers and the association timed out while the tab was away.
      //
      // They must be dropped, because nothing else will. `ensureLink` returns any
      // link that is not flagged dead, and a frozen association is never flagged —
      // it still reports connected/open on both ends. So the sender kept handing
      // back the dead peer connection and answered the receiver's fresh offer on
      // it, which is why a receiver that had waited through the outage was told
      // "the sender never started sending". Presence after the reconnect rebuilds
      // every link, because it offers whenever `links` has no entry for a peer.
      if (links.size) {
        const n = links.size;
        for (const id of [...links.keys()]) dropLink(id, "");
        chat("sys", `Dropped ${n} encrypted link${n > 1 ? "s" : ""} — this tab was frozen and they died with it. Rebuilding when I come back.`);
      }
      // Two different facts, so two one-shot messages rather than one guard on
      // the attempt count. 1006 means the tab's socket died (the background
      // story). 4400 means the server still holds our own entry and is waiting
      // for its own write to fail — new information the sender would otherwise
      // sit on in silence for several seconds. Each fires at most once per
      // outage and both are cleared on a successful open.
      if (dup) {
        if (!saidRejoining) {
          saidRejoining = true;
          setPipeState("waiting", "Rejoining the link…");
          logSender("Rejoining the link…");
          chat("sys", "Rejoining the link — the server is still finishing up the old connection. A few seconds on a phone.");
        }
      } else if (!saidPaused) {
        saidPaused = true;
        setPipeState("waiting", "Paused while this tab is in the background…");
        logSender("Link paused — your phone froze this tab. It resumes when you come back.");
        chat("sys", "Paused while in the background. Come back to this tab and the link resumes automatically — no need to re-share.");
      }
      // A backgrounded tab cannot run a timer, so the retry is scheduled only
      // when visible; onVisible covers the other case. Backoff because the server
      // needs up to one ping interval to notice, and a tight loop would just be
      // ~20 refused upgrades.
      if (typeof document === "undefined" || !document.hidden) {
        const wait = Math.min(SIG_RETRY_MIN * Math.pow(1.6, sigTries), SIG_RETRY_MAX);
        sigRetryT = setTimeout(() => { sigRetryT = 0; reopenSignal(); }, wait);
      }
      sigTries++;
    }
    const onVisible = () => {
      if (document.hidden || !roomId || !started) return;
      clearTimeout(sigRetryT); sigRetryT = 0;
      // No sigTries reset here on purpose: the give-up branch in reopenSignal
      // already clears it, and that is the only place that should. Two owners of
      // one reset is how the budget ended up meaning nothing — a return to the tab
      // looked like it refilled the budget while the give-up silently did it.
      reopenSignal();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);   // iOS restores from bfcache here
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);    // network came back
  }

  // On-demand serving (DataChannel file protocol v2): the receiver picks files
  // ({t:want,fid} / {t:wantAll}); requests queue FIFO per receiver and stream one
  // file at a time. Progress/diagnostics are aggregate (the sender's own UI shows
  // one transfer), but every transport is per receiver peer.
  let sendWd = null;
  let sentDone = 0, sentTotal = 0, sentT0 = Date.now();
  // Force the final progress paint of a completed transfer. ONE owner: the
  // drained-queue block in pumpQueue.
  //
  // Progress writes are coalesced into one rAF frame, and that callback
  // early-returns once the file stops sending — so the LAST frame is always
  // dropped. Both terminal paths therefore have to paint synchronously.
  //
  // The bar and the radial were forced here before; the byte counters were not,
  // which is why a completely sent 1.5 MB file displayed "1.3 MB of 1.5 MB": at
  // the default 256 KB chunk that file is 6 chunks, and the display froze on
  // chunk 5. One helper, called from both sites, so they cannot drift apart a
  // third time — the bar fix was made in two places and the counters were
  // forgotten in both.
  //
  // It paints the TRUE cumulative totals rather than assuming 100. Forcing the bar
  // to 100 when one file of several finishes is wrong — the bar is cumulative
  // (sentDone of sentTotal), so a two-file send used to jump 100% → 50% → 100%.
  // Only the drained-queue path may claim 100, because only then is it true.
  const forceFinalPaint = () => {
    if (!(sentDone > 0 && sentTotal > 0)) return;
    const dt = Math.max(1, (Date.now() - sentT0) / 1000);
    setStats(sentDone, sentTotal, sentDone / dt);
    const st = document.getElementById("stats");
    if (st) st.textContent = rungText + `${fmt(sentDone)} of ${fmt(sentTotal)}`;
  };
  // Cleared by resetShare; distinguishes "queue drained" from "we stopped", so a
  // Stop press can never be reported to the user as a successful send.
  let shareAlive = true;
  const byFid = fid => files.find(f => fidOf(f) === fid);

  // One peer connection PER RECEIVER. A single PC cannot serve two receivers:
  // both answer the same offer, and the second setRemoteDescription arrives in
  // the wrong signaling state ("Called in wrong state: stable"), so the second
  // tab silently never gets files. Per-peer links also mean one receiver
  // reloading no longer disturbs anyone else's transfer.
  const links = new Map(); // peerId -> link
  // True once any receiver has been linked this session, so the presence handler
  // can tell a first joiner from a reconnection (see linksEver use above).
  let linksEver = false;
  let outQ = [];
  // Outbound frames queue until signaling is open, so a build that races the
  // socket never drops the offer the whole link depends on.
  const tx = f => { if (sig) sig.send(f); else if (outQ.length < 64) outQ.push(f); };

  function stopServing(peer, reason) {
    const l = links.get(peer);
    if (!l) return;
    if (!l.serving && !l.queue.length) return;
    l.queue = []; l.serving = false;
    // This peer's files only — see dropLink for why it is per-peer.
    files.forEach(f => { if (f._peer === peer) f._sending = false; });
    chat("sys", `Stopped sending — ${reason}`);
    toast("Stopped sending");
  }

  function dropLink(peer, reason) {
    const l = links.get(peer);
    if (!l) return;
    links.delete(peer);
    l.queue = []; l.serving = false;
    // Release the stats poller this link owns. Leaking it left a 2Hz
    // getStats() loop running against a closed peer connection for the life of
    // the page — one per rebuild, unbounded.
    if (l.stopT) { try { l.stopT(); } catch {} l.stopT = null; }
    // Per-peer state only. Clearing every file's _sending flag across all links
    // froze the progress paint of whichever OTHER receiver was mid-transfer
    // (txUi guards on _sending), so one peer leaving jumped a live bar to 100%.
    for (const [oid, ok] of links) {
      if (!ok.serving) files.forEach(f => { if (f._peer === oid) { f._sending = false; paintBadge(f); } });
    }
    files.forEach(f => { if (f._peer === peer) { f._sending = false; paintBadge(f); } });
    try { l.pc && l.pc.close(); } catch {}
    if (reason) chat("sys", `Dropped the link to ${peer} — ${reason}.`);
    if (!links.size && started) setPipeState("waiting", "Looking for a receiver…");
  }

  async function ensureLink(peer) {
    if (!roomId || !started) return null;
    const have = links.get(peer);
    if (have && !have.dead) {
      // A build may still be in flight. The link is published into `links` BEFORE
      // it has a peer connection, because a build that gets superseded has to be
      // able to see that it was — so `have` can be a link whose pc is still null.
      // Returning it as-is handed the offer handler a null pc, its rollback guard
      // threw, and the catch only chatted: the receiver's offer was dropped, its
      // data channel never opened, and it sat at "waiting for sender" until its
      // own watchdog fired. That is the reported "asked again but nothing came"
      // failure, seen from the other side. Await the build instead.
      if (have.building) { try { await have.building; } catch {} }
      const done = links.get(peer);
      return done && !done.dead ? done : null;
    }
    // `built` must start at 0, not undefined: rebuildLink throttles on
    // `now - l.built < 3000` and NaN < 3000 is false, which would let the first
    // rebuild skip the throttle entirely.
    // stopT is the handle trackTransport returns. Every rebuild used to leak the
    // previous 2s getStats() interval, which then polled a peer connection that
    // had already been closed, for the life of the page.
    const link = { peer, gen: 0, pc: null, dc: null, linked: false, queue: [], serving: false, lastAdvance: Date.now(), lastRestart: 0, built: 0, dead: false, stopT: null, building: null };
    links.set(peer, link);
    linksEver = true;
    // The build is the rest of this function. Callers that arrive while it runs
    // await `link.building` above, so exactly one peer connection is created.
    link.building = (async () => {
    let ice;
    try { ice = await fetchIce(roomId); }
    catch (err) { chat("sys", "Could not reach the server for TURN credentials: " + (err.message || err)); links.delete(peer); return null; }
    if (links.get(peer) !== link || !started) { links.delete(peer); return null; } // superseded
    const gen = ++link.gen;
    const p = new RTCPeerConnection({ iceServers: ice });
    link.pc = p;
    const d = p.createDataChannel("files", { ordered: true });
    d.bufferedAmountLowThreshold = LOW_WATER;
    link.dc = d;
    armServing(peer, link);
    d.onerror = () => {
      // Only worth reporting while we are actually pushing bytes at someone.
      if (shareAlive && [...links.values()].some(k => !k.dead && (k.serving || k.queue.length))) {
        chat("sys", "⚠️ Data channel error — the link may still recover; watch progress.");
      }
    };
    link.stopT = trackTransport(p,
      t => { rungText = t + " — "; },
      ev => {
        // Only advise "keep this tab open" while we are actually pushing bytes.
        // After a Stop press or a peer that left, the advice is pure noise.
        const busy = shareAlive && [...links.values()].some(k => !k.dead && (k.serving || k.queue.length));
        if (ev === "failed" && busy) { chat("sys", "Direct path failed — restarting with relay candidates…"); toast("Retrying via relay…"); }
        else if (ev === "stuck" && busy) chat("sys", "Link stuck — keep this tab open; receiver may be on a strict network.");
      });
    // Offers/ICE are addressed to this peer only. Broadcasting them was what made
    // two receivers collide on one offer in the first place.
    p.onicecandidate = e => {
      if (e.candidate) tx({ from: "sender", to: peer, kind: "ice", payload: JSON.stringify(e.candidate) });
    };
    let makingOffer = false;
    p.onnegotiationneeded = async () => {
      if (link.gen !== gen || link.dead || makingOffer) return;
      makingOffer = true;
      try {
        const offer = await p.createOffer();
        if (link.gen !== gen || link.dead) return;
        await p.setLocalDescription(offer);
        tx({ from: "sender", to: peer, kind: "offer", payload: JSON.stringify(offer) });
      } catch (err) { chat("sys", "Offer failed: " + (err.message || err)); }
      makingOffer = false;
    };
    p.onconnectionstatechange = () => {
      if (link.gen !== gen || link.dead) return;
      // "disconnected" can self-heal; "failed"/"closed" cannot.
      if (p.connectionState === "failed") rebuildLink(peer, "the connection failed");
      else if (p.connectionState === "closed" && d.readyState !== "open") rebuildLink(peer, "the connection closed");
    };
    return link;
    })();
    return link.building;
  }

  function rebuildLink(peer, reason) {
    if (!roomId || !started) return;
    const l = links.get(peer);
    if (!l) return;
    const now = Date.now();
    if (now - l.built < 3000) return; // close + failed + presence can all fire together
    l.built = now;
    stopServing(peer, reason);
    chat("sys", `Rebuilding the link — ${reason}.`);
    l.dead = true;                       // ignore late events from the old PC
    if (l.stopT) { try { l.stopT(); } catch {} l.stopT = null; }
    try { l.pc && l.pc.close(); } catch {}
    links.delete(peer);
    ensureLink(peer);                     // onnegotiationneeded re-offers to that peer
  }

  // Resolve a request to a live file. Missing means the sender removed it after
  // the receiver asked, so we say so out loud instead of silently stalling.
  const resolve = msg => {
    let f = msg.fid ? byFid(msg.fid) : (Number.isInteger(msg.idx) ? files[msg.idx] : null);
    if (!f && msg.fid) {
      chat("sys", "Receiver asked for a file you removed — nothing to send.");
    }
    return f;
  };

  function armServing(peer, link) {
    const l = link;
    sentDone = 0; sentTotal = 0; sentT0 = Date.now();
    l.lastAdvance = Date.now(); l.lastRestart = 0; l.queue = []; l.serving = false;
    l.dc.onopen = () => {
      if (l.dead) return;
      setPipeState("linked", "Receiver connected — waiting for their picks");
      chat("sys", "Receiver sees the file list — waiting for their picks…");
    };
    l.dc.onclose = () => {
      if (l.dead) return; // a link we already replaced fires close late
      stopServing(peer, "the receiver disconnected.");
      // The peer is gone, so the link is no longer "held" — say so rather than
      // leaving a green line implying someone is still there.
      if (![...links.values()].some(k => k !== l && !k.dead && k.linked)) {
        setPipeState("waiting", "Receiver left — still listening for another…");
      }
      rebuildLink(peer, "the receiver's connection dropped");
    };
    l.dc.onmessage = e => {
      if (typeof e.data !== "string") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === "want") {
        const f = resolve(msg);
        if (!f) return;
        l.queue.push(f);
        l.cancelled = false;
        sentTotal += f.size;
        chat("peer", `Receiver requested “${f.name}”`);
        pumpQueue(peer);
      } else if (msg.t === "wantAll") {
        files.forEach(f => { l.queue.push(f); sentTotal += f.size; });
        l.cancelled = false;
        chat("peer", "Receiver requested everything — sending…");
        pumpQueue(peer);
      } else if (msg.t === "ack") {
        // The receiver confirming it wrote a file to its own disk. This is the
        // only evidence the sender ever gets that a file truly arrived.
        const f = byFid(msg.fid);
        if (!f || f._got) return;
        noteReceived(f);
      } else if (msg.t === "cancel") {
        // The receiver stopped the download on purpose — not a failure, not a
        // dropout. Clear what was queued, flag the in-flight file to stop at the
        // next chunk, and say exactly that in the log.
        l.queue = [];
        l.cancelled = true;
        chat("sys", "Receiver cancelled the download ✕ — nothing more will be sent. Standing by for their next pick.");
        toast("Receiver cancelled");
        setPipeState("linked", "Receiver cancelled — standing by for their picks");
      }
    };
    // Stall watchdog: an ordered DataChannel shows nothing while stuck (no ICE
    // state change). Re-armable on every 15s of no progress, rate-limited to one
    // restart per 30s — a single one-shot restart can't rescue a recurring stall.
    if (sendWd) clearInterval(sendWd);
    sendWd = setInterval(() => {
      for (const [pid, k] of links) {
        if (!k.serving || k.dead) continue;
        const idle = Date.now() - k.lastAdvance;
        if (idle > 15000 && Date.now() - k.lastRestart > 30000) {
          k.lastRestart = Date.now();
          chat("sys", "⚠️ No progress for 15s — restarting the connection (keeps the same link)…");
          toast("Stalled — restarting connection…");
          try { k.pc.restartIce(); } catch {}
        } else if (idle > 30000) {
          chat("sys", "Still stuck — a strict NAT/firewall is dropping the path. A TURN relay fixes this; both sides stay online and keep retrying.");
          k.lastAdvance = Date.now(); // nag, not spam
        }
      }
      // Bytes that left the sender but were never confirmed by the receiver are
      // NOT "received". After 20s of silence say exactly that, instead of leaving
      // the panel implying everything landed.
      for (const f of files) {
        if (f._sent && !f._got && !f._unconf && Date.now() - f._sentT > 20000) {
          f._unconf = true;
          paintBadge(f); paintRecv();
          if (!files.some(x => x._sending)) {
            setPipeState("linked", "Sent — no confirmation from the receiver");
            chat("sys", `⚠️ ${f.name} left your device but the receiver never confirmed saving it. Keep this tab open.`);
          }
        }
      }
    }, 5000);
  }

  async function pumpQueue(peer) {
    const l = links.get(peer);
    if (!l || l.serving) return;
    l.serving = true;
    setStep(2);
    let why = "";
    while (l.queue.length) {
      // Check the share and the link every iteration: a Stop press or a peer
      // reload nulls things out mid-await, and dereferencing them blindly is what
      // produced "Cannot read properties of null (reading 'send')".
      if (!shareAlive) { why = "you stopped the share"; break; }
      const d = l.dc;
      if (!d || d.readyState !== "open") { why = l.dead ? "the link was rebuilt" : "the receiver disconnected"; break; }
      const f = l.queue.shift();
      const res = await sendFile(f, l);
      if (res === "aborted") { why = res.why || "the transfer was cancelled"; break; }
      if (res === "error") { why = "the send failed — see the message above"; break; }
    }
    l.serving = false;
    if (why) {
      // Never claim success on a queue that was stopped or broke part-way.
      if (l.cancelled) {
        l.cancelled = false; // the cancel handler already narrated it — just hold the link
        document.getElementById("status").textContent = "Cancelled — standing by for the receiver's next pick.";
        const bar = document.getElementById("bar");
        if (bar) bar.value = 0;
        setRadial(0); setStats(0, 0, 0); // this attempt's progress is void; a retry counts fresh…
        // …but only when nothing else is still streaming into the shared totals.
        if (![...links.values()].some(k => k !== l && !k.dead && (k.serving || k.queue.length))) { sentDone = 0; sentTotal = 0; sentT0 = Date.now(); }
        setPipeState("linked", "Receiver cancelled — standing by for their picks");
      } else {
        document.getElementById("status").textContent = "Sending stopped.";
        setPipeState("lost", "Sending stopped — " + why);
      }
      setStep(2);
      return;
    }
    if (!l.queue.length && sentDone > 0 && shareAlive && !l.cancelled) {
      // Bytes are gone, but "delivered" is not yet true. Hold the link open and
      // wait for the receiver's own ack — noteReceived() does the real finale.
      // The queue is drained, so 100% is finally true — and this is the ONE place
      // entitled to claim it. The coalesced txUi() callback is dropped after
      // completion, so the whole readout has to be forced synchronously. Forcing
      // the bar here and not the counters is what left a finished 1.5 MB file
      // reading "1.3 MB of 1.5 MB": 6 chunks of 256 KB, display frozen on chunk 5.
      forceFinalPaint();
      const barDone = document.getElementById("bar");
      if (barDone) barDone.value = 100;
      setRadial(100);
      setPipeState("linked", "Sent — waiting for their confirmation");
      document.getElementById("status").textContent = "✓ Requested files sent — waiting for confirmation.";
      chat("sys", "All requested files sent ✓ — leave the tab open in case they want more.");
      toast("Files sent — waiting for confirmation…"); chime(true);
    }
  }

  // Returns "sent" | "aborted" | "error" so pumpQueue can tell a real completion
  // from a stop, and never announce "all files sent" for the latter.
  async function sendFile(f, l) {
    const bar = document.getElementById("bar");
    const stats = document.getElementById("stats");
    const statusEl = document.getElementById("status");
    if (!f) return "aborted";
    if (!l || l.dead || !l.dc || l.dc.readyState !== "open") {
      chat("sys", `❌ Can't send ${f.name} — the link to that receiver is not open.`);
      return "error";
    }
    const dc = l.dc, pc = l.pc;
    const fid = fidOf(f);
    f._sending = true; f._aborted = false; f._sent = false; f._got = false; f._unconf = false;
    // Which peer is streaming this file right now, so one receiver leaving
    // cannot clear the flags of a transfer another receiver is mid-way through.
    f._peer = l.peer;
    setPipeState("flowing", "Sending " + f.name + "…");
    undeliverDial();
    paintBadge(f);
    bar.hidden = false;
    chat("me", `Sending ${f.name} (${fmt(f.size)})…`);
    try {
      dc.send(JSON.stringify({ t: "header", fid, idx: files.indexOf(f), name: f.name, size: f.size, mime: f.type }));
    } catch (err) {
      f._sending = false;
      chat("sys", `❌ Lost the link before ${f.name} could start — keep the tab open and retry.`);
      return "error";
    }
    let off = 0, chunksSent = 0, lastDiag = 0, uiQueued = false;
    // hashed end-to-end (see eof below): the receiver recomputes this over what
    // IT got and refuses to save on any mismatch — a truncated or flipped file
    // can never again be stored and acked as "received" (e.g. an APK that then
    // fails to install with no explanation).
    const cap = chunkCap(pc);
    const digest = sha256New();
    // Same reason as the receiver: coalesce every DOM write into one frame so the
    // send loop never starves the event loop that drains the channel.
    const txUi = () => {
      if (uiQueued) return;
      uiQueued = true;
      requestAnimationFrame(() => {
        uiQueued = false;
        // A paint queued mid-file can land a frame AFTER the send stopped
        // (cancel / error / completion): without this guard it repaints stale
        // progress over the terminal verdict (bar jumps back up, status shows
        // "diag: …" instead of "Cancelled — standing by…"). Observed in test.
        if (!f._sending) return;
        const pct = sentTotal ? (sentDone / sentTotal) * 100 : 0;
        bar.value = pct;
        setRadial(pct);
        const dt = Math.max(1, (Date.now() - sentT0) / 1000);
        setStats(sentDone, sentTotal, sentDone / dt);
        stats.textContent = rungText + `${fmt(sentDone)} of ${fmt(sentTotal)}`;
        statusEl.textContent = `diag: chunks=${chunksSent} buffered=${fmt(dc.bufferedAmount)} dc=${dc.readyState} ice=${pc.iceConnectionState}`;
      });
    };
    try {
      while (off < f.size) {
        // The sender can delete a file while it is streaming; stop cleanly rather
        // than pushing bytes for something the receiver can no longer request.
        if (f._aborted) {
          chat("sys", `Cancelled ${f.name} — you removed it mid-transfer. Nothing was saved by the receiver.`);
          toast("Send cancelled");
          return "aborted";
        }
        if (!shareAlive) return "aborted";
        if (l.cancelled) return "aborted"; // receiver asked us to stop — pumpQueue reports it honestly
        if (l.dead || !l.dc || dc.readyState !== "open") {
          chat("sys", `Lost the link ${fmt(off)} into ${f.name} — stopped. The receiver got an incomplete file.`);
          return "error";
        }
        if (dc.bufferedAmount > HIGH_WATER) await waitDrain(dc);
        // Re-check after the await above: the slice can resolve after a Stop
        // closed the peer connection, and sending on a closed channel throws
        // InvalidStateError — which the catch below reported as "Send failed"
        // for a share the user deliberately cancelled.
        if (dc.readyState !== "open" || l.dead || !shareAlive) {
          return "aborted";
        }
        const buf = await f.slice(off, off + cap).arrayBuffer();
        if (dc.readyState !== "open" || l.dead || !shareAlive) {
          return "aborted";
        }
        dc.send(buf);
        digest.update(buf);
        off += buf.byteLength; sentDone += buf.byteLength; l.lastAdvance = Date.now(); chunksSent++;
        txUi();
        if (Date.now() - lastDiag > 2000) { lastDiag = Date.now(); txUi(); }
      }
      if (f._aborted) return "aborted";
      // bytes + sha256 are the receiver's ground truth: it saves and acks ONLY
      // when its own count and digest match these. Additive — old receivers
      // ignore the unknown fields and keep size-only behavior.
      dc.send(JSON.stringify({ t: "eof", fid, idx: files.indexOf(f), bytes: off, sha256: digest.hex() }));
      // "Sent" is a claim about our own device only. Until the receiver acks,
      // the UI must not say "received".
      f._sent = true; f._sentT = Date.now();
      paintBadge(f); paintRecv();
      // No forced paint here. The coalesced txUi() frame is dropped after this
      // file stops sending, but there is only ONE place entitled to paint a
      // final total — the drained-queue block in pumpQueue, which is the moment
      // 100% is actually true. Painting here as well is what left the bug alive
      // in the first place: the bar and radial were forced at BOTH terminal
      // sites and the counters at NEITHER, and two owners is how that happened.
      return "sent";
    } catch (err) {
      chat("sys", `❌ Send failed: ${err && err.message || err} — keep the tab open and retry; screenshot this if it repeats.`);
      toast("Send failed — see chat");
      chime(false);
      return "error";
    } finally {
      f._sending = false;
    }
  }
}

// ---------- Anonymous success counter ----------
//
// One number: how many files finished successfully. The client reports each
// completion and forgets it — all batching lives on the server, which
// accumulates the increments in memory and writes them out as one batch on a
// timer. That keeps the client trivial: no counter to carry, no timer to arm,
// no flush to fire on page hide, and nothing that can be lost on navigation.
//
// Everything here is best-effort and MUST stay that way. The rules, in order of
// importance:
//
//   1. A transfer never waits on it. The send is fire-and-forget, and a failure
//      is swallowed without a toast, a log line, or any state change — there is
//      nothing a user could do about a counter, and nothing worth telling them.
//   2. It carries no identifier. No room id, no file name, no user agent, no
//      persistent key. A count of completed files is anonymous by construction,
//      which is the only reason it is permissible at all.
//   3. It is one tiny request per completed file, issued after the file is
//      already on disk. A session transfers a handful of files, so this is a
//      few small requests — far less traffic than the page it sits in — and the
//      server absorbs the cost by batching its own writes.
//
// If the backend has no /api/usage the request 404s and is ignored, so an older
// server costs nothing but a failed request.
function countCompleted() {
  try {
    fetch(apiUrl("/api/usage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n: 1 }),
      // The file is already saved at this point, so a dropped request only
      // under-counts. keepalive lets it finish even if the tab is closing.
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never surfaces */
  }
}

// ---------- RECEIVER ----------
// One code-entry implementation for the whole product. The 4-digit nearby-code
// boxes live on the home page now — a bare /receive redirects there — so this is
// called from initSender, never initReceiver. Scoped to the otpRow element with
// a .otp-digit class query, which finds the boxes in a real document and in the
// harness stub alike (the stub only matches .class selectors).
function initCodeEntry() {
  const otpRow = document.getElementById("otpRow");
  if (!otpRow) return;
  const otpInputs = [...otpRow.querySelectorAll(".otp-digit")];
  if (!otpInputs.length) return;
  const goCode = v => {
    v = (v || "").trim();
    if (!v) return;
    if (/^\d{4}$/.test(v)) fetch(apiUrl(`/api/nearby/${v}`)).then(x => { if (!x.ok) throw 0; return x.json(); }).then(r => location.href = "/r/" + r.id).catch(() => toast("Code not found — is the sender tab still open?"));
    else location.href = "/r/" + encodeURIComponent(v);
  };
  const codeOf = () => otpInputs.map(o => o.value).join("");
  const handleBox = (inp, i) => {
    inp.value = inp.value.replace(/\D/g, "").slice(-1);
    if (inp.value && i < 3) otpInputs[i + 1].focus();
    if (codeOf().length === 4) goCode(codeOf());
  };
  otpInputs.forEach((inp, i) => {
    inp.addEventListener("input", () => handleBox(inp, i));
    inp.addEventListener("keydown", e => { if (e.key === "Backspace" && !inp.value && i > 0) otpInputs[i - 1].focus(); });
  });
  // The zone itself is clickable like the send panel's drop zone: a click on
  // its padding focuses the first empty box. (Typing needs no click at all.)
  const codeZone = document.getElementById("codeZone");
  if (codeZone) codeZone.addEventListener("click", e => {
    if (e.target === codeZone || e.target.closest("h3,p,.otp")) {
      const box = otpInputs.find(o => !o.value) || otpInputs[otpInputs.length - 1];
      if (box) box.focus();
    }
  });
  // Pasting a 4-digit code fills the boxes and proceeds — no button needed.
  otpRow.addEventListener("paste", e => {
    const t = ((e.clipboardData && e.clipboardData.getData("text")) || "").replace(/\D/g, "").slice(0, 4);
    if (!t) return;
    e.preventDefault();
    t.split("").forEach((ch, j) => { if (otpInputs[j]) otpInputs[j].value = ch; });
    if (t.length === 4) goCode(t);
    else if (otpInputs[t.length]) otpInputs[t.length].focus();
  });
  // Guide glow: a pulse on the receive card that says "here". Fired when the
  // Receive anchor is clicked while idle, and on any load that already carries
  // #receiveEntry (a reload back from a share, a bookmark, back-button).
  const guide = () => {
    const entry = document.getElementById("receiveEntry");
    if (!entry) return;
    entry.classList.remove("guide");
    try { void entry.offsetWidth; } catch {}
    entry.classList.add("guide");
    entry.addEventListener("animationend", () => entry.classList.remove("guide"), { once: true });
  };
  if ((location.hash || "") === "#receiveEntry") guide();
  // The Receive anchor while a share is live: the panel is hidden, so the
  // anchor has no visible target and the browser does nothing. Going home must
  // also STOP the send — unwinding it by hand risks a half-stopped transfer,
  // so this is a full reload: the socket closes, the server marks the sender
  // gone, and home lands idle on the receive door. Delegated (one listener),
  // walking up manually: closest() with an attribute selector has no stub
  // equivalent, and this must stay testable.
  document.addEventListener("click", e => {
    let n = e.target, found = false;
    while (n && n !== document) {
      if (n.tagName === "A" && n.getAttribute && n.getAttribute("href") === "#receiveEntry") { found = true; break; }
      n = n.parentElement || n.parentNode;
    }
    if (!found) return;
    if (document.body.classList.contains("sharing")) {
      e.preventDefault();
      // A plain href assignment does NOT reload when already on "/": same path,
      // only the hash differs, so the browser just retargets and the live send
      // keeps running — the exact "clicked Receive, nothing happened" report.
      // Set the hash, then reload for real: the socket closes, the server marks
      // the sender gone, and home boots idle with the hash still set, so the
      // guide fires on arrival.
      location.hash = "receiveEntry";
      location.reload();
      return;
    }
    guide();
  });
  // Type-anywhere capture: digits typed without clicking into a box land in the
  // first empty one — no tap required. Guarded three ways: modifier keys never
  // trigger it, keystrokes inside a real input/textarea/select stay there, and
  // it only runs while the panel is actually visible (hidden once sharing
  // starts, so sender-side typing can never fill a code box).
  const panelLive = () => !otpRow.hidden && otpRow.offsetParent !== null;
  const isEditable = t => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || !!t.isContentEditable);
  document.addEventListener("keydown", e => {
    if (!/^[0-9]$/.test(e.key || "") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target) || !panelLive()) return;
    const box = otpInputs.find(o => !o.value);
    if (!box) return;
    e.preventDefault();
    box.value = e.key;
    handleBox(box, otpInputs.indexOf(box));
    // The filling boxes are the cue; the flash says *this panel* took the key.
    try { otpRow.classList.remove("otp-flash"); void otpRow.offsetWidth; otpRow.classList.add("otp-flash"); } catch {}
  });
  document.addEventListener("paste", e => {
    if (isEditable(e.target) || !panelLive()) return;
    const t = ((e.clipboardData && e.clipboardData.getData("text")) || "").replace(/\D/g, "").slice(0, 4);
    if (!t) return;
    e.preventDefault();
    t.split("").forEach((ch, j) => { if (otpInputs[j]) otpInputs[j].value = ch; });
    if (t.length === 4) goCode(t);
    else if (otpInputs[t.length]) otpInputs[t.length].focus();
  });
}

async function initReceiver() {
  const box = document.getElementById("box");
  if (!box) return;
  window.addEventListener("error", e => chat("sys", "❌ Error: " + (e.message || "unknown") + " — screenshot this if it repeats."));
  const parts = location.pathname.split("/").filter(Boolean);
  let id = parts[0] === "r" ? parts[1] : null;
  if (!id) {
    const q = new URLSearchParams(location.search);
    id = q.get("c") || q.get("code") || "";
    if (!id) {
      location.href = "/";
      return;
    }
    if (/^\d{4}$/.test(id)) {
      try { const r = await fetch(apiUrl(`/api/nearby/${id}`)).then(x => { if (!x.ok) throw 0; return x.json(); }); location.href = "/r/" + r.id; return; }
      catch { box.textContent = "Code not found — is the sender tab still open?"; return; }
    }
    location.href = "/r/" + encodeURIComponent(id);
    return;
  }
  const myId = "rx-" + rid();
  let meta;
  const roomRes = await fetch(apiUrl(`/api/rooms/${id}`)).catch(() => null);
  if (roomRes && roomRes.status === 451) {
    box.innerHTML = `This transfer was <b>disabled by an operator</b> after an abuse report.<br><span class='hint'>If you believe this is a mistake, ask the sender to contact support.</span>`;
    chat("sys", "Transfer disabled for abuse. 🚫");
    return;
  }
  try { meta = await (roomRes && roomRes.ok ? roomRes.json() : Promise.reject(0)); }
  catch {
    box.innerHTML = `This link is <b>expired</b> or the sender closed their tab.<br><span class='hint'>P2P only works while the sender is online — ask them to re-share.</span>`;
    chat("sys", "Link dead — sender is offline. Ask them to re-share. 🥀");
    return;
  }
  const rl = document.getElementById("reportLink");
  if (rl) {
    // app.js has always built this href, but no page contained #reportLink, so
    // the `if (rl)` guard swallowed it and the report page had no entry point
    // at all — reachable only by typing /report/<id> by hand. The wrapper is
    // revealed here rather than statically: the link is only meaningful once a
    // live room has been confirmed, and an expired link has nothing to report.
    rl.href = "/report/" + encodeURIComponent(id);
    const slot = document.getElementById("reportSlot");
    if (slot) slot.hidden = false;
  }
  // No sender-status banner here. It was painted once from the REST snapshot and
  // never updated, so it went stale the moment the sender's tab froze or came
  // back — and it was the one line the receiver read to decide whether clicking
  // Download was worth it, so a wrong one sent them down the wrong path.
  // Presence is live and already narrates both directions in the chat log; the
  // REST snapshot cannot know about any of that.
  box.innerHTML = "";
  const nFiles = (meta.files || []).length;
  chat("peer", `${nFiles} file${nFiles === 1 ? "" : "s"} ready — hit Download ⬇. Whether the sender is connected is in the log below.`);
  // Per-file picking (DataChannel file protocol v2): each row has its own
  // download button, plus Download-all. Rows are keyed by the sender's stable
  // file id (never the array index) so a live list update can add/remove rows
  // without any chance of a button pointing at the wrong file.
  let rxFiles = (meta.files || []).map(f => ({ ...f }));
  const savedFids = new Set();   // fully received
  const goneFids = new Set();    // removed by the sender mid-session
  const rowEl = document.getElementById("fileList");
  const dlAll = document.getElementById("dl");
  // fid is assigned by the sender and is peer-controlled. Interpolating it
  // raw into an attribute selector makes a single quote throw a DOMException,
  // which wedged that file permanently (in handleHeader it fired before
  // `cur = msg`, so the receive never started and every later chunk was
  // silently discarded). The server also rejects ids containing quotes, so
  // neither layer is load-bearing alone.
  const rowBtn = fid => (fid == null || fid === "" ? null
    : rowEl.querySelector(`.dlOne[data-fid="${cssEscape(String(fid))}"]`));
  // Live progress glow on the row currently streaming (cleared on every exit).
  const markActive = (fid, on) => {
    const b = fid && rowBtn(fid);
    const row = b && b.closest(".frow");
    if (row) row.classList.toggle("rx-active", !!on);
  };

  function renderRx() {
    rowEl.innerHTML = rxFiles.map(f => {
      const gone = goneFids.has(f.id);
      const done = savedFids.has(f.id);
      // A held request (waiting for an offline sender) must survive a re-render,
      // or a live manifest update silently reset the row to "download" and the
      // receiver believed the hold had been dropped.
      const heldRow = held.has(f.id);
      const busy = gone || done || heldRow;
      return `<div class="frow"><div class="ficon">${iconFor(f.name)}</div><div class="fmeta"><div class="fname" translate="no">${esc(f.name)}</div><div class="fsize">${gone ? "removed by sender" : fmt(f.size)}</div></div><button class="btn btn-sm dlOne" data-fid="${esc(f.id)}"${busy ? " disabled" : ""}>${gone ? "🚫" : done ? "✓ Saved" : heldRow ? "⏳" : "⬇"}</button></div>`;
    }).join("");
    rowEl.querySelectorAll(".dlOne").forEach(b => { b.onclick = () => wantOne(b.dataset.fid); });
    dlAll.hidden = !rxFiles.length;
    // While anything is outstanding a request is already in flight (single or
    // all): a live list update must not re-enable Download-all mid-flight, or
    // the second request overlaps the first and the sender pushes the same
    // bytes twice. Single mode disables it at click time (see wantOne); this
    // keeps it off across re-renders until the flight settles or is cancelled.
    dlAll.disabled = !rxFiles.length || rxFiles.every(f => goneFids.has(f.id)) || outstandingFids.size > 0;
    const live = rxFiles.filter(f => !goneFids.has(f.id));
    if (!live.length && !doneRx) {
      // Never overwrite a specific verdict ("stopped", "failed") with a generic
      // one — the specific reason is the actionable part.
      log.textContent = "The sender removed every file from this share.";
      chat("sys", "There are no files left to download. 🥀");
    }
  }

  let rPc = null, rSig = null, rDc = null, dirHandle = null;
  // offerRxT is when we last put OUR offer on the wire. It bounds the glare wait
  // in the offer handler: an offer nobody answered is stale, not in flight.
  let offerRxT = 0;
  const GLARE_RX_MS = 4000;
  // How long a receiver waits for the sender to answer a request before
  // calling it dead. It must comfortably exceed the app's own 30s "no data"
  // threshold below: on a strict NAT a TURN relay can take longer than that to
  // finish connecting, and failing the request while the link is still being
  // established is failing a sender who was never slow — it was just relayed.
  const REQ_DEADLINE_MS = 60000;
  // rxRequesting covers the window between accepting a click and the request
  // being recorded in pendingReq. pickDir() awaits a directory picker, which can
  // sit there as long as the user takes; cur and pendingReq are both null the
  // whole time, so the Cancel button was hidden exactly while a download was
  // genuinely in progress and stuck.
  let rxRequesting = false;
  let pendingWants = [], wantedCount = 0, wantedTotal = 0, receivedCount = 0;
  let cur = null, got = 0, fileDone = 0, writer = null, useStream = false,
    chunks = [], broken = false, lastRx = Date.now(), lastRestartRx = 0, doneRx = false;
  // Integrity + race guards (see handleHeader/handleEof): every header starts a
  // new attempt id. Async continuations (writer setup, writer close) snapshot
  // their attempt's data synchronously and only touch shared state when their
  // id is still current — otherwise a second file's header arriving mid-await
  // used to clobber or wipe the first file's verdict and bytes.
  let rxGen = 0, rxHash = null, pendChunks = null;
  // Write failures from attempts that have already been superseded (their close
  // settles after the next header). Keyed by attempt id so they can still fail
  // THEIR file without poisoning the next one.
  const lateBroken = {};
  let failed = false;
  let senderGoneT = 0;          // grace timer: sender offline mid-download
  let senderOnline = !!meta.senderOnline;  // last presence verdict
  // Every request the user made and has not seen a verdict for. The file list can
  // change underneath us, so the counters are derived from this set rather than
  // incremented blindly — otherwise a removed file leaves the totals permanently
  // short and the "all received" celebration can never fire.
  const outstandingFids = new Set();
  // What the receiver ASKED FOR, which is not the same as what is in flight.
  // A file stays wanted across an auto-restart and across a cancel-for-retry,
  // so this outlives both; outstandingFids is emptied by endRx on every failed
  // attempt and cannot answer the question on its own.
  const wantedFids = new Set();
  // A request that has been sent but for which no header has arrived. A dead
  // sender used to leave this at ⏳ forever; it now drives a request watchdog.
  let pendingReq = null;
  let lastCancelT = 0; // quiet window: eof chatter right after your own cancel stays silent
  const start = Date.now();
  const bar = document.getElementById("bar");
  const log = document.getElementById("log"); // was an implicit window.log named-access — now explicit
  // Progress is rendered once per animation frame, NOT once per chunk. At 4MB/s
  // a 256KB chunk arrives ~16x/sec, and the old per-chunk version did ~10 DOM
  // writes + 3 string formats each time — ~160 forced style invalidations/sec
  // that starved the message handler and stopped SCTP from draining.
  let uiQueued = false;
  function rxUi() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => {
      uiQueued = false;
      const all = fileDone + got;
      const pct = wantedTotal ? (all / wantedTotal) * 100 : 0;
      bar.value = pct;
      setRadial(pct);
      const dt = Math.max(1, (Date.now() - start) / 1000);
      setStats(all, wantedTotal, all / dt);
      if (cur && !doneRx) {
        log.textContent = `Receiving ${cur.name}… ${fmt(got)} of ${fmt(cur.size)} · ${fmt(all / dt)}/s`;
        const rb = cur.fid && rowBtn(cur.fid);
        const rfr = rb && rb.closest(".frow");
        const fsz = rfr && rfr.querySelector(".fsize");
        if (fsz) fsz.textContent = `${fmt(got)} of ${fmt(cur.size)} · ${wantedTotal ? Math.round(((fileDone + got) / wantedTotal) * 100) : 0}%`;
      }
    });
  }
  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
  const liveByFid = fid => rxFiles.find(f => f.id === fid && !goneFids.has(f.id));

  // Live manifest reconciliation. The sender can add or remove files at any time;
  // a removed file must vanish here and stop being requestable immediately.
  function applyManifest(list) {
    const before = new Map(rxFiles.map(f => [f.id, f]));
    rxFiles = (list || []).map(f => ({ ...f }));
    const after = new Set(rxFiles.map(f => f.id));
    for (const f of before.values()) {
      if (after.has(f.id)) continue;
      goneFids.add(f.id);
      pendingWants = pendingWants.filter(w => w.fid !== f.id);
      // A request for a file that no longer exists can never be satisfied, so it
      // leaves the totals too — otherwise "2 of 2" is unreachable and the radial
      // sits below 100% for the rest of the session.
      // applyManifest has already dropped the fid from rxFiles, so the totals
      // lose it there — no second delete from wantedFids is needed, and adding
      // one only hid a bug in the other mechanism.
      outstandingFids.delete(f.id);
      recomputeWanted();
      if (pendingReq && pendingReq.fid === f.id) pendingReq = null;
      if (cur && cur.fid === f.id) {
        // Abort the in-flight receive through the SAME terminal state as every
        // other interruption. Setting only `broken` used to leave the progress
        // bar frozen mid-file and let the stall watchdog nag about a stall we
        // caused deliberately.
        failed = true;
        endRx(`the sender removed ${f.name} while it was downloading`, {
          label: "Download stopped",
          toast: "File removed by sender",
          hint: "Nothing was saved. The row is gone from the list.",
        });
      } else {
        log.textContent = `Sender removed ${f.name}.`;
        chat("sys", `Sender removed ${f.name} — it's no longer available.`);
      }
    }
    const added = rxFiles.filter(f => !before.has(f.id));
    for (const f of added) chat("peer", `Sender added ${f.name} (${fmt(f.size)}) — available now.`);
    renderRx();
    // Every outstanding request is now accounted for: either saved or gone.
    maybeAllDone();
  }

  const saveBlob = (name, mime, parts) => {
    const blob = new Blob(parts || chunks, { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    try { setTimeout(() => URL.revokeObjectURL(url), 60000); } catch {}
  };
  // gen ties a failure to the attempt that produced it: a write that settles
  // after the next file's header started must fail ITS file, not the new one.
  const streamFail = (err, gen) => {
    if (gen !== undefined && gen !== rxGen) { lateBroken[gen] = true; return; }
    if (broken) return;
    broken = true;
    chat("sys", `❌ Disk write failed on ${cur ? cur.name : "file"} (${err && err.message || err}) — file will be incomplete.`);
  };
  const handleHeader = async msg => {
    // A header for a file nobody asked for (e.g. cancelled a breath too late) —
    // don't start saving it; the sender was already told to stop.
    if (msg.fid && !outstandingFids.has(msg.fid)) {
      // A header for a file already saved is a duplicate send, not a new file:
      // the stall watchdog's one retry can overlap a slow sender, or a second
      // request slipped out before the first arrived. Saving it again is what
      // downloaded the same file twice — so ignore it, ack nothing.
      if (savedFids.has(msg.fid)) {
        chat("sys", `Ignored a repeat send of ${msg.name || "a file"} — already saved.`);
        return;
      }
      chat("sys", `Ignored ${msg.name || "a file"} — you cancelled that download.`);
      return;
    }
    // P2P path never sees the server's validFileMeta: reject spoofed/device/
    // traversal-adjacent names before anything reaches disk. Fail loudly, save
    // nothing, ack nothing — the sender sees "sent · no confirmation".
    if (!validRecvName(msg.name)) {
      const fid = msg.fid;
      if (fid) outstandingFids.delete(fid);
      markActive(fid, false);
      const btn = fid ? rowBtn(fid) : null;
      if (btn && !goneFids.has(fid)) { btn.textContent = "❌"; btn.disabled = true; }
      log.textContent = `✗ Download blocked — the sender sent an unsafe file name. Nothing was saved.`;
      chat("sys", `✗ Blocked an unsafe file name from the sender. Nothing was saved.`);
      toast("Blocked unsafe file name ✗");
      chime(false);
      return;
    }
    const prevFid = cur && cur.fid;
    if (prevFid && prevFid !== msg.fid) markActive(prevFid, false);
    markActive(msg.fid, true);
    // A new attempt: fresh id, fresh byte count, fresh digest, fresh buffers.
    // chunks/rxHash are REPLACED (never mutated), so an earlier file whose eof
    // is still awaiting its writer close keeps its own snapshot intact.
    const gen = ++rxGen;
    cur = msg; got = 0; chunks = []; rxHash = sha256New();
    writer = null; useStream = false; broken = false; pendChunks = null;
    // A new file header is a new attempt: clear the failure verdict from any
    // previous one, or every later download would report itself as failed.
    doneRx = false; failed = false;
    pendingReq = null;
    clearTimeout(senderGoneT); senderGoneT = 0;
    lastRx = Date.now();
    log.textContent = `Receiving: ${cur.name}…`;
    chat("peer", `Sending ${cur.name} (${fmt(cur.size)})…`);
    setPipeState("flowing", "Receiving " + cur.name + "…");
    if (dirHandle) {
      // The writer spins up ASYNC (two awaits). Bytes that arrive meanwhile
      // used to fall into `chunks` while later bytes went to the stream — and
      // eof then saved only the stream half, silently dropping the head. Now
      // they queue in pendChunks and flush to the writer in order once ready.
      pendChunks = [];
      try {
        // Never silently overwrite a name we already wrote. Two manifest entries can
        // share a name (nothing enforces uniqueness), and a sender can re-send a
        // different file under a name already on disk. getFileHandle(name,
        // {create:true}) returns the EXISTING file, and createWritable() with no
        // options truncates it to zero — so an already-verified download would
        // vanish with no warning, and the corrupt-stream path below then
        // removeEntry's it outright. Refuse and say so.
        const existing = await dirHandle.getFileHandle(msg.name).catch(() => null);
        if (existing && (await existing.getFile().catch(() => null))) {
          throw new Error("ALREADY_SAVED");
        }
        const fh = await dirHandle.getFileHandle(msg.name, { create: true });
        if (rxGen !== gen) return; // superseded — leave the new attempt alone
        const w = await fh.createWritable({ keepExistingData: true });
        if (rxGen !== gen) { try { await w.abort(); } catch {} return; }
        const q = pendChunks || []; pendChunks = null;
        writer = w; useStream = true;
        for (const part of q) {
          if (rxGen !== gen) break;
          try {
            const r = writer.write(part);
            if (r && r.catch) r.catch(err => streamFail(err, gen));
          } catch (err) { streamFail(err, gen); break; }
        }
      } catch (err) {
        if (rxGen !== gen) return;
        // Refused: a file of that name is already on disk and verified. Leave
        // it alone and fall back to a normal download, which the browser
        // handles as (n) rather than overwriting.
        if (err && err.message === "ALREADY_SAVED") {
          chat("sys", `${msg.name} is already in that folder — keeping it, saving this one as a normal download.`);
          if (pendChunks) { for (const part of pendChunks) chunks.push(part); pendChunks = null; }
          writer = null; useStream = false;
          return;
        }
        // No stream after all: keep what arrived while spinning up, in memory.
        if (pendChunks) { for (const part of pendChunks) chunks.push(part); pendChunks = null; }
        writer = null; useStream = false;
      }
    }
  };
  const handleEof = async msg => {
    if (!cur) {
      // The tail of a duplicate send we already refused at its header (saved
      // file re-sent) — nothing to verdict, stay quiet.
      if (msg && msg.fid && savedFids.has(msg.fid)) return;
      if (Date.now() - lastCancelT < 30000) return; // aftermath of your own cancel — stay quiet
      chat("sys", "Sender sent an end-of-file for a transfer we never started — ignoring."); return;
    }
    // Snapshot EVERYTHING synchronously. A second file's header can land while
    // the writer close below is awaited (wantAll streams back-to-back): it
    // replaces the shared buffers/counters, and this verdict must use what THIS
    // file actually received — never the next file's live state.
    const gen = rxGen;
    const f = cur, n = got, data = chunks, pend = pendChunks;
    const w = writer, streaming = useStream && !!writer;
    const h = rxHash, wasBroken = broken || failed, fid = f.fid || msg.fid;
    const eofBytes = msg && Number.isInteger(msg.bytes) ? msg.bytes : null;
    const eofHash = msg && typeof msg.sha256 === "string" ? msg.sha256 : null;
    markActive(fid, false);
    if (!outstandingFids.has(fid) && !savedFids.has(fid)) {
      // We were not waiting for this file (e.g. the request was cancelled when
      // the sender removed it). Say so rather than counting it as progress.
      chat("sys", `Ignored the tail of ${f.name} — you had already stopped that download.`);
      if (rxGen === gen && cur === f) { cur = null; got = 0; }
      return;
    }
    outstandingFids.delete(fid);
    if (streaming) {
      try { await Promise.race([w.close(), timeout(30000)]); }
      catch {
        if (rxGen === gen) streamFail(new Error("close timed out"));
        else lateBroken[gen] = true;
      }
    }
    // Verify BEFORE anything reaches disk. Length first (catches truncation),
    // then the content digest (catches flips that keep the length). Old senders
    // omit bytes/sha256: the header-size check still guards truncation.
    let failWhy = "";
    if (wasBroken || lateBroken[gen]) failWhy = "the write did not complete";
    else if (n !== f.size) failWhy = `arrived incomplete (${fmt(n)} of ${fmt(f.size)})`;
    else if (eofBytes !== null && n !== eofBytes) failWhy = `arrived incomplete (${fmt(n)} of ${fmt(eofBytes)} sent)`;
    else if (eofHash !== null) {
      let actual = null;
      try { actual = h.hex(); } catch { actual = null; }
      if (actual !== eofHash) failWhy = "failed its integrity check (contents differ from what the sender sent)";
    }
    if (!failWhy && !streaming) {
      // Memory path: the assembled parts must add up to what we counted.
      let sum = 0;
      for (const p of data) sum += (p && (p.byteLength || p.size)) || 0;
      if (pend) for (const p of pend) sum += (p && (p.byteLength || p.size)) || 0;
      if (sum !== n) failWhy = `arrived incomplete (${fmt(sum)} buffered of ${fmt(f.size)})`;
    }
    delete lateBroken[gen];
    const btn = rowBtn(fid);
    if (failWhy) {
      // Loud, specific, nothing saved, no ack. The sender notices the missing
      // ack and reports "sent · no confirmation" instead of "received".
      // Stream path caveat: the bad bytes already reached the disk file, so
      // remove it best-effort — otherwise "nothing was saved" would be a lie.
      let diskNote = "Nothing was saved.";
      if (streaming && dirHandle) {
        try { await dirHandle.removeEntry(f.name); }
        catch { diskNote = `Delete ${f.name} from your chosen folder — it is corrupt.`; }
      }
      if (rxGen === gen && cur === f) { cur = null; got = 0; pendChunks = null; }
      if (btn && !goneFids.has(fid)) { btn.textContent = "❌"; btn.disabled = true; }
      log.textContent = `✗ Download failed — ${f.name} ${failWhy}. ${diskNote}`;
      chat("sys", `✗ Download failed: ${f.name} ${failWhy}. ${diskNote} Ask the sender to send it again.`);
      toast("File failed verification ✗");
      chime(false);
      setPipeState("lost", `Verification failed — ${f.name} ${failWhy}`);
      if (!outstandingFids.size) document.getElementById("peerHint").textContent = "finished with errors";
      return;
    }
    // Actual bytes land in the totals (was: advertised size, which hid truncation).
    fileDone += n; receivedCount++;
    savedFids.add(fid);
    // Reached only on the success path: the digest mismatch above returns early,
    // so "saved" and "verified" are the same branch. This is the single place a
    // completed file is counted — a request, a start, a cancel, a retry and a
    // failed transfer all leave it alone.
    countCompleted();
    if (!streaming) saveBlob(f.name, f.mime, pend ? data.concat(pend) : data);
    if (btn) { btn.textContent = "✓ Saved"; btn.disabled = true; }
    log.textContent = `✓ Saved ${f.name} — check your ${dirHandle ? "chosen folder" : "downloads"}.`;
    chat("sys", `Saved ${f.name} ✓ (${receivedCount}/${wantedCount})`);
    // Tell the sender it actually landed — and landing now MEANS verified.
    // Without this the sender can only ever claim "sent".
    sendAck(fid);
    // Roll the in-flight bytes into fileDone (else the rAF renderer sums
    // fileDone + got and reports exactly double) — but only when no newer file
    // has started counting in the meantime.
    if (rxGen === gen && cur === f) {
      cur = null; got = 0; pendChunks = null;
      // A request made while this file was streaming is not a stalled one. The
      // sender keeps one queue per receiver and serves it a file at a time, so the
      // header can be a whole large transfer away — and the deadline, measured
      // from the CLICK, expired during that wait. The failure then landed the
      // instant the previous file finished: the sender got to the next request
      // milliseconds later and the receiver had already given up on it.
      // The sender has just proved it is alive and moved its queue, so the
      // remaining request starts its clock now.
      if (pendingReq) pendingReq.deadline = Date.now() + REQ_DEADLINE_MS;
    }
    maybeAllDone();
  };
  // ONE terminal state for a receive that will not complete. Interruptions
  // (channel close, ICE failure, sender gone) and sender-side removals both land
  // here, so the UI always ends truthful: no frozen progress bar, no watchdog
  // nagging about a stall we caused on purpose, and nothing half-saved.
  // opts.hint overrides the "ask the sender to re-share" tail, which is wrong
  // advice when the sender is still online and simply removed a file.
  function endRx(reason, opts = {}) {
    if (doneRx) return;
    doneRx = true; broken = true;
    rxRequesting = false;
    rxGen++; // invalidate any writer setup/close still in flight — it must not
             // touch the (now dead) shared state when it settles
    for (const k in lateBroken) delete lateBroken[k];
    clearTimeout(senderGoneT); senderGoneT = 0;
    chunks = []; pendChunks = null;   // never let a partial transfer reach disk
    if (useStream && writer) { try { writer.abort(); } catch {} writer = null; }
    // Capture everything about the in-flight file BEFORE dropping it. Reading
    // `cur` further down threw a TypeError, and because that happened after
    // doneRx = true the whole rest of endRx was skipped — the user got no
    // failure message at all and just a frozen progress bar.
    // An explicit fid wins over cur. `cur` is null whenever the sender never
    // started — no header ever arrived — and that is precisely the case that has
    // to be queued for an auto-resume: the fid is sitting right there in the
    // caller, but deriving it from cur silently dropped it, so a transfer the
    // sender's freeze killed was never queued and never restarted.
    const cfid = opts.fid || (cur ? cur.fid : null);
    const btn = cfid ? rowBtn(cfid) : null;
    markActive(cfid, false);
    if (cfid) outstandingFids.delete(cfid);
    // Any rAF frame already queued reads `cur` and would repaint
    // "Receiving x… 6.3 MB of 90.0 MB" over the failure message, leaving a
    // progress bar frozen on a transfer that will never resume.
    cur = null; got = 0;
    pendingReq = null;
    if (opts.resume) {
      // The sender's tab froze mid-transfer and they reconnect by themselves.
      // Queue it so it restarts on its own when they return — see queueResume.
      //
      // A null cfid with resume means "everything outstanding": Download-all
      // records its pendingReq with fid: null, so there is no single row to mark.
      // Queuing each outstanding file is what makes a multi-file request resume
      // as a whole rather than dropping all but one.
      if (cfid && !goneFids.has(cfid)) queueResume(cfid);
      else if (!cfid) for (const id of outstandingFids) if (!goneFids.has(id)) queueResume(id);
    } else if (btn && !goneFids.has(cfid)) {
      // Leave a WORKING Resume rather than a dead ❌. A frozen sender killed the
      // transfer and left the receiver with neither a way to retry nor a way to
      // cancel — the reported dead end. There is no byte-offset resume on a
      // DataChannel, so Resume restarts the file from the beginning; the row
      // click already goes through wantOne, which is exactly that.
      btn.textContent = "↻ Resume";
      btn.disabled = false;
    }
    if (pendingWants.length) pendingWants = [];
    const tail = opts.hint || "Nothing was saved. ↻ Resume restarts the file from the beginning — it can't continue from the middle.";
    log.textContent = `✗ ${opts.label || "Download failed"} — ${reason}`;
    document.getElementById("peerHint").textContent = opts.label || "Download failed";
    chat("sys", `✗ ${opts.label || "Download failed"}: ${reason}. ${tail}`);
    toast(opts.toast || "Download failed ✗");
    chime(false);
    setPipeState("lost", opts.label ? opts.label + " — " + reason : "Link lost — " + reason);
  }
  // A download must FAIL loudly, never silently stall or half-save, when the
  // sender goes away mid-transfer (tab closed, room deleted, network dropped).
  // opts is forwarded verbatim, so a caller that knows the fid but has no `cur`
  // (the sender never sent a header) can still tell endRx what to queue.
  const failRx = (reason, opts) => { if (failed) return; failed = true; endRx(reason, opts); };

  // The totals describe WHAT THE RECEIVER ASKED FOR, never how many requests it
  // issued. An auto-restart re-issues the same want, so counting on every request
  // counted one file twice: after a freeze and a successful restart the file
  // saved fine but the session ended "Saved a.bin (1/2)" with the bar stuck at
  // 50% and "Download failed" still on screen, because the completion gate could
  // never be met. Deriving the numbers from the wanted set makes a restart
  // idempotent, and this is the one place that owns them.
  function recomputeWanted() {
    wantedCount = 0; wantedTotal = 0;
    for (const id of wantedFids) {
      // No goneFids test here on purpose: a fid only enters goneFids at the one
      // site that also drops it from wantedFids, so filtering it twice just
      // hides a missed delete. wantedFids is the single record of intent.
      const f = rxFiles.find(x => x.id === id);
      if (!f) continue;
      wantedCount++; wantedTotal += f.size || 0;
    }
  }
  // Fired when nothing is in flight: a fresh request, or the file list changed.
  // Recomputes the totals from outstandingFids, so a removed file cannot leave
  // the progress pinned below 100% forever.
  function maybeAllDone() {
    recomputeWanted();
    if (receivedCount >= wantedCount && wantedCount > 0 && !outstandingFids.size) {
      doneRx = true;
      // Keep the session's final average speed/ETA on screen: zeroing them here
      // is what left "—" under a completed download (reported as missing speed).
      const avg = fileDone / Math.max(1, (Date.now() - start) / 1000);
      bar.value = 100; setRadial(100); setStats(fileDone, wantedTotal, avg);
      document.getElementById("peerHint").textContent = broken ? "Finished with errors" : "All requested files received ✓";
      if (!broken) { toast(`All files received ✓`); chime(true); deliveredShow("Received successfully on this device ✓"); }
      else { toast("Finished with errors"); chime(false); }
    }
  }

  // Stall + request watchdogs. The interval is created once and never cleared:
  // clearing it on success meant a SECOND download in the same session had no
  // watchdog at all. It idles out on `doneRx || !cur` instead.
  const wdRx = setInterval(() => {
    if (doneRx) return;
    // A request with no bytes and no header is the "clicked Download but
    // nothing happened" case — the sender is gone or wedged. Retry once over a
    // fresh link, then fail loudly rather than leaving the row at ⏳.
    if (pendingReq && got === 0) {
      const waited = Date.now() - pendingReq.t0;
      // >=, not >: the watchdog ticks on 5s boundaries, so a strict > pushed the
      // 10s retry to 15s and the 25s failure to 30s.
      if (!pendingReq.retried && waited >= 10000) {
        pendingReq.retried = true;
        chat("sys", "The sender hasn't started sending — rebuilding the link and asking again…");
        const w = pendingReq.w;
        const btn = rowBtn(pendingReq.fid);
        if (btn) btn.textContent = "⏳";
        linkRx().then(() => {
          if (rDc && rDc.readyState === "open") rDc.send(JSON.stringify(w));
          else pendingWants.push(w);
        }).catch(() => {});
      } else if (Date.now() >= pendingReq.deadline) {
        const nm = pendingReq.name, fid = pendingReq.fid;
        pendingReq = null;
        failed = true;
        endRx(`the sender never started sending ${nm}`, {
          toast: "Sender never started ✗",
          // The hint has to match what will actually happen: resume is only
          // queued when the sender is away, so promising an automatic restart
          // when they are merely wedged tells the receiver to wait for nothing.
          hint: senderOnline
            ? "Nothing was saved. ↻ Resume asks again from the beginning."
            : "Nothing was saved — it restarts by itself once the sender is back.",
          resume: !senderOnline, fid,
        });
        // endRx only marks the row of an in-flight file; here nothing arrived, so
        // mark the requested row by hand or it stays at ⏳ forever. An interruption
        // leaves a WORKING Resume, not a dead ❌ — the sender may well come back,
        // and there is no byte-offset resume on a DataChannel, so it starts over.
        const btn = rowBtn(fid);
        if (btn && !goneFids.has(fid)) { btn.textContent = "↻ Resume"; btn.disabled = false; }
      }
      return;
    }
    if (!cur) return;
    const idle = Date.now() - lastRx;
    const dead = rDc && rDc.readyState !== "open";
    const iceDead = rPc && (rPc.iceConnectionState === "failed" || rPc.connectionState === "failed");
    if (dead || iceDead) { failRx("the sender's connection dropped"); return; }
    if (idle > 15000 && Date.now() - lastRestartRx > 30000) {
      lastRestartRx = Date.now();
      chat("sys", "⚠️ No data for 15s — restarting the connection (same link)…");
      try { rPc.restartIce(); } catch {}
    } else if (idle > 30000) {
      chat("sys", "Still no data — a strict NAT/firewall is dropping the path. A TURN relay would fix this.");
      lastRx = Date.now(); // nag, not spam
    }
  }, 5000);

  // Signaling opens on page load, NOT on first click: the receiver must be in the
  // room to learn about live file removals even before anyone presses Download.
  // The peer connection itself is still created lazily (on first pick, or on the
  // first offer, whichever lands first) so opening the page costs nothing.
  function ensureSignal() {
    // A closed socket is not reusable, and a mobile tab that was backgrounded
    // comes back to a dead one. Returning early on any non-null rSig meant the
    // receiver could never re-join for the rest of the page's life — so a
    // backgrounded receiver was stuck with stale presence forever, which is the
    // mirror image of the sender-side bug.
    if (rSig && !rSig.isClosed()) return;
    rSig = null;
    setPipeState("waiting", "Reaching the sender…");
    const pendingIce = [];
    let remoteSet = false, linkedRx = false;
    rSig = openSignal(id, "receiver", myId, async m => {
      if (m.kind === "files") {
        // Live manifest from the sender: add/remove rows, drop pending wants.
        try { applyManifest(JSON.parse(m.payload).files || []); }
        catch (err) { chat("sys", "Bad file list update: " + (err.message || err)); }
        return;
      }
      if (m.kind === "offer") {
        // The sender may offer before we have a PC (we connect lazily). Create it
        // now so the offer is not lost — the server's offer mailbox is one-shot.
        if (!rPc) { try { await ensureConn(); } catch (err) { chat("sys", "Could not connect: " + (err.message || err)); return; } }
        const pc = rPc;
        // Ignore the sender's offer ONLY while ours is genuinely in flight (glare)
        // — the polite sender rolls back and answers ours. An offer left
        // unanswered for longer than GLARE_RX_MS is stale: the sender was not
        // there to answer it. Sitting in have-local-offer forever then made us
        // DISCARD the sender's offer when it came back, which is a hard deadlock
        // — presence says online, nothing ever flows, and nothing says why.
        //
        // The stall watchdog's restartIce() is what creates the stale offer, so
        // this only bit when the watchdog fired during the gap: intermittent, and
        // only after a longer pause. Bounding the wait removes the whole class.
        if (pc.signalingState === "have-local-offer") {
          if (Date.now() - offerRxT < GLARE_RX_MS) return;
          try { await pc.setLocalDescription({ type: "rollback" }); } catch {}
        }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(m.payload)));
          remoteSet = true;
          for (const c of pendingIce) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
          pendingIce.length = 0;
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          rSig.send({ from: myId, to: "sender", kind: "answer", payload: JSON.stringify(answer) });
          if (!linkedRx) {
            linkedRx = true;
            document.getElementById("peerHint").textContent = "connected ✓";
            chat("sys", "Connected ✓ — pick the files you want ⬇");
          } else chat("sys", "Connection re-established ✓");
        } catch (err) { chat("sys", "Offer rejected: " + (err.message || err)); }
      } else if (m.kind === "ice") {
        const c = JSON.parse(m.payload);
        if (remoteSet && rPc) { try { await rPc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
        else pendingIce.push(c);
      } else if (m.kind === "bye") {
        // failRx() owns the log line. Setting log.textContent here ran AFTER it
        // and replaced "✗ Download failed — the sender closed the share" with a
        // blander "Sender closed the room." that hid the failure verdict.
        // Capture before failRx: endRx nulls cur, and the row has to be marked
        // after it runs. A closed share is definitive, so NO row may offer a
        // restart — the pendingReq-only branch used to leave an in-flight file
        // showing ↻ Resume, which would start against a share that is gone.
        const closedFid = cur ? cur.fid : (pendingReq ? pendingReq.fid : null);
        if (cur && !doneRx) failRx("the sender closed the share");
        else if (pendingReq) {
          const nm = pendingReq.name, fid = pendingReq.fid;
          pendingReq = null; failed = true;
          endRx("the sender closed the share before the transfer started", {
            toast: "Share closed ✗",
            hint: "Nothing was saved. Ask the sender to re-share.",
            fid,
          });
        }
        if (closedFid) {
          const b = rowBtn(closedFid);
          if (b && !savedFids.has(closedFid)) { b.textContent = "❌"; b.disabled = true; }
        }
        // Capture before failRx: endRx sets doneRx, and the narration plus the
        // held-drop below must run either way. Gating them on !doneRx meant a bye
        // that arrived while a file was in flight skipped BOTH — the receiver was
        // never told the share closed, and requests queued for the sender's return
        // survived against a share that no longer exists.
        const wasDoneRx = doneRx;
        chat("sys", "Sender closed the room. 🥀");
        // A bye is a DEFINITIVE close (the share was stopped or the room
        // deleted), not the soft "tab frozen" case that presence reports. Held
        // requests must not survive it, or they would start against a share
        // that no longer exists.
        if (held.size) {
          const n = held.size;
          dropHeld();
          for (const f of rxFiles) {
            const b = rowBtn(f.id);
            if (b && !savedFids.has(f.id) && !goneFids.has(f.id)) { b.textContent = "⬇"; b.disabled = false; }
          }
          chat("sys", `The ${n} waiting file${n > 1 ? "s" : ""} ${n > 1 ? "were" : "was"} dropped — the sender ended the share.`);
        }
        if (!wasDoneRx) log.textContent = "Sender closed the room — nothing more can arrive.";
        // A closed share means no sender: remember it, or a later click would
        // queue a request that can only ever time out.
        senderOnline = false;
        // A click still waiting on the directory picker has no transfer behind it
        // any more, and this path may not reach endRx (nothing is in flight), so
        // leaving rxRequesting set would keep Cancel on screen for good.
        rxRequesting = false;
      } else if (m.kind === "presence") {
        try {
          const p = JSON.parse(m.payload);
          const was = senderOnline;
          senderOnline = !!p.senderOnline;
          clearTimeout(senderGoneT);
          senderGoneT = 0;
          // Presence reporting the sender gone is proof its tab was frozen — which
          // is also proof the WebRTC session is gone, however healthy it looks.
          //
          // A frozen tab stops running its DTLS/SCTP keepalives, so the
          // association times out while the tab is away and BOTH ends still report
          // connectionState "connected" / channel "open". Every staleness check
          // downstream (linkRx's dead test, ensureConn's early return) trusts those
          // states, so they all pass and the receiver sends its want into a channel
          // nobody is reading: "the sender never started sending". Rebuilding is
          // only possible once the old PC is closed, because a fresh offer applied
          // to a connected peer connection is rejected.
          //
          // pendingWants is deliberately left alone. The re-issue below covers the
          // single in-flight pendingReq, but once a file is STREAMING (`cur` set)
          // there is no re-issue at all, and the queue is the only thing carrying
          // the receiver's later picks to the rebuilt channel.
          if (!senderOnline) {
            // A click still waiting on the directory picker has no transfer behind
            // it any more. Leaving rxRequesting set would keep Cancel on screen for
            // good — the same stranded state the bye path has to clear.
            rxRequesting = false;
            // Guarded on rPc, so a flapping presence does not repeat the message:
            // the first frame nulls it and the rest go quiet.
            if (rPc) {
              try { rPc.close(); } catch {}
              rPc = null; rDc = null;
              lastRx = Date.now();
              chat("sys", "Sender's tab was frozen, so the encrypted link died with it. Rebuilding when they return.");
            }
            const busy = cur || pendingReq;
            if (busy) {
              log.textContent = "Sender went offline — transfer may stall.";
              // Presence is the only instant signal that the sender's tab closed;
              // the data channel itself would linger ~30s on an SCTP timeout. Give
              // a short grace period for them to come back, then fail the download
              // instead of leaving a progress bar frozen forever.
              if (!doneRx && !failed) {
                chat("sys", "Sender went offline mid-download — waiting 10s to see if they return…");
                senderGoneT = setTimeout(() => {
                  senderGoneT = 0;
                  if (doneRx || failed) return;
                  if (cur) failRx("the sender went offline", { resume: true });
                  else if (pendingReq) {
                    const nm = pendingReq.name, fid = pendingReq.fid;
                    pendingReq = null; failed = true;
                    // They were mid-share and went away, so this restarts by
                    // itself when they return.
                    endRx(`the sender went offline before sending ${nm}`, {
                      toast: "Sender went offline ✗",
                      hint: "Nothing was saved — it restarts by itself once the sender is back.",
                      resume: true, fid,
                    });
                  }
                }, 10000);
              }
            } else {
              // Nothing in flight. The most likely cause on a phone is the
              // sender's own tab being frozen while they shared the link — they
              // reconnect on their own, so this is a pause, not a failure.
              log.textContent = "Sender went offline — if they're on a phone this is their tab pausing. It resumes when they come back.";
              chat("peer", "Sender paused — waiting for them to come back.");
            }
          } else if (!was) {
            chat("peer", "Sender is back online ✓");
            // Deliberately NOT gated on !doneRx. A failed attempt sets doneRx —
            // which is exactly the state being recovered from — so gating on it
            // meant the sender could return, presence could flip to online, and
            // nothing would restart. That was the reported "connection
            // re-established but the download never resumes".
            releaseHeld();
          }
        } catch {}
      }
    }, (state, e) => {
      if (e && e.code === 4401) {
        log.textContent = "Transfer disabled by operator.";
        chat("sys", "This transfer was disabled for abuse. 🚫");
        return;
      }
      if ((cur || pendingReq) && !doneRx) {
        // Forward the fid: endRx derives it from cur, which is null whenever the
        // sender never started — and for Download-all it is null by design.
        failRx("lost the connection to the sender", { fid: pendingReq ? pendingReq.fid : null });
      }
      else if (!linkedRx) { log.textContent = "Lost signaling — sender may have closed the tab."; }
      // Rejoin when this tab comes back. A mobile receiver opens the link in an
      // in-app browser (WhatsApp) and that gets backgrounded constantly; without
      // this the presence view froze the moment it did.
      rSig = null;
      if (typeof document !== "undefined" && !document.hidden) {
        setTimeout(() => { try { ensureSignal(); } catch {} }, 800);
      }
    });
    const onVisibleRx = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try { ensureSignal(); } catch {}
    };
    document.addEventListener("visibilitychange", onVisibleRx);
    window.addEventListener("pageshow", onVisibleRx);
    window.addEventListener("online", onVisibleRx);
  }

  async function ensureConn() {
    if (rPc) return;
    const idle = document.getElementById("rxIdle");
    if (idle) idle.hidden = true;
    const lc = document.getElementById("rxLiveCard");
    if (lc) lc.hidden = false;
    const rtc = document.getElementById("rxTermCard");
    if (rtc) rtc.hidden = false;
    document.body.classList.add("rx-active");
    ensureSignal();
    bar.hidden = false;
    document.getElementById("rxRadialWrap").hidden = false;
    setPipeState("waiting", "Reaching the sender…");
    undeliverDial();
    document.getElementById("peerHint").textContent = "establishing encrypted P2P…";
    chat("me", "Joining room… 🤝");
    const ice = await fetchIce(id);
    rPc = new RTCPeerConnection({ iceServers: ice });
    const pc = rPc;
    let makingOfferRx = false;
    trackTransport(pc,
      t => { document.getElementById("peerHint").textContent = t + " ✓"; },
        ev => {
          // Advise "keep this tab open" only while a transfer is actually in
          // flight. After a deliberate stop — file removed, share closed, or a
          // click that never started because the sender is offline — the peer is
          // gone on purpose and the advice is pure noise.
          const busy = cur || pendingReq;
          if (ev === "failed" && busy && !doneRx) { chat("sys", "Direct path failed — restarting, will prefer relay…"); log.textContent = "Retrying via relay…"; }
          else if (ev === "stuck" && busy && !doneRx) chat("sys", "Still stuck — strict firewall? Keep this tab open and ask the sender to stay online.");
        });
    pc.onicecandidate = e => {
      if (e.candidate) rSig.send({ from: myId, to: "sender", kind: "ice", payload: JSON.stringify(e.candidate) });
    };
    pc.onnegotiationneeded = () => { sendOfferRx(); };
    async function sendOfferRx() {
      if (makingOfferRx) return;
      makingOfferRx = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        offerRxT = Date.now();
        rSig.send({ from: myId, to: "sender", kind: "offer", payload: JSON.stringify(offer) });
      } catch (err) { chat("sys", "Restart offer failed: " + (err.message || err)); }
      makingOfferRx = false;
    }
    // Sender vanished (tab closed / room deleted) while we were mid-download:
    // fail the transfer instead of leaving the user watching a dead progress bar.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && cur && !doneRx) failRx("the peer connection failed");
    };
    pc.ondatachannel = ev => {
      const dc = ev.channel;
      rDc = dc;
      dc.binaryType = "arraybuffer"; // no Blob overhead, direct byteLength
      dc.onopen = () => {
        if (doneRx) return;
        setPipeState("linked", "Connected to the sender — pick what you want");
        chat("sys", "Encrypted link to the sender is up ✓");
      };
      dc.onerror = () => {
        if (doneRx || !(cur || pendingReq)) return; // no transfer in flight — nothing to worry about
        chat("sys", "⚠️ Data channel error — may still recover; watch progress.");
      };
      dc.onclose = () => {
        // Don't fail instantly. The sender rebuilds its link when a receiver
        // reloads, which closes this channel too — the request watchdog can
        // rebuild and re-ask, and ondatachannel re-requests an in-flight file.
        if ((cur || pendingReq) && !doneRx) {
          chat("sys", "The sender's channel closed — reconnecting…");
          linkRx().catch(() => {});
        }
      };
      // wantOne/dlAll put the request in pendingWants AND record it as pendingReq,
      // so flushing the queue and then re-issuing pendingReq sent the SAME request
      // twice on every rebuild — the sender queued the whole file list twice and
      // pushed the same bytes twice. Compare by identity, not by kind: `w` and
      // pendingReq.w are the same object only when it really is a duplicate.
      let flushedReq = false;
      for (const w of pendingWants.splice(0)) {
        dc.send(JSON.stringify(w));
        if (pendingReq && w === pendingReq.w) flushedReq = true;
      }
      // A transfer that was already in flight when the link was rebuilt needs its
      // request re-issued: the sender's old queue died with the old channel, so
      // waiting for it to finish a file nobody is asking for stalls forever.
      if (pendingReq && !cur && !flushedReq) { try { dc.send(JSON.stringify(pendingReq.w)); pendingReq.t0 = Date.now(); pendingReq.retried = false; } catch {} }
      // A transfer that was already streaming when the channel died has to be
      // re-requested too: the sender's queue died with the channel, so its bytes
      // will never resume and the download would sit frozen at the last chunk.
      if (cur && !doneRx && !broken) {
        const f = liveByFid(cur.fid);
        if (f) {
          got = 0; chunks = []; writer = null; useStream = false;
          rxHash = sha256New(); pendChunks = null;
          const w = { t: "want", fid: f.id, idx: rxFiles.indexOf(f) };
          try { dc.send(JSON.stringify(w)); } catch {}
          pendingReq = { fid: f.id, name: f.name, w, t0: Date.now(), retried: false };
          log.textContent = `Reconnecting — asking again for ${f.name}…`;
          chat("sys", `Link rebuilt — asking again for ${f.name}.`);
        }
      }
      dc.onmessage = e => {
        if (typeof e.data === "string") {
          const msg = JSON.parse(e.data);
          if (msg.t === "header") handleHeader(msg);
          else if (msg.t === "eof") handleEof(msg);
          return;
        }
        // Binary path is fully synchronous: WritableStream queues writes in order
        // internally, so awaiting per-chunk would only serialize (and can freeze
        // the ordered channel on a stuck disk write). Never await per-chunk.
        // Hashing is sync too, so the digest covers exactly what arrived.
        // No receive in flight (e.g. right after a cancel) — drop the bytes
        // instead of painting phantom progress on a dead transfer.
        if (!cur && !pendingReq) return;
        const nb = (e.data && e.data.byteLength) || 0;
        if (!broken && rxHash && nb) { try { rxHash.update(e.data); } catch { broken = true; } }
        if (useStream && writer && !broken) writer.write(e.data).catch(err => streamFail(err, rxGen));
        else if (!broken && writer === null && pendChunks) pendChunks.push(e.data);
        else if (!broken) chunks.push(e.data);
        got += nb; lastRx = Date.now();
        if (senderGoneT) { clearTimeout(senderGoneT); senderGoneT = 0; } // sender came back
        rxUi();
      };
    };
    log.textContent = "Signaling connected — waiting for sender's offer…";
  }
  // The one bit of feedback the sender gets about a file actually landing. Sent
  // only after the write finished, so it never lies about disk state. Declared as
  // a function (not a const arrow) so handleEof can call it whenever it fires.
  function sendAck(fid) {
    if (!rDc || rDc.readyState !== "open") return;
    try { rDc.send(JSON.stringify({ t: "ack", fid })); } catch {}
  }

  async function pickDir() {
    if (dirHandle || !window.showDirectoryPicker) return;
    try { dirHandle = await window.showDirectoryPicker({ mode: "readwrite" }); }
    catch { dirHandle = null; }
  }

  // The link dies when either side's tab reloads. A dead PC that still has an
  // object reference would swallow the want into pendingWants forever, so drop
  // it and build a fresh one before queueing anything.
  async function linkRx() {
    const dead = rPc && (
      (rDc && (rDc.readyState === "closed" || rDc.readyState === "closing")) ||
      rPc.connectionState === "failed" || rPc.connectionState === "closed"
    );
    if (dead) {
      chat("sys", "The link to the sender dropped — reconnecting…");
      try { rPc.close(); } catch {}
      rPc = null; rDc = null;
      lastRx = Date.now();
    }
    await ensureConn();
  }

  // Held because the sender was offline at click time. Released the moment
  // presence says they are back, so the receiver's single click is enough.
  // `held` is a Set of fids, not a queue: the receiver can hold several files,
  // and each is re-requested through the normal wantOne path on release.
  const held = new Set();
  function holdForSender(f) {
    const fid = f.id;
    if (held.has(fid) || savedFids.has(fid) || goneFids.has(fid)) return;
    held.add(fid);
    const b = rowBtn(fid);
    if (b) { b.textContent = "⏳"; b.disabled = true; }
    renderRx();
  }
  // A transfer the sender's freeze interrupted. Queued so it restarts by itself
  // when they come back.
  //
  // This is deliberately NOT the same as a click that never started: that one
  // stays manual, because the receiver's click was consent for a moment that has
  // passed, and a transfer starting itself minutes later is not what they asked
  // for. An interruption is different — bytes were already moving when the
  // sender's tab froze, so finishing it is finishing what they wanted.
  function queueResume(fid) {
    if (held.has(fid) || savedFids.has(fid) || goneFids.has(fid)) return;
    held.add(fid);
    const b = rowBtn(fid);
    if (b) { b.textContent = "⏳"; b.disabled = true; }
    chat("sys", "The sender's tab froze mid-transfer — this restarts by itself when they come back.");
  }
  // Called from the presence handler when senderOnline flips false→true.
  async function releaseHeld() {
    if (!held.size) return;
    // Filter BEFORE announcing. The old order printed "starting N requested
    // files" and then skipped the ones that had since been removed or saved, so
    // the receiver was told a restart was happening when nothing was.
    const ids = [...held].filter(fid => !savedFids.has(fid) && !goneFids.has(fid));
    held.clear();
    if (!ids.length) return;
    // Clear the previous attempt's verdict, exactly as handleHeader does. This is
    // NOT redundant with ensureConn: R20 shows that without it the watchdog and
    // the Cancel button both stay disabled for the whole restarted transfer,
    // because both are gated on !doneRx — a resume with no way to stop it and no
    // retry if it stalls again.
    doneRx = false; failed = false;
    chat("sys", `Sender is back — starting ${ids.length} requested file${ids.length > 1 ? "s" : ""}…`);
    for (const fid of ids) {
      await wantOne(fid);
      // The restart did not take — no WebRTC, the sender gone again, a rejected
      // offer. `held` was already cleared, so without this the file is simply
      // gone: the receiver clicked for it and there is nothing left to click.
      // Leave a manual Resume rather than dropping it or looping.
      //
      // `held` is the exception: wantOne puts a file BACK on the queue when the
      // sender's tab freezes again while the loop is still working through them,
      // and that produces no pendingReq either. Its row already shows the queued
      // ⏳, so treating it as a failure here replaced ⏳ with ↻ Resume while the
      // file was still on the auto-restart list — clickable, and started a second
      // time by the next return.
      if (!(pendingReq && pendingReq.fid === fid) && !held.has(fid)) {
        const b = rowBtn(fid);
        if (b && !savedFids.has(fid) && !goneFids.has(fid)) { b.textContent = "↻ Resume"; b.disabled = false; }
      }
    }
  }
  // Cancel must clear held requests too, or a cancelled file would start
  // downloading the instant the sender reconnected.
  function dropHeld() { held.clear(); }

  async function wantOne(fid) {
    const f = liveByFid(fid);
    if (!f) { toast("That file is no longer available"); renderRx(); return; }
    const btn = rowBtn(fid);
    // The sender is not connected. DO NOT refuse outright — hold the request and
    // release it when they come back, because the common cause is a mobile
    // sender whose tab was frozen while they were sharing the link, and they
    // reconnect automatically the moment they return. Refusing meant the
    // receiver had to notice, go back to the sender, and click Download a second
    // time by hand.
    if (!senderOnline) {
      chat("sys", `The sender isn't connected yet, so “${f.name}” is waiting. If they're on a phone this is normal — the app reconnects the moment they return to the tab.`);
      toast("Waiting for the sender…");
      holdForSender(f);
      return;
    }
    if (outstandingFids.has(fid) || pendingReq && pendingReq.fid === fid) { toast("Already requested"); return; }
    rxRequesting = true;
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    dlAll.disabled = true; // mixed single+all would double-count; pick one mode
    outstandingFids.add(fid);
    wantedFids.add(fid);
    recomputeWanted();
    try {
      await pickDir();
      // Presence can flip while the picker is up. Firing anyway would put the
      // want into a channel nobody is reading and fail 25s later, so re-check
      // rather than trusting the state from before the await.
      if (!senderOnline) {
        rxRequesting = false;
        chat("sys", `The sender isn't connected, so “${f.name}” didn't start. Nothing is downloading — tap Download again once they're back.`);
        toast("Sender not connected — nothing started");
        if (btn) { btn.textContent = "⚠ offline"; btn.disabled = false; }
        return;
      }
      await linkRx();
      undeliverDial();
      const w = { t: "want", fid, idx: rxFiles.indexOf(f) };
      if (rDc && rDc.readyState === "open") rDc.send(JSON.stringify(w));
      else pendingWants.push(w);
      pendingReq = { fid, name: f.name, w, t0: Date.now(), retried: false, deadline: Date.now() + REQ_DEADLINE_MS };
      chat("me", `Requested “${f.name}” — waiting for sender…`);
      if (btn) btn.textContent = "⏳";
    } catch (err) {
      // Anything thrown after the click was accepted must not strand the UI. Left
      // unhandled it stranded rxRequesting, which keeps Cancel on screen for good
      // with no transfer behind it — the same dead end this button was added to
      // remove. Give the row back and say what happened.
      outstandingFids.delete(fid);
      wantedFids.delete(fid);
      recomputeWanted();
      if (btn) { btn.textContent = "⬇"; btn.disabled = false; }
      chat("sys", `Could not start “${f.name}” — ${(err && err.message) || "unknown error"}. Try again.`);
    }
    rxRequesting = false;
  }
  dlAll.onclick = async () => {
    const live = rxFiles.filter(f => !goneFids.has(f.id) && !savedFids.has(f.id) && !outstandingFids.has(f.id));
    if (!live.length) return;
    // Same reasoning as wantOne: hold every outstanding file rather than
      // refusing. Download-all is the case a mobile sender hits most, because
      // they tap it the instant the link opens.
    if (!senderOnline) {
      chat("sys", "The sender isn't connected yet, so everything is waiting for them. If they're on a phone this is normal — it starts the moment they return to the tab.");
      toast("Waiting for the sender…");
      for (const f of live) holdForSender(f);
      renderRx();
      return;
    }
    dlAll.disabled = true;
    rxRequesting = true;
    rowEl.querySelectorAll(".dlOne").forEach(b => { b.disabled = true; });
    live.forEach(f => { outstandingFids.add(f.id); wantedFids.add(f.id); });
    recomputeWanted();
    try {
      await pickDir();
      // Same reasoning as wantOne: presence can flip while the picker is up.
      if (!senderOnline) {
        rxRequesting = false;
        chat("sys", "The sender isn't connected, so nothing was requested. Tap again once they're back — nothing is downloading yet.");
        toast("Sender not connected — nothing started");
        return;
      }
      await linkRx();
      undeliverDial();
      const w = { t: "wantAll" };
      if (rDc && rDc.readyState === "open") rDc.send(JSON.stringify(w));
      else pendingWants.push(w);
      pendingReq = { fid: null, name: `${live.length} file${live.length > 1 ? "s" : ""}`, w, t0: Date.now(), retried: false, deadline: Date.now() + REQ_DEADLINE_MS };
      chat("me", "Requested everything — waiting for sender…");
    } catch (err) {
      // Same reasoning as wantOne: never strand rxRequesting, never leave the
      // rows disabled with nothing behind them.
      live.forEach(f => { outstandingFids.delete(f.id); wantedFids.delete(f.id); });
      recomputeWanted();
      live.forEach(f => { const b = rowBtn(f.id); if (b) { b.textContent = "⬇"; b.disabled = false; } });
      chat("sys", `Could not start the download — ${(err && err.message) || "unknown error"}. Try again.`);
    }
    rxRequesting = false;
  };
  // Cancel: visible only while a download is actually going on. Tears the peer
  // connection down — the sender stops on channel close and rebuilds on the next
  // request (the same path a tab reload takes) — and returns every requested row
  // to retryable. Never half-saves, never leaves a frozen bar.
  const cancelBtn = document.getElementById("rxCancel");
  if (cancelBtn) {
    cancelBtn.onclick = () => { cancelRx(); };
    setInterval(() => { cancelBtn.hidden = !((rxRequesting || cur || pendingReq || held.size) && !doneRx); }, 400);
  }
  function cancelRx() {
    // A cancel with nothing in flight is meaningful now: it also drops requests
    // held for an offline sender, otherwise a cancelled file would start
    // downloading the instant they reconnected — and clears rxRequesting, or a
    // click still waiting on the directory picker would stay un-cancellable.
    if (!((rxRequesting || cur || pendingReq || held.size) && !doneRx)) return;
    rxRequesting = false;
    sfx("pop");
    const name = (cur && cur.name) || (pendingReq && pendingReq.name) || "the queued download";
    if (held.size) {
      const n = held.size;
      const ids = [...held];
      dropHeld();
      ids.forEach(fid => wantedFids.delete(fid));
      recomputeWanted();
      for (const fid of [...(rxFiles.map(f => f.id))]) {
        if (savedFids.has(fid) || goneFids.has(fid)) continue;
        const b = rowBtn(fid);
        if (b) { b.textContent = "⬇"; b.disabled = false; }
      }
      chat("sys", `Cancelled ${n} waiting file${n > 1 ? "s" : ""} — nothing was saved.`);
      toast("Cancelled the queued download");
      document.getElementById("peerHint").textContent = "cancelled — retry anytime";
      log.textContent = `Cancelled ${n} queued file${n > 1 ? "s" : ""} — nothing was saved.`;
      return;
    }
    pendingWants = [];
    pendingReq = null;
    clearTimeout(senderGoneT); senderGoneT = 0; // a pending offline-grace verdict is moot — *we* stopped
    for (const fid of [...outstandingFids]) {
      outstandingFids.delete(fid);
      const b = rowBtn(fid);
      if (b && !savedFids.has(fid) && !goneFids.has(fid)) {
        b.textContent = "⬇"; b.disabled = false;
        // rxUi rewrites this cell with live "X of Y · N%" while streaming —
        // put the plain size back so a cancelled row doesn't wear stale progress.
        const rfr = b.closest(".frow");
        const fsz = rfr && rfr.querySelector(".fsize");
        const f = rxFiles.find(x => x.id === fid);
        if (fsz && f) fsz.textContent = fmt(f.size);
      }
    }
    wantedFids.clear();
    wantedCount = 0; wantedTotal = 0; receivedCount = 0; fileDone = 0; got = 0;
    bar.value = 0; setRadial(0); setStats(0, 0, 0); // progress is per-attempt: a cancel restarts it
    chunks = []; broken = false; rxHash = null;
    rxGen++; // a writer setup still spinning up belongs to the cancelled attempt
    for (const k in lateBroken) delete lateBroken[k];
    pendChunks = null;
    if (useStream && writer) { try { writer.abort(); } catch {} writer = null; }
    useStream = false;
    const cfid = cur ? cur.fid : (pendingReq ? pendingReq.fid : null);
    markActive(cfid, false);
    cur = null;
    // Tell the sender to stop pushing — the link stays open, so a retry is instant.
    try { if (rDc && rDc.readyState === "open") rDc.send(JSON.stringify({ t: "cancel" })); } catch {}
    lastCancelT = Date.now();
    lastRx = Date.now();
    const dl = document.getElementById("dl");
    if (dl) dl.disabled = !rxFiles.some(f => !goneFids.has(f.id) && !savedFids.has(f.id));
    document.getElementById("peerHint").textContent = "cancelled — retry anytime";
    log.textContent = `Cancelled ${name} — nothing was saved.`;
    chat("sys", `Cancelled “${name}” ✕ — nothing was saved. Press Download to retry.`);
    toast("Download cancelled");
    setPipeState("waiting", "Cancelled — press Download to retry");
  }
  // Join the room immediately so live file removals reach us before any click.
  renderRx();
  ensureSignal();
}

// ---------- chrome: sound toggle, reveal, tilt, log clear (no transfer logic) ----------
function initChrome() {
  // Reload must not drift. Two things conspired to move the page on every
  // refresh: the browser restores the previous scroll position, and
  // `html { scroll-behavior: smooth }` turns that restoration into an animated
  // scroll which then settled well short of where it started (measured: 908 ->
  // 368, crawling 9 -> 290 -> 362 -> 368). "manual" disables the browser's own
  // restoration entirely, so a refresh reliably starts at the top instead of
  // drifting to somewhere the user never asked for. There is nothing to
  // restore to: this app has no deep-linkable scroll state — a room lives in
  // its own URL, and a reload of /r/<id> re-joins it from scratch.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  // sound toggle (all .soundBtn share one persisted setting)
  const paintSound = () => {
    const on = soundOn();
    document.querySelectorAll(".soundBtn").forEach(b => {
      b.setAttribute("aria-pressed", on ? "true" : "false");
      if (b.classList.contains("term-btn")) b.textContent = on ? "♪ sound" : "♪ muted";
      else b.textContent = "♪";
      b.setAttribute("data-tip", on ? "Sound on" : "Sound off");
    });
  };
  document.querySelectorAll(".soundBtn").forEach(b => {
    b.onclick = e => {
      e.preventDefault();
      const on = !soundOn();
      setSoundOn(on);
      paintSound();
      if (on) sfx("pop");
      toast(on ? "Sound on ♪" : "Sound off");
    };
  });
  paintSound();
  // Preconnect to the signal backend while the browser is still idle: with a
  // split deployment (Pages + own server) the first API call otherwise pays
  // DNS + TLS + TCP on the critical interaction path.
  if (SIGBASE) {
    try {
      const u = new URL(SIGBASE);
      if (u.host !== location.host) {
        const l = document.createElement("link");
        l.rel = "preconnect";
        l.href = u.origin;
        l.crossOrigin = "anonymous";
        document.head.appendChild(l);
      }
    } catch {}
  }
  // Reveal-on-scroll is deferred to idle: it is a pure visual nicety, and
  // observing + forcing layout during first paint is not free.
  onIdle(() => {
    try {
      const els = [...document.querySelectorAll(".rv")];
      if ("IntersectionObserver" in window && els.length) {
        const io = new IntersectionObserver(es => {
          es.forEach(en => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
        }, { threshold: 0.08 });
        els.forEach(el => io.observe(el));
        setTimeout(() => els.forEach(el => el.classList.add("in")), 2500); // fail-open
      } else els.forEach(el => el.classList.add("in"));
    } catch {}
  });
  // clear log (terminal)
  const clr = document.getElementById("clearLog");
  if (clr) clr.onclick = () => {
    const c = document.getElementById("chat");
    if (c) c.innerHTML = `<div class="msg sys">log cleared — listening…</div>`;
    sfx("pop");
  };
  // The backend-host pill was removed on purpose. It named the signalling host
  // in the nav, which is deployment plumbing: it told every visitor which
  // backend this site is split across, added a dot that read as a connection
  // status, and kept a /healthz probe running on a 30s timer forever — all for
  // information no visitor can act on.
  //
  // Backend resolution is unaffected. ensureBackend() already runs once during
  // boot (see the initChrome caller) before the sender/receiver initialise, so
  // the address settles either way; this block only *displayed* the result and
  // re-asked for it. An operator debugging a wrong backend reads it from the
  // build config, not the nav bar.
  // Background prefetch: the QR encoder (12KB gz) is needed only when the
  // SENDER creates a room — typically seconds later — so pull it in during
  // idle time. The receiver never renders a QR, so it never fetches it.
  if (document.getElementById("drop")) onIdle(() => { qrReady().catch(() => {}); });
  // Service worker: static assets only — never documents, API or WebSockets. It
  // is network-first, so it repeats no work on a repeat visit; it exists so a
  // cached asset is available if the network fails mid-session. There is no
  // offline shell.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    onIdle(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
  // hide the "no room yet" hint once a room exists
  const room = document.getElementById("room"), empty = document.getElementById("roomEmpty");
  if (room && empty) {
    const sync = () => { empty.hidden = !room.hidden; };
    sync();
    try { new MutationObserver(sync).observe(room, { attributes: true, attributeFilter: ["hidden"] }); } catch {}
  }
  // subtle 3D tilt on the dropzone (pointer only, reduced-motion safe)
  const drop = document.getElementById("drop");
  if (drop && !RM && matchMedia("(pointer:fine)").matches) {
    let raf = 0;
    drop.addEventListener("pointermove", e => {
      if (drop.classList.contains("compact")) return;
      const r = drop.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        drop.style.transform = `perspective(900px) rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 4).toFixed(2)}deg)`;
      });
    });
    drop.addEventListener("pointerleave", () => {
      cancelAnimationFrame(raf);
      drop.style.transform = "";
    });
  }
  // copy / add / download pops (delegated, never interferes with transfer)
  document.addEventListener("click", e => {
    const t = e.target.closest && e.target.closest("#copy,#nativeShare,#addBtn,#dl,.dlOne,#rxCancel");
    if (t) sfx(t.id === "copy" ? "copy" : "pop");
  });
}

// ---------- howviz: animated "how files move" diagram (index only, no transfer logic) ----------
// Three SMIL-driven lanes inside one SVG: dotted signaling via the server, a link
// token arcing sender→receiver, and file chips on the direct beam. Geometry is
// MEASURED from the real node positions (layout()), so lanes always connect —
// never guessed viewBox coordinates. JS steps the data-phase state machine
// (autoplay + controls + byte meters); the motion itself is declarative.
function initHowviz() {
  const root = document.getElementById("how");
  if (!root || !root.classList.contains("howviz")) return;
  const stage = document.getElementById("howStage"), svg = document.getElementById("howSvg");
  const sender = document.getElementById("howSender"), receiver = document.getElementById("howReceiver");
  const server = document.getElementById("howServer");
  const sigL = root.querySelector("#howSigL"), sigR = root.querySelector("#howSigR");
  const beam = root.querySelector("#howBeam"), linkArc = root.querySelector("#howLinkArc");
  const sigTag = document.getElementById("howSigTag"), beamTag = document.getElementById("howBeamTag");
  const capT = document.getElementById("howCapT"), capD = document.getElementById("howCapD");
  const mid = document.getElementById("howMid"), srv = document.getElementById("howSrvState");
  const meterP2P = document.getElementById("howMeterP2P");
  const playBtn = document.getElementById("howPlay");
  const dots = [...root.querySelectorAll(".how-dots button")];
  const steps = [...root.querySelectorAll(".how-steps li")];
  const CAPS = {
    1: ["You pick files", "They never leave your device. Creating the room mints a private link + 4-digit nearby code — the server stores the file list, never the bytes.", "🔒 files stay put", "idle"],
    2: ["You send the link", "QR, copy, or native share — outside this page, by you. The receiver opens it and the two browsers introduce themselves through the server: SDP offer/answer + ICE candidates, a few hundred bytes.", "✉️ link flies to them", "introducing…"],
    3: ["Browsers connect directly", "Shortest path — sometimes never leaving the building — 256 KB chunks over an encrypted DataChannel, straight to their disk. Watch the meters: the server counter never moves.", "⚡ encrypted stream", "idle · 0 bytes"],
  };
  let phase = 1, playing = !RM, visible = true, timer = 0, meterT = 0, mb = 0;
  // Measure real boxes and draw lanes between them. viewBox is set to exact
  // stage pixels (1:1), so strokes stay crisp and circles stay circular.
  function layout() {
    if (!stage || !svg || !sender || !receiver || !server) return;
    const sr = stage.getBoundingClientRect();
    if (sr.width < 10 || sr.height < 10) return;
    const rel = el => {
      const r = el.getBoundingClientRect();
      return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height };
    };
    const S = rel(sender), R = rel(receiver), V = rel(server);
    const f = n => Math.round(n * 10) / 10;
    svg.setAttribute("viewBox", `0 0 ${f(sr.width)} ${f(sr.height)}`);
    // signaling: node top-centers rise to the server pill's underside
    const sTop = [S.x + S.w / 2, S.y + 2], rTop = [R.x + R.w / 2, R.y + 2];
    const vBase = V.y + V.h, vL = V.x + V.w * 0.32, vR = V.x + V.w * 0.68;
    const lift = Math.max(30, (sTop[1] - vBase) * 0.55);
    if (sigL) sigL.setAttribute("d", `M${f(sTop[0])},${f(sTop[1])} C${f(sTop[0])},${f(sTop[1] - lift)} ${f(vL)},${f(vBase + 8)} ${f(vL)},${f(vBase)}`);
    if (sigR) sigR.setAttribute("d", `M${f(rTop[0])},${f(rTop[1])} C${f(rTop[0])},${f(rTop[1] - lift)} ${f(vR)},${f(vBase + 8)} ${f(vR)},${f(vBase)}`);
    // file lanes: facing edges at node mid-height; link arc flies higher
    const a = [S.x + S.w - 2, S.y + S.h * 0.44], b = [R.x + 2, R.y + R.h * 0.44];
    const sag = Math.max(14, Math.abs(b[0] - a[0]) * 0.04);
    if (beam) beam.setAttribute("d", `M${f(a[0])},${f(a[1])} C${f(a[0] + 90)},${f(a[1] + sag)} ${f(b[0] - 90)},${f(b[1] + sag)} ${f(b[0])},${f(b[1])}`);
    const hop = Math.max(60, Math.abs(b[0] - a[0]) * 0.22);
    if (linkArc) linkArc.setAttribute("d", `M${f(a[0])},${f(a[1] - 26)} C${f(a[0] + 120)},${f(Math.min(a[1], b[1]) - hop)} ${f(b[0] - 120)},${f(Math.min(a[1], b[1]) - hop)} ${f(b[0])},${f(b[1] - 26)}`);
    // lane tags sit on the lines they describe
    if (sigTag) {
      sigTag.style.left = f((sTop[0] + vL) / 2 - 14) + "px";
      sigTag.style.top = f((sTop[1] + vBase) / 2 - 6) + "px";
    }
    if (beamTag) {
      beamTag.style.left = f((a[0] + b[0]) / 2) + "px";
      beamTag.style.top = f((a[1] + b[1]) / 2 + sag + 22) + "px";
    }
  }
  const paintPlay = () => {
    if (!playBtn) return;
    playBtn.textContent = playing ? "⏸" : "▶";
    playBtn.setAttribute("aria-pressed", playing ? "true" : "false");
    playBtn.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
  };
  const syncSmil = () => {
    try {
      if (!svg) return;
      if (RM || !playing) svg.pauseAnimations();
      else svg.unpauseAnimations();
    } catch {}
  };
  const paintMeters = () => {
    if (meterP2P) meterP2P.textContent = mb < 1000 ? mb.toFixed(1) + " MB" : (mb / 1000).toFixed(2) + " GB";
  };
  function setPhase(n, user) {
    phase = n < 1 ? 3 : n > 3 ? 1 : n;
    root.dataset.phase = String(phase);
    const [t, d, m, s] = CAPS[phase];
    if (capT) capT.textContent = t;
    if (capD) capD.textContent = d;
    if (mid) mid.textContent = m;
    if (srv) srv.textContent = s;
    if (phase === 1) { mb = 0; paintMeters(); }
    dots.forEach(b => b.setAttribute("aria-selected", String(Number(b.dataset.how) === phase)));
    steps.forEach(li => {
      const on = Number(li.dataset.how) === phase;
      li.classList.toggle("on", on);
      li.setAttribute("aria-selected", String(on));
    });
    if (user) sfx("pop");
  }
  const next = () => setPhase(phase + 1, true);
  const prev = () => setPhase(phase - 1, true);
  const hook = (el, fn) => { if (el) el.addEventListener("click", e => { e.preventDefault(); fn(); }); };
  hook(document.getElementById("howNext"), next);
  hook(document.getElementById("howPrev"), prev);
  hook(playBtn, () => { playing = !playing; paintPlay(); syncSmil(); });
  dots.forEach(b => b.addEventListener("click", () => setPhase(Number(b.dataset.how), true)));
  steps.forEach(li => {
    li.addEventListener("click", () => setPhase(Number(li.dataset.how), true));
    li.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPhase(Number(li.dataset.how), true); }
    });
  });
  document.addEventListener("keydown", e => {
    if (!root.classList.contains("in")) return;
    if (e.key === "ArrowRight" && document.activeElement && root.contains(document.activeElement)) next();
    if (e.key === "ArrowLeft" && document.activeElement && root.contains(document.activeElement)) prev();
  });
  try {
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(es => {
        visible = es.some(en => en.isIntersecting);
        if (visible) layout();
      }, { threshold: 0.15 }).observe(root);
    }
  } catch {}
  try {
    if ("ResizeObserver" in window && stage) new ResizeObserver(() => layout()).observe(stage);
    else window.addEventListener("resize", layout);
  } catch {}
  document.addEventListener("visibilitychange", () => { if (document.hidden) { try { svg && svg.pauseAnimations(); } catch {} } else syncSmil(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => layout()).catch(() => {});
  setTimeout(layout, 600); // late fonts / theme settle
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (playing && visible && !document.hidden) setPhase(phase + 1); }, 4200);
  if (meterT) clearInterval(meterT);
  // the proof, ticking: ~38 MB/s direct while phase 3 is live, server stays 0 B
  meterT = setInterval(() => {
    if (phase === 3 && playing && visible && !document.hidden && !RM) { mb += 5.7; paintMeters(); }
  }, 150);
  setPhase(1);
  paintPlay();
  syncSmil();
  layout();
}

// ---------------------------------------------------------------------------
// Boot. app.js is loaded with `defer`, so it runs after the HTML is parsed but
// WITHOUT blocking first paint — the browser paints the shell (HTML + styles.css)
// while this file is still downloading. Each init is page-scoped: the sender page
// has #drop, the receiver page has #box, so a single bundle serves both.
// (Guarded on document.readyState so the Node test harness, which calls the
// init* functions directly against a stub document, never auto-boots.)
// ---------------------------------------------------------------------------
(function boot() {
  if (typeof document === "undefined" || typeof document.readyState !== "string") return;
  const run = () => {
    try { initTheme(); } catch (e) { console.error("theme", e); }
    try { initChrome(); } catch (e) { console.error("chrome", e); }
    // Resolve the live backend address BEFORE initialising the sender/receiver,
    // because both may create server-side state on their first user action. The
    // fetch is capped at 4s and falls back to the baked value, so this can
    // delay the UI by at most one bad network round-trip — and only when the
    // config host is unreachable.
    const ready = ensureBackend();
    try { if (document.getElementById("drop")) initSender(); } catch (e) { console.error("sender", e); }
    try { if (document.getElementById("box")) initReceiver(); } catch (e) { console.error("receiver", e); }
    try { if (document.getElementById("how")) initHowviz(); } catch (e) { console.error("howviz", e); }
    // Expose the awaitable so tests (and any future caller) can assert the
    // address has settled without reaching into module internals.
    window.__backendReady = ready;
  };
  // defer + DOMContentLoaded both land after parsing; run now if already past it.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();

