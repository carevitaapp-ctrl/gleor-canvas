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
