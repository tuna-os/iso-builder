const { test, expect, chromium } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { useProfile } = require("./fixtures");
const { observeRegistryTransfers, summarizeRegistryTransfers } = require("./build-measurements");
const { campaignValue } = require("./pair-protocol");

// Public synthetic bytes over real loopback TCP, never intercepted Playwright routes.
const layer = `sha256:${"a".repeat(64)}`;
const config = `sha256:${"b".repeat(64)}`;
const bytes = Buffer.alloc(1024 * 1024, 37);
let server, origin, requests;
test.beforeAll(async () => {
  requests = [];
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, range: req.headers.range || null });
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/") { res.end("<!doctype html><title>Public pair fixture</title>"); return; }
    if (req.url === "/worker.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end('onmessage = async e => { try { const r = await fetch(e.data); postMessage((await r.arrayBuffer()).byteLength); } catch { postMessage("failed"); } };'); return;
    }
    if (req.url.includes("pendingManifest=1")) {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 4096 });
      res.write("{");
      return;
    }
    if (req.url.includes("/manifests/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: config }, layers: [{ digest: layer }] })); return;
    }
    if (req.url.includes("/redirect/")) { res.writeHead(307, { Location: `/v2/fixture/blobs/${layer}` }); res.end(); return; }
    if (req.url.includes("broken=1")) {
      res.writeHead(200, { "Content-Length": bytes.length * 2 }); res.write(bytes);
      setTimeout(() => res.destroy(), 20); return;
    }
    if (req.url.includes("/blobs/")) {
      const body = req.url.endsWith(config) ? Buffer.from("config") : bytes;
      if (req.headers.range) { res.writeHead(206, { "Content-Range": `bytes 0-15/${body.length}`, "Content-Length": 16 }); res.end(body.subarray(0, 16)); return; }
      res.setHeader("Content-Length", body.length); res.end(body); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

test("real Chromium observes worker layers, configs, redirects, ranges, HEAD and failed bodies", async ({ page, context }) => {
  const observer = observeRegistryTransfers(context);
  try {
    await page.goto(origin);
    await page.evaluate(async ({ layer, config }) => {
      const read = async (url, options) => { try { const r = await fetch(url, options); await r.arrayBuffer(); } catch {} };
      await read("/v2/fixture/manifests/fixed");
      await read(`/v2/fixture/blobs/${config}`);
      await read(`/v2/fixture/blobs/${layer}`, { method: "HEAD" });
      await read(`/v2/fixture/blobs/${layer}`, { headers: { Range: "bytes=0-15" } });
      await read(`/v2/fixture/blobs/${layer}?redirect=1`);
      await read(`/v2/fixture/redirect/${layer}`);
      await read(`/v2/fixture/blobs/${layer}?broken=1`);
      await new Promise(resolve => { const w = new Worker("/worker.js"); w.onmessage = () => { w.terminate(); resolve(); }; w.postMessage(`/v2/fixture/blobs/${layer}`); });
    }, { layer, config });
    await expect.poll(async () => (await observer.summary()).inFlightBlobRequests).toBe(0);
    const result = await observer.summary();
    expect(result.completeLayerBlobs).toBe(3);
    expect(result.completeLayerBytes).toBe(3 * bytes.length);
    expect(result.completeConfigBlobs).toBe(1);
    expect(result.configBytes).toBe(6);
    expect(result.rangeRequests).toBe(1);
    expect(result.rangeBytes).toBe(16);
    expect(result.transfers.some(t => t.failure)).toBe(true);
    expect(result.transfers.some(t => t.method === "HEAD")).toBe(true);
    expect(result.transfers.some(t => t.redirected && t.status === 200)).toBe(true);
    expect(result.observer.blobBodyBytesRead).toBe(0);
    expect(result.observer.errors).toEqual([]);
  } finally { observer.stop(); }
});

test("unknown byte sizes cannot count as completed layers", () => {
  const row = { method: "GET", status: 200, range: null, failure: null, digest: layer };
  const result = summarizeRegistryTransfers([{ ...row, bytes: null }, { ...row, bytes: 0 }], new Set());
  expect(result.completeLayerBlobs).toBe(0);
  expect(result.unknownSizeRequests).toBe(1);
});

test("actual fixture reopens OPFS after browser exit and cold resets it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pair-profile-"));
  const options = { browserType: chromium, root, workerIndex: 0, mode: "cold", keep: true };
  const run = (mode, keep, fn) => useProfile({ ...options, mode, keep }, async context => {
    const page = context.pages()[0]; await page.goto(origin); await fn(page, context);
  });
  const read = page => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try { return await (await (await root.getFileHandle("public-layer")).getFile()).text(); }
    catch (e) { if (e.name === "NotFoundError") return null; throw e; }
  });
  try {
    await expect(run("warm", false, async () => {})).rejects.toThrow(/cold run's profile/);
    await run("cold", true, async page => {
      expect(await read(page)).toBeNull();
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory(); const f = await root.getFileHandle("public-layer", { create: true });
        const writer = await f.createWritable(); await writer.write("retained public bytes"); await writer.close();
      });
    });
    await run("warm", true, async page => expect(await read(page)).toBe("retained public bytes"));
    await run("cold", false, async page => expect(await read(page)).toBeNull());
    await expect(fs.stat(path.join(root, "tmp/pw-prof-0"))).rejects.toThrow();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("campaign pins reject changed inputs rather than replacing the first sample", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pair-pins-"));
  const old = { pair: process.env.TBOX_E2E_PAIR, state: process.env.TBOX_E2E_PAIR_STATE };
  process.env.TBOX_E2E_PAIR = "1"; process.env.TBOX_E2E_PAIR_STATE = path.join(root, "pins.json");
  try {
    expect(campaignValue("source", { digest: layer })).toEqual({ digest: layer });
    expect(campaignValue("source", { digest: layer })).toEqual({ digest: layer });
    expect(() => campaignValue("source", { digest: config })).toThrow(/changed source/);
    expect(JSON.parse(await fs.readFile(process.env.TBOX_E2E_PAIR_STATE, "utf8"))).toEqual({ source: { digest: layer } });
  } finally {
    for (const [key, value] of [["TBOX_E2E_PAIR", old.pair], ["TBOX_E2E_PAIR_STATE", old.state]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("records bounded observer on/off overhead over real network without body copies", async ({ page, context }, testInfo) => {
  await page.goto(origin);
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const observed = i % 2 === 1;
    const observer = observed ? observeRegistryTransfers(context) : null;
    const before = requests.length;
    const started = performance.now();
    try {
      await page.evaluate(async layer => {
        for (let n = 0; n < 8; n++) {
          const response = await fetch(`/v2/fixture/blobs/${layer}?overhead=${n}`);
          await response.arrayBuffer();
        }
      }, layer);
      const transfer = observer ? await observer.summary() : null;
      samples.push({ observed, wallMs: performance.now() - started, requests: requests.length - before,
        bodyBytes: 8 * bytes.length, transfer });
      expect(requests.length - before).toBe(8);
      if (transfer) {
        expect(transfer.completeLayerBytes).toBe(8 * bytes.length);
        expect(transfer.observer.blobBodyBytesRead).toBe(0);
      }
    } finally { observer?.stop(); }
  }
  const report = { kind: "synthetic-loopback-observer-overhead", qualification: "not-assessed",
    browser: await page.evaluate(() => navigator.userAgent), samples,
    pairedWallDeltaMs: [0, 2, 4].map(i => samples[i + 1].wallMs - samples[i].wallMs),
    limitation: "Alternating 8 MiB loopback fetches, not an ISO speed claim; includes scheduling and request.sizes IPC." };
  console.log(JSON.stringify(report));
  const reportPath = testInfo.outputPath("observer-overhead.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach("observer-overhead.json", { path: reportPath, contentType: "application/json" });
});

test("failure snapshots retain pending real network observations without awaiting a stalled body", async ({ page, context }) => {
  await page.goto(origin);
  const observer = observeRegistryTransfers(context);
  try {
    await page.evaluate(() => {
      fetch("/v2/fixture/manifests/fixed?pendingManifest=1").then(r => r.text()).catch(() => {});
    });
    await expect.poll(() => observer.snapshot().observer.pendingObservations).toBeGreaterThan(0);
    const started = performance.now();
    const snapshot = observer.snapshot();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(snapshot.observer.pendingObservations).toBeGreaterThan(0);
    expect(snapshot.observer.networkRequestsSeen).toBeGreaterThan(0);
    expect(snapshot.manifests).toEqual([]);
    expect(snapshot.completeLayerBlobs).toBe(0);
    await page.goto("about:blank");
  } finally { observer.stop(); }
});
