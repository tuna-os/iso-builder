/* Fixed, generated deployment allowlist. A query supplies an ID, never a URL. */
(function(root){
 'use strict';
 const manifest=root.TBOX_EXPERIENCES;
 if(!manifest||manifest.schema_version!==1||!Array.isArray(manifest.experiences))throw Error('Missing deployment experiences');
 const defaults={config:root.TBOX_BUILDER_CONFIG,catalog:root.TBOX_GUIDED_CATALOG,flavorMetadata:root.TBOX_FLAVOR_METADATA};
 const entries=manifest.experiences.map(entry=>({id:entry.id,...(entry.use_default_assets?defaults:{config:entry.config,catalog:entry.catalog,flavorMetadata:{}})}));
 const requested=new URLSearchParams(location.search).get('experience');
 const selected=entries.find(e=>e.id===requested)||entries.find(e=>e.id===manifest.default_id);
 if(!selected)throw Error('Missing default experience');
 root.TBOX_BUILDER_CONFIG=selected.config;root.TBOX_GUIDED_CATALOG=selected.catalog;root.TBOX_FLAVOR_METADATA=selected.flavorMetadata;
 root.TboxExperiences=Object.freeze({id:selected.id,defaultId:manifest.default_id,entries:Object.freeze(entries.map(e=>Object.freeze({id:e.id,name:e.config?.brand?.name || "Experience",previewOnly:Boolean(e.config?.preview_only)}))),
  target(id){if(!entries.some(e=>e.id===id))return null;const url=new URL(location.href);url.search='';url.hash='';if(id!==manifest.default_id)url.searchParams.set('experience',id);return url.href;}
 });
})(globalThis);
