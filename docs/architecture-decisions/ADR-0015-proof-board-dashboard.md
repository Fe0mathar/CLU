# ADR-0015 — durable Proof Board dashboard projection

**Status:** implementation candidate for Creator ratification  
**Date:** 2026-08-14  
**Owner:** DEV-P2-11 / B6 dashboard benchmark and proof surface

## Context

P2 already records the facts needed to explain a governed experiment:

- `benchmark.run_recorded` names the exact registered Master Benchmark, harness identity,
  result artifact and measurements;
- `proof.contract_frozen` starts one proof attempt;
- `proof.baseline_bound` binds that attempt to its baseline evidence;
- `proof.execution_refused` records a named refusal; and
- `proof.verdict_recorded` carries the deterministic disposition and evidence identities.

The dashboard did not expose those facts as a coherent operator surface. Adding a visual panel
that recomputed a verdict from deltas would create a second decision authority in the browser,
while reading artifacts directly would bypass the durable event and projection boundaries.

One additional implementation issue had to be resolved first: both Great Book and the new Proof
Board consume `proof.verdict_recorded`. The projection store previously represented one projector
per event type, so registering the second consumer would silently replace the first.

## Decision

### One event may have multiple atomic projection consumers

`ProjectionStore` stores an ordered list of projectors for each event type. Every registered
consumer runs inside the same SQLite transaction as `events_index`. If any consumer refuses, all
rows and the event-index advance roll back together.

This is event fan-out, not a new authority: each table remains rebuildable from the append-only
log and artifact store.

### Projection schema 8

Projection schema 8 adds five read-model tables:

```text
proof_board_benchmark_runs
proof_board_contracts
proof_board_baselines
proof_board_refusals
proof_board_verdicts
```

The tables contain event IDs, sequence numbers, mission/cycle identity, hashes, recorded
reasons/deltas and Great Book linkage. They do not contain artifact bodies or secret values.

A newer `proof.contract_frozen` event starts a new attempt boundary. Baselines and terminal events
from an older attempt cannot leak into it. A terminal event requires an earlier baseline and must
bind the same contract, hypothesis, mission and baseline digest.

ZIP 03 also introduced an exact three-field closure signal under `proof.verdict_recorded`. That
compact event is valid input for §24 but is not a complete proof attempt. The Proof Board accepts
that exact legacy shape without projecting it; a partially formed modern payload still fails
closed.

### Read-only API

`GET /api/proof-board` returns schema `clue.proof-board/1.0.0` data with `Cache-Control: no-store`.
It joins only the rebuildable projection rows and the currently registered benchmark identity.
The endpoint never runs `decide()`, never executes a benchmark and never reads evidence artifact
bodies.

### Render-only browser workspace

The dashboard mounts one shared-overlay workspace from
`ui/clue-dashboard/workspaces/proofBoard.js`. The client:

- strictly validates the endpoint shape;
- verifies server summary parity and unique event identities;
- displays the recorded disposition exactly as supplied;
- refuses contradictions instead of selecting a more convenient state; and
- escapes all evidence text before writing markup.

A positive-looking delta cannot turn a recorded `REJECT` into `ACCEPT` in the browser.

## Versioning

The Status wire remains **5.6.0**. B6 is a specialised dashboard read model and does not add or
change a Status branch. The dashboard interface identity advances to:

```text
ULTIMATE-2026.08-R6-PROOF-BOARD
```

The projection schema advances from 7 to 8 because durable SQLite table shape changes.

## Consequences

- benchmark and proof history becomes visible without creating a second verdict authority;
- Great Book and Proof Board can consume the same verdict event without overwriting each other;
- an empty board means “connected and no full proof attempt recorded”, not `unsupported`;
- current proof attempts, refusals and dispositions survive dashboard restart through replay;
- only hashes and identifiers are exposed; evidence bodies stay behind the artifact boundary;
- the panel does not by itself create the production proof-authoritative cycle required to close
  P2.

## Acceptance

1. two projection modules consume the same event and a failing consumer rolls the whole event back;
2. schema 8 migrates a schema-7 workspace and installs all five Proof Board tables;
3. benchmark, contract, baseline and verdict replay into one coherent attempt;
4. attempt boundaries prevent stale baseline/verdict inheritance;
5. cross-hypothesis, cross-baseline, contradictory and corrupted rows are refused;
6. compact ZIP-03 closure signals remain valid but are not presented as full attempts;
7. `/api/proof-board` is read-only, no-store and honestly empty on a virgin workspace;
8. the UI renders durable event IDs and dispositions and contains no verdict function;
9. typecheck, build, all self-test files, dashboard tests and component verifiers remain green.
