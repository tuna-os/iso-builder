const {test,expect}=require('@playwright/test');
require('./legacy-deployment').useLegacyDeployment(test);
const fs=require('node:fs');
const path=require('node:path');
const child=require('node:child_process');
const {validate,variants}=require('../../app/public/builder-config.js');
const root=path.join(__dirname,'../..');
const stock=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/guided/legacy-config-v1.json')));
const snapshot=JSON.parse(fs.readFileSync(path.join(root,'app/public/catalog-snapshot.json')));
const copy=v=>JSON.parse(JSON.stringify(v));
const dataScript=c=>'globalThis.TBOX_BUILDER_CONFIG = '+JSON.stringify(c)+';';

test('stock runtime projection has no drift and choices intersect catalog',()=>{
  child.execFileSync(process.execPath,[path.join(root,'scripts/generate-builder-config.cjs'),'--check']);
  const config=validate(copy(stock));
  expect(Object.isFrozen(config.desktops[0])).toBe(true);
  expect(variants(config,snapshot).find(v=>v.id==='yellowfin').des).toContain('gnome');
  const reduced=copy(snapshot); reduced.targets=[];
  expect(variants(config,reduced)).toEqual([]);
});
for(const [name,edit] of [
  ['unknown fields',c=>c.rogue=true],['wrong version',c=>c.schema_version=2],
  ['unsafe link',c=>c.brand.homepage_url='javascript:alert(1)'],
  ['external protocol-relative asset',c=>c.brand.logo_url='//tracker.test/icon'],
  ['traversal asset',c=>c.brand.logo_url='/../private'],
  ['numeric label',c=>c.output.volume_label=123],
  ['numeric filename',c=>c.output.filename_prefix=123],
  ['invalid filename',c=>c.output.filename_prefix='../escape'],
  ['unknown default',c=>c.default_selection.flavor='not-configured'],
  ['duplicate desktop',c=>c.desktops.push(copy(c.desktops[0]))],
  ['unlabeled preview',c=>{c.preview_only=true;delete c.brand.disclaimer;}],
]) test(`invalid deployment config rejects ${name}`,()=>{
 const config=copy(stock);edit(config);expect(()=>validate(config)).toThrow();
});

test('alternate catalog brand/default uses only configured choices',async({page})=>{
 const config=copy(stock); config.brand={name:'Example Workshop',homepage_url:'https://example.org',documentation_url:'https://example.org/docs'};
 config.presentation.headline='Build your workshop image';config.variants=config.variants.filter(v=>v.id==='bonito');
 config.desktops=config.desktops.filter(d=>d.id==='kde');config.curated_app_sets=[];config.ddi_channels=[];
 config.default_selection={kind:'catalog',variant:'bonito',flavor:'kde',platform:'linux/amd64'};
 config.output={volume_label:'WORKSHOP',filename_prefix:'workshop'};
 validate(config);
 await page.route('**/builder-config-data.js',r=>r.fulfill({contentType:'text/javascript',body:dataScript(config)}));
 await page.goto('/');
 await expect(page).toHaveTitle('Example Workshop ISO Builder');
 await expect(page.locator('#editions .edition')).toHaveCount(1);
 await expect(page.locator('#image')).toHaveValue('bonito:kde');
 await expect(page.locator('#label')).toHaveValue('WORKSHOP');
 await expect(page.locator('.site-header img')).toHaveCount(0);
 await expect(page.locator('.site-header .brand')).toHaveText('Example Workshop');
 await expect(page.locator('link[rel=icon]')).toHaveCount(0);
 expect(await page.evaluate(()=>window.tboxGetBuildRequest().options.outputFilename)).toMatch(/^workshop-/);
});

for(const name of ['bluefin','bazzite']) test(`${name} config uses the same UI and cannot execute image actions`,async({page})=>{
 const config=validate(JSON.parse(fs.readFileSync(path.join(root,`examples/${name}/builder-config.json`))));
 const remote=[];
 page.on('request',r=>{if(/\/v2\/|tbox\.wasm|ddi.*json/.test(r.url())) remote.push(r.url());});
 await page.goto(`/?experience=${name}&autorun=1`);
 await expect(page).toHaveTitle(`${config.brand.name} ISO Builder`);
 await expect(page.locator('h1')).toHaveText(config.presentation.headline);
 await expect(page.locator('#builder-disclaimer')).toContainText('Unofficial');
 await expect(page.locator('#image')).toHaveValue('');
 await expect(page.locator('#guided-picker')).toBeVisible();
 await expect(page.locator('#introspect')).toBeDisabled();
 await expect(page.locator('.site-header img')).toHaveCount(config.brand.logo_url?1:0);
 // A wordmark carries the name: it replaces the header text, and its alt keeps the accessible name.
 await expect(page.locator('.site-header .brand')).toHaveText(config.brand.logo_url?'':config.brand.name);
 await expect(page.locator('.site-header .brand')).toHaveAccessibleName(config.brand.name);
 await expect(page.locator('link[rel=icon]')).toHaveCount(0);
 await page.evaluate(async()=>{await window.inspect();await window.build();await window.buildDdi({});window.prepareDdi({});});
 expect(remote).toEqual([]);
 await expect(page.locator('#buildcard')).toBeHidden();
 const dir=path.join(root,'e2e/screenshots');fs.mkdirSync(dir,{recursive:true});
 await page.screenshot({path:path.join(dir,`config-${name}-desktop.png`),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:path.join(dir,`config-${name}-mobile.png`),fullPage:true});
});

test('invalid runtime config shows error and does not initialize a stock builder',async({page})=>{
 await page.route('**/builder-config-data.js',r=>r.fulfill({contentType:'text/javascript',body:dataScript({schema_version:999})}));
 await page.goto('/');
 await expect(page.locator('main')).toHaveAttribute('role','alert');
 await expect(page.locator('main')).toContainText('configuration is missing or invalid');
 await expect(page.locator('#introspect')).toHaveCount(0);
});

test('catalog updates remove unoffered configured choices and clear the selected image',async({page})=>{
 await page.goto('/');
 await expect(page.locator('#image')).toHaveValue('yellowfin:gnome');
 await page.evaluate(()=>{const snapshot=structuredClone(window.tboxGetCatalogSnapshot());snapshot.targets=[];window.tboxSetCatalogSnapshot(snapshot);});
 await expect(page.locator('#editions .edition')).toHaveCount(0);
 await expect(page.locator('#image')).toHaveValue('');
 await expect(page.locator('#introspect')).toBeDisabled();
 await expect(page.locator('#selection-summary')).toContainText('No image is selected');
});

 test('configured v3 image platform is preserved',async({page})=>{
 const config=copy(stock);config.default_selection={kind:'image',image:'ghcr.io/example/project:stable',platform:'linux/amd64/v3'};
 await page.route('**/builder-config-data.js',r=>r.fulfill({contentType:'text/javascript',body:dataScript(config)}));
 await page.goto('/');await expect(page.locator('#platform')).toHaveValue('linux/amd64/v3');
 expect(await page.evaluate(()=>currentPlatform())).toBe('linux/amd64/v3');
 });

 test('fetched catalog cannot leave a removed default offered as a custom image',async({page})=>{
 const reduced=copy(snapshot);reduced.targets=reduced.targets.filter(e=>!(e.target?.variant==='yellowfin'&&e.target?.flavor==='gnome'));
 await page.route('**/catalog-snapshot.json',r=>r.fulfill({json:reduced}));await page.goto('/');
 await expect(page.locator('#image')).toHaveValue('');
 await expect(page.locator('#editions .edition[data-de="gnome"]')).toHaveCount(0);
 await expect(page.locator('#introspect')).toBeDisabled();
 });

 test('inspection waits for catalog and rejects a removed selection before engine load',async({page})=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const reduced=copy(snapshot);reduced.targets=reduced.targets.filter(e=>!(e.target?.variant==='yellowfin'&&e.target?.flavor==='gnome'));
 await page.route('**/catalog-snapshot.json',async r=>{await gate;await r.fulfill({json:reduced});});
 let engineRequests=0;await page.route('**/tbox.wasm',r=>{engineRequests++;return r.abort();});
 await page.goto('/',{waitUntil:'domcontentloaded'});
 await page.locator('#introspect').click();release();
 await expect(page.locator('#log')).toContainText('no longer available');
 expect(engineRequests).toBe(0);await expect(page.locator('#build')).toBeDisabled();
 await expect(page.locator('#introspect')).toBeDisabled();
 await page.locator('#base-options > summary').click();
 await page.locator('#variant').selectOption('ddi:snowfield');
 await page.locator('#editions .edition').click();
 await expect(page.locator('#introspect')).toBeEnabled();
 });

 test('explicit unqualified platform retains its catalog identity after refresh',async({page})=>{
 test.setTimeout(30_000);
 await page.goto('/?variant=yellowfin&flavor=gnome&platform=linux%2Farm64');
 await page.evaluate(()=>loadCatalogSnapshot());
 await expect(page.locator('#image')).toHaveValue('yellowfin:gnome');
 await expect(page.locator('#introspect')).toBeEnabled();
 const request=await page.evaluate(()=>window.tboxGetBuildRequest());
 expect(request.customImage).toBe(false);
 expect(request.target).toMatchObject({variant:'yellowfin',flavor:'gnome',platform:'linux/arm64'});
 expect(request.qualificationId).toBeUndefined();
 });

 test('automatic default still clears when its fetched catalog record is no longer admitted',async({page})=>{
 const reduced=copy(snapshot);
 for(const e of reduced.targets)if(e.target?.variant==='yellowfin'&&e.target?.flavor==='gnome'&&e.target?.platform==='linux/amd64/v2'){e.scheduled=false;e.availability={available:false};}
 await page.route('**/catalog-snapshot.json',r=>r.fulfill({json:reduced}));await page.goto('/');
 await expect(page.locator('#image')).toHaveValue('');await expect(page.locator('#introspect')).toBeDisabled();
 });
