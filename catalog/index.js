// catalog/index.js
// /catalog pipeline orchestrator. Validates and locks RAW + Master Clean before Stages 2 → 7.
// One retry pass is available: on verdict 'retry', Stage 4 rebuilds the prompt
// with the tightened qa-lock insert and Stages 4-6 run once more. A second
// 'retry' verdict is promoted to 'manual_review' (no infinite loop).
//
// Exports:
//   runCatalogPipeline({ originalRaw, masterClean, inputManifest, anthropicKey, openaiKey })
//   createHandler({ anthropicKeyEnv, openaiKeyEnv })  → Express handler

const { parseFilename }   = require('./metadataParser');
const { buildPrompt, resolveLayers } = require('./promptBuilder');
const { writeInputs, writeBundle, sha256 } = require('./writer');
const { readCatalogRequest, validateInputs } = require('./inputContract');
const { PIPELINE_VERSION, MAX_RETRIES, MODELS } = require('./constants');

async function runCatalogPipeline({ originalRaw, masterClean, inputManifest, anthropicKey, openaiKey, retryLimit = MAX_RETRIES }) {
  // No provider-capable module is loaded until V2 input validation and immutable
  // persistence succeed. RAW is the sole structural authority; Clean is derived.
  if (![0, MAX_RETRIES].includes(retryLimit)) throw Object.assign(new Error('Invalid catalog retry limit'), { statusCode: 400 });
  const inputs = await validateInputs({ originalRaw, masterClean, inputManifest });
  if (!anthropicKey) throw new Error('runCatalogPipeline: anthropicKey required');
  if (!openaiKey)    throw new Error('runCatalogPipeline: openaiKey required');
  const inputAssets = writeInputs(inputs);
  const raw = inputs.originalRaw;
  const clean = inputs.masterClean;
  const filename = raw.originalFilename;
  const mediaType = raw.mediaType;
  const { runProductTruth } = require('./productTruth');
  const { runGptImageEdit } = require('./gptImageEdit');
  const { runCatalogQA } = require('./catalogQA');
  const startedAt = new Date();

  // Stage 2 — filename metadata parse.
  const fm = parseFilename(filename || '');
  const sku = fm.sku || fallbackSku(raw.buffer);

  // Stage 3 — Product Truth (Claude Vision).
  const ptStart = Date.now();
  const ptResult = await runProductTruth({
    imageBuffer: Buffer.from(raw.buffer),
    imageMediaType: mediaType,
    sku,
    filenameMetadata: fm,
    anthropicKey,
  });
  const ptDuration = Date.now() - ptStart;

  // Stage 4 → 5 → 6 — normal pass.
  let retry = false;
  let promptText = buildPrompt({ truth: ptResult.truth, retry });
  let layers = resolveLayers(ptResult.truth, retry);

  let gieResult = await runGptImageEdit({
    imageBuffer: Buffer.from(clean.buffer),
    imageFilename: 'master-clean.png',
    imageMediaType: clean.mediaType,
    prompt: promptText,
    openaiKey,
    ...(retryLimit === 0 ? { maxRetries: 0 } : {}),
  });

  let qaResult = await runCatalogQA({
    originalBuffer: Buffer.from(raw.buffer),
    originalMediaType: mediaType,
    finalBuffer: gieResult.pngBuffer,
    truth: ptResult.truth,
    anthropicKey,
  });

  // One retry pass if verdict is 'retry'.
  let retryCount = 0;
  if (qaResult.verdict.value === 'retry' && retryLimit >= 1) {
    retry = true;
    retryCount = 1;
    promptText = buildPrompt({ truth: ptResult.truth, retry: true });
    layers = resolveLayers(ptResult.truth, true);
    gieResult = await runGptImageEdit({
      imageBuffer: Buffer.from(clean.buffer),
      imageFilename: 'master-clean.png',
      imageMediaType: clean.mediaType,
      prompt: promptText,
      openaiKey,
    });
    qaResult = await runCatalogQA({
      originalBuffer: Buffer.from(raw.buffer),
      originalMediaType: mediaType,
      finalBuffer: gieResult.pngBuffer,
      truth: ptResult.truth,
      anthropicKey,
    });
    // After the retry pass, 'retry' is no longer available — promote to manual_review.
    if (qaResult.verdict.value === 'retry') {
      qaResult.verdict = {
        value: 'manual_review',
        reasons: qaResult.verdict.reasons,
        promoted_from_retry: true,
      };
    }
  }

  if (qaResult.verdict.value === 'retry' && retryLimit === 0) {
    qaResult.verdict = { ...qaResult.verdict, value: 'manual_review', promoted_from_retry: true };
  }

  const finishedAt = new Date();

  const qaReport = {
    gate_a: qaResult.gate_a,
    gate_b: qaResult.gate_b,
    final_approval: qaResult.final_approval,
    verdict: qaResult.verdict,
  };

  const finalMetadata = {
    pipeline_version: PIPELINE_VERSION,
    input_contract_version: 2,
    inputs: inputAssets,
    sku,
    filename: filename || null,
    filename_metadata: fm,
    timings: {
      started_at:  startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      total_ms:    finishedAt.getTime() - startedAt.getTime(),
    },
    retry_count: retryCount,
    retry_limit: retryLimit,
    verdict: qaResult.verdict.value,
    final_approval: qaResult.final_approval,
    stages: {
      product_truth: {
        model: ptResult.model || MODELS.productTruth,
        usage: ptResult.usage || null,
        duration_ms: ptDuration,
      },
      prompt_builder: {
        layers_used: layers,
        prompt_sha256: sha256(Buffer.from(promptText, 'utf8')),
        retry,
      },
      gpt_image: {
        model:       gieResult.model,
        size:        gieResult.size,
        quality:     gieResult.quality,
        duration_ms: gieResult.durationMs,
        usage:       gieResult.usage,
      },
      gate_a: {
        status:      qaResult.gate_a.status,
        model:       qaResult.gate_a.model || MODELS.qa,
        usage:       qaResult.gate_a.usage,
        duration_ms: qaResult.gate_a.durationMs,
      },
      gate_b: {
        status:      qaResult.gate_b.status,
        model:       qaResult.gate_b.status === 'NOT_RUN' ? null : (qaResult.gate_b.model || MODELS.qa),
        usage:       qaResult.gate_b.usage,
        duration_ms: qaResult.gate_b.durationMs,
      },
    },
    hashes: {
      original_raw_sha256:     raw.sha256,
      master_clean_png_sha256: clean.sha256,
      product_truth_sha256: sha256(Buffer.from(JSON.stringify(ptResult.truth), 'utf8')),
      prompt_sha256:        sha256(Buffer.from(promptText, 'utf8')),
      render_candidate_sha256: sha256(gieResult.pngBuffer),
      qa_report_sha256:     sha256(Buffer.from(JSON.stringify(qaReport), 'utf8')),
    },
    final_scores_summary: {
      gate_a_min: minScore(qaResult.gate_a.criteria),
      gate_b_min: minScore(qaResult.gate_b.criteria),
    },
  };

  const manualReviewReasons = !qaResult.final_approval
    ? {
        verdict: qaResult.verdict,
        notes: 'See qa-report.json for full per-criterion scores.',
      }
    : null;

  const bundle = writeBundle({
    sku,
    verdict: qaResult.verdict.value,
    inputAssets,
    productTruth: ptResult.truth,
    promptText,
    finalPng: gieResult.pngBuffer,
    qaReport,
    finalMetadata,
    manualReviewReasons,
  });

  return {
    sku,
    verdict: qaResult.verdict,
    gate_a: qaResult.gate_a,
    gate_b: qaResult.gate_b,
    final_approval: qaResult.final_approval,
    bundle,
    inputAssets,
    productTruth: ptResult.truth,
    finalMetadata,
  };
}

function minScore(scores) {
  const values = Object.values(scores).filter(s => s.applicable && Number.isFinite(s.score)).map(s => s.score);
  return values.length ? Math.min(...values) : null;
}

function fallbackSku(imageBuffer) {
  return sha256(imageBuffer).slice(0, 12).toUpperCase();
}

// Express handler factory. Mounted by server.js at POST /catalog.
function createHandler({ anthropicKeyEnv = 'ANTHROPIC_API_KEY', openaiKeyEnv = 'OPENAI_API_KEY' } = {}) {
  return async function catalogHandler(req, res) {
    try {
      const retryHeader = req.headers?.['x-catalog-retry-limit'];
      if (retryHeader !== undefined && retryHeader !== '0') {
        return res.status(400).json({ error: 'X-Catalog-Retry-Limit must be 0 when supplied' });
      }
      const requestInputs = readCatalogRequest(req);
      const result = await runCatalogPipeline({
        ...requestInputs,
        retryLimit: retryHeader === '0' ? 0 : MAX_RETRIES,
        anthropicKey: process.env[anthropicKeyEnv],
        openaiKey: process.env[openaiKeyEnv],
      });

      res.status(200).json({
        sku: result.sku,
        verdict: result.verdict.value,
        gate_a: result.gate_a,
        gate_b: result.gate_b,
        final_approval: result.final_approval,
        reasons: result.verdict.reasons,
        bundle_dir: result.bundle.dir,
        pipeline_version: PIPELINE_VERSION,
        input_contract_version: 2,
        retry_count: result.finalMetadata.retry_count,
        retry_limit: result.finalMetadata.retry_limit,
        inputs: result.inputAssets,
      });
    } catch (err) {
      console.error('catalog pipeline error:', err && err.stack ? err.stack : err);
      res.status(err.statusCode || 500).json({ error: err.message || String(err) });
    }
  };
}

module.exports = { runCatalogPipeline, createHandler };
