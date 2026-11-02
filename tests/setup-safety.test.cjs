const test=require('node:test');
const assert=require('node:assert/strict');
const {assertPortable}=require('../app/public/setup-safety');
test('public configuration is preserved exactly',()=>{
 const config={image:'ghcr.io/tuna-os/yellowfin:gnome',registry:'https://relay.tunaos.org',options:{extraRun:['dnf -y copr enable atim/starship']}};
 assert.equal(assertPortable(config),config);
});
for(const value of ['https://user:password@example.org/path','https://example.org/path?signed=abcdef','https://example.org/#credential','-----BEGIN OPENSSH PRIVATE KEY-----','TOKEN=abc','Authorization: Bearer abc']) {
 test('reject secret-bearing portable value '+value.split(':')[0],()=>assert.throws(()=>assertPortable({nested:[value]})));
}
