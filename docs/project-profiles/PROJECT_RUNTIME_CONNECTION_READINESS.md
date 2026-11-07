# CLU-E Project Profiles — Host and Git Runtime Readiness

**Document class:** runtime connection contract  
**Implemented by:** Batch 4 / PP-21 and PP-22  
**Status:** backend baseline; operator API/UI arrives in later batches

## 1. PowerShell/Host

### Effective configuration

The PowerShell executable may come from a global installation default or an explicit project
override. A bare command such as `pwsh.exe` is resolved through the supplied `PATH` and Windows
`PATHEXT`; a path-qualified value must identify an existing file. All roots and host authority remain
project-scoped.

The launch binding contains:

```text
executable
host script
canonical Target Root
workspace root
shadow root
browser profile root
Project Operation Identity
```

### Readiness classification

| State | Meaning |
|---|---|
| `READY` | executable/script exist; handshake, roots and project identity agree |
| `UNAVAILABLE` | effective PowerShell executable is unavailable |
| `INVALID PATH` | host script or required project-owned path is invalid |
| `HANDSHAKE FAILED` | process/protocol failed without a proven root/identity contradiction |
| `ROOT MISMATCH` | root, path, zone or Project Operation Identity differs |

### Wire rule

Profile-bound startup passes the canonical Project Operation Identity as JSON. Every request and
response carries that identity. Unknown envelope fields remain rejected. Identity parity is checked
independently by both host and client.

No API key or other credential is part of this identity.

## 2. Git

### Readiness versus synchronization

Readiness is a local inspection. Synchronization is a separate explicit mutation. The two must not
share an implicit control path.

Readiness may execute only local commands such as:

```text
git --version
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
git symbolic-ref --quiet --short HEAD
git rev-parse HEAD
git status --porcelain
git check-ref-format --branch <default>
```

It does not execute:

```text
fetch
pull
push
ls-remote
merge
```

### Publication states

| Profile state | Readiness | Local operations | Publication |
|---|---|---:|---:|
| `NO_REMOTE_YET` | `READY_LOCAL_ONLY` | yes | no |
| `LOCAL_ONLY` | `READY_LOCAL_ONLY` | yes | no |
| valid `REMOTE_REGISTERED` | `READY` | yes | yes, explicit only |
| invalid/mismatched repository | `INVALID` | no | no |
| dirty/detached/base mismatch | `BLOCKED` | local reads only | no |

### Explicit sync guard

Before explicit synchronization:

```text
caller expected identity
== durable profile operation identity
== selected repository Target Root
```

A mismatch results in refusal before Git starts. Local-only mode also returns before Git starts.

## 3. Activation behavior

Batch 4 exposes services only. Installing it does not launch or test Host/Git automatically. Later
API/CLI activation code must:

1. resolve the selected durable profile generation;
2. acquire the project runtime generation/lease;
3. call readiness with the exact durable record;
4. publish sanitized readiness;
5. require a new explicit action for Git synchronization.

`START CLU-E` may refresh local Git readiness but must never invoke manual synchronization.
