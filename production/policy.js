'use strict';
const { createHash, randomUUID } = require('crypto');
const VERSION = '2.0.0';
const STAGES = ['REQUEST', 'SOURCE_SUFFICIENCY', 'PRODUCT_TRUTH', 'STRUCTURE_CHECK', 'MACRO_PRODUCT_TRUTH_INSPECTION', 'MACRO_IDENTITY_LOCK', 'PRESENTATION_RECONSTRUCTION_AUTHORIZATION', 'RENDER', 'MACRO_IDENTITY_CHECK', 'FINISH_IDENTITY_CHECK', 'GATE_A', 'GATE_B', 'RELEASE_GATE'];
const GENERAL_FIELDS = ['silhouette', 'proportions', 'visible_stone_count', 'metal_thickness_family'];
const EARRING_FIELDS = ['visible_stone_count', 'stone_size_hierarchy', 'stone_spacing', 'prong_setting_rhythm', 'stone_bearing_rail_width', 'gallery_opening_count_shape_spacing', 'hinge_clasp_relationship', 'post_pin_relationship', 'inner_opening_proportions', 'rail_curvature', 'bottom_geometry', 'metal_thickness_family', 'visible_seams_joints'];
const FIELDS = [...new Set([...GENERAL_FIELDS, ...EARRING_FIELDS])];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
// Capabilities are process-local, non-serializable authority. JSON claiming PASS is not authority.
const releases = new WeakMap();
function isReleaseRecord(record) { const cap = record && releases.get(record); return !!cap && cap.valid(); }
function authorized(record, bytes) { return isReleaseRecord(record) && releases.get(record).hash === hash(bytes); }
const FINISHES = freeze({ 'preserve-source': { revision: '1', semantics: 'Preserve RAW visible hue, surface texture and reflectivity; no target color invented.', reference: 'original_raw_sha256' } });
function options(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !['transformation', 'finish_id', 'finish_revision'].includes(k))) throw Error('INVALID_PRODUCTION_OPTIONS');
  const o = { transformation: 'auto', finish_id: 'preserve-source', finish_revision: '1', ...value };
  if (typeof o.finish_id !== 'string' || typeof o.finish_revision !== 'string') throw Error('INVALID_FINISH_OPTIONS');
  if (!['auto', 'preserve', 'reconstruction'].includes(o.transformation)) throw Error('INVALID_TRANSFORMATION');
  return freeze(o);
}
class ProductionRun {
  #state; #source; #inputs; #lock; #candidate; #options;
  #aborted = false; #sourceStarted = false; #generation = 0; #epoch = 0; #digest;
  constructor(value) {
    this.#state = { run_id: randomUUID(), runtime_version: VERSION, core_visual_rules: VERSION, earring_standard: VERSION, stages: Object.fromEntries(STAGES.map(s => [s, { status: 'NOT_RUN' }])), transitions: [], publication_authorized: false };
    this.#set('REQUEST', 'PASS');
    try { this.#options = options(value); } catch (e) { this.abort('INVALID_REQUEST'); throw Object.assign(e, { production: this.snapshot(), statusCode: 400 }); }
  }
  #active() { if (this.#aborted) throw Object.assign(Error('RUN_ABORTED'), { code: 'RUN_ABORTED', statusCode: 422, production: this.snapshot() }); }
  #set(stage, status, detail = {}) { this.#state.stages[stage] = { ...clone(detail), status }; this.#state.transitions.push({ stage, status }); }
  #deny(stage, reason) { this.#set(stage, 'FAIL', { ...this.#state.stages[stage], ...(stage === 'PRESENTATION_RECONSTRUCTION_AUTHORIZATION' ? { decision: 'NOT_ALLOWED' } : {}), reasons: [reason] }); this.abort(reason); throw Object.assign(Error(reason), { code: reason, statusCode: 422, production: this.snapshot() }); }
  snapshot() { return freeze(clone({ ...this.#state, lifecycle: this.#aborted ? 'ABORTED' : 'ACTIVE', candidate_generation: this.#generation, candidate_sha256: this.#digest || null, identity_lock: this.#lock || null, finish: this.#options ? { finish_id: this.#options.finish_id, finish_revision: this.#options.finish_revision, reference_sha256: this.#inputs?.rawHash || null, validation: this.#state.stages.FINISH_IDENTITY_CHECK.status } : null })); }
  abort(reason = 'PRODUCTION_ERROR') { if (this.#aborted) return; this.#aborted = true; this.#epoch++;  if (this.#state.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.status === 'NOT_RUN') this.#set('PRESENTATION_RECONSTRUCTION_AUTHORIZATION', 'FAIL', { decision: 'NOT_ALLOWED', reasons: [reason] }); for (const stage of STAGES) if (this.#state.stages[stage].status === 'RUNNING') this.#set(stage, 'ERROR', { reasons: [reason] }); this.#set('RELEASE_GATE', 'FAIL', { reasons: [reason] }); this.#state.publication_authorized = false; }
  begin(stage) {
    this.#active();
    if (stage === 'PRODUCT_TRUTH' && (this.#lock || this.#state.stages.PRODUCT_TRUTH.status !== 'NOT_RUN')) this.#deny('RELEASE_GATE', 'PRODUCT_TRUTH_ALREADY_STARTED');
    const prerequisite = { PRODUCT_TRUTH: 'SOURCE_SUFFICIENCY', RENDER: 'PRESENTATION_RECONSTRUCTION_AUTHORIZATION' }[stage];
    if (!prerequisite || !['PASS', ...(stage === 'RENDER' ? ['NOT_REQUIRED'] : [])].includes(this.#state.stages[prerequisite].status)) this.#deny(stage in this.#state.stages ? stage : 'REQUEST', 'INVALID_STAGE_TRANSITION');
    if (stage === 'RENDER') {
      if (['RUNNING'].includes(this.#state.stages.RENDER.status) || this.#state.stages.MACRO_IDENTITY_CHECK.status === 'RUNNING') this.#deny('RELEASE_GATE', 'CANDIDATE_IN_PROGRESS');
      this.#generation++; this.#epoch++; this.#candidate = null; this.#digest = null;
      for (const s of ['MACRO_IDENTITY_CHECK','FINISH_IDENTITY_CHECK','GATE_A','GATE_B','RELEASE_GATE']) this.#set(s, 'NOT_RUN');
      this.#state.publication_authorized = false;
    }
    this.#set(stage, 'RUNNING');
  }
  qaRecorder(candidate) {
    this.#active();
    const generation = this.#generation, digest = this.#digest;
    if (!digest || hash(candidate) !== digest || this.#state.stages.FINISH_IDENTITY_CHECK.status !== 'PASS') this.#deny('RELEASE_GATE', 'QA_CANDIDATE_NOT_VERIFIED');
    return (stage, status) => {
      this.#active();
      if (generation !== this.#generation || digest !== this.#digest || hash(candidate) !== digest) this.#deny('RELEASE_GATE', 'STALE_QA_CANDIDATE');
      if (!['GATE_A','GATE_B'].includes(stage) || !['RUNNING','PASS','FAIL','NOT_RUN'].includes(status)) this.#deny('RELEASE_GATE', 'INVALID_QA_TRANSITION');
      const current = this.#state.stages[stage].status;
      // B's skipped notifications are diagnostic only, never successful authority.
      if (stage === 'GATE_B' && status === 'NOT_RUN' && current === 'NOT_RUN' && this.#state.stages.GATE_A.status === 'FAIL') return;
      if (this.#state.stages.FINISH_IDENTITY_CHECK.status !== 'PASS' || (stage === 'GATE_B' && this.#state.stages.GATE_A.status !== 'PASS')) this.#deny('RELEASE_GATE', 'QA_PREREQUISITE_FAILED');
      if (!(current === 'NOT_RUN' && status === 'RUNNING') && !(current === 'RUNNING' && ['PASS','FAIL'].includes(status))) this.#deny('RELEASE_GATE', 'INVALID_QA_TRANSITION');
      this.#set(stage, status, { generation, candidate_sha256: digest, authority: 'CATALOG_QA_TRANSITION' });
    };
  }
  async source(inputs) {
    this.#active();
    if (this.#sourceStarted) this.#deny('RELEASE_GATE', 'SOURCE_ALREADY_ESTABLISHED');
    this.#sourceStarted = true;
    this.#set('SOURCE_SUFFICIENCY', 'RUNNING');
    this.#inputs = { raw: Buffer.from(inputs.originalRaw.buffer), media: inputs.originalRaw.mediaType, rawHash: hash(inputs.originalRaw.buffer), cleanHash: hash(inputs.masterClean.buffer) };
    const profile = Object.hasOwn(FINISHES, this.#options.finish_id) ? FINISHES[this.#options.finish_id] : null;
    if (!profile || profile.revision !== this.#options.finish_revision) this.#deny('FINISH_IDENTITY_CHECK', 'UNREGISTERED_FINISH_OR_REVISION');
    const { inspectSource } = require('./inspection');
    const observation = await inspectSource(this.#inputs.raw, this.#inputs.media, inputs.openaiKey);
    this.#active();
    this.#source = freeze(clone(observation));
    const s = this.#source;
    const fields = s.category === 'earring' ? [...new Set([...GENERAL_FIELDS, ...EARRING_FIELDS])] : GENERAL_FIELDS;
    const valid = s.complete === true && s.confidence >= .95 && typeof s.category === 'string' && ['ring','earring','pendant','necklace','bracelet'].includes(s.category)
      && Array.isArray(s.features) && s.features.length === new Set(s.features.map(f => f.name)).size;
    const good = f => f && ['KNOWN','NOT_VISIBLE'].includes(f.status) && f.confidence >= .95 && typeof f.evidence === 'string' && f.evidence.trim().length > 0 && (f.status === 'NOT_VISIBLE' ? f.value === null : typeof f.value === 'string' && f.value.trim().length > 0);
    const observations = fields.map(name => s.features?.find(f => f.name === name));
    const stoneCount = observations.find(f => f?.name === 'visible_stone_count');
    const sufficient = valid && /^(0|[1-9][0-9]*)$/.test(stoneCount?.value) && observations.every(good) && ['silhouette','proportions','visible_stone_count'].every(n => observations.some(f => f?.name === n && f.status === 'KNOWN'));
    const reconstruction = sufficient && observations.every(f => f.status === 'KNOWN');
    const decision = reconstruction ? 'SUFFICIENT_FOR_RECONSTRUCTION' : sufficient ? 'SUFFICIENT_FOR_PRESERVE' : 'INSUFFICIENT';
    this.#set('SOURCE_SUFFICIENCY', sufficient ? 'PASS' : 'FAIL', { decision, required_fields: fields, unknown_fields: fields.filter((_,i) => !good(observations[i])) });
    if (!sufficient) this.#deny('SOURCE_SUFFICIENCY', 'INSUFFICIENT_SOURCE_IDENTITY');
    if (this.#options.transformation === 'reconstruction' && !reconstruction) this.#deny('SOURCE_SUFFICIENCY', 'SOURCE_NOT_SUFFICIENT_FOR_RECONSTRUCTION');
  }
  lock(truth) {
    this.#active();
    if (this.#lock) this.#deny('RELEASE_GATE', 'IDENTITY_LOCK_ALREADY_ESTABLISHED');
    if (this.#state.stages.SOURCE_SUFFICIENCY.status !== 'PASS') this.#deny('PRODUCT_TRUTH', 'SOURCE_NOT_VERIFIED');
    if (!truth || truth.category?.value !== this.#source.category || truth.product_complete?.value !== true || !(truth.product_complete.confidence >= .85) || typeof truth.gemstone_presence?.value !== 'boolean' || (truth.gemstone_presence.value && !Number.isInteger(truth.gemstone_presence.visible_count))) this.#deny('PRODUCT_TRUTH', 'UNKNOWN_CRITICAL_PRODUCT_TRUTH');
    const gems = truth.gemstone_presence;
    if (!Number.isInteger(gems.visible_count) || gems.visible_count < 0 || (gems.value ? gems.visible_count === 0 : gems.visible_count !== 0)) this.#deny('PRODUCT_TRUTH', 'INVALID_PRODUCT_TRUTH');
    if (truth.metadata_conflicts?.length) this.#deny('PRODUCT_TRUTH', 'DECLARED_METADATA_CONFLICT');
    this.#set('PRODUCT_TRUTH', 'PASS', { sha256: hash(JSON.stringify(truth)), authority: 'ORIGINAL_RAW' });
    const required = this.#state.stages.SOURCE_SUFFICIENCY.required_fields;
    const features = this.#source.features.filter(f => required.includes(f.name));
    const stone = features.find(f => f.name === 'visible_stone_count');
    if (stone?.status === 'KNOWN' && Number(stone.value) !== truth.gemstone_presence.visible_count) this.#deny('STRUCTURE_CHECK', 'CONTRADICTORY_STONE_COUNT');
    this.#set('STRUCTURE_CHECK', 'PASS', { features, unknown_fields: [], not_visible_fields: features.filter(f => f.status === 'NOT_VISIBLE').map(f => f.name) });
    this.#set('MACRO_PRODUCT_TRUTH_INSPECTION', 'PASS', { source_sha256: this.#inputs.rawHash, features });
    const content = { run_id: this.#state.run_id, source_sha256: this.#inputs.rawHash, category: this.#source.category, features, comparison: 'Exact visible identity; zero permitted structural changes. NOT_VISIBLE remains unasserted and cannot authorize reconstruction.' };
    this.#lock = freeze({ ...clone(content), sha256: hash(JSON.stringify(content)) });
    this.#set('MACRO_IDENTITY_LOCK', 'PASS', { sha256: this.#lock.sha256 });
  }
  authorize(isRing) {
    this.#active();
    if (this.#state.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.status !== 'NOT_RUN') this.#deny('RELEASE_GATE', 'AUTHORIZATION_ALREADY_ESTABLISHED');
    if (this.#lock && isRing !== (this.#lock.category === 'ring')) this.#deny('RELEASE_GATE', 'RENDERER_CATEGORY_MISMATCH');
    if (!this.#lock || this.#state.stages.MACRO_IDENTITY_LOCK.status !== 'PASS') this.#deny('PRESENTATION_RECONSTRUCTION_AUTHORIZATION', 'MISSING_MACRO_IDENTITY_LOCK');
    const reconstruct = !isRing;
    if (isRing && this.#options.transformation === 'reconstruction') this.#deny('PRESENTATION_RECONSTRUCTION_AUTHORIZATION', 'RING_RECONSTRUCTION_NOT_SUPPORTED');
    if (reconstruct && (this.#options.transformation === 'preserve' || this.#state.stages.SOURCE_SUFFICIENCY.decision !== 'SUFFICIENT_FOR_RECONSTRUCTION')) this.#deny('PRESENTATION_RECONSTRUCTION_AUTHORIZATION', 'RECONSTRUCTION_NOT_ALLOWED');
    this.#set('PRESENTATION_RECONSTRUCTION_AUTHORIZATION', reconstruct ? 'PASS' : 'NOT_REQUIRED', { decision: reconstruct ? 'ALLOWED' : 'NOT_REQUIRED', method: isRing ? 'deterministic-ring-composer-v1' : 'existing-gpt-image-renderer' });
  }
  async verify(candidate, key, localQA) {
    this.#active();
    if (this.#state.stages.RENDER.status !== 'RUNNING') this.#deny('RELEASE_GATE', 'RENDER_NOT_STARTED');
    const generation = this.#generation;
    const auth = this.#state.stages.PRESENTATION_RECONSTRUCTION_AUTHORIZATION.status;
    if (!this.#lock || !['PASS','NOT_REQUIRED'].includes(auth)) this.#deny('RENDER', 'RENDER_NOT_AUTHORIZED');
    this.#candidate = Buffer.from(candidate);
    this.#digest = hash(this.#candidate);
    // A retry must pass every post-render gate again; never reuse candidate-bound checks.
    for (const s of ['MACRO_IDENTITY_CHECK','FINISH_IDENTITY_CHECK','GATE_A','GATE_B','RELEASE_GATE']) this.#set(s, 'NOT_RUN');
    this.#set('RENDER', 'PASS', { sha256: this.#digest });
    if (auth === 'NOT_REQUIRED' && localQA?.pass !== true) this.#deny('MACRO_IDENTITY_CHECK', 'LOCAL_GEOMETRY_FAILURE');
    this.#set('MACRO_IDENTITY_CHECK', 'RUNNING');
    const { compareCandidate } = require('./inspection');
    const report = await compareCandidate(this.#inputs.raw, this.#inputs.media, Buffer.from(this.#candidate), this.#lock, key);
    this.#active();
    if (generation !== this.#generation) this.#deny('RELEASE_GATE', 'STALE_CANDIDATE_VERIFICATION');
    const rows = report?.features;
    if (!Array.isArray(rows) || rows.length !== this.#lock.features.length || new Set(rows.map(f => f.name)).size !== rows.length || !this.#lock.features.every(f => rows.some(r => r.name === f.name && r.result === 'MATCH' && r.confidence >= .95 && typeof r.evidence === 'string' && r.evidence.trim()))) this.#deny('MACRO_IDENTITY_CHECK', 'LOCKED_IDENTITY_MISMATCH_OR_UNKNOWN');
    this.#set('MACRO_IDENTITY_CHECK', 'PASS', { lock_sha256: this.#lock.sha256, generation, candidate_sha256: this.#digest, features: rows });
    if (report.finish_matches_source !== true || !(report.finish_confidence >= .95) || !report.finish_evidence?.trim()) this.#deny('FINISH_IDENTITY_CHECK', 'FINISH_MISMATCH_OR_UNKNOWN');
    this.#set('FINISH_IDENTITY_CHECK', 'PASS', { generation, candidate_sha256: this.#digest, finish_id: this.#options.finish_id, finish_revision: this.#options.finish_revision, reference_sha256: this.#inputs.rawHash, evidence: report.finish_evidence });
  }
  release(qa) {
    if (this.#aborted) return this.snapshot();
    const epoch = ++this.#epoch, generation = this.#generation, digest = this.#digest;
    const reasons = STAGES.filter(s => s !== 'RELEASE_GATE').filter(s => this.#state.stages[s].status !== 'PASS' && !(s === 'PRESENTATION_RECONSTRUCTION_AUTHORIZATION' && this.#state.stages[s].status === 'NOT_REQUIRED')).map(s => `${s}:${this.#state.stages[s].status}`);
    if (qa?.verdict?.value !== 'approved' || qa?.final_approval !== true) reasons.push('CATALOG_NOT_APPROVED');
    if (!this.#candidate) reasons.push('MISSING_CANDIDATE');
    for (const stage of ['MACRO_IDENTITY_CHECK','FINISH_IDENTITY_CHECK','GATE_A','GATE_B']) {
      const record = this.#state.stages[stage];
      if (record.generation !== generation || record.candidate_sha256 !== digest) reasons.push(`${stage}:CANDIDATE_BINDING_MISSING`);
    }
    if (qa?.gate_a?.status !== this.#state.stages.GATE_A.status || qa?.gate_b?.status !== this.#state.stages.GATE_B.status) reasons.push('QA_SUMMARY_INCONSISTENT');
    this.#set('RELEASE_GATE', reasons.length ? 'FAIL' : 'PASS', { reasons });
    this.#state.publication_authorized = !reasons.length;
    const result = this.snapshot();
    if (!reasons.length) releases.set(result, { hash: digest, valid: () => !this.#aborted && epoch === this.#epoch && generation === this.#generation && digest === this.#digest && this.#state.publication_authorized === true && this.#state.stages.RELEASE_GATE.status === 'PASS' });
    return result;
  }
}
module.exports = { VERSION, STAGES, FIELDS, GENERAL_FIELDS, EARRING_FIELDS, FINISHES, ProductionRun, authorized, isReleaseRecord, hash };
