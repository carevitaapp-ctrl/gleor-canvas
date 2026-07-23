// Gleor Hero Engine — preserve-only production module (Phase 1, 2026-07-22).
// Two variants:
//   A: no lighting.mode  (no PhotoRoom relight; local Sharp finish only)
//   B: lighting.mode=ai.preserve-hue-and-saturation (PhotoRoom relight, hue-preserving mode)
// Everything else identical between A and B.
// See HERO_PRODUCT_STANDARD.md §11 and TASK-017 Phase 0 report for architecture.

const https = require('https');
const crypto = require('crypto');
const sharp = require('sharp');

const V2_HOST = 'image-api.photoroom.com';
const V2_PATH = '/v2/edit';
const V1_HOST = 'sdk.photoroom.com';
const V1_PATH = '/v1/segment';

// Category-specific padding derived from CATEGORY_CONFIG fillRatio in server.js.
// padding ≈ (1 - fillRatio) / 2 ; matches the current preserve-based spec.
const CATEGORY_PADDING = {
  ring:          '0.175',
  earring:       '0.125',
  necklace:      '0.05',
  bracelet:      '0.10',
  anklet:        '0.10',
  piercing:      '0.15',
  'jewelry set': '0.075',
};

// Per-metal Sharp local micro-adjust — bounded, uniform-channel, jewelry-safe.
const METAL_LOCAL = {
  yellow_gold: { brightness: 1.02, saturation: 1.04 },
  rose_gold:   { brightness: 1.02, saturation: 1.03 },
  white_gold:  { brightness: 1.01, saturation: 0.99 },
  silver:      { brightness: 1.01, saturation: 0.97 },
  platinum:    { brightness: 1.00, saturation: 0.97 },
  unknown:     { brightness: 1.01, saturation: 1.00 },
};

// Deterministic contact-shadow parameters (alpha-mask driven).
const CONTACT_SHADOW = {
  color:     { r: 0, g: 0, b: 0 },
  opacity:   0.16,        // final alpha multiplier
  sigma:     18,          // Gaussian blur sigma on master resolution
  yOffset:   14,          // vertical offset (master resolution)
};

// Master / final resolution.
const MASTER_SIZE = 2000;
const FINAL_SIZE = 1200;

// --- multipart helpers ---
function buildMultipart(fields, imageFile) {
  const boundary = '----gleor-hero-' + crypto.randomBytes(8).toString('hex');
  const nl = '\r\n';
  const parts = [
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="imageFile"; filename="in.jpg"${nl}Content-Type: image/jpeg${nl}${nl}`),
    imageFile,
  ];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(Buffer.from(nl + `--${boundary}${nl}Content-Disposition: form-data; name="${k}"${nl}${nl}${v}`));
  }
  parts.push(Buffer.from(nl + `--${boundary}--${nl}`));
  return { boundary, body: Buffer.concat(parts) };
}

function httpsPostBinary({ host, path, headers, body, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'POST', headers, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// --- STAGE B: Master Clean PNG (archival, parallel branch, v1/segment) ---
async function renderMasterCleanPng(rawImageBuffer, apiKey) {
  const { boundary, body } = buildMultipart({ format: 'png', channels: 'rgba', size: 'full' }, rawImageBuffer);
  // v1 uses field name image_file (not imageFile). Rebuild with that.
  const nl = '\r\n';
  const parts = [
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="image_file"; filename="in.jpg"${nl}Content-Type: image/jpeg${nl}${nl}`),
    rawImageBuffer,
    Buffer.from(nl + `--${boundary}${nl}Content-Disposition: form-data; name="format"${nl}${nl}png`),
    Buffer.from(nl + `--${boundary}${nl}Content-Disposition: form-data; name="channels"${nl}${nl}rgba`),
    Buffer.from(nl + `--${boundary}${nl}Content-Disposition: form-data; name="size"${nl}${nl}full`),
    Buffer.from(nl + `--${boundary}--${nl}`),
  ];
  const v1body = Buffer.concat(parts);
  const res = await httpsPostBinary({
    host: V1_HOST, path: V1_PATH,
    headers: {
      'x-api-key': apiKey,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': v1body.length,
      'Accept': 'image/png',
    },
    body: v1body,
  });
  if (res.status !== 200 || !res.headers['content-type']?.includes('image')) {
    throw new Error(`v1/segment failed HTTP ${res.status}: ${res.body.slice(0, 300).toString('utf8')}`);
  }
  return { output: res.body, providerVersion: res.headers['x-photoroom-model'] || null };
}

// --- STAGE C: Hero candidate from v2/edit ---
// variant: 'A' (no lighting.mode) or 'B' (lighting.mode=ai.preserve-hue-and-saturation)
async function renderHeroCandidate({ rawImageBuffer, category, variant, apiKey }) {
  const padding = CATEGORY_PADDING[category] || CATEGORY_PADDING.ring;
  const fields = {
    'removeBackground':      'true',
    'background.color':      'FFFFFF',
    'outputSize':            `${MASTER_SIZE}x${MASTER_SIZE}`,
    'padding':               padding,
    'scaling':               'fit',
    'horizontalAlignment':   'center',
    'verticalAlignment':     'center',
    'referenceBox':          'subjectBox',
    'colorSpace':            'sRGB',
    'export.format':         'png',
  };
  if (variant === 'B') {
    fields['lighting.mode'] = 'ai.preserve-hue-and-saturation';
  } else if (variant === 'C') {
    // Experimental generative candidate.
    // May alter product texture or geometry; never auto-approve.
    fields['beautify.mode'] = 'ai.auto';
  }
  // Deliberately excluded: shadow.mode, beautify.mode, editWithAI, virtualModel, flatLay, ghostMannequin, upscale, background.prompt
  const { boundary, body } = buildMultipart(fields, rawImageBuffer);
  const res = await httpsPostBinary({
    host: V2_HOST, path: V2_PATH,
    headers: {
      'x-api-key': apiKey,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      'Accept': 'image/png',
    },
    body,
  });
  if (res.status !== 200 || !res.headers['content-type']?.includes('image')) {
    throw new Error(`v2/edit failed HTTP ${res.status}: ${res.body.slice(0, 400).toString('utf8')}`);
  }
  return {
    output: res.body,
    providerHeaders: {
      'x-photoroom-model':          res.headers['x-photoroom-model'] || null,
      'x-photoroom-request-id':     res.headers['x-photoroom-request-id'] || res.headers['x-request-id'] || null,
    },
    requestFields: fields,
    variant,
  };
}

// --- STAGE D: Local Sharp finish (deterministic) ---
// Reconstruct alpha from near-white bg, draw alpha-mask contact shadow, metal-safe modulate,
// gentle sharpen, re-flatten, downsize.
async function applyLocalFinish({ candidateBuffer, metalTone }) {
  const profile = METAL_LOCAL[metalTone] || METAL_LOCAL.unknown;

  // TEMPORARY DIAGNOSTIC MODE:
  // Keep PhotoRoom output untouched; only resize to final catalog dimensions.
  if (process.env.HERO_RAW_TEST === '1') {
    return {
      output: await sharp(candidateBuffer)
        .resize({
          width: FINAL_SIZE,
          height: FINAL_SIZE,
          fit: 'fill',
          kernel: 'lanczos3'
        })
        .png({ compressionLevel: 9 })
        .toBuffer()
    };
  }

  // 1. Load candidate at master resolution, extract raw RGB
  const meta = await sharp(candidateBuffer).metadata();
  const W = meta.width, H = meta.height;
  const { data: rgb } = await sharp(candidateBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. Reconstruct alpha from near-white bg-snap threshold
  //    Near-white → alpha 0. Non-white → soft ramp based on channel deviation.
  const rgba = Buffer.alloc(W * H * 4);
  let mnX = W, mnY = H, mxX = -1, mxY = -1;
  const BG_SNAP = 4;   // maxDev below this → pure bg
  const EDGE_FULL = 16; // maxDev above this → fully opaque product
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i3 = (y * W + x) * 3;
      const i4 = (y * W + x) * 4;
      const r = rgb[i3], g = rgb[i3 + 1], b = rgb[i3 + 2];
      const maxDev = Math.max(255 - r, 255 - g, 255 - b);
      let alpha;
      let rr = r, gg = g, bb = b;
      if (maxDev < BG_SNAP) {
        alpha = 0; rr = 255; gg = 255; bb = 255;
      } else if (maxDev >= EDGE_FULL) {
        alpha = 255;
        if (x < mnX) mnX = x; if (x > mxX) mxX = x;
        if (y < mnY) mnY = y; if (y > mxY) mxY = y;
      } else {
        alpha = Math.round(((maxDev - BG_SNAP) / (EDGE_FULL - BG_SNAP)) * 255);
        if (alpha > 20) {
          if (x < mnX) mnX = x; if (x > mxX) mxX = x;
          if (y < mnY) mnY = y; if (y > mxY) mxY = y;
        }
      }
      rgba[i4] = rr; rgba[i4 + 1] = gg; rgba[i4 + 2] = bb; rgba[i4 + 3] = alpha;
    }
  }
  const productWithAlpha = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();

  // 3. Alpha-mask contact shadow (deterministic)
  const alphaOnly = await sharp(productWithAlpha).extractChannel('alpha').toBuffer();
  const solidBlack = await sharp({
    create: { width: W, height: H, channels: 3, background: CONTACT_SHADOW.color }
  }).joinChannel(alphaOnly).png().toBuffer();
  const blurred = await sharp(solidBlack).blur(CONTACT_SHADOW.sigma).ensureAlpha().toBuffer();
  const blurredRgb = await sharp(blurred).removeAlpha().toBuffer();
  const blurredAlpha = await sharp(blurred)
    .extractChannel('alpha')
    .linear(CONTACT_SHADOW.opacity, 0)
    .toBuffer();
  const shadowLayer = await sharp(blurredRgb).joinChannel(blurredAlpha).png().toBuffer();

  // 4. Compose: white bg → shadow (y-offset for contact effect) → product
  const composed = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .composite([
      { input: shadowLayer, left: 0, top: CONTACT_SHADOW.yOffset },
      { input: productWithAlpha, left: 0, top: 0 },
    ])
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  // 5. Metal-safe uniform micro-adjust (bounded)
  const modulated = await sharp(composed)
    .modulate({ brightness: profile.brightness, saturation: profile.saturation })
    .png()
    .toBuffer();

  // 6. Very light highlight-biased sharpen
  const sharpened = await sharp(modulated)
    .sharpen({ sigma: 0.5, m1: 0.7, m2: 0.35 })
    .png()
    .toBuffer();

  // 7. Downsize master → final catalog (1200×1200) with lanczos3
  const final = await sharp(sharpened)
    .resize({ width: FINAL_SIZE, height: FINAL_SIZE, kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    output: final,
    bbox: (mxX < 0 || mxY < 0) ? null : { minX: mnX, minY: mnY, maxX: mxX, maxY: mxY },
    metalProfile: profile,
  };
}

// --- Orchestrator: raw → Hero (variant A or B) ---
async function renderHero({ rawImageBuffer, category, metalTone, variant, apiKey }) {
  if (!['A', 'B', 'C'].includes(variant)) throw new Error(`variant must be 'A' or 'B', got ${variant}`);
  if (!apiKey) throw new Error('apiKey required (PhotoRoom v2)');
  const cat = (category || 'ring').toLowerCase().trim();
  const metal = (metalTone || 'unknown').toLowerCase().trim();

  const stageC = await renderHeroCandidate({ rawImageBuffer, category: cat, variant, apiKey });
  const stageD = await applyLocalFinish({ candidateBuffer: stageC.output, metalTone: metal });

  // Metadata for downstream logging / snapshotting.
  const inputMd5 = crypto.createHash('md5').update(rawImageBuffer).digest('hex');
  const outputMd5 = crypto.createHash('md5').update(stageD.output).digest('hex');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(stageC.requestFields)).digest('hex');

  return {
    output: stageD.output,
    meta: {
      variant,
      category: cat,
      metalTone: metal,
      input_md5: inputMd5,
      output_md5: outputMd5,
      photoroom_endpoint: 'v2/edit',
      photoroom_request_hash: requestHash,
      photoroom_headers: stageC.providerHeaders,
      request_fields: stageC.requestFields,
      metal_local_profile: stageD.metalProfile,
      final_bbox: stageD.bbox,
      final_dims: { width: FINAL_SIZE, height: FINAL_SIZE },
      pipeline_version: 'hero-v7-preserve-only-2026-07-22',
    },
  };
}

module.exports = {
  renderHero,
  renderHeroCandidate,
  applyLocalFinish,
  renderMasterCleanPng,
  CATEGORY_PADDING,
  METAL_LOCAL,
  CONTACT_SHADOW,
  MASTER_SIZE,
  FINAL_SIZE,
};
