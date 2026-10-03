// catalog/constants.js
// Single source of truth for pipeline thresholds, canonical field order, and model IDs.
// Every stage of the /catalog pipeline loads its numbers from here.

const PIPELINE_VERSION = 'gleor-production-2.0.0';

// Confidence gates (locked per approved plan §1).
// Below LOW  → field becomes null/unknown; prompt uses "preserve as-is" clause.
// Between LOW and HIGH → field carried forward with conditional wording.
// At/above HIGH (RAW-observed) → field asserted as fact in prompt.
const CONFIDENCE_LOW = 0.60;
const CONFIDENCE_HIGH = 0.85;
// STRICT NON-ESTIMATION RULE: Product Truth is descriptive only. Any attribute
// listed below must reach CONFIDENCE_HIGH from RAW analysis. Filename declarations
// are separate and unverified. Otherwise values become null / "unknown".
// Fields: metal_type, gemstone_type, gemstone visible_count. Karat stays unverified.
const VISION_MIN_FOR_STRICT_FIELDS = CONFIDENCE_HIGH;
const GEMSTONE_TYPE_MIN = CONFIDENCE_HIGH;
const GEMSTONE_COUNT_MIN = CONFIDENCE_HIGH;

// Allowlists for value validation.
const CATEGORIES = ['ring', 'pendant', 'earring', 'bracelet', 'necklace'];
const METAL_TYPES = ['yellow_gold', 'rose_gold', 'white_gold', 'silver', 'platinum'];
const KARATS = ['10K', '14K', '18K', '22K', '24K', '925'];
const ORIENTATIONS = ['front', 'three_quarter', 'side', 'top'];
const PRODUCT_SCALES = ['too_small', 'correct', 'too_large'];
const FRAMINGS = ['centered', 'off_center_left', 'off_center_right', 'off_center_top', 'off_center_bottom'];
const BACKGROUND_CONDITIONS = ['clean_white', 'off_white', 'textured', 'colored', 'gradient', 'complex'];
const GEMSTONE_TYPES = ['diamond', 'colored_stone', 'pearl', 'mixed', 'unknown'];
const SETTING_TYPES = ['prong', 'bezel', 'pave', 'channel', 'tension', 'flush', 'halo', 'mixed', 'unknown'];

// Canonical order for Product Truth JSON key serialization.
// Deterministic prompt/artifact hashing depends on this being stable.
const PRODUCT_TRUTH_KEY_ORDER = [
  'declared_metadata', 'metadata_conflicts',
  'sku',
  'generated_at',
  'sources',
  'category',
  'metal_type',
  'metal_confidence',
  'karat',
  'orientation',
  'product_scale',
  'framing',
  'product_complete',
  'visible_hallmarks',
  'cleanup_regions',
  'support_objects',
  'chain_visible',
  'pendant_visible',
  'background_condition',
  'gemstone_presence',
  'gemstone_type',
  'setting_type',
  'overall_analysis_confidence',
];

// Package 1: independent criterion floors; no combined approval score.
const QA_THRESHOLDS = {
  geometry_fidelity: 95,
  silhouette_fidelity: 95,
  symmetry: 95,
  band_proportions: 95,
  band_curvature_thickness: 95,
  pave_start_boundary_fidelity: 95,
  pave_end_boundary_fidelity: 95,
  stone_layout_fidelity: 95,
  stone_row_fidelity: 95,
  prong_fidelity: 95,
  inner_band_structural_fidelity: 95,
  perspective_fidelity: 95,
  metal_color_fidelity: 95,
  metal_realism: 90,
  clean_light_premium_gold_appearance: 90,
  gemstone_clarity: 90,
  gemstone_facet_definition: 90,
  stone_prong_visual_separation: 90,
  lighting_quality: 90,
  highlight_quality: 90,
  physically_plausible_contact_shadow: 90,
  sharpness_without_oversharpening: 92,
  correct_product_scale: 92,
  framing: 92,
  pure_white_background: 98,
  premium_jewelry_catalog_appearance: 95,
};

const QA_LAYER_A_CRITERIA = [
  'geometry_fidelity',
  'silhouette_fidelity',
  'symmetry',
  'band_proportions',
  'band_curvature_thickness',
  'pave_start_boundary_fidelity',
  'pave_end_boundary_fidelity',
  'stone_layout_fidelity',
  'stone_row_fidelity',
  'prong_fidelity',
  'inner_band_structural_fidelity',
  'perspective_fidelity',
];

const QA_LAYER_B_CRITERIA = [
  'metal_color_fidelity',
  'metal_realism',
  'clean_light_premium_gold_appearance',
  'gemstone_clarity',
  'gemstone_facet_definition',
  'stone_prong_visual_separation',
  'lighting_quality',
  'highlight_quality',
  'physically_plausible_contact_shadow',
  'sharpness_without_oversharpening',
  'correct_product_scale',
  'framing',
  'pure_white_background',
  'premium_jewelry_catalog_appearance',
];

// Only physically absent features can be marked not applicable. Unclear is not N/A.
const QA_OPTIONAL_A_CRITERIA = new Set([
  'band_proportions',
  'band_curvature_thickness',
  'pave_start_boundary_fidelity',
  'pave_end_boundary_fidelity',
  'stone_layout_fidelity',
  'stone_row_fidelity',
  'prong_fidelity',
  'inner_band_structural_fidelity',
]);

const QA_OPTIONAL_B_CRITERIA = new Set([
  'clean_light_premium_gold_appearance',
  'gemstone_clarity',
  'gemstone_facet_definition',
  'stone_prong_visual_separation',
]);

// Preserve the existing single retry for presentation-only failures.
const QA_RETRY_ELIGIBLE_CRITERIA = new Set([
  'physically_plausible_contact_shadow',
  'lighting_quality',
  'sharpness_without_oversharpening',
  'framing',
  'correct_product_scale',
]);

// Analysis defaults are a low-cost candidate, pending a live visual-quality benchmark.
// Explicit nano/mini overrides never change prompts, thresholds or retry policy.
// Model IDs.
const MODELS = {
  productTruth: process.env.CATALOG_PRODUCT_TRUTH_MODEL || 'gpt-5.4-nano',
  qa:           process.env.CATALOG_QA_MODEL || 'gpt-5.4-nano',
  gptImage:     'gpt-image-2',
  analysisAllowed: ['gpt-5.4-nano', 'gpt-5.4-mini'],
};

// GPT Image parameters (locked at plan defaults; no upscaling / Sharp visual ops downstream).
const GPT_IMAGE_SIZE = '1024x1024';
const GPT_IMAGE_QUALITY = 'high';

// Retry budget (locked at 1 per approved plan §8).
const MAX_RETRIES = 1;

module.exports = {
  PIPELINE_VERSION,
  CONFIDENCE_LOW,
  CONFIDENCE_HIGH,
  VISION_MIN_FOR_STRICT_FIELDS,
  GEMSTONE_TYPE_MIN,
  GEMSTONE_COUNT_MIN,
  CATEGORIES,
  METAL_TYPES,
  KARATS,
  ORIENTATIONS,
  PRODUCT_SCALES,
  FRAMINGS,
  BACKGROUND_CONDITIONS,
  GEMSTONE_TYPES,
  SETTING_TYPES,
  PRODUCT_TRUTH_KEY_ORDER,
  QA_THRESHOLDS,
  QA_LAYER_A_CRITERIA,
  QA_LAYER_B_CRITERIA,
  QA_RETRY_ELIGIBLE_CRITERIA,
  QA_OPTIONAL_A_CRITERIA,
  QA_OPTIONAL_B_CRITERIA,
  MODELS,
  GPT_IMAGE_SIZE,
  GPT_IMAGE_QUALITY,
  MAX_RETRIES,
};
