const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Slice the canonical-ref block out of app.js (browser globals unavailable in
// node); the block is self-contained by construction.
const source=fs.readFileSync(path.join(__dirname,'../app/public/app.js'),'utf8');
const block=source.slice(source.indexOf('// The default relay fronts ghcr.io'),source.indexOf('// ── Image picker'));
assert.ok(block.includes('function canonicalInstallRef(')&&block.includes('function sameImageRef('));
const context={};
vm.createContext(context);
vm.runInContext(block,context);
const {canonicalInstallRef,sameImageRef}=context;

test('relay default matches the SHIM initializer it must shadow',()=>{
  const init=source.match(/let SHIM = "([^"]+)"/);
  const pinned=source.match(/const DEFAULT_RELAY = "([^"]+)"/);
  assert.ok(init&&pinned);
  assert.equal(pinned[1],init[1]);
});

for (const [raw,registry,image,want] of [
  ['tuna-os/skipjack:gnome','https://relay.tunaos.org','tuna-os/skipjack:gnome','ghcr.io/tuna-os/skipjack:gnome'],
  ['ghcr.io/tuna-os/skipjack:gnome','https://relay.tunaos.org','tuna-os/skipjack:gnome','ghcr.io/tuna-os/skipjack:gnome'],
  ['skipjack:gnome','https://relay.tunaos.org','tuna-os/skipjack:gnome','ghcr.io/tuna-os/skipjack:gnome'],
  ['quay.io/example/os:stable','https://quay.io','example/os:stable','quay.io/example/os:stable'],
  ['registry.example.org:5000/a/b:c','https://registry.example.org:5000','a/b:c','registry.example.org:5000/a/b:c'],
  ['tuna-os/skipjack:gnome','https://relay.example.org','tuna-os/skipjack:gnome','tuna-os/skipjack:gnome'],
  ['  tuna-os/x:y  ','https://relay.tunaos.org','tuna-os/x:y','ghcr.io/tuna-os/x:y'],
]) test(`canonical ${JSON.stringify(raw)} via ${registry}`,()=>{
  assert.equal(canonicalInstallRef(raw,registry,image),want);
});

for (const [a,b,want] of [
  ['ghcr.io/tuna-os/x:y','tuna-os/x:y',true],
  ['tuna-os/x:y','ghcr.io/tuna-os/x:y',true],
  ['tuna-os/x:y','tuna-os/x:y',true],
  ['ghcr.io/tuna-os/x:y','ghcr.io/tuna-os/x:y',true],
  ['tuna-os/x:y','tuna-os/z:y',false],
  ['quay.io/a:b','tuna-os/a:b',false],
  ['','tuna-os/x:y',false],
]) test(`sameImageRef ${JSON.stringify(a)} ${JSON.stringify(b)}`,()=>{
  assert.equal(sameImageRef(a,b),want);
});
