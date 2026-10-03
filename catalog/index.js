// catalog/index.js
// /catalog pipeline orchestrator. Validates and locks RAW + Master Clean before Stages 2 → 7.
// One retry pass is available: on verdict 'retry', Stage 4 rebuilds the prompt
// with the tightened qa-lock insert and Stages 4-6 run once more. A second
// 'retry' verdict is promoted to 'manual_review' (no infinite loop).
//
// Exports:
//   runCatalogPipeline({ originalRaw, masterClean, inputManifest, openaiKey })
//   createHandler({ openaiKeyEnv })  → Express handler

const { ProductionRun } = require('../production/policy');
const { parseFilename }   = require('./metadataParser');
const { buildPrompt, resolveLayers } = require('./promptBuilder');
const { writeInputs, writeBundle, writeFailure, sha256, readReleased } = require('./writer');
const { readCatalogRequest, validateInputs } = require('./inputContract');
const { PIPELINE_VERSION, MAX_RETRIES, MODELS } = require('./constants');

async function runCatalogPipeline(args) {
  const production = new ProductionRun(args.productionOptions);
  const publication = { committed: false };
  try { return await executeCatalog(args, production, publication); }
  catch (err) {
    // A durable release cannot be retroactively aborted by response preparation.
    // The handler still fails closed if persisted response validation fails.
    if (publication.committed) throw err;
    production.abort(err.code || 'PIPELINE_ERROR');
    err.production = production.snapshot();
    const failure = sanitizedPublicationFailure(err.publication_failure, err.production.run_id);
    err.publication_failure = failure;
    try {
      if (typeof writeFailure !== 'function') throw Error('DIAGNOSTIC_UNAVAILABLE');
      err.diagnostic_path = writeFailure({ ...err.production, ...(failure ? { publication_failure: failure } : {}) });
    } catch (_) {
      // Independent operational signal; never include raw errors, paths or manifests.
      if (failure?.quarantine_required) {
        const event = JSON.stringify({ event: 'RELEASE_ROLLBACK_FAILED', ...failure });
        try { console.error(event); }
        catch (_) { try { process.stderr.write(event + '\n'); } catch (_) { /* Both logging sinks unavailable. */ } }
      }
    }
    throw err;
  }
}
async function executeCatalog({ originalRaw, masterClean, inputManifest, openaiKey, retryLimit = MAX_RETRIES }, production, publication) {
  // No provider-capable module is loaded until V2 input validation and immutable
  // persistence succeed. RAW is the sole structural authority; Clean is derived.
  if (![0, MAX_RETRIES].includes(retryLimit)) throw Object.assign(new Error('Invalid catalog retry limit'), { statusCode: 400 });
  const inputs = await validateInputs({ originalRaw, masterClean, inputManifest });
  if (!openaiKey)    throw new Error('runCatalogPipeline: openaiKey required');
  const inputAssets = writeInputs(inputs);
  await production.source({ ...inputs, openaiKey });
  const raw = inputs.originalRaw;
  const clean = inputs.masterClean;
  const filename = raw.originalFilename;
  const mediaType = raw.mediaType;
  const { runProductTruth } = require('./productTruth');
  const { runCatalogQA } = require('./catalogQA');
  const startedAt = new Date();

  // Stage 2 — filename metadata parse.
  const fm = parseFilename(filename || '');
  const sku = fm.sku || fallbackSku(raw.buffer);

  // Stage 3 — Product Truth (OpenAI Vision).
  const ptStart = Date.now();
  production.begin('PRODUCT_TRUTH');
  const ptResult = await runProductTruth({
    imageBuffer: Buffer.from(raw.buffer),
    imageMediaType: mediaType,
    sku,
    filenameMetadata: fm,
    openaiKey,
  });
  const ptDuration = Date.now() - ptStart;

  // Stage 4 → 5 → 6 — normal pass.
  let retry = false;
  const isRing = ptResult.truth.category?.value === 'ring';
  production.lock(ptResult.truth);
  production.authorize(isRing);
  const composer = isRing ? require('./geometryPreservingCompose') : null;
  const render = isRing ? composer.composeRingHero : require('./gptImageEdit').runGptImageEdit;
  let promptText = isRing ? composer.FRAMING : buildPrompt({ truth: ptResult.truth, retry });
  let layers = isRing ? ['deterministic-ring-composer-v1'] : resolveLayers(ptResult.truth, retry);

  production.begin('RENDER');
  let gieResult = await render({
    imageBuffer: Buffer.from(clean.buffer),
    imageFilename: 'master-clean.png',
    imageMediaType: clean.mediaType,
    prompt: promptText,
    openaiKey,
    ...(retryLimit === 0 ? { maxRetries: 0 } : {}),
  });

  let localQA = null;
  if (isRing) {
    localQA = await composer.verifyRingHero({ imageBuffer: clean.buffer, candidateBuffer: gieResult.pngBuffer, diagnostics: gieResult.diagnostics });
    if (!localQA.pass) throw new Error('Ring local geometry QA failed');
  }
  await production.verify(gieResult.pngBuffer, openaiKey, localQA);
  let qaResult = await runCatalogQA({
    onGate: production.qaRecorder(gieResult.pngBuffer),
    originalBuffer: Buffer.from(raw.buffer),
    originalMediaType: mediaType,
    ...(isRing ? { masterCleanBuffer: Buffer.from(clean.buffer) } : {}),
    finalBuffer: gieResult.pngBuffer,
    truth: ptResult.truth,
    openaiKey,
  });

  // One retry pass if verdict is 'retry'.
  let retryCount = 0;
  if (qaResult.verdict.value === 'retry' && retryLimit >= 1 && !isRing) {
    retry = true;
    retryCount = 1;
    promptText = buildPrompt({ truth: ptResult.truth, retry: true });
    layers = resolveLayers(ptResult.truth, true);
    production.begin('RENDER');
    gieResult = await render({
      imageBuffer: Buffer.from(clean.buffer),
      imageFilename: 'master-clean.png',
      imageMediaType: clean.mediaType,
      prompt: promptText,
      openaiKey,
    });
    await production.verify(gieResult.pngBuffer, openaiKey, null);
    qaResult = await runCatalogQA({
      onGate: production.qaRecorder(gieResult.pngBuffer),
      originalBuffer: Buffer.from(raw.buffer),
      originalMediaType: mediaType,
      finalBuffer: gieResult.pngBuffer,
      truth: ptResult.truth,
      openaiKey,
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

  if (qaResult.verdict.value === 'retry' && (retryLimit === 0 || isRing)) {
    qaResult.verdict = { ...qaResult.verdict, value: 'manual_review', promoted_from_retry: true };
  }

  const release = production.release(qaResult);
  const released = release.publication_authorized === true;
  if (!released && qaResult.verdict.value === 'approved') qaResult.verdict = { value: 'manual_review', reasons: release.stages.RELEASE_GATE.reasons };
  qaResult.final_approval = released;
  const finishedAt = new Date();

  const qaReport = {
    production: release,
    ...(isRing ? { local_qa: localQA, composition: gieResult.diagnostics } : {}),
    gate_a: qaResult.gate_a,
    gate_b: qaResult.gate_b,
    final_approval: qaResult.final_approval,
    verdict: qaResult.verdict,
  };

  const finalMetadata = {
    production: release,
    asset_state: released ? 'RELEASED' : 'CANDIDATE_ONLY',
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
      ...(isRing ? { ring_composer: { ...gieResult.diagnostics, local_qa: localQA, model: gieResult.model, duration_ms: gieResult.durationMs } } : {}),
      gpt_image: {
        model:       isRing ? null : gieResult.model,
        size:        isRing ? null : gieResult.size,
        quality:     isRing ? null : gieResult.quality,
        duration_ms: isRing ? 0 : gieResult.durationMs,
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
    release,
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

  publication.committed = released && bundle.asset_state === 'RELEASED';
  const published = released ? readReleased(sku, release.run_id) : null;
  return {
    production: release,
    sku,
    verdict: qaResult.verdict,
    gate_a: qaResult.gate_a,
    gate_b: qaResult.gate_b,
    final_approval: qaResult.final_approval,
    bundle,
    inputAssets,
    productTruth: ptResult.truth,
    finalMetadata,
    artifacts: {
      render_candidate_base64: (published ? published.bytes : gieResult.pngBuffer).toString('base64'),
      product_truth: ptResult.truth,
      prompt: promptText,
      qa_report: qaReport,
      ...(released ? { final_metadata: finalMetadata } : { candidate_metadata: finalMetadata }),
    },
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
function createHandler({ openaiKeyEnv = 'OPENAI_API_KEY' } = {}) {
  return async function catalogHandler(req, res) {
    try {
      const artifactHeader = req.headers?.['x-catalog-include-artifacts'];
      if (artifactHeader !== undefined && artifactHeader !== '1') {
        return res.status(400).json({ error: 'X-Catalog-Include-Artifacts must be 1 when supplied' });
      }
      const retryHeader = req.headers?.['x-catalog-retry-limit'];
      if (retryHeader !== undefined && retryHeader !== '0') {
        return res.status(400).json({ error: 'X-Catalog-Retry-Limit must be 0 when supplied' });
      }
      const requestInputs = readCatalogRequest(req);
      const result = await runCatalogPipeline({
        ...requestInputs,
        productionOptions: readProductionOptions(req),
        retryLimit: retryHeader === '0' ? 0 : MAX_RETRIES,
        openaiKey: process.env[openaiKeyEnv],
      });

      const persisted = result.final_approval ? readReleased(result.sku, result.production.run_id) : null;
      if (persisted) result.artifacts.render_candidate_base64 = persisted.bytes.toString('base64');
      const response = {
        production: result.production,
        asset_state: result.final_approval ? 'RELEASED' : 'CANDIDATE_ONLY',
        sku: result.sku,
        verdict: result.verdict.value,
        gate_a: result.gate_a,
        gate_b: result.gate_b,
        final_approval: result.final_approval,
        reasons: result.verdict.reasons,
        bundle_dir: result.bundle.dir,
        ...(persisted ? { release_manifest: persisted.manifest, housekeeping_status: result.bundle.housekeeping_status, cleanup_pending: result.bundle.cleanup_pending, warnings: result.bundle.warnings } : {}),
        pipeline_version: PIPELINE_VERSION,
        input_contract_version: 2,
        retry_count: result.finalMetadata.retry_count,
        retry_limit: result.finalMetadata.retry_limit,
        inputs: result.inputAssets,
        ...(artifactHeader === '1' ? { artifacts: result.artifacts } : {}),
      };
      require('../production/http').certifyResponse(response, result.production);
      res.status(200).json(response);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: 'CATALOG_FAILED', ...(err.publication_failure ? { publication_failure: err.publication_failure } : {}), production: err.production || { publication_authorized: false, stages: { RELEASE_GATE: { status: 'FAIL', reasons: ['REQUEST_OR_PIPELINE_ERROR'] } } }, asset_state: 'CANDIDATE_ONLY' });
    }
  };
}

function sanitizedPublicationFailure(value, runId) {
  if (!value || value.publication_status !== 'FAILED') return null;
  const rollbackFailed = value.code === 'MANIFEST_REVOCATION_FAILED';
  return {
    publication_status: 'FAILED', failure_category: 'RELEASE_PUBLICATION_FAILED',
    sku: typeof value.sku === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.sku) ? value.sku : null,
    run_id: typeof runId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId) ? runId : null,
    quarantine_required: rollbackFailed,
    ...(rollbackFailed ? { rollback_status: 'FAILED', code: 'MANIFEST_REVOCATION_FAILED' } : {}),
  };
}

function readProductionOptions(req) {
  const raw = req.headers?.['x-gleor-production'];
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.length > 2048) throw Object.assign(Error('Invalid production options'), { statusCode: 400 });
  try { return JSON.parse(raw); } catch (_) { throw Object.assign(Error('Invalid production options'), { statusCode: 400 }); }
}
module.exports = { runCatalogPipeline, createHandler };
