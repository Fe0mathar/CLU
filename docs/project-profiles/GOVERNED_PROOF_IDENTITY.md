# Governed Proof Identity

## 1. Project Governance Basis

Every new Project Profile-bound proof operation carries:

```text
basisVersion = clue-project-governance-basis/1
operationIdentity:
  projectId
  targetRootIdentity
  projectProfileHash
profileGeneration
authorityHash
masterBenchmarkHash
recognitionConfigHash
benchmarkRuntimeHash
```

Its canonical JSON hash is the stable project governance identity used by mission, cycle, proof,
benchmark evidence, verdict, and Great Book.

## 2. Versioned compatibility

New project-bound records use version 2 of the relevant proof/Great Book schemas and require the
basis. Legacy version 1 records omit it and remain readable. A legacy record cannot borrow a modern
project basis, and a modern record cannot omit one.

## 3. Boundaries

The basis is checked at:

- mission registration and current-basis verification;
- AI context construction;
- cycle input locking and resume verification;
- Proof Contract freeze;
- baseline capture and reuse;
- candidate comparison and deterministic verdict;
- proof closure derivation;
- benchmark run artifact/event recording;
- ACCEPT-to-Great-Book construction and projection.

A mismatch is refused before ACCEPT. Narrative explanation cannot repair a cross-project or stale
baseline.

## 4. Great Book isolation

A Great Book v2 entry carries the same project basis as the enclosing proof verdict. The entry's
`target_id` must equal the basis Project ID. Projection rejects parity mismatch between verdict,
entry, cycle, mission, candidate, patch, benchmark, and project identity.

Batch 2 already supplies physically isolated project state. Batch 3 adds explicit exported record
identity so copied or aggregated evidence still cannot be mistaken for another project.

## 5. Legacy behavior

Legacy v2 installation mode remains operational until the coordinated API/CLI cutover. Legacy
records are not rewritten. The strict project basis rules become mandatory only when runtime work
is explicitly bound to a Project Profile generation.
