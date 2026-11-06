const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { qualifiedCatalogFixture } = require("./qualified-catalog-fixture");
const { observedBuildFixture } = require("./observed-build-fixture");
const legacyConfig = require("../../tests/fixtures/guided/legacy-config-v1.json");

// Component/consumer coverage of the served app, not ISO, kernel or qualification
// proof. Reuse the existing synthetic catalog admission fixture. The real
// default loader instantiates an empty WASM module; a bounded Go.run fixture
// registers four-byte engine consumers at its normal export-capture boundary.
// This tests frontend registration/admission, not the implementation of LZ4.
async function readyPage(page, { legacy = false, autodl = false, cold = false, hold = false, nativePicker = false } = {}) {
  await page.route("**/wasm_exec.js", route => route.fulfill({
    contentType: "text/javascript",
    body: `globalThis.Go = class {
      constructor() { this.importObject = {}; globalThis.__compression.events.push("load"); }
      run() { globalThis.__registerCompressionEngine(); }
    };`,
  }));
  await page.route("**/tbox.wasm", async route => {
    // Exercise actual transient activation expiry, not a fake clock or a
    // permissive picker. The production loader must finish before confirmation.
    if (cold) await page.waitForFunction(() => !navigator.userActivation.isActive);
    if (hold) await page.waitForFunction(() => window.__compression.releaseWasm);
    await route.fulfill({
      contentType: "application/wasm",
      body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    });
  });
  await page.route("https://**/*", route => route.abort());
  await qualifiedCatalogFixture(page);
  if (legacy) {
    await page.route("**/builder-config-data.js", route => route.fulfill({
      contentType: "text/javascript",
      body: `globalThis.TBOX_BUILDER_CONFIG=${JSON.stringify(legacyConfig)};`,
    }));
  }
  await page.goto(`/${autodl ? "?autodl=1" : ""}`);
  await expect(page.locator("#introspect")).toBeEnabled();
  await page.locator("#introspect").click();
  await expect(page.locator("#build")).toBeEnabled();
  await openDetails(page, "advanced-options");
  await expect(page.getByLabel("Live filesystem compression", { exact: true })).toHaveValue("none");
  await page.evaluate(({ fixture, nativePicker }) => {
    window.__compression = { events: [], requests: [], fixture, pickerActivation: [] };
    const record = event => window.__compression.events.push(event);
    // Observe the real sink entry point too: refusal must precede even entering
    // isoSink, not merely precede writing the first byte.
    const originalSink = window.isoSink;
    window.isoSink = async (...args) => {
      record("sink");
      window.__compression.inSink = true;
      try { return await originalSink(...args); }
      finally { window.__compression.inSink = false; }
    };
    const originalDirectory = navigator.storage.getDirectory.bind(navigator.storage);
    navigator.storage.getDirectory = async () => {
      if (window.__compression.inSink) record("opfs");
      return originalDirectory();
    };
    const originalPicker = window.showSaveFilePicker?.bind(window);
    window.showSaveFilePicker = async (...args) => {
      record("picker");
      const active = navigator.userActivation.isActive;
      window.__compression.pickerActivation.push(active);
      if (!active) throw new DOMException("Native file selection requires transient activation", "SecurityError");
      if (nativePicker) {
        if (!originalPicker) throw new Error("This browser has no native save picker");
        try {
          await originalPicker(...args);
          throw new Error("Native picker unexpectedly selected a file; no writable was opened");
        } catch (error) {
          window.__compression.nativePickerError = error.name;
          throw error;
        }
      }
      return { createWritable: async () => {
        record("writer");
        return {
          write: async () => { record("write"); },
          close: async () => {
            record("close");
            if (window.__compression.pauseClose) await new Promise(resolve => { window.__compression.resumeClose = resolve; });
          },
          abort: async () => { record("abort"); },
        };
      } };
    };
    window.__registerCompressionEngine = () => {
      record("register");
      window.__compression.activationAfterColdLoad = navigator.userActivation.isActive;
      const capability = window.__compression.capability;
      if (capability?.kind === "non-function") window.tboxGetCapabilities = {};
      else if (capability?.kind !== "missing") window.tboxGetCapabilities = () => {
        record("capabilities");
        if (capability?.kind === "throw") throw new Error("fixture capability failure");
        if (capability?.kind === "promise") return Promise.resolve({ schemaVersion: 1, rootfsCompression: ["none", "lz4"] });
        return capability ? capability.value : { schemaVersion: 1, rootfsCompression: ["none", "lz4"] };
      };
      window.tboxIntrospect = async request => {
        record("introspect");
        window.__compression.inspectedRequest = structuredClone(request);
        if (window.__compression.pauseInspect) await new Promise(resolve => { window.__compression.resumeInspect = resolve; });
        return JSON.stringify({ desktop: "gnome", pkgManager: "dnf", kernelVer: "fixture-not-a-kernel" });
      };
      const build = async (options, write, withResult) => {
        record(withResult ? "build-result" : "build-legacy");
        window.__compression.requests.push(structuredClone(options.request));
        if (window.__compression.pauseBuild) await new Promise(resolve => { window.__compression.resumeBuild = resolve; });
        await write(new Uint8Array([1, 2, 3, 4]));
        return withResult ? window.__compression.fixture : 4;
      };
      if (!window.__compression.legacyResult) window.tboxBuildIsoWithResult = (options, write) => build(options, write, true);
      window.tboxBuildIso = (options, write) => build(options, write, false);
      window.tboxBuildDdiIso = async () => { record("build-ddi"); throw new Error("DDI must refuse before invoking the engine"); };
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.__compression.clipboard = text; },
    } });
  }, { fixture: observedBuildFixture(), nativePicker });
}

async function openDetails(page, id) {
  if (!await page.locator(`#${id}`).evaluate(element => element.open)) {
    await page.locator(`#${id} > summary`).click();
  }
}

async function openReview(page) {
  await page.locator("#build").click();
  await expect(page.locator("#build-review")).toBeVisible();
}

async function createIso(page) {
  await openReview(page);
  await page.locator("#review-create").click();
}

// Playwright evaluations set userGesture:true. Locator polling during expiry
// would renew activation and keep the deliberately cold response pending.
// Observe from one passive CDP call, within the original 15-second window.
async function waitForColdEngineOutcome(page, review) {
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send("Runtime.evaluate", {
      expression: `new Promise((resolve, reject) => {
        const deadline = performance.now() + 15000;
        function observe() {
          const registered = window.__compression?.events.includes("register");
          const ready = ${review
            ? 'document.querySelector("#review-create")?.disabled === false'
            : 'document.querySelector("#stage")?.textContent.includes("ISO saved")'};
          if (registered && ready) return resolve();
          if (performance.now() >= deadline) return reject(new Error("Cold engine outcome deadline"));
          setTimeout(observe, 25);
        }
        observe();
      })`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
  } finally {
    await session.detach();
  }
}

async function assertExports(page, mode) {
  const rendered = JSON.parse(await page.locator("#fallbackjson").textContent());
  expect(rendered.options.rootfsCompression).toBe(mode);
  const command = `tacklebox purebuild --request build-request.json${mode === "lz4" ? " --rootfs-compression=lz4" : ""}`;
  await expect(page.locator("#fallbackcmd")).toHaveText(command);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#downloadrequest").click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("build-request.json");
  const exported = JSON.parse(await fs.readFile(await download.path(), "utf8"));
  expect(exported).toEqual(rendered);
  await page.locator("#copyfallback").click();
  await expect(page.locator("#copyfallback")).toHaveText("Copied!");
  const clipboard = await page.evaluate(() => window.__compression.clipboard);
  expect(clipboard).toBe(`cat <<'EOF' > build-request.json\n${JSON.stringify(exported, null, 2)}\nEOF\n${command}`);
  return exported;
}

async function selectAnotherGuidedImage(page) {
  const previous = await page.locator("#image").inputValue();
  await page.getByRole("button", { name: "Help me choose / browse all setups" }).click();
  await page.getByRole("radio", { name: /KDE/ }).check();
  // Follow the real bounded question flow, retaining current answers where valid.
  for (let step = 0; step < 8; step++) {
    const next = page.locator(".guided-next");
    if (await next.isDisabled()) await page.locator("#guided-question input[type=radio]:not(:disabled)").first().check();
    const review = (await next.textContent()) === "Review images";
    await next.click();
    if (review) break;
  }
  await page.locator(".guided-use:not(:disabled)").first().click();
  await expect(page.locator("#image")).not.toHaveValue(previous);
}

test.describe("per-build live filesystem compression", () => {
  test.describe.configure({ timeout: 30_000 });

  for (const legacy of [false, true]) {
    test(`${legacy ? "legacy" : "guided"}: default None exports explicitly and builds with an old engine`, async ({ page }) => {
      await readyPage(page, { legacy });
      await page.evaluate(() => {
        window.__compression.capability = { kind: "missing" };
        window.__compression.legacyResult = true;
      });
      const request = await assertExports(page, "none");
      await createIso(page);
      await expect(page.locator("#stage")).toContainText("ISO saved");
      const consumed = await page.evaluate(() => window.__compression.requests);
      expect(consumed).toEqual([request]);
      expect(await page.evaluate(() => window.__compression.events)).not.toContain("capabilities");
      expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
    });

    test(`${legacy ? "legacy" : "guided"}: LZ4 survives label, app and source edits into downloads and the engine`, async ({ page }) => {
      await readyPage(page, { legacy });
      await page.locator("#rootfs-compression").selectOption("lz4");
      await page.locator("#label").fill("LZ4_LABEL");
      await openDetails(page, "apps-options");
      await page.locator("#fpnone").click();
      if (legacy) {
        await openDetails(page, "base-options");
        await page.locator("#variant").selectOption("sailfin");
      } else {
        await selectAnotherGuidedImage(page);
      }
      await expect(page.locator("#rootfs-compression")).toHaveValue("lz4");
      await expect(page.locator("#build")).toBeDisabled();
      // Ordinary inspection reconstructs the request and applies detected facts.
      await page.locator("#introspect").click();
      await expect(page.locator("#build")).toBeEnabled();
      await expect(page.locator("#rootfs-compression")).toHaveValue("lz4");
      const request = await assertExports(page, "lz4");
      expect(request.options.label).toBe("LZ4_LABEL");
      expect(request.options.flatpaks).toEqual([]);
      await page.evaluate(() => { window.__compression.events = []; });
      await createIso(page);
      await expect(page.locator("#stage")).toContainText("ISO saved");
      expect(await page.evaluate(() => window.__compression.requests)).toEqual([request]);
      expect(await page.evaluate(() => window.__compression.events)).toEqual([
        "load", "register", "capabilities", "capabilities", "sink", "picker", "writer", "introspect", "build-result", "write", "close",
      ]);
    });
  }

  for (const mode of ["none", "lz4"]) {
    test(`${mode}: a cold engine cannot consume the final confirmation's picker activation`, async ({ page }) => {
      await readyPage(page, { cold: true });
      await page.locator("#rootfs-compression").selectOption(mode);
      await openReview(page);
      if (mode === "lz4") {
        await expect(page.locator("#review-create")).toBeDisabled();
        await waitForColdEngineOutcome(page, true);
        expect(await page.locator("#review-create").isEnabled()).toBe(true);
        expect(await page.evaluate(() => window.__compression.activationAfterColdLoad)).toBe(false);
      }
      await page.locator("#review-create").click();
      if (mode === "none") {
        await waitForColdEngineOutcome(page, false);
        expect(await page.locator("#stage").textContent()).toContain("ISO saved");
      } else {
        await expect(page.locator("#stage")).toContainText("ISO saved", { timeout: 15_000 });
      }
      expect(await page.evaluate(() => window.__compression.pickerActivation)).toEqual([true]);
      const events = await page.evaluate(() => window.__compression.events);
      expect(events.indexOf("picker") < events.indexOf("load")).toBe(mode === "none");
      if (mode === "lz4") expect(events.filter(event => event === "capabilities")).toHaveLength(2);
    });

    test(`${mode}: actual native picker cancellation uses a fresh gesture and opens no writer`, async ({ page }) => {
      // Only the native picker is exercised here; the Go consumer remains the
      // explicit component fixture above. No selected/saved file is claimed.
      await readyPage(page, { cold: true, nativePicker: true });
      await page.locator("#rootfs-compression").selectOption(mode);
      await openReview(page);
      if (mode === "lz4") {
        await waitForColdEngineOutcome(page, true);
        expect(await page.locator("#review-create").isEnabled()).toBe(true);
      } else {
        await expect(page.locator("#review-create")).toBeEnabled({ timeout: 15_000 });
      }
      await page.locator("#review-create").click();
      await expect(page.locator("#stage")).toContainText("Build cancelled");
      expect(await page.evaluate(() => window.__compression.nativePickerError)).toBe("AbortError");
      expect(await page.evaluate(() => window.__compression.pickerActivation)).toEqual([true]);
      const events = await page.evaluate(() => window.__compression.events);
      expect(events).not.toContain("writer");
      expect(events).not.toContain("introspect");
      expect(events).not.toContain("build-result");
      expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
      await expect(page.locator("#postcard")).toBeHidden();
    });
  }
  test("Back disarms a pending LZ4 check without changing a new None review", async ({ page }) => {
    await readyPage(page, { hold: true });
    await page.locator("#rootfs-compression").selectOption("lz4");
    await openReview(page);
    await expect(page.locator("#review-compression")).toContainText("Checking LZ4");
    await expect(page.locator("#review-create")).toBeDisabled();
    await page.locator("#review-back").click();
    await page.locator("#rootfs-compression").selectOption("none");
    await openReview(page);
    await expect(page.locator("#review-create")).toBeEnabled();
    await page.evaluate(() => { window.__compression.releaseWasm = true; });
    await page.waitForFunction(() => window.__compression.events.includes("register"));
    await expect(page.locator("#review-compression")).toHaveText("Uncompressed filesystem selected.");
    await expect(page.locator("#review-create")).toBeEnabled();
    expect(await page.evaluate(() => window.__compression.events)).toEqual(["load", "register"]);
  });

  test("a capability replaced after preflight is synchronously refused before the picker", async ({ page }) => {
    await readyPage(page);
    await page.locator("#rootfs-compression").selectOption("lz4");
    await openReview(page);
    await expect(page.locator("#review-create")).toBeEnabled();
    await page.evaluate(() => {
      window.__compression.events = [];
      window.tboxGetCapabilities = () => {
        window.__compression.events.push("replaced-capabilities");
        return { schemaVersion: 1, rootfsCompression: ["none", "lz4"] };
      };
    });
    await page.locator("#review-create").click();
    await expect(page.locator("#stage")).toContainText("LZ4 live filesystem compression is unavailable");
    expect(await page.evaluate(() => window.__compression.events)).toEqual([]);
    expect(await page.evaluate(() => window.__compression.requests)).toEqual([]);
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
    await expect(page.locator("#postcard")).toBeHidden();
  });


  test("a supported loaded engine is checked before sink and lazy catalog introspection", async ({ page }) => {
    await readyPage(page);
    await page.locator("#rootfs-compression").selectOption("lz4");
    const request = await assertExports(page, "lz4");
    await createIso(page);
    await expect(page.locator("#stage")).toContainText("ISO saved");
    expect(await page.evaluate(() => window.__compression.events)).toEqual([
      "load", "register", "capabilities", "capabilities", "sink", "picker", "writer", "introspect", "build-result", "write", "close",
    ]);
    expect(await page.evaluate(() => window.__compression.inspectedRequest)).toEqual(request);
    expect(await page.evaluate(() => window.__compression.requests)).toEqual([request]);
  });

  test("registered LZ4 support also reaches an engine without the result API", async ({ page }) => {
    await readyPage(page);
    await page.locator("#rootfs-compression").selectOption("lz4");
    await page.evaluate(() => { window.__compression.legacyResult = true; });
    const request = await assertExports(page, "lz4");
    await createIso(page);
    await expect(page.locator("#stage")).toContainText("ISO saved");
    expect(await page.evaluate(() => window.__compression.events)).toEqual([
      "load", "register", "capabilities", "capabilities", "sink", "picker", "writer", "introspect", "build-legacy", "write", "close",
    ]);
    expect(await page.evaluate(() => window.__compression.requests)).toEqual([request]);
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
  });

  const rejectedCapabilities = [
    { name: "missing API", kind: "missing", called: false },
    { name: "non-function API", kind: "non-function", called: false },
    { name: "null response", value: null },
    { name: "missing schema", value: { rootfsCompression: ["none", "lz4"] } },
    { name: "wrong schema", value: { schemaVersion: 2, rootfsCompression: ["none", "lz4"] } },
    { name: "malformed codec list", value: { schemaVersion: 1, rootfsCompression: "none,lz4" } },
    { name: "missing codec list", value: { schemaVersion: 1 } },
    { name: "mixed-type codec list", value: { schemaVersion: 1, rootfsCompression: ["none", "lz4", 1] } },
    { name: "unsupported codec", value: { schemaVersion: 1, rootfsCompression: ["none"] } },
    { name: "asynchronous response", kind: "promise" },
    { name: "throwing API", kind: "throw" },
  ];
  for (const autodl of [false, true]) {
    for (const capability of rejectedCapabilities) {
      test(`LZ4 refuses ${capability.name} before ${autodl ? "OPFS download" : "file picker"} or any engine consumer`, async ({ page }) => {
        await readyPage(page, { autodl });
        await page.locator("#rootfs-compression").selectOption("lz4");
        await page.evaluate(capability => { window.__compression.capability = capability; }, capability);
        await openReview(page);
        await expect(page.locator("#review-create")).toBeDisabled();
        await expect(page.locator("#stage")).toContainText("LZ4 live filesystem compression is unavailable");
        await expect(page.locator("#fallbackreason")).toContainText(/LZ4|capabilit/i);
        expect(await page.evaluate(() => window.__compression.events)).toEqual([
          "load", "register", ...(capability.called === false ? [] : ["capabilities"]),
        ]);
        expect(await page.evaluate(() => window.__compression.requests)).toEqual([]);
        expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
        await expect(page.locator("#postcard")).toBeHidden();
        await expect(page.locator("#rootfs-compression")).toHaveValue("lz4");
        await page.locator("#review-back").click();
        await assertExports(page, "lz4");
      });
    }
  }

  for (const autodl of [false, true]) {
    test(`an old registered module cannot inherit stale LZ4 advertisement (${autodl ? "OPFS" : "picker"})`, async ({ page }) => {
      await readyPage(page, { autodl });
      await page.locator("#rootfs-compression").selectOption("lz4");
      await page.evaluate(() => {
        window.__compression.capability = { kind: "missing" };
        window.tboxGetCapabilities = () => {
          window.__compression.events.push("stale-capabilities");
          return { schemaVersion: 1, rootfsCompression: ["none", "lz4"] };
        };
      });
      await openReview(page);
      await expect(page.locator("#review-create")).toBeDisabled();
      await expect(page.locator("#stage")).toContainText("LZ4 live filesystem compression is unavailable");
      expect(await page.evaluate(() => window.__compression.events)).toEqual(["load", "register"]);
      expect(await page.evaluate(() => typeof window.tboxGetCapabilities)).toBe("undefined");
      expect(await page.evaluate(() => window.__compression.requests)).toEqual([]);
      await expect(page.locator("#postcard")).toBeHidden();
    });

    test(`replacing a captured capability API cannot authorize LZ4 (${autodl ? "OPFS" : "picker"})`, async ({ page }) => {
      await readyPage(page, { autodl });
      await page.locator("#rootfs-compression").selectOption("lz4");
      await page.evaluate(async () => {
        await window.loadWasm();
        window.__compression.events = [];
        window.tboxGetCapabilities = () => {
          window.__compression.events.push("replaced-capabilities");
          return { schemaVersion: 1, rootfsCompression: ["none", "lz4"] };
        };
      });
      await openReview(page);
      await expect(page.locator("#review-create")).toBeDisabled();
      await expect(page.locator("#stage")).toContainText("LZ4 live filesystem compression is unavailable");
      expect(await page.evaluate(() => window.__compression.events)).toEqual([]);
      expect(await page.evaluate(() => window.__compression.requests)).toEqual([]);
      await expect(page.locator("#postcard")).toBeHidden();
    });
  }

  test("a standalone load/capability stub is not a registered engine capability", async ({ page }) => {
    await readyPage(page);
    await page.locator("#rootfs-compression").selectOption("lz4");
    await page.evaluate(() => {
      window.loadWasm = async () => { window.__compression.events.push("standalone-load"); };
      window.tboxGetCapabilities = () => {
        window.__compression.events.push("standalone-capabilities");
        return { schemaVersion: 1, rootfsCompression: ["none", "lz4"] };
      };
    });
    await openReview(page);
    await expect(page.locator("#review-create")).toBeDisabled();
    await expect(page.locator("#stage")).toContainText("LZ4 live filesystem compression is unavailable");
    expect(await page.evaluate(() => window.__compression.events)).toEqual(["standalone-load"]);
    expect(await page.evaluate(() => window.__compression.requests)).toEqual([]);
    await expect(page.locator("#postcard")).toBeHidden();
  });

  test("compression changes invalidate a completed receipt but retain inspected source facts", async ({ page }) => {
    await readyPage(page);
    await createIso(page);
    await expect(page.locator("#stage")).toContainText("ISO saved");
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toEqual(observedBuildFixture());
    const sourceState = await page.evaluate(() => ({
      id: window.tboxCurrentOperation.id,
      inspectedVia: window.tboxCurrentOperation.inspectedVia,
      resolvedInputs: window.tboxCurrentOperation.request.resolvedInputs,
      facts: document.querySelector("#facts").textContent,
    }));
    await page.locator("#rootfs-compression").selectOption("lz4");
    expect(await page.evaluate(() => ({
      id: window.tboxCurrentOperation.id,
      inspectedVia: window.tboxCurrentOperation.inspectedVia,
      resolvedInputs: window.tboxCurrentOperation.request.resolvedInputs,
      facts: document.querySelector("#facts").textContent,
    }))).toEqual(sourceState);
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
    await expect(page.locator("#postcard")).toBeHidden();
    await expect(page.locator("#build")).toBeEnabled();
    await assertExports(page, "lz4");
    await page.locator("#rootfs-compression").selectOption("none");
    await assertExports(page, "none");
  });

  test("the selector stays locked during real inspect, build and sink-close operations", async ({ page }) => {
    await readyPage(page);
    await page.locator("#rootfs-compression").selectOption("lz4");
    await page.getByText("Use a custom container image").click();
    await page.locator("#image").fill("registry.example/fixture/boot:test");
    await page.evaluate(async () => {
      await window.loadWasm();
      window.__compression.pauseInspect = true;
    });
    await page.locator("#introspect").click();
    await page.waitForFunction(() => window.__compression.resumeInspect);
    await expect(page.locator("#rootfs-compression")).toBeDisabled();
    await page.evaluate(() => window.__compression.resumeInspect());
    await expect(page.locator("#build")).toBeEnabled();
    await expect(page.locator("#rootfs-compression")).toBeEnabled();
    await page.evaluate(() => { window.__compression.pauseBuild = true; window.__compression.pauseClose = true; });
    await createIso(page);
    await page.waitForFunction(() => window.__compression.resumeBuild);
    await expect(page.locator("#rootfs-compression")).toBeDisabled();
    await page.evaluate(() => window.__compression.resumeBuild());
    await page.waitForFunction(() => window.__compression.resumeClose);
    await expect(page.locator("#rootfs-compression")).toBeDisabled();
    expect(await page.evaluate(() => window.tboxCurrentOperation.buildResult)).toBeNull();
    await page.evaluate(() => window.__compression.resumeClose());
    await expect(page.locator("#stage")).toContainText("ISO saved");
    await expect(page.locator("#rootfs-compression")).toBeEnabled();
    await expect(page.locator("#rootfs-compression")).toHaveValue("lz4");
  });

  test("legacy DDI refuses LZ4 before loading, downloading boot files or opening output", async ({ page }) => {
    await readyPage(page, { legacy: true });
    await page.locator("#rootfs-compression").selectOption("lz4");
    await openDetails(page, "base-options");
    await page.locator("#variant").selectOption("ddi:snow");
    await page.locator("#introspect").click();
    await expect(page.locator("#stage")).toContainText("DDI channel");
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    await openReview(page);
    await expect(page.locator("#review-create")).toBeDisabled();
    await expect(page.locator("#stage")).toContainText("DDI channels do not support LZ4");
    await expect(page.locator("#log")).toContainText(/DDI.*LZ4|LZ4.*DDI/i);
    expect(await page.evaluate(() => window.__compression.events)).toEqual([]);
    expect(requests).toEqual([]);
    await expect(page.locator("#postcard")).toBeHidden();
    await expect(page.locator("#rootfs-compression")).toHaveValue("lz4");
  });

  test("planning replacement refuses nondefault compression and share links explicitly omit it", async ({ page }) => {
    await readyPage(page);
    await openDetails(page, "planning-recovery");
    await page.locator("#save-plan").click();
    await expect(page.locator("#plan-status")).toContainText("saved in this tab");
    const saved = await page.evaluate(() => sessionStorage.getItem("tbox-planning-v1:tunaos"));
    await page.locator("#rootfs-compression").selectOption("lz4");
    await page.locator("#save-plan").click();
    await expect(page.locator("#plan-status")).toContainText("advanced values");
    expect(await page.evaluate(() => sessionStorage.getItem("tbox-planning-v1:tunaos"))).toBe(saved);
    await page.locator("#restore-plan").click();
    await expect(page.locator("#plan-status")).toContainText("advanced values");
    await expect(page.locator("#rootfs-compression")).toHaveValue("lz4");
    await expect(page.locator(".share-options")).toContainText(/excludes live filesystem compression/i);
    const href = await page.locator("#sharelink").getAttribute("href");
    const url = new URL(href, page.url());
    expect([...url.searchParams.keys()]).not.toContain("rootfsCompression");
    expect(url.search).not.toContain("lz4");
    await assertExports(page, "lz4");
    await page.goto(url.href);
    await openDetails(page, "advanced-options");
    await expect(page.locator("#rootfs-compression")).toHaveValue("none");
  });
});
