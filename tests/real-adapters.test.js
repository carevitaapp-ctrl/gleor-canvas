const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),sharp=require('sharp');
const {createApp}=require('../server'),{ROUTES}=require('../production/gates'),{load,hash,raster}=require('../production/evidence'),{registerIMG5684}=require('../production/registerEvidence'),{microCheck,transform,verifyAppearance,create}=require('../production/realAdapters');
const workspace=process.env.GLEOR_FIXTURE_WORKSPACE;
test('production refuses injected test adapters regardless of supplied gate flags',()=>{
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';try{assert.throws(()=>createApp({adapters:{},testOnly:true}),/TEST_ADAPTER_INJECTION_FORBIDDEN/);}finally{process.env.NODE_ENV=previous;}
});
if(workspace){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gleor-real-')),registryPath=path.join(root,'registry.json');
 registerIMG5684(path.join(workspace,'output/source_authority_patch'),root,registryPath);
 test('real registered IMG5684 evidence blocks every actual production route without injected states',async()=>{
  const app=createApp({root,registryPath,dryRun:true}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{for(const route of ROUTES){const res=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'X-Gleor-Run-Id':'IMG5684','Content-Type':'application/json'},body:JSON.stringify({sourceSufficient:true,microCheck:'PASS',finishCheck:'PASS'})});const b=await res.json();assert.equal(res.status,409);assert.equal(b.reason,'INSUFFICIENT_PRODUCT_TRUTH_FOR_FRONT_HERO');assert.equal(b.state.PROVENANCE.status,'VERIFIED');assert.equal(b.state.RENDER_PROVIDER_CALL_COUNT,0);assert.equal(b.state.RECONSTRUCTION_ATTEMPT_COUNT,0);assert.deepEqual(b.state.calls,{});assert.equal(b.image,undefined);assert.deepEqual(b.missing_evidence,['UPPER_HOLDER_FRONT_CONTOUR_AND_CONTACT_INTERFACE','LOWER_HOLDER_FRONT_TOPOLOGY_AND_RAIL_CONNECTION']);}}
  finally{await new Promise(r=>server.close(r));}
 });
 test('actual micro patches detect pixels changed; unsupported camera fails closed',async()=>{
  const e=await load(root,'IMG5684',registryPath);assert.equal((await microCheck(e.source,e)).status,'FAIL_CLOSED');
  // Comparator capability test in the actual source camera; does not authorize FRONT_HERO.
  const same={...e,m:{...e.m,target_view:e.truth.existing_view}};assert.equal((await microCheck(e.source,same)).status,'PASS');
  const r=await raster(e.source),raw=Buffer.from(r.data),box=e.micro.shape_authority.LOWER_HOLDER.source_box_xyxy;raw[(box[1]*r.info.width+box[0])*4]^=255;
  const changed=await sharp(raw,{raw:{width:r.info.width,height:r.info.height,channels:4}}).png().toBuffer();const q=await microCheck(changed,same);assert.equal(q.status,'FAIL');assert.equal(q.fields.LOWER_HOLDER.changed_pixels,1);
  const unknown=await create(e,path.join(root,'IMG5684')).finishQA(e.source);assert.equal(unknown.status,'FAIL_CLOSED');
 });
 test('registry pins fail closed on tampering and mismatched SKU before processing',async()=>{
  const p=path.join(root,'IMG5684/manifest.json'),before=fs.readFileSync(p);try{const d=JSON.parse(before);d.sku_id='OTHER';fs.writeFileSync(p,JSON.stringify(d));await assert.rejects(load(root,'IMG5684',registryPath),/EVIDENCE_HASH_MISMATCH/);}finally{fs.writeFileSync(p,before);}
 });
 test('read-only IMG5751 accepted replay uses production registry and keeps final bytes unchanged',async()=>{
  const base=path.join(workspace,'inputs/standard'),known=JSON.parse(fs.readFileSync(path.join(base,'IMG5751_CANONICAL_EXAMPLE.json'))),original=known.assets.final_export.path,before=fs.readFileSync(original),dir=path.join(root,'IMG5751');fs.mkdirSync(dir);
  const save=(name,b)=>{fs.writeFileSync(path.join(dir,name),b);return {path:name,sha256:hash(b)};};
  const source=save('source.png',fs.readFileSync(known.assets.product_truth.path));
  const m={sku_id:'IMG5751',category:'earring',target_view:'EXISTING_ACCEPTED_PAIR',mode:'ACCEPTED_EXPORT_REPLAY',finish_id:'gleor_champagne_rose_v1',finish_revision:'1.2.0',product_truth:{id:'IMG5751',...source},final_asset:save('accepted.png',before),acceptance_record:save('accepted.json',fs.readFileSync(path.join(base,'canonical_provenance/IMG5751_FINAL_EXPORT/FINAL_EXPORT_RECORD.json'))),premium_record:save('premium.json',fs.readFileSync(path.join(base,'canonical_provenance/IMG5751_FINAL_PREMIUM_QA/PREMIUM_QA.json')))};
  const manifest=save('manifest.json',Buffer.from(JSON.stringify(m))),registry=JSON.parse(fs.readFileSync(registryPath));registry.runs.IMG5751={sku_id:'IMG5751',manifest_sha256:manifest.sha256,source_sha256:source.sha256};fs.writeFileSync(registryPath,JSON.stringify(registry));
  const svc=require('../production/gates').createService({root,registryPath,dryRun:true}),r=await svc.execute('IMG5751');assert.equal(r.state.RELEASE_GATE_STATUS,'PASS');assert.equal(r.state.PROVENANCE.status,'VERIFIED');assert.ok(r.image.equals(before));assert.ok(fs.readFileSync(original).equals(before));assert.equal(hash(before),'1fc25cce27e5e266fd02f39df106abd86c6aab4dd81aa605c9e1e27b1a1a1e2d');
 });
}
test('pointwise finish kernel preserves protected RGB/alpha and rejects any unaccounted geometry change',async()=>{
 // Synthetic raster exercises numeric code, not a claim of calibrated production finish.
 const before=await sharp(Buffer.from([180,140,100,255,255,255,255,0]),{raw:{width:2,height:1,channels:4}}).png().toBuffer(),map={weights:Buffer.from([255,0]),protected:Buffer.from([0,255])};
 const recipe={input_sha256:hash(before),canonical_reference_sha256:'2d85a405b78e8e3e932da6b80e7b3786b84235feeb3072f85fe9a8950883ad07',finish_target:'gleor_champagne_rose_v1',shared_transform:{L_star_gain:1,L_star_offset:0,a_star_gain:.7579672337871075,b_star_gain:1.074034890962629},spatial_operations:{resampling:false}};
 const after=await transform(before,map,recipe);assert.equal((await verifyAppearance({before,after,map},recipe)).status,'PASS');
 const r=await raster(after);r.data[7]=255;const corrupt=await sharp(r.data,{raw:{width:2,height:1,channels:4}}).png().toBuffer();assert.equal((await verifyAppearance({before,after:corrupt,map},recipe)).status,'FAIL');
 const other=await raster(after);other.data[0]^=255;const edited=await sharp(other.data,{raw:{width:2,height:1,channels:4}}).png().toBuffer();assert.equal((await verifyAppearance({before,after:edited,map},recipe)).status,'FAIL');
 await assert.rejects(transform(after,map,recipe),/SOURCE_SPECIFIC_FINISH_RECIPE_MISMATCH/);
});
