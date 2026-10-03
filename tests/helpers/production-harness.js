const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const sharp = require('sharp');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../..');
const nativeRequire = createRequire(path.join(root, 'package.json'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const C = require('../../catalog/constants');
const { FIELDS, GENERAL_FIELDS, EARRING_FIELDS } = require('../../production/policy');
function source(category = 'ring') { return { category, complete: true, confidence: 1, features: FIELDS.map(name => ({ name, status: 'KNOWN', value: name === 'visible_stone_count' ? '0' : 'fixture visible topology', confidence: 1, evidence: 'Visible in synthetic RAW fixture' })) }; }
function truth(category = 'ring') {
  const en = value => ({ value, confidence: 1 });
  return { category: en(category), metal_type: en('yellow_gold'), karat: en(null), orientation: en('front'), product_scale: { ...en('correct'), occupies_frame_pct: 60 }, framing: en('centered'), product_complete: { value: true, cropped_regions: [], confidence: 1 }, visible_hallmarks: { present: false, regions: [], confidence: 1 }, cleanup_regions: { present: false, types: [], regions: [], confidence: 1 }, support_objects: { present: false, types: [] }, chain_visible: en(false), pendant_visible: en(false), background_condition: en('clean_white'), gemstone_presence: { value: false, visible_count: 0, count_confidence: 1 }, gemstone_type: en('unknown'), setting_type: en('unknown'), overall_analysis_confidence: 1 };
}
function comparison(category = 'ring') { return { features: [...new Set(category === 'earring' ? [...GENERAL_FIELDS,...EARRING_FIELDS] : GENERAL_FIELDS)].map(name => ({ name, result: 'MATCH', evidence: 'Same visible fixture identity', confidence: 1 })), finish_matches_source: true, finish_evidence: 'Same RAW fixture surface', finish_confidence: 1 }; }
function gate(layer) { return { criteria: Object.fromEntries((layer === 'A' ? C.QA_LAYER_A_CRITERIA : C.QA_LAYER_B_CRITERIA).map(k => [k, { score: 100, applicable: true, note: 'Synthetic fixture assessment', ...(layer === 'A' ? { critical_deviation: false } : {}) }])), ...(layer === 'A' ? { critical_failures: [] } : {}) }; }
function harness(config = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gleor-production-v2-')));
  const category = config.category || 'ring';
  const calls = []; let rendererCalls = 0;
  const replies = { production_source: source(category), product_truth: truth(category), production_comparison: comparison(category), gate_a: gate('A'), gate_b: gate('B'), ...config.replies };
  const https = { request(opts, cb) {
    if (opts.hostname !== 'api.openai.com') throw Error('UNEXPECTED_PROVIDER');
    const req = new EventEmitter(); let body = '';
    req.setTimeout = () => req; req.write = b => { body += b; }; req.destroy = e => req.emit('error', e);
    req.end = () => queueMicrotask(() => {
      const data = JSON.parse(body), name = data.text.format.name;
      calls.push(name);
      if (config.error === name) return req.emit('error', Error('fixture private provider error'));
      const reply = typeof replies[name] === 'function' ? replies[name](data, calls) : replies[name];
      const res = new EventEmitter(); res.statusCode = 200; cb(res);
      res.emit('data', Buffer.from(JSON.stringify({ status: 'completed', model: 'offline-stub', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(reply) }] }] })));
      res.emit('end');
    }); return req;
  } };
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const localRequire = name => {
      if (name === 'https') return https;
      if (name === './gptImageEdit') return { runGptImageEdit: async args => { rendererCalls++; return { pngBuffer: await sharp(args.imageBuffer).flatten({ background: 'white' }).png().toBuffer(), model: 'offline-renderer' }; } };
      if (name === './heroEngine') return { FINAL_SIZE: 8, renderHero: async () => ({ output: Buffer.from('fixture'), meta: { category: 'ring', metalTone: 'unknown', input_md5: 'fixture', output_md5: 'fixture', pipeline_version: 'offline', status: 'APPROVED' } }) };
      if (name.startsWith('.')) { let next = path.resolve(path.dirname(file), name); if (fs.existsSync(next) && fs.statSync(next).isDirectory()) next = path.join(next, 'index.js'); if (!path.extname(next)) next += '.js'; return load(next); }
      return nativeRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: localRequire, __dirname: file.endsWith('/catalog/writer.js') ? path.join(directory, 'catalog') : path.dirname(file), Buffer, console: config.console || console, process: { env: { OPENAI_API_KEY: 'offline-fixture', PHOTOROOM_API_KEY: 'offline-fixture' } }, Date, setTimeout, clearTimeout }, { filename: file });
    return module.exports;
  }
  return { directory, load: name => load(path.join(root, name)), calls, rendererCalls: () => rendererCalls, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
async function input(category = 'ring') {
  const data = Buffer.alloc(20*20*4);
  for (let y=5;y<15;y++) for (let x=5;x<15;x++) { const i=(y*20+x)*4; data[i]=130; data[i+1]=110; data[i+2]=80; data[i+3]=255; }
  const clean = await sharp(data,{raw:{width:20,height:20,channels:4}}).png().toBuffer();
  const raw = await sharp(clean).flatten({background:'white'}).jpeg().toBuffer();
  return { originalRaw:{buffer:raw,originalFilename:`${category}-SKU123.jpg`},masterClean:{buffer:clean,originalFilename:'clean.png'},inputManifest:{contract_version:2,original_raw:{sha256:hash(raw)},master_clean_png:{sha256:hash(clean),source_raw_sha256:hash(raw)}},openaiKey:'offline-fixture',retryLimit:0 };
}
module.exports = { harness, input, source, truth, comparison, gate, hash };
