// catalog/promptBuilder.js
// Stage 4 — deterministic assembly of the GPT Image prompt.
//
// Layers (fixed order):
//   Layer 0: preamble/prompt-builder-contract.txt    (never restyle — hard override)
//   Layer 1: hero-catalog-v1.txt                     (SKU-preserving catalog template)
//   Layer 2: category/<value>.txt                    (composition rules)
//   Layer 3: metal/<value>.txt                       (metal hue / finish rules)
//   Layer 4: lighting/<variant>.txt                  (studio lighting)
//   Layer 5: qa-lock/<default|tightened>.txt         (mirror of QA reject criteria)
// Assertions block (product-truth-derived, deterministic templates) is inserted
// between Layer 0 and Layer 1 so the model sees authoritative facts up front.
//
// Determinism contract: given the same Product Truth object (irrespective of its
// generated_at timestamp or sku) and the same set of insert files on disk,
// buildPrompt() returns a byte-identical string. No timestamps, no randomness,
// no LLM calls.

const fs = require('fs');
const path = require('path');

const { METAL_TYPES, CONFIDENCE_LOW, CONFIDENCE_HIGH } = require('./constants');

const PROMPT_DIR = path.join(__dirname, '..', 'prompts');
const LAYER_SEPARATOR = '\n\n---\n\n';
const COOL_METALS = new Set(['silver', 'platinum', 'white_gold']);

function buildPrompt({ truth, retry = false } = {}) {
  if (!truth) throw new Error('promptBuilder: truth is required');
  const layers = resolveLayers(truth, retry);

  const parts = [
    readInsert(layers.preamble),
    buildAssertions(truth),
    readInsert(layers.base),
    readInsert(layers.category),
    readInsert(layers.metal),
    readInsert(layers.lighting),
    readInsert(layers.qaLock),
  ];

  return parts.map(normalize).join(LAYER_SEPARATOR) + '\n';
}

function resolveLayers(truth, retry) {
  return {
    preamble: 'preamble/prompt-builder-contract.txt',
    base:     'hero-catalog-v1.txt',
    category: `category/${categoryFile(truth)}`,
    metal:    `metal/${metalFile(truth)}`,
    lighting: `lighting/${lightingFile(truth)}`,
    qaLock:   `qa-lock/${retry ? 'catalog-v1-tightened.txt' : 'catalog-v1.txt'}`,
  };
}

function readInsert(rel) {
  return fs.readFileSync(path.join(PROMPT_DIR, rel), 'utf8');
}

// Trim trailing whitespace (including trailing newlines) — the LAYER_SEPARATOR
// controls spacing between layers, so each layer contributes only its body.
function normalize(s) {
  return s.replace(/[\r ]+$/gm, '').replace(/\s+$/g, '');
}

function categoryFile(truth) {
  const v = truth && truth.category && truth.category.value;
  if (v === 'ring' || v === 'pendant' || v === 'earring' || v === 'bracelet' || v === 'necklace') {
    return `${v}.txt`;
  }
  return 'unknown.txt';
}

function metalFile(truth) {
  const m = truth && truth.metal_type;
  if (!m || !m.value || !METAL_TYPES.includes(m.value)) return 'preserve_as_seen.txt';
  if (m.source === 'vision' && m.confidence >= CONFIDENCE_HIGH) return `${m.value}.txt`;
  return 'preserve_as_seen.txt';
}

function lightingFile(truth) {
  const m = truth && truth.metal_type && truth.metal_type.value;
  return truth?.metal_type?.source === 'vision' && COOL_METALS.has(m) ? 'soft_studio_dark_metal.txt' : 'soft_studio.txt';
}

// Deterministic assertions block. Includes only facts that clear their confidence
// gates. Uses fixed sentence templates in a fixed order. No timestamps.
function buildAssertions(truth) {
  const lines = ['PRODUCT ASSERTIONS (authoritative — do not contradict):'];

  if (truth.category.value) {
    lines.push(`- category: ${truth.category.value} (source: ${truth.category.source})`);
  } else {
    lines.push(`- category: unspecified — preserve the piece exactly as shown in the input`);
  }

  const metalAsserted =
    truth.metal_type.value &&
    truth.metal_type.source === 'vision' && truth.metal_type.confidence >= CONFIDENCE_HIGH;
  if (metalAsserted) {
    lines.push(`- metal_type: ${truth.metal_type.value} (source: ${truth.metal_type.source})`);
  } else {
    lines.push(`- metal_type: not asserted — preserve the metal's exact hue and tone as seen in the input`);
  }

  // No verified assay input exists in this pipeline; declarations cannot assert karat.
  lines.push(`- karat: not asserted — do not invent any hallmark, karat stamp, or engraved indicator; preserve visible source markings`);

  if (truth.gemstone_presence.value === true) {
    if (Number.isInteger(truth.gemstone_presence.visible_count)) {
      lines.push(`- gemstones: present; visible count = ${truth.gemstone_presence.visible_count} (preserve exactly — do not add or remove stones)`);
    } else {
      lines.push(`- gemstones: present; count uncertain — preserve every visible stone exactly, do not add or remove any`);
    }
  } else if (truth.gemstone_presence.value === false) {
    lines.push(`- gemstones: not visible in the input — do not introduce gemstones`);
  }

  if (truth.gemstone_type.value && truth.gemstone_type.value !== 'unknown') {
    lines.push(`- gemstone_type: ${truth.gemstone_type.value} (preserve — do not substitute a different stone type)`);
  }

  if (truth.setting_type.value && truth.setting_type.value !== 'unknown' && truth.setting_type.confidence >= CONFIDENCE_LOW) {
    lines.push(`- setting_type: ${truth.setting_type.value} (preserve — do not substitute a different setting)`);
  }

  if (truth.chain_visible.value === true && truth.chain_visible.confidence >= CONFIDENCE_LOW) {
    lines.push(`- chain: present — preserve the chain exactly (link pattern, thickness, length as in the input)`);
  } else if (truth.chain_visible.value === false && truth.chain_visible.confidence >= CONFIDENCE_LOW) {
    lines.push(`- chain: not present — do not add a chain`);
  }

  if (truth.pendant_visible.value === true && truth.pendant_visible.confidence >= CONFIDENCE_LOW) {
    lines.push(`- pendant: present — preserve exactly (silhouette, size, orientation)`);
  } else if (truth.pendant_visible.value === false && truth.pendant_visible.confidence >= CONFIDENCE_LOW) {
    lines.push(`- pendant: not present — do not add a pendant`);
  }

  if (truth.support_objects.present === true && truth.support_objects.types.length > 0) {
    lines.push(`- support objects visible in the input (${truth.support_objects.types.join(', ')}) — remove them in the output; the product must appear alone on a clean white background`);
  }

  if (truth.cleanup_regions.present === true && truth.cleanup_regions.types.length > 0) {
    lines.push(`- photographic defects present in the input (${truth.cleanup_regions.types.join(', ')}) — clean these up in the output while preserving the product itself`);
  }

  if (truth.visible_hallmarks.present === true) {
    const where = truth.visible_hallmarks.regions.length > 0 ? ` (${truth.visible_hallmarks.regions.join(', ')})` : '';
    lines.push(`- visible hallmarks / stamps present in the input${where} — preserve these physical product markings exactly; do not erase or invent marks`);
  }

  if (truth.product_complete.value === false && truth.product_complete.cropped_regions.length > 0) {
    lines.push(`- input is clipped at frame edge(s): ${truth.product_complete.cropped_regions.join(', ')} — do not fabricate the missing regions; frame the visible product with generous padding`);
  }

  if (truth.background_condition.value && truth.background_condition.value !== 'clean_white') {
    lines.push(`- input background is ${truth.background_condition.value} — replace it with a pure #FFFFFF uniform white background in the output`);
  }

  return lines.join('\n');
}

module.exports = { buildPrompt, resolveLayers };
