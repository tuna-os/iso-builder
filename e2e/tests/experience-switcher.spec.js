const {test,expect}=require('@playwright/test');
// This suite tests local UI state, not upstream services or artwork health.
test.beforeEach(async({page})=>{await page.route('https://**/*',r=>r.abort());});
test('fresh and unknown experiences default to deployment default',async({page})=>{
 await page.goto('/?experience=https://untrusted.example/config.json');await expect(page.locator('#experience')).toHaveValue('tunaos');await expect(page).toHaveTitle('TunaOS ISO Builder');
 await expect(page.getByText('These requests are not yet applied to the live image or installed system.',{exact:false})).toBeVisible();
});
test('switching starts a clean preview setup and drops all prior URL overrides',async({page})=>{
 await page.goto('/?image=yellowfin:gnome&flatpaks=org.mozilla.firefox&label=OLD');
 await page.locator('#experience').selectOption('bluefin');await expect(page).toHaveURL(/\?experience=bluefin$/);await expect(page).toHaveTitle('Bluefin ISO Builder');
 await expect(page.locator('#label')).toHaveValue('BLUEFIN_DEMO');await expect(page.locator('#image')).toHaveValue('');await expect(page.locator('#fplist')).toBeEmpty();await expect(page.locator('#introspect')).toBeDisabled();await expect(page.locator('#buildcard')).toBeHidden();
 await page.locator('#experience').selectOption('bazzite');await expect(page).toHaveTitle('Bazzite ISO Builder');await expect(page.locator('.guided-question')).toContainText('device');
 await page.goBack();await expect(page).toHaveTitle('Bluefin ISO Builder');await expect(page.locator('#image')).toHaveValue('');await expect(page.locator('#buildcard')).toBeHidden();
});
test('busy operation disables switching and handler refuses forged change',async({page})=>{
 await page.goto('/');await page.evaluate(()=>window.setOperationBusy(true,'inspect'));await expect(page.locator('#experience')).toBeDisabled();
 await page.evaluate(()=>{const e=document.querySelector('#experience');e.value='bluefin';e.dispatchEvent(new Event('change'));});await expect(page.locator('#experience')).toHaveValue('tunaos');await expect(page).toHaveTitle('TunaOS ISO Builder');
 await page.evaluate(()=>window.setOperationBusy(false));await expect(page.locator('#experience')).toBeEnabled();
});
test('Bluefin shows Classic Dakota and Utah cards with truthful status',async({page})=>{
 await page.goto('/?experience=bluefin');
 for(const name of ['Classic','Dakota','Utah'])await expect(page.getByRole('radio',{name:new RegExp(name)})).toBeVisible();
 await expect(page.locator('.guided-card-badge')).toContainText(['For everyone','Alpha','Coming soon']);
 await page.getByRole('radio',{name:/Utah/}).check();await page.getByRole('button',{name:'Review images',exact:true}).click();await expect(page.locator('.guided-leaf')).toContainText('testing');await expect(page.locator('.guided-leaf')).toContainText('Preview only');await expect(page.locator('#introspect')).toBeDisabled();
});
test('Bazzite handheld skips graphics and HTPC Nvidia asks for beta acknowledgement',async({page})=>{
 await page.goto('/?experience=bazzite');await page.getByRole('radio',{name:/Handheld/}).check();await page.locator('.guided-next').click();await expect(page.locator('.guided-question legend')).toHaveText('Choose your desktop');
 await page.goto('/?experience=bazzite');await page.getByRole('radio',{name:/Home theater/}).check();await page.locator('.guided-next').click();await page.getByRole('radio',{name:/NVIDIA/}).check();await page.locator('.guided-next').click();await page.getByRole('radio',{name:/GNOME/}).check();await page.locator('.guided-next').click();
 await expect(page.locator('.guided-leaf')).toContainText('bazzite-deck-nvidia-gnome');await expect(page.locator('.guided-use')).toBeDisabled();await page.locator('.guided-ack input').check();await expect(page.locator('.guided-use')).toBeEnabled();await page.locator('.guided-use').click();await expect(page.locator('#guided-selection-summary')).toBeVisible();await expect(page.locator('#introspect')).toBeDisabled();await page.locator('.guided-ack input').uncheck();await expect(page.locator('#guided-selection-summary')).toHaveCount(0);expect(await page.evaluate(()=>guidedPicker.getSelection())).toBeNull();await expect(page.locator('.guided-use')).toBeDisabled();
});
test('branded card layouts with local fixture artwork at desktop and mobile',async({page})=>{
 const fs=require('node:fs'),path=require('node:path');const dir=path.join(__dirname,'../screenshots');fs.mkdirSync(dir,{recursive:true});
 for(const name of ['bluefin','bazzite']){
  // Exercise the real layout with explicit fixtures, not remote artwork health.
  const config=require(`../../examples/${name}/builder-config.json`);
  for(const facet of config.selection.facets)for(const value of facet.values)if(value.card){
   await page.route(value.card.image_url,r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#31445a"/><text x="32" y="240" fill="white" font-size="24">Local artwork fixture</text></svg>'}));
  }
  await page.setViewportSize({width:1280,height:900});await page.goto(`/?experience=${name}`);await page.evaluate(()=>document.fonts.ready);
  await expect.poll(()=>page.locator('.guided-art-card img').evaluateAll(images=>images.every(i=>i.complete&&i.naturalWidth>0))).toBe(true);
  await page.screenshot({path:path.join(dir,`guided-${name}-fixture-cards-desktop.png`),fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:path.join(dir,`guided-${name}-fixture-cards-mobile.png`),fullPage:true});
 }
});
for(const asset of ['experience-data.js','experiences.js'])test(`missing ${asset} fails closed before a preview can fall back to stock`,async({page})=>{
 const actions=[];page.on('request',r=>{if(/tbox\.wasm|\/v2\//.test(r.url()))actions.push(r.url());});
 await page.route(`**/${asset}`,r=>r.abort());await page.goto('/?experience=bluefin&autorun=1');await expect(page.locator('main')).toHaveAttribute('role','alert');await expect(page.locator('#introspect')).toHaveCount(0);expect(actions).toEqual([]);
});
test('malformed experience bundle fails closed',async({page})=>{
 await page.route('**/experience-data.js',r=>r.fulfill({body:'globalThis.TBOX_EXPERIENCES={schema_version:999};',contentType:'text/javascript'}));await page.goto('/?experience=bazzite');await expect(page.locator('main')).toHaveAttribute('role','alert');await expect(page.locator('#introspect')).toHaveCount(0);
});
