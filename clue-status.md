# CLU-E status

**GENERATED — do not edit by hand.** Produced by `clue status report` from the sealed
Status snapshot. Editing this file changes nothing; the next run overwrites it.

Status is a projection over durable records and never a source used to reconstruct
them (Constitution §3.5, Directory §19.2). Backlog: `DEV-P1-25`.

| | |
|---|---|
| Generated at | 2026-08-13T10:06:58.142Z |
| Schema | 5.2.0 |
| Status hash | `bd9f6214453864f28499f0d8e237d05f1b3742d7f3e5e86dc1463c9588caac8e` |
| Seal | verified · 8 cross-checks ran, 2 skipped |
| Consistency | branches agree |
| Projection | no branch reader failed |

## Capability

10 branches are backed by durable state; 23 are specified by the contract and unimplemented in this build. The second number is not a defect count — it is what this build declares it cannot do, which §1 and gate 26 require it to state rather than imply.

**Backed:** target, cycle, repositoryInventory, recognition, q1, currentWork, measurementCatalogue, improvementField, operationalConsole, runtimeDiagnostics

**Unsupported:** projectInputs, assessmentEnvelope, rpi, environments, universalProjectRepresentation, crossEnvironment, purposeAndCapabilities, intentAndMethods, solutionFrontier, functionalities, measureSessions, proofInstruments, humanEvaluations, aiOrchestration, findings, proofPipeline, benchmarks, improvementEconomics, versionControl, integrations, assessment, greatBook, equilibrium

## Gates

**Satisfied:** 1, 2, 3, 4

**Unreachable, with the reason:**

- gate 7 — unit records are not projected; only their counts are

A gate in neither list is undeclared: this build neither claims it nor explains why it cannot be reached. `CLUE_Status_Contract_v9.md` §20 defines considerably more gates than appear above, and the difference is unstated rather than satisfied.

## Branches

State comes from the capability declaration, not from inspecting the branch body. The first version of this renderer inferred it — anything without a `state` field was called `populated` — and it labelled `goldenMetrics` populated on a build where ADR-0001 declares the Golden branch explicitly UNAVAILABLE, because that branch names its own field `projectionState`. A projection that guesses is the invented healthy state §3.3 forbids, so nothing below is inferred: a branch the declaration does not classify is reported as undeclared rather than assumed well.

| Branch | State | Detail |
|---|---|---|
| `target` | populated | — |
| `projectInputs` | unsupported | no owning domain in this build (projectInputs) |
| `assessmentEnvelope` | unsupported | no owning domain in this build (assessmentEnvelope) |
| `rpi` | unsupported | no owning domain in this build (rpi) |
| `environments` | unsupported | no owning domain in this build (environments) |
| `universalProjectRepresentation` | unsupported | no owning domain in this build (universalProjectRepresentation) |
| `crossEnvironment` | unsupported | no owning domain in this build (crossEnvironment) |
| `purposeAndCapabilities` | unsupported | no owning domain in this build (purposeAndCapabilities) |
| `intentAndMethods` | unsupported | no owning domain in this build (intentAndMethods) |
| `solutionFrontier` | unsupported | no owning domain in this build (solutionFrontier) |
| `functionalities` | unsupported | no owning domain in this build (functionalities) |
| `measureSessions` | unsupported | no owning domain in this build (measureSessions) |
| `proofInstruments` | unsupported | no owning domain in this build (proofInstruments) |
| `humanEvaluations` | unsupported | no owning domain in this build (humanEvaluations) |
| `aiOrchestration` | unsupported | gateway disabled by configuration (gateway.enabled: false); no orchestration domain runs in this build |
| `findings` | unsupported | no owning domain in this build (findings) |
| `proofPipeline` | unsupported | the cycle stage machine exists in src/cycle/; the ten-stage proof board this branch reports awaits the candidate loop (DEV-P2-11) and the 5.2.0 wire revision |
| `benchmarks` | unsupported | no owning domain in this build (benchmarks) |
| `improvementEconomics` | unsupported | no owning domain in this build (improvementEconomics) |
| `versionControl` | unsupported | no owning domain in this build (versionControl) |
| `integrations` | unsupported | no owning domain in this build (integrations) |
| `assessment` | unsupported | no owning domain in this build (assessment) |
| `greatBook` | unsupported | no owning domain in this build (greatBook) |
| `equilibrium` | unsupported | no owning domain in this build (equilibrium) |
| `cycle` | populated | — |
| `repositoryInventory` | populated | — |
| `recognition` | populated | — |
| `q1` | populated | — |
| `currentWork` | populated | — |
| `units` | unavailable | unit records are not on the RegistrySource reader seam; recognition reports the counts |
| `measurementCatalogue` | populated | — |
| `goldenMetrics` | UNAVAILABLE | — |
| `improvementField` | populated | — |
| `gauges` | unavailable | MetricRegistry holds no record for this snapshot |
| `operationalConsole` | populated | — |
| `runtimeDiagnostics` | populated | — |

## Sources

The durable source identities this body was assembled from (§15).

_none_

