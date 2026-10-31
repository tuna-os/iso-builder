// Test-only helpers for building a catalog-unqualified target in @full.
//
// The production qualification gate (catalog.js catalogQualification) is never
// weakened. The app honours one JS global, installed by Playwright
// addInitScript, that names the exact image and platform of the operation
// (catalog.js diagnosticUnqualifiedGrant). Nothing the deployed site's normal path
// can reach (URL, storage, UI, environment) installs it. The result is labelled
// "diagnostic-unqualified" everywhere and is never a qualification.

const LABEL = "diagnostic, unqualified build";
const QUALIFICATION = "diagnostic-unqualified";

// Returns null unless DIAGNOSTIC_ALLOW_UNQUALIFIED=1. When requested, the
// target MUST be named (DIAGNOSTIC_TARGET) and equal the image being built, and
// the spec must be the @full spec; anything else is a loud error rather than a
// silent grant or a silent ignore.
function diagnosticGrantFromEnv(env, { image, platform }) {
  if (env.DIAGNOSTIC_ALLOW_UNQUALIFIED === undefined || env.DIAGNOSTIC_ALLOW_UNQUALIFIED === "") return null;
  if (env.DIAGNOSTIC_ALLOW_UNQUALIFIED !== "1") {
    throw new Error(`DIAGNOSTIC_ALLOW_UNQUALIFIED must be exactly "1" or unset, got ${JSON.stringify(env.DIAGNOSTIC_ALLOW_UNQUALIFIED)}`);
  }
  if (!env.TBOX_E2E_FULL) throw new Error("DIAGNOSTIC_ALLOW_UNQUALIFIED=1 is only valid for the @full spec (TBOX_E2E_FULL)");
  if (!env.DIAGNOSTIC_TARGET) throw new Error("DIAGNOSTIC_ALLOW_UNQUALIFIED=1 requires DIAGNOSTIC_TARGET naming the exact image to build");
  if (env.DIAGNOSTIC_TARGET !== image) {
    throw new Error(`DIAGNOSTIC_TARGET ${JSON.stringify(env.DIAGNOSTIC_TARGET)} does not name the image being built ${JSON.stringify(image)}; refusing to grant the override`);
  }
  return Object.freeze({
    kind: "diagnostic-unqualified",
    image,
    ...(platform ? { platform } : {}),
  });
}

// Init script body. The grant is passed as the single argument, so the page
// global exists only when the spec decided to grant it.
function installDiagnosticGrant(grant) {
  Object.defineProperty(globalThis, "__TBOX_DIAGNOSTIC_UNQUALIFIED__", {
    value: Object.freeze({ ...grant }), enumerable: false, configurable: false, writable: false,
  });
}

// The app's #stage text when the catalog gate refused the target.
const GATE_STAGE = /^Browser build unavailable: (.+?) — use local fallback below\.?$/;

function parseGateRefusal(stageText) {
  const m = GATE_STAGE.exec(String(stageText || "").trim());
  return m ? m[1] : null;
}

function gateRefusalMessage({ image, platform, reason, diagnosticRequested }) {
  return (
    `browser build gated for ${image}${platform ? ` (${platform})` : ""}: ${reason}.\n` +
    (diagnosticRequested
      ? "The diagnostic override was requested but the app still refused this target (storage or availability, not qualification)."
      : "The production qualification gate refuses this target and the diagnostic override was NOT requested. " +
        "To build it for diagnostics only, dispatch ci.yml with run_full=true, only=<slug> and diagnostic_unqualified=true; the result is labelled 'diagnostic-unqualified' and is never a qualification.")
  );
}

function gateRefusalSummary({ image, platform, reason, diagnosticRequested }) {
  return [
    "### Browser build refused by the qualification gate",
    "",
    `- target: \`${image}\`${platform ? ` (\`${platform}\`)` : ""}`,
    `- gate reason: \`${reason}\``,
    `- diagnostic override requested: ${diagnosticRequested ? "yes" : "no"}`,
    "- no ISO was built; nothing here is a qualification",
    "",
  ].join("\n");
}

// The committed catalog snapshot pins registry digests as of its generation
// date; the engine enforces those pins ("platformManifestDigest mismatch") and
// the first diagnostic dispatch died on exactly that (snapshot 2026-10-17 vs
// the republished tag). Dropping the pins would change the media shape (the
// offline layout ships only when pins exist), so a diagnostic build refreshes
// the three pins of the one named target to what the registry serves now and
// records old and new values in the evidence.
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function resolveLiveDigests({ repository, tag, platform, fetchImpl = fetch }) {
  const m = /^ghcr\.io\/(.+)$/.exec(repository || "");
  if (!m || !tag || !platform) throw new Error(`cannot resolve live digests for ${repository}:${tag} (${platform})`);
  const repo = m[1];
  const tokenRes = await fetchImpl(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`);
  if (!tokenRes.ok) throw new Error(`registry token request failed: ${tokenRes.status}`);
  const headers = { Authorization: `Bearer ${(await tokenRes.json()).token}`, Accept: ACCEPT };
  const get = async (ref) => {
    const r = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${ref}`, { headers });
    if (!r.ok) throw new Error(`manifest ${ref} request failed: ${r.status}`);
    return { digest: r.headers.get("docker-content-digest"), body: await r.json() };
  };
  const index = await get(tag);
  if (!Array.isArray(index.body.manifests)) throw new Error(`${repository}:${tag} is not an image index`);
  const want = platform.replace(/^linux\//, "");
  const hits = index.body.manifests.filter((d) => d.platform?.os === "linux" && d.platform.architecture === want);
  if (hits.length !== 1) throw new Error(`expected exactly one ${platform} manifest in ${repository}:${tag}, found ${hits.length}`);
  const manifest = await get(hits[0].digest);
  const configDigest = manifest.body.config?.digest;
  for (const d of [index.digest, hits[0].digest, configDigest]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(d || "")) throw new Error(`registry returned a malformed digest ${JSON.stringify(d)}`);
  }
  return { indexDigest: index.digest, platformManifestDigest: hits[0].digest, configDigest };
}

function catalogEntryFor(catalog, image, platform) {
  const short = image.replace(/^.*\//, "");
  return catalog.targets.find((t) => (platform ? t.targetKey === `${short}:${platform}` : t.targetKey && t.targetKey.startsWith(`${short}:`))) || null;
}

// Pure: returns a copy of the snapshot with only the named target's three pins
// replaced, plus a record of before/after. Qualification is never touched.
function refreshDiagnosticSnapshot(catalog, targetKey, live) {
  const doc = structuredClone(catalog);
  const entry = doc.targets.find((t) => t.targetKey === targetKey);
  if (!entry) throw new Error(`no catalog target ${targetKey}`);
  const ri = entry.resolvedInputs;
  const record = {
    targetKey, catalogSnapshotDigest: catalog.snapshotDigest ?? null,
    before: { indexDigest: ri.indexDigest ?? null, platformManifestDigest: ri.platformManifestDigest ?? null, configDigest: ri.configDigest ?? null },
    after: { ...live },
  };
  Object.assign(ri, live);
  if (entry.facts) entry.facts.digest = live.platformManifestDigest;
  return { doc, record };
}

module.exports = {
  resolveLiveDigests, catalogEntryFor, refreshDiagnosticSnapshot,
  LABEL, QUALIFICATION, diagnosticGrantFromEnv, installDiagnosticGrant,
  parseGateRefusal, gateRefusalMessage, gateRefusalSummary,
};
