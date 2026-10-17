// The engine's out-of-memory guard, tested without an engine.
//
// The real failure needs a multi-GB pull and ~20 minutes to reproduce
// (tuna-os/tacklebox#156), which is exactly why it went unnoticed for so
// long. The guard's own logic is independent of the engine, though: it reads
// linear memory, watches for progress, and reports. Stub the first, withhold
// the second, and fast-forward the clock over the third.
const { test, expect } = require("@playwright/test");

// watchEngineMemory() and tboxWasmMB() are reachable from the page because
// app.js is a classic script, so its top-level function declarations land on
// window. lastProgressAt is a `let` and deliberately isn't reachable — the
// guard stamps it itself on start, and withholding tboxOnProgress is what
// simulates a wedge.
async function armGuard(page, mb) {
  await page.evaluate((mb) => {
    globalThis.tboxWasmMB = () => mb;
    globalThis.__stop = window.watchEngineMemory();
  }, mb);
}

test.describe("engine OOM guard", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
  });

  test("reports out of memory when the heap parks at the ceiling and offers target-preserving local fallback", async ({ page }) => {
    await page.locator("#variant").selectOption("bonito");
    await page.locator('#editions .edition[data-de="kde"]').click();
    await expect(page.locator("#build")).toBeEnabled();
    const selectedRequest = await page.evaluate(() => window.tboxGetBuildRequest());

    await armGuard(page, 4000);
    // Past the 120s no-progress window; the guard polls every 5s.
    await page.clock.fastForward("03:00");

    await expect(page.locator("#stage")).toContainText(/Out of memory/i);
    await expect(page.locator("#build")).toBeDisabled();
    await expect(page.locator("#postcard")).toBeHidden();
    await expect(page.locator("#fallbackcard")).toBeVisible();
    await expect(page.locator("#fallbackcmd")).toContainText(
      "tacklebox purebuild --request build-request.json",
    );

    const fallbackReq = await page.evaluate(() =>
      JSON.parse(document.getElementById("fallbackjson").textContent),
    );
    expect(fallbackReq).toEqual(selectedRequest);
    expect(fallbackReq.schemaVersion).toBe(1);
    expect(fallbackReq.kind).toBe("build-request");
    expect(fallbackReq.image).toBe("tuna-os/bonito:kde");
    expect(fallbackReq.target).toEqual({
      variant: "bonito",
      flavor: "kde",
      platform: "linux/amd64",
      cpuBaseline: "x86-64",
      hardwareScope: "generic",
    });
    expect(fallbackReq.resolvedInputs.platformManifestDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  test("blocks browser build when storage quota is below prerequisite and preserves BuildRequest v1 in fallback", async ({ page }) => {
    await page.locator('#editions .edition[data-de="gnome"]').click();
    await expect(page.locator("#build")).toBeEnabled();
    const selectedRequest = await page.evaluate(() => window.tboxGetBuildRequest());
    await page.evaluate(() => {
      navigator.storage.estimate = async () => ({
        quota: 2_000_000_000, usage: 500_000_000,
      });
    });

    await page.getByText("Or build from any bootable container image").click();
    await page.locator("#introspect").click();

    await expect(page.locator("#build")).toBeDisabled();
    await expect(page.locator("#stage")).toContainText(/insufficient.*storage/i);
    await expect(page.locator("#fallbackcard")).toBeVisible();

    const opState = await page.evaluate(() => ({
      state: window.tboxCurrentOperation?.state,
      ready: window.tboxCurrentOperation?.ready,
      storageBlocked: window.tboxCurrentOperation?.storageBlocked,
      fallbackReq: JSON.parse(document.getElementById("fallbackjson").textContent),
    }));
    expect(opState.state).toBe("blocked");
    expect(opState.ready).toBe(false);
    expect(opState.storageBlocked).toBe(true);
    expect(opState.fallbackReq).toEqual(selectedRequest);
    expect(opState.fallbackReq.schemaVersion).toBe(1);
    expect(opState.fallbackReq.kind).toBe("build-request");
    expect(opState.fallbackReq.image).toBe("tuna-os/yellowfin:gnome");
    expect(opState.fallbackReq.target).toEqual({
      variant: "yellowfin",
      flavor: "gnome",
      platform: "linux/amd64/v2",
      cpuBaseline: "x86-64-v2",
      hardwareScope: "generic",
    });
    expect(opState.fallbackReq.resolvedInputs.platformManifestDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  test("warns while climbing but does not declare failure", async ({ page }) => {
    await armGuard(page, 3500); // over the warn mark, under the wedged mark
    await page.clock.fastForward("03:00");

    await expect(page.locator("#log")).toContainText(/warning: engine memory 3500 MB/);
    await expect(page.locator("#stage")).not.toContainText(/Out of memory/i);
  });

  test("stays quiet for a healthy build", async ({ page }) => {
    await armGuard(page, 900);
    await page.clock.fastForward("10:00");

    await expect(page.locator("#log")).not.toContainText(/warning: engine memory/);
    await expect(page.locator("#stage")).not.toContainText(/Out of memory/i);
  });

  // A slow stage that is still ticking must never be called dead, or the
  // guard replaces a rare hang with a common false failure.
  test("does not fire while progress is still advancing", async ({ page }) => {
    await armGuard(page, 4000);
    for (let i = 1; i <= 12; i++) {
      await page.evaluate((i) => globalThis.tboxOnProgress("unpack", i, 65), i);
      await page.clock.fastForward("00:30");
    }
    await expect(page.locator("#stage")).not.toContainText(/Out of memory/i);
    await expect(page.locator("#stage")).toContainText(/Unpacking layer 12\/65/);
  });
});
