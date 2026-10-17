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

// manifestFor builds a manifest JSON string for the given LAYERS indexes.
function manifestFor(idxs) {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "sha256:" + "0".repeat(64), size: 2 },
    layers: idxs.map((i) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+zstd", digest: LAYERS[i].digest, size: LAYERS[i].buf.length })),
  });
}

// stubRegistry serves manifests (per-tag overrides via `manifests`) and blobs,
// honouring Range, and records every blob request with how many were open at
// once plus the Range header each carried (null for a full fetch).
async function stubRegistry(page, { failFirst = false, manifests = {} } = {}) {
  const stats = { blobHits: 0, open: 0, peak: 0, failed: new Set(), auth: [], ranges: [] };
  await page.route(/\/v2\/.*\/manifests\//, (route) => {
    const tag = route.request().url().split("/manifests/")[1].split(/[?#]/)[0];
    const body = manifests[tag] || MANIFEST;
    return route.fulfill({ status: 200, contentType: "application/vnd.oci.image.manifest.v1+json", body });
  });
  await page.route(/\/v2\/.*\/blobs\//, async (route) => {
    const req = route.request();
    const digest = /blobs\/(sha256:[0-9a-f]{64})/.exec(req.url())[1];
    const layer = LAYERS.find((l) => l.digest === digest);
    stats.blobHits++;
    stats.ranges.push({ digest, range: req.headers()["range"] || null });
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

async function resolveManifest(page, tag = "latest") {
  await page.evaluate(async ({ repo, tag }) => {
    const h = new Headers({ Authorization: "Bearer stub", Accept: "application/vnd.oci.image.manifest.v1+json" });
    await (await fetch(`${location.origin}/v2/${repo}/manifests/${tag}`, { method: "GET", headers: h })).text();
  }, { repo: REPO, tag });
}

// corruptChunk flips the first byte of chunk c0 of a cached layer in OPFS.
async function corruptChunk(page, digest, chunk = "c0") {
  return page.evaluate(async ({ digest, chunk }) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("tbox-layer-cache").then((d) => d.getDirectoryHandle(digest.slice(7)));
    const h = await dir.getFileHandle(chunk);
    const f = await h.getFile();
    const buf = new Uint8Array(await f.arrayBuffer());
    buf[0] ^= 0xff;
    const w = await h.createWritable();
    await w.write(buf);
    await w.close();
    return { size: f.size };
  }, { digest, chunk });
}

// seedPartial writes the first `whole` chunks of layer buf into OPFS plus an
// empty trailing chunk file (the recorded c3-zero-bytes case), with no
// meta.json so the layer counts as interrupted, not complete.
async function seedPartial(page, digest, buf, whole) {
  return page.evaluate(async ({ digest, buf64, whole }) => {
    const CHUNK = 4 << 20;
    const bin = Uint8Array.from(atob(buf64), (c) => c.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle("tbox-layer-cache", { create: true });
    const dir = await cache.getDirectoryHandle(digest.slice(7), { create: true });
    for (let i = 0; i < whole; i++) {
      const w = await (await dir.getFileHandle("c" + i, { create: true })).createWritable();
      await w.write(bin.subarray(i * CHUNK, (i + 1) * CHUNK));
      await w.close();
    }
    await dir.getFileHandle("c" + whole, { create: true }); // zero-byte tail
    return { seeded: whole * CHUNK };
  }, { digest, buf64: Buffer.from(buf.subarray(0, whole * (4 << 20))).toString("base64"), whole });
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

  test("an unchanged warm build transfers zero already-complete layers", async ({ page }) => {
    const stats = await stubRegistry(page);
    await resolveManifest(page);
    await expect(page.locator("#log")).toContainText(`all ${LAYERS.length} layers on disk`);
    const warm = stats.blobHits;
    expect(warm).toBe(LAYERS.length);

    // Same manifest again: every layer is complete in OPFS, so no blob
    // request may reach the network.
    await resolveManifest(page);
    await expect(page.locator("#log")).toContainText(`${LAYERS.length}/${LAYERS.length} layers on disk, nothing to download`);
    for (const l of LAYERS) {
      expect((await engineFetch(page, l.digest)).hex).toBe(hexOf(l.buf));
    }
    expect(stats.blobHits).toBe(warm);
  });

  test("a related build downloads only layers not already complete", async ({ page }) => {
    const stats = await stubRegistry(page, {
      manifests: { base: manifestFor([0, 1, 2, 3]), next: manifestFor([0, 1, 2, 4]) },
    });
    await resolveManifest(page, "base");
    await expect.poll(() => stats.blobHits).toBe(4);
    await expect(page.locator("#log")).toContainText("all 4 layers on disk");
    const warm = stats.blobHits;

    // Layers 0-2 carry over; only layer 4 is new and may hit the network.
    // Layer 3 is absent from manifest B, so it must not be re-fetched either.
    await resolveManifest(page, "next");
    await expect.poll(() => stats.blobHits).toBe(warm + 1);
    const fresh = stats.ranges.slice(warm).map((r) => r.digest);
    expect(fresh).toEqual([LAYERS[4].digest]);
    for (const i of [0, 1, 2, 4]) {
      expect((await engineFetch(page, LAYERS[i].digest)).hex).toBe(hexOf(LAYERS[i].buf));
    }
    expect(stats.blobHits).toBe(warm + 1);
  });

  test("a tampered chunk is rejected and re-fetched, never served corrupt", async ({ page }) => {
    const stats = await stubRegistry(page);
    const l = LAYERS[0];
    expect((await engineFetch(page, l.digest)).hex).toBe(hexOf(l.buf));
    const warm = stats.blobHits;

    await corruptChunk(page, l.digest);
    const got = await engineFetch(page, l.digest);
    // Correct bytes come back: the corrupt cache entry is rejected
    // (digest mismatch) and the layer is re-fetched from the registry.
    expect(got.hex).toBe(hexOf(l.buf));
    expect(got.length).toBe(l.buf.length);
    expect(stats.blobHits).toBeGreaterThan(warm);
    expect(stats.ranges.slice(warm).map((r) => r.digest)).toContain(l.digest);
  });

  test("a zero-byte trailing chunk is discarded and resumed at the boundary", async ({ page }) => {
    const CHUNK = 4 << 20;
    const stats = await stubRegistry(page);
    const l = LAYERS[2]; // (9 << 20) + 12345 bytes: two whole chunks plus a tail
    await seedPartial(page, l.digest, l.buf, 2);
    await resolveManifest(page);
    // The worker drops the empty tail and resumes whole: the registry sees a
    // Range starting exactly at the whole-chunk boundary.
    await expect.poll(() => stats.ranges.length).toBeGreaterThan(0);
    const resume = stats.ranges.find((r) => r.digest === l.digest && r.range);
    expect(resume?.range).toBe(`bytes=${2 * CHUNK}-`);
    await expect(page.locator("#log")).toContainText(`all ${LAYERS.length} layers on disk`);
    const got = await engineFetch(page, l.digest);
    expect(got).toEqual({ status: 200, length: l.buf.length, hex: hexOf(l.buf) });
  });
});
