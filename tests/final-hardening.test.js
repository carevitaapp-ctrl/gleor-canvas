const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const net = require('net');
const http = require('http');
const { harness, input } = require('./helpers/production-harness');
const guardSource = fs.readFileSync(path.join(__dirname,'helpers/network-guard.cjs'),'utf8');
function isolatedGuard() {
  const calls=[];
  const fakeNet={Socket:function(){}};
  fakeNet.Socket.prototype.connect=function(...args){calls.push(args);return this;};
  const modules={net:fakeNet,https:{},tls:{}};
  vm.runInNewContext(guardSource,{require:n=>modules[n]});
  return {connect:(...args)=>fakeNet.Socket.prototype.connect.call({},...args),calls,modules};
}
test('guard permits loopback TCP using native normalized net.connect form',{timeout:5000},async t=>{
  const server=net.createServer(socket=>socket.end('loopback'));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const body=await new Promise((resolve,reject)=>{const socket=net.connect(server.address().port,'localhost');t.after(()=>socket.destroy());let data='';socket.on('data',b=>data+=b);socket.once('end',()=>resolve(data));socket.once('error',reject);});
  assert.equal(body,'loopback');
});
test('guard permits actual loopback HTTP',{timeout:5000},async t=>{
  const server=http.createServer((req,res)=>res.end('local HTTP'));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const body=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port},res=>{let data='';res.on('data',b=>data+=b);res.once('end',()=>resolve(data));});req.once('error',reject);});
  assert.equal(body,'local HTTP');
});
test('guard rejects external TCP in object, positional and normalized array forms',()=>{
  const g=isolatedGuard();
  for(const args of [[{port:80,host:'external.invalid'}],[80,'external.invalid'],['80','203.0.113.1'],[[{port:80,host:'external.invalid'},undefined]]]) assert.throws(()=>g.connect(...args),/TEST_NETWORK_BLOCKED/);
  assert.equal(g.calls.length,0);
});
test('native net.connect normalized array cannot reach external transport',()=>{
  const original=net.Socket.prototype.connect;let transportCalls=0;
  try {
    net.Socket.prototype.connect=function(){transportCalls++;throw Error('UNEXPECTED_TRANSPORT');};
    vm.runInNewContext(guardSource,{require:n=>n==='net'?net:{}});
    assert.throws(()=>net.connect({host:'external.invalid',port:80}),/TEST_NETWORK_BLOCKED/);
    assert.equal(transportCalls,0);
  } finally { net.Socket.prototype.connect=original; }
});
test('external plain HTTP rejected before any transport',{timeout:5000},async()=>{
  const original=net.Socket.prototype.connect;let transportCalls=0;
  try {
    net.Socket.prototype.connect=function(){transportCalls++;throw Error('UNEXPECTED_TRANSPORT');};
    vm.runInNewContext(guardSource,{require:n=>n==='net'?net:{}});
    await assert.rejects(new Promise((resolve,reject)=>{try{const req=http.get('http://external.invalid/',()=>reject(Error('UNEXPECTED_RESPONSE')));req.once('error',reject);}catch(e){reject(e);}}),/TEST_NETWORK_BLOCKED/);
    assert.equal(transportCalls,0);
  } finally {net.Socket.prototype.connect=original;}
});
test('external HTTPS and TLS remain rejected',()=>{
  const {modules}=isolatedGuard();assert.throws(()=>modules.https.request('https://external.invalid'),/TEST_NETWORK_BLOCKED/);assert.throws(()=>modules.https.get('https://external.invalid'),/TEST_NETWORK_BLOCKED/);assert.throws(()=>modules.tls.connect({host:'external.invalid',port:443}),/TEST_NETWORK_BLOCKED/);
});
test('guard normalizes supported loopback forms and preserves local IPC',()=>{
  const g=isolatedGuard(),cb=()=>{};
  for(const args of [[1234],[1234,cb],['1234','localhost',cb],[{port:1234,host:'::1'},cb],[[{port:1234,host:'localhost'},cb]],['/tmp/gleor-test-only.sock',cb],[{path:'/tmp/gleor-test-only.sock'},cb]])g.connect(...args);
  assert.equal(g.calls.length,7);assert.equal(g.calls[2][0].host,'127.0.0.1');assert.equal(g.calls[3][0].host,'::1');assert.equal(g.calls[4][0].host,'127.0.0.1');assert.equal(g.calls[5][0].path,'/tmp/gleor-test-only.sock');assert.equal(g.calls[5][1],cb);
});
test('guard fails closed on malformed destinations without transport',()=>{
  const g=isolatedGuard();for(const args of [[],[null],[{}],[{port:80,host:null}],[{port:80,host:[]}],[{port:80,host:'127.0.0.1.external.invalid'}],[{port:'bad',host:'localhost'}],[[[{port:80,host:'localhost'}]]],[80,{},()=>{}]])assert.throws(()=>g.connect(...args),/TEST_NETWORK_BLOCKED/);assert.equal(g.calls.length,0);
});
for(const field of ['finish_id','finish_revision']) for(const [kind,value] of [['array',['preserve-source']],['object',{}],['number',1],['boolean',true],['null',null]]) test(`finish ${field} rejects ${kind} without providers`,async t=>{
  const h=harness();t.after(h.cleanup);await assert.rejects(h.load('catalog/index.js').runCatalogPipeline({...await input(),productionOptions:{[field]:value}}),e=>e.message==='INVALID_FINISH_OPTIONS' && e.production.publication_authorized===false);assert.equal(h.calls.length,0);assert.equal(h.rendererCalls(),0);
});
test('registered string finish/revision reaches release through real orchestration',async t=>{
  const h=harness();t.after(h.cleanup);const r=await h.load('catalog/index.js').runCatalogPipeline({...await input(),productionOptions:{finish_id:'preserve-source',finish_revision:'1'}});assert.equal(r.production.stages.RELEASE_GATE.status,'PASS');assert.equal(r.production.finish.finish_id,'preserve-source');assert.equal(r.production.finish.finish_revision,'1');assert.equal(r.production.stages.GATE_A.status,'PASS');assert.equal(r.production.stages.GATE_B.status,'PASS');
});
test('unknown and inherited string finish names cannot select registry entries',async t=>{
  for(const finish_id of ['unknown','__proto__','constructor','toString']) {const h=harness();t.after(h.cleanup);await assert.rejects(h.load('catalog/index.js').runCatalogPipeline({...await input(),productionOptions:{finish_id}}),e=>e.code==='UNREGISTERED_FINISH_OR_REVISION');assert.equal(h.calls.length,0);}
});
