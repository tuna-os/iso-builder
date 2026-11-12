// The one-click download view (app/public/quick-start.js): which route the
// single button takes, and that a browser build carries each desktop's
// default apps. The engine and registry are stubbed; catalog admission is real.
const { test, expect } = require("@playwright/test");
const { qualifiedCatalogFixture } = require("./qualified-catalog-fixture");
const config = require("../../app/public/builder-config.json");
const snapshot = require("../../app/public/catalog-snapshot.json");

// The deployed catalog qualifies some targets (the default, yellowfin:gnome,
// among them), which changes the route under test. These specs serve the same
// snapshot with every qualification removed except bonito:gnome (the one
// qualified target the browser-route specs use, with its real receipt), and
// opt out where qualifiedCatalogFixture is the point.
const QUALIFIED_FOR_SPECS = "bonito:gnome:linux/amd64";
async function unqualifiedCatalog(page) {
  const doc = structuredClone(snapshot);
  for (const entry of doc.targets) {
    if (entry.targetKey === QUALIFIED_FOR_SPECS) continue;
    entry.qualification = { browser: null, qualifiedAt: null, reason: "no-qualification-receipt",
      receiptDigest: null, resources: null, status: "unqualified" };
  }
  await page.route("**/catalog-snapshot.json", route => route.fulfill({ json: doc }));
}

const DEFAULT_APPS = Object.fromEntries(config.desktops.map(d => [d.id, d.default_flatpaks]));
const PREBUILT = {
  "yellowfin-gnome": { url: "https://download.tunaos.org/live-isos/yellowfin-gnome-latest.iso", size: 6_000_000_000 },
  "bonito-gnome": { url: "https://download.tunaos.org/live-isos/bonito-gnome-latest.iso", size: 7_000_000_000 },
};
const WRITER = { version: "1.0.0", assets: {
  macos: { url: "https://github.com/tuna-os/iso-builder/releases/download/media-writer-v1.0.0/TunaOS-Media-Writer-macOS.dmg" },
  "windows-x64": { url: "https://github.com/tuna-os/iso-builder/releases/download/media-writer-v1.0.0/TunaOS-Media-Writer-Windows-x64.msi" },
  "linux-x86_64": { url: "https://github.com/tuna-os/iso-builder/releases/download/media-writer-v1.0.0/TunaOS-Media-Writer-Linux-x86_64.flatpak" },
} };

async function open(page, { prebuilt = PREBUILT, mediaWriter = null, deviceMemory = 16, freeGB = 100, url = "/", platform = "Linux", catalog = "unqualified" } = {}) {
  if (catalog === "unqualified") await unqualifiedCatalog(page);
  await page.route("**/wasm_exec.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/tbox.wasm", route => route.abort());
  await page.route("https://**/*", route => route.abort());
  await page.route("**/downloads.json", route => route.fulfill({ json: { schemaVersion: 1, prebuilt, mediaWriter } }));
  await page.addInitScript(({ deviceMemory, freeGB, platform }) => {
    Object.defineProperty(navigator, "deviceMemory", { value: deviceMemory, configurable: true });
    navigator.storage.estimate = async () => ({ quota: freeGB * 1e9, usage: 0 });
    Object.defineProperty(navigator, "userAgentData", { value: { platform, mobile: false }, configurable: true });
  }, { deviceMemory, freeGB, platform });
  await page.goto(url);
}
const route = page => page.evaluate(() => window.tboxQuickRoute());
const settled = page => page.waitForFunction(() => window.tboxQuickRoute && document.querySelectorAll("#quick-desktops input").length > 0);

test.describe("one-click download view", () => {
  test.describe.configure({ timeout: 60_000 });

  test("the bare URL is one screen with one button; any parameter opens the full builder", async ({ page }) => {
    await open(page);
    await settled(page);
    await expect(page.locator("#quick")).toBeVisible();
    await expect(page.locator("#introspect")).toBeHidden();
    await expect(page.locator("#quick-prebuilt")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await page.goto("/?customize=1");
    await expect(page.locator("#quick")).toBeHidden();
    await expect(page.locator("#introspect")).toBeVisible();
    await expect(page.locator("#quick-back")).toBeVisible();
  });

  test("Customize keeps the chosen image", async ({ page }) => {
    await open(page);
    await settled(page);
    await page.getByText("KDE Plasma", { exact: true }).click();
    await page.locator("#quick-customize").click();
    await expect(page.locator("#introspect")).toBeVisible();
    await expect(page.locator("#image")).toHaveValue("ghcr.io/tuna-os/yellowfin:kde");
    expect(new URL(page.url()).search).toBe("?customize=1");
  });

  test("a browser-qualified image is built here when the browser can", async ({ page }) => {
    await open(page);
    await settled(page);
    await page.locator("#quick-base").selectOption("bonito");
    expect((await route(page)).kind).toBe("browser");
    await expect(page.locator("#quick-download")).toHaveText("Download ISO");
    await expect(page.locator("#quick-download")).toBeEnabled();
  });

  for (const [why, options] of [
    ["too little memory", { deviceMemory: 2 }],
    ["too little storage", { freeGB: 3 }],
  ]) {
    test(`with ${why}, a qualified image falls back to its ready-made ISO, then the app, then local`, async ({ page }) => {
      await open(page, options);
      await settled(page);
      await page.locator("#quick-base").selectOption("bonito");
      expect(await route(page)).toMatchObject({ kind: "prebuilt", iso: PREBUILT["bonito-gnome"] });
      await expect(page.locator("#quick-prebuilt")).toHaveAttribute("href", PREBUILT["bonito-gnome"].url);

      await open(page, { ...options, prebuilt: {}, mediaWriter: WRITER });
      await settled(page);
      await page.locator("#quick-base").selectOption("bonito");
      expect((await route(page)).kind).toBe("app");
      await expect(page.locator("#quick-app-download")).toHaveAttribute("href", WRITER.assets["linux-x86_64"].url);
      await expect(page.locator("#quick-app-download")).toHaveText("Get TunaOS Media Writer for Linux");
      await expect(page.locator("#quick-app-reason")).toContainText(why === "too little memory" ? "memory" : "storage");
      await expect(page.locator("#quick-app-other a")).toHaveText(["macOS", "Windows"]);
      await expect(page.locator("#quick-app-hint")).toHaveText("Open the downloaded file with your software center to install it.");

      await open(page, { ...options, prebuilt: {}, mediaWriter: null });
      await settled(page);
      await page.locator("#quick-base").selectOption("bonito");
      expect((await route(page)).kind).toBe("local");
      await page.locator("#quick-download").click();
      await expect(page.locator("#fallbackcard")).toBeVisible();
      await expect(page.locator("#quick")).toBeHidden();
    });
  }

  test("an image without a browser receipt never builds here, whatever the browser", async ({ page }) => {
    await open(page, { prebuilt: {}, mediaWriter: WRITER });
    await settled(page);
    expect(await route(page)).toMatchObject({ kind: "app", base: "yellowfin", desktop: "gnome" });
    await expect(page.locator("#quick-app-reason")).toHaveText("This one can’t be built in a browser yet.");
  });

  test("the full builder's local fallback leads with the app when one is released", async ({ page }) => {
    await open(page, { mediaWriter: WRITER, url: "/?customize=1" });
    await page.locator("#introspect").click();
    await expect(page.locator("#fallbackcard")).toBeVisible();
    await expect(page.locator("#fallback-app-link")).toHaveAttribute("href", WRITER.assets["linux-x86_64"].url);
    await expect(page.locator("#fallback-app-link")).toHaveText("TunaOS Media Writer for Linux");
  });

  test("one click builds with each desktop's default apps, never the previous desktop's", async ({ page }) => {
    await qualifiedCatalogFixture(page);
    await open(page, { catalog: null });
    await settled(page);
    await page.evaluate(() => {
      window.__builds = [];
      window.showSaveFilePicker = async ({ suggestedName }) => ({ createWritable: async () => ({
        write: async () => {}, close: async () => {}, abort: async () => {}, name: suggestedName,
      }) });
      window.loadWasm = async () => {};
      window.tboxIntrospect = async image => JSON.stringify({ desktop: image.split(":").pop(), kernelVer: "6.12", layerCount: 1, compressedSize: 1 });
      window.tboxBuildIso = async (opts, write) => { window.__builds.push(opts.flatpaks); await write(new Uint8Array(4)); return 4; };
      window.tboxReset = () => null;
    });
    // The qualified fixture admits every target, so the deployment default
    // (yellowfin) is built in the browser.
    expect((await route(page)).kind).toBe("browser");
    await page.locator("#quick-download").click();
    await expect(page.locator("#quick-result-text")).toHaveText("Saved tunaos-yellowfin-gnome-amd64.iso.");
    await expect(page.locator("#quick-next")).toBeVisible();

    await page.getByText("KDE Plasma", { exact: true }).click();
    await expect(page.locator("#quick-result")).toBeHidden();
    await page.locator("#quick-download").click();
    await expect(page.locator("#quick-result-text")).toHaveText("Saved tunaos-yellowfin-kde-amd64.iso.");
    expect(await page.evaluate(() => window.__builds)).toEqual([DEFAULT_APPS.gnome, DEFAULT_APPS.kde]);
  });

  test("a cancelled save dialog starts nothing", async ({ page }) => {
    await qualifiedCatalogFixture(page);
    await open(page, { catalog: null });
    await settled(page);
    await page.evaluate(() => {
      window.__inspected = false;
      window.showSaveFilePicker = async () => { throw new DOMException("cancelled", "AbortError"); };
      window.loadWasm = async () => {};
      window.tboxIntrospect = async () => { window.__inspected = true; return "{}"; };
    });
    await page.locator("#quick-download").click();
    await expect(page.locator("#quick-action")).toBeVisible();
    await expect(page.locator("#quick-progress")).toBeHidden();
    expect(await page.evaluate(() => window.__inspected)).toBe(false);
  });
});

test("the first-launch hint follows the release's recorded signing, per OS", async ({ page }) => {
  const signed = structuredClone(WRITER);
  signed.assets.macos.signed = true;
  signed.assets["windows-x64"].signed = false;
  await open(page, { prebuilt: {}, mediaWriter: signed, platform: "macOS" });
  await settled(page);
  await expect(page.locator("#quick-app-download")).toHaveText("Get TunaOS Media Writer for macOS");
  await expect(page.locator("#quick-app-hint")).toBeHidden();
  await open(page, { prebuilt: {}, mediaWriter: signed, platform: "Windows" });
  await settled(page);
  await expect(page.locator("#quick-app-hint")).toHaveText("If Windows SmartScreen warns you, choose More info, then Run anyway.");
});
