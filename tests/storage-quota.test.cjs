const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app/public/app.js'),'utf8');
const code=source.slice(source.indexOf('async function checkStorageQuota('),source.indexOf('async function finishIsoSink('));
for(const [name,storage,freeGB,blocked] of [
 ['missing API',{},null,false],
 ['missing quota',{estimate:async()=>({usage:0})},null,false],
 ['rejected estimate',{estimate:async()=>{throw Error('unavailable');}},null,false],
 ['low quota',{estimate:async()=>({quota:3e9,usage:1e9})},2,true],
 ['sufficient estimate',{estimate:async()=>({quota:20e9,usage:1e9})},19,false],
]) test(name,async()=>{
 const context=vm.createContext({navigator:{storage},currentOp:null,MIN_FREE_GB:9.5,log(){},renderFallbackCard(){}});
 vm.runInContext(code,context);
 const actual=await context.checkStorageQuota();assert.equal(actual.freeGB,freeGB);assert.equal(actual.blocked,blocked);
});
