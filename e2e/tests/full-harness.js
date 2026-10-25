// Harness helpers for the @full spec.

// Headless Chromium defines window.showSaveFilePicker but rejects it at once
// with AbortError ("The user aborted a request"; run 40231494555). The app
// treats a cancelled export as a failed build (deliberately; see
// build-result.spec.js), so after the ISO was fully written (`phase=iso`) the
// build was reported failed. Removing the picker selects the app's download
// fallback, the same path the "saved tiny download" test exercises.
function removeSavePicker() {
  delete window.showSaveFilePicker;
}

// The app sets this stage text for every terminal build failure. It does not
// say why; the reason is in #log, which describe() reports.
const FAILED_STAGE = /^Build failed/;

function buildFailedSignature(sig) {
  return FAILED_STAGE.test(String(sig || "").split("|")[0]);
}

module.exports = { removeSavePicker, buildFailedSignature };
