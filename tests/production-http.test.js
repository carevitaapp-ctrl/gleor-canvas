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
  const h=harness(config), app=h.load('server.js');
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
