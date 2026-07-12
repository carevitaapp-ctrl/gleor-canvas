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
  // v2 calibration (TASK-012): tuned for Mejuri/PDPAOLA/Missoma-class output.
  // Attempt 0: default premium-catalog look. Attempt 1: safer fallback for edge cases.
  return attempt === 0
    ? {
        wbGain: 0.7,           // corner-WB correction, softened to protect metal hue
        brightness: 1.02,      // gentle exposure lift
        saturation: 1.05,      // mild warmth boost for metals (never > 1.08)
        sharpen: { sigma: 0.5, m1: 0.9, m2: 0.4 },  // more on highlights than shadows
        bgSnapDev: 5,          // pixel maxDev below this → snap to (255,255,255)
        maskEdgeStart: 5,      // maxDev where alpha ramp starts
        maskEdgeFull: 20,      // maxDev where alpha = 255
        shadowOpacity: 0.18,
        shadowBlur: 14,
      }
    : {
        wbGain: 0.5,
        brightness: 1.01,
        saturation: 1.03,
        sharpen: { sigma: 0.35, m1: 0.6, m2: 0.3 },
        bgSnapDev: 3,
        maskEdgeStart: 3,
        maskEdgeFull: 15,
        shadowOpacity: 0.12,
        shadowBlur: 20,
      };
}

async function renderHero(canvasBuffer, rawCategory, attempt) {
  const category = (rawCategory || 'bracelet').toLowerCase().trim();
  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.bracelet;
  const p = paramsForAttempt(attempt);

  // 1. Baseline flatten + corner-WB sample.
  const { data: raw0, info } = await sharp(canvasBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const corners = [[8, 8], [W - 9, 8], [8, H - 9], [W - 9, H - 9]];
  let sR = 0, sG = 0, sB = 0;
  for (const [cx, cy] of corners) {
    const i = (cy * W + cx) * 3;
    sR += raw0[i]; sG += raw0[i+1]; sB += raw0[i+2];
  }
  const meanR = sR / corners.length, meanG = sG / corners.length, meanB = sB / corners.length;
  const off = (v) => Math.round(p.wbGain * (255 - v));
  const offR = off(meanR), offG = off(meanG), offB = off(meanB);

  // 2. Apply WB + modulate + sharpen globally.
  const enh = await sharp(canvasBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .linear([1, 1, 1], [offR, offG, offB])
    .modulate({ brightness: p.brightness, saturation: p.saturation })
    .sharpen(p.sharpen)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const eData = enh.data;

  // 3. Build RGBA with pure-white bg snap and soft product mask.
  //    Also compute product bbox for shadow placement.
  const rgba = Buffer.alloc(W * H * 4);
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i3 = (y * W + x) * 3;
      const i4 = (y * W + x) * 4;
      let r = eData[i3], g = eData[i3+1], b = eData[i3+2];
      const maxDev = Math.max(255 - r, 255 - g, 255 - b);
      let a;
      if (maxDev < p.bgSnapDev) {
        // Definite background — force pure white, transparent for compositing.
        r = 255; g = 255; b = 255; a = 0;
      } else if (maxDev < p.maskEdgeFull) {
        // Ambiguous edge — soft ramp preserves metallic highlights.
        a = Math.round((maxDev - p.maskEdgeStart) / (p.maskEdgeFull - p.maskEdgeStart) * 255);
        if (a < 0) a = 0; if (a > 255) a = 255;
        if (a > 15) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      } else {
        // Definite product.
        a = 255;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      rgba[i4] = r; rgba[i4+1] = g; rgba[i4+2] = b; rgba[i4+3] = a;
    }
  }

  const productLayer = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer();

  // 4. Soft elliptical drop shadow beneath the product bbox.
  const bboxW = Math.max(1, maxX - minX + 1);
  const bboxH = Math.max(1, maxY - minY + 1);
  const shadowRx = Math.round(bboxW * 0.42);
  const shadowRy = Math.round(Math.max(bboxH * 0.06, 14));
  const shadowCx = Math.round((minX + maxX) / 2);
  const shadowCy = Math.min(H - 4, Math.round(maxY + shadowRy * 0.55));
  const shadowSvg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<ellipse cx="${shadowCx}" cy="${shadowCy}" rx="${shadowRx}" ry="${shadowRy}" ` +
    `fill="rgba(0,0,0,${p.shadowOpacity})" />` +
    `</svg>`
  );
  const shadowLayer = await sharp(shadowSvg).blur(p.shadowBlur).png().toBuffer();

  // 5. Composite: white base → shadow → product. Flatten to final RGB PNG.
  const output = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: shadowLayer, top: 0, left: 0 },
      { input: productLayer, top: 0, left: 0 },
    ])
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    output, category, fillRatio: config.fillRatio, attempt,
    wbSampled: { R: +meanR.toFixed(1), G: +meanG.toFixed(1), B: +meanB.toFixed(1) },
    wbCorrection: { R: offR, G: offG, B: offB },
    bbox: { width: bboxW, height: bboxH, minX, minY, maxX, maxY },
    shadow: { cx: shadowCx, cy: shadowCy, rx: shadowRx, ry: shadowRy, opacity: p.shadowOpacity },
  };
}

async function validateHero(heroBuffer, expected) {
  // expected: { fillRatio, productBbox? } — productBbox from renderHero preferred
  // so the shadow region doesn't get mistaken for the product on the final image.
  const { data, info } = await sharp(heroBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const failures = [];
  const measurements = {};

  let minX, minY, maxX, maxY;
  if (expected.productBbox) {
    ({ minX, minY, maxX, maxY } = expected.productBbox);
  } else {
    const bbox = await computeProductBBox(data, W, H);
    if (bbox.maxX < 0 || bbox.maxY < 0) {
      failures.push({ id: 'A10', reason: 'no product pixels detected' });
      return { passed: false, failures, measurements };
    }
    minX = bbox.minX; minY = bbox.minY; maxX = bbox.maxX; maxY = bbox.maxY;
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

  // A3 White background — sample non-product pixels, excluding the shadow
  // region (shadow sits below the product; margin below is larger than sides).
  let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
  const step = 8;
  const marginSides = 20, marginTop = 20, marginBottom = 50;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (x < minX - marginSides || x > maxX + marginSides ||
          y < minY - marginTop  || y > maxY + marginBottom) {
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
      const v = await validateHero(r.output, { fillRatio: r.fillRatio, productBbox: r.bbox });
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
