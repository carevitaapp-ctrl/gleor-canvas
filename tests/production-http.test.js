const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { harness, input, source, truth, comparison, gate } = require('./helpers/production-harness');
const records = [];
function multipart(parts) {
  const boundary='gleor-v2-offline-boundary';const chunks=[];
  for(const p of parts) {chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename?`; filename="${p.filename}"`:''}\r\n${p.filename?'Content-Type: application/octet-stream\r\n':''}\r\n`));chunks.push(Buffer.isBuffer(p.bytes)?p.bytes:Buffer.from(p.bytes));chunks.push(Buffer.from('\r\n'));}
  chunks.push(Buffer.from(`--${boundary}--\r\n`));return {body:Buffer.concat(chunks),type:`multipart/form-data; boundary=${boundary}`};
}
async function server(t,config={}) {
  const h=harness(config);
  if(config.beforeApp) config.beforeApp(h);
  const app=h.load('server.js');
  const s=await new Promise(resolve=>{const v=app.listen(0,'127.0.0.1',()=>resolve(v));});
  t.after(async()=>{await new Promise(resolve=>s.close(resolve));h.cleanup();});
  async function request(route,content,headers={}) {return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:s.address().port,path:route,method:'POST',headers:{'content-type':content.type,'content-length':content.body.length,...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const raw=Buffer.concat(chunks);let body;try{body=JSON.parse(raw);}catch(_){body=null;}resolve({status:res.statusCode,headers:res.headers,body,raw});});
    });req.on('error',reject);req.end(content.body);
  }); }
  return {h,request};
}
async function catalogBody(category='ring', filename) {
  const i=await input(category);return multipart([{name:'original_raw',filename:filename || i.originalRaw.originalFilename,bytes:i.originalRaw.buffer},{name:'master_clean_png',filename:'clean.png',bytes:i.masterClean.buffer},{name:'input_manifest',bytes:JSON.stringify(i.inputManifest)}]);
}
function record(name,route,r,calls,requestOptions={}) {
  records.push({name,request:{method:'POST',path:route,fixture:'synthetic RAW/Clean; no user assets',production_options:requestOptions},http_status:r.status,asset_state:r.body?.asset_state||r.headers['x-gleor-asset-state'],release_gate:r.body?.production?.stages?.RELEASE_GATE||{status:r.headers['x-gleor-release-gate']},transitions:r.body?.production?.transitions||[],mocked_analyses:calls,external_provider_calls:0});
}
function denied(r) {assert.equal(r.headers['x-gleor-release-gate'],'FAIL');assert.equal(r.body.final_approval,false);assert.equal(r.body.asset_state,'CANDIDATE_ONLY');assert.notEqual(r.body.production.stages.RELEASE_GATE.status,'PASS');}
test('HTTP 1 insufficient reconstruction cannot reach renderer',async t=>{
  const s=source('earring');s.features[0].status='UNKNOWN';const {h,request}=await server(t,{category:'earring',replies:{production_source:s}});
  const opts={transformation:'reconstruction'};const r=await request('/catalog',await catalogBody('earring'),{'x-gleor-production':JSON.stringify(opts)});denied(r);assert.equal(h.rendererCalls(),0);record('insufficient reconstruction','/catalog',r,h.calls,opts);
});
test('HTTP 2 structural failure cannot release',async t=>{
  const c=comparison();c.features[0].result='MISMATCH';const {h,request}=await server(t,{replies:{production_comparison:c}});const r=await request('/catalog',await catalogBody());denied(r);assert.ok(!h.calls.includes('gate_a'));record('structural identity mismatch','/catalog',r,h.calls);
});
for(const opts of [{finish_id:'unknown'},{finish_revision:'999'}]) test(`HTTP 3 finish ${JSON.stringify(opts)} fails closed`,async t=>{
  const {h,request}=await server(t);const r=await request('/catalog',await catalogBody(),{'x-gleor-production':JSON.stringify(opts)});denied(r);assert.equal(h.calls.length,0);record('finish registration failure','/catalog',r,h.calls,opts);
});
for(const layer of ['A','B']) test(`HTTP 4 Gate ${layer} cannot release`,async t=>{
  const g=gate(layer);g.criteria[Object.keys(g.criteria)[0]].score=0;const {h,request}=await server(t,{replies:{[layer==='A'?'gate_a':'gate_b']:g}});const r=await request('/catalog',await catalogBody());denied(r);if(layer==='A')assert.ok(!h.calls.includes('gate_b'));record(`Gate ${layer} failure`,'/catalog',r,h.calls);
});
test('HTTP 5 review candidate has no final labels or final artifact path',async t=>{
  const b=gate('B');b.criteria.framing.score=0;const {h,request}=await server(t,{replies:{gate_b:b}});const r=await request('/catalog',await catalogBody(),{'x-catalog-include-artifacts':'1'});denied(r);assert.equal(r.body.verdict,'manual_review');assert.ok(!JSON.stringify(r.body).includes('"RELEASED"'));assert.ok(!fs.existsSync(path.join(r.body.bundle_dir,'final.png')));record('review candidate','/catalog',r,h.calls);
});
for(const route of ['/hero','/hero-a','/hero-b','/hero-c','/process','/HERO-C/']) test(`HTTP 6 ${route} cannot bypass policy`,async t=>{
  const {h,request}=await server(t);const i=await input();const body=multipart([{name:'image',filename:'fixture.png',bytes:i.masterClean.buffer},{name:'category',bytes:'ring'},{name:'status',bytes:'RELEASED'}]);
  const r=await request(route,body,{'x-gleor-production':JSON.stringify({release_gate:'PASS',publication_authorized:true})});denied(r);assert.ok(!JSON.stringify(r.body).includes('"APPROVED"'));record('alternate endpoint',route,r,h.calls);
});
test('HTTP candidate binary response carries nonproduction headers',async t=>{
  const {h,request}=await server(t);const i=await input();const r=await request('/hero-c',multipart([{name:'image',filename:'fixture.png',bytes:i.masterClean.buffer}]),{accept:'image/png'});assert.equal(r.headers['x-gleor-release-gate'],'FAIL');assert.equal(r.headers['x-gleor-asset-state'],'CANDIDATE_ONLY');record('binary candidate','/hero-c',r,h.calls);
});
test('HTTP 7 compliant path releases only after persisted release manifest',async t=>{
  const {h,request}=await server(t);const r=await request('/catalog',await catalogBody());assert.equal(r.status,200);assert.equal(r.body.production.stages.RELEASE_GATE.status,'PASS');assert.equal(r.body.asset_state,'RELEASED');assert.equal(r.headers['x-gleor-release-gate'],'PASS');assert.ok(fs.existsSync(path.join(r.body.bundle_dir,'release.json')));assert.equal(r.body.production.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.status,'NOT_REQUIRED');record('compliant preservation','/catalog',r,h.calls);
});
test('HTTP request cannot inject authorization or prompt overrides',async t=>{
  const {h,request}=await server(t);const opts={transformation:'reconstruction',authorized:true};const r=await request('/catalog',await catalogBody(),{'x-gleor-production':JSON.stringify(opts)});denied(r);assert.equal(h.calls.length,0);record('forged authorization','/catalog',r,h.calls,opts);
});
test('HTTP malformed JSON has explicit denied production state',async t=>{
  const {h,request}=await server(t);const r=await request('/process',{type:'application/json',body:Buffer.from('{bad')});denied(r);record('malformed request','/process',r,h.calls);
});
test.after(()=>{
  // Only an explicit local validation invocation persists the secret-free evidence.
  if(process.env.GLEOR_HTTP_EVIDENCE) fs.writeFileSync(process.env.GLEOR_HTTP_EVIDENCE,JSON.stringify({runtime:'2.0.0',validation:'actual loopback HTTP; provider transport stubbed',external_provider_calls:0,cases:records},null,2)+'\n');
});

test('HTTP successful reconstruction still passes every stage before release',async t=>{
  const {h,request}=await server(t,{category:'earring'});const opts={transformation:'reconstruction',finish_id:'preserve-source',finish_revision:'1'};
  const r=await request('/catalog',await catalogBody('earring'),{'x-gleor-production':JSON.stringify(opts)});
  assert.equal(r.body.production.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.status,'PASS');assert.equal(r.body.production.stages.RELEASE_GATE.status,'PASS');assert.equal(h.rendererCalls(),1);record('compliant reconstruction','/catalog',r,h.calls,opts);
});
test('HTTP legacy hero approval is downgraded even on successful binary render',async t=>{
  const sharp=require('sharp');const {h,request}=await server(t);
  const tile=await sharp({create:{width:780,height:500,channels:3,background:{r:150,g:140,b:130}}}).png().toBuffer();
  const image=await sharp({create:{width:1200,height:1200,channels:3,background:'white'}}).composite([{input:tile,left:210,top:350}]).png().toBuffer();
  const r=await request('/hero',multipart([{name:'image',filename:'hero.png',bytes:image},{name:'category',bytes:'ring'}]),{accept:'image/png'});
  assert.equal(r.status,200);assert.equal(r.headers['x-hero-status'],'candidate_only');assert.equal(r.headers['x-gleor-release-gate'],'FAIL');record('legacy hero successful candidate','/hero',r,h.calls);
});

// Remediation cases are additional to the original recorded 19 HTTP checks.
test('HTTP remediation conflicting filename material cannot release',async t=>{
  const v=truth();v.metal_type.value='silver';const {h,request}=await server(t,{replies:{product_truth:v}});
  const r=await request('/catalog',await catalogBody('ring','ring-gold-14k-SKU123.jpg'));denied(r);assert.equal(r.status,422);assert.equal(r.body.production.identity_lock,null);assert.equal(h.rendererCalls(),0);record('remediation metadata conflict','/catalog',r,h.calls);
});
for(const [value,visible_count] of [[false,3],[true,0]]) test(`HTTP remediation contradictory gemstones ${value}/${visible_count}`,async t=>{
  const v=truth();v.gemstone_presence={value,visible_count,count_confidence:1};const {h,request}=await server(t,{replies:{product_truth:v}});
  const r=await request('/catalog',await catalogBody());denied(r);assert.equal(r.status,422);assert.equal(r.body.production.identity_lock,null);assert.ok(!h.calls.includes('production_comparison'));record('remediation gemstone contradiction','/catalog',r,h.calls);
});

// Downstream readiness: actual Express responses require persisted bundle validation.
test('HTTP release response includes manifest bound to the exact returned image bytes',async t=>{
  const {h,request}=await server(t);const r=await request('/catalog',await catalogBody(),{'x-catalog-include-artifacts':'1'});
  assert.equal(r.status,200);assert.equal(r.body.asset_state,'RELEASED');
  const bytes=Buffer.from(r.body.artifacts.render_candidate_base64,'base64');
  const digest=require('crypto').createHash('sha256').update(bytes).digest('hex');
  assert.equal(r.body.release_manifest.candidate_sha256,digest);
  assert.equal(r.body.release_manifest.run_id,r.body.production.run_id);
  assert.deepEqual(bytes,h.load('catalog/writer.js').readReleased(r.body.sku,r.body.production.run_id).bytes);
  record('manifest-bound HTTP bytes','/catalog',r,h.calls);
});
for(const tamper of ['missing','digest']) test(`HTTP refuses release when persisted manifest is ${tamper}`,async t=>{
  const {h,request}=await server(t,{beforeApp(h){
    const writer=h.load('catalog/writer.js'), read=writer.readReleased;let reads=0;
    writer.readReleased=(sku,runId)=>{
      if(++reads===2){const dir=path.join(h.directory,'outputs',sku,runId);const file=path.join(dir,tamper==='missing'?'release.json':'final.png');fs.unlinkSync(file);if(tamper==='digest')fs.writeFileSync(file,'tampered');}
      return read(sku,runId);
    };
  }});
  const r=await request('/catalog',await catalogBody(),{'x-catalog-include-artifacts':'1'});
  denied(r);assert.equal(r.status,500);assert.ok(!r.body.release_manifest);record(`persisted ${tamper} blocked`,'/catalog',r,h.calls);
});

for(const failure of ['remove','sync']) test(`HTTP committed release survives housekeeping ${failure} failure`,async t=>{
  const remove=fs.rmSync,sync=fs.fsyncSync;let cleaned=false,fired=false;
  const {h,request}=await server(t);
  fs.rmSync=function(p,...rest){if(String(p).startsWith(h.directory)&&String(p).includes('.staging-')){if(failure==='remove'){fired=true;throw Error('HOUSEKEEPING_REMOVE');}const r=remove.call(fs,p,...rest);cleaned=true;return r;}return remove.call(fs,p,...rest);};
  fs.fsyncSync=function(fd){if(failure==='sync'&&cleaned&&!fired){fired=true;throw Error('HOUSEKEEPING_SYNC');}return sync.call(fs,fd);};
  let r;try{r=await request('/catalog',await catalogBody());}finally{fs.rmSync=remove;fs.fsyncSync=sync;}
  assert.equal(fired,true);assert.equal(r.status,200);assert.equal(r.body.production.lifecycle,'ACTIVE');assert.equal(r.body.production.publication_authorized,true);assert.equal(r.headers['x-gleor-release-gate'],'PASS');assert.equal(r.body.asset_state,'RELEASED');assert.equal(r.body.housekeeping_status,'PENDING');assert.equal(r.body.cleanup_pending,true);assert.ok(!r.body.publication_failure);assert.notEqual(r.body.quarantine_required,true);assert.ok(r.body.warnings.length);assert.ok(r.body.warnings.every(w=>!w.includes('/')));
  assert.equal(h.load('catalog/writer.js').readReleased(r.body.sku,r.body.production.run_id).manifest.asset_state,'RELEASED');record(`housekeeping ${failure} debt`,'/catalog',r,h.calls);
});

for(const denyDiagnostic of [false,true]) test(`HTTP rollback quarantine signal survives diagnostic persistence failure=${denyDiagnostic}`,async t=>{
  const logs=[],{h,request}=await server(t,{console:{...console,error:v=>logs.push(v)}});
  const content=await catalogBody(),fault=require('./helpers/rollback-fault').rollbackFault({directory:h.directory,denyRevocation:true,denyDiagnostic});let r;
  try{r=await request('/catalog',content,{'x-catalog-include-artifacts':'1'});}finally{fault.restore();}
  denied(r);assert.equal(r.status,500);assert.equal(r.body.publication_failure.publication_status,'FAILED');assert.equal(r.body.publication_failure.rollback_status,'FAILED');assert.equal(r.body.publication_failure.code,'MANIFEST_REVOCATION_FAILED');assert.equal(r.body.publication_failure.quarantine_required,true);assert.ok(!r.body.artifacts);assert.ok(!r.body.release_manifest);
  assert.ok(!/\/private\/|PRIVATE_|secret-fixture|offline-fixture/.test(JSON.stringify(r.body)));
  assert.equal(logs.length,denyDiagnostic?1:0);if(denyDiagnostic){const event=JSON.parse(logs[0]);assert.equal(event.event,'RELEASE_ROLLBACK_FAILED');assert.equal(event.run_id,r.body.production.run_id);assert.ok(!logs[0].includes('/'));}
  record('rollback quarantine required','/catalog',r,h.calls);
});
