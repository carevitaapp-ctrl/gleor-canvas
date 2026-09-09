// catalog/gptImageEdit.js
// Stage 5 — OpenAI gpt-image-2 images.edit.
// This is the ONLY visual renderer in the /catalog pipeline. No Sharp visual
// operations are applied to the output (no modulate, no sharpen, no shadow
// compositing) — GPT Image produces the final visual quality.

const { OpenAI, toFile } = require('openai');
const { MODELS, GPT_IMAGE_SIZE, GPT_IMAGE_QUALITY } = require('./constants');

async function runGptImageEdit({ imageBuffer, imageFilename, imageMediaType, prompt, openaiKey, maxRetries }) {
  if (!openaiKey) throw new Error('runGptImageEdit: openaiKey required');
  if (!Buffer.isBuffer(imageBuffer)) throw new Error('runGptImageEdit: imageBuffer must be a Buffer');
  if (!prompt || typeof prompt !== 'string') throw new Error('runGptImageEdit: prompt required');

  const client = new OpenAI({ apiKey: openaiKey, ...(maxRetries === 0 ? { maxRetries: 0 } : {}) });
  const inputName = imageFilename || 'input.jpg';
  const mediaType = imageMediaType || 'image/jpeg';
  const imageFile = await toFile(imageBuffer, inputName, { type: mediaType });

  const started = Date.now();
  const response = await client.images.edit({
    model: MODELS.gptImage,
    image: imageFile,
    prompt,
    size: GPT_IMAGE_SIZE,
    quality: GPT_IMAGE_QUALITY,
  });
  const durationMs = Date.now() - started;

  const b64 = response.data && response.data[0] && response.data[0].b64_json;
  if (!b64) {
    throw new Error(`runGptImageEdit: no b64_json in response (keys: ${Object.keys(response).join(', ')})`);
  }

  return {
    pngBuffer: Buffer.from(b64, 'base64'),
    model: MODELS.gptImage,
    size: GPT_IMAGE_SIZE,
    quality: GPT_IMAGE_QUALITY,
    durationMs,
    usage: response.usage || null,
  };
}

module.exports = { runGptImageEdit };
