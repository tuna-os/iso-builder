// Persistent browser contexts on real disk: Chrome derives the OPFS
// quota from the profile partition's free space, and the default
// ephemeral profile lands on /tmp — a 2 GB tmpfs on dev boxes, which
// caps origin storage below what a real image pull needs.
//
// TBOX_E2E_PROFILE_ROOT moves the profile off $HOME when the roomiest
// filesystem is not the one $HOME sits on. That is the normal case on a
// GitHub runner: / has ~14 GB (~44 GB after reclaiming the preinstalled
// toolchains), while /mnt is a ~75 GB NVMe that is otherwise unused.
// Since the quota follows the *profile's* partition, pointing this at
// /mnt is what actually raises it — freeing / does not help a profile
// that could have been on the big disk all along.
//
// It is deliberately a separate variable rather than an override of
// HOME: Playwright resolves its browser download to ~/.cache/ms-playwright,
// so moving HOME would strand the cached chromium and silently reinstall
// it on every run.
const base = require("@playwright/test");
const path = require("path");
const fs = require("fs");

exports.test = base.test.extend({
  context: async ({ browserName }, use, testInfo) => {
    const root = process.env.TBOX_E2E_PROFILE_ROOT || process.env.HOME;
    const dir = path.join(root, "tmp", `pw-prof-${testInfo.workerIndex}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const ctx = await base[browserName].launchPersistentContext(dir, {
      viewport: { width: 1180, height: 820 },
      baseURL: "http://127.0.0.1:8931",
      args: ["--disable-dev-shm-usage"],
    });
    await use(ctx);
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] || (await context.newPage()));
  },
});
exports.expect = base.expect;
