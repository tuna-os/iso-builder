// Falsification: forged/replayed reservations, wrong sessions, changed sizes,
// late replies, unreserved large packets and aborted captures cannot yield bytes.
// Core extraction retains old page reconciliation; these mocks grant no coverage.
const { test, expect } = require("@playwright/test");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const { BodyReservations, decodedLength } = require("./owned-flat-body-reservations");
const { FlatConnection, LIMITS } = require("./owned-flat-cdp");
const { createFrontendResponseState } = require("./frontend-measurements");
class Socket extends EventEmitter {
  constructor() { super(); this.calls = []; }
  addEventListener(name, fn) { this.on(name, fn); }
  send(text) { this.calls.push(JSON.parse(text)); }
  close() {}
  reply(value) { this.emit("message", { data: JSON.stringify(value) }); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = bytes => ({ body: bytes.toString("base64"), base64Encoded: true });
function fixture(options = {}) {
  const reservations = new BodyReservations(options), socket = new Socket();
  return { reservations, socket, connection: new FlatConnection(socket, { bodyReservations: reservations }) };
}
function token(f, key = "one", size = 3, session = "worker", request = key) {
  const value = f.reservations.reserve(key, size); f.reservations.bind(value, "network", session, request); return value;
}
function reply(f, body = result(Buffer.from("abc")), overrides = {}) {
  const command = f.socket.calls.at(-1); f.socket.reply({ id: command.id, sessionId: command.sessionId, result: body, ...overrides });
}
test("reservations retain exact decoded aggregate and response-count bounds without allocating bodies", () => {
  const r = new BodyReservations(); r.reserve("first", 64 * 1024 ** 2); r.reserve("second", 32 * 1024 ** 2);
  expect(r.snapshot()).toMatchObject({ responses: 2, reservedBytes: 96 * 1024 ** 2 });
  expect(() => r.reserve("overflow", 1)).toThrow("reservation-invalid"); expect(r.snapshot().failed).toBe(true);
  const count = new BodyReservations(); for (let i = 0; i < 64; i++) count.reserve(String(i), 1);
  expect(() => count.reserve("overflow", 1)).toThrow("reservation-invalid");
});
for (const [index, options] of [{ maxResponseBytes: 67108865 }, { maxTotalBytes: 100663297 }, { maxResponses: 65 }, { maxResponses: 0 }].entries()) {
  test(`reservations reject expanded limits ${index}`, () => expect(() => new BodyReservations(options)).toThrow("limit-invalid"));
}
for (const [index, value] of ["YQ", "YR==", "YWJ=", "Y Q==", "!!!!", "YQ===", "=AAA"].entries()) {
  test(`body decoder rejects noncanonical base64 ${index}`, () => expect(() => decodedLength(value, true)).toThrow("base64-invalid"));
}
test("body decoder counts canonical base64 and UTF-8 exactly", () => {
  expect(decodedLength("YQ==", true)).toBe(1); expect(decodedLength("YWI=", true)).toBe(2); expect(decodedLength("YWJj", true)).toBe(3);
  expect(decodedLength("é", false)).toBe(2);
});
test("correlated body read uses bound original request and session", async () => {
  const f = fixture(), t = token(f); const task = f.connection.readBody(t); await tick();
  expect(f.socket.calls).toEqual([{ id: 1, method: "Network.getResponseBody", params: { requestId: "one" }, sessionId: "worker" }]);
  reply(f); await expect(task).resolves.toEqual(result(Buffer.from("abc"))); f.connection.close();
});
test("correlated reads serialize across worker sessions", async () => {
  const f = fixture(), a = token(f), b = token(f, "two", 3, "second-worker");
  const first = f.connection.readBody(a), second = f.connection.readBody(b); await tick(); expect(f.socket.calls).toHaveLength(1);
  reply(f); await first; await tick(); expect(f.socket.calls).toHaveLength(2); expect(f.socket.calls[1].sessionId).toBe("second-worker");
  reply(f); await second; expect(f.reservations.snapshot().reservedBytes).toBe(6); f.connection.close();
});
for (const [index, mutation] of [
  () => ({ sessionId: "foreign" }), () => ({ id: 999 }), () => ({ extra: "untrusted" }),
  () => ({ result: { body: "YWJj", base64Encoded: true, extra: "untrusted" } }),
  () => ({ result: result(Buffer.from("ab")) }), () => ({ result: { body: "YWJ=", base64Encoded: true } }),
].entries()) {
  test(`correlated read rejects response substitution ${index}`, async () => {
    const f = fixture(), task = f.connection.readBody(token(f)); await tick(); reply(f, undefined, mutation());
    await expect(task).rejects.toThrow("observation-failed"); expect(f.connection.failure).not.toBeNull(); f.connection.close();
  });
}
test("correlated reader refuses forged tokens and unreserved body commands", async () => {
  const f = fixture(); await expect(f.connection.send("Network.getResponseBody", { requestId: "one" }, "worker")).rejects.toThrow("reservation-required");
  await expect(f.connection.readBody({})).rejects.toThrow("capture-invalid"); expect(f.socket.calls).toHaveLength(0); f.connection.close();
});
test("duplicate reservation or capture cannot reclaim aggregate budget", async () => {
  const f = fixture(), t = token(f); const first = f.connection.readBody(t); await tick(); reply(f); await first;
  await expect(f.connection.readBody(t)).rejects.toThrow("capture-invalid"); expect(f.reservations.snapshot().reservedBytes).toBe(3);
  expect(f.socket.calls).toHaveLength(1); f.connection.close();
  const other = new BodyReservations(); other.reserve("one", 1); expect(() => other.reserve("one", 1)).toThrow("reservation-invalid");
});
test("bootstrap captures share one reservation but each fixed purpose is single-use", async () => {
  const f = fixture(), t = token(f);
  f.reservations.bind(t, "creator", "page", "fetch-original"); f.reservations.bind(t, "source", "worker", "script-original");
  for (const [kind, method] of [["creator", "Fetch.getResponseBody"], ["network", "Network.getResponseBody"], ["source", "Debugger.getScriptSource"]]) {
    const task = f.connection.readBody(t, kind); await tick(); expect(f.socket.calls.at(-1).method).toBe(method);
    reply(f, kind === "source" ? { scriptSource: "abc" } : result(Buffer.from("abc"))); await task;
  }
  expect(f.reservations.snapshot()).toMatchObject({ responses: 1, reservedBytes: 3 }); f.connection.close();
});
test("late body after connection disposal cannot succeed", async () => {
  const f = fixture(), task = f.connection.readBody(token(f)); await tick(); f.connection.close(); reply(f);
  await expect(task).rejects.toThrow("observation-failed"); expect(f.reservations.snapshot().failed).toBe(true);
});
test("reserved body may exceed tiny message cap without enlarging default connection", async () => {
  const f = fixture(), bytes = Buffer.alloc(200000, 65), task = f.connection.readBody(token(f, "large", bytes.length));
  await tick(); reply(f, result(bytes)); await expect(task).resolves.toEqual(result(bytes)); f.connection.close();
  const socket = new Socket(), ordinary = new FlatConnection(socket); socket.reply({ method: "event", params: { padding: "x".repeat(LIMITS.frameBytes) } });
  expect(ordinary.failure.message).toBe("owned-cdp:frame-bound"); ordinary.close();
});
test("large non-body replies and events remain rejected with reservations enabled", async () => {
  const f = fixture(), task = f.connection.send("Network.enable", {}, "worker");
  reply(f, { padding: "x".repeat(LIMITS.frameBytes) }); await expect(task).rejects.toThrow("unreserved-large-reply"); f.connection.close();
  const other = fixture(); other.socket.reply({ method: "Network.event", params: { padding: "x".repeat(LIMITS.frameBytes) } });
  expect(other.connection.failure.message).toBe("owned-cdp:unreserved-large-event"); other.connection.close();
});
test("extracted byte core reads original owned bytes through correlated reservation", async () => {
  const f = fixture(), bytes = Buffer.from("tiny script"), url = "http://127.0.0.1:1234/app.js";
  const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", readBody: (key, size) => f.connection.readBody(token(f, key, size, "owned-page", key)) });
  core.accept("Network.requestWillBeSent", { requestId: "original", type: "Script", request: { url, method: "GET" } });
  core.accept("Network.responseReceived", { requestId: "original", type: "Script", response: { url, status: 200, headers: { "content-length": String(bytes.length) } } });
  core.accept("Network.loadingFinished", { requestId: "original" }); await tick(); expect(f.socket.calls[0].params.requestId).toBe("original");
  reply(f, result(bytes)); await core.drain();
  expect(core.snapshot().assets).toEqual([{ url, resourceType: "script", sizeBytes: bytes.length, responseCount: 1,
    sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` }]);
  expect(core.snapshot()).not.toHaveProperty("coverage"); core.dispose(); f.connection.close();
});
test("extracted core fails on missing original response and on external abort", async () => {
  let reads = 0; const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", readBody: () => { reads++; } });
  core.accept("Network.requestWillBeSent", { requestId: "original", type: "Script", request: { url: "http://127.0.0.1:1234/a.js", method: "GET" } });
  core.accept("Network.loadingFinished", { requestId: "original" }); await core.drain();
  expect(() => core.snapshot()).toThrow("without an owned response"); expect(reads).toBe(0); core.dispose();
});

test("standalone byte core fails closed on a non-Error reader rejection", async () => {
  const url = "http://127.0.0.1:1234/a.js";
  const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", readBody: async () => { throw null; } });
  core.accept("Network.requestWillBeSent", { requestId: "original", type: "Script", request: { url, method: "GET" } });
  core.accept("Network.responseReceived", { requestId: "original", type: "Script", response: { url, status: 200, headers: { "content-length": "1" } } });
  core.accept("Network.loadingFinished", { requestId: "original" }); await core.drain();
  expect(() => core.snapshot()).toThrow(); core.dispose();
});

function simpleCore(readBody, onFailure) {
  const url = "http://127.0.0.1:1234/a.js";
  const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", readBody, onFailure });
  core.accept("Network.requestWillBeSent", { requestId: "original", type: "Script", request: { url, method: "GET" } });
  core.accept("Network.responseReceived", { requestId: "original", type: "Script", response: { url, status: 200, headers: { "content-length": "1" } } });
  core.accept("Network.loadingFinished", { requestId: "original" }); return core;
}
test("standalone core snapshot rejects queued and active body reads", async () => {
  let resolve; const core = simpleCore(() => new Promise(done => { resolve = done; }));
  expect(() => core.snapshot()).toThrow("still pending"); await tick(); expect(() => core.snapshot()).toThrow("still pending");
  resolve(result(Buffer.from("a"))); await core.drain(); expect(core.snapshot().assets).toHaveLength(1); core.dispose();
  expect(() => core.snapshot()).toThrow("already disposed");
});
test("standalone core abort rejects pending completion and later snapshots", async () => {
  let resolve; const core = simpleCore(() => new Promise(done => { resolve = done; })); await tick(); core.abort();
  expect(() => core.snapshot()).toThrow("observation aborted"); resolve(result(Buffer.from("a"))); await core.drain();
  expect(() => core.snapshot()).toThrow("observation aborted"); core.dispose();
});
test("standalone core keeps first failure when failure callback throws", async () => {
  const original = new Error("original fixed failure");
  const core = simpleCore(async () => { throw original; }, () => { throw new Error("callback failure"); });
  await core.drain(); expect(() => core.snapshot()).toThrow(original); core.dispose();
});
test("standalone core rejects null reader and latches null abort", () => {
  expect(() => createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", readBody: null })).toThrow("invalid frontend byte reader");
  const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", readBody: async () => result(Buffer.from("a")) });
  core.abort(null); expect(() => core.snapshot()).toThrow("null"); core.dispose();
});

test("session-scoped core cannot alias equal raw request IDs from distinct targets", async () => {
  const seen = [], bytes = { page: Buffer.from("a"), worker: Buffer.from("b") };
  const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", requestIdentity: "session-scoped",
    readBody: async (key, size, source) => { seen.push({ key, size, source }); return result(bytes[source.sessionId]); } });
  for (const session of ["page", "worker"]) {
    const url = `http://127.0.0.1:1234/${session}.js`;
    core.accept("Network.requestWillBeSent", { requestId: "same", type: "Script", request: { url, method: "GET" } }, session);
    core.accept("Network.responseReceived", { requestId: "same", type: "Script", response: { url, status: 200, headers: { "content-length": "1" } } }, session);
    core.accept("Network.loadingFinished", { requestId: "same" }, session);
  }
  await core.drain(); expect(core.snapshot().assets).toHaveLength(2); expect(seen[0].key).not.toBe(seen[1].key);
  expect(seen.map(value => value.source)).toEqual([{ sessionId: "page", requestId: "same" }, { sessionId: "worker", requestId: "same" }]); core.dispose();
});
test("session-scoped core rejects missing source session instead of using raw ID", () => {
  const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", requestIdentity: "session-scoped", readBody: async () => result(Buffer.from("a")) });
  core.accept("Network.loadingFinished", { requestId: "same" }); expect(() => core.snapshot()).toThrow("missing owned frontend session/request identity"); core.dispose();
});

for (const changed of [false, true]) {
  test(`session-scoped core rejects active request replay changedURL=${changed}`, () => {
    const core = createFrontendResponseState({ documentURL: "http://127.0.0.1:1234/", requestIdentity: "session-scoped", readBody: async () => result(Buffer.from("a")) });
    const request = { requestId: "same", type: "Script", request: { url: "http://127.0.0.1:1234/a.js", method: "GET" } };
    core.accept("Network.requestWillBeSent", request, "worker");
    core.accept("Network.requestWillBeSent", { ...request, request: { ...request.request, url: changed ? "http://127.0.0.1:1234/b.js" : request.request.url } }, "worker");
    expect(() => core.snapshot()).toThrow("reused active frontend request identity"); core.dispose();
  });
}
