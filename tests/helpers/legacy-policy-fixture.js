// The pre-v2 regression suites isolate the NEW production boundary so their
// renderer/QA/Input-V2 assertions retain their original scope and call budgets.
// Real policy, real writer and actual Express wiring are covered in production tests.
const { createHash } = require('crypto');
class ProductionRun {
  qaRecorder() { return () => {}; }
  begin() {} qaStage() {} async source() {} lock() {} authorize() {} async verify() {}
  abort() {} snapshot() { return { publication_authorized: false, stages: { RELEASE_GATE: { status: 'FAIL' } } }; }
  release(qa) { return { publication_authorized: qa.final_approval === true && qa.verdict.value === 'approved', stages: { RELEASE_GATE: { status: qa.final_approval ? 'PASS' : 'FAIL', reasons: [] } } }; }
}
module.exports = { ProductionRun, authorized: release => release?.publication_authorized === true, hash: b => createHash('sha256').update(b).digest('hex') };
