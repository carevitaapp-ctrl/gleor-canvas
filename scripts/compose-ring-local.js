// Offline only: node scripts/compose-ring-local.js RAW MASTER_CLEAN OUTPUT_DIR
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createHash } = require('crypto');
const { composeRingHero, verifyRingHero, FRAMING } = require('../catalog/geometryPreservingCompose');
const hash = b => createHash('sha256').update(b).digest('hex');
(async () => {
  const [rawPath, cleanPath, outputDir] = process.argv.slice(2);
  if (!rawPath || !cleanPath || !outputDir) throw Error('Usage: RAW MASTER_CLEAN OUTPUT_DIR');
  const raw = fs.readFileSync(rawPath), clean = fs.readFileSync(cleanPath);
  const result = await composeRingHero({ imageBuffer: clean });
  const verification = await verifyRingHero({ imageBuffer: clean, candidateBuffer: result.pngBuffer, diagnostics: result.diagnostics });
  if (!verification.pass) throw Error('Local composition verification failed');
  const repeat = await composeRingHero({ imageBuffer: clean });
  if (!repeat.pngBuffer.equals(result.pngBuffer)) throw Error('Non-deterministic output');
  const r = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const c = await sharp(clean).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const aligned = r.info.width === c.info.width && r.info.height === c.info.height;
  let opaque = 0, maxDiff = 0, sumDiff = 0;
  if (aligned) for (let i = 0; i < c.data.length; i += 4) if (c.data[i + 3] === 255) {
    opaque++;
    for (let k = 0; k < 3; k++) { const d = Math.abs(c.data[i + k] - r.data[i + k]); maxDiff = Math.max(maxDiff, d); sumDiff += d; }
  }
  fs.mkdirSync(outputDir, { recursive: true });
  for (const target of ['ring-hero.png', 'product-layer.png', 'local-diagnostics.json']) {
    if ([path.resolve(rawPath), path.resolve(cleanPath)].includes(path.resolve(outputDir, target))) throw Error('Output would overwrite source');
  }
  fs.writeFileSync(path.join(outputDir, 'ring-hero.png'), result.pngBuffer);
  fs.writeFileSync(path.join(outputDir, 'product-layer.png'), result.productLayer);
  const diagnostics = { framing: FRAMING, ...result.diagnostics, verification, repeat_identical: true,
    raw_sha256: hash(raw), source_file_unchanged: fs.readFileSync(cleanPath).equals(clean),
    raw_clean_comparison: { aligned, opaque_pixels: opaque, max_channel_difference: aligned ? maxDiff : null, mean_channel_difference: opaque ? sumDiff / (opaque * 3) : null },
    gate_a: 'NOT_RUN: local preservation is not a semantic structural approval', gate_b: 'NOT_RUN', provider_calls: 0 };
  fs.writeFileSync(path.join(outputDir, 'local-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  console.log(JSON.stringify(diagnostics, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
