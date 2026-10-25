// The @full spec may build a catalog-unqualified target only through an
// explicit, named, test-only grant. These tests run the real app and the real
// spec helpers; none of them builds an ISO.

const { test, expect } = require("./fixtures");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { diagnosticRecord } = require("./build-measurements");
const {
  diagnosticGrantFromEnv, installDiagnosticGrant, resolveLiveDigests, catalogEntryFor, refreshDiagnosticSnapshot, parseGateRefusal, gateRefusalMessage, gateRefusalSummary,
} = require("./diagnostic-gate");

const ROOT = path.resolve(__dirname, "../..");
const IMAGE = "tuna-os/skipjack:gnome";
const PLATFORM = "linux/amd64";
const PRESET = "/?variant=skipjack&flavor=gnome&platform=linux%2Famd64";

async function inspectPreset(page) {
  await page.getByText("Use a custom container image").click();
  await page.locator("#introspect").click();
}

const grant = (over = {}) => ({ kind: "diagnostic-unqualified", image: IMAGE, platform: PLATFORM, ...over });
async function withGrant(page, g) { await page.addInitScript(installDiagnosticGrant, g); }

test.describe("catalog gate with the diagnostic grant", () => {
  test("without a grant the gate still refuses an unqualified target", async ({ page }) => {
    await page.goto(PRESET);
    await inspectPreset(page);
    await expect(page.locator(".badge.status")).toContainText("unqualified");
    await expect(page.locator(".badge.status")).not.toContainText("diagnostic");
    await expect(page.locator("#build")).toBeDisabled();
    await expect(page.locator("#stage")).toContainText("Browser build unavailable");
    await expect(page.locator("#fallbackcard")).toBeVisible();
    const request = JSON.parse(await page.locator("#fallbackjson").textContent());
    expect(request.qualificationId).toBeUndefined();
  });

  test("the grant for the named image and platform unlocks only a labelled diagnostic build", async ({ page }) => {
    await withGrant(page, grant());
    await page.goto(PRESET);
    await inspectPreset(page);
    await expect(page.locator("#build")).toBeEnabled();
    const badge = page.locator(".badge.status");
    await expect(badge).toContainText("diagnostic-unqualified");
    await expect(badge).toContainText("incomplete-qualification-provenance");
    await expect(page.locator("#stage")).toContainText("diagnostic, unqualified build");
    await expect(page.locator("#log")).toContainText("DIAGNOSTIC, UNQUALIFIED BUILD");
    // Never reported as the qualified state.
    await expect(page.locator("#stage")).not.toContainText(/^Image inspected — ready to build\.$/);
  });

  for (const [name, g] of [
    ["another image", grant({ image: "tuna-os/yellowfin:gnome" })],
    ["the same image on another platform", grant({ platform: "linux/arm64" })],
    ["a different kind", grant({ kind: "qualified" })],
    ["an empty image", grant({ image: "" })],
  ]) {
    test(`a grant naming ${name} does not unlock the target`, async ({ page }) => {
      await withGrant(page, g);
      await page.goto(PRESET);
      await inspectPreset(page);
      await expect(page.locator("#build")).toBeDisabled();
      await expect(page.locator(".badge.status")).not.toContainText("diagnostic");
      await expect(page.locator("#stage")).toContainText("Browser build unavailable");
    });
  }

  test("URL parameters, storage and look-alike globals cannot unlock the gate", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("__TBOX_DIAGNOSTIC_UNQUALIFIED__", JSON.stringify({ kind: "diagnostic-unqualified", image: "tuna-os/skipjack:gnome" }));
      sessionStorage.setItem("DIAGNOSTIC_ALLOW_UNQUALIFIED", "1");
      globalThis.DIAGNOSTIC_ALLOW_UNQUALIFIED = "1";
      globalThis.DIAGNOSTIC_TARGET = "tuna-os/skipjack:gnome";
      globalThis.__TBOX_E2E__ = true;
    });
    await page.goto(`${PRESET}&diagnosticUnqualified=1&DIAGNOSTIC_ALLOW_UNQUALIFIED=1&DIAGNOSTIC_TARGET=${encodeURIComponent(IMAGE)}`);
    await inspectPreset(page);
    await expect(page.locator("#build")).toBeDisabled();
    await expect(page.locator(".badge.status")).not.toContainText("diagnostic");
  });

  test("the grant is a frozen, non-writable page global", async ({ page }) => {
    await withGrant(page, grant());
    await page.goto(PRESET);
    const result = await page.evaluate(() => {
      const d = Object.getOwnPropertyDescriptor(globalThis, "__TBOX_DIAGNOSTIC_UNQUALIFIED__");
      return { writable: d.writable, configurable: d.configurable, frozen: Object.isFrozen(d.value) };
    });
    expect(result).toEqual({ writable: false, configurable: false, frozen: true });
  });

  test("the refused-stage text parses to the gate reason the job summary reports", async ({ page }) => {
    await page.goto(PRESET);
    await inspectPreset(page);
    // Inspection is asynchronous: wait for the refusal before reading the stage.
    await expect(page.locator("#stage")).toContainText("Browser build unavailable");
    const stage = await page.locator("#stage").textContent();
    const reason = parseGateRefusal(stage);
    expect(reason).toBe("unqualified (incomplete-qualification-provenance)");
    const info = { image: IMAGE, platform: PLATFORM, reason, diagnosticRequested: false };
    expect(gateRefusalSummary(info)).toContain("incomplete-qualification-provenance");
    expect(gateRefusalMessage(info)).toContain("diagnostic override was NOT requested");
    expect(gateRefusalMessage({ ...info, diagnosticRequested: true })).toContain("requested but the app still refused");
    expect(parseGateRefusal("Image inspected — ready to build.")).toBeNull();
  });
});

test.describe("spec-side grant resolution", () => {
  const base = { TBOX_E2E_FULL: "1" };
  const want = { image: IMAGE, platform: PLATFORM };

  test("is off unless explicitly requested", () => {
    expect(diagnosticGrantFromEnv({ ...base }, want)).toBeNull();
    expect(diagnosticGrantFromEnv({ ...base, DIAGNOSTIC_TARGET: IMAGE }, want)).toBeNull();
    expect(diagnosticGrantFromEnv({ ...base, DIAGNOSTIC_ALLOW_UNQUALIFIED: "" }, want)).toBeNull();
  });

  test("grants exactly the named image and platform", () => {
    expect(diagnosticGrantFromEnv({ ...base, DIAGNOSTIC_ALLOW_UNQUALIFIED: "1", DIAGNOSTIC_TARGET: IMAGE }, want))
      .toEqual({ kind: "diagnostic-unqualified", image: IMAGE, platform: PLATFORM });
  });

  for (const [name, env] of [
    ["an unnamed target", { DIAGNOSTIC_ALLOW_UNQUALIFIED: "1" }],
    ["a different named target", { DIAGNOSTIC_ALLOW_UNQUALIFIED: "1", DIAGNOSTIC_TARGET: "tuna-os/yellowfin:gnome" }],
    ["a truthy non-1 value", { DIAGNOSTIC_ALLOW_UNQUALIFIED: "true", DIAGNOSTIC_TARGET: IMAGE }],
    ["a non-@full run", { DIAGNOSTIC_ALLOW_UNQUALIFIED: "1", DIAGNOSTIC_TARGET: IMAGE, TBOX_E2E_FULL: "" }],
  ]) {
    test(`refuses ${name}`, () => {
      expect(() => diagnosticGrantFromEnv({ ...base, ...env }, want)).toThrow(/DIAGNOSTIC/);
    });
  }
});

test.describe("diagnostic pin refresh", () => {
  const CATALOG = require("../../app/public/catalog-snapshot.json");
  const h = (c) => `sha256:${c.repeat(64)}`;
  // Fake registry transport: same wire protocol as GHCR, no network.
  function fakeRegistry({ perPlatform = 1, bad = null } = {}) {
    const index = { manifests: [
      { digest: h("a"), platform: { os: "linux", architecture: "amd64" } },
      { digest: h("b"), platform: { os: "linux", architecture: "amd64/v2" } },
      ...Array.from({ length: perPlatform - 1 }, () => ({ digest: h("e"), platform: { os: "linux", architecture: "amd64" } })),
    ] };
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push(url);
      const json = (body, digest) => ({ ok: true, status: 200, json: async () => body, headers: { get: (k) => (k.toLowerCase() === "docker-content-digest" ? digest : null) } });
      if (url.startsWith("https://ghcr.io/token")) return json({ token: "t" });
      expect(init.headers.Authorization).toBe("Bearer t");
      if (url.endsWith("/manifests/gnome")) return json(index, bad ?? h("1"));
      if (url.endsWith(`/manifests/${h("a")}`)) return json({ config: { digest: h("c") } }, h("a"));
      if (url.endsWith(`/manifests/${h("b")}`)) return json({ config: { digest: h("d") } }, h("b"));
      return { ok: false, status: 404 };
    };
    return { fetchImpl, calls };
  }

  test("resolves index, platform manifest and config digests for the exact platform", async () => {
    const { fetchImpl, calls } = fakeRegistry();
    const args = { repository: "ghcr.io/tuna-os/skipjack", tag: "gnome", fetchImpl };
    expect(await resolveLiveDigests({ ...args, platform: "linux/amd64" }))
      .toEqual({ indexDigest: h("1"), platformManifestDigest: h("a"), configDigest: h("c") });
    expect(await resolveLiveDigests({ ...args, platform: "linux/amd64/v2" }))
      .toEqual({ indexDigest: h("1"), platformManifestDigest: h("b"), configDigest: h("d") });
    expect(calls[0]).toContain("scope=repository:tuna-os/skipjack:pull");
  });

  test("refuses ambiguous, missing or malformed registry answers", async () => {
    const base = { repository: "ghcr.io/tuna-os/skipjack", tag: "gnome", platform: "linux/amd64" };
    await expect(resolveLiveDigests({ ...base, fetchImpl: fakeRegistry({ perPlatform: 2 }).fetchImpl })).rejects.toThrow(/exactly one/);
    await expect(resolveLiveDigests({ ...base, platform: "linux/arm64", fetchImpl: fakeRegistry().fetchImpl })).rejects.toThrow(/exactly one/);
    await expect(resolveLiveDigests({ ...base, fetchImpl: fakeRegistry({ bad: "nope" }).fetchImpl })).rejects.toThrow(/malformed digest/);
    await expect(resolveLiveDigests({ ...base, repository: "docker.io/x/y", fetchImpl: fakeRegistry().fetchImpl })).rejects.toThrow(/cannot resolve/);
  });

  test("replaces only the named target's three pins and never touches qualification", () => {
    const entry = catalogEntryFor(CATALOG, "tuna-os/skipjack:gnome", "linux/amd64");
    expect(entry.targetKey).toBe("skipjack:gnome:linux/amd64");
    const live = { indexDigest: h("1"), platformManifestDigest: h("a"), configDigest: h("c") };
    const { doc, record } = refreshDiagnosticSnapshot(CATALOG, entry.targetKey, live);
    const after = doc.targets.find((t) => t.targetKey === entry.targetKey);
    expect(after.resolvedInputs).toMatchObject(live);
    expect(after.qualification).toEqual(entry.qualification);
    expect(record.before.platformManifestDigest).toBe(entry.resolvedInputs.platformManifestDigest);
    expect(record.after).toEqual(live);
    // Every other target and the input document are untouched.
    expect(entry.resolvedInputs.platformManifestDigest).not.toBe(live.platformManifestDigest);
    for (const t of doc.targets.filter((x) => x.targetKey !== entry.targetKey)) {
      expect(t).toEqual(CATALOG.targets.find((x) => x.targetKey === t.targetKey));
    }
    expect(() => refreshDiagnosticSnapshot(CATALOG, "nope:gnome:linux/amd64", live)).toThrow(/no catalog target/);
  });

  test("a refreshed pin reaches the build request while the target stays gated by the app", async ({ page }) => {
    const entry = catalogEntryFor(CATALOG, IMAGE, PLATFORM);
    const live = { indexDigest: h("1"), platformManifestDigest: h("a"), configDigest: h("c") };
    const { doc } = refreshDiagnosticSnapshot(CATALOG, entry.targetKey, live);
    await page.route("**/catalog-snapshot.json", (route) => route.fulfill({ json: doc }));
    await page.goto(PRESET);
    await inspectPreset(page);
    await expect(page.locator("#stage")).toContainText("Browser build unavailable");
    await expect(page.locator("#build")).toBeDisabled();  // no grant: still refused
    await expect(page.locator("#fallbackcard")).toBeVisible();
    const request = JSON.parse(await page.locator("#fallbackjson").textContent());
    expect(request.resolvedInputs).toMatchObject(live);
    expect(request.qualificationId).toBeUndefined();
  });
});

test.describe("evidence labelling", () => {
  const input = () => ({
    iso: { sha256: `sha256:${"a".repeat(64)}`, sizeBytes: 32 },
    wasm: { sha256: `sha256:${"b".repeat(64)}`, sizeBytes: 8 },
    browser: { product: "HeadlessChrome/140.0.1.2", userAgent: "fixture" },
    phasesMs: { inspect: 1, build: 2, save: 3 },
  });

  test("a diagnostic build record says diagnostic-unqualified and names the gate reason", () => {
    const rec = diagnosticRecord({ ...input(), diagnostic: { image: IMAGE, platform: PLATFORM, gateReason: "unqualified (incomplete-qualification-provenance)" } });
    expect(rec.qualification).toBe("diagnostic-unqualified");
    expect(rec.diagnosticUnqualified).toEqual({
      label: "diagnostic, unqualified build", image: IMAGE, platform: PLATFORM,
      gateReason: "unqualified (incomplete-qualification-provenance)",
    });
    const pins = { targetKey: "skipjack:gnome:linux/amd64", before: {}, after: {} };
    expect(diagnosticRecord({ ...input(), diagnostic: { image: IMAGE, gateReason: "x", catalogPins: pins } }).diagnosticUnqualified.catalogPins).toEqual(pins);
  });

  test("a record without a diagnostic grant is unchanged", () => {
    const rec = diagnosticRecord(input());
    expect(rec.qualification).toBe("not-assessed");
    expect(rec.diagnosticUnqualified).toBeUndefined();
  });

  test("a diagnostic label without image or reason is rejected", () => {
    expect(() => diagnosticRecord({ ...input(), diagnostic: { image: IMAGE } })).toThrow(/diagnostic label/);
    expect(() => diagnosticRecord({ ...input(), diagnostic: { gateReason: "x" } })).toThrow(/diagnostic label/);
  });

  test("the @full spec labels the browser evidence file and the app status it read", async () => {
    const src = fs.readFileSync(path.join(__dirname, "builder.spec.js"), "utf8");
    expect(src).toMatch(/qualification: "diagnostic-unqualified"/);
    expect(src).toMatch(/toContain\("diagnostic-unqualified"\)/);
    expect(src).toMatch(/buildResult, diagnostic,/);
  });
});

test.describe("production code and CI wiring", () => {
  test("the deployed app never reads the CI environment variables", () => {
    const app = path.join(ROOT, "app/public");
    for (const f of fs.readdirSync(app)) {
      if (!/\.(js|html|json)$/.test(f)) continue;
      const text = fs.readFileSync(path.join(app, f), "utf8");
      expect(text, f).not.toMatch(/DIAGNOSTIC_ALLOW_UNQUALIFIED|DIAGNOSTIC_TARGET|process\.env/);
    }
  });

  test("only the full-matrix build step can set the override, only for a named cell", () => {
    const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const lines = wf.split("\n");
    const hits = lines.map((l, i) => [l, i]).filter(([l]) => /DIAGNOSTIC_ALLOW_UNQUALIFIED:/.test(l));
    expect(hits).toHaveLength(1);
    const [line, idx] = hits[0];
    expect(line).toContain("diagnostic_unqualified");
    expect(line).toContain("inputs.only");
    // The nearest preceding step header is the @full build step.
    const header = lines.slice(0, idx).reverse().find((l) => /^      - name:/.test(l));
    expect(header).toContain("build ${{ matrix.edition.ref }}");
    expect(wf).toMatch(/DIAGNOSTIC_TARGET: \$\{\{ contains\(matrix\.edition\.ref/);
    // Input defaults off.
    expect(wf).toMatch(/diagnostic_unqualified:\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/);
  });

  test("a refused full-build cell fails within seconds with the gate reason, not after the 5 min stall watchdog", async () => {
    test.setTimeout(180_000);
    const env = { ...process.env, TBOX_E2E_FULL: "1", TBOX_E2E_IMAGE: IMAGE, TBOX_E2E_PLATFORM: PLATFORM };
    for (const k of ["DIAGNOSTIC_ALLOW_UNQUALIFIED", "DIAGNOSTIC_TARGET"]) delete env[k];
    const summary = path.join(require("os").tmpdir(), `gate-summary-${process.pid}.md`);
    fs.rmSync(summary, { force: true });
    env.GITHUB_STEP_SUMMARY = summary;
    const started = Date.now();
    const r = spawnSync("npx", ["playwright", "test", "--grep", "full build streams a bootable ISO", "--timeout=120000"], {
      cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 150_000,
    });
    const elapsed = (Date.now() - started) / 1000;
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).not.toBe(0);
    expect(out).toContain("browser build gated for tuna-os/skipjack:gnome");
    expect(out).toContain("incomplete-qualification-provenance");
    expect(out).toContain("diagnostic override was NOT requested");
    expect(out).not.toContain("wedged");
    expect(elapsed).toBeLessThan(100);
    const md = fs.readFileSync(summary, "utf8");
    expect(md).toContain("incomplete-qualification-provenance");
    fs.rmSync(summary, { force: true });
  });
});
