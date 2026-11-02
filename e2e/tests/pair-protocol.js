// Test-only fixed-input measurements, never producer authority or qualification.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const digest = value => "sha256:" + crypto.createHash("sha256").update(value).digest("hex");

function campaignValue(key, value) {
  const filename = process.env.TBOX_E2E_PAIR_STATE;
  if (!process.env.TBOX_E2E_PAIR) return value;
  if (!filename) throw new Error("pair mode requires TBOX_E2E_PAIR_STATE");
  const state = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : {};
  if (Object.hasOwn(state, key) && !isDeepStrictEqual(state[key], value)) {
    throw new Error(`pair campaign changed ${key}; refusing changed inputs`);
  }
  state[key] = value;
  fs.writeFileSync(filename, JSON.stringify(state, null, 2) + "\n");
  return value;
}

function pairEnvironment() {
  const root = path.resolve(__dirname, "../..");
  const publicRoot = path.join(root, "app/public");
  const frontend = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:js|json|html|css)$/.test(file)) {
        frontend[path.relative(publicRoot, file)] = digest(fs.readFileSync(file));
      }
    }
  }
  visit(publicRoot);
  const cgroup = name => {
    try { return fs.readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim(); }
    catch { return "unavailable"; }
  };
  const disk = fs.statfsSync(process.env.TBOX_E2E_PROFILE_ROOT || process.env.HOME);
  return campaignValue("environment", {
    frontendRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    frontend, engineModule: fs.readFileSync(path.join(root, "native/go.mod"), "utf8").match(/^\s*github\.com\/tuna-os\/tacklebox\s+\S+/m)?.[0].trim() || null,
    goSumSha256: digest(fs.readFileSync(path.join(root, "native/go.sum"))),
    playwrightLockSha256: digest(fs.readFileSync(path.join(root, "e2e/package-lock.json"))),
    resources: { os: os.platform(), arch: os.arch(), cpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
      memoryMax: cgroup("memory.max"), swapMax: cgroup("memory.swap.max"), cpuMax: cgroup("cpu.max"),
      profileFilesystemBytes: disk.blocks * disk.bsize, profileFilesystemType: disk.type,
      chromiumArgs: ["--disable-dev-shm-usage"], viewport: { width: 1180, height: 820 } },
    memoryMethod: "Sampled tboxWasmMB and tboxJsHeapMB at phase boundaries and every 30 seconds; estimates, not process RSS or exact maxima; MB as reported by hooks",
    qualification: "not-assessed", registryFallback: false,
  });
}
module.exports = { campaignValue, pairEnvironment, digest };
