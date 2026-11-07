# Project Benchmark Runtime

## 1. Scope

Benchmark authority and benchmark execution settings are related but distinct:

```text
Master Benchmark = governed measurement authority
Benchmark Runtime = project-scoped executable configuration
```

The runtime binds working directory, command, scenario, warm-up, repetitions, timeout, optional
browser target/profile/resolution, and additional arguments.

## 2. Readiness

States:

```text
READY
INCOMPLETE
INVALID
```

The runtime is `READY` only when:

- working directory exists and stays inside the Target Root;
- a current active Master Benchmark exists;
- the benchmark contract is machine-readable;
- a supported `cli-node` harness block exists and passes integrity verification;
- configured benchmark ID/version agree with the document where specified;
- scenario belongs to the selected harness;
- duplicated warm-up, repetition, and timeout values agree with the Master Benchmark policy;
- timeout does not exceed the benchmark's maximum total runtime.

Descriptive benchmark text without an executable supported harness is not proof-ready.

## 3. Identity

The profile's behavior-relevant Benchmark Runtime fields produce a deterministic runtime hash. The
resolved runtime also produces a consistency hash over effective values and validation results. The
runtime hash enters the Project Governance Basis and therefore the proof identity.

## 4. Candidate execution

When the canonical working directory equals the Target Root, candidate execution maps it to the
candidate shadow root. This preserves the same logical benchmark configuration while ensuring the
candidate is measured in isolation rather than mutating or measuring the canonical tree.

## 5. Browser condition

A configured target URL makes browser execution required. Exact Chrome session/target/origin
resolution and durable browser evidence belong to Batch 5. A CLI-only benchmark remains valid
without browser readiness.
