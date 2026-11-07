# Project Profile Storage Decision

**Decision:** dedicated CLU-E-owned profile control-plane root  
**Proposed Windows root:** `F:\CLU\profiles`  
**Record schema:** `clue-project-profile-record/1`

## 1. Selected layout

```text
F:\CLU\profiles\
├── registry.json
├── profiles\
│   ├── clu.json
│   └── <projectId>.json
├── events\
│   └── profile-events.ndjson
├── .transactions\
│   └── PROFILE-TX-<uuid>.json
└── .locks\
```

The layout is outside every target repository, project workspace and shadow checkout. Physical zone
overlap is refused after realpath/junction resolution.

## 2. Why a dedicated root

Project Profiles are installation control-plane data, not target source and not one target's proof
history. Placing the registry inside `F:\CLU\workspace\clue` would make the CLU target own the
selector for every future target. Placing it inside the CLU repository would expose mutable runtime
state to Git and recognition.

Each profile instead points to a separate project workspace, for example:

```text
F:\CLU\workspace\clue
F:\CLU\workspace\murugan
```

A separate workspace per project provides the safest isolation boundary for the existing event log,
SQLite projections, artifact store, graph, Great Book, recognition and proof services.

## 3. Three distinct hashes

Every stored profile record contains:

- `projectProfileHash` — complete behavior-relevant profile configuration identity, including
  disabled governed-document bindings;
- `authorityBasisHash` — active project authority identity; disabled governed documents do not
  enter this basis until enabled;
- `recordIntegrityHash` — integrity of the complete durable profile record, including display/audit
  fields that intentionally do not move behavior identity.

`projectProfileHash` excludes generation, audit timestamps, display label and current runtime
references. It includes credential references but cannot include secret bytes. Revalidating
unchanged authority bytes does not move identity merely because `lastValidated` changed.

Global defaults are resolved when a draft is saved. The resulting effective value and its
`global-default` provenance are stored in that generation. A later installation-default change
does not silently reinterpret or invalidate old durable bytes; applying the new default requires
an explicit successor profile generation. Even an explicitly stored null remains a stable snapshot
until such an update.

## 4. Durable write model

A profile write follows:

```text
exclusive lock
→ validate strict schema
→ canonicalize
→ write unique temp file
→ fsync temp file
→ atomic no-replace/create or replace
→ fsync parent directory
→ release lock
```

Updates use optimistic generation checks. A stale caller receives `GENERATION_CONFLICT`; committed
bytes remain unchanged.

Registry create/delete operations use a transaction journal so profile and registry visibility can
be completed after a crash. Every registry operation performs recovery before starting a new write.

## 5. Registry authority

`registry.json` is the authoritative set of visible profiles. It enforces:

- unique canonical Project ID;
- unique physical Target Root identity;
- canonical profile path `profiles/<projectId>.json`;
- active pointer references only a registered project;
- registry/profile target identity parity.

An orphan profile file is never silently adopted. A registered profile that is missing, malformed,
hash-invalid, or no longer resolves to its physical target fails integrity verification.

## 6. Event log

Profile authority events use strict machine fields only and a hash chain:

```text
project-profile.created
project-profile.updated
project-profile.activated
project-profile.validation_failed
project-profile.deleted
project-authority.changed
```

Each event binds transaction ID, project identity, old/new generation, old/new hashes and registry
generation. Free-text secrets, credentials and arbitrary payloads have no schema location.

## 7. Deletion semantics

Deletion requires an exact confirmation:

```text
projectId = <exact id>
deleteProfileDataOnly = true
```

The store can delete only a profile record under its own `profiles` directory. Target repositories,
project workspaces and shadow roots are not descendants of this service and are never removed.

## 8. Rejected alternatives

- **Profiles inside target repositories:** mixes CLU-E installation state with target source.
- **Profiles inside the active workspace:** makes one project own global selection state.
- **One unpartitioned shared workspace/database:** high risk of Great Book, proof and recognition
  leakage.
- **Browser-local persistence:** frontend cannot enforce physical root uniqueness or durability.
- **Raw credential storage:** prohibited; only external credential references are accepted.

## 9. Batch boundary

Batch 1 supplies storage primitives only. It does not activate a project, switch runtime services,
open a project database, expose HTTP endpoints, or modify Configuration UI. Those operations must
use the later atomic switching/runtime layers.
