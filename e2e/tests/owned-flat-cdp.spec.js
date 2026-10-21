// Test-only protocol capability probe, never a qualification collector.
// Falsification: foreign PID/inode/session, unsafe port files, missing bootstrap,
// import/WASM bytes, wrong pause, early execution, detach and incomplete cleanup
// must fail, as must missing/mismatched/replayed provisional bootstrap ownership.
// Unknown cache/SW flags stay unknown; mocks do not prove Chromium.
const { test, expect } = require("@playwright/test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { FlatConnection, launchOwnedChromium, parseActivePort, processIdentity, inspectEndpointRecords,
  launchArguments, cleanupOwnedProcess, readSmall, deadline, problem, LIMITS, stderrCategory, numericObservation, helperObservation,
  collectLaunchPrerequisites, prerequisiteDiagnosticsFor, attachPrerequisites, executableObservation, freshProfileObservation,
  launchPolicyObservation, launchProvenance, launchProvenanceFor, attachLaunchProvenance, PROVENANCE_LIMITS, diagnosticCode, commandRejectionObservation, launchLifecycleObservation } = require("./owned-flat-cdp");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const PORT = "42123\n/devtools/browser/12345678-abcd-abcd-abcd-123456789abc";
const stat = (pid, start = "800") => `${pid} (chrome test) S 1 ${pid} ${pid} ${Array(15).fill("0").join(" ")} ${start}`;
const row = (address = "0100007F", inode = "876", port = 42123) =>
  `0: ${address}:${port.toString(16).toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`;
const records = (rows, sockets = ["876"], tcp6 = "header\n") => ({ port: 42123, tcp: `header\n${rows}\n`, tcp6, sockets });
class MockSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  addEventListener(name, callback) { this.on(name, callback); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
  reply(value) { this.emit("message", { data: JSON.stringify(value) }); }
}

test.describe("owned flattened CDP mocks", () => {
  test("port file permits Chromium's absent final newline", () => {
    expect(parseActivePort(PORT)).toEqual({ port: 42123, url: `ws://127.0.0.1:42123${PORT.split("\n")[1]}` });
    expect(parseActivePort(`${PORT}\n`)).toEqual(parseActivePort(PORT));
  });
  for (const value of ["0", "65536", "042123", "42123\nws://user:token@127.0.0.1/a", `${PORT}\n\n`, `${PORT}?token=x`, `${PORT}\0`]) {
    test(`rejects malformed endpoint ${JSON.stringify(value)}`, () => expect(() => parseActivePort(value)).toThrow("endpoint-file-invalid"));
  }
  test("joins namespace listener to exact process FD inode", () => {
    expect(inspectEndpointRecords(records(row()))).toBe("876");
    expect(() => inspectEndpointRecords(records(row(), ["999"]))).toThrow("not-owned-by-process");
  });
  for (const address of ["00000000", "0100000A", "0200007F"]) {
    test(`rejects non-authorized listener ${address}`, () => expect(() => inspectEndpointRecords(records(row(address)))).toThrow("unique-ipv4-loopback"));
  }
  test("rejects ambiguous and IPv6 same-port listeners", () => {
    expect(() => inspectEndpointRecords(records(`${row()}\n${row()}`))).toThrow("listener-ambiguous");
    expect(() => inspectEndpointRecords(records(row(), ["876"], `header\n${row("00000000000000000000000001000000")}\n`))).toThrow("unique-ipv4-loopback");
  });
  test("requires owned process group and starttime", () => {
    expect(processIdentity(stat(123), 123)).toEqual({ pid: 123, start: "800", group: 123 });
    expect(() => processIdentity(stat(124), 123)).toThrow("process-stat-invalid");
    expect(() => processIdentity(stat(123).replace("S 1 123", "S 1 456"), 123)).toThrow("process-group-invalid");
  });
  test("metadata read rejects symlink, directory and oversize", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-cdp-mock-"));
    try {
      await fs.writeFile(path.join(root, "file"), "tiny");
      await fs.symlink(path.join(root, "file"), path.join(root, "link"));
      await expect(readSmall(path.join(root, "link"), 8, true)).rejects.toThrow();
      await expect(readSmall(root, 8, true)).rejects.toThrow("metadata-file-invalid");
      await expect(readSmall(path.join(root, "file"), 3, true)).rejects.toThrow("metadata-file-invalid");
      expect((await readSmall(path.join(root, "file"), 4, true)).text).toBe("tiny");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  test("launch arguments never relax the sandbox or allow remote origins", () => {
    const args = launchArguments("/owned/fresh");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args.some(arg => /no-sandbox|disable-setuid-sandbox|remote-allow-origins|disable-web-security/.test(arg))).toBe(false);
  });
  test("routes public flattened command reply by exact session", async () => {
    const socket = new MockSocket(); const connection = new FlatConnection(socket);
    const task = connection.send("Network.enable", {}, "worker-1");
    expect(socket.sent[0]).toEqual({ id: 1, method: "Network.enable", params: {}, sessionId: "worker-1" });
    socket.reply({ id: 1, sessionId: "worker-1", result: {} }); await task; connection.close();
  });
  for (const reply of [{ id: 1, sessionId: "foreign", result: {} }, { id: 1, result: {} }, { id: 99, result: {} }]) {
    test(`rejects wrong reply ownership ${JSON.stringify(reply)}`, async () => {
      const socket = new MockSocket(); const connection = new FlatConnection(socket);
      const task = connection.send("Network.enable", {}, "worker-1");
      socket.reply(reply); await expect(task).rejects.toThrow("reply-ownership-mismatch"); connection.close();
    });
  }
  test("protocol error text cannot escape and timeout fails all pending commands", async () => {
    const socket = new MockSocket(); const connection = new FlatConnection(socket, { commandMs: 10 });
    const task = connection.send("Network.enable");
    socket.reply({ id: 1, error: { message: "https://secret.test/?token=private", data: "body" } });
    await expect(task).rejects.toThrow(/^owned-cdp:command-rejected$/); connection.close();
    const second = new FlatConnection(new MockSocket(), { commandMs: 5 });
    await expect(second.send("Network.enable")).rejects.toThrow(/^owned-cdp:command-timeout$/); second.close();
  });
  for (const commandMs of [0, -1, Infinity, NaN, 3001]) {
    test(`rejects unbounded command timeout ${commandMs}`, () => expect(() => new FlatConnection(new MockSocket(), { commandMs })).toThrow("deadline-invalid"));
  }
  test("rejects oversized accepted frame before parsing", () => {
    const connection = new FlatConnection(new MockSocket()); connection.receive(" ".repeat(LIMITS.frameBytes + 1));
    expect(connection.failure.message).toBe("owned-cdp:frame-bound"); connection.close();
  });
  test("cleanup observes actual exit rather than killed flag", async () => {
    const child = { pid: 123, exitCode: null, signalCode: null, killed: true };
    const signals = []; let waits = 0;
    await cleanupOwnedProcess({ child, identity: { start: "800" }, exited: Promise.resolve(), endpoint: { inode: "876" } }, {
      snapshot: async () => ({ start: "800" }), groupSignal: (pid, name) => signals.push([pid, name]),
      wait: async () => { waits++; child.signalCode = "SIGTERM"; }, listenerPresent: async () => false, groupPresent: () => false,
    });
    expect(signals).toEqual([[-123, "SIGTERM"]]); expect(waits).toBe(1);
  });
  test("cleanup never signals a replaced process or stale exited group", async () => {
    const child = { pid: 123, exitCode: null, signalCode: null }; let signals = 0;
    const io = { snapshot: async () => ({ start: "900" }), groupSignal: () => signals++, wait: async () => {}, listenerPresent: async () => false, groupPresent: () => false };
    await expect(cleanupOwnedProcess({ child, identity: { start: "800" } }, io)).rejects.toThrow("ownership-lost");
    child.exitCode = 0; await cleanupOwnedProcess({ child, identity: { start: "800" } }, io); expect(signals).toBe(0);
  });
  test("partial startup still terminates direct child and reports unverified cleanup", async () => {
    const names = []; const child = { pid: 123, exitCode: null, signalCode: null, kill: name => names.push(name) };
    await expect(cleanupOwnedProcess({ child, exited: Promise.resolve() }, {
      groupSignal: () => { throw new Error("must not signal group"); },
      wait: async () => { child.signalCode = "SIGTERM"; },
    })).rejects.toThrow("cleanup-preidentity-unverified");
    expect(names).toEqual(["SIGTERM"]);
  });
  test("surviving listener and unobserved exit fail cleanup", async () => {
    const child = { pid: 123, exitCode: 0, signalCode: null };
    await expect(cleanupOwnedProcess({ child, identity: { start: "800" }, endpoint: { inode: "876" } }, {
      listenerPresent: async () => true,
    })).rejects.toThrow("listener-survived");
    child.exitCode = null;
    await expect(cleanupOwnedProcess({ child, identity: { start: "800" } }, {
      snapshot: async () => ({ start: "800" }), groupSignal: () => {}, wait: async () => {},
    })).rejects.toThrow("exit-unobserved");
  });
});

const BOOTSTRAP = Buffer.from('importScripts("/worker-import.js");\nWebAssembly.instantiateStreaming(fetch("/worker.wasm")).then(() => postMessage("owned-worker-done"));\n');
const IMPORT = Buffer.from('self.importWasExecuted = true;\n');
const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const BODIES = { "/bootstrap.js": BOOTSTRAP, "/worker-import.js": IMPORT, "/worker.wasm": WASM };
const CONTROL_NAMES = ["Network.enable", "Network.setCacheDisabled", "Network.setBypassServiceWorker"];
function newFacts() {
  return { profile: "owned-flat-cdp-startup-probe/1", completeCoverage: false, collectorProofEstablished: false,
    stage: "launch", childSetupAcksBeforeFirstResume: 0, setupAcksBeforeFinalResume: false, instrumentationPauseObserved: false,
    pauseSourceMatchesBootstrap: false, creatorFetchBodyMatches: false, continuedWithoutOverrides: false,
    bootstrapTargetBound: false, creatorFetchBeforeWorkerAttach: null, bootstrapWorkerBodyMatches: false,
    importBodyMatches: false, wasmBodyMatches: false, workerMessageObserved: false,
    earlyImportOrWasm: false, networkResponseSeen: false, fromDiskCache: null, fromPrefetchCache: null,
    fromServiceWorker: null, freshContextCreated: false, cacheDisabledAcknowledged: false,
    bypassServiceWorkerAcknowledged: false, cacheFactsScope: "bootstrap-only", bootstrapServedFromCacheEvent: false,
    endpointReverified: false, cleanupVerified: false, probeSucceeded: false, errorCode: null, capability: "unestablished", startupTrace: null };
}
function recordBootstrapFlags(facts, response) {
  // Reject a second response rather than allowing migration/repetition to erase
  // true or unknown evidence. These fields describe only the bootstrap.
  if (facts.networkResponseSeen) throw problem("probe-duplicate-bootstrap-response");
  facts.networkResponseSeen = true;
  for (const name of ["fromDiskCache", "fromPrefetchCache", "fromServiceWorker"]) {
    facts[name] = typeof response?.[name] === "boolean" ? response[name] : null;
  }
}
function assertProbeEvidence(facts) {
  for (const name of ["setupAcksBeforeFinalResume", "instrumentationPauseObserved", "pauseSourceMatchesBootstrap",
    "creatorFetchBodyMatches", "continuedWithoutOverrides", "bootstrapTargetBound", "bootstrapWorkerBodyMatches", "importBodyMatches", "wasmBodyMatches", "workerMessageObserved",
    "freshContextCreated", "cacheDisabledAcknowledged", "bypassServiceWorkerAcknowledged"]) {
    if (facts[name] !== true) throw problem("probe-evidence-incomplete");
  }
  if (facts.earlyImportOrWasm) throw problem("execution-before-owned-release");
  return facts;
}
for (const missing of ["bootstrapWorkerBodyMatches", "bootstrapTargetBound", "creatorFetchBodyMatches", "importBodyMatches", "wasmBodyMatches", "instrumentationPauseObserved", "workerMessageObserved"]) {
  test(`owned probe rejects missing ${missing}`, () => {
    const facts = newFacts(); for (const key of Object.keys(facts)) if (typeof facts[key] === "boolean") facts[key] = true;
    facts.earlyImportOrWasm = false; facts[missing] = false;
    expect(() => assertProbeEvidence(facts)).toThrow("probe-evidence-incomplete");
  });
}
test("owned probe preserves unknown provenance separately from acknowledged controls", () => {
  const facts = newFacts(); facts.cacheDisabledAcknowledged = true; facts.bypassServiceWorkerAcknowledged = true;
  expect([facts.fromDiskCache, facts.fromPrefetchCache, facts.fromServiceWorker]).toEqual([null, null, null]);
  expect(facts.completeCoverage).toBe(false); expect(facts.collectorProofEstablished).toBe(false);
});

// Diagnostic-only aliases never expose raw IDs. The map and ring are bounded;
// no URL, header, response body, arbitrary method, or exception is retained.
function startupTrace() {
  const methods = new Set(["Target.createBrowserContext", "Target.setAutoAttach", "Target.createTarget", "Target.attachedToTarget",
    "Target.detachedFromTarget", "Target.targetCrashed", "Inspector.detached", "Network.enable", "Network.setCacheDisabled",
    "Network.setBypassServiceWorker", "Network.requestWillBeSent", "Network.responseReceived", "Network.requestServedFromCache",
    "Network.loadingFinished", "Network.loadingFailed", "Network.getResponseBody", "Fetch.enable", "Fetch.requestPaused",
    "Fetch.getResponseBody", "Fetch.continueRequest", "Runtime.enable", "Runtime.runIfWaitingForDebugger", "Runtime.consoleAPICalled",
    "Page.enable", "Page.navigate", "Debugger.enable", "Debugger.setInstrumentationBreakpoint", "Debugger.scriptParsed",
    "Debugger.paused", "Debugger.resumed", "Debugger.getScriptSource", "Debugger.removeBreakpoint", "Debugger.resume",
    "probe.worker-setup", "probe.bootstrap-fetch", "probe.bootstrap-instrumentation", "probe.bootstrap-body", "probe.import-body"]);
  const ids = new Map(), events = []; let sequence = 0, dropped = 0, identityLimitReached = false;
  const alias = value => {
    if (typeof value !== "string" || !value || value.length > 128) return null;
    if (!ids.has(value)) {
      if (ids.size === 32) { identityLimitReached = true; return null; }
      ids.set(value, `i${ids.size + 1}`);
    }
    return ids.get(value);
  };
  return {
    record(method, phase, session, p = {}, state = {}) {
      const checks = { pagePresent: typeof state.page === "string", workerPresent: typeof state.worker === "string",
        originalPresent: typeof state.original === "string", workerTargetPresent: typeof state.workerTarget === "string",
        sessionIsPage: session === state.page, sessionIsWorker: session === state.worker };
      if (phase === "event") {
        const bootstrapUrlMatches = p.request?.url === `${state.origin}/bootstrap.js`;
        if (method === "Target.attachedToTarget") Object.assign(checks, {
          rootSession: !session, targetIsPage: p.targetInfo?.type === "page", targetIsWorker: p.targetInfo?.type === "worker",
          pageAbsent: !state.page, workerAbsent: !state.worker, childSessionIsString: typeof p.sessionId === "string",
          contextMatches: p.targetInfo?.browserContextId === state.context, parentMatchesPage: p.targetInfo?.parentId === state.pageTarget,
          targetEqualsOriginal: p.targetInfo?.targetId === state.original, waitingForDebugger: p.waitingForDebugger === true });
        if (method === "Network.requestWillBeSent") Object.assign(checks, {
          bootstrapUrlMatches, getMethod: p.request?.method === "GET", redirectAbsent: !p.redirectResponse, originalAbsent: !state.original });
        if (method === "Fetch.requestPaused") Object.assign(checks, {
          firstPauseCandidate: state.pauseCount + 1 === 1, networkIdEqualsOriginal: p.networkId === state.original,
          originalEqualsWorkerTarget: state.original === state.workerTarget, bootstrapUrlMatches, getMethod: p.request?.method === "GET",
          status200: p.responseStatusCode === 200, responseErrorAbsent: !p.responseErrorReason, redirectedRequestAbsent: !p.redirectedRequestId,
          responseHeadersArray: Array.isArray(p.responseHeaders), responseHeadersWithinBound: Array.isArray(p.responseHeaders) && p.responseHeaders.length <= 32 });
        if (method === "Debugger.paused") Object.assign(checks, {
          firstInstrumentationPause: !state.facts?.instrumentationPauseObserved, instrumentationReason: p.reason === "instrumentation",
          scriptIdIsString: typeof p.data?.scriptId === "string", callFrameScriptMatches: p.callFrames?.[0]?.location?.scriptId === p.data?.scriptId,
          hitBreakpointsEmpty: Array.isArray(p.hitBreakpoints) && p.hitBreakpoints.length === 0, oneParsedScript: state.scripts?.length === 1,
          initialScriptMatches: state.scripts?.[0]?.id === p.data?.scriptId, initialScriptUrlMatches: state.scripts?.[0]?.url === `${state.origin}/bootstrap.js` });
        if (method === "Debugger.scriptParsed") checks.scriptWithinBound = state.scripts?.length < 8;
        if (method === "Debugger.resumed") checks.finalReleaseSent = state.facts?.setupAcksBeforeFinalResume === true;
        if (["Network.responseReceived", "Network.loadingFinished"].includes(method)) {
          const entry = state.requests?.get(p.requestId);
          Object.assign(checks, { requestEqualsOriginal: p.requestId === state.original, requestTracked: Boolean(entry),
            responseAlreadySeen: entry?.response === true, completionAlreadySeen: entry?.completed === true,
            status200: p.response?.status === 200, responseUrlMatches: Boolean(entry) && p.response?.url === state.origin + entry.key,
            bootstrapResponseUrlMatches: p.response?.url === `${state.origin}/bootstrap.js`,
            bootstrapResponseAlreadySeen: state.facts?.networkResponseSeen === true, bootstrapCompletionAlreadySeen: state.bootstrapCompleted === true });
        }
      }
      const event = Object.freeze({ sequence: sequence = Math.min(sequence + 1, 1024), method: methods.has(method) ? method : "other",
        phase: ["event", "send", "ack", "reject"].includes(phase) ? phase : "other", session: alias(session),
        childSession: alias(p.sessionId), request: alias(p.requestId), network: alias(p.networkId),
        target: alias(p.targetInfo?.targetId), parent: alias(p.targetInfo?.parentId),
        expectedOriginal: alias(state.original), expectedWorkerTarget: alias(state.workerTarget), checks: Object.freeze(checks) });
      events.push(event); if (events.length > 32) { events.shift(); dropped = Math.min(dropped + 1, 1024); }
    },
    snapshot() { return Object.freeze({ events: Object.freeze([...events]), droppedEvents: dropped, identityLimitReached }); },
  };
}

async function startupProbe(connection, origin, serverCounts, { firstDelayMs = 150, holdDelayMs = 100, completionMs = 10000, facts = newFacts() } = {}) { let context, page, pageTarget, worker, workerTarget, original, pauseCount = 0;
  let released = false, setup = [], breakpoint, failure, eventCount = 0, finished = false, bootstrap, creatorBootstrapBytes, bootstrapCompleted = false, bootstrapWorkerRequestSeen = false;
  const requests = new Map(), scripts = []; const tasks = new Set();
  const trace = startupTrace();
  const traceState = () => ({ context, page, pageTarget, worker, workerTarget, original, pauseCount, origin, requests, scripts, facts, bootstrapCompleted });
  let resolveDone, rejectDone; const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Prevent a rejection before the finish waiter is installed becoming unhandled.
  done.catch(() => {});
  const fail = code => { if (!failure) { failure = problem(code); rejectDone(failure); } };
  const maybeDone = () => {
    if (facts.bootstrapWorkerBodyMatches && facts.bootstrapTargetBound && facts.workerMessageObserved && facts.creatorFetchBodyMatches && facts.continuedWithoutOverrides && facts.importBodyMatches && facts.wasmBodyMatches) resolveDone();
  };
  const task = (promise, label, session) => { tasks.add(promise); promise.catch(() => {
    trace.record(label, "reject", session, {}, traceState()); fail("probe-protocol-operation-failed");
  }).finally(() => tasks.delete(promise)); };
  const dispatch = (method, params = {}, session) => {
    trace.record(method, "send", session, {}, traceState());
    return connection.send(method, params, session).then(result => {
      trace.record(method, "ack", session, {}, traceState()); return result;
    }, error => { trace.record(method, "reject", session, {}, traceState()); throw error; });
  };
  const send = (method, params = {}, session = page) => dispatch(method, params, session);
  const controls = session => CONTROL_NAMES.map((name, index) => send(name, index === 1 ? { cacheDisabled: true } : index === 2 ? { bypass: true } : {}, session));
  const decode = (response, expected) => {
    if (typeof response.body !== "string" || response.body.length > 8192 || typeof response.base64Encoded !== "boolean") throw problem("body-shape-invalid");
    const bytes = Buffer.from(response.body, response.base64Encoded ? "base64" : "utf8");
    if (response.base64Encoded && bytes.toString("base64") !== response.body) throw problem("body-base64-invalid");
    if (bytes.length > 4096 || !bytes.equals(expected)) throw problem("body-mismatch");
    return bytes;
  };
  const onEvent = event => {
    if (failure || finished) return;
    if (++eventCount > 256) { fail("probe-event-bound"); return; }
    const { method, params: p, sessionId: session } = event;
    trace.record(method, "event", session, p, traceState());
    if (["Target.detachedFromTarget", "Target.targetCrashed", "Inspector.detached"].includes(method)) { fail("probe-target-lifecycle-lost"); return; }
    if (method === "Target.attachedToTarget") {
      if (!session && p.targetInfo?.type === "page" && !page && p.targetInfo.browserContextId === context && p.waitingForDebugger === true) {
        page = p.sessionId; pageTarget = p.targetInfo.targetId; return;
      }
      if (session !== page || worker || !original || typeof pageTarget !== "string" || !pageTarget ||
          p.targetInfo?.type !== "worker" || p.targetInfo.parentId !== pageTarget ||
          p.targetInfo.targetId !== original || p.waitingForDebugger !== true || typeof p.sessionId !== "string" || !p.sessionId) { fail("probe-worker-owner-mismatch"); return; }
      if (bootstrap && (bootstrap.page !== page || bootstrap.original !== p.targetInfo.targetId)) { fail("probe-worker-owner-mismatch"); return; }
      worker = p.sessionId; workerTarget = p.targetInfo.targetId; facts.stage = "worker-attached";
      if (bootstrap) facts.bootstrapTargetBound = true;
      task((async () => {
        setup = controls(worker).map(promise => promise.then(value => { if (!released) facts.childSetupAcksBeforeFirstResume++; return value; }));
        // Register the second execution gate before queuing the first resume.
        setup.push(send("Debugger.enable", {}, worker));
        const install = send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, worker);
        setup.push(install); setup.forEach(promise => promise.catch(() => fail("probe-child-setup-failed"))); install.then(value => { breakpoint = value.breakpointId; }, () => {});
        // This interval measures the actual fetch-throttle/renderer dependency.
        await wait(firstDelayMs);
        if (failure || finished) return;
        facts.childSetupAcksBeforeFirstResume = Math.min(facts.childSetupAcksBeforeFirstResume, 3);
        released = true; facts.stage = "first-resume-sent";
        await send("Runtime.runIfWaitingForDebugger", {}, worker);
      })(), "probe.worker-setup", worker); return;
    }
    if (method === "Fetch.requestPaused" && session !== page) { fail("probe-fetch-owner-mismatch"); return; }
    if (original && p.requestId === original && ["Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(method) && session !== worker) {
      fail("probe-bootstrap-source-invalid"); return;
    }
    if (session !== page && session !== worker) return;
    if (method === "Network.requestWillBeSent") {
      if (session === page && p.request?.url === `${origin}/bootstrap.js`) {
        if (original || typeof p.requestId !== "string" || !p.requestId || p.redirectResponse || p.request.method !== "GET") { fail("probe-bootstrap-request-invalid"); return; }
        original = p.requestId; return;
      }
      if (session === worker && p.request?.url === `${origin}/bootstrap.js`) {
        if (!facts.bootstrapTargetBound || bootstrapWorkerRequestSeen || p.requestId !== original || p.request.method !== "GET" || p.redirectResponse) {
          fail("probe-bootstrap-request-invalid"); return;
        }
        bootstrapWorkerRequestSeen = true; return;
      }
      if (session === worker && p.request?.url !== `${origin}/bootstrap.js`) {
        const key = Object.keys(BODIES).find(name => name !== "/bootstrap.js" && p.request?.url === origin + name);
        if (!key || requests.size >= 2 || requests.has(p.requestId) || [...requests.values()].some(value => value.key === key) || p.redirectResponse || p.request.method !== "GET") { fail("probe-import-request-invalid"); return; }
        if (!facts.setupAcksBeforeFinalResume) { facts.earlyImportOrWasm = true; fail("execution-before-owned-release"); return; }
        requests.set(p.requestId, { key, response: false, completed: false }); return;
      }
    }
    if (method === "Network.responseReceived") {
      if (p.requestId === original) {
        if (!facts.bootstrapTargetBound || p.response?.url !== `${origin}/bootstrap.js` || p.response.status !== 200) {
          fail("probe-bootstrap-response-invalid"); return;
        }
        recordBootstrapFlags(facts, p.response);
      }
      const entry = requests.get(p.requestId);
      if (entry && session === worker) {
        if (entry.response || p.response?.status !== 200 || p.response.url !== origin + entry.key) { fail("probe-import-response-invalid"); return; }
        entry.response = true;
      }
    }
    if (method === "Network.requestServedFromCache" && p.requestId === original) facts.bootstrapServedFromCacheEvent = true;
    if (method === "Fetch.requestPaused") {
      // Chromium can pause the creator response before constructing the worker
      // target. Keep one provisional identity; continuing these exact bytes may
      // be necessary for attachment. Only the later owned attachment binds it.
      if (session !== page || ++pauseCount !== 1 || !original || bootstrap || typeof p.requestId !== "string" || !p.requestId ||
          p.networkId !== original || (workerTarget !== undefined && original !== workerTarget) ||
          p.request?.url !== `${origin}/bootstrap.js` || p.request.method !== "GET" || p.responseStatusCode !== 200 || p.responseErrorReason ||
          p.redirectedRequestId || !Array.isArray(p.responseHeaders) || p.responseHeaders.length > 32) { fail("probe-fetch-owner-mismatch"); return; }
      bootstrap = Object.freeze({ page, original, fetch: p.requestId });
      facts.creatorFetchBeforeWorkerAttach = !worker;
      if (worker) facts.bootstrapTargetBound = true;
      facts.stage = "bootstrap-fetch-paused";
      task((async () => {
        creatorBootstrapBytes = decode(await send("Fetch.getResponseBody", { requestId: bootstrap.fetch }, bootstrap.page), BOOTSTRAP);
        if (failure || finished) return;
        facts.creatorFetchBodyMatches = true; facts.stage = "bootstrap-body-captured";
        await send("Fetch.continueRequest", { requestId: bootstrap.fetch }, bootstrap.page); facts.continuedWithoutOverrides = true; maybeDone();
      })(), "probe.bootstrap-fetch", page); return;
    }
    if (session === worker && method === "Debugger.scriptParsed") {
      if (scripts.length >= 8) { fail("probe-script-bound"); return; }
      scripts.push({ id: p.scriptId, url: p.url });
    }
    if (session === worker && method === "Debugger.paused") {
      if (facts.instrumentationPauseObserved || p.reason !== "instrumentation" || typeof p.data?.scriptId !== "string" ||
          p.callFrames?.[0]?.location?.scriptId !== p.data.scriptId || !Array.isArray(p.hitBreakpoints) || p.hitBreakpoints.length ||
          scripts.length !== 1 || scripts[0].id !== p.data.scriptId || scripts[0].url !== `${origin}/bootstrap.js`) { fail("probe-bootstrap-pause-invalid"); return; }
      facts.instrumentationPauseObserved = true; facts.stage = "instrumentation-paused";
      task((async () => {
        await Promise.all(setup); facts.stage = "child-setup-acknowledged";
        const source = await send("Debugger.getScriptSource", { scriptId: p.data.scriptId }, worker);
        if (source.scriptSource !== BOOTSTRAP.toString("ascii")) throw problem("probe-bootstrap-source-mismatch");
        facts.pauseSourceMatchesBootstrap = true;
        if (typeof breakpoint !== "string") throw problem("probe-breakpoint-missing");
        await send("Debugger.removeBreakpoint", { breakpointId: breakpoint }, worker);
        // Deliberate second delay: no immediate imports/WASM may run while held.
        await wait(holdDelayMs);
        if (failure || finished) return;
        if (requests.size || serverCounts["/worker-import.js"] || serverCounts["/worker.wasm"] || facts.workerMessageObserved) throw problem("execution-before-owned-release");
        facts.cacheDisabledAcknowledged = true; facts.bypassServiceWorkerAcknowledged = true;
        facts.setupAcksBeforeFinalResume = true; facts.stage = "final-resume-sent";
        await send("Debugger.resume", {}, worker);
      })(), "probe.bootstrap-instrumentation", worker); return;
    }
    if (session === worker && method === "Debugger.resumed" && !facts.setupAcksBeforeFinalResume) { fail("probe-unsolicited-resume"); return; }
    if (method === "Network.loadingFailed") { fail("probe-network-failed"); return; }
    if (session === worker && method === "Network.loadingFinished" && p.requestId === original) {
      if (!facts.bootstrapTargetBound || !facts.networkResponseSeen || bootstrapCompleted) { fail("probe-bootstrap-completion-invalid"); return; }
      bootstrapCompleted = true;
      task((async () => {
        // Read from the actual completing worker, never substitute the creator
        // capture for an unavailable Network body or fetch the URL a second time.
        const bytes = decode(await send("Network.getResponseBody", { requestId: original }, worker), BOOTSTRAP);
        if (failure || finished) return;
        if (!creatorBootstrapBytes || !bytes.equals(creatorBootstrapBytes)) throw problem("probe-bootstrap-body-mismatch");
        facts.bootstrapWorkerBodyMatches = true; maybeDone();
      })(), "probe.bootstrap-body", worker); return;
    }
    if (session === worker && method === "Network.loadingFinished" && requests.has(p.requestId)) {
      const entry = requests.get(p.requestId);
      if (!entry.response || entry.completed) { fail("probe-import-completion-invalid"); return; }
      entry.completed = true;
      task((async () => {
        decode(await send("Network.getResponseBody", { requestId: p.requestId }, worker), BODIES[entry.key]);
        facts[entry.key === "/worker.wasm" ? "wasmBodyMatches" : "importBodyMatches"] = true; maybeDone();
      })(), "probe.import-body", worker);
    }
    if (session === page && method === "Runtime.consoleAPICalled" && p.type === "log" && p.args?.length === 1 && p.args[0].value === "owned-worker-done") {
      if (facts.workerMessageObserved || !facts.setupAcksBeforeFinalResume) { fail("probe-worker-message-invalid"); return; }
      facts.workerMessageObserved = true; maybeDone();
    }
  };
  const listener = event => { try { onEvent(event); } catch { fail("probe-event-invalid"); } };
  const transportFailed = () => fail("probe-transport-failed");
  connection.on("event", listener); connection.on("failure", transportFailed);
  try {
    context = (await dispatch("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    if (typeof context !== "string") throw problem("probe-context-missing"); facts.freshContextCreated = true;
    await dispatch("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "page", exclude: false }, { exclude: true }] });
    facts.stage = "page-setup";
    const target = await dispatch("Target.createTarget", { url: "about:blank", browserContextId: context });
    if (!page || target.targetId !== pageTarget) throw problem("probe-page-attachment-missing");
    await Promise.all([...controls(page), send("Runtime.enable"), send("Page.enable"),
      send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/bootstrap.js`, requestStage: "Response" }] }),
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: "worker", exclude: false }, { exclude: true }] })]);
    await send("Runtime.runIfWaitingForDebugger");
    await send("Page.navigate", { url: `${origin}/` });
    await deadline(done, completionMs, "probe-capability-timeout");
    await deadline(Promise.all([...tasks]), 3000, "probe-drain-timeout");
    if (failure) throw failure;
    assertProbeEvidence(facts);
    for (const key of Object.keys(BODIES)) if (serverCounts[key] !== 1) throw problem("probe-server-count-mismatch");
    facts.capability = "classic-bootstrap-second-gate-observed"; facts.stage = "protocol-evidence-complete";
    return facts;
  } finally {
    facts.startupTrace = trace.snapshot();
    finished = true; connection.off("event", listener); connection.off("failure", transportFailed);
    // Owned browser teardown removes the fresh context even if a session failed.

  }
}

// Executes the actual probe event handlers, without a browser or a socket.
class ProbeProtocolMock extends EventEmitter {
  constructor(mode = "valid", { fetchFirst = false } = {}) { super(); this.mode = mode; this.fetchFirst = fetchFirst; this.commands = []; this.queued = []; this.counts = {}; }
  event(method, params, sessionId = "page") { this.emit("event", { method, params, sessionId: sessionId === null ? undefined : sessionId }); }
  async send(method, params = {}, session) {
    this.commands.push({ method, params, session });
    if (method === "Target.createBrowserContext") return { browserContextId: "context" };
    if (method === "Target.createTarget") {
      this.event("Target.attachedToTarget", { sessionId: "page", waitingForDebugger: true,
        targetInfo: { targetId: "page-target", type: "page", browserContextId: "context" } }, null);
      return { targetId: "page-target" };
    }
    if (method === "Page.navigate") {
      if (this.mode === "attachment-before-original") this.event("Target.attachedToTarget", { sessionId: "worker", waitingForDebugger: true,
        targetInfo: { type: "worker", parentId: "page-target" } });
      if (this.mode !== "missing-original") this.event("Network.requestWillBeSent", { requestId: "bootstrap-id", request: { url: "http://fixture/bootstrap.js", method: "GET" } });
      if (this.fetchFirst) this.pauseBootstrap(); else this.attachWorker();
      return {};
    }
    if (session === "worker" && [...CONTROL_NAMES, "Debugger.enable", "Debugger.setInstrumentationBreakpoint"].includes(method)) {
      return new Promise(resolve => this.queued.push(() => resolve(method === "Debugger.setInstrumentationBreakpoint" ? { breakpointId: "breakpoint" } : {})));
    }
    if (session === "worker" && method === "Runtime.runIfWaitingForDebugger") {
      if (this.fetchFirst) this.startRenderer(); else if (this.mode !== "missing-bootstrap") this.pauseBootstrap();
      return {};
    }
    if (method === "Fetch.getResponseBody") {
      if (this.mode === "duplicate-fetch") this.pauseBootstrap();
      return { base64Encoded: true, body: (this.mode === "wrong-bootstrap-body" ? IMPORT : BOOTSTRAP).toString("base64") };
    }
    if (method === "Fetch.continueRequest") {
      this.counts["/bootstrap.js"] = 1;
      if (this.mode === "replayed-bootstrap") this.event("Network.requestWillBeSent", { requestId: "bootstrap-id", request: { url: "http://fixture/bootstrap.js", method: "GET" } });
      if (this.fetchFirst) { if (this.mode !== "missing-worker") this.attachWorker(); }
      else this.startRenderer();
      return {};
    }
    if (method === "Debugger.getScriptSource") return { scriptSource: (this.mode === "wrong-bootstrap-source" ? IMPORT : BOOTSTRAP).toString("ascii") };
    if (method === "Debugger.resume") {
      this.event("Debugger.resumed", {}, "worker");
      if (this.mode === "detach") this.event("Target.detachedFromTarget", { sessionId: "worker" });
      if (this.mode === "late-worker") this.event("Target.attachedToTarget", { sessionId: "late", waitingForDebugger: true,
        targetInfo: { type: "worker", parentId: "page-target", targetId: "late" } });
      if (this.mode === "message-before-bodies") this.event("Runtime.consoleAPICalled", { type: "log", args: [{ value: "owned-worker-done" }] });
      if (this.mode === "message-before-bodies") await wait(2);
      if (this.mode !== "missing-import") this.asset("/worker-import.js", "import-id");
      if (this.mode !== "missing-wasm") this.asset("/worker.wasm", "wasm-id");
      this.completeBootstrap();
      if (this.mode !== "message-before-bodies") this.event("Runtime.consoleAPICalled", { type: "log", args: [{ value: "owned-worker-done" }] });
      return {};
    }
    if (method === "Network.getResponseBody") {
      if (params.requestId === "bootstrap-id") {
        if (session !== "worker") throw new Error("bootstrap read on wrong session");
        if (this.mode === "missing-bootstrap-worker-body") throw new Error("untrusted https://host/?token=secret body");
        if (this.mode === "late-bootstrap-worker-body") await wait(80);
        return { base64Encoded: true, body: (this.mode === "wrong-bootstrap-worker-body" ? Buffer.concat([Buffer.from("x"), BOOTSTRAP.subarray(1)]) : BOOTSTRAP).toString("base64") };
      }
      if (this.mode === "missing-body") throw new Error("untrusted https://host/?token=secret body");
      return { base64Encoded: true, body: (params.requestId === "wasm-id" ? WASM : IMPORT).toString("base64") };
    }
    return {};
  }
  pauseBootstrap() {
    this.event("Fetch.requestPaused", { requestId: this.mode === "missing-fetch-id" ? undefined : "fetch-id",
      networkId: this.mode === "wrong-fetch-network" ? "other-request" : "bootstrap-id",
      request: { url: "http://fixture/bootstrap.js", method: "GET" }, responseStatusCode: 200, responseHeaders: [] },
    this.mode === "wrong-fetch-session" ? "foreign-session" : "page");
  }
  attachWorker() {
    const params = { sessionId: this.mode === "empty-worker-session" ? "" : "worker", waitingForDebugger: true,
      targetInfo: { type: "worker", parentId: this.mode === "foreign-parent" ? "foreign" : "page-target",
        targetId: this.mode === "future-target-mismatch" ? "other-target" : "bootstrap-id" } };
    this.event("Target.attachedToTarget", params);
    if (this.mode === "duplicate-worker") this.event("Target.attachedToTarget", params);
  }
  startRenderer() {
    this.queued.forEach(resolve => resolve());
    const request = { requestId: this.mode === "wrong-worker-bootstrap-id" ? "other-id" : "bootstrap-id",
      request: { url: "http://fixture/bootstrap.js", method: this.mode === "wrong-worker-bootstrap-method" ? "POST" : "GET" },
      redirectResponse: this.mode === "redirected-worker-bootstrap" ? {} : undefined };
    this.event("Network.requestWillBeSent", request, "worker");
    if (this.mode === "duplicate-worker-bootstrap-request") this.event("Network.requestWillBeSent", request, "worker");
    if (this.mode === "bootstrap-completion-before-response") this.completeBootstrap();
    if (this.mode !== "missing-bootstrap-response") {
      const response = { requestId: this.mode === "wrong-bootstrap-response-id" ? "other-id" : "bootstrap-id",
        response: { status: this.mode === "wrong-bootstrap-status" ? 201 : 200,
          url: this.mode === "wrong-bootstrap-url" ? "http://fixture/other.js" : "http://fixture/bootstrap.js" } };
      this.event("Network.responseReceived", response, this.mode === "wrong-bootstrap-response-session" ? "foreign" : "worker");
      if (this.mode === "duplicate-bootstrap-response") this.event("Network.responseReceived", response, "worker");
    }
    if (this.mode === "early-import") this.asset("/worker-import.js", "import-id");
    this.event("Debugger.scriptParsed", { scriptId: "script", url: "http://fixture/bootstrap.js" }, "worker");
    this.event("Debugger.paused", { reason: this.mode === "wrong-pause" ? "other" : "instrumentation", data: { scriptId: "script" },
      callFrames: [{ location: { scriptId: "script" } }], hitBreakpoints: [] }, "worker");
  }
  completeBootstrap() {
    if (this.mode === "missing-bootstrap-completion") return;
    const method = this.mode === "failed-bootstrap-completion" ? "Network.loadingFailed" : "Network.loadingFinished";
    this.event(method, { requestId: this.mode === "wrong-bootstrap-completion-id" ? "other-id" : "bootstrap-id" },
      this.mode === "wrong-bootstrap-completion-session" ? "foreign" : "worker");
    if (this.mode === "duplicate-bootstrap-completion") this.event(method, { requestId: "bootstrap-id" }, "worker");
  }
  asset(key, id) {
    this.counts[key] = (this.counts[key] || 0) + 1;
    this.event("Network.requestWillBeSent", { requestId: id, request: { url: `http://fixture${key}`, method: "GET" } }, "worker");
    this.event("Network.responseReceived", { requestId: id, response: { status: 200, url: `http://fixture${key}` } }, "worker");
    this.event("Network.loadingFinished", { requestId: id }, "worker");
  }
}
const MOCK_TIMING = { firstDelayMs: 1, holdDelayMs: 1, completionMs: 50, diagnostics: false };
test("owned probe actual handlers distinguish throttle release from final execution release", async () => {
  const connection = new ProbeProtocolMock();
  const facts = await startupProbe(connection, "http://fixture", connection.counts, MOCK_TIMING);
  expect(facts.childSetupAcksBeforeFirstResume).toBe(0);
  expect(facts.bootstrapTargetBound).toBe(true); expect(facts.creatorFetchBeforeWorkerAttach).toBe(false);
  expect(facts.capability).toBe("classic-bootstrap-second-gate-observed");
  expect(facts.completeCoverage).toBe(false); expect(facts.fromServiceWorker).toBe(null);
  const commands = connection.commands.filter(value => value.session === "worker").map(value => value.method);
  expect(commands.indexOf("Debugger.setInstrumentationBreakpoint")).toBeLessThan(commands.indexOf("Runtime.runIfWaitingForDebugger"));
  expect(commands.indexOf("Debugger.removeBreakpoint")).toBeLessThan(commands.indexOf("Debugger.resume"));
  expect(connection.commands.find(value => value.method === "Fetch.continueRequest").params).toEqual({ requestId: "fetch-id" });
});
test("owned probe waits for response bodies after cross-session page completion", async () => {
  const connection = new ProbeProtocolMock("message-before-bodies");
  const facts = await startupProbe(connection, "http://fixture", connection.counts, MOCK_TIMING);
  expect(facts.importBodyMatches && facts.wasmBodyMatches && facts.workerMessageObserved).toBe(true);
});
for (const mode of ["foreign-parent", "missing-bootstrap", "wrong-bootstrap-body", "wrong-pause", "early-import", "detach", "late-worker", "missing-import", "missing-wasm", "missing-body"]) {
  test(`owned probe actual handlers reject ${mode}`, async () => {
    const connection = new ProbeProtocolMock(mode);
    await expect(startupProbe(connection, "http://fixture", connection.counts, MOCK_TIMING)).rejects.toThrow(/^owned-cdp:[a-z-]+$/);
  });
}
test("owned probe binds creator-first capture only after the exact future worker attaches", async () => {
  const connection = new ProbeProtocolMock("valid", { fetchFirst: true }), facts = newFacts();
  const send = connection.send.bind(connection); let unboundAtContinuation = false;
  connection.send = (method, params, session) => {
    if (method === "Fetch.continueRequest") unboundAtContinuation = facts.bootstrapTargetBound === false;
    return send(method, params, session);
  };
  await startupProbe(connection, "http://fixture", connection.counts, { ...MOCK_TIMING, facts });
  expect(unboundAtContinuation).toBe(true); expect(facts.bootstrapTargetBound).toBe(true);
  expect(facts.creatorFetchBeforeWorkerAttach).toBe(true); expect(facts.instrumentationPauseObserved).toBe(true);
  expect(facts.setupAcksBeforeFinalResume && facts.importBodyMatches && facts.wasmBodyMatches).toBe(true);
  expect([facts.fromDiskCache, facts.fromPrefetchCache, facts.fromServiceWorker]).toEqual([null, null, null]);
  expect(facts.completeCoverage || facts.collectorProofEstablished).toBe(false);
  expect(connection.commands.filter(command => command.method === "Fetch.getResponseBody")).toHaveLength(1);
  expect(connection.commands.filter(command => command.method === "Fetch.continueRequest")).toEqual([
    { method: "Fetch.continueRequest", params: { requestId: "fetch-id" }, session: "page" },
  ]);
});
for (const [mode, reason] of [
  ["attachment-before-original", "probe-worker-owner-mismatch"], ["empty-worker-session", "probe-worker-owner-mismatch"],
  ["future-target-mismatch", "probe-worker-owner-mismatch"], ["duplicate-worker", "probe-worker-owner-mismatch"],
  ["foreign-parent", "probe-worker-owner-mismatch"], ["replayed-bootstrap", "probe-bootstrap-request-invalid"],
  ["duplicate-fetch", "probe-fetch-owner-mismatch"], ["wrong-fetch-session", "probe-fetch-owner-mismatch"],
  ["wrong-fetch-network", "probe-fetch-owner-mismatch"], ["missing-fetch-id", "probe-fetch-owner-mismatch"],
  ["missing-original", "probe-fetch-owner-mismatch"], ["late-worker", "probe-worker-owner-mismatch"],
  ["early-import", "execution-before-owned-release"], ["wrong-pause", "probe-bootstrap-pause-invalid"],
  ["wrong-bootstrap-body", "probe-protocol-operation-failed"], ["missing-import", "probe-capability-timeout"],
  ["missing-wasm", "probe-capability-timeout"], ["missing-body", "probe-protocol-operation-failed"],
  ["detach", "probe-target-lifecycle-lost"],
]) {
  test(`provisional creator-first capture rejects ${mode}`, async () => {
    const connection = new ProbeProtocolMock(mode, { fetchFirst: true }), facts = newFacts();
    await expect(startupProbe(connection, "http://fixture", connection.counts, { ...MOCK_TIMING, facts })).rejects.toThrow(reason);
    expect(facts.capability).toBe("unestablished"); expect(facts.completeCoverage || facts.collectorProofEstablished).toBe(false);
    if (["attachment-before-original", "empty-worker-session", "future-target-mismatch", "foreign-parent", "wrong-fetch-session", "wrong-fetch-network", "missing-original"].includes(mode)) expect(facts.bootstrapTargetBound).toBe(false);
    if (["duplicate-fetch", "wrong-fetch-session", "wrong-fetch-network", "missing-fetch-id", "missing-original", "wrong-bootstrap-body"].includes(mode)) {
      expect(connection.commands.some(command => command.method === "Fetch.continueRequest")).toBe(false);
    }
  });
}
for (const fetchFirst of [false, true]) {
  test(`owned worker bootstrap body is read once and matches creator capture, fetchFirst=${fetchFirst}`, async () => {
    const connection = new ProbeProtocolMock("valid", { fetchFirst });
    const facts = await startupProbe(connection, "http://fixture", connection.counts, MOCK_TIMING);
    expect(facts.bootstrapWorkerBodyMatches && facts.pauseSourceMatchesBootstrap).toBe(true);
    expect(connection.commands.filter(command => command.method === "Network.getResponseBody" && command.params.requestId === "bootstrap-id")).toEqual([
      { method: "Network.getResponseBody", params: { requestId: "bootstrap-id" }, session: "worker" },
    ]);
    expect(connection.counts["/bootstrap.js"]).toBe(1);
    expect(connection.commands.filter(command => command.method === "Fetch.getResponseBody")).toHaveLength(1);
    expect(facts.completeCoverage || facts.collectorProofEstablished).toBe(false);
  });
}
for (const [mode, reason] of [
  ["wrong-worker-bootstrap-id", "probe-bootstrap-request-invalid"], ["wrong-worker-bootstrap-method", "probe-bootstrap-request-invalid"],
  ["redirected-worker-bootstrap", "probe-bootstrap-request-invalid"], ["duplicate-worker-bootstrap-request", "probe-bootstrap-request-invalid"],
  ["missing-bootstrap-worker-body", "probe-protocol-operation-failed"], ["wrong-bootstrap-worker-body", "probe-protocol-operation-failed"],
  ["late-bootstrap-worker-body", "probe-capability-timeout"], ["missing-bootstrap-response", "probe-bootstrap-completion-invalid"],
  ["wrong-bootstrap-url", "probe-bootstrap-response-invalid"], ["wrong-bootstrap-status", "probe-bootstrap-response-invalid"],
  ["wrong-bootstrap-response-id", "probe-bootstrap-completion-invalid"], ["wrong-bootstrap-response-session", "probe-bootstrap-source-invalid"],
  ["duplicate-bootstrap-response", "probe-event-invalid"], ["duplicate-bootstrap-completion", "probe-bootstrap-completion-invalid"],
  ["missing-bootstrap-completion", "probe-capability-timeout"], ["failed-bootstrap-completion", "probe-network-failed"],
  ["wrong-bootstrap-completion-id", "probe-capability-timeout"], ["wrong-bootstrap-completion-session", "probe-bootstrap-source-invalid"],
  ["bootstrap-completion-before-response", "probe-bootstrap-completion-invalid"], ["wrong-bootstrap-source", "probe-protocol-operation-failed"],
]) {
  test(`owned worker bootstrap lifecycle rejects ${mode}`, async () => {
    const connection = new ProbeProtocolMock(mode, { fetchFirst: true }), facts = newFacts();
    await expect(startupProbe(connection, "http://fixture", connection.counts, { ...MOCK_TIMING, facts })).rejects.toThrow(reason);
    if (mode === "late-bootstrap-worker-body") await wait(85);
    expect(facts.bootstrapWorkerBodyMatches).toBe(false); expect(facts.capability).toBe("unestablished");
    expect(facts.completeCoverage || facts.collectorProofEstablished).toBe(false);
    expect(connection.commands.filter(command => command.method === "Fetch.getResponseBody")).toHaveLength(1);
    expect(connection.commands.filter(command => command.method === "Network.getResponseBody" && command.params.requestId === "bootstrap-id").length).toBeLessThanOrEqual(1);
    expect(connection.counts["/bootstrap.js"]).toBe(1);
  });
}
test("cleanup rejects a surviving group even after leader and listener exit", async () => {
  await expect(cleanupOwnedProcess({ child: { pid: 123, exitCode: 0, signalCode: null }, identity: { start: "800" }, endpoint: { inode: "876" } }, {
    listenerPresent: async () => false, groupPresent: () => true, pause: async () => { throw problem("cleanup-process-group-survived"); },
  })).rejects.toThrow("cleanup-process-group-survived");
});
test("no-follow bounded metadata rejects an actual FIFO without waiting for a writer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-cdp-fifo-"));
  try {
    const fifo = path.join(root, "DevToolsActivePort");
    require("node:child_process").execFileSync("mkfifo", [fifo]);
    await expect(deadline(readSmall(fifo, 512, true), 200, "fifo-read-timeout")).rejects.toThrow("metadata-file-invalid");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const second of [{ fromDiskCache: false }, {}]) {
  test(`bootstrap true then ${JSON.stringify(second)} cannot erase provenance`, () => {
    const facts = newFacts(); recordBootstrapFlags(facts, { fromDiskCache: true });
    expect(() => recordBootstrapFlags(facts, second)).toThrow("duplicate-bootstrap-response");
    expect(facts.fromDiskCache).toBe(true); expect(facts.fromServiceWorker).toBe(null);
  });
}
test("cleanup permits bounded normal group reaping without signaling an exited leader", async () => {
  let checks = 0, pauses = 0;
  await cleanupOwnedProcess({ child: { pid: 123, exitCode: 0, signalCode: null }, identity: { start: "800" } }, {
    groupPresent: () => ++checks < 3, pause: async () => pauses++, groupSignal: () => { throw new Error("stale group signal"); },
  });
  expect(pauses).toBe(2);
});

test.describe("bounded all-startup rejection trace", () => {
  test("aliases and fixed checks redact arbitrary protocol data and bound map/ring", () => {
    const trace = startupTrace(), secret = "https://secret.invalid/?token=private";
    for (let i = 0; i < 100; i++) trace.record(secret, secret, `session-${i}`, {
      requestId: `request-${i}`, networkId: secret, request: { url: secret, body: secret }, responseHeaders: [{ name: secret, value: secret }], error: secret,
    });
    const snapshot = trace.snapshot();
    expect(snapshot.events).toHaveLength(32); expect(snapshot.droppedEvents).toBe(68); expect(snapshot.identityLimitReached).toBe(true);
    expect(snapshot.events.every(event => event.method === "other" && event.phase === "other")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|token|https|request-[0-9]|session-[0-9]/);
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.events) && Object.isFrozen(snapshot.events[0]) && Object.isFrozen(snapshot.events[0].checks)).toBe(true);
    trace.record("Fetch.requestPaused", "event", "later"); expect(snapshot.events).toHaveLength(32); expect(snapshot.droppedEvents).toBe(68);
  });
  test("exact equality and ID aliases identify original/target association without raw IDs", () => {
    const trace = startupTrace();
    trace.record("Fetch.requestPaused", "event", "owned-page", { requestId: "interception", networkId: "bootstrap-original",
      request: { url: "http://fixture/bootstrap.js", method: "GET" }, responseStatusCode: 200, responseHeaders: [] },
    { page: "owned-page", worker: "owned-worker", original: "bootstrap-original", workerTarget: "bootstrap-original", pauseCount: 0, origin: "http://fixture" });
    const event = trace.snapshot().events[0];
    expect(event.network).toBe(event.expectedOriginal); expect(event.expectedOriginal).toBe(event.expectedWorkerTarget);
    expect(event.checks.networkIdEqualsOriginal && event.checks.originalEqualsWorkerTarget && event.checks.status200).toBe(true);
    expect(JSON.stringify(event)).not.toContain("bootstrap-original");
  });
  test("provisional creator bytes alone retain the measured Fetch-before-attach trace but cannot succeed", async () => {
    const connection = new ProbeProtocolMock("missing-worker", { fetchFirst: true }), facts = newFacts();
    await expect(startupProbe(connection, "http://fixture", connection.counts, { ...MOCK_TIMING, facts })).rejects.toThrow("probe-capability-timeout");
    const events = facts.startupTrace.events, fetch = events.find(event => event.method === "Fetch.requestPaused");
    expect(fetch.checks).toMatchObject({ originalPresent: true, workerTargetPresent: false, sessionIsPage: true,
      networkIdEqualsOriginal: true, originalEqualsWorkerTarget: false, bootstrapUrlMatches: true, getMethod: true,
      firstPauseCandidate: true, status200: true, responseErrorAbsent: true, redirectedRequestAbsent: true,
      responseHeadersArray: true, responseHeadersWithinBound: true });
    expect(events.some(event => event.method === "Network.requestWillBeSent" && event.sequence < fetch.sequence)).toBe(true);
    expect(events.filter(event => event.method === "Target.attachedToTarget" && event.checks.targetIsWorker)).toHaveLength(0);
    expect(facts.creatorFetchBodyMatches && facts.continuedWithoutOverrides).toBe(true);
    expect(facts.bootstrapTargetBound).toBe(false); expect(facts.capability).toBe("unestablished");
    const commands = connection.commands.length; connection.attachWorker();
    expect(connection.commands).toHaveLength(commands); expect(facts.bootstrapTargetBound).toBe(false);
  });
  for (const mode of ["foreign-parent", "missing-bootstrap", "wrong-bootstrap-body", "wrong-pause", "early-import", "detach", "late-worker", "missing-import", "missing-wasm", "missing-body"]) {
    test(`fixed frozen trace survives ${mode} rejection`, async () => {
      const connection = new ProbeProtocolMock(mode), facts = newFacts();
      await expect(startupProbe(connection, "http://fixture", connection.counts, { ...MOCK_TIMING, facts })).rejects.toThrow(/^owned-cdp:/);
      expect(facts.startupTrace.events.length).toBeGreaterThan(0); expect(facts.startupTrace.events.length).toBeLessThanOrEqual(32);
      expect(Object.isFrozen(facts.startupTrace)).toBe(true);
      const encoded = JSON.stringify(facts.startupTrace); connection.event("arbitrary secret event", { token: "private" });
      expect(JSON.stringify(facts.startupTrace)).toBe(encoded); expect(encoded).not.toMatch(/https:|token=secret|untrusted/);
      if (mode === "wrong-bootstrap-body") expect(facts.startupTrace.events.some(event => event.method === "probe.bootstrap-fetch" && event.phase === "reject")).toBe(true);
    });
  }
  test("root setup command rejection retains fixed method but not arbitrary error text", async () => {
    const connection = new ProbeProtocolMock(), facts = newFacts();
    connection.send = async () => { throw new Error("https://secret.invalid/?token=private body"); };
    await expect(startupProbe(connection, "http://fixture", {}, { ...MOCK_TIMING, facts })).rejects.toThrow();
    expect(facts.startupTrace.events.map(event => [event.method, event.phase])).toEqual([
      ["Target.createBrowserContext", "send"], ["Target.createBrowserContext", "reject"],
    ]);
    expect(JSON.stringify(facts.startupTrace)).not.toMatch(/secret|private|token|body|https/);
  });
});

test.describe("read-only launch prerequisite diagnostics", () => {
  const secret = "https://private.invalid/?token=secret /secret/path authorization=secret";
  for (const [text, category] of [
    ["Running as root without --no-sandbox is not supported", "root-refusal"],
    ["No usable sandbox!", "no-usable-sandbox"],
    ["Failed to move to new namespace: errno = Operation not permitted", "namespace-denied"],
    ["The SUID sandbox helper binary was found, but is not configured correctly", "helper-configuration"],
    ["an unrelated error", "unknown"],
  ]) {
    test(`returns only the fixed ${category} stderr category`, () => {
      expect(stderrCategory(`${secret} ${text} ${secret}`)).toBe(category);
      expect(stderrCategory("x".repeat(4096) + text)).toBe("unknown");
    });
  }
  for (const text of ["", "-1", "2", "1 token", "01", "1\nextra", "4294967296", secret, null]) {
    test(`malformed bounded setting ${JSON.stringify(text)}`, () => {
      expect(numericObservation(text, 1)).toEqual({ status: "invalid", value: null });
    });
  }
  test("accepts only bounded numeric settings without inventing missing values", () => {
    expect(numericObservation("0\n", 1)).toEqual({ status: "observed", value: 0 });
    expect(numericObservation("1", 1)).toEqual({ status: "observed", value: 1 });
    expect(numericObservation("4294967295")).toEqual({ status: "observed", value: 4294967295 });
  });
  test("collects fixed sibling metadata and never reads an override value", async () => {
    const names = [], env = {}; Object.defineProperty(env, "CHROME_DEVEL_SANDBOX", { get() { throw new Error("value must not be read"); } });
    const observations = await collectLaunchPrerequisites({ realpath: "/installed/chrome" }, {
      effectiveUid: () => 1001, overridePresent: () => Object.hasOwn(env, "CHROME_DEVEL_SANDBOX"),
      read: async name => name.endsWith("max_user_namespaces") ? "65536\n" : "1\n",
      lstat: async name => { names.push(name); return { uid: 0, gid: 0, mode: 0o104755, isFile: () => true, isSymbolicLink: () => false }; },
    });
    expect(names.sort()).toEqual(["/installed/chrome-sandbox", "/installed/chrome_sandbox"]);
    expect(observations.underscoreHelper).toEqual({ status: "observed", kind: "regular-file", uid: 0, gid: 0, mode: 0o4755 });
    expect(observations.chromeDevelSandboxPresent).toBe(true); expect(observations.chromeDevelSandboxInherited).toBe(false);
    expect(Object.isFrozen(observations) && Object.isFrozen(observations.effectiveUid) && Object.isFrozen(observations.underscoreHelper)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("/installed");
  });
  test("absent, unreadable and timed-out inputs stay unavailable without raw errors", async () => {
    const observations = await collectLaunchPrerequisites({ realpath: "/secret/chrome" }, {
      effectiveUid: () => { throw new Error(secret); }, overridePresent: () => { throw new Error(secret); },
      read: async () => { throw new Error(secret); }, lstat: () => new Promise(() => {}), timeoutMs: 5,
    });
    expect(observations.effectiveUid.status).toBe("unavailable"); expect(observations.unprivilegedUsernsClone.status).toBe("unavailable");
    expect(observations.chromeDevelSandboxPresent).toBe(null); expect(observations.underscoreHelper.status).toBe("unavailable");
    expect(JSON.stringify(observations)).not.toMatch(/secret|private|token|\/secret/);
  });
  test("missing fixed sibling helpers are distinguished from unreadable metadata", async () => {
    const observations = await collectLaunchPrerequisites({ realpath: "/installed/chrome" }, {
      effectiveUid: () => 1001, overridePresent: () => false, read: async () => "1",
      lstat: async () => { throw Object.assign(new Error(secret), { code: "ENOENT" }); },
    });
    expect(observations.hyphenHelper.status).toBe("absent");
    expect(observations.chromeDevelSandboxPresent).toBe(false);
    expect(JSON.stringify(observations)).not.toContain(secret);
  });
  test("malformed helper metadata and symlinks are never followed or called usable", () => {
    expect(helperObservation({ uid: "root", gid: 0, mode: 0o4755 }).status).toBe("invalid");
    expect(helperObservation({ uid: 1001, gid: 1001, mode: 0o120777, isFile: () => false, isSymbolicLink: () => true }).kind).toBe("symlink");
    expect(helperObservation(null).status).toBe("unavailable");
  });
  test("sanitized launch failure retains only frozen diagnostics", async () => {
    const observations = await collectLaunchPrerequisites(undefined, { effectiveUid: () => 0, overridePresent: () => false, read: async () => "0" });
    const error = attachPrerequisites(new Error(secret), observations, `No usable sandbox! ${secret}`, true);
    expect(error.message).toBe("owned-cdp:launch-failed"); expect(error.stack).not.toContain(secret);
    expect(prerequisiteDiagnosticsFor(error).stderrCategory).toBe("no-usable-sandbox");
    expect(prerequisiteDiagnosticsFor(error).stderrCaptureTruncated).toBe(true);
    expect(Object.isFrozen(prerequisiteDiagnosticsFor(error))).toBe(true);
    expect(prerequisiteDiagnosticsFor(new Error(secret))).toBe(null);
    expect(JSON.stringify(prerequisiteDiagnosticsFor(error))).not.toMatch(/secret|private|token/);
  });
});

test("owned flattened CDP real Chromium startup capability probe", async () => {
  test.setTimeout(40000);
  let owned, server; const counts = {}, facts = newFacts(); let prerequisites = null;
  try {
    owned = await launchOwnedChromium(); prerequisites = owned.prerequisites;
    server = http.createServer((request, response) => {
      const name = request.url; counts[name] = (counts[name] || 0) + 1;
      if (request.method !== "GET" || counts[name] > 1) { response.writeHead(409); response.end(); return; }
      let bytes = BODIES[name];
      if (name === "/") bytes = Buffer.from('<!doctype html><script>const w=new Worker("/bootstrap.js");w.onmessage=e=>{if(e.data==="owned-worker-done")console.log(e.data);};</script>');
      if (!bytes) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Type": name === "/worker.wasm" ? "application/wasm" : name === "/" ? "text/html" : "text/javascript",
        "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes);
    });
    await deadline(new Promise((resolve, reject) => { server.once("error", () => reject(problem("fixture-server-failed"))); server.listen(0, "127.0.0.1", resolve); }), 1000, "fixture-server-timeout");
    const origin = `http://127.0.0.1:${server.address().port}`;
    await startupProbe(owned.connection, origin, counts, { facts });
    await owned.verify(); facts.endpointReverified = true; facts.stage = "endpoint-reverified";
    expect(facts.capability).toBe("classic-bootstrap-second-gate-observed");
  } catch (error) {
    prerequisites ||= prerequisiteDiagnosticsFor(error);
    facts.errorCode = /^owned-cdp:[a-z-]+$/.test(error?.message || "") ? error.message : "owned-cdp:probe-failed";
    throw problem(facts.errorCode.slice(10));
  } finally {
    let failure;
    try { if (owned) { await owned.close(); facts.cleanupVerified = true; if (!facts.errorCode) facts.stage = "cleanup-verified"; } } catch (error) { failure = error; }
    if (server) {
      try { server.closeAllConnections(); await deadline(new Promise(resolve => server.close(resolve)), 1000, "fixture-server-cleanup-timeout"); }
      catch { failure ||= problem("fixture-server-cleanup-failed"); }
    }
    if (failure) facts.errorCode = /^owned-cdp:[a-z-]+$/.test(failure.message || "") ? failure.message : "owned-cdp:cleanup-failed";
    facts.probeSucceeded = facts.capability === "classic-bootstrap-second-gate-observed" && facts.endpointReverified && facts.cleanupVerified && !facts.errorCode;
    console.log(`OWNED_FLAT_CDP_PROBE ${JSON.stringify({ ...facts, prerequisites, browserVersion: owned?.pin.browserVersion || null, playwrightVersion: owned?.pin.playwrightVersion || null })}`);
    if (failure) throw problem(facts.errorCode.slice(10));
  }
});


// Falsification: provenance cannot turn an absent/replaced executable, wrapper,
// nonempty profile or secret-bearing failure into an observed clean launch.
const hashBytes = bytes => `sha256:${require("node:crypto").createHash("sha256").update(bytes).digest("hex")}`;
async function executableFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-provenance-"));
  try {
    const realpath = path.join(root, "binary"), bytes = Buffer.from([0x7f,0x45,0x4c,0x46,0,1,2,3]);
    await fs.writeFile(realpath, bytes); const stat = await fs.stat(realpath);
    await run({root,bytes,executable:{realpath,dev:stat.dev,ino:stat.ino,size:stat.size}});
  } finally { await fs.rm(root,{recursive:true,force:true}); }
}
test("executable observation streams exact selected file and only emits fixed metadata", async()=>executableFixture(async({bytes,executable})=>{
 const report=await executableObservation(executable);
 expect(report).toEqual({status:"observed",sha256:hashBytes(bytes),sizeBytes:8,format:"elf-magic"});
 expect(Object.isFrozen(report)).toBe(true); expect(JSON.stringify(report)).not.toContain(executable.realpath);
}));
for(const [name,bytes,format] of [["wrapper",Buffer.from("#!/secret/token\n"),"shebang"],["other",Buffer.from("SECRET_BODY"),"other"]])
 test(`executable format ${name} is measured without exposing its contents`,async()=>executableFixture(async({executable})=>{
  await fs.writeFile(executable.realpath,bytes); executable.size=bytes.length;
  const report=await executableObservation(executable); expect(report).toMatchObject({status:"observed",format,sizeBytes:bytes.length});
  expect(JSON.stringify(report)).not.toMatch(/SECRET|secret|token/);
 }));
test("executable observation rejects missing symlink directory and wrong selected identity",async()=>executableFixture(async({root,executable})=>{
 const symlink=path.join(root,"link");await fs.symlink(executable.realpath,symlink);
 for(const changed of [{realpath:symlink},{realpath:root},{realpath:root+"/absent"},{ino:executable.ino+1}]) {
  const report=await executableObservation({...executable,...changed});expect(report.status).not.toBe("observed");expect(report.sha256).toBeNull();
 }
}));
test("executable observation refuses FIFO metadata before any stream read",async()=>{
 let streamed=false,closed=false,flags;
 const report=await executableObservation({realpath:"SECRET",dev:1,ino:2,size:0},{open:async(name,f)=>{flags=f;return {stat:async()=>({isFile:()=>false}),close:async()=>{closed=true;}};},stream:()=>{streamed=true;}});
 expect(report.status).toBe("invalid");expect(streamed).toBe(false);expect(closed).toBe(true);
 const c=require("node:fs").constants; expect(flags & c.O_NONBLOCK).toBe(c.O_NONBLOCK);expect(flags & c.O_NOFOLLOW).toBe(c.O_NOFOLLOW);
});
test("executable size bound never starts a stream",async()=>{
 let streamed=false,closed=false;
 const report=await executableObservation({realpath:"SECRET"},{open:async()=>({stat:async()=>({isFile:()=>true,size:PROVENANCE_LIMITS.executableBytes+1}),close:async()=>{closed=true;}}),stream:()=>{streamed=true;}});
 expect(report.status).toBe("oversize");expect(streamed).toBe(false);expect(closed).toBe(true);
});
test("executable timeout cancels stream and closes its descriptor",async()=>executableFixture(async({executable})=>{
 let stream;
 const {Readable,addAbortSignal}=require("node:stream");
 const report=await executableObservation(executable,{timeoutMs:5,stream:(file,options)=>{stream=addAbortSignal(options.signal,new Readable({read(){}}));return stream;}});
 expect(report.status).toBe("timeout");expect(report.sha256).toBeNull();expect(stream.destroyed).toBe(true);
}));
test("executable observation detects path replacement after reading the owned file",async()=>executableFixture(async({executable})=>{
 const report=await executableObservation(executable,{lstat:async name=>{const s=await fs.lstat(name);return {...s,isFile:()=>true,ino:s.ino+1};}});
 expect(report.status).toBe("changed");expect(report.sha256).toBeNull();
}));
test("executable observation detects mutation of the open file",async()=>executableFixture(async({bytes,executable})=>{
 const {Readable}=require("node:stream");
 const report=await executableObservation(executable,{stream:()=>Readable.from((async function*(){yield bytes;await fs.appendFile(executable.realpath,"x");})())});
 expect(report.status).toBe("changed");expect(report.sha256).toBeNull();
}));
test("executable error text and unsupported deadline never escape",async()=>{
 const report=await executableObservation({realpath:"SECRET"},{open:async()=>{throw Error("SECRET https://token.invalid");}});
 expect(report.status).toBe("unavailable");expect(JSON.stringify(report)).not.toContain("SECRET");
 expect((await executableObservation({}, {timeoutMs:NaN})).status).toBe("invalid");
});
test("profile observation distinguishes empty nonempty and symlink without entry names",async()=>executableFixture(async({root})=>{
 const profile=path.join(root,"profile");await fs.mkdir(profile,{mode:0o700});
 const empty=await freshProfileObservation(profile);expect(empty).toMatchObject({status:"observed",empty:true,stableIdentity:true,ownedByEffectiveUid:true,mode:0o700});
 await fs.writeFile(path.join(profile,"SECRET"),"SECRET");const nonempty=await freshProfileObservation(profile);
 expect(nonempty.empty).toBe(false);expect(JSON.stringify(nonempty)).not.toContain("SECRET");
 await fs.symlink(profile,path.join(root,"link"));expect((await freshProfileObservation(path.join(root,"link"))).status).toBe("invalid");
 expect(Object.isFrozen(empty)).toBe(true);
}));
test("profile unavailable and replaced observations stay distinct",async()=>{
 expect((await freshProfileObservation("SECRET",{lstat:async()=>{throw Error("SECRET");}})).status).toBe("unavailable");
 let n=0,closed=false;const report=await freshProfileObservation("SECRET",{lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,dev:1,ino:++n,uid:7,mode:0o700}),uid:()=>7,opendir:async()=>({read:async()=>null,close:async()=>{closed=true;}})});
 expect(report).toMatchObject({status:"observed",stableIdentity:false});expect(closed).toBe(true);
});
test("launch policy facts describe unchanged arguments and no policy inspection",()=>{
 expect(launchPolicyObservation(launchArguments("SECRET"))).toEqual({componentBackgroundDisabled:false,extensionsDisabled:false,componentUpdatesDisabled:false,testType:false,loadExtension:false,hostPolicyInspection:"not-performed"});
});
test("frozen sanitized provenance survives failure without arbitrary product or pin fields",()=>{
 const pin={playwrightVersion:"SECRET",browserVersion:"SECRET",executable:{realpath:"SECRET"}};
 const report=launchProvenance(pin,null,null,"SECRET_PRODUCT"),error=problem("launch-failed");attachLaunchProvenance(error,report);
 expect(launchProvenanceFor(error)).toBe(report);expect(Object.isFrozen(report)).toBe(true);
 expect(JSON.stringify(report)).not.toContain("SECRET");expect(launchProvenanceFor(Error("SECRET"))).toBeNull();
});

test("declared pin provenance stays distinct from observed running product",()=>{
 const pin={playwrightVersion:"1.64.1",browserVersion:"156.0.8078.4",browserRevision:"1248",distribution:"Chrome for Testing"};
 expect(launchProvenance(pin,null,null,"Chrome/156.0.8078.4")).toMatchObject({playwrightVersion:"1.64.1",browserRevision:"1248",declaredDistribution:"playwright-chromium-cft",observedProduct:"Chrome/156.0.8078.4"});
 expect(launchProvenance({},null,null,"OTHER")).toMatchObject({browserRevision:null,declaredDistribution:null,observedProduct:null});
});

test("executable EOF followed by delayed metadata cannot report observed after timeout",async()=>executableFixture(async({executable})=>{
 const report=await executableObservation(executable,{timeoutMs:5,lstat:async name=>{await wait(20);return fs.lstat(name);}});
 expect(report).toEqual({status:"timeout",sha256:null,sizeBytes:null,format:"unknown"});
}));
test("executable descriptor close failure invalidates an otherwise observed result",async()=>executableFixture(async({executable})=>{
 let closed=false;
 const report=await executableObservation(executable,{open:async(name,flags)=>{const handle=await fs.open(name,flags);return {stat:()=>handle.stat(),createReadStream:options=>handle.createReadStream(options),close:async()=>{await handle.close();closed=true;throw Error("SECRET_CLOSE");}};}});
 expect(closed).toBe(true);expect(report.status).toBe("unavailable");expect(report.sha256).toBeNull();expect(JSON.stringify(report)).not.toContain("SECRET");
}));

test("profile close failure downgrades otherwise observed empty directory",async()=>{
 let closed=false;
 const report=await freshProfileObservation("SECRET",{lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,dev:1,ino:2,uid:7,mode:0o700}),uid:()=>7,
  opendir:async()=>({read:async()=>null,close:async()=>{closed=true;throw Error("SECRET_CLOSE");}})});
 expect(closed).toBe(true);expect(report).toEqual({status:"unavailable",empty:null,ownedByEffectiveUid:null,mode:null,stableIdentity:null});
 expect(JSON.stringify(report)).not.toContain("SECRET");expect(Object.isFrozen(report)).toBe(true);
});


// Falsification: the opt-in fixture setting cannot change sandbox/security
// flags, invent an applied control, or admit any pre-existing target.
test("component-background suppression is an explicit one-flag test option",()=>{
 const base=launchArguments("SECRET_PROFILE"), suppressed=launchArguments("SECRET_PROFILE",{suppressComponentBackgroundExtensions:true});
 expect(suppressed).toEqual([...base,"--disable-component-extensions-with-background-pages"]);
 expect(base).not.toContain("--disable-component-extensions-with-background-pages");
 expect(suppressed.some(arg=>/no-sandbox|disable-setuid-sandbox|disable-web-security|remote-allow-origins|disable-extensions$/.test(arg))).toBe(false);
});
for(const [index,value] of ["true",1,null,{}].entries())test(`component fixture option rejects nonboolean ${index}`,()=>{
 expect(()=>launchArguments("SECRET",{suppressComponentBackgroundExtensions:value})).toThrow(/^owned-cdp:component-profile-invalid$/);
});
test("launch provenance reports actual passed argument set rather than current defaults",()=>{
 const actual=Object.freeze(launchArguments("SECRET",{suppressComponentBackgroundExtensions:true}));
 const report=launchProvenance(null,null,null,null,actual);
 expect(report.launchPolicy).toEqual({componentBackgroundDisabled:true,extensionsDisabled:false,componentUpdatesDisabled:false,testType:false,loadExtension:false,hostPolicyInspection:"not-performed"});
 expect(JSON.stringify(report)).not.toContain("SECRET");expect(Object.isFrozen(report.launchPolicy)).toBe(true);
 expect(launchProvenance(null,null,null,null,[]).launchPolicy.componentBackgroundDisabled).toBe(false);
});
test("pre-spawn failure provenance has unknown applied flags",()=>{
 const report=launchProvenance(null,null,null,null);
 expect(report.launchPolicy).toEqual({componentBackgroundDisabled:null,extensionsDisabled:null,componentUpdatesDisabled:null,testType:null,loadExtension:null,hostPolicyInspection:"not-performed"});
});
test("production-layer real fixture alone opts in and launcher passes the same captured arguments",async()=>{
 const fixture=await fs.readFile(path.join(__dirname,"owned-flat-layer-fixture.spec.js"),"utf8");
 expect(fixture).toContain("launchOwnedChromium({ boundedBodies:true, suppressComponentBackgroundExtensions:true })");
 const launcher=await fs.readFile(path.join(__dirname,"owned-flat-cdp.js"),"utf8");
 expect(launcher).toContain("child = spawn(pin.executable.realpath, actualArgs,");
 expect(launcher).toContain("launchProvenance(pin, executableFacts, profileFacts, observedProduct, actualArgs)");
});

// Falsification: protocol rejection is not process death. No protocol text,
// unlisted method, stderr/path/env value or cleanup exception may escape.
for (const [message, category] of [
  ["Hidden target can be created only when remote debugging is enabled", "hidden-remote-debugging-required"],
  ["Hidden target cannot be created for tab", "hidden-tab-forbidden"],
  ["Hidden target cannot be created in a new window", "hidden-new-window-forbidden"],
  ["Hidden target can be created only in background", "hidden-background-required"],
  ["Hidden target can be created only when remote debugging is enabled SECRET", "unknown"],
  [undefined, "unavailable"],
]) test(`fixed hidden protocol rejection category ${category}`, async () => {
  const socket = new MockSocket(), c = new FlatConnection(socket), task = c.send("Target.createTarget", { hidden: true });
  socket.reply({ id: 1, error: { code: -32000, message, data: { SECRET: "https://SECRET.invalid" } } });
  await expect(task).rejects.toThrow(/^owned-cdp:command-rejected$/);
  const before = c.diagnostics(); expect(before).toEqual({ firstFailure: { reason: "command-rejected",
    command: { method: "Target.createTarget", protocolCode: -32000, messageCategory: category } }, closeObserved: false, closeCode: null, closeWasClean: null, errorObserved: false });
  socket.emit("close"); socket.emit("error", Error("SECRET")); c.fail("browser-exited"); c.close();
  expect(c.diagnostics().firstFailure).toBe(before.firstFailure); expect(before.closeObserved).toBe(false);
  expect(c.diagnostics()).toMatchObject({ closeObserved: true, errorObserved: true });
  expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before.firstFailure.command)).toBe(true);
  expect(JSON.stringify(c.diagnostics())).not.toContain("SECRET"); expect(JSON.stringify(c.diagnostics()).length).toBeLessThan(384);
});
for (const code of [NaN, Infinity, -Infinity, 0.1, "-32000", null, undefined, -2147483649, 2147483648, Number.MAX_SAFE_INTEGER]) {
  test(`protocol numeric diagnostic rejects malformed or out-of-bound code ${String(code)}`, () => {
    const result = commandRejectionObservation("SECRET".repeat(10000), { code, message: "SECRET".repeat(10000), data: "SECRET" });
    expect(result).toEqual({ method: "other", protocolCode: null, messageCategory: "unknown" });
    expect(JSON.stringify(result).length).toBeLessThan(100);
  });
}
for (const code of [-2147483648, -32602, 0, 2147483647]) test(`protocol numeric diagnostic retains bounded integer ${code}`, () => {
  expect(commandRejectionObservation("Target.createTarget", { code }).protocolCode).toBe(code);
});
for (const [event, reason] of [["close", "transport-closed"], ["error", "transport-error"], ["process", "browser-exited"]]) {
  test(`protocol diagnostic distinguishes ${event} before command reply`, async () => {
    const socket = new MockSocket(), c = new FlatConnection(socket), task = c.send("Target.createTarget");
    if (event === "process") c.fail("browser-exited"); else socket.emit(event, Error("SECRET"));
    await expect(task).rejects.toThrow(reason); expect(c.diagnostics().firstFailure).toEqual({ reason, command: null }); c.close();
  });
}
test("lifecycle report retains bounded existing exit and cleanup observations", () => {
  const result = launchLifecycleObservation({ child: { exitCode: 1, signalCode: "SIGABRT", SECRET: true }, exitObserved: true,
    exitPhase: "before-cleanup", processErrorObserved: true, stderr: "SECRET No usable sandbox!", stderrTruncated: true,
    cleanupStatus: "failed", cleanupFailure: "cleanup-process-group-survived" });
  expect(result).toMatchObject({ processCreated: true, exitObserved: true, exitCode: 1, signal: "SIGABRT", exitPhase: "before-cleanup",
    processErrorObserved: true, stderrCategory: "no-usable-sandbox", stderrCaptureTruncated: true,
    cleanupStatus: "failed", firstCleanupFailure: "cleanup-process-group-survived" });
  expect(Object.isFrozen(result)).toBe(true); expect(JSON.stringify(result)).not.toContain("SECRET"); expect(JSON.stringify(result).length).toBeLessThan(512);
  expect(launchLifecycleObservation()).toMatchObject({ processCreated: false, exitObserved: false, exitCode: null, signal: null, exitPhase: null, cleanupStatus: "not-started" });
});
for (const exitCode of [-1, 256, Infinity, NaN, 0.5, "SECRET", undefined]) test(`lifecycle diagnostic redacts malformed exit ${String(exitCode)}`, () => {
  const value = launchLifecycleObservation({ child: { exitCode, signalCode: "SECRET" }, exitPhase: "SECRET", stderr: "SECRET".repeat(10000),
    cleanupStatus: "SECRET", cleanupFailure: "SECRET" });
  expect(value).toMatchObject({ exitCode: null, signal: "other", exitPhase: null, stderrCategory: "unknown", cleanupStatus: "unavailable", firstCleanupFailure: "other" });
  expect(JSON.stringify(value)).not.toContain("SECRET"); expect(diagnosticCode(Error("owned-cdp:SECRET"))).toBe("other");
});

for (const code of [0, 1000, 1006, 65535, -1, 65536, 1.5, Infinity, NaN, "SECRET", undefined]) test(`socket close diagnostic code ${String(code)}`, () => {
  const socket = new MockSocket(), c = new FlatConnection(socket);
  socket.emit("close", { code, wasClean: true, reason: "https://SECRET.invalid/BODY_SECRET" });
  const report = c.diagnostics(); expect(report.closeCode).toBe(Number.isSafeInteger(code) && code >= 0 && code <= 65535 ? code : null);
  expect(report.closeWasClean).toBe(true); expect(report.firstFailure.reason).toBe("transport-closed");
  socket.emit("close", { code: 1234, wasClean: false }); expect(c.diagnostics()).toEqual(report);
  expect(JSON.stringify(report)).not.toContain("SECRET"); c.close();
});
test("close missing or malformed clean state remains unknown", () => {
  for (const wasClean of [undefined, null, "SECRET", 1]) {
    const socket = new MockSocket(), c = new FlatConnection(socket); socket.emit("close", { wasClean });
    expect(c.diagnostics()).toMatchObject({ closeCode: null, closeWasClean: null }); c.close();
  }
});
test("normal disposal keeps cleanup semantics when owned process later exits", () => {
  const socket = new MockSocket(), c = new FlatConnection(socket); let failures = 0; c.on("failure", () => failures++);
  c.close(); const failure = c.failure; c.fail("browser-exited"); c.fail("browser-process-error");
  socket.emit("close", { code: 1000, wasClean: true, reason: "SECRET" });
  expect(c.closed).toBe(true); expect(c.failure).toBe(failure); expect(failures).toBe(1);
  expect(c.diagnostics()).toMatchObject({ firstFailure: { reason: "transport-disposed", command: null }, closeCode: 1000, closeWasClean: true });
});
