const express = require('express');
const sharp = require('sharp');

const app = express();

app.use(express.json({ limit: '20mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/process', async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({
        error: 'image field required (base64)'
      });
    }

    const inputBuffer = Buffer.from(image, 'base64');

    const CANVAS = 1200;

    const { data, info } = await sharp(inputBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Alpha bounding box hesapla
    let minX = info.width;
    let minY = info.height;
    let maxX = 0;
    let maxY = 0;

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

    // Tamamen boş görsel kontrolü
    if (minX > maxX || minY > maxY) {
      return res.status(400).json({
        error: 'No visible pixels detected'
      });
    }

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    // Ürün canvas'ın yaklaşık %80'ini kaplasın
    const TARGET = Math.round(CANVAS * 0.80);

    const scale = Math.min(
      TARGET / cropW,
      TARGET / cropH
    );

    const newW = Math.round(cropW * scale);
    const newH = Math.round(cropH * scale);

    const left = Math.round((CANVAS - newW) / 2);
    const top = Math.round((CANVAS - newH) / 2);

    const output = await sharp(inputBuffer)
      .extract({
        left: minX,
        top: minY,
        width: cropW,
        height: cropH
      })
      .resize(newW, newH)
      .extend({
        top,
        bottom: CANVAS - newH - top,
        left,
        right: CANVAS - newW - left,
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: 1
        }
      })
      .flatten({
        background: '#FFFFFF'
      })
      .png()
      .toBuffer();

    return res.json({
      width: 1200,
      height: 1200,
      format: 'png',
      bbox: {
        width: cropW,
        height: cropH
      },
      image: output.toString('base64')
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`gleor-canvas running on ${PORT}`);
});
