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
    page.on("console", (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

    await page.goto(`/?image=${encodeURIComponent(IMAGE)}&autodl=1&autorun=1${initrd ? `&initrd=${encodeURIComponent(initrd)}` : ""}`);

    // Heartbeat: proves whether the unpack is advancing or wedged, which is
    // the thing the bare assertion can't distinguish.
    const stageText = () => page.locator("#stage").textContent().catch(() => "<unreadable>");
    const beat = setInterval(async () => console.log(`[stage] ${await stageText()}`), 30_000);
    try {
      await expect(page.locator("#build")).toBeEnabled({ timeout: 600_000 });
    } catch (e) {
      const stage = await stageText();
      const logText = (await page.locator("#log").textContent().catch(() => "")) || "";
      await shot(page, `05-inspect-stalled-${slug(IMAGE)}.png`);
      throw new Error(
        `inspect never enabled #build for ${IMAGE}\n` +
          `  last stage: ${stage}\n` +
          `  log tail:\n${logText.split("\n").slice(-40).join("\n")}\n\n${e.message}`,
      );
    } finally {
      clearInterval(beat);
    }

    const download = page.waitForEvent("download", { timeout: 600_000 });
    await page.locator("#build").click();
    await shot(page, "05-building.png");
    const dl = await download;
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
