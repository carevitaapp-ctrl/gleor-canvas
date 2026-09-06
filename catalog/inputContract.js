// Input Contract V2: ORIGINAL RAW alone is authoritative Product Truth.
// MASTER CLEAN is an immutable renderer input, never a structural authority.
// Breaking change: every /catalog caller (including n8n if used) must migrate
// before production activation. There is deliberately no single-image fallback.
const crypto = require('crypto');
const sharp = require('sharp');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40 * 1000 * 1000;
const FORMATS = {
  jpeg: { mediaType: 'image/jpeg', ext: '.jpg' },
  png: { mediaType: 'image/png', ext: '.png' },
  webp: { mediaType: 'image/webp', ext: '.webp' },
};

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(k => !Object.hasOwn(value, k))) {
    throw invalid(`${label}: expected exactly ${keys.join(', ')}`);
  }
}

function readCatalogRequest(req) {
  if (req.file) throw invalid('Input Contract V2 does not accept the single image field');
  exactKeys(req.files, ['original_raw', 'master_clean_png'], 'file fields');
  exactKeys(req.body, ['input_manifest'], 'text fields');
  const takeFile = name => {
    const files = req.files[name];
    if (!Array.isArray(files) || files.length !== 1 || files[0]?.fieldname !== name) {
      throw invalid(`Exactly one ${name} file is required`);
    }
    return { buffer: files[0].buffer, originalFilename: files[0].originalname };
  };
  if (typeof req.body.input_manifest !== 'string') throw invalid('input_manifest must be one JSON text field');
  let inputManifest;
  try { inputManifest = JSON.parse(req.body.input_manifest); }
  catch (_) { throw invalid('input_manifest must contain valid JSON'); }
  return {
    originalRaw: takeFile('original_raw'),
    masterClean: takeFile('master_clean_png'),
    inputManifest,
  };
}

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw invalid(`${label}: expected a SHA-256 hexadecimal digest`);
  }
  return value.toLowerCase();
}

function snapshot(file, label) {
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) throw invalid(`${label}: empty or missing file`);
  if (file.buffer.length > MAX_FILE_BYTES) throw invalid(`${label}: file exceeds 25 MiB`, 413);
  if (typeof file.originalFilename !== 'string' || !file.originalFilename.trim()) throw invalid(`${label}: missing filename`);
  // Own the exact received bytes before any asynchronous operation. Never expose
  // this canonical buffer to provider functions; the orchestrator passes copies.
  return { buffer: Buffer.from(file.buffer), originalFilename: file.originalFilename };
}

function rejectAnimatedPng(buffer) {
  if (!buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return;
  // Some decoders expose only the first APNG frame. Reject the animation control
  // chunk independently; decoding below still validates the image itself.
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) throw invalid('Truncated PNG chunk', 422);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') throw invalid('Animated images are not supported', 422);
    offset += length + 12;
    if (type === 'IEND') break;
  }
}

async function inspect(file, label, clean) {
  rejectAnimatedPng(file.buffer);
  try {
    const image = sharp(file.buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning' });
    const meta = await image.metadata();
    if (!Object.hasOwn(FORMATS, meta.format) || (clean && meta.format !== 'png')) {
      throw invalid(`${label}: ${clean ? 'PNG required' : 'only JPEG, PNG or WebP supported'}`, 422);
    }
    if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height)
      || meta.width < 1 || meta.height < 1 || meta.width * meta.height > MAX_INPUT_PIXELS) {
      throw invalid(`${label}: invalid dimensions or pixel limit exceeded`, 422);
    }
    if ((meta.pages || 1) !== 1) throw invalid(`${label}: multi-frame images are not supported`, 422);
    // Full decode detects damaged pixel data. This is validation only: no image
    // transform or encoding is applied, and decoded pixels are never persisted.
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    if (info.width !== meta.width || info.height !== meta.height
      || !Number.isInteger(info.channels) || info.channels < 1 || info.channels > 4
      || data.length !== info.width * info.height * info.channels) {
      throw invalid(`${label}: invalid decoded image`, 422);
    }
    if (clean) {
      if (!meta.hasAlpha || ![2, 4].includes(info.channels)) throw invalid('Master Clean must contain transparency', 422);
      let transparent = false, visible = false;
      for (let i = info.channels - 1; i < data.length; i += info.channels) {
        if (data[i] === 0) transparent = true;
        if (data[i] > 0) visible = true;
      }
      if (!transparent || !visible) throw invalid('Master Clean must have transparent background pixels and visible content', 422);
    }
    return { ...file, ...FORMATS[meta.format], width: meta.width, height: meta.height };
  } catch (err) {
    if (err.statusCode) throw err;
    throw invalid(`${label}: image cannot be decoded within the input limits`, 422);
  }
}

async function validateInputs({ originalRaw, masterClean, inputManifest } = {}) {
  exactKeys(inputManifest, ['contract_version', 'original_raw', 'master_clean_png'], 'input_manifest');
  if (inputManifest.contract_version !== 2) throw invalid('input_manifest.contract_version must be 2');
  exactKeys(inputManifest.original_raw, ['sha256'], 'original_raw manifest');
  exactKeys(inputManifest.master_clean_png, ['sha256', 'source_raw_sha256'], 'master_clean_png manifest');
  const expectedRaw = digest(inputManifest.original_raw.sha256, 'original_raw.sha256');
  const expectedClean = digest(inputManifest.master_clean_png.sha256, 'master_clean_png.sha256');
  const sourceRawSha256 = digest(inputManifest.master_clean_png.source_raw_sha256, 'source_raw_sha256');
  const raw = snapshot(originalRaw, 'ORIGINAL RAW');
  const clean = snapshot(masterClean, 'MASTER CLEAN PNG');
  const rawSha256 = hash(raw.buffer), cleanSha256 = hash(clean.buffer);
  if (rawSha256 !== expectedRaw || cleanSha256 !== expectedClean || sourceRawSha256 !== rawSha256) {
    throw invalid('Input hash or RAW provenance link mismatch', 422);
  }
  if (rawSha256 === cleanSha256) throw invalid('RAW and Master Clean must be distinct assets', 422);
  const rawImage = await inspect(raw, 'ORIGINAL RAW', false);
  const cleanImage = await inspect(clean, 'MASTER CLEAN PNG', true);
  return {
    originalRaw: Object.freeze({ ...rawImage, sha256: rawSha256 }),
    masterClean: Object.freeze({ ...cleanImage, sha256: cleanSha256, sourceRawSha256 }),
  };
}

module.exports = { readCatalogRequest, validateInputs };
