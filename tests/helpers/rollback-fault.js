// Real filesystem fault injection, restored before fixture cleanup.
const fs = require('fs');
function rollbackFault({ directory, denyRevocation = false, denyDiagnostic = false }) {
  const originals = Object.fromEntries(['linkSync','fsyncSync','unlinkSync','writeFileSync'].map(k=>[k,fs[k]]));
  const state = { marker: null, criticalFailed: false, revocationFailed: false, diagnosticFailed: false };
  fs.linkSync = function(from,to) {
    const r=originals.linkSync.call(fs,from,to);
    if(String(to).startsWith(directory) && String(to).endsWith('/release.json')) state.marker=String(to);
    return r;
  };
  fs.fsyncSync = function(fd) {
    if(state.marker && !state.criticalFailed) { state.criticalFailed=true; throw Error('PRIVATE_FAULT /private/internal/path secret-fixture'); }
    return originals.fsyncSync.call(fs,fd);
  };
  fs.unlinkSync = function(file) {
    if(denyRevocation && String(file)===state.marker) { state.revocationFailed=true; throw Error('PRIVATE_REVOKE_ERROR'); }
    return originals.unlinkSync.call(fs,file);
  };
  fs.writeFileSync = function(file,...args) {
    if(denyDiagnostic && String(file).startsWith(directory) && String(file).endsWith('/production-state.json')) { state.diagnosticFailed=true; throw Error('PRIVATE_DIAGNOSTIC_ERROR'); }
    return originals.writeFileSync.call(fs,file,...args);
  };
  return { state, restore() { for(const [k,v] of Object.entries(originals)) fs[k]=v; } };
}
module.exports = { rollbackFault };
