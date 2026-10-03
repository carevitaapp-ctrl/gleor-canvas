# Persistent data root — local implementation, pending review

All catalog writes and release reads use production/storage.js. The release-store
algorithm, policy, strict JSON and provider contracts are unchanged.

Production is the default, including unset/unrecognized NODE_ENV. Only explicit
NODE_ENV=development or test enables an isolated temporary default. Any RENDER
variable forces production checks even if NODE_ENV says test. Configured roots
are never sourced from requests. Configured invalid roots never use the default.

Production requires both GLEOR_DATA_MOUNT and GLEOR_DATA_ROOT pointing to
existing canonical absolute directories. The root may equal the mount or be a
strict descendant; equal roots must satisfy the same ownership/mode checks. Provision that application directory deliberately during a separately
authorized deployment; this application never creates a missing configured root.
Root/descendants must be owned by the runtime UID, owner-readable/writable/
searchable and not group/world writable. Ancestors reject symlinks and unsafe
write permissions; sticky shared ancestors are allowed outside the data root.

Inputs, outputs and renders/manual are created with private permissions below
that root. Startup verifies directory identity, permissions, same device, and
exclusive file creation, file/directory fsync, no-follow reads and no-overwrite
hard links using disposable .preflight-* files within outputs. Cleanup is part
of successful preflight. Failures latch not-ready for that process. Required
paths/identities are rechecked at request and writer boundaries. Dynamic input
and manual directories receive the same containment/trust checks.

Production requires Linux mountinfo to contain exactly the configured mount point
with ext4/xfs/btrfs backing. A supported ancestor such as /var cannot satisfy a
configured /var/data mount. Root must be contained beneath that exact mount;
symlinks, nested mounts intersecting the root, and mount identity changes fail
closed. Root and managed directories must remain on the same device. Production
on non-Linux hosts fails closed. Explicit local test/development modes use
isolated storage without reading /proc; presence of RENDER disables that bypass.
This verifies the configured boundary, not provider billing or physical durability.

Future Render configuration (NOT applied):

```
GLEOR_DATA_MOUNT=/var/data
GLEOR_DATA_ROOT=/var/data/gleor
NODE_ENV=production
```

Render disk mount path: /var/data. Provision /var/data/gleor before application
start with service UID ownership, owner rwx and no group/world write permissions.
The mount and root must already exist. Environment variables alone are insufficient.
Staging stays inside outputs/<sku>, on the publication filesystem.

GET /health stays HTTP 200 for process liveness, adding alive:true and storage
{configured,ready}. It performs read-only checks and returns no filesystem paths
or errors. A failed startup still permits health reporting but every protected
processing POST returns 503 before parsing uploads or calling providers. Render
/health alone is therefore liveness, not a storage readiness approval: controlled
validation must check storage.ready explicitly. PhotoRoom is never required for
storage readiness or the catalog contract.

No historical import or metadata rewrite is performed. Legacy candidates cannot
become releases through configuration. Do not deploy or push this implementation
until review and separate storage/deployment authorization. Keep auto-deploy off.

Trust boundary remains a service-owned filesystem. Portable pathname APIs do not
protect against a hostile same-UID/root process replacing paths between checks.
Health checks do not guarantee future free space or repeat the write probe.
