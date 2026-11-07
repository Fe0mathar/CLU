# Project Authority Conflict Policy

## 1. Precedence

The governed precedence is:

```text
Master Benchmark / frozen Proof Contract
  > Project Intent / protected constraints
  > Target Description
  > Additional Governed Documents
```

Precedence identifies the stronger authority; it does not authorize CLU-E to hide a material
contradiction. A conflict is surfaced and governed work fails closed until a successor authority
generation resolves it.

## 2. Structural conflicts

Batch 3 deterministically detects conflicts that do not require natural-language judgment,
including:

- the same physical canonical file bound more than once;
- duplicate explicit authority order;
- duplicate distinguished authority kind;
- path or hash declarations inconsistent with the active Project Profile;
- proof requirements inconsistent with the available Master Benchmark/runtime basis.

Ordinary authority drift is reported as `AUTHORITY CHANGED`/`DRIFTED`, not fabricated into a
semantic conflict.

## 3. Explicit semantic conflict records

Natural-language contradiction detection is not treated as perfectly decidable. A semantic
conflict becomes authoritative only through a versioned record containing:

```text
conflictVersion
conflictId
projectId
authorityHash
kind = semantic-declared
description
bindingIds
detectedAt
resolution | null
```

A resolution records:

```text
resolutionId
resolvedAt
resolvedBy
statement
successorAuthorityHash
```

No AI suggestion or UI action may silently rewrite precedence or mark a conflict resolved.

## 4. Successor-generation rule

A conflict belongs to the exact `authorityHash` where it was detected. A resolution cannot make
that same generation current again, even if it falsely sets `successorAuthorityHash` equal to the
conflicted hash. The conflict clears only after a different, declared successor authority generation
is saved, activated, and becomes the live basis.

## 5. Resolution workflow

```text
detect drift/conflict
→ preserve exact conflict evidence
→ block affected governed operations
→ Creator edits/chooses/records resolution
→ validate successor files
→ save successor Project Profile generation
→ compute successor authority/profile hashes
→ activate successor generation
→ renew mission/ratification/epoch/proof basis as required
```

Removing, disabling, reordering, re-roling, or rebinding a document is an authority change, not a
presentation-only edit.

## 6. Proof rule

The frozen Proof Contract and Master Benchmark are first-class proof authority. An additional
document cannot weaken a mandatory benchmark gate. An unresolved conflict affecting admissibility
blocks proof readiness and ACCEPT; it is not converted into REVISE or a manual success.
