// Test-only helpers for building a catalog-unqualified target in @full.
//
// Production catalog qualification is never changed. CI installs frozen,
// named-target grants with addInitScript; URL, storage and UI cannot grant one.
// Diagnostic builds stay diagnostic-unqualified. The bounded retained-ISO plain
// and both-mode routes instead record a strict-observed, not-assessed build.

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

// The retained plain route stays bounded to Skipjack GNOME. STRICT_INSTALL_MODE
// =both (plain then LUKS on one retained ISO, the qualification-receipt route)
// may name any single TunaOS linux/amd64 cell; ONLY must be exactly its slug.
const STRICT_BOTH_IMAGE = /^tuna-os\/([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:[.-][a-z0-9]+)*)$/;

function strictObservedGrantFromEnv(env, { image, platform }) {
  if (env.TBOX_E2E_STRICT_OBSERVED === undefined || env.TBOX_E2E_STRICT_OBSERVED === "") return null;
  const required = {
    TBOX_E2E_STRICT_OBSERVED: "1", TBOX_E2E_FULL: "1",
    STRICT_ROUNDTRIP_TEST: "true", DIAGNOSTIC_UNQUALIFIED: "false", RETAIN_ISO_ARTIFACT: "true",
    BENCHMARK: "false", KEEP_ISO: "false", RETAIN_CANDIDATE: "false", PAIR: "false",
  };
  const mode = env.STRICT_INSTALL_MODE;
  const both = mode === "both" && STRICT_BOTH_IMAGE.exec(image || "");
  const target = mode === "plain"
    ? env.ONLY === "skipjack-gnome" && image === "tuna-os/skipjack:gnome"
    : Boolean(both) && env.ONLY === `${both[1]}-${both[2]}`;
  if (Object.entries(required).some(([key, value]) => env[key] !== value) || !target ||
      env.DIAGNOSTIC_ALLOW_UNQUALIFIED || platform !== "linux/amd64") {
    throw new Error("TBOX_E2E_STRICT_OBSERVED requires the retained Skipjack GNOME plain strict roundtrip, or a both-mode strict roundtrip of the one named TunaOS linux/amd64 cell, with no diagnostic grant or publishing");
  }
  return Object.freeze({ kind: "strict-observed", image, platform,
    installMode: mode, route: "retained-iso-roundtrip" });
}

function installStrictObservedGrant(grant) {
  Object.defineProperty(globalThis, "__TBOX_STRICT_OBSERVED__", {
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
// date, and the engine builds exactly those pinned manifests, fetched by digest
// (tacklebox#452). Before that it resolved the tag and refused a moved one
// ("platformManifestDigest mismatch"): the first diagnostic dispatch died on
// exactly that (snapshot 2026-10-17 vs the republished tag). A diagnostic build
// exercises what the registry serves now, and dropping the pins would change
// the media shape (the offline layout ships only when pins exist), so it
// refreshes the three pins of the one named target to what the registry serves
// now and records old and new values in the evidence.
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function resolvePlatformDescriptor({ repository, tag, platform, fetchImpl = fetch }) {
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
  const [os, architecture, variant = "", ...extra] = platform.split("/");
  if (os !== "linux" || !architecture || extra.length) throw new Error(`cannot resolve exact platform ${platform}`);
  const hits = index.body.manifests.filter((d) => d.platform?.os === os &&
    d.platform.architecture === architecture && (d.platform.variant || "") === variant);
  if (hits.length !== 1) throw new Error(`expected exactly one ${platform} manifest in ${repository}:${tag}, found ${hits.length}`);
  const manifest = await get(hits[0].digest);
  const configDigest = manifest.body.config?.digest;
  for (const d of [index.digest, hits[0].digest, configDigest]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(d || "")) throw new Error(`registry returned a malformed digest ${JSON.stringify(d)}`);
  }
  return { indexDigest: index.digest, platformManifestDigest: hits[0].digest, configDigest,
    annotations: hits[0].annotations || {} };
}

async function resolveLiveDigests(args) {
  const { indexDigest, platformManifestDigest, configDigest } = await resolvePlatformDescriptor(args);
  return { indexDigest, platformManifestDigest, configDigest };
}

// tunaOS live-overlay.yml publishes live-overlay:<variant>-<flavor> with the
// platform manifest digest of the base it was built from as the descriptor
// annotation below; the engine refuses an overlay whose binding is not the
// image it builds.
const OVERLAY_REPOSITORY = "ghcr.io/tuna-os/live-overlay";
const OVERLAY_BASE_ANNOTATION = "org.tunaos.live-overlay.base-digest";

async function resolveLiveOverlayPins({ variant, flavor, platform, fetchImpl = fetch }) {
  const tag = `${variant}-${flavor}`;
  const d = await resolvePlatformDescriptor({ repository: OVERLAY_REPOSITORY, tag, platform, fetchImpl });
  const base = d.annotations[OVERLAY_BASE_ANNOTATION];
  if (!/^sha256:[0-9a-f]{64}$/.test(base || "")) {
    throw new Error(`${OVERLAY_REPOSITORY}:${tag} (${platform}) carries no ${OVERLAY_BASE_ANNOTATION} digest, got ${JSON.stringify(base ?? null)}`);
  }
  return { liveOverlayDigest: d.platformManifestDigest, liveOverlayBaseDigest: base };
}

function catalogEntryFor(catalog, image, platform) {
  const short = image.replace(/^.*\//, "");
  return catalog.targets.find((t) => (platform ? t.targetKey === `${short}:${platform}` : t.targetKey && t.targetKey.startsWith(`${short}:`))) || null;
}

// The image the page is driven with: the catalog entry's publication.ref, which
// is what the guided picker hands a user and what the installed system tracks.
// A variant with publish_name/tag_suffix publishes under another name than its
// target key (flounder-sid:gnome is flounder:gnome-sid); driving the page with
// the target key would build and install the variant-ID repository instead.
// Same short form as the edition ref for every other target. The target
// identity (slug, ONLY, evidence target) stays the edition ref.
function pageImageFor(catalog, image, platform) {
  const entry = catalogEntryFor(catalog, image, platform);
  return entry ? entry.publication.ref.replace(/^ghcr\.io\//, "") : image;
}

// Pure: returns a copy of the snapshot with only the named target's three pins
// replaced, plus a record of before/after. Qualification is never touched.
// A target that also pins its live overlay (skipjack:gnome since the
// 2026-11-07 snapshot) needs the overlay pins refreshed with the image: the
// overlay is bound to one base, and iso-builder run 42894083700 refreshed only
// the image (80f53cbc -> 5edcb582) and died in the engine with
// "liveOverlayBaseDigest 80f53cbc does not match platformManifestDigest
// 5edcb582". Such a target needs `overlay` from resolveLiveOverlayPins, bound
// to the live image; a stale or missing overlay is refused here, before a
// build starts.
function refreshDiagnosticSnapshot(catalog, targetKey, live, overlay = null) {
  const doc = structuredClone(catalog);
  const entry = doc.targets.find((t) => t.targetKey === targetKey);
  if (!entry) throw new Error(`no catalog target ${targetKey}`);
  const ri = entry.resolvedInputs;
  const pinsOverlay = Boolean(ri.liveOverlayDigest || ri.liveOverlayBaseDigest);
  if (overlay && overlay.liveOverlayBaseDigest !== live.platformManifestDigest) {
    throw new Error(`the published live overlay for ${targetKey} is bound to ${overlay.liveOverlayBaseDigest}, but the registry serves ${live.platformManifestDigest}: the overlay is stale; republish it (tunaOS live-overlay.yml) before a diagnostic build`);
  }
  if (pinsOverlay && !overlay && ri.liveOverlayBaseDigest !== live.platformManifestDigest) {
    throw new Error(`${targetKey} pins a live overlay bound to ${ri.liveOverlayBaseDigest}; refreshing its image to ${live.platformManifestDigest} needs the overlay pins refreshed too`);
  }
  const record = {
    targetKey, catalogSnapshotDigest: catalog.snapshotDigest ?? null,
    before: { indexDigest: ri.indexDigest ?? null, platformManifestDigest: ri.platformManifestDigest ?? null, configDigest: ri.configDigest ?? null },
    after: { ...live },
  };
  if (overlay) {
    record.before.liveOverlayDigest = ri.liveOverlayDigest ?? null;
    record.before.liveOverlayBaseDigest = ri.liveOverlayBaseDigest ?? null;
    Object.assign(record.after, overlay);
  }
  Object.assign(ri, live, overlay || {});
  if (entry.facts) entry.facts.digest = live.platformManifestDigest;
  return { doc, record };
}

module.exports = {
  resolveLiveDigests, resolveLiveOverlayPins, catalogEntryFor, pageImageFor, refreshDiagnosticSnapshot,
  LABEL, QUALIFICATION, diagnosticGrantFromEnv, installDiagnosticGrant,
  strictObservedGrantFromEnv, installStrictObservedGrant,
  parseGateRefusal, gateRefusalMessage, gateRefusalSummary,
};
