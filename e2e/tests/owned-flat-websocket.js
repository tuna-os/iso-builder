// Explicit public ws transport proposal. Endpoint ownership remains the launcher's
// responsibility; neither a URL nor this client proves browser/process ownership.
const { EventEmitter } = require("node:events");

const SOCKET_LIMITS = Object.freeze({
  tinyMessageBytes: 256 * 1024,
  decodedAssetBytes: 64 * 1024 * 1024,
  totalDecodedBytes: 96 * 1024 * 1024,
  envelopeBytes: 64 * 1024,
  messageBytes: 4 * Math.ceil((64 * 1024 * 1024) / 3) + 64 * 1024,
  fragments: 16384, bufferedChunks: 262144, handshakeMs: 3000, closeMs: 1000,
});
const failure = code => new Error(`owned-ws:${code}`);
const EVENTS = new Set(["open", "message", "error", "close"]);
const RECEIVE_ERRORS = Object.freeze({
  WS_ERR_UNSUPPORTED_MESSAGE_LENGTH: "message-bound",
  WS_ERR_TOO_MANY_BUFFERED_PARTS: "parts-bound",
  WS_ERR_INVALID_UTF8: "invalid-utf8",
  WS_ERR_UNEXPECTED_RSV_1: "unexpected-compression",
});

function socketOptions(overrides = {}) {
  const caps = { maxPayload: SOCKET_LIMITS.tinyMessageBytes, maxFragments: SOCKET_LIMITS.fragments,
    maxBufferedChunks: SOCKET_LIMITS.bufferedChunks, handshakeTimeout: SOCKET_LIMITS.handshakeMs,
    closeTimeout: SOCKET_LIMITS.closeMs };
  const ceilings = { ...caps, maxPayload: SOCKET_LIMITS.messageBytes };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(caps, key) || !Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) {
      throw failure("limit-invalid");
    }
    caps[key] = value;
  }
  return Object.freeze({ ...caps, perMessageDeflate: false, followRedirects: false,
    skipUTF8Validation: false, maxHeaderSize: 16 * 1024 });
}
function endpointURL(endpoint) {
  if (!endpoint || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
      typeof endpoint.inode !== "string" || !/^[1-9][0-9]{0,19}$/.test(endpoint.inode) ||
      typeof endpoint.url !== "string" || !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/devtools\/browser\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(endpoint.url) ||
      new URL(endpoint.url).port !== String(endpoint.port)) throw failure("endpoint-invalid");
  return endpoint.url;
}
function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure("close-timeout")), ms);
  })]).finally(() => clearTimeout(timer));
}

class OwnedSocket extends EventEmitter {
  constructor(endpoint, overrides, WebSocketClient) {
    super();
    // EventEmitter's special error semantics must never expose raw ws errors,
    // including errors before the consumer has installed its own listener.
    this.on("error", () => {});
    const url = endpointURL(endpoint);
    this.options = socketOptions(overrides);
    this.failure = null; this.opened = false; this.closing = false; this.didClose = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    try { this.raw = new WebSocketClient(url, this.options); }
    catch { this.fail("connect-failed"); return; }
    this.raw.on("open", () => {
      if (this.closing || this.failure) return;
      if (this.raw.url !== url || this.raw.extensions !== "" || this.raw.protocol !== "") {
        this.fail("handshake-mismatch"); return;
      }
      this.opened = true; this.resolveReady(); this.emit("open", Object.freeze({}));
    });
    this.raw.on("message", (data, isBinary) => {
      if (this.closing || this.failure) return;
      if (!this.opened || isBinary !== false || !Buffer.isBuffer(data)) { this.fail("message-type-invalid"); return; }
      if (data.length > this.options.maxPayload) { this.fail("message-bound"); return; }
      // ws has already enforced cumulative frame/fragment/chunk bounds and UTF-8.
      // Conversion/JSON parsing still allocate; maxPayload is not a process RSS cap.
      this.emit("message", Object.freeze({ data: data.toString("utf8") }));
    });
    this.raw.on("error", error => this.fail(RECEIVE_ERRORS[error?.code] || "transport-error"));
    this.raw.on("close", () => {
      this.didClose = true;
      if (!this.closing && !this.failure) this.fail("transport-closed");
      this.rejectReady(this.failure || failure("transport-closed"));
      this.resolveClosed(); this.emit("close", Object.freeze({}));
    });
  }
  get url() { return this.raw?.url; }
  addEventListener(name, listener, options = {}) {
    if (!EVENTS.has(name) || typeof listener !== "function") throw failure("listener-invalid");
    if (options.once) this.once(name, listener); else this.on(name, listener);
  }
  removeEventListener(name, listener) { this.off(name, listener); }
  fail(code) {
    if (this.failure) return;
    this.failure = failure(code); this.rejectReady(this.failure);
    this.emit("error", Object.freeze({ error: this.failure }));
    try { this.raw?.terminate(); } catch { /* Owned process cleanup is still required. */ }
  }
  send(text) {
    if (this.failure || this.closing || !this.opened) throw failure("send-unavailable");
    if (typeof text !== "string" || Buffer.byteLength(text) > SOCKET_LIMITS.tinyMessageBytes) throw failure("command-bound");
    try { this.raw.send(text, error => { if (error) this.fail("send-failed"); }); }
    catch { this.fail("send-failed"); throw this.failure; }
  }
  close() { this.dispose().catch(() => {}); }
  dispose() {
    return this.disposal ||= (async () => {
      this.closing = true; this.rejectReady(failure("transport-disposed"));
      if (!this.raw || this.didClose) return;
      try { this.raw.close(); } catch { try { this.raw.terminate(); } catch {} }
      try { await bounded(this.closed, this.options.closeTimeout); }
      catch {
        try { this.raw.terminate(); } catch { throw failure("close-failed"); }
        await bounded(this.closed, this.options.closeTimeout);
      }
    })();
  }
}
function connectOwnedSocket(endpoint, options = {}, WebSocketClient = require("ws")) {
  return new OwnedSocket(endpoint, options, WebSocketClient);
}

module.exports = { SOCKET_LIMITS, socketOptions, endpointURL, connectOwnedSocket };
