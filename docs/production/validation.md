# Runtime 2.0.0 local verification

Verified 2026-10-03 against the working-tree implementation based on main `1e131974d0c7913ecf0adaeca32b0ea1b4238103`. No commit or deployment was made.

- Full suite: **107 passed, 0 failed, 0 skipped**. See `test-results.txt`.
- Separately executed loopback HTTP suite: **19 passed, 0 failed, 0 skipped**. See `http-validation.txt` and machine-readable `http-validation.json`.
- External provider calls: **0**. HTTPS/provider transport was denied globally in test processes; the analysis boundary used synthetic structured replies and generative/PhotoRoom boundaries were stubbed. Real local Express, multipart parsing, input validation, Sharp ring processing, policy and storage executed.
- Git diff whitespace check: PASS.
- Original 21 untracked files: all byte-identical by starting/ending SHA-256. See `preserved-untracked.json`.
- Branch and starting HEAD unchanged. Implementation remains unstaged/uncommitted.

## Coverage and scope

The 57 original tests retain their pre-v2 isolation boundary through `tests/helpers/legacy-policy-fixture.js`; this fixture is not loaded by production. The new tests independently exercise actual source files, shared policy, structured-output schemas and release-capability enforcement. All test storage is temporary.

The 31 new policy/integration tests cover insufficient source, missing lock, request injection, identity changes/unknowns, finish identity and revision, A failure skipping B, B failure, provider and schema errors, critical UNKNOWNs, nonpassing release states, forged capabilities, overwrite protection, preservation NOT_REQUIRED, all earring field-family wiring and revalidation of a retry.

The 19 recorded HTTP cases cover:

- insufficient reconstruction and injected authorization;
- structural identity mismatch;
- unknown finish and wrong revision;
- Gate A and Gate B failure;
- review candidate with artifact retrieval;
- every alternate route plus a case/trailing-slash variant;
- candidate-only binary output;
- successful preservation release and successful reconstruction release;
- malformed request handling;
- successful legacy `/hero` processing with its historical approval header downgraded.

Evidence records no credentials or customer image data. Successful tests demonstrate software enforcement, not live provider quality. No claim is made that a real visual evaluator can never misclassify jewelry. Only the registered source-preservation finish is supported; unavailable named reference finishes remain blocked by design.

## Behavior verification

A/B criteria and renderer selection were retained. The new pre/post checks surround them. In successful preservation, reconstruction authorization is explicitly NOT_REQUIRED. In successful mocked reconstruction, it is PASS only after sufficient RAW observations, Product Truth, structure assessment and immutable lock. Both paths require macro/finish checks, A/B, release evaluation, exact-byte publication capability and final release manifest.

Failed states retain machine-readable reasons and never gain release authority. A serialized PASS object fails the writer capability test. A later failed candidate writes a distinct candidate directory and does not alter the previous released PNG. Unknown product completeness/presence remains null and blocks required production decisions.

## Readiness

The central enforcement implementation is locally verified and ready for code review. Production deployment, downstream-consumer migration, authentication/infrastructure review, live visual benchmarks, and registration of real named finish references were not performed or implied by this result.
