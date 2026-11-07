# CLU-E Project Profiles — Batch 6 Backend API, CLI and Configuration-v3 Cutover

**Document class:** implementation receipt and operating boundary  
**Batch:** 6 of 8  
**Patch scope:** PP-29 through PP-31, plus the coordinated Configuration-v3 startup selector deferred from the runtime batches  
**Architecture scope:** post-P2 Project Profiles  
**Activation state:** implementation only; extraction performs no migration, adoption, activation, provider call, browser launch, Git synchronization or P2 ceremony

## 1. Purpose

Batch 6 turns the Project Profile foundations from Batches 1–5 into an operable, server-authoritative
control plane. It adds:

- a versioned backend API;
- CLI operations for creation, validation, readiness, connection tests, migration and activation;
- an explicit Configuration-v3 startup selector;
- byte-exact legacy-configuration backup and reversible startup cutover;
- compatibility normalization across the profile record/store/registry contracts used by the
  preceding batches.

The browser remains a client. It cannot become the authority for identity, uniqueness, persistence,
activation, readiness or secret handling.

## 2. PP-29 — Project Profiles API service

`src/daemon/projectProfilesApi.ts` owns the Project Profile HTTP contract:

```text
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects
PUT    /api/projects/:id
DELETE /api/projects/:id

POST   /api/projects/:id/activate
POST   /api/projects/:id/validate
POST   /api/projects/:id/test-host
POST   /api/projects/:id/test-git
POST   /api/projects/:id/test-chrome
POST   /api/projects/:id/test-gpt

GET    /api/projects/:id/readiness?operation=<operation>
```

The service enforces:

```text
strict profile schema
canonical Target Root identity
Project ID and physical-root uniqueness
optimistic generation checks
project/profile preconditions for activation
profile-only deletion with a state-bound phrase
active-project deletion refusal
request-size limit
request and response secret scanning
structured refusal codes
```

A live HTTP activation is refused when the dashboard does not own an atomic `ProjectRuntimeManager`
switch seam. This prevents the registry from saying Project B while the live Runtime and page still
serve Project A.

HTTP request bodies cannot nominate the durable mutation actor. The actor is fixed by the trusted
server-side service instance.

## 3. PP-30 — dashboard-server integration

`src/daemon/clueDashboardServer.ts` delegates `/api/projects...` to the API service after the existing
host, Origin and bearer-token exposure checks. The router contains no profile persistence or
canonicalization logic.

The existing `/api/config` meaning remains intact and receives one versioned `projectProfiles`
branch containing:

```text
API version
registry root
runtime profile mode
active registry pointer
```

The legacy single-runtime dashboard does not pretend it can perform a truthful live switch. Batch 7
may provide the atomic runtime-manager callback when it installs the complete Configuration UI.

## 4. PP-31 — CLI control plane

The following commands are available before the browser UI:

```text
clue project list
clue project active
clue project show <id>
clue project create --file <draft.json>
clue project update <id> --file <draft.json> --expected-generation <n>
clue project delete <id> --expected-generation <n> --confirmation <phrase>
clue project validate <id>
clue project readiness <id> --operation <name>
clue project test-host <id>
clue project test-git <id>
clue project test-chrome <id>
clue project test-gpt <id>
clue project activate <id> --confirmation <phrase>
clue project migrate-legacy --confirmation "MIGRATE LEGACY ACTIVE TARGET"
clue project adopt-legacy <id> --confirmation <phrase>
clue project cutover-v3 <id> --confirmation <phrase>
clue project rollback-v3 --confirmation "DISABLE PROJECT PROFILE STARTUP"
```

Profile drafts are strict JSON. Raw credential material is rejected. CLI output is scanned before
printing and exposes credential references only.

## 5. Configuration-v3 startup selector

Legacy startup remains the default while this file is absent:

```text
config/project-profiles.yaml
```

The selector is created only by the explicit cutover command. Cutover requires the exact current
profile hash, activates the requested durable profile, writes a byte-exact backup of
`config/clue.config.yaml`, writes the selector atomically and re-reads the resulting active identity.

Conceptually:

```text
migrate legacy target
→ adopt existing workspace explicitly
→ validate profile and integrations
→ CUTOVER <projectId> <profile-hash-prefix>
→ back up configuration-v2 bytes
→ activate profile generation
→ write Configuration-v3 selector
→ verify active profile identity
```

Rollback removes only the selector. It does not remove Project Profiles, workspace ownership,
recognition state, proof history, Great Book history, the target repository or the configuration-v2
backup.

## 6. Compatibility normalization

Batches 3–5 use the final behavior-profile plus durable-record envelope. Batch 6 normalizes the
foundation modules to that contract:

```text
ProjectProfile                 behavior-bearing clue-project-profile/1
ProjectProfileRecord           generation/timestamps/profile:v1 hash envelope
Target Root identity           path:v1:<platform>:<sha256>
Project Operation Identity     projectId + Target Root identity + profile hash
```

The compatibility work removes no invariant. It preserves deterministic hashes, raw-secret
rejection, exact physical Target Root checks, registry transactions, hash-chained events and legacy
migration evidence.

## 7. Safety boundary

Applying this patch does not:

- change `config/clue.config.yaml`;
- create `config/project-profiles.yaml`;
- create, migrate, adopt, activate or switch a Project Profile;
- write to `F:\CLU\workspace\clue` or `F:\CLU\shadow\clue`;
- launch PowerShell or Chrome;
- contact OpenAI;
- read or write raw API-key bytes;
- synchronize Git;
- modify the Metric Catalogue;
- modify the Q1/SURF application;
- ratify P2 documents, open `P2-authoritative`, execute proof or close P2.

The live migration/adoption/cutover sequence remains an explicit operator action after Batch 7
provides the complete Configuration surface.
