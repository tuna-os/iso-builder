// Host-side, test-only observations of browser response bytes. These neither
// authenticate a producer nor prove execution, media qualification, or cutover.
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const DEFAULT_LIMITS = Object.freeze({
  maxResponses: 64,
  maxResponseBytes: 64 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
  timeoutMs: 30_000,
});

// Only errors created here with fixed or explicitly sanitized fields may keep
// their reason/stack. Protocol and transport exceptions are untrusted text.
const internalObservationErrors = new WeakMap();
function observationError(message) {
  const error = new Error(message);
  internalObservationErrors.set(error, Object.freeze({ message, stack: error.stack }));
  return error;
}

function loopbackURL(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.hash || url.href !== value) {
    throw observationError("a canonical HTTP literal-loopback URL is required");
  }
  return url;
}

function frontendKind(address, resourceType, contentType = "") {
  const type = resourceType.toLowerCase();
  if (["document", "script", "stylesheet"].includes(type)) return type;
  const url = new URL(address);
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (/\.wasm$/i.test(url.pathname) || mime === "application/wasm") return "wasm";
  // Include worker scripts and executable assets fetched outside <script>.
  if (/\.(?:js|mjs|cjs)$/i.test(url.pathname)) return "script";
  if (/\.css$/i.test(url.pathname)) return "stylesheet";
  return null;
}

function byteMeasurement(value) {
  return value && typeof value.sha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0;
}

// Experimental public-CDP transport for direct dedicated workers only. Page
// auto-attach supports nonflattened child messages; browser-level auto-attach
// requires flattening, which Playwright's public CDPSession cannot route here.
// Protocol: https://chromedevtools.github.io/devtools-protocol/tot/Target/
// Chromium OnWorkerMainScriptRequestWillBeSent uses the worker target token as
// its main-request ID on the creator target. Only that ID may migrate here;
// same-URL requests never substitute for a missing initial worker response.
function dedicatedWorkerTransport(raw, limits, origin) {
  const transport = new EventEmitter();
  const children = new Map();
  const targets = new Map();
  const records = new Map();
  const publicWorkers = [];
  const listeners = [];
  let closed = false;
  let failure = null;
  let ownerTargetId = null;
  // Failure-only bounded identity diagnostics. Never retain event objects,
  // URLs, headers, bodies or arbitrary protocol text in this ring.
  const recentIdentities = [];
  const tracedFailures = new WeakMap();
  const opaqueIdentity = value => value == null ? null :
    typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : "[redacted]";
  const rememberIdentity = (method, requestId, source) => {
    const identity = {
      method, requestId: opaqueIdentity(requestId), source: source ? "worker" : "page",
      sessionId: source ? opaqueIdentity(source.id) : null,
      targetId: opaqueIdentity(source ? source.targetId : ownerTargetId),
    };
    recentIdentities.push(identity);
    if (recentIdentities.length > 32) recentIdentities.shift();
  };
  transport.withIdentityTrace = (error, stage) => {
    const original = error instanceof Error ? error : new Error("external failure");
    if (tracedFailures.has(original)) return tracedFailures.get(original);
    const recent = Object.freeze(recentIdentities.map(identity => Object.freeze({ ...identity })));
    const trace = Object.freeze({ ...recent.at(-1), ownerTargetId: opaqueIdentity(ownerTargetId), recent });
    const safe = internalObservationErrors.get(original);
    const reason = safe ? safe.message : `frontend observation external error: ${stage}`;
    const traced = new Error(`${reason}; identityTrace=${JSON.stringify(trace)}`);
    if (safe && typeof safe.stack === "string") {
      traced.stack = `${traced.name}: ${traced.message}\n${safe.stack.split("\n").slice(1).join("\n")}`;
    }
    Object.defineProperty(traced, "identityTrace", { value: trace });
    tracedFailures.set(original, traced);
    tracedFailures.set(traced, traced);
    return traced;
  };
  const fail = error => {
    failure ||= error instanceof Error ? error : new Error("external failure");
    transport.emit("observationError", transport.withIdentityTrace(failure, "worker-transport"));
  };
  const key = (source, requestId) => JSON.stringify([
    source && requestId !== source.targetId ? source.id : "page", requestId,
  ]);
  const normalized = response => {
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    return JSON.stringify([response.url, response.status,
      ...["content-length", "content-type", "content-encoding", "content-range", "transfer-encoding"].map(name => headers[name] || "")]);
  };
  const childCommand = (child, method, params = {}) => {
    if (closed || child.closed) throw observationError("worker session detached");
    const id = ++child.commandId;
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Commands can fall through to a renderer that does not exist until the
    // initial script fetch is released. Await outer dispatch acknowledgement,
    // enqueue all controls, then resume; require every inner reply before finish.
    const timer = setTimeout(() => {
      child.pending.delete(id);
      rejectResult(observationError(`worker CDP command timed out: ${method}`));
    }, limits.timeoutMs);
    child.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
    result.catch(() => {});
    const sent = raw.send("Target.sendMessageToTarget", { sessionId: child.id, message: JSON.stringify({ id, method, params }) })
      .catch(error => { clearTimeout(timer); child.pending.delete(id); rejectResult(error); throw error; });
    return { sent, result };
  };
  const sendChild = async (child, method, params) => {
    const command = childCommand(child, method, params);
    await command.sent;
    return command.result;
  };
  const forward = (method, event, source = null) => {
    if (closed || failure) return;
    try {
      rememberIdentity(method, event.requestId, source);
      const requestId = key(source, event.requestId);
      const worker = source && event.requestId === source.targetId ? source : targets.get(event.requestId);
      let record = records.get(requestId);
      if (source && !source.controlsSent) {
        throw observationError(`worker network event preceded owned cache controls (${method}; request ${opaqueIdentity(event.requestId)}; session ${opaqueIdentity(source.id)}; dispatched commands ${source.commandId})`);
      }
      if (method === "Network.requestWillBeSent") {
        const candidate = !!frontendKind(event.request.url, event.type || "Other") ||
          (new URL(event.request.url).origin === origin && ["fetch", "xhr"].includes((event.type || "Other").toLowerCase()));
        if (record) {
          if (worker && source && record.startSource === null &&
              record.start.url === event.request.url && record.start.method === event.request.method && !event.redirectResponse) return;
          // OCI fetches may redirect. They remain outside executable-byte
          // observation; never let that exception hide a frontend redirect.
          if (!event.redirectResponse || record.candidate || candidate || record.complete) {
            throw observationError("duplicate or changed worker request identity");
          }
        }
        if (source && event.requestId === source.targetId) throw observationError("worker main request has no original creator request");
        record = { start: event.request, startSource: source, requestId: event.requestId, candidate, response: null, complete: false, bodyRead: false };
        records.set(requestId, record);
        if (records.size > limits.maxResponses * 2) throw observationError("too many worker transport request identities");
      } else if (method === "Network.responseReceived") {
        if (!record) {
          throw observationError("worker response has no original owned request");
        }
        if (event.response.fromDiskCache || event.response.fromPrefetchCache || event.response.fromServiceWorker) {
          // Preserve every cache signal even when the main response migrates.
          transport.emit(method, { ...event, requestId });
          return;
        }
        if (record.response) {
          if (!worker || !source || normalized(record.response) !== normalized(event.response)) {
            throw observationError("worker response metadata changed across targets");
          }
          return;
        }
        record.response = event.response;
        record.frontend = !!frontendKind(event.response.url, event.type || "Other", event.response.mimeType || "");
        record.candidate ||= record.frontend;
      } else if (method === "Network.loadingFinished") {
        if (worker && !source) return; // The worker owns its initial body buffer.
        if (record) {
          if (record.complete) throw observationError("duplicate worker transport completion");
          record.complete = true;
          record.bodySource = source;
        }
      }
      transport.emit(method, { ...event, requestId });
      if ((method === "Network.loadingFinished" || method === "Network.loadingFailed") && record && !record.frontend) records.delete(requestId);
    } catch (error) { fail(error); }
  };
  const attached = event => {
    if (closed || failure) return;
    try {
      const { sessionId, targetInfo, waitingForDebugger } = event;
      if (!sessionId || targetInfo?.type !== "worker" || !targetInfo.targetId || waitingForDebugger !== true) {
        throw observationError("dedicated worker was not attached while waiting for debugger");
      }
      if (targetInfo.parentId !== ownerTargetId) throw observationError("worker is not a direct child of the owned page target");
      if (children.has(sessionId) || targets.has(targetInfo.targetId)) throw observationError("duplicate dedicated worker target");
      if (children.size >= 4) throw observationError("too many dedicated worker targets");
      if (targetInfo.url) loopbackURL(targetInfo.url);
      const child = { id: sessionId, targetId: targetInfo.targetId, url: targetInfo.url,
        commandId: 0, pending: new Map(), closed: false, controlsSent: false, ready: false };
      const existing = records.get(key(null, child.targetId));
      if (existing?.complete) throw observationError("worker main response completed before target capture");
      children.set(sessionId, child);
      targets.set(child.targetId, child);
      rememberIdentity("Target.attachedToTarget", null, child);
      child.setup = (async () => {
        const replies = [];
        for (const [method, params] of [
          ["Network.setCacheDisabled", { cacheDisabled: true }],
          ["Network.setBypassServiceWorker", { bypass: true }],
          ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter: [{ type: "worker" }, { exclude: true }] }],
        ]) {
          const command = childCommand(child, method, params);
          replies.push(command.result);
          command.result.catch(fail);
          await command.sent;
          if (failure) throw failure;
        }
        // Each outer acknowledgement confirms dispatch to this child, not an
        // inner renderer reply. Set this boundary before Network.enable: enable
        // can emit initial-request history before its own dispatch returns.
        // The creator request remains identity-bound and every inner reply is
        // still required below; this does not claim controls predated that fetch.
        child.controlsSent = true;
        const enable = childCommand(child, "Network.enable", {
          maxTotalBufferSize: limits.maxTotalBytes, maxResourceBufferSize: limits.maxResponseBytes,
        });
        replies.push(enable.result);
        enable.result.catch(fail);
        await enable.sent;
        if (failure) throw failure;
        const resume = childCommand(child, "Runtime.runIfWaitingForDebugger");
        replies.push(resume.result);
        await resume.sent;
        await Promise.all(replies);
        child.ready = true;
      })().catch(fail);
    } catch (error) { fail(error); }
  };
  const received = ({ sessionId, message }) => {
    if (closed || failure) return;
    try {
      const child = children.get(sessionId);
      if (!child || child.closed) throw observationError("message from unowned worker session");
      const payload = JSON.parse(message);
      if (Object.hasOwn(payload, "id")) {
        const pending = child.pending.get(payload.id);
        if (!pending) throw observationError("unmatched worker command reply");
        child.pending.delete(payload.id);
        clearTimeout(pending.timer);
        if (payload.error) pending.reject(observationError("worker CDP command rejected"));
        else pending.resolve(payload.result);
      } else if (payload.method === "Target.attachedToTarget") {
        throw observationError("nested dedicated worker targets are unsupported");
      } else if (networkEvents.includes(payload.method)) {
        forward(payload.method, payload.params, child);
      }
    } catch (error) { fail(error); }
  };
  const detached = ({ sessionId }) => {
    if (closed) return;
    const child = children.get(sessionId);
    if (!child) { fail(observationError("unowned worker target detached")); return; }
    child.closed = true;
    for (const pending of child.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(observationError("worker target detached before command completed"));
    }
    child.pending.clear();
    const main = records.get(key(null, child.targetId));
    if (!child.ready || !main?.bodyRead || [...records.values()].some(record => record.startSource === child && record.frontend && !record.bodyRead)) {
      fail(observationError("worker target detached before frontend bytes were captured"));
    }
  };
  const networkEvents = ["Network.requestWillBeSent", "Network.requestServedFromCache", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"];
  for (const method of networkEvents) {
    const listener = event => forward(method, event);
    raw.on(method, listener); listeners.push([method, listener]);
  }
  for (const [method, listener] of [["Target.attachedToTarget", attached], ["Target.receivedMessageFromTarget", received], ["Target.detachedFromTarget", detached]]) {
    raw.on(method, listener); listeners.push([method, listener]);
  }
  transport.send = async (method, params) => {
    if (method !== "Network.getResponseBody") return raw.send(method, params);
    const record = records.get(params.requestId);
    if (!record?.complete) throw observationError("owned worker response body is not complete");
    const result = record.bodySource ? await sendChild(record.bodySource, method, { requestId: record.requestId }) :
      await raw.send(method, { requestId: record.requestId });
    record.bodyRead = true;
    return result;
  };
  transport.enableWorkers = async () => {
    const info = await raw.send("Target.getTargetInfo");
    if (info?.targetInfo?.type !== "page" || typeof info.targetInfo.targetId !== "string" || !info.targetInfo.targetId) {
      throw observationError("owned page target identity is unavailable");
    }
    ownerTargetId = info.targetInfo.targetId;
    await raw.send("Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: false,
      filter: [{ type: "worker" }, { exclude: true }],
    });
  };
  transport.observeWorker = worker => {
    publicWorkers.push(worker.url());
    if (publicWorkers.length > 4) fail(observationError("too many public dedicated workers"));
  };
  transport.flushWorkers = async () => {
    if (failure) throw failure;
    await Promise.all([...children.values()].map(child => child.setup));
    for (const child of children.values()) {
      if (!child.closed && !failure) await sendChild(child, "Network.setCacheDisabled", { cacheDisabled: true });
    }
    if (failure) throw failure;
  };
  transport.assertWorkers = () => {
    if (failure) throw failure;
    if (children.size !== publicWorkers.length) throw observationError("dedicated worker target coverage is incomplete");
    const mainURLs = [];
    for (const child of children.values()) {
      const main = records.get(key(null, child.targetId));
      if (!child.ready || !main?.response || !main.complete || !main.bodyRead || main.bodySource !== child || main.startSource !== null) {
        throw observationError("dedicated worker initial response bytes are missing");
      }
      if (child.url && child.url !== main.start.url) throw observationError("dedicated worker initial URL changed");
      mainURLs.push(main.start.url);
    }
    for (const url of publicWorkers.filter(Boolean)) {
      const index = mainURLs.indexOf(url);
      if (index < 0) throw observationError("public worker has no matching owned target");
      mainURLs.splice(index, 1);
    }
  };
  transport.detach = async () => {
    if (closed) return;
    closed = true;
    for (const [method, listener] of listeners) raw.off(method, listener);
    for (const child of children.values()) {
      child.closed = true;
      for (const pending of child.pending.values()) {
        clearTimeout(pending.timer); pending.reject(observationError("worker observation disposed"));
      }
      child.pending.clear();
    }
    // Detaching the owned parent session also releases its auto-attached targets.
    await raw.detach();
  };
  return transport;
}

// Shared byte state only: target census and coverage remain the caller's job.
// readBody must read the original owned request; it must never refetch by URL.
function createFrontendResponseState({ documentURL, limits: overrides = {}, readBody, onFailure = () => {}, requestIdentity = "single-session" }) {
  const document = loopbackURL(documentURL);
  if (!["single-session", "session-scoped"].includes(requestIdentity)) throw observationError("invalid frontend request identity mode");
  const SOURCE = Symbol("owned source");
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[name]) {
      throw observationError("invalid or expanded frontend observation limit");
    }
    limits[name] = value;
  }
  if (typeof readBody !== "function" || typeof onFailure !== "function") throw observationError("invalid frontend byte reader");
  const assets = new Map();
  const requests = new Map();
  const ownedResponses = new Map();
  const pendingCache = new Set();
  let failure = null;
  let reservedBytes = 0;
  let pendingReads = 0;
  let queue = Promise.resolve();
  let disposed = false;
  const fail = (error, stage = "collector") => {
    if (!failure) {
      failure = error instanceof Error ? error : new Error(String(error));
      try { onFailure(failure, stage); } catch { /* The original failure stays latched. */ }
    }
  };
  const signature = metadata => JSON.stringify([metadata.url, metadata.resourceType, metadata.sizeBytes]);
  const responseMetadata = (address, resourceType, status, headers) => {
    const url = loopbackURL(address);
    if (url.origin !== document.origin) throw observationError("frontend response origin changed");
    if (status !== 200) throw observationError("frontend responses must be successful, unredirected GET requests");
    if (headers["content-range"] || headers["transfer-encoding"] ||
        (headers["content-encoding"] && headers["content-encoding"].toLowerCase() !== "identity")) {
      throw observationError("encoded, ranged, or unbounded frontend response");
    }
    const lengthText = headers["content-length"];
    if (typeof lengthText !== "string" || !/^[1-9][0-9]*$/.test(lengthText)) {
      throw observationError("frontend response needs an explicit positive Content-Length");
    }
    const sizeBytes = Number(lengthText);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > limits.maxResponseBytes) {
      throw observationError("frontend response exceeds byte limit");
    }
    return { url: url.href, resourceType, sizeBytes };
  };
  const cdpRequest = ({ requestId, request, type = "Other", redirectResponse, [SOURCE]: source }) => {
    if (failure || disposed) return;
    try {
      const frontend = !!frontendKind(request.url, type);
      // An extensionless same-origin fetch can become executable only once its
      // MIME arrives. Keep its identity and reject an unresolved snapshot.
      const candidate = frontend || (new URL(request.url).origin === document.origin &&
        ["fetch", "xhr"].includes(type.toLowerCase()));
      if (redirectResponse && (candidate || requests.get(requestId)?.candidate)) {
        throw observationError("redirected frontend request");
      }
      if (requestIdentity === "session-scoped" && requests.has(requestId)) {
        throw observationError("reused active frontend request identity");
      }
      if (ownedResponses.has(requestId)) throw observationError("reused frontend request identity");
      requests.set(requestId, { url: request.url, method: request.method, frontend, candidate, redirected: !!redirectResponse, source });
      if (requests.size > limits.maxResponses) throw observationError("too many pending request identities");
    } catch (error) { fail(error); }
  };
  const cacheUsed = ({ requestId }) => {
    if (failure || disposed) return;
    if (requests.get(requestId)?.frontend || ownedResponses.has(requestId)) {
      fail(observationError("browser cache use makes frontend observation ambiguous"));
    } else {
      pendingCache.add(requestId);
      if (pendingCache.size > limits.maxResponses) fail(observationError("too many unclassified cache signals"));
    }
  };
  const cdpResponse = ({ requestId, response, type = "Other" }) => {
    if (failure || disposed) return;
    try {
      const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
      const resourceType = frontendKind(response.url, type, response.mimeType || headers["content-type"] || "");
      if (!resourceType) {
        if (requests.get(requestId)?.frontend) throw observationError("frontend request classification disappeared");
        requests.delete(requestId);
        pendingCache.delete(requestId);
        return;
      }
      if (pendingCache.has(requestId) || response.fromDiskCache || response.fromPrefetchCache || response.fromServiceWorker) {
        throw observationError("cached or service-worker response makes frontend observation ambiguous");
      }
      const request = requests.get(requestId);
      if (!request || request.url !== response.url) throw observationError("frontend response has no matching owned CDP request");
      if (request.method !== "GET" || request.redirected) throw observationError("frontend responses must be successful, unredirected GET requests");
      if (ownedResponses.has(requestId)) throw observationError("duplicate owned CDP response identity");
      const metadata = responseMetadata(response.url, resourceType, response.status, headers);
      if (ownedResponses.size >= limits.maxResponses) throw observationError("too many frontend responses");
      reservedBytes += metadata.sizeBytes;
      if (reservedBytes > limits.maxTotalBytes) throw observationError("frontend responses exceed total byte limit");
      request.frontend = request.candidate = true;
      ownedResponses.set(requestId, { ...metadata, complete: false, source: request.source });
      pendingCache.delete(requestId);
    } catch (error) { fail(error); }
  };
  const cdpComplete = ({ requestId }) => {
    if (failure || disposed) return;
    try {
      const record = ownedResponses.get(requestId);
      if (requests.get(requestId)?.candidate && !record) {
        throw observationError("frontend request completed without an owned response");
      }
      requests.delete(requestId);
      pendingCache.delete(requestId);
      if (!record) return;
      if (record.complete) throw observationError("duplicate frontend completion");
      record.complete = true;
      // Read the exact request ID on the same session whose cache state was
      // checked. Playwright Response.body() can silently refetch a missing body;
      // it must never be used here. Unavailable/evicted bodies fail closed.
      pendingReads++;
      queue = queue.then(async () => {
        if (failure || disposed) return;
        const result = await readBody(requestId, record.sizeBytes, record.source);
        if (disposed) return;
        if (!result || typeof result.body !== "string" || typeof result.base64Encoded !== "boolean") {
          throw observationError("owned frontend response body is unavailable");
        }
        const body = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
        if (body.length !== record.sizeBytes || body.length > limits.maxResponseBytes) {
          throw observationError("frontend response body and declared size differ");
        }
        const sha256 = `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
        const previous = assets.get(record.url);
        if (previous && (previous.sha256 !== sha256 || previous.sizeBytes !== record.sizeBytes ||
            previous.resourceType !== record.resourceType)) {
          throw observationError("duplicate frontend URL returned different bytes or resource types");
        }
        assets.set(record.url, {
          url: record.url, resourceType: record.resourceType, sha256, sizeBytes: record.sizeBytes,
          responseCount: (previous?.responseCount || 0) + 1,
        });
      }).catch(error => fail(error, "body-read")).finally(() => { pendingReads--; });
    } catch (error) { fail(error); }
  };
  const cdpFailed = ({ requestId }) => {
    if (requests.get(requestId)?.candidate || ownedResponses.has(requestId)) fail(observationError("frontend request failed"));
    requests.delete(requestId);
    pendingCache.delete(requestId);
  };
  const handlers = Object.freeze({
    "Network.requestWillBeSent": cdpRequest, "Network.requestServedFromCache": cacheUsed,
    "Network.responseReceived": cdpResponse, "Network.loadingFinished": cdpComplete,
    "Network.loadingFailed": cdpFailed,
  });
  return Object.freeze({
    accept(method, event, sessionId) {
      if (!Object.hasOwn(handlers, method)) throw observationError("unsupported frontend byte event");
      if (requestIdentity === "session-scoped") {
        if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256 ||
            typeof event?.requestId !== "string" || !event.requestId || event.requestId.length > 256) {
          fail(observationError("missing owned frontend session/request identity")); return;
        }
        const source = Object.freeze({ sessionId, requestId: event.requestId });
        event = { ...event, requestId: JSON.stringify([sessionId, event.requestId]), [SOURCE]: source };
      } else if (sessionId !== undefined) {
        fail(observationError("unexpected frontend source session")); return;
      }
      handlers[method](event);
    },
    responseMetadata,
    signature,
    drain: () => queue,
    snapshot() {
      if (disposed) throw observationError("frontend observation already disposed");
      if (failure) throw failure;
      if (pendingReads) throw observationError("frontend response bytes are still pending");
      if (pendingCache.size) throw observationError("unclassified cache signals remain at frontend snapshot");
      if ([...requests.values()].some(request => request.candidate)) throw observationError("outstanding frontend request at snapshot");
      return { signatures: [...ownedResponses.values()].map(signature).sort(),
        assets: [...assets.values()].map(asset => ({ ...asset })).sort((a, b) => a.url.localeCompare(b.url)) };
    },
    abort(error = observationError("frontend observation aborted")) { fail(error); },
    dispose() { disposed = true; },
  });
}

// Page-target-only by default. Worker coverage is an explicit experimental
// option until the real Chromium fixture passes in CI. Its output is ineligible
// for the page-only served-tree binder. Same-URL page fetches never cover workers.
// Cache/SW controls are not undone; dispose this dedicated page/context afterward.
async function observeFrontendResponses(page, { documentURL, experimentalDedicatedWorkers = false, ...overrides }) {
  if (typeof experimentalDedicatedWorkers !== "boolean") throw observationError("invalid worker observation mode");
  const document = loopbackURL(documentURL);
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[name]) {
      throw observationError("invalid or expanded frontend observation limit");
    }
    limits[name] = value;
  }
  if (page.url() !== "about:blank") throw observationError("frontend observation must start before navigation");

  const rawSession = await page.context().newCDPSession(page);
  const session = experimentalDedicatedWorkers ? dedicatedWorkerTransport(rawSession, limits, document.origin) : rawSession;
  const publicResponses = [];
  let failure = null;
  let documentCount = 0;
  let finished = null;
  let disposed = false;
  const diagnosticFailure = (error, stage = "collector") => experimentalDedicatedWorkers ? session.withIdentityTrace(error, stage) : error;
  let core;
  const fail = (error, stage = "collector") => {
    failure ||= diagnosticFailure(error instanceof Error ? error : new Error(String(error)), stage);
    core?.abort(failure);
  };
  core = createFrontendResponseState({ documentURL, limits, onFailure: fail,
    readBody: requestId => session.send("Network.getResponseBody", { requestId }) });
  const { responseMetadata, signature } = core;
  const cdpRequest = event => core.accept("Network.requestWillBeSent", event);
  const cacheUsed = event => core.accept("Network.requestServedFromCache", event);
  const cdpResponse = event => core.accept("Network.responseReceived", event);
  const cdpComplete = event => core.accept("Network.loadingFinished", event);
  const cdpFailed = event => core.accept("Network.loadingFailed", event);
  const workerCreated = worker => experimentalDedicatedWorkers ? session.observeWorker(worker) :
    fail(observationError("worker target is not covered by the owned page CDP session"));
  const failedRequest = request => {
    try {
      if (frontendKind(request.url(), request.resourceType())) fail(observationError("frontend request failed"));
    } catch (error) { fail(error); }
  };
  const observe = response => {
    if (failure || disposed) return;
    try {
      const resourceType = frontendKind(response.url(), response.request().resourceType(), response.headers()["content-type"] || "");
      if (!resourceType) return;
      if (publicResponses.length >= limits.maxResponses) throw observationError("too many frontend responses");
      const request = response.request();
      const metadata = responseMetadata(response.url(), resourceType, response.status(), response.headers());
      if (request.url() !== metadata.url) throw observationError("frontend request URL changed");
      if (request.method() !== "GET" || request.redirectedFrom() || request.redirectedTo()) {
        throw observationError("frontend responses must be successful, unredirected GET requests");
      }
      if (response.fromServiceWorker()) throw observationError("service-worker frontend response");
      if (resourceType === "document") {
        if (++documentCount !== 1 || metadata.url !== documentURL ||
            !request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
          throw observationError("exactly one expected main-document response is required");
        }
      }
      // Compare one-to-one at finish, after cross-session event delivery drains.
      // No URL can reuse one owned response to cover an extra worker response.
      publicResponses.push(signature(metadata));
    } catch (error) { fail(error); }
  };

  const detach = async () => {
    if (disposed) return;
    disposed = true; core.dispose();
    page.off("response", observe);
    page.off("requestfailed", failedRequest);
    page.off("worker", workerCreated);
    session.off("observationError", fail);
    session.off("Network.requestWillBeSent", cdpRequest);
    session.off("Network.requestServedFromCache", cacheUsed);
    session.off("Network.responseReceived", cdpResponse);
    session.off("Network.loadingFinished", cdpComplete);
    session.off("Network.loadingFailed", cdpFailed);
    await session.detach();
  };
  try {
    session.on("observationError", fail);
    session.on("Network.requestWillBeSent", cdpRequest);
    session.on("Network.requestServedFromCache", cacheUsed);
    session.on("Network.responseReceived", cdpResponse);
    session.on("Network.loadingFinished", cdpComplete);
    session.on("Network.loadingFailed", cdpFailed);
    await session.send("Network.enable", {
      maxTotalBufferSize: limits.maxTotalBytes,
      maxResourceBufferSize: limits.maxResponseBytes,
    });
    await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    await session.send("Network.setBypassServiceWorker", { bypass: true });
    page.on("response", observe);
    page.on("requestfailed", failedRequest);
    page.on("worker", workerCreated);
    if (experimentalDedicatedWorkers) await session.enableWorkers();
  } catch (error) {
    const reported = diagnosticFailure(error, "setup");
    await detach().catch(() => {});
    throw reported;
  }

  return {
    // Call after the load/build. Requests begun inside this observation window
    // must have finished; this makes no promise about requests begun afterward.
    finish() {
      if (finished) return finished;
      if (disposed) return Promise.reject(diagnosticFailure(observationError("frontend observation already disposed")));
      finished = (async () => {
        let timer;
        try {
          const drain = async () => {
            let previous;
            do {
              previous = core.drain();
              await previous;
              await session.send("Network.setCacheDisabled", { cacheDisabled: true })
                .catch(error => { throw diagnosticFailure(error, "drain"); });
              if (experimentalDedicatedWorkers) await session.flushWorkers();
            } while (previous !== core.drain() && !failure);
          };
          await Promise.race([
            drain(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(observationError("frontend observation timed out")), limits.timeoutMs);
            }),
          ]);
          if (failure) throw failure;
          if (experimentalDedicatedWorkers) session.assertWorkers();
          const snapshot = core.snapshot();
          const owned = snapshot.signatures;
          const observed = [...publicResponses].sort();
          if (owned.length !== observed.length || owned.some((value, index) => value !== observed[index])) {
            throw observationError("frontend response has no one-to-one owned CDP identity");
          }
          if (documentCount !== 1 || !snapshot.assets.some(asset => asset.url === documentURL)) throw observationError("one complete main-document response is required");
          return {
            schemaVersion: 1, kind: "diagnostic-loaded-frontend", qualification: "not-assessed",
            authentication: "not-verified", coverage: experimentalDedicatedWorkers ? "page-and-direct-dedicated-workers-experimental" : "page-target-only", origin: document.origin, documentURL,
            assets: snapshot.assets,
          };
        } finally {
          clearTimeout(timer);
          await detach();
        }
      })().catch(error => { throw diagnosticFailure(error, "finish"); });
      return finished;
    },
    dispose: () => detach().catch(error => { throw diagnosticFailure(error, "dispose"); }),
  };
}

// Expected bytes must come from the separately checked served tree, never from
// these responses. Exact-set comparison rejects missing and unexpected assets.
// A match is byte correspondence only, not an authenticated frontend identity.
function compareFrontendAssets(observation, expectedAssets) {
  if (!observation || observation.schemaVersion !== 1 ||
      observation.kind !== "diagnostic-loaded-frontend" || observation.qualification !== "not-assessed" ||
      observation.authentication !== "not-verified" || observation.coverage !== "page-target-only" ||
      !Array.isArray(observation.assets) || !observation.assets.length ||
      observation.assets.length > DEFAULT_LIMITS.maxResponses) {
    throw new Error("invalid diagnostic frontend observation");
  }
  const document = loopbackURL(observation.documentURL);
  if (observation.origin !== document.origin || !expectedAssets || typeof expectedAssets !== "object" ||
      Array.isArray(expectedAssets)) throw new Error("invalid expected frontend assets");
  const expected = new Map(Object.entries(expectedAssets));
  if (expected.size !== observation.assets.length) throw new Error("frontend asset set mismatch");
  const seen = new Set();
  let documents = 0;
  let responses = 0;
  let bytes = 0;
  for (const asset of observation.assets) {
    const url = loopbackURL(asset.url);
    if (url.origin !== document.origin || seen.has(asset.url) ||
        !["document", "script", "stylesheet", "wasm"].includes(asset.resourceType) ||
        !byteMeasurement(asset) || asset.sizeBytes > DEFAULT_LIMITS.maxResponseBytes ||
        !Number.isSafeInteger(asset.responseCount) || asset.responseCount <= 0) {
      throw new Error("invalid or duplicate frontend asset");
    }
    seen.add(asset.url);
    responses += asset.responseCount;
    bytes += asset.sizeBytes * asset.responseCount;
    if (responses > DEFAULT_LIMITS.maxResponses || bytes > DEFAULT_LIMITS.maxTotalBytes) {
      throw new Error("frontend observation exceeds bounds");
    }
    if (asset.resourceType === "document") {
      documents++;
      if (asset.url !== observation.documentURL || asset.responseCount !== 1) {
        throw new Error("invalid main-document observation");
      }
    }
    const wanted = expected.get(asset.url);
    if (!byteMeasurement(wanted) || wanted.sha256 !== asset.sha256 || wanted.sizeBytes !== asset.sizeBytes) {
      throw new Error("loaded frontend bytes differ from expected served asset");
    }
  }
  if (documents !== 1) throw new Error("one main-document observation is required");
  return {
    kind: "diagnostic-frontend-byte-match", qualification: "not-assessed",
    authentication: "not-verified", matchedAssets: seen.size,
  };
}

module.exports = { observeFrontendResponses, compareFrontendAssets, createFrontendResponseState, frontendKind };
