// Host-side byte accounting/correlation only. Callers still must validate actual
// target ownership and response metadata before reserving or binding a capture.
const { SOCKET_LIMITS } = require("./owned-flat-websocket");
const METHODS = Object.freeze({ network: "Network.getResponseBody", creator: "Fetch.getResponseBody", source: "Debugger.getScriptSource" });
const bad = code => new Error(`owned-body:${code}`);
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256;
function decodedLength(body, base64) {
  if (typeof body !== "string" || typeof base64 !== "boolean") throw bad("shape-invalid");
  if (!base64) return Buffer.byteLength(body, "utf8");
  if (body.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) throw bad("base64-invalid");
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  if (padding) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(body[body.length - padding - 1]);
    if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) throw bad("base64-invalid");
  }
  return body.length / 4 * 3 - padding;
}
class BodyReservations {
  #tokens = new WeakMap(); #keys = new Set(); #queue = Promise.resolve(); #active = null; #failure = null; #bytes = 0;
  constructor({ maxResponseBytes = SOCKET_LIMITS.decodedAssetBytes, maxTotalBytes = SOCKET_LIMITS.totalDecodedBytes, maxResponses = 64 } = {}) {
    for (const [value, cap] of [[maxResponseBytes, SOCKET_LIMITS.decodedAssetBytes], [maxTotalBytes, SOCKET_LIMITS.totalDecodedBytes], [maxResponses, 64]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw bad("limit-invalid");
    }
    Object.defineProperty(this, "limits", { value: Object.freeze({ maxResponseBytes, maxTotalBytes, maxResponses }) });
  }
  reserve(key, sizeBytes) {
    if (this.#failure) throw this.#failure;
    if (!id(key) || this.#keys.has(key) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > this.limits.maxResponseBytes ||
        this.#keys.size >= this.limits.maxResponses || this.#bytes + sizeBytes > this.limits.maxTotalBytes) { this.abort(); throw bad("reservation-invalid"); }
    const token = Object.freeze({}); this.#tokens.set(token, { sizeBytes, captures: new Map() });
    this.#keys.add(key); this.#bytes += sizeBytes; return token;
  }
  bind(token, kind, sessionId, requestId) {
    const entry = this.#tokens.get(token);
    if (this.#failure) throw this.#failure;
    if (!entry || !Object.hasOwn(METHODS, kind) || entry.captures.has(kind) || !id(sessionId) || !id(requestId)) { this.abort(); throw bad("binding-invalid"); }
    entry.captures.set(kind, { method: METHODS[kind], sessionId, requestId, used: false });
  }
  ownsActive(token, kind) { return this.#active?.token === token && this.#active?.kind === kind && !this.#failure; }
  validate(token, kind, result) {
    const entry = this.#tokens.get(token);
    if (!entry || !this.ownsActive(token, kind) || !result || typeof result !== "object" || Array.isArray(result)) throw bad("reply-invalid");
    const fields = Object.keys(result).sort().join(",");
    let length;
    if (kind === "source") {
      if (fields !== "scriptSource") throw bad("reply-invalid");
      if (typeof result.scriptSource !== "string" || result.scriptSource.length > entry.sizeBytes) throw bad("size-mismatch");
      length = decodedLength(result.scriptSource, false);
    } else {
      if (fields !== "base64Encoded,body") throw bad("reply-invalid");
      if (typeof result.body !== "string" || result.body.length > (result.base64Encoded ? 4 * Math.ceil(entry.sizeBytes / 3) : entry.sizeBytes)) throw bad("size-mismatch");
      length = decodedLength(result.body, result.base64Encoded);
    }
    if (length !== entry.sizeBytes || length > this.limits.maxResponseBytes) throw bad("size-mismatch");
    return result;
  }
  read(token, kind, send) {
    const entry = this.#tokens.get(token), capture = entry?.captures.get(kind);
    if (this.#failure) return Promise.reject(this.#failure);
    if (!capture || capture.used || typeof send !== "function") { this.abort(); return Promise.reject(bad("capture-invalid")); }
    capture.used = true;
    const task = this.#queue.then(async () => {
      if (this.#failure) throw this.#failure;
      this.#active = { token, kind };
      try {
        const result = await send(Object.freeze({ method: capture.method, sessionId: capture.sessionId, requestId: capture.requestId }));
        return this.validate(token, kind, result);
      } catch { this.abort(); throw this.#failure; }
      finally { this.#active = null; }
    });
    this.#queue = task.catch(() => {}); return task;
  }
  abort() { this.#failure ||= bad("observation-failed"); }
  snapshot() { return Object.freeze({ responses: this.#keys.size, reservedBytes: this.#bytes, active: this.#active !== null, failed: this.#failure !== null }); }
}
module.exports = { BodyReservations, METHODS, decodedLength };
