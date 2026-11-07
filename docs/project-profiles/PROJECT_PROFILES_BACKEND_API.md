# CLU-E Project Profiles Backend API

**Contract:** `clue-project-profiles-api/1`  
**Authority:** backend control-plane services  
**Frontend role:** presentation and explicit operator intent only

## Invariants

Every mutation is validated against the current durable registry generation. The backend owns:

```text
profile parsing and canonicalization
Project ID uniqueness
physical Target Root uniqueness
profile generation/hash
active registry pointer
profile-only deletion safety
live activation truthfulness
connection/readiness identity
secret filtering
```

The API never accepts raw credential bytes. A profile may contain only a supported credential
reference such as `env:OPENAI_API_KEY` or `credential-store:<id>`.

## Concurrency

Updates and deletions require `expectedGeneration`. Activation requires both the exact generation
and full profile hash. A stale client receives a structured conflict rather than overwriting a newer
profile generation.

## Deletion

Deletion requires:

```text
DELETE PROFILE <projectId> <generation> <hash-prefix>
```

It removes only CLU-E-owned profile registration. It never deletes the canonical target repository,
workspace, shadow, Great Book, proof evidence or external history. An active profile cannot be
deleted.

## Live activation

A single-runtime dashboard cannot atomically change target context. Its activation endpoint returns
`RUNTIME_SWITCH_UNAVAILABLE`. A host that supplies the Project Runtime Manager callback may publish
a live switch only after the registry and runtime agree on the requested project identity.

## Security and transport

The enclosing dashboard server retains its loopback/authentication, Host-header, Origin and bearer
checks. JSON request bodies are capped at one MiB. Both request and response values are scanned for
secret material, and provider errors are redacted before becoming externally visible.
