// catalog/writer.js
// Input Contract V2: immutable inputs are stored before providers run.
// Stage 7 emits the result bundle, referencing these authoritative input bytes.
// Approved outputs land under outputs/<sku>/. Non-approved outputs land under
// renders/manual/<sku>/ with an extra manual-review-reasons.json file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUTPUTS_ROOT = path.join(__dirname, '..', 'outputs');
const MANUAL_ROOT  = path.join(__dirname, '..', 'renders', 'manual');
const INPUTS_ROOT  = path.join(__dirname, '..', 'inputs');

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function writeImmutable(file, bytes) {
  const temporary = path.join(path.dirname(file), `.input-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let fd, created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o444);
    created = true;
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      // Publish a complete file atomically, without replacing an existing path.
      fs.linkSync(temporary, file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(bytes)) {
        throw conflict('Immutable input record conflicts with existing content');
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.unlinkSync(temporary);
  }
}

function writeInputs({ originalRaw, masterClean }) {
  for (const asset of [originalRaw, masterClean]) {
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Buffer.isBuffer(asset.buffer) || sha256(asset.buffer) !== asset.sha256) {
      throw conflict('Input bytes no longer match their validated identity');
    }
  }
  if (!['.jpg', '.png', '.webp'].includes(originalRaw.ext)
    || masterClean.ext !== '.png' || masterClean.mediaType !== 'image/png'
    || masterClean.sourceRawSha256 !== originalRaw.sha256
    || masterClean.sha256 === originalRaw.sha256) {
    throw conflict('Invalid RAW / Master Clean input binding');
  }
  const dir = path.join(INPUTS_ROOT, originalRaw.sha256, masterClean.sha256);
  fs.mkdirSync(dir, { recursive: true });
  const rawPath = path.join(dir, `original-raw${originalRaw.ext}`);
  const cleanPath = path.join(dir, 'master-clean.png');
  const manifestPath = path.join(dir, 'input-manifest.json');
  const manifest = {
    contract_version: 2,
    product_truth_authority: 'ORIGINAL_RAW',
    original_raw: { sha256: originalRaw.sha256, media_type: originalRaw.mediaType },
    master_clean_png: {
      sha256: masterClean.sha256,
      media_type: 'image/png',
      source_raw_sha256: originalRaw.sha256,
      role: 'RENDERER_INPUT_ONLY',
      provenance: 'caller_declared_hash_link_not_visual_derivation_proof',
    },
  };
  writeImmutable(rawPath, originalRaw.buffer);
  writeImmutable(cleanPath, masterClean.buffer);
  // Publish the complete pair's manifest last; any conflict stops before providers.
  writeImmutable(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return {
    contract_version: 2,
    product_truth_authority: 'ORIGINAL_RAW',
    original_raw: { ...manifest.original_raw, path: rawPath },
    master_clean_png: { ...manifest.master_clean_png, path: cleanPath },
    manifest_path: manifestPath,
  };
}

function writeBundle({
  sku,
  verdict,
  inputAssets,
  productTruth,
  promptText,
  finalPng,
  qaReport,
  finalMetadata,
  manualReviewReasons,
}) {
  if (!sku) throw new Error('writeBundle: sku required');
  const root = verdict === 'approved' ? OUTPUTS_ROOT : MANUAL_ROOT;
  const dir = path.join(root, sku);
  fs.mkdirSync(dir, { recursive: true });

  const truthPath    = path.join(dir, 'product-truth.json');
  const promptPath   = path.join(dir, 'prompt.txt');
  const finalPath    = path.join(dir, 'final.png');
  const qaPath       = path.join(dir, 'qa-report.json');
  const metadataPath = path.join(dir, 'final-metadata.json');
  const reasonsPath  = path.join(dir, 'manual-review-reasons.json');

  fs.writeFileSync(truthPath,    JSON.stringify(productTruth,  null, 2) + '\n');
  fs.writeFileSync(promptPath,   promptText);
  fs.writeFileSync(finalPath,    finalPng);
  fs.writeFileSync(qaPath,       JSON.stringify(qaReport,      null, 2) + '\n');
  fs.writeFileSync(metadataPath, JSON.stringify(finalMetadata, null, 2) + '\n');

  const files = {
    original_raw: inputAssets.original_raw.path,
    master_clean_png: inputAssets.master_clean_png.path,
    input_manifest: inputAssets.manifest_path,
    render_candidate: finalPath,
    productTruth: truthPath,
    prompt: promptPath,
    final: finalPath,
    qaReport: qaPath,
    finalMetadata: metadataPath,
    manualReviewReasons: null,
  };

  if (verdict !== 'approved' && manualReviewReasons) {
    fs.writeFileSync(reasonsPath, JSON.stringify(manualReviewReasons, null, 2) + '\n');
    files.manualReviewReasons = reasonsPath;
  }

  return { dir, files };
}

function sha256(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return crypto.createHash('sha256').update(b).digest('hex');
}

module.exports = { writeInputs, writeBundle, sha256 };
