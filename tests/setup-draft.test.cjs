const test=require('node:test'),assert=require('node:assert/strict');
const draft=require('../app/public/setup-draft');
const catalog=require('../app/public/guided-catalog');
const {validFlatpakId}=require('../app/public/builder-config');
const config=require('../app/public/builder-config.json');
const metadata=require('../app/public/builder-flavors.json');
const model=catalog.createModel(require('../app/public/guided-catalog.json'),require('../app/public/catalog-snapshot.json'),config,{flavorMetadata:Object.fromEntries(metadata.flavors.map(item=>[item.id,{desktop:item.desktop,edition:item.edition}])),isOffered:e=>Boolean(e.scheduled||e.availability?.available)});
const context={model,experience:'tunaos',catalog,validFlatpakId};
const value=()=>({version:1,experience:'tunaos',catalogId:model.catalogId,snapshotDigest:model.snapshotDigest,pathId:model.defaultPath,filters:{desktop:'gnome'},leafId:'yellowfin:gnome:linux/amd64/v2',flatpaks:['org.mozilla.firefox'],packages:['vim'],label:'TUNAOS'});
test('restores only validated catalog choices without a receipt',()=>{
 const result=draft.parse(JSON.stringify(value()),context);assert.equal(result.state.selectedLeafId,value().leafId);assert.deepEqual(result.state.filters,{desktop:'gnome'});assert.equal(result.value.ready,undefined);assert.equal(result.value.buildResult,undefined);
});
for(const [name,edit]of [
 ['schema',v=>v.version=2],['experience',v=>v.experience='bluefin'],['stale catalog',v=>v.snapshotDigest='sha256:'+'0'.repeat(64)],
 ['command injection',v=>v.extraRun=['touch /tmp/x']],['unknown field',v=>v.token='secret'],['missing field',v=>delete v.packages],
 ['unknown image',v=>v.leafId='missing'],['incompatible leaf',v=>v.filters.desktop='kde'],['invalid facet',v=>v.filters.platform='unknown'],
 ['flatpak command',v=>v.flatpaks=['org.example.App;echo x']],['package command',v=>v.packages=['vim;echo x']],['secret label',v=>v.label='TOKEN=secret'],
 ['raw filters',v=>v.filters='code'],['too many apps',v=>v.flatpaks=Array(101).fill('org.mozilla.firefox')],['duplicate apps',v=>v.flatpaks.push('org.mozilla.firefox')],
])test('rejects '+name+' without mutating input',()=>{const v=value();edit(v);const before=JSON.stringify(v);assert.throws(()=>draft.validate(v,context));assert.equal(JSON.stringify(v),before);});
test('bounds document size before parsing',()=>assert.throws(()=>draft.parse(' '.repeat(32769),context)));
test('incomplete planning keeps selected leaf empty',()=>{const v=value();v.leafId=null;assert.equal(draft.validate(v,context).state.selectedLeafId,null);});
