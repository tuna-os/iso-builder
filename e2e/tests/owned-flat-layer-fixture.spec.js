// Falsification: absent OPFS, disabled prefetch, mutated served code, changed
// payload/storage bytes, repeated warm/shared network transfers, missing worker
// bytes or incomplete cleanup must fail. This tiny experiment is not an ISO,
// compression/network-savings claim, CPU measurement or qualification record.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { launchOwnedChromium, deadline, prerequisiteDiagnosticsFor, launchProvenanceFor } = require("./owned-flat-cdp");
const { openOwnedFrontendController, controllerDiagnosticsFor } = require("./owned-flat-frontend-controller");
const bad = code => new Error(`owned-layer-fixture:${code}`);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const LAYERS = Object.freeze({ A: Buffer.alloc(97, 65), B: Buffer.alloc(131, 66), C: Buffer.alloc(59, 67) });
const EXPECTED = Object.freeze(Object.fromEntries(Object.entries(LAYERS).map(([name, bytes]) => [name, Object.freeze({ name, digest: `sha256:${sha(bytes)}`, size: bytes.length })])));
const PAIRS = Object.freeze({ cold: ["A", "B"], warm: ["A", "B"], shared: ["A", "C"] });
const HTML = Buffer.from('<!doctype html><meta charset="utf-8"><title>owned layer cache fixture</title><script src="/layercache.js"></script>');
function manifest(phase) {
  return Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    layers: PAIRS[phase].map(name => ({ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: EXPECTED[name].digest, size: EXPECTED[name].size })) }));
}
function registryHandler(origin, counts) {
  return (request, response) => {
    let bytes, type = "application/octet-stream", identity;
    const phase = Object.keys(PAIRS).find(value => request.url === `/v2/fixture/manifests/${value}`);
    const layer = Object.keys(LAYERS).find(value => request.url === `/v2/fixture/blobs/${EXPECTED[value].digest}`);
    if (phase) { bytes = manifest(phase); type = "application/vnd.oci.image.manifest.v1+json"; identity = `manifest-${phase}`; }
    if (layer) { bytes = LAYERS[layer]; identity = layer; }
    if (request.method !== "GET" || !bytes || request.headers.range) { counts.rejected++; response.writeHead(409, { "Content-Length": "0" }); response.end(); return; }
    counts.requests[identity] = (counts.requests[identity] || 0) + 1;
    counts.bodyBytes += bytes.length;
    if (layer) { counts.blobBodyBytes += bytes.length; counts.uniqueLayers.add(layer); }
    response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store", "Access-Control-Allow-Origin": origin }); response.end(bytes);
  };
}
function networkSnapshot(counts) {
  return Object.freeze({ requests: Object.freeze({ ...counts.requests }), rejected: counts.rejected,
    bodyBytes: counts.bodyBytes, blobBodyBytes: counts.blobBodyBytes,
    uniqueBlobBodyBytes: [...counts.uniqueLayers].reduce((sum, name) => sum + LAYERS[name].length, 0) });
}
function operation(registryOrigin, phase) {
  // The actual production fetch hook observes the manifest and serves the blobs.
  // No alternate downloader, metadata-only mode, cache clearing or bypass is used.
  return `(async () => {
    if (!globalThis.tboxLayerCache?.isPrefetchEnabled() || !navigator.storage?.getDirectory) throw Error("fixture prerequisites");
    const started = performance.now();
    const manifestURL = ${JSON.stringify(registryOrigin + "/v2/fixture/manifests/" + phase)};
    const response = await fetch(manifestURL); if (!response.ok) throw Error("manifest failed");
    const manifest = await response.json(); if (!Array.isArray(manifest.layers) || manifest.layers.length !== 2) throw Error("manifest shape");
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2,"0")).join("");
    const payloads = [];
    for (const layer of manifest.layers) {
      const response = await fetch(${JSON.stringify(registryOrigin + "/v2/fixture/blobs/")} + layer.digest);
      if (!response.ok) throw Error("blob failed"); const bytes = await response.arrayBuffer();
      payloads.push({digest:"sha256:" + await digest(bytes), size:bytes.byteLength});
    }
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("tbox-layer-cache");
    const stored = []; let verificationFileReadBytes = 0, metadataBytes = 0;
    for await (const [name, handle] of directory.entries()) {
      if (stored.length >= 3 || handle.kind !== "directory" || !/^[0-9a-f]{64}$/.test(name)) throw Error("storage entry");
      const names = []; for await (const [filename] of handle.entries()) { if (names.length >= 2) throw Error("storage count"); names.push(filename); }
      if (names.sort().join(",") !== "c0,meta.json") throw Error("storage layout");
      const chunk = await (await handle.getFileHandle("c0")).getFile();
      const meta = await (await handle.getFileHandle("meta.json")).getFile();
      if (chunk.size > 1024 || meta.size > 512) throw Error("storage bound");
      const bytes = await chunk.arrayBuffer(); const parsed = JSON.parse(await meta.text());
      if (parsed.size !== bytes.byteLength || !Number.isSafeInteger(parsed.used)) throw Error("storage metadata");
      verificationFileReadBytes += bytes.byteLength; metadataBytes += meta.size;
      stored.push({digest:"sha256:" + name, measuredDigest:"sha256:" + await digest(bytes), size:bytes.byteLength});
    }
    stored.sort((a,b) => a.digest.localeCompare(b.digest));
    return {payloads, stored, cacheSize:await tboxLayerCache.size(), prefetchEnabled:tboxLayerCache.isPrefetchEnabled(),
      consumerPayloadBytes:payloads.reduce((sum,item)=>sum+item.size,0), verificationFileReadBytes, metadataBytes,
      fixtureWallMs:performance.now()-started, storageWriteBytes:null, storageWriteMeasurement:"unavailable", cpuTimeMs:null, cpuMeasurement:"unavailable"};
  })()`;
}
function checkPhase(phase, value, network) {
  const names = phase === "shared" ? ["A", "B", "C"] : ["A", "B"];
  expect(value.payloads).toEqual(PAIRS[phase].map(name => ({ digest: EXPECTED[name].digest, size: EXPECTED[name].size })));
  expect(value.stored).toEqual(names.map(name => ({ digest: EXPECTED[name].digest, measuredDigest: EXPECTED[name].digest, size: EXPECTED[name].size })).sort((a,b) => a.digest.localeCompare(b.digest)));
  expect(value.prefetchEnabled).toBe(true);
  expect(value.cacheSize).toEqual({ layers: names.length, bytes: names.reduce((sum,name) => sum+LAYERS[name].length,0) });
  expect(value.verificationFileReadBytes).toBe(value.cacheSize.bytes);
  expect(value.consumerPayloadBytes).toBe(PAIRS[phase].reduce((sum,name) => sum+LAYERS[name].length,0));
  expect(value.storageWriteBytes).toBeNull(); expect(value.cpuTimeMs).toBeNull();
  expect(Number.isFinite(value.fixtureWallMs) && value.fixtureWallMs >= 0).toBe(true);
  expect(network.rejected).toBe(0); expect(network.requests.A).toBe(1); expect(network.requests.B).toBe(1);
  expect(network.requests.C || 0).toBe(phase === "shared" ? 1 : 0);
  expect(network.blobBodyBytes).toBe(value.cacheSize.bytes); expect(network.uniqueBlobBodyBytes).toBe(value.cacheSize.bytes);
}
async function listen(server) {
  await deadline(new Promise((resolve,reject) => { server.once("error", () => reject(bad("server-failed"))); server.listen(0,"127.0.0.1",resolve); }), 1000, "fixture-listen-timeout");
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  if (!server) return; server.closeAllConnections();
  await deadline(new Promise(resolve => server.close(resolve)), 1000, "fixture-server-close-timeout");
}
test("registry fixture accounting distinguishes duplicate transfer bytes from unique payload bytes without sockets", () => {
  const counts = { requests:{}, rejected:0, bodyBytes:0, blobBodyBytes:0, uniqueLayers:new Set() };
  const handler = registryHandler("http://127.0.0.1:1234",counts);
  const response = { writeHead() {}, end() {} };
  for (const name of ["A","B","A"]) handler({ method:"GET", url:`/v2/fixture/blobs/${EXPECTED[name].digest}`, headers:{} },response);
  expect(networkSnapshot(counts)).toMatchObject({ blobBodyBytes:325, uniqueBlobBodyBytes:228, requests:{A:2,B:1} });
});
test("production fixture leaves cache enabled and has bounded payload/storage inspection", () => {
  const expression = operation("http://127.0.0.1:1234","cold");
  expect(expression).not.toMatch(/setPrefetchEnabled|fetchMetadata|\.clear\(/);
  expect(Buffer.byteLength(expression)).toBeLessThan(65536);
  expect(Object.values(LAYERS).reduce((sum,bytes)=>sum+bytes.length,0)).toBe(287);
});
test("owned collector real Chromium unchanged production layerworker cold warm shared bytes", async () => {
  test.setTimeout(40000);
  let owned, controller, frontend, registry, prerequisites = null, failure, observation, errorCode = null, controllerDiagnostics = null, provenance = null;
  const measured = [], frontendCounts = {}, registryCounts = { requests:{}, rejected:0, bodyBytes:0, blobBodyBytes:0, uniqueLayers:new Set() };
  try {
    const assets = { "/":HTML };
    for (const name of ["layercache.js","layerworker.js"]) {
      const bytes = await fs.readFile(path.join(__dirname,"..","..","app","public",name));
      if (bytes.length > 65536) throw bad("source-bound"); assets["/"+name] = bytes;
    }
    owned = await launchOwnedChromium({ boundedBodies:true, suppressComponentBackgroundExtensions:true }); prerequisites = owned.prerequisites; provenance = owned.provenance;
    frontend = http.createServer((request,response) => {
      const bytes = assets[request.url];
      if (request.url === "/favicon.ico") { response.writeHead(204,{"Content-Length":"0"}); response.end(); return; }
      if (request.method !== "GET" || !bytes) { response.writeHead(409,{"Content-Length":"0"}); response.end(); return; }
      frontendCounts[request.url] = (frontendCounts[request.url] || 0) + 1;
      response.writeHead(200,{"Content-Type":request.url === "/" ? "text/html" : "text/javascript","Content-Length":bytes.length,"Cache-Control":"no-store"}); response.end(bytes);
    });
    const origin = await listen(frontend);
    registry = http.createServer(registryHandler(origin,registryCounts)); const registryOrigin = await listen(registry);
    controller = await openOwnedFrontendController(owned,{documentURL:origin+"/",workerURLs:[origin+"/layerworker.js"],expectedPageScripts:[origin+"/layercache.js"],browserImplementationProfile:"chromium-156-top-chrome-v1",firstResumeDelayMs:150});
    for (const phase of ["cold","warm","shared"]) {
      const before = networkSnapshot(registryCounts), value = await controller.evaluate(operation(registryOrigin,phase)), after = networkSnapshot(registryCounts);
      checkPhase(phase,value,after);
      measured.push({phase,...value,network:after,networkBodyBytesThisPhase:after.bodyBytes-before.bodyBytes,
        blobBodyBytesThisPhase:after.blobBodyBytes-before.blobBodyBytes,uniqueBlobBytesThisPhase:after.uniqueBlobBodyBytes-before.uniqueBlobBodyBytes});
    }
    observation = await controller.finish();
    expect(observation).toMatchObject({workers:1,terminalCleanupVerified:true,completeCoverage:false,collectorProofEstablished:false});
    expect(observation.assets).toHaveLength(3);
    for (const [name,bytes] of Object.entries(assets)) {
      expect(observation.assets.find(asset=>asset.url === origin+name)).toMatchObject({sha256:`sha256:${sha(bytes)}`,sizeBytes:bytes.length,responseCount:1});
      expect(frontendCounts[name]).toBe(1);
    }
    expect(measured.map(phase=>phase.blobBodyBytesThisPhase)).toEqual([228,0,59]);
  } catch (error) {
    prerequisites ||= prerequisiteDiagnosticsFor(error);
    provenance ||= launchProvenanceFor(error);
    controllerDiagnostics = controllerDiagnosticsFor(error);
    errorCode = /^owned-(?:cdp|controller|frontend|ws|body|layer-fixture):[a-z-]+$/.test(error?.message || "") ? error.message : "owned-layer-fixture:assertion-failed";
    failure = bad("experiment-failed");
  }
  finally {
    try { if (controller) await controller.dispose(); else if (owned) await owned.close(); } catch { failure ||= bad("owned-cleanup-failed"); }
    try { await closeServer(registry); await closeServer(frontend); } catch { failure ||= bad("server-cleanup-failed"); }
    console.log(`OWNED_LAYER_CACHE_EXPERIMENT ${JSON.stringify({success:!failure,measured,prerequisites,provenance,controllerDiagnostics,
      browserVersion:owned?.pin.browserVersion || null,terminalCleanupVerified:observation?.terminalCleanupVerified === true,
      completeCoverage:false,collectorProofEstablished:false,errorCode:errorCode || failure?.message || null})}`);
  }
  if (failure) throw failure;
});
