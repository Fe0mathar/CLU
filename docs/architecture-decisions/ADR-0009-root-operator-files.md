# ADR-0009 — Operator files stay at the repository root

**Status:** accepted — the root-file placement decision requested by DEV-P2-05, taken by
the Creator 2026-08-10 (option 1 of the presented menu) in the same batch acceptance that
covered the cycle plan. This is its durable record; with it, every decision accepted this
session has one.
**Date of record:** 2026-08-10
**Applies to:** `CONFIG-EDIT.md`, `clue-status.md`, `MANIFEST.txt`

---

## 1. Context

Three operator-facing files live at the repository root, each born of a P1 item:
`CONFIG-EDIT.md` (DEV-P1-27's durable configuration-edit workflow), `clue-status.md`
(DEV-P1-25's generated status report, replacing the hand-maintained document), and
`MANIFEST.txt` (DEV-P1-26's release manifest, written by `tools/release.mjs`). DEV-P2-05
carried the open question of whether they should move — into `docs/`, or under the
workspace — and the menu of placements was presented for decision.

## 2. Decision (as accepted)

All three stay at the repository root. No file moves.

## 3. Rationale, recorded

- **They are the operator's first surfaces.** The root is where an operator lands;
  a workflow guide, the current status report, and the release census belong at the
  landing point, not a directory deep.
- **They are outside the sealed pack** — none of the three appears in
  `SHA256SUMS_v9.txt` (verified against the seal on the date of record), two are
  generated and all are regenerable, so their placement carries no governance weight and
  moving them would buy nothing a seal cares about.
- **Zero migration is itself evidence.** The generators already target the root and every
  reference in the tree assumes it; the placement was load-bearing before it was a
  question, and the decision confirms practice rather than changing it.

## 4. Consequences

None in the tree — the decision is a confirmation. The DEV-P2-05 decision hole closes;
generators, references, and the host runbook continue unchanged.
