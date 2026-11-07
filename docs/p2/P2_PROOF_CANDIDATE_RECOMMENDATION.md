# Recommended First P2 Authoritative Proof Candidate

## Target

```text
src/analysis/source/recognizer.ts
```

## Hypothesis

Reduce repeated traversal/allocation in one narrow recognition path while preserving every externally visible recognition result and identity.

## Why this candidate

- inside CLU-E itself;
- measurable with a deterministic fixture corpus;
- no UI, database schema, network or provider behavior change;
- small patch and simple rollback;
- direct parity assertions are available;
- benchmark can measure time and allocation/proxy counts while guardrails compare complete normalized recognition output.

## Screening before ratification

Reject this candidate before the ceremony when:

- median baseline is too small or noisy;
- coefficient of variation remains high after warm-up;
- the proposed patch spans unrelated functions/files;
- output parity requires weakening a guard;
- a broader architectural refactor is needed.

Use a different small hotspot if screening fails. Do not force this recommendation into the authoritative cycle.

## Mandatory guardrails

The candidate must not change:

```text
recognized unit count
unit IDs and hashes
source locations
edge identities and kinds
unresolved-reference identities
adapter selection
snapshot/project identity
Status or event semantics
```

It must pass typecheck, build, full selftest, recognition parity and any benchmark-specific deterministic guard.

## Success criterion

Set the Proof Contract threshold only after baseline screening. The threshold must exceed observed noise and use a stable statistic, normally median across repeated isolated runs. The improvement must be measurable without regression; a merely positive point estimate is insufficient.
