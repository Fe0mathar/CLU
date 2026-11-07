# ADR-0019 — Project Profile identity and readiness in Status 5.8.0

**Status:** Accepted for implementation; enters the next documentation ratification set  
**Date:** 2026-08-15

## Context

Status 5.7.0 could report target, recognition, proof, Great Book and Model Gateway facts, but it could
not prove which Project Profile generation owned those facts or whether a requested operation was
ready. A dashboard-selected project is not durable authority, and one global health flag cannot
represent local-only proof alongside unavailable optional publication or browser capabilities.

## Decision

Advance the canonical Status wire to `5.8.0` and add one strict `projectProfile` branch containing:

```text
Project Operation Identity
profileGeneration
overall readiness
operation-specific capability readiness
authority current/drift/conflict state
profile and authority hashes
```

Extend the populated Model Gateway branch with exact active-project identity, generation,
credential reference/presence, requested/effective model, no-fallback state and provider
reachability/pause state.

The runtime registry, projector, seal, retained-history validation, CLI/dashboard Status readers and
formal P2 closure assessment use the exported `STATUS_SCHEMA_VERSION`; they do not maintain literal
competing versions.

## Consequences

- Status can no longer combine Project A runtime facts with Project B presentation state.
- A stale profile generation is visible and rejectable.
- `READY_LOCAL_ONLY` can coexist with unavailable Git publication.
- Credential bytes remain outside Status.
- Historical 5.7.0 snapshots are not reinterpreted as 5.8.0.
- The P2 closure mechanism follows the current installed wire version but still requires the full
  authoritative closure chain; a new Status version does not itself close P2.
