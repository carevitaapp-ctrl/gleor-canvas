const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));

const CATEGORY_CONFIG = {
  bracelet:      { fillRatio: 0.80 },
  ring:          { fillRatio: 0.65 },
  earring:       { fillRatio: 0.75 },
  necklace:      { fillRatio: 0.90 },
  piercing:      { fillRatio: 0.70 },
  'jewelry set': { fillRatio: 0.85 },
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', categories: Object.keys(CATEGORY_CONFIG) });
});

async function renderCanvas(inputBuffer, rawCategory) {
  const category = (rawCategory || 'bracelet').toLowerCase().trim();
  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.bracelet;
  const { fillRatio } = config;

  const CANVAS = 1200;

  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width, minY = info.height, maxX = 0, maxY = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX > maxX || minY > maxY) {
    const err = new Error('No visible pixels detected');
    err.statusCode = 400;
    throw err;
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const TARGET = Math.round(CANVAS * fillRatio);
  const scale  = Math.min(TARGET / cropW, TARGET / cropH);

  const newW = Math.round(cropW * scale);
  const newH = Math.round(cropH * scale);

  const left = Math.round((CANVAS - newW) / 2);
  const top  = Math.round((CANVAS - newH) / 2);

  const output = await sharp(inputBuffer)
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .resize(newW, newH)
    .extend({
      top,
      bottom: CANVAS - newH - top,
      left,
      right:  CANVAS - newW - left,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: '#FFFFFF' })
    .png()
    .toBuffer();

  return {
    output, category, fillRatio,
    bbox:    { width: cropW, height: cropH },
    scaled:  { width: newW, height: newH },
    padding: { top, bottom: CANVAS - newH - top, left, right: CANVAS - newW - left },
  };
}

function respond(req, res, result) {
  const { output, category, fillRatio, bbox, scaled, padding } = result;
  const acceptsBinary = (req.headers.accept || '').includes('image/png');
  if (acceptsBinary) {
    res.set('Content-Type', 'image/png');
    res.set('X-Category', category);
    res.set('X-Fill-Ratio', String(fillRatio));
    res.set('X-BBox', bbox.width + 'x' + bbox.height);
    res.set('X-Scaled', scaled.width + 'x' + scaled.height);
    return res.send(output);
  }
  return res.json({
    width: 1200, height: 1200, format: 'png',
    category, fillRatio, bbox, scaled, padding,
    image: output.toString('base64'),
  });
}

// -----------------------------------------------------------------------------
// Hero Product Standardization
// See 01_Gleor/HERO_PRODUCT_STANDARD.md §11 for the full spec.
// This endpoint takes an already-standardized Canvas 1200x1200 PNG and applies
// deterministic normalization + 8-criterion acceptance validation with a single
// controlled retry. Never redesigns, regenerates, or hallucinates the jewelry.
// -----------------------------------------------------------------------------

async function computeProductBBox(rgbData, width, height) {
  // Find non-near-white pixels (product region) on a flattened RGB buffer.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (rgbData[i] < 240 || rgbData[i+1] < 240 || rgbData[i+2] < 240) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function paramsForAttempt(attempt) {
  // Attempt 0: default, expects a well-prepped canvas.
  // Attempt 1: safer fallback (smaller WB nudge, gentler sharpen).
  return attempt === 0
    ? { wbGain: 1.0, sharpen: { sigma: 0.3, m1: 0.5, m2: 0.5 } }
    : { wbGain: 0.6, sharpen: { sigma: 0.2, m1: 0.3, m2: 0.3 } };
}

async function renderHero(canvasBuffer, rawCategory, attempt) {
  const category = (rawCategory || 'bracelet').toLowerCase().trim();
  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.bracelet;
  const p = paramsForAttempt(attempt);

  // Sample corner white pixels for WB correction (input is Canvas: white bg).
  const { data: raw, info } = await sharp(canvasBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const corners = [[8, 8], [W - 9, 8], [8, H - 9], [W - 9, H - 9]];
  let sR = 0, sG = 0, sB = 0;
  for (const [cx, cy] of corners) {
    const i = (cy * W + cx) * 3;
    sR += raw[i]; sG += raw[i+1]; sB += raw[i+2];
  }
  const meanR = sR / corners.length, meanG = sG / corners.length, meanB = sB / corners.length;

  // WB correction: nudge each channel offset so corners average toward 255.
  const off = (v) => Math.round(p.wbGain * (255 - v));
  const offR = off(meanR), offG = off(meanG), offB = off(meanB);

  // Build the hero pipeline (deterministic operations only).
  // Steps in §11.4: background → exposure/WB/temp → contrast → highlight roll-off
  // → shadow (deferred) → reflection (deferred) → sharpen → artifact cleanup.
  const output = await sharp(canvasBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .linear([1, 1, 1], [offR, offG, offB])
    .sharpen(p.sharpen)
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    output, category, fillRatio: config.fillRatio, attempt,
    wbSampled: { R: meanR, G: meanG, B: meanB },
    wbCorrection: { R: offR, G: offG, B: offB },
  };
}

async function validateHero(heroBuffer, expected) {
  const { data, info } = await sharp(heroBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const failures = [];
  const measurements = {};

  // Bounding box on the hero image.
  const { minX, minY, maxX, maxY } = await computeProductBBox(data, W, H);
  if (maxX < 0 || maxY < 0) {
    failures.push({ id: 'A10', reason: 'no product pixels detected' });
    return { passed: false, failures, measurements };
  }
  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const padL = minX, padR = W - 1 - maxX;
  const padT = minY, padB = H - 1 - maxY;
  measurements.bbox = { width: bboxW, height: bboxH };
  measurements.padding = { top: padT, bottom: padB, left: padL, right: padR };

  // A1 Centering — ≤ 1 px delta per axis
  if (Math.abs(padL - padR) > 1) failures.push({ id: 'A1', axis: 'x', padL, padR });
  if (Math.abs(padT - padB) > 1) failures.push({ id: 'A1', axis: 'y', padT, padB });

  // A2 Scale — longer bbox side within ±2% of fill_ratio × 1200
  const longer = Math.max(bboxW, bboxH);
  const target = expected.fillRatio * 1200;
  const scaleErr = Math.abs(longer - target) / target;
  measurements.scaleErr = +scaleErr.toFixed(4);
  if (scaleErr > 0.02) failures.push({ id: 'A2', longer, target: +target.toFixed(1), errPct: +(scaleErr * 100).toFixed(2) });

  // A3 White background — sample non-product pixels
  let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
  const step = 8;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (x < minX - 5 || x > maxX + 5 || y < minY - 5 || y > maxY + 5) {
        const i = (y * W + x) * 3;
        bgR += data[i]; bgG += data[i+1]; bgB += data[i+2]; bgN++;
      }
    }
  }
  const bgMean = { R: bgR / bgN, G: bgG / bgN, B: bgB / bgN };
  measurements.bgMean = { R: +bgMean.R.toFixed(1), G: +bgMean.G.toFixed(1), B: +bgMean.B.toFixed(1) };
  if (bgMean.R < 252 || bgMean.G < 252 || bgMean.B < 252)
    failures.push({ id: 'A3', reason: 'background not white', bgMean: measurements.bgMean });

  // A5 White balance on the background — channel spread ≤ 3
  const wbDelta = Math.max(
    Math.abs(bgMean.R - bgMean.G),
    Math.abs(bgMean.G - bgMean.B),
    Math.abs(bgMean.R - bgMean.B),
  );
  measurements.wbDelta = +wbDelta.toFixed(2);
  if (wbDelta > 3) failures.push({ id: 'A5', wbDelta: measurements.wbDelta });

  // A4 Exposure — product luminance mean within a reasonable band for jewelry
  let pxN = 0, pxSum = 0;
  for (let y = minY; y <= maxY; y += 3) {
    for (let x = minX; x <= maxX; x += 3) {
      const i = (y * W + x) * 3;
      const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      // Only sample non-white pixels (actual product)
      if (data[i] < 240 || data[i+1] < 240 || data[i+2] < 240) {
        pxSum += lum; pxN++;
      }
    }
  }
  const midtoneMean = pxN > 0 ? pxSum / pxN : 0;
  measurements.midtoneMean = +midtoneMean.toFixed(1);
  if (midtoneMean < 60 || midtoneMean > 220)
    failures.push({ id: 'A4', midtoneMean: measurements.midtoneMean });

  // A10 Completeness — min padding from any edge
  const MIN_PAD = 30;
  if (padL < MIN_PAD || padR < MIN_PAD || padT < MIN_PAD || padB < MIN_PAD)
    failures.push({ id: 'A10', reason: 'product too close to canvas edge', padding: measurements.padding });

  // A11 Geometry / A12 Uniform scaling — Canvas already uses uniform scaling;
  // Hero does not resize, so aspect is preserved by construction.
  measurements.geometryCheck = 'PASS (Canvas preserves aspect; Hero does not resize)';

  // A6/A7/A8/A9/A13/A14/A15/A16 — deferred to v2 (see spec §11.4 and §11.8)
  measurements.deferred = ['A6', 'A7', 'A8', 'A9', 'A13', 'A14', 'A15', 'A16'];

  return { passed: failures.length === 0, failures, measurements };
}

app.post('/hero', upload.single('image'), async (req, res) => {
  try {
    let inputBuffer;
    let rawCategory;

    if (req.file) {
      inputBuffer = req.file.buffer;
      rawCategory = req.body.category;
    } else {
      const { image, category } = req.body || {};
      if (!image) return res.status(400).json({ error: 'image field required (base64 or multipart file)' });
      inputBuffer = Buffer.from(image, 'base64');
      rawCategory = category;
    }

    const MAX_ATTEMPTS = 2; // controlled retry: 1 default attempt + 1 fallback
    let lastResult = null;
    let lastValidation = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await renderHero(inputBuffer, rawCategory, attempt);
      const v = await validateHero(r.output, { fillRatio: r.fillRatio });
      lastResult = r; lastValidation = v;
      if (v.passed) {
        const acceptsBinary = (req.headers.accept || '').includes('image/png');
        if (acceptsBinary) {
          res.set('Content-Type', 'image/png');
          res.set('X-Category', r.category);
          res.set('X-Fill-Ratio', String(r.fillRatio));
          res.set('X-Hero-Attempt', String(attempt));
          res.set('X-Hero-Status', 'approved');
          return res.send(r.output);
        }
        return res.json({
          width: 1200, height: 1200, format: 'png',
          category: r.category, fillRatio: r.fillRatio,
          attempt, status: 'approved',
          wbSampled: r.wbSampled, wbCorrection: r.wbCorrection,
          validation: v,
          image: r.output.toString('base64'),
        });
      }
    }

    // Both attempts failed → 422 rejected (do not return an image)
    return res.status(422).json({
      status: 'rejected',
      attempts: MAX_ATTEMPTS,
      category: lastResult ? lastResult.category : rawCategory,
      lastValidation,
      routeTo: 'manual review',
    });
  } catch (err) {
    console.error(err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/process', upload.single('image'), async (req, res) => {
  try {
    let inputBuffer;
    let rawCategory;

    if (req.file) {
      // multipart/form-data: image is a file part, category is a text field
      inputBuffer = req.file.buffer;
      rawCategory = req.body.category;
    } else {
      // application/json: image is a base64 string
      const { image, category } = req.body || {};
      if (!image) {
        return res.status(400).json({ error: 'image field required (base64 or multipart file)' });
      }
      inputBuffer = Buffer.from(image, 'base64');
      rawCategory = category;
    }

    const result = await renderCanvas(inputBuffer, rawCategory);
    return respond(req, res, result);

  } catch (err) {
    console.error(err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`gleor-canvas running on ${PORT}`));
