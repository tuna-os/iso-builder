// E2E for the TunaOS ISO Builder web app — drives the real WASM engine
// against the real registry relay.
//
// The @walkthrough tests double as the documentation pipeline: every
// screenshot lands in ../../../../docs/iso-builder/ and is embedded by
// docs/iso-builder-guide.md. Regenerate with `npm run walkthrough`
// (or the iso-builder-e2e workflow), then commit the refreshed images.
//
// TBOX_E2E_FULL=1 additionally runs the full ISO build + download —
// heavy (real image in browser memory); off by default in CI.

const { test, expect } = require("./fixtures");
const path = require("path");
const fs = require("fs");

const SHOTS = process.env.TBOX_E2E_SHOTS
  ? path.resolve(process.env.TBOX_E2E_SHOTS)
  : path.resolve(__dirname, "../screenshots");
// sailfin:base: smallest clean image with kernel + systemd-boot
// (guppy:base ships a /tmp build tree — tunaOS#672).
const IMAGE = process.env.TBOX_E2E_IMAGE || "tuna-os/sailfin:base";
// Per-phase budget for @full: one for inspect (pull + unpack), one for the
// build. Both scale with payload, and the first sweep proved 10 min only
// ever fit the baseline — sailfin:base is 1.5 GB of compressed layers and
// inspects in ~4 min, but the editions the picker offers run to 4.8 GB
// (bonito:kde) and 3.8 GB (yellowfin:gnome). Those two cells timed out on
// image size with 35 of the job's 45 minutes of Playwright budget unused.
// Two phases at this budget still fit under that per-test cap.
//
// This is an upper bound for work that is slow, not a wait for work that is
// dead. See the watchdogs below.
const WAIT_MS = Number(process.env.TBOX_E2E_WAIT_MS || 1_200_000);
// The engine is a Go binary on wasm32, so the unpacked tree, the EROFS
// image and the ISO all share one 4 GiB linear-memory address space. Every
// red cell in the first full sweep was that one ceiling:
//
//   flounder:xfce    `runtime: out of memory: cannot allocate 4194304-byte
//                    block (4257021952 in use)` + `exit code: 2` while
//                    authoring the ISO: 3.97 GiB in use, 1.0 GB of layers.
//   bonito:kde       counter frozen at layer 38/65, silently, forever.
//   yellowfin:gnome  same, at 47/65. Both had consumed ~1.9 GB of
//                    compressed layers, which is where this image set
//                    expands past 4 GiB.
//   sailfin:gnome    1.6 GB, the only edition that fits. Passes in 5 min.
//
// Both shapes are terminal, and a dead engine still serves DOM queries, so
// waiting one out just relabels it: `Received: disabled` after 20 min, or a
// download that never comes after 20 more. These two watchdogs cut that to
// the moment the engine says it died, or to the moment progress stops.
//
// A frozen counter means wedged, not slow: unpack ticks once per layer and
// the fastest edition clears all 65 in ~2 min, so this only has to outlast
// the single largest layer (556 MB in bonito:kde).
const STALL_MS = Number(process.env.TBOX_E2E_STALL_MS || 300_000);
// The build phase gets a looser budget on purpose. Its stages (EROFS
// authoring, ESP, ISO streaming) hold one label for minutes and only the
// progress bar moves underneath, and how finely the engine ticks it there
// isn't something a green run has ever shown, because the old heartbeat
// stopped at the end of inspect, so every passing build was unobserved. The
// death detector is what actually caught the build-phase OOM; this is a
// backstop, and a backstop that fails a healthy 5 GB build is worse than
// one that takes 10 min to fire.
const BUILD_STALL_MS = Number(process.env.TBOX_E2E_BUILD_STALL_MS || 600_000);

function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

// "tuna-os/bonito:kde" -> "bonito-kde", for filenames.
const slug = (ref) => ref.replace(/^.*\//, "").replace(/[^a-zA-Z0-9]+/g, "-");

test.describe("iso builder", () => {
  test("page loads with the edition picker @walkthrough", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/TunaOS ISO Builder/);
    // Primary path is the picker: a base-variant dropdown + desktop chips.
    await expect(page.locator("#variant")).toBeVisible();
    await expect(page.locator("#editions .edition")).not.toHaveCount(0);
    await shot(page, "01-home.png");
  });

  test("picking an edition fills the image ref (no typing)", async ({ page }) => {
    await page.goto("/");
    // Selecting a base re-renders its desktop chips; clicking one sets the
    // image ref as <variant>:<desktop> — the zero-typing default flow.
    await page.locator("#variant").selectOption("bonito");
    const chip = page.locator('#editions .edition[data-de="kde"]');
    await expect(chip).toBeVisible();
    // Read the ref the chip would build without kicking off a network inspect.
    const de = await chip.getAttribute("data-de");
    expect(de).toBe("kde");
  });

  test("url params prefill the form and reflect in the picker", async ({ page }) => {
    await page.goto("/?image=bonito:kde&label=DEMO&flatpaks=org.example.App");
    await expect(page.locator("#image")).toHaveValue("bonito:kde");
    await expect(page.locator("#variant")).toHaveValue("bonito");
    await expect(page.locator("#label")).toHaveValue("DEMO");
    await expect(page.locator("#fplist")).toContainText("org.example.App");
    await expect(page.locator("#share")).toContainText("image=bonito");
  });

  test("inspect detects the image and fills flatpak defaults @walkthrough", async ({ page }) => {
    await page.goto("/");
    // Freeform 'any image' path lives under a disclosure — open it to type a
    // :base image the picker doesn't list.
    await page.getByText("Or build from any bootable container image").click();
    await page.locator("#image").fill(IMAGE);
    await shot(page, "02-image-entered.png");
    await page.locator("#introspect").click();

    // Engine load + manifest resolve + full unpack (network).
    await expect(page.locator("#facts")).toBeVisible({ timeout: 600_000 });
    await expect(page.locator(".badge.de")).toContainText(/gnome|kde|niri|cosmic|xfce|none/);
    await expect(page.locator("#build")).toBeEnabled();
    await shot(page, "03-inspected.png");

    // Advanced customization panel: per-DE flatpak defaults are prefilled.
    await page.getByText(/Advanced — customize/).click();
    expect(await page.locator("#fplist input[type=checkbox]").count()).toBeGreaterThan(0);
    await shot(page, "04-advanced.png");
  });

  test("full build streams a bootable ISO @full", async ({ page }) => {
    test.skip(!process.env.TBOX_E2E_FULL, "set TBOX_E2E_FULL=1 for the full build");
    const initrd = process.env.TBOX_E2E_INITRD_URL || "";

    // Without these, a stalled inspect reports only `Received: disabled` —
    // identical output whether the unpack is merely slow or threw. The
    // engine's own diagnostics all go to console / #stage / #log.
    //
    // wasm_exec.js relays the Go runtime's fatal output verbatim, so the
    // panic that kills the engine arrives here as ordinary console lines.
    // Catching it is the difference between "OOM at 3.97 GiB while authoring
    // the ISO" and a bare 20-minute timeout on a download event.
    //
    // Matched narrowly, on the Go runtime's own fatal markers and a non-zero
    // wasm exit: console errors are not automatically fatal here (the green
    // sailfin:gnome cell logs a benign resource 404), and treating them as
    // fatal would fail healthy builds. A pageerror does count, because
    // inspect() and build() catch their own failures into #log, so an
    // exception escaping to window.onerror leaves nothing to recover.
    //
    // `!!! tbox failed:` is the engine's own terminal-failure line (stdout,
    // relayed by wasm_exec.js). It is deterministic, not a crash: the page stays
    // alive serving "Build failed.", so without this marker the run only dies
    // when the stall watchdog gives up. The first aurora-stable cell spent 10
    // idle minutes exactly that way, with the actual reason ("image ships no
    // systemd-boot ... need a supplied one") buried in the log tail instead
    // of the error title.
    let death = null;
    const watchLine = (line) => {
      if (!death && /fatal error:|runtime: out of memory|^\[pageerror\]|panic: |exit code: [1-9]|!!! tbox failed:/m.test(line)) {
        death = line.trim();
      }
    };
    page.on("console", (m) => {
      const line = `[browser:${m.type()}] ${m.text()}`;
      console.log(line);
      watchLine(line);
    });
    page.on("pageerror", (e) => {
      const line = `[pageerror] ${e.message}`;
      console.log(line);
      watchLine(line);
    });

    await page.goto(`/?image=${encodeURIComponent(IMAGE)}&autodl=1&autorun=1${initrd ? `&initrd=${encodeURIComponent(initrd)}` : ""}`);

    const stageText = () => page.locator("#stage").textContent().catch(() => "<unreadable>");
    // Engine linear memory alongside the stage: a stall that plateaus at a
    // fixed MB figure is the wasm32 ceiling, not a slow network. flounder's
    // panic put a number on that ceiling (3.97 GiB in use), so a wedge
    // parked near ~4000 MB here is the same wall reached quietly.
    const wasmMB = () => page.evaluate(() => globalThis.tboxWasmMB?.() ?? -1).catch(() => -1);
    // #stage is the human label; #bar is the only thing that moves inside a
    // long stage (the app assigns .value, which never reflects to the
    // attribute, hence evaluate rather than getAttribute). A crashed page
    // makes this throw, which reads as "not advancing", which it isn't.
    const progress = () =>
      page
        .evaluate(() => {
          const b = document.getElementById("bar");
          const s = document.getElementById("stage");
          return `${s ? s.textContent : "?"}|${b ? `${b.value}/${b.max}` : "?"}`;
        })
        .catch(() => "<unreadable>");

    // Heartbeat + watchdogs. The 30 s [stage] log is what proves after the
    // fact whether a phase was advancing or wedged; the rejection is what
    // stops a terminal failure from eating the whole per-phase budget.
    function watch(what, stallMs) {
      let cancel = () => {};
      const promise = new Promise((_, reject) => {
        let last = null;
        let moved = Date.now();
        let ticks = 0;
        const stop = (err) => {
          clearInterval(tick);
          reject(err);
        };
        const tick = setInterval(async () => {
          const sig = await progress();
          if (++ticks % 6 === 0) {
            console.log(`[stage] ${await stageText()}  wasm=${Math.round(await wasmMB())} MB`);
          }
          if (death) return stop(new Error(`engine died during ${what}: ${death}`));
          if (sig !== last) {
            last = sig;
            moved = Date.now();
          } else if (Date.now() - moved > stallMs) {
            const budget =
              stallMs >= 60_000
                ? `${Math.round(stallMs / 60_000)} min`
                : `${Math.round(stallMs / 1000)} s`;
            stop(
              new Error(
                `${what} wedged: no progress for ${budget} at ${sig}` +
                  ` (wasm=${Math.round(await wasmMB())} MB)`,
              ),
            );
          }
        }, 5_000);
        cancel = () => clearInterval(tick);
      });
      // Whichever side loses the race is never awaited.
      promise.catch(() => {});
      return { promise, cancel };
    }

    // Both phases fail the same way and deserve the same evidence: the last
    // stage, the app's own log tail, and a screenshot. The first sweep only
    // instrumented inspect, so flounder:xfce's build-phase OOM surfaced as a
    // naked `waitForEvent: Timeout 1200000ms exceeded` with the panic that
    // caused it 19 minutes upstream in the log.
    const describe = async (what, e) => {
      const stage = await stageText();
      const logText = (await page.locator("#log").textContent().catch(() => "")) || "";
      await shot(page, `05-${what}-stalled-${slug(IMAGE)}.png`);
      return new Error(
        `${what} never completed for ${IMAGE}\n` +
          `  last stage: ${stage}  (wasm=${Math.round(await wasmMB())} MB)\n` +
          (death ? `  engine died: ${death}\n` : "") +
          `  log tail:\n${logText.split("\n").slice(-40).join("\n")}\n\n${e.message}`,
      );
    };

    const inspectWatch = watch("inspect", STALL_MS);
    try {
      await Promise.race([
        expect(page.locator("#build")).toBeEnabled({ timeout: WAIT_MS }),
        inspectWatch.promise,
      ]);
    } catch (e) {
      throw await describe("inspect", e);
    } finally {
      inspectWatch.cancel();
    }

    const buildWatch = watch("build", BUILD_STALL_MS);
    let dl;
    try {
      const download = page.waitForEvent("download", { timeout: WAIT_MS });
      await page.locator("#build").click();
      await shot(page, "05-building.png");
      dl = await Promise.race([download, buildWatch.promise]);
    } catch (e) {
      throw await describe("build", e);
    } finally {
      buildWatch.cancel();
    }
    const out = process.env.TBOX_E2E_ISO_OUT || path.join(SHOTS, "..", "iso-builder-e2e-output.iso");
    console.log("saving iso to:", out, "(env override:", process.env.TBOX_E2E_ISO_OUT || "none", ")");
    await dl.saveAs(out);
    console.log("saved:", out, fs.statSync(out).size, "bytes");
    // Playwright reclaims download artifacts at context close — even the
    // saveAs copy has been observed vanishing on CI. Duplicate to a path
    // wholly outside playwright's purview before the test ends.
    if (process.env.TBOX_E2E_ISO_COPY) {
      fs.copyFileSync(out, process.env.TBOX_E2E_ISO_COPY);
      console.log("copied to:", process.env.TBOX_E2E_ISO_COPY, fs.statSync(process.env.TBOX_E2E_ISO_COPY).size, "bytes");
    }
    const size = fs.statSync(out).size;
    expect(size).toBeGreaterThan(100 * 1024 * 1024);
    // ISO9660 PVD signature at sector 16.
    const fd = fs.openSync(out, "r");
    const buf = Buffer.alloc(6);
    fs.readSync(fd, buf, 0, 6, 16 * 2048);
    fs.closeSync(fd);
    expect(buf.toString("latin1", 1, 6)).toBe("CD001");
    await expect(page.locator("#stage")).toContainText(/Done/, { timeout: 120_000 });
    await shot(page, "06-done.png");
    fs.unlinkSync(out);
  });
});
