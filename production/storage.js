'use strict';
// Server-only storage configuration. HTTP input never selects a root or mode.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
function fail() { throw Object.assign(Error('PRODUCTION_STORAGE_NOT_READY'), { code: 'PRODUCTION_STORAGE_NOT_READY', statusCode: 503 }); }
function check(ok) { if (!ok) fail(); }
// Callers validate canonical absolute paths before using this containment test.
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function createStorage(env = process.env) {
  // Render must never opt into a local fallback, even with a mistaken NODE_ENV.
  const render = Object.hasOwn(env, 'RENDER');
  const local = !render && ['development', 'test'].includes(env.NODE_ENV);
  const configured = Object.hasOwn(env, 'GLEOR_DATA_ROOT');
  const value = env.GLEOR_DATA_ROOT;
  let attempted = false, ready = false, roots, root, pins, mountIdentity;
  const expectedMount = env.GLEOR_DATA_MOUNT;
  const sync = dir => {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  function inspect(dir, create = false) {
    check(path.isAbsolute(dir) && path.normalize(dir) === dir);
    let current = path.parse(dir).root;
    const components = [current];
    for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      components.push(current);
    }
    const entries = [];
    // Include '/' itself so its directory identity is checked and pinned too.
    for (const current of components) {
      const inside = current === root || current.startsWith(root + path.sep);
      if (create && inside && current !== root) {
        try { fs.mkdirSync(current, { mode: 0o700 }); sync(path.dirname(current)); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      const s = fs.lstatSync(current);
      check(s.isDirectory() && !s.isSymbolicLink());
      check((s.mode & 0o022) === 0 || (!inside && current !== path.parse(dir).root && (s.mode & 0o1000) !== 0));
      if (inside) check(typeof process.getuid === 'function' && s.uid === process.getuid() && (s.mode & 0o700) === 0o700);
      entries.push([current, s.dev, s.ino]);
    }
    check(fs.realpathSync(dir) === dir);
    return entries;
  }
  function mounted() {
    if (local) return;
    check(process.platform === 'linux');
    check(typeof expectedMount === 'string' && expectedMount.trim() === expectedMount && !expectedMount.includes('\0'));
    check(path.isAbsolute(expectedMount) && path.normalize(expectedMount) === expectedMount);
    check(within(expectedMount, root));
    inspect(expectedMount);
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => {
      const fields = line.split(' '), separator = fields.indexOf('-');
      check(separator >= 6 && fields.length >= separator + 4);
      const mount = fields[4].replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
      return { mount, type: fields[separator + 1], identity: line };
    });
    const exact = mounts.filter(entry => entry.mount === expectedMount);
    // Filesystem type supplements exact mount identity; ancestors never qualify.
    check(exact.length === 1 && ['ext4', 'xfs', 'btrfs'].includes(exact[0].type));
    // Reject alternate mounts between the boundary and root, or anywhere under
    // the root (including future writer directories), even with a supported type.
    check(!mounts.some(({ mount }) => mount !== expectedMount && within(expectedMount, mount) &&
      (within(mount, root) || within(root, mount))));
    check(fs.statSync(expectedMount).dev === fs.statSync(root).dev);
    if (mountIdentity === undefined) mountIdentity = exact[0].identity;
    check(mountIdentity === exact[0].identity);
  }
  function stable() {
    mounted();
    for (const [p, dev, ino] of pins) {
      const entries = inspect(p);
      const s = fs.lstatSync(p);
      check(entries.length > 0 && s.dev === dev && s.ino === ino);
    }
    const dev = fs.statSync(root).dev;
    for (const p of Object.values(roots)) check(fs.statSync(p).dev === dev);
  }
  function probe() {
    const dir = path.join(roots.outputs, `.preflight-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    try {
      const src = path.join(dir, 'source'), dst = path.join(dir, 'linked');
      const fd = fs.openSync(src, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o444);
      try { fs.writeFileSync(fd, 'storage-preflight'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(src, dst);
      let collision = false;
      try { fs.linkSync(src, dst); } catch (e) { if (e.code !== 'EEXIST') throw e; collision = true; }
      check(collision && fs.statSync(src).ino === fs.statSync(dst).ino);
      const read = fs.openSync(dst, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { check(fs.fstatSync(read).isFile() && fs.readFileSync(read, 'utf8') === 'storage-preflight'); } finally { fs.closeSync(read); }
      sync(dir); sync(roots.outputs);
    } finally { fs.rmSync(dir, { recursive: true }); sync(roots.outputs); }
  }
  function initialize() {
    if (attempted) return status();
    attempted = true;
    try {
      check(fs.constants.O_NOFOLLOW > 0 && fs.constants.O_DIRECTORY > 0);
      if (configured) {
        check(typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0'));
        check(path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root);
        root = value;
      } else {
        check(local);
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gleor-local-data-')));
      }
      // Explicit roots must already exist. Provisioning belongs to deployment,
      // not application fallback; only trusted descendants are created here.
      inspect(root); mounted();
      roots = Object.freeze({ inputs: path.join(root, 'inputs'), outputs: path.join(root, 'outputs'), manual: path.join(root, 'renders', 'manual') });
      pins = inspect(root);
      for (const dir of Object.values(roots)) pins.push(...inspect(dir, true));
      stable(); probe(); stable(); ready = true;
    } catch (_) { ready = false; }
    return status();
  }
  function status() {
    if (ready) { try { stable(); } catch (_) { ready = false; } }
    return Object.freeze({ configured, ready });
  }
  function paths() {
    if (!attempted) initialize();
    check(status().ready); return roots;
  }
  function directory(base, ...parts) {
    paths();
    check(Object.values(roots).includes(base));
    check(parts.every(p => typeof p === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(p)));
    const dir = path.join(base, ...parts);
    check(dir.startsWith(base + path.sep));
    try { inspect(dir, true); check(fs.statSync(dir).dev === fs.statSync(root).dev); stable(); }
    catch (_) { ready = false; fail(); }
    return dir;
  }
  return Object.freeze({ initialize, status, paths, directory });
}
const storage = createStorage();
module.exports = { createStorage, ...storage };
