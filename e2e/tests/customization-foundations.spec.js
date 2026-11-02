const {test,expect}=require('@playwright/test');
test.beforeEach(async({page})=>{
 await page.route('**/wasm_exec.js',r=>r.fulfill({body:''}));
 await page.route('**/tbox.wasm',r=>r.abort());
 await page.route('https://**/*',r=>r.abort());
 await page.goto('/');
 await page.locator('#advanced-options > summary').click();
 await page.getByText('Add a repository or setup command',{exact:true}).click();
});
test('repository addition requires explicit trust and retains existing commands',async({page})=>{
 await page.locator('#reporef').fill('atim/starship');await page.locator('#addrepo').click();
 await expect(page.locator('#repo-error')).toContainText('Confirm');
 await expect(page.locator('#repo-trust')).toBeFocused();
 await expect(page.locator('#repolist')).toBeEmpty();
 await page.locator('#repo-trust').check();await page.locator('#addrepo').click();
 await expect(page.locator('#repolist')).toContainText('dnf -y copr enable atim/starship');
 await expect(page.locator('#repo-trust')).not.toBeChecked();
 await page.locator('#reporef').fill('other/project');await page.locator('#repo-trust').check();
 await page.locator('#reporef').fill('changed/project');
 await expect(page.locator('#repo-trust')).not.toBeChecked();
 const request=await page.evaluate(()=>JSON.parse(window.tboxExportBuildRequestJSON()));
 expect(request.options.extraRun).toEqual(['dnf -y copr enable atim/starship']);
 await page.getByRole('button',{name:'Remove setup command 1',exact:true}).click();
 await expect(page.locator('#repolist')).toBeEmpty();
});
test('secret-bearing commands and repository shell syntax are rejected',async({page})=>{
 await page.locator('#repokind').selectOption('raw');
 await page.locator('#reporef').fill('curl https://user:password@example.org/file');
 await page.locator('#repo-trust').check();await page.locator('#addrepo').click();
 await expect(page.locator('#repo-error')).toContainText('credentials');
 await expect(page.locator('#repolist')).toBeEmpty();
 await page.locator('#repokind').selectOption('copr');await page.locator('#reporef').fill('owner/repo; echo injected');
 await page.locator('#repo-trust').check();await page.locator('#addrepo').click();
 await expect(page.locator('#repo-error')).toContainText('shell syntax');
});
test('sharing excludes trust-sensitive overrides and documents incomplete transport',async({page})=>{
 await page.evaluate(()=>{document.querySelector('#initrdurl').value='https://example.org/boot?token=secret';updateShare();});
 await expect(page.locator('#sharelink')).not.toHaveAttribute('href',/token|initrd/);
 await page.getByText('Configuration source (TOML)',{exact:true}).click();
 await expect(page.locator('#advanced-options')).toContainText('not a complete TOML editor');
 await page.locator('.share-options > summary').click();
 await expect(page.locator('.share-options')).toContainText('excludes setup commands');
});

test('Bluefin writer policy links its official guidance while remaining preview-only',async({page})=>{
 await page.goto('/?experience=bluefin');
 await page.getByText('Installation and USB writer guidance',{exact:true}).click();
 await expect(page.locator('#writer-policy')).toContainText('Ventoy is unsupported');
 await expect(page.locator('#installation-guide')).toHaveAttribute('href','https://docs.projectbluefin.io/installation/');
 await expect(page.locator('#introspect')).toBeDisabled();
});
