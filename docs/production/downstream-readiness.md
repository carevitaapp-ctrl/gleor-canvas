# Downstream publication hardening (local, uncommitted)

Base: main, 1abac9e2cb2167f7220fbee3edd3a7795749a193. Runtime, Core Visual Rules,
Earring Production Standard remain 2.0.0. This work does not deploy or validate live providers.

## Discovered path

`ProductionRun.release()` live, candidate-bound capability → `catalog/writer.js`
→ `production/release-store.js` → `outputs/<sku>/<production.run_id>/release.json`
→ `readReleased()` → catalog pipeline and Express JSON response.

The catalog response is the repository-controlled downstream consumer: it now revalidates
persisted publication after writing and again immediately before response certification,
returns the release manifest, and takes returned image bytes from the validator.
`production/http.js` still independently requires the live process-local release capability.

No tracked static asset route, uploader, deployment workflow, or independent production
publisher was found. No local `.github` directory exists. `render.yaml` describes a Node
web service (`npm install`, `npm start`), without an explicit auto-deploy setting. Actual
Render account settings, GitHub-hosted configuration and external automation were not queried.
External n8n callers are mentioned in migration comments but their implementation is absent.
No evidence establishes the final external public product-image path.

`/hero`, `/hero-a`, `/hero-b`, `/hero-c` remain candidate-only; `/process` remains utility-only.
`bench-ab.js` saves benchmark hero images/reports; `scripts/compose-ring-local.js` saves local
composition/debug files. Neither emits a release manifest or is a production consumer.
Legacy/untracked scripts are not wired into this application and were not changed.
No filename, historical approval, or manual-review output qualifies as a release.

## Consumer contract

Use `catalog/writer.readReleased(sku, runId)` for this application's fixed release root.
Future local consumers may call `consumeRelease({root, sku, runId})` with a trusted,
server-configured absolute canonical root. Never obtain root/path from an HTTP caller.
Use the returned Buffer for upload/serving; do not validate then reopen a filename.

Manifest contract version 1 binds SKU, production run, fixed `final.png` identity,
SHA-256 and length of all five required bundle files, production authorization and every
required gate, candidate generation/digest, and exact 2.0.0 runtime/standard versions.
QA and final metadata must also approve the same run/candidate; final metadata must match SKU.
Strict parsing rejects duplicate decoded object keys at every nesting depth (including arrays),
including escaped-equivalent and identical-value duplicates in manifest, QA and metadata JSON.
Missing/malformed manifests, incomplete bundles, different versions, unexpected filenames,
traversal, symlinks and mismatched bytes fail closed. Previous minimal release manifests
lack this contract and are deliberately rejected; no automatic approval/migration is provided.
RAW/Clean input paths in metadata are provenance references, not additional public assets.

A JSON manifest is NOT a cryptographic signature or a portable release capability. Its
provenance depends on the service-owned trusted storage root. A root supplied by an attacker
or a downloaded manifest cannot establish authorization. Off-host consumers must establish
trusted transport/provenance and apply equivalent validation before publishing. No such
external consumer is configured or verified by this task. Untrusted/off-host manifest consumption
is not authorized by this design. A boundary test explicitly demonstrates that coherent local
forgery can satisfy persisted consistency without possessing a live Runtime capability.

## Filesystem publication

* Canonical absolute paths and safe SKU/UUID names only. Inspect every directory component
  with lstat, reject symlinks, require non-writable ancestors (sticky shared temp ancestors
  are allowed), and owner-controlled, non-group/world-writable release root/SKU/run directories.
  Pin and recheck directory device/inode identities. Open files with O_NOFOLLOW; require
  regular files. Unsupported no-follow/directory-open primitives fail closed.
* New directories use 0700; exclusive immutable file creations use 0444. Copy incoming
  buffers before I/O; recheck the live release capability against final bytes.
* Write five files and manifest in hidden staging; fsync each file and staging directory.
  Reserve the final run directory using exclusive mkdir; collision, including an empty
  directory, fails. Hard-link required files without replacement and sync destination/parent.
  Re-read and compare exact published bytes, then atomically link `release.json` LAST.
  Sync destination and parent again, validate the complete release, then return success.
  Atomicity means manifest-based bundle eligibility, not invisibility of all file names.
* PRE_COMMIT_CRITICAL errors attempt manifest revocation and staging cleanup, then propagate the original failure. Cleanup failures are attached as explicit error codes; an unavailable filesystem can prevent rollback and requires operator quarantine before consumption.
  Partially reserved destinations remain quarantined without a valid marker; they are never
  reused/overwritten. A killed process can leave staging or incomplete directories, which
  cannot be consumed. No automatic scavenger is introduced.
* DURABLE COMMIT occurs after required asset writes/file syncs, final-byte rechecks,
  exclusive manifest-last publication, destination/parent directory syncs, and persisted
  validation all succeed. POST_COMMIT_HOUSEKEEPING removes staging and syncs that removal.
  Housekeeping errors return committed success with `housekeeping_status: PENDING`,
  `cleanup_pending: true`, and path-free warning codes. They do not revoke authorization.
  The catalog exposes these fields without exposing staging paths. A later response-validation
  failure still denies the HTTP response but does not retroactively abort a durable release.
* Critical file/directory fsync errors fail closed; no silent portability fallback. Tested locally on
  macOS. Deployment filesystem directory-sync/hard-link semantics still require confirmation.
  OS fsync does not certify hardware power-loss behavior; macOS F_FULLFSYNC is not exposed
  by this Node implementation. Network filesystems/Windows are not certified.

Portable Node pathname APIs cannot provide openat-style confinement against an actively
hostile process with the same UID or privileged ability to rename ancestors between checks.
Service-owned directories and trusted ancestors are required deployment preconditions;
this patch is not a sandbox against a compromised service account. A native descriptor-relative
implementation would be required if that threat model must be supported.

## Validation scope

Real release policy, writer, local image composer and Express run in the production harness;
only external provider boundaries are stubbed. The test preload rejects external transports.
Release-store tests inject filesystem errors, tampering and interrupted-state snapshots;
they do not claim physical power-cut testing. Loopback tests verify manifest-bound returned
bytes and denied responses when persisted assets/manifests change before certification.

Older isolated regression suites explicitly mock the new storage boundary, retaining their
existing parser/QA/Input Contract tests. They are not counted as filesystem enforcement evidence.
The new real-storage and HTTP suites supply that evidence. Historical evidence is unchanged.

Review the diff before commit/push. Deployment remains unauthorized. Remaining checks include
external consumer migration and enforcement, live provider/schema/visual validation under
separate authorization, trusted persistent deployment storage, and actual deployment settings.

## Rollback-failure operations

Pre-commit publication errors carry sanitized `publication_failure` diagnostics:
`publication_status: FAILED`, failure category, safe SKU and run ID. Failed manifest
revocation additionally sets `rollback_status: FAILED`, `quarantine_required: true`,
and `code: MANIFEST_REVOCATION_FAILED`. This does not claim successful revocation.
The catalog saves these fields with its failed-run diagnostic and returns only the
sanitized operational fields in its denied response, without released bytes/certification.

If diagnostic persistence fails, the existing application console emits a structured
`RELEASE_ROLLBACK_FAILED` event containing only those safe identifiers/codes; stderr is
attempted if that logger throws. This signal does not depend on release-storage writes.
An operator must quarantine the identified residual run before downstream consumption.
The application does not promise automatic quarantine on an unavailable filesystem.
Post-commit housekeeping warnings never enter this rollback-failure path.
