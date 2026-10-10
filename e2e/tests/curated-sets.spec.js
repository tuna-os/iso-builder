// Curated Flatpak sets matched to the inspected desktop (iso-builder#192),
// tested without an engine or the network.
//
// app.js is a classic script, so loadWasm() and tboxIntrospect() are window
// properties: stub the engine load and hand inspect() the facts a real image
// would report. The upstream set files are served from fixtures by
// page.route, so the test does not depend on another repo's main branch.
const { test, expect } = require("@playwright/test");

const BREWFILE = [
  'brew "gh"',
  'flatpak "org.example.Alpha"',
  'flatpak "org.example.Beta"',
  'flatpak "not an id; rm -rf /"',
].join("\n");

const PREINSTALL = [
  "[Flatpak Preinstall org.example.Gamma]",
  "Branch=stable",
  "IsRuntime=false",
  "",
  "[Flatpak Preinstall org.example.Platform]",
  "Branch=stable",
  "IsRuntime=true",
].join("\n");

async function inspectAs(page, desktop) {
  await page.evaluate((desktop) => {
    window.loadWasm = async () => {};
    window.tboxIntrospect = async () =>
      JSON.stringify({ desktop, kernelVer: "6.0.0", hasSdBoot: true, fileCount: 1 });
  }, desktop);
  await page.getByText("Or build from any bootable container image").click();
  await page.locator("#image").fill("bonito:" + desktop);
  await page.locator("#introspect").click();
  await expect(page.locator(".badge.de")).toContainText(desktop);
}

const selectedSet = (page) => page.locator("#curatedset").inputValue();
const groups = (page) =>
  page.locator("#curatedset optgroup").evaluateAll((gs) => gs.map((g) => g.label));

test.describe("curated flatpak sets", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("https://raw.githubusercontent.com/**/*.Brewfile", (r) =>
      r.fulfill({ body: BREWFILE }));
    await page.route("https://raw.githubusercontent.com/**/*.preinstall", (r) =>
      r.fulfill({ body: PREINSTALL }));
    await page.goto("/");
  });

  test("lists every set before an image is inspected", async ({ page }) => {
    expect(await groups(page)).toEqual(["All sets"]);
    expect(await page.locator("#curatedset option").count()).toBeGreaterThan(3);
  });

  for (const [desktop, group, first] of [
    ["gnome", "For GNOME", "bluefin-system"],
    ["kde", "For KDE Plasma", "aurora-system"],
    ["niri", "For Niri", "zirconium"],
    ["xfce", "For XFCE", "bluefin-system"],
  ]) {
    test(`matches the ${desktop} desktop`, async ({ page }) => {
      await inspectAs(page, desktop);
      expect(await groups(page)).toEqual([group, "Other desktops"]);
      expect(await selectedSet(page)).toBe(first);
    });
  }

  test("a headless image matches no set", async ({ page }) => {
    await inspectAs(page, "none");
    expect(await groups(page)).toEqual(["All sets"]);
  });

  test("adds the app ids of a Brewfile set and drops non-ids", async ({ page }) => {
    await inspectAs(page, "kde");
    await page.getByText(/Advanced — customize/).click();
    await page.locator("#curated").click();
    await expect(page.locator("#log")).toContainText("added 2 apps from the Aurora core apps set");
    await expect(page.locator("#fplist")).toContainText("org.example.Alpha");
    await expect(page.locator("#fplist")).toContainText("org.example.Beta");
    await expect(page.locator("#fplist")).not.toContainText("rm -rf");
  });

  test("adds the apps of a preinstall set and skips runtimes", async ({ page }) => {
    await inspectAs(page, "niri");
    await page.getByText(/Advanced — customize/).click();
    await page.locator("#curated").click();
    await expect(page.locator("#log")).toContainText("added 1 apps from the Zirconium apps set");
    await expect(page.locator("#fplist")).toContainText("org.example.Gamma");
    await expect(page.locator("#fplist")).not.toContainText("org.example.Platform");
  });
});
