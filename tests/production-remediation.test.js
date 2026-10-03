const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, input, truth, gate } = require('./helpers/production-harness');
const approve = () => ({gate_a:{status:'PASS'},gate_b:{status:'PASS'},final_approval:true,verdict:{value:'approved'}});
async function prepared(t) {
  const h=harness(); t.after(h.cleanup);
  const policy=h.load('production/policy.js'), p=new policy.ProductionRun(), args=await input();
  args.originalRaw.mediaType='image/jpeg';
  await p.source(args); p.begin('PRODUCT_TRUTH'); p.lock(truth()); p.authorize(true); p.begin('RENDER');
  const candidate=Buffer.from(args.masterClean.buffer);
  await p.verify(candidate,'offline',{pass:true});
  return {h,p,policy,args,candidate,record:p.qaRecorder(candidate)};
}
function outcome(record, stage, result) { record(stage,'RUNNING'); record(stage,result); }
function passBoth(record) { outcome(record,'GATE_A','PASS'); outcome(record,'GATE_B','PASS'); }
function denied(p, summary=approve()) { const r=p.release(summary); assert.equal(r.publication_authorized,false); assert.equal(r.stages.RELEASE_GATE.status,'FAIL'); return r; }
test('R1 prepared run without QA cannot release',async t=>{ const {p}=await prepared(t); assert.equal(p.release().publication_authorized,false); assert.equal(p.snapshot().stages.GATE_A.status,'NOT_RUN'); });
test('R2 fake release PASS summary does not manufacture gate records',async t=>{ const {p}=await prepared(t); const r=denied(p); assert.equal(r.stages.GATE_A.status,'NOT_RUN'); assert.equal(r.stages.GATE_B.status,'NOT_RUN'); });
test('R3 Gate A failure cannot be upgraded through recorder or release',async t=>{ const {p,record}=await prepared(t); outcome(record,'GATE_A','FAIL'); denied(p); assert.throws(()=>record('GATE_A','PASS'),/INVALID_QA_TRANSITION/); assert.equal(p.snapshot().stages.GATE_A.status,'FAIL'); denied(p); });
test('R4 B cannot start or pass before A',async t=>{ for(const status of ['RUNNING','PASS']) {const {p,record}=await prepared(t); assert.throws(()=>record('GATE_B',status),/QA_PREREQUISITE_FAILED/); denied(p);} });
test('R5 A PASS and B NOT_RUN denies release',async t=>{ const {p,record}=await prepared(t); outcome(record,'GATE_A','PASS'); denied(p); });
test('R6 A PASS and B FAIL denies release and preserves failure',async t=>{ const {p,record}=await prepared(t); outcome(record,'GATE_A','PASS'); outcome(record,'GATE_B','FAIL'); denied(p); assert.equal(p.snapshot().stages.GATE_B.status,'FAIL'); });
test('R7 actual catalogQA records successful candidate-bound gates',async t=>{
  const {h,p,policy,args,candidate,record}=await prepared(t);
  const qa=await h.load('catalog/catalogQA.js').runCatalogQA({originalBuffer:args.originalRaw.buffer,finalBuffer:candidate,truth:truth(),openaiKey:'offline',onGate:record});
  const r=p.release(qa); assert.equal(r.publication_authorized,true); assert.equal(policy.authorized(r,candidate),true);
  for(const stage of ['GATE_A','GATE_B','MACRO_IDENTITY_CHECK','FINISH_IDENTITY_CHECK']) { assert.equal(r.stages[stage].generation,r.candidate_generation); assert.equal(r.stages[stage].candidate_sha256,r.candidate_sha256); }
});
test('R8 abort is terminal for release and every authority mutation',async t=>{
  const {p,record,args,candidate}=await prepared(t); passBoth(record); assert.equal(p.release(approve()).publication_authorized,true); p.abort();
  denied(p); await assert.rejects(p.source(args),/RUN_ABORTED/); assert.throws(()=>p.lock(truth()),/RUN_ABORTED/); assert.throws(()=>p.authorize(true),/RUN_ABORTED/); assert.throws(()=>p.begin('RENDER'),/RUN_ABORTED/); assert.throws(()=>record('GATE_A','RUNNING'),/RUN_ABORTED/); assert.throws(()=>p.qaRecorder(candidate),/RUN_ABORTED/); await assert.rejects(p.verify(candidate,'offline',{pass:true}),/RUN_ABORTED/); denied(p); assert.equal(p.snapshot().lifecycle,'ABORTED');
});
test('R9 pre-abort capability never revives',async t=>{ const {p,record,policy,candidate}=await prepared(t); passBoth(record); const cap=p.release(approve()); p.abort(); for(let i=0;i<3;i++){denied(p);assert.equal(policy.authorized(cap,candidate),false);} });
test('R10 source establishment is single-use',async t=>{ const {p,args}=await prepared(t); const before=p.snapshot().identity_lock.sha256; await assert.rejects(p.source(args),/SOURCE_ALREADY_ESTABLISHED/); assert.equal(p.snapshot().identity_lock.sha256,before); denied(p); });
test('R11 identity lock cannot be replaced',async t=>{ const {p}=await prepared(t); const before=p.snapshot().identity_lock.sha256; assert.throws(()=>p.lock(truth()),/IDENTITY_LOCK_ALREADY_ESTABLISHED/); assert.equal(p.snapshot().identity_lock.sha256,before); denied(p); });
test('R12 capability cannot authorize different bytes or serialized copy',async t=>{ const {p,record,policy,candidate}=await prepared(t); passBoth(record); const cap=p.release(approve()); assert.equal(policy.authorized(cap,Buffer.from('other')),false); assert.equal(policy.authorized(JSON.parse(JSON.stringify(cap)),candidate),false); });
test('R13 old capability stays invalid after a later successful generation, even for identical bytes',async t=>{
  const {p,record,policy,candidate}=await prepared(t); passBoth(record); const old=p.release(approve()); p.begin('RENDER'); assert.equal(policy.authorized(old,candidate),false);
  await p.verify(candidate,'offline',{pass:true}); passBoth(p.qaRecorder(candidate)); const current=p.release(approve()); assert.equal(current.candidate_generation,2); assert.equal(policy.authorized(current,candidate),true); assert.equal(policy.authorized(old,candidate),false);
});
test('R14 filename gold/14K cannot override observed silver or authorize release',async t=>{
  const v=truth();v.metal_type.value='silver';const h=harness({replies:{product_truth:v}});t.after(h.cleanup); const args=await input();args.originalRaw.originalFilename='ring-gold-14k-SKU123.jpg';
  const pt=await h.load('catalog/productTruth.js').runProductTruth({imageBuffer:args.originalRaw.buffer,imageMediaType:'image/jpeg',filenameMetadata:{metal_type:{value:'yellow_gold'},karat:{value:'14K'}},openaiKey:'offline'});
  assert.equal(pt.truth.metal_type.value,'silver');assert.equal(pt.truth.metal_type.source,'vision');assert.ok(pt.truth.metadata_conflicts.includes('metal_type'));
  await assert.rejects(h.load('catalog/index.js').runCatalogPipeline(args),e=>e.code==='DECLARED_METADATA_CONFLICT' && e.production.identity_lock===null);assert.equal(h.rendererCalls(),0);assert.ok(!h.calls.includes('production_comparison'));
});
test('R15 karat remains declared/unverified despite confident visual output',async t=>{
  const v=truth();v.karat={value:'18K',confidence:1}; const h=harness({replies:{product_truth:v}});t.after(h.cleanup);
  const r=await h.load('catalog/productTruth.js').runProductTruth({imageBuffer:Buffer.from('RAW'),filenameMetadata:{karat:{value:'14K'}},openaiKey:'offline'});
  assert.equal(r.truth.karat.value,null);assert.equal(r.truth.karat.confidence,0);assert.equal(r.truth.declared_metadata.karat.value,'14K');assert.equal(r.truth.declared_metadata.karat.verification,'UNVERIFIED');assert.equal(r.truth.declared_metadata.karat.source,'filename');
});
test('R16 declared material never enters observed prompt assertions or QA applicability',async t=>{
  const v=truth();v.metal_type={value:null,confidence:0};v.karat={value:null,confidence:0};
  const h=harness({replies:{product_truth:(request)=>{const content=JSON.stringify(request.input);assert.ok(!content.includes('14K'));assert.ok(!content.includes('yellow_gold'));return v;}}});t.after(h.cleanup);
  const {truth:observed}=await h.load('catalog/productTruth.js').runProductTruth({imageBuffer:Buffer.from('RAW'),filenameMetadata:{metal_type:{value:'yellow_gold'},karat:{value:'14K'}},openaiKey:'offline'});
  const prompt=h.load('catalog/promptBuilder.js').buildPrompt({truth:observed});assert.ok(!prompt.includes('- metal_type: yellow_gold'));assert.ok(!prompt.includes('- karat: 14K'));
  const b=gate('B');b.criteria.clean_light_premium_gold_appearance={score:null,applicable:false,note:'Material not established'};
  assert.equal(h.load('catalog/catalogQA.js').parseGate(JSON.stringify(b),'B',observed).status,'PASS');
});
for(const [label,presence,count] of [['R17',false,3],['R18',true,0]]) test(`${label} contradictory gemstones rejected before lock at both boundaries`,async t=>{
  const v=truth();v.gemstone_presence={value:presence,visible_count:count,count_confidence:1};const h=harness({replies:{product_truth:v}});t.after(h.cleanup);const args=await input();
  await assert.rejects(h.load('catalog/index.js').runCatalogPipeline(args),e=>e.code==='INVALID_PRODUCT_TRUTH' && e.production.identity_lock===null);assert.ok(!h.calls.includes('production_comparison'));
  const p=new (h.load('production/policy.js').ProductionRun)();await p.source(args);assert.throws(()=>p.lock(v),/INVALID_PRODUCT_TRUTH/);assert.equal(p.snapshot().identity_lock,null);
});
test('R19 unknown gemstone facts remain blocked',async t=>{
  for(const gems of [{value:null,visible_count:null,count_confidence:0},{value:true,visible_count:null,count_confidence:0},{value:false,visible_count:null,count_confidence:0}]) { const v=truth();v.gemstone_presence=gems;const h=harness({replies:{product_truth:v}});t.after(h.cleanup);await assert.rejects(h.load('catalog/index.js').runCatalogPipeline(await input()),e=>e.production.publication_authorized===false && e.production.identity_lock===null); }
});
test('R20 inconsistent final approval cannot release despite recorded passes',async t=>{ const {p,record}=await prepared(t);passBoth(record);denied(p,{...approve(),final_approval:false}); });
test('R21 stale QA recorder cannot record for a later generation',async t=>{ const {p,record,candidate}=await prepared(t);p.begin('RENDER');await p.verify(candidate,'offline',{pass:true});assert.throws(()=>record('GATE_A','RUNNING'),/STALE_QA_CANDIDATE/);denied(p); });
test('R22 mutation of candidate bytes invalidates QA recording',async t=>{ const {p,record,candidate}=await prepared(t);candidate[0]^=1;assert.throws(()=>record('GATE_A','RUNNING'),/STALE_QA_CANDIDATE/);denied(p); });
test('R23 skipped RUNNING cannot fabricate successful gate completion',async t=>{const {p,record}=await prepared(t);assert.throws(()=>record('GATE_A','PASS'),/INVALID_QA_TRANSITION/);denied(p);});
test('R24 provider transports are blocked by the test preload',()=>{assert.throws(()=>require('https').request('https://example.invalid'),/TEST_NETWORK_BLOCKED/);assert.throws(()=>require('tls').connect({host:'example.invalid',port:443}),/TEST_NETWORK_BLOCKED/);});

test('R25 Product Truth cannot be restarted after release',async t=>{const {p,record,policy,candidate}=await prepared(t);passBoth(record);const cap=p.release(approve());assert.throws(()=>p.begin('PRODUCT_TRUTH'),/PRODUCT_TRUTH_ALREADY_STARTED/);assert.equal(policy.authorized(cap,candidate),false);denied(p);});
test('R26 Gate A failure blocks B recording without relying on release evaluation',async t=>{const {p,record}=await prepared(t);outcome(record,'GATE_A','FAIL');assert.throws(()=>record('GATE_B','RUNNING'),/QA_PREREQUISITE_FAILED/);assert.equal(p.snapshot().stages.GATE_A.status,'FAIL');assert.equal(p.snapshot().stages.GATE_B.status,'NOT_RUN');denied(p);});
test('R27 abort during source analysis cannot establish source authority',async t=>{
  let p;const h=harness({replies:{production_source:()=>{p.abort();return require('./helpers/production-harness').source();}}});t.after(h.cleanup);p=new (h.load('production/policy.js').ProductionRun)();await assert.rejects(p.source(await input()),/RUN_ABORTED/);assert.equal(p.snapshot().stages.SOURCE_SUFFICIENCY.status,'ERROR');assert.equal(p.snapshot().identity_lock,null);denied(p);
});
test('R28 abort during candidate comparison cannot restore verification authority',async t=>{
  let p;const h=harness({replies:{production_comparison:()=>{p.abort();return require('./helpers/production-harness').comparison();}}});t.after(h.cleanup);p=new (h.load('production/policy.js').ProductionRun)();const args=await input();await p.source(args);p.lock(truth());p.authorize(true);p.begin('RENDER');await assert.rejects(p.verify(args.masterClean.buffer,'offline',{pass:true}),/RUN_ABORTED/);assert.equal(p.snapshot().stages.MACRO_IDENTITY_CHECK.status,'ERROR');denied(p);
});
