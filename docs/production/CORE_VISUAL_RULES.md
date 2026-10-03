# Core Visual Rules 2.0.0

New implemented contract on the verified Gleor mainline; not a recovered historical standard. Canonical enforcement: `production/policy.js`, with RAW analyses in `production/inspection.js` and strict schemas in `catalog/analysisSchemas.js`.

1. ORIGINAL RAW is structural and finish authority. Master Clean is an immutable renderer input, never independent truth. Client-declared hash lineage is not proof of visual derivation; RAW comparison and existing Gate A remain necessary.
2. Completeness must be observed, not inferred. Source completeness must be true with confidence >= 0.95. Product Truth completeness must be true with confidence >= 0.85. Unknown gemstone presence/count for a product with stones blocks production.
3. Source sufficiency is typed: SUFFICIENT_FOR_PRESERVE, SUFFICIENT_FOR_RECONSTRUCTION, INSUFFICIENT; non-production route state uses NOT_APPLICABLE. Preserve still requires known visible silhouette, proportions and exact visible stone count. Every category additionally records metal thickness family. Earrings add the full earring field family.
4. Each required observation is KNOWN (value plus visible evidence), NOT_VISIBLE (null value plus explicit occlusion/inapplicability reason), or UNKNOWN. Confidence must be within [0,1]; accepted observations require >= 0.95. UNKNOWN never passes. NOT_VISIBLE cannot support reconstruction. This conservative policy may reject otherwise useful sources; it must not guess.
5. Visible stone count uses a nonnegative decimal integer string and must agree with Product Truth. Features describing spacing, curvature, proportions and relationships must describe the visible source, not ideal symmetry or a desired design.
6. Macro inspection is persisted separately from structure assessment. The immutable per-run lock binds required observations to RAW SHA-256 and a run ID. It cannot be supplied by an HTTP caller or silently revised.
7. Structural tolerance is zero: exact visible count/topology and unchanged visible relative size, spacing, rhythm, shape and relationships. Descriptive fields use categorical MATCH/MISMATCH/UNKNOWN comparison against RAW and the lock; no aesthetic improvement offsets structural failure. This is evaluator-based evidence, not calibrated metrology. Numeric nonzero tolerances are NOT introduced.
8. Candidate comparison must contain exactly one result for every locked feature, confidence >= 0.95, evidence, and MATCH. Inventing newly visible features where the lock recorded NOT_VISIBLE is a mismatch. Unknown/missing comparison cannot pass. Deterministic ring geometry verification remains an additional pixel-level requirement.
9. Finish ID/revision must resolve to the registered source-preservation profile. Reference RAW SHA-256 and comparison result are recorded. No absent finish target can be invented. Hue, texture and reflectivity identity must remain; presentation lighting alone may change.
10. Existing Gate A/B thresholds and critical-deviation rules remain. A failure blocks B and release. All applicable v2 gates must pass; reconstruction authorization is explicitly NOT_REQUIRED only for the deterministic ring path.
11. Candidate generation, HTTP success and QA success are not publication authority. Only RELEASE_GATE PASS plus the exact-byte capability permits a released bundle/response. Publication manifest is written last. Diagnostics are not FINAL/FINAL_LOCKED/APPROVED/PRODUCTION_READY/RELEASED.

See `README.md` for route downgrades, storage, error behavior and migration details.

## Pre-commit remediation clarification (2026-10-03)

The pre-commit review exposed enforcement gaps; the following rules are implemented by the remediation, not proven by the original validation:

- QA transitions are candidate-generation/digest bound and monotonic. Release reads recorded A/B outcomes and never overwrites them from a summary.
- Abort is terminal. Source and lock establishment are single-use. Generation changes and release decisions revoke old capability epochs permanently.
- Observed Product Truth is separate from provenance-labelled, unverified filename declarations. Category/material conflicts block locking; karat declarations never become visually verified facts.
- Presence=false/count>0 and presence=true/count=0 are invalid Product Truth. Production requires known consistent counts; no missing count is silently replaced with zero.

See `remediation.md` for current tests and the four-finding static self-review.
