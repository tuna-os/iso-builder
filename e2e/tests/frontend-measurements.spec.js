const { test, expect } = require("@playwright/test");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const { observeFrontendResponses, compareFrontendAssets } = require("./frontend-measurements");

const ORIGIN = "http://127.0.0.1:8931";
const DOCUMENT = `${ORIGIN}/?image=tiny%3Abase`;
const HTML = Buffer.from("<!doctype html><style>body{color:red}</style><script>1</script>");
const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const measurement = body => ({
  sha256: `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`,
  sizeBytes: body.length,
});

class MockSession extends EventEmitter {
  constructor() { super(); this.calls = []; this.detached = false; this.bodies = new Map(); this.childBodies = new Map(); this.workerCommands = []; }
  async send(method, params) {
    this.calls.push({ method, params });
    if (method === "Target.getTargetInfo") return { targetInfo: { type: "page", targetId: "owned-page" } };
    if (method === "Target.sendMessageToTarget") {
      const command = { sessionId: params.sessionId, ...JSON.parse(params.message) };
      this.workerCommands.push(command);
      queueMicrotask(async () => {
        try {
          let result = {};
          if (command.method === "Network.getResponseBody") {
            const read = this.childBodies.get(command.sessionId)?.get(command.params.requestId);
            if (!read) throw new Error("worker body unavailable");
            result = await read();
          }
          if (this.childHandler) {
            const override = await this.childHandler(command);
            if (override === "no-reply") return;
            if (override !== undefined) result = override;
          }
          this.emit("Target.receivedMessageFromTarget", { sessionId: command.sessionId, message: JSON.stringify({ id: command.id, result }) });
        } catch (error) {
          this.emit("Target.receivedMessageFromTarget", { sessionId: command.sessionId, message: JSON.stringify({ id: command.id, error: { message: error.message } }) });
        }
      });
      return {};
    }
    if (method === "Network.getResponseBody") {
      if (!this.bodies.has(params.requestId)) throw new Error("owned body unavailable");
      return this.bodies.get(params.requestId)();
    }
  }
  async detach() { this.detached = true; }
}
class MockPage extends EventEmitter {
  constructor() { super(); this.session = new MockSession(); this.frame = {}; this.currentURL = "about:blank"; }
  url() { return this.currentURL; }
  mainFrame() { return this.frame; }
  context() { return { newCDPSession: async () => this.session }; }
}
function response(page, options = {}) {
  const url = options.url || DOCUMENT;
  const body = options.body || HTML;
  const type = options.type || "document";
  const request = {
    url: () => options.requestURL || url,
    resourceType: () => type,
    method: () => options.method || "GET",
    redirectedFrom: () => options.redirectedFrom || null,
    redirectedTo: () => options.redirectedTo || null,
    isNavigationRequest: () => options.navigation !== false,
    frame: () => options.frame || page.mainFrame(),
  };
  const result = {
    url: () => url,
    request: () => request,
    headers: () => ({ "content-length": String(body.length), ...options.headers }),
    fromServiceWorker: () => !!options.serviceWorker,
    status: () => options.status || 200,
    bodyCalls: 0,
    publicBodyCalls: 0,
    body: async () => { result.publicBodyCalls++; throw new Error("Playwright body() must never be used"); },
    ownedBody: async () => {
      result.bodyCalls++;
      const bytes = options.read ? await options.read() : body;
      return { body: bytes.toString("base64"), base64Encoded: true };
    },
  };
  return result;
}
async function setup(options = {}) {
  const page = new MockPage();
  const observer = await observeFrontendResponses(page, { documentURL: DOCUMENT, ...options });
  let nextId = 0;
  return { page, observer, emit: (overrides = {}) => {
    const res = response(page, overrides);
    const requestId = overrides.requestId || `request-${++nextId}`;
    if (overrides.publicFirst && !overrides.omitPublic) page.emit("response", res);
    if (!overrides.omitOwned) {
      page.session.bodies.set(requestId, res.ownedBody);
      page.session.emit("Network.requestWillBeSent", {
        requestId, request: { url: res.request().url(), method: res.request().method() }, type: res.request().resourceType(),
      });
      page.session.emit("Network.responseReceived", {
        requestId, type: res.request().resourceType(),
        response: { url: res.url(), status: res.status(), headers: res.headers(), mimeType: res.headers()["content-type"] || "" },
      });
    }
    if (!overrides.publicFirst && !overrides.omitPublic) page.emit("response", res);
    if (!overrides.omitOwned && !overrides.omitComplete) page.session.emit("Network.loadingFinished", { requestId });
    return res;
  } };
}
function expected(assets = {}) { return { [DOCUMENT]: measurement(HTML), ...assets }; }

// Tiny mocked responses exercise the host observer without Chromium, a real
// engine, an image pull, or an ISO. Browser-boundary integration is separate.
test.describe("host frontend response observation", () => {
  test("hashes owned page document, scripts, styles, and fetched WASM bytes", async () => {
    const { page, observer, emit } = await setup();
    const inputs = [
      { url: DOCUMENT, body: HTML, type: "document" },
      { url: `${ORIGIN}/app.js`, body: Buffer.from("app();"), type: "script" },
      { url: `${ORIGIN}/app.css`, body: Buffer.from("body{}"), type: "stylesheet" },
      { url: `${ORIGIN}/tbox.wasm`, body: WASM, type: "fetch" },
    ];
    for (const input of inputs) emit(input);
    const result = await observer.finish();
    expect(result).toMatchObject({ schemaVersion: 1, kind: "diagnostic-loaded-frontend",
      qualification: "not-assessed", authentication: "not-verified", origin: ORIGIN, documentURL: DOCUMENT });
    expect(result.assets).toHaveLength(inputs.length);
    for (const input of inputs) {
      expect(result.assets.find(asset => asset.url === input.url)).toMatchObject({
        ...measurement(input.body), responseCount: 1,
        resourceType: input.url.endsWith(".wasm") ? "wasm" : input.url.endsWith("layerworker.js") ? "script" : input.type,
      });
    }
    expect(compareFrontendAssets(result, Object.fromEntries(inputs.map(input => [input.url, measurement(input.body)]))))
      .toEqual({ kind: "diagnostic-frontend-byte-match", qualification: "not-assessed", authentication: "not-verified", matchedAssets: 4 });
    expect(page.session.calls.slice(0, 3)).toEqual([
      { method: "Network.enable", params: { maxTotalBufferSize: 96 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024 } },
      { method: "Network.setCacheDisabled", params: { cacheDisabled: true } },
      { method: "Network.setBypassServiceWorker", params: { bypass: true } },
    ]);
    expect(page.listenerCount("response")).toBe(0);
    expect(page.session.listenerCount("Network.responseReceived")).toBe(0);
    expect(page.session.detached).toBe(true);
  });

  test("rejects created workers because their CDP targets are not controlled", async () => {
    const { page, observer, emit } = await setup();
    emit();
    page.emit("worker", { url: () => `${ORIGIN}/layerworker.js` });
    await expect(observer.finish()).rejects.toThrow(/worker target is not covered/);
    expect(page.listenerCount("worker")).toBe(0);
  });

  test("a same-URL page response cannot stand in for a worker target", async () => {
    const { page, observer, emit } = await setup();
    emit();
    emit({ url: `${ORIGIN}/layerworker.js`, type: "other" });
    page.emit("worker", { url: () => `${ORIGIN}/layerworker.js` });
    await expect(observer.finish()).rejects.toThrow(/worker target is not covered/);
  });

  test("rejects blob workers without claiming their source was observed", async () => {
    const { page, observer, emit } = await setup();
    emit();
    page.emit("worker", { url: () => `blob:${ORIGIN}/unobserved` });
    await expect(observer.finish()).rejects.toThrow(/worker target is not covered/);
  });

  test("uses owned CDP bytes and never calls Playwright body or refetch", async () => {
    const { page, observer, emit } = await setup();
    const owned = Buffer.from("x".repeat(HTML.length));
    const res = emit({ read: async () => owned });
    expect((await observer.finish()).assets[0]).toMatchObject(measurement(owned));
    expect(res.publicBodyCalls).toBe(0);
    expect(page.session.calls.filter(call => call.method === "Network.getResponseBody"))
      .toEqual([{ method: "Network.getResponseBody", params: { requestId: "request-1" } }]);
    expect(page.session.calls.some(call => call.method === "Network.loadNetworkResource")).toBe(false);
  });

  test("requires one-to-one owned CDP evidence for public response events", async () => {
    const { observer, emit } = await setup();
    emit();
    emit({ url: `${ORIGIN}/unowned.js`, type: "script", omitOwned: true });
    await expect(observer.finish()).rejects.toThrow(/one-to-one owned CDP identity/);
  });

  test("a duplicate public response cannot reuse one owned response identity", async () => {
    const { observer, emit } = await setup();
    emit();
    emit({ url: `${ORIGIN}/app.js`, type: "script" });
    emit({ url: `${ORIGIN}/app.js`, type: "script", omitOwned: true });
    await expect(observer.finish()).rejects.toThrow(/one-to-one owned CDP identity/);
  });

  test("requires a public response event for each owned frontend response", async () => {
    const { observer, emit } = await setup();
    emit();
    emit({ url: `${ORIGIN}/app.js`, type: "script", omitPublic: true });
    await expect(observer.finish()).rejects.toThrow(/one-to-one owned CDP identity/);
  });

  test("correlates responses even when public events precede owned CDP events", async () => {
    const { observer, emit } = await setup();
    emit({ publicFirst: true });
    expect((await observer.finish()).assets).toHaveLength(1);
  });

  for (const [url, type] of [[`${ORIGIN}/late.js`, "Script"], [`${ORIGIN}/engine`, "Fetch"]]) {
    test(`rejects an outstanding frontend candidate ${type}`, async () => {
      const { page, observer, emit } = await setup();
      emit();
      page.session.emit("Network.requestWillBeSent", { requestId: "late", request: { url, method: "GET" }, type });
      await expect(observer.finish()).rejects.toThrow(/outstanding frontend request/);
    });
  }

  test("requires loadingFinished before an observed body can be accepted", async () => {
    const { observer, emit } = await setup();
    emit({ omitComplete: true });
    await expect(observer.finish()).rejects.toThrow(/outstanding frontend request/);
  });

  test("rejects an owned frontend response without its original request identity", async () => {
    const { page, observer, emit } = await setup();
    emit();
    page.session.emit("Network.responseReceived", { requestId: "orphan", type: "Script",
      response: { url: `${ORIGIN}/app.js`, status: 200, headers: { "content-length": "1" } } });
    await expect(observer.finish()).rejects.toThrow(/matching owned CDP request/);
  });

  test("cannot forget an executable request when later metadata loses its type", async () => {
    const { page, observer, emit } = await setup();
    emit();
    const url = `${ORIGIN}/extensionless-script`;
    page.session.emit("Network.requestWillBeSent", { requestId: "changed-type", request: { url, method: "GET" }, type: "Script" });
    page.session.emit("Network.responseReceived", { requestId: "changed-type", type: "Fetch",
      response: { url, status: 200, mimeType: "application/octet-stream", headers: { "content-length": "1" } } });
    await expect(observer.finish()).rejects.toThrow(/classification disappeared/);
  });

  test("empty owned bodies fail rather than using a later fallback response", async () => {
    const { page, observer, emit } = await setup();
    const res = emit({ read: async () => Buffer.alloc(0) });
    await expect(observer.finish()).rejects.toThrow(/declared size differ/);
    expect(res.publicBodyCalls).toBe(0);
    expect(page.session.calls.some(call => call.method === "Network.loadNetworkResource")).toBe(false);
  });

  test("accepts textual bodies from the owned CDP session", async () => {
    const { page, observer, emit } = await setup();
    const res = emit();
    page.session.bodies.set("request-1", async () => ({ body: HTML.toString("utf8"), base64Encoded: false }));
    expect((await observer.finish()).assets[0]).toMatchObject(measurement(HTML));
    expect(res.publicBodyCalls).toBe(0);
  });

  test("rejects a failed extensionless same-origin frontend candidate", async () => {
    const { page, observer, emit } = await setup();
    emit();
    page.session.emit("Network.requestWillBeSent", { requestId: "failed", type: "Fetch",
      request: { url: `${ORIGIN}/engine`, method: "GET" } });
    page.session.emit("Network.loadingFailed", { requestId: "failed" });
    await expect(observer.finish()).rejects.toThrow(/frontend request failed/);
  });

  test("includes extensionless application/wasm fetch responses", async () => {
    const { observer, emit } = await setup();
    emit();
    emit({ url: `${ORIGIN}/engine`, body: WASM, type: "fetch", headers: { "content-type": "application/wasm" } });
    expect((await observer.finish()).assets.find(asset => asset.url.endsWith("/engine")))
      .toMatchObject({ resourceType: "wasm", ...measurement(WASM) });
  });

  test("ignores unrelated image and registry data responses", async () => {
    const { observer, emit } = await setup();
    emit();
    const image = emit({ url: `${ORIGIN}/logo.png`, type: "image" });
    const registry = emit({ url: "https://registry.invalid/v2/layers/blob", type: "fetch" });
    expect((await observer.finish()).assets).toHaveLength(1);
    expect(image.bodyCalls + registry.bodyCalls).toBe(0);
  });

  test("accepts repeat asset responses only when exact bytes and resource types agree", async () => {
    const { observer, emit } = await setup();
    const js = Buffer.from("one();");
    emit();
    emit({ url: `${ORIGIN}/app.js`, body: js, type: "script" });
    emit({ url: `${ORIGIN}/app.js`, body: js, type: "script" });
    const result = await observer.finish();
    expect(result.assets.find(asset => asset.url.endsWith("/app.js")).responseCount).toBe(2);
    expect(compareFrontendAssets(result, expected({ [`${ORIGIN}/app.js`]: measurement(js) })).matchedAssets).toBe(2);
  });

  for (const mismatch of ["body", "type"]) {
    test(`rejects repeated URL with changed ${mismatch}`, async () => {
      const { observer, emit } = await setup();
      emit();
      emit({ url: `${ORIGIN}/app.js`, body: Buffer.from("one"), type: "script" });
      emit({ url: `${ORIGIN}/app.js`, body: Buffer.from(mismatch === "body" ? "two" : "one"),
        type: mismatch === "type" ? "stylesheet" : "script" });
      await expect(observer.finish()).rejects.toThrow(/duplicate frontend URL/);
    });
  }

  for (const options of [
    { url: "https://outside.invalid/app.js", type: "script" },
    { url: "http://127.0.0.1:8932/app.js", type: "script" },
    { url: "http://localhost:8931/app.js", type: "script" },
    { url: "data:text/javascript,1", type: "script" },
    { url: `${ORIGIN}/app.js`, type: "script", requestURL: `${ORIGIN}/other.js` },
    { url: `${ORIGIN}/app.js`, type: "script", redirectedFrom: {} },
    { url: `${ORIGIN}/app.js`, type: "script", redirectedTo: {} },
    { url: `${ORIGIN}/app.js`, type: "script", status: 302 },
    { url: `${ORIGIN}/app.js`, type: "script", status: 304 },
    { url: `${ORIGIN}/app.js`, type: "script", status: 206 },
    { url: `${ORIGIN}/app.js`, type: "script", method: "POST" },
    { url: `${ORIGIN}/app.js`, type: "script", serviceWorker: true },
  ]) {
    test(`rejects ambiguous response ${JSON.stringify(options)}`, async () => {
      const { observer, emit } = await setup();
      emit();
      const bad = emit(options);
      await expect(observer.finish()).rejects.toThrow();
      expect(bad.bodyCalls).toBe(0);
    });
  }

  for (const headers of [
    { "content-length": undefined }, { "content-length": "0" }, { "content-length": "-1" },
    { "content-length": "1.5" }, { "content-length": "8, 8" }, { "content-length": "08" },
    { "content-length": "9007199254740992" }, { "content-encoding": "gzip" },
    { "transfer-encoding": "chunked" }, { "content-range": "bytes 0-7/20" },
  ]) {
    test(`rejects unbounded or encoded response ${JSON.stringify(headers)}`, async () => {
      const { observer, emit } = await setup();
      const bad = emit({ headers });
      await expect(observer.finish()).rejects.toThrow();
      expect(bad.bodyCalls).toBe(0);
    });
  }

  for (const event of [
    ["Network.requestServedFromCache", { requestId: "tiny" }],
    ["Network.responseReceived", { requestId: "tiny", response: { url: `${ORIGIN}/app.js`, fromDiskCache: true } }],
    ["Network.responseReceived", { requestId: "tiny", response: { url: `${ORIGIN}/app.js`, fromPrefetchCache: true } }],
    ["Network.responseReceived", { requestId: "tiny", response: { url: `${ORIGIN}/app.js`, fromServiceWorker: true } }],
  ]) {
    test(`rejects CDP cache or service-worker evidence ${JSON.stringify(event)}`, async () => {
      const { page, observer, emit } = await setup();
      emit();
      page.session.emit("Network.requestWillBeSent", { requestId: "tiny", request: { url: `${ORIGIN}/app.js` }, type: "Script" });
      page.session.emit(...event);
      await expect(observer.finish()).rejects.toThrow(/cache|service-worker/);
    });
  }

  test("ignores cached OCI/blob responses while retaining frontend cache checks", async () => {
    const { page, observer, emit } = await setup();
    emit();
    const url = "https://registry.invalid/v2/blobs/sha256:tiny";
    page.session.emit("Network.requestWillBeSent", { requestId: "blob", request: { url }, type: "Fetch" });
    page.session.emit("Network.requestServedFromCache", { requestId: "blob" });
    page.session.emit("Network.responseReceived", { requestId: "blob", type: "Fetch",
      response: { url, mimeType: "application/octet-stream", fromDiskCache: true, fromServiceWorker: true } });
    expect((await observer.finish()).assets).toHaveLength(1);
  });

  test("rejects cached extensionless WASM identified by later response MIME", async () => {
    const { page, observer, emit } = await setup();
    emit();
    const url = `${ORIGIN}/engine`;
    page.session.emit("Network.requestWillBeSent", { requestId: "wasm", request: { url }, type: "Fetch" });
    page.session.emit("Network.requestServedFromCache", { requestId: "wasm" });
    page.session.emit("Network.responseReceived", { requestId: "wasm", type: "Fetch",
      response: { url, mimeType: "application/wasm" } });
    await expect(observer.finish()).rejects.toThrow(/cache/);
  });

  test("rejects cache evidence emitted while flushing the closing snapshot", async () => {
    const { page, observer, emit } = await setup();
    emit();
    page.session.emit("Network.requestWillBeSent", { requestId: "tiny", request: { url: DOCUMENT }, type: "Document" });
    const originalSend = page.session.send.bind(page.session);
    page.session.send = async (method, params) => {
      if (method === "Network.setCacheDisabled") page.session.emit("Network.requestServedFromCache", { requestId: "tiny" });
      return originalSend(method, params);
    };
    await expect(observer.finish()).rejects.toThrow(/cache/);
  });

  for (const options of [
    { url: `${ORIGIN}/other.html` }, { frame: {} }, { navigation: false },
  ]) {
    test(`rejects unexpected main document ${JSON.stringify(options)}`, async () => {
      const { observer, emit } = await setup();
      emit(options);
      await expect(observer.finish()).rejects.toThrow(/main-document/);
    });
  }
  test("rejects another navigation even if its document body is identical", async () => {
    const { observer, emit } = await setup();
    emit(); emit();
    await expect(observer.finish()).rejects.toThrow(/main-document/);
  });
  test("requires an observed main document", async () => {
    const { observer, emit } = await setup();
    emit({ url: `${ORIGIN}/app.js`, type: "script" });
    await expect(observer.finish()).rejects.toThrow(/main-document/);
  });

  test("enforces declared per-response limits before reading any body", async () => {
    const { observer, emit } = await setup({ maxResponseBytes: 1 });
    const bad = emit();
    await expect(observer.finish()).rejects.toThrow(/byte limit/);
    expect(bad.bodyCalls).toBe(0);
  });
  test("bounds aggregate bytes including matching duplicate responses", async () => {
    const { observer, emit } = await setup({ maxTotalBytes: HTML.length + 1 });
    emit();
    const bad = emit({ url: `${ORIGIN}/app.js`, body: Buffer.from("12"), type: "script" });
    await expect(observer.finish()).rejects.toThrow(/total byte limit/);
    expect(bad.bodyCalls).toBe(0);
  });
  test("bounds response count before body reads", async () => {
    const { observer, emit } = await setup({ maxResponses: 1 });
    emit();
    const bad = emit({ url: `${ORIGIN}/app.js`, type: "script" });
    await expect(observer.finish()).rejects.toThrow(/too many/);
    expect(bad.bodyCalls).toBe(0);
  });
  test("checks actual body size even with a small declared Content-Length", async () => {
    const { observer, emit } = await setup();
    emit({ headers: { "content-length": "1" } });
    await expect(observer.finish()).rejects.toThrow(/declared size differ/);
  });
  test("body-read failures produce no partial success", async () => {
    const { observer, emit } = await setup();
    emit({ read: async () => { throw new Error("tiny body unavailable"); } });
    await expect(observer.finish()).rejects.toThrow(/tiny body unavailable/);
  });
  test("failed frontend requests cannot disappear from an otherwise valid snapshot", async () => {
    const { page, observer, emit } = await setup();
    emit();
    page.emit("requestfailed", response(page, { url: `${ORIGIN}/layerworker.js`, type: "script" }).request());
    await expect(observer.finish()).rejects.toThrow(/request failed/);
  });
  test("times out a stalled body, detaches observers, and cannot later return success", async () => {
    const { page, observer, emit } = await setup({ timeoutMs: 15 });
    let release;
    emit({ read: () => new Promise(resolve => { release = resolve; }) });
    await expect(observer.finish()).rejects.toThrow(/timed out/);
    expect(page.listenerCount("response")).toBe(0);
    expect(page.session.detached).toBe(true);
    release(HTML);
    await expect(observer.finish()).rejects.toThrow(/timed out/);
  });
  test("serializes response-body reads and includes responses arriving during draining", async () => {
    const { observer, emit } = await setup();
    let release;
    emit({ read: () => new Promise(resolve => { release = resolve; }) });
    const resultPromise = observer.finish();
    await Promise.resolve();
    const script = emit({ url: `${ORIGIN}/app.js`, type: "script" });
    expect(script.bodyCalls).toBe(0);
    release(HTML);
    expect((await resultPromise).assets).toHaveLength(2);
    expect(script.bodyCalls).toBe(1);
  });
  test("disposal detaches and prevents a later result", async () => {
    const { page, observer } = await setup();
    await observer.dispose();
    await observer.dispose();
    await expect(observer.finish()).rejects.toThrow(/disposed/);
    expect(page.listenerCount("response")).toBe(0);
  });
  test("requires installation before navigation", async () => {
    const page = new MockPage(); page.currentURL = DOCUMENT;
    await expect(observeFrontendResponses(page, { documentURL: DOCUMENT })).rejects.toThrow(/before navigation/);
  });
  test("setup failure detaches the CDP session", async () => {
    const page = new MockPage(); page.session.send = async () => { throw new Error("unsupported CDP"); };
    await expect(observeFrontendResponses(page, { documentURL: DOCUMENT })).rejects.toThrow(/unsupported CDP/);
    expect(page.session.detached).toBe(true);
    expect(page.session.listenerCount("Network.responseReceived")).toBe(0);
  });
  for (const options of [{ maxResponses: 65 }, { maxResponses: 0 }, { maxResponseBytes: 1.2 },
    { timeoutMs: 30001 }, { unknown: 1 }, { documentURL: "https://example.org/" }]) {
    test(`rejects loosened or invalid configuration ${JSON.stringify(options)}`, async () => {
      await expect(setup(options)).rejects.toThrow();
    });
  }
});

const WORKER_URL = `${ORIGIN}/layerworker.js`;
const WORKER_BODY = Buffer.from('onmessage = () => postMessage("ready");');
const childEvent = (page, method, params, sessionId = "worker-session") => page.session.emit("Target.receivedMessageFromTarget", {
  sessionId, message: JSON.stringify({ method, params }),
});
async function attachWorker(page, { targetId = "worker-target", sessionId = "worker-session", url = WORKER_URL, waitingForDebugger = true } = {}) {
  page.session.childBodies.set(sessionId, new Map([[targetId, async () => ({ body: WORKER_BODY.toString("base64"), base64Encoded: true })]]));
  page.emit("worker", { url: () => url });
  page.session.emit("Target.attachedToTarget", { sessionId, targetInfo: { targetId, type: "worker", parentId: "owned-page", url }, waitingForDebugger });
  // Mock protocol delivery only; no browser, network, or wall-clock polling.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function workerMain(page, { requestId = "worker-target", omitStart = false, omitHeaders = false, complete = true, cache = false, url = WORKER_URL } = {}) {
  const res = response(page, { url, body: WORKER_BODY, type: "other" });
  if (!omitStart) page.session.emit("Network.requestWillBeSent", { requestId, type: "Other", request: { url, method: "GET" } });
  if (!omitHeaders) {
    page.session.emit("Network.responseReceived", { requestId, type: "Other",
      response: { url, status: 200, headers: res.headers(), mimeType: "text/javascript", fromDiskCache: cache } });
    page.emit("response", res);
  }
  if (complete) childEvent(page, "Network.loadingFinished", { requestId });
}

test.describe("experimental owned dedicated worker transport", () => {
  test("configures public nonflattened child transport before resuming", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    await attachWorker(page);
    workerMain(page);
    const observation = await observer.finish();
    expect(observation.coverage).toBe("page-and-direct-dedicated-workers-experimental");
    expect(observation.assets.find(asset => asset.url === WORKER_URL)).toMatchObject(measurement(WORKER_BODY));
    expect(page.session.workerCommands.slice(0, 5).map(command => command.method)).toEqual([
      "Network.setCacheDisabled", "Network.setBypassServiceWorker", "Target.setAutoAttach", "Network.enable", "Runtime.runIfWaitingForDebugger",
    ]);
    expect(page.session.calls.find(call => call.method === "Target.setAutoAttach").params).toMatchObject({ flatten: false, waitForDebuggerOnStart: true });
    expect(page.session.workerCommands.find(command => command.method === "Network.getResponseBody").params).toEqual({ requestId: "worker-target" });
    expect(page.session.calls.filter(call => call.method === "Network.getResponseBody")).toHaveLength(1);
    expect(() => compareFrontendAssets(observation, expected({ [WORKER_URL]: measurement(WORKER_BODY) }))).toThrow(/invalid diagnostic/);
  });

  test("queues cache controls before resume even when inner replies await resume", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    const held = [];
    page.session.childHandler = command => {
      if (command.method !== "Runtime.runIfWaitingForDebugger" && !held.resumed) { held.push(command); return "no-reply"; }
      if (command.method === "Runtime.runIfWaitingForDebugger") {
        held.resumed = true;
        for (const pending of held) page.session.emit("Target.receivedMessageFromTarget", { sessionId: pending.sessionId, message: JSON.stringify({ id: pending.id, result: {} }) });
      }
    };
    await attachWorker(page);
    workerMain(page);
    expect((await observer.finish()).assets).toHaveLength(2);
  });

  test("captures exact initial worker history emitted during Network.enable dispatch", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    // The initial script starts on the already-controlled creator target. Its
    // identity must migrate, not be replaced by a same-URL request or refetch.
    workerMain(page, { complete: false });
    let atEnable;
    page.session.childHandler = command => {
      if (command.method !== "Network.enable") return;
      atEnable = page.session.workerCommands.map(command => command.method);
      childEvent(page, "Network.requestWillBeSent", { requestId: "worker-target", type: "Script",
        request: { url: WORKER_URL, method: "GET" } });
      childEvent(page, "Network.responseReceived", { requestId: "worker-target", type: "Script",
        response: { url: WORKER_URL, status: 200, headers: { "content-length": String(WORKER_BODY.length) }, mimeType: "text/javascript" } });
      childEvent(page, "Network.loadingFinished", { requestId: "worker-target" });
    };
    await attachWorker(page);
    const observation = await observer.finish();
    expect(atEnable).toEqual(["Network.setCacheDisabled", "Network.setBypassServiceWorker", "Target.setAutoAttach", "Network.enable"]);
    expect(observation.assets.find(asset => asset.url === WORKER_URL))
      .toMatchObject({ ...measurement(WORKER_BODY), responseCount: 1 });
    expect(page.session.workerCommands.filter(command => command.method === "Network.getResponseBody"))
      .toEqual([expect.objectContaining({ sessionId: "worker-session", params: { requestId: "worker-target" } })]);
    expect(page.session.calls.some(call => call.method === "Network.loadNetworkResource")).toBe(false);
  });

  for (const cacheSignal of ["requestServedFromCache", "fromDiskCache", "fromPrefetchCache", "fromServiceWorker"]) {
    test(`rejects ${cacheSignal} in initial history emitted during enable`, async () => {
      const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
      emit(); workerMain(page, { complete: false });
      page.session.childHandler = command => {
        if (command.method !== "Network.enable") return;
        if (cacheSignal === "requestServedFromCache") {
          childEvent(page, "Network.requestServedFromCache", { requestId: "worker-target" });
        } else {
          childEvent(page, "Network.responseReceived", { requestId: "worker-target", type: "Script",
            response: { url: WORKER_URL, status: 200, headers: { "content-length": String(WORKER_BODY.length) },
              mimeType: "text/javascript", [cacheSignal]: true } });
        }
      };
      await attachWorker(page);
      await expect(observer.finish()).rejects.toThrow(/cache|service-worker/);
    });
  }

  test("enable-time worker history cannot invent a missing creator request", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    page.session.childHandler = command => {
      if (command.method === "Network.enable") childEvent(page, "Network.requestWillBeSent", {
        requestId: "worker-target", type: "Script", request: { url: WORKER_URL, method: "GET" },
      });
    };
    await attachWorker(page);
    await expect(observer.finish()).rejects.toThrow(/no original creator request/);
  });

  for (const failedControl of ["Network.setCacheDisabled", "Network.setBypassServiceWorker"]) {
    test(`does not enable or resume after reported ${failedControl} rejection`, async () => {
      const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
      emit();
      page.session.childHandler = command => {
        if (command.method === failedControl) throw new Error("owned safety control rejected");
      };
      await attachWorker(page);
      await expect(observer.finish()).rejects.toThrow(/worker CDP command rejected/);
      expect(page.session.workerCommands.some(command => ["Network.enable", "Runtime.runIfWaitingForDebugger"].includes(command.method))).toBe(false);
    });
  }

  test("a delayed inner cache-control rejection cannot yield a successful snapshot", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); workerMain(page, { complete: false });
    let cacheCommand;
    page.session.childHandler = command => {
      if (command.method === "Network.setCacheDisabled") { cacheCommand = command; return "no-reply"; }
      if (command.method === "Runtime.runIfWaitingForDebugger") {
        page.session.emit("Target.receivedMessageFromTarget", { sessionId: cacheCommand.sessionId,
          message: JSON.stringify({ id: cacheCommand.id, error: { message: "delayed cache control rejection" } }) });
      }
    };
    await attachWorker(page);
    await expect(observer.finish()).rejects.toThrow(/worker CDP command rejected/);
  });

  for (const missing of ["start", "headers", "completion"]) {
    test(`rejects missing initial worker ${missing}`, async () => {
      const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
      emit(); await attachWorker(page);
      workerMain(page, { omitStart: missing === "start", omitHeaders: missing === "headers", complete: missing !== "completion" });
      await expect(observer.finish()).rejects.toThrow(/original owned request|without an owned response|initial response bytes/);
    });
  }

  // Falsification: diagnostics cannot repair an orphan, missing response, cache
  // rejection or failed lifecycle. Later traffic cannot rewrite a frozen trace;
  // URL/query/header/body fields and malformed IDs must never enter its snapshot.
  const assertTrace = error => {
    expect(error).toBeInstanceOf(Error);
    expect(error.message.match(/; identityTrace=/g)).toHaveLength(1);
    const trace = error.identityTrace;
    expect(trace).toEqual(JSON.parse(error.message.split("; identityTrace=")[1]));
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.recent)).toBe(true);
    expect(trace.recent.length).toBeLessThanOrEqual(32);
    for (const identity of trace.recent) {
      expect(Object.isFrozen(identity)).toBe(true);
      expect(Object.keys(identity).sort()).toEqual(["method", "requestId", "sessionId", "source", "targetId"]);
    }
    return trace;
  };

  test("missing worker response completion freezes a bounded redacted failure trace", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    const targetId = "worker?secret=target-marker", sessionId = "session?secret=session-marker";
    await attachWorker(page, { targetId, sessionId });
    const noise = prefix => {
      for (let i = 0; i < 24; i++) {
        const requestId = `${prefix}-${i}`, url = `${ORIGIN}/data?secret=query-marker`;
        page.session.emit("Network.requestWillBeSent", { requestId, type: "Other",
          request: { url, method: "GET", headers: { authorization: "header-marker" }, postData: "body-marker" } });
        page.session.emit("Network.responseReceived", { requestId, type: "Other",
          response: { url, status: 200, headers: { "x-secret": "response-header-marker" }, mimeType: "application/octet-stream" } });
        page.session.emit("Network.loadingFinished", { requestId });
      }
    };
    noise("before");
    page.session.emit("Network.requestWillBeSent", { requestId: targetId, type: "Other",
      request: { url: `${WORKER_URL}?secret=worker-url-marker`, method: "GET" } });
    const completion = { requestId: targetId, url: "completion-url-marker",
      headers: { authorization: "completion-header-marker" }, body: "completion-body-marker" };
    childEvent(page, "Network.loadingFinished", completion, sessionId);
    completion.requestId = "replaced-after-failure";
    noise("after");
    const error = await observer.finish().then(() => null, error => error);
    expect(error.message).toContain("frontend request completed without an owned response;");
    expect(error.stack).toContain("cdpComplete");
    const trace = assertTrace(error);
    expect(trace.recent).toHaveLength(32);
    expect(trace).toMatchObject({ method: "Network.loadingFinished", requestId: "[redacted]",
      source: "worker", sessionId: "[redacted]", targetId: "[redacted]", ownerTargetId: "owned-page" });
    expect(trace.recent.at(-1)).toMatchObject({ method: "Network.loadingFinished", requestId: "[redacted]" });
    expect(trace.recent.some(identity => identity.requestId === "before-0" || identity.requestId?.startsWith("after-"))).toBe(false);
    expect(error.message.length).toBeLessThan(16 * 1024);
    for (const marker of ["http:", "secret=", "target-marker", "session-marker", "query-marker", "worker-url-marker",
      "header-marker", "body-marker", "completion-url-marker", "replaced-after-failure"]) expect(error.message).not.toContain(marker);
    expect(await observer.finish().catch(error => error)).toBe(error);
    expect(page.session.workerCommands.some(command => command.method === "Network.getResponseBody")).toBe(false);
    expect(page.session.calls.some(call => call.method === "Network.loadNetworkResource")).toBe(false);
  });

  for (const phase of ["response", "body", "snapshot", "worker coverage", "drain", "timeout", "dispose", "disposed"]) {
    test(`collector ${phase} rejection includes one frozen identity trace`, async () => {
      const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true, timeoutMs: 15 });
      let release;
      emit(phase === "response" ? { status: 201 } : phase === "body" ? {
        read: async () => { throw new Error("tiny body unavailable"); },
      } : phase === "timeout" ? { read: () => new Promise(resolve => { release = resolve; }) } :
        phase === "snapshot" ? { omitComplete: true } : {});
      if (phase === "worker coverage") page.emit("worker", { url: () => WORKER_URL });
      if (phase === "drain") {
        const send = page.session.send.bind(page.session);
        page.session.send = (method, params) => method === "Network.setCacheDisabled" ?
          Promise.reject(new Error("drain control unavailable")) : send(method, params);
      }
      if (phase === "dispose") page.session.detach = async () => { throw new Error("detach unavailable"); };
      if (phase === "disposed") await observer.dispose();
      const error = await (phase === "dispose" ? observer.dispose() : observer.finish()).then(() => null, error => error);
      release?.(HTML);
      assertTrace(error);
      expect(error.message).toMatch(/successful, unredirected|external error: (body-read|drain|dispose)|outstanding frontend|coverage is incomplete|timed out|already disposed/);
    });
  }

  test("setup rejection includes a frozen empty trace and still detaches", async () => {
    const page = new MockPage();
    page.session.send = async () => { throw new Error("unsupported CDP"); };
    const error = await observeFrontendResponses(page, { documentURL: DOCUMENT, experimentalDedicatedWorkers: true })
      .then(() => null, error => error);
    expect(error.message).toContain("frontend observation external error: setup;");
    expect(assertTrace(error)).toEqual({ ownerTargetId: null, recent: [] });
    expect(page.session.detached).toBe(true);
    expect(page.session.listenerCount("Network.responseReceived")).toBe(0);
  });

  test("mutating an escaped internal error cannot change its safe diagnostic reason or stack", async () => {
    const escaped = await setup({ experimentalDedicatedWorkers: "invalid" }).catch(error => error);
    expect(escaped.message).toBe("invalid worker observation mode");
    escaped.message = "https://outside.invalid/path?token=mutated-message-secret";
    escaped.stack = "Error: mutated-stack-secret\n    at https://outside.invalid/stack";
    const page = new MockPage();
    page.session.send = async () => { throw escaped; };
    const error = await observeFrontendResponses(page, { documentURL: DOCUMENT, experimentalDedicatedWorkers: true })
      .catch(error => error);
    assertTrace(error);
    expect(error.message).toContain("invalid worker observation mode;");
    for (const marker of ["outside.invalid", "https:", "token=", "mutated-message-secret", "mutated-stack-secret"]) {
      expect(error.message).not.toContain(marker);
      expect(error.stack).not.toContain(marker);
    }
  });

  for (const phase of ["setup", "body-read", "drain", "worker", "event", "dispose"]) {
    test(`external ${phase} errors cannot leak arbitrary message stack or fields`, async () => {
      const injected = new Error("https://outside.invalid/path?token=secret-token\nAuthorization: header-secret body-secret");
      injected.stack += "\n    at https://outside.invalid/stack?token=stack-secret";
      injected.cause = { body: "cause-secret" };
      injected.identityTrace = { recent: [{ url: "forged-trace-secret" }] };
      Object.freeze(injected);
      let error;
      if (phase === "setup") {
        const page = new MockPage();
        page.session.send = async () => { throw injected; };
        error = await observeFrontendResponses(page, { documentURL: DOCUMENT, experimentalDedicatedWorkers: true })
          .catch(error => error);
      } else {
        const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
        emit(phase === "body-read" ? { read: async () => { throw injected; } } : {});
        if (phase === "drain") {
          const send = page.session.send.bind(page.session);
          page.session.send = (method, params) => method === "Network.setCacheDisabled" ?
            Promise.reject(injected) : send(method, params);
        }
        if (phase === "worker") {
          page.session.childHandler = async () => { throw injected; };
          await attachWorker(page);
        }
        if (phase === "event") page.session.emit("Network.requestWillBeSent", { requestId: "bad-event", type: "Other",
          request: { url: "invalid-url?token=secret-token", method: "GET" } });
        if (phase === "dispose") page.session.detach = async () => { throw injected; };
        error = await (phase === "dispose" ? observer.dispose() : observer.finish()).catch(error => error);
      }
      assertTrace(error);
      expect(error.message).toContain(phase === "worker" ? "worker CDP command rejected;" :
        `frontend observation external error: ${phase === "event" ? "worker-transport" : phase};`);
      expect(error.cause).toBeUndefined();
      for (const marker of ["outside.invalid", "https:", "token=", "secret-token", "Authorization", "header-secret",
        "body-secret", "stack-secret", "cause-secret", "forged-trace-secret", "invalid-url"]) {
        expect(error.message).not.toContain(marker);
        expect(error.stack).not.toContain(marker);
        expect(JSON.stringify(error.identityTrace)).not.toContain(marker);
      }
    });
  }

  test("pre-control worker diagnostics redact malformed request and session IDs", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    const sessionId = "http://127.0.0.1/session?secret=session-marker";
    page.session.emit("Target.attachedToTarget", { sessionId,
      targetInfo: { targetId: "worker-target", type: "worker", parentId: "owned-page", url: WORKER_URL }, waitingForDebugger: true });
    childEvent(page, "Network.responseReceived", { requestId: "http://127.0.0.1/request?secret=request-marker",
      response: { url: `${WORKER_URL}?secret=url-marker`, headers: { authorization: "header-marker" } } }, sessionId);
    const error = await observer.finish().then(() => null, error => error);
    expect(error?.message).toContain("preceded owned cache controls");
    expect(error.message).toContain("request [redacted]; session [redacted]");
    for (const marker of ["http:", "secret=", "session-marker", "request-marker", "url-marker", "header-marker"]) expect(error.message).not.toContain(marker);
  });

  test("orphan worker diagnostics retain exact creator and child IDs without a URL join", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page);
    workerMain(page, { complete: false });
    childEvent(page, "Network.responseReceived", { requestId: "different-child-request", type: "Script",
      response: { url: WORKER_URL, status: 200, headers: { "content-length": String(WORKER_BODY.length) }, mimeType: "text/javascript" } });
    const error = await observer.finish().then(() => null, error => error);
    expect(error?.message).toContain("worker response has no original owned request; identityTrace=");
    assertTrace(error);
    const trace = JSON.parse(error.message.split("; identityTrace=")[1]);
    expect(trace).toMatchObject({ requestId: "different-child-request", source: "worker",
      sessionId: "worker-session", targetId: "worker-target", ownerTargetId: "owned-page" });
    expect(trace.recent).toContainEqual(expect.objectContaining({ method: "Network.requestWillBeSent",
      requestId: "worker-target", source: "page", sessionId: null, targetId: "owned-page" }));
    expect(trace.recent.at(-1)).toMatchObject({ method: "Network.responseReceived", requestId: "different-child-request", source: "worker" });
    expect(page.session.workerCommands.some(command => command.method === "Network.getResponseBody")).toBe(false);
    expect(page.session.calls.some(call => call.method === "Network.loadNetworkResource")).toBe(false);
  });

  test("orphan worker identity trace is bounded and redacts URL query headers body and malformed IDs", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    const targetId = "http://127.0.0.1/target?secret=target-marker";
    const sessionId = "session?secret=session-marker";
    await attachWorker(page, { targetId, sessionId });
    for (let i = 0; i < 24; i++) {
      const requestId = `recent-${i}`, url = `${ORIGIN}/data?secret=query-marker`;
      page.session.emit("Network.requestWillBeSent", { requestId, type: "Other",
        request: { url, method: "GET", headers: { authorization: "header-marker" }, postData: "body-marker" } });
      page.session.emit("Network.responseReceived", { requestId, type: "Other",
        response: { url, status: 200, headers: { "x-secret": "response-header-marker" }, mimeType: "application/octet-stream" } });
      page.session.emit("Network.loadingFinished", { requestId });
    }
    childEvent(page, "Network.responseReceived", {
      requestId: "http://127.0.0.1/request?secret=request-marker", type: "Script",
      response: { url: `${WORKER_URL}?secret=response-url-marker`, status: 200,
        headers: { authorization: "orphan-header-marker" }, body: "orphan-body-marker" },
    }, sessionId);
    const error = await observer.finish().then(() => null, error => error);
    expect(error?.message).toContain("worker response has no original owned request; identityTrace=");
    const trace = JSON.parse(error.message.split("; identityTrace=")[1]);
    expect(trace.recent).toHaveLength(32);
    expect(trace).toMatchObject({ requestId: "[redacted]", sessionId: "[redacted]", targetId: "[redacted]" });
    expect(trace.recent.some(event => event.requestId === "recent-0")).toBe(false);
    expect(trace.recent.at(-1)).toMatchObject({ method: "Network.responseReceived", source: "worker", requestId: "[redacted]" });
    expect(error.message.length).toBeLessThan(16 * 1024);
    for (const marker of ["http:", "secret=", "query-marker", "target-marker", "session-marker", "request-marker",
      "response-url-marker", "header-marker", "body-marker"]) expect(error.message).not.toContain(marker);
    for (const event of trace.recent) expect(Object.keys(event).sort()).toEqual(["method", "requestId", "sessionId", "source", "targetId"]);
  });

  test("orphan diagnostics redact overlong opaque protocol IDs instead of retaining prefixes", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page);
    childEvent(page, "Network.responseReceived", { requestId: "sensitive-prefix-" + "a".repeat(100), type: "Script",
      response: { url: WORKER_URL, status: 200, headers: {} } });
    const error = await observer.finish().then(() => null, error => error);
    expect(error?.message).toContain("worker response has no original owned request; identityTrace=");
    expect(error.message).not.toContain("sensitive-prefix-");
    expect(JSON.parse(error.message.split("; identityTrace=")[1]).requestId).toBe("[redacted]");
  });

  test("same-URL page fetch cannot replace worker initial-request identity", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); emit({ url: WORKER_URL, body: WORKER_BODY, type: "script" });
    await attachWorker(page);
    await expect(observer.finish()).rejects.toThrow(/initial response bytes/);
  });

  test("rejects initial worker cache evidence from its creator target", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page); workerMain(page, { cache: true });
    await expect(observer.finish()).rejects.toThrow(/cache/);
  });

  test("rejects worker subresource cache evidence in its own session", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page); workerMain(page);
    childEvent(page, "Network.requestWillBeSent", { requestId: "import", type: "Script", request: { url: `${ORIGIN}/import.js`, method: "GET" } });
    childEvent(page, "Network.requestServedFromCache", { requestId: "import" });
    await expect(observer.finish()).rejects.toThrow(/cache/);
  });

  test("rejects a worker attached after it was already running", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page, { waitingForDebugger: false });
    await expect(observer.finish()).rejects.toThrow(/waiting for debugger/);
  });

  test("rejects unowned target messages and unsupported nested workers", async () => {
    for (const nested of [false, true]) {
      const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
      emit(); if (nested) await attachWorker(page);
      childEvent(page, nested ? "Target.attachedToTarget" : "Network.loadingFinished", {}, nested ? "worker-session" : "unknown");
      await expect(observer.finish()).rejects.toThrow(/unowned|nested dedicated/);
    }
  });

  test("rejects target detachment before original bytes are captured", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page);
    page.session.emit("Target.detachedFromTarget", { sessionId: "worker-session" });
    await expect(observer.finish()).rejects.toThrow(/detached before frontend bytes/);
  });

  test("rejects a public worker that has no owned paused target", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); page.emit("worker", { url: () => WORKER_URL });
    await expect(observer.finish()).rejects.toThrow(/target coverage is incomplete/);
  });

  test("rejects worker traffic before cache controls have been dispatched", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    page.session.emit("Target.attachedToTarget", { sessionId: "worker-session", targetInfo: { targetId: "worker-target", type: "worker", parentId: "owned-page", url: WORKER_URL }, waitingForDebugger: true });
    childEvent(page, "Network.requestWillBeSent", { requestId: "early", type: "Script", request: { url: `${ORIGIN}/early.js`, method: "GET" } });
    await expect(observer.finish()).rejects.toThrow(/preceded owned cache controls/);
  });

  test("rejects unavailable initial bytes without page-body fallback", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page);
    page.session.childBodies.get("worker-session").clear();
    workerMain(page);
    await expect(observer.finish()).rejects.toThrow(/worker CDP command rejected/);
    expect(page.session.calls.some(call => call.method === "Network.loadNetworkResource")).toBe(false);
  });

  test("rejects changed initial-response headers during target migration", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page); workerMain(page, { complete: false });
    childEvent(page, "Network.responseReceived", { requestId: "worker-target", type: "Script",
      response: { url: WORKER_URL, status: 200, headers: { "content-length": "999" }, mimeType: "text/javascript" } });
    await expect(observer.finish()).rejects.toThrow(/metadata changed across targets/);
  });

  test("does not resume after an already-reported child control failure", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); page.session.childHandler = command => { if (command.method === "Network.enable") throw new Error("unsupported network controls"); };
    await attachWorker(page);
    await expect(observer.finish()).rejects.toThrow(/worker CDP command rejected/);
    expect(page.session.workerCommands.some(command => command.method === "Runtime.runIfWaitingForDebugger")).toBe(false);
  });

  test("worker subresource IDs cannot collide with page request IDs", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit({ requestId: "collision" }); await attachWorker(page); workerMain(page);
    const script = response(page, { url: `${ORIGIN}/import.js`, body: Buffer.from("1"), type: "script" });
    page.session.childBodies.get("worker-session").set("collision", script.ownedBody);
    childEvent(page, "Network.requestWillBeSent", { requestId: "collision", type: "Script", request: { url: script.url(), method: "GET" } });
    childEvent(page, "Network.responseReceived", { requestId: "collision", type: "Script", response: { url: script.url(), status: 200, headers: script.headers() } });
    page.emit("response", script);
    childEvent(page, "Network.loadingFinished", { requestId: "collision" });
    expect((await observer.finish()).assets).toHaveLength(3);
  });

  test("ignores redirected OCI bytes while retaining worker frontend capture", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit(); await attachWorker(page); workerMain(page);
    childEvent(page, "Network.requestWillBeSent", { requestId: "oci", type: "Fetch", request: { url: "https://registry.invalid/blob", method: "GET" } });
    childEvent(page, "Network.requestWillBeSent", { requestId: "oci", type: "Fetch", redirectResponse: { status: 307 }, request: { url: "https://blob.invalid/data", method: "GET" } });
    childEvent(page, "Network.responseReceived", { requestId: "oci", type: "Fetch", response: { url: "https://blob.invalid/data", status: 200,
      mimeType: "application/octet-stream", headers: { "content-length": "999999999" } } });
    childEvent(page, "Network.loadingFinished", { requestId: "oci" });
    expect((await observer.finish()).assets).toHaveLength(2);
    expect(page.session.workerCommands.filter(command => command.method === "Network.getResponseBody")).toHaveLength(1);
  });

  test("rejects a child with an unverified parent target", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true });
    emit();
    page.session.emit("Target.attachedToTarget", { sessionId: "foreign-child", targetInfo: { targetId: "foreign-target", type: "worker", parentId: "another-page", url: WORKER_URL }, waitingForDebugger: true });
    await expect(observer.finish()).rejects.toThrow(/not a direct child/);
  });

  test("rejects non-boolean experimental mode selection", async () => {
    await expect(setup({ experimentalDedicatedWorkers: "yes" })).rejects.toThrow(/invalid worker observation mode/);
  });

  test("bounds missing worker command replies and cleans up", async () => {
    const { page, observer, emit } = await setup({ experimentalDedicatedWorkers: true, timeoutMs: 15 });
    emit(); page.session.childHandler = () => "no-reply";
    await attachWorker(page);
    await expect(observer.finish()).rejects.toThrow(/timed out/);
    expect(page.session.listenerCount("Target.receivedMessageFromTarget")).toBe(0);
    expect(page.session.detached).toBe(true);
  });
});

test.describe("separate served-asset comparison", () => {
  async function observation() {
    const { observer, emit } = await setup(); emit(); return observer.finish();
  }
  test("checks trusted expected bytes independently of body metadata and browser globals", async () => {
    const actual = await observation();
    expect(compareFrontendAssets(actual, expected()).matchedAssets).toBe(1);
    expect(() => compareFrontendAssets(actual, expected({ [DOCUMENT]: measurement(Buffer.from("different")) })))
      .toThrow(/differ from expected/);
  });
  test("rejects a missing or extra expected asset rather than claiming unused files were loaded", async () => {
    const actual = await observation();
    expect(() => compareFrontendAssets(actual, {})).toThrow(/set mismatch/);
    expect(() => compareFrontendAssets(actual, expected({ [`${ORIGIN}/unused.js`]: measurement(WASM) }))).toThrow(/set mismatch/);
  });
  test("query strings are exact and cannot alias different navigations", async () => {
    const actual = await observation();
    expect(() => compareFrontendAssets(actual, { [`${ORIGIN}/`]: measurement(HTML) })).toThrow(/differ from expected/);
  });
  for (const mutation of [
    actual => { actual.qualification = "qualified"; },
    actual => { actual.authentication = "verified"; },
    actual => { actual.coverage = "all-targets"; },
    actual => { delete actual.coverage; },
    actual => { actual.assets[0].responseCount = 2; },
    actual => { actual.assets[0].responseCount = 0; },
    actual => { actual.assets[0].sizeBytes = Number.MAX_SAFE_INTEGER; },
    actual => { actual.assets[0].resourceType = "image"; },
    actual => { actual.assets[0].url = "https://outside.invalid/"; },
    actual => { actual.origin = "http://127.0.0.1:9999"; },
  ]) {
    test(`rejects malformed or overclaimed input ${mutation.toString()}`, async () => {
      const actual = await observation(); mutation(actual);
      expect(() => compareFrontendAssets(actual, expected())).toThrow();
    });
  }
});

for (const mode of ["page", "reject-worker", "experimental-worker"]) {
  const withWorker = mode !== "page";
  test(mode === "experimental-worker" ? "real Chromium experimental worker capture preserves initial and imported bytes" :
    withWorker ? "real Chromium rejects an uncovered worker target" :
    "real Chromium observes owned page script, stylesheet, document and tiny WASM bytes", async ({ page }) => {
  test.setTimeout(30_000);
  const http = require("node:http");
  const inputs = new Map([
    ["/", { type: "text/html", body: Buffer.from('<!doctype html><link rel="stylesheet" href="tiny.css"><script src="tiny.js"></script>') }],
    ["/tiny.css", { type: "text/css", body: Buffer.from("body { color: green; }") }],
    ["/tiny.js", { type: "text/javascript", body: Buffer.from(`
      const workerReady = ${withWorker} ? new Promise((resolve, reject) => {
        const worker = new Worker("layerworker.js");
        window.fixtureWorker = worker;
        worker.onmessage = () => { resolve(); };
        worker.onerror = reject;
      }) : Promise.resolve();
      Promise.all([workerReady, WebAssembly.instantiateStreaming(fetch("tbox.wasm"))])
        .then(() => { window.fixtureReady = true; });
    `) }],
    ["/layerworker.js", { type: "text/javascript", body: Buffer.from('importScripts("worker-import.js"); WebAssembly.instantiateStreaming(fetch("worker.wasm")).then(() => postMessage("tiny worker ready"));') }],
    ["/worker-import.js", { type: "text/javascript", body: Buffer.from('self.importedFixture = true;') }],
    ["/worker.wasm", { type: "application/wasm", body: WASM }],
    ["/tbox.wasm", { type: "application/wasm", body: WASM }],
  ]);
  const requestCounts = new Map();
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    requestCounts.set(pathname, (requestCounts.get(pathname) || 0) + 1);
    const asset = inputs.get(pathname);
    if (!asset) { response.writeHead(404, { "Content-Length": "0" }); response.end(); return; }
    response.writeHead(200, { "Content-Type": asset.type, "Content-Length": String(asset.body.length) });
    response.end(asset.body);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const documentURL = `${origin}/?fixture=loaded-bytes`;
  let observer;
  try {
    observer = await observeFrontendResponses(page, { documentURL, experimentalDedicatedWorkers: mode === "experimental-worker" });
    await page.goto(documentURL);
    await page.waitForFunction(() => window.fixtureReady === true);
    if (mode === "reject-worker") {
      await expect(observer.finish()).rejects.toThrow(/worker target is not covered/);
      return;
    }
    const observation = await observer.finish();
    const expectedAssets = Object.fromEntries([...inputs].filter(([pathname]) => withWorker ||
      !["/layerworker.js", "/worker-import.js", "/worker.wasm"].includes(pathname)).map(([pathname, asset]) => [
      pathname === "/" ? documentURL : `${origin}${pathname}`, measurement(asset.body),
    ]));
    if (withWorker) {
      // Experimental observations intentionally remain ineligible for the
      // page-only production comparator/binder until this fixture is verified.
      expect(observation.coverage).toBe("page-and-direct-dedicated-workers-experimental");
      expect(observation.assets).toHaveLength(7);
      for (const asset of observation.assets) expect(asset).toMatchObject(expectedAssets[asset.url]);
      for (const pathname of ["/layerworker.js", "/worker-import.js", "/worker.wasm"]) expect(requestCounts.get(pathname)).toBe(1);
    } else {
      expect(compareFrontendAssets(observation, expectedAssets).matchedAssets).toBe(4);
      expect(observation.coverage).toBe("page-target-only");
    }
    expect(observation.assets.find(asset => asset.url.endsWith("/tbox.wasm")))
      .toMatchObject({ resourceType: "wasm", ...measurement(WASM) });
  } finally {
    await observer?.dispose();
    await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
}
