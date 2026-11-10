const {test,expect}=require('@playwright/test');
require('./legacy-deployment').useLegacyDeployment(test);
async function inspect(page,ids,image='bonito:gnome') {
 await page.evaluate(ids=>{ window.loadWasm=async()=>{}; window.tboxIntrospect=async()=>JSON.stringify({desktop:'gnome',suggestedFlatpaks:ids}); },ids);
 await page.locator('#image').fill(image); await page.locator('#introspect').click();
 await expect(page.locator('#fpdefaults-restore')).toBeEnabled();
}
test.beforeEach(async({page})=>{
 await page.route('**/api/v2/search',r=>r.fulfill({json:{hits:[]}}));
 await page.goto('/?customize=1'); await page.getByText('Use a custom container image').click();
 await page.locator('#apps-options > summary').click();
});
test('inspected defaults prefill, custom none persists, and changed targets offer reset',async({page})=>{
 await inspect(page,['org.example.Alpha']);
 await expect(page.locator('#fplist input:checked')).toHaveCount(1);
 await expect(page.locator('#fpdefaults-status')).toContainText('image inspection');
 await page.locator('#fpnone').click(); await inspect(page,['org.example.Alpha']);
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
 await inspect(page,['org.example.Beta'],'bonito:kde');
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
 await page.locator('#fpdefaults-restore').click();
 await expect(page.locator('#fplist')).toContainText('org.example.Beta');
 await expect(page.locator('#fproles')).toContainText('coverage is unknown');
 await page.locator('#fpnone').click();
 await page.locator('#image').fill('bonito:xfce');
 await expect(page.locator('#fpdefaults-restore')).toBeDisabled();
 await page.evaluate(()=>document.getElementById('fpdefaults-restore').dispatchEvent(new Event('click')));
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
});
test('an explicit empty share list is preserved',async({page})=>{
 await page.goto('/?image=bonito:gnome&flatpaks=');
 await page.locator('#apps-options > summary').click();
 await page.evaluate(()=>{window.loadWasm=async()=>{};window.tboxIntrospect=async()=>JSON.stringify({desktop:'gnome',suggestedFlatpaks:['org.example.Alpha']});});
 await page.locator('#introspect').click();
 await expect(page.locator('#fpdefaults-restore')).toBeEnabled();
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
 await expect(page.locator('#sharelink')).toHaveAttribute('href',/flatpaks=/);
});
test('stale inspect cannot replace defaults or enable restore',async({page})=>{
 await page.evaluate(()=>{window.loadWasm=async()=>{};window.tboxIntrospect=()=>new Promise(r=>window.finishInspect=r);});
 await page.locator('#image').fill('bonito:gnome'); await page.locator('#introspect').click();
 await expect.poll(()=>page.evaluate(()=>typeof window.finishInspect)).toBe('function');
 await page.evaluate(()=>{document.getElementById('image').value='bonito:kde';window.finishInspect(JSON.stringify({desktop:'gnome',suggestedFlatpaks:['org.example.Old']}));});
 await expect(page.locator('#introspect')).toBeEnabled();
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
 await expect(page.locator('#fpdefaults-restore')).toBeDisabled();
});
test('deployment suggestions are labelled and restore cannot run while checking',async({page})=>{
 await page.evaluate(()=>{window.loadWasm=async()=>{};window.tboxIntrospect=async()=>JSON.stringify({desktop:'gnome'});});
 await page.locator('#image').fill('bonito:gnome'); await page.locator('#introspect').click();
 await expect(page.locator('#fpdefaults-restore')).toHaveText('Use deployment suggestions');
 await expect(page.locator('#fpdefaults-status')).toContainText('configuration declaration');
 await page.locator('#fpnone').click();
 await page.evaluate(()=>{window.tboxIntrospect=()=>new Promise(r=>window.finishInspect=r);});
 await page.locator('#introspect').click();
 await expect.poll(()=>page.evaluate(()=>typeof window.finishInspect)).toBe('function');
 await expect(page.locator('#fpdefaults-restore')).toBeDisabled();
 await page.evaluate(()=>document.getElementById('fpdefaults-restore').dispatchEvent(new Event('click')));
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
 await page.evaluate(()=>window.finishInspect(JSON.stringify({desktop:'gnome',suggestedFlatpaks:['org.example.New']})));
 await expect(page.locator('#fpdefaults-restore')).toBeEnabled();
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
});
test('missing defaults support fails with a visible message',async({page})=>{
 await page.route('**/flatpak-defaults.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
 await page.goto('/?customize=1');
 await expect(page.locator('main[role="alert"]')).toContainText('configuration is missing or invalid');
});

test('edits made during inspection survive its reply',async({page})=>{
 await inspect(page,['org.example.Alpha']);
 await page.evaluate(()=>{window.tboxIntrospect=()=>new Promise(r=>window.finishInspect=r);});
 await page.locator('#introspect').click();
 await expect.poll(()=>page.evaluate(()=>typeof window.finishInspect)).toBe('function');
 await page.locator('#fplist input').uncheck();
 await page.evaluate(()=>window.finishInspect(JSON.stringify({desktop:'gnome',suggestedFlatpaks:['org.example.New']})));
 await expect(page.locator('#fpdefaults-restore')).toBeEnabled();
 await expect(page.locator('#fplist input:checked')).toHaveCount(0);
});
