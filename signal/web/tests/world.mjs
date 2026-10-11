// Shared fake-browser world for app.js harnesses (imported by test scripts).
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// P2PFILESHARING_APP_SRC overrides the app.js under test (absolute path). It exists
// so the cancel + integrity harnesses can run against the MINIFIED build
// output, not just the readable source: a minifier misparse fails loudly here
// instead of in production. Default (and CI) path is unchanged.
const APP_SRC = fs.readFileSync(
  process.env.P2PFILESHARING_APP_SRC || join(dirname(fileURLToPath(import.meta.url)), "..", "app.js"), "utf8");

// ---------------------------------------------------------------- fake clock
function cssEscapeStr(s) {
  const v = String(s);
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(v);
  return v.replace(/[^a-zA-Z0-9_-]/g, c => "\\" + c);
}

export function makeClock() {
  const realImmediate = setImmediate;
  let now = 1_000_000, seq = 1;
  const timers = new Map();
  const api = {
    now: () => now,
    setTimeout(cb, ms = 0, ...a) { const id = seq++; timers.set(id, { cb, args: a, t: now + ms, rep: 0 }); return id; },
    setInterval(cb, ms = 0, ...a) { const id = seq++; timers.set(id, { cb, args: a, t: now + ms, rep: ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    rafQ: [],
    requestAnimationFrame(cb) { api.rafQ.push(cb); return api.rafQ.length; },
    runRaf() { const q = api.rafQ.splice(0); for (const cb of q) { try { cb(now); } catch (e) { api.errors.push(e); } } },
    errors: [],
    async flush(n = 40) { for (let i = 0; i < n; i++) { await new Promise(r => realImmediate(r)); api.runRaf(); } if (api.errors.length) throw api.errors[0]; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let best = null, bestId = 0;
        for (const [id, t] of timers) if (t.t <= end && (best === null || t.t < best.t)) { best = t; bestId = id; }
        if (!best) break;
        now = best.t;
        if (best.rep) best.t = now + best.rep; else timers.delete(bestId);
        await best.cb(...best.args);
        await api.flush();
      }
      now = end;
      await api.flush();
    },
    destroy() { timers.clear(); api.rafQ.length = 0; },
  };
  return api;
}

// ---------------------------------------------------------------- fake DOM
// Supports exactly the selector forms the app emits: a single class, optionally
// followed by one [data-x="..."] attribute. The attribute VALUE must understand
// CSS backslash escapes, because app.js runs peer-controlled file ids through
// CSS.escape before building the selector — a matcher that stopped at the first
// quote could not find a row whose id contains one, which would have hidden the
// escaping entirely.
function matchSel(el, sel) {
  const m = sel.match(/^\.([A-Za-z0-9_-]+)(?:\[data-([A-Za-z0-9_-]+)="((?:\\.|[^"\\])*)"\])?$/);
  if (m) {
    if (!el.classList || !el.classList.contains(m[1])) return false;
    if (m[2]) {
      const k = m[2].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      // Unescape \X -> X, the only escape form CSS.escape produces here.
      const want = m[3].replace(/\\(.)/g, "$1");
      return String((el.dataset || {})[k] ?? "") === want;
    }
    return true;
  }
  return false;
}
function queryAll(root, sel) {
  const out = [];
  const walk = n => { for (const c of (n.children || [])) { if (matchSel(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}
// Attributes are HTML-escaped when written into innerHTML, so a value
// containing a quote arrives as &quot;. A real browser decodes entities on
// attribute read; without that, a row built from a file id containing a quote
// stored the literal entity text and could never match a selector built from the
// raw id — which hid the escaping fix from the tests entirely.
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot);/g, (_, e) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    }
    return _;
  });
}

function stubFromHtml(html) {
  const el = makeEl("");
  const mCls = html.match(/class="([^"]*)"/);
  for (const c of (mCls ? mCls[1].split(/\s+/) : []).filter(Boolean)) el.classList.add(c);
  const mDs = html.match(/data-([a-z]+)="([^"]*)"/);
  if (mDs) el.dataset[mDs[1]] = decodeEntities(mDs[2]);
  el.textContent = decodeEntities(html.replace(/<[^>]*>/g, ""));
  return el;
}
function parseRows(rowEl, html) {
  rowEl.children = [];
  for (const part of html.split('<div class="frow">').slice(1)) {
    const frow = makeEl(""); frow.classList.add("frow"); frow.parent = frow.parentElement = rowEl;
    const mSize = part.match(/<div class="fsize">([\s\S]*?)<\/div>/);
    const fsize = makeEl(""); fsize.classList.add("fsize");
    fsize.textContent = mSize ? mSize[1] : ""; fsize.parent = fsize.parentElement = frow;
    frow.children.push(fsize);
    const mBtn = part.match(/<button([^>]*)>([\s\S]*?)<\/button>/);
    if (mBtn) {
      const btn = makeEl(""); btn.parent = btn.parentElement = frow;
      const mCls = mBtn[1].match(/class="([^"]*)"/);
      for (const c of (mCls ? mCls[1].split(/\s+/) : []).filter(Boolean)) btn.classList.add(c);
      const mFid = mBtn[1].match(/data-fid="([^"]*)"/);
      if (mFid) btn.dataset.fid = decodeEntities(mFid[1]);
      btn.disabled = /\bdisabled\b/.test(mBtn[1]);
      btn.textContent = mBtn[2];
      frow.children.push(btn);
    }
    rowEl.children.push(frow);
  }
}
function makeEl(id) {
  const el = {
    id, children: [], parent: null, parentElement: null,
    _html: "", textContent: "", value: "", disabled: false, hidden: false,
    dataset: {}, style: { setProperty() {} }, scrollTop: 0, scrollHeight: 0, offsetWidth: 0,
    _cls: new Set(), _listeners: {},
    get className() { return [...this._cls].join(" "); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    classList: null,
    addEventListener(t, f) { (this._listeners[t] ??= []).push(f); },
    removeEventListener(t, f) { const a = this._listeners[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } },
    appendChild(ch) { ch.parent = ch.parentElement = this; this.children.push(ch); return ch; },
    get firstChild() { return this.children[0] || null; },
    remove() { const p = this.parent; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); this.parent = this.parentElement = null; } },
    set innerHTML(h) { this._html = h; parseRows(this, h); },
    get innerHTML() { return this._html; },
    set outerHTML(h) { const n = stubFromHtml(h); const p = this.parent; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children[i] = n; n.parent = n.parentElement = p; } this.parent = this.parentElement = null; },
    insertAdjacentHTML(pos, h) { const n = stubFromHtml(h); const p = this.parent; if (p && pos === "beforebegin") { const i = p.children.indexOf(this); p.children.splice(i < 0 ? p.children.length : i, 0, n); n.parent = n.parentElement = p; } },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
    closest(sel) { let n = this; while (n) { if (matchSel(n, sel)) return n; n = n.parent; } return null; },
    contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parent; } return false; },
    click() {}, focus() {},
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 }; },
    getContext() { return null; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._cls.add(x)),
    remove: (...c) => c.forEach(x => el._cls.delete(x)),
    toggle: (c, f) => { if (f === undefined) f = !el._cls.has(c); f ? el._cls.add(c) : el._cls.delete(c); return f; },
    contains: c => el._cls.has(c),
  };
  return el;
}

// ---------------------------------------------------------------- world
// siteUrl: window.SIGNAL_SITE_URL, the origin a shared link must use. Empty
//          models a build that never baked one (single-origin web deploy).
// roomUrl: what POST /api/rooms returns. Production sends an ABSOLUTE url built
//          from its own PUBLIC_BASE_URL when that is set, which on a split
//          deployment names the API host — the exact case that made every share
//          link 404. A relative value models a server with no base URL set.
export function newWorld({ pathname = "/r/ROOM1", meta = null, siteUrl = "", roomUrl = "/r/ROOM9" } = {}) {
  const clock = makeClock();
  const els = new Map();
  const pipeTrack = makeEl("");
  const getEl = id => {
    if (!els.has(id)) {
      const e = makeEl(id);
      if (id === "pipe") e.querySelector = () => pipeTrack;
      els.set(id, e);
    }
    return els.get(id);
  };
  const wsList = [], pcList = [];
  // Anonymous success deltas app.js posts to /api/usage, in order.
  const usageLog = [];
  const roomMeta = meta || { files: [], senderOnline: true };

  // A real WebSocket fires `onopen` once the handshake completes, and app.js now
  // decides "I rejoined the room" from exactly that callback (the sender's
  // reconnect backoff resets there and nowhere else). A stub that never fired it
  // left the whole success path unexercised — the same class of lie as the
  // bufferedAmount: 0 default.
  //
  // `open`/`fail` are the two transitions a test drives, because timing them is
  // the point: a socket that opens and is then refused (close 4400) must NOT
  // count as a successful rejoin, and only an explicit sequence can show that.
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; wsList.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    // handshake completed
    open() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      if (this.onopen) { try { this.onopen({}); } catch (e) { sandboxErrors.push(e); } }
    }
    // handshake or connection failed; `code` is the close code a real socket
    // would report (4400 = duplicate peer, 1006 = abnormal/abandoned)
    fail(code = 1006) {
      this.readyState = 3;
      if (this.onclose) { try { this.onclose({ code }); } catch (e) { sandboxErrors.push(e); } }
    }
  }
  // bufferedAmount must be RAISABLE by a test and must emit
  // bufferedamountlow when it drains, otherwise app.js's backpressure gate
  // (waitDrain) can never be exercised — mutating that call away still passed
  // 19/19 + 13/13, which is how the 225MB-wedge regression stayed invisible.
  function makeDC() {
    let buffered = 0, lowAt = 0;
    const dc = {
      readyState: "open", binaryType: "", bufferedAmountLowThreshold: 0,
      _l: {}, onopen: null, onclose: null, onerror: null, onmessage: null,
      sent: [],
      get bufferedAmount() { return buffered; },
      set bufferedAmount(v) {
        buffered = v;
        if (buffered <= lowAt) {
          for (const f of (this._l.bufferedamountlow || []).slice()) f({ type: "bufferedamountlow" });
        }
      },
      // Test hooks: simulate a peer that stops reading.
      fillBuffer(v) { this.bufferedAmount = v; },
      drainBuffer(v = 0) { this.bufferedAmountLowThreshold = 0; this.bufferedAmount = v; },
      addEventListener(t, f) { (this._l[t] ??= []).push(f); },
      removeEventListener(t, f) { const a = this._l[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } },
      send(d) {
        if (this.readyState !== "open") throw new DOMExceptionish("RTCDataChannel.readyState is not 'open'");
        this.sent.push(d);
        // A real channel delivers binary as a Blob until binaryType is set to
        // "arraybuffer"; app.js sets it explicitly, and the stub must honour
        // that so removing the line cannot pass unnoticed.
        if (typeof d !== "string" && this.binaryType !== "arraybuffer") {
          this._lastDeliveredAsBlob = true;
        }
        if (this._hook) this._hook(d);
      },
      close() { this.readyState = "closed"; },
    };
    return dc;
  }
  class DOMExceptionish extends Error { }
  class FakePC {
    constructor() {
      this.iceConnectionState = "new"; this.connectionState = "new"; this.signalingState = "stable";
      this._l = {}; this.dc = null; pcList.push(this);
    }
    addEventListener(t, f) { (this._l[t] ??= []).push(f); }
    // fire must invoke the on<event> PROPERTY as well as listeners registered via
    // addEventListener. app.js assigns pc.onnegotiationneeded = ... and
    // pc.onicecandidate = ..., which are plain properties; a stub that only
    // replayed _l silently never ran sendOfferRx, so the glare tests exercised a
    // state the test had forced by hand and proved nothing. Same class of lie as
    // the bufferedAmount: 0 default and the missing onopen.
    fire(t) {
      const ev = { type: t, target: this };
      const h = this["on" + t];
      if (typeof h === "function") { try { h.call(this, ev); } catch (e) { sandboxErrors.push(e); } }
      for (const f of (this._l[t] || [])) { try { f.call(this, ev); } catch (e) { sandboxErrors.push(e); } }
    }
    createDataChannel() { this.dc = makeDC(); return this.dc; }
    async createOffer() { return { type: "offer", sdp: "x" }; }
    async createAnswer() { return { type: "answer", sdp: "y" }; }
    async setLocalDescription(d) { this.signalingState = d.type === "offer" ? "have-local-offer" : "stable"; }
    async setRemoteDescription() { this.signalingState = "stable"; }
    async addIceCandidate() {}
    async restartIce() {}
    async getStats() { return { forEach() {}, get() { return null; } }; }
    close() { this.connectionState = "closed"; }
  }

  const sandbox = {
    console, URLSearchParams,
    Blob: globalThis.Blob,
    // The app reads Date.now() for every timeout/watchdog computation, so the
    // fake clock must own it too — otherwise advances never trip thresholds.
    // (new Date() keeps real wall time; only chat timestamps use it.)
    Date: class extends Date { static now() { return clock.now(); } },
    // A real URL constructor, plus the two blob statics app.js calls. Replacing
    // the global with a plain object made every `new URL(...)` in app.js throw
    // "not a constructor", which the code then swallowed in a try/catch — so a
    // genuine parsing bug would have been invisible here. Extending the real
    // class keeps both behaviours.
    URL: Object.assign(class extends globalThis.URL {}, {
      createObjectURL: () => "blob:fake",
      revokeObjectURL() {},
    }),
    performance: globalThis.performance,
    crypto: globalThis.crypto,
    innerWidth: 1280, innerHeight: 800,
    location: { pathname, search: "", protocol: "http:", host: "t", origin: "http://t", href: "http://t" + pathname },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: cb => clock.requestAnimationFrame(cb),
    setTimeout: (...a) => clock.setTimeout(...a),
    clearTimeout: id => clock.clearTimeout(id),
    setInterval: (...a) => clock.setInterval(...a),
    clearInterval: id => clock.clearInterval(id),
    WebSocket: FakeWS,
    RTCPeerConnection: FakePC,
    RTCSessionDescription: class { constructor(o) { Object.assign(this, o); } },
    RTCIceCandidate: class { constructor(o) { Object.assign(this, o); } },
    window: null, document: null, navigator: {},
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u === "/api/usage") { usageLog.push(JSON.parse(String(opts.body || "{}")).n); return { ok: true, status: 204, json: async () => ({}) }; }
      if (u === "/api/rooms" && opts.method === "POST") return { ok: true, status: 201, json: async () => ({ id: "ROOM9", nearby: "1234", url: roomUrl }) };
      if (/\/api\/rooms\/[^/]+\/turn$/.test(u)) return { ok: true, status: 200, json: async () => ({ iceServers: [{ urls: "stun:x" }] }) };
      if (/\/api\/rooms\/[^/]+$/.test(u)) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(roomMeta)) };
      if (u.startsWith("/api/nearby/")) return { ok: false, status: 404, json: async () => ({}) };
      throw new Error("unexpected fetch " + u);
    },
    qrcode: () => ({ addData() {}, make() {}, createSvgTag: () => "<svg></svg>" }),
  };
  const bodyEl = makeEl("body"), htmlEl = makeEl("html");
  // app.js reads window.SIGNAL_SITE_URL at evaluation time, so it must be set
  // before initSender/initReceiver runs — not later.
  // Real event registration for window and document. The mobile reconnect path
  // hangs entirely off visibilitychange / pageshow / focus / online, so a stub
  // with no-op listeners made the whole recovery path untestable — the same
  // class of lie as the bufferedAmount: 0 default.
  const winL = {}, docL = {};
  const on = (bag) => (t, f) => { (bag[t] ??= []).push(f); };
  const fire = (bag, t, ev = {}) => { for (const f of (bag[t] || []).slice()) { try { f(ev); } catch (e) { sandboxErrors.push(e); } } };
  const sandboxErrors = [];
  sandbox.window = { addEventListener: on(winL), location: sandbox.location, dispatchEvent: () => true };
  if (siteUrl) sandbox.window.SIGNAL_SITE_URL = siteUrl;
  sandbox.hidden = false;
  sandbox.document = {
    getElementById: getEl,
    createElement: () => makeEl(""),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: on(docL),
    body: bodyEl, documentElement: htmlEl,
    get hidden() { return sandbox.hidden; },
    get visibilityState() { return sandbox.hidden ? "hidden" : "visible"; },
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });

  const chatEl = () => getEl("chat");
  const api = {
    clock, els: getEl, wsList, pcList,
    // Drive the visibility cycle the way a mobile browser does: background the
    // tab (JS freezes, socket dies), then bring it back.
    hide: () => { sandbox.hidden = true; fire(docL, "visibilitychange", {}); },
    show: () => { sandbox.hidden = false; fire(docL, "visibilitychange", {}); fire(winL, "pageshow", {}); fire(winL, "focus", {}); },
    fireVisibility: () => { sandbox.hidden = false; fire(docL, "visibilitychange", {}); fire(winL, "pageshow", {}); fire(winL, "focus", {}); },
    // Drive document-level listeners the way real dispatch does. app.js
    // registers keydown/paste on document (type-anywhere code capture), and the
    // stub has no bubbling — so tests deliver the event object directly, exactly
    // as fireVisibility does for visibilitychange.
    fireDoc: (t, ev = {}) => { fire(docL, t, ev); },
    errors: sandboxErrors,
    chat: () => chatEl().children.map(c => c.textContent),
    toast: () => getEl("toast").textContent,
    log: () => getEl("log").textContent,
    peerHint: () => getEl("peerHint").textContent,
    bar: () => getEl("bar").value,
    radial: () => getEl("radialTxt").textContent,
    statSent: () => getEl("statSent").textContent,
    statSpeed: () => getEl("statSpeed").textContent,
    statEta: () => getEl("statEta").textContent,
    pipe: () => ({ state: getEl("pipe").dataset.state, label: getEl("pipeLabel").textContent, hidden: getEl("pipe").hidden }),
    // These mirror app.js's own lookup, so a change to the escaping in app.js
    // is visible here rather than being papered over by a second copy of the
    // same unescaped selector.
    rowBtn: fid => getEl("fileList").querySelector(`.dlOne[data-fid="${cssEscapeStr(fid)}"]`),
    rowSize: fid => { const b = getEl("fileList").querySelector(`.dlOne[data-fid="${cssEscapeStr(fid)}"]`); const r = b && b.closest(".frow"); const s = r && r.querySelector(".fsize"); return s ? s.textContent : null; },
    rowActive: fid => { const b = getEl("fileList").querySelector(`.dlOne[data-fid="${cssEscapeStr(fid)}"]`); const r = b && b.closest(".frow"); return !!(r && r.classList.contains("rx-active")); },
    wsRecv: (ws, obj) => ws.onmessage && ws.onmessage({ data: JSON.stringify(obj) }),
    fireDC: (pc, dc) => pc.ondatachannel && pc.ondatachannel({ channel: dc }),
    destroy() { clock.destroy(); },
  };
  api.usageLog = usageLog;
  return { sb: sandbox, api };
}

export const sleepFlush = async (api, n = 30) => { await api.clock.flush(n); };
export async function waitFor(api, cond, label) {
  for (let i = 0; i < 200; i++) { await api.clock.flush(5); if (cond()) return; }
  throw new Error("timeout waiting for: " + label);
}

// receiver-side data channel as the sender's end would look
export function dcLiteral() {
  return {
    readyState: "open", bufferedAmount: 0, binaryType: "", sent: [],
    onopen: null, onclose: null, onerror: null, onmessage: null,
    addEventListener() {}, removeEventListener() {},
    send(x) { this.sent.push(x); }, close() { this.readyState = "closed"; },
  };
}

export function filesMeta() {
  return [
    { id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" },
    { id: "fB", name: "b.bin", size: 2000, mime: "application/octet-stream" },
  ];
}
export function makeGate() {
  const q = [];
  return { wait() { return new Promise(res => q.push(res)); }, open(n = Infinity) { let c = 0; while (q.length && c < n) { q.shift()(); c++; } }, pending() { return q.length; } };
}
export function gateFile(name, size, gate) {
  return {
    name, size, type: "application/octet-stream",
    slice(a, b) {
      const n = Math.max(0, Math.min(b, size) - a);
      return { arrayBuffer: () => gate.wait().then(() => new Uint8Array(n).buffer) };
    },
  };
}

// ---------------------------------------------------------------- shared flows
export async function rxWorld(fileList) {
  const { sb, api } = newWorld({ meta: { files: fileList || filesMeta(), senderOnline: true } });
  const p = sb.initReceiver();
  await sleepFlush(api);
  await p;
  await sleepFlush(api);
  return { sb, api };
}
export async function sxWorld() {
  const { sb, api } = newWorld({ pathname: "/" });
  sb.initSender();
  await sleepFlush(api);
  return { sb, api };
}
export function sxAddFile(api, file) {
  const picker = api.els("picker");
  picker.files = [file];
  picker.onchange();
}
export async function sxLink(api, peer = "rx-1") {
  const sigWs = api.wsList[0];
  api.wsRecv(sigWs, { from: "server", to: "receivers", kind: "presence", payload: JSON.stringify({ peers: ["sender", peer], senderOnline: true }) });
  await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  if (!pc || !pc.dc) throw new Error("sender link/dc not built after presence");
  pc.dc.onopen && pc.dc.onopen();
  await sleepFlush(api);
  return pc.dc;
}
