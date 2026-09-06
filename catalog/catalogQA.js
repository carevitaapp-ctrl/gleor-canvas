// Stage 6: Gate A must pass before Gate B runs. No combined approval score.
const https = require('https');
const fs = require('fs');
const path = require('path');

const {
  MODELS,
  QA_THRESHOLDS,
  QA_LAYER_A_CRITERIA,
  QA_LAYER_B_CRITERIA,
  QA_RETRY_ELIGIBLE_CRITERIA,
  QA_OPTIONAL_A_CRITERIA,
  QA_OPTIONAL_B_CRITERIA,
} = require('./constants');

const LAYER_A_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'qa', 'sku-fidelity.txt');
const LAYER_B_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'qa', 'catalog-quality.txt');

async function runCatalogQA({ originalBuffer, originalMediaType, finalBuffer, truth, anthropicKey }) {
  if (!anthropicKey) throw new Error('runCatalogQA: anthropicKey required');
  if (!Buffer.isBuffer(originalBuffer)) throw new Error('runCatalogQA: originalBuffer must be a Buffer');
  if (!Buffer.isBuffer(finalBuffer)) throw new Error('runCatalogQA: finalBuffer must be a Buffer');

  const gate_a = await runLayerA({ originalBuffer, originalMediaType, finalBuffer, truth, anthropicKey });
  const gate_b = gate_a.status === 'PASS'
    ? await runLayerB({ originalBuffer, originalMediaType, finalBuffer, truth, anthropicKey })
    : { status: 'NOT_RUN', criteria: {}, failures: [], model: null, usage: null, durationMs: 0 };
  const final_approval = gate_a.status === 'PASS' && gate_b.status === 'PASS';
  return { gate_a, gate_b, final_approval, verdict: decideVerdict(gate_a, gate_b) };
}

async function runLayerA({ originalBuffer, originalMediaType, finalBuffer, truth, anthropicKey }) {
  const template = fs.readFileSync(LAYER_A_PROMPT_PATH, 'utf8');
  const promptText = injectTruthContext(template, truth);
  const body = JSON.stringify({
    model: MODELS.qa,
    max_tokens: 3000,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'ORIGINAL INPUT:' },
        { type: 'image', source: { type: 'base64', media_type: originalMediaType || 'image/jpeg', data: originalBuffer.toString('base64') } },
        { type: 'text', text: 'RENDERED OUTPUT:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: finalBuffer.toString('base64') } },
        { type: 'text', text: promptText },
      ],
    }],
  });
  const started = Date.now();
  const { text, usage, model } = await callAnthropic(body, anthropicKey);
  const durationMs = Date.now() - started;
  return { ...parseGate(text, 'A', truth), usage, model, durationMs };
}

async function runLayerB({ originalBuffer, originalMediaType, finalBuffer, truth, anthropicKey }) {
  const template = fs.readFileSync(LAYER_B_PROMPT_PATH, 'utf8');
  const promptText = injectTruthContext(template, truth);
  const body = JSON.stringify({
    model: MODELS.qa,
    max_tokens: 3000,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'ORIGINAL INPUT (material/color context only):' },
        { type: 'image', source: { type: 'base64', media_type: originalMediaType || 'image/jpeg', data: originalBuffer.toString('base64') } },
        { type: 'text', text: 'RENDERED OUTPUT (evaluate catalog quality):' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: finalBuffer.toString('base64') } },
        { type: 'text', text: promptText },
      ],
    }],
  });
  const started = Date.now();
  const { text, usage, model } = await callAnthropic(body, anthropicKey);
  const durationMs = Date.now() - started;
  return { ...parseGate(text, 'B', truth), usage, model, durationMs };
}

function injectTruthContext(template, truth) {
  const category = (truth && truth.category && truth.category.value) || 'unspecified';
  const metal = (truth && truth.metal_type && truth.metal_type.value) || 'unspecified';
  const goldRelevant = metal === 'yellow_gold' || metal === 'rose_gold';
  const gemCount = truth && truth.gemstone_presence && Number.isInteger(truth.gemstone_presence.visible_count)
    ? String(truth.gemstone_presence.visible_count)
    : 'unknown';
  return template
    .replaceAll('{{CATEGORY}}', category)
    .replaceAll('{{METAL}}', metal)
    .replaceAll('{{GOLD_HUE_APPLICABLE}}', goldRelevant ? 'yes' : (metal === 'unspecified' ? 'unknown' : 'no'))
    .replaceAll('{{GEMSTONE_COUNT}}', gemCount);
}

function callAnthropic(bodyStr, anthropicKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`Anthropic QA ${res.statusCode}: ${raw}`));
        try {
          const parsed = JSON.parse(raw);
          const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          resolve({ text, usage: parsed.usage, model: parsed.model });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// Invalid, incomplete or uncertain evaluator responses cannot approve a candidate.
function parseGate(text, layer, truth) {
  let parsed;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('missing JSON');
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    parsed = null;
  }
  const isA = layer === 'A';
  const keys = isA ? QA_LAYER_A_CRITERIA : QA_LAYER_B_CRITERIA;
  const optional = isA ? QA_OPTIONAL_A_CRITERIA : QA_OPTIONAL_B_CRITERIA;
  // A model's N/A response cannot override a feature already established by Product Truth.
  const required = new Set(keys.filter(k => !optional.has(k)));
  if (isA && truth?.category?.value === 'ring') {
    for (const k of ['band_proportions', 'band_curvature_thickness', 'inner_band_structural_fidelity']) required.add(k);
  }
  if (isA && truth?.setting_type?.value === 'pave') {
    required.add('pave_start_boundary_fidelity');
    required.add('pave_end_boundary_fidelity');
  }
  if (isA && truth?.setting_type?.value === 'prong') required.add('prong_fidelity');
  if (truth?.gemstone_presence?.value === true) {
    required.add(isA ? 'stone_layout_fidelity' : 'gemstone_clarity');
    if (!isA && truth?.setting_type?.value === 'prong') required.add('stone_prong_visual_separation');
  }
  if (!isA && ['yellow_gold', 'rose_gold'].includes(truth?.metal_type?.value)) {
    required.add('clean_light_premium_gold_appearance');
  }
  const criteria = {};
  const failures = [];
  const critical_failures = [];

  if (isA) {
    if (!Array.isArray(parsed?.critical_failures)) {
      critical_failures.push({ criterion: 'qa_response', reason: 'Missing or malformed critical_failures array' });
    } else {
      for (const entry of parsed.critical_failures) {
        // Even a malformed critical entry must block approval, never disappear.
        critical_failures.push({
          criterion: keys.includes(entry?.criterion) ? entry.criterion : 'qa_response',
          reason: typeof entry?.reason === 'string' && entry.reason.trim()
            ? entry.reason : 'Critical deviation reported without a valid reason',
        });
      }
    }
  }

  for (const k of keys) {
    const v = parsed?.criteria?.[k];
    const hasNote = typeof v?.note === 'string' && v.note.trim().length > 0;
    const validCritical = !isA || typeof v?.critical_deviation === 'boolean';
    const validScore = typeof v?.score === 'number' && Number.isInteger(v.score)
      && v.score >= 0 && v.score <= 100;
    const validNA = optional.has(k) && !required.has(k) && v?.applicable === false && v.score === null && hasNote;
    const valid = hasNote && validCritical && (validNA || (v?.applicable === true && validScore));
    criteria[k] = valid
      ? { score: v.score, applicable: v.applicable, note: v.note }
      : { score: 0, applicable: true, note: 'Missing or malformed criterion; cannot establish a pass' };
    if (isA) {
      criteria[k].critical_deviation = v?.critical_deviation === true;
      if (criteria[k].critical_deviation) {
        critical_failures.push({ criterion: k, reason: hasNote ? v.note : 'Critical structural deviation' });
      }
    }
    if (!valid || (criteria[k].applicable && criteria[k].score < QA_THRESHOLDS[k])) {
      failures.push({ criterion: k, score: criteria[k].score, threshold: QA_THRESHOLDS[k], layer, reason: criteria[k].note });
    }
  }
  return {
    status: failures.length === 0 && critical_failures.length === 0 ? 'PASS' : 'FAIL',
    criteria,
    ...(isA ? { critical_failures } : {}),
    failures,
  };
}

function decideVerdict(gateA, gateB) {
  if (gateA.status !== 'PASS') {
    return { value: 'FAIL', reasons: [...gateA.critical_failures, ...gateA.failures] };
  }
  if (gateB.status === 'PASS') return { value: 'approved', reasons: [] };
  const failures = gateB.failures || [];
  const allRetryable = failures.length > 0
    && failures.every(f => QA_RETRY_ELIGIBLE_CRITERIA.has(f.criterion));
  return { value: allRetryable ? 'retry' : 'manual_review', reasons: failures };
}

module.exports = { runCatalogQA, decideVerdict };
