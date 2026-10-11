// Cancel-scenario + negative-case harness for signal/web/app.js.
// Drives the REAL app.js in a fake browser (see world.mjs) through cancel
// paths on both sides, asserting messages, UI state and progress reset.
//
// Run: node /tmp/opencode/cancel-harness.mjs   (exit 0 = all green)
import { newWorld, sleepFlush, waitFor, gateFile, makeGate, filesMeta, rxWorld, dcLiteral, sxWorld, sxAddFile, sxLink } from "./world.mjs";

// ---------------------------------------------------------------- runner
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

// ---------------------------------------------------------------- RECEIVER tests
await test("R1 cancel mid-stream resets everything and stays retryable", async () => {
  const { api } = await rxWorld();
  const btn = api.rowBtn("fA"); ok(btn, "row button fA exists");
  btn.onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1]; ok(pc, "pc created on want");
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onopen && dc.onopen(); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(400).buffer }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(300).buffer }); await sleepFlush(api);
  ok(api.bar() > 0, "progress advanced before cancel");
  ok(api.rowActive("fA"), "streaming row glows");
  const chatBefore = api.chat().length;
  api.els("rxCancel").onclick(); await sleepFlush(api);
  ok(dc.sent.some(s => { try { return JSON.parse(s).t === "cancel"; } catch { return false; } }), "cancel frame sent on open channel");
  eq(api.bar(), 0, "bar reset");
  eq(api.radial(), "0%", "radial reset");
  eq(api.statSent(), "0 B", "statSent reset");
  eq(api.statSpeed(), "—", "statSpeed reset");
  eq(api.statEta(), "—", "statEta reset");
  const b2 = api.rowBtn("fA");
  eq(b2.textContent, "⬇", "row button back to download");
  eq(b2.disabled, false, "row button enabled");
  eq(api.rowSize("fA"), "1.0 KB", "row size text restored (was live %)");
  ok(!api.rowActive("fA"), "row glow cleared");
  eq(api.log(), "Cancelled a.bin — nothing was saved.", "log verdict");
  eq(api.peerHint(), "cancelled — retry anytime", "peer hint");
  eq(api.toast(), "Download cancelled", "toast");
  hasChat(api, /Cancelled “a\.bin” ✕/, "chat cancel line");
  eq(api.pipe().state, "waiting", "pipe back to waiting");
  b2.onclick(); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0 }) }); await sleepFlush(api);
  const b3 = api.rowBtn("fA");
  eq(b3.textContent, "✓ Saved", "retry saved");
  ok(dc.sent.some(s => { try { return JSON.parse(s).t === "ack"; } catch { return false; } }), "ack sent after retry");
  if (api.chat().length <= chatBefore) throw new Error("chat did not grow across cancel+retry");
  api.destroy();
});

await test("R2 cancel while waiting for header (no bytes yet)", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onopen && dc.onopen(); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "⏳", "row shows waiting");
  api.els("rxCancel").onclick(); await sleepFlush(api);
  ok(dc.sent.some(s => { try { return JSON.parse(s).t === "cancel"; } catch { return false; } }), "cancel sent while pending");
  eq(api.bar(), 0, "bar reset");
  eq(api.radial(), "0%", "radial reset");
  eq(api.rowBtn("fA").textContent, "⬇", "row retryable");
  hasChat(api, /Cancelled/, "chat cancel line");
  api.destroy();
});

await test("R3 cancel with nothing in flight is a silent no-op", async () => {
  const { api } = await rxWorld();
  const n0 = api.chat().length, t0 = api.toast();
  api.els("rxCancel").onclick(); await sleepFlush(api);
  eq(api.chat().length, n0, "no chat added");
  eq(api.toast(), t0, "no toast fired");
  api.destroy();
});

await test("R4 cancel after successful download is a silent no-op", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0 }) }); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "file saved first");
  const n0 = api.chat().length;
  api.els("rxCancel").onclick(); await sleepFlush(api);
  eq(api.chat().length, n0, "cancel after done adds nothing");
  eq(api.bar(), 100, "completion bar untouched");
  api.destroy();
});

await test("R5 wantAll partial: saved file keeps ✓, cancelled file retries to done", async () => {
  const { api } = await rxWorld();
  api.els("dl").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onopen && dc.onopen(); await sleepFlush(api);
  const H = (fid, i, nm, sz) => ({ data: JSON.stringify({ t: "header", fid, idx: i, name: nm, size: sz, mime: "application/octet-stream" }) });
  const E = (fid, i) => ({ data: JSON.stringify({ t: "eof", fid, idx: i }) });
  dc.onmessage(H("fA", 0, "a.bin", 1000)); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage(E("fA", 0)); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "fA saved before cancel");
  dc.onmessage(H("fB", 1, "b.bin", 2000)); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(500).buffer }); await sleepFlush(api);
  api.els("rxCancel").onclick(); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "saved file keeps ✓");
  eq(api.rowBtn("fA").disabled, true, "saved file stays disabled");
  eq(api.rowBtn("fB").textContent, "⬇", "cancelled file retryable");
  eq(api.bar(), 0, "bar reset");
  api.rowBtn("fB").onclick(); await sleepFlush(api);
  dc.onmessage(H("fB", 1, "b.bin", 2000)); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(2000).buffer }); await sleepFlush(api);
  dc.onmessage(E("fB", 1)); await sleepFlush(api);
  eq(api.rowBtn("fB").textContent, "✓ Saved", "fB saved on retry");
  eq(api.peerHint(), "All requested files received ✓", "all-done verdict");
  hasChat(api, /Saved b\.bin ✓ \(1\/1\)/, "per-round counter correct after cancel reset");
  api.destroy();
});

await test("R6 late header/eof after cancel are ignored quietly", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(200).buffer }); await sleepFlush(api);
  api.els("rxCancel").onclick(); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  hasChat(api, /Ignored a\.bin — you cancelled/, "stale header refused with reason");
  const n1 = api.chat().length;
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0 }) }); await sleepFlush(api);
  eq(api.chat().length, n1, "stale eof stays silent in cancel quiet window");
  eq(api.rowBtn("fA").textContent, "⬇", "row still retryable, nothing saved");
  api.destroy();
});

await test("R7 sender removes file mid-download still fails loudly (regression)", async () => {
  const { api } = await rxWorld([{ id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" }]);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(200).buffer }); await sleepFlush(api);
  const sigWs = api.wsList[0];
  api.wsRecv(sigWs, { from: "sender", to: "receivers", kind: "files", payload: JSON.stringify({ files: [] }) });
  await sleepFlush(api);
  eq(api.log(), "✗ Download stopped — the sender removed a.bin while it was downloading", "specific verdict kept");
  hasChat(api, /sender removed a\.bin while it was downloading/, "chat names the cause");
  api.destroy();
});

// Clicking Download while the sender is not connected must HOLD the request,
// not refuse it. The receiver's single click has to be enough: on a phone the
// sender's tab is frozen while they share the link, and they reconnect on their
// own the moment they come back to the tab. Refusing made the receiver go back
// to the sender and click a second time by hand.
await test("R8 offline click holds the request and releases it when the sender returns", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: false } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "⏳", "row shows it is waiting, not refused");
  eq(api.rowBtn("fA").disabled, true, "held row is not clickable twice");
  eq(api.pcList.length, 0, "no peer connection built yet");
  hasChat(api, /isn.t connected yet/, "explains the wait and that it is normal on a phone");
  ok(api.chat().some(t => /reconnects the moment they return/i.test(t)),
    "says the sender reconnects by itself — no second click needed");

  // The sender comes back. The held request must start on its own.
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence", payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 9 }) });
  await sleepFlush(api, 20);
  ok(api.pcList.length > 0, "a peer connection was built automatically on reconnect");
  ok(api.chat().some(t => /Sender is back online/.test(t)), "announces the return");
  api.destroy();
});

await test("R9 stalled request retries once then fails loudly (regression)", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  await api.clock.advance(16000); // fires the +15s tick: past the 10s retry line
  hasChat(api, /hasn't started sending — rebuilding/, "one rebuild + re-ask at 10s");
  // REQ_DEADLINE_MS (60s), not the 25s this used to be. A TURN relay can take
  // longer than the app's own 30s "no data" threshold to connect, and failing a
  // request while the link is still being established fails a sender who was
  // never slow — only relayed.
  await api.clock.advance(48000); // past the 60s deadline
  eq(api.log().startsWith("✗"), true, "loud failure verdict, got: " + api.log());
  // An interruption leaves a WORKING Resume, not a dead ❌ — the sender may come
  // back, and there is no byte-offset resume on a DataChannel, so it restarts.
  eq(api.rowBtn("fA").textContent, "↻ Resume", "row offers a restart, not stuck at ⏳");
  eq(api.rowBtn("fA").disabled, false, "the restart must be clickable");
  api.destroy();
});

// ── The sender's freeze vs any other interruption are different ─────────────
//
// Reported as: sender shares, goes to WhatsApp, receiver opens the link and it
// fails; sender comes back, the connection re-establishes — and the download
// never resumes. Two gaps caused that:
//   1. nothing queued the interrupted transfer, so the sender's return had
//      nothing to release;
//   2. the release was gated on !doneRx, and endRx sets doneRx — so even a
//      queued item could never be released after a failure.
await test("R20 a transfer the sender's freeze killed restarts when they return", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(400).buffer }); await sleepFlush(api);

  // >>> the sender's tab freezes mid-transfer <<<
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);

  ok(api.log().startsWith("✗"), "the attempt failed loudly, got: " + api.log());
  ok(api.chat().some(t => /restarts by itself/i.test(t)),
    `the receiver was not told it would restart, chat=${JSON.stringify(api.chat())}`);

  // >>> the sender returns: it must restart with no second click <<<
  const pcsBefore = api.pcList.length;
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /Sender is back — starting/.test(t)),
    `nothing was restarted on their return, chat=${JSON.stringify(api.chat())}`);
  ok(api.rowBtn("fA").textContent !== "↻ Resume",
    "the row is still waiting for a manual click — the auto-resume did not take");
  // The restart must be a normal, cancellable attempt. The watchdog and the
  // Cancel button are both gated on !doneRx, so a resume that left the previous
  // attempt's verdict set would quietly restart with no way to stop it and no
  // retry if it stalled again. ensureConn clears it when it builds the fresh
  // peer connection; this pins that the net result is right.
  await api.clock.advance(1000); await sleepFlush(api, 10);
  eq(api.els("rxCancel").hidden, false,
    "Cancel is unavailable during the restarted transfer — the old verdict was not cleared");
  api.destroy();
});

// An interruption NOT caused by the sender's absence must stay manual. Only
// bytes-already-moving deserves an automatic restart; auto-firing a transfer the
// receiver did not just ask for is its own bug.
await test("R27 an interruption with the sender still online stays a manual Resume", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(400).buffer }); await sleepFlush(api);

  // The receiver's own signaling socket drops — nothing to do with the sender.
  api.wsList[api.wsList.length - 1].fail(1006);
  await sleepFlush(api, 20);
  ok(api.log().startsWith("✗"), "the attempt failed loudly, got: " + api.log());
  eq(api.rowBtn("fA").textContent, "↻ Resume", "left as a manual restart");
  eq(api.rowBtn("fA").disabled, false, "and it is clickable");
  api.destroy();
});

// An integrity failure is NOT an interruption: resuming would re-fetch the same
// corrupt bytes, so that verdict must stay a dead ❌.
await test("R21 an integrity failure keeps a dead ❌, not a Resume", async () => {
  const { api } = await rxWorld([{ id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" }]);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000, sha256: "0".repeat(64) }) }); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "❌", "a corrupt file must not offer Resume — resuming re-fetches the same bytes");
  eq(api.rowBtn("fA").disabled, true, "and stays unclickable until the sender re-sends it");
  api.destroy();
});

// ── Item 3: Cancel must cover the window where a download is stuck ────────────
//
// pickDir() awaits a directory picker. While it is pending, cur and pendingReq
// are both null — so the poll hid Cancel exactly when a download was in progress
// and blocked. Verified in a real browser: Download-all and the row were greyed,
// Cancel was hidden, and nothing was logged.
await test("R22 Cancel is available while the directory picker is pending", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: true } });
  // A picker that never settles, i.e. a user who has not chosen a folder yet.
  sb.window.showDirectoryPicker = () => new Promise(() => {});
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);

  api.rowBtn("fA").onclick(); await sleepFlush(api);
  await api.clock.advance(1000); await sleepFlush(api, 10); // the 400ms visibility poll
  eq(api.els("rxCancel").hidden, false,
    "Cancel was hidden while the download was blocked on the directory picker");
  api.destroy();
});

await test("R11 sha256 mismatch fails loudly and never acks", async () => {
  const { api } = await rxWorld([{ id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" }]);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  // right length, wrong content: only a digest can catch this
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000, sha256: "0".repeat(64) }) }); await sleepFlush(api);
  ok(/integrity check/.test(api.log()), "integrity failure is the stated verdict, got: " + api.log());
  eq(api.rowBtn("fA").textContent, "❌", "row marked failed");
  ok(!dc.sent.some(s => { try { return JSON.parse(s).t === "ack"; } catch { return false; } }), "never acked a file that failed verification");
  hasChat(api, /Ask the sender to send it again/, "actionable next step in the log");
  api.destroy();
});

await test("R12 matching digest saves and acks (integrity happy path)", async () => {
  const { api } = await rxWorld([{ id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" }]);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  const { createHash } = await import("node:crypto");
  const good = createHash("sha256").update(Buffer.alloc(1000)).digest("hex");
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000, sha256: good }) }); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "verified file saved");
  ok(dc.sent.some(s => { try { return JSON.parse(s).t === "ack"; } catch { return false; } }), "ack sent only after verification passed");
  api.destroy();
});

await test("R10 completed download keeps speed, ETA and receiver-side wording", async () => {
  const { api } = await rxWorld([{ id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" }]);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) }); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(400).buffer }); await sleepFlush(api);
  await api.clock.advance(3000);
  dc.onmessage({ data: new Uint8Array(600).buffer }); await sleepFlush(api);
  await api.clock.advance(3000);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0 }) }); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "file saved");
  ok(api.statSpeed() !== "—" && /\/s$/.test(api.statSpeed()), "speed persists as final average, got: " + api.statSpeed());
  eq(api.statEta(), "0s", "ETA settles at 0s, not —");
  eq(api.pipe().label, "Received successfully on this device ✓", "receiver-side delivery wording");
  api.destroy();
});

await test("R13 repeat send of a saved file is ignored — downloads once (regression)", async () => {
  const { api } = await rxWorld([{ id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" }]);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  const H = { data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) };
  const B = { data: new Uint8Array(1000).buffer };
  const E = { data: JSON.stringify({ t: "eof", fid: "fA", idx: 0 }) };
  dc.onmessage(H); await sleepFlush(api);
  dc.onmessage(B); await sleepFlush(api);
  dc.onmessage(E); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "file saved first");
  const saves = () => api.chat().filter(t => /Saved a\.bin ✓/.test(t)).length;
  const acks = () => dc.sent.filter(s => { try { return JSON.parse(s).t === "ack"; } catch { return false; } }).length;
  eq(saves(), 1, "saved exactly once");
  eq(acks(), 1, "acked exactly once");
  // A duplicate send (watchdog retry overlapping a slow sender, or a second
  // request slipping out before the first arrived) must not save again.
  const n0 = api.chat().length;
  dc.onmessage(H); await sleepFlush(api);
  dc.onmessage(B); await sleepFlush(api);
  dc.onmessage(E); await sleepFlush(api);
  eq(saves(), 1, "duplicate send saved nothing more");
  eq(acks(), 1, "duplicate send acked nothing more");
  eq(api.rowBtn("fA").textContent, "✓ Saved", "row still saved, not disturbed");
  hasChat(api, /repeat send of a\.bin — already saved/, "duplicate refused with reason");
  eq(api.chat().length, n0 + 1, "duplicate stays quiet apart from its refusal note");
  api.destroy();
});

await test("R14 Download-all after a single request skips outstanding files (regression)", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  eq(api.els("dl").disabled, true, "single request holds Download-all off (one mode at a time)");
  // A live list update re-renders rows; Download-all must stay off mid-flight.
  api.els("dl").onclick(); await sleepFlush(api); // forced: bypasses the disabled guard like a stale double-fire
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onopen && dc.onopen(); await sleepFlush(api);
  const H = (fid, i, nm, sz) => ({ data: JSON.stringify({ t: "header", fid, idx: i, name: nm, size: sz, mime: "application/octet-stream" }) });
  const E = (fid, i) => ({ data: JSON.stringify({ t: "eof", fid, idx: i }) });
  dc.onmessage(H("fA", 0, "a.bin", 1000)); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage(E("fA", 0)); await sleepFlush(api);
  dc.onmessage(H("fB", 1, "b.bin", 2000)); await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(2000).buffer }); await sleepFlush(api);
  dc.onmessage(E("fB", 1)); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "fA saved");
  eq(api.rowBtn("fB").textContent, "✓ Saved", "fB saved");
  // fA was requested once, not twice: totals read (2/2) and the finale fires.
  hasChat(api, /Saved b\.bin ✓ \(2\/2\)/, "no double-count of the outstanding file");
  eq(api.peerHint(), "All requested files received ✓", "all-done verdict reachable");
  api.destroy();
});

// ---------------------------------------------------------------- SENDER tests
await test("S1 cancel mid-stream: sender stops, resets display, serves retry to ack", async () => {
  const { api } = await sxWorld();
  const gate = makeGate();
  sxAddFile(api, gateFile("a.bin", 2 * 262144 + 100, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);
  const hdr = dc.sent.map(s => { try { return JSON.parse(s); } catch { return null; } }).find(o => o && o.t === "header");
  ok(hdr, "sender emitted header");
  const realFid = hdr.fid;
  gate.open(1); await sleepFlush(api); // chunk 1 out
  dc.onmessage({ data: JSON.stringify({ t: "cancel" }) });
  await sleepFlush(api);
  gate.open(10); await sleepFlush(api); // let any in-flight iteration drain
  const frames = dc.sent.map(s => { try { return JSON.parse(s); } catch { return "bin"; } });
  ok(!frames.some(o => o && o.t === "eof"), "no eof after cancel — file truly stopped");
  hasChat(api, /Receiver cancelled the download/, "sender log names the cancel");
  eq(api.els("status").textContent, "Cancelled — standing by for the receiver's next pick.", "sender status honest");
  eq(api.bar(), 0, "sender bar reset");
  eq(api.radial(), "0%", "sender radial reset");
  eq(api.pipe().state, "linked", "link held, not lost");
  if (api.chat().some(t => /All requested files sent/.test(t))) throw new Error("must not claim success after cancel");
  dc.onmessage({ data: JSON.stringify({ t: "want", fid: realFid, idx: 0 }) });
  await sleepFlush(api);
  // pace the chunk gates: each iteration parks a fresh waiter, so drain repeatedly
  let eofSeen = false;
  for (let i = 0; i < 12 && !eofSeen; i++) {
    gate.open(10);
    await sleepFlush(api);
    eofSeen = dc.sent.some(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } });
  }
  ok(eofSeen, "retry runs to eof");
  dc.onmessage({ data: JSON.stringify({ t: "ack", fid: realFid }) });
  await sleepFlush(api);
  eq(api.els("recvPanel").hidden, false, "Received panel appears on ack");
  eq(api.els("recvCount").textContent, "1 / 1", "received counter");
  hasChat(api, /All done — the receiver confirmed/, "delivery finale still reachable after cancel");
  eq(api.pipe().label, "Delivered — confirmed on their device ✓", "sender keeps its own delivery wording");
  api.destroy();
});

await test("S2 cancel while idle does not poison the next request", async () => {
  const { api } = await sxWorld();
  const gate = makeGate();
  sxAddFile(api, gateFile("a.bin", 500, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "cancel" }) });
  await sleepFlush(api);
  hasChat(api, /Receiver cancelled the download/, "idle cancel still narrated");
  dc.onmessage({ data: JSON.stringify({ t: "want", fid: "f1-xxxxx", idx: 0 }) });
  await sleepFlush(api);
  hasChat(api, /removed — nothing to send/, "unknown fid answered plainly, no stall");
  api.destroy();
});

// THE MOBILE BUG. Sharing from a phone means switching to WhatsApp, which
// backgrounds the browser — and mobile browsers freeze a backgrounded tab's JS,
// tearing down its WebSocket. The server then clears its sender slot and tells
// every receiver `senderOnline: false`, so receivers saw the file list and got
// "sender is offline" on every click.
//
// Three things had to be true, and this test holds all three:
//   1. the sender NOTICES its socket died (it passed no onState, so a close was
//      completely silent — the page still said "waiting for receiver"),
//   2. it says so instead of pretending to be live,
//   3. it REOPENS the socket when the tab comes back, restoring the sender slot.
await test("S7 a frozen sender tab reconnects when it returns to the foreground", async () => {
  const { api } = await sxWorld();
  // A room (and therefore a signaling socket) only exists once a file is staged.
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  eq(api.wsList.length, 1, "one signaling socket");
  api.wsList[0].open();                       // handshake completes
  // The server broadcasts presence right after the sender's own Join — this is a
  // brand new share, not a comeback, and must not be announced as one.
  api.wsList[0].onmessage && api.wsList[0].onmessage({ data: JSON.stringify({
    from: "server", to: "sender", kind: "presence", seq: 1,
    payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 10);
  ok(!api.chat().some(t => /Back online/.test(t)),
    `a fresh share must not announce a comeback; chat=${JSON.stringify(api.chat())}`);
  // The sender's own status line must not claim it is live while the server has
  // already marked it gone — that mismatch is what made this unfixable from the
  // receiver's side.
  ok(api.chat().some(t => /Waiting for receiver/i.test(t)),
    `sender says it is waiting, chat=${JSON.stringify(api.chat())}`);

  // >>> the phone backgrounds the tab: the socket dies <<<
  api.wsList[0].fail(1006);
  await sleepFlush(api, 10);

  ok(api.chat().some(t => /background/i.test(t)),
    `the chat log explains the pause (a frozen tab, not a failure); chat=${JSON.stringify(api.chat())}`);

  // >>> the user comes back: visibilitychange fires <<<
  const before = api.wsList.length;
  api.fireVisibility();
  await sleepFlush(api, 20);
  ok(api.wsList.length > before,
    `a new signaling socket was opened on return (had ${before}, now ${api.wsList.length})`);
  // Success is proven by the server's presence frame, not by the socket opening:
  // the server upgrades before it runs Join, so a refused reconnect opens first.
  ok(!api.chat().some(t => /Back online/.test(t)),
    "no premature 'back online' claim before the server confirms the rejoin");
  const back = api.wsList[api.wsList.length - 1];
  back.open();
  ok(!api.chat().some(t => /Back online/.test(t)),
    "an open socket is not proof — the server has not accepted the Join yet");
  back.onmessage && back.onmessage({ data: JSON.stringify({
    from: "server", to: "sender", kind: "presence", seq: 4,
    payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 10);
  ok(api.chat().some(t => /Back online/.test(t)), "the sender confirms it is back");
  api.destroy();
});

// THE production failure. The server cannot tell the tab's socket is gone until
// a write to it fails — up to SIGNAL_PING, because a frozen tab sends nothing
// and the reader sits on its deadline. So the sender's FIRST reconnect arrives
// while the server still holds the old entry and is refused with close 4400.
// Verified live: that is exactly what happened, the reconnect closed with 4400
// "duplicate_sender", and the mobile fix was silently inert.
//
// So the retry must survive a refusal and keep going until one is accepted. A
// single attempt — or giving up when the close arrives — leaves the sender
// permanently offline with no way back but re-sharing.
await test("S8 the sender keeps retrying until the server accepts the rejoin", async () => {
  const { api } = await sxWorld();
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  api.wsList[0].open();
  // The share starts live: the server broadcasts presence after its Join. Without
  // this the later "coming back" has nothing to come back FROM.
  api.wsList[0].onmessage && api.wsList[0].onmessage({ data: JSON.stringify({
    from: "server", to: "sender", kind: "presence", seq: 1,
    payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 10);

  // The reconnect backoff runs on setTimeout, and this harness's clock only
  // fires timers when time is ADVANCED — flush() merely yields. Retrying without
  // advancing is the one thing that cannot exercise a retry.
  const settle = async () => { await api.clock.advance(6000); await api.clock.flush(10); };

  // >>> the tab is frozen and the socket dies <<<
  api.wsList[0].fail(1006);
  await sleepFlush(api, 10);
  api.fireVisibility();
  await sleepFlush(api, 20);

  // The server still holds the old entry. It UPGRADES the socket and only then
  // refuses the Join, so the browser sees open-then-4400 — which is why presence,
  // not the socket, is the success signal. Refuse it twice.
  for (const refused of [1, 2]) {
    const n = api.wsList.length;
    const sock = api.wsList[n - 1];
    sock.open();
    ok(!api.chat().some(t => /Back online/.test(t)),
      `attempt ${refused}: an open socket alone must not claim success`);
    sock.fail(4400);
    await settle();
    ok(api.wsList.length > n,
      `attempt ${refused}: no further reconnect was attempted after 4400 (sockets=${api.wsList.length})`);
    ok(api.chat().some(t => /Rejoining/i.test(t)),
      `attempt ${refused}: the sender explains the wait instead of guessing`);
  }

  // Now the server's write finally failed and it accepts the rejoin.
  const back = api.wsList[api.wsList.length - 1];
  back.open();
  ok(!api.chat().some(t => /Back online/.test(t)),
    "still no success claim until the server actually speaks");
  // The server broadcasts presence to every peer right after a successful Join.
  back.onmessage && back.onmessage({ data: JSON.stringify({
    from: "server", to: "sender", kind: "presence", seq: 4,
    payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 20);
  ok(api.chat().some(t => /Back online/.test(t)),
    "the sender is back once presence proves the rejoin");
  api.destroy();
});

// The retry must be BOUNDED. A deleted room makes every upgrade fail forever, and
// an unbounded timer chain on the sender's page is a leak the user cannot clear
// short of reloading.
await test("S9 the sender gives up rather than retrying forever", async () => {
  const { api } = await sxWorld();
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  api.wsList[0].open();
  api.wsList[0].fail(1006);
  await sleepFlush(api, 10);

  let spins = 0, gave = false;
  while (spins++ < 60) {
    await api.clock.advance(6000);
    await api.clock.flush(10);
    const last = api.wsList[api.wsList.length - 1];
    if (last && last.readyState !== 3) last.fail(1006);   // refuse everything
    // The bound is a break in the hammer, NOT a write-off: it stops opening
    // sockets for now and says it is still listening. Telling the sender to
    // restart the share was the bug — it made a transient outage permanent.
    if (api.chat().some(t => /Still trying/i.test(t))) { gave = true; break; }
  }
  ok(gave, `the sender stops hammering instead of looping; chat=${JSON.stringify(api.chat())}`);
  ok(!api.chat().some(t => /Couldn't rejoin/i.test(t)),
    `the share must never be written off while the sender is still in it: ${JSON.stringify(api.chat())}`);
  // And it stops opening sockets: the bound is on attempts, not just on messaging.
  const settled = api.wsList.length;
  await api.clock.advance(30000);
  await api.clock.flush(10);
  ok(api.wsList.length === settled, `retries stopped (${api.wsList.length} vs ${settled} sockets)`);
  api.destroy();
});

// The receiver must be able to rejoin after ITS tab was backgrounded. A
// non-null rSig used to short-circuit ensureSignal forever, so a backgrounded
// receiver froze on stale presence for the rest of the page's life.
await test("R17 a backgrounded receiver rejoins the room", async () => {
  const { api } = await rxWorld();
  eq(api.wsList.length, 1, "receiver signaling up");
  api.wsList[0].open();
  api.wsList[0].fail(1006);
  await sleepFlush(api, 20);
  const before = api.wsList.length;
  api.fireVisibility();
  await sleepFlush(api, 20);
  ok(api.wsList.length > before,
    `receiver opened a fresh socket after its old one closed (had ${before}, now ${api.wsList.length})`);
  api.destroy();
});

// The sender's backpressure gate. app.js refuses to keep writing once the
// channel's buffer is above HIGH_WATER and waits for it to drain; without this
// the sender wedges at ~16MB of a 225MB file (documented in app.js) and the tab
// grows without bound. The stub previously hard-coded bufferedAmount to 0, so
// mutating the gate away (`if (false) await waitDrain(dc)`) still passed
// everything.
await test("S6 sender waits for the datachannel to drain past HIGH_WATER", async () => {
  const { api } = await sxWorld();
  const gate = makeGate();
  // Many chunks: the transfer must NOT be able to finish while stalled, or the
  // test would pass with the backpressure gate deleted (it would simply run to
  // completion and stop growing sent[]).
  const chunk = 262144, chunks = 200;
  sxAddFile(api, gateFile("big.bin", chunk * chunks, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);
  const sentIs = o => dc.sent.some(s => { try { return JSON.parse(s).t === o; } catch { return false; } });
  ok(dc.sent.some(s => { try { return JSON.parse(s).t === "header"; } catch { return false; } }), "sender emitted header");

  // A peer that stops reading. The buffer stays far above the high-water mark,
  // so the sender must park in waitDrain rather than issuing chunk after chunk.
  dc.fillBuffer(64 * 1024 * 1024);
  for (let i = 0; i < 40 && dc.sent.length < 8; i++) { gate.open(10); await sleepFlush(api); }
  const parked = dc.sent.length;
  ok(parked < 30, `sender issued only ${parked} sends before stalling — it is not racing ahead`);

  // Keep the file gate wide open: if the sender were NOT gated on
  // bufferedAmount, every one of these iterations would push another chunk and
  // the transfer would finish.
  for (let i = 0; i < 40; i++) { gate.open(50); await sleepFlush(api); }
  eq(dc.sent.length, parked, "sender issued no further sends while the channel stayed full");
  ok(!sentIs("eof"), "no eof while the channel is stuck — the transfer is genuinely blocked");

  // Drain it and the transfer must resume and finish.
  dc.drainBuffer(0);
  let eofSeen = false;
  for (let i = 0; i < 400 && !eofSeen; i++) {
    gate.open(50);
    await sleepFlush(api);
    eofSeen = sentIs("eof");
  }
  ok(eofSeen, "transfer resumed after the buffer drained and finished");
  ok(dc.sent.length > parked, "and it made further progress after resuming");
  api.destroy();
});

// A peer id is sender-chosen and reaches a querySelector on the receiver.
// Unescaped, one quote throws a DOMException before the receive starts, which
// wedged that file permanently with no visible error.
await test("R15 a hostile file id cannot break the receiver's selector lookup", async () => {
  const { sb, api } = newWorld({
    meta: { files: [{ id: 'x" onload="alert(1)', name: "a.bin", size: 4, mime: "application/octet-stream" }], senderOnline: true },
  });
  await sb.initReceiver();
  await sleepFlush(api); await sleepFlush(api);
  const btn = api.rowBtn('x" onload="alert(1)');
  ok(btn, "row button located for an id containing a quote");
  btn.onclick();
  await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  ok(pc, "a peer connection was created — the click did not throw");
  ok(!/Error|error/.test(btn.textContent), "row is in a live state, not an error state");
  // The row disables itself once a request is queued, which is the point: the
  // click resolved to a live request rather than throwing out of the handler,
  // which is what an unescaped quote did.
  eq(btn.disabled, true, "the click queued a request instead of throwing in the selector lookup");
  api.destroy();
});

// A file already saved under a name must not be truncated by a later transfer
// of the same name. getFileHandle(name, {create:true}) returns the EXISTING
// file and createWritable() with no options truncates it to zero, so a manifest
// with two entries sharing a name destroyed the first download silently.
await test("R16 a duplicate file name never overwrites an already-saved file", async () => {
  // Both entries share a name and BOTH are in the manifest, so the second
  // transfer is a legitimate request rather than an ignored unknown fid.
  // Nothing on the server enforces name uniqueness, so this is reachable.
  const { sb, api } = newWorld({
    meta: {
      files: [
        { id: "fA", name: "dup.bin", size: 4, mime: "application/octet-stream" },
        { id: "fB", name: "dup.bin", size: 4, mime: "application/octet-stream" },
      ],
      senderOnline: true,
    },
  });
  const disk = new Map();
  const saves = [];
  sb.window.showDirectoryPicker = async () => ({
    getFileHandle: async (name, opts) => {
      if (!opts || !opts.create) {
        if (!disk.has(name)) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      }
      return {
        getFile: async () => ({ size: (disk.get(name) || []).length }),
        createWritable: async (wopts) => {
          const buf = (wopts && wopts.keepExistingData && disk.get(name)) ? disk.get(name).slice() : [];
          return {
            write: async c => { buf.push(Buffer.from(c)); },
            close: async () => { disk.set(name, buf); },
            abort: async () => {},
          };
        },
      };
    },
    removeEntry: async name => { disk.delete(name); },
  });
  await sb.initReceiver();
  await sleepFlush(api); await sleepFlush(api);
  api.rowBtn("fA").onclick();
  await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  ok(pc, "peer connection created");
  const dc = dcLiteral();
  api.fireDC(pc, dc);
  await sleepFlush(api);
  dc.onopen && dc.onopen();
  await sleepFlush(api);
  dc.binaryType = "arraybuffer";
  const { createHash } = await import("node:crypto");
  const sha256Hex = b => createHash("sha256").update(b).digest("hex");
  const payload = Buffer.from("good");
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "dup.bin", size: 4, mime: "application/octet-stream" }) });
  await sleepFlush(api, 5);
  dc.onmessage({ data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + 4) });
  await sleepFlush(api, 5);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 4, sha256: sha256Hex(payload) }) });
  await sleepFlush(api, 5);
  eq(Buffer.concat(disk.get("dup.bin") || []).toString(), "good", "first file on disk intact");

  // Now request and receive the second file, which shares that name.
  api.rowBtn("fB").onclick();
  await sleepFlush(api, 5);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fB", idx: 1, name: "dup.bin", size: 4, mime: "application/octet-stream" }) });
  await sleepFlush(api, 5);
  const bad = Buffer.from("EVIL");
  dc.onmessage({ data: bad.buffer.slice(bad.byteOffset, bad.byteOffset + 4) });
  await sleepFlush(api, 5);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fB", idx: 1, bytes: 4, sha256: sha256Hex(bad) }) });
  await sleepFlush(api, 5);
  eq(Buffer.concat(disk.get("dup.bin") || []).toString(), "good",
    "the already-saved file was NOT overwritten by a same-name transfer");
  // The refusal must be explained, not silent: the user has to know a name
  // collided, otherwise a second download that went to the blob path looks like
  // the file they already had.
  ok(api.chat().some(t => /already in that folder|dup\.bin/i.test(t)),
    "the name collision was reported to the user");
  api.destroy();
});

// ---------------------------------------------------------------- share links
// A share link must point at the host that serves the UI. Production sets
// PUBLIC_BASE_URL, so the server returns an ABSOLUTE url naming the API host —
// which on a split deployment serves no UI, so a link built from it 404s for
// the recipient while looking completely normal to the sender.
//
// Staging a file is what triggers room creation, so every case here needs one.
const stageOneFile = api => {
  const f = { name: "a.bin", size: 10, type: "application/octet-stream",
              slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) };
  const picker = api.els("picker");
  picker.files = [f];
  picker.onchange();
};

// A share link must point at the host that serves the UI. Production sets
// PUBLIC_BASE_URL, so the server returns an ABSOLUTE url naming the API host —
// which on a split deployment serves no UI, so a link built from it 404s for
// the recipient while looking completely normal to the sender.
await test("S3 share link uses the SITE origin, not the API host (regression)", async () => {
  const { sb, api } = newWorld({
    pathname: "/",
    siteUrl: "https://files.example.com",
    roomUrl: "https://api-files.example.com/r/ROOM9",
  });
  sb.initSender();
  await sleepFlush(api);
  stageOneFile(api);
  await sleepFlush(api);
  const v = api.els("shareUrl").value;
  eq(v, "https://files.example.com/r/ROOM9", "share link rebased onto the UI host");
  ok(!v.includes("api-files"), "share link must never name the API host");
  api.destroy();
});

await test("S4 a hostile room url cannot move the share link off-site (regression)", async () => {
  // The path is remote input. The guarantee is that the link's ORIGIN is always
  // the site, whatever the server hands back: a "//host/path" tail must not
  // become a protocol-relative URL pointing somewhere else.
  const { sb, api } = newWorld({
    pathname: "/",
    siteUrl: "https://files.example.com",
    roomUrl: "https://api-files.example.com//evil.example/r/ROOM9",
  });
  sb.initSender();
  await sleepFlush(api);
  stageOneFile(api);
  await sleepFlush(api);
  const v = api.els("shareUrl").value;
  ok(!v.startsWith("//"), "must not be protocol-relative, got: " + v);
  eq(new URL(v).origin, "https://files.example.com", "origin stays on the site host");
  ok(!/\/\//.test(new URL(v).pathname), "path has no double slash, got: " + new URL(v).pathname);
  api.destroy();
});

await test("S5 with no baked site url, the page origin is used (single-origin)", async () => {
  // The Go server serves the UI itself in that mode, so the page origin and the
  // API origin are the same host and the link is correct either way.
  const { sb, api } = newWorld({
    pathname: "/",
    siteUrl: "",
    roomUrl: "https://api.example.com/r/ROOM9",
  });
  sb.initSender();
  await sleepFlush(api);
  stageOneFile(api);
  await sleepFlush(api);
  eq(api.els("shareUrl").value, "http://t/r/ROOM9", "falls back to the page origin");
  api.destroy();
});

// ---------------------------------------------------------------- summary
let fails = 0;
for (const [s, n] of results) if (s === "FAIL") fails++;

// Stopping a share is not an outage. Without clearing the comeback state, the
// NEXT share's first presence announces "Back online ✓ — the link works again"
// for a share that never went anywhere, because sigEverLive survived the reset.
await test("S10 a fresh share after Stop does not announce a comeback", async () => {
  const { api } = await sxWorld();
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  api.wsList[0].open();
  api.wsList[0].onmessage && api.wsList[0].onmessage({ data: JSON.stringify({
    from: "server", to: "sender", kind: "presence", seq: 1,
    payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 10);

  // The user stops the share and starts a new one. The socket must be DEAD first:
  // resetShare calls sig.close(), and if the socket was still live sigLive stays
  // true, which masks a stale sigEverLive and hides the bug.
  api.wsList[0].fail(1006);
  await sleepFlush(api, 10);
  api.els("stopBtn").onclick();
  await sleepFlush(api, 20);
  sxAddFile(api, { name: "b.bin", size: 8, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(8).buffer }) });
  api.els("restartBtn").onclick();
  await waitFor(api, () => api.wsList.length > 1, "the new share's socket");
  const fresh = api.wsList[api.wsList.length - 1];
  fresh.open();
  fresh.onmessage && fresh.onmessage({ data: JSON.stringify({
    from: "server", to: "sender", kind: "presence", seq: 1,
    payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 10);
  ok(!api.chat().some(t => /Back online/.test(t)),
    `a new share announced a comeback; chat=${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Second half of the mobile freeze: the WebRTC sessions die with the tab ──
//
// The sender's socket reconnect fixed presence ("connection re-established"),
// and then the transfer still failed with "the sender never started sending".
// Root cause: a frozen tab stops running its DTLS/SCTP keepalives, so the
// association times out while the tab is away — and BOTH ends still report
// connectionState "connected" / channel "open". Every staleness check trusts
// those states, so they all pass. ensureLink returns the dead session to the
// receiver's fresh offer, and the receiver's want goes into a channel nobody is
// reading. Nothing is ever sent, and nothing says why.

// The sender must drop every session when its socket dies. Nothing else will:
// ensureLink returns any link not flagged dead, and a frozen one never is.
await test("S11 a frozen sender drops the peer connections that died with it", async () => {
  const { api } = await sxWorld();
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  api.wsList[0].open();
  await sxLink(api, "rx-1");
  const pc = api.pcList[api.pcList.length - 1];
  // Model the freeze precisely: the association timed out but NOTHING says so.
  pc.connectionState = "connected";
  pc.dc.readyState = "open";
  eq(pc.connectionState, "connected", "the session looks healthy — this is the trap");

  // >>> the tab is frozen and the socket dies <<<
  api.wsList[0].fail(1006);
  await sleepFlush(api, 20);
  eq(pc.connectionState, "closed",
    "the sender kept a peer connection whose far end no longer exists");
  api.destroy();
});

// The receiver must do the same when presence reports the sender offline, which
// is proof its tab froze. A fresh offer applied to a connected peer connection is
// rejected, so the old one has to be gone before the sender can renegotiate.
await test("R18 the receiver rebuilds its peer connection after the sender froze", async () => {
  const { api } = await rxWorld();
  const sig = api.wsList[0];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "x" }), seq: 1 }) });
  await sleepFlush(api, 20);
  const before = api.pcList.length;
  ok(before > 0, "the receiver built a peer connection");
  const pc = api.pcList[before - 1];
  // A frozen association: healthy-looking at the connection level. (The receiver
  // does not create the data channel — it arrives via the sender's
  // createDataChannel + ondatachannel — so there is no dc to model here.)
  pc.connectionState = "connected";

  // >>> the sender's tab froze; presence reports it gone <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await sleepFlush(api, 20);
  eq(pc.connectionState, "closed",
    "the receiver kept a peer connection to a sender whose tab was frozen");

  // And when the sender returns with a fresh offer, it lands on a NEW connection.
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "y" }), seq: 3 }) });
  await sleepFlush(api, 20);
  ok(api.pcList.length > before,
    `the sender's fresh offer reused the dead connection (pcList ${api.pcList.length} vs ${before})`);
  api.destroy();
});

// Download-all queues a request before the channel is usable. The rebuilt channel
// flushes it, so the presence teardown must NOT discard the queue — nothing else
// re-issues it (only the single in-flight pendingReq re-requests itself), so
// clearing it would silently drop a multi-file request.
await test("R19 a Download-all survives the sender's freeze and rebuild", async () => {
  const { api } = await rxWorld();
  const sig = api.wsList[0];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "x" }), seq: 1 }) });
  await sleepFlush(api, 20);
  const before = api.pcList.length;

  // The receiver taps Download-all before the channel is usable.
  api.els("dl").onclick();
  await sleepFlush(api, 20);

  // >>> the sender's tab froze <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await sleepFlush(api, 20);

  // >>> they return; the sender offers on a fresh connection <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "y" }), seq: 3 }) });
  await sleepFlush(api, 20);
  ok(api.pcList.length > before, "a fresh peer connection was built");
  // The sender creates the channel, so the receiver only gets it via
  // ondatachannel — drive that, or there is nothing for the wants to flush onto.
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc);
  await sleepFlush(api, 20);
  dc.onopen && dc.onopen();
  await sleepFlush(api, 20);
  const wants = dc.sent.filter(x => {
    try { const t = JSON.parse(x).t; return t === "want" || t === "wantAll"; } catch { return false; } });
  // Exactly once. wantOne/dlAll record the request in BOTH pendingWants and
  // pendingReq, so flushing the queue and then re-issuing pendingReq sent it twice
  // — the sender queued every file twice and pushed the same bytes twice. Measured
  // before the fix: 2 x wantAll on one rebuilt channel.
  eq(wants.length, 1,
    `the request must survive the rebuild exactly once, got ${wants.length} (${JSON.stringify(dc.sent)})`);
  api.destroy();
});

// ── Item 1: no stale sender-status banner ────────────────────────────────────
//
// "Sender online — ready when you are." was painted once from the REST snapshot
// and never updated, so it went stale the moment the sender's tab froze or came
// back — and it was the one line the receiver read to decide whether to click.
await test("R23 the receiver shows no one-shot sender-status banner", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: true } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  const box = api.els("box");
  const txt = (box.innerHTML || "") + " " + (box.textContent || "");
  ok(!/Sender online — ready when you are/i.test(txt),
    `the stale banner is still on the page: ${JSON.stringify(txt)}`);
  ok(!/Sender offline — ask them to reopen/i.test(txt),
    "and so is its offline twin, which had the same problem");
  // Presence must own the story instead — the file count is all this line can
  // honestly claim at load time.
  ok(api.chat().some(t => /file/i.test(t)), `the file count is still narrated, got ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Item 2: the glare wait must be bounded ───────────────────────────────────
//
// This is the intermittent "reconnected but nothing resumes". The receiver's
// stall watchdog calls restartIce(), which fires negotiationneeded and puts the
// PC in have-local-offer. If the sender is away it is never answered — and the
// offer handler then discarded EVERY offer the sender sent on its return. No
// renegotiation, no resume, no error. Intermittent because it only bites when
// the watchdog fired during the gap.
await test("R24 a stale unanswered offer does not swallow the sender's offer", async () => {
  const { api } = await rxWorld();
  const sig = api.wsList[0];
  sig.open(); // openSignal queues frames while CONNECTING; nothing reaches sig.sent otherwise
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "a" }), seq: 1 }) });
  await sleepFlush(api, 20);
  const pc = api.pcList[0];

  // The watchdog's restartIce: we offer, and nobody is there to answer.
  pc.signalingState = "have-local-offer";
  pc.fire("negotiationneeded");
  await sleepFlush(api, 20);
  eq(pc.signalingState, "have-local-offer", "the receiver put its own offer on the wire");

  // The sender comes back and offers. This is the offer that used to be ignored.
  await api.clock.advance(6000); // past the glare window — our offer is now stale
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "b" }), seq: 2 }) });
  await sleepFlush(api, 20);
  ok(!/Offer rejected/.test(api.chat().join(" ")),
    `the sender's offer was rejected instead of accepted: ${JSON.stringify(api.chat())}`);
  ok(sig.sent.some(f => f.kind === "answer"),
    `no answer was sent — the renegotiation that resumes the transfer never happened (sent: ${JSON.stringify(sig.sent.map(f => f.kind))})`);
  eq(pc.signalingState, "stable", "the receiver did not settle after answering");
  ok(api.chat().some(t => /Connection re-established/.test(t)),
    "the receiver never treated the sender's offer as a renegotiation");
  api.destroy();
});

// Inside the glare window the offer IS ignored: that is deliberate, and losing it
// would reintroduce offer/answer collision.
await test("R25 a genuinely in-flight offer still wins the glare race", async () => {
  const { api } = await rxWorld();
  const sig = api.wsList[0];
  sig.open(); // openSignal queues frames while CONNECTING
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "a" }), seq: 1 }) });
  await sleepFlush(api, 20);
  const pc = api.pcList[0];
  pc.signalingState = "have-local-offer";
  pc.fire("negotiationneeded");
  await sleepFlush(api, 20);
  const before = sig.sent.length;

  // Well inside the window: this is real glare, so ignore the sender's offer.
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "b" }), seq: 2 }) });
  await sleepFlush(api, 20);
  eq(sig.sent.length, before, "answered an offer during real glare — collision risk is back");
  api.destroy();
});

// A throw after the click is accepted must not strand the UI. Left unhandled it
// stranded rxRequesting, which keeps Cancel on screen permanently with no
// transfer behind it — the same dead end the button was added to remove.
await test("R26 a failure while setting up the link does not strand Cancel", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: true } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  // No WebRTC available, e.g. an in-app WebView without it: ensureConn throws.
  sb.RTCPeerConnection = function () { throw new Error("no peer connection support"); };
  api.rowBtn("fA").onclick(); await sleepFlush(api, 20);

  eq(api.rowBtn("fA").textContent, "⬇", "the row was not left mid-flight");
  eq(api.rowBtn("fA").disabled, false, "and it is clickable again");
  await api.clock.advance(1000); await sleepFlush(api, 10); // the 400ms visibility poll
  eq(api.els("rxCancel").hidden, true,
    "Cancel stayed on screen with nothing behind it — rxRequesting was stranded");
  ok(api.chat().some(t => /Could not start/.test(t)),
    `the failure is narrated, got ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Sender progress must reach the total ─────────────────────────────────────
//
// A completely sent 1.5 MB file displayed "1.3 MB of 1.5 MB". Progress writes
// are coalesced into one rAF frame whose callback early-returns once the file
// stops sending, so the LAST frame is always dropped. The bar and the radial
// were forced synchronously at both terminal paths; the byte counters were not.
// At the default 256 KB chunk a 1.5 MB file is 6 chunks, and the display froze
// on chunk 5 — 1.25 MB, which fmt() renders as "1.3 MB".
await test("S12 sender progress reaches the full file size on completion", async () => {
  const { api } = await sxWorld();
  const size = 6 * 262144;                 // 1.5 MB, exactly 6 chunks
  const gate = makeGate();
  sxAddFile(api, gateFile("a.bin", size, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);

  let eofSeen = false;
  for (let i = 0; i < 20 && !eofSeen; i++) {
    gate.open(10);
    await sleepFlush(api);
    eofSeen = dc.sent.some(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } });
  }
  ok(eofSeen, "the whole file went out");
  await sleepFlush(api, 20);

  eq(api.statSent(), "1.5 MB / 1.5 MB",
    `the byte counter stopped short on a fully sent file: ${JSON.stringify(api.statSent())}`);
  eq(api.bar(), 100, "the bar reached 100");
  eq(api.radial(), "100%", "the radial reached 100");
  api.destroy();
});

// The other readout the sender shows ("X of Y") must agree with statSent.
await test("S13 the sender's 'X of Y' readout also reaches the total", async () => {
  const { api } = await sxWorld();
  const size = 6 * 262144;
  const gate = makeGate();
  sxAddFile(api, gateFile("a.bin", size, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);
  let eofSeen = false;
  for (let i = 0; i < 20 && !eofSeen; i++) {
    gate.open(10);
    await sleepFlush(api);
    eofSeen = dc.sent.some(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } });
  }
  await sleepFlush(api, 20);
  const txt = api.els("stats").textContent;
  const m = txt.match(/([\d.]+)\s*(B|KB|MB|GB)\s+of\s+([\d.]+)\s*(B|KB|MB|GB)\s*$/);
  ok(!!m, `the readout is not in "X of Y" form at completion: ${JSON.stringify(txt)}`);
  eq(m[1] + " " + m[2], m[3] + " " + m[4],
    `the "of" readout stopped short on a fully sent file: ${JSON.stringify(txt)}`);
  api.destroy();
});

// A multi-file send must also land on the total, not just the last file's bytes.
await test("S14 progress reaches the total across several files", async () => {
  const { api } = await sxWorld();
  const each = 4 * 262144;                 // 1 MB each
  const gate = makeGate();
  sxAddFile(api, gateFile("a.bin", each, gate));
  sxAddFile(api, gateFile("b.bin", each, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "wantAll" }) });
  await sleepFlush(api);

  let done = false;
  for (let i = 0; i < 30 && !done; i++) {
    gate.open(10);
    await sleepFlush(api);
    done = dc.sent.filter(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } }).length >= 2;
  }
  ok(done, "both files went out");
  await sleepFlush(api, 20);
  ok(/2\.0 MB \/ 2\.0 MB|2 MB \/ 2 MB/.test(api.statSent()),
    `multi-file progress did not reach the total: ${JSON.stringify(api.statSent())}`);
  eq(api.bar(), 100, "the bar reached 100");
  api.destroy();
});

// Progress must be monotonic while sending — never jumping past the total, which
// is what a stale paint over a terminal verdict looks like.
await test("S15 mid-send progress never exceeds the total", async () => {
  const { api } = await sxWorld();
  const size = 8 * 262144;                 // 2 MB
  const gate = makeGate();
  sxAddFile(api, gateFile("a.bin", size, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "want", idx: 0 }) });
  await sleepFlush(api);

  const seen = [];
  for (let i = 0; i < 20; i++) {
    gate.open(4);
    await sleepFlush(api);
    const v = api.bar();
    seen.push(v);
    if (v >= 100) break;
  }
  ok(seen.every(v => v >= 0 && v <= 100), `bar left the 0..100 range: ${JSON.stringify(seen)}`);
  for (let i = 1; i < seen.length; i++) {
    ok(seen[i] >= seen[i - 1], `progress went backwards: ${JSON.stringify(seen)}`);
  }
  api.destroy();
});

// A file finishing is not the transfer finishing. The bar is cumulative
// (sentDone of sentTotal), so forcing it to 100 after each file made a two-file
// send jump 100% → 50% → 100%. Only a drained queue may claim 100.
await test("S16 the bar does not claim 100% while files are still queued", async () => {
  const { api } = await sxWorld();
  const each = 4 * 262144;                 // 1 MB each
  const gate = makeGate();
  sxAddFile(api, gateFile("a.bin", each, gate));
  sxAddFile(api, gateFile("b.bin", each, gate));
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const dc = await sxLink(api);
  dc.onmessage({ data: JSON.stringify({ t: "wantAll" }) });
  await sleepFlush(api);

  // Pace until exactly one of the two files has finished.
  let oneDone = false;
  for (let i = 0; i < 40 && !oneDone; i++) {
    gate.open(10);
    await sleepFlush(api);
    const eofs = dc.sent.filter(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } }).length;
    if (eofs === 1) { oneDone = true; await api.clock.flush(5); await sleepFlush(api, 20); }
  }
  ok(oneDone, "the first file finished");
  ok(api.bar() < 100,
    `the bar claimed 100% with a second file still queued (bar=${api.bar()}, stat="${api.statSent()}")`);
  // Mid-transfer the readout is allowed to lag a coalesced frame — that is what
  // the rAF coalescing is FOR — so only assert it is short of the total, never
  // that it equals the per-file figure. Forcing it per-file is what broke this.
  const shown = api.statSent().match(/([\d.]+)\s*(B|KB|MB|GB)\s*\/\s*([\d.]+)\s*(B|KB|MB|GB)/);
  ok(!!shown, `counters are not in "X / Y" form mid-transfer: ${JSON.stringify(api.statSent())}`);
  ok(shown[1] !== shown[3] || shown[2] !== shown[4],
    `the counters already claimed the full total mid-queue: ${JSON.stringify(api.statSent())}`);

  // And once the queue drains it does reach 100.
  let both = false;
  for (let i = 0; i < 40 && !both; i++) {
    gate.open(10);
    await sleepFlush(api);
    both = dc.sent.filter(s => { try { return JSON.parse(s).t === "eof"; } catch { return false; } }).length >= 2;
  }
  await sleepFlush(api, 20);
  eq(api.bar(), 100, "the bar reached 100 once everything was sent");
  api.destroy();
});

// ── Scenario: rxRequesting is stranded by a bye or a presence-offline ────────
//
// rxRequesting covers the window between accepting a click and pendingReq being
// set — pickDir() awaits a directory picker. If the sender closes the share or
// goes offline during that window, nothing clears it, and the Cancel button stays
// on screen for good with no transfer behind it.
await test("S28 a bye during the picker window does not strand Cancel", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: true } });
  sb.window.showDirectoryPicker = () => new Promise(() => {});   // picker never settles
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  await api.clock.advance(1000); await sleepFlush(api, 10);
  eq(api.els("rxCancel").hidden, false, "Cancel is up while the picker is pending");

  // >>> the sender closes the share <<<
  api.wsList[api.wsList.length - 1].onmessage({ data: JSON.stringify({
    from: "server", to: "rx-1", kind: "bye", seq: 9 }) });
  await api.clock.advance(1000); await sleepFlush(api, 10);
  eq(api.els("rxCancel").hidden, true,
    "Cancel stayed on screen after the share closed — rxRequesting was stranded");
  api.destroy();
});

await test("S29 a presence-offline during the picker window does not strand Cancel", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: true } });
  sb.window.showDirectoryPicker = () => new Promise(() => {});
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  await api.clock.advance(1000); await sleepFlush(api, 10);

  // >>> the sender's tab freezes <<<
  api.wsList[api.wsList.length - 1].onmessage({ data: JSON.stringify({
    from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(1000); await sleepFlush(api, 10);
  eq(api.els("rxCancel").hidden, true,
    "Cancel stayed on screen after the sender went offline — rxRequesting was stranded");
  api.destroy();
});

// ── Scenario: wantOne must re-check senderOnline after the picker ────────────
//
// wantOne checks senderOnline, then awaits pickDir(). If presence flips while the
// picker is up, the want goes out into a channel nobody is reading and the request
// only fails 25s later.
await test("S30 a click does not fire into a channel the sender has left", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: true } });
  let release;
  sb.window.showDirectoryPicker = () => new Promise(r => { release = r; });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  api.rowBtn("fA").onclick(); await sleepFlush(api);

  // The sender leaves while the picker is still up.
  api.wsList[api.wsList.length - 1].onmessage({ data: JSON.stringify({
    from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await sleepFlush(api, 10);
  release();                       // the user finally picks a folder
  await sleepFlush(api, 20);
  ok(api.chat().some(t => /isn.t connected/.test(t)),
    `the click fired anyway: ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Scenario: Download-all with the sender freezing ──────────────────────────
await test("S31 Download-all queues every file and resumes them all", async () => {
  const { api } = await rxWorld();
  api.els("dl").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);
  ok(api.chat().some(t => /restarts by itself/i.test(t)), "told the receiver it will restart");

  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 2 requested files/.test(t)),
    `only one file was resumed: ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Scenario: the sender leaves again before the resume completes ────────────
await test("S32 a resume that gets interrupted again re-queues, not loops", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)), "the first resume fired");

  // >>> and they leave again before it completes <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 4 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);
  ok(api.chat().filter(t => /restarts by itself/i.test(t)).length >= 2,
    `it did not re-queue for a second attempt: ${JSON.stringify(api.chat())}`);
  // And it must not be spinning: no runaway chain of restarts.
  const restarts = api.chat().filter(t => /starting \d+ requested file/.test(t)).length;
  ok(restarts <= 2, `the resume looped ${restarts} times`);
  api.destroy();
});

// ── Scenario: presence flapping ──────────────────────────────────────────────
await test("S33 flapping presence ends resumed, not stuck", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  for (const [seq, online] of [[2, false], [3, true], [4, false], [5, true]]) {
    sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
      payload: JSON.stringify({ peers: online ? ["sender", "rx-1"] : ["rx-1"], senderOnline: online }), seq }) });
    await api.clock.advance(12000); await sleepFlush(api, 20);
  }
  ok(api.chat().some(t => /starting 1 requested file/.test(t)),
    `never resumed after flapping: ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Scenario: a resume that fails again must stop, not retry forever ─────────
await test("S34 a resume that fails again becomes manual, not a loop", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)), "the resume fired");

  // The resumed transfer dies again — this time the receiver's own socket drops,
  // which is NOT a reason to auto-restart.
  api.wsList[api.wsList.length - 1].fail(1006);
  await sleepFlush(api, 20);
  eq(api.rowBtn("fA").textContent, "↻ Resume", "left as a manual restart");
  const restarts = api.chat().filter(t => /starting \d+ requested file/.test(t)).length;
  eq(restarts, 1, `auto-resumed ${restarts} times — it should stop after one failure`);
  api.destroy();
});

// ── Scenario: returning inside the 10s grace saves the transfer ──────────────
//
// The 10s grace is the presence handler's senderGoneT: it waits 10s before
// failing, and a sender returning inside that window cancels it. But the 25s
// watchdog is about BYTES, not presence — so returning is only half of it.
await test("S35 the sender returning inside the grace and then sending completes", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(6000); await sleepFlush(api, 10);   // inside the 10s grace
  ok(api.chat().some(t => /waiting 10s to see if they return/.test(t)), "the grace started");

  // >>> they come back, inside the grace, and actually send <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 20);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral(); api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  const { createHash } = await import("node:crypto");
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000,
    sha256: createHash("sha256").update(Buffer.alloc(1000)).digest("hex") }) });
  await sleepFlush(api, 20);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "the transfer the grace saved completed");
  api.destroy();
});
// ── Scenario: a queued file the sender then removes ──────────────────────────
await test("S36 a queued file the sender removes is not resumed", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: false } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "⏳", "held while the sender is away");

  // The sender removes the file before coming back.
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "receivers", kind: "files",
    payload: JSON.stringify({ files: [{ id: "fB", name: "b.bin", size: 2000, mime: "application/octet-stream" }] }), seq: 2 }) });
  await sleepFlush(api, 20);
  ok(api.rowBtn("fA") === null, "the removed file is gone from the list");

  const pcs = api.pcList.length;
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  eq(api.pcList.length, pcs, "a removed file was resumed — a peer connection was built for it");
  ok(!api.chat().some(t => /starting \d+ requested file/.test(t)),
    `a removed file was announced as restarting: ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Scenario: clicking again after an auto-resume must not double-request ────
await test("S37 a second click after an auto-resume does not double-request", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: false } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 2 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)), "the auto-resume fired");
  const pcs = api.pcList.length;
  api.rowBtn("fA").onclick(); await sleepFlush(api, 20);
  eq(api.pcList.length, pcs, "a second click built a second peer connection");
  api.destroy();
});

// ── Scenario: the sender presses Stop mid-transfer ───────────────────────────
await test("S38 the sender stopping the share ends it definitively", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral(); api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(400).buffer }); await sleepFlush(api);

  api.wsList[api.wsList.length - 1].onmessage({ data: JSON.stringify({
    from: "server", to: "rx-1", kind: "bye", seq: 9 }) });
  await sleepFlush(api, 20);
  eq(api.rowBtn("fA").textContent, "❌", "a closed share is not resumable");
  eq(api.rowBtn("fA").disabled, true, "and the row is not clickable");
  ok(api.chat().some(t => /Sender closed the room/.test(t)), "the close is narrated");
  api.destroy();
});

// ── Scenario: two receivers, one frozen sender ───────────────────────────────
await test("S41 every receiver resumes when the sender returns", async () => {
  const a = await rxWorld();
  const b = await rxWorld();
  for (const w of [a, b]) {
    w.api.rowBtn("fA").onclick(); await sleepFlush(w.api);
    const sig = w.api.wsList[w.api.wsList.length - 1];
    sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
      payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
    await w.api.clock.advance(12000); await sleepFlush(w.api, 20);
  }
  for (const w of [a, b]) {
    const sig = w.api.wsList[w.api.wsList.length - 1];
    sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
      payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
    await sleepFlush(w.api, 30);
    ok(w.api.chat().some(t => /starting 1 requested file/.test(t)),
      `a receiver did not resume: ${JSON.stringify(w.api.chat())}`);
  }
  a.api.destroy(); b.api.destroy();
});

// ── Scenario: cancelling during an auto-resume ───────────────────────────────
await test("S42 a cancel during the restarted transfer works", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)), "the resume fired");
  api.els("rxCancel").onclick(); await sleepFlush(api, 20);
  ok(api.chat().some(t => /cancelled/i.test(t)), "the cancel was honoured");
  ok(!api.log().startsWith("✗"), "and it was not reported as a failure");
  api.destroy();
});

// ── Scenario: a throw inside the release must not drop the queued file ───────
await test("S43 a failed restart attempt keeps the file queued, not lost", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: false } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);

  // The sender returns, but the receiver cannot build a peer connection.
  const RealPC = sb.RTCPeerConnection;
  sb.RTCPeerConnection = function () { throw new Error("no webrtc"); };
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)), "the release announced a restart");
  eq(api.rowBtn("fA").textContent, "↻ Resume",
    `the file was dropped when the restart failed: ${JSON.stringify(api.rowBtn("fA").textContent)}`);
  // And it is still recoverable by hand.
  sb.RTCPeerConnection = RealPC;
  api.rowBtn("fA").onclick(); await sleepFlush(api, 20);
  ok(api.chat().some(t => /Requested/.test(t)),
    `the queued file was lost when the restart failed: ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── The reported scenario, exactly ───────────────────────────────────────────
//
// Sender shares, goes to WhatsApp. Receiver opens the link and clicks Download
// while the sender is already gone — but the REST snapshot still said the sender
// was online, so the click went down the REAL path, not the hold path. The
// sender's tab freeze then kills the transfer before a single byte arrives.
//
// This is the case that needs endRx's explicit fid: `cur` is null because no
// header ever arrived, so deriving the fid from cur silently drops it and the
// transfer is never queued for the sender's return.
await test("S44 the reported scenario: click, sender freezes, sender returns", async () => {
  const { api } = await rxWorld();          // meta.senderOnline: true (stale)
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "⏳", "the click was accepted as a real request");

  // >>> the sender's tab freezes; no byte ever arrives <<<
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);   // past the 10s grace

  ok(api.log().startsWith("✗"), "the attempt failed loudly, got: " + JSON.stringify(api.log()));
  ok(api.chat().some(t => /restarts by itself/i.test(t)),
    `the receiver was not told it would restart: ${JSON.stringify(api.chat())}`);
  eq(api.rowBtn("fA").textContent, "⏳", "queued, not left as a manual Resume");

  // >>> the sender comes back <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)),
    `nothing was restarted: ${JSON.stringify(api.chat())}`);
  // The restart must have re-issued the request. A new peer connection is NOT
  // required: the watchdog's own 10s retry may already have built one, and
  // ensureConn correctly reuses it — the sender's offer renegotiates it. What
  // matters is that the want went out again.
  ok(api.chat().filter(t => /Requested /.test(t)).length >= 2,
    `the request was not re-issued: ${JSON.stringify(api.chat())}`);
  eq(api.rowBtn("fA").textContent, "⏳", "the row shows the restarted request is in flight");
  api.destroy();
});

// ── Scenario: a wedged sender is not a reason to auto-resume ─────────────────
await test("S39 a stalled transfer with the sender online stays manual", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral(); api.fireDC(pc, dc); await sleepFlush(api);
  // The sender is present but sends nothing. Wait the real REQ_DEADLINE_MS (60s),
  // not a stale 25s — and it must still fail rather than wait forever.
  await api.clock.advance(66000); await sleepFlush(api, 20);
  eq(api.rowBtn("fA").textContent, "↻ Resume", "left as a manual restart");
  ok(!api.chat().some(t => /restarts by itself/i.test(t)),
    `it promised an automatic restart it cannot keep: ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Scenario: an auto-resumed transfer must actually complete ────────────────
//
// Building a peer connection and re-sending the want is not the same as the file
// arriving. This drives the resumed request all the way to a saved, verified file.
await test("S40 an auto-resumed transfer completes and saves", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)), "the resume fired");

  // The sender now actually sends the file.
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral();
  api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  const { createHash } = await import("node:crypto");
  const good = createHash("sha256").update(Buffer.alloc(1000)).digest("hex");
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000, sha256: good }) });
  await sleepFlush(api, 20);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "the resumed transfer saved the file");
  ok(api.chat().some(t => /Saved/.test(t)), "and said so");
  api.destroy();
});

// ── Scenario: the whole freeze → resume cycle must still end at 100% ─────────
//
// endRx deletes the interrupted fid from outstandingFids and decrements the
// totals, and wantOne increments them again on the restart. If either side of
// that handoff is wrong the file still arrives but the progress never reaches
// 100% — maybeAllDone() requires receivedCount >= wantedCount AND an empty
// outstandingFids, so a fid that is both queued and outstanding pins the bar
// below full for the rest of the session. Drive the reported scenario all the
// way to a verified save and read the actual progress readouts.
await test("S45 a freeze and auto-resume still ends at 100%", async () => {
  const { api } = await rxWorld();
  const { createHash } = await import("node:crypto");
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];

  // The sender's tab freezes before a single byte arrives.
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 2 }) });
  await api.clock.advance(12000); await sleepFlush(api, 20);

  // ...and returns, which restarts the request on its own.
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 1 requested file/.test(t)), "the resume fired");

  // The sender now actually sends the file.
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral(); api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000,
    sha256: createHash("sha256").update(Buffer.alloc(1000)).digest("hex") }) });
  await sleepFlush(api, 20);

  eq(api.rowBtn("fA").textContent, "✓ Saved", "the resumed transfer saved the file");
  eq(api.bar(), 100, `the progress bar did not reach the total — got ${api.bar()}`);
  eq(api.radial(), "100%", `the radial did not reach the total — got ${JSON.stringify(api.radial())}`);
  ok(!api.peerHint().startsWith("Receiving"), `the readout is still mid-transfer: ${JSON.stringify(api.peerHint())}`);
  api.destroy();
});

// ── Scenario: the share is closed while requests sit queued ──────────────────
//
// A request the receiver queued for the sender's return must NOT survive a bye:
// the share is definitively over, so releasing it later would start a transfer
// against files the sender is no longer offering. The row has to go back to a
// plain Download so the receiver can see the share ended.
await test("S46 closing the share drops requests queued for the sender", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: false } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  eq(api.rowBtn("fA").textContent, "⏳", "the click was held for the sender");

  // >>> the sender ends the share while the request is queued <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "bye", seq: 9 }) });
  await sleepFlush(api, 20);
  ok(api.chat().some(t => /dropped .*the sender ended the share/.test(t)),
    `the queued request was not reported as dropped: ${JSON.stringify(api.chat())}`);
  eq(api.rowBtn("fA").textContent, "⬇", "the row is clickable again, not left queued");
  eq(api.rowBtn("fA").disabled, false, "and not left disabled");

  // Nothing may restart it afterwards.
  const before = api.chat().length;
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 3 }) });
  await sleepFlush(api, 30);
  eq(api.chat().slice(before).filter(t => /starting \d+ requested file/.test(t)).length, 0,
    "a request dropped by a bye was restarted anyway");
  api.destroy();
});

// ── Scenario: a stalled request is re-asked promptly, not after the deadline ─
//
// The watchdog ticks every 5s and re-sends the want once. `>=` on the 10s
// threshold is what makes that re-send land in the FIRST window; a strict `>`
// pushes it to the second tick, so the retry lands after 15s. Assert the retry
// happens inside the window it is documented to use, not merely eventually.
await test("S47 a stalled request is re-asked within its window", async () => {
  const { api } = await rxWorld();
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral(); api.fireDC(pc, dc); await sleepFlush(api);
  // The sender is online but sends nothing at all.
  await api.clock.advance(12000); await sleepFlush(api, 20);
  ok(api.chat().some(t => /hasn't started sending/.test(t)),
    `the request was not re-asked inside the 10s window: ${JSON.stringify(api.chat())}`);
  api.destroy();
});

// ── Scenario: the sender removes a wanted file mid-session ───────────────────
//
// A receiver who asked for two files and then gets one of them withdrawn must
// still be able to finish: the removed file has to leave the totals, otherwise
// the survivor can never satisfy the completion gate and the bar sits at 33%
// ("1.0 KB of 3.0 KB") for the rest of the session with no way to clear it.
await test("S48 a file withdrawn mid-session still lets the rest complete", async () => {
  const { api } = await rxWorld();
  const { createHash } = await import("node:crypto");
  api.els("dl").onclick(); await sleepFlush(api);          // request both files
  const sig = api.wsList[api.wsList.length - 1];

  // The sender withdraws b.bin before either arrives.
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "receivers", kind: "files",
    payload: JSON.stringify({ files: [{ id: "fA", name: "a.bin", size: 1000, mime: "application/octet-stream" }] }), seq: 2 }) });
  await sleepFlush(api, 20);

  // The sender then sends the one file that is still on offer.
  const pc = api.pcList[api.pcList.length - 1];
  const dc = dcLiteral(); api.fireDC(pc, dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000,
    sha256: createHash("sha256").update(Buffer.alloc(1000)).digest("hex") }) });
  await sleepFlush(api, 20);

  eq(api.rowBtn("fA").textContent, "✓ Saved", "the file that was still offered arrived");
  eq(api.bar(), 100, `the session could not complete — bar is ${api.bar()} of 100`);
  eq(api.radial(), "100%", `the session could not complete — radial is ${JSON.stringify(api.radial())}`);
  api.destroy();
});

// ── Scenario: presence flaps offline again DURING the restart ────────────────
//
// releaseHeld asks for each queued file in turn, and each ask awaits the
// directory picker. If the sender's tab freezes again in that window, the next
// file is put back on the queue — but it produces no pendingReq, so the
// "did the restart take?" check cannot tell "re-queued" from "failed". Left
// unhandled it replaced the queued ⏳ with a manual ↻ Resume while the file was
// still on the auto-restart list, so the receiver could start it twice.
await test("S49 a file re-queued mid-restart keeps its queued state", async () => {
  const { sb, api } = newWorld({ meta: { files: filesMeta(), senderOnline: false } });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  const sig = api.wsList[api.wsList.length - 1];
  api.els("dl").onclick(); await sleepFlush(api);            // both files queued
  eq(api.rowBtn("fA").textContent, "⏳", "fA is queued");
  eq(api.rowBtn("fB").textContent, "⏳", "fB is queued");

  // The sender comes back, and the first file's picker opens.
  let release;
  sb.window.showDirectoryPicker = () => new Promise(r => { release = r; });
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-1"], senderOnline: true }), seq: 2 }) });
  await sleepFlush(api, 30);
  ok(api.chat().some(t => /starting 2 requested files/.test(t)), "the restart began");

  // >>> their tab freezes again before the first file is even requested <<<
  sig.onmessage({ data: JSON.stringify({ from: "server", to: "rx-1", kind: "presence",
    payload: JSON.stringify({ peers: ["rx-1"], senderOnline: false }), seq: 3 }) });
  await sleepFlush(api, 10);
  release();                          // the user finally picks a folder
  await sleepFlush(api, 30);

  const queued = [api.rowBtn("fA"), api.rowBtn("fB")].filter(b => b && b.textContent === "⏳");
  ok(queued.length >= 1,
    `a file that was put back on the queue lost its queued state: ` +
    `fA=${JSON.stringify(api.rowBtn("fA").textContent)} fB=${JSON.stringify(api.rowBtn("fB").textContent)}`);
  api.destroy();
});

// ── Scenario: the sender must not hand out a half-built link ────────────────
//
// ensureLink publishes the link into `links` and THEN awaits fetchIce before it
// assigns link.pc. Two callers can reach it at once after a freeze: the presence
// frame makes the sender build the link on its own, and the receiver's rebuilt
// peer connection offers for the same peer at the same moment. The second caller
// got the first one's link back with pc === null, and the offer handler's
// rollback guard threw on it — inside a catch that only chats. The offer was
// dropped silently, the data channel never opened, and the receiver sat at
// "waiting for sender" until its own 25s watchdog fired.
//
// This is the reported failure seen from the other side. The receiver logs that
// it asked again because the sender genuinely never received the request, so no
// amount of receiver-side work fixes it.
//
// The TURN fetch is held open deliberately: a real thawing tab is slow, and that
// is the entire window. Note `from` is the peer id the sender keys links by
// (app.js: `const peer = m.from`).
await test("S50 an offer arriving mid-rebuild is still answered", async () => {
  const { sb, api } = await sxWorld();
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  const sig = api.wsList[0];
  sig.open();
  await sleepFlush(api, 10);

  // Hold the TURN credential fetch open, so the sender is provably mid-build.
  const realFetch = sb.fetch;
  let releaseTurn;
  sb.fetch = (u, o) => /\/turn$/.test(String(u))
    ? new Promise(res => { releaseTurn = () => realFetch(u, o).then(res); })
    : realFetch(u, o);

  // The sender starts building the link on its own, from the presence frame...
  api.wsRecv(sig, { from: "server", to: "receivers", kind: "presence",
    payload: JSON.stringify({ peers: ["sender", "rx-9"], senderOnline: true }) });
  await sleepFlush(api, 10);
  eq(api.pcList.length, 0, "the link is published but not yet built");

  // ...and the receiver's rebuilt peer connection offers for the same peer.
  sig.onmessage({ data: JSON.stringify({ from: "rx-9", to: "sender", kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "v=0\r\n" }) }) });
  await sleepFlush(api, 10);

  // Let the build finish. Both callers must now converge on ONE peer connection.
  releaseTurn();
  await sleepFlush(api, 60);

  const kinds = sig.sent.map(f => f.kind);
  ok(kinds.includes("answer"),
    `the receiver's offer was never answered (sender sent ${JSON.stringify(kinds)}), so the ` +
    `data channel never opened and the receiver waited until its watchdog: ` +
    `${JSON.stringify(api.chat().slice(-4))}`);
  eq(api.pcList.length, 1, `two peer connections were built for one peer: ${api.pcList.length}`);
  ok(!api.errors.length, `the sender threw while answering: ${JSON.stringify(api.errors)}`);
  sb.fetch = realFetch;
});

// ── Scenario: the retry budget must not brick the share ─────────────────────
//
// sigTries only ever reset when presence arrived, and presence can only arrive
// on a socket that joined. So once the budget hit SIG_RETRY_MAX_N the sender was
// stuck for good: every later return to the tab re-printed "Couldn't rejoin",
// opened no sockets at all, and the receivers — who could still load the share
// page — were left with a sender that never came back. Putting the phone down
// twice was enough to lose the share permanently, with only a manual restart to
// recover.
//
// A sender who shares a link to WhatsApp is the exact user who does this.
await test("S51 the sender can still rejoin after exhausting its retries", async () => {
  const { api } = await sxWorld();
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  api.wsList[0].open();
  api.wsList[0].onmessage({ data: JSON.stringify({ from: "server", to: "sender", kind: "presence", seq: 1,
    payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 10);

  // The tab freezes and returns, but the server refuses the rejoin every time.
  // It needs up to one ping interval to notice the dead socket, which is longer
  // than the whole budget.
  const refuse = async () => {
    await api.clock.advance(6000); await api.clock.flush(10);
    const sock = api.wsList[api.wsList.length - 1];
    if (sock.readyState === 0) { sock.open(); sock.fail(4400); }
  };
  api.wsList[0].fail(1006);
  await sleepFlush(api, 10);
  api.fireVisibility();
  for (let i = 0; i < 30 && !api.chat().some(t => /Still trying/.test(t)); i++) await refuse();

  ok(api.chat().some(t => /Still trying/.test(t)),
    `the budget never ran out, so the escalation path is untested: ${JSON.stringify(api.chat().slice(-2))}`);
  ok(!api.chat().some(t => /Couldn't rejoin/.test(t)),
    "the share must not be written off as dead — receivers can still load it");

  // The user comes back to the tab again. This is the whole point: the share has
  // to come back by itself, with no manual restart.
  const before = api.wsList.length;
  api.fireVisibility();
  await refuse();
  ok(api.wsList.length > before,
    `returning to the tab opened no socket — the sender is bricked (${before} -> ${api.wsList.length})`);

  // And it recovers completely once the server accepts.
  const sock = api.wsList[api.wsList.length - 1];
  if (sock.readyState === 0) sock.open();
  sock.onmessage && sock.onmessage({ data: JSON.stringify({ from: "server", to: "sender",
    kind: "presence", seq: 99, payload: JSON.stringify({ peers: ["sender"], senderOnline: true }) }) });
  await sleepFlush(api, 20);
  ok(api.chat().some(t => /Back online/.test(t)),
    `the sender never came back: ${JSON.stringify(api.chat().slice(-3))}`);
  api.destroy();
});

// ── Scenario: a request made while another file streams must survive ────────
//
// The sender keeps ONE queue per receiver and serves it a file at a time, so a
// receiver that asks for a second file while the first is still streaming waits
// for the sender to finish it. The deadline was measured from the CLICK, so it
// expired during that wait — and the failure landed the instant the first file
// finished. The sender got to the second request milliseconds later, and the
// receiver had already given up on it. Nothing was wrong with either side; the
// clock just started at the wrong moment.
//
// This is what "the sender is merely slow" looks like, and it is the same code
// path as a dead sender, so nothing distinguished them.
await test("S52 a request queued behind another transfer is not failed", async () => {
  const { api } = await rxWorld();
  const { createHash } = await import("node:crypto");

  // File A: requested, streaming, and slow.
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = dcLiteral();
  api.fireDC(api.pcList[api.pcList.length - 1], dc); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(400).buffer }); await sleepFlush(api);

  // File B: requested while A is still going. The sender queues it behind A.
  api.rowBtn("fB").onclick(); await sleepFlush(api);
  eq(api.rowBtn("fB").textContent, "⏳", "B is waiting its turn");

  // A takes far longer than the request deadline. B must still be waiting, not
  // failed — the deadline is not running against a sender that is visibly busy.
  await api.clock.advance(70000); await sleepFlush(api, 20);
  eq(api.rowBtn("fB").textContent, "⏳",
    `B was failed while the sender was still streaming A: ${api.log()}`);
  ok(!api.chat().some(t => /never started sending b\.bin/.test(t)),
    `B was written off mid-queue: ${JSON.stringify(api.chat().slice(-3))}`);

  // A finishes. The sender's queue now advances to B, and B starts.
  dc.onmessage({ data: new Uint8Array(600).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000,
    sha256: createHash("sha256").update(Buffer.alloc(1000)).digest("hex") }) });
  await sleepFlush(api, 20);
  eq(api.rowBtn("fA").textContent, "✓ Saved", "A completed");

  // The real gap: A is done, the sender still has to reach the next item in its
  // queue, and the receiver's watchdog ticks every 5s. That window is where the
  // deadline used to fire — with B's clock already spent on A's transfer.
  await api.clock.advance(10000); await sleepFlush(api, 20);
  eq(api.rowBtn("fB").textContent, "⏳",
    `B was failed the moment A finished, before the sender could reach it: ${api.log()}`);

  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fB", idx: 1, name: "b.bin", size: 2000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(2000).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fB", idx: 1, bytes: 2000,
    sha256: createHash("sha256").update(Buffer.alloc(2000)).digest("hex") }) });
  await sleepFlush(api, 20);

  eq(api.rowBtn("fB").textContent, "✓ Saved",
    `B never arrived even though the sender queued it in time: ${api.log()}`);
  api.destroy();
});

// ── Scenario: a slow link is given room to connect ──────────────────────────
//
// The deadline has to outlast link establishment, not just a healthy sender.
// A TURN relay behind a strict NAT routinely takes 20-40s to connect, and the
// app's OWN threshold for "this path is struggling" is 30s of silence. A 25s
// request deadline therefore failed receivers whose link was merely slow and
// still connecting — the sender was never wedged, it was just relayed.
//
// So: the sender answers late, well past the old 25s line, and the transfer
// must still complete. A shorter deadline turns this into "never started
// sending", which is a lie — the sender was there the whole time.
await test("S53 a link that connects late still gets its file", async () => {
  const { api } = await rxWorld();
  const { createHash } = await import("node:crypto");
  api.rowBtn("fA").onclick(); await sleepFlush(api);
  const dc = dcLiteral();
  api.fireDC(api.pcList[api.pcList.length - 1], dc); await sleepFlush(api);

  // The relay finishes connecting and the sender answers, late but well inside
  // the window a strict NAT needs.
  await api.clock.advance(45000); await sleepFlush(api, 20);
  eq(api.rowBtn("fA").textContent, "⏳",
    `the request was failed while the link was still connecting: ${api.log()}`);

  dc.onmessage({ data: JSON.stringify({ t: "header", fid: "fA", idx: 0, name: "a.bin", size: 1000, mime: "application/octet-stream" }) });
  await sleepFlush(api);
  dc.onmessage({ data: new Uint8Array(1000).buffer }); await sleepFlush(api);
  dc.onmessage({ data: JSON.stringify({ t: "eof", fid: "fA", idx: 0, bytes: 1000,
    sha256: createHash("sha256").update(Buffer.alloc(1000)).digest("hex") }) });
  await sleepFlush(api, 20);

  eq(api.rowBtn("fA").textContent, "✓ Saved",
    `a slow but working link was failed: ${api.log()}`);
  eq(api.bar(), 100, "and the transfer still reached 100%");
  api.destroy();
});

// ── Scenario: one socket attempt at a time ──────────────────────────────────
//
// reopenSignal used to guard only on isOpen() (readyState 1), so a foreground
// event while the socket was still connecting opened a SECOND socket.
// onVisible fires on every tap, focus and pageshow — exactly what a user staring
// at their phone generates. Two sockets then raced for the sender slot.
await test("S54 a foreground event mid-connect opens no second socket", async () => {
  const { api } = await sxWorld();
  sxAddFile(api, { name: "a.bin", size: 16, type: "application/octet-stream",
                   slice: () => ({ arrayBuffer: async () => new Uint8Array(16).buffer }) });
  await waitFor(api, () => api.wsList.length > 0, "sender signaling up");
  eq(api.wsList.length, 1, "one socket attempt");

  // The socket is still connecting (readyState 0). The user taps the phone.
  api.fireVisibility();
  await sleepFlush(api, 10);
  api.fireVisibility();
  await sleepFlush(api, 10);
  eq(api.wsList.length, 1,
    `a second socket was opened while the first was still connecting (${api.wsList.length}) — they will race for the sender slot`);
  api.destroy();
});

// ── Code entry on the home page ──────────────────────────────────────────────
//
// The 4-digit nearby-code boxes live on home now (a bare /receive redirects
// there). One initCodeEntry() owns the boxes, goCode, and the type-anywhere
// capture. Setup builds the static boxes first — real HTML has them at parse
// time, so init-time query is the correct behaviour to pin, not a limitation.
const homeBoxes = api => {
  const otpRow = api.els("otpRow");
  for (let i = 0; i < 4; i++) {
    const b = api.els("otp" + i);
    b.className = "otp-digit";
    otpRow.appendChild(b);
  }
  return { otpRow, boxes: otpRow.children.slice() };
};
const homeSender = async () => {
  const { sb, api } = newWorld({ pathname: "/" });
  const h = homeBoxes(api);
  sb.initSender(); await sleepFlush(api, 10);
  return { sb, api, ...h };
};
const keyEv = (target, key, extra = {}) => ({ key, target, preventDefault() {}, ...extra });

await test("C1 typing digits without clicking fills the boxes in order", async () => {
  const { api } = await homeSender();
  const { boxes } = { boxes: api.els("otpRow").children.slice() };
  api.fireDoc("keydown", keyEv(api.els("share"), "1"));
  api.fireDoc("keydown", keyEv(api.els("share"), "2"));
  await sleepFlush(api, 10);
  eq(boxes[0].value, "1", "first digit landed in box 1 without a click");
  eq(boxes[1].value, "2", "second digit landed in box 2");
  eq(boxes[2].value, "", "box 3 stayed empty");
  eq(boxes[3].value, "", "box 4 stayed empty");
  api.destroy();
});

await test("C2 completing all four digits navigates to the room", async () => {
  const { sb, api } = await homeSender();
  const boxes = api.els("otpRow").children.slice();
  const realFetch = sb.fetch;
  sb.fetch = (u, o) => /\/api\/nearby\//.test(String(u))
    ? Promise.resolve({ ok: true, json: async () => ({ id: "ROOM9" }) })
    : realFetch(u, o);
  for (const d of ["1", "2", "3", "4"]) api.fireDoc("keydown", keyEv(api.els("share"), d));
  await sleepFlush(api, 30);
  eq(sb.location.href, "/r/ROOM9", "fourth digit resolved the code and left");
  sb.fetch = realFetch;
  api.destroy();
});

await test("C3 typing inside a text field never touches the boxes", async () => {
  const { api } = await homeSender();
  const boxes = api.els("otpRow").children.slice();
  const field = api.els("shareUrl");
  field.tagName = "INPUT";
  api.fireDoc("keydown", keyEv(field, "1"));
  api.fireDoc("keydown", keyEv(field, "2"));
  await sleepFlush(api, 10);
  ok(boxes.every(b => b.value === ""),
    `keystrokes meant for a text field leaked into the code boxes: ${JSON.stringify(boxes.map(b => b.value))}`);
  api.destroy();
});

await test("C4 modifier keys never trigger capture", async () => {
  const { api } = await homeSender();
  const boxes = api.els("otpRow").children.slice();
  api.fireDoc("keydown", keyEv(api.els("share"), "5", { ctrlKey: true }));
  api.fireDoc("keydown", keyEv(api.els("share"), "6", { metaKey: true }));
  await sleepFlush(api, 10);
  ok(boxes.every(b => b.value === ""), "ctrl/meta digits filled the boxes");
  api.destroy();
});

await test("C5 capture stops when the panel is hidden", async () => {
  const { api } = await homeSender();
  const otpRow = api.els("otpRow");
  const boxes = otpRow.children.slice();
  otpRow.hidden = true;   // the harness proxy for body.sharing display:none
  api.fireDoc("keydown", keyEv(api.els("share"), "7"));
  await sleepFlush(api, 10);
  ok(boxes.every(b => b.value === ""),
    "a digit reached the boxes after sharing started hiding the panel");
  api.destroy();
});

await test("C6 a pasted code fills the boxes without clicking", async () => {
  const { api } = await homeSender();
  const boxes = api.els("otpRow").children.slice();
  api.fireDoc("paste", { target: api.els("share"), preventDefault() {},
    clipboardData: { getData: () => "ab12cd" } });
  await sleepFlush(api, 10);
  eq(boxes.map(b => b.value).join(""), "12", "pasted digits landed, letters stripped");
  api.destroy();
});

await test("C7 a bare /receive lands on the home page", async () => {
  const { sb, api } = newWorld({ pathname: "/receive" });
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api);
  // Serving is untouched (/r/<id> still resolves here) — only the entry page
  // with no room to join bounces. A 4-digit ?c= deep link must keep resolving.
  eq(sb.location.href, "/", "bare /receive did not land on home");
  api.destroy();
});

await test("C8 a ?c= deep link still resolves instead of bouncing", async () => {
  const { sb, api } = newWorld({ pathname: "/receive" });
  sb.location.search = "?c=1234";
  const p = sb.initReceiver(); await sleepFlush(api); await p; await sleepFlush(api, 20);
  ok(sb.location.href !== "/", "a deep link was bounced home instead of resolved");
  // The stub API 404s the code, so this pins the failure branch: explained in
  // place, in the box — never bounced, never silent.
  ok(/Code not found/.test(api.els("box").textContent),
    `the deep link was neither resolved nor explained: href=${sb.location.href} box=${JSON.stringify(api.els("box").textContent)}`);
  api.destroy();
});

// ── Receive anchor while sharing + guide glow ────────────────────────────────
//
// Clicking Receive mid-share used to do nothing at all: the panel is hidden, so
// the anchor has no visible target and the browser scrolls nowhere. The send
// keeps running behind a page the user has mentally left.
const receiveAnchor = api => {
  const a = api.els("navReceive");
  a.tagName = "A";
  a.getAttribute = () => "#receiveEntry";
  return a;
};

await test("C9 Receive mid-share cancels the send and lands home", async () => {
  const { sb, api } = await homeSender();
  sb.document.body.classList.add("sharing");
  let prevented = false, reloaded = false;
  sb.location.reload = () => { reloaded = true; };
  api.fireDoc("click", { target: receiveAnchor(api), preventDefault() { prevented = true; } });
  await sleepFlush(api, 10);
  // A full reload, not an in-page unwind: the socket closes, the server marks
  // the sender gone, and home lands idle. Anything less risks a half-stopped
  // transfer still pushing bytes. And it must be a REAL reload: a bare href
  // assignment never leaves "/" (same path, only the hash differs), so the
  // live send kept running and the click did nothing — exactly the report.
  ok(prevented, "the dead anchor scroll was not suppressed");
  eq(sb.location.hash, "receiveEntry", "the landing lost its door"); // hash stores bare; the # is added on serialize
  ok(reloaded, "no reload happened — a hash-only assignment never leaves the page");
  api.destroy();
});

await test("C13 Receive before the room exists glides, never reloads", async () => {
  const { sb, api } = await homeSender();
  // Files picked but the room POST has not resolved: started, yet no sharing
  // class and the panel still visible. There is nothing to cancel, so this must
  // behave like idle — glide and guide — and above all must not reload.
  let prevented = false;
  api.fireDoc("click", { target: receiveAnchor(api), preventDefault() { prevented = true; } });
  await sleepFlush(api, 10);
  ok(!prevented, "a pre-room click reloaded instead of gliding");
  ok(api.els("receiveEntry").classList.contains("guide"), "no guide on a visible panel");
  api.destroy();
});

await test("C10 Receive clicked while idle guides the eye, staying put", async () => {
  const { sb, api } = await homeSender();
  let prevented = false;
  api.fireDoc("click", { target: receiveAnchor(api), preventDefault() { prevented = true; } });
  await sleepFlush(api, 10);
  ok(!prevented, "the idle anchor scroll was suppressed — it must glide, not reload");
  ok(api.els("receiveEntry").classList.contains("guide"),
    "no guide glow on the panel the anchor points at");
  api.destroy();
});

await test("C12 other links pass through untouched", async () => {
  const { sb, api } = await homeSender();
  const other = api.els("navPrivacy");
  other.tagName = "A";
  other.getAttribute = () => "/privacy";
  let prevented = false;
  sb.document.body.classList.add("sharing");
  api.fireDoc("click", { target: other, preventDefault() { prevented = true; } });
  await sleepFlush(api, 10);
  // Even mid-share, a non-receive link is none of this handler's business: no
  // reload, no suppression, no glow. Broadening the match to every anchor must
  // fail here — that is what keeps the handler honest.
  ok(!prevented, "an unrelated link was suppressed mid-share");
  ok(sb.location.href !== "/#receiveEntry", "an unrelated link reloaded home mid-share");
  ok(!api.els("receiveEntry").classList.contains("guide"), "an unrelated link lit the guide");
  api.destroy();
});

await test("C11 landing with #receiveEntry already set guides too", async () => {
  const { sb, api } = newWorld({ pathname: "/" });
  sb.location.hash = "#receiveEntry";
  const h = homeBoxes(api);
  sb.initSender(); await sleepFlush(api, 10);
  // Covers the reload back from a share, bookmarks, and back-button: the user
  // arrives pointed at the panel, so the panel says hello.
  ok(api.els("receiveEntry").classList.contains("guide"),
    "no guide glow on a load already carrying the hash");
  api.destroy();
});

// ---------------------------------------------------------------- known gaps
// A mutation that leaves this suite green is not automatically a missing test.
// These five are deliberately not distinguished, with the reason each one is kept
// anyway. They are listed so a future reader does not read the green suite as
// coverage that does not exist.
//
//  1. `endRx`'s fid at the 25s watchdog's `resume: !senderOnline` branch. That
//     branch is currently unreachable with a fid to lose: presence going offline
//     always arms the 10s grace, which fails the request first. Kept because it is
//     the difference between queueing one file and queueing every outstanding one
//     if that ordering ever changes.
//  2. `endRx`'s fid at the `bye` path. A bye is definitive, so `resume` is false
//     and the fid only affects the totals. Without it a bye mid-transfer leaves a
//     wanted file that can never arrive, pinning the bar below 100% for the rest
//     of the session — a wrong progress bar, not a missing feature.
//  3. `recomputeWanted()` inside `maybeAllDone`. Every mutation of `wantedFids`
//     already recomputes, so the call at the decision point is a consistency check
//     rather than load-bearing logic.
//  4-6. `wantedFids` cleanup on the two "could not start" paths and on cancelling a
//     queued request. Each is counter hygiene in a state where no bytes are
//     flowing, so no readout differs; they are kept because leaving a stale entry
//     behind is how the double-count bug in this same file started.

console.log(`\n${results.length - fails}/${results.length} green`);
process.exit(fails ? 1 : 0);
