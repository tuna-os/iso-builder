// The installer medium path (tuna-os/iso-builder#664): the catalog pins one
// installer image per cell, and the page streams its chunks into the user's
// file, verifies digest and receipt, and records both. No build, no R2.
//
// The chunks below are a real `tacklebox cmd/mkinstaller` product
// (feat/write-medium): the spec parses its manifest, config and chunk table
// itself, serves the decompressed chunk bytes to a mock engine export
// (window.tboxWriteMedium has the documented write-medium.js signature; the
// wasm session lands the real one), and asserts the saved bytes hash to the
// config's whole-image sha256.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const LAYOUT = path.join(__dirname, "fixtures", "installer-layout");
const snapshot = require("../../app/public/catalog-snapshot.json");

function loadLayout() {
  const index = JSON.parse(fs.readFileSync(path.join(LAYOUT, "index.json"), "utf8"));
  const manifestDigest = index.manifests[0].digest;
  const manifest = JSON.parse(fs.readFileSync(path.join(LAYOUT, "blobs", "sha256", manifestDigest.split(":")[1]), "utf8"));
  const cfg = JSON.parse(fs.readFileSync(path.join(LAYOUT, "blobs", "sha256", manifest.config.digest.split(":")[1]), "utf8"));
  const raw = Buffer.concat(manifest.layers.map((layer) => {
    const blob = fs.readFileSync(path.join(LAYOUT, "blobs", "sha256", layer.digest.split(":")[1]));
    return { blob, layer };
  }).map(({ blob }) => execFileSync("zstd", ["-dc"], { input: blob, maxBuffer: cfg.totalSize + 1024 })));
  return { index, manifestDigest, manifest, config: cfg, raw };
}

const L = loadLayout();
const RAW_SHA256 = `sha256:${crypto.createHash("sha256").update(L.raw).digest("hex")}`;
const RAW_B64 = L.raw.toString("base64");

const PIN = {
  ref: "ghcr.io/tuna-os/flounder-installer:synthetic",
  manifestDigest: L.manifestDigest,
  sha256: L.config.sha256,
  sizeBytes: L.config.totalSize,
  receiptDigest: `sha256:${"c".repeat(64)}`,
  cosignIdentity: "https://github.com/tuna-os/tunaOS/.github/workflows/ci.yml@refs/heads/main",
};

// Every available cell carries the pin, so whatever the deployment default
// selects, the installer route is the one under test. Cells without a pin
// keep the legacy routes (covered by quick-start.spec.js).
function catalogWithPin() {
  const doc = structuredClone(snapshot);
  for (const entry of doc.targets) {
    if (entry.availability.available) entry.installer = { ...PIN };
  }
  return doc;
}

// A mock with the documented write-medium.js engine signature: it checks each
// chunk against the config table (like the engine's per-chunk check), streams
// raw bytes in disk order, and returns the whole-image receipt.
async function mockEngine(page) {
  await page.addInitScript(({ rawB64, chunks, manifestDigest, sha256 }) => {
    const raw = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0));
    window.tboxWriteMedium = async (args, write, onProgress) => {
      if (args.manifestDigest !== manifestDigest) throw new Error("mock: manifest digest mismatch");
      if (args.expectedSha256 !== sha256) throw new Error("mock: expected sha256 mismatch");
      if (args.sizeBytes !== raw.length) throw new Error("mock: size mismatch");
      const subtle = window.crypto.subtle;
      const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
      let total = 0;
      for (let i = 0; i < chunks.length; i++) {
        const bytes = raw.subarray(chunks[i].offset, chunks[i].offset + chunks[i].length);
        const digest = `sha256:${hex(await subtle.digest("SHA-256", bytes))}`;
        if (digest !== chunks[i].sha256) throw new Error(`mock: chunk ${i} digest mismatch`);
        total += bytes.length;
        onProgress && onProgress("fetch", i + 1, chunks.length);
        await write(bytes);
      }
      onProgress && onProgress("verify", 1, 1);
      return { bytesWritten: total, sha256, manifestDigest };
    };
  }, { rawB64: RAW_B64, chunks: L.config.chunks, manifestDigest: L.manifestDigest, sha256: L.config.sha256 });
}

async function stubPicker(page, store) {
  await page.evaluate(() => {
    window.__written = [];
    window.showSaveFilePicker = async ({ suggestedName }) => ({
      name: suggestedName,
      createWritable: async () => ({
        write: async (u8) => { window.__written.push(...u8); },
        close: async () => {},
        abort: async () => {},
      }),
    });
  });
  void store;
}

async function savedBytes(page) {
  return Buffer.from(await page.evaluate(() => window.__written));
}

async function open(page, { url = "/", deviceMemory = 16, freeGB = 100 } = {}) {
  const r2 = [];
  page.on("request", (request) => {
    if (request.url().includes("download.tunaos.org")) r2.push(request.url());
  });
  await page.route("**/wasm_exec.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/tbox.wasm", (route) => route.abort());
  await page.route("**/catalog-snapshot.json", (route) => route.fulfill({ json: catalogWithPin() }));
  await page.route("**/downloads.json", (route) => route.fulfill({ json: { schemaVersion: 1, prebuilt: {}, mediaWriter: null } }));
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(({ deviceMemory, freeGB }) => {
    Object.defineProperty(navigator, "deviceMemory", { value: deviceMemory, configurable: true });
    navigator.storage.estimate = async () => ({ quota: freeGB * 1e9, usage: 0 });
    Object.defineProperty(navigator, "userAgentData", { value: { platform: "Linux" }, configurable: true });
  }, { deviceMemory, freeGB });
  await mockEngine(page);
  await page.goto(url);
  await page.waitForFunction(() => window.tboxQuickRoute && document.querySelectorAll("#quick-desktops input").length > 0);
  return { r2 };
}

test.describe("installer medium fixture", () => {
  test("the committed layout is a genuine mkinstaller product", async () => {
    for (const layer of L.manifest.layers) {
      const blob = fs.readFileSync(path.join(LAYOUT, "blobs", "sha256", layer.digest.split(":")[1]));
      expect(`sha256:${crypto.createHash("sha256").update(blob).digest("hex")}`).toBe(layer.digest);
      expect(layer.mediaType).toBe("application/vnd.tunaos.installer.chunk.v1+zstd");
    }
    expect(L.manifest.config.mediaType).toBe("application/vnd.tunaos.installer.config.v1+json");
    let offset = 0;
    for (const chunk of L.config.chunks) {
      expect(chunk.offset).toBe(offset);
      offset += chunk.length;
    }
    expect(offset).toBe(L.config.totalSize);
    expect(L.raw.length).toBe(L.config.totalSize);
    // The config's whole-image digest names the same bytes the chunks carry.
    expect(RAW_SHA256).toBe(L.config.sha256);
  });
});

test.describe("installer medium one-click download", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the installer image is the default route, with digest, receipt and fixed apps", async ({ page }) => {
    await open(page);
    const route = await page.evaluate(() => window.tboxQuickRoute());
    expect(route.kind).toBe("installer");
    expect(route.installer.manifestDigest).toBe(L.manifestDigest);
    await expect(page.locator("#quick-download")).toHaveText("Download the installer image");
    await expect(page.locator("#quick-pin")).toContainText(L.manifestDigest);
    await expect(page.locator("#quick-pin")).toContainText(L.config.sha256);
    await expect(page.locator("#quick-pin")).toContainText("0.0 GB");
    await expect(page.locator("#quick-flatpaks")).toBeVisible();
    // No Customize and no ready-made ISO for this medium.
    await expect(page.locator("#quick-customize")).toBeHidden();
    await expect(page.locator("#quick-prebuilt")).toBeHidden();
  });

  test("streaming writes the verified bytes and records the receipt, no R2", async ({ page }) => {
    const { r2 } = await open(page);
    await stubPicker(page);
    await page.locator("#quick-download").click();
    await expect(page.locator("#quick-result-text")).toContainText(L.manifestDigest, { timeout: 30_000 });
    const resultText = await page.locator("#quick-result-text").textContent();
    expect(resultText).toContain(RAW_SHA256);
    expect(resultText).toContain("works with dd");
    const saved = await savedBytes(page);
    expect(saved.length).toBe(L.config.totalSize);
    expect(`sha256:${crypto.createHash("sha256").update(saved).digest("hex")}`).toBe(L.config.sha256);
    expect(saved.equals(L.raw)).toBe(true);
    expect(r2).toEqual([]);
  });

  test("a digest mismatch refuses the write", async ({ page }) => {
    await open(page);
    await stubPicker(page);
    await page.evaluate(() => {
      const real = window.tboxWriteMedium;
      window.tboxWriteMedium = async (args, write, onProgress) => {
        const receipt = await real(args, write, onProgress);
        return { ...receipt, sha256: `sha256:${"e".repeat(64)}` };
      };
    });
    await page.locator("#quick-download").click();
    await expect(page.locator("#quick-result-text")).toContainText("digest mismatch", { timeout: 30_000 });
  });

  test("low device memory still streams: only the file size gates the medium", async ({ page }) => {
    // 2 GB device memory would refuse the legacy build; the medium needs
    // only its own size in storage.
    await open(page, { deviceMemory: 2 });
    const route = await page.evaluate(() => window.tboxQuickRoute());
    expect(route.kind).toBe("installer");
  });

  test("too little storage falls back to the app, never the ready-made ISO", async ({ page }) => {
    await open(page, { freeGB: 0.000001 });
    const route = await page.evaluate(() => window.tboxQuickRoute());
    // No prebuilt section in downloads.json and no R2 route for this medium:
    // local instructions are the only fallback left.
    expect(route.kind).toBe("local");
  });
});

test.describe("installer medium full builder", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a pinned cell offers the download, hides Customize, and keeps the legacy build off", async ({ page }) => {
    const doc = catalogWithPin();
    // A desktop cell: base flavors never attach a catalog entry, and the
    // guided quick view only offers single-desktop standard generic cells.
    const entry = doc.targets.find((e) => e.targetKey === "flounder:kde:linux/amd64")
      || doc.targets.find((e) => e.availability.available && !e.target.flavor.startsWith("base"));
    await page.route("**/wasm_exec.js", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.route("**/tbox.wasm", (route) => route.abort());
    await page.route("**/catalog-snapshot.json", (route) => route.fulfill({ json: doc }));
    await page.route("**/downloads.json", (route) => route.fulfill({ json: { schemaVersion: 1, prebuilt: {}, mediaWriter: null } }));
    await page.route("https://**/*", (route) => route.abort());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgentData", { value: { platform: "Linux" }, configurable: true });
    });
    await mockEngine(page);
    const params = new URLSearchParams({
      customize: "1",
      variant: entry.target.variant,
      flavor: entry.target.flavor,
      platform: entry.target.platform,
    });
    await page.goto(`/?${params.toString()}`);
    // URL params fill the inputs without firing listeners; behave like a
    // typed image so the page rebuilds the operation and the medium card.
    await page.evaluate(() => {
      document.getElementById("image").dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.locator("#mediumcard")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#medium-pin")).toContainText(L.manifestDigest);
    await expect(page.locator("#medium-pin")).toContainText(RAW_SHA256);
    await expect(page.locator("#medium-flatpaks")).toBeVisible();
    await expect(page.locator("#apps-options")).toBeHidden();
    await expect(page.locator("#advanced-options")).toBeHidden();
    await page.evaluate(() => {
      window.__written = [];
      window.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async (u8) => { window.__written.push(...u8); },
          close: async () => {},
          abort: async () => {},
        }),
      });
      window.loadWasm = async () => {};
    });
    await page.locator("#medium-download").click();
    await expect(page.locator("#medium-result")).toContainText(RAW_SHA256, { timeout: 30_000 });
    await expect(page.locator("#medium-result")).toContainText(L.manifestDigest);
    const saved = await savedBytes(page);
    expect(`sha256:${crypto.createHash("sha256").update(saved).digest("hex")}`).toBe(L.config.sha256);
  });
});
