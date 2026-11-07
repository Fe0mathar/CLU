# Batch 3 — Project Authority and Proof Binding

**Patch range:** PP-13 through PP-18  
**Prerequisite:** Batch 1 and Batch 2  
**Scope:** Project Authority, governed operation identity, proof/Great Book isolation, and project-scoped benchmark runtime.

## 1. Purpose

Batch 3 makes one durable Project Profile generation an explicit authority input to every new
proof-authoritative operation. It does not activate profiles or begin the P2 ceremony. It supplies
the authority and identity layer that later API/CLI/UI batches will operate.

The governed chain is:

```text
ProjectProfileRecord
  → ProjectOperationIdentity
  → live Project Authority manifest
  → Master Benchmark identity
  → recognition configuration hash
  → Benchmark Runtime hash
  → ProjectGovernanceBasis
  → mission / cycle input lock / proof contract
  → baseline / candidate verdict / closure
  → ACCEPT-only Great Book entry
```

A legacy v2 runtime remains readable. New Project Profile-bound records use versioned schemas and
must carry the exact project governance basis; legacy records are not rewritten or reinterpreted.

## 2. Implemented patches

### PP-13 — Project Authority

`src/control/projectProfiles/projectAuthority.ts` re-reads each enabled governed document, resolves
its physical path, verifies the bound SHA-256, and produces a deterministic active manifest only
when the authority generation is current.

Rules enforced:

- Target Description and Master Benchmark are distinguished required proof authorities;
- Project Intent is optional;
- Additional Governed Documents use explicit role/order/enabled metadata;
- disabled documents remain in the profile but never enter the active manifest;
- path mismatch, missing bytes, stale validation state, or content drift cannot be silently absorbed;
- a drifted or incomplete authority generation cannot mint a proof-ready governance basis.

### PP-14 — Conflict and resolution state

`src/control/projectProfiles/authorityConflict.ts` detects structural conflicts and accepts explicit
semantic conflict records. A conflict is bound to the exact authority hash where it was detected.
A resolution names a successor authority hash; it cannot bless the conflicted generation itself.
The current generation remains blocked until the successor generation is actually active.

### PP-15 — Mission, context, and cycle lock

The mission basis now includes the deterministic project governance basis hash. Exact active
Project Authority bytes are stored by immutable artifact reference and are exposed to AI context as
essential policy. Disabled documents and credential values are not included.

The cycle input lock carries the exact project governance basis, Target Description, Master
Benchmark, authority readiness, conflict readiness, and benchmark-runtime readiness. Authority
drift makes the current mission/proof assumptions stale rather than updating them in place.

### PP-16 — Great Book identity

Great Book entry version 2 binds the project governance basis. The proof verdict payload and the
atomic Great Book consequence must carry the same basis and project ID. Project A evidence cannot
be projected as Project B history. Legacy entry version 1 remains readable without being rewritten.

### PP-17 — Proof and cycle identity

Proof Contract version 2, Baseline Package version 2, deterministic verdict identity, cycle proof
closure, and resume verification bind the same Project Governance Basis. A baseline, candidate,
verdict, or closure from another project or profile generation is `INVALID` or refused. Historical
legacy records remain readable only under legacy semantics.

### PP-18 — Benchmark Runtime

`src/control/projectProfiles/benchmarkRuntime.ts` resolves project-scoped working directory,
command, scenario, warm-up count, repetitions, timeout, target URL, browser profile/resolution, and
additional arguments. It validates duplicated values against the machine-readable Master Benchmark
and creates deterministic runtime and consistency hashes.

Browser readiness is conditional: a runtime with no target URL is not blocked by browser settings;
a browser-targeted runtime carries the browser requirement forward to the later Browser/GPT/
Readiness batch.

## 3. Fail-closed boundaries

Project Profile-bound proof work is refused when any of these differ:

```text
projectId
targetRootIdentity
projectProfileHash
profile generation
authority manifest hash
Master Benchmark hash
recognition configuration hash
Benchmark Runtime hash
```

The system does not convert drift, mismatch, missing authority, or cross-project evidence into an
advisory warning or manual success.

## 4. Safety boundary

Applying this patch does not:

- change `config/clue.config.yaml`;
- create, migrate, adopt, or activate a Project Profile;
- write to `F:\CLU\workspace\clue` or `F:\CLU\shadow\clue`;
- change the active target;
- modify the Q1/SURF interface files;
- change the Metric Catalogue;
- configure OpenAI credentials;
- ratify documents, open `P2-authoritative`, run a proof, create an ACCEPT, or close P2.

## 5. Evidence

Focused automated evidence:

```text
selftest/project-authority-binding.test.ts
selftest/project-authority-conflict.test.ts
selftest/authority-drift-stales-proof.test.ts
selftest/mission-profile-binding.test.ts
selftest/great-book-project-isolation.test.ts
selftest/proof-cycle-project-isolation.test.ts
selftest/project-benchmark-runtime.test.ts
```

Batch acceptance also requires typecheck, production build, the complete repository self-test suite,
and the dashboard, System Navigator, Operational Console, Great Book field, and gauge regressions.
