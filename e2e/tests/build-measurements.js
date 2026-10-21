// Test-only observations. These do not authenticate a producer or qualify media.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { validateBuildResult } = require("../../app/public/build-result");

// Passed directly to addInitScript: keep browser code self-contained.
function observeLoadedWasm() {
  const nativeInstantiate = WebAssembly.instantiateStreaming;
  const state = { calls: 0, result: null, error: null, pending: null };
  globalThis.__loadedWasmMeasurement = state;
  WebAssembly.instantiateStreaming = async function (source, imports, ...rest) {
    state.calls++;
    const response = await source;
    let observation;
    try {
      if (!(response instanceof Response) || !response.ok || response.redirected ||
          response.url !== new URL("tbox.wasm", location.href).href) {
        throw new Error("unexpected WASM response");
      }
      const copy = response.clone();
      observation = (async () => {
        const reader = copy.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 64 * 1024 * 1024) throw new Error("WASM observation exceeds 64 MiB");
            chunks.push(value);
          }
        } finally {
          // Do not await cancel on a tee: the native consumer may still be reading.
          reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!size) throw new Error("empty WASM response");
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return { sha256: "sha256:" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""), sizeBytes: size };
      })();
    } catch (error) {
      observation = Promise.reject(error);
    }
    // An observer failure is reported later, without changing native instantiation.
    state.pending = observation.then(result => { state.result = result; }, error => { state.error = String(error); });
    try {
      const result = await Reflect.apply(nativeInstantiate, WebAssembly, [response, imports, ...rest]);
      state.instantiated = true;
      return result;
    } catch (error) {
      state.error = "native WASM instantiation failed";
      throw error;
    }
  };
}

async function loadedWasmMeasurement(page) {
  const result = await page.evaluate(async () => {
    const s = globalThis.__loadedWasmMeasurement;
    if (!s) return null;
    await s.pending;
    return { calls: s.calls, instantiated: s.instantiated, result: s.result, error: s.error };
  });
  if (!result || result.calls !== 1 || !result.instantiated || result.error || !result.result) {
    throw new Error("one successful observed WASM instantiation is required");
  }
  return result.result;
}

async function hashSavedIso(filename, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error("invalid ISO size");
  const file = await fs.promises.open(filename, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedSize)) throw new Error("ISO size mismatch");
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      size += chunk.length;
      if (size > expectedSize) throw new Error("ISO grew while hashing");
      hash.update(chunk);
    }
    const after = await file.stat({ bigint: true });
    const named = await fs.promises.stat(filename, { bigint: true });
    if (size !== expectedSize || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size || named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) {
      throw new Error("ISO changed while hashing");
    }
    return { sha256: "sha256:" + hash.digest("hex"), sizeBytes: size };
  } finally { await file.close(); }
}

async function buildOperationIdentity(page) {
  return page.evaluate(() => {
    const op = globalThis.tboxCurrentOperation;
    if (!op || !Number.isSafeInteger(op.id) || !Number.isSafeInteger(op.buildAttempt)) {
      throw new Error("an active browser build attempt is required");
    }
    return { operationId: op.id, attempt: op.buildAttempt };
  });
}

async function completedBuildResult(page, expectedIdentity = null) {
  return page.evaluate(expected => {
    const op = globalThis.tboxCurrentOperation;
    if (!op || op.state !== "completed" || !Number.isSafeInteger(op.buildAttempt)) {
      throw new Error("a completed browser build is required");
    }
    if (expected && (op.id !== expected.operationId || op.buildAttempt !== expected.attempt)) {
      throw new Error("browser build operation changed during measurement");
    }
    // null is intentional for an older engine. Catalog/request identities are
    // never a substitute for the engine's operation-local observations.
    return op.buildResult ?? null;
  }, expectedIdentity);
}

function diagnosticRecord({ iso, wasm, browser, phasesMs, buildResult = null, loadedFrontend = null }) {
  for (const value of [iso, wasm]) {
    if (!value || typeof value.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) {
      throw new Error("invalid byte measurement");
    }
  }
  if (!browser || typeof browser.product !== "string" || !/^(?:Chrome|HeadlessChrome)\/[0-9]+(?:\.[0-9]+)+$/.test(browser.product) ||
      typeof browser.userAgent !== "string" || !browser.userAgent.trim()) throw new Error("missing Chromium version");
  for (const name of ["inspect", "build", "save"]) {
    if (typeof phasesMs?.[name] !== "number" || !Number.isFinite(phasesMs[name]) || phasesMs[name] < 0) throw new Error("invalid phase duration");
  }
  if (loadedFrontend !== null && (loadedFrontend?.schemaVersion !== 1 ||
      loadedFrontend.kind !== "diagnostic-loaded-frontend" || loadedFrontend.coverage !== "page-target-only" ||
      loadedFrontend.qualification !== "not-assessed" || loadedFrontend.authentication !== "not-verified")) {
    throw new Error("invalid diagnostic frontend observation");
  }
  return {
    schemaVersion: 1, kind: "diagnostic-build-measurements", qualification: "not-assessed",
    iso: { sha256: iso.sha256, sizeBytes: iso.sizeBytes },
    loadedWasm: { sha256: wasm.sha256, sizeBytes: wasm.sizeBytes },
    loadedFrontend,
    engineBuildResult: buildResult === null ? null : validateBuildResult(buildResult, iso.sizeBytes),
    missingIdentity: ["producer", "frontend"],
    browser: { product: browser.product, userAgent: browser.userAgent },
    phasesMs: { inspect: phasesMs.inspect, build: phasesMs.build, save: phasesMs.save },
    timingNote: "Existing stage durations exclude navigation and include observer overhead where it overlaps; no performance qualification.",
  };
}

module.exports = { observeLoadedWasm, loadedWasmMeasurement, hashSavedIso, buildOperationIdentity, completedBuildResult, diagnosticRecord };
