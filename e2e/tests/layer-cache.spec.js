// The layer cache and parallel layer download (iso-builder#191), tested
// without an engine or a registry.
//
// layercache.js only sees fetch(): a manifest goes by, then the engine asks
// for blobs one at a time. So a stub registry on the page's own origin and
// fetch calls shaped like the Go js/wasm transport's (a Headers object, an
// explicit method) exercise all of it in seconds.
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");

const REPO = "tuna-os/stub";
// Sizes straddle the 4 MiB chunk: under one chunk, exactly one, several with
// a short tail.
const SIZES = [1 << 20, 4 << 20, (9 << 20) + 12345, (6 << 20) + 7, 3 << 20, 512];
const LAYERS = SIZES.map((n, i) => {
  const body = crypto.createHash("sha256").update(`seed${i}`).digest();
  const buf = Buffer.alloc(n);
  for (let p = 0; p < n; p += body.length) body.copy(buf, p);
  return { buf, digest: "sha256:" + crypto.createHash("sha256").update(buf).digest("hex") };
});
const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "sha256:" + "0".repeat(64), size: 2 },
  layers: LAYERS.map((l) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+zstd", digest: l.digest, size: l.buf.length })),
});

// stubRegistry serves the manifest and blobs, honouring Range, and records
// every blob request with how many were open at once.
async function stubRegistry(page, { failFirst = false } = {}) {
  const stats = { blobHits: 0, open: 0, peak: 0, failed: new Set(), auth: [] };
  await page.route(/\/v2\/.*\/manifests\//, (route) =>
    route.fulfill({ status: 200, contentType: "application/vnd.oci.image.manifest.v1+json", body: MANIFEST }));
  await page.route(/\/v2\/.*\/blobs\//, async (route) => {
    const req = route.request();
    const digest = /blobs\/(sha256:[0-9a-f]{64})/.exec(req.url())[1];
    const layer = LAYERS.find((l) => l.digest === digest);
    stats.blobHits++;
    stats.auth.push(req.headers()["authorization"]);
    stats.open++;
    stats.peak = Math.max(stats.peak, stats.open);
    // Hold the response long enough that parallel downloads overlap.
    await new Promise((r) => setTimeout(r, 150));
    stats.open--;
    if (failFirst && !stats.failed.has(digest)) {
      stats.failed.add(digest);
      return route.fulfill({ status: 503, body: "busy" });
    }
    const range = /bytes=(\d+)-/.exec(req.headers()["range"] || "");
    if (range) {
      const from = Number(range[1]);
      return route.fulfill({ status: 206, body: layer.buf.subarray(from) });
    }
    return route.fulfill({ status: 200, body: layer.buf });
  });
  return stats;
}

// engineFetch reads a blob the way the Go transport does and returns its
// sha256 and length, so no multi-MB array crosses back into Node.
async function engineFetch(page, digest, from = 0) {
  return page.evaluate(async ({ repo, digest, from }) => {
    const h = new Headers({ Authorization: "Bearer stub" });
    if (from) h.set("Range", `bytes=${from}-`);
    const r = await fetch(`${location.origin}/v2/${repo}/blobs/${digest}`, { method: "GET", headers: h });
    const buf = new Uint8Array(await r.arrayBuffer());
    const sum = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { status: r.status, length: buf.length, hex };
  }, { repo: REPO, digest, from });
}

async function resolveManifest(page) {
  await page.evaluate(async (repo) => {
    const h = new Headers({ Authorization: "Bearer stub", Accept: "application/vnd.oci.image.manifest.v1+json" });
    await (await fetch(`${location.origin}/v2/${repo}/manifests/latest`, { method: "GET", headers: h })).text();
  }, REPO);
}

const hexOf = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test.describe("layer cache", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => tboxLayerCache.clear());
  });

  test("a manifest starts every layer downloading, several at once", async ({ page }) => {
    const stats = await stubRegistry(page);
    await resolveManifest(page);
    // Nothing asked for a blob yet: these are the prefetches.
    await expect.poll(() => stats.blobHits).toBe(LAYERS.length);
    expect(stats.peak).toBeGreaterThan(1);
    expect(stats.peak).toBeLessThanOrEqual(4);
    // Prefetch reuses the manifest request's token.
    expect(stats.auth.every((a) => a === "Bearer stub")).toBe(true);
    await expect(page.locator("#log")).toContainText(`all ${LAYERS.length} layers on disk`);

    for (const l of LAYERS) {
      const got = await engineFetch(page, l.digest);
      expect(got).toEqual({ status: 200, length: l.buf.length, hex: hexOf(l.buf) });
    }
    // Served from disk: the engine's reads added no network requests.
    expect(stats.blobHits).toBe(LAYERS.length);
  });

  test("a reload rebuilds without downloading anything", async ({ page }) => {
    const stats = await stubRegistry(page);
    await resolveManifest(page);
    await expect(page.locator("#log")).toContainText(`all ${LAYERS.length} layers on disk`);
    const before = stats.blobHits;

    await page.reload();
    await resolveManifest(page);
    await expect(page.locator("#log")).toContainText(`${LAYERS.length}/${LAYERS.length} layers on disk, nothing to download`);
    for (const l of LAYERS) {
      expect((await engineFetch(page, l.digest)).hex).toBe(hexOf(l.buf));
    }
    expect(stats.blobHits).toBe(before);
    await expect(page.locator("#cachestat")).toContainText(`${LAYERS.length} layers`);
  });

  test("an engine request with no manifest seen downloads and streams it", async ({ page }) => {
    const stats = await stubRegistry(page);
    const l = LAYERS[2];
    expect(await engineFetch(page, l.digest)).toEqual({ status: 200, length: l.buf.length, hex: hexOf(l.buf) });
    expect(stats.blobHits).toBe(1);
  });

  test("an engine resume (Range) gets 206 and the right tail", async ({ page }) => {
    await stubRegistry(page);
    const l = LAYERS[2];
    for (const from of [1, 4 << 20, (5 << 20) + 99]) {
      const got = await engineFetch(page, l.digest, from);
      expect(got).toEqual({ status: 206, length: l.buf.length - from, hex: hexOf(l.buf.subarray(from)) });
    }
  });

  test("a failed download is retried instead of reaching the engine", async ({ page }) => {
    const stats = await stubRegistry(page, { failFirst: true });
    const l = LAYERS[3];
    expect((await engineFetch(page, l.digest)).hex).toBe(hexOf(l.buf));
    expect(stats.failed.size).toBe(1);
    await expect(page.locator("#log")).toContainText("retry 1");
  });

  test("clearing drops every downloaded layer", async ({ page }) => {
    const stats = await stubRegistry(page);
    await resolveManifest(page);
    await expect(page.locator("#log")).toContainText(`all ${LAYERS.length} layers on disk`);
    await page.locator("summary", { hasText: "Advanced" }).click();
    await page.evaluate(() => showCacheSize()); // inspect() does this after a pull
    await expect(page.locator("#cachestat")).toContainText(`${LAYERS.length} layers`);
    await page.locator("#clearcache").click();
    await expect(page.locator("#log")).toContainText("layer cache cleared");
    await expect(page.locator("#cachestat")).toHaveText("empty");
    const before = stats.blobHits;
    await engineFetch(page, LAYERS[0].digest);
    expect(stats.blobHits).toBe(before + 1);
  });
});
