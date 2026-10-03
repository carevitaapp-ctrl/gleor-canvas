// Offline contract tests. VM modules receive only explicitly allowed local dependencies.
// No provider SDK, network transport, server, image processing or on-disk rendering is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const constants = require('../catalog/constants');
const { QA_LAYER_A_CRITERIA: A, QA_LAYER_B_CRITERIA: B, QA_THRESHOLDS: floors } = constants;
const input = { originalBuffer: Buffer.from('source-marker'), finalBuffer: Buffer.from('candidate-marker'), openaiKey: 'offline-placeholder', truth: {} };

function load(relative, allowed) {
  const filename = path.join(root, relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, Date,
    process: { env: { OPENAI_API_KEY: 'offline-placeholder' } },
    console,
    require(name) {
      if (name === '../production/policy') return require('./helpers/legacy-policy-fixture');
      if (name === '../production/http' || name === './production/http') return { certifyResponse() {}, protect(req,res,next) { next(); } };
      if (!Object.hasOwn(allowed, name)) throw new Error(`Forbidden dependency in offline test: ${name}`);
      return allowed[name];
    },
  }, { filename });
  return module.exports;
}

function response(layer, score = 100) {
  return {
    criteria: Object.fromEntries((layer === 'A' ? A : B).map(k => [k, {
      score: score === 'floor' ? floors[k] : score,
      applicable: true, note: 'Fixture assessment',
      ...(layer === 'A' ? { critical_deviation: false } : {}),
    }])),
    ...(layer === 'A' ? { critical_failures: [] } : {}),
  };
}

function harness(responses) {
  const requests = [];
  const events = [];
  const fakeHttps = {
    request(options, callback) {
      assert.equal(options.hostname, 'api.openai.com');
      assert.equal(options.path, '/v1/responses');
      const index = requests.length;
      assert.ok(index < responses.length, 'Unexpected extra evaluator request');
      let body = '';
      requests.push(null);
      events.push(`start-${index}`);
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = chunk => { body += chunk; };
      req.end = () => queueMicrotask(() => {
        requests[index] = JSON.parse(body);
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        const reply = responses[index];
        res.emit('data', Buffer.from(JSON.stringify({
          status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] }],
          model: 'offline-fixture', usage: { input_tokens: 0, output_tokens: 0 },
        })));
        events.push(`complete-${index}`);
        res.emit('end');
      });
      return req;
    },
  };
  const analysis = load('catalog/openaiAnalysis.js', { https: fakeHttps, './analysisSchemas': require('../catalog/analysisSchemas'), './constants': constants });
  const qa = load('catalog/catalogQA.js', { './openaiAnalysis': analysis, fs, path, './constants': constants });
  return { ...qa, requests, events };
}

function assertBlocked(result, h) {
  assert.equal(result.gate_a.status, 'FAIL');
  assert.equal(result.gate_b.status, 'NOT_RUN');
  assert.equal(Object.keys(result.gate_b.criteria).length, 0);
  assert.equal(result.final_approval, false);
  assert.equal(result.verdict.value, 'FAIL');
  assert.equal(h.requests.length, 1);
}

test('A completes before B starts; B receives color reference; both gates approve', async () => {
  const h = harness([response('A'), response('B')]);
  const result = await h.runCatalogQA(input);
  assert.equal(result.final_approval, true);
  assert.equal(result.gate_a.status, 'PASS');
  assert.equal(result.gate_b.status, 'PASS');
  assert.deepEqual(h.events, ['start-0', 'complete-0', 'start-1', 'complete-1']);
  const images = h.requests[1].input[0].content.filter(c => c.type === 'input_image');
  assert.equal(images[0].image_url, 'data:image/jpeg;base64,' + input.originalBuffer.toString('base64'));
  assert.equal(images[1].image_url, 'data:image/png;base64,' + input.finalBuffer.toString('base64'));
  assert.equal('overall' in result.verdict, false);
});

test('every Gate A criterion independently blocks B below its floor', async () => {
  for (const key of A) {
    const a = response('A'); a.criteria[key].score = floors[key] - 1;
    const h = harness([a]); assertBlocked(await h.runCatalogQA(input), h);
  }
});

test('critical flag defeats perfect numeric scores for every structural criterion', async () => {
  for (const key of A) {
    const a = response('A'); a.criteria[key].critical_deviation = true;
    const h = harness([a]); const result = await h.runCatalogQA(input);
    assertBlocked(result, h);
    assert.ok(result.gate_a.critical_failures.some(f => f.criterion === key));
  }
});

test('top-level critical failures also defeat perfect scores', async () => {
  const a = response('A');
  a.critical_failures = [{ criterion: 'pave_end_boundary_fidelity', reason: 'Boundary moved' }];
  const h = harness([a]); assertBlocked(await h.runCatalogQA(input), h);
});

test('malformed or incomplete A responses fail closed without B', async () => {
  const fixtures = ['not JSON', 'null', '{}'];
  for (const mutate of [
    a => { delete a.critical_failures; },
    a => { a.critical_failures = 'none'; },
    a => { a.critical_failures = [null]; },
    a => { delete a.criteria.geometry_fidelity; },
    a => { delete a.criteria.geometry_fidelity.critical_deviation; },
    a => { a.criteria.geometry_fidelity.score = '100'; },
    a => { a.criteria.geometry_fidelity.score = 101; },
    a => { a.criteria.geometry_fidelity.note = ''; },
    a => { a.criteria.geometry_fidelity = { applicable: false, score: null, note: 'N/A', critical_deviation: false }; },
  ]) { const a = response('A'); mutate(a); fixtures.push(a); }
  for (const a of fixtures) {
    const h = harness([a]); assertBlocked(await h.runCatalogQA(input), h);
  }
});

test('all 14 Gate B criteria independently prevent final approval', async () => {
  for (const key of B) {
    const b = response('B'); b.criteria[key].score = floors[key] - 1;
    const h = harness([response('A'), b]);
    const result = await h.runCatalogQA(input);
    assert.equal(result.gate_a.status, 'PASS');
    assert.equal(result.gate_b.status, 'FAIL');
    assert.equal(result.final_approval, false);
    assert.notEqual(result.verdict.value, 'approved');
  }
});

test('missing B criterion or invalid JSON cannot approve', async () => {
  const b = response('B'); delete b.criteria.metal_realism;
  for (const fixture of [b, 'invalid JSON']) {
    const h = harness([response('A'), fixture]);
    const result = await h.runCatalogQA(input);
    assert.equal(result.gate_b.status, 'FAIL');
    assert.equal(result.final_approval, false);
  }
});

test('passing individual floors approves even when former combined mean is below 95', async () => {
  const a = response('A', 'floor'); const b = response('B', 'floor');
  const scores = [...Object.values(a.criteria), ...Object.values(b.criteria)].map(c => c.score);
  assert.ok(scores.reduce((s, x) => s + x, 0) / scores.length < 95);
  const h = harness([a, b]);
  assert.equal((await h.runCatalogQA(input)).final_approval, true);
});

test('physically inapplicable optional criteria remain N/A, never averaged as 100', async () => {
  const a = response('A'); const b = response('B');
  a.criteria.pave_start_boundary_fidelity = { applicable: false, score: null, critical_deviation: false, note: 'No pavé in source' };
  b.criteria.clean_light_premium_gold_appearance = { applicable: false, score: null, note: 'Silver product' };
  const h = harness([a, b]); const result = await h.runCatalogQA(input);
  assert.equal(result.final_approval, true);
  assert.equal(result.gate_a.criteria.pave_start_boundary_fidelity.score, null);
});

test('N/A cannot skip structural features or gold appearance established by Product Truth', async () => {
  for (const [key, truth] of [
    ['band_proportions', { category: { value: 'ring' } }],
    ['pave_end_boundary_fidelity', { setting_type: { value: 'pave' } }],
    ['prong_fidelity', { setting_type: { value: 'prong' } }],
    ['stone_layout_fidelity', { gemstone_presence: { value: true } }],
  ]) {
    const a = response('A');
    a.criteria[key] = { applicable: false, score: null, note: 'Incorrect N/A', critical_deviation: false };
    const h = harness([a]); assertBlocked(await h.runCatalogQA({ ...input, truth }), h);
  }
  const b = response('B');
  b.criteria.clean_light_premium_gold_appearance = { applicable: false, score: null, note: 'Incorrect N/A' };
  const h = harness([response('A'), b]);
  const result = await h.runCatalogQA({ ...input, truth: { metal_type: { value: 'yellow_gold' } } });
  assert.equal(result.gate_b.status, 'FAIL');
  assert.equal(result.final_approval, false);
});

function pipelineHarness(replies) {
  const h = harness(replies);
  const files = new Map();
  const memoryFs = { mkdirSync() {}, writeFileSync(file, data) { files.set(file, data); } };
  const writer = load('catalog/writer.js', { fs: memoryFs, path, crypto });
  // Immutable input persistence is tested separately; bundle writes stay in memory.
  writer.writeInputs = ({ originalRaw, masterClean }) => ({
    contract_version: 2, product_truth_authority: 'ORIGINAL_RAW',
    original_raw: { path: '/offline/inputs/original-raw.jpg', sha256: originalRaw.sha256 },
    master_clean_png: { path: '/offline/inputs/master-clean.png', sha256: masterClean.sha256, source_raw_sha256: originalRaw.sha256 },
    manifest_path: '/offline/inputs/input-manifest.json',
  });
  const inputContract = load('catalog/inputContract.js', { crypto, sharp: buffer => ({
    metadata: async () => ({ format: buffer.equals(input.originalBuffer) ? 'jpeg' : 'png', width: 2, height: 1, hasAlpha: true }),
    raw() { return this; },
    toBuffer: async () => ({ data: Buffer.from([0, 0, 0, 0, 1, 1, 1, 255]), info: { width: 2, height: 1, channels: 4 } }),
  }) });
  let candidates = 0;
  const pipeline = load('catalog/index.js', {
    path, './constants': constants, './writer': writer, './catalogQA': h, './inputContract': inputContract,
    './metadataParser': { parseFilename: () => ({ sku: 'OFFLINE-SKU' }) },
    './productTruth': { runProductTruth: async () => ({ truth: {}, model: 'offline-fixture' }) },
    './promptBuilder': { buildPrompt: () => 'offline prompt', resolveLayers: () => ({}) },
    './gptImageEdit': { runGptImageEdit: async () => {
      candidates++;
      return { pngBuffer: Buffer.from('candidate-marker'), model: 'offline-fixture', size: '1024x1024', quality: 'high', durationMs: 0, usage: null };
    } },
  });
  return { ...h, ...pipeline, files, candidates: () => candidates };
}
const cleanMarker = Buffer.from('master-clean-marker');
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const pipelineInput = {
  originalRaw: { buffer: input.originalBuffer, originalFilename: 'offline.png' },
  masterClean: { buffer: cleanMarker, originalFilename: 'master-clean.png' },
  inputManifest: {
    contract_version: 2,
    original_raw: { sha256: digest(input.originalBuffer) },
    master_clean_png: { sha256: digest(cleanMarker), source_raw_sha256: digest(input.originalBuffer) },
  },
  openaiKey: 'offline-placeholder',
};

test('A FAIL reaches report, metadata and manual routing without retry or phantom B usage', async () => {
  const a = response('A'); a.criteria.prong_fidelity.critical_deviation = true;
  const h = pipelineHarness([a]); const result = await h.runCatalogPipeline(pipelineInput);
  assert.equal(h.candidates(), 1);
  assert.equal(result.verdict.value, 'FAIL');
  assert.equal(result.final_approval, false);
  assert.equal(result.finalMetadata.stages.gate_b.model, null);
  assert.equal(result.finalMetadata.stages.gate_b.status, 'NOT_RUN');
  assert.equal(result.finalMetadata.final_scores_summary.gate_b_min, null);
  const report = JSON.parse(h.files.get(result.bundle.files.qaReport));
  assert.equal(report.gate_b.status, 'NOT_RUN');
  assert.equal(report.final_approval, false);
  assert.match(result.bundle.dir, /renders\/manual/);
  assert.ok(h.files.has(result.bundle.files.manualReviewReasons));
});

test('retry candidate must pass A again; structural retry failure skips B', async () => {
  const b = response('B'); b.criteria.framing.score = 0;
  const a2 = response('A'); a2.criteria.geometry_fidelity.critical_deviation = true;
  const h = pipelineHarness([response('A'), b, a2]);
  const result = await h.runCatalogPipeline(pipelineInput);
  assert.equal(h.candidates(), 2);
  assert.equal(h.requests.length, 3);
  assert.equal(result.verdict.value, 'FAIL');
  assert.equal(result.gate_b.status, 'NOT_RUN');
  assert.equal(result.final_approval, false);
});

test('presentation retry budget stays one and exhausted retry cannot approve', async () => {
  const b = response('B'); b.criteria.framing.score = 0;
  const h = pipelineHarness([response('A'), b, response('A'), b]);
  const result = await h.runCatalogPipeline(pipelineInput);
  assert.equal(h.candidates(), 2);
  assert.equal(result.verdict.value, 'manual_review');
  assert.equal(result.final_approval, false);
});

test('HTTP handler propagates the explicit gate contract', async () => {
  const h = pipelineHarness([response('A'), response('B')]);
  let status, body;
  const res = { status(code) { status = code; return this; }, json(data) { body = data; return this; } };
  await h.createHandler()({
    files: {
      original_raw: [{ fieldname: 'original_raw', buffer: input.originalBuffer, originalname: 'offline.png' }],
      master_clean_png: [{ fieldname: 'master_clean_png', buffer: cleanMarker, originalname: 'master-clean.png' }],
    },
    body: { input_manifest: JSON.stringify(pipelineInput.inputManifest) },
  }, res);
  assert.equal(status, 200);
  assert.equal(body.gate_a.status, 'PASS');
  assert.equal(body.gate_b.status, 'PASS');
  assert.equal(body.final_approval, true);
  assert.equal('overall' in body, false);
  assert.equal('artifacts' in body, false);
});

test('assembled production prompts preserve SKU for normal and retry passes', () => {
  const { buildPrompt } = require('../catalog/promptBuilder');
  const truth = {
    category: { value: 'ring', source: 'filename' }, metal_type: { value: 'yellow_gold', source: 'filename' },
    karat: {}, gemstone_presence: { value: true, visible_count: 8 }, gemstone_type: {}, setting_type: {},
    chain_visible: {}, pendant_visible: {}, support_objects: {}, cleanup_regions: {},
    visible_hallmarks: { present: true, regions: ['inner_band'] }, product_complete: {}, background_condition: {},
  };
  for (const retry of [false, true]) {
    const prompt = buildPrompt({ truth, retry });
    assert.doesNotMatch(prompt, /approximately 5%|Reduce prong head|Reduce the visual height|visually slimmer|fixed 50mm|exact front-facing orientation|do NOT render these|Remove all hallmarks/);
    assert.match(prompt, /Product Truth overrides aesthetic optimization/);
    assert.match(prompt, /preserve these physical product markings exactly/);
    assert.match(prompt, /preserve every visible stone|preserve exactly — do not add or remove stones/);
    assert.match(prompt, /#FFFFFF/);
  }
});


test('zero retry budget performs one render and routes presentation failure to review', async () => {
  const b = response('B'); b.criteria.framing.score = 0;
  const h = pipelineHarness([response('A'), b]);
  const result = await h.runCatalogPipeline({ ...pipelineInput, retryLimit: 0 });
  assert.equal(h.candidates(), 1);
  assert.equal(h.requests.length, 2);
  assert.equal(result.verdict.value, 'manual_review');
  assert.equal(result.final_approval, false);
  assert.equal(result.finalMetadata.retry_count, 0);
  assert.equal(result.finalMetadata.retry_limit, 0);
});

test('single attempt renderer disables SDK transport retries', async () => {
  let options;
  const { runGptImageEdit } = load('catalog/gptImageEdit.js', {
    './constants': constants,
    openai: {
      OpenAI: class { constructor(config) { options = config; this.images = { edit: async () => ({ data: [{ b64_json: 'eA==' }] }) }; } },
      toFile: async () => ({}),
    },
  });
  await runGptImageEdit({ imageBuffer: Buffer.from('input'), prompt: 'test', openaiKey: 'offline', maxRetries: 0 });
  assert.equal(options.maxRetries, 0);
});


test('HTTP zero retry header is honored and other values fail before providers', async () => {
  const b = response('B'); b.criteria.framing.score = 0;
  const h = pipelineHarness([response('A'), b]);
  let status, body;
  const res = { status(code) { status = code; return this; }, json(data) { body = data; return this; } };
  await h.createHandler()({ headers: { 'x-catalog-retry-limit': '1' } }, res);
  assert.equal(status, 400);
  assert.equal(h.candidates(), 0);
  await h.createHandler()({
    headers: { 'x-catalog-retry-limit': '0', 'x-catalog-include-artifacts': '1' },
    files: {
      original_raw: [{ fieldname: 'original_raw', buffer: input.originalBuffer, originalname: 'offline.png' }],
      master_clean_png: [{ fieldname: 'master_clean_png', buffer: cleanMarker, originalname: 'master-clean.png' }],
    },
    body: { input_manifest: JSON.stringify(pipelineInput.inputManifest) },
  }, res);
  assert.equal(status, 200);
  assert.equal(h.candidates(), 1);
  assert.equal(body.retry_count, 0);
  assert.equal(body.retry_limit, 0);
  assert.equal(body.verdict, 'manual_review');
  assert.equal(crypto.createHash('sha256').update(Buffer.from(body.artifacts.render_candidate_base64, 'base64')).digest('hex'), body.artifacts.candidate_metadata.hashes.render_candidate_sha256);
  assert.equal(body.artifacts.qa_report.final_approval, false);
  assert.equal(body.artifacts.candidate_metadata.retry_count, 0);
});
