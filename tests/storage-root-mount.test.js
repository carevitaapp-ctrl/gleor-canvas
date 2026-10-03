'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const http = require('http');
const {harness, input} = require('./helpers/production-harness');
const dataRoot = '/srv/gleor/data';
const entry = (mount='/', type='ext4', id=36) => `${id} 25 8:1 / ${mount} rw - ${type} /dev/vda1 rw\n`;
function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gleor-root-mount-')));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const disk=p=>p==='/'?base:path.join(base,p.slice(1));
  fs.mkdirSync(disk(dataRoot),{recursive:true,mode:0o700});
  for(const p of [base,disk('/srv'),disk('/srv/gleor')]) fs.chmodSync(p,0o755);
  const f={base,disk,info:entry(),mutate:()=>{},rootInspections:0,afterCall:()=>{}};
  // Only test FS calls are redirected. Application modules execute unchanged;
  // data writes, hard links, fsync and release reads use real temporary files.
  const mapped=p=>typeof p==='string'&&(p==='/'||p==='/srv'||p.startsWith('/srv/'));
  f.fs=new Proxy(fs,{get(target,key){
    const value=target[key]; if(typeof value!=='function')return value;
    return (...args)=>{
      if(key==='readFileSync'&&args[0]==='/proc/self/mountinfo')return f.info;
      const original=args[0];
      const result=value.apply(target,args.map(p=>mapped(p)?disk(p):p));
      if(['statSync','lstatSync'].includes(key)&&mapped(original)) {
        if(['/','/srv','/srv/gleor'].includes(original))result.uid=0;
        if(original==='/')f.rootInspections++;
        f.mutate(original,result);
      }
      if(key==='realpathSync'&&mapped(original)) {
        assert.ok(result===base||result.startsWith(base+'/'));
        return result===base?'/':result.slice(base.length);
      }
      f.afterCall(key,args);
      return result;
    };
  }});
  f.env={NODE_ENV:'production',GLEOR_DATA_MOUNT:'/',GLEOR_DATA_ROOT:dataRoot};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../production/storage.js'),'utf8'),{
    module,process:{env:{},platform:'linux',getuid:()=>process.getuid()},require:n=>n==='fs'?f.fs:require(n),
  });
  f.storage=(env={})=>module.exports.createStorage({...f.env,...env});
  f.app=()=>{const h=harness({fs:f.fs,platform:'linux',env:f.env});t.after(h.cleanup);return h;};
  return f;
}
test('DigitalOcean exact ext4 root mount with service-owned descendant is ready',t=>{
 const f=fixture(t),s=f.storage(); assert.equal(s.initialize().ready,true);
 assert.equal(s.paths().outputs,dataRoot+'/outputs');assert.ok(f.rootInspections>0);
 assert.deepEqual(fs.readdirSync(f.disk(dataRoot+'/outputs')),[]);
});
for(const type of ['overlay','tmpfs','nfs'])test(`root mount rejects ${type}`,t=>{
 const f=fixture(t);f.info=entry('/',type);assert.equal(f.storage().initialize().ready,false);
 assert.deepEqual(fs.readdirSync(f.disk(dataRoot)),[]);
});
for(const scenario of ['missing','duplicate','application-root-is-slash','mount-not-configured','noncanonical-root','relative-root'])test(`root mount rejects ${scenario}`,t=>{
 const f=fixture(t),env={};
 if(scenario==='missing')f.info=entry('/other');
 if(scenario==='duplicate')f.info=entry()+entry('/','ext4',37);
 if(scenario==='application-root-is-slash')env.GLEOR_DATA_ROOT='/';
 if(scenario==='mount-not-configured')env.GLEOR_DATA_MOUNT=undefined;
 if(scenario==='noncanonical-root')env.GLEOR_DATA_ROOT='/srv/gleor/../gleor/data';
 if(scenario==='relative-root')env.GLEOR_DATA_ROOT='srv/gleor/data';
 assert.equal(f.storage(env).initialize().ready,false);
});
test('unrelated system and Docker mounts allowed under trusted root mount',t=>{
 const f=fixture(t);f.info+=['/proc','/sys','/dev','/run','/boot','/boot/efi','/var/lib/docker/overlay2/example/merged','/srv/gleor/database'].map((p,i)=>entry(p,'tmpfs',40+i)).join('');
 assert.equal(f.storage().initialize().ready,true);
});
for(const nested of ['/srv','/srv/gleor',dataRoot,dataRoot+'/inputs',dataRoot+'/outputs',dataRoot+'/outputs/sku/.staging-run'])test(`reject intersecting mount ${nested}`,t=>{
 const f=fixture(t);f.info+=entry(nested,'ext4',37);assert.equal(f.storage().initialize().ready,false);
});
for(const component of ['/srv','/srv/gleor',dataRoot])test(`reject symlink component ${component}`,t=>{
 const f=fixture(t),target=f.disk(component)+'-actual';fs.renameSync(f.disk(component),target);fs.symlinkSync(target,f.disk(component));
 assert.equal(f.storage().initialize().ready,false);
});
for(const component of ['/','/srv','/srv/gleor',dataRoot])test(`reject unsafe mode at ${component}`,t=>{
 const f=fixture(t);fs.chmodSync(f.disk(component),0o777);assert.equal(f.storage().initialize().ready,false);
});
test('application root requires service UID ownership',t=>{
 const f=fixture(t);f.mutate=(p,s)=>{if(p===dataRoot)s.uid=process.getuid()+1;};assert.equal(f.storage().initialize().ready,false);
});
test('different root and application devices fail closed',t=>{
 const f=fixture(t);f.mutate=(p,s)=>{if(p===dataRoot)s.dev+=1;};assert.equal(f.storage().initialize().ready,false);
});
for(const change of ['root-inode','root-device','mount-id','nested'])test(`root readiness rejects and latches ${change} replacement`,t=>{
 const f=fixture(t),s=f.storage();assert.equal(s.initialize().ready,true);
 if(change==='root-inode')f.mutate=(p,s)=>{if(p==='/')s.ino+=1;};
 if(change==='root-device')f.mutate=(p,s)=>{if(p==='/')s.dev+=1;};
 if(change==='mount-id')f.info=entry('/','ext4',99);
 if(change==='nested')f.info+=entry(dataRoot+'/outputs','tmpfs',37);
 assert.equal(s.status().ready,false);f.mutate=()=>{};f.info=entry();assert.equal(s.status().ready,false);
});
test('root identity change during hard-link preflight fails closed',t=>{
 const f=fixture(t);let changed=false;
 f.afterCall=(method,args)=>{if(method==='linkSync'&&args[0].includes('.preflight-'))changed=true;};
 f.mutate=(p,s)=>{if(p==='/'&&changed)s.ino+=1;};
 assert.equal(f.storage().initialize().ready,false);assert.equal(changed,true);
});
test('sticky world-writable filesystem root is rejected',t=>{
 const f=fixture(t);f.mutate=(p,s)=>{if(p==='/')s.mode=0o41777;};
 assert.equal(f.storage().initialize().ready,false);
});
test('DigitalOcean configuration publishes and consumes actual Runtime V2 release',async t=>{
 const f=fixture(t),h=f.app();assert.equal(h.load('production/storage.js').initialize().ready,true);
 const r=await h.load('catalog/index.js').runCatalogPipeline(await input());assert.equal(r.final_approval,true);
 assert.ok(r.bundle.dir.startsWith(dataRoot+'/outputs/'));
 const released=h.load('catalog/writer.js').readReleased(r.sku,r.production.run_id);
 assert.ok(released.bytes.length>0);
 assert.deepEqual(released.bytes,fs.readFileSync(f.disk(path.join(r.bundle.dir,'final.png'))));
});
for(const type of ['overlay','tmpfs'])test(`invalid ${type} root gives health false and pre-parser catalog 503`,async t=>{
 const f=fixture(t);f.info=entry('/',type);const h=f.app(),app=h.load('server.js');
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(method,url,contentType,body='')=>new Promise((resolve,reject)=>{
  const q=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method,headers:{'content-type':contentType}},r=>{
   let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(body)}));
  });q.on('error',reject);q.end(body);
 });
 for(const contentType of ['application/json','multipart/form-data']) {
  const r=await request('POST','/catalog',contentType,'{invalid');assert.equal(r.status,503);assert.equal(r.body.error,'PRODUCTION_STORAGE_NOT_READY');
  assert.ok(!JSON.stringify(r).includes('/srv/'));
 }
 const health=await request('GET','/health','application/json');assert.equal(health.status,200);assert.equal(health.body.alive,true);assert.equal(health.body.storage.ready,false);
 assert.ok(!JSON.stringify(health).includes('/srv/'));assert.ok(!JSON.stringify(health).includes(f.base));
 assert.equal(h.calls.length,0);assert.equal(h.rendererCalls(),0);assert.deepEqual(fs.readdirSync(f.disk(dataRoot)),[]);
});
