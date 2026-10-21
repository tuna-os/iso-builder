// Falsification: oversized/fragmented/compressed frames, wrong endpoint shape,
// missing close, invalid limits and arbitrary error text must fail closed.
// The real public ws parser is exercised through an in-memory HTTP Duplex;
// these are socket-free transport tests, not Chromium or collector evidence.
const { test, expect } = require("@playwright/test");
const { EventEmitter, once } = require("node:events");
const { Duplex } = require("node:stream");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { SOCKET_LIMITS, socketOptions, endpointURL, connectOwnedSocket } = require("./owned-flat-websocket");
const { FlatConnection, LIMITS } = require("./owned-flat-cdp");

const endpoint = { port: 42123, inode: "876", url: "ws://127.0.0.1:42123/devtools/browser/12345678-abcd-abcd-abcd-123456789abc" };
const tick = () => new Promise(resolve => setImmediate(resolve));
class MockClient extends EventEmitter {
  constructor(url, options) { super(); this.url = url; this.options = options; this.extensions = ""; this.protocol = ""; this.terminations = 0; }
  open() { this.emit("open"); }
  send(_text, callback) { callback(); }
  close() { queueMicrotask(() => this.emit("close")); }
  terminate() { this.terminations++; queueMicrotask(() => this.emit("close")); }
}
function mock(options = {}, Client = MockClient) { return connectOwnedSocket(endpoint, options, Client); }

test("owned ws keeps exact decoded and wire arithmetic separate", () => {
  expect(SOCKET_LIMITS.messageBytes).toBe(89544024);
  expect(SOCKET_LIMITS.decodedAssetBytes).toBe(67108864);
  expect(SOCKET_LIMITS.totalDecodedBytes).toBe(100663296);
  expect(SOCKET_LIMITS.tinyMessageBytes).toBe(LIMITS.frameBytes);
  expect(socketOptions().maxPayload).toBe(262144);
  expect(socketOptions({ maxPayload: SOCKET_LIMITS.messageBytes }).maxPayload).toBe(89544024);
  expect(6 * SOCKET_LIMITS.decodedAssetBytes + SOCKET_LIMITS.envelopeBytes).toBeGreaterThan(SOCKET_LIMITS.messageBytes);
});
test("owned ws fixed public security options cannot be overridden", () => {
  expect(socketOptions()).toMatchObject({ perMessageDeflate: false, followRedirects: false,
    skipUTF8Validation: false, maxFragments: 16384, maxBufferedChunks: 262144, maxHeaderSize: 16384 });
  expect(Object.isFrozen(socketOptions())).toBe(true);
});
for (const [index, options] of [ { maxPayload: 0 }, { maxPayload: 89544025 }, { maxPayload: Infinity },
  { maxPayload: 1.5 }, { maxFragments: 0 }, { maxBufferedChunks: -1 }, { handshakeTimeout: 3001 },
  { closeTimeout: 1001 }, { perMessageDeflate: true }, { followRedirects: true }, { headers: {} } ].entries()) {
  test(`owned ws rejects invalid option set ${index}`, () => {
    expect(() => socketOptions(options)).toThrow(/^owned-ws:limit-invalid$/);
  });
}
for (const [index, changed] of [ { port: 42124 }, { inode: "0" }, { inode: undefined },
  { url: endpoint.url.replace("127.0.0.1", "localhost") }, { url: `${endpoint.url}?token=secret` },
  { url: endpoint.url.replace("127.0.0.1", "user:secret@127.0.0.1") }, { url: endpoint.url.replace("ws:", "wss:") } ].entries()) {
  test(`owned ws rejects endpoint substitution ${index}`, () => expect(() => endpointURL({ ...endpoint, ...changed })).toThrow(/^owned-ws:endpoint-invalid$/));
}
test("owned ws adapts bounded public text events", async () => {
  const socket = mock(); const messages = []; socket.addEventListener("message", event => messages.push(event));
  socket.raw.open(); await socket.ready; socket.raw.emit("message", Buffer.from("hello"), false);
  expect(messages).toEqual([{ data: "hello" }]); expect(Object.isFrozen(messages[0])).toBe(true);
  socket.send("{}"); await socket.dispose(); expect(socket.didClose).toBe(true);
});
for (const [index, action] of [
  raw => raw.emit("message", Buffer.from("secret"), true),
  raw => raw.emit("message", "untrusted", false),
  raw => raw.emit("message", Buffer.alloc(9), false),
  raw => raw.emit("error", new Error("https://secret.invalid/?token=value body headers")),
].entries()) {
  test(`owned ws sanitizes rejected message/error ${index}`, async () => {
    const socket = mock({ maxPayload: 8 }); socket.raw.open(); await socket.ready;
    const errors = []; socket.addEventListener("error", event => errors.push(event.error)); action(socket.raw);
    expect(errors).toHaveLength(1); expect(errors[0].message).toMatch(/^owned-ws:[a-z-]+$/);
    expect(JSON.stringify(errors[0], Object.getOwnPropertyNames(errors[0]))).not.toMatch(/secret|token=|headers/);
    await socket.dispose();
  });
}
test("owned ws preserves flattened reply ownership rejection", async () => {
  const socket = mock(); socket.raw.open(); await socket.ready;
  const connection = new FlatConnection(socket); const pending = connection.send("Network.enable", {}, "owned");
  socket.raw.emit("message", Buffer.from(JSON.stringify({ id: 1, sessionId: "foreign", result: {} })), false);
  await expect(pending).rejects.toThrow("reply-ownership-mismatch"); connection.close(); await socket.dispose();
});
test("owned ws concurrent disposal shares teardown and requires actual close", async () => {
  class Slow extends MockClient { close() {} }
  const socket = mock({ closeTimeout: 5 }, Slow); socket.raw.open(); await socket.ready;
  const first = socket.dispose(); expect(socket.dispose()).toBe(first); await first;
  expect(socket.raw.terminations).toBe(1); expect(socket.didClose).toBe(true);
});
test("owned ws missing close after termination remains failed", async () => {
  class Missing extends MockClient { close() {} terminate() { this.terminations++; } }
  const socket = mock({ closeTimeout: 5 }, Missing); socket.raw.open(); await socket.ready;
  await expect(socket.dispose()).rejects.toThrow(/^owned-ws:close-timeout$/); expect(socket.didClose).toBe(false);
});
test("owned ws constructor and handshake failures expose fixed reasons", async () => {
  class Throws { constructor() { throw new Error("https://secret.invalid/path"); } }
  const missing = mock({}, Throws); await expect(missing.ready).rejects.toThrow(/^owned-ws:connect-failed$/); await missing.dispose();
  const mismatch = mock(); mismatch.raw.extensions = "unsafe"; mismatch.raw.open();
  await expect(mismatch.ready).rejects.toThrow(/^owned-ws:handshake-mismatch$/); await mismatch.dispose();
});

// Public http.request createConnection option injects a Duplex: no net.connect,
// listening socket, private ws fields, browser manager or external URL is used.
class Wire extends Duplex {
  constructor(response = null) { super(); this.request = ""; this.response = response; this.upgraded = false; }
  _read() {}
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  _write(chunk, _encoding, callback) {
    if (!this.upgraded) {
      this.request += chunk.toString("ascii");
      if (this.request.includes("\r\n\r\n")) {
        this.upgraded = true;
        const key = /Sec-WebSocket-Key: ([^\r]+)\r/i.exec(this.request)?.[1];
        const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        const response = this.response || `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
        queueMicrotask(() => this.push(Buffer.from(response)));
      }
    } else if ((chunk[0] & 15) === 8) queueMicrotask(() => { if (!this.destroyed) this.push(Buffer.from([0x88, 0])); });
    callback();
  }
}
function framed(options = {}, response) {
  const wire = new Wire(response);
  class PublicClient extends WebSocket { constructor(url, config) { super(url, { ...config, createConnection: () => wire }); } }
  return { wire, socket: mock({ maxPayload: 16, closeTimeout: 20, ...options }, PublicClient) };
}
function frame(text, { opcode = 1, fin = true, rsv = false } = {}) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  if (bytes.length > 125) throw new Error("fixture bound");
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | (rsv ? 0x40 : 0) | opcode, bytes.length]), bytes]);
}
async function rejectedFrames(options, chunks, expected) {
  const { wire, socket } = framed(options); const messages = [];
  socket.addEventListener("message", event => messages.push(event)); await socket.ready;
  const rejected = new Promise(resolve => socket.addEventListener("error", event => resolve(event.error), { once: true }));
  try {
    for (const bytes of chunks) { if (wire.destroyed) break; wire.push(bytes); await tick(); }
    expect((await rejected).message).toBe(`owned-ws:${expected}`); expect(messages).toEqual([]);
  } finally { await socket.dispose(); wire.destroy(); }
}
test("public ws parser accepts exact-limit fragmented response without sockets", async () => {
  const { wire, socket } = framed(); await socket.ready; const got = once(socket, "message");
  try {
    wire.push(frame("12345678", { fin: false })); wire.push(frame("abcdefgh", { opcode: 0 }));
    expect((await got)[0].data).toBe("12345678abcdefgh");
    expect(wire.request).not.toContain("Sec-WebSocket-Extensions");
  } finally { await socket.dispose(); wire.destroy(); }
});
test("public ws parser rejects declared over-limit frame before its payload", async () => {
  await rejectedFrames({}, [Buffer.from([0x81, 126, 0, 17])], "message-bound");
});
test("public ws parser rejects fragmented cumulative overflow", async () => {
  await rejectedFrames({}, [frame("12345678", { fin: false }), frame("123456789", { opcode: 0 })], "message-bound");
});
test("public ws parser rejects too many empty fragments", async () => {
  await rejectedFrames({ maxFragments: 2 }, [frame("", { fin: false }), frame("", { opcode: 0, fin: false }), frame("", { opcode: 0 })], "parts-bound");
});
test("public ws parser rejects too many buffered partial chunks", async () => {
  await rejectedFrames({ maxBufferedChunks: 2 }, [Buffer.from([0x81, 8]), Buffer.from("1"), Buffer.from("2"), Buffer.from("3")], "parts-bound");
});
test("public ws parser rejects unnegotiated compression", async () => {
  await rejectedFrames({}, [frame("x", { rsv: true })], "unexpected-compression");
});
test("public ws parser rejects invalid UTF-8", async () => {
  await rejectedFrames({}, [frame(Buffer.from([0xff]))], "invalid-utf8");
});
test("public ws parser rejects binary application frames", async () => {
  await rejectedFrames({}, [frame("x", { opcode: 2 })], "message-type-invalid");
});
test("public ws parser rejects a redirect without connecting elsewhere", async () => {
  const { wire, socket } = framed({}, "HTTP/1.1 302 Found\r\nLocation: http://secret.invalid/token\r\nContent-Length: 0\r\n\r\n");
  await expect(socket.ready).rejects.toThrow(/^owned-ws:transport-error$/); await socket.dispose(); wire.destroy();
});
test("public ws parser close mid-fragment fails pending command", async () => {
  const { wire, socket } = framed(); await socket.ready; const connection = new FlatConnection(socket);
  const task = connection.send("Network.enable");
  wire.push(frame("part", { fin: false })); wire.push(frame("", { opcode: 8 }));
  await expect(task).rejects.toThrow(/transport-error|transport-closed/); await socket.dispose(); wire.destroy();
});
test("public ws parser accepts exact-limit unfragmented text", async () => {
  const { wire, socket } = framed(); await socket.ready; const got = once(socket, "message");
  try { wire.push(frame("1234567890abcdef")); expect((await got)[0].data).toBe("1234567890abcdef"); }
  finally { await socket.dispose(); wire.destroy(); }
});
test("public ws parser rejects unfragmented one-byte overflow", async () => {
  await rejectedFrames({}, [frame("1234567890abcdefg")], "message-bound");
});
test("public ws parser rejects unsolicited extension during handshake", async () => {
  class ExtensionWire extends Wire {
    push(bytes, encoding) {
      if (Buffer.isBuffer(bytes) && bytes.toString("ascii").startsWith("HTTP/1.1 101")) {
        bytes = Buffer.from(bytes.toString("ascii").replace("\r\n\r\n", "\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n"));
      }
      return super.push(bytes, encoding);
    }
  }
  const wire = new ExtensionWire();
  class Client extends WebSocket { constructor(url, config) { super(url, { ...config, createConnection: () => wire }); } }
  const socket = mock({ closeTimeout: 20 }, Client);
  await expect(socket.ready).rejects.toThrow(/^owned-ws:transport-error$/); await socket.dispose(); wire.destroy();
});
test("public ws text cannot bypass existing JSON protocol gate", async () => {
  const { wire, socket } = framed(); await socket.ready; const connection = new FlatConnection(socket);
  const task = connection.send("Network.enable"); wire.push(frame("{bad json"));
  await expect(task).rejects.toThrow("frame-json-invalid"); await socket.dispose(); wire.destroy();
});
test("public ws wire ceiling rejects escaped text despite small decoded body", async () => {
  const { wire, socket } = framed({ maxPayload: 64 }); await socket.ready;
  const rejected = new Promise(resolve => socket.addEventListener("error", event => resolve(event.error), { once: true }));
  const body = '\\u0000'.repeat(8); const text = `{"result":{"body":"${body}","base64Encoded":false}}`;
  expect(Buffer.from(JSON.parse(text).result.body).length).toBe(8); expect(Buffer.byteLength(text)).toBeGreaterThan(64);
  try { wire.push(frame(text)); expect((await rejected).message).toBe("owned-ws:message-bound"); }
  finally { await socket.dispose(); wire.destroy(); }
});
