# ADR-0011 — Status wire 5.3.0: `proofPipeline` becomes backed

**Status:** implementation candidate for Creator ratification  
**Date:** 2026-08-13  
**Owner:** Status wire / DEV-P2-11

## Decision

`proofPipeline` moves from `unsupported` to a typed, backed Status branch. This is an additive wire change, so `STATUS_SCHEMA_VERSION` advances from `5.2.0` to `5.3.0` under the same versioning law used by ADR-0007.

The branch is sourced only from durable `proof.*` events indexed in SQLite from the append-only event log:

- `proof.contract_frozen`;
- `proof.baseline_bound`;
- `proof.execution_refused`;
- `proof.verdict_recorded`.

Every new proof event uses the governing cycle id as `subject_id`. That makes the read-only Status path cycle-addressable without interpreting UI state or reopening the writer log. Pre-ADR proof events whose subject is null remain unattributed; they are not guessed into a cycle.

## Attempt coherence

The latest `proof.contract_frozen` event is the boundary of the selected proof attempt. Baseline and terminal events are accepted into the branch only when their sequence is later than that boundary.

Therefore, when a second proof attempt begins in the same cycle, Status immediately shows the new contract with no baseline or verdict until those events are durably recorded. It never combines the new contract with an old attempt's verdict.

The read path fails closed when one attempt appears to contain both `execution_refused` and `verdict_recorded`, or when a terminal event has no later baseline binding. Such contradictory durable state becomes an unavailable branch plus a projection fault; it is not rendered as healthy progress.

## Wire shape

The branch carries:

- the selected `cycleId`;
- one nullable evidence identity for each proof event type;
- branch freshness.

Each evidence identity contains only event id, sequence, and occurrence time. Contract and verdict payloads remain evidence-side and can be followed through the event/artifact identities; Status does not duplicate them.

A virgin workspace, or an active cycle with no proof attempt, is backed with all event members null. A source that does not implement the proof reader is `unavailable`, not fabricated as empty.

## Consequences

- `proofPipeline` leaves `UNSUPPORTED_BRANCHES` and enters `BACKED_BRANCHES`.
- Status schema becomes `5.3.0`.
- Existing `5.2.0` historical snapshots remain historical evidence; current parsing requires `5.3.0`.
- The dashboard may later derive its ten-stage board from these durable facts, but the Status branch does not invent intermediate stages that have no independent durable event.
- `§24` candidate-loop evaluation remains a separate P2 ZIP; this ADR exposes the evidence it will consume but does not change cycle closure wording yet.

## Acceptance

1. typecheck and production build are green;
2. current Status reports schema `5.3.0`;
3. `proofPipeline` is backed and excluded from the unsupported census;
4. all newly written proof events are cycle-addressable through `subject_id`;
5. the runtime reader selects one coherent latest attempt and never carries old terminal evidence forward;
6. empty, missing, contradictory, and failing readers remain honest non-values;
7. the complete suite remains green.
