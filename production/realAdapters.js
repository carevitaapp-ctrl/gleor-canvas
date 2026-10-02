'use strict';
const sharp=require('sharp');
const {file,json,hash,need,raster}=require('./evidence');
const CANONICAL='2d85a405b78e8e3e932da6b80e7b3786b84235feeb3072f85fe9a8950883ad07';
const RECIPE='9408fb54c4c80bdebf1a433debc54f7754c3b38db0ec5c54e36bbb75da9cb6d2';
const result=(b,status,evidence_ref,details={})=>({status,asset_sha256:hash(b),evidence_ref,...details});
// Conservative exact source-patch comparison. It cannot certify a novel camera
// from descriptive locks. No guessed contact-point counts or similarity thresholds.
async function microCheck(image,e){
 try{
  need(e.micro&&e.micro.applicable===true,'REQUIRED_MICRO_LOCK_UNAVAILABLE');
  need(e.m.target_view===e.truth.existing_view,'TARGET_CAMERA_COMPARISON_UNSUPPORTED');
  const c=await raster(image),s=await raster(e.source);
  need(c.info.width===s.info.width&&c.info.height===s.info.height,'CANDIDATE_COORDINATE_MAPPING_UNVERIFIED');
  const fields={};let drift=false;
  for(const [name,r]of Object.entries(e.micro.shape_authority)){
   const [x,y,x2,y2]=r.source_box_xyxy;let changed=0;
   for(let j=y;j<y2;j++)for(let i=x;i<x2;i++){const p=(j*s.info.width+i)*4;if(!c.data.subarray(p,p+4).equals(s.data.subarray(p,p+4)))changed++;}
   fields[name]={status:changed?'FAIL':'PASS',changed_pixels:changed,method:'EXACT_SOURCE_PATCH_NO_RESAMPLING'};drift||=changed>0;
  }
  const evidence_states={};for(const holder of ['UPPER_HOLDER','LOWER_HOLDER'])evidence_states[holder]=Object.fromEntries(Object.entries(e.micro[holder]||{}).filter(([,v])=>v&&v.state).map(([k,v])=>[k,v.state]));
  return result(image,drift?'FAIL':'PASS',e.provenance.micro_lock_sha256,{fields,evidence_states,scope:'Source camera and original pixel coordinates only; uncertainty is not recertified'});
 }catch(err){return result(image,'FAIL_CLOSED','MICRO_COMPARISON_UNAVAILABLE',{reason:err.code||err.message});}
}
// CIELAB D65 math reused from the recorded finish reproduction, not a new profile.
const M=[[.4124564,.3575761,.1804375],[.2126729,.7151522,.072175],[.0193339,.119192,.9503041]],W=[.95047,1,1.08883];
const I=[[3.240454836,-1.537138850,-.498531547],[-.969266390,1.876010929,.041556082],[.055643419,-.204025854,1.057225162]];
function lab(rgb){const l=rgb.map(v=>{const x=v/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}),d=6/29;const f=M.map((r,i)=>{const v=r.reduce((a,b,j)=>a+b*l[j],0)/W[i];return v>d**3?Math.cbrt(v):v/(3*d*d)+4/29;});return [116*f[1]-16,500*(f[0]-f[1]),200*(f[1]-f[2])];}
function rgb(v){const y=(v[0]+16)/116,f=[y+v[1]/500,y,y-v[2]/200],d=6/29,xyz=f.map((t,i)=>(t>d?t**3:3*d*d*(t-4/29))*W[i]);return I.map(r=>{const l=r.reduce((a,b,j)=>a+b*xyz[j],0),s=l<=.0031308?12.92*l:1.055*Math.max(l,0)**(1/2.4)-.055;return Math.round(Math.min(1,Math.max(0,s))*255);});}
async function mapLoad(image,e,dir){
 const spec=json(dir,e.m.surface_map);need(spec.asset_sha256===hash(image)&&spec.sku_id===e.m.sku_id&&spec.source_sha256===e.provenance.source_sha256,'SURFACE_MAP_LINEAGE_MISMATCH');
 need(spec.geometry_excluded===true&&spec.visible_metal_coverage==='ALL_VERIFIED'&&spec.boundary_protection==='ALL_IDENTITY_BOUNDARIES_VERIFIED','SURFACE_MAP_SEMANTICS_UNVERIFIED');
 const r=await raster(image),w=await sharp(file(dir,spec.weights)).raw().toBuffer({resolveWithObject:true}),p=await sharp(file(dir,spec.protected_mask)).raw().toBuffer({resolveWithObject:true});
 need(w.info.width===r.info.width&&w.info.height===r.info.height&&p.info.width===r.info.width&&p.info.height===r.info.height&&w.info.channels===1&&p.info.channels===1,'MASK_DIMENSIONS_INVALID');
 for(let i=0;i<p.data.length;i++){need(p.data[i]===0||p.data[i]===255,'PROTECTION_MASK_NOT_BINARY');need(p.data[i]===0||w.data[i]===0,'WEIGHT_IN_PROTECTED_STRUCTURE');}
 return {...result(image,'PASS',e.m.surface_map.sha256),weights:w.data,protected:p.data,spec};
}
async function transform(image,map,recipe){
 const meta=await sharp(image).metadata();need(!meta.orientation||meta.orientation===1,'ORIENTATION_METADATA_UNSUPPORTED');need(!meta.pages||meta.pages===1,'MULTIPAGE_APPEARANCE_DENIED');
 need(recipe.input_sha256===hash(image),'SOURCE_SPECIFIC_FINISH_RECIPE_MISMATCH');
 need(recipe.canonical_reference_sha256===CANONICAL&&recipe.finish_target==='gleor_champagne_rose_v1','RECIPE_FINISH_AUTHORITY_MISMATCH');
 const g=recipe.shared_transform;need(g.L_star_gain===1&&g.L_star_offset===0&&recipe.spatial_operations.resampling===false,'NON_APPEARANCE_RECIPE_DENIED');
 const r=await raster(image),out=Buffer.from(r.data);need(map.weights.length===r.info.width*r.info.height,'WEIGHT_COUNT_MISMATCH');
 for(let i=0;i<map.weights.length;i++){const w=map.weights[i]/255;if(!w)continue;need(map.protected[i]===0,'PROTECTED_EDIT_DENIED');const p=i*4,v=lab([...r.data.subarray(p,p+3)]);v[1]*=1+w*(g.a_star_gain-1);v[2]*=1+w*(g.b_star_gain-1);out.set(rgb(v),p);}
 return sharp(out,{raw:{width:r.info.width,height:r.info.height,channels:4}}).png().toBuffer();
}
async function verifyAppearance({before,after,map},recipe){
 try{
  const b=await raster(before),a=await raster(after);need(b.info.width===a.info.width&&b.info.height===a.info.height,'DIMENSION_CHANGE');
  let alpha=0,protectedChanges=0;for(let i=0;i<map.weights.length;i++){const p=i*4;if(a.data[p+3]!==b.data[p+3])alpha++;if(!map.weights[i]&&!a.data.subarray(p,p+4).equals(b.data.subarray(p,p+4)))protectedChanges++;}
  need(alpha===0&&protectedChanges===0,'PROTECTED_OR_ALPHA_CHANGED');
  const expected=await raster(await transform(before,map,recipe));need(expected.data.equals(a.data),'NON_POINTWISE_FINISH_CHANGE');
  return result(after,'PASS','DETERMINISTIC_POINTWISE_REPLAY',{alpha_changes:alpha,protected_changes:protectedChanges,dimensions_unchanged:true,spatial_operations:0,scope:'Exact operator replay plus source-bound semantic boundary map; no independent 3D metrology'});
 }catch(err){return result(after,'FAIL','FINISH_APPLICATION_STRUCTURE_VIOLATION',{reason:err.code||err.message});}
}
function create(e,dir){
 let recipe;
 return {
  micro:image=>microCheck(image,e),
  metalMap:image=>mapLoad(image,e,dir),
  finish:async({image,map,finish_id,revision,reference})=>{
   need(finish_id==='gleor_champagne_rose_v1'&&revision==='1.2.0'&&hash(reference)===CANONICAL,'LOCKED_FINISH_MISMATCH');
   // Existing recipe is source dependent; never transfer its masks/coefficients to another SKU.
   const bytes=file(dir,e.m.finish_recipe);need(hash(bytes)===RECIPE,'UNREGISTERED_FINISH_RECIPE');recipe=JSON.parse(bytes);
   return {image:await transform(image,map,recipe)};
  },
  verifyAppearance:input=>verifyAppearance(input,recipe),
  finishQA:async image=>result(image,'FAIL_CLOSED','CANONICAL_FINISH_QA_NOT_CALIBRATED',{reason:'Locked library has no calibrated universal mapping or numerical acceptance tolerance; operation reproducibility does not establish material-family PASS'})
 };
}
module.exports={create,microCheck,mapLoad,transform,verifyAppearance,lab,rgb};
