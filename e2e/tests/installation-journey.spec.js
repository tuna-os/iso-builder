const {test,expect}=require('@playwright/test');
const {qualifiedCatalogFixture}=require('./qualified-catalog-fixture');
const fs=require('node:fs');
test.beforeEach(async({page})=>{
 await page.route('**/wasm_exec.js',r=>r.fulfill({body:''}));
 await page.route('**/tbox.wasm',r=>r.abort());
 await page.route('https://**/*',r=>r.abort());
});
test('maintained starting point is honest and browsing preserves a single catalog',async({page})=>{
 await page.goto('/');
 await expect(page.locator('#experience')).toHaveValue('tunaos');
 await expect(page.locator('#guided-start')).toBeVisible();
 await expect(page.locator('#guided-picker')).toContainText('Browser build not yet verified');
 await expect(page.locator('.guided-question')).toHaveCount(0);
 await page.getByRole('button',{name:'Help me choose / browse all setups'}).click();
 await expect(page.locator('#guided-question')).toBeFocused();
 await page.getByRole('radio',{name:/KDE/}).check();
 await page.locator('.guided-paths button').nth(1).click();
 await expect(page.locator('.guided-chips')).toContainText('KDE');
});
test('review is reversible and does not start an engine',async({page})=>{
 await qualifiedCatalogFixture(page);
 await page.goto('/?variant=sailfin&flavor=xfce&platform=linux%2Famd64');
 await page.locator('#introspect').click();
 await expect(page.locator('#build')).toBeEnabled();
 const before=await page.locator('#image').inputValue();
 await page.locator('#build').click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.locator('#review-back')).toBeFocused();
 await expect(page.locator('#review-apps')).toContainText('not applied');
 await expect(page.locator('#review-target')).toContainText(before);
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toBeHidden();
 await expect(page.locator('#image')).toHaveValue(before);
 await page.locator('#build').click();await page.locator('#review-back').click();
 await expect(page.locator('#image')).toHaveValue(before);
});
test('unknown progress stays indeterminate',async({page})=>{
 await page.goto('/');await page.evaluate(()=>window.tboxOnProgress('resolve',0,0));
 await expect(page.locator('#bar')).not.toHaveAttribute('value');
 await page.evaluate(()=>window.tboxOnProgress('unpack',2,8));
 await expect(page.locator('#bar')).toHaveAttribute('value','2');
 await expect(page.locator('#bar')).toHaveAttribute('max','8');
});
test('desktop and enlarged 320px journey fit without horizontal scroll',async({page})=>{
 fs.mkdirSync('/tmp/iso-ux-screens',{recursive:true});
 await page.goto('/');await page.screenshot({path:'/tmp/iso-ux-screens/p1-desktop.png',fullPage:true});
 await page.setViewportSize({width:320,height:800});
 await page.addStyleTag({content:'html { font-size: 125%; }'});
 await expect(page.locator('.mobile-planning')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'/tmp/iso-ux-screens/p1-mobile.png',fullPage:true});
});
