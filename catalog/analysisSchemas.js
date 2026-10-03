// Wire schemas enforce shape; existing coercers and QA floors remain authoritative.
const Ajv = require('ajv');
const C = require('./constants');
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', items });
const number = { type: 'number' };
const bool = { type: 'boolean' };
const string = { type: 'string' };
const confidence = number; // Do not move the existing clamp/strict-field gates into schema validation.
const enumField = values => object({ value: { type: ['string', 'null'], enum: [...values, null] }, confidence });
const strings = array(string);
const productTruth = object({
  category: enumField(C.CATEGORIES), metal_type: enumField(C.METAL_TYPES), karat: enumField(C.KARATS),
  orientation: enumField(C.ORIENTATIONS),
  product_scale: object({ value: { type: ['string', 'null'], enum: [...C.PRODUCT_SCALES, null] }, occupies_frame_pct: number, confidence }),
  framing: enumField(C.FRAMINGS),
  product_complete: object({ value: { type: ['boolean', 'null'] }, cropped_regions: strings, confidence }),
  visible_hallmarks: object({ present: bool, regions: strings, confidence }),
  cleanup_regions: object({ present: bool, types: strings, regions: array(object({ type: string, bbox_pct: array(number) })), confidence }),
  support_objects: object({ present: bool, types: strings }),
  chain_visible: object({ value: { type: ['boolean', 'null'] }, confidence }),
  pendant_visible: object({ value: { type: ['boolean', 'null'] }, confidence }),
  background_condition: enumField(C.BACKGROUND_CONDITIONS),
  gemstone_presence: object({ value: { type: ['boolean', 'null'] }, visible_count: { type: ['integer', 'null'] }, count_confidence: confidence }),
  gemstone_type: enumField(C.GEMSTONE_TYPES), setting_type: enumField(C.SETTING_TYPES),
  overall_analysis_confidence: confidence,
});
function gate(keys, isA) {
  return object({ criteria: object(Object.fromEntries(keys.map(k => [k, object({
    score: { type: ['integer', 'null'], minimum: 0, maximum: 100 }, applicable: bool, note: string,
    ...(isA ? { critical_deviation: bool } : {}),
  })]))), ...(isA ? { critical_failures: array(object({ criterion: string, reason: string })) } : {}) });
}
const productionConfidence = { type: 'number', minimum: 0, maximum: 1 };
const productionField = { type: 'string', enum: require('../production/policy').FIELDS };
const productionSource = object({
  category: { type: ['string', 'null'], enum: [...C.CATEGORIES, null] }, complete: { type: ['boolean', 'null'] }, confidence: productionConfidence,
  features: array(object({ name: productionField, status: { type: 'string', enum: ['KNOWN', 'UNKNOWN', 'NOT_VISIBLE'] }, value: { type: ['string', 'null'] }, evidence: string, confidence: productionConfidence })),
});
const productionComparison = object({ features: array(object({ name: productionField, result: { type: 'string', enum: ['MATCH', 'MISMATCH', 'UNKNOWN'] }, evidence: string, confidence: productionConfidence })), finish_matches_source: { type: ['boolean','null'] }, finish_evidence: string, finish_confidence: productionConfidence });
const schemas = { production_source: productionSource, production_comparison: productionComparison, product_truth: productTruth, gate_a: gate(C.QA_LAYER_A_CRITERIA, true), gate_b: gate(C.QA_LAYER_B_CRITERIA, false) };
const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
module.exports = { schemas, validators };
