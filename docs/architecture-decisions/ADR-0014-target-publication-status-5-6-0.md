# ADR-0014 — explicit target publication decision; Status wire 5.6.0

**Status:** implementation candidate for Creator ratification  
**Date:** 2026-08-14  
**Owner:** target identity / DEV-P2-04 / Status wire

## Context

P2 permits `DEV-P2-04` to close either by registering a target remote or by recording the
Creator decision **NO_REMOTE_YET**. The existing profile carried only:

```yaml
remote: null
credential_env: null
```

That pair was insufficient evidence of a decision. Both fields defaulted to null for legacy
profiles, so an untouched profile and a deliberate local-only target were indistinguishable to
the machine. Comments could explain intent to a reader but could not make it schema-valid,
mission-bound state.

A second defect used `backup.remote` as the target's Git identity in the §19 next-cycle handoff.
`backup.remote` is CLU-E's ledger-backup transport and may be the symbolic name `origin`; it is
not the selected target's publication identity.

## Decision

The target profile gains one strict `remote_decision` record:

```yaml
remote_decision:
  state: NO_REMOTE_YET | REMOTE_REGISTERED
  decision_id: <stable Creator decision id>
  recorded_at: YYYY-MM-DD
  recorded_by: creator
  reason: <specific rationale>
```

Legacy profiles with no record resolve to `UNRECORDED`, which remains valid for compatibility
but does **not** close P2-04. Cross-field validation enforces:

- `UNRECORDED` may not carry a remote or credential reference;
- `NO_REMOTE_YET` requires `remote: null` and `credential_env: null`;
- `REMOTE_REGISTERED` requires a credential-free remote identity;
- a credential reference without a remote is refused;
- none of the states grants push or landing authority.

The active `clu` profile records:

```text
P2-D5-NO-REMOTE-YET
```

with the Creator's local-only rationale. Because the active profile is already part of the
mission basis, changing this decision registers a successor mission before governed evidence.

## Status 5.6.0

The sealed `target` branch gains a `publication` object containing:

- decision and stable decision identity;
- recording date and authority;
- credential-free remote identity or null;
- credential environment-variable name or null;
- `localOnly`;
- `gitLifecycleImplemented: false`;
- `publicationPermitted: false`;
- the exact recorded rationale.

This is an additive minor revision from 5.5.0 to 5.6.0. The information belongs to target
identity, not `versionControl`: P2 records a decision but does not pretend the governed Git
lifecycle exists. `versionControl` therefore remains explicitly unsupported.

## Runtime and diagnostic effects

- `clue doctor --deep` distinguishes `UNRECORDED`, `NO_REMOTE_YET` and
  `REMOTE_REGISTERED`.
- `/api/config` exposes the same safe publication view for the dashboard; no credential value
  is present.
- the §19 next-cycle handoff uses `project.remote`, never `backup.remote`;
- a local-only handoff carries the exact recorded stated-absence reason;
- a future registered remote enters accepted identity but still grants no publication authority.

## Consequences

- DEV-P2-04 closes honestly as a recorded absence for the current target.
- no Git command, network connection, push, landing or credential read is added by this change.
- self-target proof still requires the later worktree/config-relocation lifecycle before live
  candidate execution; this ADR does not claim otherwise.
- changing the publication decision moves the mission because the profile bytes change.
- formal Directory registration and ratification remain part of the final P2 governance package.

## Acceptance

1. legacy null/null resolves to `UNRECORDED`, not an invented Creator decision;
2. the shipped profile resolves exactly to `NO_REMOTE_YET` with decision id
   `P2-D5-NO-REMOTE-YET`;
3. contradictory remote/credential/decision combinations are refused;
4. Status 5.6.0 seals the decision while `versionControl` stays unsupported;
5. `/api/config` and Status expose equal publication state without a secret value;
6. §19 handoff uses target publication identity and preserves the stated absence;
7. typecheck, build, targeted tests, complete suite and dashboard verification stay green.

## Seal and phase boundary

The State Seal independently checks that publication remains denied and that each decision's
identity fields are coherent. The proof self-target worktree/config-relocation limitation is not
reopened as P2-04: it belongs to the later governed Git/worktree phase (P4).
