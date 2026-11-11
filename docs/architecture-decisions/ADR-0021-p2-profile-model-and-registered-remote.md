# ADR-0021 — P2 Project Profile model and registered Git remote

**Status** Proposed for Creator ratification

**Date** 2026-11-11

**Owners** AI Utilization, Git Integration and P2 closure assessment

## Context

The Windows installation closed `CYCLE-000004` with a durable ACCEPT under `MISSION-000007`.
The subsequent P2 assessment found two differences between the live Project Profile and the
phase policy. The gateway successfully used `gpt-6-astra`, and the profile registered a Git remote.
The prior policy required `gpt-5.6-sol` and a local-only target.

## Decision proposed for the successor mission

- D4 pins the exact verified OpenAI model ID `gpt-6-astra`. Compare the configured policy ID
  with the effective gateway identity. A later model upgrade needs its own reviewed policy
  and evidence. The runtime continues to refuse fallback and retains the OpenAI Platform
  budget, usage reporting and controlled provider-pause rules from ADR-0017.
- D5 permits `REMOTE_REGISTERED` for the active Project Profile. The mission binds the profile
  generation and registered remote identity. Legacy P2 policy with no explicit publication
  decision retains the local-only `NO_REMOTE_YET` interpretation.
- Git Sync is an independent operator action under Git Integration §35. P2 keeps governed
  publication and landing disabled. Start, proof, ACCEPT and cycle closure perform no Git sync.
- The full P4 delivery path binds accepted source to a reviewed branch and remote review
  object, verifies required CI checks, records publication and Custodian landing receipts,
  then verifies the landed state and retains rollback evidence. Git stores and transports
  the versioned result. The local proof remains the authority for the improvement verdict.

## Adoption

1. Verify the candidate v9 pack seal and the active profile's exact model, registered remote and
   gateway readiness.
2. Register a successor mission, ratify the exact installed pack interactively and seal the
   mission's current P2-authoritative evidence epoch.
3. Produce and close a new proof-authoritative cycle under that mission and assess formal P2
   closure. Preserve all historical evidence with its original scope, including
   `MISSION-000007` and `CYCLE-000004`.
