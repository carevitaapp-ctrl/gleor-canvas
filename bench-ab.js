// A/B Benchmark — Hero-A vs Hero-B across categories.
// Reads sources from a manifest, runs both variants, saves outputs,
// builds side-by-side composites, runs Claude Vision QA on each,
// and generates a markdown comparison report.
//
// Usage:
//   PHOTOROOM_API_KEY=... ANTHROPIC_API_KEY=... node bench-ab.js <sources.json> <outdir>
//
// sources.json shape:
//   [{ "category": "ring", "metal_tone": "rose_gold", "karat": "18k",
//      "path": "/abs/path/to/source.jpg", "label": "rock_ring" }, ...]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const heroEngine = require('./heroEngine');
const { runQA } = require('./qa-runner');

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

async function makeSideBySide({ srcPath, aPath, bPath, outPath, label }) {
  const TILE = 800; // each tile 800×800 for the composite
  const PAD = 24;
  const LABEL_H = 60;
  // Load and resize each to TILE with white bg letterbox
  async function toTile(p) {
    return await sharp(p)
      .resize({ width: TILE, height: TILE, fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
  }
  const [srcTile, aTile, bTile] = await Promise.all([toTile(srcPath), toTile(aPath), toTile(bPath)]);
  const width = TILE * 3 + PAD * 4;
  const height = TILE + PAD * 2 + LABEL_H;
  const labelSvg = (text, x) => `<text x="${x}" y="${LABEL_H - 20}" font-family="sans-serif" font-size="24" fill="black">${text}</text>`;
  const labels = Buffer.from(
    `<svg width="${width}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${width}" height="${LABEL_H}" fill="white"/>` +
    labelSvg('Source', PAD + TILE / 2 - 40) +
    labelSvg('Hero-A (no lighting.mode)', 2 * PAD + TILE + TILE / 2 - 140) +
    labelSvg('Hero-B (ai.preserve-hue-and-saturation)', 3 * PAD + TILE * 2 + TILE / 2 - 220) +
    `</svg>`
  );
  const composite = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: labels, top: 0, left: 0 },
      { input: srcTile, top: LABEL_H + PAD, left: PAD },
      { input: aTile,   top: LABEL_H + PAD, left: 2 * PAD + TILE },
      { input: bTile,   top: LABEL_H + PAD, left: 3 * PAD + TILE * 2 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return outPath;
}

function scoreDelta(a, b, keys) {
  const out = {};
  for (const k of keys) {
    const av = a[k], bv = b[k];
    if (typeof av === 'number' && typeof bv === 'number') out[k] = +(bv - av).toFixed(2);
  }
  return out;
}

async function main() {
  const [, , sourcesJsonPath, outDir] = process.argv;
  if (!sourcesJsonPath || !outDir) {
    console.error('usage: node bench-ab.js <sources.json> <outdir>');
    process.exit(1);
  }
  const photoroomKey = process.env.PHOTOROOM_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!photoroomKey) { console.error('PHOTOROOM_API_KEY missing'); process.exit(2); }
  if (!anthropicKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(2); }

  const sources = JSON.parse(fs.readFileSync(sourcesJsonPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'hero-a'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'hero-b'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'side-by-side'), { recursive: true });

  const QA_KEYS = ['approved','overall_score','centering_score','scale_score','background_score','edge_quality_score','shadow_score','reflection_score','exposure_score','white_balance_score','metal_realism_score','metal_color_accuracy_score','gemstone_clarity_score','sharpness_score','product_completeness_score','geometry_preservation_score','artifact_score','brand_consistency_score'];

  const results = [];
  for (const src of sources) {
    const label = src.label || path.basename(src.path, path.extname(src.path));
    process.stderr.write(`[${label}] rendering A + B ... `);
    const raw = fs.readFileSync(src.path);
    const srcMd5 = md5(raw);
    let recA, recB;
    try {
      recA = await heroEngine.renderHero({
        rawImageBuffer: raw, category: src.category, metalTone: src.metal_tone,
        variant: 'A', apiKey: photoroomKey,
      });
      recB = await heroEngine.renderHero({
        rawImageBuffer: raw, category: src.category, metalTone: src.metal_tone,
        variant: 'B', apiKey: photoroomKey,
      });
    } catch (e) {
      process.stderr.write(`FAIL: ${e.message}\n`);
      results.push({ label, error: e.message });
      continue;
    }
    const aPath = path.join(outDir, 'hero-a', `${label}_A.png`);
    const bPath = path.join(outDir, 'hero-b', `${label}_B.png`);
    fs.writeFileSync(aPath, recA.output);
    fs.writeFileSync(bPath, recB.output);

    const sbsPath = path.join(outDir, 'side-by-side', `${label}_sbs.png`);
    await makeSideBySide({ srcPath: src.path, aPath, bPath, outPath: sbsPath, label });

    process.stderr.write('QA A ... ');
    const qaA = await runQA({
      heroPngBuffer: recA.output,
      meta: { filename: path.basename(src.path), category: src.category, metalTone: src.metal_tone, karat: src.karat },
      anthropicKey,
    });
    process.stderr.write('QA B ... ');
    const qaB = await runQA({
      heroPngBuffer: recB.output,
      meta: { filename: path.basename(src.path), category: src.category, metalTone: src.metal_tone, karat: src.karat },
      anthropicKey,
    });
    process.stderr.write(`overall A=${qaA.scores.overall_score} B=${qaB.scores.overall_score} Δ=${(qaB.scores.overall_score - qaA.scores.overall_score).toFixed(1)}\n`);

    results.push({
      label, category: src.category, metal_tone: src.metal_tone, karat: src.karat,
      source_md5: srcMd5,
      A: { output_md5: md5(recA.output), output_path: aPath, qa: qaA.scores, meta: recA.meta },
      B: { output_md5: md5(recB.output), output_path: bPath, qa: qaB.scores, meta: recB.meta },
      side_by_side: sbsPath,
      qa_delta: scoreDelta(qaA.scores, qaB.scores, QA_KEYS),
    });
  }

  // Persist raw results
  const resultsPath = path.join(outDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  // Markdown report
  const report = [];
  report.push(`# Hero-A vs Hero-B Benchmark Report`);
  report.push(``);
  report.push(`- Date: ${new Date().toISOString()}`);
  report.push(`- Categories tested: ${results.map(r => r.category || '?').join(', ')}`);
  report.push(`- Pipeline: hero-v7-preserve-only-2026-07-22`);
  report.push(`- A: no \`lighting.mode\`. B: \`lighting.mode=ai.preserve-hue-and-saturation\`. All other params identical.`);
  report.push(``);
  report.push(`## Per-product QA overall`);
  report.push(``);
  report.push(`| product | category | metal | A overall | B overall | Δ | A approved | B approved |`);
  report.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    if (r.error) { report.push(`| ${r.label} | — | — | — | — | ERROR: ${r.error} |  |  |`); continue; }
    const d = r.B.qa.overall_score - r.A.qa.overall_score;
    report.push(`| ${r.label} | ${r.category} | ${r.metal_tone} | ${r.A.qa.overall_score} | ${r.B.qa.overall_score} | ${d >= 0 ? '+' : ''}${d.toFixed(1)} | ${r.A.qa.approved} | ${r.B.qa.approved} |`);
  }
  report.push(``);
  report.push(`## Per-criterion averages (B − A)`);
  report.push(``);
  report.push(`| criterion | avg A | avg B | Δ |`);
  report.push(`|---|---|---|---|`);
  const okResults = results.filter(r => !r.error);
  if (okResults.length > 0) {
    for (const k of QA_KEYS.filter(k => k !== 'approved')) {
      const avgA = okResults.map(r => r.A.qa[k]).reduce((a,b)=>a+b,0) / okResults.length;
      const avgB = okResults.map(r => r.B.qa[k]).reduce((a,b)=>a+b,0) / okResults.length;
      const d = avgB - avgA;
      report.push(`| ${k} | ${avgA.toFixed(1)} | ${avgB.toFixed(1)} | ${d >= 0 ? '+' : ''}${d.toFixed(1)} |`);
    }
  }
  report.push(``);
  report.push(`## Metal / geometry drift check`);
  report.push(``);
  report.push(`Auto-flags any product where **any** of {metal_color_accuracy, metal_realism, geometry_preservation, gemstone_clarity} regresses in B (Δ ≤ −5):`);
  report.push(``);
  const flagged = okResults.filter(r =>
    (r.qa_delta.metal_color_accuracy_score ?? 0) <= -5 ||
    (r.qa_delta.metal_realism_score ?? 0) <= -5 ||
    (r.qa_delta.geometry_preservation_score ?? 0) <= -5 ||
    (r.qa_delta.gemstone_clarity_score ?? 0) <= -5);
  if (flagged.length === 0) {
    report.push(`No flags. Metal/geometry criteria did not regress ≥ 5 pts in any category.`);
  } else {
    report.push(`| product | metal_color_accuracy Δ | metal_realism Δ | geometry Δ | gemstone_clarity Δ |`);
    report.push(`|---|---|---|---|---|`);
    for (const r of flagged) {
      report.push(`| ${r.label} | ${r.qa_delta.metal_color_accuracy_score} | ${r.qa_delta.metal_realism_score} | ${r.qa_delta.geometry_preservation_score} | ${r.qa_delta.gemstone_clarity_score} |`);
    }
  }
  report.push(``);
  report.push(`## Files`);
  report.push(``);
  report.push(`- Hero-A outputs: \`${path.join(outDir, 'hero-a')}\``);
  report.push(`- Hero-B outputs: \`${path.join(outDir, 'hero-b')}\``);
  report.push(`- Side-by-side composites: \`${path.join(outDir, 'side-by-side')}\``);
  report.push(`- Raw results JSON: \`${resultsPath}\``);
  report.push(``);
  report.push(`## Adoption recommendation`);
  report.push(``);
  report.push(`This benchmark is diagnostic. **No adoption recommendation is made here.** Founder to review side-by-side composites and this report, then decide (A) adopt Hero-B, (B) reject Hero-B, or (C) run additional targeted benchmarks. Visual review overrides QA delta whenever they conflict.`);

  const reportPath = path.join(outDir, 'report.md');
  fs.writeFileSync(reportPath, report.join('\n'));

  console.log('\n=== Benchmark complete ===');
  console.log('report:  ', reportPath);
  console.log('results: ', resultsPath);
  console.log('sbs dir: ', path.join(outDir, 'side-by-side'));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
