const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { observedBuildFixture } = require("./observed-build-fixture");
const {
  observeLoadedWasm,
  loadedWasmMeasurement,
  hashSavedIso,
  buildOperationIdentity,
  completedBuildResult,
  diagnosticRecord,
  observeConsumedBuildInputs,
  completedInputMeasurements,
  observeFrontendResponses,
  producerEnvironment,
  browserObservedInputRecord,
  captureExecutingSource,
  finalizeExecutingSource,
} = require("./build-measurements");

// An empty, valid WebAssembly module. It performs no build or network work.
const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const digest = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

async function observedPage(page, { body = WASM, status = 200, contentType = "application/wasm" } = {}) {
  await page.addInitScript({ content:
    `globalThis.__nativeInstantiateStreaming = WebAssembly.instantiateStreaming; (${observeLoadedWasm.toString()})();`,
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(".wasm")) {
      return route.fulfill({ status, contentType, body,
        headers: { "Access-Control-Allow-Origin": "*" } });
    }
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic WASM observation</title>" });
  });
  await page.goto("http://127.0.0.1:8931/measurement-fixture");
}

test.describe("native WASM diagnostic observation", () => {
  test("hashes the exact response passed to a successful native invocation", async ({ page }) => {
    await observedPage(page);
    const instantiated = await page.evaluate(async () => {
      const result = await WebAssembly.instantiateStreaming(fetch("/tbox.wasm"), {});
      return { module: result.module instanceof WebAssembly.Module,
        instance: result.instance instanceof WebAssembly.Instance };
    });
    expect(instantiated).toEqual({ module: true, instance: true });
    expect(await loadedWasmMeasurement(page)).toEqual({ sha256: digest(WASM), sizeBytes: 8 });
  });

  test("accepts a Response argument as well as a fetch promise", async ({ page }) => {
    await observedPage(page);
    await page.evaluate(async () => WebAssembly.instantiateStreaming(await fetch("/tbox.wasm"), {}));
    expect(await loadedWasmMeasurement(page)).toEqual({ sha256: digest(WASM), sizeBytes: 8 });
  });

  test("missing initialization cannot yield a measurement", async ({ page }) => {
    await page.goto("about:blank");
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("a fetch without instantiation cannot yield a measurement", async ({ page }) => {
    await observedPage(page);
    await page.evaluate(async () => (await fetch("/tbox.wasm")).arrayBuffer());
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("non-streaming fallback is not silently counted as observed", async ({ page }) => {
    await observedPage(page);
    await page.evaluate(async () => WebAssembly.instantiate(await (await fetch("/tbox.wasm")).arrayBuffer()));
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("duplicate successful native invocations reject ambiguous attribution", async ({ page }) => {
    await observedPage(page);
    await page.evaluate(async () => {
      await Promise.all([1, 2].map(() => WebAssembly.instantiateStreaming(fetch("/tbox.wasm"))));
    });
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  for (const source of ["/other.wasm", "/tbox.wasm?unreviewed=1", "http://other.invalid/tbox.wasm"]) {
    test(`successful native call rejects diagnostic response ${source}`, async ({ page }) => {
      await observedPage(page);
      const nativeSucceeded = await page.evaluate(async source => {
        const result = await WebAssembly.instantiateStreaming(fetch(source));
        return result.instance instanceof WebAssembly.Instance;
      }, source);
      expect(nativeSucceeded).toBe(true);
      await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
    });
  }

  test("redirected response metadata boundary injection rejects diagnostics while native tiny WASM succeeds", async ({ page }) => {
    await observedPage(page);
    const result = await page.evaluate(async () => {
      const response = await fetch("/tbox.wasm");
      // Inject the observer's redirect-metadata boundary only. Playwright does
      // not route a redirected request's target, so a real redirect here could
      // load the application's Go engine instead of the tiny synthetic module.
      Object.defineProperty(response, "redirected", { value: true });
      const instantiated = await WebAssembly.instantiateStreaming(response, {});
      return { redirected: response.redirected,
        nativeSucceeded: instantiated.instance instanceof WebAssembly.Instance };
    });
    expect(result).toEqual({ redirected: true, nativeSucceeded: true });
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  for (const failure of ["invalid module", "HTTP failure", "wrong MIME"]) {
    test(`native ${failure} remains a failure and produces no diagnostic`, async ({ page }) => {
      await observedPage(page, failure === "invalid module" ? { body: Buffer.from("not wasm") } :
        failure === "HTTP failure" ? { status: 404 } : { contentType: "text/plain" });
      const errors = await page.evaluate(async () => {
        const failureOf = async call => {
          try { await call(); return null; } catch (error) { return error.name; }
        };
        return {
          original: await failureOf(() => __nativeInstantiateStreaming(fetch("/tbox.wasm"))),
          observed: await failureOf(() => WebAssembly.instantiateStreaming(fetch("/tbox.wasm"))),
        };
      });
      expect(errors.original).not.toBeNull();
      expect(errors.observed).toBe(errors.original);
      await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
    });
  }

  test("a rejected source preserves the exact rejection reason", async ({ page }) => {
    await observedPage(page);
    expect(await page.evaluate(async () => {
      const reason = new Error("synthetic fetch rejection");
      try { await WebAssembly.instantiateStreaming(Promise.reject(reason)); }
      catch (error) { return error === reason; }
      return false;
    })).toBe(true);
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("observer hashing failure does not replace successful native instantiation", async ({ page }) => {
    await observedPage(page);
    expect(await page.evaluate(async () => {
      crypto.subtle.digest = async () => { throw new Error("synthetic diagnostic digest failure"); };
      const result = await WebAssembly.instantiateStreaming(fetch("/tbox.wasm"));
      return result.instance instanceof WebAssembly.Instance;
    })).toBe(true);
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("native result does not await diagnostic hash completion", async ({ page }) => {
    await observedPage(page);
    expect(await page.evaluate(async () => {
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (...args) => new Promise((resolve, reject) => {
        globalThis.__completeDiagnosticHash = () => nativeDigest(...args).then(resolve, reject);
      });
      const result = await WebAssembly.instantiateStreaming(fetch("/tbox.wasm"));
      return result.instance instanceof WebAssembly.Instance;
    })).toBe(true);
    await page.waitForFunction(() => typeof globalThis.__completeDiagnosticHash === "function");
    await page.evaluate(() => __completeDiagnosticHash());
    expect(await loadedWasmMeasurement(page)).toEqual({ sha256: digest(WASM), sizeBytes: 8 });
  });

  test("a delayed successful diagnostic hash cannot erase native failure", async ({ page }) => {
    await observedPage(page, { body: Buffer.from("not a valid WASM module") });
    expect(await page.evaluate(async () => {
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (...args) => new Promise((resolve, reject) => {
        globalThis.__completeDiagnosticHash = () => nativeDigest(...args).then(resolve, reject);
      });
      try { await WebAssembly.instantiateStreaming(fetch("/tbox.wasm")); }
      catch (error) { return error.name; }
      return null;
    })).toBe("CompileError");
    await page.waitForFunction(() => typeof globalThis.__completeDiagnosticHash === "function");
    await page.evaluate(() => __completeDiagnosticHash());
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("observer failure preserves a native instantiation error", async ({ page }) => {
    await observedPage(page, { body: Buffer.from("invalid WASM") });
    expect(await page.evaluate(async () => {
      crypto.subtle.digest = async () => { throw new Error("synthetic observer failure"); };
      try { await WebAssembly.instantiateStreaming(fetch("/tbox.wasm")); }
      catch (error) { return error.name; }
      return null;
    })).toBe("CompileError");
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("observer refuses an oversized clone without replacing native success", async ({ page }) => {
    await observedPage(page);
    const result = await page.evaluate(async () => {
      // Inject only the observer's stream boundary; native sees the real 8-byte response.
      const response = await fetch("/tbox.wasm");
      const trace = { reads: 0, cancelled: false, released: false };
      response.clone = () => ({ body: { getReader: () => ({
        read: async () => { trace.reads++; return { value: { byteLength: 64 * 1024 * 1024 + 1 }, done: false }; },
        cancel: async () => { trace.cancelled = true; },
        releaseLock: () => { trace.released = true; },
      }) } });
      const result = await WebAssembly.instantiateStreaming(response);
      await globalThis.__loadedWasmMeasurement.pending;
      return { ...trace, nativeSucceeded: result.instance instanceof WebAssembly.Instance };
    });
    expect(result).toEqual({ reads: 1, cancelled: true, released: true, nativeSucceeded: true });
    await expect(loadedWasmMeasurement(page)).rejects.toThrow(/successful observed WASM/);
  });

  test("joins a tiny saved browser download with observed WASM and same-context browser version", async ({ page }, testInfo) => {
    await observedPage(page);
    await page.evaluate(() => WebAssembly.instantiateStreaming(fetch("/tbox.wasm")));
    const tinyIso = Buffer.from("synthetic download bytes, not a bootable ISO\n");
    const downloadEvent = page.waitForEvent("download");
    await page.evaluate(bytes => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
      link.download = "synthetic.iso";
      link.click();
    }, [...tinyIso]);
    const filename = testInfo.outputPath("synthetic.iso");
    const download = await downloadEvent;
    try {
      await download.saveAs(filename);
      const session = await page.context().newCDPSession(page);
      let browser;
      try { browser = await session.send("Browser.getVersion"); }
      finally { await session.detach(); }
      const record = diagnosticRecord({
        iso: await hashSavedIso(filename, tinyIso.length),
        wasm: await loadedWasmMeasurement(page), browser,
        phasesMs: { inspect: 0, build: 0, save: 0 },
        buildResult: observedBuildFixture(tinyIso.length),
      });
      expect(record.iso).toEqual({ sha256: digest(tinyIso), sizeBytes: tinyIso.length });
      expect(record.loadedWasm).toEqual({ sha256: digest(WASM), sizeBytes: WASM.length });
      expect(record.browser).toEqual({ product: browser.product, userAgent: browser.userAgent });
      expect(record.engineBuildResult).toEqual(observedBuildFixture(tinyIso.length));
      expect(record.missingIdentity).toEqual(["producer", "frontend"]);
      expect(record.kind).toBe("diagnostic-build-measurements");
      expect(record.qualification).toBe("not-assessed");
    } finally {
      await fs.rm(filename, { force: true });
      await download.delete();
    }
  });
});

test.describe("saved ISO diagnostic hashing", () => {
  let directory;
  let filename;
  const bytes = Buffer.from("tiny synthetic saved ISO bytes\n");

  test.beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "iso-measurement-test-"));
    filename = path.join(directory, "synthetic.iso");
    await fs.writeFile(filename, bytes);
  });
  test.afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  test("hashes exact file bytes", async () => {
    expect(await hashSavedIso(filename, bytes.length)).toEqual({ sha256: digest(bytes), sizeBytes: bytes.length });
  });

  test("same-sized different content has a different measured digest", async () => {
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    await fs.writeFile(filename, changed);
    const measured = await hashSavedIso(filename, bytes.length);
    expect(measured.sha256).toBe(digest(changed));
    expect(measured.sha256).not.toBe(digest(bytes));
  });

  for (const size of [0, -1, true, "30", 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`rejects malformed expected size ${String(size)}`, async () => {
      await expect(hashSavedIso(filename, size)).rejects.toThrow(/invalid ISO size/);
    });
  }

  for (const difference of [-1, 1]) {
    test(`rejects saved size offset ${difference}`, async () => {
      await expect(hashSavedIso(filename, bytes.length + difference)).rejects.toThrow(/ISO size mismatch/);
    });
  }

  test("missing saved file rejects", async () => {
    await expect(hashSavedIso(path.join(directory, "missing.iso"), 1)).rejects.toThrow(/ENOENT/);
  });

  test("directory is not a saved ISO", async () => {
    await expect(hashSavedIso(directory, 1)).rejects.toThrow(/ISO size mismatch/);
  });

  test("rejects an actual same-sized replacement at the final filename check", async () => {
    const originalStat = fs.stat;
    let replaced = false;
    fs.stat = async (name, ...args) => {
      if (name === filename && !replaced) {
        replaced = true;
        await fs.rename(filename, path.join(directory, "original.iso"));
        await fs.writeFile(filename, Buffer.alloc(bytes.length, 42));
      }
      return originalStat(name, ...args);
    };
    try {
      await expect(hashSavedIso(filename, bytes.length)).rejects.toThrow(/ISO changed while hashing/);
      expect(replaced).toBe(true);
    } finally { fs.stat = originalStat; }
  });

  test("rejects same-sized in-place mutation before the final handle stat", async () => {
    const originalOpen = fs.open;
    let changed = false;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      let stats = 0;
      handle.stat = async (...statArgs) => {
        if (++stats === 2) {
          changed = true;
          await fs.writeFile(filename, Buffer.alloc(bytes.length, 43));
          // A fixed different timestamp avoids relying on filesystem clock granularity.
          await fs.utimes(filename, new Date(1000), new Date(1000));
        }
        return originalStat(...statArgs);
      };
      return handle;
    };
    try {
      await expect(hashSavedIso(filename, bytes.length)).rejects.toThrow(/ISO changed while hashing/);
      expect(changed).toBe(true);
    } finally { fs.open = originalOpen; }
  });

  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    test(`rejects changed filename stat ${field}`, async () => {
      const originalStat = fs.stat;
      fs.stat = async (...args) => {
        const stat = await originalStat(...args);
        stat[field] += 1n;
        return stat;
      };
      try { await expect(hashSavedIso(filename, bytes.length)).rejects.toThrow(/ISO changed while hashing/); }
      finally { fs.stat = originalStat; }
    });
  }
});

function validRecord() {
  return {
    iso: { sha256: `sha256:${"1".repeat(64)}`, sizeBytes: 32 },
    wasm: { sha256: digest(WASM), sizeBytes: 8 },
    browser: { product: "Chrome/140.0.1.2", userAgent: "Synthetic Chromium test fixture" },
    phasesMs: { inspect: 1.25, build: 2.5, save: 0 },
  };
}

test.describe("diagnostic operation binding", () => {
  function fixture() {
    const state = { tboxCurrentOperation: { id: 1, buildAttempt: 2, state: "completed", buildResult: observedBuildFixture() } };
    const context = vm.createContext(state);
    return { state, page: { evaluate: async (fn, arg) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context) } };
  }
  test("snapshot identity stays bound to the same completed attempt", async () => {
    const { page } = fixture(); const identity = await buildOperationIdentity(page);
    expect(await completedBuildResult(page, identity)).toEqual(observedBuildFixture());
  });
  for (const change of ["operation", "attempt", "invalidated", "building"]) {
    test(`rejects ${change} drift even when a new result has the same output size`, async () => {
      const { state, page } = fixture(); const identity = await buildOperationIdentity(page);
      if (change === "operation") state.tboxCurrentOperation.id++;
      if (change === "attempt") state.tboxCurrentOperation.buildAttempt++;
      if (change === "invalidated") state.tboxCurrentOperation.buildAttempt = null;
      if (change === "building") state.tboxCurrentOperation.state = "building";
      state.tboxCurrentOperation.buildResult = observedBuildFixture();
      await expect(completedBuildResult(page, identity)).rejects.toThrow(/changed|completed/);
    });
  }
});

test.describe("diagnostic record validation", () => {
  test("preserves a valid CDP HeadlessChrome product without normalization", () => {
    const input = validRecord();
    input.browser = { product: "HeadlessChrome/140.0.1.2", userAgent: "Synthetic HeadlessChrome fixture" };
    const record = diagnosticRecord(input);
    expect(record.browser).toEqual(input.browser);
    expect(record.qualification).toBe("not-assessed");
  });

  test("emits only diagnostic v1 fields and preserves distinct identities", () => {
    const input = validRecord();
    input.iso.qualified = true;
    input.wasm.authenticated = true;
    const record = diagnosticRecord(input);
    expect(record.schemaVersion).toBe(1);
    expect(record.kind).toBe("diagnostic-build-measurements");
    expect(record.qualification).toBe("not-assessed");
    expect(record.iso).toEqual({ sha256: input.iso.sha256, sizeBytes: 32 });
    expect(record.loadedWasm).toEqual({ sha256: input.wasm.sha256, sizeBytes: 8 });
    expect(record.iso.sha256).not.toBe(record.loadedWasm.sha256);
    expect(record.engineBuildResult).toBeNull();
    expect(record.missingIdentity).toEqual(["producer", "frontend"]);
    expect(record.browser).toEqual(input.browser);
    expect(record.phasesMs).toEqual(input.phasesMs);
    expect(record.timingNote).toMatch(/no performance qualification/);
    expect(Object.keys(record).sort()).toEqual([
      "schemaVersion", "kind", "qualification", "iso", "loadedWasm", "engineBuildResult", "missingIdentity", "browser", "phasesMs", "timingNote",
    ].sort());
  });

  test("joins exact operation result only when its output count matches independently saved bytes", () => {
    const input = validRecord(); input.buildResult = observedBuildFixture(input.iso.sizeBytes);
    const record = diagnosticRecord(input);
    expect(record.engineBuildResult).toEqual(input.buildResult);
    expect(record.qualification).toBe("not-assessed");
    expect(record.missingIdentity).toEqual(["producer", "frontend"]);
    input.buildResult.bytesWritten++;
    expect(() => diagnosticRecord(input)).toThrow(/byte count/);
    expect(record.engineBuildResult.bytesWritten).toBe(32);
  });
  test("ignores requested identity and keeps unsupported-engine observations absent", () => {
    const input = validRecord();
    input.request = { resolvedInputs: { platformManifestDigest: `sha256:${"2".repeat(64)}` } };
    input.producerIdentity = "claimed producer"; input.frontendIdentity = "claimed frontend";
    const record = diagnosticRecord(input);
    expect(record.engineBuildResult).toBeNull();
    expect(record.missingIdentity).toEqual(["producer", "frontend"]);
    expect(record.request).toBeUndefined();
  });
  for (const bad of [false, 4, {}, { bytesWritten: 32 }]) {
    test(`rejects malformed operation observations ${JSON.stringify(bad)}`, () => {
      expect(() => diagnosticRecord({ ...validRecord(), buildResult: bad })).toThrow();
    });
  }

  for (const role of ["iso", "wasm"]) {
    for (const value of [null, true, 0, -1, 1.5, "8", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      test(`${role} rejects invalid byte count ${String(value)}`, () => {
        const input = validRecord(); input[role].sizeBytes = value;
        expect(() => diagnosticRecord(input)).toThrow(/byte measurement/);
      });
    }
    for (const value of [null, "sha256:short", `sha256:${"A".repeat(64)}`, true, {}]) {
      test(`${role} rejects invalid digest ${JSON.stringify(value)}`, () => {
        const input = validRecord(); input[role].sha256 = value;
        expect(() => diagnosticRecord(input)).toThrow(/byte measurement/);
      });
    }
    test(`${role} rejects string-coercible digest objects`, () => {
      const input = validRecord();
      input[role].sha256 = { toString: () => `sha256:${"1".repeat(64)}` };
      expect(() => diagnosticRecord(input)).toThrow(/byte measurement/);
    });
    test(`${role} cannot be missing`, () => {
      const input = validRecord(); delete input[role];
      expect(() => diagnosticRecord(input)).toThrow(/byte measurement/);
    });
  }

  for (const name of ["inspect", "build", "save"]) {
    for (const value of [null, true, "1", -1, NaN, Infinity, undefined]) {
      test(`${name} rejects invalid duration ${String(value)}`, () => {
        const input = validRecord(); input.phasesMs[name] = value;
        expect(() => diagnosticRecord(input)).toThrow(/phase duration/);
      });
    }
  }
  for (const browser of [null, {}, { product: "chromium", userAgent: "fixture" },
    { product: "Chrome/140.0.1", userAgent: " " }, { product: "Chrome/unknown", userAgent: "fixture" },
    { product: "HeadlessChrome/unknown", userAgent: "fixture" },
    { product: "OtherHeadlessChrome/140.0.1.2", userAgent: "fixture" },
    { product: "HeadlessChrome/140.0.1.2 trailing", userAgent: "fixture" },
    { product: "Chrome/140.0.1", userAgent: 1 }]) {
    test(`rejects missing or malformed browser version ${JSON.stringify(browser)}`, () => {
      const input = validRecord(); input.browser = browser;
      expect(() => diagnosticRecord(input)).toThrow(/Chromium version/);
    });
  }
});

test.describe("consumed request observation fixtures", () => {
  test("persists only public asset paths and constant failure reasons", async () => {
    const { EventEmitter } = require("node:events");
    const page = new EventEmitter();
    const frame = {};
    page.mainFrame = () => frame;
    page.url = () => "https://frontend.invalid/?token=navigation-secret";
    const observer = observeFrontendResponses(page);
    const responseBytes = Buffer.from("observed public app bytes");
    const emit = (url, fail = false) => page.emit("requestfinished", {
      frame: () => frame, resourceType: () => "script", url: () => url,
      method: () => "GET", redirectedFrom: () => null, redirectedTo: () => null,
      response: async () => ({ status: () => 200, body: async () => {
        if (fail) throw new Error(`request failed: ${url}`);
        return responseBytes;
      } }),
    });
    emit("https://user:password@frontend.invalid/app.js?signature=signed-secret");
    emit("https://frontend.invalid/wasm_exec.js?token=failed-secret", true);
    emit("https://elsewhere.invalid/secret-path.js?token=cross-origin-secret");
    emit("https://frontend.invalid/private-secret-path.js?token=private-secret");
    const summary = await observer.summary();
    observer.stop();
    expect(summary.files).toEqual([{ path: "/app.js", resourceType: "script",
      sha256: digest(responseBytes), sizeBytes: responseBytes.length }]);
    expect(summary.failures).toEqual(expect.arrayContaining([
      { path: "/wasm_exec.js", reason: "frontend-response-body-unavailable" },
      { path: null, reason: "non-public-or-cross-origin-frontend-response" },
    ]));
    for (const secret of ["password", "signed-secret", "failed-secret", "navigation-secret",
      "cross-origin-secret", "private-secret", "secret-path", "https://"]) {
      expect(JSON.stringify(summary)).not.toContain(secret);
    }
  });

  function fixture() {
    const state = {
      performance: { now: () => 100 },
      navigator: { deviceMemory: 4, storage: { estimate: async () => ({ quota: 4096, usage: 1024 }) } },
      tboxCurrentOperation: { id: 7, buildAttempt: 9, state: "building" },
    };
    const context = vm.createContext(state);
    const run = source => vm.runInContext(source, context);
    run(`(${observeConsumedBuildInputs.toString()})();`);
    const page = { evaluate: async (fn, arg) => run(`(${fn.toString()})(${JSON.stringify(arg)})`) };
    return { state, run, page, identity: { operationId: 7, attempt: 9 } };
  }

  test("captures the exact parser string, not a later request serialization", async () => {
    const { run, page, identity } = fixture();
    run(`globalThis.tboxBuildIsoWithResult = opts => {
      const consumed = { schemaVersion: 1, kind: "build-request", image: opts.request.image };
      return JSON.stringify(consumed);
    };
    globalThis.request = { image: "café", ignoredRequestClaim: "not consumed" };
    globalThis.consumed = tboxBuildIsoWithResult({request});
    request.image = "changed after consumption";
    tboxCurrentOperation.state = "completed";`);
    const measured = await completedInputMeasurements(page, identity);
    expect(measured.requestJson).toBe('{"schemaVersion":1,"kind":"build-request","image":"café"}');
    expect(measured.requestJson).not.toContain("not consumed");
    expect(measured.requestError).toBeNull();
  });

  test("preserves the same promise and native rejection object", async () => {
    const { run } = fixture();
    expect(run(`globalThis.failure = new Error("native parser failed");
      globalThis.promise = Promise.reject(failure);
      promise.catch(() => {});
      globalThis.tboxBuildIsoWithResult = () => promise;
      tboxBuildIsoWithResult({}) === promise;`)).toBe(true);
    expect(run(`globalThis.tboxBuildIso = () => { throw failure; };
      (() => { try { tboxBuildIso({}); } catch (error) { return error === failure; } })();`)).toBe(true);
  });

  for (const variant of ["not consumed", "twice serialized", "duplicate invocation", "oversized"]) {
    test(`does not invent request bytes when ${variant}`, async () => {
      const { run, page, identity } = fixture();
      const serialize = `JSON.stringify({schemaVersion:1,kind:"build-request",image:"fixture"})`;
      run(`globalThis.tboxBuildIsoWithResult = () => {
        ${variant === "not consumed" ? "" : variant === "oversized"
          ? `JSON.stringify({schemaVersion:1,kind:"build-request",image:"x".repeat(1024*1024)});`
          : `${serialize}; ${variant === "twice serialized" ? serialize + ";" : ""}`}
        return 32;
      };
      tboxBuildIsoWithResult({});
      ${variant === "duplicate invocation" ? "tboxBuildIsoWithResult({});" : ""}
      tboxCurrentOperation.state = "completed";`);
      const measured = await completedInputMeasurements(page, identity);
      expect(measured.requestJson).toBeNull();
      expect(measured.requestError).toMatch(/observation limit|not observed/);
    });
  }

  test("unrelated serializations outside the engine invocation are not consumed requests", async () => {
    const { run, page, identity } = fixture();
    run(`JSON.stringify({schemaVersion:1,kind:"build-request",image:"catalog-only"});
      tboxCurrentOperation.state = "completed";`);
    expect((await completedInputMeasurements(page, identity)).requestJson).toBeNull();
  });

  test("rejects operation drift during asynchronous storage measurement", async () => {
    const { run, page, identity } = fixture();
    run(`tboxCurrentOperation.state = "completed";
      navigator.storage.estimate = async () => {
        tboxCurrentOperation.buildAttempt++;
        return {quota:4096,usage:1024};
      };`);
    await expect(completedInputMeasurements(page, identity)).rejects.toThrow(/operation changed/);
  });

  test("records environment run and attempt as observations, never authentication", () => {
    const measured = producerEnvironment({
      GITHUB_REPOSITORY: "tuna-os/iso-builder", GITHUB_RUN_ID: "41388681015", GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "a".repeat(40), GITHUB_WORKFLOW_SHA: "b".repeat(40),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must never leak",
    });
    expect(measured.runId).toBe(41388681015);
    expect(measured.runAttempt).toBe(1);
    expect(measured.authenticated).toBe(false);
    expect(measured.raw.GITHUB_SHA).toBe("a".repeat(40));
    expect(JSON.stringify(measured)).not.toContain("must never leak");
    for (const value of ["0", "1.5", "01", "1e2", "9007199254740992", undefined]) {
      expect(producerEnvironment({ GITHUB_RUN_ID: value }).runId).toBeNull();
    }
  });

  test("enumerates missing canonical identities without promoting a verified OCI config descriptor", () => {
    const base = validRecord();
    const identity = { operationId: 7, attempt: 9 };
    const result = observedBuildFixture(base.iso.sizeBytes);
    result.observedInputs.source.config.bytesVerified = true;
    const record = browserObservedInputRecord({ ...base, identity, buildResult: result,
      inputs: { operation: identity, requestJson: null, requestError: "parser bytes unavailable" },
      frontend: { files: [], failures: [] }, env: {},
    });
    expect(record.observed.bytes_written).toBe(base.iso.sizeBytes);
    expect(record.observed.source_manifest).toBeUndefined();
    expect(record.observed.config_sha256).toBeUndefined();
    expect(record.observed.loaded_engine).toBeUndefined();
    expect(record.observed.producer_run).toBeUndefined();
    expect(record.observed.resources).toBeUndefined();
    expect(record.missingFields).toEqual([
      "build_request_sha256", "config_sha256", "deployed_frontend", "loaded_engine", "overlay",
      "producer_run", "recipe_sha256", "resources", "source_manifest",
    ]);
    expect(record.measurements.source.config.bytesVerified).toBe(true);
    expect(record.measurements.producerEnvironment.runAttempt).toBeNull();
    expect(record.measurements.missingReasons.build_request_sha256).toBe("parser bytes unavailable");
    expect(record.kind).toBe("browser-observed-input");
    expect(record.qualification).toBe("not-assessed");
  });
});

test.describe("measured executing checkout fixtures", () => {
  test("compares actual bytes with HEAD even when the index hides an edit", async () => {
    git("update-index", "--assume-unchanged", sourcePaths[0]);
    await fs.writeFile(path.join(root, sourcePaths[0]), "module.exports = 43;\n");
    expect(git("status", "--porcelain")).toBe("");
    const measured = await finalizeExecutingSource(await captureExecutingSource({ root, env }), { env });
    expect(measured.producerRun).toBeNull();
    expect(measured.producerRunMissingReason).toBe("harness-source-does-not-match-head-blob");
  });

  test("refuses ignored source bytes that have no tracked HEAD blob", async () => {
    git("rm", "--cached", "--", sourcePaths[0]);
    await fs.writeFile(path.join(root, ".gitignore"), `${sourcePaths[0]}\n`);
    commit();
    expect(git("status", "--porcelain")).toBe("");
    const measured = await finalizeExecutingSource(await captureExecutingSource({ root, env }), { env });
    expect(measured.producerRun).toBeNull();
    expect(measured.producerRunMissingReason).toBe("harness-source-not-tracked-at-head");
  });

  let root, env, revision;
  const sourcePaths = ["e2e/tests/build-measurements.js", "e2e/tests/builder.spec.js",
    "e2e/tests/fixtures.js", "e2e/playwright.config.js", ".github/workflows/ci.yml"];
  const git = (...args) => execFileSync("git", ["-C", root, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Observation Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture source");
    return git("rev-parse", "HEAD");
  };
  const loadSource = async relative => {
    const Module = require("node:module");
    const filename = path.join(root, relative);
    const loaded = new Module(filename);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    // Bypass Playwright's transform hook: this fixture deliberately compiles
    // actual temporary-file bytes, retaining a function to keep V8 source live.
    loaded._compile(await fs.readFile(filename, "utf8"), filename);
    loaded.loaded = true;
    require.cache[filename] = loaded;
    return loaded.exports;
  };
  test.beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "measured-checkout-"));
    git("init", "-q", "--initial-branch=main");
    for (const filename of [...sourcePaths, "e2e/tests/helper.js"]) {
      await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await fs.writeFile(path.join(root, filename),
        filename.endsWith(".js") ? "module.exports = () => 42;\n" : "# measured fixture workflow\n");
    }
    revision = commit();
    env = { GITHUB_REPOSITORY: "tuna-os/iso-builder",
      GITHUB_WORKFLOW_REF: "tuna-os/iso-builder/.github/workflows/ci.yml@refs/heads/main",
      GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SHA: revision, GITHUB_WORKFLOW_SHA: revision };
    for (const filename of sourcePaths.filter(filename => filename.endsWith(".js"))) await loadSource(filename);
  });
  test.afterEach(async () => {
    for (const filename of Object.keys(require.cache)) {
      if (filename.startsWith(`${root}${path.sep}`)) delete require.cache[filename];
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  test("measures tracked HEAD blobs, executing dependencies and matching run context without authentication", async () => {
    expect((await loadSource("e2e/tests/helper.js"))()).toBe(42);
    const before = await captureExecutingSource({ root, env });
    const measured = await finalizeExecutingSource(before, { env });
    expect(measured.status).toBe("measured");
    expect(measured.authenticated).toBe(false);
    expect(measured.sourceRevision).toBe(revision);
    expect(measured.loadedSource.status).toBe("matched");
    expect(measured.loadedSource.files.every(file => file.scripts.length === 1 &&
      ["exact-source", "standard-commonjs-wrapper"].includes(file.scripts[0].comparison))).toBe(true);
    expect(measured.files.map(file => file.path)).toEqual([...sourcePaths, "e2e/tests/helper.js"].sort());
    for (const file of measured.files) {
      const bytes = await fs.readFile(path.join(root, file.path));
      expect(file.sha256).toBe(digest(bytes));
      expect(file.sizeBytes).toBe(bytes.length);
      expect(file.gitBlob).toBe(git("rev-parse", `${revision}:${file.path}`));
    }
    expect(measured.producerRun).toEqual({ repository: "tuna-os/iso-builder",
      workflowPath: ".github/workflows/ci.yml", workflowRevision: revision,
      sourceRevision: revision, harnessRevision: revision, runId: 123, runAttempt: 2 });
    expect(JSON.stringify(measured)).not.toContain(root);
    const identity = { operationId: 1, attempt: 2 };
    const record = browserObservedInputRecord({ ...validRecord(), buildResult: null, identity,
      inputs: { operation: identity }, frontend: { files: [], failures: [] },
      executingSource: measured, env });
    expect(record.observed.producer_run).toEqual(measured.producerRun);
    expect(record.missingFields).not.toContain("producer_run");
    expect(record.qualification).toBe("not-assessed");
  });

  for (const change of ["tracked edit", "untracked file"]) {
    test(`refuses a ${change} rather than claiming an environment revision`, async () => {
      await fs.writeFile(path.join(root, change === "tracked edit" ? sourcePaths[0] : "untracked.js"), "changed\n");
      const measured = await finalizeExecutingSource(await captureExecutingSource({ root, env }), { env });
      expect(measured.status).toBe("missing");
      expect(measured.producerRun).toBeNull();
      expect(measured.producerRunMissingReason).toBe("checkout-dirty-or-untracked");
    });
  }

  test("refuses a no-VCS source directory", async () => {
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
    const measured = await finalizeExecutingSource(await captureExecutingSource({ root, env }), { env });
    expect(measured.status).toBe("missing");
    expect(measured.producerRun).toBeNull();
    expect(measured.producerRunMissingReason).toBe("git-or-source-measurement-unavailable");
  });

  test("refuses changed HEAD even when the final checkout is clean", async () => {
    const before = await captureExecutingSource({ root, env });
    await fs.writeFile(path.join(root, sourcePaths[0]), "module.exports = 43;\n");
    const next = commit();
    const measured = await finalizeExecutingSource(before, { env: { ...env, GITHUB_SHA: next, GITHUB_WORKFLOW_SHA: next } });
    expect(measured.producerRun).toBeNull();
    expect(measured.producerRunMissingReason).toBe("executing-source-changed-during-build");
  });

  test("refuses a same-content rewrite during the build", async () => {
    const before = await captureExecutingSource({ root, env });
    const filename = path.join(root, sourcePaths[0]);
    await fs.writeFile(filename, await fs.readFile(filename));
    await fs.utimes(filename, new Date(1000), new Date(1000));
    expect(git("status", "--porcelain")).toBe("");
    const measured = await finalizeExecutingSource(before, { env });
    expect(measured.producerRunMissingReason).toBe("executing-source-changed-during-build");
  });

  test("refuses an executing dependency first loaded after the baseline", async () => {
    const before = await captureExecutingSource({ root, env });
    expect((await loadSource("e2e/tests/helper.js"))()).toBe(42);
    const measured = await finalizeExecutingSource(before, { env });
    expect(measured.producerRunMissingReason).toBe("executing-source-changed-during-build");
  });

  for (const field of ["GITHUB_SHA", "GITHUB_WORKFLOW_SHA"]) {
    test(`does not substitute mismatching ${field} for measured source`, async () => {
      const before = await captureExecutingSource({ root, env });
      const measured = await finalizeExecutingSource(before, { env: { ...env, [field]: "a".repeat(40) } });
      expect(measured.status).toBe("measured");
      expect(measured.sourceRevision).toBe(revision);
      expect(measured.producerRun).toBeNull();
      expect(measured.producerRunMissingReason).toBe("github-source-or-workflow-revision-does-not-match-measured-checkout");
    });
  }

  for (const override of [{ GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_RUN_ID: "9007199254740992" },
    { GITHUB_WORKFLOW_REF: "other/repo/.github/workflows/ci.yml@refs/heads/main" }]) {
    test(`refuses invalid CI context ${JSON.stringify(override)}`, async () => {
      const invalid = { ...env, ...override };
      const measured = await finalizeExecutingSource(await captureExecutingSource({ root, env: invalid }), { env: invalid });
      expect(measured.status).toBe("measured");
      expect(measured.producerRun).toBeNull();
      expect(measured.producerRunMissingReason).toBe("github-run-or-workflow-context-invalid");
    });
  }

  test("does not promote a modified loaded module restored to clean HEAD bytes before capture", async () => {
    const filename = path.join(root, "e2e/tests/helper.js");
    const original = await fs.readFile(filename);
    await fs.writeFile(filename, "module.exports = () => 43;\n");
    expect((await loadSource("e2e/tests/helper.js"))()).toBe(43);
    await fs.writeFile(filename, original);
    expect(git("status", "--porcelain")).toBe("");
    const measured = await finalizeExecutingSource(await captureExecutingSource({ root, env }), { env });
    expect(measured.status).toBe("measured");
    expect(measured.sourceRevision).toBe(revision);
    expect(measured.loadedSource.files.find(file => file.path === "e2e/tests/helper.js").status).toBe("mismatched");
    expect(measured.producerRun).toBeNull();
    expect(measured.producerRunMissingReason).toBe("loaded-harness-source-not-bound-to-head");
    const identity = { operationId: 1, attempt: 2 };
    const record = browserObservedInputRecord({ ...validRecord(), buildResult: null, identity,
      inputs: { operation: identity }, frontend: { files: [], failures: [] }, executingSource: measured, env });
    expect(record.observed.producer_run).toBeUndefined();
    expect(record.missingFields).toContain("producer_run");
  });

  test("does not trust source-map sourcesContent instead of actual compiled script bytes", async () => {
    const filename = path.join(root, "e2e/tests/helper.js");
    const original = await fs.readFile(filename, "utf8");
    const map = Buffer.from(JSON.stringify({ version: 3, sources: ["helper.js"],
      sourcesContent: [original], names: [], mappings: "" })).toString("base64");
    await fs.writeFile(filename, `${original}// transformed source\n//# sourceMappingURL=data:application/json;base64,${map}\n`);
    expect((await loadSource("e2e/tests/helper.js"))()).toBe(42);
    await fs.writeFile(filename, original);
    const measured = await finalizeExecutingSource(await captureExecutingSource({ root, env }), { env });
    expect(measured.loadedSource.files.find(file => file.path === "e2e/tests/helper.js").status).toBe("mismatched");
    expect(measured.producerRun).toBeNull();
    expect(measured.producerRunMissingReason).toBe("loaded-harness-source-not-bound-to-head");
  });
});

test.describe("engine observed source coordinates", () => {
  test("preserves exact proxy transport and resolve coordinates without inventing an origin", () => {
    const input = validRecord();
    input.buildResult = observedBuildFixture(input.iso.sizeBytes);
    Object.assign(input.buildResult.observedInputs.source, {
      registryEndpoint: "https://relay.invalid/registry-proxy", repository: "tuna-os/fixture",
      requestedReference: "observed-tag", origin: "must not survive",
    });
    const record = diagnosticRecord(input);
    expect(record.engineBuildResult.observedInputs.source).toMatchObject({
      registryEndpoint: "https://relay.invalid/registry-proxy", repository: "tuna-os/fixture",
      requestedReference: "observed-tag",
    });
    expect(record.engineBuildResult.observedInputs.source.origin).toBeUndefined();
    const identity = { operationId: 1, attempt: 2 };
    const envelope = browserObservedInputRecord({ ...input, identity, inputs: { operation: identity },
      frontend: { files: [], failures: [] }, env: {} });
    expect(envelope.measurements.source.repository).toBe("tuna-os/fixture");
    expect(envelope.observed.source_manifest).toBeUndefined();
    expect(envelope.missingFields).toContain("source_manifest");
  });
  for (const endpoint of ["https://user:secret@registry.invalid", "https://registry.invalid?token=secret",
    "https://registry.invalid#secret", "file:///private", "not a URL"]) {
    test(`rejects unsafe observed transport ${endpoint}`, () => {
      const input = validRecord();
      input.buildResult = observedBuildFixture(input.iso.sizeBytes);
      input.buildResult.observedInputs.source.registryEndpoint = endpoint;
      expect(() => diagnosticRecord(input)).toThrow(/observed (?:registry endpoint|source coordinates)/);
    });
  }
  for (const field of ["registryEndpoint", "repository", "requestedReference"]) {
    test(`rejects malformed optional ${field}`, () => {
      for (const value of ["", " leading-space", "control\u0000character", 42, null]) {
        const input = validRecord();
        input.buildResult = observedBuildFixture(input.iso.sizeBytes);
        input.buildResult.observedInputs.source[field] = value;
        expect(() => diagnosticRecord(input)).toThrow(/observed source coordinates/);
      }
    });
  }
});

test.describe("additive measured engine identity", () => {
  function measuredFixture() {
    const input = validRecord();
    input.buildResult = observedBuildFixture(input.iso.sizeBytes);
    const observed = input.buildResult.observedInputs;
    observed.source.config.bytesVerified = true;
    observed.source.config.content = { os: "linux", architecture: "amd64", variant: "v2" };
    observed.overlay.baseDigest = observed.source.manifestDigest;
    observed.overlay.baseAnnotationMatched = true;
    const appId = "org.tunaos.Fisherman";
    const commit = `sha256:${"7".repeat(64)}`;
    observed.installer = {
      sourceStamp: { path: "etc/tunaos/live-source.json", sha256: `sha256:${"6".repeat(64)}`, sizeBytes: 128 },
      stampClaims: { appId, revision: commit, bundleSha256Claim: `sha256:${"8".repeat(64)}` },
      deployment: { appId, ref: `app/${appId}/x86_64/stable`, arch: "x86_64",
        deployedCommit: commit, metadataSha256: `sha256:${"9".repeat(64)}`, sourceStampMatched: true },
      helper: { path: `var/lib/flatpak/app/${appId}/x86_64/stable/${"7".repeat(64)}/files/bin/fisherman`,
        sha256: `sha256:${"a".repeat(64)}`, sizeBytes: 256 },
      shippedRecipe: { path: "etc/bootc-installer/recipe.json", sha256: `sha256:${"b".repeat(64)}`, sizeBytes: 64 },
    };
    observed.engine = { module: "github.com/tuna-os/tacklebox", package: "github.com/tuna-os/tacklebox/cmd/tbwasm",
      goVersion: "go1.26.3", vcsRevision: "c".repeat(40), vcsModified: "false" };
    const identity = { operationId: 7, attempt: 9 };
    return { ...input, identity, inputs: { operation: identity, requestJson: '{"kind":"build-request","schemaVersion":1}',
      deviceMemory: 4, elapsedMs: 100, storage: { quota: 4096, usage: 1024 } },
      frontend: { files: [{ path: "/wasm_exec.js", sha256: `sha256:${"d".repeat(64)}`, sizeBytes: 128 }],
        failures: [] }, env: {} };
  }

  test("promotes only matched measured identities, not bundle claims or shipped-file hash domains", () => {
    const input = measuredFixture();
    const record = browserObservedInputRecord(input);
    const facts = input.buildResult.observedInputs;
    expect(record.observed.overlay).toEqual({ kind: "oci-platform-manifest",
      digest: facts.overlay.manifestDigest, baseDigest: facts.source.manifestDigest });
    expect(record.observed.deployed_frontend).toEqual({ kind: "flatpak-commit",
      appId: "org.tunaos.Fisherman", ref: "app/org.tunaos.Fisherman/x86_64/stable",
      arch: "x86_64", deployedCommit: facts.installer.deployment.deployedCommit });
    expect(record.observed.loaded_engine).toEqual({ kind: "wasm-module", sha256: input.wasm.sha256,
      sourceRevision: facts.engine.vcsRevision, runtimeShimSha256: input.frontend.files[0].sha256 });
    expect(record.measurements.source.config.content).toEqual({ os: "linux", architecture: "amd64", variant: "v2" });
    expect(record.measurements.shippedRecipe).toEqual(facts.installer.shippedRecipe);
    expect(record.measurements.installer.stampClaims.bundleSha256Claim).toBe(facts.installer.stampClaims.bundleSha256Claim);
    expect(record.observed.deployed_frontend.bundleSha256).toBeUndefined();
    expect(record.observed.recipe_sha256).toBeUndefined();
    expect(record.observed.config_sha256).toBeUndefined();
    expect(record.observed.source_manifest).toBeUndefined();
    expect(record.missingFields).toEqual(["config_sha256", "producer_run", "recipe_sha256", "source_manifest"]);
    expect(record.qualification).toBe("not-assessed");
  });

  test("copies only known additive observations without retaining mutable aliases", () => {
    const input = measuredFixture();
    const facts = input.buildResult.observedInputs;
    facts.installer.authenticated = true;
    facts.engine.qualified = true;
    facts.source.config.content.cpuBaseline = "request-only";
    const record = diagnosticRecord(input);
    facts.installer.deployment.ref = "changed";
    facts.installer.helper.sha256 = `sha256:${"f".repeat(64)}`;
    facts.engine.vcsRevision = "e".repeat(40);
    facts.source.config.content.os = "changed";
    const copied = record.engineBuildResult.observedInputs;
    expect(copied.installer.deployment.ref).toBe("app/org.tunaos.Fisherman/x86_64/stable");
    expect(copied.installer.helper.sha256).toBe(`sha256:${"a".repeat(64)}`);
    expect(copied.engine.vcsRevision).toBe("c".repeat(40));
    expect(copied.source.config.content.os).toBe("linux");
    expect(copied.installer.authenticated).toBeUndefined();
    expect(copied.engine.qualified).toBeUndefined();
    expect(copied.source.config.content.cpuBaseline).toBeUndefined();
  });

  for (const mode of ["missing base digest", "different base digest", "unmatched annotation"]) {
    test(`does not promote overlay with ${mode}`, () => {
      const input = measuredFixture();
      const overlay = input.buildResult.observedInputs.overlay;
      if (mode === "missing base digest") delete overlay.baseDigest;
      if (mode === "different base digest") overlay.baseDigest = `sha256:${"0".repeat(64)}`;
      if (mode === "unmatched annotation") overlay.baseAnnotationMatched = false;
      const record = browserObservedInputRecord(input);
      expect(record.observed.overlay).toBeUndefined();
      expect(record.missingFields).toContain("overlay");
      expect(record.measurements.overlay).toEqual(overlay);
    });
  }

  for (const mode of ["stamp only", "deployment mismatch", "missing source-stamp revision"]) {
    test(`does not turn installer ${mode} into a deployed frontend`, () => {
      const input = measuredFixture();
      const installer = input.buildResult.observedInputs.installer;
      if (mode === "stamp only") {
        delete installer.deployment; delete installer.helper; delete installer.shippedRecipe;
        installer.missingReason = "deployment-missing";
      } else {
        installer.deployment.sourceStampMatched = false;
        installer.missingReason = "source-stamp-deployment-mismatch";
        if (mode === "deployment mismatch") installer.stampClaims.revision = `sha256:${"0".repeat(64)}`;
        else delete installer.stampClaims.revision;
      }
      const record = browserObservedInputRecord(input);
      expect(record.observed.deployed_frontend).toBeUndefined();
      expect(record.missingFields).toContain("deployed_frontend");
      expect(record.measurements.installer.missingReason).toBe(installer.missingReason);
    });
  }

  for (const mode of ["dirty", "no revision", "no modified stamp", "native package", "missing shim", "ambiguous shim"]) {
    test(`does not identify loaded engine from ${mode}`, () => {
      const input = measuredFixture();
      const engine = input.buildResult.observedInputs.engine;
      if (mode === "dirty") engine.vcsModified = "true";
      if (mode === "no revision") delete engine.vcsRevision;
      if (mode === "no modified stamp") delete engine.vcsModified;
      if (mode === "native package") engine.package = "github.com/tuna-os/tacklebox/cmd/purebuild";
      if (mode === "missing shim") input.frontend.files = [];
      if (mode === "ambiguous shim") input.frontend.files.push({ ...input.frontend.files[0] });
      const record = browserObservedInputRecord(input);
      expect(record.observed.loaded_engine).toBeUndefined();
      expect(record.missingFields).toContain("loaded_engine");
      expect(record.measurements.engine).toEqual(engine);
    });
  }

  const malformed = [
    ["unverified config content", o => { o.source.config.bytesVerified = false; }],
    ["non-object config content", o => { o.source.config.content = []; }],
    ["non-string config OS", o => { o.source.config.content.os = true; }],
    ["base digest on absent overlay", o => { o.overlay = { status: "absent", layersApplied: false,
      baseAnnotationMatched: false, baseDigest: o.source.manifestDigest }; }],
    ["invalid base digest", o => { o.overlay.baseDigest = "not a digest"; }],
    ["unsafe source-stamp size", o => { o.installer.sourceStamp.sizeBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ["different source-stamp path", o => { o.installer.sourceStamp.path = "other/stamp.json"; }],
    ["path traversal helper", o => { o.installer.helper.path = "../bin/fisherman"; }],
    ["different recipe path", o => { o.installer.shippedRecipe.path = "unconsumed/recipe.json"; }],
    ["unmatched ref architecture", o => { o.installer.deployment.arch = "aarch64"; }],
    ["invalid deployed commit", o => { o.installer.deployment.deployedCommit = "claim"; }],
    ["invalid metadata hash", o => { o.installer.deployment.metadataSha256 = false; }],
    ["non-boolean stamp match", o => { o.installer.deployment.sourceStampMatched = "true"; }],
    ["contradictory stamp match", o => { o.installer.stampClaims.revision = `sha256:${"0".repeat(64)}`; }],
    ["unstructured missing reason", o => { o.installer.missingReason = "secret URL or raw error"; }],
    ["unattributable module", o => { o.engine.module = "example.invalid/another-engine"; }],
    ["unattributable package", o => { o.engine.package = "example.invalid/another-engine/cmd/wasm"; }],
    ["empty Go version", o => { o.engine.goVersion = ""; }],
    ["short engine revision", o => { o.engine.vcsRevision = "abcd"; }],
    ["uppercase engine revision", o => { o.engine.vcsRevision = "C".repeat(40); }],
    ["non-string modified stamp", o => { o.engine.vcsModified = false; }],
  ];
  for (const [name, mutate] of malformed) {
    test(`rejects ${name}`, () => {
      const input = measuredFixture();
      mutate(input.buildResult.observedInputs);
      expect(() => diagnosticRecord(input)).toThrow(/invalid observed/);
    });
  }
});

test.describe("native WASM diagnostic observation: consumed inputs", () => {
  test("joins closed download, consumed request and loaded frontend bytes without completing missing identities", async ({ page }, testInfo) => {
    await page.addInitScript(observeLoadedWasm);
    await page.addInitScript(observeConsumedBuildInputs);
    const frontend = observeFrontendResponses(page);
    const config = 'globalThis.fixtureConfig = {label:"café"};\n';
    const shim = 'globalThis.fixtureShimLoaded = true;\n';
    const html = '<!doctype html><script src="/wasm_exec.js"></script><script src="/builder-config-data.js"></script>';
    await page.route("**/*", route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/tbox.wasm") return route.fulfill({ contentType: "application/wasm", body: WASM });
      if (pathname === "/wasm_exec.js" || pathname === "/builder-config-data.js") {
        return route.fulfill({ contentType: "application/javascript; charset=utf-8", body: pathname === "/wasm_exec.js" ? shim : config });
      }
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto("http://127.0.0.1:8931/");
    const bytes = Buffer.from("tiny observed post-close fixture; not bootable\n");
    const result = observedBuildFixture(bytes.length);
    const downloadEvent = page.waitForEvent("download");
    await page.evaluate(async ({ bytes, result }) => {
      await WebAssembly.instantiateStreaming(fetch("/tbox.wasm"));
      globalThis.tboxCurrentOperation = { id: 5, buildAttempt: 8, state: "building" };
      // A behavioral fixture for the engine's synchronous serialization boundary,
      // not a fake source/installer identity or a production engine replacement.
      globalThis.tboxBuildIsoWithResult = opts => {
        globalThis.fixtureConsumedJson = JSON.stringify({
          schemaVersion: 1, kind: "build-request", image: opts.request.image,
          options: { label: fixtureConfig.label },
        });
        return Promise.resolve(result);
      };
      const actual = await tboxBuildIsoWithResult({ request: { image: "consumed-image", catalogClaim: "not consumed" } });
      tboxCurrentOperation.state = "completed";
      tboxCurrentOperation.buildResult = actual;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
      link.download = "observed-fixture.iso";
      link.click();
    }, { bytes: [...bytes], result });
    const download = await downloadEvent;
    const filename = testInfo.outputPath("observed-fixture.iso");
    await download.saveAs(filename);
    const identity = await buildOperationIdentity(page);
    const iso = await hashSavedIso(filename, bytes.length);
    const inputs = await completedInputMeasurements(page, identity);
    const responses = await frontend.summary();
    frontend.stop();
    const session = await page.context().newCDPSession(page);
    let browser;
    try { browser = await session.send("Browser.getVersion"); }
    finally { await session.detach(); }
    const record = browserObservedInputRecord({ iso, wasm: await loadedWasmMeasurement(page), browser,
      buildResult: await completedBuildResult(page, identity), identity, inputs, frontend: responses,
      env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" },
    });
    const parsed = await page.evaluate(() => ({ json: fixtureConsumedJson, shim: fixtureShimLoaded, config: fixtureConfig }));
    expect(parsed.shim).toBe(true);
    expect(parsed.config.label).toBe("café");
    expect(record.media).toEqual({ sha256: digest(bytes), sizeBytes: bytes.length });
    expect(record.observed.selection_id).toBe("5:8");
    expect(record.observed.build_request_sha256).toBe(digest(Buffer.from(parsed.json, "utf8")));
    expect(record.measurements.buildRequest).toMatchObject({
      sizeBytes: Buffer.byteLength(parsed.json, "utf8"), encoding: "utf-8",
    });
    expect(record.measurements.buildRequest.text).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("consumed-image");
    expect(record.measurements.runtimeShim).toMatchObject({ sha256: digest(Buffer.from(shim)), sizeBytes: Buffer.byteLength(shim) });
    expect(record.measurements.config).toMatchObject({ sha256: digest(Buffer.from(config)), sizeBytes: Buffer.byteLength(config) });
    expect(record.measurements.frontendFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "document", sha256: digest(Buffer.from(html)) }),
    ]));
    expect(record.measurements.producerEnvironment.runAttempt).toBe(2);
    expect(record.missingFields).toEqual(expect.arrayContaining(["config_sha256", "recipe_sha256", "deployed_frontend", "loaded_engine"]));
    expect(record.observed.config_sha256).toBeUndefined();
    expect(record.qualification).toBe("not-assessed");
    await expect(completedBuildResult(page, identity)).resolves.toEqual(result);
    await fs.writeFile(testInfo.outputPath("browser-observed-input.json"), `${JSON.stringify(record, null, 2)}\n`);
  });
});

test.describe("diagnostic wiring boundaries", () => {
  test("the actual diagnostic filename misses every qualification consumer glob", async () => {
    const root = path.resolve(__dirname, "../..");
    const builder = await fs.readFile(path.join(__dirname, "builder.spec.js"), "utf8");
    const workflow = await fs.readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const expression = builder.match(/const measurementPath = ([^;]+);/);
    expect(expression).not.toBeNull();
    const evPath = "test-results/qual-evidence-synthetic-s1.json";
    const diagnosticPath = vm.runInNewContext(expression[1], { path, evPath });
    expect(path.dirname(diagnosticPath)).toBe(path.dirname(evPath));
    expect(path.basename(diagnosticPath)).toBe("build-measurements-qual-evidence-synthetic-s1.json");

    // The validator's glob moved out of the workflow into the script its recipe runs.
    const validator = await fs.readFile(path.join(root, "scripts/validate-qualification-evidence.py"), "utf8");
    const validationGlobs = [...validator.matchAll(/glob\.glob\(f"([^"]+)"\)/g)]
      .map(match => match[1].replaceAll("{slug}", "synthetic"));
    const uploadGlobs = [...workflow.matchAll(/^\s+path: (e2e\/test-results\/qual-evidence-.+\.json)\s*$/gm)]
      .map(match => match[1].replaceAll("${{ matrix.edition.slug }}", "synthetic").replace(/^e2e\//, ""));
    expect(validationGlobs.length).toBeGreaterThan(0);
    expect(uploadGlobs.length).toBeGreaterThan(0);
    for (const glob of [...validationGlobs, ...uploadGlobs]) {
      expect(path.matchesGlob(evPath, glob), glob).toBe(true);
      expect(path.matchesGlob(diagnosticPath, glob), glob).toBe(false);
    }
    const diagnosticsUpload = workflow.match(/- name: upload diagnostics\n([\s\S]*?)if-no-files-found:/);
    expect(diagnosticsUpload).not.toBeNull();
    expect(diagnosticsUpload[1]).toMatch(/^\s+e2e\/test-results\/\s*$/m);
  });

  test("full-build wiring observes before navigation and measures both files before cleanup", async () => {
    const builder = await fs.readFile(path.join(__dirname, "builder.spec.js"), "utf8");
    const full = builder.slice(builder.indexOf('test("full build streams a bootable ISO @full"'));
    expect(full.indexOf("await page.addInitScript(observeLoadedWasm)")).toBeGreaterThan(-1);
    expect(full.indexOf("await page.addInitScript(observeLoadedWasm)")).toBeLessThan(full.indexOf("page.goto("));
    const measured = full.indexOf("await hashSavedIso(out, size)");
    expect(measured).toBeGreaterThan(-1);
    expect(measured).toBeLessThan(full.indexOf("fs.unlinkSync(out)"));
    expect(full.indexOf("buildIdentity = await buildOperationIdentity(page)")).toBeLessThan(full.indexOf("dl = await Promise.race"));
    expect(full.indexOf("const buildResult = await completedBuildResult(page, buildIdentity)")).toBeLessThan(measured);
    expect(full.indexOf("expect(await completedBuildResult(page, buildIdentity)).toEqual(buildResult)")).toBeGreaterThan(measured);
    expect(full).toMatch(/if \(process\.env\.TBOX_E2E_ISO_COPY\)\s*\{\s*const retained = await hashSavedIso\(process\.env\.TBOX_E2E_ISO_COPY, size\);\s*expect\(retained\)\.toEqual\(iso\);/);
  });
});
