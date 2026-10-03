'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createStorage } = require('../production/storage');
const { harness, input, gate } = require('./helpers/production-harness');
function fixture(t) { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gleor-storage-test-'))); t.after(() => fs.rmSync(p, {recursive:true,force:true})); return p; }
function localStorage(root, extra = {}) { return createStorage({ NODE_ENV: 'test', GLEOR_DATA_ROOT: root, ...extra }); }
for (const [name, env] of Object.entries({missing:{NODE_ENV:'production'},empty:{NODE_ENV:'production',GLEOR_DATA_ROOT:''},relative:{NODE_ENV:'production',GLEOR_DATA_ROOT:'data'},implicit:{},typo:{NODE_ENV:'prod'},testOnRender:{NODE_ENV:'test',RENDER:'true'}})) {
 test(`storage rejects ${name} without fallback`,()=>{const s=createStorage(env); assert.equal(s.initialize().ready,false);assert.throws(()=>s.paths(),/STORAGE_NOT_READY/);});
}
test('trusted configured test root passes without PhotoRoom',t=>{const root=fixture(t),s=localStorage(root);assert.deepEqual(s.initialize(),{configured:true,ready:true});for(const p of Object.values(s.paths())) assert.ok(p.startsWith(root+'/'));assert.deepEqual(fs.readdirSync(s.paths().outputs),[]);});
test('absent configured root is never created',t=>{const root=path.join(fixture(t),'absent');assert.equal(localStorage(root).initialize().ready,false);assert.equal(fs.existsSync(root),false);});
for (const suffix of ['/../escape','/./child','/']) test(`noncanonical root rejected ${suffix}`,t=>{assert.equal(localStorage(fixture(t)+suffix).initialize().ready,false);});
for(const mode of ['test','development']) test(`explicit ${mode} uses isolated temporary default`,()=>{const s=createStorage({NODE_ENV:mode});assert.equal(s.initialize().ready,true);const root=path.dirname(s.paths().inputs);try{assert.ok(!root.includes('/var/data'));assert.ok(!root.includes('gleor-canvas'));assert.equal(s.status().configured,false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
for(const child of ['alias','inputs','outputs','renders']) test(`reject symlink ${child}`,t=>{const root=fixture(t),target=fixture(t);fs.symlinkSync(target,path.join(root,child));assert.equal(localStorage(child==='alias'?path.join(root,child):root).initialize().ready,false);});
test('reject unsafe root and child permissions',t=>{for(const child of ['', 'inputs']){const root=fixture(t),dir=child?path.join(root,child):root;if(child)fs.mkdirSync(dir);fs.chmodSync(dir,0o777);assert.equal(localStorage(root).initialize().ready,false);}});
test('reject ownership mismatch',t=>{const root=fixture(t),original=fs.lstatSync;try{fs.lstatSync=function(p,...a){const s=original.call(this,p,...a);if(p===root)s.uid=process.getuid()+1;return s;};assert.equal(localStorage(root).initialize().ready,false);}finally{fs.lstatSync=original;}});
test('reject child escape and replaced child after preflight',t=>{const root=fixture(t),s=localStorage(root);s.initialize();const outputs=s.paths().outputs;for(const part of ['..','../escape','/tmp','a/b',''])assert.throws(()=>s.directory(outputs,part));fs.rmdirSync(outputs);fs.symlinkSync(fixture(t),outputs);assert.equal(s.status().ready,false);assert.throws(()=>s.paths());});
test('reject unsafe input hash directory before writing',async t=>{const h=harness();t.after(h.cleanup);const w=h.load('catalog/writer.js'),storage=h.load('production/storage.js');storage.initialize();const args=await input();const validated=await h.load('catalog/inputContract.js').validateInputs(args);fs.symlinkSync(fixture(t),path.join(storage.paths().inputs,validated.originalRaw.sha256));assert.throws(()=>w.writeInputs(validated),/STORAGE_NOT_READY/);assert.equal(h.calls.length,0);});
for(const op of ['linkSync','fsyncSync']) test(`preflight fails closed if ${op} unavailable`,t=>{const s=localStorage(fixture(t));const old=fs[op];try{fs[op]=()=>{throw Error('unsupported');};assert.equal(s.initialize().ready,false);}finally{fs[op]=old;}assert.equal(s.status().ready,false);});
test('production never borrows a development root',t=>{const root=fixture(t),local=createStorage({NODE_ENV:'development',GLEOR_DATA_ROOT:root});assert.equal(local.initialize().ready,true);assert.equal(createStorage({NODE_ENV:'production'}).initialize().ready,false);});
test('Render cannot use an ordinary unmounted directory',t=>{assert.equal(localStorage(fixture(t),{RENDER:'true'}).initialize().ready,false);});
test('configured writer publishes and consumes real verified bytes; staging inside outputs',async t=>{const h=harness();t.after(h.cleanup);h.load('production/storage.js').initialize();const old=fs.linkSync,stages=[];try{fs.linkSync=function(a,b,...rest){if(a.includes('.staging-')){stages.push(a);assert.ok(a.startsWith(path.join(h.directory,'outputs')+'/'));assert.equal(fs.statSync(path.dirname(a)).dev,fs.statSync(path.dirname(b)).dev);}return old.call(this,a,b,...rest);};const r=await h.load('catalog/index.js').runCatalogPipeline(await input());assert.equal(r.final_approval,true);assert.ok(r.inputAssets.original_raw.path.startsWith(path.join(h.directory,'inputs')+'/'));assert.ok(r.bundle.dir.startsWith(path.join(h.directory,'outputs')+'/'));assert.ok(stages.length>0);assert.ok(h.load('catalog/writer.js').readReleased(r.sku,r.production.run_id).bytes.length>0);}finally{fs.linkSync=old;}});
test('manual review and failure evidence stay beneath configured root',async t=>{const b=gate('B');b.criteria.framing.score=0;const h=harness({replies:{gate_b:b}});t.after(h.cleanup);const r=await h.load('catalog/index.js').runCatalogPipeline(await input());assert.equal(r.final_approval,false);assert.ok(r.bundle.dir.startsWith(path.join(h.directory,'renders/manual')+'/'));assert.equal(fs.existsSync(path.join(r.bundle.dir,'release.json')),false);});
async function serve(t,env){const h=harness({env});t.after(h.cleanup);const app=h.load('server.js');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));return {h,get:(url,method='GET',headers={},body='')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(body)}));});q.on('error',reject);q.end(body);})};}
for(const ready of [true,false])test(`HTTP health reports storage ready=${ready} without writes or providers`,async t=>{const {h,get}=await serve(t,ready?{PHOTOROOM_API_KEY:undefined}:{GLEOR_DATA_ROOT:''});const before=fs.readdirSync(h.directory);const r=await get('/health');assert.equal(r.status,200);assert.equal(r.body.alive,true);assert.equal(r.body.storage.ready,ready);assert.equal(r.body.storage.configured,true);assert.ok(!JSON.stringify(r).includes(h.directory));assert.deepEqual(fs.readdirSync(h.directory),before);assert.equal(h.calls.length,0);});
for(const route of ['/catalog','/CATALOG/','/hero','/hero-a','/hero-b','/hero-c','/process'])test(`HTTP storage-not-ready blocks ${route} before providers`,async t=>{const {h,get}=await serve(t,{GLEOR_DATA_ROOT:''});const r=await get(route,'POST');assert.equal(r.status,503);assert.equal(r.body.error,'PRODUCTION_STORAGE_NOT_READY');assert.equal(r.body.final_approval,false);assert.equal(h.calls.length,0);assert.deepEqual(fs.readdirSync(h.directory),[]);});

test('readiness remains false after failed probe even if filesystem recovers', t => {
  const root = fixture(t), storage = localStorage(root), old = fs.linkSync;
  try { fs.linkSync = () => { throw Error('unsupported'); }; assert.equal(storage.initialize().ready, false); }
  finally { fs.linkSync = old; }
  assert.equal(storage.initialize().ready, false);
  assert.throws(() => storage.paths(), /STORAGE_NOT_READY/);
});
test('failure diagnostics route only to configured manual root', t => {
  const h = harness(); t.after(h.cleanup);
  const file = h.load('catalog/writer.js').writeFailure({run_id: require('crypto').randomUUID(), publication_authorized:false});
  assert.ok(file.startsWith(path.join(h.directory, 'renders/manual/failed-runs') + '/'));
  assert.equal(JSON.parse(fs.readFileSync(file)).publication_authorized, false);
});
test('health uses no mutating filesystem operations', async t => {
  const {get} = await serve(t, {}), original = {};
  for (const name of ['mkdirSync','writeFileSync','linkSync','unlinkSync','rmSync','fsyncSync']) { original[name] = fs[name]; fs[name] = () => { throw Error('HEALTH_MUST_NOT_WRITE'); }; }
  try { const r = await get('/health'); assert.equal(r.body.storage.ready,true); }
  finally { Object.assign(fs,original); }
});
test('read-only configured directory is not ready',t=>{const root=fixture(t);fs.chmodSync(root,0o500);try{assert.equal(localStorage(root).initialize().ready,false);}finally{fs.chmodSync(root,0o700);}});

for (const mount of [undefined, 'relative-mount']) test(`missing/invalid mount blocks malformed upload before parsing: ${mount}`, async t => {
  const {h,get}=await serve(t,{NODE_ENV:'production',GLEOR_DATA_MOUNT:mount});
  for (const route of ['/catalog','/hero','/hero-a','/hero-b','/hero-c','/process']) {
    for (const type of ['application/json','multipart/form-data']) {
      const r=await get(route,'POST',{'content-type':type},'{invalid');
      assert.equal(r.status,503); assert.equal(r.body.error,'PRODUCTION_STORAGE_NOT_READY');
    }
  }
  const r=await get('/health'); assert.equal(r.status,200); assert.equal(r.body.alive,true);
  assert.equal(r.body.storage.ready,false); assert.equal(r.body.storage.configured,true);
  assert.ok(!JSON.stringify(r).includes(h.directory)); assert.ok(!JSON.stringify(r).includes('relative-mount'));
  assert.equal(h.calls.length,0); assert.equal(h.rendererCalls(),0); assert.deepEqual(fs.readdirSync(h.directory),[]);
});
