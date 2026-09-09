# Catalog analysis migration — local implementation only

Base: ff4cf80967b1f53199d732839652e95e23cf4cf8. Not pushed or deployed.

## Runtime

Product Truth, Gate A and Gate B now use POST https://api.openai.com/v1/responses with inline image inputs, strict JSON schemas and independent Ajv validation. Only OPENAI_API_KEY is required by /catalog. There is no analysis provider fallback and no analysis transport retry. Malformed/refused/incomplete Product Truth aborts before rendering; malformed QA maps to the existing fail-closed gate logic. HTTP and transport failures abort without retry. Provider error bodies and credentials are not exposed by the new adapter.

RAW remains Product Truth authority. Gate A receives RAW + candidate, and Gate B receives RAW for material/color context + candidate only after A passes. Master Clean remains the exact immutable renderer input, including presentation retries. Input V2 validation, provenance, writer/hash algorithms, Product Truth coercers, confidence gates, QA criteria/floors, final verdict and retry eligibility are unchanged.

The GPT Image renderer stays gpt-image-2 / images.edit / 1024x1024 / high, with unchanged code and input handling. The only renderer-prompt edit removes obsolete provider attribution: “independent Claude Vision QA layer” becomes “independent vision QA layer.” This changes prompt bytes and the resulting prompt hash, not hash computation or visual instructions. No exact cross-provider image/score equivalence is claimed.

## Model configuration and benchmark boundary

Default Product Truth and QA: gpt-5.4-nano, reasoning low, max_output_tokens 8192 (including reasoning), image detail high. This is a provisional low-cost current-generation candidate, not a proven cheapest reliable jewelry evaluator. CATALOG_PRODUCT_TRUTH_MODEL and CATALOG_QA_MODEL independently allow gpt-5.4-nano or gpt-5.4-mini; no automatic escalation. Flagship models are not allowed. Models are aliases, so providers may update their backing versions; actual response model is recorded in stage metadata.

Official references checked 2026-09-09:
- https://developers.openai.com/api/docs/models/gpt-5.4-nano — image input, Responses, structured output, low reasoning; text input $0.20/output $1.25 per million tokens.
- https://developers.openai.com/api/docs/models/gpt-5-nano — lower listed token rates, but snapshot section displays Deprecated; not selected for a new migration.
- https://developers.openai.com/api/docs/models/gpt-4.1-nano — lower listed token rates, but snapshot section displays Deprecated; not selected for a new migration.
- https://developers.openai.com/api/docs/guides/structured-outputs — Responses text.format json_schema with strict true.
- https://developers.openai.com/api/docs/guides/images-vision — inline data URL image input.

Local benchmark: both allowed configurations pass the identical synthetic schemas/routing fixtures. These tests validate protocol and application behavior, NOT model perception, actual cost, latency, account access or remote schema acceptance. No real provider or render was called. A live, human-reviewed ring-test is required before declaring visual reliability or activating automation. Do not change QA thresholds to make a weaker model pass.

## Calls per SKU

With X-Catalog-Retry-Limit: 0: successful path is 3 OpenAI Responses analyses (Truth/A/B) + 1 OpenAI image edit. Gate A failure skips B, yielding 2 analyses + 1 image edit. Product Truth failure prevents image generation. No PhotoRoom or former-provider call occurs.

Existing normal presentation-retry policy is retained: at most 5 logical analyses + 2 logical image edits, with identical Master Clean bytes on both renders. Analysis transport has no retries. Normal-mode image SDK transport retries remain exactly as before; the zero-retry header disables them for the controlled smoke. Logical image-edit counts in normal mode are not a promise of the same maximum number of HTTP transport attempts.

## Local verification and handoff

npm test: 50/50 pass; baseline was 35/35. Tests use guarded VM dependencies and fake Responses transport; no real network is available to the tested analysis modules. Covers all independent QA floors, critical deviations, N/A eligibility, malformed/refused/incomplete responses, HTTP/timeout failures, RAW/Clean lineage, sequential gates, bounded calls and no former-provider references in the /catalog runtime modules/prompts. git diff --check passes. Separate invariant review confirms 30 locked sections/files, including unchanged coercion and verdict functions.

Legacy bench-ab.js and qa-runner.js retain their previous provider because they are standalone A/B tooling, not loaded by /catalog or server.js. They were not run or refactored.

Do not remove ANTHROPIC_API_KEY from the currently deployed old version. After this reviewed migration is deployed, /catalog no longer needs it; the standalone legacy tooling would still need its own credential if used. Render config, n8n and production code are untouched by this local implementation.

Ready as a local candidate for a reviewed deploy followed by one explicitly controlled smoke test. Not yet a live migration, a production-quality benchmark, or permission to activate n8n.
