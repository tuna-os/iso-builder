// Falsification: wrong/missing/replayed worker ownership, cached or unknown
// provenance, missing bodies/imports, early execution, source substitution and
// detach must reject. Mocks exercise state/byte guards, never establish coverage.
const { test, expect } = require("@playwright/test");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const { FlatConnection } = require("./owned-flat-cdp");
const { BodyReservations } = require("./owned-flat-body-reservations");
const { createOwnedFrontendState, CACHE_FLAGS } = require("./owned-flat-frontend-state");
const ORIGIN = "http://127.0.0.1:1234";
const BODIES = { bootstrap: Buffer.from('importScripts("/import.js");'), import: Buffer.from("self.example = 1;"), wasm: Buffer.from([0,97,115,109,1,0,0,0]) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sha = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
class Socket extends EventEmitter {
  constructor() { super(); this.calls = []; this.overrides = {}; this.held = new Set(); this.queued = []; }
  addEventListener(name, fn) { this.on(name, fn); }
  close() {}
  send(text) {
    const packet = JSON.parse(text); this.calls.push(packet);
    const respond = () => {
      let result = {};
      if (packet.method === "Debugger.setInstrumentationBreakpoint") result = { breakpointId: "breakpoint" };
      if (packet.method === "Debugger.getScriptSource") result = { scriptSource: BODIES.bootstrap.toString() };
      if (["Fetch.getResponseBody", "Network.getResponseBody"].includes(packet.method)) {
        const name = packet.params.requestId === "original" || packet.params.requestId === "creator-fetch" ? "bootstrap" : packet.params.requestId;
        result = { body: BODIES[name]?.toString("base64"), base64Encoded: true };
      }
      if (Object.hasOwn(this.overrides, packet.method)) result = this.overrides[packet.method](packet, result);
      this.emit("message", { data: JSON.stringify({ id: packet.id, sessionId: packet.sessionId, result }) });
    };
    if (this.held.has(packet.method)) this.queued.push(respond); else queueMicrotask(respond);
  }
  release() { this.held.clear(); for (const respond of this.queued.splice(0)) respond(); }
}
function fixture(options = {}) {
  const socket = new Socket(), reservations = new BodyReservations(), connection = new FlatConnection(socket, { commandMs: 100, bodyReservations: reservations });
  const state = createOwnedFrontendState({ connection, documentURL: ORIGIN + "/", pageSessionId: "page", pageTargetId: "page-target",
    workerURLs: [ORIGIN + "/bootstrap.js"], timeoutMs: 300, ...options });
  const emit = (method, params, sessionId = "page") => state.accept({ method, params, sessionId });
  const request = (requestId, url = "/bootstrap.js", session = "page", extra = {}) => emit("Network.requestWillBeSent",
    { requestId, type: "Script", request: { url: ORIGIN + url, method: "GET" }, ...extra }, session);
  const attach = (extra = {}, session = "page") => emit("Target.attachedToTarget", { sessionId: "worker", waitingForDebugger: true,
    targetInfo: { type: "worker", targetId: "original", parentId: "page-target", url: ORIGIN + "/bootstrap.js" }, ...extra }, session);
  const fetch = (extra = {}, session = "page") => emit("Fetch.requestPaused", { requestId: "creator-fetch", networkId: "original",
    request: { url: ORIGIN + "/bootstrap.js", method: "GET" }, responseStatusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: String(BODIES.bootstrap.length) }], ...extra }, session);
  const response = (requestId = "original", name = "bootstrap", session = "worker", extra = {}) => emit("Network.responseReceived",
    { requestId, type: name === "wasm" ? "Fetch" : "Script", response: { url: ORIGIN + `/${name}.${name === "wasm" ? "wasm" : "js"}`,
      status: 200, fromDiskCache: false, fromPrefetchCache: false, fromServiceWorker: false,
      headers: { "Content-Length": String(BODIES[name].length) }, ...extra } }, session);
  const complete = (requestId = "original", session = "worker") => emit("Network.loadingFinished", { requestId }, session);
  const pause = (extra = {}) => {
    emit("Debugger.scriptParsed", { scriptId: "bootstrap-script", url: ORIGIN + "/bootstrap.js" }, "worker");
    emit("Debugger.paused", { reason: "instrumentation", data: { scriptId: "bootstrap-script" },
      callFrames: [{ location: { scriptId: "bootstrap-script" } }], hitBreakpoints: [], ...extra }, "worker");
  };
  return { socket, connection, reservations, state, emit, request, attach, fetch, response, complete, pause,
    close() { state.dispose(); connection.close(); } };
}
async function bootstrap(f, fetchFirst = true) {
  f.request("original");
  if (fetchFirst) { f.fetch(); await tick(); f.attach(); } else { f.attach(); f.fetch(); }
  await tick(); f.response(); f.complete(); f.pause(); await tick(); await tick();
}
async function asset(f, name) {
  f.request(name, `/${name}.${name === "wasm" ? "wasm" : "js"}`, "worker", { type: name === "wasm" ? "Fetch" : "Script" });
  f.response(name, name); f.complete(name); await tick();
}
for (const fetchFirst of [true, false]) test(`creator migration retains original body identity in ${fetchFirst ? "creator" : "attach"}-first ordering`, async () => {
  const f = fixture(); try {
    await bootstrap(f, fetchFirst); await asset(f, "import"); await asset(f, "wasm");
    const result = await f.state.drainSnapshot(); expect(result.assets).toHaveLength(3);
    expect(result.assets.map(value => value.sha256).sort()).toEqual(Object.values(BODIES).map(sha).sort());
    expect(result).toMatchObject({ workers: 1, completeCoverage: false, collectorProofEstablished: false });
    expect(f.reservations.snapshot().reservedBytes).toBe(Object.values(BODIES).reduce((n, body) => n + body.length, 0));
    const commands = f.socket.calls.filter(command => command.method.endsWith("getResponseBody"));
    expect(commands.filter(command => command.method === "Fetch.getResponseBody")).toMatchObject([{ sessionId: "page", params: { requestId: "creator-fetch" } }]);
    expect(commands.filter(command => command.method === "Network.getResponseBody")).toMatchObject([
      { sessionId: "worker", params: { requestId: "original" } }, { sessionId: "worker", params: { requestId: "import" } }, { sessionId: "worker", params: { requestId: "wasm" } }]);
    expect(f.socket.calls.find(command => command.method === "Fetch.continueRequest").params).toEqual({ requestId: "creator-fetch" });
  } finally { f.close(); }
});
for (const flag of CACHE_FLAGS) for (const value of [undefined, true, null, "false"]) test(`strict response requires observed false ${flag}: ${String(value)}`, async () => {
  const f = fixture(); try { f.request("original"); f.fetch(); await tick(); f.attach(); f.response("original", "bootstrap", "worker", { [flag]: value });
    await expect(f.state.drainSnapshot()).rejects.toThrow("cache-provenance-unavailable-or-used");
  } finally { f.close(); }
});
for (const [name, mutation] of Object.entries({
  target: { type: "worker", targetId: "other", parentId: "page-target" }, parent: { type: "worker", targetId: "original", parentId: "foreign" },
  url: { type: "worker", targetId: "original", parentId: "page-target", url: ORIGIN + "/other.js" },
  kind: { type: "service_worker", targetId: "original", parentId: "page-target" },
})) test(`migration rejects wrong ${name}`, async () => {
  const f = fixture(); try { f.request("original"); f.fetch(); await tick(); f.attach({ targetInfo: mutation }); await expect(f.state.drainSnapshot()).rejects.toThrow("worker-owner-mismatch"); } finally { f.close(); }
});
for (const which of ["request", "fetch", "attach", "response", "completion", "worker-request"]) test(`migration rejects duplicate ${which}`, async () => {
  const f = fixture(); try {
    f.request("original"); if (which === "request") f.request("original");
    f.fetch(); if (which === "fetch") f.fetch(); await tick(); f.attach(); if (which === "attach") f.attach();
    if (which === "worker-request") { f.request("original", "/bootstrap.js", "worker"); f.request("original", "/bootstrap.js", "worker"); }
    f.response(); if (which === "response") f.response(); f.complete(); if (which === "completion") f.complete();
    f.pause(); await expect(f.state.drainSnapshot()).rejects.toThrow("owned-frontend:");
  } finally { f.close(); }
});
for (const which of ["fetch", "response", "completion", "attach"]) test(`migration rejects wrong-session ${which}`, async () => {
  const f = fixture(); try {
    f.request("original"); f.fetch({}, which === "fetch" ? "foreign" : "page"); await tick(); f.attach({}, which === "attach" ? "foreign" : "page");
    f.response("original", "bootstrap", which === "response" ? "page" : "worker"); f.complete("original", which === "completion" ? "page" : "worker");
    f.pause(); await expect(f.state.drainSnapshot()).rejects.toThrow("owned-frontend:");
  } finally { f.close(); }
});
test("missing future attachment rejects and cannot be repaired after snapshot", async () => {
  const f = fixture(); try { f.request("original"); f.fetch(); await tick(); await expect(f.state.drainSnapshot()).rejects.toThrow("incomplete-lifecycle"); f.attach(); await expect(f.state.drainSnapshot()).rejects.toThrow("incomplete-lifecycle"); } finally { f.close(); }
});
test("import before acknowledged execution gate rejects", async () => {
  const f = fixture(); try { f.request("original"); f.fetch(); await tick(); f.attach(); f.request("import", "/import.js", "worker"); await expect(f.state.drainSnapshot()).rejects.toThrow("early-request"); } finally { f.close(); }
});
test("queued setup controls do not count as acknowledged setup", async () => {
  const f = fixture(); try {
    f.socket.held.add("Network.setCacheDisabled"); f.request("original"); f.fetch(); await tick(); f.attach(); f.pause(); await tick();
    expect(f.socket.calls.some(command => command.method === "Debugger.resume")).toBe(false);
    f.socket.release(); await tick(); await tick(); expect(f.socket.calls.some(command => command.method === "Debugger.resume")).toBe(true);
    f.response(); f.complete(); expect((await f.state.drainSnapshot()).workers).toBe(1);
  } finally { f.close(); }
});
for (const which of ["Network.getResponseBody", "Debugger.getScriptSource", "Fetch.getResponseBody"]) test(`missing exact ${which} bytes rejects`, async () => {
  const f = fixture(); try { f.socket.overrides[which] = () => ({}); await bootstrap(f); await expect(f.state.drainSnapshot()).rejects.toThrow("owned-frontend:"); } finally { f.close(); }
});
for (const which of ["Network.getResponseBody", "Debugger.getScriptSource"]) test(`same-size changed ${which} bytes rejects`, async () => {
  const f = fixture(); try {
    f.socket.overrides[which] = (_packet, result) => which === "Debugger.getScriptSource" ? { scriptSource: "x".repeat(BODIES.bootstrap.length) } :
      { ...result, body: Buffer.alloc(BODIES.bootstrap.length, 120).toString("base64") };
    await bootstrap(f); await expect(f.state.drainSnapshot()).rejects.toThrow("owned-frontend:");
  } finally { f.close(); }
});
for (const method of ["Target.detachedFromTarget", "Inspector.detached", "Target.targetCrashed", "Network.loadingFailed"]) test(`lifecycle ${method} rejects captured bytes`, async () => {
  const f = fixture(); try { await bootstrap(f); f.emit(method, { requestId: "original", sessionId: "worker", targetId: "original" }, "worker"); await expect(f.state.drainSnapshot()).rejects.toThrow("owned-frontend:"); } finally { f.close(); }
});
test("missing import completion cannot produce a snapshot", async () => {
  const f = fixture(); try { await bootstrap(f); f.request("import", "/import.js", "worker"); f.response("import", "import"); await expect(f.state.drainSnapshot()).rejects.toThrow("incomplete-lifecycle"); } finally { f.close(); }
});
test("late body after abort stays rejected", async () => {
  const f = fixture(); try { f.socket.held.add("Network.getResponseBody"); await bootstrap(f); f.state.abort(); f.socket.release(); await expect(f.state.drainSnapshot()).rejects.toThrow("aborted"); } finally { f.close(); }
});
test("ordinary identical request IDs on page and worker keep distinct bodies", async () => {
  const f = fixture(); try { await bootstrap(f); f.request("import", "/import.js", "page"); f.response("import", "import", "page"); f.complete("import", "page"); await asset(f, "import");
    const result = await f.state.drainSnapshot(); expect(result.assets.find(asset => asset.url.endsWith("/import.js")).responseCount).toBe(2);
    expect(f.socket.calls.filter(command => command.method === "Network.getResponseBody" && command.params.requestId === "import").map(command => command.sessionId)).toEqual(["page", "worker"]);
  } finally { f.close(); }
});

test("ordinary remote registry blobs and artwork do not consume frontend reservations", async () => {
  const f = fixture(); try {
    await bootstrap(f);
    for (let n = 0; n < 100; n++) {
      const url = n % 2 ? `https://registry.example/v2/tiny/blobs/sha256:${"a".repeat(64)}` : "https://artwork.example/background.png";
      const type = n % 2 ? "Fetch" : "Image", requestId = `ordinary-${n}`;
      f.emit("Network.requestWillBeSent", { requestId, type, request: { url, method: "GET" } }, "worker");
      f.emit("Network.responseReceived", { requestId, type, response: { url, status: 200, mimeType: n % 2 ? "application/octet-stream" : "image/png", headers: {} } }, "worker");
      f.complete(requestId);
    }
    const result = await f.state.drainSnapshot(); expect(result.assets).toHaveLength(1); expect(f.reservations.snapshot().responses).toBe(1);
    expect(f.socket.calls.filter(command => command.method === "Network.getResponseBody")).toHaveLength(1);
  } finally { f.close(); }
});
for (const [name, url, type, headers] of [
  ["script", "https://registry.example/injected.js", "Script", { "Content-Length": "3" }],
  ["late MIME WASM", "https://registry.example/object", "Fetch", { "Content-Length": "8", "Content-Type": "APPLICATION/WASM; charset=binary" }],
]) test(`remote ${name} remains rejected after response classification`, async () => {
  const f = fixture(); try { await bootstrap(f);
    f.emit("Network.requestWillBeSent", { requestId: "foreign", type, request: { url, method: "GET" } }, "worker");
    f.emit("Network.responseReceived", { requestId: "foreign", type, response: { url, status: 200, headers,
      fromDiskCache: false, fromPrefetchCache: false, fromServiceWorker: false } }, "worker");
    await expect(f.state.drainSnapshot()).rejects.toThrow("owned-frontend:");
  } finally { f.close(); }
});
test("extensionless local WASM uses shared Content-Type fallback and normalization", async () => {
  const f = fixture(); try { await bootstrap(f);
    const url = ORIGIN + "/object";
    f.emit("Network.requestWillBeSent", { requestId: "wasm", type: "Fetch", request: { url, method: "GET" } }, "worker");
    f.emit("Network.responseReceived", { requestId: "wasm", type: "Fetch", response: { url, status: 200,
      headers: { "Content-Length": "8", "Content-Type": "APPLICATION/WASM; charset=binary" },
      fromDiskCache: false, fromPrefetchCache: false, fromServiceWorker: false } }, "worker");
    f.complete("wasm"); const result = await f.state.drainSnapshot();
    expect(result.assets.find(asset => asset.url === url)).toMatchObject({ resourceType: "wasm", sha256: sha(BODIES.wasm), sizeBytes: 8 });
  } finally { f.close(); }
});
test("late events invalidate an earlier diagnostic snapshot", async () => {
  const f = fixture(); try { await bootstrap(f); const snapshot = await f.state.drainSnapshot(); expect(snapshot.completeCoverage).toBe(false);
    f.attach(); expect(() => f.state.assertNoFailure()).toThrow("event-after-snapshot-start");
  } finally { f.close(); }
});

for (const mutation of [false,true]) test(`served main-page script source ${mutation ? "substitution rejects" : "matches captured response"}`, async () => {
  const f = fixture(); try {
    await bootstrap(f); f.request("import","/import.js","page"); f.response("import","import","page"); f.complete("import","page");
    await f.state.drainSnapshot();
    f.socket.overrides["Debugger.getScriptSource"] = () => ({scriptSource:mutation ? "x".repeat(BODIES.import.length) : BODIES.import.toString()});
    const task = f.state.verifyPageScripts([{id:"page-script",url:ORIGIN+"/import.js"}]);
    if (mutation) await expect(task).rejects.toThrow("page-script-verification-failed"); else await task;
  } finally { f.close(); }
});
test("missing page script parse record cannot cover a loaded script", async () => {
  const f = fixture(); try { await bootstrap(f); f.request("import","/import.js","page"); f.response("import","import","page"); f.complete("import","page");
    await f.state.drainSnapshot(); await expect(f.state.verifyPageScripts([])).rejects.toThrow("page-script-verification-failed");
  } finally { f.close(); }
});

test("a separately aborted body registry invalidates an otherwise complete snapshot", async () => {
  const f = fixture(); try { await bootstrap(f); f.reservations.abort(); await expect(f.state.drainSnapshot()).rejects.toThrow("body-reservation-failed"); } finally { f.close(); }
});
