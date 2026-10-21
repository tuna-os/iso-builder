// Local integration slice, not a complete observer or receipt admission policy.
// The caller must own the connection/page and enforce its independent target and
// frame census, final transport/process teardown, and expected served-tree match.
// This state never claims complete coverage. It keeps the creator request as the
// logical identity while explicitly binding its body to the actual worker source.
const crypto = require("node:crypto");
const { createFrontendResponseState, frontendKind } = require("./frontend-measurements");
const { BodyReservations } = require("./owned-flat-body-reservations");
const { deadline } = require("./owned-flat-cdp");
const bad = code => new Error(`owned-frontend:${code}`);
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const key = (session, request) => JSON.stringify([session, request]);
const digest = result => `sha256:${crypto.createHash("sha256").update(Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8")).digest("hex")}`;
const NETWORK_EVENTS = new Set(["Network.requestWillBeSent", "Network.requestServedFromCache", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]);
const CACHE_FLAGS = Object.freeze(["fromDiskCache", "fromPrefetchCache", "fromServiceWorker"]);
function canonicalURL(value, origin) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.hash ||
      url.href !== value || (origin && url.origin !== origin)) throw bad("url-invalid");
  return url;
}
function fetchHeaders(list) {
  if (!Array.isArray(list) || list.length > 32) throw bad("fetch-headers-invalid");
  const headers = {};
  for (const item of list) {
    if (typeof item?.name !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(item.name) ||
        typeof item.value !== "string" || item.value.length > 4096 || /[\r\n]/.test(item.value)) throw bad("fetch-headers-invalid");
    const name = item.name.toLowerCase();
    if (Object.hasOwn(headers, name)) throw bad("fetch-headers-invalid");
    headers[name] = item.value;
  }
  return headers;
}
function createOwnedFrontendState({ connection, pageSessionId, pageTargetId, documentURL, workerURLs,
    limits = {}, timeoutMs = 3000, firstResumeDelayMs = 0, onFailure = () => {} }) {
  if (!(connection?.bodyReservations instanceof BodyReservations) || typeof connection.readBody !== "function" ||
      typeof connection.send !== "function" || !id(pageSessionId) || !id(pageTargetId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isSafeInteger(firstResumeDelayMs) || firstResumeDelayMs < 0 || firstResumeDelayMs > 1000 || typeof onFailure !== "function") throw bad("configuration-invalid");
  const origin = canonicalURL(documentURL).origin;
  if (!Array.isArray(workerURLs) || workerURLs.length > 4 || new Set(workerURLs).size !== workerURLs.length) throw bad("worker-policy-invalid");
  const expectedWorkers = new Set(workerURLs.map(value => {
    if (!/\.js$/.test(canonicalURL(value, origin).pathname)) throw bad("worker-policy-invalid"); return value;
  }));
  const reservations = connection.bodyReservations, records = new Map(), aliases = new Map(), workers = new Map(), targets = new Map();
  const tasks = new Set(); let failure, disposed = false, stopping = false, serial = 0, pendingBootstrap = null, core;
  const fail = code => {
    if (!failure) {
      failure = bad(code); reservations.abort(); core?.abort(failure);
      try { onFailure(failure); } catch { /* The original fixed reason stays latched. */ }
    }
    return failure;
  };
  const check = () => { if (failure) throw failure; if (disposed) throw bad("disposed"); if (connection.failure) throw fail("transport-failed"); if (reservations.snapshot().failed) throw fail("body-reservation-failed"); };
  const task = promise => {
    tasks.add(promise); promise.catch(() => fail("protocol-operation-failed")).finally(() => tasks.delete(promise));
    return promise;
  };
  const send = (method, params, session) => {
    check(); return connection.send(method, params, session);
  };
  const reserve = (record, metadata) => {
    if (record.metadata && core.signature(record.metadata) !== core.signature(metadata)) throw bad("bootstrap-metadata-changed");
    if (!record.token) {
      record.token = reservations.reserve(`response-${++serial}`, metadata.sizeBytes);
      record.metadata = metadata;
    }
  };
  const actualRecord = (session, request) => records.get(aliases.get(key(session, request)) || key(session, request));
  core = createFrontendResponseState({ documentURL, limits, requestIdentity: "session-scoped", onFailure: () => fail("byte-state-failed"),
    readBody: async (_logical, size, source) => {
      check(); const record = records.get(key(source.sessionId, source.requestId));
      if (!record?.token || !record.completed || record.metadata.sizeBytes !== size || record.bodyRead) throw bad("body-source-invalid");
      const result = await connection.readBody(record.token, "network"); check();
      const hash = digest(result);
      if (record.bootstrap && (!record.creatorHash || record.creatorHash !== hash)) throw bad("bootstrap-body-mismatch");
      record.bodyRead = true; record.sha256 = hash; return result;
    },
  });
  // Migration is one-use and originates only from an actual direct-child attach.
  // No synthetic worker request is emitted and no same-URL fallback is allowed.
  const migrateBootstrap = (session, event) => {
    const info = event.targetInfo, record = records.get(key(pageSessionId, info?.targetId));
    if (session !== pageSessionId || stopping || !id(event.sessionId) || workers.has(event.sessionId) || targets.has(info?.targetId) ||
        event.sessionId === pageSessionId || event.waitingForDebugger !== true || info?.type !== "worker" ||
        info.parentId !== pageTargetId || !record || !expectedWorkers.has(record.url) || record.worker || record.completed || record.method !== "GET" ||
        (info.url && info.url !== record.url) || workers.size >= expectedWorkers.size ||
        [...workers.values()].some(worker => worker.record.url === record.url)) throw bad("worker-owner-mismatch");
    const alias = key(event.sessionId, info.targetId);
    if (records.has(alias) || aliases.has(alias)) throw bad("migration-replayed");
    const worker = { session: event.sessionId, target: info.targetId, record, scripts: new Map(), paused: false,
      resumeSent: false, resumeAcknowledged: false, setupAcknowledged: false, workerRequestSeen: false };
    workers.set(worker.session, worker); targets.set(worker.target, worker); aliases.set(alias, key(pageSessionId, info.targetId));
    record.bootstrap = true; record.worker = worker;
    if (record.continued && pendingBootstrap === record) pendingBootstrap = null;
    const setup = [
      send("Network.enable", { maxTotalBufferSize: reservations.limits.maxTotalBytes, maxResourceBufferSize: reservations.limits.maxResponseBytes }, worker.session),
      send("Network.setCacheDisabled", { cacheDisabled: true }, worker.session),
      send("Network.setBypassServiceWorker", { bypass: true }, worker.session),
      send("Debugger.enable", {}, worker.session),
      send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }, { exclude: true }] }, worker.session),
    ];
    const install = send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, worker.session);
    setup.push(install); worker.setup = Promise.all(setup); worker.setup.catch(() => fail("worker-setup-failed"));
    install.then(value => { worker.breakpoint = value.breakpointId; }, () => {});
    task((async () => {
      // Commands must be queued before this fetch-throttle release. Actual ACKs
      // and source equality are required at the second execution pause below.
      if (firstResumeDelayMs) await new Promise(resolve => setTimeout(resolve, firstResumeDelayMs));
      check(); if (stopping) throw bad("late-worker-setup");
      await send("Runtime.runIfWaitingForDebugger", {}, worker.session);
    })());
  };
  const paused = (worker, event) => {
    const script = event.data?.scriptId;
    if (worker.paused || event.reason !== "instrumentation" || !id(script) || event.callFrames?.[0]?.location?.scriptId !== script ||
        !Array.isArray(event.hitBreakpoints) || event.hitBreakpoints.length || worker.scripts.size !== 1 ||
        worker.scripts.get(script) !== worker.record.url) throw bad("execution-pause-invalid");
    worker.paused = true;
    task((async () => {
      await worker.setup; check(); worker.setupAcknowledged = true;
      const record = worker.record;
      if (!record.creatorTask) throw bad("creator-body-missing");
      await record.creatorTask; check();
      reservations.bind(record.token, "source", worker.session, script);
      const source = await connection.readBody(record.token, "source"); check();
      if (digest({ body: source.scriptSource, base64Encoded: false }) !== record.creatorHash) throw bad("execution-source-mismatch");
      if (!id(worker.breakpoint)) throw bad("breakpoint-missing");
      worker.sourceMatches = true;
      await send("Debugger.removeBreakpoint", { breakpointId: worker.breakpoint }, worker.session); check();
      if (stopping) throw bad("late-execution-release");
      worker.resumeSent = true;
      await send("Debugger.resume", {}, worker.session); check(); worker.resumeAcknowledged = true;
    })());
  };
  const accept = ({ method, params: event, sessionId: session }) => {
    if (failure || disposed) return;
    try {
      if (stopping) throw bad("event-after-snapshot-start");
      if (!event || typeof event !== "object") throw bad("event-invalid");
      if (["Target.detachedFromTarget", "Target.targetCrashed", "Inspector.detached"].includes(method)) throw bad("target-lifecycle-lost");
      if (method === "Target.attachedToTarget") { migrateBootstrap(session, event); return; }
      const worker = workers.get(session);
      if (method.startsWith("Network.") || method === "Fetch.requestPaused" || method.startsWith("Debugger.")) {
        if (session !== pageSessionId && !worker) throw bad("unowned-event-source");
      }
      if (method === "Debugger.scriptParsed" && worker) {
        if (!id(event.scriptId) || worker.scripts.has(event.scriptId) || worker.scripts.size >= 64) throw bad("script-identity-invalid");
        if (!worker.resumeSent && (worker.scripts.size || event.url !== worker.record.url)) throw bad("early-script");
        worker.scripts.set(event.scriptId, event.url); return;
      }
      if (method === "Debugger.paused" && worker) { paused(worker, event); return; }
      if ((method === "Debugger.resumed" || method === "Runtime.consoleAPICalled") && worker && !worker.resumeSent) throw bad("early-execution");
      if (method === "Fetch.requestPaused") {
        const record = records.get(key(pageSessionId, event.networkId));
        if (session !== pageSessionId || !record || !expectedWorkers.has(record.url) || record.creatorTask || !id(event.requestId) ||
            (pendingBootstrap && pendingBootstrap !== record) || event.request?.url !== record.url || event.request.method !== "GET" ||
            record.method !== "GET" || event.responseStatusCode !== 200 || event.responseErrorReason || event.redirectedRequestId || record.completed) throw bad("fetch-owner-mismatch");
        const metadata = core.responseMetadata(record.url, "script", event.responseStatusCode, fetchHeaders(event.responseHeaders));
        reserve(record, metadata); record.bootstrap = true; pendingBootstrap = record;
        reservations.bind(record.token, "creator", session, event.requestId);
        record.creatorTask = task((async () => {
          const body = await connection.readBody(record.token, "creator"); check(); record.creatorHash = digest(body);
          await send("Fetch.continueRequest", { requestId: event.requestId }, session); check(); record.continued = true;
          if (record.worker) pendingBootstrap = null;
        })()); return;
      }
      if (!NETWORK_EVENTS.has(method)) return;
      if (!id(event.requestId)) throw bad("request-identity-invalid");
      let record = actualRecord(session, event.requestId);
      if (method === "Network.requestWillBeSent") {
        if (worker && event.requestId === worker.target) {
          if (worker.workerRequestSeen || !record?.bootstrap || event.request?.url !== record.url || event.request.method !== "GET" || event.redirectResponse) throw bad("bootstrap-request-replayed");
          worker.workerRequestSeen = true; return;
        }
        if (record || event.redirectResponse || !event.request || !id(session)) throw bad("request-replayed-or-redirected");
        if (worker && !worker.resumeSent) throw bad("early-request");
        // Retain bounded transient non-frontend requests until MIME classification.
        // Their bytes are not charged to the 64 captured-frontend reservations.
        if (records.size >= reservations.limits.maxResponses + 128 ||
            [...records.values()].filter(value => !value.token && !value.completed).length >= 128) throw bad("request-count-bound");
        record = { session, request: event.requestId, url: event.request.url, type: event.type || "Other", method: event.request.method,
          completed: false, response: false, bodyRead: false, bootstrap: expectedWorkers.has(event.request.url) };
        if (typeof record.url !== "string" || record.url.length > 8192 || !["http:", "https:"].includes(new URL(record.url).protocol)) throw bad("request-url-invalid");
        records.set(key(session, event.requestId), record);
      }
      if (!record) throw bad("request-missing");
      if (record.bootstrap && session !== record.worker?.session) {
        // The creator owns only the initial request/Fetch body; later response
        // and completion must come from the exact migrated worker session.
        if (method !== "Network.requestWillBeSent" && method !== "Network.requestServedFromCache") throw bad("bootstrap-source-invalid");
      }
      if (method === "Network.responseReceived") {
        if (record.response || event.response?.url !== record.url) throw bad("response-identity-invalid");
        const headers = Object.fromEntries(Object.entries(event.response.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
        const kind = frontendKind(event.response.url, event.type || "Other", event.response.mimeType || headers["content-type"] || "");
        if (kind) {
          if (CACHE_FLAGS.some(name => event.response[name] !== false)) throw bad("cache-provenance-unavailable-or-used");
          reserve(record, core.responseMetadata(record.url, kind, event.response.status, headers));
          reservations.bind(record.token, "network", session, event.requestId);
        }
        record.response = true;
      }
      if (method === "Network.loadingFinished") {
        if (record.completed || !record.response) throw bad("completion-invalid");
        record.completed = true;
      }
      if (method === "Network.loadingFailed") throw bad("network-failed");
      // The original creator key stays stable. Its reader above resolves the
      // separate verified actual-body binding, never a URL or caller Boolean.
      core.accept(method, event, record.session);
      if (method === "Network.loadingFinished" && !record.token) records.delete(key(record.session, record.request));
    } catch (error) { fail(/^owned-frontend:[a-z-]+$/.test(error?.message || "") ? error.message.slice(15) : "event-invalid"); }
  };
  return Object.freeze({
    accept,
    async drainSnapshot() {
      check();
      await deadline((async () => {
        for (;;) {
          const current = core.drain(), running = [...tasks];
          await Promise.all(running); await current; check();
          if (!tasks.size && current === core.drain()) break;
        }
      })(), timeoutMs, "frontend-drain-timeout").catch(() => { throw fail("drain-failed"); });
      check(); stopping = true;
      if (workers.size !== expectedWorkers.size || pendingBootstrap || [...workers.values()].some(worker =>
        !worker.paused || !worker.sourceMatches || !worker.setupAcknowledged || !worker.resumeAcknowledged ||
        !worker.record.continued || !worker.record.bodyRead) || [...records.values()].some(record => !record.completed)) throw fail("incomplete-lifecycle");
      const bytes = core.snapshot();
      return Object.freeze({ assets: Object.freeze(bytes.assets.map(Object.freeze)), signatures: Object.freeze(bytes.signatures),
        workers: workers.size, completeCoverage: false, collectorProofEstablished: false });
    },
    async verifyPageScripts(scripts) {
      check();
      try {
        if (!Array.isArray(scripts) || scripts.length > 64 || new Set(scripts.map(script => script.id)).size !== scripts.length ||
            new Set(scripts.map(script => script.url)).size !== scripts.length) throw bad("page-script-census-invalid");
        const external = [...records.values()].filter(record => record.session === pageSessionId && !record.bootstrap && record.metadata?.resourceType === "script");
        if (external.length !== scripts.length) throw bad("page-script-census-invalid");
        for (const script of scripts) {
          const matches = external.filter(record => record.url === script.url);
          if (!id(script.id) || matches.length !== 1 || !matches[0].bodyRead) throw bad("page-script-census-invalid");
          const record = matches[0]; reservations.bind(record.token, "source", pageSessionId, script.id);
          const source = await connection.readBody(record.token, "source"); check();
          if (digest({ body: source.scriptSource, base64Encoded: false }) !== record.sha256) throw bad("page-script-source-mismatch");
        }
      } catch { throw fail("page-script-verification-failed"); }
    },
    assertNoFailure() { if (failure) throw failure; },
    abort() { fail("aborted"); },
    dispose() { disposed = true; core.dispose(); reservations.abort(); },
  });
}
module.exports = { createOwnedFrontendState, CACHE_FLAGS, fetchHeaders };
