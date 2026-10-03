'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { harness, input, gate } = require('./helpers/production-harness');
async function fixture(t) {
  const h = harness(); t.after(h.cleanup);
  const result = await h.load('catalog/index.js').runCatalogPipeline(await input());
  const store = h.load('production/release-store.js');
  const root = path.join(h.directory, 'outputs'), sku = result.sku, runId = result.production.run_id;
  const manifestFile = path.join(result.bundle.dir, 'release.json');
  return { h, result, store, root, sku, runId, manifestFile,
    read: () => store.consumeRelease({root, sku, runId}),
    edit: fn => { const m = JSON.parse(fs.readFileSync(manifestFile)); fn(m); fs.unlinkSync(manifestFile); fs.writeFileSync(manifestFile, JSON.stringify(m)); },
    publication: () => ({root: path.join(h.directory, 'new-releases'), sku, release: result.production,
      assets: Object.fromEntries(store.ASSETS.map(n => [n, fs.readFileSync(path.join(result.bundle.dir,n))]))}),
  };
}
function replace(file, bytes) { fs.unlinkSync(file); fs.writeFileSync(file, bytes); }
test('release consumer accepts complete durable bundle and returns exact published bytes', async t => {
  const f = await fixture(t), r = f.read();
  assert.deepEqual(r.bytes, fs.readFileSync(f.result.bundle.files.final));
  assert.equal(r.manifest.candidate_sha256, require('crypto').createHash('sha256').update(r.bytes).digest('hex'));
  assert.equal(r.manifest.run_id, f.result.production.run_id);
});
for (const [name, change] of [
  ['missing manifest', f => fs.unlinkSync(f.manifestFile)],
  ['malformed manifest', f => replace(f.manifestFile, '{')],
  ['candidate state', f => f.edit(m => m.asset_state = 'CANDIDATE_ONLY')],
  ['manual review', f => f.edit(m => m.production.stages.RELEASE_GATE.status = 'REVIEW_REQUIRED')],
  ['rejected release', f => f.edit(m => m.production.publication_authorized = false)],
  ['wrong SKU', f => f.edit(m => m.sku = 'other')],
  ['wrong run', f => f.edit(m => m.run_id = 'other')],
  ['different filename', f => f.edit(m => m.assets['final.png'].file = 'candidate.png')],
  ['manifest traversal', f => f.edit(m => m.assets['final.png'].file = '../final.png')],
  ['wrong candidate digest', f => f.edit(m => m.candidate_sha256 = '0'.repeat(64))],
  ['wrong asset digest', f => f.edit(m => m.assets['final.png'].sha256 = '0'.repeat(64))],
  ['changed published bytes', f => replace(f.result.bundle.files.final, Buffer.from('different'))],
  ['missing required asset', f => fs.unlinkSync(f.result.bundle.files.prompt)],
  ['extra unrecognized manifest asset', f => f.edit(m => m.assets.extra = {})],
  ['wrong generation', f => f.edit(m => m.production.stages.GATE_B.generation++)],
  ...['runtime_version','core_visual_rules','earring_standard'].map(k => [`wrong ${k}`, f => f.edit(m => m.production[k] = '1.0.0')]),
]) test(`consumer rejects ${name}`, async t => { const f = await fixture(t); change(f); assert.throws(f.read); });
test('caller path traversal and staging names are rejected', async t => {
  const f = await fixture(t);
  for (const args of [{sku:'../other',runId:f.runId},{sku:f.sku,runId:'../other'},{sku:f.sku,runId:'.staging-123'}]) assert.throws(() => f.store.consumeRelease({root:f.root,...args}));
});
test('actual manual-review writer output cannot be consumed as release', async t => {
  const a=gate('A');a.criteria.geometry_fidelity.score=0;
  const h=harness({replies:{gate_a:a}});t.after(h.cleanup);
  const result=await h.load('catalog/index.js').runCatalogPipeline(await input());
  assert.equal(result.final_approval,false);assert.equal(result.bundle.asset_state,'CANDIDATE_ONLY');
  assert.equal(fs.existsSync(path.join(result.bundle.dir,'release.json')),false);
  const root=path.join(h.directory,'renders','manual');
  assert.throws(()=>h.load('production/release-store.js').consumeRelease({root,sku:result.sku,runId:path.basename(result.bundle.dir)}));
});
test('serialized release metadata is not a publication capability', async t => {
  const f=await fixture(t), args=f.publication();args.release=JSON.parse(JSON.stringify(args.release));
  assert.throws(()=>f.store.publishRelease(args));assert.equal(fs.existsSync(args.root),false);
});
for(const part of ['root','sku','ancestor','asset','manifest']) test(`symlink ${part} is denied without following target`, async t=>{
  const f=await fixture(t), outside=path.join(f.h.directory,'outside');fs.mkdirSync(outside);
  if(part==='asset'||part==='manifest') {
    const file=part==='asset'?f.result.bundle.files.final:f.manifestFile;
    const target=path.join(outside,'target');fs.writeFileSync(target,'sentinel');fs.unlinkSync(file);fs.symlinkSync(target,file);
    assert.throws(f.read);assert.equal(fs.readFileSync(target,'utf8'),'sentinel');return;
  }
  const args=f.publication();
  if(part==='root')fs.symlinkSync(outside,args.root);
  if(part==='sku'){fs.mkdirSync(args.root);fs.symlinkSync(outside,path.join(args.root,args.sku));}
  if(part==='ancestor'){const link=path.join(f.h.directory,'linked');fs.symlinkSync(outside,link);args.root=path.join(link,'releases');}
  assert.throws(()=>f.store.publishRelease(args));assert.deepEqual(fs.readdirSync(outside),[]);
});
test('existing destination including empty directory cannot be overwritten', async t=>{
  const f=await fixture(t), before=f.read().bytes;
  const args=f.publication();args.root=f.root;assert.throws(()=>f.store.publishRelease(args),/EEXIST/);assert.deepEqual(f.read().bytes,before);
  args.root=path.join(f.h.directory,'empty-collision');fs.mkdirSync(path.join(args.root,args.sku,args.release.run_id),{recursive:true});
  assert.throws(()=>f.store.publishRelease(args),/EEXIST/);assert.deepEqual(fs.readdirSync(path.join(args.root,args.sku,args.release.run_id)),[]);
});
for(const failure of ['asset write','manifest write','partial link','manifest link','directory sync']) test(`publication fails closed on ${failure}`,async t=>{
  const f=await fixture(t), args=f.publication();let fired=false;
  const method=failure.includes('write')?'writeFileSync':failure.includes('link')?'linkSync':'fsyncSync';
  const original=fs[method], open=fs.openSync, close=fs.closeSync, fds=new Map();
  fs.openSync=function(p,...rest){const fd=open.call(fs,p,...rest);fds.set(fd,String(p));return fd;};
  fs.closeSync=function(fd){fds.delete(fd);return close.call(fs,fd);};
  fs[method]=function(...a){
    const p=method==='writeFileSync'||method==='fsyncSync'?fds.get(a[0]):String(a[1]);
    const hit=p?.startsWith(args.root) && (failure==='asset write'?p.endsWith('/final.png'):failure==='manifest write'?p.endsWith('/release.json'):failure==='partial link'?p.endsWith('/prompt.txt'):failure==='manifest link'?p.endsWith('/release.json'):p.endsWith(args.release.run_id));
    if(hit&&!fired){fired=true;throw Error('SIMULATED_FAILURE');}return original.apply(fs,a);
  };
  try {assert.throws(()=>f.store.publishRelease(args),/SIMULATED_FAILURE/);} finally {fs[method]=original;fs.openSync=open;fs.closeSync=close;}
  assert.equal(fired,true);assert.throws(()=>f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}));
  assert.ok(!fs.readdirSync(path.join(args.root,args.sku)).some(n=>n.startsWith('.staging-')));
});
test('interrupted staging and partial destination are not valid releases',async t=>{
  const f=await fixture(t), args=f.publication(), parent=path.join(args.root,args.sku);fs.mkdirSync(parent,{recursive:true});
  const stage=path.join(parent,'.staging-interrupted');fs.mkdirSync(stage);fs.writeFileSync(path.join(stage,'final.png'),args.assets['final.png']);
  const dir=path.join(parent,args.release.run_id);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'final.png'),args.assets['final.png']);
  assert.throws(()=>f.store.consumeRelease({root:args.root,sku:args.sku,runId:'.staging-interrupted'}));
  assert.throws(()=>f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}));
});
test('manifest commit marker appears only after complete synced assets',async t=>{
  const f=await fixture(t), args=f.publication(), link=fs.linkSync;let checked=false;
  fs.linkSync=function(from,to){if(String(to).startsWith(args.root)&&String(to).endsWith('/release.json')) {
    assert.throws(()=>f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}));
    for(const n of f.store.ASSETS)assert.deepEqual(fs.readFileSync(path.join(path.dirname(to),n)),args.assets[n]);checked=true;
  }return link.call(fs,from,to);};
  try{f.store.publishRelease(args);}finally{fs.linkSync=link;}
  assert.equal(checked,true);assert.deepEqual(f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}).bytes,args.assets['final.png']);
});

test('post-marker sync failure revokes release marker',async t=>{
  const f=await fixture(t), args=f.publication(), sync=fs.fsyncSync;let fired=false;
  fs.fsyncSync=function(fd){if(!fired&&fs.existsSync(path.join(args.root,args.sku,args.release.run_id,'release.json'))){fired=true;throw Error('POST_MARKER_SYNC');}return sync.call(fs,fd);};
  try{assert.throws(()=>f.store.publishRelease(args),/POST_MARKER_SYNC/);}finally{fs.fsyncSync=sync;}
  assert.equal(fired,true);assert.throws(()=>f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}));
});
test('tampered bytes between linking and publication are rejected',async t=>{
  const f=await fixture(t), args=f.publication(), link=fs.linkSync;let changed=false;
  fs.linkSync=function(from,to){const r=link.call(fs,from,to);if(String(to).startsWith(args.root)&&String(to).endsWith('/final.png')){replace(to,Buffer.from('tampered'));changed=true;}return r;};
  try{assert.throws(()=>f.store.publishRelease(args));}finally{fs.linkSync=link;}
  assert.equal(changed,true);assert.equal(fs.existsSync(path.join(args.root,args.sku,args.release.run_id,'release.json')),false);
});
test('consumer rejects symlinked run directory',async t=>{
  const f=await fixture(t), moved=f.result.bundle.dir+'-moved';fs.renameSync(f.result.bundle.dir,moved);fs.symlinkSync(moved,f.result.bundle.dir);assert.throws(f.read);
});
test('writer rejects group-writable release root',async t=>{
  const f=await fixture(t), args=f.publication();fs.mkdirSync(args.root);fs.chmodSync(args.root,0o777);assert.throws(()=>f.store.publishRelease(args));
});
test('approved manifest cannot launder rejected QA with recomputed file hash',async t=>{
  const f=await fixture(t), file=f.result.bundle.files.qaReport, qa=JSON.parse(fs.readFileSync(file));qa.final_approval=false;
  const b=Buffer.from(JSON.stringify(qa));replace(file,b);f.edit(m=>{m.assets['qa-report.json'].sha256=require('crypto').createHash('sha256').update(b).digest('hex');m.assets['qa-report.json'].bytes=b.length;});assert.throws(f.read);
});

test('noncanonical configured roots are rejected before publication',async t=>{
  const f=await fixture(t), args=f.publication();args.root=f.h.directory+'/child/../escape';
  assert.throws(()=>f.store.publishRelease(args));assert.throws(()=>f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}));assert.equal(fs.existsSync(path.join(f.h.directory,'escape')),false);
});

for(const failure of ['remove','sync']) test(`remediation commit preserves success after housekeeping ${failure} failure`,async t=>{
  const f=await fixture(t), args=f.publication(), remove=fs.rmSync, sync=fs.fsyncSync;let cleaned=false,fired=false;
  fs.rmSync=function(p,...rest){if(String(p).startsWith(args.root)&&String(p).includes('.staging-')){if(failure==='remove'){fired=true;throw Error('HOUSEKEEPING_REMOVE');}const r=remove.call(fs,p,...rest);cleaned=true;return r;}return remove.call(fs,p,...rest);};
  fs.fsyncSync=function(fd){if(failure==='sync'&&cleaned&&!fired){fired=true;throw Error('HOUSEKEEPING_SYNC');}return sync.call(fs,fd);};
  let result;try{result=f.store.publishRelease(args);}finally{fs.rmSync=remove;fs.fsyncSync=sync;}
  assert.equal(fired,true);assert.equal(result.housekeeping_status,'PENDING');assert.equal(result.cleanup_pending,true);assert.ok(result.warnings.includes(failure==='remove'?'STAGING_CLEANUP_PENDING':'HOUSEKEEPING_SYNC_PENDING'));
  assert.equal(f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}).manifest.asset_state,'RELEASED');
  assert.equal(f.h.load('production/policy.js').authorized(args.release,args.assets['final.png']),true);
});
test('remediation commit asset fsync failure is critical and cannot publish',async t=>{
  const f=await fixture(t),args=f.publication(),open=fs.openSync,close=fs.closeSync,sync=fs.fsyncSync,fds=new Map();let fired=false;
  fs.openSync=function(p,...rest){const fd=open.call(fs,p,...rest);fds.set(fd,String(p));return fd;};fs.closeSync=function(fd){fds.delete(fd);return close.call(fs,fd);};
  fs.fsyncSync=function(fd){if(!fired&&fds.get(fd)?.startsWith(args.root)&&fds.get(fd).endsWith('/final.png')){fired=true;throw Error('ASSET_SYNC');}return sync.call(fs,fd);};
  try{assert.throws(()=>f.store.publishRelease(args),/ASSET_SYNC/);}finally{fs.openSync=open;fs.closeSync=close;fs.fsyncSync=sync;}
  assert.equal(fired,true);assert.throws(()=>f.store.consumeRelease({root:args.root,sku:args.sku,runId:args.release.run_id}));
});
for(const [name,transform] of [
  ['state',s=>s.replace('{','{"asset_state":"REJECTED",')],
  ['schema',s=>s.replace('{','{"contract_version":999,')],
  ['digest',s=>s.replace('"candidate_sha256":','"candidate_sha256":"wrong","candidate_sha256":')],
  ['identical',s=>s.replace('{','{"asset_state":"RELEASED",')],
  ['nested authorization',s=>s.replace('"publication_authorized":','"publication_authorized":false,"publication_authorized":')],
  ['array member',s=>s.replace('{','{"extra":[{"x":1,"x":1}],')],
  ['asset entry',s=>s.replace('"file":','"file":"wrong","file":')],
  ['escaped equivalent',s=>s.replace('{','{"asset_\\u0073tate":"REJECTED",')],
]) test(`remediation duplicate ${name} manifest cannot be consumed`,async t=>{
  const f=await fixture(t);replace(f.manifestFile,transform(fs.readFileSync(f.manifestFile,'utf8')));assert.throws(f.read,/DUPLICATE_RELEASE_JSON_KEY/);
});
for(const name of ['qa-report.json','final-metadata.json']) test(`remediation duplicate keys in ${name} rejected even with matching digest`,async t=>{
  const f=await fixture(t),file=path.join(f.result.bundle.dir,name);const b=Buffer.from(fs.readFileSync(file,'utf8').replace('{','{"final_approval":false,'));replace(file,b);
  f.edit(m=>{m.assets[name].sha256=require('crypto').createHash('sha256').update(b).digest('hex');m.assets[name].bytes=b.length;});assert.throws(f.read,/DUPLICATE_RELEASE_JSON_KEY/);
});
test('trusted storage boundary: coherent persisted forgery is consistency, not cryptographic issuance',async t=>{
  const f=await fixture(t),m=JSON.parse(fs.readFileSync(f.manifestFile)),bytes=Buffer.from('locally forged candidate'),hash=require('crypto').createHash('sha256').update(bytes).digest('hex');
  const rewrite=p=>{p.candidate_sha256=hash;for(const s of ['MACRO_IDENTITY_CHECK','FINISH_IDENTITY_CHECK','GATE_A','GATE_B'])p.stages[s].candidate_sha256=hash;};
  rewrite(m.production);m.candidate_sha256=hash;replace(f.result.bundle.files.final,bytes);
  for(const name of ['qa-report.json','final-metadata.json']){const file=path.join(f.result.bundle.dir,name),v=JSON.parse(fs.readFileSync(file));rewrite(v.production);replace(file,JSON.stringify(v));}
  for(const name of f.store.ASSETS){const b=fs.readFileSync(path.join(f.result.bundle.dir,name));m.assets[name].sha256=require('crypto').createHash('sha256').update(b).digest('hex');m.assets[name].bytes=b.length;}
  replace(f.manifestFile,JSON.stringify(m));assert.equal(f.h.load('production/policy.js').authorized(m.production,bytes),false);assert.deepEqual(f.read().bytes,bytes);
});
test('remediation commit response-validation exception cannot retroactively abort durable release',async t=>{
  const h=harness();t.after(h.cleanup);const writer=h.load('catalog/writer.js'),write=writer.writeBundle;let captured;
  writer.writeBundle=args=>{const result=write(args);captured=args;return result;};
  writer.readReleased=()=>{throw Error('RESPONSE_READ_FAILURE');};
  await assert.rejects(h.load('catalog/index.js').runCatalogPipeline(await input()),/RESPONSE_READ_FAILURE/);
  assert.equal(h.load('production/policy.js').authorized(captured.release,captured.finalPng),true);
  assert.equal(h.load('production/release-store.js').consumeRelease({root:path.join(h.directory,'outputs'),sku:captured.sku,runId:captured.release.run_id}).manifest.asset_state,'RELEASED');
});
