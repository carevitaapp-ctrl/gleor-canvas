# Pre-commit remediation — 2026-10-03

Repository: `/Users/gulizarcekcen/gleor-canvas`, main at `1e131974d0c7913ecf0adaeca32b0ea1b4238103`. All work remains uncommitted. Runtime and standards remain 2.0.0. No provider calls, deployments, dependency changes, or Git mutations.

The earlier 107-test/19-HTTP evidence remains unchanged and describes the pre-remediation implementation. This record is new evidence for the four review findings.

## Files changed by this remediation

Modified:
- production/policy.js
- catalog/index.js
- catalog/productTruth.js
- catalog/constants.js
- catalog/promptBuilder.js
- catalog/metadataParser.js (comments only)
- prompts/product-truth-system.txt
- tests/catalog-openai-analysis.test.js
- tests/helpers/legacy-policy-fixture.js
- tests/production-http.test.js
- docs/production/README.md
- docs/production/CORE_VISUAL_RULES.md

Added:
- tests/production-remediation.test.js
- docs/production/remediation.md
- docs/production/remediation-focused-tests.txt
- docs/production/remediation-full-tests.txt
- docs/production/remediation-http-tests.txt
- docs/production/remediation-http-validation.json
- docs/production/remediation-preserved-untracked.json
- docs/production/remediation-source-sha256.json

## Fresh static self-review

1. RELEASE_GATE — FIXED. `ProductionRun.release()` no longer sets GATE_A/B. It checks recorded prerequisite states, each post-render record's candidate generation/digest, and consistency with the non-authoritative QA summary. `qaRecorder(candidate)` enforces NOT_RUN → RUNNING → PASS/FAIL and A before B. The existing catalog QA receives this callback for each candidate, including retries. No request field installs gate authority. R1–R7, R20, R23 and R26 exercise prepared-run bypass attempts and the actual QA path.

2. LIFECYCLE — FIXED. A private aborted flag is terminal and checked before every authority mutation and after asynchronous inspection/comparison. Source establishment is single-use, lock replacement is rejected, completed Product Truth cannot restart, and authorization is single-use. Each render advances the generation and revocation epoch. Capabilities close over their owning run plus generation, digest and epoch; abort/re-evaluation/new generation cannot revive an old capability. Candidate bytes are privately copied before comparison; recorder callbacks reject changed bytes or stale generations. R8–R13, R21–R22 and R25–R28 cover these invariants, including identical bytes across different generations and in-flight aborts.

3. PRODUCT TRUTH AUTHORITY — FIXED. Product Truth no longer injects filename declarations into the evaluator or merges them over observations. Commercial category/material/karat remain separately provenance-labelled UNVERIFIED in declared_metadata. Observed category/material come from RAW analysis, and observed karat remains null. Conflicting declared/observed category or material prevents lock creation. Prompt material/lighting selection requires observed provenance and no karat assertion is emitted. QA receives the observed fields, not declared overrides. R14–R16 cover conflict, unverified karat, analysis/prompt isolation and QA applicability; an added real HTTP case verifies rejection before comparison/rendering.

4. GEMSTONE CONSISTENCY — FIXED. Contradictory raw evaluator presence/count pairs throw INVALID_PRODUCT_TRUTH before count-confidence coercion. The policy independently requires false/zero or true/positive integer and compares that retained count directly to source without substituting zero. Unknown critical identity still blocks locking. R17–R19 exercise both boundaries and null cases; two additional HTTP cases verify explicit denial and absence of a lock.

The callback is an internal application API, not protection against arbitrary code execution inside the server process. Existing trusted catalogQA remains responsible for deriving gate outcomes from validated evaluator output.

## Validation

- Focused: `node --require ./tests/helpers/network-guard.cjs --test tests/production-remediation.test.js` — 28 passed, 0 failed/skipped.
- Full: `npm_config_update_notifier=false npm test` — 138 passed, 0 failed/skipped.
- Actual loopback: `GLEOR_HTTP_EVIDENCE=docs/production/remediation-http-validation.json node --require ./tests/helpers/network-guard.cjs --test tests/production-http.test.js` — 22 passed, 0 failed/skipped. The 22 are included in the full 138; this is a separate repeat, not additional unique tests.
- Provider calls: 0. Analysis transport and generative/PhotoRoom boundaries are mocked; the preload guard is enabled. R24 verifies HTTPS/TLS calls are rejected. Real local Express, parsing, policy, filesystem storage and ring Sharp processing execute.
- `git diff --check`: PASS.
- Original 21 untracked files: 21/21 current SHA-256 values match their original recorded starting values.
- Branch and HEAD unchanged; final diff/status inspected.

An initial full-suite attempt had 112 passes and 19 listener EPERM failures because the sandbox denied loopback listening. After network permission was granted, all tests passed. Later added lifecycle/HTTP cases bring the final counts to 138/22. No provider calls were needed to resolve the environment restriction.

## Compatibility and remaining limits

Filename parsing/SKU extraction remain, but declarations no longer override RAW observation. This intentional authority correction can reject previously accepted conflicting filenames. Unknown counts now block even for declared stone absence. Existing Input Contract V2, ring geometry tests, QA thresholds and renderer implementations remain intact. The old isolated regression harness only gains the new no-op callback shape; real enforcement is covered by production tests.

Mocked visual assessments do not prove live visual accuracy or provider schema acceptance. Filesystem-administrator tampering, parent-directory symlinks, crash durability and downstream consumer migration remain outside this focused remediation. No named finish reference was invented. No remaining blocker was found against these four findings during static self-review.

Ready for final independent pre-commit review; no commit or deployment performed.
