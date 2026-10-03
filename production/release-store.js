'use strict';
// Local trusted-storage contract. Never accept a release root from an HTTP caller.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseStrictJSON } = require('./strict-json');
const { VERSION, STAGES, authorized } = require('./policy');
const ASSETS = Object.freeze(['final.png', 'product-truth.json', 'prompt.txt', 'qa-report.json', 'final-metadata.json']);
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const safeSku = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const safeRun = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
function check(ok) { if (!ok) throw Error('INVALID_RELEASE_BUNDLE'); }
function directory(dir, create = false) {
  check(typeof dir === 'string' && path.isAbsolute(dir) && path.normalize(dir) === dir);
  check(fs.constants.O_NOFOLLOW > 0 && fs.constants.O_DIRECTORY > 0);
  let current = path.parse(dir).root;
  const identities = [];
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      let created = false;
      try { fs.mkdirSync(current, { mode: 0o700 }); created = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (created) { syncDirectory(current); syncDirectory(path.dirname(current)); }
    }
    const s = fs.lstatSync(current);
    check(s.isDirectory() && !s.isSymbolicLink());
    // Writable shared ancestors need sticky-directory protection (e.g. /private/tmp).
    check((s.mode & 0o022) === 0 || (s.mode & 0o1000) !== 0);
    identities.push([current, s.dev, s.ino]);
  }
  return () => { for (const [p, dev, ino] of identities) { const s = fs.lstatSync(p); check(s.isDirectory() && !s.isSymbolicLink() && s.dev === dev && s.ino === ino); } };
}
function privateDirectory(dir) {
  const s = fs.lstatSync(dir);
  check(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o022) === 0);
  if (typeof process.getuid === 'function') check(s.uid === process.getuid());
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd); check(before.isFile() && before.nlink >= 1);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), entry = fs.lstatSync(file);
    check(entry.isFile() && entry.dev === after.dev && entry.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.length === after.size);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function writeFile(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o444);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function stateValid(p, hash, run) {
  check(p && p.run_id === run && p.publication_authorized === true && p.lifecycle === 'ACTIVE' && p.candidate_sha256 === hash && Number.isInteger(p.candidate_generation) && p.candidate_generation > 0);
  for (const k of ['runtime_version', 'core_visual_rules', 'earring_standard']) check(p[k] === VERSION);
  for (const s of STAGES) check(p.stages?.[s]?.status === 'PASS' || (s === 'PRESENTATION_RECONSTRUCTION_AUTHORIZATION' && p.stages?.[s]?.status === 'NOT_REQUIRED'));
  for (const s of ['MACRO_IDENTITY_CHECK','FINISH_IDENTITY_CHECK','GATE_A','GATE_B']) check(p.stages[s].candidate_sha256 === hash && p.stages[s].generation === p.candidate_generation);
}
// Returns verified bytes, not a path to reopen later (avoids validation/use races).
// JSON is evidence in a trusted writer-owned root, NOT a portable signed capability.
function consumeRelease({ root, sku, runId }) {
  check(typeof root === 'string' && path.isAbsolute(root) && path.normalize(root) === root);
  check(safeSku(sku) && safeRun(runId));
  const dir = path.join(root, sku, runId), stable = directory(dir);
  for (const d of [root, path.join(root, sku), dir]) privateDirectory(d);
  const manifestBytes = readFile(path.join(dir, 'release.json'));
  const m = parseStrictJSON(manifestBytes);
  check(m.contract_version === 1 && m.asset_state === 'RELEASED' && m.sku === sku && m.run_id === runId && m.asset === 'final.png');
  check(m.assets && Object.keys(m.assets).sort().join('|') === [...ASSETS].sort().join('|'));
  stateValid(m.production, m.candidate_sha256, runId);
  const assets = {};
  for (const name of ASSETS) {
    const b = readFile(path.join(dir, name)), a = m.assets[name];
    check(a && a.file === name && /^[a-f0-9]{64}$/.test(a.sha256) && a.sha256 === digest(b) && a.bytes === b.length);
    assets[name] = b;
  }
  check(digest(assets['final.png']) === m.candidate_sha256);
  const qa = parseStrictJSON(assets['qa-report.json']), metadata = parseStrictJSON(assets['final-metadata.json']);
  check(qa.final_approval === true && qa.verdict?.value === 'approved' && metadata.final_approval === true && metadata.asset_state === 'RELEASED' && metadata.sku === sku && qa.gate_a?.status === 'PASS' && qa.gate_b?.status === 'PASS');
  for (const p of [qa.production, metadata.production]) stateValid(p, m.candidate_sha256, runId);
  stable(); check(readFile(path.join(dir, 'release.json')).equals(manifestBytes));
  return { manifest: m, bytes: assets['final.png'] };
}
function publishRelease({ root, sku, release, assets }) {
  check(typeof root === 'string' && path.isAbsolute(root) && path.normalize(root) === root);
  check(safeSku(sku) && safeRun(release?.run_id));
  check(Object.keys(assets).sort().join('|') === [...ASSETS].sort().join('|'));
  const bytes = Object.fromEntries(ASSETS.map(name => [name, Buffer.from(assets[name])]));
  check(authorized(release, bytes['final.png']));
  const runId = release.run_id, parent = path.join(root, sku), dir = path.join(parent, runId);
  const stable = directory(parent, true);
  for (const d of [root, parent]) privateDirectory(d);
  // Persist newly created root/sku entries before returning a successful release.
  for (const d of [path.dirname(root), root, parent]) syncDirectory(d);
  const stage = path.join(parent, `.staging-${crypto.randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  const stageStable = directory(stage);
  let reserved = false, destinationStable;
  // PRE_COMMIT_CRITICAL: all exceptions propagate after attempted rollback.
  try {
    for (const name of ASSETS) { stable(); stageStable(); writeFile(path.join(stage, name), bytes[name]); }
    const manifest = { contract_version: 1, asset_state: 'RELEASED', sku, run_id: runId, asset: 'final.png', candidate_sha256: digest(bytes['final.png']), production: release, assets: {} };
    for (const name of ASSETS) { const b = readFile(path.join(stage, name)); check(b.equals(bytes[name])); manifest.assets[name] = { file: name, sha256: digest(b), bytes: b.length }; }
    writeFile(path.join(stage, 'release.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    syncDirectory(stage); stable();
    // mkdir is the no-replace reservation. An existing run, even empty, is a conflict.
    fs.mkdirSync(dir, { mode: 0o700 });
    destinationStable = directory(dir); reserved = true;
    for (const name of ASSETS) { stable(); stageStable(); destinationStable(); fs.linkSync(path.join(stage, name), path.join(dir, name)); }
    syncDirectory(dir); syncDirectory(parent);
    for (const name of ASSETS) check(readFile(path.join(dir, name)).equals(bytes[name]));
    check(authorized(release, readFile(path.join(dir, 'final.png'))));
    stable(); stageStable(); destinationStable();
    // Only this atomic exclusive link makes the entire bundle a release.
    fs.linkSync(path.join(stage, 'release.json'), path.join(dir, 'release.json'));
    syncDirectory(dir); syncDirectory(parent);
    consumeRelease({ root, sku, runId });
  } catch (error) {
    const rollbackErrors = [];
    if (reserved) {
      try {
        stable(); destinationStable();
        try { fs.unlinkSync(path.join(dir, 'release.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        syncDirectory(dir);
      } catch (_) { rollbackErrors.push('MANIFEST_REVOCATION_FAILED'); }
    }
    try { stable(); stageStable(); fs.rmSync(stage, { recursive: true }); syncDirectory(parent); }
    catch (_) { rollbackErrors.push('STAGING_CLEANUP_FAILED'); }
    if (rollbackErrors.length) error.publication_cleanup_errors = rollbackErrors;
    const revocationFailed = rollbackErrors.includes('MANIFEST_REVOCATION_FAILED');
    error.publication_failure = {
      publication_status: 'FAILED', failure_category: 'RELEASE_PUBLICATION_FAILED',
      sku, run_id: runId, quarantine_required: revocationFailed,
      ...(revocationFailed ? { rollback_status: 'FAILED', code: 'MANIFEST_REVOCATION_FAILED' } : {}),
    };
    throw error;
  }
  // DURABLE COMMIT: assets and manifest are synced, final namespace synced,
  // and the persisted bundle validated. No authoritative work follows here.
  const result = { dir, manifestPath: path.join(dir, 'release.json'), housekeeping_status: 'COMPLETE', cleanup_pending: false, warnings: [] };
  // POST_COMMIT_HOUSEKEEPING: failures are debt, never a release failure.
  try { stable(); stageStable(); fs.rmSync(stage, { recursive: true }); }
  catch (_) { result.warnings.push('STAGING_CLEANUP_PENDING'); }
  try { stable(); syncDirectory(parent); }
  catch (_) { result.warnings.push('HOUSEKEEPING_SYNC_PENDING'); }
  if (result.warnings.length) { result.housekeeping_status = 'PENDING'; result.cleanup_pending = true; }
  return result;
}
module.exports = { ASSETS, consumeRelease, publishRelease };
