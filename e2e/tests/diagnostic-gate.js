// Test-only helpers for building a catalog-unqualified target in @full.
//
// The production qualification gate (app.js catalogQualification) is never
// weakened. The app honours one JS global, installed by Playwright
// addInitScript, that names the exact image and platform of the operation
// (app.js diagnosticUnqualifiedGrant). Nothing the deployed site's normal path
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

module.exports = {
  LABEL, QUALIFICATION, diagnosticGrantFromEnv, installDiagnosticGrant,
  parseGateRefusal, gateRefusalMessage, gateRefusalSummary,
};
