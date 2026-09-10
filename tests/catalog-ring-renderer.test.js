// Offline regression: real prompt builder and GPT Image adapter, mocked SDK only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const C = require('../catalog/constants');
const prompts = require('../catalog/promptBuilder');
const hash = b => createHash('sha256').update(b).digest('hex');
function load(file, deps) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, Buffer, Date, console,
    require(n) {
      assert.ok(Object.hasOwn(deps, n), `Forbidden dependency (including composer): ${n}`);
      return deps[n];
    },
  });
  return module.exports;
}
function truth(category) {
  const field = value => ({ value, confidence: 1, source: 'vision' });
  return {
    category: field(category), metal_type: field('yellow_gold'), karat: field('18K'),
    gemstone_presence: { value: true, visible_count: 8 }, gemstone_type: field('diamond'),
    setting_type: field('prong'), chain_visible: field(false), pendant_visible: field(false),
    support_objects: { present: false }, cleanup_regions: { present: false },
    visible_hallmarks: { present: false }, product_complete: field(true),
    background_condition: field('clean_white'),
  };
}
for (const category of ['ring', 'pendant']) {
  test(`${category} uses GPT images.edit and existing layers; bounded retries preserve RAW/Clean`, async () => {
    for (const [verdicts, retryLimit, expected] of [
      [['approved'], 1, 'approved'], [['FAIL'], 1, 'FAIL'],
      [['retry'], 0, 'manual_review'], [['retry', 'approved'], 1, 'approved'],
      [['retry', 'retry'], 1, 'manual_review'],
    ]) {
      const raw = Buffer.from('authoritative RAW'), clean = Buffer.from('immutable Clean');
      const pt = truth(category), calls = [], qaCalls = [], configs = [];
      const renderer = load('catalog/gptImageEdit.js', {
        './constants': C,
        openai: {
          toFile: async (bytes, name, options) => {
            assert.deepEqual(bytes, clean);
            assert.equal(name, 'master-clean.png'); assert.equal(options.type, 'image/png');
            const copy = Buffer.from(bytes); bytes.fill(0);
            return copy;
          },
          OpenAI: class {
            constructor(config) {
              configs.push(config);
              this.images = { edit: async args => {
                calls.push(args);
                return { data: [{ b64_json: Buffer.from(`candidate-${calls.length}`).toString('base64') }] };
              } };
            }
          },
        },
      });
      const pipeline = load('catalog/index.js', {
        './constants': C, './promptBuilder': prompts, './gptImageEdit': renderer,
        './metadataParser': { parseFilename: () => ({ category: { value: category }, sku: 'test' }) },
        './inputContract': { validateInputs: async input => input },
        './writer': { sha256: hash, writeInputs: () => ({}), writeBundle: () => ({}) },
        './productTruth': { runProductTruth: async args => {
          assert.deepEqual(args.imageBuffer, raw); args.imageBuffer.fill(0);
          return { truth: pt };
        } },
        './catalogQA': { runCatalogQA: async args => {
          assert.deepEqual(args.originalBuffer, raw);
          if (category === 'ring') { assert.deepEqual(args.masterCleanBuffer, clean); args.masterCleanBuffer.fill(0); }
          else assert.equal(args.masterCleanBuffer, undefined);
          assert.equal(args.finalBuffer.toString(), `candidate-${calls.length}`);
          assert.equal(args.truth, pt);
          args.originalBuffer.fill(0); qaCalls.push(args);
          const value = verdicts[qaCalls.length - 1];
          assert.ok(value, 'Unexpected QA retry');
          return { gate_a: { status: value === 'FAIL' ? 'FAIL' : 'PASS', criteria: {} },
            gate_b: { status: value === 'FAIL' ? 'NOT_RUN' : value === 'approved' ? 'PASS' : 'FAIL', criteria: {} },
            final_approval: value === 'approved', verdict: { value, reasons: [] } };
        } },
      });
      const result = await pipeline.runCatalogPipeline({
        originalRaw: { buffer: raw, originalFilename: `${category}.jpg`, mediaType: 'image/jpeg' },
        masterClean: { buffer: clean, mediaType: 'image/png' }, openaiKey: 'offline-key', retryLimit,
      });
      assert.equal(calls.length, verdicts.length); assert.equal(qaCalls.length, calls.length);
      for (const [i, call] of calls.entries()) {
        assert.deepEqual(call.image, clean);
        assert.equal(call.model, C.MODELS.gptImage);
        assert.equal(call.size, '1024x1024'); assert.equal(call.quality, 'high');
        assert.equal(call.prompt, prompts.buildPrompt({ truth: pt, retry: i > 0 }));
      }
      if (retryLimit === 0) assert.equal(configs[0].maxRetries, 0);
      const stages = result.finalMetadata.stages;
      assert.equal(stages.prompt_builder.layers_used.base, 'hero-catalog-v1.txt');
      assert.equal(stages.prompt_builder.layers_used.category, `category/${category}.txt`);
      assert.equal(stages.prompt_builder.layers_used.qaLock, `qa-lock/${calls.length === 2 ? 'catalog-v1-tightened' : 'catalog-v1'}.txt`);
      assert.equal(stages.gpt_image.model, C.MODELS.gptImage);
      assert.equal(stages.ring_composer, undefined);
      assert.equal(result.artifacts.qa_report.local_qa, undefined);
      assert.equal(result.verdict.value, expected);
      assert.equal(result.final_approval, expected === 'approved');
      assert.equal(result.finalMetadata.retry_count, calls.length - 1);
      assert.equal(raw.toString(), 'authoritative RAW'); assert.equal(clean.toString(), 'immutable Clean');
    }
  });
}
