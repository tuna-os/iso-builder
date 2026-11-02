const {test,expect}=require('@playwright/test');
test.beforeEach(async({page})=>{
 await page.route('**/wasm_exec.js',r=>r.fulfill({body:''}));await page.route('**/tbox.wasm',r=>r.abort());await page.route('https://**/*',r=>r.abort());
 await page.goto('/');await page.locator('#planning-recovery > summary').click();
});
test('refresh recovery restores supported choices only after explicit action',async({page})=>{
 await page.getByRole('button',{name:'Help me choose / browse all setups'}).click();await page.getByRole('radio',{name:/KDE/}).check();
 await page.locator('#save-plan').click();await expect(page.locator('#plan-status')).toContainText('saved in this tab');
 const stored=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tbox-planning-v1:tunaos')));expect(stored.filters.desktop).toBe('kde');expect(stored.extraRun).toBeUndefined();
 await page.reload();await expect(page.locator('#plan-status')).toContainText('saved plan is available');
 await expect(page.locator('#guided-start')).toBeVisible();
 await page.locator('#restore-plan').click();await expect(page.locator('.guided-chips')).toContainText('KDE');
 await expect(page.locator('#plan-status')).toContainText('Nothing has been built');await expect(page.locator('#build')).toBeDisabled();
 await page.locator('#forget-plan').click();await expect(page.locator('.guided-chips')).toContainText('KDE');
 expect(await page.evaluate(()=>sessionStorage.getItem('tbox-planning-v1:tunaos'))).toBeNull();
});
test('advanced commands never enter the saved plan or get erased by restore',async({page})=>{
 await page.locator('#save-plan').click();
 const before=await page.evaluate(()=>sessionStorage.getItem('tbox-planning-v1:tunaos'));
 await page.evaluate(()=>repoCmds.push('echo intentional-local-command'));
 await page.locator('#save-plan').click();await expect(page.locator('#plan-status')).toContainText('advanced values');
 expect(await page.evaluate(()=>sessionStorage.getItem('tbox-planning-v1:tunaos'))).toBe(before);
 await page.locator('#restore-plan').click();expect(await page.evaluate(()=>repoCmds.slice())).toEqual(['echo intentional-local-command']);
});
test('tampered or stale drafts fail closed without changing the form',async({page})=>{
 await page.locator('#save-plan').click();const image=await page.locator('#image').inputValue();
 await page.evaluate(()=>{const key='tbox-planning-v1:tunaos';const value=JSON.parse(sessionStorage.getItem(key));value.extraRun=['echo injected'];sessionStorage.setItem(key,JSON.stringify(value));});
 await page.locator('#restore-plan').click();await expect(page.locator('#plan-status')).toContainText('invalid');await expect(page.locator('#image')).toHaveValue(image);
 expect(await page.evaluate(()=>repoCmds.slice())).toEqual([]);
});
test('busy operation and unavailable storage leave setup unchanged',async({page})=>{
 await page.evaluate(()=>setOperationBusy(true,'inspect'));await page.locator('#save-plan').click();await expect(page.locator('#plan-status')).toContainText('Finish');
 await page.evaluate(()=>{setOperationBusy(false);Storage.prototype.setItem=()=>{throw new DOMException('Storage unavailable','SecurityError');};});
 await page.locator('#save-plan').click();await expect(page.locator('#plan-status')).toContainText('Storage unavailable');
});
test('hardware guidance opens the existing catalog architecture question',async({page})=>{
 await page.getByText('Find the architecture and hardware requirements',{exact:true}).click();
 await expect(page.locator('#hardware-heading').locator('..')).toContainText('Apple Silicon');
 await page.locator('#choose-architecture').click();await expect(page.locator('#guided-question')).toBeFocused();
 await expect(page.locator('#guided-question legend')).toContainText('architecture');
});
test('catalog desktop preview uses supplied assets and reports an image failure',async({page})=>{
 const config=require('../../app/public/builder-config.json');const copy=structuredClone(config);
 const desktop=copy.selection.facets.find(f=>f.id==='desktop').values.find(v=>v.id==='gnome');
 desktop.card={image_url:'/preview-fixture.svg',image_alt:'Synthetic GNOME preview for UI tests'};
 await page.route('**/builder-config-data.js',r=>r.fulfill({contentType:'text/javascript',body:'globalThis.TBOX_BUILDER_CONFIG='+JSON.stringify(copy)+';'}));
 await page.route('**/preview-fixture.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#20252b"/></svg>'}));
 await page.reload();await expect(page.locator('.desktop-preview img')).toBeVisible();
 await expect(page.locator('.desktop-preview figcaption')).toContainText('not evidence');
 await page.route('**/preview-fixture.svg',r=>r.fulfill({status:503,body:'unavailable'}));await page.reload();
 await expect(page.locator('.desktop-preview')).toContainText('Preview image unavailable');
 await expect(page.locator('.desktop-preview img')).toBeHidden();
});
test('failed upstream artwork remains visible as a failure while preview selection works',async({page})=>{
 // Deliberate local interception: no request to the external image host.
 await page.route('https://projectbluefin.io/characters/*.webp',r=>r.fulfill({status:503,body:'unavailable'}));
 await page.goto('/?experience=bluefin');await expect(page.locator('.preview-unavailable')).toHaveCount(3);
 await page.getByRole('radio',{name:/Classic/}).check();await page.getByRole('button',{name:'Review images',exact:true}).click();
 await expect(page.locator('.guided-leaf')).toContainText('Preview only');await expect(page.locator('#introspect')).toBeDisabled();
});

test('expanded recovery and hardware guidance remain usable at 320px with enlarged text',async({page})=>{
 const fs=require('node:fs');fs.mkdirSync('/tmp/iso-ux-screens',{recursive:true});
 await page.getByText('Find the architecture and hardware requirements',{exact:true}).click();
 await page.screenshot({path:'/tmp/iso-ux-screens/final-desktop.png',fullPage:true});
 await page.setViewportSize({width:320,height:800});await page.addStyleTag({content:'html{font-size:125%}'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'/tmp/iso-ux-screens/final-mobile.png',fullPage:true});
 await page.locator('#planning-recovery').screenshot({path:'/tmp/iso-ux-screens/final-recovery.png'});
});
test('restoring a preview plan never restores risk acknowledgements',async({page})=>{
 await page.goto('/?experience=bazzite');
 await page.getByRole('radio',{name:/Home theater/}).check();await page.locator('.guided-next').click();
 await page.getByRole('radio',{name:/NVIDIA/}).check();await page.locator('.guided-next').click();
 await page.getByRole('radio',{name:/GNOME/}).check();await page.locator('.guided-next').click();
 await page.locator('.guided-ack input').check();await page.locator('.guided-use').click();
 expect(await page.evaluate(()=>Boolean(guidedPicker.getSelection()))).toBe(true);
 await page.locator('#planning-recovery > summary').click();await page.locator('#save-plan').click();
 await expect(page.locator('#plan-status')).toContainText('saved in this tab');
 await page.locator('#restore-plan').click();
 expect(await page.evaluate(()=>guidedPicker.getSelection())).toBeNull();
 await expect(page.locator('#introspect')).toBeDisabled();
});
