const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { observedBuildFixture } = require("./observed-build-fixture");
const {
  observeLoadedWasm,
  loadedWasmMeasurement,
  hashSavedIso,
  buildOperationIdentity,
  completedBuildResult,
  diagnosticRecord,
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
      "schemaVersion", "kind", "qualification", "iso", "loadedWasm", "loadedFrontend", "engineBuildResult", "missingIdentity", "browser", "phasesMs", "timingNote",
    ].sort());
  });
  test("loaded frontend observations do not fill authenticated identity gaps", () => {
    const input = validRecord();
    input.loadedFrontend = { schemaVersion: 1, kind: "diagnostic-loaded-frontend", qualification: "not-assessed",
      coverage: "page-target-only",
      authentication: "not-verified", assets: [] };
    const record = diagnosticRecord(input);
    expect(record.loadedFrontend).toEqual(input.loadedFrontend);
    expect(record.qualification).toBe("not-assessed");
    expect(record.missingIdentity).toEqual(["producer", "frontend"]);
    input.loadedFrontend.authentication = "verified";
    expect(() => diagnosticRecord(input)).toThrow(/frontend observation/);
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

    const validationGlobs = [...workflow.matchAll(/glob\.glob\(f"([^"]+)"\)/g)]
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
