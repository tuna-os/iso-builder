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

async function open(page, { prebuilt = PREBUILT, mediaWriter = null, deviceMemory = 16, freeGB = 100, url = "/", platform = "Linux", architecture = null, catalog = "unqualified", mobile = false } = {}) {
  if (catalog === "unqualified") await unqualifiedCatalog(page);
  await page.route("**/wasm_exec.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/tbox.wasm", route => route.abort());
  await page.route("https://**/*", route => route.abort());
  await page.route("**/downloads.json", route => route.fulfill({ json: { schemaVersion: 1, prebuilt, mediaWriter } }));
  await page.addInitScript(({ deviceMemory, freeGB, platform, architecture, mobile }) => {
    Object.defineProperty(navigator, "deviceMemory", { value: deviceMemory, configurable: true });
    navigator.storage.estimate = async () => ({ quota: freeGB * 1e9, usage: 0 });
    const uaData = { platform, mobile };
    // Chromium's high-entropy hint; other browsers have none.
    if (architecture !== null) uaData.getHighEntropyValues = async () => ({ architecture });
    Object.defineProperty(navigator, "userAgentData", { value: uaData, configurable: true });
  }, { deviceMemory, freeGB, platform, architecture, mobile });
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
      // Stock Ubuntu has no Flatpak: the one-time setup, and no ISO to fall
      // back to on the app route, so no balenaEtcher.
      await expect(page.locator("#quick-app-hint")).toBeHidden();
      await expect(page.locator("#quick-app-linux")).toBeVisible();
      await expect(page.locator("#quick-app-linux code")).toHaveText("sudo apt install flatpak gnome-software-plugin-flatpak");
      await expect(page.locator("#quick-app-linux a").first()).toHaveAttribute("href", "https://flathub.org/setup/Ubuntu");
      await expect(page.locator("#quick-app-etcher")).toBeHidden();

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

test("macOS: the unsigned app opens from Privacy & Security, and Apple Silicon is told the stick is for a PC", async ({ page }) => {
  const warning = page.locator("#quick-arm"), note = page.locator("#quick-mac");
  await open(page, { mediaWriter: WRITER, platform: "macOS" });
  await settled(page);
  await expect(page.locator("#quick-app-hint")).toHaveText("First launch: if macOS blocks the app, choose Open Anyway in System Settings → Privacy & Security.");
  await expect(page.locator("#quick-app-linux")).toBeHidden();
  // No processor hint (Safari, Firefox): every Mac gets the note under the action.
  await expect(note).toBeVisible();
  await expect(note.locator("a")).toHaveAttribute("href", "https://tunaos.org/docs/apple-silicon");
  await expect(warning).toBeHidden();
  // Chromium on an Apple chip: the warning comes before the Download button.
  await open(page, { mediaWriter: WRITER, platform: "macOS", architecture: "arm" });
  await settled(page);
  await expect(warning).toBeVisible();
  await expect(warning.locator("a")).toHaveAttribute("href", "https://tunaos.org/docs/apple-silicon");
  expect(await page.evaluate(() => document.getElementById("quick-arm").compareDocumentPosition(document.getElementById("quick-prebuilt")) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  await expect(note).toBeHidden();
  await open(page, { mediaWriter: WRITER, platform: "macOS", architecture: "x86" });
  await settled(page);
  await expect(page.locator("#quick-app")).toBeVisible();
  await expect(warning).toBeHidden();
  await expect(note).toBeHidden();
  await open(page, { mediaWriter: WRITER, platform: "Windows" });
  await settled(page);
  await expect(warning).toBeHidden();
  await expect(note).toBeHidden();
});

test.describe("TunaOS Media Writer beside every route", () => {
  test.describe.configure({ timeout: 60_000 });
  const app = page => page.locator("#quick-app");

  test("a browser build keeps the app as the second action, opening on this image", async ({ page }) => {
    await open(page, { mediaWriter: WRITER });
    await settled(page);
    await page.locator("#quick-base").selectOption("bonito");
    expect((await route(page)).kind).toBe("browser");
    await expect(page.locator("#quick-download")).toBeVisible();
    await expect(app(page)).toBeVisible();
    await expect(app(page)).toHaveClass(/is-secondary/);
    await expect(page.locator("#quick-app-title")).toHaveText("Or skip the ISO file: TunaOS Media Writer downloads TunaOS and writes the USB stick for you.");
    await expect(page.locator("#quick-app-reason")).toBeHidden();
    await expect(page.locator("#quick-app-download")).toHaveAttribute("href", WRITER.assets["linux-x86_64"].url);
    await expect(page.locator("#quick-app-open")).toHaveAttribute("href", "tunaos-media-writer://build?target=bonito%3Agnome%3Alinux%2Famd64");
    await expect(app(page)).toContainText("Already installed? Open in Media Writer. Otherwise install it, then choose Open in Media Writer again.");
    // The primary route's note stays under the primary button.
    expect(await page.evaluate(() => document.getElementById("quick-under").nextElementSibling.id)).toBe("quick-app");
    // Linux: the Flatpak setup, and balenaEtcher for the ISO this route gives.
    await expect(page.locator("#quick-app-linux")).toBeVisible();
    await expect(page.locator("#quick-app-etcher a")).toHaveAttribute("href", "https://etcher.balena.io/");
  });

  test("a ready-made ISO keeps the app as the second action, and the deep link follows the chosen image", async ({ page }) => {
    await open(page, { mediaWriter: WRITER });
    await settled(page);
    expect((await route(page)).kind).toBe("prebuilt");
    await expect(page.locator("#quick-prebuilt")).toBeVisible();
    await expect(app(page)).toBeVisible();
    await expect(page.locator("#quick-app-open")).toHaveAttribute("href", "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64");
    await page.getByText("KDE Plasma", { exact: true }).click();
    await expect(page.locator("#quick-app-open")).toHaveAttribute("href", "tunaos-media-writer://build?target=yellowfin%3Akde%3Alinux%2Famd64");
  });

  test("without a release for this OS there is no app action", async ({ page }) => {
    await open(page, { mediaWriter: null });
    await settled(page);
    await expect(page.locator("#quick-prebuilt")).toBeVisible();
    await expect(app(page)).toBeHidden();
  });

  test("on the app route the app is the action itself", async ({ page }) => {
    await open(page, { prebuilt: {}, mediaWriter: WRITER });
    await settled(page);
    expect((await route(page)).kind).toBe("app");
    await expect(app(page)).not.toHaveClass(/is-secondary/);
    await expect(page.locator("#quick-app-title")).toBeHidden();
    await expect(page.locator("#quick-app-reason")).toBeVisible();
    expect(await page.evaluate(() => document.getElementById("quick-app").nextElementSibling.id)).toBe("quick-under");
  });

  test("the build request is this image with its desktop's default apps", async ({ page }) => {
    await open(page, { mediaWriter: WRITER });
    await settled(page);
    await page.getByText("KDE Plasma", { exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#quick-app-request").click()]);
    expect(download.suggestedFilename()).toBe("build-request.json");
    const request = JSON.parse(require("fs").readFileSync(await download.path(), "utf8"));
    expect(request).toMatchObject({ kind: "build-request", image: "ghcr.io/tuna-os/yellowfin:kde",
      target: { variant: "yellowfin", flavor: "kde", platform: "linux/amd64" } });
    expect(request.options.flatpaks).toEqual(DEFAULT_APPS.kde);
    await expect(page.locator("#quick-app-error")).toBeHidden();
  });
});

test.describe("a tunaos.org ?image= link", () => {
  test.describe.configure({ timeout: 60_000 });
  const checked = page => page.locator("#quick-desktops input:checked");

  for (const query of [
    `image=${encodeURIComponent("tuna-os/bonito:kde")}`,
    `image=${encodeURIComponent("ghcr.io/tuna-os/bonito:kde")}`,
    `image=${encodeURIComponent("tuna-os/bonito:kde")}&platform=${encodeURIComponent("linux/amd64")}`,
  ]) {
    test(`?${query} opens the one-click view on that desktop and base`, async ({ page }) => {
      await open(page, { mediaWriter: WRITER, url: `/?${query}` });
      await settled(page);
      await expect(page.locator("#quick")).toBeVisible();
      await expect(page.locator("#introspect")).toBeHidden();
      expect(await route(page)).toMatchObject({ desktop: "kde", base: "bonito" });
      await expect(checked(page)).toHaveValue("kde");
      await expect(page.locator("#quick-base")).toHaveValue("bonito");
      await expect(page.locator("#quick-app-open")).toHaveAttribute("href", "tunaos-media-writer://build?target=bonito%3Akde%3Alinux%2Famd64");
      // The link stays shareable; Customize starts the full builder from it.
      expect(new URL(page.url()).search).toBe(`?${query}`);
      await page.locator("#quick-customize").click();
      await expect(page.locator("#introspect")).toBeVisible();
      await expect(page.locator("#image")).toHaveValue("ghcr.io/tuna-os/bonito:kde");
      expect(new URL(page.url()).search).toBe("?customize=1");
    });
  }

  for (const [why, query] of [
    ["an image the view does not offer", `image=${encodeURIComponent("tuna-os/yellowfin:gnome-hwe")}`],
    ["another platform", `image=${encodeURIComponent("tuna-os/bonito:kde")}&platform=${encodeURIComponent("linux/arm64")}`],
    ["another parameter", `image=${encodeURIComponent("tuna-os/bonito:kde")}&label=DEMO`],
  ]) {
    test(`${why} opens the full builder with the link applied`, async ({ page }) => {
      await open(page, { url: `/?${query}` });
      await expect(page.locator("#introspect")).toBeVisible();
      await expect(page.locator("#quick")).toBeHidden();
      await expect(page.locator("#image")).toHaveValue(new URLSearchParams(query).get("image"));
      expect(new URL(page.url()).search).toBe(`?${query}`);
    });
  }
});

test.describe("the USB path, in plain words", () => {
  test.describe.configure({ timeout: 60_000 });

  test("under every primary action: the USB stick size, the drive erase, and the way to keep Windows", async ({ page }) => {
    for (const options of [{}, { prebuilt: {}, mediaWriter: WRITER }]) {
      await open(page, options);
      await settled(page);
      await expect(page.locator("#quick-usb")).toHaveText("You need a USB stick of 16 GB or larger; everything on it is erased.");
      await expect(page.locator("#quick-erase")).toHaveText("Installing erases the computer’s drive. Want to keep Windows? Use wootc.");
      await expect(page.locator("#quick-erase a")).toHaveAttribute("href", "https://tunaos.org/wootc");
    }
  });

  test("one line leads back to tunaos.org's other ways to install", async ({ page }) => {
    await open(page, { mediaWriter: WRITER });
    await settled(page);
    await expect(page.locator(".quick-more a")).toHaveAttribute("href", "https://tunaos.org/download");
    await expect(page.locator(".quick-more a")).toHaveText("Other ways to install TunaOS");
  });

  test("after the ISO: balenaEtcher for the file, then the USB start and installer guides", async ({ page }) => {
    await open(page, { mediaWriter: WRITER });
    await settled(page);
    await page.locator("#quick-prebuilt").evaluate(a => a.addEventListener("click", e => e.preventDefault()));
    await page.locator("#quick-prebuilt").click();
    await expect(page.locator("#quick-next")).toBeVisible();
    expect(await page.locator("#quick-next a").evaluateAll(links => links.map(a => a.href))).toEqual([
      "https://etcher.balena.io/", "https://tunaos.org/docs/start-from-usb", "https://tunaos.org/docs/installer"]);
    // The app stays offered beside the result; nothing on the way points at
    // developer docs or another project's writer.
    await expect(page.locator("#quick-app")).toBeVisible();
    const hrefs = await page.locator("#quick a[href]").evaluateAll(links => links.map(a => a.href));
    expect(hrefs.filter(h => /docs\/iso-builder|bootc-installer-asahi|fedoraproject/.test(h))).toEqual([]);
  });
});

test("developer documentation is linked from the full builder only", async ({ page }) => {
  test.setTimeout(60_000);
  const link = page.getByRole("link", { name: "How this builder works (developer documentation)" });
  await open(page);
  await settled(page);
  await expect(link).toBeHidden();
  await page.locator("#quick-customize").click();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://tunaos.org/docs/iso-builder");
});

test.describe("a phone", () => {
  test.describe.configure({ timeout: 60_000 });

  test("is told it needs a PC and a USB stick, offered no ISO, and can copy the link to this image", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, { mediaWriter: WRITER, platform: "Android", mobile: true });
    await settled(page);
    expect((await route(page)).kind).toBe("mobile");
    await expect(page.locator("#quick-phone-text")).toHaveText("You’ll need a Windows, Mac or Linux PC and a USB stick of 16 GB or larger. Open this page on that computer to download TunaOS.");
    for (const id of ["quick-prebuilt", "quick-download", "quick-app", "quick-usb", "quick-meta"]) await expect(page.locator(`#${id}`)).toBeHidden();
    await expect(page.locator("#quick-erase")).toBeVisible();
    await page.getByText("KDE Plasma", { exact: true }).click();
    await expect(page.locator("#quick-phone-share")).toHaveText("Copy link");
    await page.locator("#quick-phone-share").click();
    await expect(page.locator("#quick-phone-status")).toContainText("Link copied.");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(copied).searchParams.get("image")).toBe("tuna-os/yellowfin:kde");
  });

  test("uses the share sheet where there is one", async ({ page }) => {
    await page.addInitScript(() => { navigator.share = async (data) => { window.__shared = data; }; });
    await open(page, { platform: "Android", mobile: true });
    await settled(page);
    await expect(page.locator("#quick-phone-share")).toHaveText("Send this link to your computer");
    await page.locator("#quick-phone-share").click();
    await expect.poll(() => page.evaluate(() => window.__shared?.url)).toMatch(/\?image=tuna-os%2Fyellowfin%3Agnome$/);
  });
});

test.describe("Open in Media Writer", () => {
  test.describe.configure({ timeout: 60_000 });

  test("is not offered before Media Writer 0.2.0, which registers no link handler", async ({ page }) => {
    for (const version of ["0.1.0", "0.1.9", "not-a-version"]) {
      await open(page, { mediaWriter: { ...WRITER, version } });
      await settled(page);
      await expect(page.locator("#quick-app")).toBeVisible();
      await expect(page.locator("#quick-app-open")).toBeHidden();
      await expect(page.locator("#quick-app-request")).toBeVisible();
      await expect(page.locator("#quick-app-how")).toHaveText("Install it, then pick this desktop in the app, or choose Open build request… with the file above.");
    }
    for (const version of ["0.2.0", "0.10.1", "1.0.0"]) {
      await open(page, { mediaWriter: { ...WRITER, version } });
      await settled(page);
      await expect(page.locator("#quick-app-open")).toBeVisible();
    }
  });

  test("says to install the app first when nothing happens", async ({ page }) => {
    await open(page, { mediaWriter: { ...WRITER, version: "0.2.0" } });
    await settled(page);
    // No handler for the scheme: the click goes nowhere, as without the app.
    await page.locator("#quick-app-open").evaluate(a => a.addEventListener("click", e => e.preventDefault()));
    await page.locator("#quick-app-open").click();
    await expect(page.locator("#quick-app-nothing")).toBeHidden();
    await expect(page.locator("#quick-app-nothing")).toBeVisible({ timeout: 4000 });
    await expect(page.locator("#quick-app-nothing")).toHaveText("Nothing happened? Install the app first, then choose Open in Media Writer again.");
    await expect(page.locator("#quick-app-how")).toBeHidden();
  });
});

test.describe("a browser build, start to cancel", () => {
  test.describe.configure({ timeout: 60_000 });

  async function stubEngine(page) {
    await page.evaluate(() => {
      window.showSaveFilePicker = async ({ suggestedName }) => ({ createWritable: async () => ({
        write: async () => {}, close: async () => {}, name: suggestedName,
        abort: async () => { sessionStorage.setItem("test-aborted", "1"); },
      }) });
      window.loadWasm = async () => {};
      window.tboxIntrospect = async image => JSON.stringify({ desktop: image.split(":").pop(), kernelVer: "6.12", layerCount: 65, compressedSize: 1 });
      // Never finishes on its own, like a long build.
      window.tboxBuildIso = async () => { globalThis.tboxOnProgress("unpack", 3, 65); await new Promise(() => {}); };
      window.tboxReset = () => null;
    });
  }

  test("says before it starts: a Save dialog, how much downloads, roughly how long, keep the tab open", async ({ page }) => {
    await open(page, { mediaWriter: WRITER });
    await settled(page);
    await page.locator("#quick-base").selectOption("bonito");
    expect((await route(page)).kind).toBe("browser");
    const size = snapshot.targets.find(t => t.targetKey === QUALIFIED_FOR_SPECS).facts.compressedSize;
    await expect(page.locator("#quick-meta")).toHaveText(new RegExp(
      `^Built in this browser tab, for 64-bit Intel and AMD PCs\\. First you choose where to save the file\\. Then this tab downloads about ${(size / 1e9).toFixed(1)} GB and builds the ISO, roughly \\d+ to \\d+ minutes on a home connection\\. Keep the tab open until it finishes\\.$`));
  });

  test("shows plain progress with Cancel, keeps Media Writer offered, and Cancel stops it", async ({ page }) => {
    await qualifiedCatalogFixture(page);
    await open(page, { catalog: null, mediaWriter: WRITER });
    await settled(page);
    await stubEngine(page);
    await page.locator("#quick-download").click();
    await expect(page.locator("#quick-stage")).toHaveText("Downloading TunaOS (part 3 of 65)");
    await expect(page.locator("#quick-download")).toBeHidden();
    await expect(page.locator("#quick-under")).toBeHidden();
    await expect(page.locator("#quick-app")).toBeVisible();
    await expect(page.locator("#quick-cancel")).toBeVisible();

    await Promise.all([page.waitForEvent("load"), page.locator("#quick-cancel").click()]);
    await settled(page);
    expect(await page.evaluate(() => sessionStorage.getItem("test-aborted"))).toBe("1");
    await expect(page.locator("#quick-result-text")).toHaveText("Download cancelled. If an unfinished .iso file was left where you chose to save it, you can delete it.");
    await expect(page.locator("#quick-next")).toBeHidden();
    await expect(page.locator("#quick-download")).toBeVisible();
    // Only once: a later reload starts clean.
    await page.reload();
    await settled(page);
    await expect(page.locator("#quick-result")).toBeHidden();
  });
});
