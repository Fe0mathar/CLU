# Project Authority Runtime

## 1. Authority states

The runtime reports one of:

```text
CURRENT
INCOMPLETE
DRIFTED
INVALID
```

`CURRENT` is the only state that can produce an active Project Authority manifest. Proof readiness
also requires one enabled Target Description and one enabled Master Benchmark.

`DRIFTED` means current bytes no longer match the SHA-256 bound by the durable profile generation.
The runtime reports the mismatch and does not silently update the profile or active mission.

## 2. Deterministic order

Active authority is ordered by distinguished kind and explicit document order:

```text
Target Description
Master Benchmark
Project Intent / Constraints
Additional Governed Documents in explicit order
```

Filesystem enumeration order is never authority. Disabled additional documents remain durable
profile configuration but do not enter the active manifest or AI context.

## 3. Physical identity and hash verification

For every configured binding the runtime verifies:

- configured path resolves to a regular file;
- the observed physical canonical path equals the profile-bound canonical path;
- the observed SHA-256 equals the profile-bound SHA-256;
- the profile validation state is valid;
- distinguished and additional document metadata remain structurally coherent.

A path alias cannot redirect a binding to another physical document while preserving the old
configured string.

## 4. Manifest identity

A current manifest binds:

```text
operation identity
profile generation
configured authority hash
recognition configuration hash
ordered active documents and content hashes
Target Description hash
Master Benchmark hash
optional Project Intent hash
manifest hash
```

The manifest contains no credential bytes. Exact authority document text is stored separately by
immutable ArtifactStore reference when the mission is registered.

## 5. Conflict policy

Structural conflicts and explicit semantic conflict records are evaluated separately from drift.
Drift remains `DRIFTED`; it is not fabricated into a semantic conflict. An unresolved conflict
blocks governed work. A resolution must point to a successor authority generation; the conflicted
generation never becomes current merely because a resolution record exists.

## 6. Renewal

The only valid renewal path is:

```text
change governed bytes
→ validate exact successor files
→ save a successor Project Profile generation
→ compute successor profile/authority hashes
→ activate successor generation
→ renew mission/ratification/epoch/proof basis where required
```

Historical evidence remains bound to the previous immutable basis.
