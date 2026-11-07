# CLU-E Project Profiles — Configuration UI Control Plane

**Implementation batch:** 7  
**Scope:** PP-32 through PP-35  
**UI authority:** control and presentation only  
**Backend authority:** profile persistence, path identity, uniqueness, hashes, validation, readiness and activation

## 1. Purpose

The Configuration tab is the operator-facing control plane for one complete Project Profile. It does not become a second profile store and does not infer target identity from browser state.

The selected durable record, editable draft and active runtime pointer are deliberately separate:

```text
selected durable record
        +
editable non-authoritative draft
        +
backend-published active pointer
```

Changing the selector does not activate a target. Saving a successor does not activate it. The active target changes only after the backend confirms one exact profile generation and the project-bound dashboard surfaces have entered the transition guard.

## 2. UI modules

```text
configurationState.js       stale-response-safe browser draft state
projectSelector.js           saved project / active identity / activation controls
projectEditor.js             creation preparation and durable generation editor
authorityEditor.js           governed document bindings, order, drift and conflicts
recognitionEditor.js         project recognition roots, excludes and policy
hostEditor.js                PowerShell/Host settings and connection result
gitEditor.js                 local repository and explicit publication posture
browserEditor.js             governed Chrome instance, origin and target settings
gatewayEditor.js             exact OpenAI model and credential reference only
benchmarkRuntimeEditor.js    project-scoped benchmark execution settings
projectReadinessPanel.js     operation-specific readiness and blockers
configurationPanel.js        composition and request routing only
actionContracts.js           closed browser action registry
configuration.css            scalable Configuration layout
```

## 3. New-project preparation

The browser collects only human-editable inputs:

```text
templateProjectId
projectId
displayName
targetRoot
workspaceRoot
shadowRoot
browserProfileDirectory
```

`POST /api/projects/prepare-draft` resolves the physical Target Root identity, enforces disjoint path zones and duplicate-root/Project-ID invariants, then returns a strict non-persistent `clue-project-profile/1` draft.

Preparation intentionally clears:

- Target Description;
- Master Benchmark;
- Project Intent;
- Additional Governed Documents;
- benchmark command and scenario;
- browser target URL;
- Git remote/provider/base pin.

Publication returns to `NO_REMOTE_YET`. Nothing is persisted or activated until an explicit save and later activation succeed.

## 4. Governed-document preparation

The browser never computes authority hashes. `POST /api/projects/prepare-document` resolves the requested Markdown file and returns a server-owned binding containing:

```text
bindingId
kind
canonicalPath
sha256
role
enabled
order
validationState
lastValidated
```

Distinguished order is fixed server-side:

```text
0 Target Description
1 Master Benchmark
2 Project Intent / Constraints
100+ Additional Governed Documents
```

Disabled additional documents remain visible in the profile but leave the active authority basis. Drift and unresolved authority conflicts are surfaced as fail-closed states.

## 5. Credential boundary

The Configuration UI supports references only:

```text
env:OPENAI_API_KEY
credential-store:OpenAI/Primary
```

Raw credential bytes are rejected:

- before they are copied into browser draft state;
- by the closed action client before transport;
- by backend secret-safety validation;
- by the Project Profile schema.

No normal API response returns secret bytes.

## 6. Atomic activation presentation

Before an activation request is submitted:

1. Q1 prepares the successor recognition generation.
2. The sealed-frame bus parks and binds the expected successor Project Operation Identity.
3. Q2, Q3 and Q4 clear Project A-derived presentation.
4. The backend performs the atomic runtime transition.

On success from a dashboard hosted through the `ProjectRuntimeManager` seam, the exact active pointer is published to the rail and project-bound surfaces wait for Project B evidence. Late Project A frames are rejected.

On failure, Q1 and the sealed-frame bus cancel the transition and restore Project A as the required active identity. The selected Project B record remains visible for diagnosis, but it is not presented as active. The legacy single-Runtime dashboard deliberately returns `RUNTIME_SWITCH_UNAVAILABLE`; it never fabricates a live switch.

## 7. Readiness presentation

Readiness is assessed for an intended operation rather than collapsed into one health light:

```text
LOCAL PROOF
AI CANDIDATE GENERATION
BROWSER BENCHMARK
GIT PUBLICATION
```

`READY_LOCAL_ONLY` remains a valid result when recognition and proof are ready but Git publication is intentionally unavailable under `NO_REMOTE_YET`.

## 8. Safety boundaries

The Configuration UI does not:

- canonicalize Target Root identity;
- write the profile registry directly;
- write project state directly;
- infer document hashes;
- decide readiness;
- decide authority conflict resolution;
- select arbitrary Chrome tabs;
- contact OpenAI without an explicit connection test;
- synchronize Git as a side effect of `START CLU-E`;
- activate a project merely because it was selected or saved.
