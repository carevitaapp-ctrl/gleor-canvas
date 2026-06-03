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
    const PADDING = 80;
    const MAX_DIM = CANVAS - PADDING * 2;

    const meta = await sharp(inputBuffer).metadata();

    const scale = Math.min(
      MAX_DIM / meta.width,
      MAX_DIM / meta.height
    );

    const newWidth = Math.round(meta.width * scale);
    const newHeight = Math.round(meta.height * scale);

    const left = Math.round((CANVAS - newWidth) / 2);
    const top = Math.round((CANVAS - newHeight) / 2);

    const output = await sharp(inputBuffer)
      .resize(newWidth, newHeight, {
        fit: 'contain'
      })
      .extend({
        top,
        bottom: CANVAS - newHeight - top,
        left,
        right: CANVAS - newWidth - left,
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
