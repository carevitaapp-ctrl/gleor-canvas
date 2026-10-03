# Runtime 2.0.0 finalization validation — 2026-10-03

Base: main at `1e131974d0c7913ecf0adaeca32b0ea1b4238103`.

This record follows final pre-commit audit. Historical 107/19 and 138/22 evidence is retained unchanged. Runtime, Core Visual Rules and Earring Production Standard remain 2.0.0.

## Final hardening

`tests/helpers/network-guard.cjs` now accepts Node's normalized options/callback array as well as object, positional-port and local IPC forms. It validates TCP ports/destinations, permits 127.0.0.1 and ::1, and pins localhost to 127.0.0.1. Unsupported destination forms fail closed. Unix/Windows local IPC remains allowed. HTTPS/TLS remain denied. Focused tests use actual loopback TCP/HTTP and stub the underlying transport for external TCP/HTTP probes; no real external requests are made. The native net.connect normalized-array path is explicitly exercised.

`production/policy.js` requires finish ID/revision strings before registry selection and uses Object.hasOwn for registry membership. Arrays, objects, numbers, booleans and null are rejected before provider work. Unknown/inherited string names remain rejected; valid strings traverse the real catalog orchestration with mocked provider boundaries and release successfully.

## Results

- Focused hardening tests: 20 passed, 0 failed/skipped (`finalization-focused-tests.txt`).
- Complete suite: 158 passed, 0 failed/skipped (`finalization-full-tests.txt`).
- Separate actual loopback HTTP suite: 22 passed, 0 failed/skipped (`finalization-http-tests.txt`, `finalization-http-validation.json`). These 22 are included in the 158, not additional unique tests.
- Provider calls: 0; provider transports/renderers are mocked and the corrected guard is preloaded.
- git diff --check: PASS.
- Original unrelated untracked files: all 21 match their recorded original SHA-256; see `finalization-preserved-untracked.json`.
- Source hashes: `finalization-source-sha256.json` captures the final runtime/test source.

Commands:

```
node --require ./tests/helpers/network-guard.cjs --test tests/final-hardening.test.js
npm_config_update_notifier=false npm test
GLEOR_HTTP_EVIDENCE=docs/production/finalization-http-validation.json node --require ./tests/helpers/network-guard.cjs --test tests/production-http.test.js
git diff --check
```

The first focused attempt identified Node's null no-callback representation. Normalization was corrected before the passing runs above.

## Commit scope and limitations

The intended commit comprises 17 modified tracked files and 33 new runtime, test, documentation and evidence files (50 total). The original 21 experimental/unrelated untracked files are excluded. No dependency installation or deployment is part of finalization. This record documents pre-commit validation; commit/push identity is verified separately after those operations, not predicted here.

Live visual accuracy, live provider schema acceptance and downstream deployment compatibility remain unverified. Parent-directory symlink hardening and crash-durable publication remain outside this change. Git publication is not a deployment validation. Deployment settings and any external automatic deployment behavior are not managed by these patches.
