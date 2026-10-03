const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {harness,input}=require('./helpers/production-harness');
const {rollbackFault}=require('./helpers/rollback-fault');
for(const [name,denyRevocation,denyDiagnostic] of [['successful revocation',false,false],['failed revocation',true,false],['independent fallback',true,true]]) test(`rollback observability: ${name}`,async t=>{
  const logs=[],h=harness({console:{...console,error:v=>logs.push(v)}});t.after(h.cleanup);
  const args=await input(),api=h.load('catalog/index.js'),fault=rollbackFault({directory:h.directory,denyRevocation,denyDiagnostic});let error;
  try{await assert.rejects(api.runCatalogPipeline(args),e=>{error=e;return true;});}finally{fault.restore();}
  assert.equal(fault.state.criticalFailed,true);assert.equal(fault.state.revocationFailed,denyRevocation);assert.equal(error.production.publication_authorized,false);
  const d=error.publication_failure;assert.equal(d.publication_status,'FAILED');assert.equal(d.quarantine_required,denyRevocation);assert.match(d.sku,/^[A-Za-z0-9_-]{1,128}$/);assert.equal(d.run_id,error.production.run_id);
  if(denyRevocation){assert.equal(d.code,'MANIFEST_REVOCATION_FAILED');assert.equal(d.rollback_status,'FAILED');assert.ok(fs.existsSync(fault.state.marker));}
  else{assert.equal(fs.existsSync(fault.state.marker),false);assert.equal(d.rollback_status,undefined);}
  if(denyDiagnostic){assert.equal(fault.state.diagnosticFailed,true);assert.equal(logs.length,1);const event=JSON.parse(logs[0]);assert.equal(event.event,'RELEASE_ROLLBACK_FAILED');assert.deepEqual(event,{event:'RELEASE_ROLLBACK_FAILED',...JSON.parse(JSON.stringify(d))});assert.ok(!/\/|PRIVATE_|secret-fixture|offline-fixture|candidate_sha256|assets/.test(logs[0]));}
  else{const saved=JSON.parse(fs.readFileSync(path.join(h.directory,'renders','manual','failed-runs',d.run_id,'production-state.json')));assert.deepEqual(saved.publication_failure,JSON.parse(JSON.stringify(d)));assert.equal(logs.length,0);}
});
