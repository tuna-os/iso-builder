// Executes the real app inspect() with a mocked engine. This does not launch a
// browser, run WASM, fetch an OCI layer, or prove engine pin verification.
const { test } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../app/public/app.js"), "utf8");
const start = source.indexOf("async function inspect() {");
const end = source.indexOf("async function isoSink(", start);
assert.ok(start >= 0 && end > start, "actual inspect() must exist");
const inspectSource = source.slice(start, end);

function app(platform, engine) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === "image" ? "registry.invalid/team/image:v1" : "",
      disabled: false, textContent: "",
      classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  const request = Object.freeze({
    schemaVersion: 1, kind: "build-request", customImage: true,
    image: "team/image:v1", registry: "https://registry.invalid/proxy",
    resolvedInputs: Object.freeze({ platformManifestDigest: `sha256:${"a".repeat(64)}` }),
    options: Object.freeze({ label: "TEST", outputFilename: "test.iso" }),
  });
  const op = { id: 1, state: "inspecting", ready: false, platform, request };
  const trace = { calls: [], busy: [], watchesStopped: 0, released: 0 };
  const context = {
    console, navigator: {}, $: element, selectedDdi: null, facts: null,
    wasmNativeIntrospect: null, tboxCurrentOperation: op,
    isOperationBusy: () => false,
    updateShim() {}, askNotify() {}, parseCuratedTunaRef: () => null,
    rebuildCurrentOperation: () => op,
    setOperationBusy: value => trace.busy.push(value),
    checkStorageQuota: async () => ({ blocked: false }),
    loadWasm: async () => {},
    watchEngineMemory: () => () => { trace.watchesStopped++; },
    parseImage: raw => {
      assert.equal(raw, "registry.invalid/team/image:v1");
      return { image: "team/image:v1", registry: "https://registry.invalid/proxy" };
    },
    renderFactsBadges() {}, applyDetectedDesktopAndPackaging() {},
    syncOperationOptions() {}, renderFallbackCard() {}, updateShare() {},
    log() {}, notify() {}, showCacheSize() {},
    tboxLayerCache: { acquireBuildLease: () => () => { trace.released++; } },
    tboxIntrospect: async (...args) => {
      trace.calls.push(args);
      return engine ? engine(args, op) : JSON.stringify({ desktop: "gnome" });
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(inspectSource, context);
  return { context, op, request, trace, element };
}

for (const platform of ["linux/amd64", "linux/amd64/v2", "linux/arm64"]) {
  test(`inspect uses one object argument and keeps explicit ${platform}`, async () => {
    const a = app(platform);
    await a.context.inspect();
    assert.equal(a.trace.calls.length, 1);
    assert.equal(a.trace.calls[0].length, 1);
    const argument = a.trace.calls[0][0];
    assert.equal(Object.isFrozen(argument), true);
    assert.deepEqual(Object.keys(argument).sort(), ["image", "platform", "registry", "request"]);
    assert.equal(argument.image, a.request.image);
    assert.equal(argument.registry, a.request.registry);
    assert.equal(argument.platform, platform);
    assert.equal(argument.request, JSON.stringify(a.request));
    assert.deepEqual(JSON.parse(argument.request), a.request);
    assert.equal(a.op.ready, true);
    assert.equal(a.op.inspectedVia, "wasm");
    assert.deepEqual(a.trace.busy, [true, false]);
    assert.equal(a.trace.watchesStopped, 1);
    assert.equal(a.trace.released, 1);
  });
}

test("request bytes stay fixed if the operation request is replaced during the call", async () => {
  let captured;
  const a = app("linux/arm64", async (args, op) => {
    captured = args[0].request;
    op.request = { ...op.request, options: { label: "CHANGED" } };
    await Promise.resolve();
    assert.equal(args[0].request, captured);
    return JSON.stringify({ desktop: "gnome" });
  });
  await a.context.inspect();
  assert.equal(captured, JSON.stringify(a.request));
  assert.notEqual(captured, JSON.stringify(a.op.request));
});

test("a mocked engine pin rejection leaves inspection failed and build disabled", async () => {
  const a = app("linux/amd64", async args => {
    const request = JSON.parse(args[0].request);
    assert.equal(request.resolvedInputs.platformManifestDigest, `sha256:${"a".repeat(64)}`);
    throw new Error("build request platformManifestDigest mismatch");
  });
  await a.context.inspect();
  assert.equal(a.op.state, "failed");
  assert.equal(a.op.ready, false);
  assert.match(a.op.error, /platformManifestDigest mismatch/);
  assert.equal(a.element("build").disabled, true);
  assert.equal(a.context.facts, null);
  assert.equal(a.trace.released, 1);
});
