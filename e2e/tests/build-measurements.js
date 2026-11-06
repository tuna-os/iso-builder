// Test-only observations. These do not authenticate a producer or qualify media.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Session } = require("node:inspector");
const { fileURLToPath } = require("node:url");
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

// Test-only hook at the engine's synchronous JS -> Go request parser boundary.
// Hash the string actually returned to that parser, never a later serialization
// of tboxCurrentOperation.request. Native return values and errors are untouched.
function observeConsumedBuildInputs() {
  const nativeStringify = JSON.stringify;
  const state = { calls: [], active: null };
  globalThis.__consumedBuildInputs = state;
  JSON.stringify = function (...args) {
    const text = Reflect.apply(nativeStringify, JSON, args);
    const call = state.active;
    if (call && args[0]?.kind === "build-request" && args[0]?.schemaVersion === 1) {
      call.serializations++;
      if (typeof text === "string" && text.length <= 1024 * 1024) call.requestJson = text;
      else call.error = "consumed request serialization exceeds observation limit";
    }
    return text;
  };
  for (const name of ["tboxBuildIso", "tboxBuildIsoWithResult"]) {
    let implementation;
    Object.defineProperty(globalThis, name, {
      configurable: true, enumerable: true,
      get: () => implementation,
      set(fn) {
        if (typeof fn !== "function") { implementation = fn; return; }
        implementation = function (...args) {
          const op = globalThis.tboxCurrentOperation;
          const call = { operationId: op?.id, attempt: op?.buildAttempt,
            startedAt: performance.now(), serializations: 0, requestJson: null, error: null };
          state.calls.push(call);
          const previous = state.active;
          state.active = call;
          try { return Reflect.apply(fn, this, args); }
          finally { state.active = previous; }
        };
      },
    });
  }
}

async function completedInputMeasurements(page, expectedIdentity) {
  return page.evaluate(async expected => {
    const check = () => {
      const op = globalThis.tboxCurrentOperation;
      if (!expected || !op || op.state !== "completed" ||
          op.id !== expected.operationId || op.buildAttempt !== expected.attempt) {
        throw new Error("browser build operation changed during input measurement");
      }
    };
    check();
    const calls = globalThis.__consumedBuildInputs?.calls ?? [];
    const matching = calls.filter(call => call.operationId === expected.operationId && call.attempt === expected.attempt);
    const call = matching.length === 1 ? matching[0] : null;
    // Snapshot the string before awaiting storage; no mutable request is read.
    const requestJson = call?.serializations === 1 && !call.error ? call.requestJson : null;
    const requestError = requestJson === null
      ? call?.error || "exactly one engine-consumed request serialization was not observed" : null;
    const elapsedMs = call ? performance.now() - call.startedAt : null;
    const deviceMemory = navigator.deviceMemory;
    let storage = null;
    try { storage = await navigator.storage.estimate(); } catch (_) {}
    check();
    return { operation: { operationId: expected.operationId, attempt: expected.attempt },
      requestJson, requestError, elapsedMs, deviceMemory: deviceMemory ?? null,
      storage: storage ? { quota: storage.quota ?? null, usage: storage.usage ?? null } : null };
  }, expectedIdentity);
}

// Observe the responses already loaded by this page. Reading files from the
// checkout or fetching their URLs again could hash bytes the browser never used.
function observeFrontendResponses(page) {
  const files = [];
  const failures = [];
  const pending = new Set();
  const publicPaths = new Set(["/", "/index.html", ...[
    "wasm_exec", "layercache", "build-result", "builder-config", "builder-config-data",
    "guided-catalog", "guided-catalog-data", "guided-picker", "experience-data",
    "experiences", "flatpak-defaults", "app",
  ].map(name => `/${name}.js`)]);
  const onFinished = request => {
    if (!["document", "script", "stylesheet"].includes(request.resourceType())) return;
    let frame;
    try { frame = request.frame(); } catch (_) { return; }
    if (frame !== page.mainFrame()) return;
    const url = new URL(request.url());
    if (url.origin !== new URL(page.url()).origin || !publicPaths.has(url.pathname)) {
      failures.push({ path: null, reason: "non-public-or-cross-origin-frontend-response" });
      return;
    }
    // Only allowlisted public path coordinates survive; never URL credentials,
    // navigation parameters, signed queries or raw network exception messages.
    const assetPath = url.pathname;
    const task = (async () => {
      const response = await request.response();
      if (!response || request.method() !== "GET" || response.status() !== 200 ||
          request.redirectedFrom() || request.redirectedTo()) {
        failures.push({ path: assetPath, reason: "frontend-response-not-unredirected-successful-get" });
        return;
      }
      const bytes = await response.body();
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
        failures.push({ path: assetPath, reason: "frontend-response-outside-observation-limit" });
        return;
      }
      files.push({ path: assetPath, resourceType: request.resourceType(),
        sha256: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length });
    })().catch(() => { failures.push({ path: assetPath, reason: "frontend-response-body-unavailable" }); });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on("requestfinished", onFinished);
  return {
    async summary() {
      while (pending.size) await Promise.all([...pending]);
      return { files: [...files].sort((a, b) => a.path.localeCompare(b.path)), failures: [...failures] };
    },
    stop() { page.off("requestfinished", onFinished); },
  };
}

function producerEnvironment(env) {
  const names = ["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_SHA", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_JOB"];
  const raw = Object.fromEntries(names.map(name => [name, typeof env[name] === "string" ? env[name] : null]));
  const positive = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  return { source: "producer-process-environment", authenticated: false, raw,
    runId: positive(raw.GITHUB_RUN_ID), runAttempt: positive(raw.GITHUB_RUN_ATTEMPT) };
}

const HARNESS_SOURCE_PATHS = [
  "e2e/tests/build-measurements.js", "e2e/tests/builder.spec.js",
  "e2e/tests/fixtures.js", "e2e/playwright.config.js",
];

function githubWorkflowPath(env) {
  const repository = env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  const prefix = `${repository}/`;
  const ref = env.GITHUB_WORKFLOW_REF;
  if (typeof ref !== "string" || !ref.startsWith(prefix)) return null;
  const match = /^(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@([^\s\x00-\x1f\x7f]+)$/.exec(ref.slice(prefix.length));
  return match ? match[1] : null;
}

function sourceMeasurementFailure(reason) {
  const error = new Error(reason);
  error.observationReason = reason;
  throw error;
}

function sourceFileSnapshot(root, relative) {
  if (relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) {
    sourceMeasurementFailure("invalid-harness-source-path");
  }
  const filename = path.join(root, relative);
  if (fs.realpathSync(filename) !== filename || fs.lstatSync(filename).isSymbolicLink()) {
    sourceMeasurementFailure("symlinked-harness-source");
  }
  const fd = fs.openSync(filename, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 8n * 1024n ** 2n) sourceMeasurementFailure("invalid-harness-source-file");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.statSync(filename, { bigint: true });
    const token = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
    if (bytes.length !== Number(before.size) || token(before) !== token(after) || token(after) !== token(named)) {
      sourceMeasurementFailure("harness-source-changed-while-hashing");
    }
    return { bytes, token: token(after),
      sha256: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
  } finally { fs.closeSync(fd); }
}

// require.cache names modules, not their compiled bytes. Ask V8 for the actual
// script source; disk files or source-map sourcesContent cannot supply this fact.
async function observeLoadedHarnessSource(root, snapshots) {
  const required = new Map(snapshots.filter(file => file.loadedRequired).map(file => [file.path, file]));
  const files = new Map([...required.keys()].map(relative => [relative, { path: relative, scripts: [] }]));
  const session = new Session();
  const scripts = [];
  let exceeded = false;
  const post = (method, params = {}) => new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  session.on("Debugger.scriptParsed", ({ params }) => {
    let filename;
    try {
      filename = params.url.startsWith("file:") ? fileURLToPath(params.url) : params.url;
      if (!path.isAbsolute(filename)) return;
    } catch (_) { return; }
    const relative = path.relative(root, filename).split(path.sep).join("/");
    if (!required.has(relative)) return;
    if (scripts.length >= 256) { exceeded = true; return; }
    scripts.push({ id: params.scriptId, path: relative, length: params.length });
  });
  try {
    session.connect();
    await post("Debugger.enable", { maxScriptsCacheSize: 64 * 1024 * 1024 });
    let totalBytes = 0;
    for (const script of scripts) {
      const entry = files.get(script.path);
      if (!Number.isSafeInteger(script.length) || script.length < 0 || script.length > 8 * 1024 * 1024 ||
          totalBytes + script.length * 4 > 64 * 1024 * 1024) {
        entry.reason = "loaded-source-observation-limit";
        continue;
      }
      let source;
      try { source = (await post("Debugger.getScriptSource", { scriptId: script.id })).scriptSource; }
      catch (_) { entry.reason = "v8-script-source-unavailable"; continue; }
      if (typeof source !== "string") { entry.reason = "v8-script-source-unavailable"; continue; }
      const sizeBytes = Buffer.byteLength(source, "utf8");
      totalBytes += sizeBytes;
      if (sizeBytes > 8 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) {
        entry.reason = "loaded-source-observation-limit";
        continue;
      }
      const sha256 = "sha256:" + crypto.createHash("sha256").update(source, "utf8").digest("hex");
      const expected = required.get(script.path);
      const comparison = sha256 === expected.sha256 ? "exact-source" :
        sha256 === expected.commonJsSha256 ? "standard-commonjs-wrapper" : "different-source";
      entry.scripts.push({ sha256, sizeBytes, comparison });
    }
    for (const entry of files.values()) {
      entry.status = entry.reason ? "unavailable" : entry.scripts.length === 0 ? "missing" :
        entry.scripts.some(script => script.comparison === "different-source") ? "mismatched" :
          entry.scripts.length !== 1 ? "ambiguous" : "matched";
      if (entry.status === "missing") entry.reason = "loaded-source-bytes-not-observed";
      if (entry.status === "mismatched") entry.reason = "compiled-source-does-not-match-head";
      if (entry.status === "ambiguous") entry.reason = "multiple-v8-scripts-for-source-path";
    }
    return { method: "v8.Debugger.getScriptSource", status: !exceeded &&
      [...files.values()].every(file => file.status === "matched") ? "matched" : "missing",
      files: [...files.values()], ...(exceeded ? { reason: "loaded-source-observation-limit" } : {}) };
  } catch (_) {
    return { method: "v8.Debugger.getScriptSource", status: "missing",
      files: [...required.keys()].map(relative => ({ path: relative, status: "unavailable",
        scripts: [], reason: "v8-inspector-unavailable" })) };
  } finally { try { session.disconnect(); } catch (_) {} }
}

async function captureExecutingSource({ root = path.resolve(__dirname, "../.."), additionalFiles = [], env = process.env } = {}) {
  try {
    root = fs.realpathSync(root);
    const gitEnv = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete gitEnv[name];
    const git = (...args) => execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "-C", root, ...args],
      { env: gitEnv, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (fs.realpathSync(git("rev-parse", "--show-toplevel").toString("utf8").trim()) !== root) {
      sourceMeasurementFailure("harness-source-outside-checkout-root");
    }
    const revision = git("rev-parse", "--verify", "HEAD").toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) sourceMeasurementFailure("unsupported-checkout-revision");
    const clean = () => git("status", "--porcelain=v1", "-z", "--untracked-files=normal").length === 0;
    if (!clean()) sourceMeasurementFailure("checkout-dirty-or-untracked");
    const files = new Set([...HARNESS_SOURCE_PATHS, ...additionalFiles]);
    const loadedPaths = new Set(HARNESS_SOURCE_PATHS);
    const workflowPath = githubWorkflowPath(env);
    if (workflowPath) files.add(workflowPath);
    for (const filename of Object.keys(require.cache)) {
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (!relative.startsWith("../") && !relative.startsWith("/") &&
          !relative.split("/").includes("node_modules")) { files.add(relative); loadedPaths.add(relative); }
    }
    const snapshots = [...files].sort().map(relative => {
      const measured = sourceFileSnapshot(root, relative);
      let blob;
      try { blob = git("cat-file", "blob", `${revision}:${relative}`); } catch (_) {
        sourceMeasurementFailure("harness-source-not-tracked-at-head");
      }
      const blobSha256 = "sha256:" + crypto.createHash("sha256").update(blob).digest("hex");
      if (measured.sha256 !== blobSha256 || measured.sizeBytes !== blob.length) {
        sourceMeasurementFailure("harness-source-does-not-match-head-blob");
      }
      const decoded = blob.toString("utf8");
      // Only the standard Node wrapper is an accepted transformation. BOM,
      // shebang, Playwright and source-map transforms are not silently undone.
      const commonJsSha256 = Buffer.from(decoded, "utf8").equals(blob)
        ? "sha256:" + crypto.createHash("sha256").update(
          `(function (exports, require, module, __filename, __dirname) { ${decoded}\n});`, "utf8").digest("hex")
        : null;
      return { path: relative, sha256: measured.sha256, sizeBytes: measured.sizeBytes, token: measured.token,
        loadedRequired: loadedPaths.has(relative), commonJsSha256,
        gitBlob: git("rev-parse", `${revision}:${relative}`).toString("utf8").trim() };
    });
    const loadedSource = await observeLoadedHarnessSource(root, snapshots);
    if (!clean() || git("rev-parse", "--verify", "HEAD").toString("utf8").trim() !== revision) {
      sourceMeasurementFailure("checkout-changed-during-source-measurement");
    }
    return { status: "captured", root, sourceRevision: revision, files: snapshots, loadedSource };
  } catch (error) {
    return { status: "missing", missingReason: error.observationReason || "git-or-source-measurement-unavailable" };
  }
}

async function finalizeExecutingSource(snapshot, { env = process.env } = {}) {
  const missing = reason => ({ schemaVersion: 1, kind: "executing-harness-source",
    authenticated: false, status: "missing", sourceRevision: null, files: [],
    loadedSourceBefore: snapshot?.loadedSource ?? null, loadedSource: null,
    producerRun: null, producerRunMissingReason: reason });
  if (snapshot?.status !== "captured") return missing(snapshot?.missingReason || "executing-source-baseline-unavailable");
  const completed = await captureExecutingSource({ root: snapshot.root,
    additionalFiles: snapshot.files.map(file => file.path), env });
  if (completed.status !== "captured") return missing(completed.missingReason);
  if (completed.sourceRevision !== snapshot.sourceRevision || completed.files.length !== snapshot.files.length ||
      completed.files.some((file, index) => {
        const before = snapshot.files[index];
        return file.path !== before.path || file.sha256 !== before.sha256 || file.token !== before.token || file.gitBlob !== before.gitBlob;
      })) return missing("executing-source-changed-during-build");
  const receipt = { schemaVersion: 1, kind: "executing-harness-source", authenticated: false,
    status: "measured", sourceRevision: completed.sourceRevision,
    files: completed.files.map(({ path, sha256, sizeBytes, gitBlob }) => ({ path, sha256, sizeBytes, gitBlob })),
    loadedSourceBefore: snapshot.loadedSource, loadedSource: completed.loadedSource,
    producerRun: null, producerRunMissingReason: null };
  const context = producerEnvironment(env);
  const workflowPath = githubWorkflowPath(env);
  if (!workflowPath || context.runId === null || context.runAttempt === null) {
    receipt.producerRunMissingReason = "github-run-or-workflow-context-invalid";
  } else if (env.GITHUB_SHA !== receipt.sourceRevision || env.GITHUB_WORKFLOW_SHA !== receipt.sourceRevision) {
    receipt.producerRunMissingReason = "github-source-or-workflow-revision-does-not-match-measured-checkout";
  } else if (!receipt.files.some(file => file.path === workflowPath)) {
    receipt.producerRunMissingReason = "executing-workflow-source-not-measured";
  } else if (snapshot.loadedSource.status !== "matched" || completed.loadedSource.status !== "matched") {
    receipt.producerRunMissingReason = "loaded-harness-source-not-bound-to-head";
  } else if (JSON.stringify(snapshot.loadedSource.files) !== JSON.stringify(completed.loadedSource.files)) {
    receipt.producerRunMissingReason = "loaded-harness-source-changed-during-build";
  } else {
    receipt.producerRun = { repository: env.GITHUB_REPOSITORY, workflowPath,
      workflowRevision: receipt.sourceRevision, sourceRevision: receipt.sourceRevision,
      harnessRevision: receipt.sourceRevision, runId: context.runId, runAttempt: context.runAttempt };
  }
  return receipt;
}

function browserObservedInputRecord({ iso, wasm, browser, buildResult, identity, inputs, frontend, executingSource = null, env = process.env }) {
  const result = buildResult === null ? null : validateBuildResult(buildResult, iso.sizeBytes);
  if (!identity || !Number.isSafeInteger(identity.operationId) || !Number.isSafeInteger(identity.attempt) ||
      inputs?.operation?.operationId !== identity.operationId || inputs?.operation?.attempt !== identity.attempt) {
    throw new Error("browser build operation changed during input measurement");
  }
  const selection = `${identity.operationId}:${identity.attempt}`;
  const observed = { selection_id: selection, completed_selection_id: selection, build_status: "completed",
    bytes_written: iso.sizeBytes, browser: { product: "chromium", version: browser.product.split("/")[1] } };
  const missingReasons = {
    source_manifest: "Independent origin mapping and CPU baseline are unavailable; verified config content is retained separately when observed.",
    overlay: "No applied overlay observation has a matched base digest equal to the observed source manifest.",
    deployed_frontend: "No measured Flatpak deployment is matched to its measured source stamp.",
    loaded_engine: "Clean attributable WASM engine build info and a unique measured runtime shim are required.",
    recipe_sha256: "The canonical recipe hash domain is undefined; a shipped file hash does not prove runtime consumption.",
    config_sha256: "The canonical build-config hash domain is undefined; OCI config and frontend config bytes are distinct.",
    producer_run: executingSource?.producerRunMissingReason || "Measured executing harness source and matching CI context are unavailable.",
  };
  if (executingSource?.status === "measured" && executingSource.producerRun) {
    observed.producer_run = { ...executingSource.producerRun };
    delete missingReasons.producer_run;
  }
  let buildRequest = null;
  if (typeof inputs.requestJson === "string" && inputs.requestJson) {
    const bytes = Buffer.from(inputs.requestJson, "utf8");
    buildRequest = { sha256: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length, encoding: "utf-8",
      source: "engine-call JSON.stringify return value" };
    observed.build_request_sha256 = buildRequest.sha256;
  } else missingReasons.build_request_sha256 = inputs.requestError || "Engine-consumed request bytes were not observed.";
  const resources = [];
  const memoryBytes = inputs.deviceMemory * 1024 ** 3;
  if (typeof inputs.deviceMemory === "number" && Number.isFinite(memoryBytes) && memoryBytes > 0) {
    resources.push({ subject: "browser", quantity: "memoryCapacity", unit: "bytes", method: "reported",
      value: memoryBytes, source: "navigator.deviceMemory" });
  }
  const available = inputs.storage?.quota - inputs.storage?.usage;
  if (typeof inputs.storage?.quota === "number" && typeof inputs.storage?.usage === "number" && Number.isFinite(available) && available > 0) {
    resources.push({ subject: "browser", quantity: "availableStorage", unit: "bytes", method: "estimated",
      value: available, source: "navigator.storage.estimate" });
  }
  if (typeof inputs.elapsedMs === "number" && Number.isFinite(inputs.elapsedMs) && inputs.elapsedMs > 0) {
    resources.push({ subject: "browser", quantity: "elapsedDuration", unit: "seconds", method: "measured",
      value: inputs.elapsedMs / 1000, source: "performance.now" });
  }
  if (resources.length === 3) observed.resources = resources;
  else missingReasons.resources = "Browser memory, available storage and measured elapsed duration were not all available.";
  const unique = filename => {
    const matches = frontend.files.filter(file => file.path === `/${filename}`);
    return matches.length === 1 ? matches[0] : null;
  };
  const runtimeShim = unique("wasm_exec.js");
  const config = unique("builder-config-data.js");
  const overlay = result?.observedInputs.overlay;
  if (overlay?.status === "applied" && overlay.layersApplied && overlay.baseAnnotationMatched &&
      overlay.baseDigest === result.observedInputs.source.manifestDigest) {
    observed.overlay = { kind: "oci-platform-manifest", digest: overlay.manifestDigest, baseDigest: overlay.baseDigest };
    delete missingReasons.overlay;
  }
  const installer = result?.observedInputs.installer ?? null;
  if (installer?.deployment?.sourceStampMatched && !installer.missingReason) {
    const deployed = installer.deployment;
    observed.deployed_frontend = { kind: "flatpak-commit", appId: deployed.appId, ref: deployed.ref,
      arch: deployed.arch, deployedCommit: deployed.deployedCommit };
    // bundleSha256Claim is deliberately not promoted to measured bundle bytes.
    delete missingReasons.deployed_frontend;
  }
  const engine = result?.observedInputs.engine ?? null;
  if (engine?.package === "github.com/tuna-os/tacklebox/cmd/tbwasm" &&
      engine.vcsRevision && engine.vcsModified === "false" && runtimeShim &&
      /^sha256:[0-9a-f]{64}$/.test(wasm.sha256) && /^sha256:[0-9a-f]{64}$/.test(runtimeShim.sha256)) {
    observed.loaded_engine = { kind: "wasm-module", sha256: wasm.sha256,
      sourceRevision: engine.vcsRevision, runtimeShimSha256: runtimeShim.sha256 };
    delete missingReasons.loaded_engine;
  } else if (engine?.vcsModified === "true") {
    missingReasons.loaded_engine = "Engine build info reports a dirty source tree; its VCS revision cannot identify the module source.";
  }
  const unavailableMeasurements = {
    sourceReference: "Engine resolve coordinates require independent origin-policy mapping; a transport endpoint may be a proxy.",
    sourceCpuBaseline: "Verified OCI config architecture does not measure CPU baseline.",
    ...(!result?.observedInputs.source.config.content?.os || !result?.observedInputs.source.config.content?.architecture
      ? { sourceOsAndArchitecture: "Consumed verified config OS/architecture were not both observed." } : {}),
    ...(!observed.deployed_frontend ? { deployedInstallerCommit: missingReasons.deployed_frontend } : {}),
    installerBundleBytes: "A source-stamp bundle hash is only a claim, not measured bundle bytes.",
    ...(!observed.loaded_engine ? { engineSourceRevision: missingReasons.loaded_engine } : {}),
    recipeHashDomain: missingReasons.recipe_sha256,
    configHashDomain: missingReasons.config_sha256,
    ...(executingSource?.status !== "measured" || executingSource?.loadedSourceBefore?.status !== "matched" ||
        executingSource?.loadedSource?.status !== "matched" ||
        executingSource?.producerRunMissingReason === "loaded-harness-source-changed-during-build"
      ? { executingHarnessRevision: executingSource?.producerRunMissingReason || "Actual loaded source bytes were not bound to HEAD." } : {}),
    ...(!result ? { sourceAndOverlay: "No operation-local engine result API observations are available." } : {}),
    ...(!runtimeShim ? { runtimeShimBytes: "Exactly one successful loaded wasm_exec.js response was not observed." } : {}),
    ...(!config ? { frontendConfigScriptBytes: "Exactly one successful loaded builder-config-data.js response was not observed." } : {}),
    ...(!buildRequest ? { buildRequestBytes: missingReasons.build_request_sha256 } : {}),
  };
  return {
    schemaVersion: 1, kind: "browser-observed-input", qualification: "not-assessed",
    observed, missingFields: Object.keys(missingReasons).sort(), media: { sha256: iso.sha256, sizeBytes: iso.sizeBytes },
    measurements: {
      operation: { ...identity }, source: result?.observedInputs.source ?? null, overlay: result?.observedInputs.overlay ?? null,
      loadedWasm: { sha256: wasm.sha256, sizeBytes: wasm.sizeBytes },
      frontendFiles: frontend.files, frontendFailures: frontend.failures,
      runtimeShim, config, installer, engine,
      shippedRecipe: installer?.shippedRecipe ?? null,
      buildRequest, producerEnvironment: producerEnvironment(env), executingSource, resources, missingReasons, unavailableMeasurements,
    },
  };
}

function diagnosticRecord({ iso, wasm, browser, phasesMs, buildResult = null, diagnostic = null }) {
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
  if (diagnostic !== null && (typeof diagnostic?.image !== "string" || !diagnostic.image || typeof diagnostic.gateReason !== "string" || !diagnostic.gateReason)) {
    throw new Error("invalid diagnostic label");
  }
  return {
    schemaVersion: 1, kind: "diagnostic-build-measurements",
    qualification: diagnostic ? "diagnostic-unqualified" : "not-assessed",
    ...(diagnostic ? { diagnosticUnqualified: {
      label: "diagnostic, unqualified build", image: diagnostic.image,
      platform: diagnostic.platform ?? null, gateReason: diagnostic.gateReason,
      ...(diagnostic.catalogPins ? { catalogPins: diagnostic.catalogPins } : {}),
    } } : {}),
    iso: { sha256: iso.sha256, sizeBytes: iso.sizeBytes },
    loadedWasm: { sha256: wasm.sha256, sizeBytes: wasm.sizeBytes },
    engineBuildResult: buildResult === null ? null : validateBuildResult(buildResult, iso.sizeBytes),
    missingIdentity: ["producer", "frontend"],
    browser: { product: browser.product, userAgent: browser.userAgent },
    phasesMs: { inspect: phasesMs.inspect, build: phasesMs.build, save: phasesMs.save },
    timingNote: "Existing stage durations exclude navigation and include observer overhead where it overlaps; no performance qualification.",
  };
}

// Registry transfers as the browser itself saw them (page and worker fetches,
// via the context's network events). A blob is named by its registry URL
// `/v2/<repo>/blobs/<digest>`; redirects are followed back to that URL so a
// CDN hop is still attributed. Layer-cache hits are synthetic Responses and
// never appear here.
const BLOB_URL = /\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})(?:[?#]|$)/;
const MANIFEST_URL = /\/v2\/(.+)\/manifests\/([^/?#]+)(?:[?#]|$)/;

function registryOrigin(request, pattern) {
  for (let r = request; r; r = r.redirectedFrom()) {
    const m = pattern.exec(r.url());
    if (m) return { repository: m[1], ref: m[2] };
  }
  return null;
}

// A complete blob transfer is a finished GET answered 200 without a Range
// header; HEAD, redirect hops, 206 resumes and failed streams are not.
// Config blobs (named by an observed manifest) are not layers. Any other
// complete blob counts as a layer, so a missed manifest errs strict.
function summarizeRegistryTransfers(transfers, configDigests, inFlight = 0) {
  const complete = (t) => t.method === "GET" && t.status === 200 && !t.range && !t.failure &&
    Number.isSafeInteger(t.bytes) && t.bytes > 0;
  const layers = transfers.filter((t) => complete(t) && !configDigests.has(t.digest));
  const sum = (list) => list.reduce((n, t) => n + (Number.isSafeInteger(t.bytes) && t.bytes > 0 ? t.bytes : 0), 0);
  return {
    blobRequests: transfers.length,
    blobBytes: sum(transfers),
    completeLayerBlobs: layers.length,
    completeLayerBytes: sum(layers),
    completeConfigBlobs: transfers.filter((t) => complete(t) && configDigests.has(t.digest)).length,
    rangeRequests: transfers.filter((t) => t.range || t.status === 206).length,
    rangeBytes: sum(transfers.filter((t) => t.range || t.status === 206)),
    configBytes: sum(transfers.filter((t) => configDigests.has(t.digest))),
    unknownSizeRequests: transfers.filter((t) => !Number.isSafeInteger(t.bytes) || t.bytes < 0).length,
    incompleteBlobRequests: transfers.filter((t) => !complete(t)).length,
    inFlightBlobRequests: inFlight,
    completeLayers: layers.map((t) => ({ repository: t.repository, digest: t.digest, bytes: t.bytes })),
    transfers,
    bytesNote: "Encoded response body bytes from the browser's own network observation (Playwright request.sizes()).",
  };
}

function observeRegistryTransfers(context) {
  const transfers = [];
  const manifests = [];
  const configDigests = new Set();
  const started = new Set();
  const pending = new Set();
  const errors = [];
  let manifestBytesRead = 0;
  const observerStartedAt = performance.now();
  let networkRequestsSeen = 0;
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); };
  const record = async (request, failed) => {
    const origin = registryOrigin(request, BLOB_URL);
    if (!origin) return;
    started.delete(request);
    const response = failed ? null : await request.response().catch(() => null);
    const sizes = await request.sizes().catch(() => null);
    transfers.push({
      repository: origin.repository, digest: origin.ref, method: request.method(),
      status: response ? response.status() : null,
      range: (await request.headerValue("range").catch(() => null)) || null,
      redirected: Boolean(request.redirectedFrom()),
      bytes: sizes ? sizes.responseBodySize : null,
      failure: failed ? (request.failure()?.errorText || "failed") : null,
    });
  };
  const onRequest = (request) => {
    networkRequestsSeen++;
    // A redirect hop may finish without its own event; its successor carries on.
    started.delete(request.redirectedFrom());
    if (registryOrigin(request, BLOB_URL)) started.add(request);
  };
  const onFinished = (request) => track(record(request, false));
  const onFailed = (request) => track(record(request, true));
  const onResponse = (response) => {
    const request = response.request();
    const origin = registryOrigin(request, MANIFEST_URL);
    if (!origin || request.method() !== "GET" || response.status() !== 200) return;
    track((async () => {
      const body = await response.body();
      manifestBytesRead += body.length;
      const manifest = JSON.parse(body.toString("utf8"));
      if (/^sha256:[0-9a-f]{64}$/.test(manifest?.config?.digest || "")) configDigests.add(manifest.config.digest);
      const sizes = await request.sizes();
      manifests.push({
        repository: origin.repository, ref: origin.ref, mediaType: manifest?.mediaType ?? null,
        digest: "sha256:" + crypto.createHash("sha256").update(body).digest("hex"),
        bytes: sizes.responseBodySize,
      });
    })().catch((error) => errors.push(String(error))));
  };
  context.on("request", onRequest);
  context.on("requestfinished", onFinished);
  context.on("requestfailed", onFailed);
  context.on("response", onResponse);
  const snapshot = () => ({
    ...summarizeRegistryTransfers([...transfers], configDigests, started.size), manifests: [...manifests],
    metadataRequests: manifests.length, metadataBytes: manifests.reduce((n, m) => n + m.bytes, 0),
    observer: { method: "Playwright context network events; request.sizes; manifest bodies only",
      blobBodyBytesRead: 0, manifestBytesRead, errors: [...errors], pendingObservations: pending.size, networkRequestsSeen,
      elapsedMs: performance.now() - observerStartedAt,
      overhead: "Not isolated: elapsedMs includes the build. Validate observer on/off separately; no performance qualification." },
  });
  return {
    snapshot,
    async summary() {
      while (pending.size) await Promise.allSettled([...pending]);
      return snapshot();
    },
    stop() {
      context.off("request", onRequest);
      context.off("requestfinished", onFinished);
      context.off("requestfailed", onFailed);
      context.off("response", onResponse);
    },
  };
}

module.exports = {
  observeLoadedWasm, loadedWasmMeasurement, hashSavedIso, buildOperationIdentity, completedBuildResult, diagnosticRecord,
  observeRegistryTransfers, summarizeRegistryTransfers, observeConsumedBuildInputs, completedInputMeasurements,
  observeFrontendResponses, producerEnvironment, browserObservedInputRecord, captureExecutingSource, finalizeExecutingSource,
};
