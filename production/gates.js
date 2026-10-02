'use strict';
// The only HTTP production entry/release boundary. Evidence is loaded from a
// server-owned run directory, never accepted as request-supplied PASS flags.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VERSION = '1.1.0';
const HASH = x => crypto.createHash('sha256').update(x).digest('hex');
const ROUTES = ['/catalog', '/hero', '/hero-a', '/hero-b', '/hero-c', '/process'];
const POLICY_HASH = '505e8c7bbcbc7d9a07e546e0b92aa19abea985395d776705c1efa3ceb31b8912';
const STANDARD_HASH = '1204845aee426156352775bc915050d5e502795f9ba9c7c60ed514677d775c4f';
class Denied extends Error { constructor(code, evidence = []) { super(code); this.code = code; this.evidence = evidence; } }
const requireTrue = (condition, code) => { if (!condition) throw new Denied(code); };
function loadPolicy() {
  const a = fs.readFileSync(path.join(__dirname, 'policy/authority.json'));
  const e = fs.readFileSync(path.join(__dirname, 'policy/earring.json'));
  requireTrue(HASH(a) === POLICY_HASH && HASH(e) === STANDARD_HASH, 'POLICY_INTEGRITY_FAILURE');
  return { authority: JSON.parse(a), standard: JSON.parse(e) };
}
function initial(runId) {
  const s = { RUN_ID: runId, RUNTIME_VERSION: VERSION, CORE_VERSION: '1.3.0', EARRING_STANDARD_VERSION: '1.7.0',
    SKU_ID: null, CATEGORY: null, PRODUCT_TRUTH_ID: null, PRODUCT_TRUTH_HASH: null, TARGET_VIEW: null,
    SOURCE_SUFFICIENCY_STATUS: 'UNKNOWN', MACRO_IDENTITY_LOCK_STATUS: 'UNKNOWN',
    MICRO_SETTING_APPLICABILITY: null, MICRO_SETTING_LOCK_STATUS: 'UNKNOWN',
    RECONSTRUCTION_AUTHORIZATION: 'DENIED', RECONSTRUCTION_ATTEMPT_COUNT: 0,
    LOCKED_FINISH_ID: null, LOCKED_FINISH_REVISION: null, FINISH_BINDING_STATUS: 'NOT_CALLED',
    MACRO_IDENTITY_CHECK_STATUS: 'NOT_CALLED', MICRO_SETTING_CHECK_STATUS: 'NOT_CALLED',
    VIEW_AWARE_SKU_CHECK_STATUS: 'NOT_CALLED', FINISH_CONSISTENCY_STATUS: 'NOT_CALLED',
    FRAMING_STATUS: 'NOT_CALLED', PREMIUM_QA_STATUS: 'NOT_CALLED', RELEASE_GATE_STATUS: 'BLOCKED',
    FINAL_OUTPUT_STATUS: 'BLOCKED', RAW_GATE_A: 'NOT_RUN / NOT_RECERTIFIED',
    RENDER_PROVIDER_CALL_COUNT: 0, calls: {}, events: [], released_sha256: null };
  return s;
}
function verifiedFile(root, record) {
  requireTrue(record && /^[a-f0-9]{64}$/.test(record.sha256), 'MISSING_PROVENANCE');
  const f = fs.realpathSync(path.resolve(root, record.path));
  requireTrue(f.startsWith(fs.realpathSync(root) + path.sep), 'EVIDENCE_PATH_ESCAPE');
  const bytes = fs.readFileSync(f);
  requireTrue(HASH(bytes) === record.sha256, 'EVIDENCE_HASH_MISMATCH');
  return bytes;
}
function sufficiency(a, policy, source, locks, target) {
  requireTrue(a.target_view === target && a.source_sha256 === HASH(source), 'SOURCE_OR_TARGET_MISMATCH');
  requireTrue(JSON.stringify(Object.keys(a.lock_hashes).sort()) === JSON.stringify(Object.keys(locks).sort()), 'LOCK_SET_MISMATCH');
  for (const [k,b] of Object.entries(locks)) requireTrue(a.lock_hashes[k] === HASH(b), 'LOCK_HASH_MISMATCH');
  let inference = false;
  const unsupported = [];
  for (const k of policy.SOURCE_SUFFICIENCY_GATE.required_features) {
    const f = a.features[k];
    requireTrue(f && f.state in policy.SOURCE_SUFFICIENCY_GATE.field_states && f.evidence && typeof f.target_visible === 'boolean' && typeof f.identity_critical === 'boolean', 'MISSING_FEATURE_EVIDENCE:' + k);
    if (f.state === 'UNSUPPORTED_IDENTITY_CRITICAL') unsupported.push(k);
    if (f.state === 'CONSERVATIVE_PRESENTATION_INFERENCE') { requireTrue(f.identity_critical === false, 'IDENTITY_INFERENCE_DENIED:' + k); inference = true; }
    if (f.state === 'OCCLUDED') requireTrue(f.target_visible === false, 'INVALID_OCCLUSION:' + k);
    if (['TRANSFORM_SUPPORTED','SOURCE_AMBIGUOUS'].includes(f.state)) requireTrue(!!f.safe_constraint, 'MISSING_SAFE_CONSTRAINT:' + k);
  }
  return unsupported.length ? 'INSUFFICIENT_PRODUCT_TRUTH_FOR_TARGET_VIEW' : inference ? 'SOURCE_SUFFICIENT_WITH_PRESENTATION_INFERENCE' : 'SOURCE_SUFFICIENT_FOR_TARGET_VIEW';
}
function createService({ root, adapters = {}, dryRun = false } = {}) {
  root = root || process.env.GLEOR_RUN_ROOT;
  async function execute(runId) {
    const s = initial(runId); let dir, lock, image;
    const persist = () => {
      requireTrue(!!dir, 'AUDIT_UNAVAILABLE');
      const tmp = path.join(dir, 'runtime-state.tmp');
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, path.join(dir, 'runtime-state.json'));
      fs.appendFileSync(path.join(dir,'runtime-audit.jsonl'), JSON.stringify({...s, audit_at:new Date().toISOString()})+'\n');
    };
    async function stage(name, input) {
      requireTrue(typeof adapters[name] === 'function', 'ADAPTER_NOT_CONFIGURED:' + name);
      s.calls[name] = (s.calls[name] || 0) + 1;
      s.events.push({ stage: name, time: new Date().toISOString() }); persist();
      return adapters[name](input);
    }
    function check(result, name, asset) {
      requireTrue(result && result.status === 'PASS' && result.asset_sha256 === HASH(asset) && result.evidence_ref, name + (result?.status === 'FAIL' && result.asset_sha256 === HASH(asset) && result.evidence_ref ? '_FAIL' : '_UNVERIFIED'));
    }
    try {
      requireTrue(typeof runId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(runId) && !!root, 'TRUSTED_RUN_REQUIRED');
      dir = path.join(root, runId);
      requireTrue(fs.realpathSync(dir).startsWith(fs.realpathSync(root) + path.sep), 'RUN_PATH_ESCAPE');
      lock = fs.openSync(path.join(dir, 'runtime.lock'), 'wx');
      const { authority, standard } = loadPolicy();
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
      Object.assign(s, { SKU_ID:m.sku_id, CATEGORY:m.category, PRODUCT_TRUTH_ID:m.product_truth?.id,
        PRODUCT_TRUTH_HASH:m.product_truth?.sha256, TARGET_VIEW:m.target_view,
        MICRO_SETTING_APPLICABILITY:m.micro_applicable, LOCKED_FINISH_ID:m.finish_id, LOCKED_FINISH_REVISION:m.finish_revision });
      requireTrue(m.category === 'earring', 'CATEGORY_ADAPTER_NOT_CONFIGURED');
      requireTrue(m.finish_id === 'gleor_champagne_rose_v1' && m.finish_revision === '1.2.0', 'LOCKED_FINISH_MISMATCH');
      const source = verifiedFile(dir, m.product_truth);
      // Existing accepted export replay is not reconstruction, and never creates
      // retroactive macro/micro PASS records. It requires the exact accepted bytes.
      if (m.mode === 'ACCEPTED_EXPORT_REPLAY') {
        const rec = JSON.parse(verifiedFile(dir, m.acceptance_record));
        image = verifiedFile(dir, m.final_asset);
        requireTrue(rec.status.includes('FINAL_LOCKED') && rec.status.includes('HUMAN_ACCEPTED') && rec.sha256 === HASH(image) && rec.byte_identical_to_locked_source === true, 'ACCEPTED_EXPORT_MISMATCH');
        const premium = JSON.parse(verifiedFile(dir, m.premium_record));
        requireTrue(premium.decision === 'PREMIUM_QA_PASS' && premium.output_unchanged_sha256 === HASH(image), 'ACCEPTED_PREMIUM_MISMATCH');
        requireTrue(rec.dimensions[0] === 1200 && rec.dimensions[1] === 1200 && rec.product_heights_px.every(x=>x>=396 && x<=420), 'ACCEPTED_FRAMING_MISMATCH');
        s.RECONSTRUCTION_AUTHORIZATION = 'NOT_APPLICABLE_EXISTING_ACCEPTED_EXPORT';
        s.RELEASE_BASIS = 'BYTE_IDENTICAL_HUMAN_ACCEPTED_EXPORT_ONLY_NO_RECERTIFICATION';
      } else {
        const locks = {};
        for (const [k,v] of Object.entries(m.locks || {})) locks[k] = verifiedFile(dir,v);
        requireTrue(typeof m.micro_applicable === 'boolean', 'MICRO_APPLICABILITY_UNKNOWN');
        const macro = JSON.parse(locks['IMG5684_MACRO_IDENTITY_LOCK.json'] || locks['MACRO_IDENTITY_LOCK.json'] || 'null');
        const micro = JSON.parse(locks['IMG5684_MICRO_SETTING_LOCK.json'] || locks['MICRO_SETTING_LOCK.json'] || 'null');
        requireTrue(macro && macro.source_sha256 === HASH(source), 'MACRO_LOCK_UNVERIFIED');
        s.MACRO_IDENTITY_LOCK_STATUS = macro.status;
        if (m.micro_applicable) { requireTrue(micro && micro.source_sha256 === HASH(source), 'MICRO_LOCK_UNVERIFIED'); s.MICRO_SETTING_LOCK_STATUS = micro.status; }
        const a = JSON.parse(verifiedFile(dir, m.assessment));
        s.SOURCE_SUFFICIENCY_STATUS = sufficiency(a, authority, source, locks, m.target_view);
        if (s.SOURCE_SUFFICIENCY_STATUS === 'INSUFFICIENT_PRODUCT_TRUTH_FOR_TARGET_VIEW') throw new Denied('INSUFFICIENT_PRODUCT_TRUTH_FOR_' + m.target_view, a.missing_evidence);
        requireTrue(['VERIFIED','PARTIAL_SOURCE_AMBIGUITY'].includes(macro.status), 'MACRO_LOCK_BLOCKED');
        if(m.micro_applicable) requireTrue(['VERIFIED','PARTIAL_SOURCE_AMBIGUITY'].includes(micro.status), 'MICRO_LOCK_BLOCKED');
        // Complete source inspections and camera/closure lock evidence must be
        // provided by server-owned analysis before any renderer is eligible.
        for(const k of ['STRUCTURE_CHECK','MACRO_PRODUCT_TRUTH_INSPECTION','EXISTING_VIEW_DETECTION','IDENTIFY_MISSING_VIEW','CLOSURE_LOCK','FRONT_CAMERA_LOCK',...(m.micro_applicable?['MICRO_SETTING_INSPECTION']:[])]) {
          const e=m.prerequisites?.[k]; requireTrue(e?.status==='PASS' && e.source_sha256===HASH(source) && e.evidence_ref, 'PREREQUISITE_UNVERIFIED:'+k);
        }
        requireTrue(m.internal_only_renderer === true, 'INTERMEDIATE_VISIBILITY_NOT_CONTROLLED');
        // No provider module is imported when stage implementations are missing.
        const stages=['render','macro','viewAware','closure','camera','metalMap','finish','finishQA','gateM','gateF','markings','framing','pair','premium',...(m.micro_applicable?['micro']:[])];
        for(const k of stages) requireTrue(typeof adapters[k]==='function','ADAPTER_NOT_CONFIGURED:'+k);
        const ledgerPath=path.join(dir,'attempt-ledger.json');
        const ledger=JSON.parse(fs.readFileSync(ledgerPath));
        requireTrue(Number.isInteger(ledger.attempts) && ledger.attempts>=0 && ledger.attempts<=2, 'INVALID_RETRY_LEDGER');
        let attempts=ledger.attempts;
        requireTrue(attempts===0 || (attempts===1 && ledger.last_failure==='VISIBLE_IDENTITY_FAIL'), 'RETRY_EXHAUSTED');
        s.RECONSTRUCTION_AUTHORIZATION='AUTHORIZED';
        let structuralOK=false;
        while(attempts<2) {
          // Reserve durably before call; a crash cannot create a free retry.
          attempts++; s.RECONSTRUCTION_ATTEMPT_COUNT=attempts;
          fs.writeFileSync(ledgerPath,JSON.stringify({attempts,last_failure:'IN_PROGRESS'}));
          if(!dryRun) s.RENDER_PROVIDER_CALL_COUNT++;
          image=await stage('render',{source:Buffer.from(source),locks,target:m.target_view,attempt:attempts});
          requireTrue(Buffer.isBuffer(image),'RENDER_OUTPUT_INVALID');
          try {
            check(await stage('macro',image),'MACRO_IDENTITY_CHECK',image);s.MACRO_IDENTITY_CHECK_STATUS='PASS';
            if(m.micro_applicable){const q=await stage('micro',image);s.MICRO_SETTING_CHECK_STATUS=q?.status||'UNKNOWN';check(q,'MICRO_SETTING_CHECK',image);}
            else s.MICRO_SETTING_CHECK_STATUS='NOT_APPLICABLE';
            check(await stage('viewAware',image),'VIEW_AWARE_SKU_CHECK',image);s.VIEW_AWARE_SKU_CHECK_STATUS='PASS';
            check(await stage('closure',image),'CLOSURE_GEOMETRY_CHECK',image);
            check(await stage('camera',image),'FRONT_CAMERA_CHECK',image);
            structuralOK=true;break;
          } catch(e) {
            s.events.push({rejected_sha256:HASH(image),role:'NEGATIVE_EVIDENCE_ONLY',reason:e.message});
            fs.writeFileSync(ledgerPath,JSON.stringify({attempts,last_failure:'VISIBLE_IDENTITY_FAIL'}));
            // Only explicit measured FAIL may authorize the controlled retry;
            // unavailable/crashed/unknown checks never do.
            if(!m.allow_controlled_retry || attempts>=2 || !e.code?.endsWith('_FAIL')) throw e;
            s.MACRO_IDENTITY_CHECK_STATUS='NOT_CALLED';s.MICRO_SETTING_CHECK_STATUS='NOT_CALLED';s.VIEW_AWARE_SKU_CHECK_STATUS='NOT_CALLED';
          }
        }
        requireTrue(structuralOK,'STRUCTURAL_REJECTION');
        const map=await stage('metalMap',image);check(map,'METAL_SURFACE_MAP',image);
        const finishReference=verifiedFile(dir,m.finish_reference);
        requireTrue(HASH(finishReference)===standard.material.champagne_rose.canonical_sha256,'FINISH_REFERENCE_MISMATCH');
        const before=Buffer.from(image);
        const finish=await stage('finish',{image:Buffer.from(image),map,finish_id:m.finish_id,revision:m.finish_revision,reference:finishReference});
        // Exact raster mask contract: dimensions/alpha/nonmetal protected bytes
        // cannot change. No resampling or structure-generating finish adapter.
        requireTrue(finish && Buffer.isBuffer(finish.image) && typeof adapters.verifyAppearance==='function','FINISH_APPLICATION_UNVERIFIED');
        check(await stage('verifyAppearance',{before,after:finish.image,map}),'FINISH_APPLICATION_STRUCTURE_VIOLATION',finish.image);
        image=finish.image;s.FINISH_BINDING_STATUS='VERIFIED';
        check(await stage('gateM',image),'GATE_M',image);
        const fq=await stage('finishQA',image);s.FINISH_CONSISTENCY_STATUS=fq?.status||'UNKNOWN';check(fq,'FINISH_CONSISTENCY_CHECK',image);
        const cleaned=await stage('markings',image);requireTrue(Buffer.isBuffer(cleaned),'MARKINGS_OUTPUT_INVALID');
        check(await stage('verifyAppearance',{before:image,after:cleaned,map}),'MARKING_STRUCTURE_VIOLATION',cleaned);image=cleaned;
        check(await stage('finishQA',image),'FINISH_CONSISTENCY_CHECK',image);
        const frame=await stage('framing',{image,height:408,canvas:1200});
        requireTrue(frame && Buffer.isBuffer(frame.image) && frame.height>=396 && frame.height<=420,'FRAMING_FAIL');image=frame.image;s.FRAMING_STATUS='PASS';
        const pair=await stage('pair',image);requireTrue(pair && Buffer.isBuffer(pair.image) && pair.alignment==='PASS','PAIR_ALIGNMENT_FAIL');image=pair.image;
        // Final asset must be checked again after all appearance/composition edits.
        check(await stage('macro',image),'FINAL_MACRO_IDENTITY_CHECK',image);
        if(m.micro_applicable)check(await stage('micro',image),'FINAL_MICRO_SETTING_CHECK',image);
        check(await stage('viewAware',image),'FINAL_VIEW_AWARE_SKU_CHECK',image);
        check(await stage('finishQA',image),'FINAL_FINISH_CONSISTENCY_CHECK',image);
        check(await stage('gateF',image),'GATE_F',image);
        check(await stage('premium',image),'PREMIUM_QA',image);s.PREMIUM_QA_STATUS='PASS';
        requireTrue(s.RECONSTRUCTION_AUTHORIZATION==='AUTHORIZED' && s.MACRO_IDENTITY_CHECK_STATUS==='PASS' && (!m.micro_applicable||s.MICRO_SETTING_CHECK_STATUS==='PASS') && s.VIEW_AWARE_SKU_CHECK_STATUS==='PASS' && s.FINISH_BINDING_STATUS==='VERIFIED' && s.FINISH_CONSISTENCY_STATUS==='PASS' && s.FRAMING_STATUS==='PASS' && s.PREMIUM_QA_STATUS==='PASS','RELEASE_REQUIREMENTS_FAILED');
      }
      s.RELEASE_GATE_STATUS='PASS';s.FINAL_OUTPUT_STATUS='HUMAN_REVIEW_REQUIRED';s.released_sha256=HASH(image);persist();
      return {state:s,image};
    } catch(e) {
      s.RECONSTRUCTION_AUTHORIZATION=s.RECONSTRUCTION_AUTHORIZATION==='AUTHORIZED'?'AUTHORIZED': 'DENIED';
      s.RELEASE_GATE_STATUS='BLOCKED';s.FINAL_OUTPUT_STATUS='BLOCKED';s.reason=e.code||'GATE_ERROR';s.missing_evidence=e.evidence||[];
      if(dir && lock!==undefined) {try{persist();}catch(_){s.reason='AUDIT_PERSISTENCE_FAILURE';}}
      return {state:s};
    } finally {if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(path.join(dir,'runtime.lock'));}}
  }
  // All mutations in the actual Express app are intercepted before old handlers.
  // Neither category labels nor artifact headers can route around this boundary.
  async function middleware(req,res,next) {
    if(req.method==='GET' && req.path==='/health') return next();
    if(!ROUTES.includes(req.path)||req.method!=='POST') return res.status(404).json({error:'PRODUCTION_ROUTE_NOT_ALLOWED'});
    const result=await execute(req.headers['x-gleor-run-id']);
    if(result.state.RELEASE_GATE_STATUS!=='PASS') return res.status(409).json({status:'BLOCKED',reason:result.state.reason,missing_evidence:result.state.missing_evidence||[],state:result.state});
    // The only user-facing visual serialization in the active HTTP path.
    if((req.headers.accept||'').includes('image/png')) return res.type('png').send(result.image);
    return res.json({status:'HUMAN_REVIEW_REQUIRED',sha256:result.state.released_sha256,image:result.image.toString('base64'),state:result.state});
  }
  return {execute,middleware};
}
module.exports={createService,initial,sufficiency,loadPolicy,HASH,ROUTES,VERSION};
