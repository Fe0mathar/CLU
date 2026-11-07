# ADR-0010 — The Master Benchmark is one artifact, harness embedded

**Status:** accepted — all three decisions taken as proposed by the Creator, 2026-08-11 (one artifact; a `[harness.<id>]` block with an integrity hash; the ceremony batched with ADR-0008's queued Directory amendment)
**Date:** 2026-08-11
**Origin:** the Creator's question of 2026-08-11 — *"maybe we can make .js content within
`benchmark.template_v9.txt`?"*
**Supersedes:** decision **D2** of `docs/target-profiles-and-benchmark_v1.md` (the benchmark
as a `.md` + `.js` pair, accepted 2026-08-11), if this record is accepted.

---

## 1. The question, and the honest answer

D2 made the benchmark a pair: a contract file and a separate harness file, both hashed into
the cycle lock, with a version-agreement rule between them. The Creator asked whether the
harness could live *inside* the contract instead. It can — and on reflection it should. The
session proposed the pair; the Creator's instinct is better, and this record says why rather
than simply complying.

## 2. Why one artifact is more correct, not merely simpler

**A harness change *is* a comparability event.** The draft contract's §9 states the rule
already: a change to a scenario's action or a signal's aggregation is a version bump, and
renaming or retiring an id is a major one. But the harness is precisely *where scenario
actions and aggregations are implemented*. Under the pair, a harness edit could change what
is measured while the contract's version — and therefore the trend line — stayed still, and
nothing structural would object. Embedding makes the coupling physical: touching the
measurement touches the document whose version governs comparability.

**It deletes a failure class instead of guarding one.** The pair required a version-agreement
rule, a schema refinement forbidding half a benchmark, a lock field for the second half, and
a second doctor line for a missing harness. All of that exists to police a split that need
not exist. One file cannot disagree with itself.

**It matches the selection model.** The Creator's design has the operator choosing a
benchmark per target from the dashboard. One file is one choice.

**The lock is unaffected.** A single content hash still detects every change, including a
harness-only edit — and now such an edit is indistinguishable from a contract edit *by
design*, because both mean the same thing: this is a different benchmark.

## 3. What it costs, stated plainly

- **No editor tooling for the embedded script.** Inside a fenced block the harness gets no
  typecheck, lint, or highlighting. Mitigation: the runner extracts and syntax-checks the
  block before executing it, and refuses a block that does not parse — a failure at
  extraction, never a silent zero.
- **Review mixes policy and code.** Approving thresholds and approving executable code
  become one act. This is a real cost and the Creator should weigh it; the counter-argument
  is §2's first point — they were never independent in fact, only in filing.
- **Amending a sealed file is a ceremony.** `templates/benchmark.template_v9.txt` is one of
  the seventeen files under `SHA256SUMS_v9.txt`. Adding a harness section means the
  DEV-P2-03 sequence: edit, re-seal, manifest revision, and a ratification that goes stale
  until the Creator re-ratifies.

## 4. The proposed shape

The template gains one repeatable block, following its existing `[section.<id>]` convention:

```
[harness.<HRN-001>]
runner_adapter  = cli-node | browser-injection
scenario_ids    = SCN-001,SCN-002
language        = javascript
integrity       = sha256 of the fenced body, recorded when the version is approved
--- begin harness ---
// executable body; returns the contract's result shape:
// { benchmarkVersion, unifiedScore, measures[], protective[], environment, incomplete[] }
--- end harness ---
```

`benchmarkVersion` returned by the body must equal the document's own `benchmark_version` or
the run is void — the one agreement check that survives, and now it is a self-check rather
than a cross-file one. `integrity` lets a reviewer see that the body approved is the body
stored, without re-reading it.

## 5. Consequences across the build

- `masterBenchmarkSchema` collapses from `{contract, harness}` to a single path; the lock's
  `master_benchmark_harness` field and its pair refinement are removed; mission binds one
  governed input again; doctor returns to one benchmark line.
- The draft contract `targets/clu/benchmark/master-benchmark.md` gains its `[harness.*]`
  section in the same shape, and §12's registration instruction changes to a single path.
- **Batch the ceremony.** ADR-0008 queued the Directory §18.2 camelCase amendment for "the
  next governed Directory change". This is that change: one edit pass, one re-seal, one
  manifest revision, one re-ratification covering both amendments. Two governed changes for
  the price of one ceremony is the whole reason ADR-0008 deferred.

## 6. Decisions requested

- **D1** — the benchmark is one artifact; D2 of the design record is superseded.
- **D2** — the template gains a `[harness.<id>]` block with a fenced body and an `integrity`
  hash, per §4.
- **D3** — batch the template amendment with ADR-0008's queued Directory §18.2 amendment into
  a single re-seal and re-ratification ceremony.

Accepted 2026-08-11. The §5 code changes landed the same turn; the sealed-file amendment and
its ceremony are staged for the Creator's host, since only he can re-ratify.
