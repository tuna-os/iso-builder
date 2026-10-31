#!/usr/bin/env node
// Import exact bytes from the immutable primary export, never moving main.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {validate}=require('../app/public/builder-config.js');
const args=process.argv.slice(2);
const root=path.join(__dirname,'..');
const destination=path.join(root,'app/public/builder-config.json');
const flavorsPath=path.join(root,'app/public/builder-flavors.json');
const manifestPath=path.join(root,'app/public/builder-config-source.json');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
if(args.includes('--check')) {
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 if(manifest.repository!=='tuna-os/tunaOS'||manifest.path!=='docs/iso-builder.config.json'||!/^[a-f0-9]{40}$/.test(manifest.commit))throw Error('Invalid immutable source receipt');
 const bytes=fs.readFileSync(destination);const config=validate(JSON.parse(bytes));
 if(config.schema_version===2){if(manifest.flavors?.path!=='docs/iso-builder.flavors.json'||digest(fs.readFileSync(flavorsPath))!==manifest.flavors.sha256)throw Error('Primary flavor metadata differs from pinned source receipt');}
 if(digest(bytes)!==manifest.sha256)throw Error('Stock builder config differs from its pinned primary export');
 const input=args.find(a=>!a.startsWith('--'));
 if(input&&!bytes.equals(fs.readFileSync(input)))throw Error('Stock builder config differs from supplied primary export');
} else {
 const input=args[0], index=args.indexOf('--source-commit'), commit=args[index+1];
 if(!input||index<0||!/^[a-f0-9]{40}$/.test(commit||''))throw Error('Usage: node scripts/sync-builder-config.cjs <exported JSON> --source-commit <immutable SHA>, or --check');
 const bytes=fs.readFileSync(input);const config=validate(JSON.parse(bytes));
 const wordmarkIndex=args.indexOf('--wordmark');
 if(config.brand.logo_url==='/wordmark.svg'){
  if(wordmarkIndex<0||!args[wordmarkIndex+1])throw Error('Wordmark import requires --wordmark <primary lettermarks/tunaos.svg>');
  fs.copyFileSync(args[wordmarkIndex+1],path.join(root,'app/public/wordmark.svg'));
 }
 let flavors;
 if(config.schema_version===2){const index=args.indexOf('--flavors');if(index<0||!args[index+1])throw Error('v2 import requires --flavors <primary metadata JSON>');const data=fs.readFileSync(args[index+1]);const doc=JSON.parse(data);if(doc.schema_version!==1||doc.kind!=='builder-flavor-metadata'||!Array.isArray(doc.flavors))throw Error('Invalid primary metadata');flavors={path:'docs/iso-builder.flavors.json',sha256:digest(data)};fs.writeFileSync(flavorsPath,data);}
 fs.writeFileSync(destination,bytes);
 fs.writeFileSync(manifestPath,JSON.stringify({repository:'tuna-os/tunaOS',commit,path:'docs/iso-builder.config.json',sha256:digest(bytes),...(flavors?{flavors}:{})},null,2)+'\n');
}
