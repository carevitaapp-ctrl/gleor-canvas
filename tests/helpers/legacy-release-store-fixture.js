// Only pre-v2 isolated regression suites use this in-memory storage boundary.
// It provides no enforcement evidence; release-store/HTTP suites use the real store.
const path = require('path');
module.exports = function legacyReleaseStore(fs) {
  const saved = new Map();
  return {
    publishRelease({root, sku, assets}) {
      const dir = path.join(root, sku, 'legacy-fixture');
      for (const [name, bytes] of Object.entries(assets)) fs.writeFileSync(path.join(dir, name), bytes);
      saved.set(sku, Buffer.from(assets['final.png']));
      return { dir, manifestPath: path.join(dir, 'release.json') };
    },
    consumeRelease({sku}) {
      if (!saved.has(sku)) throw Error('Legacy fixture has no published bytes');
      return {bytes:Buffer.from(saved.get(sku)),manifest:{fixture:true}};
    },
  };
};
