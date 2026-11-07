# Target Description

**Project name:** `<name>`  
**Project ID:** `<stable-project-id>`  
**Description version:** `<version>`  
**Owner:** `<person or team>`  
**Last reviewed:** `<YYYY-MM-DD>`  

> This file defines declared project intent. It does not prove that the implementation satisfies the declaration. CLU-E compares it with repository, runtime, metric, test, benchmark, and Git evidence.

---

## 1. Purpose

Describe why the project exists and the problem it is intended to solve.

`<purpose>`

## 2. Intended users, operators, or consumers

| Group | Need or responsibility | Criticality |
|---|---|---|
| `<group>` | `<need>` | `critical / important / supporting` |

## 3. Primary journeys and workloads

| Journey or workload ID | Description | Representative input/state | Expected outcome | Priority |
|---|---|---|---|---|
| `JRN-001` | `<description>` | `<input/state>` | `<outcome>` | `<priority>` |

## 4. Core capabilities

| Capability ID | Capability | Why it matters | Evidence path expected |
|---|---|---|---|
| `CAP-001` | `<capability>` | `<reason>` | `direct / proxy / human evaluation / not yet defined` |

## 5. Strategic objectives

Use stable objective IDs so documentation, measures, benchmarks, candidates, and Great Book records can refer to them.

| Objective ID | Objective statement | Priority | Benchmarkability | Success interpretation |
|---|---|---|---|---|
| `OBJ-001` | `<objective>` | `critical / high / medium / low` | `direct / proxy / qualitative / unknown` | `<meaning>` |

## 6. Critical behavior and invariants

State behavior that must remain true across all accepted improvements.

- `INV-001 — <invariant>`
- `INV-002 — <invariant>`

## 7. Quality priorities

Rank or explain the intended relationship among relevant qualities. Do not force a ranking where the relationship is conditional.

| Quality | Priority or policy | Notes |
|---|---|---|
| Correctness | `<policy>` | `<notes>` |
| Performance | `<policy>` | `<notes>` |
| Reliability | `<policy>` | `<notes>` |
| Security | `<policy>` | `<notes>` |
| Privacy | `<policy>` | `<notes>` |
| Accessibility | `<policy>` | `<notes>` |
| Maintainability | `<policy>` | `<notes>` |
| Extensibility | `<policy>` | `<notes>` |
| User experience / visual fidelity | `<policy>` | `<notes>` |

## 8. Non-negotiable constraints

Include legal, security, privacy, safety, compatibility, platform, budget, latency, or operational constraints.

| Constraint ID | Constraint | Authority/source | Required gate or evidence |
|---|---|---|---|
| `CON-001` | `<constraint>` | `<authority>` | `<gate/evidence>` |

## 9. Supported environments and scale

| Environment ID | Environment | Required/optional | Expected scale or load | Notes |
|---|---|---|---|---|
| `ENV-001` | `<OS/browser/runtime/hardware/deployment>` | `<required>` | `<scale>` | `<notes>` |

## 10. Acceptable and unacceptable trade-offs

### Acceptable

- `<trade-off allowed under stated conditions>`

### Unacceptable

- `<quality or capability that may not be sacrificed>`

## 11. Non-goals

Explicitly state what the project is not intended to do.

- `NG-001 — <non-goal>`

## 12. Known risks and ambiguities

| ID | Risk or ambiguity | Why unresolved | Evidence or decision needed |
|---|---|---|---|
| `AMB-001` | `<item>` | `<reason>` | `<needed>` |

## 13. Project-level success

Describe what a successful accepted project state means. Keep native measures and qualitative judgments separate.

`<success definition>`

## 14. Human-evaluation requirements

List any qualities that cannot be decided solely through deterministic measures, such as creative quality, perceived clarity, or strategic fit.

| Evaluation ID | Subject | Evaluator profile | Method | Acceptance authority |
|---|---|---|---|---|
| `HEV-001` | `<subject>` | `<profile>` | `<method>` | `<authority>` |

## 15. References

List authoritative project documents, requirements, policies, or design records. References are inputs, not proof of implementation.

- `<reference>`

## 16. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| `<version>` | `<date>` | `<change>` | `<authority>` |
