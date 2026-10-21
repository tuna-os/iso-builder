const { test, expect } = require("@playwright/test");
const { validateBuildResult } = require("../../app/public/build-result");
const { diagnosticRecord, completedBuildResult, hashSavedIso } = require("./build-measurements");
const { qualifiedCatalogFixture } = require("./qualified-catalog-fixture");
const { observedBuildFixture } = require("./observed-build-fixture");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

test.describe("engine result validation", () => {
  for (const repository of ["team/my__image", "team/my--image", "team/my.image"]) {
    test(`preserves OCI repository separator ${repository}`, () => {
      const input = observedBuildFixture();
      Object.assign(input.observedInputs.source, {registryEndpoint: "https://relay.invalid", repository, requestedReference: "v1.2"});
      expect(validateBuildResult(input, 4)).toEqual(input);
    });
  }
  test("preserves explicit HTTP diagnostic transport without qualifying its origin", () => {
    const input = observedBuildFixture();
    Object.assign(input.observedInputs.source, {registryEndpoint: "http://127.0.0.1:5443/proxy", repository: "team/image", requestedReference: "latest"});
    expect(validateBuildResult(input, 4)).toEqual(input);
  });
  test("preserves exact operation request coordinates without inferring origin", () => {
    const input = observedBuildFixture();
    Object.assign(input.observedInputs.source, {registryEndpoint: "https://relay.invalid:5443/proxy", repository: "team/image", requestedReference: "latest"});
    const result = validateBuildResult(input, 4);
    expect(result).toEqual(input);
    expect(result.observedInputs.source.origin).toBeUndefined();
    input.observedInputs.source.repository = "mutated/image";
    expect(result.observedInputs.source.repository).toBe("team/image");
  });
  for (const [key, value] of [["registryEndpoint", "https:relay.invalid"], ["registryEndpoint", "https://relay.invalid:0443"], ["registryEndpoint", "https://relay.invalid/a//b"], ["registryEndpoint", "https://relay.invalid/proxy/../other"], ["registryEndpoint", "https://relay.invalid?"], ["registryEndpoint", "https://relay.invalid#"], ["repository", undefined], ["repository", "../image"], ["repository", "team/image@sha256:bad"], ["registryEndpoint", "https://user:secret@relay.invalid"], ["registryEndpoint", "https://relay.invalid?other"], ["registryEndpoint", "https://relay.invalid/#other"], ["requestedReference", "sha256:bad"], ["requestedReference", "tag/other"]]) {
    test(`rejects malformed observed request ${key} ${String(value)}`, () => {
      const input = observedBuildFixture();
      Object.assign(input.observedInputs.source, {registryEndpoint: "https://relay.invalid", repository: "team/image", requestedReference: "latest", [key]: value});
      expect(() => validateBuildResult(input, 4)).toThrow(/observed source/);
    });
  }

  test("copies observed facts only, retaining unverified config and overlay linkage", () => {
    const input = observedBuildFixture();
    input.observedInputs.source.requestedPlatform = "linux/arm64";
    input.observedInputs.qualified = true;
    input.frontendRevision = "invented";
    const result = validateBuildResult(input, 4);
    expect(result).toEqual(observedBuildFixture());
    input.observedInputs.source.platformDescriptor.architecture = "changed";
    expect(result.observedInputs.source.platformDescriptor.architecture).toBe("amd64");
  });
  test("retains direct-manifest gaps instead of inventing an index or platform", () => {
    const input = observedBuildFixture();
    delete input.observedInputs.source.indexDigest;
    delete input.observedInputs.source.platformDescriptor;
    expect(validateBuildResult(input, 4)).toEqual(input);
  });
  for (const status of ["custom-image", "absent"]) {
    test(`accepts explicit ${status} with no overlay observation`, () => {
      const input = observedBuildFixture();
      input.observedInputs.overlay = { status, layersApplied: false, baseAnnotationMatched: false };
      expect(validateBuildResult(input, 4)).toEqual(input);
    });
  }
  test("retains verified config and observed annotation match without upgrading qualification", () => {
    const input = observedBuildFixture();
    input.observedInputs.source.config.bytesVerified = true;
    input.observedInputs.overlay.baseAnnotationMatched = true;
    expect(validateBuildResult(input, 4)).toEqual(input);
  });
  for (const count of [0, -1, true, "4", 4.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 3, 5]) {
    test(`rejects unsafe or inconsistent result count ${String(count)}`, () => {
      expect(() => validateBuildResult(observedBuildFixture(count), 4)).toThrow(/byte count/);
    });
  }
  for (const count of [0, -1, true, "4", 4.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`rejects invalid sink count ${String(count)}`, () => {
      expect(() => validateBuildResult(observedBuildFixture(4), count)).toThrow(/byte count/);
    });
  }
  test("accepts maximum safe exact counts without allocating that output", () => {
    expect(validateBuildResult(observedBuildFixture(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER).bytesWritten)
      .toBe(Number.MAX_SAFE_INTEGER);
  });
  for (const [name, mutate] of [
    ["wrong schema", r => { r.observedInputs.schemaVersion = 2; }],
    ["missing observations", r => { delete r.observedInputs; }],
    ["requested-only source", r => { r.observedInputs.source = { requestedDigest: `sha256:${"1".repeat(64)}` }; }],
    ["malformed digest", r => { r.observedInputs.source.manifestDigest = "sha256:bad"; }],
    ["malformed index", r => { r.observedInputs.source.indexDigest = null; }],
    ["descriptor without index", r => { delete r.observedInputs.source.indexDigest; }],
    ["malformed platform", r => { r.observedInputs.source.platformDescriptor.architecture = false; }],
    ["missing bytesVerified", r => { delete r.observedInputs.source.config.bytesVerified; }],
    ["string bytesVerified", r => { r.observedInputs.source.config.bytesVerified = "false"; }],
    ["unsafe config size", r => { r.observedInputs.source.config.descriptor.size = Number.MAX_SAFE_INTEGER + 1; }],
    ["missing config media type", r => { delete r.observedInputs.source.config.descriptor.mediaType; }],
    ["bad overlay status", r => { r.observedInputs.overlay.status = "qualified"; }],
    ["applied without digest", r => { delete r.observedInputs.overlay.manifestDigest; }],
    ["numeric layersApplied", r => { r.observedInputs.overlay.layersApplied = 1; }],
    ["applied without layers", r => { r.observedInputs.overlay.layersApplied = false; }],
    ["unapplied with digest", r => { r.observedInputs.overlay.status = "absent"; r.observedInputs.overlay.layersApplied = false; }],
    ["unapplied matched annotation", r => { r.observedInputs.overlay = { status: "absent", layersApplied: false, baseAnnotationMatched: true }; }],
  ]) {
    test(`rejects ${name}`, () => {
      const input = observedBuildFixture(); mutate(input);
      expect(() => validateBuildResult(input, 4)).toThrow();
    });
  }
});

async function readyPage(page, { autodl = false } = {}) {
  // Never load a real engine or contact the registry. Keep the actual app,
  // catalog admission, operation state machine, and browser sink code.
  await page.route("**/wasm_exec.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/tbox.wasm", route => route.abort());
  await page.route("https://**/*", route => route.abort());
  await qualifiedCatalogFixture(page);
  await page.goto(`/?variant=sailfin&flavor=xfce&platform=linux%2Famd64${autodl ? "&autodl=1" : ""}`);
  await page.getByText("Or build from any bootable container image").click();
  await page.locator("#introspect").click();
  await expect(page.locator("#build")).toBeEnabled();
  await page.evaluate(fixture => {
    window.__fixture = fixture;
    window.__writes = 0;
    window.__closeCalls = 0;
    window.__legacyCalls = 0;
    window.__resultCalls = 0;
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async chunk => { window.__writes += chunk.byteLength; },
      close: async () => {
        window.__closeCalls++;
        if (window.__pauseClose) await new Promise(resolve => { window.__resumeClose = resolve; });
        if (window.__closeError) throw new Error("synthetic sink close error");
      },
      abort: async () => { window.__aborted = true; },
    }) });
    window.tboxIntrospect = async () => "{}";
    window.tboxBuildIso = async (_opts, write) => {
      window.__legacyCalls++;
      await write(new Uint8Array([1, 2, 3, 4]));
      return 4;
    };
    window.tboxBuildIsoWithResult = async (_opts, write) => {
      window.__resultCalls++;
      if (window.__pauseBuild) await new Promise(resolve => { window.__resumeBuild = resolve; });
      await write(new Uint8Array([1, 2, 3, 4]));
      if (window.__engineError) throw new Error("synthetic engine failure");
      return window.__fixture;
    };
    window.tboxReset = () => null;
    window.tboxResetAsync = async () => null;
  }, observedBuildFixture());
}
async function success(page) {
  await page.locator("#build").click();
  await expect(page.locator("#stage")).toContainText("Done");
  expect(await completedBuildResult(page)).toEqual(observedBuildFixture());
}
async function failed(page) {
  await expect(page.locator("#stage")).toContainText("Build failed");
  await expect(page.locator("#postcard")).toBeHidden();
  expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
  expect(await page.evaluate(() => window.tboxCurrentOperation.state)).toBe("failed");
}

test.describe("browser result lifecycle", () => {
  test.describe.configure({ timeout: 30_000 });
  test("result remains private until sink close, then publishes an immutable copy", async ({ page }) => {
    await readyPage(page);
    await page.evaluate(() => { window.__pauseClose = true; });
    await page.locator("#build").click();
    await page.waitForFunction(() => window.__resumeClose);
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
    await expect(page.locator("#postcard")).toBeHidden();
    await page.evaluate(() => {
      window.__fixture.observedInputs.source.manifestDigest = "mutated after return";
      window.__resumeClose();
    });
    await expect(page.locator("#stage")).toContainText("Done");
    expect(await completedBuildResult(page)).toEqual(observedBuildFixture());
    expect(await page.evaluate(() => window.tboxCurrentOperation.outputDelivery)).toEqual({ kind: "picker", status: "stream-closed" });
    expect(await page.evaluate(() => ({ legacy: window.__legacyCalls, result: window.__resultCalls,
      frozen: Object.isFrozen(window.tboxCurrentOperation.buildResult.observedInputs.source.config.descriptor) })))
      .toEqual({ legacy: 0, result: 1, frozen: true });
  });
  for (const absent of ["missing", "non-function"]) {
    test(`older engine ${absent} API retains numeric build and no observations`, async ({ page }) => {
      await readyPage(page);
      await page.evaluate(absent => {
        if (absent === "missing") delete window.tboxBuildIsoWithResult;
        else window.tboxBuildIsoWithResult = {};
      }, absent);
      await page.locator("#build").click();
      await expect(page.locator("#stage")).toContainText("Done");
      expect(await completedBuildResult(page)).toBeNull();
      expect(await page.evaluate(() => window.__legacyCalls)).toBe(1);
    });
  }
  for (const bad of [null, 4, {}, { bytesWritten: 4 }, observedBuildFixture(3), observedBuildFixture(Number.MAX_SAFE_INTEGER + 1)]) {
    test(`malformed result ${JSON.stringify(bad)} aborts without legacy retry`, async ({ page }) => {
      await readyPage(page);
      await page.evaluate(bad => { window.__fixture = bad; }, bad);
      await page.locator("#build").click();
      await failed(page);
      expect(await page.evaluate(() => ({ aborted: window.__aborted, closes: window.__closeCalls, legacy: window.__legacyCalls })))
        .toEqual({ aborted: true, closes: 0, legacy: 0 });
    });
  }
  test("sink close failure cannot publish the engine result or stale success", async ({ page }) => {
    await readyPage(page);
    await success(page);
    await page.evaluate(() => { window.__closeError = true; });
    await page.locator("#build").click();
    await failed(page);
    expect(await page.evaluate(() => window.__aborted)).toBe(true);
    await page.evaluate(() => { window.__closeError = false; });
    await success(page);
  });
  test("retry clears the previous result immediately and rejected engine leaves none", async ({ page }) => {
    await readyPage(page);
    await success(page);
    await page.evaluate(() => { window.__pauseBuild = true; window.__engineError = true; });
    await page.locator("#build").click();
    await page.waitForFunction(() => window.__resumeBuild);
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
    await page.evaluate(() => window.__resumeBuild());
    await failed(page);
  });
  for (const id of ["image", "platform", "label", "initrdurl", "shimurl"]) {
    test(`${id} edit clears a completed result`, async ({ page }) => {
      await readyPage(page); await success(page);
      if (id === "platform") await page.locator("#platform").selectOption("linux/arm64");
      else await page.locator(`#${id}`).evaluate((el, id) => {
        el.value = id === "image" ? "bonito:kde" : "changed";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, id);
      expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
      await expect(page.locator("#postcard")).toBeHidden();
    });
  }
  test("changed options during sink close cannot republish an obsolete result", async ({ page }) => {
    await readyPage(page);
    await page.getByText("Advanced — customize (flatpaks, packages, repos)", { exact: true }).click();
    await page.evaluate(() => { window.__pauseClose = true; });
    await page.locator("#build").click();
    await page.waitForFunction(() => window.__resumeClose);
    // Options are editable inside Advanced; open it before using normal input.
    await page.locator("#label").fill("CHANGED");
    await page.evaluate(() => window.__resumeClose());
    await failed(page);
  });
  for (const name of ["tboxReset", "tboxResetAsync"]) {
    test(`${name} clears the receipt and preserves the engine return contract`, async ({ page }) => {
      await readyPage(page); await success(page);
      expect(await page.evaluate(async name => {
        const result = window[name]();
        return { promise: result instanceof Promise, value: await result };
      }, name)).toEqual({ promise: name.endsWith("Async"), value: null });
      expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
      await expect(page.locator("#postcard")).toBeHidden();
    });
  }
  test("cancelling the next initial picker clears prior receipt", async ({ page }) => {
    await readyPage(page); await success(page);
    await page.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException("cancelled", "AbortError"); }; });
    await page.locator("#build").click();
    await expect(page.locator("#stage")).toContainText("Build cancelled");
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
  });
  for (const failure of ["cancel", "close", "write"]) {
    test(`OPFS export picker ${failure} failure is not a completed save`, async ({ page }) => {
      await readyPage(page, { autodl: true });
      await page.evaluate(failure => {
        window.showSaveFilePicker = async () => {
          if (failure === "cancel") throw new DOMException("cancelled", "AbortError");
          return { createWritable: async () => new WritableStream({
            write() { if (failure === "write") throw new Error("synthetic export write error"); },
            close() { throw new Error("synthetic export close error"); },
          }) };
        };
      }, failure);
      await page.locator("#build").click();
      await failed(page);
    });
  }
  test("unavailable OPFS export picker falls back to download initiation, without a saved-file claim", async ({ page }) => {
    await readyPage(page, { autodl: true });
    await page.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException("unavailable", "SecurityError"); }; });
    const downloading = page.waitForEvent("download");
    await success(page);
    const download = await downloading;
    expect(await page.evaluate(() => window.tboxCurrentOperation.outputDelivery))
      .toEqual({ kind: "download", status: "initiated" });
    await download.delete();
  });
  test("saved tiny download joins observed result and independent file digest only as diagnostics", async ({ page }, testInfo) => {
    await readyPage(page, { autodl: true });
    await page.evaluate(() => { delete window.showSaveFilePicker; });
    const downloading = page.waitForEvent("download");
    await success(page);
    const download = await downloading;
    expect(await page.evaluate(() => window.tboxCurrentOperation.outputDelivery)).toEqual({ kind: "download", status: "initiated" });
    const filename = testInfo.outputPath("tiny-synthetic.iso");
    try {
      await download.saveAs(filename);
      const iso = await hashSavedIso(filename, 4);
      expect(iso.sha256).toBe(`sha256:${crypto.createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex")}`);
      const record = diagnosticRecord({ iso, wasm: { sha256: `sha256:${"6".repeat(64)}`, sizeBytes: 8 },
        browser: { product: "Chrome/140.0.1", userAgent: "synthetic collector fixture" },
        phasesMs: { inspect: 0, build: 0, save: 0 }, buildResult: await completedBuildResult(page) });
      expect(record.engineBuildResult).toEqual(observedBuildFixture());
      expect(record.qualification).toBe("not-assessed");
      expect(record.missingIdentity).toEqual(["producer", "frontend"]);
      expect(() => diagnosticRecord({ iso: { ...iso, sizeBytes: 5 }, wasm: record.loadedWasm,
        browser: record.browser, phasesMs: record.phasesMs, buildResult: record.engineBuildResult })).toThrow(/byte count/);
    } finally { await fs.rm(filename, { force: true }); await download.delete(); }
  });
});
