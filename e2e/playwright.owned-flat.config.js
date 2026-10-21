// Isolated temporary capability probe: no app server, engine build or @full ISO.
// The spec owns its Chromium process; this config adds no browser launch flags.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: ["owned-flat-cdp.spec.js", "owned-flat-websocket.spec.js", "owned-flat-body-reservations.spec.js",
    "owned-flat-frontend-state.spec.js", "owned-flat-launcher-profile.spec.js", "owned-flat-frontend-controller.spec.js", "owned-flat-layer-fixture.spec.js", "owned-flat-hidden-page.spec.js"],
  timeout: 40_000,
  globalTimeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "./test-results-owned-flat",
});
