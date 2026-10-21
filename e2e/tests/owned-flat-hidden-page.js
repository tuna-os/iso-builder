// Separate same-CfT capability probe. It does not admit a frontend observation.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { deadline, diagnosticCode } = require("./owned-flat-cdp");
const reports = new WeakMap(), codes = new WeakMap();
const bad = code => { const error = new Error(`owned-hidden-page:${code}`); codes.set(error, code); return error; };
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const guid = value => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const sha = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const DOWNLOAD = Buffer.from("owned hidden page saved download v1\n");
const OPFS = Buffer.from("owned hidden page OPFS v1\n");
const EVENTS = new Set(["Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget", "Target.targetDestroyed",
  "Target.targetCrashed", "Target.detachedFromTarget", "Inspector.detached", "Page.frameNavigated", "Page.frameAttached", "Page.frameDetached",
  "Page.loadEventFired", "Page.windowOpen", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
  "Browser.downloadWillBegin", "Browser.downloadProgress"]);
function diagnosticsFor(error) { return reports.get(error) || null; }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
async function createDirectory() {
  const name = await fs.mkdtemp(path.join(os.tmpdir(), "iso285-hidden-download-"));
  try {
    const stat = await fs.lstat(name);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw bad("download-directory-invalid");
    return { name, dev: stat.dev, ino: stat.ino, uid: stat.uid };
  } catch { await fs.rm(name, { recursive: true, force: true }); throw bad("download-directory-invalid"); }
}
async function checkDirectory(directory, io = fs) {
  const stat = await io.lstat(directory.name);
  if (!stat.isDirectory() || stat.dev !== directory.dev || stat.ino !== directory.ino || stat.uid !== directory.uid || (stat.mode & 0o777) !== 0o700) throw bad("download-directory-changed");
}
async function removeDirectory(directory) { await checkDirectory(directory); await fs.rm(directory.name, { recursive: true, force: true }); }
async function readDownload(directory, name, io = fs) {
  if (!guid(name)) throw bad("download-guid-invalid");
  let file;
  try {
    await checkDirectory(directory, io);
    const filename = path.join(directory.name, name);
    file = await io.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size !== DOWNLOAD.length || before.uid !== directory.uid) throw bad("download-file-invalid");
    const bytes = Buffer.alloc(DOWNLOAD.length + 1); let count = 0;
    while (count < bytes.length) { const result = await file.read(bytes, count, bytes.length - count, null); if (!result.bytesRead) break; count += result.bytesRead; }
    const after = await file.stat(), current = await io.lstat(filename);
    await checkDirectory(directory, io);
    if (!current.isFile() || !sameFile(before, after) || !sameFile(after, current) || count !== DOWNLOAD.length || !bytes.subarray(0, count).equals(DOWNLOAD)) throw bad("download-file-mismatch");
    return Object.freeze({ sizeBytes: count, sha256: sha(bytes.subarray(0, count)) });
  } catch (error) { throw bad(codes.get(error) || "download-file-unavailable"); }
  finally { try { await file?.close(); } catch { throw bad("download-file-close-failed"); } }
}
const defaultIO = { createDirectory, removeDirectory, readDownload };
const OPFS_EXPRESSION = `(async()=>{const bytes=new Uint8Array(${JSON.stringify([...OPFS])});
 if(!navigator.storage?.getDirectory)throw Error("OPFS unavailable");const root=await navigator.storage.getDirectory();
 const handle=await root.getFileHandle("hidden-probe.bin",{create:true});const writer=await handle.createWritable();
 await writer.write(bytes);await writer.close();const file=await handle.getFile();if(file.size>1024)throw Error("OPFS bound");
 return {size:file.size,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))};})()`;

async function runHiddenPageProbe(owned, { documentURL, downloadURL, timeoutMs = 10000 } = {}, io = defaultIO) {
  let c, origin, directory, context, created, attached, frame, runtime, initialRuntime, failure, closing = false, stopped = false;
  let stage = "configuration", count = 0, dropped = 0, navigation = false, navigated = false, loaded = false, bound = false;
  let targetBlankObserved = false, initialBlankVerified = false, resolveBlank, rejectBlank;
  let downloadStarted, downloadDone = false, downloadIssued = false, saved, opfsMeasured = false, cleanupVerified = false, cleanupReason = null;
  const trace = [], note = value => { if (trace.length === 64) { trace.shift(); dropped++; } trace.push(Object.freeze({ sequence: ++count, stage, ...value })); };
  let resolveLoad, rejectLoad, resolveDownload, rejectDownload;
  const load = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; }); load.catch(() => {});
  const download = new Promise((resolve, reject) => { resolveDownload = resolve; rejectDownload = reject; }); download.catch(() => {});
  const blank = new Promise((resolve, reject) => { resolveBlank = resolve; rejectBlank = reject; }); blank.catch(() => {});
  const fail = code => { failure ||= bad(code); rejectLoad(failure); rejectDownload(failure); rejectBlank(failure); return failure; };
  const check = () => { if (failure) throw failure; if (stopped || c?.failure || c?.socket?.failure) throw fail("transport-failed"); };
  const send = async (method, params = {}, session) => {
    check(); stage = method; note({ kind: "command", outcome: "sent" });
    const value = await c.send(method, params, session); check(); note({ kind: "command", outcome: "acknowledged" }); return value;
  };
  const inspectTarget = info => {
    const pendingEmpty = info?.url === "" && !navigation && !initialBlankVerified && !targetBlankObserved;
    if (!id(info?.targetId) || info.type !== "other" || info.browserContextId !== context || info.parentId || info.openerId ||
        (!pendingEmpty && info.url !== "about:blank" && (!navigation || info.url !== documentURL))) throw bad("target-identity-mismatch");
    if (created && info.targetId !== created || attached && info.targetId !== attached.target) throw bad("extra-target");
    if (info.url === "about:blank") targetBlankObserved = true;
  };
  const maybeLoaded = () => { if (navigated && loaded && runtime) resolveLoad(); };
  const event = packet => {
    if (stopped) return;
    try {
      const { method, params: p, sessionId: session } = packet;
      if (!EVENTS.has(method)) return;
      note({ kind: "event", event: method, afterFailure: !!failure, ownedSession: !!attached && session === attached.session,
        targetMatches: !!created && p.targetInfo?.targetId === created, contextMatches: !!context && p.targetInfo?.browserContextId === context,
        targetType: p.targetInfo?.type === "other" ? "other" : p.targetInfo?.type === "page" ? "page" : "unavailable",
        targetURLKind: p.targetInfo?.url === "" ? "empty" : p.targetInfo?.url === "about:blank" ? "about-blank" : p.targetInfo ? "other" : "unavailable",
        waiting: typeof p.waitingForDebugger === "boolean" ? p.waitingForDebugger : null });
      if (failure) return;
      if (count > 512) throw bad("event-bound");
      if (method === "Target.targetCreated") { if (!context || created || bound) throw bad("extra-target"); inspectTarget(p.targetInfo); created = p.targetInfo.targetId; return; }
      if (method === "Target.targetInfoChanged") { if (!created) throw bad("target-order-invalid"); inspectTarget(p.targetInfo); return; }
      if (method === "Target.attachedToTarget") {
        if (session !== undefined || attached || !id(p.sessionId) || p.waitingForDebugger !== true) throw bad("attachment-invalid");
        inspectTarget(p.targetInfo); attached = { target: p.targetInfo.targetId, session: p.sessionId }; return;
      }
      if (["Target.targetDestroyed", "Target.targetCrashed", "Target.detachedFromTarget", "Inspector.detached"].includes(method)) {
        if (closing && (p.targetId === created || p.sessionId === attached?.session || session === attached?.session)) return;
        throw bad("target-lifecycle-lost");
      }
      if (method === "Browser.downloadWillBegin") {
        if (session !== undefined || !downloadIssued || downloadStarted || !guid(p.guid) || p.frameId !== frame || p.url !== downloadURL) throw bad("download-identity-mismatch");
        downloadStarted = p.guid; return;
      }
      if (method === "Browser.downloadProgress") {
        if (session !== undefined || !downloadStarted || p.guid !== downloadStarted || downloadDone ||
            !Number.isSafeInteger(p.receivedBytes) || p.receivedBytes < 0 || p.receivedBytes > DOWNLOAD.length ||
            !Number.isSafeInteger(p.totalBytes) || p.totalBytes < 0 || p.totalBytes > DOWNLOAD.length) throw bad("download-progress-invalid");
        if (p.state === "inProgress") return;
        if (p.state !== "completed" || p.receivedBytes !== DOWNLOAD.length || p.totalBytes !== DOWNLOAD.length) throw bad("download-incomplete");
        downloadDone = true; resolveDownload(); return;
      }
      if (!bound || session !== attached.session) throw bad("unowned-page-event");
      if (["Page.frameAttached", "Page.frameDetached", "Page.windowOpen"].includes(method)) throw bad("unexpected-page-lifecycle");
      if (method === "Page.frameNavigated") {
        if (!navigation && p.frame?.id === frame && p.frame.url === "about:blank" && !p.frame.parentId) { resolveBlank(); return; }
        if (!navigation || navigated || p.frame?.id !== frame || p.frame.parentId || p.frame.url !== documentURL || p.frame.unreachableUrl) throw bad("frame-mismatch");
        navigated = true; maybeLoaded(); return;
      }
      if (method === "Runtime.executionContextCreated") {
        const value = p.context;
        if (value?.auxData?.isDefault !== true || value.auxData.frameId !== frame || !Number.isSafeInteger(value.id) || value.id < 1) throw bad("runtime-context-invalid");
        if (!runtime && value.origin === origin && navigation) { runtime = value.id; maybeLoaded(); return; }
        if (!runtime && !initialRuntime && ["", "://"].includes(value.origin)) { initialRuntime = value.id; return; }
        throw bad("runtime-context-invalid");
      }
      if (method === "Runtime.executionContextDestroyed") { if (p.executionContextId === runtime) throw bad("runtime-context-lost"); if (p.executionContextId === initialRuntime) initialRuntime = null; return; }
      if (method === "Runtime.executionContextsCleared") { if (runtime) throw bad("runtime-context-lost"); initialRuntime = null; return; }
      if (method === "Page.loadEventFired") { if (!navigation) return; if (loaded) throw bad("duplicate-page-load"); loaded = true; maybeLoaded(); }
    } catch (error) { fail(codes.get(error) || "event-invalid"); }
  };
  const transportFailure = () => { if (!(closing && c.failure?.message === "owned-cdp:transport-disposed")) fail("transport-failed"); };
  const execute = async () => {
    stage = "verify-owned"; await owned.verify(); check();
    const initial = await send("Target.getTargets"); if (!Array.isArray(initial.targetInfos) || initial.targetInfos.length) throw bad("initial-targets-present");
    await send("Target.setDiscoverTargets", { discover: true });
    context = (await send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    if (!id(context)) throw bad("context-missing");
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "other", exclude: false }, { exclude: true }] });
    const target = await send("Target.createTarget", { url: "about:blank", browserContextId: context, hidden: true });
    if (!created || !attached || target.targetId !== created || attached.target !== created) throw bad("target-binding-missing");
    bound = true;
    const tree = (await send("Page.getFrameTree", {}, attached.session)).frameTree;
    if (!id(tree?.frame?.id) || !["", "about:blank"].includes(tree.frame.url) || tree.frame.parentId || tree.childFrames?.length) throw bad("initial-frame-invalid");
    frame = tree.frame.id;
    if (tree.frame.url === "about:blank") resolveBlank();
    for (const [method, params] of [["Page.enable", {}], ["Runtime.enable", {}], ["Network.enable", {}],
      ["Network.setCacheDisabled", { cacheDisabled: true }], ["Network.setBypassServiceWorker", { bypass: true }]]) await send(method, params, attached.session);
    await send("Browser.setDownloadBehavior", { behavior: "allowAndName", browserContextId: context, downloadPath: directory.name, eventsEnabled: true });
    await send("Runtime.runIfWaitingForDebugger", {}, attached.session);
    stage = "initial-blank-commit"; await blank; check();
    const initialFrame = (await send("Page.getFrameTree", {}, attached.session)).frameTree;
    if (initialFrame?.frame?.id !== frame || initialFrame.frame.url !== "about:blank" || initialFrame.frame.parentId || initialFrame.childFrames?.length) throw bad("initial-blank-missing");
    const initialTarget = (await send("Target.getTargetInfo", { targetId: created })).targetInfo;
    inspectTarget(initialTarget);
    if (initialTarget.url !== "about:blank") throw bad("initial-blank-missing");
    initialBlankVerified = true;
    navigation = true;
    const result = await send("Page.navigate", { url: documentURL }, attached.session);
    if (result.frameId !== frame || result.errorText || result.isDownload) throw bad("navigation-invalid");
    stage = "page-load"; await load; check();
    const opfs = await send("Runtime.evaluate", { expression: OPFS_EXPRESSION, contextId: runtime, awaitPromise: true, returnByValue: true }, attached.session);
    if (opfs.exceptionDetails || opfs.result?.type !== "object" || opfs.result.value?.size !== OPFS.length ||
        !Array.isArray(opfs.result.value.bytes) || opfs.result.value.bytes.length !== OPFS.length || opfs.result.value.bytes.some((value, index) => value !== OPFS[index])) throw bad("opfs-mismatch");
    opfsMeasured = true;
    downloadIssued = true;
    const trigger = await send("Runtime.evaluate", { expression: `(()=>{const a=document.createElement("a");a.href=${JSON.stringify(downloadURL)};a.download="tiny.bin";document.body.append(a);a.click();a.remove();return true;})()`,
      contextId: runtime, userGesture: true, returnByValue: true }, attached.session);
    if (trigger.exceptionDetails || trigger.result?.type !== "boolean" || trigger.result.value !== true) throw bad("download-trigger-failed");
    stage = "download-completion"; await download; check();
    const measured = await io.readDownload(directory, downloadStarted); check();
    if (measured?.sizeBytes !== DOWNLOAD.length || measured.sha256 !== sha(DOWNLOAD)) throw bad("saved-download-mismatch");
    saved = Object.freeze({ sizeBytes: measured.sizeBytes, sha256: measured.sha256 });
    const final = await send("Target.getTargets");
    if (!Array.isArray(final.targetInfos) || final.targetInfos.length !== 1 || final.targetInfos[0].targetId !== created ||
        final.targetInfos[0].url !== documentURL || final.targetInfos[0].attached !== true) throw bad("final-targets-mismatch");
    inspectTarget(final.targetInfos[0]);
    stage = "verify-final-owned"; await owned.verify(); check();
  };
  try {
    c = owned?.connection;
    const document = new URL(documentURL), url = new URL(downloadURL);
    if (!c || typeof owned.verify !== "function" || typeof owned.close !== "function" || document.protocol !== "http:" || document.hostname !== "127.0.0.1" ||
        document.origin !== url.origin || document.username || document.password || document.search || document.hash || url.username || url.password || url.search || url.hash ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw bad("configuration-invalid");
    origin = document.origin;
    stage = "create-download-directory"; directory = await io.createDirectory();
    c.on("event", event); c.on("failure", transportFailure);
    await deadline(execute(), timeoutMs, "hidden-probe-timeout");
  } catch (error) { fail(codes.get(error) || (error?.message === "owned-cdp:hidden-probe-timeout" ? "probe-timeout" : "stage-failed")); }
  finally {
    closing = true;
    try { await owned?.close(); if (!c?.closed || (c.failure && c.failure.message !== "owned-cdp:transport-disposed") || c.socket?.failure) throw bad("cleanup-failed"); cleanupVerified = true; }
    catch (error) { cleanupReason ||= codes.get(error) || diagnosticCode(error); fail("cleanup-failed"); }
    stopped = true; c?.off("event", event); c?.off("failure", transportFailure);
    if (directory) try { await io.removeDirectory(directory); } catch { cleanupReason ||= "download-cleanup-failed"; cleanupVerified = false; fail("download-cleanup-failed"); }
  }
  const report = Object.freeze({ profile: "owned-hidden-page-capability-v1", success: !failure, stage, reason: codes.get(failure) || null,
    transport: c?.diagnostics?.() || null, lifecycle: owned?.lifecycle?.() || null, firstCleanupFailure: cleanupReason,
    targetBound: bound, pausedAttachmentObserved: !!attached, initialBlankVerified, freshContextCreated: !!context, mainFrameObserved: !!frame,
    opfsMeasured, opfsSizeBytes: opfsMeasured ? OPFS.length : null, downloadStarted: !!downloadStarted, downloadCompleted: downloadDone,
    savedDownload: saved || null, terminalCleanupVerified: cleanupVerified, cacheState: "unmeasured", serviceWorkerState: "unmeasured",
    completeCoverage: false, collectorProofEstablished: false, dropped, trace: Object.freeze([...trace]) });
  if (failure) { reports.set(failure, report); throw failure; } return report;
}
module.exports = { runHiddenPageProbe, diagnosticsFor, createDirectory, removeDirectory, readDownload, OPFS_EXPRESSION,
  DOWNLOAD: Buffer.from(DOWNLOAD), OPFS: Buffer.from(OPFS) };
