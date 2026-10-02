'use strict';
// Operator-only import of the already inspected private package. No provider calls.
// Output stays outside the public repository. Does not alter original evidence.
const fs=require('fs'),path=require('path');
const {hash,need}=require('./evidence');
function registerIMG5684(packageDir,runRoot,registryPath){
 const id='IMG5684',dir=path.join(runRoot,id);need(!fs.existsSync(dir),'RUN_ALREADY_EXISTS');fs.mkdirSync(dir,{recursive:true});
 const save=(name,bytes)=>{fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx'});return {path:name,sha256:hash(bytes)};};
 const copy=name=>save(name,fs.readFileSync(path.join(packageDir,name)));
 const source=copy('PRODUCT_TRUTH.png'),assessment=copy('IMG5684_SOURCE_SUFFICIENCY_FRONT_HERO.json');
 const a=JSON.parse(fs.readFileSync(path.join(dir,assessment.path))),locks={};for(const k of Object.keys(a.lock_hashes)){locks[k]=copy(k);need(locks[k].sha256===a.lock_hashes[k],'LOCK_HASH_MISMATCH');}
 const macro=JSON.parse(fs.readFileSync(path.join(dir,'IMG5684_MACRO_IDENTITY_LOCK.json'))),micro=JSON.parse(fs.readFileSync(path.join(dir,'IMG5684_MICRO_SETTING_LOCK.json')));
 for(const r of Object.values(micro.shape_authority)){const x=copy(r.path);need(x.sha256===r.sha256,'PATCH_HASH_MISMATCH');}
 const truth={id:'IMG5684_PRODUCT_TRUTH',version:'1.0.0-evidence-import',sku_id:id,category:'earring',source_asset_id:macro.source_drive_id,source_sha256:source.sha256,originality:macro.originality,existing_view:macro.existing_view,target_view:macro.missing_view,micro_applicable:true,finish_id:'gleor_champagne_rose_v1',finish_revision:'1.2.0',lock_versions:{MACRO:'sha256:'+locks['IMG5684_MACRO_IDENTITY_LOCK.json'].sha256},import_note:'Envelope only; original macro lock has no semantic version. Its immutable hash is the snapshot version. No new inspection or source-originality certification.'};
 const truth_record=save('truth-record.json',Buffer.from(JSON.stringify(truth,null,2)));
 const finish_library=save('finish-library.json',fs.readFileSync(path.join(packageDir,'verified_inputs/GLEOR_METAL_FINISH_LIBRARY.json'))),finish_reference=save('finish-reference.png',fs.readFileSync(path.resolve(packageDir,'../../inputs/Minimalist Rose Altın Halka Küpeler.png')));
 const m={sku_id:id,category:'earring',product_truth:{id:truth.id,...source},truth_record,locks,lock_roles:{macro:'IMG5684_MACRO_IDENTITY_LOCK.json',micro:'IMG5684_MICRO_SETTING_LOCK.json'},assessment,target_view:truth.target_view,micro_applicable:true,finish_id:truth.finish_id,finish_revision:truth.finish_revision,finish_library,finish_reference};
 const manifest=save('manifest.json',Buffer.from(JSON.stringify(m,null,2)));save('attempt-ledger.json',Buffer.from('{"attempts":0}'));
 const registry=fs.existsSync(registryPath)?JSON.parse(fs.readFileSync(registryPath)):{version:'1.0.0',runs:{}};
 need(!registry.runs[id],'REGISTERED_RUN_ALREADY_EXISTS');registry.runs[id]={sku_id:id,manifest_sha256:manifest.sha256,source_sha256:source.sha256};
 fs.writeFileSync(registryPath,JSON.stringify(registry,null,2));return dir;
}
if(require.main===module){const [pkg,root,registry]=process.argv.slice(2);need(pkg&&root&&registry,'USAGE: node registerEvidence.js packageDir privateRunRoot registryPath');registerIMG5684(pkg,root,registry);}
module.exports={registerIMG5684};
