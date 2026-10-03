// catalog/metadataParser.js
// Stage 2 — extract declared commercial fields from filename.
// Runtime 2.0.0 remediation retains these declarations as UNVERIFIED metadata.
// They never override RAW observations; identity conflicts block production.

const path = require('path');

function tokenize(filename) {
  const base = path.parse(filename).name;
  return base
    .toLowerCase()
    .split(/[-_.\s]+/)
    .filter(Boolean);
}

const CATEGORY_TOKEN_MAP = {
  ring: 'ring',
  rings: 'ring',
  pendant: 'pendant',
  pendants: 'pendant',
  earring: 'earring',
  earrings: 'earring',
  bracelet: 'bracelet',
  bracelets: 'bracelet',
  necklace: 'necklace',
  necklaces: 'necklace',
};

function detectCategory(tokens) {
  for (const t of tokens) {
    if (CATEGORY_TOKEN_MAP[t]) return CATEGORY_TOKEN_MAP[t];
  }
  return null;
}

// Multi-word metals first (rose gold, white gold, yellow gold) so plain "gold" doesn't shadow them.
function detectMetal(tokens) {
  const joined = ' ' + tokens.join(' ') + ' ';
  if (/ rose ?gold |\brg\b| pink ?gold /.test(joined)) return 'rose_gold';
  if (/ white ?gold |\bwg\b/.test(joined)) return 'white_gold';
  if (/ yellow ?gold |\byg\b/.test(joined)) return 'yellow_gold';
  if (/ platinum |\bplat\b|\bpt\b/.test(joined)) return 'platinum';
  if (/ silver | sterling |\b925\b/.test(joined)) return 'silver';
  if (/ gold /.test(joined)) return 'yellow_gold'; // industry default when unqualified
  return null;
}

function detectKarat(tokens) {
  for (const t of tokens) {
    const m = t.match(/^(10|14|18|22|24)k$/);
    if (m) return `${m[1]}K`;
    if (t === '925') return '925';
  }
  return null;
}

const KNOWN_NOISE_TOKENS = new Set([
  ...Object.keys(CATEGORY_TOKEN_MAP),
  'yellow', 'rose', 'white', 'gold', 'silver', 'platinum',
  'sterling', 'diamond', 'diamonds', 'stone', 'stones', 'gem', 'gems',
  'yg', 'rg', 'wg', 'pt', 'plat',
  '925', '10k', '14k', '18k', '22k', '24k',
  'catalog', 'hero', 'test', 'sample', 'raw', 'source', 'input', 'photo', 'image', 'img',
]);

// SKU token detection. Order tried:
//   1) explicit SKU-prefixed token (SKU123, sku_ABC1, ...)
//   2) trailing alphanumeric token with at least one digit that isn't a noise word
//   3) trailing pure-digit token of length >= 4
// Returns null if none; orchestrator falls back to a hash prefix of the image bytes.
function detectSku(rawBase, tokens) {
  const explicit = rawBase.match(/\b(sku[-_]?[a-z0-9]+)\b/i);
  if (explicit) return explicit[1].toUpperCase().replace(/[-_]/g, '');

  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (KNOWN_NOISE_TOKENS.has(t)) continue;
    if (/^[a-z0-9]{3,}$/.test(t) && /\d/.test(t) && /[a-z]/.test(t)) {
      return t.toUpperCase();
    }
  }

  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (KNOWN_NOISE_TOKENS.has(t)) continue;
    if (/^\d{4,}$/.test(t)) return t;
  }

  return null;
}

/**
 * Parse a filename into declared product metadata.
 * @param {string} filename - filename with or without directory prefix; extension optional.
 * @returns {{
 *   sku: string|null,
 *   category:   {value: string|null, source: 'filename'|'unknown'},
 *   metal_type: {value: string|null, source: 'filename'|'unknown'},
 *   karat:      {value: string|null, source: 'filename'|'unknown'},
 * }}
 */
function parseFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return {
      sku: null,
      category:   { value: null, source: 'unknown' },
      metal_type: { value: null, source: 'unknown' },
      karat:      { value: null, source: 'unknown' },
    };
  }
  const rawBase = path.parse(filename).name;
  const tokens = tokenize(filename);
  const category = detectCategory(tokens);
  const metal    = detectMetal(tokens);
  const karat    = detectKarat(tokens);
  const sku      = detectSku(rawBase, tokens);
  return {
    sku,
    category:   { value: category, source: category ? 'filename' : 'unknown' },
    metal_type: { value: metal,    source: metal    ? 'filename' : 'unknown' },
    karat:      { value: karat,    source: karat    ? 'filename' : 'unknown' },
  };
}

module.exports = { parseFilename };
