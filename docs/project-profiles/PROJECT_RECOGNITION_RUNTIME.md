# CLU-E Project Profiles — Project Recognition Runtime

**Document class:** architecture and invariants  
**Implemented by:** Batch 4 / PP-19 and PP-20  
**Status:** implementation baseline

## 1. Identity model

Recognition is no longer identified only by a snapshot or compiler-options hash. One exact project
recognition generation is:

```text
ProjectRecognitionIdentity = {
  identityVersion: clue-project-recognition-identity/1,
  operationIdentity: {
    projectId,
    targetRootIdentity,
    projectProfileHash
  },
  profileGeneration,
  recognitionConfigHash
}
```

`recognitionConfigHash` binds the project ID, physical Target Root identity and canonical recognition
configuration. `projectProfileHash` binds the complete behavior-relevant Project Profile. The
explicit generation prevents an old record from being mistaken for a successor even when a future
canonicalization change produces equivalent settings.

## 2. Resolution

The runtime resolves recognition from the active durable profile record, not from dashboard fields.
It verifies:

```text
profile record hash
runtime Project Operation Identity
Target Root containment
build/compiler config exists as a file
source roots remain under target and exist as directories
excluded paths use deterministic segment/subtree semantics
supported adapter exists
symlink policy is implementable
```

The current recognizer uses a complete TypeScript program for dependency resolution. Source roots
control snapshot/capture authority and configured scope; they do not permit a partial program to
silently alter module resolution. Excluded paths are passed to both snapshot capture and semantic
recognition. A simple exclusion such as `dist` matches path segments at any depth; a path exclusion
such as `src/generated` matches that exact subtree. This keeps physical and semantic inventories in
parity.

## 3. Durable propagation

The identity is stored or checked at each boundary:

| Boundary | Rule |
|---|---|
| Snapshot capture | capture receipt/basis binds identity |
| Recognizer | basis and basis hash bind identity |
| Scan cache | plan, prior artifact and merge result must agree |
| Graph artifact | profile-bound `resultOf` requires exact identity |
| Physical inventory | inventory hash and pointer bind identity |
| Navigator event | every profile-bound event carries identity and denormalized project fields |
| Graph pointer | reader may require exact identity |
| Daemon/Q1 | run attribution and stream generation require exact identity |

Legacy artifacts remain readable only from the legacy startup mode. They do not satisfy a
profile-bound read.

## 4. Incremental reuse

A cache candidate is reusable only when:

```text
same project recognition identity
same prior snapshot/record basis
same compiler-options basis
required artifact exists and validates
```

Changed configuration produces a full rescan. A project switch alone does not. If
`fullScanOnActivation=true`, the caller must explicitly mark the activation run; the policy does not
turn every later run into a full scan. This allows:

```text
activate A → recognize → activate B → activate unchanged A → reuse A durable state
```

while refusing:

```text
activate A → copy pointer/cache to B → B reuses A
```

## 5. SURF/DIVE publication order

On a new project generation:

```text
authorize exact B generation
→ receive boundary event for B
→ clear/park A physical state
→ clear/park A semantic state
→ set active B generation
→ accept B inventory/recognition events
→ ignore all late A events
```

An ordinary refresh within the same generation does not manufacture a project switch. Q1 accepts
identity only from one coherent recognition envelope, never by combining unrelated nested fields. A
cancelled activation requires a fresh boundary before the current project is replayed. Q1 may replay
an unchanged project's durable pointer when that pointer carries the exact expected identity.

## 6. Failure policy

The runtime fails closed for:

```text
missing profile/runtime identity
path escape
missing build config
unsupported follow-symlink policy
no supported static adapter
legacy or mismatched cache artifact
legacy or mismatched inventory pointer
legacy or mismatched graph pointer
stale Navigator stream generation
cross-project console frame/Status pairing
```

No failure is converted into a cache miss that could accidentally attribute foreign evidence. Where
a safe full scan is possible, the planner names the invalidation reason and scans under the current
identity.
