# CLU-E Project Profiles — Batch 5 Browser, GPT, Readiness and Status

**Document class:** implementation receipt and operating boundary  
**Batch:** 5 of 8  
**Patch scope:** PP-23 through PP-28  
**Architecture scope:** post-P2 Project Profiles  
**Activation state:** implementation only; no profile migration, activation, browser launch, provider call, credential write, or P2 ceremony

## 1. Purpose

Batch 5 closes the remaining runtime-readiness gap before the backend API and CLI become the
operator control plane. It binds browser execution, GPT/model access, project readiness and Status
to one exact Project Profile generation.

The governing identity is:

```text
projectId
+ targetRootIdentity
+ projectProfileHash
+ profileGeneration
```

A browser session, provider call, readiness result or Status branch from another identity is stale
and must be refused rather than merged into the active generation.

## 2. PP-23 — governed browser target

Browser target discovery is deterministic and fail-closed:

```text
1. exact previously selected Page ID
2. exact configured target URL
3. one unique page under an allowed origin
4. otherwise TARGET AMBIGUOUS / TARGET NOT FOUND / ORIGIN FORBIDDEN
```

`BrowserAgent` no longer selects the first allowed tab. Governed attachment requires the Project
Operation Identity, profile generation and deterministic Chrome Instance ID together. Execution is
refused after a session is parked, closed, replaced, disconnected or bound to another project.

The PowerShell launcher owns process creation. It uses one dedicated profile directory, one loopback
DevTools port, one governed target origin and a durable identity state file. It refuses personal
profiles, unrelated endpoints, stale profile identity and process-name guessing.

## 3. PP-24 — browser execution evidence

`BrowserExecutionLedger` stores one immutable request/response pair per governed execution. The
command body is not persisted; only its SHA-256 identity is recorded. Evidence binds:

```text
browserExecutionId
Project Operation Identity
profileGeneration
mission / scenario / proof binding
Chrome Instance ID
Browser Session ID
Target Page ID and URL/origin
Chrome version and debug endpoint
request and response hashes
started/completed timestamps
terminal status
sanitized evidence references
```

Request, response and receipt files are parsed and re-hashed on read. Missing, changed or
cross-project evidence is invalid. A response is terminal and may be written only once.

## 4. PP-25 — browser session switching

Browser publication participates in the same atomic transition as project state and runtime
publication:

```text
park Project A
activate Project B
publish Project B generation
```

If activation fails, Project B is parked and Project A is restored. A failed browser rollback blocks
the runtime manager instead of publishing mixed state. Replacing an active registration is refused
until it is explicitly parked or unregistered, preventing an orphaned CDP session.

## 5. PP-26 — GPT/OpenAI readiness

Project GPT readiness resolves only a credential reference:

```text
env:OPENAI_API_KEY
credential-store:<id>
```

Secret bytes remain process-local. They are not returned in readiness, Status, events, artifacts,
Great Book or profile state. Provider and network errors are redacted before becoming public.

Readiness requires:

```text
provider = openai
requestedModel = effectiveModel
fallbackPolicy = FORBID
fallbackUsed = false
spendAuthority = openai_platform
localBudgetEnforced = false
credentialPresent = true
providerReachable = true
```

A substituted model is `MODEL UNAVAILABLE`, not a fallback. Provider funding exhaustion remains a
controlled durable pause. Gateway calls and terminal projections bind the exact Project Operation
Identity and profile generation, and an in-flight generation change is a terminal refusal.

## 6. PP-27 — operation-specific readiness

The readiness service computes:

```text
READY
READY_LOCAL_ONLY
INCOMPLETE
BLOCKED
INVALID
```

and independent capabilities for recognition, proof, browser benchmark, AI candidate generation,
Git publication and Custodian landing. Optional unavailable integrations do not block unrelated
local work. `NO_REMOTE_YET` remains a valid `READY_LOCAL_ONLY` posture. Invalid authority, identity,
model, origin or benchmark invariants remain `INVALID`.

## 7. PP-28 — Status 5.8.0

Status 5.8.0 adds a strict Project Profile branch and extends Model Gateway facts with:

```text
active Project Operation Identity
profileGeneration
overall readiness
capability readiness
authority state and drift/conflict identity
requested/effective model
credential reference/presence
provider reachability and controlled pause
```

This is an additive wire revision. Historical 5.7.0 snapshots remain 5.7.0 evidence and are not
silently reinterpreted. The seal covers the complete 5.8.0 body.

## 8. Safety boundary

Applying this patch does not:

- edit `config/clue.config.yaml`;
- create, migrate or activate a Project Profile;
- launch, attach to or stop Chrome;
- contact OpenAI;
- write `OPENAI_API_KEY` or any credential bytes;
- write the live workspace or shadow tree;
- synchronize Git;
- begin ratification, open `P2-authoritative`, run proof or close P2.

The live Windows browser and provider connection tests remain explicit operator actions after the
Backend API + CLI batch supplies the coordinated control surface.
