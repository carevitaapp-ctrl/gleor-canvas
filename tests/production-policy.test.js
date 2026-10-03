const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { harness, input, source, truth, comparison, gate } = require('./helpers/production-harness');
async function run(t, config = {}, opts = {}) {
  const h = harness(config); t.after(h.cleanup);
  const args = { ...await input(config.category), ...opts };
  return { h, args, api: h.load('catalog/index.js') };
}
async function blocked(t, config, opts, code) {
  const {h,args,api} = await run(t,config,opts);
  await assert.rejects(api.runCatalogPipeline(args), e => { assert.equal(e.production.publication_authorized,false); assert.equal(e.production.stages.RELEASE_GATE.status,'FAIL'); if(code) assert.equal(e.code,code); if(code==='INSUFFICIENT_SOURCE_IDENTITY') { assert.equal(e.production.stages.SOURCE_SUFFICIENCY.decision,'INSUFFICIENT'); assert.equal(e.production.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.decision,'NOT_ALLOWED'); } return true; });
  return h;
}
test('A source insufficiency stops before truth and reconstruction', async t => {
  const s=source('pendant');s.complete=null;
  const h=await blocked(t,{category:'pendant',replies:{production_source:s}},{productionOptions:{transformation:'reconstruction'}},'INSUFFICIENT_SOURCE_IDENTITY');
  assert.deepEqual(h.calls,['production_source']);assert.equal(h.rendererCalls(),0);
});
test('B missing immutable macro lock blocks authorization', t => {
  const h=harness();t.after(h.cleanup);const {ProductionRun}=h.load('production/policy.js');const p=new ProductionRun();
  assert.throws(()=>p.authorize(false),e=>e.code==='MISSING_MACRO_IDENTITY_LOCK');
});
test('C request cannot inject lock, approval, prompt or release authorization', async t => {
  for(const key of ['prompt','macro_identity_lock','release_gate','authorized']) {
    const {api,args}=await run(t);await assert.rejects(api.runCatalogPipeline({...args,productionOptions:{[key]:true}}),/INVALID_PRODUCTION_OPTIONS/);
  }
});
test('D locked identity mismatch stops before A/B', async t => {
  const c=comparison();c.features[0].result='MISMATCH';
  const h=await blocked(t,{replies:{production_comparison:c}},{},'LOCKED_IDENTITY_MISMATCH_OR_UNKNOWN');assert.ok(!h.calls.includes('gate_a'));
});
for(const [name,opts] of [['E unknown finish',{finish_id:'unregistered-champagne'}],['F wrong revision',{finish_revision:'2'}]]) test(name,async t=>{
  const h=await blocked(t,{}, {productionOptions:opts},'UNREGISTERED_FINISH_OR_REVISION');assert.equal(h.calls.length,0);
});
test('finish mismatch stops before QA',async t=>{
  const c=comparison();c.finish_matches_source=false;await blocked(t,{replies:{production_comparison:c}},{},'FINISH_MISMATCH_OR_UNKNOWN');
});
test('G Gate A failure skips B and denies release',async t=>{
  const a=gate('A');a.criteria.geometry_fidelity.score=0;
  const {h,api,args}=await run(t,{replies:{gate_a:a}});const r=await api.runCatalogPipeline(args);
  assert.equal(r.production.stages.GATE_B.status,'NOT_RUN');assert.equal(r.production.stages.RELEASE_GATE.status,'FAIL');assert.ok(!h.calls.includes('gate_b'));assert.equal(r.final_approval,false);
});
test('H Gate B failure blocks release',async t=>{
  const b=gate('B');b.criteria.pure_white_background.score=0;
  const {api,args}=await run(t,{replies:{gate_b:b}});const r=await api.runCatalogPipeline(args);assert.equal(r.production.publication_authorized,false);assert.equal(r.verdict.value,'manual_review');
});
for(const stage of ['production_source','product_truth','production_comparison','gate_a','gate_b']) test(`I provider error at ${stage} blocks release`,async t=>{await blocked(t,{error:stage});});
for(const stage of ['production_source','product_truth','production_comparison']) test(`I schema error at ${stage} blocks release`,async t=>{await blocked(t,{replies:{[stage]:{}}});});
test('critical UNKNOWN completeness and gemstone presence cannot become facts',async t=>{
  for(const field of ['product_complete','gemstone_presence']) {const v=truth();v[field].value=null;await blocked(t,{replies:{product_truth:v}},{},'UNKNOWN_CRITICAL_PRODUCT_TRUTH');}
});
for(const status of ['REVIEW_REQUIRED','NOT_RUN','UNKNOWN','ERROR','FAIL']) test(`J/K ${status} cannot authorize release`,t=>{
  const h=harness();t.after(h.cleanup);const p=new (h.load('production/policy.js').ProductionRun)();const r=p.release({gate_a:{status},gate_b:{status:'PASS'},final_approval:true,verdict:{value:'approved'}});assert.equal(r.publication_authorized,false);
});
test('M forged serialized release cannot publish',async t=>{
  const {h}=await run(t);const writer=h.load('catalog/writer.js');
  assert.throws(()=>writer.writeBundle({sku:'SKU',verdict:'approved',finalPng:Buffer.from('fake'),release:{publication_authorized:true,stages:{RELEASE_GATE:{status:'PASS'}}},finalMetadata:{}}),/live RELEASE_GATE/);
});
test('N failed candidate cannot overwrite released asset; output names truthful',async t=>{
  let fail=false;const {api,args,h}=await run(t,{replies:{gate_a:()=>{const a=gate('A');if(fail)a.criteria.geometry_fidelity.score=0;return a;}}});
  const good=await api.runCatalogPipeline(args);const bytes=fs.readFileSync(good.bundle.files.final);fail=true;
  const bad=await api.runCatalogPipeline(args);assert.deepEqual(fs.readFileSync(good.bundle.files.final),bytes);assert.ok(!('final' in bad.bundle.files));assert.ok(bad.bundle.files.render_candidate.endsWith('candidate.png'));assert.notEqual(good.bundle.dir,bad.bundle.dir);assert.ok(fs.existsSync(path.join(good.bundle.dir,'release.json')));assert.ok(!fs.existsSync(path.join(bad.bundle.dir,'release.json')));
  const policy=h.load('production/policy.js');assert.equal(policy.authorized(JSON.parse(JSON.stringify(good.production)),bytes),false);assert.equal(policy.authorized(good.production,Buffer.from('changed')),false);
});
test('O real ring composer follows safe non-reconstruction path, lock and evidence persisted',async t=>{
  const {h,api,args}=await run(t);const r=await api.runCatalogPipeline(args);
  assert.equal(r.production.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.status,'NOT_REQUIRED');assert.equal(r.production.stages.RELEASE_GATE.status,'PASS');assert.equal(h.rendererCalls(),0);
  const saved=JSON.parse(fs.readFileSync(r.bundle.files.qaReport));assert.equal(saved.production.identity_lock.sha256,r.production.identity_lock.sha256);assert.ok(Object.isFrozen(r.production.identity_lock.features));
});
test('earring family requires every observation and rejects missing gallery evidence',async t=>{
  const s=source('earring');s.features.find(f=>f.name==='gallery_opening_count_shape_spacing').status='UNKNOWN';
  const h=await blocked(t,{category:'earring',replies:{production_source:s}},{},'INSUFFICIENT_SOURCE_IDENTITY');assert.equal(h.rendererCalls(),0);
});
test('complete earring evidence authorizes reconstruction and is all compared',async t=>{
  const {h,api,args}=await run(t,{category:'earring'});const r=await api.runCatalogPipeline(args);
  assert.equal(r.production.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.status,'PASS');assert.equal(r.production.identity_lock.features.length,15);assert.equal(h.rendererCalls(),1);assert.equal(r.production.stages.RELEASE_GATE.status,'PASS');
});
test('preserve request cannot activate generative renderer for non-ring',async t=>{
  const h=await blocked(t,{category:'earring'},{productionOptions:{transformation:'preserve'}},'RECONSTRUCTION_NOT_ALLOWED');assert.equal(h.rendererCalls(),0);
});
test('lock cannot be repaired to match candidate and duplicate/missing comparisons fail',async t=>{
  for(const mutate of [c=>c.features.pop(),c=>c.features.push(c.features[0]),c=>{c.features[0].result='UNKNOWN';}]) {const c=comparison();mutate(c);await blocked(t,{replies:{production_comparison:c}});}
});
test('retry candidate repeats macro/finish checks before QA and cannot reuse prior PASS',async t=>{
  let n=0;const b=gate('B');b.criteria.framing.score=0;
  const h=await blocked(t,{category:'pendant',replies:{gate_b:b,production_comparison:()=>{const c=comparison('pendant');if(++n===2)c.features[0].result='MISMATCH';return c;}}},{retryLimit:1});
  assert.equal(h.rendererCalls(),2);assert.equal(h.calls.filter(c=>c==='gate_a').length,1);
});
