// Native-pixel composition: canvas adapts to the product, never resample the SKU.
const sharp = require('sharp');
const { createHash } = require('crypto');
const hash = b => createHash('sha256').update(b).digest('hex');
const FRAMING = 'Native product pixels, no resampling/rotation/toning. Square white canvas; longest alpha bbox side fills 62.5% (within one canvas pixel), centered within 0.5 pixel. Contact shadow outside product alpha only.';
async function decode(buffer) {
  return sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function composeRingHero({ imageBuffer }) {
  const started = Date.now();
  const sourceHash = hash(imageBuffer);
  const { data, info } = await decode(imageBuffer);
  const { width, height } = info;
  let x0 = width, y0 = height, x1 = -1, y1 = -1, opaque = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = data[(y * width + x) * 4 + 3];
    if (a) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (a === 255) opaque++;
  }
  if (!opaque || x0 === 0 || y0 === 0 || x1 === width - 1 || y1 === height - 1) {
    throw new Error('Ring composer requires a complete, transparent product mask with opaque product pixels and clear margins');
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const size = Math.round(Math.max(w, h) / 0.625);
  if (size > 4096) throw new Error('Native ring canvas exceeds 4096 pixels; supply a smaller verified source');
  const left = Math.floor((size - w) / 2), top = Math.floor((size - h) / 2);
  const output = Buffer.alloc(size * size * 4, 255);
  const layer = Buffer.alloc(w * h * 4);
  const contacts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const src = ((y + y0) * width + x + x0) * 4;
    data.copy(layer, (y * w + x) * 4, src, src + 4);
    if (y >= h - Math.max(2, Math.round(h * .025)) && data[src + 3] >= 128) contacts.push({ x: left + x, y: top + y, a: data[src + 3] / 255 });
  }
  // Project only the actual lowest mask contact points onto the ground plane.
  const rx = Math.max(2, w * .045), ry = Math.max(1, h * .008);
  const contactShadow = Buffer.alloc(size * size);
  for (const point of contacts) {
    for (let y = Math.max(1, Math.floor(point.y - 3 * ry)); y <= Math.min(size - 2, Math.ceil(point.y + 3 * ry)); y++)
      for (let x = Math.max(1, Math.floor(point.x - 3 * rx)); x <= Math.min(size - 2, Math.ceil(point.x + 3 * rx)); x++) {
        const d = ((x - point.x) / rx) ** 2 + ((y - point.y) / ry) ** 2;
        if (d < 9) contactShadow[y * size + x] = Math.max(contactShadow[y * size + x], Math.round(24 * point.a * Math.exp(-d / 2)));
      }
  }
  let shadowPixels = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const lx = x - left, ly = y - top;
    const p = (y * size + x) * 4;
    const i = (ly * w + lx) * 4;
    const inProduct = lx >= 0 && lx < w && ly >= 0 && ly < h && layer[i + 3] > 0;
    if (inProduct) {
      const a = layer[i + 3];
      for (let c = 0; c < 3; c++) output[p + c] = Math.round((layer[i + c] * a + 255 * (255 - a)) / 255);
    } else {
      const shade = contactShadow[y * size + x];
      if (shade) { output[p] = output[p + 1] = output[p + 2] = 255 - shade; shadowPixels++; }
    }
  }
  const pngBuffer = await sharp(output, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const productLayer = await sharp(layer, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  if (hash(imageBuffer) !== sourceHash) throw new Error('Source mutation');
  return { pngBuffer, productLayer, model: 'deterministic-ring-composer-v1', size: `${size}x${size}`, quality: 'native-pixels', durationMs: Date.now() - started, usage: null,
    diagnostics: { source_sha256: sourceHash, product_rgba_sha256: hash(layer), output_sha256: hash(pngBuffer), source_bbox: { left: x0, top: y0, width: w, height: h }, placement: { left, top, scale: 1 }, canvas: size, fill_ratio: Math.max(w, h) / size, shadow_pixels: shadowPixels, background: '#FFFFFF', renderer_provider_calls: 0 } };
}
// Independent pixel-by-pixel verification, including partially transparent edges.
async function verifyRingHero({ imageBuffer, candidateBuffer, diagnostics }) {
  const source = await decode(imageBuffer), candidate = await decode(candidateBuffer);
  const b = diagnostics.source_bbox, p = diagnostics.placement, n = diagnostics.canvas;
  let mismatches = 0, productPixels = 0, alphaErrors = 0, backgroundErrors = 0;
  let totalSourcePixels = 0;
  for (let i = 3; i < source.data.length; i += 4) if (source.data[i]) totalSourcePixels++;
  const crop = await sharp(imageBuffer).ensureAlpha().extract(b).raw().toBuffer();
  const shadowTop = p.top + b.height - Math.max(2, Math.round(b.height * .025)) - 3 * Math.max(1, b.height * .008);
  const shadowBottom = p.top + b.height + 3 * Math.max(1, b.height * .008);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const j = (y * n + x) * 4;
    if (candidate.data[j + 3] !== 255) alphaErrors++;
    if ((x === 0 || y === 0 || x === n - 1 || y === n - 1) && candidate.data.subarray(j, j + 3).some(c => c !== 255)) backgroundErrors++;
    const sx = x - p.left + b.left, sy = y - p.top + b.top;
    if (sx < b.left || sx >= b.left + b.width || sy < b.top || sy >= b.top + b.height) {
      if ((y < shadowTop || y > shadowBottom) && candidate.data.subarray(j, j + 3).some(c => c !== 255)) backgroundErrors++;
      continue;
    }
    const i = (sy * source.info.width + sx) * 4, a = source.data[i + 3];
    if (!a) {
      if ((y < shadowTop || y > shadowBottom) && candidate.data.subarray(j, j + 3).some(c => c !== 255)) backgroundErrors++;
      continue;
    }
    productPixels++;
    for (let c = 0; c < 3; c++) if (candidate.data[j + c] !== Math.round((source.data[i + c] * a + 255 * (255 - a)) / 255)) mismatches++;
  }
  const checks = { source_hash: hash(imageBuffer) === diagnostics.source_sha256, canvas: candidate.info.width === n && candidate.info.height === n, native_scale: p.scale === 1, product_rgba_hash: hash(crop) === diagnostics.product_rgba_sha256,
    centering: Math.abs(p.left + b.width / 2 - n / 2) <= .5 && Math.abs(p.top + b.height / 2 - n / 2) <= .5,
    fill: Math.abs(Math.max(b.width, b.height) / n - .625) <= 1 / n, product_pixels: productPixels > 0 && productPixels === totalSourcePixels && mismatches === 0, alpha_integrity: alphaErrors === 0, white_background_outside_contact_region: backgroundErrors === 0 };
  return { pass: Object.values(checks).every(Boolean), checks, productPixels, mismatches, alphaErrors, backgroundErrors };
}
module.exports = { composeRingHero, verifyRingHero, FRAMING };
