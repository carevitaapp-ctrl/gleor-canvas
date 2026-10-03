'use strict';
const { runAnalysis, imageInput } = require('../catalog/openaiAnalysis');
const { MODELS } = require('../catalog/constants');
const { FIELDS } = require('./policy');
async function inspectSource(raw, media, openaiKey) {
  const r = await runAnalysis({ openaiKey, model: MODELS.productTruth, schemaName: 'production_source',
    instructions: 'Inspect ORIGINAL RAW only. Never infer hidden geometry, reconstruct, or invent facts. Return all listed identity fields. KNOWN requires visible evidence, NOT_VISIBLE means physically occluded/not applicable with an explicit reason, UNKNOWN means ambiguous. Numeric visible_stone_count must be an integer encoded as a decimal string. complete is null when uncertain. Confidence must describe actual visibility. Describe exact topology, counts, ratios and relationships, not aesthetic goals.',
    content: [imageInput(raw, media), { type: 'input_text', text: `Inspect fields: ${FIELDS.join(', ')}. This is source sufficiency, not permission to improve the product.` }] });
  return r.json;
}
async function compareCandidate(raw, media, candidate, lock, openaiKey) {
  const r = await runAnalysis({ openaiKey, model: MODELS.qa, schemaName: 'production_comparison',
    instructions: 'Compare candidate against ORIGINAL RAW and the immutable identity lock. Return exactly one result for every locked field. MATCH only when visibly identical in count/topology/proportions/relationships; zero structural change is permitted. NOT_VISIBLE fields must remain unasserted: invented newly visible features are MISMATCH. Unverifiable comparisons are UNKNOWN. Check finish hue, texture and reflectivity against RAW; lighting alone may change, finish identity may not. Never rewrite the lock.',
    content: [imageInput(raw, media), imageInput(candidate, 'image/png'), { type: 'input_text', text: JSON.stringify(lock) }] });
  return r.json;
}
module.exports = { inspectSource, compareCandidate };
