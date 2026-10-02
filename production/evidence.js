'use strict';
// Server-owned registry pins immutable evidence manifests. HTTP fields have no authority.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),sharp=require('sharp');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function need(ok,code){if(!ok)throw Object.assign(new Error(code),{code});}
function file(root,r){need(r&&/^[a-f0-9]{64}$/.test(r.sha256),'EVIDENCE_REFERENCE_REQUIRED');const p=fs.realpathSync(path.resolve(root,r.path));need(p.startsWith(fs.realpathSync(root)+path.sep),'EVIDENCE_PATH_ESCAPE');const b=fs.readFileSync(p);need(hash(b)===r.sha256,'EVIDENCE_HASH_MISMATCH');return b;}
const json=(root,r)=>JSON.parse(file(root,r));
const sku=s=>String(s||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
async function raster(b){return sharp(b,{limitInputPixels:40000000}).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});}
async function load(root,runId,registryPath){
 need(registryPath,'TRUSTED_REGISTRY_REQUIRED');
 const registry=JSON.parse(fs.readFileSync(registryPath)),pin=registry.runs?.[runId];
 need(pin&&pin.sku_id&&pin.manifest_sha256,'REGISTERED_RUN_REQUIRED');
 const dir=path.join(root,runId),mb=file(dir,{path:'manifest.json',sha256:pin.manifest_sha256}),m=JSON.parse(mb);
 need(sku(m.sku_id)===sku(pin.sku_id)&&m.category==='earring','SKU_CATEGORY_MISMATCH');
 const source=file(dir,m.product_truth),sourceHash=hash(source);
 if(m.mode==='ACCEPTED_EXPORT_REPLAY'){
  need(m.product_truth.id&&pin.source_sha256===sourceHash,'ACCEPTED_SOURCE_UNVERIFIED');
  return {m,source,provenance:{status:'VERIFIED',manifest_sha256:hash(mb),source_sha256:sourceHash,mode:m.mode}};
 }
 const truth=json(dir,m.truth_record);
 need(sku(truth.sku_id)===sku(m.sku_id)&&truth.category===m.category&&truth.source_sha256===sourceHash,'PRODUCT_TRUTH_LINEAGE_MISMATCH');
 need(truth.id===m.product_truth.id&&truth.version&&truth.source_asset_id,'PRODUCT_TRUTH_METADATA_MISSING');
 need(truth.existing_view&&truth.target_view===m.target_view&&truth.existing_view!==m.target_view,'VIEW_LINEAGE_MISMATCH');
 need(truth.finish_id==='gleor_champagne_rose_v1'&&truth.finish_revision==='1.2.0'&&m.finish_id===truth.finish_id&&m.finish_revision===truth.finish_revision,'LOCKED_FINISH_MISMATCH');
 need(typeof m.micro_applicable==='boolean'&&truth.micro_applicable===m.micro_applicable,'MICRO_APPLICABILITY_UNVERIFIED');
 const libraryBytes=file(dir,m.finish_library);need(hash(libraryBytes)==='ae0935608b618f59606504cb9b50ff5e02cb8403f541a783601469f58bd2389a','FINISH_LIBRARY_INTEGRITY_FAILURE');
 const profile=JSON.parse(libraryBytes).profiles.find(x=>x.finish_id===truth.finish_id);
 need(profile?.status==='LOCKED'&&profile.version===truth.finish_revision,'FINISH_PROFILE_UNVERIFIED');
 need(hash(file(dir,m.finish_reference))===profile.primary_canonical_visual_reference.sha256,'FINISH_REFERENCE_MISMATCH');
 const locks={};for(const [k,r]of Object.entries(m.locks||{})){locks[k]=file(dir,r);const l=JSON.parse(locks[k]);need(l.source_sha256===sourceHash&&sku(l.id).startsWith(sku(m.sku_id)),'LOCK_SOURCE_SKU_MISMATCH:'+k);}
 const macroKey=m.lock_roles?.macro,microKey=m.lock_roles?.micro;
 const macro=JSON.parse(locks[macroKey]||'null'),micro=JSON.parse(locks[microKey]||'null');
 for(const [type,l]of [['MACRO',macro],...(m.micro_applicable?[['MICRO',micro]]:[])]){
  need(l&&sku(l.id).startsWith(sku(m.sku_id))&&l.source_sha256===sourceHash,type+'_LOCK_LINEAGE_MISMATCH');
  need(l.revision||l.version||truth.lock_versions?.[type],type+'_LOCK_VERSION_MISSING');
 }
 if(m.micro_applicable){
  need(micro.macro_lock_sha256===hash(locks[macroKey]),'MICRO_MACRO_LINEAGE_MISMATCH');
  need(micro.shape_authority&&Object.keys(micro.shape_authority).length>0,'MICRO_SHAPE_AUTHORITY_MISSING');
  const src=await raster(source);
  need(JSON.stringify([src.info.width,src.info.height])===JSON.stringify(micro.source_dimensions),'SOURCE_DIMENSIONS_MISMATCH');
  for(const [name,r]of Object.entries(micro.shape_authority)){
   const patch=file(dir,r),[x,y,x2,y2]=r.source_box_xyxy;
   need([x,y,x2,y2].every(Number.isInteger)&&x>=0&&y>=0&&x2>x&&y2>y&&x2<=src.info.width&&y2<=src.info.height,'INVALID_SOURCE_PATCH:'+name);
   const actual=await raster(await sharp(source).extract({left:x,top:y,width:x2-x,height:y2-y}).png().toBuffer()),expected=await raster(patch);
   need(actual.data.equals(expected.data)&&actual.info.width===expected.info.width&&actual.info.height===expected.info.height,'SOURCE_PATCH_MISMATCH:'+name);
  }
 }
 return {m,truth,source,locks,macro,micro,provenance:{status:'VERIFIED',source_asset_id:truth.source_asset_id,source_path:m.product_truth.path,source_sha256:sourceHash,product_truth_id:truth.id,product_truth_version:truth.version,product_truth_sha256:hash(file(dir,m.truth_record)),macro_lock_sha256:hash(locks[macroKey]),macro_lock_version:macro.revision||macro.version||truth.lock_versions.MACRO,micro_lock_sha256:micro?hash(locks[microKey]):null,micro_lock_version:micro?.revision||micro?.version,existing_view:truth.existing_view,target_view:m.target_view,manifest_sha256:hash(mb),originality:truth.originality,finish_library_sha256:hash(libraryBytes),finish_id:profile.finish_id,finish_revision:profile.version,finish_reference_sha256:m.finish_reference.sha256}};
}
module.exports={load,file,json,hash,need,raster};
