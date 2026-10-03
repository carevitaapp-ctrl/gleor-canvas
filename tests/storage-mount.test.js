'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
function fixture(t, literalTopology = false) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gleor-mount-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const mount = path.join(base, 'data'), root = path.join(mount, 'gleor');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const line = (p, type = 'ext4', id = 36) => `${id} 25 8:1 / ${p.replace(/ /g, '\\040')} rw - ${type} /dev/test rw\n`;
  let info = line(mount);
  const diskFs = Object.create(fs), module = { exports: {} };
  // Remap only test filesystem operations so the literal Linux /var/data
  // topology can be tested on macOS without touching the host's /var tree.
  const logical = p => typeof p === 'string' && (p === '/var' || p.startsWith('/var/'));
  const mappedFs = literalTopology ? new Proxy(diskFs, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (...args) => {
      const result = value.apply(target, args.map(p => logical(p) ? base + p.slice(4) : p));
      return key === 'realpathSync' && typeof result === 'string' && result.startsWith(base) ? '/var' + result.slice(base.length) : result;
    };
  } }) : diskFs;
  diskFs.readFileSync = (p, ...args) => p === '/proc/self/mountinfo' ? info : fs.readFileSync(p, ...args);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../production/storage.js'), 'utf8'), {
    module, process: { env: {}, platform: 'linux', getuid: () => process.getuid() },
    require: name => name === 'fs' ? mappedFs : require(name),
  });
  const configuredMount = literalTopology ? '/var/data' : mount, configuredRoot = literalTopology ? '/var/data/gleor' : root;
  if (literalTopology) info = line(configuredMount);
  return { base, mount, root, line, set: value => { info = value; },
    storage: (env = {}) => module.exports.createStorage({ NODE_ENV: 'production', GLEOR_DATA_MOUNT: configuredMount, GLEOR_DATA_ROOT: configuredRoot, ...env }) };
}
test('exact mount supports application child topology and real write preflight', t => {
  const f = fixture(t), s = f.storage({RENDER:'true'});
  assert.equal(s.initialize().ready, true);
  assert.equal(s.paths().outputs, path.join(f.root, 'outputs'));
  assert.deepEqual(fs.readdirSync(s.paths().outputs), []);
});
test('ephemeral supported ancestor cannot substitute for exact mount', t => {
  const f = fixture(t); f.set(f.line(f.base));
  assert.equal(f.storage().initialize().ready, false);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
for (const scenario of ['unrelated','missing','relative','outside','unsupported','nested-root','nested-child','nested-supported','intervening','duplicate','noncanonical','absent']) {
  test(`mount boundary rejects ${scenario}`, t => {
    const f = fixture(t), env = {};
    if (scenario === 'unrelated') f.set(f.line('/other'));
    if (scenario === 'missing') env.GLEOR_DATA_MOUNT = undefined;
    if (scenario === 'relative') env.GLEOR_DATA_MOUNT = 'data';
    if (scenario === 'outside') env.GLEOR_DATA_ROOT = f.base;
    if (scenario === 'unsupported') f.set(f.line(f.mount, 'tmpfs'));
    if (scenario === 'nested-root') f.set(f.line(f.mount) + f.line(f.root, 'tmpfs', 37));
    if (scenario === 'nested-child') f.set(f.line(f.mount) + f.line(path.join(f.root, 'outputs'), 'tmpfs', 37));
    if (scenario === 'nested-supported') f.set(f.line(f.mount) + f.line(f.root, 'ext4', 37));
    if (scenario === 'intervening') { const child = path.join(f.root,'app'); fs.mkdirSync(child); env.GLEOR_DATA_ROOT = child; f.set(f.line(f.mount) + f.line(f.root, 'tmpfs', 37)); }
    if (scenario === 'duplicate') f.set(f.line(f.mount) + f.line(f.mount, 'ext4', 37));
    if (scenario === 'noncanonical') env.GLEOR_DATA_MOUNT = f.mount + '/.';
    if (scenario === 'absent') env.GLEOR_DATA_MOUNT = path.join(f.base, 'absent');
    assert.equal(f.storage(env).initialize().ready, false);
  });
}
test('root equal to mount allowed with trusted ownership and permissions', t => {
  const f = fixture(t); assert.equal(f.storage({ GLEOR_DATA_ROOT: f.mount }).initialize().ready, true);
});
for (const target of ['mount','root']) test(`symlink ${target} is rejected`, t => {
  const f = fixture(t), alias = path.join(f.mount,'alias'); fs.symlinkSync(f[target], alias);
  const env = target === 'mount' ? {GLEOR_DATA_MOUNT:alias, GLEOR_DATA_ROOT:path.join(alias,'gleor')} : {GLEOR_DATA_ROOT:alias};
  assert.equal(f.storage(env).initialize().ready, false);
});
for (const NODE_ENV of ['production','test','development',undefined]) test(`Render cannot bypass missing mount with NODE_ENV=${NODE_ENV}`, t => {
  const f = fixture(t); assert.equal(f.storage({RENDER:'true',NODE_ENV, GLEOR_DATA_MOUNT:undefined}).initialize().ready, false);
});
test('generic Linux production requires exact mount without Render marker', t => {
  const f = fixture(t); f.set(f.line(f.base));
  assert.equal(f.storage().initialize().ready, false);
});
for (const mutation of ['disappear','replace','nested']) test(`readiness latches false when mount ${mutation}`, t => {
  const f=fixture(t), s=f.storage(); assert.equal(s.initialize().ready,true);
  f.set(mutation === 'disappear' ? f.line(f.base) : mutation === 'replace' ? f.line(f.mount,'ext4',99) : f.line(f.mount)+f.line(path.join(f.root,'inputs'),'tmpfs',37));
  assert.equal(s.status().ready,false); f.set(f.line(f.mount)); assert.equal(s.status().ready,false);
});
test('local isolation never reads Linux mountinfo', t => {
  const f=fixture(t), original=fs.readFileSync;
  try { fs.readFileSync=(p,...args)=>{assert.notEqual(p,'/proc/self/mountinfo');return original(p,...args);};
    const {createStorage}=require('../production/storage');
    assert.equal(createStorage({NODE_ENV:'test',GLEOR_DATA_ROOT:f.root}).initialize().ready,true);
  } finally { fs.readFileSync=original; }
});

for (const actual of ['/var/data','/var']) test(`literal Render topology with actual mount ${actual}`, t => {
  const f=fixture(t,true); f.set(f.line(actual));
  const s=f.storage({RENDER:'true'}); assert.equal(s.initialize().ready,actual==='/var/data');
  if (actual==='/var/data') assert.equal(s.paths().outputs,'/var/data/gleor/outputs');
  else assert.deepEqual(fs.readdirSync(f.root),[]);
});
