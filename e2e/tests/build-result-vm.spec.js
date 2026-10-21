// Exercise the actual app functions with controlled engine/sink boundaries.
// These tests supplement browser coverage; they do not simulate a real save.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateBuildResult } = require("../../app/public/build-result");
const { observedBuildFixture } = require("./observed-build-fixture");
const source = fs.readFileSync(path.join(__dirname, "../../app/public/app.js"), "utf8");
function appFunction(name, next) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = source.indexOf(next, start);
  if (start < 0 || end < 0) throw new Error(`missing real app function ${name}`);
  return source.slice(start, end);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function app() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", disabled: false,
      classList: { hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; }, contains() { return this.hidden; } } });
    return elements.get(id);
  };
  const request = { image: "synthetic:base", options: { label: "TEST", outputFilename: "test.iso", flatpaks: [], packages: [], extraRun: [] } };
  const op = { state: "ready", ready: true, request, inspectedVia: "wasm", id: 1, buildResult: null };
  const trace = { closes: 0, writes: 0, aborts: 0, legacy: 0, calls: 0, downloads: 0 };
  const sink = { kind: "picker", w: {
    write: async bytes => { trace.writes += bytes.length; },
    close: async () => { trace.closes++; }, abort: async () => { trace.aborts++; },
  } };
  const context = {
    console, performance, Uint8Array, Blob, URL, Promise, WeakSet,
    location: { search: "" }, setTimeout: () => 0,
    document: { createElement: () => ({ click: () => { trace.downloads++; } }) },
    navigator: {}, $: element, currentOp: op, buildResultRevision: 0,
    observedResetFunctions: new WeakSet(), pendingEngineResets: new Set(), activeBusyPhase: null,
    selectedDdi: null, operationSeq: 0, facts: null, tboxCurrentOperation: op, nextRequest: request, wasmNativeBuildIso: null, wasmNativeBuildIsoWithResult: null,
    updateShim() {}, askNotify() {},
    buildRequestFromForm() { return { request: structuredClone(context.nextRequest) }; },
    isOperationBusy() { return false; }, operationMatchesForm: () => true,
    setOperationBusy() {}, watchEngineMemory: () => () => {},
    log() {}, notify() {}, renderFallbackCard() {}, showCacheSize() {}, updatePostcardFilename() {},
    isoSink: async () => sink, loadWasm: async () => {}, tboxValidateBuildResult: validateBuildResult,
    tboxBuildIso: async (_opts, write) => { trace.legacy++; await write(new Uint8Array([1, 2, 3, 4])); return 4; },
    tboxBuildIsoWithResult: async (_opts, write) => { trace.calls++; await write(new Uint8Array([1, 2, 3, 4])); return observedBuildFixture(); },
    tboxReset: () => null, tboxResetAsync: async () => null,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext([
    appFunction("deepFreeze", "let operationSeq"),
    appFunction("clearBuildResult", "function observeEngineResets"),
    appFunction("observeEngineResets", "function isOperationBusy"),
    appFunction("rebuildCurrentOperation", "function syncOperationOptions"),
    appFunction("syncOperationOptions", "function operationMatchesForm"),
    appFunction("finishIsoSink", "function prepareDdi"),
    appFunction("build", "function updateShare"),
  ].join("\n"), context);
  return { c: context, op, sink, trace, element };
}
function expectFailed({ op, element }) {
  expect(op.state).toBe("failed");
  expect(op.buildResult).toBeNull();
  expect(op.outputDelivery).toBeNull();
  expect(op.buildTiming).toBeNull();
  expect(element("stage").textContent).toContain("Build failed");
  expect(element("postcard").classList.hidden).toBe(true);
}

test.describe("app result lifecycle VM", () => {
  test("keeps result private until successful close and exposes a frozen snapshot", async () => {
    const a = app(); const closed = deferred(); const closing = deferred();
    a.sink.w.close = async () => { closing.resolve(); await closed.promise; };
    const pending = a.c.build(); await closing.promise;
    expect(a.op.buildResult).toBeNull();
    expect(a.op.state).toBe("building");
    closed.resolve(); await pending;
    expect(a.op.state).toBe("completed");
    expect(a.op.buildResult).toEqual(observedBuildFixture());
    expect(a.op.outputDelivery).toEqual({ kind: "picker", status: "stream-closed" });
    expect(Object.isFrozen(a.op.buildResult.observedInputs.source.config.descriptor)).toBe(true);
    expect(a.trace.legacy).toBe(0);
  });
  test("missing result API retains the numeric path without observations", async () => {
    const a = app(); delete a.c.tboxBuildIsoWithResult;
    await a.c.build();
    expect(a.op.state).toBe("completed"); expect(a.op.buildResult).toBeNull();
    expect(a.trace.legacy).toBe(1);
  });
  for (const malformed of [null, 4, {}, observedBuildFixture(3), observedBuildFixture(Number.MAX_SAFE_INTEGER + 1)]) {
    test(`rejects malformed returned result ${JSON.stringify(malformed)} before close`, async () => {
      const a = app();
      a.c.tboxBuildIsoWithResult = async (_opts, write) => { await write(new Uint8Array(4)); return malformed; };
      await a.c.build(); expectFailed(a);
      expect(a.trace.closes).toBe(0); expect(a.trace.aborts).toBe(1); expect(a.trace.legacy).toBe(0);
    });
  }
  test("sink write rejection leaves no result", async () => {
    const a = app(); a.sink.w.write = async () => { throw new Error("sink write rejected"); };
    await a.c.build(); expectFailed(a); expect(a.trace.closes).toBe(0);
  });
  test("sink close error clears previous success; recovery starts from an empty result", async () => {
    const a = app(); await a.c.build(); expect(a.op.buildResult).not.toBeNull();
    a.sink.w.close = async () => { throw new Error("sink close error"); };
    await a.c.build(); expectFailed(a);
    a.sink.w.close = async () => {};
    await a.c.build(); expect(a.op.buildResult).toEqual(observedBuildFixture()); expect(a.op.error).toBeNull();
  });
  test("retry clears receipt before an engine Promise resolves or rejects", async () => {
    const a = app(); await a.c.build(); const started = deferred(); const resume = deferred();
    a.c.tboxBuildIsoWithResult = async () => { started.resolve(); await resume.promise; throw new Error("failed retry"); };
    const pending = a.c.build(); await started.promise; expect(a.op.buildResult).toBeNull();
    resume.resolve(); await pending; expectFailed(a);
  });
  test("form invalidation during close cannot republish stale success", async () => {
    const a = app(); const closing = deferred(); const resume = deferred();
    a.sink.w.close = async () => { closing.resolve(); await resume.promise; };
    const pending = a.c.build(); await closing.promise; a.c.clearBuildResult();
    resume.resolve(); await pending; expectFailed(a);
  });
  for (const reset of ["tboxReset", "tboxResetAsync"]) {
    test(`${reset} keeps its return contract and clears completed receipt`, async () => {
      const a = app(); await a.c.build(); const result = a.c[reset]();
      expect(result instanceof Promise).toBe(reset.endsWith("Async")); expect(await result).toBeNull();
      expect(a.op.buildResult).toBeNull(); expect(a.op.outputDelivery).toBeNull();
    });
  }
  for (const reset of ["tboxReset", "tboxResetAsync"]) {
    test(`${reset} busy rejection does not invalidate an active build`, async () => {
      const a = app(); const started = deferred(); const resume = deferred();
      a.c[reset] = () => Promise.reject("tacklebox operation already in progress");
      a.c.tboxBuildIsoWithResult = async (_opts, write) => {
        started.resolve(); await resume.promise; await write(new Uint8Array(4)); return observedBuildFixture();
      };
      const pending = a.c.build(); await started.promise;
      await expect(a.c[reset]()).rejects.toBe("tacklebox operation already in progress");
      resume.resolve(); await pending;
      expect(a.op.state).toBe("completed"); expect(a.op.buildResult).toEqual(observedBuildFixture());
      expect(a.c.pendingEngineResets.size).toBe(0);
    });
  }
  for (const cleanupFails of [false, true]) {
    test(`accepted async reset during close blocks publication (cleanup failure=${cleanupFails})`, async () => {
      const a = app(); const closing = deferred(); const close = deferred(); const reset = deferred();
      a.c.tboxResetAsync = async () => { await reset.promise; if (cleanupFails) throw new Error("reset cleanup failed"); return null; };
      a.sink.w.close = async () => { closing.resolve(); await close.promise; };
      const pending = a.c.build(); await closing.promise;
      const resetting = a.c.tboxResetAsync(); const outcome = resetting.catch(error => error);
      close.resolve(); await new Promise(resolve => setImmediate(resolve));
      expect(a.op.buildResult).toBeNull(); expect(a.op.state).toBe("building");
      reset.resolve(); await outcome; await pending; expectFailed(a);
      expect(a.c.pendingEngineResets.size).toBe(0);
    });
  }
  test("new resets during an earlier reset wait also block publication", async () => {
    const a = app(); const closing = deferred(); const close = deferred();
    const busy = deferred(); const accepted = deferred(); let resets = 0;
    a.c.tboxResetAsync = async () => {
      if (++resets === 1) { await busy.promise; throw "tacklebox operation already in progress"; }
      await accepted.promise; return null;
    };
    a.sink.w.close = async () => { closing.resolve(); await close.promise; };
    const pending = a.c.build(); await closing.promise;
    const busyOutcome = a.c.tboxResetAsync().catch(error => error);
    close.resolve(); await new Promise(resolve => setImmediate(resolve));
    const acceptedOutcome = a.c.tboxResetAsync();
    busy.resolve(); await busyOutcome; await new Promise(resolve => setImmediate(resolve));
    expect(a.op.state).toBe("building"); expect(a.op.buildResult).toBeNull();
    accepted.resolve(); await acceptedOutcome; await pending; expectFailed(a);
  });
  test("completed receipt is unavailable while async reset cleanup is unresolved", async () => {
    const a = app(); const cleanup = deferred();
    a.c.tboxResetAsync = async () => { await cleanup.promise; return null; };
    await a.c.build(); expect(a.op.buildResult).not.toBeNull();
    const resetting = a.c.tboxResetAsync();
    expect(a.op.buildResult).toBeNull(); expect(a.op.buildAttempt).toBeNull();
    cleanup.resolve(); await resetting;
  });
  for (const asyncError of [false, true]) {
    test(`unknown reset error fails closed (async=${asyncError})`, async () => {
      const a = app();
      a.c.tboxReset = asyncError ? () => Promise.reject(new Error("unknown reset error")) : () => { throw new Error("unknown reset error"); };
      await a.c.build(); expect(a.op.buildResult).not.toBeNull();
      if (asyncError) await expect(a.c.tboxReset()).rejects.toThrow("unknown reset error");
      else expect(() => a.c.tboxReset()).toThrow("unknown reset error");
      expect(a.op.buildResult).toBeNull(); expect(a.op.buildAttempt).toBeNull();
    });
  }
  test("reading unchanged request preserves result; option edits clear it", async () => {
    const a = app(); await a.c.build();
    a.c.syncOperationOptions(); expect(a.op.buildResult).toEqual(observedBuildFixture());
    a.c.nextRequest.options.packages.push("new-package");
    a.c.syncOperationOptions(); expect(a.op.buildResult).toBeNull(); expect(a.op.outputDelivery).toBeNull();
  });
  test("new inspection or form invalidation clears even references to the old operation", async () => {
    const a = app(); await a.c.build();
    const replacement = a.c.rebuildCurrentOperation("inspecting");
    expect(a.op.buildResult).toBeNull(); expect(a.op.outputDelivery).toBeNull();
    expect(replacement.buildResult).toBeNull(); expect(replacement.outputDelivery).toBeNull();
    expect(a.c.tboxCurrentOperation).toBe(replacement);
  });
  test("initial picker cancellation clears previous success", async () => {
    const a = app(); await a.c.build(); a.c.isoSink = async () => null;
    await a.c.build(); expect(a.op.state).toBe("ready"); expect(a.op.buildResult).toBeNull();
    expect(a.element("stage").textContent).toBe("Build cancelled.");
  });
  for (const failure of ["cancel", "write", "close"]) {
    test(`OPFS export ${failure} fails without a completed result or fallback download`, async () => {
      const a = app(); a.sink.kind = "opfs";
      a.sink.fh = { getFile: async () => new Blob([new Uint8Array(4)]) };
      a.c.showSaveFilePicker = async () => {
        if (failure === "cancel") { const e = new Error("cancelled"); e.name = "AbortError"; throw e; }
        return { createWritable: async () => new WritableStream({
          write() { if (failure === "write") throw new Error("export write failed"); },
          close() { throw new Error("export close failed"); },
        }) };
      };
      await a.c.build(); expectFailed(a); expect(a.trace.downloads).toBe(0);
    });
  }
  test("unavailable picker retains a successful download-initiation fallback", async () => {
    const a = app(); a.sink.kind = "opfs";
    a.sink.fh = { getFile: async () => new Blob([new Uint8Array(4)]) };
    a.c.showSaveFilePicker = async () => { const e = new Error("picker unavailable"); e.name = "SecurityError"; throw e; };
    await a.c.build(); expect(a.op.state).toBe("completed");
    expect(a.op.outputDelivery).toEqual({ kind: "download", status: "initiated" });
    expect(a.trace.downloads).toBe(1); expect(a.op.buildResult).toEqual(observedBuildFixture());
  });
});


test.describe("active build duration VM", () => {
  for (const catalog of [true, false]) {
    test(`includes current inspection without re-counting prior UI work: ${catalog}`, async () => {
      const a = app(); let now = 0;
      a.c.performance = { now: () => now };
      a.op.inspectedVia = catalog ? "catalog" : "wasm";
      a.c.isoSink = async () => { now += 1000000; return a.sink; };
      a.c.tboxIntrospect = async () => { now += 100000; };
      a.c.tboxBuildIsoWithResult = async (_opts, write) => {
        now += 7000; await write(new Uint8Array([1, 2, 3, 4])); return observedBuildFixture();
      };
      a.sink.w.close = async () => { now += 2000; };
      await a.c.build();
      expect(a.op.state).toBe("completed");
      expect(a.op.buildTiming.elapsedMs).toBe(catalog ? 109000 : 9000);
      expect(a.op.buildTiming.inspectionReused).toBe(!catalog);
      expect(a.op.buildTiming.phasesMs).toEqual({ preparation: 0, engineSetupAndInspection: catalog ? 100000 : 0, buildAndSave: 9000 });
      expect(a.op.buildTiming.operationId).toBe(a.op.id);
      expect(a.op.buildTiming.buildAttempt).toBe(a.op.buildAttempt);
      expect(Object.isFrozen(a.op.buildTiming.phasesMs)).toBe(true);
      expect(a.element("stage").textContent).toContain(catalog ? "109.0s" : "9.0s");
      expect(a.op.buildTiming.qualification).toBeUndefined();
      const firstTiming = a.op.buildTiming;
      await a.c.build();
      expect(a.op.buildTiming.elapsedMs).toBe(9000);
      expect(a.op.buildTiming.phasesMs.engineSetupAndInspection).toBe(0);
      expect(a.op.buildTiming.buildAttempt).not.toBe(firstTiming.buildAttempt);
      expect(firstTiming.elapsedMs).toBe(catalog ? 109000 : 9000);
    });
  }
  test("counts initrd preparation without counting the file-picker wait", async () => {
    const a = app(); let now = 0;
    a.c.performance = { now: () => now };
    a.element("initrdurl").value = "https://fixture.invalid/initrd";
    a.c.fetch = async () => { now += 4000; return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }; };
    a.c.isoSink = async () => { now += 1000000; return a.sink; };
    await a.c.build();
    expect(a.op.state).toBe("completed");
    expect(a.op.buildTiming.phasesMs.preparation).toBe(4000);
    expect(a.op.buildTiming.elapsedMs).toBe(4000);
  });
  test("cancelled file selection publishes no timing or engine result", async () => {
    const a = app(); a.op.buildTiming = { stale: true };
    a.c.isoSink = async () => null;
    await a.c.build();
    expect(a.op.buildTiming).toBeNull();
    expect(a.op.buildResult).toBeNull();
    expect(a.trace.calls).toBe(0);
  });
  test("close failure clears a previous timing", async () => {
    const a = app(); a.op.buildTiming = { stale: true };
    a.sink.w.close = async () => { throw new Error("close failed"); };
    await a.c.build(); expectFailed(a);
  });
});
