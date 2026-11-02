/* Tab-local planning state. Never a configuration document or build receipt. */
(function(root) {
  'use strict';
  const MAX_BYTES=32768;
  function validate(value,{model,experience,catalog,validFlatpakId}) {
    const keys=['version','experience','catalogId','snapshotDigest','pathId','filters','leafId','flatpaks','packages','label'];
    const fail=()=>{throw new Error('Saved planning choices are invalid or no longer match this catalog. Keep your current setup or forget the saved plan.');};
    if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();
    if(value.version!==1||value.experience!==experience||value.catalogId!==model.catalogId||value.snapshotDigest!==model.snapshotDigest)fail();
    if(!model.paths.some(path=>path.id===value.pathId)||!value.filters||Array.isArray(value.filters)||typeof value.filters!=='object'||Object.keys(value.filters).length>10)fail();
    let state={...catalog.initialState(model),selectedLeafId:null,origin:null,unavailable:null};
    for(const [facet,choice]of Object.entries(value.filters)){
      if(typeof choice!=='string'||!model.facetPresentation[facet]?.values.some(item=>item.id===choice))fail();
      const result=catalog.chooseFacet(model,state,facet,choice);if(!result.ok)fail();state=result.state;
    }
    state=catalog.changePath(model,state,value.pathId).state;
    if(value.leafId!==null){if(typeof value.leafId!=='string')fail();const result=catalog.selectLeaf(model,state,value.leafId);if(!result.ok)fail();state=result.state;}
    const list=(items,check)=>{if(!Array.isArray(items)||items.length>100||new Set(items).size!==items.length||items.some(item=>typeof item!=='string'||item.length>255||!check(item)))fail();};
    list(value.flatpaks,validFlatpakId);
    list(value.packages,item=>/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(item));
    if(typeof value.label!=='string'||!/^[A-Z0-9_]{1,32}$/.test(value.label))fail();
    return {value:JSON.parse(JSON.stringify(value)),state};
  }
  function parse(text,context){if(typeof text!=='string'||text.length>MAX_BYTES)throw new Error('Saved plan is too large. Forget it and keep your current setup.');return validate(JSON.parse(text),context);}
  const api=Object.freeze({validate,parse,MAX_BYTES});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.TboxSetupDraft=api;
})(globalThis);
