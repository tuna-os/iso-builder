// Falsification: close notification alone, fire-and-forget close, an earlier
// transport failure, or rejected disposal cannot establish successful teardown.
// These tests do not launch a browser or bind a local socket.
const { test, expect } = require("@playwright/test");
const { closeOwnedChannels } = require("./owned-flat-cdp");
test("bounded channel cleanup awaits disposal after requesting close", async () => {
  let release, finished = false; const order = [];
  const wait = new Promise(resolve => { release = resolve; });
  const socket = { failure: null, dispose: async () => { order.push("dispose"); await wait; order.push("disposed"); } };
  const connection = { failure: null, close() { order.push("close"); this.failure = new Error("intentional closure"); } };
  const task = closeOwnedChannels(connection, socket, true).then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); expect(order).toEqual(["close", "dispose"]);
  release(); await task; expect(order).toEqual(["close", "dispose", "disposed"]);
});
for (const mode of ["prior-connection", "prior-socket", "late-socket", "dispose", "missing-dispose", "close-throws"]) test(`bounded channel cleanup rejects ${mode}`, async () => {
  let disposed = false;
  const socket = { failure: mode === "prior-socket" ? Error("secret") : null, async dispose() {
    disposed = true; if (mode === "late-socket") this.failure = Error("secret"); if (mode === "dispose") throw Error("secret");
  } };
  if (mode === "missing-dispose") delete socket.dispose;
  const connection = { failure: mode === "prior-connection" ? Error("secret") : null, close() { if (mode === "close-throws") throw Error("secret"); } };
  await expect(closeOwnedChannels(connection, socket, true)).rejects.toThrow(/^owned-cdp:channel-cleanup-failed$/);
  expect(disposed).toBe(mode !== "missing-dispose");
});
test("partial startup without a channel remains cleanable", async () => { await closeOwnedChannels(undefined, undefined, true); });
test("existing tiny channel still closes without claiming bounded ws disposal", async () => {
  let count = 0; await closeOwnedChannels({ close() { count++; } }, { close() { count++; } }); expect(count).toBe(2);
});
