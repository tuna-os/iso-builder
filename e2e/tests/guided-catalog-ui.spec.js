const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../..');
const config=require('../../tests/fixtures/guided/stock-config-v2.json');
async function guided(page,edit=()=>{}){
 const copy=structuredClone(config);edit(copy);
 await page.route('**/builder-config-data.js',route=>route.fulfill({contentType:'text/javascript',body:'globalThis.TBOX_BUILDER_CONFIG='+JSON.stringify(copy)+';'}));
 await page.goto('/');await expect(page.locator('#guided-picker')).toBeVisible();
 await page.getByRole('button',{name:'Help me choose / browse all setups'}).click();
}
test('guided stock default has no manual reference field and preserves exact target evidence',async({page})=>{
 await guided(page);
 await expect(page.locator('#guided-selection-summary')).toContainText('GNOME');
 await expect(page.locator('#image')).toBeHidden();
 await expect(page.locator('#image')).toHaveValue('ghcr.io/tuna-os/yellowfin:gnome');
 await expect(page.locator('#guided-picker')).not.toContainText('Browser build verified');
 const request=await page.evaluate(()=>window.tboxGetBuildRequest());
 expect(request.target.flavor).toBe('gnome');
 expect(request.target.platform).toBe('linux/amd64/v2');
});
test('base-first and desktop-first use one state and keyboard choices',async({page})=>{
 await guided(page);
 const paths=page.locator('.guided-paths button');await expect(paths).toHaveCount(2);
 await page.getByRole('radio',{name:/KDE/}).check();
 await expect(page.locator('.guided-chips')).toContainText('KDE');
 await paths.nth(1).click();
 await expect(page.locator('.guided-chips')).toContainText('KDE');
 const radio=page.locator('.guided-question input:not(:disabled)').first();await radio.focus();await page.keyboard.press('Space');
 await expect(radio).toBeChecked();
});
test('missing configured default is explicit and never selects first record',async({page})=>{
 await guided(page,c=>{c.default_selection={kind:'leaf',leaf_id:'missing:gnome:linux/amd64'};});
 await expect(page.locator('#guided-unavailable')).toBeVisible();await expect(page.locator('#image')).toHaveValue('');await expect(page.locator('#introspect')).toBeDisabled();
});
test('changed snapshot invalidates the bound projection and cannot inspect stale target',async({page})=>{
 await guided(page);await page.evaluate(()=>{const s=structuredClone(window.tboxGetCatalogSnapshot());s.snapshotDigest='sha256:'+'1'.repeat(64);window.tboxSetCatalogSnapshot(s);});
 await expect(page.locator('#guided-picker')).toHaveAttribute('role','alert');await expect(page.locator('#image')).toHaveValue('');await expect(page.locator('#introspect')).toBeDisabled();
});
test('guided desktop and expanded320px layouts capture actual frontend',async({page})=>{
 await guided(page);const dir=path.join(root,'e2e/screenshots');fs.mkdirSync(dir,{recursive:true});
 await page.screenshot({path:path.join(dir,'guided-stock-desktop.png'),fullPage:true});
 await page.setViewportSize({width:320,height:800});await page.locator('#advanced-options summary').first().click();await page.locator('#custom-image-options summary').click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:path.join(dir,'guided-stock-mobile-expanded.png'),fullPage:true});
});
test('same-ref platform change clears previous inspection and result identity',async({page})=>{
 const snapshot=require('../../app/public/catalog-snapshot.json');const copy=structuredClone(snapshot);
 const arm=copy.targets.find(e=>e.targetKey==='yellowfin:gnome:linux/arm64');arm.availability.available=true;arm.scheduled=true;
 await page.route('**/catalog-snapshot.json',r=>r.fulfill({json:copy}));await guided(page);
 await expect.poll(()=>page.evaluate(()=>guidedModel.leaves.find(l=>l.id==='yellowfin:gnome:linux/arm64')?.selectable)).toBe(true);
 const before=await page.evaluate(()=>{currentOp.ready=true;currentOp.buildResult={test:'stale'};return currentOp.id;});
 await page.evaluate(()=>guidedPicker.select('yellowfin:gnome:linux/arm64'));
 await expect(page.locator('#image')).toHaveValue('ghcr.io/tuna-os/yellowfin:gnome');await expect(page.locator('#platform')).toHaveValue('linux/arm64');
 const state=await page.evaluate(()=>({id:currentOp.id,ready:currentOp.ready,result:currentOp.buildResult}));expect(state.id).not.toBe(before);expect(state.ready).toBe(false);expect(state.result).toBeNull();
});
