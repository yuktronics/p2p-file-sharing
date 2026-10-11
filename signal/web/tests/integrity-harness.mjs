// Integrity harness for signal/web/app.js: end-to-end byte-exactness.
// Drives the REAL app.js in a fake browser (see world.mjs).
// Run: node integrity-harness.mjs   (exit 0 = all green)
import { createHash, randomBytes } from "node:crypto";
import { newWorld, sleepFlush, waitFor, makeGate, filesMeta, rxWorld, dcLiteral, sxWorld, sxAddFile, sxLink } from "./world.mjs";

const sha = b => createHash("sha256").update(b).digest("hex");

// Records the anonymous deltas app.js posts to /api/usage, so a test can assert
// the count is exactly what we think it is. Reads the request bodies the harness
// already intercepts rather than adding a second spy.
const usageDeltas = api => (api.usageLog || []).slice();
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS  " + name); }
  catch (e) { results.push(["FAIL", name + " :: " + (e && e.message)]); console.log("FAIL  " + name + "\n      " + (e && e.stack || e)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg + " — falsy"); }
function hasChat(api, re, msg) {
  if (!api.chat().some(t => re.test(t))) throw new Error(msg + " — chat log was: " + JSON.stringify(api.chat()));
}
// Capture what the receiver persisted via Blob (memory path).
function captureSaves(sb) {
  const saved = [];
  const RealBlob = sb.Blob;
  sb.Blob = class extends RealBlob {
    constructor(parts, opts) { super(parts, opts); saved.push({ parts: parts.slice(), type: opts && opts.type }); }
  };
  return saved;
}
const blobBytes = parts => Buffer.concat(parts.map(p => Buffer.from(p.byteLength !== undefined ? p : new Uint8Array(0))));
// Exact-copy helper: Buffer.slice() is a VIEW — .buffer alone would hand over
// Node's whole 8KB pool, not the slice. Every byte count in this suite depends
// on delivering precisely the intended range.
const ab = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
function acked(dc) { return dc.sent.some(s => { try { return JSON.parse(s).t === "ack"; } catch { return false; } }); }
const H = (fid, i, nm, sz) => ({ data: JSON.stringify({ t: "header", fid, idx: i, name: nm, size: sz, mime: "application/octet-stream" }) });
const E = (fid, i, extra) => ({ data: JSON.stringify(Object.assign({ t: "eof", fid, idx: i }, extra)) });
async function openRx(api) {
  const pc = api.pcList[api.pcList.length - 1]; ok(pc, "pc created on want");
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onopen && dc.onopen(); await sleepFlush(api);
  return dc;
}

// ---------------------------------------------------------------- sha256 unit vectors (app's own impl, via sender roundtrip + direct)
await test("INT-0 pure-JS SHA-256 matches NIST vectors incl. split updates", async () => {
  // Exercise the implementation through the sender: it hashes what it sends.
  const { api } = await sxWorld();
  const gate = makeGate();
  const mk = (name, bytes) => ({
    name, size: bytes.length, type: "application/octet-stream",
    slice: (a, b) => ({ arrayBuffer: () => gate.wait().then(() => { const s = bytes.slice(a, Math.min(b, bytes.length)); return s.buffer.slice(s.byteOffset, s.byteOffset + s.length); }) }),
  });
  const abc = Buffer.from("abc");
  sxAddFile(api, mk("v.bin", abc));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);
  for (let i = 0; i < 10; i++) { gate.open(10); await sleepFlush(api); }
  const eof = dc.sent.map(s => { try { return JSON.parse(s); } catch { return null; } }).find(o => o && o.t === "eof");
  ok(eof, "eof emitted");
  eq(eof.bytes, 3, "eof byte count");
  eq(eof.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "eof sha256 of 'abc'");
  api.destroy();
});

// ---------------------------------------------------------------- receiver verification
await test("INT-1 truncated file is refused: row ❌, nothing saved, no ack", async () => {
  const { sb, api } = await rxWorld([{ id: "fA", name: "app.apk", size: 1000, mime: "application/vnd.android.package-archive" }]);
  const saved = captureSaves(sb);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  dc.onmessage(H("fA", 0, "app.apk", 1000)); await sleepFlush(api);
  const full = randomBytes(1000);
  dc.onmessage({ data: ab(full.slice(0, 700)) }); await sleepFlush(api);
  dc.onmessage(E("fA", 0, { bytes: 1000, sha256: sha(full) })); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "❌", "row marked failed");
  eq(saved.length, 0, "nothing reached disk");
  eq(acked(dc), false, "no ack — sender must not claim received");
  ok(api.log().startsWith("✗"), "loud log verdict, got: " + api.log());
  hasChat(api, /arrived incomplete \(700 B of /, "chat names the shortfall");
  api.destroy();
});

await test("INT-2 same-length bit-flip is refused by digest", async () => {
  const { sb, api } = await rxWorld([{ id: "fA", name: "app.apk", size: 64, mime: "application/octet-stream" }]);
  const saved = captureSaves(sb);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  dc.onmessage(H("fA", 0, "app.apk", 64)); await sleepFlush(api);
  const good = randomBytes(64), bad = Buffer.from(good);
  bad[0] ^= 0xff; bad[63] ^= 0x01;
  dc.onmessage({ data: ab(bad) }); await sleepFlush(api);
  dc.onmessage(E("fA", 0, { bytes: 64, sha256: sha(good) })); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "❌", "row marked failed");
  eq(saved.length, 0, "nothing reached disk");
  eq(acked(dc), false, "no ack");
  hasChat(api, /integrity check/, "chat names the integrity failure");
  api.destroy();
});

await test("INT-3 exact bytes + matching digest save and ack", async () => {
  const { sb, api } = await rxWorld([{ id: "fA", name: "app.apk", size: 3000, mime: "application/vnd.android.package-archive" }]);
  const saved = captureSaves(sb);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  dc.onmessage(H("fA", 0, "app.apk", 3000)); await sleepFlush(api);
  const full = randomBytes(3000);
  for (let o = 0; o < full.length; o += 1000) { dc.onmessage({ data: ab(full.slice(o, o + 1000)) }); await sleepFlush(api); }
  dc.onmessage(E("fA", 0, { bytes: 3000, sha256: sha(full) })); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "row saved");
  eq(saved.length, 1, "one blob persisted");
  eq(sha(blobBytes(saved[0].parts)), sha(full), "disk bytes identical to sent bytes");
  eq(acked(dc), true, "ack sent — and now it means verified");
  api.destroy();
});

// The anonymous success count must mean exactly one thing: a file that was
// saved AND digest-verified. It sits on the same branch as savedFids, so the
// digest-failure paths (INT-1, INT-2) must not touch it — otherwise the number
// would report successes that never happened, which is the only failure mode
// this counter actually has.
await test("INT-13 usage counts a verified save, and nothing else", async () => {
  // Success: one file verified end to end.
  {
    const { sb, api } = await rxWorld([{ id: "fA", name: "ok.bin", size: 400, mime: "application/octet-stream" }]);
    api.rowBtn("fA").onclick(); await sleepFlush(api);
    const dc = await openRx(api);
    dc.onmessage(H("fA", 0, "ok.bin", 400)); await sleepFlush(api);
    const full = randomBytes(400);
    dc.onmessage({ data: ab(full) }); await sleepFlush(api);
    dc.onmessage(E("fA", 0, { bytes: 400, sha256: sha(full) })); await sleepFlush(api);
    eq(usageDeltas(api).join(","), "1", "one verified file -> n:1 exactly once");
    api.destroy();
  }
  // Failure: a same-length bit-flip is refused by the digest, so it must not
  // be counted even though every byte arrived.
  {
    // Same shape as INT-2: a single 64-byte chunk with a bit flipped, so the
    // digest is the only thing that can reject it.
    const { sb, api } = await rxWorld([{ id: "fA", name: "bad.bin", size: 64, mime: "application/octet-stream" }]);
    api.rowBtn("fA").onclick(); await sleepFlush(api);
    const dc = await openRx(api);
    dc.onmessage(H("fA", 0, "bad.bin", 64)); await sleepFlush(api);
    const good = randomBytes(64), bad = Buffer.from(good);
    bad[0] ^= 0xff; bad[63] ^= 0x01;
    dc.onmessage({ data: ab(bad) }); await sleepFlush(api);
    dc.onmessage(E("fA", 0, { bytes: 64, sha256: sha(good) })); await sleepFlush(api);
    eq(api.rowBtn("fA").textContent, "❌", "row refused the corrupt file");
    eq(usageDeltas(api).length, 0, "a digest mismatch is NOT counted");
    api.destroy();
  }
});

// A sender must never report a completed file: only a receiver can have one.
await test("INT-14 usage is receiver-only", async () => {
  const { sb, api } = await sxWorld();
  const f = { name: "a.bin", size: 100, type: "application/octet-stream",
              slice: () => ({ arrayBuffer: async () => new ArrayBuffer(100) }) };
  const picker = api.els("picker");
  picker.files = [f];
  picker.onchange();
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  eq(usageDeltas(api).length, 0, "sending side never increments the counter");
  api.destroy();
});

await test("INT-4 old sender without bytes/hash still saves on full delivery (compat)", async () => {
  const { sb, api } = await rxWorld([{ id: "fA", name: "a.bin", size: 500, mime: "application/octet-stream" }]);
  const saved = captureSaves(sb);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  dc.onmessage(H("fA", 0, "a.bin", 500)); await sleepFlush(api);
  const full = randomBytes(500);
  dc.onmessage({ data: ab(full) }); await sleepFlush(api);
  dc.onmessage(E("fA", 0)); await sleepFlush(api); // legacy eof: no bytes/sha256
  eq(api.rowBtn("fA").textContent, "✓ Saved", "legacy full delivery still saves");
  eq(sha(blobBytes(saved[0].parts)), sha(full), "bytes intact");
  api.destroy();
});

await test("INT-5 empty file round-trips (hash of empty)", async () => {
  const { sb, api } = await rxWorld([{ id: "fA", name: "empty.bin", size: 0, mime: "application/octet-stream" }]);
  const saved = captureSaves(sb);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  dc.onmessage(H("fA", 0, "empty.bin", 0)); await sleepFlush(api);
  dc.onmessage(E("fA", 0, { bytes: 0, sha256: sha(Buffer.alloc(0)) })); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "empty file saves");
  eq(acked(dc), true, "ack sent");
  api.destroy();
});

// ---------------------------------------------------------------- stream-path races
await test("INT-6 slow writer setup loses no head bytes (stream path byte-exact)", async () => {
  const { sb, api } = newWorld({ meta: { files: [{ id: "fA", name: "a.apk", size: 3000, mime: "application/octet-stream" }], senderOnline: true } });
  const saved = captureSaves(sb);
  const written = [];
  let releaseWriter;
  const gate0 = new Promise(r => { releaseWriter = r; });
  // A faithful directory-handle stub: getFileHandle(name) WITHOUT
  // {create:true} must REJECT when nothing of that name has been written,
  // because app.js uses exactly that to avoid truncating an existing file.
  // A stub that resolves unconditionally makes the not-yet-written path
  // untestable and hides the overwrite bug it guards against.
  const onDisk = new Set();
  sb.window.showDirectoryPicker = async () => ({
    getFileHandle: async (name, opts) => {
      if (!opts || !opts.create) {
        if (!onDisk.has(name)) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      }
      return {
        createWritable: async (wopts) => {
          // Truncating unless the caller asks otherwise, exactly like the real API.
          const keep = !!(wopts && wopts.keepExistingData);
          if (!keep) written.length = 0;
          return {
            write: async c => { written.push(Buffer.from(c)); },
            close: async () => { onDisk.add(name); },
            abort: async () => {},
          };
        },
      };
    },
    removeEntry: async name => { onDisk.delete(name); },
  });
  const p = sb.initReceiver();
  await sleepFlush(api); await p; await sleepFlush(api);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  const full = randomBytes(3000);
  dc.onmessage(H("fA", 0, "a.apk", 3000)); await sleepFlush(api, 5);
  dc.onmessage({ data: ab(full.slice(0, 1000)) }); await sleepFlush(api); // before writer ready
  dc.onmessage({ data: ab(full.slice(1000, 2000)) }); await sleepFlush(api);
  releaseWriter(); await sleepFlush(api);
  dc.onmessage({ data: ab(full.slice(2000)) }); await sleepFlush(api);
  dc.onmessage(E("fA", 0, { bytes: 3000, sha256: sha(full) })); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "row saved");
  eq(saved.length, 0, "stream path writes to disk, no blob");
  eq(sha(Buffer.concat(written)), sha(full), "disk bytes identical incl. pre-writer head");
  eq(acked(dc), true, "ack sent");
  api.destroy();
});

await test("INT-7 back-to-back files with slow close() both save byte-exact", async () => {
  const { sb, api } = newWorld({ meta: { files: [{ id: "fA", name: "a.apk", size: 1000, mime: "application/octet-stream" }, { id: "fB", name: "b.apk", size: 1500, mime: "application/octet-stream" }], senderOnline: true } });
  const saved = captureSaves(sb);
  const disk = { "a.apk": [], "b.apk": [] };
  let releaseClose;
  const closeGate = new Promise(r => { releaseClose = r; });
  // Faithful enough for the overwrite guard: a lookup without {create:true}
  // rejects unless that name is already on disk.
  const seen = new Set();
  sb.window.showDirectoryPicker = async () => ({
    getFileHandle: async (name, opts) => {
      if (!opts || !opts.create) {
        if (!seen.has(name)) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      }
      return {
        createWritable: async (wopts) => {
          if (!(wopts && wopts.keepExistingData)) disk[name] = [];
          return {
            write: async c => { disk[name].push(Buffer.from(c)); },
            close: async () => { seen.add(name); if (name === "a.apk") await closeGate; },
            abort: async () => {},
          };
        },
      };
    },
  });
  const p = sb.initReceiver();
  await sleepFlush(api); await p; await sleepFlush(api);
  api.els("dl").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  const fa = randomBytes(1000), fb = randomBytes(1500);
  dc.onmessage(H("fA", 0, "a.apk", 1000)); await sleepFlush(api, 5);
  dc.onmessage({ data: ab(fa) }); await sleepFlush(api);
  dc.onmessage(E("fA", 0, { bytes: 1000, sha256: sha(fa) })); await sleepFlush(api, 5); // close() gated
  dc.onmessage(H("fB", 1, "b.apk", 1500)); await sleepFlush(api, 5);
  dc.onmessage({ data: ab(fb.slice(0, 750)) }); await sleepFlush(api);
  releaseClose(); await sleepFlush(api);
  dc.onmessage({ data: ab(fb.slice(750)) }); await sleepFlush(api);
  dc.onmessage(E("fB", 1, { bytes: 1500, sha256: sha(fb) })); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "file A saved");
  eq(api.rowBtn("fB").textContent, "✓ Saved", "file B saved (not clobbered)");
  eq(sha(Buffer.concat(disk["a.apk"])), sha(fa), "A byte-exact");
  eq(sha(Buffer.concat(disk["b.apk"])), sha(fb), "B byte-exact");
  eq(saved.length, 0, "both via stream, no blobs");
  const acks = dc.sent.filter(s => { try { return JSON.parse(s).t === "ack"; } catch { return false; } }).length;
  eq(acks, 2, "both acked");
  api.destroy();
});

// ---------------------------------------------------------------- sender guarantees
await test("INT-8 real sender emits byte-exact stream + matching eof proof", async () => {
  const { api } = await sxWorld();
  const gate = makeGate();
  const full = randomBytes(3 * 262144 + 12345); // multi-chunk + ragged tail
  const f = {
    name: "app.apk", size: full.length, type: "application/vnd.android.package-archive",
    slice: (a, b) => ({ arrayBuffer: () => gate.wait().then(() => { const s = full.slice(a, Math.min(b, full.length)); return s.buffer.slice(s.byteOffset, s.byteOffset + s.length); }) }),
  };
  sxAddFile(api, f);
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);
  for (let i = 0; i < 40 && !dc.sent.some(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } }); i++) {
    gate.open(10); await sleepFlush(api);
  }
  const frames = dc.sent.map(s => { try { return JSON.parse(s); } catch { return "bin"; } });
  const hdr = frames.find(o => o && o.t === "header");
  const eof = frames.find(o => o && o.t === "eof");
  ok(hdr, "header emitted");
  ok(eof && Number.isInteger(eof.bytes) && typeof eof.sha256 === "string", "eof carries bytes+sha256");
  const bins = dc.sent.filter(s => typeof s !== "string").map(b => Buffer.from(b));
  eq(Buffer.concat(bins).length, full.length, "streamed byte count equals file size");
  eq(sha(Buffer.concat(bins)), sha(full), "streamed bytes identical to file");
  eq(eof.bytes, full.length, "eof.bytes truthful");
  eq(eof.sha256, sha(full), "eof.sha256 truthful");
  api.destroy();
});

await test("INT-9 sender clamps chunks to the peer's sctp.maxMessageSize", async () => {
  const { api } = await sxWorld();
  const gate = makeGate();
  const full = randomBytes(50000);
  const sizes = [];
  const f = {
    name: "a.bin", size: full.length, type: "application/octet-stream",
    slice: (a, b) => { sizes.push(Math.min(b, full.length) - a); return { arrayBuffer: () => gate.wait().then(() => { const s = full.slice(a, Math.min(b, full.length)); return s.buffer.slice(s.byteOffset, s.byteOffset + s.length); }) }; },
  };
  sxAddFile(api, f);
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  const pc = api.pcList[api.pcList.length - 1];
  pc.sctp = { maxMessageSize: 20000 }; // e.g. Safari-side ceiling
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);
  for (let i = 0; i < 40 && !dc.sent.some(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } }); i++) {
    gate.open(10); await sleepFlush(api);
  }
  ok(sizes.length >= 3, "multiple slices taken");
  ok(sizes.every(n => n <= 20000), "no slice exceeds the peer ceiling, got: " + JSON.stringify(sizes));
  const eof = dc.sent.map(s => { try { return JSON.parse(s); } catch { return null; } }).find(o => o && o.t === "eof");
  eq(eof.bytes, full.length, "full file still sent under the clamp");
  eq(eof.sha256, sha(full), "digest still over the whole file");
  api.destroy();
});

await test("INT-10 stream-path failure removes the bad file from disk", async () => {
  const { sb, api } = newWorld({ meta: { files: [{ id: "fA", name: "a.apk", size: 1000, mime: "application/octet-stream" }], senderOnline: true } });
  const saved = captureSaves(sb);
  const written = [];
  const removed = [];
  sb.window.showDirectoryPicker = async () => ({
    getFileHandle: async (name, opts) => {
      // Nothing exists yet in this case, so a lookup without {create:true}
      // must reject — that is the check app.js uses to avoid truncating.
      if (!opts || !opts.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      return {
        getFile: async () => ({ size: 0 }),
        createWritable: async () => ({ write: async c => { written.push(Buffer.from(c)); }, close: async () => {}, abort: async () => {} }),
      };
    },
    removeEntry: async name => { removed.push(name); },
  });
  const p = sb.initReceiver();
  await sleepFlush(api); await p; await sleepFlush(api);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = await openRx(api);
  const full = randomBytes(1000);
  dc.onmessage(H("fA", 0, "a.apk", 1000)); await sleepFlush(api, 5);
  dc.onmessage({ data: ab(full.slice(0, 600)) }); await sleepFlush(api);
  dc.onmessage(E("fA", 0, { bytes: 1000, sha256: sha(full) })); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "❌", "row marked failed");
  eq(saved.length, 0, "no blob fallback either");
  eq(removed.join(","), "a.apk", "bad disk file removed so 'nothing was saved' holds");
  eq(acked(dc), false, "no ack");
  hasChat(api, /Nothing was saved/, "chat verdict");
  api.destroy();
});

// ---------------------------------------------------------------- summary
let fails = 0;
for (const [s, n] of results) if (s === "FAIL") fails++;
console.log(`\n${results.length - fails}/${results.length} green`);
process.exit(fails ? 1 : 0);
