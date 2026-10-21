// Exploratory protocol fixture only. This does not replace the frontend collector
// or emit a qualification record. Falsification: wrong original request/target,
// foreign parent, duplicate pause, missing metadata/body, cache/SW evidence and
// oversized bodies must never produce a successful capture result.
const { test, expect } = require("@playwright/test");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");

const BODY = Buffer.from('postMessage("bootstrap fetched");');
const MAX_BYTES = 4096;
const TIMEOUT_MS = 3000;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

async function cleanupFixture(page, session, server, timeoutMs = 1000) {
  for (const action of [() => page.close(), () => session?.detach(),
    () => server.closeAllConnections(), () => new Promise(resolve => server.close(resolve))]) {
    try { await bounded(Promise.resolve().then(action), timeoutMs); } catch { /* Try every teardown. */ }
  }
}

// All output fields are fixed labels, booleans, bounded counts or digest values.
// URLs, headers, protocol error messages and bodies stay out of diagnostics.
function bootstrapProbe(session, workerURL, expectedBody, timeoutMs = TIMEOUT_MS) {
  let owner, originalId, fetchId, targetId, bodyTask, errorCode = null;
  let pauses = 0, requests = 0, attachments = 0, closed = false;
  const listeners = [];
  const facts = {
    networkEnabled: false, cacheDisabledAcknowledged: false, bypassServiceWorkerAcknowledged: false,
    fetchEnabledBeforeNavigation: false, originalRequestSeen: false, responseStageSeen: false,
    fetchNetworkIdMatched: false, directWorkerParentMatched: false, workerTargetMatched: false,
    bodyReadOnCreatorFetchSession: false, bodyMatchesExpected: false, bodyBytes: 0,
    continuedWithoutOverrides: false, networkResponseSeen: false,
    fromDiskCache: null, fromPrefetchCache: null, fromServiceWorker: null,
  };
  const fail = code => { errorCode ||= code; };
  const send = async (method, params, code, deadline) => {
    try {
      if (closed || Date.now() >= deadline) throw new Error("deadline");
      return await bounded(session.send(method, params), deadline - Date.now());
    } catch { fail(code); throw new Error(code); }
  };
  const on = (method, listener) => {
    const guarded = event => { if (!closed && !errorCode) { try { listener(event); } catch { fail("event-shape-invalid"); } } };
    session.on(method, guarded); listeners.push([method, guarded]);
  };
  on("Network.requestWillBeSent", event => {
    if (++requests > 16) { fail("request-bound-exceeded"); return; }
    // The URL selects the controlled fixture. Ownership is established only by
    // the exact original request ID, Fetch networkId and attached worker token.
    if (event.request?.url !== workerURL) return;
    if (originalId || event.redirectResponse || event.request.method !== "GET" || typeof event.requestId !== "string") {
      fail("original-request-invalid"); return;
    }
    originalId = event.requestId; facts.originalRequestSeen = true;
  });
  on("Network.responseReceived", event => {
    if (event.requestId !== originalId) return;
    if (facts.networkResponseSeen) { fail("duplicate-network-response"); return; }
    facts.networkResponseSeen = true;
    for (const name of ["fromDiskCache", "fromPrefetchCache", "fromServiceWorker"]) {
      facts[name] = typeof event.response?.[name] === "boolean" ? event.response[name] : null;
      if (facts[name] === true) fail("cache-or-service-worker-observed");
    }
  });
  on("Network.requestServedFromCache", event => {
    if (event.requestId === originalId) fail("cache-or-service-worker-observed");
  });
  on("Target.attachedToTarget", event => {
    if (++attachments > 1 || event.targetInfo?.type !== "worker" || typeof event.targetInfo.targetId !== "string") {
      fail("worker-target-invalid"); return;
    }
    if (event.targetInfo.parentId !== owner) { fail("worker-parent-mismatch"); return; }
    facts.directWorkerParentMatched = true; targetId = event.targetInfo.targetId;
  });
  on("Fetch.requestPaused", event => {
    if (++pauses > 1) { fail("duplicate-fetch-pause"); return; }
    if (!originalId || event.networkId !== originalId || typeof event.requestId !== "string") {
      fail("fetch-original-identity-mismatch"); return;
    }
    facts.fetchNetworkIdMatched = true;
    if (event.responseStatusCode !== 200 || event.responseErrorReason || event.redirectedRequestId ||
        !Array.isArray(event.responseHeaders) || event.responseHeaders.length > 32) { fail("fetch-response-invalid"); return; }
    const headers = new Map();
    for (const header of event.responseHeaders) {
      if (typeof header.name !== "string" || typeof header.value !== "string" || header.name.length > 256 || header.value.length > 256 || headers.has(header.name.toLowerCase())) {
        fail("fetch-headers-invalid"); return;
      }
      headers.set(header.name.toLowerCase(), header.value);
    }
    if (headers.get("content-length") !== String(expectedBody.length) || expectedBody.length > MAX_BYTES ||
        headers.has("content-encoding") || headers.has("content-range") || headers.has("transfer-encoding")) {
      fail("fetch-size-or-encoding-invalid"); return;
    }
    facts.responseStageSeen = true; fetchId = event.requestId;
    bodyTask = (async () => {
      // Read on the SAME creator session using the opaque Fetch interception ID,
      // never a URL, Network ID, page body fallback or another network request.
      const deadline = Date.now() + timeoutMs;
      const result = await send("Fetch.getResponseBody", { requestId: fetchId }, "fetch-body-command-failed", deadline);
      if (errorCode || closed) return;
      if (typeof result?.body !== "string" || typeof result.base64Encoded !== "boolean" ||
          result.body.length > MAX_BYTES * 2) { fail("fetch-body-invalid"); return; }
      const bytes = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
      if (result.base64Encoded && bytes.toString("base64") !== result.body) { fail("fetch-body-invalid"); return; }
      facts.bodyReadOnCreatorFetchSession = true; facts.bodyBytes = Math.min(bytes.length, MAX_BYTES + 1);
      if (bytes.length !== expectedBody.length || digest(bytes) !== digest(expectedBody)) { fail("fetch-body-mismatch"); return; }
      facts.bodyMatchesExpected = true;
      // getResponseBody must finish before continuing. Do not replace headers or
      // fulfill with synthetic bytes. The original buffered response continues.
      await send("Fetch.continueRequest", { requestId: fetchId }, "fetch-continue-failed", deadline);
      facts.continuedWithoutOverrides = true;
    })().catch(() => {});
  });
  return {
    async start() {
      const deadline = Date.now() + timeoutMs;
      const setupSend = (method, params, code) => send(method, params, code, deadline);
      try {
        const info = await setupSend("Target.getTargetInfo", {}, "owner-command-failed");
        if (info?.targetInfo?.type !== "page" || typeof info.targetInfo.targetId !== "string") { fail("owner-invalid"); return; }
        owner = info.targetInfo.targetId;
        await setupSend("Network.enable", { maxTotalBufferSize: 16384, maxResourceBufferSize: MAX_BYTES }, "network-enable-failed");
        facts.networkEnabled = true;
        await setupSend("Network.setCacheDisabled", { cacheDisabled: true }, "cache-control-failed");
        facts.cacheDisabledAcknowledged = true;
        await setupSend("Network.setBypassServiceWorker", { bypass: true }, "service-worker-control-failed");
        facts.bypassServiceWorkerAcknowledged = true;
        // This experiment obtains identity only. It makes no debugger-pause or
        // worker Network.enable claim and creates no child-session transport.
        await setupSend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false,
          filter: [{ type: "worker" }, { exclude: true }] }, "auto-attach-failed");
        await setupSend("Fetch.enable", { patterns: [{ urlPattern: workerURL, requestStage: "Response" }] }, "fetch-enable-failed");
        facts.fetchEnabledBeforeNavigation = true;
      } catch { /* send retained a fixed stage code, never arbitrary error text. */ }
    },
    fail,
    async result(workerMessageReceived, serverRequests) {
      await bodyTask;
      facts.workerTargetMatched = !!originalId && targetId === originalId;
      if (!errorCode && (!facts.bodyMatchesExpected || !facts.continuedWithoutOverrides)) fail("capture-incomplete");
      if (!errorCode && !facts.workerTargetMatched) fail("worker-target-mismatch");
      if (!errorCode && workerMessageReceived !== true) fail("worker-execution-unobserved");
      if (!errorCode && serverRequests !== 1) fail("original-request-count-mismatch");
      return Object.freeze({ experiment: "creator-fetch-worker-bootstrap", qualification: "not-assessed",
        captureSucceeded: !errorCode, failureCode: errorCode, facts: Object.freeze({ ...facts }),
        workerMessageReceived: workerMessageReceived === true, serverRequests: Math.min(Math.max(serverRequests || 0, 0), 17),
        cacheServiceWorkerEvidence: facts.networkResponseSeen && [facts.fromDiskCache, facts.fromPrefetchCache, facts.fromServiceWorker].every(value => value === false)
          ? "explicit-network-flags" : "unavailable-or-incomplete",
        // Even explicit flags here would cover only this bootstrap probe. The
        // production collector's whole-frontend proof is intentionally absent.
        collectorProof: "not-established" });
    },
    stop() { closed = true; for (const [method, listener] of listeners) session.removeListener(method, listener); },
  };
}

class MockFetchSession extends EventEmitter {
  constructor() { super(); this.calls = []; }
  async send(method, params) {
    this.calls.push({ method, params });
    if (this.override) { const result = await this.override(method, params); if (result !== undefined) return result; }
    if (method === "Target.getTargetInfo") return { targetInfo: { type: "page", targetId: "owner" } };
    if (method === "Fetch.getResponseBody") return { body: BODY.toString("base64"), base64Encoded: true };
    return {};
  }
}
async function mockedProbe(change = () => {}, override, timeoutMs = 1000) {
  const session = new MockFetchSession(); session.override = override;
  const probe = bootstrapProbe(session, "http://127.0.0.1:1/bootstrap.js", BODY, timeoutMs);
  await probe.start();
  const request = { requestId: "worker-token", request: { url: "http://127.0.0.1:1/bootstrap.js", method: "GET" } };
  const pause = { requestId: "fetch-interception", networkId: "worker-token", responseStatusCode: 200,
    responseHeaders: [{ name: "Content-Length", value: String(BODY.length) }] };
  const target = { targetInfo: { type: "worker", targetId: "worker-token", parentId: "owner" } };
  change({ request, pause, target });
  session.emit("Network.requestWillBeSent", request); session.emit("Fetch.requestPaused", pause);
  session.emit("Target.attachedToTarget", target);
  return { session, probe };
}

test.describe("creator Fetch exploratory fixture logic", () => {
  test("binds exact IDs and owned bytes while leaving missing cache facts unavailable", async () => {
    const { session, probe } = await mockedProbe();
    const result = await probe.result(true, 1); probe.stop();
    expect(result).toMatchObject({ captureSucceeded: true, cacheServiceWorkerEvidence: "unavailable-or-incomplete", collectorProof: "not-established" });
    expect(session.calls.filter(call => call.method.startsWith("Fetch."))).toEqual([
      { method: "Fetch.enable", params: { patterns: [{ urlPattern: "http://127.0.0.1:1/bootstrap.js", requestStage: "Response" }] } },
      { method: "Fetch.getResponseBody", params: { requestId: "fetch-interception" } },
      { method: "Fetch.continueRequest", params: { requestId: "fetch-interception" } },
    ]);
    expect(Object.isFrozen(result.facts)).toBe(true);
  });
  for (const [name, change, code] of [
    ["wrong original identity", ({ pause }) => { pause.networkId = "another-request"; }, "fetch-original-identity-mismatch"],
    ["missing original identity", ({ pause }) => { delete pause.networkId; }, "fetch-original-identity-mismatch"],
    ["foreign parent", ({ target }) => { target.targetInfo.parentId = "foreign"; }, "worker-parent-mismatch"],
    ["wrong worker token", ({ target }) => { target.targetInfo.targetId = "another-worker"; }, "worker-target-mismatch"],
    ["redirect", ({ pause }) => { pause.responseStatusCode = 302; }, "fetch-response-invalid"],
    ["missing response metadata", ({ pause }) => { delete pause.responseHeaders; }, "fetch-response-invalid"],
    ["wrong size", ({ pause }) => { pause.responseHeaders[0].value = "99999999"; }, "fetch-size-or-encoding-invalid"],
    ["duplicate header", ({ pause }) => { pause.responseHeaders.push({ ...pause.responseHeaders[0] }); }, "fetch-headers-invalid"],
    ["malformed header", ({ pause }) => { pause.responseHeaders[0].value = null; }, "fetch-headers-invalid"],
  ]) test(`rejects ${name}`, async () => {
    const { probe } = await mockedProbe(change); expect((await probe.result(true, 1)).failureCode).toBe(code); probe.stop();
  });
  for (const signal of ["fromDiskCache", "fromPrefetchCache", "fromServiceWorker"]) test(`does not erase ${signal}`, async () => {
    const { session, probe } = await mockedProbe();
    session.emit("Network.responseReceived", { requestId: "worker-token", response: { [signal]: true } });
    expect((await probe.result(true, 1)).failureCode).toBe("cache-or-service-worker-observed"); probe.stop();
  });
  for (const body of ["wrong", "x".repeat(MAX_BYTES * 2 + 1)]) test(`rejects invalid body of size ${body.length}`, async () => {
    const { probe } = await mockedProbe(() => {}, method => method === "Fetch.getResponseBody" ? { body, base64Encoded: false } : undefined);
    expect((await probe.result(true, 1)).captureSucceeded).toBe(false); probe.stop();
  });
  test("bounds body wait and redacts arbitrary protocol errors", async () => {
    for (const pending of [false, true]) {
      const { probe } = await mockedProbe(() => {}, method => {
        if (method === "Fetch.getResponseBody") { if (pending) return new Promise(() => {}); throw new Error("https://secret.invalid/?token=private headers body"); }
      }, 15);
      const result = await probe.result(true, 1); probe.stop();
      expect(result.failureCode).toBe("fetch-body-command-failed");
      expect(JSON.stringify(result)).not.toMatch(/secret|private|https:|headers body/);
    }
  });
  test("bounds setup and rejects a failed continuation without leaking protocol text", async () => {
    for (const method of ["Network.enable", "Fetch.continueRequest"]) {
      const { probe } = await mockedProbe(() => {}, called => {
        if (called === method) {
          if (method === "Network.enable") return new Promise(() => {});
          throw new Error("https://secret.invalid/?token=private headers body");
        }
      }, 15);
      const result = await probe.result(true, 1); probe.stop();
      expect(result.failureCode).toBe(method === "Network.enable" ? "network-enable-failed" : "fetch-continue-failed");
      expect(JSON.stringify(result)).not.toMatch(/secret|private|https:|headers body/);
    }
  });
  test("bounds teardown and still closes the server after stuck page and session cleanup", async () => {
    const calls = [];
    await cleanupFixture({ close: () => { calls.push("page"); return new Promise(() => {}); } },
      { detach: () => { calls.push("session"); return new Promise(() => {}); } },
      { closeAllConnections: () => calls.push("connections"), close: done => { calls.push("server"); done(); } }, 5);
    expect(calls).toEqual(["page", "session", "connections", "server"]);
  });
  test("rejects noncanonical base64 and request overflow", async () => {
    const malformed = await mockedProbe(() => {}, method => method === "Fetch.getResponseBody" ?
      { body: BODY.toString("base64") + "!", base64Encoded: true } : undefined);
    expect((await malformed.probe.result(true, 1)).failureCode).toBe("fetch-body-invalid"); malformed.probe.stop();
    const overflow = await mockedProbe();
    for (let n = 0; n < 16; n++) overflow.session.emit("Network.requestWillBeSent", { request: { url: "ignored" } });
    expect((await overflow.probe.result(true, 1)).failureCode).toBe("request-bound-exceeded"); overflow.probe.stop();
  });
  test("only actual explicit flags change cache evidence availability", async () => {
    const { session, probe } = await mockedProbe();
    session.emit("Network.responseReceived", { requestId: "worker-token", response: {
      fromDiskCache: false, fromPrefetchCache: false, fromServiceWorker: false,
    } });
    expect(await probe.result(true, 1)).toMatchObject({ captureSucceeded: true,
      cacheServiceWorkerEvidence: "explicit-network-flags", collectorProof: "not-established" }); probe.stop();
  });
  test("rejects missing attachment even after owned body capture", async () => {
    const session = new MockFetchSession();
    const probe = bootstrapProbe(session, "http://127.0.0.1:1/bootstrap.js", BODY, 1000); await probe.start();
    session.emit("Network.requestWillBeSent", { requestId: "worker-token", request: { url: "http://127.0.0.1:1/bootstrap.js", method: "GET" } });
    session.emit("Fetch.requestPaused", { requestId: "fetch", networkId: "worker-token", responseStatusCode: 200,
      responseHeaders: [{ name: "Content-Length", value: String(BODY.length) }] });
    expect((await probe.result(true, 1)).failureCode).toBe("worker-target-mismatch"); probe.stop();
  });
  test("rejects duplicate pause and unexpected server replay", async () => {
    const { session, probe } = await mockedProbe(); session.emit("Fetch.requestPaused", {});
    expect((await probe.result(true, 1)).failureCode).toBe("duplicate-fetch-pause"); probe.stop();
    const second = await mockedProbe(); expect((await second.probe.result(true, 2)).failureCode).toBe("original-request-count-mismatch"); second.probe.stop();
  });
});

test("real Chromium explores creator Fetch ownership of worker bootstrap", async ({ page, browser }) => {
  test.setTimeout(15_000);
  const http = require("node:http");
  let serverRequests = 0, probe, session, workerMessageReceived = false;
  const server = http.createServer((request, response) => {
    if (request.url === "/bootstrap.js") {
      serverRequests++; response.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": String(BODY.length), "Cache-Control": "no-store" }); response.end(BODY);
    } else if (request.url === "/") {
      const html = Buffer.from('<!doctype html><script>window.fixtureWorker = new Worker("bootstrap.js"); fixtureWorker.onmessage = e => { window.bootstrapMessage = e.data; };</script>');
      response.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(html.length), "Cache-Control": "no-store" }); response.end(html);
    } else { response.writeHead(404, { "Content-Length": "0" }); response.end(); }
  });
  let result;
  try {
    await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 1000);
    const origin = `http://127.0.0.1:${server.address().port}`;
    session = await bounded(page.context().newCDPSession(page), 1000);
    probe = bootstrapProbe(session, `${origin}/bootstrap.js`, BODY);
    await probe.start();
    try {
      await page.goto(`${origin}/`, { timeout: 2000 });
      await page.waitForFunction(() => window.bootstrapMessage === "bootstrap fetched", undefined, { timeout: 2000 });
      workerMessageReceived = true;
    } catch { probe.fail("fixture-operation-incomplete"); }
    result = await probe.result(workerMessageReceived, serverRequests);
  } catch {
    probe?.fail("fixture-setup-incomplete");
    if (probe) result = await probe.result(workerMessageReceived, serverRequests);
  } finally {
    // On pending/failed body reads, closing the target aborts the fixture. Do not
    // disable Fetch or continue a request while getResponseBody is incomplete.
    probe?.stop();
    const version = browser.version();
    console.log("worker-bootstrap-fetch-exploration=" + JSON.stringify({
      browserVersion: /^\d+(?:\.\d+){3}$/.test(version) ? version : "unavailable",
      ...(result || { experiment: "creator-fetch-worker-bootstrap", captureSucceeded: false, failureCode: "fixture-setup-incomplete", qualification: "not-assessed", collectorProof: "not-established" }),
    }));
    // Attempt every teardown even if an earlier operation never settles. The
    // sanitized result is already printed, including on incomplete capture.
    await cleanupFixture(page, session, server);
  }
  expect(result?.captureSucceeded, "see sanitized worker-bootstrap-fetch-exploration diagnostic").toBe(true);
});
