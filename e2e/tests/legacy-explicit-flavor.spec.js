// A v1 deployment lists only base desktops (gnome, kde, ...), so a catalog
// flavor such as gnome-hwe or gnome-nvidia is not one of its edition buttons.
// An explicit ?image= link to such a target must survive the catalog
// snapshot arriving: clearing it mid-inspect made every autorun of those
// cells stop at "The selected image is no longer available or has changed".
const { test, expect } = require("@playwright/test");
require("./legacy-deployment").useLegacyDeployment(test);

test.describe("v1 deployment, explicit catalog flavor", () => {
  for (const image of ["tuna-os/yellowfin:gnome-hwe", "tuna-os/marlin:gnome-nvidia"]) {
    test(`keeps ${image} after the catalog loads`, async ({ page }) => {
      await page.goto(`/?image=${encodeURIComponent(image)}`);
      await page.evaluate(() => loadCatalogSnapshot());
      await expect(page.locator("#image")).toHaveValue(image);
    });
  }

  test("still clears an explicit ref with no catalog entry", async ({ page }) => {
    await page.goto(`/?image=${encodeURIComponent("tuna-os/yellowfin:no-such-flavor")}`);
    await page.evaluate(() => loadCatalogSnapshot());
    await expect(page.locator("#image")).toHaveValue("");
  });
});
