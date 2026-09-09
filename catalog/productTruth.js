// catalog/productTruth.js
// Stage 3 — OpenAI Vision analysis, produces 17-field Product Truth JSON.
// Analysis only, never redesign. Filename-derived fields injected pre-call and
// re-asserted post-call so Vision can never overwrite authoritative metadata.

const { runAnalysis, imageInput } = require('./openaiAnalysis');
const fs = require('fs');
const path = require('path');

const {
  CATEGORIES, METAL_TYPES, KARATS, ORIENTATIONS, PRODUCT_SCALES, FRAMINGS,
  BACKGROUND_CONDITIONS, GEMSTONE_TYPES, SETTING_TYPES,
  GEMSTONE_TYPE_MIN,
  GEMSTONE_COUNT_MIN,
  VISION_MIN_FOR_STRICT_FIELDS,
  MODELS,
  PRODUCT_TRUTH_KEY_ORDER,
} = require('./constants');

const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'product-truth-system.txt');
const CROPPED_REGIONS = ['left', 'right', 'top', 'bottom'];
const HALLMARK_REGIONS = ['inner_band', 'back', 'clasp', 'other'];
const CLEANUP_TYPES = ['dust', 'scratch', 'fingerprint', 'glue', 'thread', 'reflection_artifact'];
const SUPPORT_TYPES = ['hand', 'stand', 'display', 'prop', 'paper', 'other'];

async function runProductTruth({ imageBuffer, imageMediaType, sku, filenameMetadata, openaiKey }) {
  if (!openaiKey) throw new Error('runProductTruth: openaiKey is required');
  if (!Buffer.isBuffer(imageBuffer)) throw new Error('runProductTruth: imageBuffer must be a Buffer');

  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  const userText = buildUserMessage(filenameMetadata);

  const { json: visionJson, usage, model } = await runAnalysis({
    openaiKey, model: MODELS.productTruth, schemaName: 'product_truth', instructions: systemPrompt,
    content: [imageInput(imageBuffer, imageMediaType), { type: 'input_text', text: userText }],
  });
  const truth = assembleProductTruth({ sku, filenameMetadata, visionJson });
  return { truth, usage, model };
}

function buildUserMessage(fm) {
  const known = [];
  if (fm && fm.category   && fm.category.value)   known.push(`category = ${fm.category.value}`);
  if (fm && fm.metal_type && fm.metal_type.value) known.push(`metal_type = ${fm.metal_type.value}`);
  if (fm && fm.karat      && fm.karat.value)      known.push(`karat = ${fm.karat.value}`);
  const knownBlock = known.length
    ? `Authoritative filename metadata (must not be contradicted):\n- ${known.join('\n- ')}\n\n`
    : `No authoritative filename metadata provided.\n\n`;
  return knownBlock + `Analyze the image and return ONLY the JSON object described in the system prompt.`;
}

function assembleProductTruth({ sku, filenameMetadata, visionJson }) {
  // category is generally visible from shape — Vision may fill it with any confidence.
  const category   = mergeAuthoritative(filenameMetadata && filenameMetadata.category,   visionJson.category,   CATEGORIES, 0);
  // metal_type and karat are strict fields: Vision must reach CONFIDENCE_HIGH or field falls to null.
  const metal_type = mergeAuthoritative(filenameMetadata && filenameMetadata.metal_type, visionJson.metal_type, METAL_TYPES, VISION_MIN_FOR_STRICT_FIELDS);
  const karat      = mergeAuthoritative(filenameMetadata && filenameMetadata.karat,      visionJson.karat,      KARATS,      VISION_MIN_FOR_STRICT_FIELDS);

  const truth = {
    sku: sku || null,
    generated_at: new Date().toISOString(),
    sources: {
      category:   category.source,
      metal_type: metal_type.source,
      karat:      karat.source,
    },
    category,
    metal_type,
    metal_confidence: metal_type.confidence,
    karat,
    orientation:          coerceEnum(visionJson.orientation, ORIENTATIONS),
    product_scale:        coerceScale(visionJson.product_scale),
    framing:              coerceEnum(visionJson.framing, FRAMINGS),
    product_complete:     coerceComplete(visionJson.product_complete),
    visible_hallmarks:    coerceHallmarks(visionJson.visible_hallmarks),
    cleanup_regions:      coerceCleanupRegions(visionJson.cleanup_regions),
    support_objects:      coerceSupportObjects(visionJson.support_objects),
    chain_visible:        coerceBoolConf(visionJson.chain_visible),
    pendant_visible:      coerceBoolConf(visionJson.pendant_visible),
    background_condition: coerceEnum(visionJson.background_condition, BACKGROUND_CONDITIONS),
    gemstone_presence:    coerceGemstonePresence(visionJson.gemstone_presence),
    gemstone_type:        coerceGemstoneType(visionJson.gemstone_type),
    setting_type:         coerceEnum(visionJson.setting_type, SETTING_TYPES),
    overall_analysis_confidence: clamp01(numOr(visionJson.overall_analysis_confidence, 0)),
  };
  return canonicalize(truth);
}

// ----- coercers -----

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function numOr(x, d) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

// Filename value always wins if present and in allowlist. Vision may fill only when filename
// is unknown AND Vision's confidence meets the minimum gate. Below the gate, the field falls
// back to null / source='unknown' so the pipeline never acts on an estimate.
function mergeAuthoritative(fromFilename, fromVision, allowlist, minVisionConfidence) {
  if (fromFilename && fromFilename.value && allowlist.includes(fromFilename.value)) {
    return { value: fromFilename.value, confidence: 1.0, source: 'filename' };
  }
  if (fromVision && typeof fromVision === 'object' && allowlist.includes(fromVision.value)) {
    const conf = clamp01(fromVision.confidence);
    if (conf >= (minVisionConfidence || 0)) {
      return { value: fromVision.value, confidence: conf, source: 'vision' };
    }
  }
  return { value: null, confidence: 0, source: 'unknown' };
}

function coerceEnum(v, allowlist) {
  if (!v || typeof v !== 'object') return { value: null, confidence: 0 };
  return {
    value: allowlist.includes(v.value) ? v.value : null,
    confidence: clamp01(v.confidence),
  };
}

function coerceScale(v) {
  if (!v || typeof v !== 'object') return { value: null, occupies_frame_pct: 0, confidence: 0 };
  let pct = numOr(v.occupies_frame_pct, 0);
  if (pct > 0 && pct <= 1) pct = pct * 100; // tolerate 0-1 form
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  return {
    value: PRODUCT_SCALES.includes(v.value) ? v.value : null,
    occupies_frame_pct: pct,
    confidence: clamp01(v.confidence),
  };
}

function coerceComplete(v) {
  if (!v || typeof v !== 'object') return { value: true, cropped_regions: [], confidence: 0 };
  const regions = Array.isArray(v.cropped_regions)
    ? v.cropped_regions.filter(r => CROPPED_REGIONS.includes(r))
    : [];
  return { value: v.value === false ? false : true, cropped_regions: regions, confidence: clamp01(v.confidence) };
}

function coerceHallmarks(v) {
  if (!v || typeof v !== 'object') return { present: false, regions: [], confidence: 0 };
  const regions = Array.isArray(v.regions)
    ? v.regions.filter(r => HALLMARK_REGIONS.includes(r))
    : [];
  return { present: v.present === true, regions, confidence: clamp01(v.confidence) };
}

function coerceCleanupRegions(v) {
  if (!v || typeof v !== 'object') return { present: false, types: [], regions: [], confidence: 0 };
  const types = Array.isArray(v.types) ? v.types.filter(t => CLEANUP_TYPES.includes(t)) : [];
  const regions = Array.isArray(v.regions) ? v.regions.filter(r =>
    r && CLEANUP_TYPES.includes(r.type) && Array.isArray(r.bbox_pct) && r.bbox_pct.length === 4
      && r.bbox_pct.every(n => Number.isFinite(n))
  ) : [];
  return { present: v.present === true, types, regions, confidence: clamp01(v.confidence) };
}

function coerceSupportObjects(v) {
  if (!v || typeof v !== 'object') return { present: false, types: [] };
  const types = Array.isArray(v.types) ? v.types.filter(t => SUPPORT_TYPES.includes(t)) : [];
  return { present: v.present === true, types };
}

function coerceBoolConf(v) {
  if (!v || typeof v !== 'object') return { value: null, confidence: 0 };
  const val = v.value === true ? true : v.value === false ? false : null;
  return { value: val, confidence: clamp01(v.confidence) };
}

function coerceGemstonePresence(v) {
  if (!v || typeof v !== 'object') return { value: false, visible_count: null, count_confidence: 0 };
  const value = v.value === true;
  const conf = clamp01(v.count_confidence);
  // STRICT: only accept a numeric count when confidence is high enough. Below gate → null.
  let count = null;
  if (conf >= GEMSTONE_COUNT_MIN && Number.isInteger(v.visible_count) && v.visible_count >= 0) {
    count = v.visible_count;
  }
  return { value, visible_count: count, count_confidence: conf };
}

function coerceGemstoneType(v) {
  if (!v || typeof v !== 'object') return { value: 'unknown', confidence: 0 };
  const conf = clamp01(v.confidence);
  if (conf < GEMSTONE_TYPE_MIN) return { value: 'unknown', confidence: conf };
  return { value: GEMSTONE_TYPES.includes(v.value) ? v.value : 'unknown', confidence: conf };
}

// Reorder keys per PRODUCT_TRUTH_KEY_ORDER so JSON.stringify produces a deterministic byte sequence.
function canonicalize(truth) {
  const out = {};
  for (const k of PRODUCT_TRUTH_KEY_ORDER) {
    if (k in truth) out[k] = truth[k];
  }
  return out;
}

module.exports = { runProductTruth };
