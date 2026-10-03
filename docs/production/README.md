# Gleor Production Runtime 2.0.0

This is NEW ENGINEERING on `main` at `1e131974d0c7913ecf0adaeca32b0ea1b4238103`. Runtime 1.1.0, Core Visual Rules 1.3.0 and Earring Standard 1.7.0 were not recovered. These documents and implementation do not claim that history.

The authoritative current software contracts are [Core Visual Rules 2.0.0](CORE_VISUAL_RULES.md) and [Earring Production Standard 2.0.0](EARRING_PRODUCTION_STANDARD.md). Runtime and standards versions are emitted in each production state. `production/policy.js` is the canonical release policy; `production/http.js` classifies and guards the Express routes. No parallel renderer was introduced.

## Pre-commit remediation (2026-10-03)

The original 107/19 validation predates the four-finding remediation. It is preserved unchanged in `validation.md` and its original logs. Current remediation evidence and static self-review are recorded in [remediation.md](remediation.md); these protections must not be attributed to the earlier test run.

QA authority now comes from the `qaRecorder(candidate)` callback passed directly to existing `runCatalogQA`. Each gate progresses NOT_RUN → RUNNING → PASS/FAIL. B can start only after A passes; recorded failures cannot be replaced. Records include candidate generation and SHA-256. `release(qa)` reads these records; its argument is only a consistency/approval summary and cannot create or upgrade gate authority.

Abort is terminal, including when analysis is in flight. Source establishment and identity lock creation are single-use. Product Truth cannot restart after locking; renderer authorization cannot be replaced. Each render begins a new generation and revokes prior capabilities. Macro verification, finish verification and QA bind to the same generation/digest. Process-local capability validity also checks a revocation epoch, so old authority cannot revive after abort, a later release decision, or another generation (even with identical bytes). Serializing the public state never serializes the capability.

Product Truth's existing observation fields now come only from RAW analysis. `declared_metadata` retains filename category/material/karat with `source: filename` and `verification: UNVERIFIED`; `metadata_conflicts` identifies differing observed category/material and blocks the lock. Declarations are not sent to the RAW evaluator, renderer assertions or QA criterion selection as facts. Karat stays null/unknown in observations, even if a stamp is visible: this pipeline has no assay verification. Filename parsing and SKU extraction remain. This deliberately replaces legacy filename precedence, which could falsely promote declarations to observed facts.

Gemstone presence/count must be consistent: false requires known zero; true requires a known positive integer. Contradictory evaluator facts are rejected before confidence coercion can erase them and checked again by the lock boundary. Unknown count/presence blocks production; source and Product Truth counts must agree without substituted zeros.

## Request and state machine

Keep Input Contract V2: two multipart files `original_raw` and `master_clean_png`, and exactly one `input_manifest` field. Existing byte hashes, decoding, provenance-link checks and immutable input persistence still run before analysis. No single-image compatibility fallback is permitted.

Optional header `X-Gleor-Production` contains JSON with ONLY:

```json
{"transformation":"auto","finish_id":"preserve-source","finish_revision":"1"}
```

Allowed transformations: `auto`, `preserve`, `reconstruction`. Defaults are shown above. Extra keys (including prompts, supplied locks, approval flags and release status), unknown transformations, unknown finishes and incorrect revisions fail closed. Clients cannot submit source observations, locks or candidate comparisons as authoritative evidence. `X-Catalog-Retry-Limit: 0` retains the previous no-retry behavior.

The state sequence is:

```
REQUEST → SOURCE_SUFFICIENCY → PRODUCT_TRUTH → STRUCTURE_CHECK
→ MACRO_PRODUCT_TRUTH_INSPECTION → MACRO_IDENTITY_LOCK
→ PRESENTATION_RECONSTRUCTION_AUTHORIZATION → RENDER
→ MACRO_IDENTITY_CHECK → FINISH_IDENTITY_CHECK → GATE_A → GATE_B
→ RELEASE_GATE → publication manifest / authorized response
```

Stages begin as NOT_RUN. Provider work can be RUNNING; failures become ERROR/FAIL and RELEASE_GATE fails. Only PASS satisfies a required stage. The ONLY successful stage exemption is reconstruction authorization = NOT_REQUIRED for the existing deterministic ring composer. UNKNOWN, REVIEW_REQUIRED, NOT_RUN, ERROR and FAIL never authorize release.

Source inspection is an independent structured analysis of RAW, using the existing OpenAI analysis adapter and schema validation. Product Truth remains the existing RAW-authoritative component. Structure Check validates the source observations against critical Product Truth; Macro Product Truth Inspection records the required visible features; Macro Identity Lock freezes a deep copy with run ID, source SHA-256 and lock SHA-256. These are distinct recorded stages even where they reuse the same RAW observations rather than repeating a provider call.

For rings, the existing native-pixel composer and independent geometry verifier remain mandatory; reconstruction is NOT_REQUIRED. An explicit request for ring reconstruction fails: the policy does not silently substitute a generative ring pipeline. For other current categories the existing GPT Image renderer constitutes reconstruction and requires explicit computed authorization, regardless of prompt text. `preserve` on these categories fails rather than using a generative renderer secretly.

After every candidate, a separate structured RAW/candidate comparison checks ALL locked fields and source finish. A changed/unknown/omitted/duplicate feature or insufficient confidence stops before Gate A. A finish mismatch stops before Gate A. The lock is never changed to fit the candidate. Gate A and Gate B retain their existing floors, critical-failure rules and sequential execution; A failure skips B. A presentation retry remains bounded to one, uses the same Master Clean, and repeats macro, finish and A/B checks. Ring retries remain disabled.

Model analysis is evidence from a probabilistic evaluator, not a mathematical guarantee of visual identity. These local tests establish enforcement and failure handling with synthetic responses; no live visual benchmark or provider schema acceptance is claimed.

## Finish identity contract

The only registered profile is `preserve-source`, revision `1`: preserve the observed RAW hue, texture and reflectivity. Its reference identity is the exact RAW SHA-256. This is an identity/preservation contract, not a new aesthetic color target. Validation result, ID, revision and reference hash are persisted.

No Champagne Rose or other unavailable finish reference is invented or registered. Such requests fail. Adding a target finish requires a reviewed registry entry, immutable actual reference asset/hash, matching comparison implementation, and tests; changing only an ID/version string is insufficient. The current comparator supports source-preservation semantics only.

## Routes and response contract

| Route | Classification | Release behavior |
| --- | --- | --- |
| `/catalog` | PRODUCTION_CAPABLE | Requires entire applicable state machine and publication capability |
| `/hero` | CANDIDATE_ONLY | Existing local processing/validation retained; historical approval labels downgraded |
| `/hero-a` | CANDIDATE_ONLY | Existing PhotoRoom A output is diagnostic candidate only |
| `/hero-b` | CANDIDATE_ONLY | Existing PhotoRoom B output is diagnostic candidate only |
| `/hero-c` | CANDIDATE_ONLY | Experimental beautification never grants production status |
| `/process` | UTILITY_ONLY | Normalized canvas is a non-production candidate/intermediate |

Classification is case-insensitive and normalizes trailing slashes, matching Express routing. Central response handling strips final/approved claims from non-authorized JSON; binary responses carry `X-Gleor-Asset-State: CANDIDATE_ONLY` and `X-Gleor-Release-Gate: FAIL`. Legacy `X-Hero-Status: approved` becomes `candidate_only`. HTTP 200 alone has no release meaning. Legacy rendering semantics are not forcibly converted into catalog processing.

Catalog success includes `production`, `asset_state: RELEASED`, and `final_approval: true` only after release. Failure/review responses explicitly deny publication. Candidate artifacts may be returned on request but are labeled as candidates; their metadata key is `candidate_metadata`, not `final_metadata`. Errors omit raw provider bodies. Middleware is installed before parsers; parser failures are also non-production responses.

This layer is production-state authorization, not user authentication, billing protection or a substitute for infrastructure access controls. Candidate endpoints can still incur their existing provider costs when deliberately invoked with configured credentials. No live endpoints were invoked during validation.

## Persistence and publication

RAW/Clean persistence remains immutable. Output bundles now use unique paths:

- released: `outputs/<sku>/<unique-run-directory>/final.png`
- non-approved: `renders/manual/<sku>/<unique-run-directory>/candidate.png`
- failed runs: `renders/manual/failed-runs/<production-run-id>/production-state.json`

SKU path components are validated. New output files use exclusive creation and read-only file mode. No old files or outputs are migrated/deleted. A later failure or review candidate cannot overwrite an earlier release.

A process-local capability binds release to the exact verified candidate SHA-256. Serialized PASS JSON, a caller-supplied verdict, or a copied capability object cannot authorize the writer. `release.json` is written LAST and identifies the final bytes and complete state. A partial directory without this manifest is not a published asset. Storage failure aborts the response authorization. An authorized response is certified in process; arbitrary JSON containing PASS cannot certify itself.

These guarantees concern application writes, not filesystem administrators editing files or third-party consumers ignoring the release contract. Downstream consumers must require the release manifest/explicit authorization; their deployment is outside this change.

## Changes to existing behavior

| OLD | NEW | WHY |
| --- | --- | --- |
| A/B approval alone drove final storage | All required v2 stages plus A/B drive release | Prevent missing upstream/finish authority |
| `/hero` could report approved | Candidate-only JSON and binary headers | Its local checks do not establish v2 compliance |
| Fixed per-SKU final filenames | Exclusive, unique per-run candidate/release bundles | Prevent overwrite and candidate/final confusion |
| Missing completeness defaulted true; missing gemstone presence false | Explicit null/UNKNOWN; critical uncertainty blocks | Do not fabricate product truth |
| All artifact metadata called final_metadata | Failed/review artifact metadata called candidate_metadata | Candidate is not final |
| Server listened on import | Export actual app; listen only as executable entrypoint | Exercise real Express wiring locally without production side effects |
| 3 catalog analyses on successful first pass | 5: source, truth, comparison, A, B | Independently assess required identity and finish |

A successful ring uses 5 analyses and zero image-provider calls; a successful non-ring uses 5 analyses plus one image edit. One eligible non-ring retry adds comparison/A/B plus one image edit (at most 8 analyses and 2 logical image edits). Existing normal image-SDK transport retry behavior remains unchanged; the zero-retry header disables it. No analysis transport retries were added.

## Validation

Run `npm test`. The test script preloads `tests/helpers/network-guard.cjs`, which denies external provider transports while allowing loopback HTTP. Original tests retain their renderer/QA/Input-V2 scope using an explicit test-only policy fixture; production tests independently exercise the REAL policy, schemas, coercers, writer and Express source, with provider transport/render boundaries mocked. The fixture is never imported by application code.

For reproducible recorded HTTP evidence:

```
GLEOR_HTTP_EVIDENCE=docs/production/http-validation.json node --require ./tests/helpers/network-guard.cjs --test tests/production-http.test.js
```

Only synthetic local fixtures are used. The tests create temporary stores, close their loopback servers, and remove only their own temporary stores. The evidence records request options, transitions, result, and mocked analysis names without credentials or image payloads. `validation.md` records the latest local run and its limitations. Nothing is deployed, committed, merged or pushed by this implementation.
