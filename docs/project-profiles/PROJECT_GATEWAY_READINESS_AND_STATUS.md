# Project Gateway Readiness and Status 5.8.0

**Status:** implemented foundation; operator endpoints and CLI arrive in Batch 6  
**Scope:** exact-model provider readiness, credential-reference safety, capability readiness and sealed Status

## Credential boundary

A Project Profile stores only an approved reference:

```text
env:OPENAI_API_KEY
credential-store:<installation-specific-id>
```

The runtime resolves bytes immediately before a provider probe or call. Public objects contain the
reference and a boolean presence result, never the value. Provider HTTP messages and network
exceptions are redacted before they enter readiness, events or diagnostics.

## Exact model and authority

The profile, installation configuration and enabled routing policy must resolve to one exact model.
The provider probe must return the same ID. Any difference is `MODEL UNAVAILABLE`; no alternate
model may be used.

For the current governed policy:

```text
spendAuthority = openai_platform
localBudgetEnforced = false
```

Billing/funding exhaustion creates `CONTROLLED PAUSE`. It preserves durable state and prevents new
submissions rather than crashing or inventing a local remaining-balance claim.

## Project binding

Prepared calls, provider pause/resume events and terminal results carry the Project Operation
Identity and profile generation. Before terminal persistence, the gateway reopens the current
runtime and proves that project identity, generation and mission still match. Project or mission
drift produces a durable failure, never a result attributed to the successor generation.

## Readiness aggregation

Readiness is evaluated per requested operation. Browser, AI, publication and Custodian capabilities
can be `NOT_REQUIRED` while local recognition/proof remain ready. Missing remote publication under
`NO_REMOTE_YET` yields `READY_LOCAL_ONLY` rather than blocking local proof.

## Status wire

Status 5.8.0 is a strict new additive schema. It exposes:

- active Project Operation Identity and profile generation;
- overall and capability readiness;
- authority current/drift/conflict state;
- exact gateway requested/effective model and no-fallback state;
- sanitized credential reference/presence;
- provider reachability and controlled-pause state.

Historical snapshots are validated against their own schema by historical tooling; the 5.8.0
validator rejects 5.7.0 bodies. Rewriting an old body with a new version number is not migration.
