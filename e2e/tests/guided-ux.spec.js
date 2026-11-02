// UX contracts use representative Flathub metadata, never a real ISO download.
const { test, expect } = require('@playwright/test');
require('./legacy-deployment').useLegacyDeployment(test);
const fs = require('node:fs');
const path = require('node:path');
const firefox = {
  app_id: 'org.mozilla.firefox', name: 'Firefox',
  summary: 'Fast, Private & Safe Web Browser',
  icon: 'https://dl.flathub.org/media/icons/128x128/org.mozilla.firefox.png',
  arches: ['x86_64', 'aarch64'],
};
async function setup(page) {
  // Metadata UI coverage must not depend on the external icon CDN.
  await page.route(firefox.icon, r => r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="blue"/></svg>'}));
  await page.route('**/wasm_exec.js', r => r.fulfill({ body: '' }));
  await page.route('**/tbox.wasm', r => r.abort());
  await page.route('**/flathub/search', r => r.fulfill({ json: { hits: [firefox] } }));
  await page.goto('/');
}
async function screenshot(page, name) {
  const dir = path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

test('quiet defaults, explicit check, reversible desktop choices', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#image')).toHaveValue('yellowfin:gnome');
  await expect(page.locator('.edition[data-de=gnome]')).toHaveAttribute('aria-pressed', 'true');
  for (const id of ['label', 'pkgsearch', 'reporef', 'initrdurl', 'shimurl', 'fpsearch']) {
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect(page.getByRole('button', { name: 'Check image & continue' })).toBeVisible();
  await expect(page.locator('#buildcard')).toBeHidden();
  await page.locator('.edition[data-de=kde]').click();
  await expect(page.locator('#image')).toHaveValue('yellowfin:kde');
  await expect(page.locator('#buildcard')).toBeHidden();
  await page.locator('.edition[data-de=gnome]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.edition[data-de=gnome]')).toHaveAttribute('aria-pressed', 'true');
  await screenshot(page, 'ux-01-desktop-defaults.png');
});

test('rich app results retain search, selected state and keyboard focus', async ({ page }) => {
  await setup(page);
  await page.locator('#apps-options > summary').click();
  await page.getByLabel('Search Flathub', { exact: true }).fill('Firefox');
  const card = page.locator('#fpresults .app-card');
  await expect(card).toContainText(firefox.summary);
  await expect(card).toContainText('Flathub · org.mozilla.firefox');
  await expect(card).toContainText('Listed for x86_64');
  await expect(card.locator('img')).toHaveAttribute('src', firefox.icon);
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(card).toBeFocused();
  await expect(page.locator('#fpcount')).toHaveText('1 selected');
  await expect(page.locator('#fpsearch')).toHaveValue('Firefox');
  await expect(page.getByRole('checkbox', { name: 'Include Firefox' })).toBeChecked();
  await screenshot(page, 'ux-02-rich-app-selection.png');
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#fpcount')).toHaveText('0 selected');
  await page.locator('#apps-options > summary').click();
  await page.locator('#apps-options > summary').click();
  await expect(page.locator('#fpsearch')).toHaveValue('Firefox');
});

test('empty, error and missing metadata states remain honest', async ({ page }) => {
  await setup(page);
  await page.locator('#apps-options > summary').click();
  await page.route('**/flathub/search', r => r.fulfill({ json: { hits: [] } }));
  await page.locator('#fpsearch').fill('missing');
  await expect(page.locator('#fpstatus')).toContainText('No apps found');
  await page.route('**/flathub/search', r => r.fulfill({ status: 503, body: 'Unavailable' }));
  await page.locator('#fpsearch').fill('offline');
  await expect(page.locator('#fpstatus')).toContainText('unavailable');
  await page.route('**/flathub/search', r => r.fulfill({ json: { hits: [{ app_id: 'org.example.Test', name: '<img onerror=alert(1)>', icon: 'https://tracking.example/icon.png' }] } }));
  await page.locator('#fpsearch').fill('test');
  await expect(page.locator('#fpresults')).toContainText('App details have not been loaded');
  await expect(page.locator('#fpresults')).toContainText('Computer compatibility not checked');
  await expect(page.locator('#fpresults img')).toHaveCount(0);
  await expect(page.locator('#fpresults')).toContainText('<img onerror=alert(1)>');
});

test('late search responses cannot replace a cleared or newer query', async ({ page }) => {
  await setup(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/flathub/search', async r => {
    if (r.request().postDataJSON().query === 'old') await pending;
    await r.fulfill({ json: { hits: [firefox] } }).catch(() => {});
  });
  await page.locator('#apps-options > summary').click();
  const request = page.waitForRequest(r => r.url().endsWith('/flathub/search'));
  await page.locator('#fpsearch').fill('old');
  await request;
  await page.locator('#fpsearch').fill('');
  release();
  await expect(page.locator('#fpstatus')).toContainText('Type at least 3');
  await expect(page.locator('#fpresults .app-card')).toHaveCount(0);
});

for (const width of [390, 320]) {
  test(`mobile ${width}px keeps controls within the viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await expect(page.locator('#introspect')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, `ux-03-mobile-${width}-defaults.png`);
    await page.locator('#apps-options > summary').click();
    await page.locator('#fpsearch').fill('Firefox');
    await expect(page.locator('#fpresults .app-card')).toBeVisible();
    await page.locator('#fpresults .app-card').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, `ux-04-mobile-${width}-apps.png`);
  });
}

test('320px advanced controls remain contained and DDI needs explicit check', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await setup(page);
  await page.locator('#base-options > summary').click();
  await page.locator('#variant').selectOption('ddi:snow');
  await expect(page.locator('#buildcard')).toBeHidden();
  await expect(page.locator('.edition')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#introspect').click();
  await expect(page.locator('#stage')).toContainText('DDI channel');
  await expect(page.locator('#build')).toBeEnabled();
  await page.locator('#advanced-options > summary').click();
  for (const summary of await page.locator('#advanced-options details > summary').all()) await summary.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, 'ux-05-mobile-advanced.png');
});

test('preset metadata hydration updates accessible names without losing checkbox focus', async ({ page }) => {
  await setup(page);
  await page.goto('/?flatpaks=org.mozilla.firefox');
  await page.locator('#apps-options > summary').click();
  await expect(page.getByRole('checkbox', { name: 'Include Firefox', exact: true })).toBeChecked();
  const checkbox = page.getByRole('checkbox', { name: 'Include Firefox', exact: true });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeFocused();
  await expect(page.locator('#fplist .app-state')).toHaveText('Not selected');
});
