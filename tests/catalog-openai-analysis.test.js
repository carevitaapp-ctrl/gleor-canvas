// End-to-end provider-mocked analysis tests. Network is never available to these VM modules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const constants = require('../catalog/constants');
const schemaModule = require('../catalog/analysisSchemas');
const root = path.resolve(__dirname, '..');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function load(file, allowed, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, exports: module.exports, Buffer, Date, __dirname: path.dirname(path.join(root, file)),
    process: { env }, console: { error() {} },
    require(name) {
      assert.ok(Object.hasOwn(allowed, name), `Unexpected runtime dependency: ${name}`);
      return allowed[name];
    },
  });
  return module.exports;
}
function truthFixture() {
  const en = (value, confidence = 0.95) => ({ value, confidence });
  return {
    category: en('pendant'), metal_type: en('yellow_gold'), karat: en('18K'), orientation: en('front'),
    product_scale: { ...en('correct'), occupies_frame_pct: 60 }, framing: en('centered'),
    product_complete: { value: true, cropped_regions: [], confidence: 1 },
    visible_hallmarks: { present: false, regions: [], confidence: 0.9 },
    cleanup_regions: { present: false, types: [], regions: [], confidence: 1 },
    support_objects: { present: false, types: [] }, chain_visible: en(false), pendant_visible: en(false),
    background_condition: en('clean_white'), gemstone_presence: { value: true, visible_count: 8, count_confidence: 0.95 },
    gemstone_type: en('diamond'), setting_type: en('prong'), overall_analysis_confidence: 0.95,
  };
}
function gate(layer, badKey) {
  const keys = layer === 'A' ? constants.QA_LAYER_A_CRITERIA : constants.QA_LAYER_B_CRITERIA;
  return { criteria: Object.fromEntries(keys.map(k => [k, { score: k === badKey ? 0 : 100, applicable: true, note: 'Fixture assessment', ...(layer === 'A' ? { critical_deviation: false } : {}) }])), ...(layer === 'A' ? { critical_failures: [] } : {}) };
}
function completed(json) {
  return { status: 'completed', model: constants.MODELS.qa, usage: { input_tokens: 10, output_tokens: 20 }, output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof json === 'string' ? json : JSON.stringify(json) }] },
  ] };
}
function harness(replies, models = constants) {
  const calls = [], rendererInputs = [];
  const https = { request(options, callback) {
    assert.equal(options.hostname, 'api.openai.com'); assert.equal(options.path, '/v1/responses');
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer offline-key');
    const index = calls.length; assert.ok(index < replies.length, 'Unbudgeted request or retry');
    calls.push(null); const req = new EventEmitter(); let body = '';
    req.setTimeout = (ms, callback) => { assert.equal(ms, 120000); req.timeout = callback; return req; };
    req.destroy = error => req.emit('error', error);
    req.write = c => { body += c; };
    req.end = () => queueMicrotask(() => {
      calls[index] = JSON.parse(body);
      const reply = replies[index];
      if (reply.transportError) return req.emit('error', new Error('sensitive transport details'));
      if (reply.timeout) return req.timeout();
      const res = new EventEmitter(); res.statusCode = reply.httpStatus || 200; callback(res);
      if (reply.aborted) return res.emit('aborted');
      res.emit('data', Buffer.from(reply.rawBody ?? JSON.stringify(reply.envelope ?? completed(reply))));
      res.emit('end');
    });
    return req;
  } };
  const analysis = load('catalog/openaiAnalysis.js', { https, './analysisSchemas': schemaModule, './constants': models });
  const truth = load('catalog/productTruth.js', { fs, path, './constants': models, './openaiAnalysis': analysis });
  const qa = load('catalog/catalogQA.js', { fs, path, './constants': models, './openaiAnalysis': analysis });
  const raw = Buffer.from('original-raw-marker'), clean = Buffer.from('immutable-clean-marker');
  const pipeline = load('catalog/index.js', {
    './constants': models, './productTruth': truth, './catalogQA': qa,
    './metadataParser': { parseFilename: () => ({ sku: 'ring-test' }) },
    './promptBuilder': { buildPrompt: () => 'unchanged renderer prompt', resolveLayers: () => ({}) },
    './writer': { sha256: hash, writeInputs: () => ({}), writeBundle: () => ({ dir: '/offline', files: {} }) },
    './inputContract': { validateInputs: async input => input, readCatalogRequest: req => req.input },
    './gptImageEdit': { runGptImageEdit: async args => {
      rendererInputs.push(Buffer.from(args.imageBuffer));
      args.imageBuffer.fill(0); // Provider mutation must not contaminate a retry.
      return { pngBuffer: Buffer.from('candidate-' + rendererInputs.length), model: constants.MODELS.gptImage };
    } },
  }, { OPENAI_API_KEY: 'offline-key' });
  const input = { originalRaw: { buffer: raw, originalFilename: 'ring-test.jpg', mediaType: 'image/jpeg', sha256: hash(raw) }, masterClean: { buffer: clean, mediaType: 'image/png', sha256: hash(clean) }, inputManifest: {}, openaiKey: 'offline-key', retryLimit: 0 };
  return { ...analysis, ...truth, ...qa, ...pipeline, calls, rendererInputs, input };
}
const images = call => call.input[0].content.filter(c => c.type === 'input_image');
const data = (b, type) => `data:${type};base64,${b.toString('base64')}`;

test('full one-pass path: RAW-only Truth, RAW/candidate A/B, 3 Responses + 1 unchanged renderer', async () => {
  const h = harness([truthFixture(), gate('A'), gate('B')]);
  const result = await h.runCatalogPipeline(h.input);
  assert.equal(result.final_approval, true);
  assert.equal(h.calls.length, 3); assert.equal(h.rendererInputs.length, 1);
  assert.deepEqual(h.rendererInputs[0], h.input.masterClean.buffer);
  assert.equal(images(h.calls[0]).length, 1);
  assert.equal(images(h.calls[0])[0].image_url, data(h.input.originalRaw.buffer, 'image/jpeg'));
  for (const call of h.calls.slice(1)) {
    assert.equal(images(call).length, 2);
    assert.equal(images(call)[0].image_url, data(h.input.originalRaw.buffer, 'image/jpeg'));
    assert.equal(images(call)[1].image_url, data(Buffer.from('candidate-1'), 'image/png'));
    assert.ok(images(call).every(i => i.detail === 'high'));
  }
  assert.match(h.calls[2].input[0].content[0].text, /material\/color context only/);
  for (const call of h.calls) {
    assert.equal(call.store, false); assert.equal(call.text.format.strict, true);
    assert.equal(call.text.format.type, 'json_schema');
    assert.equal('tools' in call, false); assert.equal('temperature' in call, false);
    assert.equal(call.max_output_tokens, 8192);
  }
  assert.equal(result.finalMetadata.hashes.render_candidate_sha256, hash(Buffer.from('candidate-1')));
});

test('strict confidence gates and authoritative filename coercion stay unchanged', async () => {
  const f = truthFixture();
  f.metal_type.confidence = 0.84; f.karat.confidence = 0.84; f.gemstone_type.confidence = 0.84; f.gemstone_presence.count_confidence = 0.84;
  const h = harness([f, f]);
  const args = { imageBuffer: h.input.originalRaw.buffer, imageMediaType: 'image/jpeg', sku: 'ring-test', openaiKey: 'offline-key' };
  const a = (await h.runProductTruth(args)).truth;
  assert.equal(a.metal_type.value, null); assert.equal(a.karat.value, null);
  assert.equal(a.gemstone_type.value, 'unknown'); assert.equal(a.gemstone_presence.visible_count, null);
  const b = (await h.runProductTruth({ ...args, filenameMetadata: { metal_type: { value: 'silver' }, karat: { value: '925' } } })).truth;
  assert.equal(b.metal_type.value, 'silver'); assert.equal(b.metal_type.source, 'filename'); assert.equal(b.karat.value, '925');
  assert.equal(JSON.stringify(Object.keys(b)), JSON.stringify(constants.PRODUCT_TRUTH_KEY_ORDER));
});

test('confidence clamp, percent conversion and strict 0.85 boundary remain intact', async () => {
  const f = truthFixture(); f.metal_type.confidence = 0.85; f.gemstone_presence.count_confidence = 0.85;
  f.overall_analysis_confidence = 2; f.product_scale.occupies_frame_pct = 0.5;
  const h = harness([f]);
  const { truth } = await h.runProductTruth({ imageBuffer: Buffer.from('raw'), imageMediaType: 'image/jpeg', openaiKey: 'offline-key' });
  assert.equal(truth.metal_type.value, 'yellow_gold'); assert.equal(truth.gemstone_presence.visible_count, 8);
  assert.equal(truth.overall_analysis_confidence, 1); assert.equal(truth.product_scale.occupies_frame_pct, 50);
});

test('malformed Product Truth blocks rendering before lenient coercers can fill omissions', async () => {
  for (const value of ['broken JSON', '{}', 'null', '```json\n{}\n```', { ...truthFixture(), extra: true }]) {
    const h = harness([value]);
    await assert.rejects(h.runCatalogPipeline(h.input), e => e.code === 'INVALID_ANALYSIS_OUTPUT');
    assert.equal(h.calls.length, 1); assert.equal(h.rendererInputs.length, 0);
  }
  for (const key of Object.keys(truthFixture())) {
    const f = truthFixture(); delete f[key]; const h = harness([f]);
    await assert.rejects(h.runCatalogPipeline(h.input), e => e.code === 'INVALID_ANALYSIS_OUTPUT');
    assert.equal(h.rendererInputs.length, 0);
  }
});

test('refused, incomplete, ambiguous and malformed envelopes cannot approve or retry', async () => {
  const base = completed(truthFixture());
  const malformed = [
    { ...base, status: 'incomplete' }, { ...base, error: { message: 'failure' } },
    { ...base, incomplete_details: { reason: 'max_output_tokens' } },
    { ...base, output: [] }, { ...base, output: [base.output[0], base.output[0]] },
    { ...base, output: [{ ...base.output[0], status: 'incomplete' }] },
    { ...base, output: [{ ...base.output[0], content: [{ type: 'refusal', refusal: 'no' }] }] },
    { ...base, output: [{ ...base.output[0], content: [...base.output[0].content, { type: 'refusal', refusal: 'no' }] }] },
  ];
  for (const envelope of malformed) {
    const h = harness([{ envelope }]);
    await assert.rejects(h.runCatalogPipeline(h.input), e => e.code === 'INVALID_ANALYSIS_OUTPUT');
    assert.equal(h.calls.length, 1); assert.equal(h.rendererInputs.length, 0);
  }
});

test('malformed OpenAI A blocks B and malformed B cannot trigger presentation retry', async () => {
  for (const a of ['invalid', { ...gate('A'), extra: true }]) {
    const h = harness([truthFixture(), a]); const r = await h.runCatalogPipeline(h.input);
    assert.equal(r.gate_a.status, 'FAIL'); assert.equal(r.gate_b.status, 'NOT_RUN');
    assert.equal(r.final_approval, false); assert.equal(h.calls.length, 2); assert.equal(h.rendererInputs.length, 1);
  }
  const h = harness([truthFixture(), gate('A'), 'invalid']);
  const r = await h.runCatalogPipeline({ ...h.input, retryLimit: 1 });
  assert.equal(r.gate_b.status, 'FAIL'); assert.equal(r.verdict.value, 'manual_review');
  assert.equal(h.calls.length, 3); assert.equal(h.rendererInputs.length, 1);
});

test('one-pass presentation failure never exceeds 3 analyses and 1 render', async () => {
  const h = harness([truthFixture(), gate('A'), gate('B', 'framing')]);
  const r = await h.runCatalogPipeline(h.input);
  assert.equal(r.verdict.value, 'manual_review'); assert.equal(r.finalMetadata.retry_count, 0);
  assert.equal(h.calls.length, 3); assert.equal(h.rendererInputs.length, 1);
});

test('normal presentation retry remains bounded at 5 analyses / 2 renders with identical Clean bytes', async () => {
  const h = harness([truthFixture(), gate('A'), gate('B', 'framing'), gate('A'), gate('B', 'framing')]);
  const r = await h.runCatalogPipeline({ ...h.input, retryLimit: 1 });
  assert.equal(r.verdict.value, 'manual_review'); assert.equal(r.finalMetadata.retry_count, 1);
  assert.equal(h.calls.length, 5); assert.equal(h.rendererInputs.length, 2);
  assert.deepEqual(h.rendererInputs[0], h.rendererInputs[1]);
});

test('HTTP, connection, timeout and response failures are not retried or leaked', async () => {
  for (const failure of [{ httpStatus: 429, rawBody: 'secret-payload' }, { httpStatus: 500 }, { transportError: true }, { timeout: true }, { aborted: true }]) {
    const h = harness([failure]);
    await assert.rejects(h.runCatalogPipeline(h.input), e => !/secret-payload|sensitive transport details/.test(e.message));
    assert.equal(h.calls.length, 1); assert.equal(h.rendererInputs.length, 0);
  }
});

test('only OPENAI_API_KEY is needed by handler; missing key fails before providers', async () => {
  const h = harness([truthFixture(), gate('A'), gate('B')]); let status, body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await h.createHandler()({ input: h.input, headers: { 'x-catalog-retry-limit': '0' } }, res);
  assert.equal(status, 200); assert.equal(body.final_approval, true);
  const missing = harness([]);
  await assert.rejects(missing.runCatalogPipeline({ ...missing.input, openaiKey: undefined }), /openaiKey required/);
  assert.equal(missing.calls.length, 0);
});

test('runtime catalog contains no former provider references or fallback', () => {
  for (const file of fs.readdirSync(path.join(root, 'catalog')).filter(f => f.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'catalog', file), 'utf8'), /anthropic|claude/i, file);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /anthropic|claude/i);
  for (const dir of ['qa', 'qa-lock']) {
    for (const file of fs.readdirSync(path.join(root, 'prompts', dir))) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, 'prompts', dir, file), 'utf8'), /anthropic|claude/i);
    }
  }
});

test('configured nano/mini use identical schemas and prompts; flagship is rejected before network', async () => {
  for (const model of constants.MODELS.analysisAllowed) {
    const h = harness([truthFixture(), gate('A'), gate('B')], { ...constants, MODELS: { ...constants.MODELS, productTruth: model, qa: model } });
    const r = await h.runCatalogPipeline(h.input);
    assert.equal(r.final_approval, true);
    assert.ok(h.calls.every(c => c.model === model));
    assert.equal(JSON.stringify(h.calls[0].text.format.schema), JSON.stringify(schemaModule.schemas.product_truth));
    assert.equal(JSON.stringify(h.calls[1].text.format.schema), JSON.stringify(schemaModule.schemas.gate_a));
  }
  const h = harness([], { ...constants, MODELS: { ...constants.MODELS, productTruth: 'expensive-flagship' } });
  await assert.rejects(h.runCatalogPipeline(h.input), /Unsupported catalog analysis model/);
  assert.equal(h.calls.length, 0);
});

test('failure at A or B stops the pipeline without a provider or render retry', async () => {
  for (const replies of [[truthFixture(), { httpStatus: 500 }], [truthFixture(), gate('A'), { httpStatus: 429 }]]) {
    const h = harness(replies);
    await assert.rejects(h.runCatalogPipeline({ ...h.input, retryLimit: 1 }), /OpenAI analysis HTTP/);
    assert.equal(h.calls.length, replies.length); assert.equal(h.rendererInputs.length, 1);
  }
});

test('null output items and unsolicited tool output fail closed while reasoning output is accepted', async () => {
  for (const item of [null, { type: 'function_call', name: 'unexpected' }]) {
    const base = completed(truthFixture()); base.output.unshift(item);
    const h = harness([{ envelope: base }]);
    await assert.rejects(h.runCatalogPipeline(h.input), e => e.code === 'INVALID_ANALYSIS_OUTPUT');
    assert.equal(h.calls.length, 1);
  }
  const base = completed(truthFixture()); base.output.unshift({ type: 'reasoning', summary: [] });
  const h = harness([{ envelope: base }, gate('A'), gate('B')]);
  assert.equal((await h.runCatalogPipeline(h.input)).final_approval, true);
});

test('every nested strict schema requires all properties and rejects extras', () => {
  function check(s) {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual(s.required, Object.keys(s.properties));
      Object.values(s.properties).forEach(check);
    }
    if (s.type === 'array') check(s.items);
  }
  Object.values(schemaModule.schemas).forEach(check);
});
