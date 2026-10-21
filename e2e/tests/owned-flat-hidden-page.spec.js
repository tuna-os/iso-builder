// Falsification: extra/replayed/unpaused/unowned hidden targets, failed OPFS,
// substituted or incomplete downloads, unsafe saved paths and failed cleanup
// must reject. Mock success is not actual Chromium capability or ISO evidence.
const { test, expect } = require("@playwright/test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { launchOwnedChromium, deadline, prerequisiteDiagnosticsFor, launchProvenanceFor, launchLifecycleFor, launchLifecycleObservation, FlatConnection } = require("./owned-flat-cdp");
const { runHiddenPageProbe, diagnosticsFor, createDirectory, removeDirectory, readDownload, OPFS, DOWNLOAD } = require("./owned-flat-hidden-page");
const ORIGIN = "http://127.0.0.1:1234", GUID = "01234567-89ab-cdef-0123-456789abcdef";
const digest = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
async function rejected(promise) { try { await promise; throw Error("expected rejection"); } catch (error) { return error; } }
function fixture(mode = "valid") {
  const c = new EventEmitter(); c.socket = {}; c.closed = false; c.calls = []; let created = false, navigation = false, resumed = false, closes = 0, removes = 0, reads = 0;
  const target = () => ({ targetId: "target", type: "other", browserContextId: "context", url: navigation ? ORIGIN + "/" : "about:blank", attached: true });
  const emit = (method, params, sessionId) => c.emit("event", { method, params, sessionId });
  c.send = async (method, params, sessionId) => {
    c.calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: created ? mode === "final-extra" ? [target(), target()] : [{ ...target(),
      ...(mode === "final-blank" ? { url: "about:blank" } : {}), ...(mode === "final-unattached" ? { attached: false } : {}) }] : mode === "initial-extra" ? [target()] : [] };
    if (method === "Target.createBrowserContext") return { browserContextId: "context" };
    if (method === "Target.createTarget") {
      if (mode === "creation-failed") throw Error("https://SECRET.invalid HEADER_SECRET BODY_SECRET");
      if (mode === "creation-timeout") return new Promise(() => {});
      created = true; const info = target();
      if (mode === "wrong-context") info.browserContextId = "foreign";
      if (mode === "wrong-type") info.type = "page";
      if (mode === "wrong-url") info.url = "https://SECRET.invalid";
      if (["initial-empty", "missing-blank", "wrong-blank-frame", "wrong-blank-target", "wrong-blank-url", "extra-before-blank"].includes(mode)) info.url = "";
      if (mode === "opener") info.openerId = "unexpected";
      const attach = () => emit("Target.attachedToTarget", { targetInfo: info, sessionId: "session", waitingForDebugger: mode !== "unpaused" }, mode === "nested-session" ? "foreign" : undefined);
      if (mode === "attach-first") attach();
      if (mode !== "missing-created") emit("Target.targetCreated", { targetInfo: info });
      if (mode === "extra-target") emit("Target.targetCreated", { targetInfo: { ...info, targetId: "unexpected" } });
      if (mode === "duplicate-created") emit("Target.targetCreated", { targetInfo: info });
      if (mode !== "missing-attached" && mode !== "attach-first") attach();
      if (mode === "duplicate-attached") attach();
      return { targetId: mode === "reply-mismatch" ? "wrong" : "target" };
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", url: !resumed && ["initial-empty", "missing-blank", "wrong-blank-frame", "wrong-blank-target", "wrong-blank-url", "extra-before-blank"].includes(mode) ? "" : "about:blank" } } };
    if (method === "Target.getTargetInfo") return { targetInfo: { ...target(), ...(mode === "wrong-blank-target" ? { targetId: "wrong" } : {}) } };
    if (method === "Runtime.runIfWaitingForDebugger") {
      resumed = true;
      if (mode === "extra-before-blank") emit("Target.targetCreated", { targetInfo: { ...target(), targetId: "unexpected" } });
      if (mode !== "missing-blank") emit("Page.frameNavigated", { frame: { id: mode === "wrong-blank-frame" ? "wrong" : "frame", url: mode === "wrong-blank-url" ? "https://SECRET.invalid" : "about:blank" } }, "session");
    }
    if (method === "Runtime.enable") emit("Runtime.executionContextCreated", { context: { id: 1, origin: "://", auxData: { isDefault: true, frameId: "frame" } } }, "session");
    if (method === "Page.navigate") {
      navigation = true; emit("Runtime.executionContextsCleared", {}, "session");
      emit("Target.targetInfoChanged", { targetInfo: target() });
      emit("Page.frameNavigated", { frame: { id: mode === "wrong-frame" ? "foreign" : "frame", url: ORIGIN + "/" } }, "session");
      emit("Runtime.executionContextCreated", { context: { id: 2, origin: ORIGIN, auxData: { isDefault: true, frameId: "frame" } } }, "session");
      emit("Page.loadEventFired", {}, "session"); return { frameId: "frame" };
    }
    if (method === "Runtime.evaluate" && params.awaitPromise) {
      if (mode === "opfs-failed") return { exceptionDetails: { text: "SECRET" } };
      return { result: { type: "object", value: { size: OPFS.length, bytes: mode === "opfs-mismatch" ? [...OPFS].reverse() : [...OPFS] } } };
    }
    if (method === "Runtime.evaluate") {
      const begin = { guid: mode === "bad-guid" ? "../SECRET" : GUID, frameId: mode === "download-frame" ? "foreign" : "frame", url: mode === "download-url" ? "https://SECRET.invalid" : ORIGIN + "/tiny.bin" };
      const progress = { guid: mode === "progress-guid" ? "ffffffff-ffff-ffff-ffff-ffffffffffff" : GUID, state: mode === "cancelled" ? "canceled" : "completed", receivedBytes: DOWNLOAD.length, totalBytes: mode === "wrong-size" ? DOWNLOAD.length + 1 : DOWNLOAD.length };
      if (mode !== "missing-download") emit("Browser.downloadWillBegin", begin);
      if (mode === "duplicate-download") emit("Browser.downloadWillBegin", begin);
      if (mode !== "missing-download" && mode !== "missing-completion") emit("Browser.downloadProgress", progress);
      if (mode === "duplicate-completion") emit("Browser.downloadProgress", progress);
      return { result: { type: "boolean", value: true } };
    }
    return {};
  };
  const owned = { connection: c, async verify() {}, async close() {
    closes++; if (mode === "late-extra") emit("Target.targetCreated", { targetInfo: { ...target(), targetId: "late" } });
    c.closed = true; if (mode === "cleanup-failed") throw Error("SECRET");
  } };
  const io = { async createDirectory() { return { name: "/SECRET-owned-directory" }; }, async removeDirectory() { removes++; if (mode === "remove-failed") throw Error("SECRET"); },
    async readDownload() { reads++; return { sizeBytes: DOWNLOAD.length, sha256: mode === "saved-mismatch" ? digest(OPFS) : digest(DOWNLOAD) }; } };
  return { c, owned, io, emit, run: () => runHiddenPageProbe(owned, { documentURL: ORIGIN + "/", downloadURL: ORIGIN + "/tiny.bin", timeoutMs: 30 }, io),
    get closes() { return closes; }, get removes() { return removes; }, get reads() { return reads; } };
}
for (const mode of ["valid", "attach-first", "initial-empty"]) test(`hidden target ${mode} binds exact requested identity before setup/resume`, async () => {
  const f = fixture(mode), result = await f.run();
  expect(result).toMatchObject({ success: true, targetBound: true, pausedAttachmentObserved: true, initialBlankVerified: true, opfsMeasured: true, downloadCompleted: true,
    savedDownload: { sizeBytes: DOWNLOAD.length, sha256: digest(DOWNLOAD) }, terminalCleanupVerified: true, completeCoverage: false, collectorProofEstablished: false });
  expect(f.c.calls.find(call => call.method === "Target.createTarget").params).toEqual({ url: "about:blank", browserContextId: "context", hidden: true });
  expect(f.c.calls.find(call => call.method === "Target.setAutoAttach").params).toMatchObject({ waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "other", exclude: false }, { exclude: true }] });
  const resume = f.c.calls.findIndex(call => call.method === "Runtime.runIfWaitingForDebugger");
  for (const method of ["Page.getFrameTree", "Page.enable", "Runtime.enable", "Network.enable", "Network.setCacheDisabled", "Network.setBypassServiceWorker"]) expect(f.c.calls.findIndex(call => call.method === method)).toBeLessThan(resume);
  expect(f.c.calls.find(call => call.method === "Browser.setDownloadBehavior").params).toMatchObject({ behavior: "allowAndName", eventsEnabled: true, browserContextId: "context" });
  expect(f.closes).toBe(1); expect(f.removes).toBe(1); expect(f.reads).toBe(1); expect(JSON.stringify(result)).not.toContain("SECRET");
});
for (const mode of ["missing-blank", "wrong-blank-frame", "wrong-blank-target", "wrong-blank-url", "extra-before-blank"]) test(`hidden pending empty target rejects ${mode} before fixture navigation`, async () => {
  const f = fixture(mode), report = diagnosticsFor(await rejected(f.run()));
  expect(report.success).toBe(false); expect(report.initialBlankVerified).toBe(false);
  expect(f.c.calls.some(call => ["Page.navigate", "Runtime.evaluate"].includes(call.method))).toBe(false);
  expect(report.downloadStarted).toBe(false); expect(f.reads).toBe(0); expect(f.closes).toBe(1);
});
for (const mode of ["initial-extra", "creation-failed", "creation-timeout", "wrong-context", "wrong-type", "wrong-url", "opener", "unpaused", "nested-session",
  "missing-created", "missing-attached", "extra-target", "duplicate-created", "duplicate-attached", "reply-mismatch"]) test(`hidden target rejects ${mode} before any resume`, async () => {
  const f = fixture(mode), error = await rejected(f.run()), report = diagnosticsFor(error);
  expect(report.success).toBe(false); expect(report.targetBound).toBe(false);
  expect(f.c.calls.some(call => call.method === "Runtime.runIfWaitingForDebugger")).toBe(false);
  expect(f.closes).toBe(1); expect(f.removes).toBe(1); expect(f.reads).toBe(0); expect(error.message + error.stack + JSON.stringify(report)).not.toContain("SECRET");
});
for (const mode of ["wrong-frame", "opfs-failed", "opfs-mismatch", "bad-guid", "download-frame", "download-url", "progress-guid", "cancelled", "wrong-size",
  "duplicate-download", "duplicate-completion", "missing-download", "missing-completion", "saved-mismatch", "final-extra", "final-blank", "final-unattached", "late-extra", "cleanup-failed", "remove-failed"]) test(`hidden capability rejects ${mode} and still cleans up`, async () => {
  const f = fixture(mode), error = await rejected(f.run()), report = diagnosticsFor(error);
  expect(report.success).toBe(false); expect(report.completeCoverage).toBe(false); expect(report.collectorProofEstablished).toBe(false);
  expect(f.closes).toBe(1); expect(f.removes).toBe(1); expect(error.message + error.stack + JSON.stringify(report)).not.toContain("SECRET");
  expect(Object.isFrozen(report)).toBe(true); expect(Object.isFrozen(report.trace)).toBe(true);
  if (["cleanup-failed", "remove-failed"].includes(mode)) expect(report.terminalCleanupVerified).toBe(false);
});
for (const mode of ["valid", "symlink", "directory", "short", "oversize", "wrong-bytes"]) test(`saved hidden download ${mode} uses bounded no-follow file verification`, async () => {
  const directory = await createDirectory(), filename = path.join(directory.name, GUID);
  try {
    if (mode === "symlink") { await fs.writeFile(path.join(directory.name, "source"), DOWNLOAD); await fs.symlink("source", filename); }
    else if (mode === "directory") await fs.mkdir(filename);
    else await fs.writeFile(filename, mode === "short" ? DOWNLOAD.subarray(1) : mode === "oversize" ? Buffer.concat([DOWNLOAD, DOWNLOAD]) : mode === "wrong-bytes" ? Buffer.alloc(DOWNLOAD.length) : DOWNLOAD);
    if (mode === "valid") expect(await readDownload(directory, GUID)).toEqual({ sizeBytes: DOWNLOAD.length, sha256: digest(DOWNLOAD) });
    else await expect(readDownload(directory, GUID)).rejects.toThrow(/^owned-hidden-page:/);
  } finally { await removeDirectory(directory); }
});
test("saved hidden download rejects path traversal before filesystem access", async () => {
  await expect(readDownload({ name: "/does-not-exist" }, "../SECRET")).rejects.toThrow("download-guid-invalid");
});
for (const mode of ["changed-stat", "replaced-path", "close-failed"]) test(`saved hidden download rejects ${mode} after exact bytes were read`, async () => {
  const directory = await createDirectory(), filename = path.join(directory.name, GUID); await fs.writeFile(filename, DOWNLOAD);
  let stats = 0;
  const io = { async lstat(name) { const stat = await fs.lstat(name); if (name === filename && mode === "replaced-path") stat.ino++; return stat; },
    async open(name, flags) { const file = await fs.open(name, flags); return {
      read: (...args) => file.read(...args), async stat() { const stat = await file.stat(); if (++stats === 2 && mode === "changed-stat") stat.mtimeMs++; return stat; },
      async close() { await file.close(); if (mode === "close-failed") throw Error("SECRET"); }
    }; } };
  try { await expect(readDownload(directory, GUID, io)).rejects.toThrow(/^owned-hidden-page:/); } finally { await removeDirectory(directory); }
});

test("owned hidden page real Chromium exact paused target OPFS and completed saved download", async () => {
  test.setTimeout(40000); let owned, server, result, failure, prerequisites = null, provenance = null, lifecycle = null, report = null;
  const requests = { document: 0, download: 0, rejected: 0 };
  try {
    server = http.createServer((request, response) => {
      if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      const document = request.url === "/", download = request.url === "/tiny.bin";
      if (request.method !== "GET" || (!document && !download)) { requests.rejected++; response.writeHead(404); response.end(); return; }
      requests[document ? "document" : "download"]++;
      const bytes = document ? Buffer.from("<!doctype html><meta charset=utf-8><title>hidden capability</title><body></body>") : DOWNLOAD;
      response.writeHead(200, { "Content-Type": document ? "text/html" : "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store", ...(download ? { "Content-Disposition": "attachment; filename=tiny.bin" } : {}) }); response.end(bytes);
    });
    await deadline(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 1000, "hidden-server-timeout");
    const origin = `http://127.0.0.1:${server.address().port}`;
    owned = await launchOwnedChromium({ suppressComponentBackgroundExtensions: true }); prerequisites = owned.prerequisites; provenance = owned.provenance;
    result = await runHiddenPageProbe(owned, { documentURL: origin + "/", downloadURL: origin + "/tiny.bin" });
    expect(requests).toEqual({ document: 1, download: 1, rejected: 0 });
    expect(result).toMatchObject({ success: true, targetBound: true, opfsMeasured: true, downloadCompleted: true, terminalCleanupVerified: true, completeCoverage: false, collectorProofEstablished: false });
  } catch (error) {
    prerequisites ||= prerequisiteDiagnosticsFor(error); provenance ||= launchProvenanceFor(error); lifecycle ||= launchLifecycleFor(error); report = diagnosticsFor(error);
    failure = new Error("owned-hidden-page:real-capability-failed");
  } finally {
    try { if (owned) await owned.close(); } catch { failure ||= new Error("owned-hidden-page:cleanup-failed"); }
    if (server) { server.closeAllConnections(); try { await deadline(new Promise(resolve => server.close(resolve)), 1000, "hidden-server-close-timeout"); } catch { failure ||= new Error("owned-hidden-page:server-cleanup-failed"); } }
    console.log(`OWNED_HIDDEN_PAGE_CAPABILITY ${JSON.stringify({ success: !failure, observation: result || report, prerequisites, provenance, lifecycle: owned?.lifecycle?.() || lifecycle, requests,
      completeCoverage: false, collectorProofEstablished: false })}`);
  }
  if (failure) throw failure;
});

// Falsification: a rejected command plus later cleanup failure must preserve
// both original fixed causes without exposing either raw exception or data.
test("hidden rejection report retains first protocol category and separate cleanup failure", async () => {
  const f = fixture(), send = f.c.send.bind(f.c);
  const socket = new EventEmitter(); socket.addEventListener = socket.on.bind(socket); socket.close = () => {};
  socket.send = text => { const packet = JSON.parse(text); socket.emit("message", { data: JSON.stringify({ id: packet.id,
    error: { code: -32000, message: "Hidden target can be created only when remote debugging is enabled", data: "SECRET" } }) }); };
  const transport = new FlatConnection(socket); f.c.diagnostics = () => transport.diagnostics();
  f.c.send = async (...args) => {
    if (args[0] !== "Target.createTarget") return send(...args);
    try { await transport.send(...args); } catch (error) { f.c.failure = error; f.c.emit("failure", error); throw error; }
  };
  f.owned.close = async () => { f.c.closed = true; throw Error("owned-cdp:cleanup-listener-survived"); };
  f.io.removeDirectory = async () => { throw Error("SECRET directory cleanup"); };
  f.owned.lifecycle = () => launchLifecycleObservation({ child: { exitCode: 0, signalCode: null }, exitObserved: true,
    exitPhase: "during-cleanup", cleanupStatus: "failed", cleanupFailure: "cleanup-listener-survived" });
  const error = await rejected(f.run()), report = diagnosticsFor(error);
  expect(report.reason).toBe("transport-failed"); expect(report.firstCleanupFailure).toBe("cleanup-listener-survived");
  expect(report.transport.firstFailure).toEqual({ reason: "command-rejected", command: { method: "Target.createTarget", protocolCode: -32000, messageCategory: "hidden-remote-debugging-required" } });
  expect(report.lifecycle).toMatchObject({ exitObserved: true, exitPhase: "during-cleanup", firstCleanupFailure: "cleanup-listener-survived" });
  expect(report).toMatchObject({ success: false, targetBound: false, opfsMeasured: false, downloadCompleted: false, terminalCleanupVerified: false, completeCoverage: false });
  expect(JSON.stringify(report) + error.stack).not.toContain("SECRET");
  expect(f.c.calls.some(item => /Page.navigate|Runtime.evaluate|runIfWaiting/.test(item.method))).toBe(false); transport.close();
});
test("hidden cleanup unknown exception stays fixed without replacing initial probe rejection", async () => {
  const f = fixture("creation-failed"); f.owned.close = async () => { throw Error("https://SECRET.invalid/path?token=SECRET"); };
  const report = diagnosticsFor(await rejected(f.run()));
  expect(report.reason).toBe("stage-failed"); expect(report.firstCleanupFailure).toBe("other");
  expect(report.transport).toBe(null); expect(report.lifecycle).toBe(null); expect(JSON.stringify(report)).not.toContain("SECRET");
});
