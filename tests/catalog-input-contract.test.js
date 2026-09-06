// Offline Input Contract V2 tests. Provider imports are guarded VM stubs, image
// decoding is stubbed, and persistence is an in-memory filesystem. Multipart
// tests use in-memory request streams and the local parser; no HTTP server runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const multer = require('multer');
const constants = require('../catalog/constants');
const root = path.resolve(__dirname, '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function load(relative, allowed, onRequire = () => {}) {
  const filename = path.join(root, relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, Date,
    process: { env: { ANTHROPIC_API_KEY: 'offline-placeholder', OPENAI_API_KEY: 'offline-placeholder' } },
    console: { log() {}, error() {} },
    require(name) {
      if (!Object.hasOwn(allowed, name)) throw new Error(`Forbidden dependency: ${name}`);
      onRequire(name);
      return allowed[name];
    },
  }, { filename });
  return module.exports;
}

function fixture() {
  const raw = Buffer.from('original-photograph-byte-marker');
  const clean = Buffer.from('segmented-master-byte-marker');
  return {
    originalRaw: { buffer: raw, originalFilename: 'ring-14k-yellow-gold-SKU123.jpg' },
    masterClean: { buffer: clean, originalFilename: 'earring-rose-gold-SKU999.png' },
    inputManifest: {
      contract_version: 2,
      original_raw: { sha256: sha256(raw) },
      master_clean_png: { sha256: sha256(clean), source_raw_sha256: sha256(raw) },
    },
    anthropicKey: 'offline-placeholder', openaiKey: 'offline-placeholder',
  };
}

function request(f = fixture()) {
  return {
    files: {
      original_raw: [{ fieldname: 'original_raw', buffer: f.originalRaw.buffer, originalname: f.originalRaw.originalFilename }],
      master_clean_png: [{ fieldname: 'master_clean_png', buffer: f.masterClean.buffer, originalname: f.masterClean.originalFilename }],
    },
    body: { input_manifest: JSON.stringify(f.inputManifest) },
  };
}

function decoder(options = {}) {
  const calls = [];
  const sharp = (buffer, settings) => {
    const clean = buffer.equals(fixture().masterClean.buffer);
    calls.push({ bytes: Buffer.from(buffer), settings });
    const override = (clean ? options.clean : options.raw) || {};
    return {
      async metadata() {
        if (override.metadataError) throw new Error('decoder failure');
        return { format: clean ? 'png' : 'jpeg', width: 2, height: 1, pages: 1, hasAlpha: clean, ...override.meta };
      },
      raw() { return this; },
      async toBuffer() {
        if (override.decodeError) throw new Error('truncated pixel data');
        return {
          data: override.pixels || (clean ? Buffer.from([0, 0, 0, 0, 10, 20, 30, 255]) : Buffer.from([10, 20, 30, 40, 50, 60])),
          info: { width: 2, height: 1, channels: clean ? 4 : 3, ...override.info },
        };
      },
    };
  };
  return { sharp, calls };
}

function contract(options) {
  const d = decoder(options);
  return { ...load('catalog/inputContract.js', { crypto, sharp: d.sharp }), decodeCalls: d.calls };
}

// Emulates exclusive create, fsync, atomic no-replace link and existing-file
// checks. No fixture image or pipeline artifact is written to the real disk.
function memoryFs() {
  const files = new Map(), handles = new Map(), events = [];
  let nextFd = 1;
  const state = { files, events, failWrite: false, failSync: false, failLink: false };
  const error = code => Object.assign(new Error(code), { code });
  state.fs = {
    mkdirSync() {},
    openSync(file, flags, mode) {
      assert.equal(flags, 'wx'); assert.equal(mode, 0o444);
      if (files.has(file)) throw error('EEXIST');
      files.set(file, { bytes: Buffer.alloc(0), regular: true });
      const fd = nextFd++; handles.set(fd, file); events.push(['open', file]); return fd;
    },
    writeFileSync(target, bytes) {
      if (state.failWrite) throw error('EIO');
      const file = typeof target === 'number' ? handles.get(target) : target;
      files.set(file, { bytes: Buffer.from(bytes), regular: true }); events.push(['write', file]);
    },
    fsyncSync(fd) {
      if (state.failSync) throw error('EIO');
      events.push(['sync', handles.get(fd)]);
    },
    closeSync(fd) { handles.delete(fd); },
    linkSync(from, to) {
      if (state.failLink) throw error('EPERM');
      if (files.has(to)) throw error('EEXIST');
      files.set(to, files.get(from)); events.push(['link', to]);
    },
    lstatSync(file) { return { isFile: () => files.get(file)?.regular === true }; },
    readFileSync(file) { if (!files.has(file)) throw error('ENOENT'); return Buffer.from(files.get(file).bytes); },
    unlinkSync(file) { if (!files.delete(file)) throw error('ENOENT'); events.push(['unlink', file]); },
  };
  return state;
}

function qaResult(value = 'approved') {
  return {
    gate_a: { status: value === 'FAIL' ? 'FAIL' : 'PASS', criteria: {}, critical_failures: [], model: 'offline', usage: null, durationMs: 0 },
    gate_b: { status: value === 'FAIL' ? 'NOT_RUN' : value === 'approved' ? 'PASS' : 'FAIL', criteria: {}, model: null, usage: null, durationMs: 0 },
    final_approval: value === 'approved', verdict: { value, reasons: [] },
  };
}

function pipeline(options = {}) {
  const c = contract(options.decoder);
  const memory = memoryFs();
  const writer = load('catalog/writer.js', { fs: memory.fs, path, crypto });
  const calls = [], imports = [];
  const parse = load('catalog/metadataParser.js', { path });
  let candidateIndex = 0, qaIndex = 0;
  const api = load('catalog/index.js', {
    path, './constants': constants, './inputContract': c, './writer': writer,
    './metadataParser': parse,
    './promptBuilder': { buildPrompt: () => 'existing-prompt-stub', resolveLayers: () => ({}) },
    './productTruth': { runProductTruth: async args => {
      calls.push({ type: 'truth', ...args, imageBuffer: Buffer.from(args.imageBuffer) });
      if (options.mutateProviderInputs) args.imageBuffer.fill(0);
      return { truth: {}, model: 'offline', usage: null };
    } },
    './gptImageEdit': { runGptImageEdit: async args => {
      calls.push({ type: 'renderer', ...args, imageBuffer: Buffer.from(args.imageBuffer) });
      if (options.mutateProviderInputs) args.imageBuffer.fill(0);
      return { pngBuffer: Buffer.from(`candidate-marker-${++candidateIndex}`), model: 'offline', size: '1024x1024', quality: 'high', durationMs: 0, usage: null };
    } },
    './catalogQA': { runCatalogQA: async args => {
      calls.push({ type: 'qa', ...args, originalBuffer: Buffer.from(args.originalBuffer) });
      return qaResult((options.verdicts || ['approved'])[qaIndex++] || 'approved');
    } },
  }, name => {
    if (['./productTruth', './gptImageEdit', './catalogQA'].includes(name)) {
      imports.push(name);
      assert.ok([...memory.files.keys()].some(p => p.endsWith('input-manifest.json')), 'Inputs must be persisted before provider modules load');
    }
  });
  return { ...api, ...c, memory, calls, imports, writer };
}

test('valid V2 inputs are hashed from exact bytes; decode cannot change the source assets', async () => {
  const f = fixture(), c = contract();
  const original = Buffer.from(f.originalRaw.buffer), clean = Buffer.from(f.masterClean.buffer);
  const result = await c.validateInputs(f);
  assert.equal(result.originalRaw.sha256, sha256(original));
  assert.equal(result.masterClean.sha256, sha256(clean));
  assert.equal(result.originalRaw.mediaType, 'image/jpeg');
  assert.equal(result.masterClean.mediaType, 'image/png');
  assert.deepEqual(result.originalRaw.buffer, original);
  assert.deepEqual(result.masterClean.buffer, clean);
  assert.notEqual(result.masterClean.buffer, f.masterClean.buffer);
  assert.deepEqual(f.originalRaw.buffer, original);
  assert.deepEqual(f.masterClean.buffer, clean);
  assert.equal(c.decodeCalls.length, 2);
  assert.ok(c.decodeCalls.every(c => c.settings.limitInputPixels === 40000000 && c.settings.failOn === 'warning'));
});

test('request schema rejects missing, duplicate, unexpected, old and candidate fields', () => {
  const c = contract();
  for (const mutate of [
    r => { delete r.files.original_raw; },
    r => { delete r.files.master_clean_png; },
    r => { r.files.original_raw.push(r.files.original_raw[0]); },
    r => { r.files.master_clean_png.push(r.files.master_clean_png[0]); },
    r => { r.files.image = r.files.original_raw; },
    r => { r.files.render_candidate = r.files.original_raw; },
    r => { r.file = r.files.original_raw[0]; },
    r => { r.body.image = 'old base64'; },
    r => { r.body.input_manifest = [r.body.input_manifest, r.body.input_manifest]; },
    r => { r.body.input_manifest = '{broken'; },
    r => { r.body = {}; },
    r => { r.files.original_raw[0].fieldname = 'image'; },
  ]) {
    const r = request(); mutate(r);
    assert.throws(() => c.readCatalogRequest(r), e => e.statusCode === 400);
  }
  assert.ok(c.readCatalogRequest(request()).originalRaw.buffer.equals(fixture().originalRaw.buffer));
});

test('manifest errors, mismatched hashes and lineage stop before any provider import or persistence', async () => {
  for (const mutate of [
    f => { f.inputManifest.contract_version = 1; },
    f => { f.inputManifest.contract_version = '2'; },
    f => { delete f.inputManifest.original_raw; },
    f => { f.inputManifest.original_raw.sha256 = 'bad'; },
    f => { f.inputManifest.original_raw.sha256 = '0'.repeat(64); },
    f => { f.inputManifest.master_clean_png.sha256 = '0'.repeat(64); },
    f => { f.inputManifest.master_clean_png.source_raw_sha256 = '0'.repeat(64); },
    f => { f.inputManifest.extra = true; },
    f => { f.inputManifest.master_clean_png.extra = true; },
    f => { f.masterClean.buffer = Buffer.from(f.originalRaw.buffer); f.inputManifest.master_clean_png.sha256 = sha256(f.masterClean.buffer); },
    f => { f.originalRaw.buffer = Buffer.alloc(0); },
    f => { f.masterClean.buffer = Buffer.alloc(25 * 1024 * 1024 + 1); },
  ]) {
    const f = fixture(), h = pipeline(); mutate(f);
    await assert.rejects(h.runCatalogPipeline(f), e => [400, 413, 422].includes(e.statusCode));
    assert.equal(h.imports.length, 0); assert.equal(h.calls.length, 0);
    assert.equal(h.memory.files.size, 0);
  }
});

test('unsupported, damaged, animated, oversized and opaque/empty Clean images fail before providers', async () => {
  for (const decoder of [
    { raw: { meta: { format: 'gif' } } },
    { raw: { meta: { pages: 2 } } },
    { raw: { meta: { width: 50000, height: 50000 } } },
    { raw: { decodeError: true } },
    { clean: { metadataError: true } },
    { clean: { meta: { format: 'jpeg' } } },
    { clean: { meta: { pages: 2 } } },
    { clean: { meta: { hasAlpha: false } } },
    { clean: { pixels: Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]) } },
    { clean: { pixels: Buffer.from([1, 2, 3, 0, 4, 5, 6, 0]) } },
    { clean: { pixels: Buffer.alloc(1) } },
    { clean: { decodeError: true } },
  ]) {
    const h = pipeline({ decoder });
    await assert.rejects(h.runCatalogPipeline(fixture()), e => e.statusCode === 422);
    assert.equal(h.imports.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.memory.files.size, 0);
  }
});

test('APNG control chunk is rejected even if a decoder might only report the first frame', async () => {
  const f = fixture(), h = pipeline();
  // Incomplete animation header, not a generated image or render fixture.
  f.masterClean.buffer = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([0, 0, 0, 0]), Buffer.from('acTL'), Buffer.alloc(4)]);
  f.inputManifest.master_clean_png.sha256 = sha256(f.masterClean.buffer);
  await assert.rejects(h.runCatalogPipeline(f), e => e.statusCode === 422 && /Animated/.test(e.message));
  assert.equal(h.imports.length, 0);
});

test('validation owns snapshots before awaiting decode', async () => {
  const f = fixture(), c = contract();
  const expectedRaw = Buffer.from(f.originalRaw.buffer), expectedClean = Buffer.from(f.masterClean.buffer);
  const pending = c.validateInputs(f);
  f.originalRaw.buffer.fill(0); f.masterClean.buffer.fill(0);
  const inputs = await pending;
  assert.deepEqual(inputs.originalRaw.buffer, expectedRaw);
  assert.deepEqual(inputs.masterClean.buffer, expectedClean);
});

test('RAW alone goes to Truth and QA; renderer and its retry receive identical Clean bytes', async () => {
  const f = fixture(), h = pipeline({ verdicts: ['retry', 'approved'], mutateProviderInputs: true });
  const result = await h.runCatalogPipeline(f);
  assert.equal(result.sku, 'SKU123');
  assert.equal(result.finalMetadata.filename, f.originalRaw.originalFilename);
  const truth = h.calls.find(c => c.type === 'truth');
  assert.deepEqual(truth.imageBuffer, f.originalRaw.buffer);
  assert.equal(truth.filenameMetadata.metal_type.value, 'yellow_gold');
  const renders = h.calls.filter(c => c.type === 'renderer');
  assert.equal(renders.length, 2);
  assert.ok(renders.every(c => c.imageBuffer.equals(f.masterClean.buffer) && c.imageMediaType === 'image/png' && c.imageFilename === 'master-clean.png'));
  const evaluations = h.calls.filter(c => c.type === 'qa');
  assert.equal(evaluations.length, 2);
  assert.ok(evaluations.every(c => c.originalBuffer.equals(f.originalRaw.buffer) && c.originalMediaType === 'image/jpeg'));
  assert.deepEqual(evaluations.map(c => c.finalBuffer.toString()), ['candidate-marker-1', 'candidate-marker-2']);
  assert.equal(result.finalMetadata.hashes.original_raw_sha256, sha256(f.originalRaw.buffer));
  assert.equal(result.finalMetadata.hashes.master_clean_png_sha256, sha256(f.masterClean.buffer));
  assert.equal(result.finalMetadata.hashes.render_candidate_sha256, sha256(Buffer.from('candidate-marker-2')));
  assert.equal(result.finalMetadata.inputs.product_truth_authority, 'ORIGINAL_RAW');
  assert.equal(result.finalMetadata.inputs.master_clean_png.source_raw_sha256, sha256(f.originalRaw.buffer));
  assert.equal(result.finalMetadata.retry_count, 1);
  assert.equal(result.final_approval, true);
});

test('existing A FAIL and exhausted retry routing remain unchanged', async () => {
  for (const [verdicts, expectedCalls, expectedVerdict] of [[['FAIL'], 1, 'FAIL'], [['retry', 'retry'], 2, 'manual_review']]) {
    const h = pipeline({ verdicts }); const result = await h.runCatalogPipeline(fixture());
    assert.equal(h.calls.filter(c => c.type === 'renderer').length, expectedCalls);
    assert.equal(result.verdict.value, expectedVerdict);
    assert.equal(result.final_approval, false);
    assert.ok(h.memory.files.has(result.bundle.files.manualReviewReasons));
  }
});

test('immutable inputs publish only after fsync, reuse identical content and retain both roles', async () => {
  const h = pipeline(), inputs = await h.validateInputs(fixture());
  const first = h.writer.writeInputs(inputs);
  const saved = new Map([...h.memory.files].map(([p, f]) => [p, Buffer.from(f.bytes)]));
  h.writer.writeInputs(inputs);
  assert.equal(h.memory.files.size, 3);
  for (const [p, bytes] of saved) assert.deepEqual(h.memory.files.get(p).bytes, bytes);
  const events = h.memory.events;
  for (let i = 0; i < events.length; i++) {
    if (events[i][0] === 'link') assert.ok(events.slice(0, i).some(e => e[0] === 'sync'));
  }
  assert.ok(h.memory.files.get(first.original_raw.path).bytes.equals(inputs.originalRaw.buffer));
  assert.ok(h.memory.files.get(first.master_clean_png.path).bytes.equals(inputs.masterClean.buffer));
  const manifest = JSON.parse(h.memory.files.get(first.manifest_path).bytes);
  assert.equal(manifest.product_truth_authority, 'ORIGINAL_RAW');
  assert.equal(manifest.master_clean_png.role, 'RENDERER_INPUT_ONLY');
  assert.ok(![...h.memory.files.keys()].some(p => p.endsWith('.tmp')));
});

test('conflicting existing RAW, Clean, manifest or symlink is never overwritten and no provider loads', async () => {
  for (const target of ['raw', 'clean', 'manifest', 'symlink']) {
    const h = pipeline(), f = fixture(), inputs = await h.validateInputs(f);
    const refs = h.writer.writeInputs(inputs);
    const file = target === 'raw' ? refs.original_raw.path : target === 'manifest' ? refs.manifest_path : refs.master_clean_png.path;
    const entry = h.memory.files.get(file);
    if (target === 'symlink') entry.regular = false;
    else entry.bytes = Buffer.from('conflicting-existing-content');
    const expected = Buffer.from(entry.bytes);
    await assert.rejects(h.runCatalogPipeline(f), e => e.statusCode === 409);
    assert.deepEqual(h.memory.files.get(file).bytes, expected);
    assert.equal(h.imports.length, 0); assert.equal(h.calls.length, 0);
    assert.ok(![...h.memory.files.keys()].some(p => p.endsWith('.tmp')));
  }
});

test('write/sync/publication failure never exposes a partial final input or reaches providers', async () => {
  for (const mode of ['failWrite', 'failSync', 'failLink']) {
    const h = pipeline(); h.memory[mode] = true;
    await assert.rejects(h.runCatalogPipeline(fixture()));
    assert.equal(h.memory.files.size, 0);
    assert.equal(h.imports.length, 0); assert.equal(h.calls.length, 0);
  }
});

test('writer rejects mutated canonical bytes and unsafe digest values', async () => {
  const h = pipeline(), inputs = await h.validateInputs(fixture());
  inputs.masterClean.buffer.fill(0);
  assert.throws(() => h.writer.writeInputs(inputs), e => e.statusCode === 409);
  const valid = await h.validateInputs(fixture());
  assert.throws(() => h.writer.writeInputs({ ...valid, originalRaw: { ...valid.originalRaw, sha256: '../escape' } }), e => e.statusCode === 409);
  assert.equal(h.memory.files.size, 0);
});

function serverRoute() {
  const routes = new Map(); let handlerCalls = 0;
  const c = contract();
  const app = { use() {}, get() {}, post(route, ...handlers) { routes.set(route, handlers); }, listen() {} };
  const express = () => app; express.json = () => () => {};
  load('server.js', {
    express, multer, sharp() { throw new Error('Legacy image processing must not run'); }, './heroEngine': {},
    './catalog': { createHandler: () => (req, res) => {
      handlerCalls++;
      try { c.readCatalogRequest(req); res.status(200).json({ accepted: true }); }
      catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
    } },
  });
  return { handlers: routes.get('/catalog'), routes, handlerCalls: () => handlerCalls };
}

function multipart(parts) {
  const boundary = 'offline-input-contract-boundary';
  const buffers = [];
  for (const p of parts) {
    buffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.file ? '; filename="fixture.bin"' : ''}\r\n${p.file ? 'Content-Type: application/octet-stream\r\n' : ''}\r\n`));
    buffers.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    buffers.push(Buffer.from('\r\n'));
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(buffers);
  const req = Readable.from([body]);
  req.method = 'POST'; req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  return req;
}
const parts = () => [
  { name: 'original_raw', file: true, data: fixture().originalRaw.buffer },
  { name: 'master_clean_png', file: true, data: fixture().masterClean.buffer },
  { name: 'input_manifest', data: JSON.stringify(fixture().inputManifest) },
];
async function sendMultipart(items) {
  const server = serverRoute();
  const response = await new Promise((resolve, reject) => {
    let status;
    const res = { status(s) { status = s; return this; }, json(body) { resolve({ status, body }); return this; } };
    const req = multipart(items);
    server.handlers[0](req, res, err => {
      if (err) return reject(err);
      try { server.handlers[1](req, res); } catch (e) { reject(e); }
    });
  });
  return { ...response, handlerCalls: server.handlerCalls() };
}

test('actual multipart parser accepts exactly two named files plus one manifest in either order', async () => {
  for (const items of [parts(), parts().reverse()]) {
    const response = await sendMultipart(items);
    assert.equal(response.status, 200); assert.equal(response.handlerCalls, 1);
  }
});

test('multipart duplicate/unexpected files and duplicate manifest are rejected before catalog handler', async () => {
  for (const items of [
    [...parts(), parts()[0]], [...parts(), parts()[1]],
    [parts()[0], { ...parts()[1], name: 'image' }, parts()[2]],
    [parts()[0], { ...parts()[1], name: 'render_candidate' }, parts()[2]],
    [...parts(), parts()[2]],
  ]) {
    const response = await sendMultipart(items);
    assert.equal(response.status, 400); assert.equal(response.handlerCalls, 0);
  }
});

test('multipart missing files, old single image and unexpected text are rejected', async () => {
  for (const items of [
    [parts()[0], parts()[2]], [parts()[1], parts()[2]],
    [{ ...parts()[0], name: 'image' }],
    [parts()[0], parts()[1], { name: 'unexpected', data: 'value' }],
  ]) assert.equal((await sendMultipart(items)).status, 400);
});

test('multipart file and manifest size limits return 413 without invoking catalog handler', async () => {
  for (const items of [
    [{ ...parts()[0], data: Buffer.alloc(25 * 1024 * 1024 + 1) }, ...parts().slice(1)],
    [parts()[0], parts()[1], { ...parts()[2], data: 'x'.repeat(4097) }],
  ]) {
    const response = await sendMultipart(items);
    assert.equal(response.status, 413); assert.equal(response.handlerCalls, 0);
  }
});

test('HTTP V2 response includes explicit input roles; invalid request never reaches providers', async () => {
  for (const valid of [true, false]) {
    const h = pipeline(); const req = request();
    if (!valid) req.body.input_manifest = '{}';
    let code, body;
    const res = { status(s) { code = s; return this; }, json(b) { body = b; return this; } };
    await h.createHandler()(req, res);
    if (valid) {
      assert.equal(code, 200); assert.equal(body.input_contract_version, 2);
      assert.equal(body.inputs.product_truth_authority, 'ORIGINAL_RAW');
      assert.equal(body.inputs.original_raw.sha256, sha256(fixture().originalRaw.buffer));
      assert.equal(body.inputs.master_clean_png.sha256, sha256(fixture().masterClean.buffer));
    } else {
      assert.equal(code, 400); assert.equal(h.imports.length, 0); assert.equal(h.calls.length, 0);
    }
  }
});
