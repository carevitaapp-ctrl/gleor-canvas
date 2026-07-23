// QA runner — sends a Hero PNG to Claude Vision QA via Anthropic API.
// Uses temperature=0 and the same prompt structure as the deployed Prep QA Payload.
// Consumed by bench-ab.js.

const https = require('https');
const fs = require('fs');

function buildPrompt({ filename, category, metalTone, karat }) {
  const lines = [
    'You are Gleor catalog QA reviewer.',
    'The image below is the FINAL 1200x1200 Hero Product (already cutout, canvased, standardized).',
    'Your job: score whether this Hero has reached premium luxury jewelry catalog quality',
    '(comparable to Mejuri / PDPAOLA / Missoma).',
    '',
    'Declared filename metadata (source of truth for identity + metal):',
    `- filename: ${filename}`,
    `- category: ${category}`,
    `- metal_tone: ${metalTone}`,
    ...(karat ? [`- karat: ${karat}`] : []),
    '',
    'Score EACH criterion from 0 to 100. Anchors:',
    '  centering_score        : 100=bbox pixel-perfect center; 95=±1px; 85=visible offset.',
    '  scale_score            : 100=matches expected fill_ratio for category; 90=±5%.',
    '  background_score       : 100=pure #FFFFFF, no cast, no halo.',
    '  edge_quality_score     : 100=clean edges, no fringes/halos/pixel contamination.',
    '  shadow_score           : 100=soft natural believable studio shadow; 0=harsh or absent.',
    '  reflection_score       : 100=absent OR subtly natural; 0=invented floating reflection.',
    '  exposure_score         : 100=balanced highlights + shadows, no clipping.',
    '  white_balance_score    : 100=neutral studio white.',
    '  metal_realism_score    : 100=natural metal, no plastic/muddy look.',
    '  metal_color_accuracy_score: 100=displayed metal matches declared metal_tone.',
    '  gemstone_clarity_score : 100=facets legible + sparkle natural; if no stones, score 95.',
    '  sharpness_score        : 100=crisp; below 80=over-sharpened (visible halos) OR blurry.',
    '  product_completeness_score: 100=entire jewelry visible, ≥30px padding from every edge.',
    '  geometry_preservation_score: 100=natural jewelry shape, no warping/distortion.',
    '  artifact_score         : 100=no compression blocks/dust/edge contamination.',
    '  brand_consistency_score: 100=Mejuri/PDPAOLA/Missoma-tier editorial calm.',
    '',
    'Compute overall_score as the weighted mean across the 16 criteria (equal weights are acceptable).',
    '',
    'Approval rule — approved = true ONLY when ALL of:',
    '  overall_score >= 95',
    '  product_completeness_score >= 98',
    '  geometry_preservation_score >= 98',
    '  metal_color_accuracy_score >= 95',
    '  background_score >= 98',
    '  every individual score >= 90',
    '',
    'route_to:',
    '  "approved" — if approved',
    '  "controlled_retry" — if failure is deterministically fixable (over-sharp, WB drift, exposure)',
    '  "manual_review" — if identity conflict, metal conflict, cropped product, hallucinated details, or unclear',
    '',
    'CRITICAL failures (immediate manual_review, do not suggest retry):',
    '  jewelry design changed, geometry changed, gemstone count/placement changed,',
    '  metal color conflicts with declared metadata, product cropped, background not pure white,',
    '  shadow visibly artificial, product details lost, excessive sharpening/smoothing visible.',
    '',
    'rejection_reasons: array of short strings citing failed criteria (empty if approved).',
    'recommended_adjustments: array of specific fixable adjustments only (empty otherwise).',
    '',
    'Return ONLY the JSON object below. No markdown, no code fences, no prose.',
    '',
    '{',
    '  "approved": true,',
    '  "overall_score": 0,',
    '  "centering_score": 0,',
    '  "scale_score": 0,',
    '  "background_score": 0,',
    '  "edge_quality_score": 0,',
    '  "shadow_score": 0,',
    '  "reflection_score": 0,',
    '  "exposure_score": 0,',
    '  "white_balance_score": 0,',
    '  "metal_realism_score": 0,',
    '  "metal_color_accuracy_score": 0,',
    '  "gemstone_clarity_score": 0,',
    '  "sharpness_score": 0,',
    '  "product_completeness_score": 0,',
    '  "geometry_preservation_score": 0,',
    '  "artifact_score": 0,',
    '  "brand_consistency_score": 0,',
    '  "rejection_reasons": [],',
    '  "recommended_adjustments": [],',
    '  "route_to": "approved"',
    '}',
  ];
  return lines.join('\n');
}

async function runQA({ heroPngBuffer, meta, anthropicKey }) {
  const prompt = buildPrompt(meta);
  const bodyStr = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 900,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: heroPngBuffer.toString('base64') } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyStr),
      },
      timeout: 90000,
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString());
          if (raw.error) return reject(new Error('anthropic: ' + JSON.stringify(raw.error)));
          const text = raw.content?.[0]?.text || '';
          const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/gm, '').trim();
          resolve({ scores: JSON.parse(cleaned), usage: raw.usage, model: raw.model });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('anthropic timeout')));
    req.write(bodyStr); req.end();
  });
}

module.exports = { runQA, buildPrompt };
