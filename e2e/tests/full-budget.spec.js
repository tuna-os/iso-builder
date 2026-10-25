// Contract for the @full time budgets. Measured in run 40229060979: a
// catalog-pinned target spends the whole layer pull, unpack and EROFS authoring
// (~18.5 min on a hosted runner) after the build click, so the download wait
// must be longer than the inspect wait and both must fit the per-test cap.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const spec = fs.readFileSync(path.join(__dirname, "builder.spec.js"), "utf8");
const workflow = fs.readFileSync(path.join(__dirname, "../../.github/workflows/ci.yml"), "utf8");
const num = (src, name) => Number(new RegExp(`const ${name} = Number\\(process\\.env\\.[A-Z0-9_]+ \\|\\| ([0-9_]+)\\)`).exec(src)[1].replaceAll("_", ""));

test.describe("full-build budgets", () => {
  test("the download wait uses the build budget, the inspect wait the inspect budget", () => {
    expect(spec).toMatch(/waitForEvent\("download", \{ timeout: BUILD_WAIT_MS \}\)/);
    expect(spec).toMatch(/toBeEnabled\(\{ timeout: WAIT_MS \}\)/);
  });

  test("the build budget exceeds the 18.5 min measured before ISO streaming and both fit the per-test cap", () => {
    const wait = num(spec, "WAIT_MS");
    const build = num(spec, "BUILD_WAIT_MS");
    const cap = Number(/--grep @full --timeout=([0-9]+)/.exec(workflow)[1]);
    expect(build).toBeGreaterThan(18.5 * 60_000 + 10 * 60_000);
    expect(wait + build).toBeLessThan(cap);
  });

  test("the stall signature counts origin storage growth", () => {
    expect(spec).toMatch(/navigator\.storage\.estimate\(\)\)\.usage/);
    expect(spec).toMatch(/\|opfs=\$\{grown\}/);
  });
});

const { test: fixtureTest, expect: fixtureExpect } = require("./fixtures");
const { removeSavePicker, buildFailedSignature } = require("./full-harness");

fixtureTest.describe("full-build save path", () => {
  fixtureTest("headless Chromium rejects the save picker at once; the harness removes it", async ({ page }) => {
    await page.goto("/");
    const before = await page.evaluate(async () => {
      if (typeof window.showSaveFilePicker !== "function") return { defined: false };
      try { await window.showSaveFilePicker(); return { defined: true, outcome: "resolved" }; }
      catch (e) { return { defined: true, outcome: e.name }; }
    });
    // Defined but unusable without a user gesture: the failure the CI run saw.
    fixtureExpect(before.defined).toBe(true);
    fixtureExpect(before.outcome).not.toBe("resolved");
    await page.evaluate(removeSavePicker);
    fixtureExpect(await page.evaluate(() => typeof window.showSaveFilePicker)).toBe("undefined");
  });

  fixtureTest("the @full spec installs the picker removal before navigation and fails fast on a failed build", () => {
    fixtureExpect(spec).toMatch(/addInitScript\(removeSavePicker\)/);
    fixtureExpect(spec.indexOf("addInitScript(removeSavePicker)")).toBeLessThan(spec.indexOf("await page.goto(`/?image="));
    fixtureExpect(buildFailedSignature("Build failed.|1/1|opfs=317")).toBe(true);
    fixtureExpect(buildFailedSignature("Build failed — storage quota exceeded.|1/1|opfs=1")).toBe(true);
    fixtureExpect(buildFailedSignature("Streaming ISO…|0/1|opfs=317")).toBe(false);
    fixtureExpect(buildFailedSignature("<unreadable>")).toBe(false);
    fixtureExpect(spec).toMatch(/what === "build" && buildFailedSignature\(sig\)/);
  });
});
