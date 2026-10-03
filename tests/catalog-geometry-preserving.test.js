const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { composeRingHero, verifyRingHero } = require('../catalog/geometryPreservingCompose');
const { parseGate } = require('../catalog/catalogQA');
const C = require('../catalog/constants');
async function fixture() {
  const b = Buffer.alloc(80 * 60 * 4);
  for (let y = 15; y < 45; y++) for (let x = 13; x < 67; x++) {
    if (x > 27 && x < 48 && y > 22 && y < 39) continue; // Preserve an asymmetric inner hole.
    const i = (y * 80 + x) * 4;
    b[i] = x * 3; b[i + 1] = y * 4; b[i + 2] = 77; b[i + 3] = x === 13 ? 100 : 255;
  }
  return sharp(b, { raw: { width: 80, height: 60, channels: 4 } }).png().toBuffer();
}
test('exact native pixels, alpha edges, hole, white background, fill and centering; repeat bytes identical', async () => {
  const b = await fixture(), original = Buffer.from(b);
  const a = await composeRingHero({ imageBuffer: b }), repeat = await composeRingHero({ imageBuffer: b });
  assert.deepEqual(b, original); assert.deepEqual(a.pngBuffer, repeat.pngBuffer); assert.deepEqual(a.productLayer, repeat.productLayer);
  const q = await verifyRingHero({ imageBuffer: b, candidateBuffer: a.pngBuffer, diagnostics: a.diagnostics });
  assert.equal(q.pass, true); assert.equal(q.mismatches, 0); assert.ok(a.diagnostics.shadow_pixels > 0);
  const source = await sharp(b).raw().toBuffer();
  const crop = await sharp(a.productLayer).raw().toBuffer();
  for (let y = 0; y < 30; y++) for (let x = 0; x < 54; x++) assert.deepEqual(crop.subarray((y * 54 + x) * 4, (y * 54 + x + 1) * 4), source.subarray(((y + 15) * 80 + x + 13) * 4, ((y + 15) * 80 + x + 14) * 4));
});
test('geometry diagnostic detects modified product pixels and alpha', async () => {
  const b = await fixture(), a = await composeRingHero({ imageBuffer: b });
  const r = await sharp(a.pngBuffer).raw().toBuffer({ resolveWithObject: true });
  const p = a.diagnostics.placement;
  const i = ((p.top + 1) * r.info.width + p.left + 1) * 4;
  r.data[i] ^= 255; r.data[i + 3] = 0;
  const corrupted = await sharp(r.data, { raw: r.info }).png().toBuffer();
  const q = await verifyRingHero({ imageBuffer: b, candidateBuffer: corrupted, diagnostics: a.diagnostics });
  assert.equal(q.pass, false); assert.ok(q.mismatches); assert.ok(q.alphaErrors);
});
test('reject opaque canvas, empty mask and clipped product', async () => {
  for (const alpha of [0, 1]) {
    const b = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 30, b: 40, alpha } } }).png().toBuffer();
    await assert.rejects(composeRingHero({ imageBuffer: b }), /complete, transparent/);
  }
});
function gate() { return { criteria: Object.fromEntries(C.QA_LAYER_A_CRITERIA.map(k => [k, { score: 100, applicable: true, note: 'Visible structure matches', critical_deviation: false }])), critical_failures: [] }; }
const truth = { category: { value: 'ring' }, gemstone_presence: { value: true }, setting_type: { value: 'prong' } };
const hidden = JSON.stringify({ visibility: 'not_visible_in_either', visible_inner_features: false, occlusion_reason: 'Inner surface and opening fully occluded by the front face in both source and output.' });
test('inner band N/A needs explicit source AND output invisibility evidence', () => {
  const a = gate(); a.criteria.inner_band_structural_fidelity = { score: null, applicable: false, note: hidden, critical_deviation: false };
  assert.equal(parseGate(JSON.stringify(a), 'A', truth).status, 'PASS');
  for (const note of ['unclear', 'not visible', hidden.replace('not_visible_in_either', 'source_visible'), hidden.replace('false', 'true')]) {
    a.criteria.inner_band_structural_fidelity.note = note;
    assert.equal(parseGate(JSON.stringify(a), 'A', truth).status, 'FAIL');
  }
});
test('geometry, stones, rows, prongs, band and perspective cannot escape via visibility N/A', () => {
  for (const key of ['geometry_fidelity', 'silhouette_fidelity', 'stone_layout_fidelity', 'stone_row_fidelity', 'prong_fidelity', 'band_proportions', 'band_curvature_thickness', 'perspective_fidelity']) {
    const a = gate(); a.criteria[key] = { score: null, applicable: false, note: hidden, critical_deviation: false };
    assert.equal(parseGate(JSON.stringify(a), 'A', truth).status, 'FAIL', key);
  }
});
test('visible inner-band below 95 or critical deviation still fails', () => {
  for (const v of [{ score: 94, applicable: true, note: 'Visible contour differs', critical_deviation: false }, { score: null, applicable: false, note: hidden, critical_deviation: true }]) {
    const a = gate(); a.criteria.inner_band_structural_fidelity = v;
    assert.equal(parseGate(JSON.stringify(a), 'A', truth).status, 'FAIL');
  }
});
test('ring orchestrator uses real local composer, sends RAW/Clean to QA, never imports renderer or retries', async () => {
  const clean = await fixture(), raw = Buffer.from('RAW authoritative marker');
  for (const verdict of ['approved', 'retry', 'FAIL']) {
    const module = { exports: {} }; let qaCalls = 0;
    const deps = {
      '../production/policy': require('./helpers/legacy-policy-fixture'),
      './metadataParser': { parseFilename: () => ({ category: { value: 'ring' }, sku: 'ring-test' }) },
      './promptBuilder': { buildPrompt() { throw Error('No generative prompt'); } },
      './writer': { sha256: b => require('crypto').createHash('sha256').update(b).digest('hex'), writeInputs: () => ({}), writeBundle: () => ({}) },
      './inputContract': { validateInputs: async v => v }, './constants': C,
      './productTruth': { runProductTruth: async a => { assert.deepEqual(a.imageBuffer, raw); return { truth }; } },
      './geometryPreservingCompose': require('../catalog/geometryPreservingCompose'),
      './catalogQA': { runCatalogQA: async a => { qaCalls++; assert.deepEqual(a.originalBuffer, raw); assert.deepEqual(a.masterCleanBuffer, clean); return { gate_a: { status: verdict === 'FAIL' ? 'FAIL' : 'PASS', criteria: {} }, gate_b: { status: verdict === 'FAIL' ? 'NOT_RUN' : 'PASS', criteria: {} }, final_approval: verdict === 'approved', verdict: { value: verdict, reasons: [] } }; } },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../catalog/index.js'), 'utf8'), { module, Buffer, Date, console, require: n => { assert.ok(n in deps, `Forbidden dependency ${n}`); return deps[n]; } });
    const r = await module.exports.runCatalogPipeline({ originalRaw: { buffer: raw, originalFilename: 'ring-test.jpg' }, masterClean: { buffer: clean }, openaiKey: 'mock', retryLimit: 1 });
    assert.equal(qaCalls, 1); assert.equal(r.finalMetadata.retry_count, 0); assert.equal(r.finalMetadata.stages.gpt_image.model, null);
    assert.equal(r.finalMetadata.stages.ring_composer.local_qa.pass, true);
    assert.equal(r.verdict.value, verdict === 'retry' ? 'manual_review' : verdict);
  }
});
