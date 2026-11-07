# CLU-E Configuration Supplement — Project Profiles, Authority Bindings and Runtime Connections

**Document class:** configuration/interface supplement  
**Date:** 14 August 2026  
**Scope:** Configuration tab, project-profile authority, per-target persistence, governed document bindings, runtime connections, readiness validation  
**Applies to:** CLU-E post-P2 architecture  
**Status:** proposed normative implementation supplement

---

# 1. Purpose

The CLU-E Configuration tab must evolve from a mostly installation-oriented configuration surface into a **project-profile control plane**.

CLU-E is expected to work with multiple target projects over time.

Each target therefore needs its own durable profile containing:
- CLU-E-local project identity;
- target repository/root;
- project authority documents;
- Master Benchmark;
- target description/context;
- optional additional governed instructions;
- recognition settings;
- project-specific state;
- Great Book / improvement history;
- proof/cycle state;
- runtime integration settings;
- benchmark-runtime settings.

The Configuration tab must allow the operator to create, select, edit, validate and persist these project profiles.

The design principle is:

> **One selected CLU-E Project Profile defines one complete target operating context.**

Changing the selected project must switch CLU-E to that target's complete project-scoped configuration and state.

---

# 2. Core Configuration Model

Configuration must distinguish between:

```text
GLOBAL CLU-E SETTINGS
        +
PROJECT PROFILE SETTINGS
```

## 2.1 Global settings

Global settings are installation-level defaults that may be shared by multiple projects.

Examples:
- CLU-E installation identity;
- default PowerShell executable;
- default Chrome executable;
- OpenAI provider configuration;
- optionally encrypted/shared GPT API credential;
- global Metric Catalogue;
- common adapter registry;
- global UI preferences.

A project may override a global setting only where explicitly supported.

---

## 2.2 Project Profile settings

Each project profile owns all target-specific state.

A Project Profile must include at minimum:

```text
projectId
targetRoot
workspaceRoot
projectStateDatabase
greatBookScope
authorityDocumentBindings
masterBenchmarkBinding
targetDescriptionBinding
additionalGovernedDocuments
recognitionConfiguration
benchmarkRuntimeConfiguration
PowerShell/host configuration
Git configuration
Chrome/browser configuration
GPT configuration or credential reference
proof/cycle state
snapshot/cache state
```

---

# 3. Project Selector

The Configuration tab must start with a dedicated **PROJECT** section.

Suggested layout:

```text
PROJECT

Saved Project        [ ▼ select existing project ]
Project ID           [ editable text field ]
Target Root          [ path ] [ SELECT ]
Profile Status       [ VALID / INVALID / INCOMPLETE ]

[ CREATE NEW ]
[ SAVE ]
[ DELETE ]
```

---

# 4. Project ID

## 4.1 Editable

`Project ID` must be editable from the keyboard.

It is a CLU-E-local identifier.

It does not have to equal:
- Git repository name;
- folder name;
- package name;
- product name.

Example:

```text
clu
murugan
murugan-webgpu
client-a-engine
experiment-project-01
```

---

## 4.2 Naming convention

Project ID should be normalized to a governed CLU-E naming convention.

Recommended canonical form:

```text
[a-z0-9][a-z0-9._-]*
```

Recommended behavior:
- trim whitespace;
- lowercase by default;
- reject empty value;
- reject path separators;
- reject control characters;
- reject duplicate Project ID.

The system should not silently rename a project after creation.

---

## 4.3 Project ID purpose

Project ID should be used as the stable CLU-E-local namespace for project-scoped resources.

Example:

```text
workspace/projects/<projectId>/
state/projects/<projectId>/
great-book/<projectId>/
proof/<projectId>/
recognition/<projectId>/
```

Physical paths may differ internally, but the logical scope must remain project-bound.

---

# 5. Saved Projects Dropdown

CLU-E must persist defined Project Profiles.

The operator must be able to select an existing project from a dropdown.

Example:

```text
Saved Project
  ▼
  CLU
  MURUGAN
  TEST-BENCH
  CLIENT-A
```

Selecting a project must load the entire profile.

It must not load only visible form fields while leaving another project's runtime state active.

Project selection must switch:
- target root;
- authority documents;
- database/state namespace;
- Great Book;
- recognition cache;
- proof/cycle state;
- benchmark;
- Chrome target/runtime settings;
- Git settings;
- project-specific host configuration.

---

# 6. Target Root

`Target Root` must be selectable with a dedicated button.

Suggested UI:

```text
Target Root

F:\Murugan\Murugan        [ SELECT ]
```

The button should use the available platform file-system/directory-selection mechanism.

Manual typing may remain available, but selection must be supported.

---

## 6.1 Canonical path authority

Before saving:
- resolve the path;
- normalize separators;
- canonicalize case where platform rules require it;
- resolve aliases/reparse semantics using the existing CLU-E path authority model;
- store a canonical target-root identity.

---

## 6.2 Duplicate target root prohibition

**Two Project Profiles must never point to the same canonical Target Root.**

This is a hard invariant.

Example:

```text
Project ID: murugan
Target: F:\Murugan\Murugan

Project ID: murugan-test
Target: F:\Murugan\Murugan
```

must be rejected.

Reason:

The Project ID is a CLU-E-local namespace, but the target root represents physical project identity.

Allowing two profiles for the same physical target could split:
- Great Book history;
- recognition history;
- proof history;
- mission authority;
- project configuration;
- target identity.

The system should return a clear validation error:

```text
TARGET ROOT ALREADY REGISTERED
Existing Project: murugan
```

---

# 7. Project-Scoped Persistence

Each Project Profile must own its own persistent project state.

At minimum:

## 7.1 SQL / projection database

Each project must have its own logical SQL/projection database namespace.

Recommended concept:

```text
projectStateDatabase = projectId scoped
```

The implementation may use:
- one physical SQLite database per project; or
- one database with strict project partitioning.

A separate database per project is simpler and safer unless there is a strong architectural reason to share.

---

## 7.2 Great Book

Each project must have its own Great Book / improvement history.

An ACCEPT from project `murugan` must never appear as an ACCEPT belonging to project `clu`.

Great Book identity must bind at least:

```text
projectId
targetRootIdentity
mission
proof verdict
accepted candidate
benchmark basis
```

---

## 7.3 Recognition state

Project-scoped:
- physical inventory snapshot;
- recognition cache;
- semantic graph state;
- adapter basis;
- invalidation state.

Switching projects must not reuse another project's recognition cache.

---

## 7.4 Proof and cycle state

Project-scoped:
- proof attempts;
- verdicts;
- cycles;
- candidates;
- benchmark baselines;
- evidence;
- project closure/epoch state where applicable.

---

# 8. PROJECT AUTHORITY Section

Create a dedicated Configuration section named:

```text
PROJECT AUTHORITY
```

This section defines the governed project-specific documents that CLU-E and the AI layer must consider.

Suggested layout:

```text
PROJECT AUTHORITY

Target Description
[ path ................................ ] [ SELECT ]

Master Benchmark
[ path ................................ ] [ SELECT ]

Project Intent / Constraints
[ path ................................ ] [ SELECT ]

Additional Governed Documents
[ + ADD .MD FILE ]

architecture-rules.md       [ role ▼ ] [ enabled ] [ X ]
performance-priorities.md   [ role ▼ ] [ enabled ] [ X ]
security-constraints.md     [ role ▼ ] [ enabled ] [ X ]
```

---

# 9. Target Description / Context

There must be a distinguished file binding for the target project description/context.

Suggested label:

```text
TARGET PROJECT DESCRIPTION
```

or:

```text
TARGET DESCRIPTION / CONTEXT
```

It must be selectable per Project Profile.

It should normally be a `.md` file.

Purpose:
- explain what the target is;
- architecture;
- functionality;
- project purpose;
- important context;
- terminology;
- major components;
- operator/Creator intent.

The AI layer should treat it as high-priority project context.

---

# 10. Master Benchmark

There must be a distinguished file binding for:

```text
MASTER BENCHMARK
```

This must not be mixed into generic additional documents.

The Master Benchmark is a first-class proof authority.

The profile should store:
- path;
- content hash;
- benchmark ID;
- benchmark version if present;
- validation state;
- last validated timestamp.

Suggested UI:

```text
MASTER BENCHMARK

F:\Murugan\Murugan\benchmark\master-benchmark.md [ SELECT ]

Status: VALID
SHA-256: ...
```

A project intended for proof-authoritative optimization must not be `READY` if its required Master Benchmark is missing or invalid.

---

# 11. Project Intent / Constraints

Reserve a separate distinguished authority binding for future Project Intent compilation.

Suggested label:

```text
PROJECT INTENT / CONSTRAINTS
```

It may initially be an optional `.md` file.

It should capture:
- protected capabilities;
- non-negotiable behaviors;
- allowed trade-offs;
- forbidden trade-offs;
- target-level priorities;
- quality constraints;
- fidelity constraints.

This document can later become input to the Project Intent Model compiler.

---

# 12. Additional Governed Documents

The Project Profile must support **zero or more additional governed `.md` files**.

These are not ordinary attachments.

They are project-specific instructions/context that the AI and relevant CLU-E reasoning components must take into consideration.

Examples:

```text
architecture-rules.md
coding-standards.md
security-constraints.md
performance-priorities.md
deployment-rules.md
product-requirements.md
creator-instructions.md
known-limitations.md
testing-rules.md
style-guidelines.md
```

---

## 12.1 Multiple files

UI must allow:

```text
[ + ADD GOVERNED DOCUMENT ]
```

Each added item must be removable individually.

---

## 12.2 Role

Each document should have a role.

Recommended roles:

```text
Architecture
Coding Standard
Performance
Security
Product Requirements
Operational Constraint
Testing
Deployment
Creator Instruction
Known Limitation
Other
```

Role is metadata to help CLU-E organize and reason about authority.

---

## 12.3 Enabled state

Each additional document should support:

```text
enabled = true / false
```

Disabled documents remain in the Project Profile but do not enter the active authority basis.

---

## 12.4 Ordering / priority

Documents should have a deterministic order.

Recommended hierarchy:

```text
1. Target Description
2. Master Benchmark
3. Project Intent / Constraints
4. Additional Governed Documents
```

Within Additional Governed Documents, store explicit ordering.

Do not depend on filesystem enumeration order.

---

## 12.5 Hash binding

For every active governed document store/derive:

```text
canonicalPath
sha256
role
enabled
order
lastValidated
```

A changed document must produce a changed project authority basis.

The system must not silently treat modified instructions as the same authority state.

---

# 13. Authority Conflict Policy

The system must define precedence.

Recommended rule:

```text
Master Benchmark / proof contract requirements
    >
Project Intent / protected constraints
    >
Target Description
    >
Additional Governed Documents
```

However, conflicting authority should preferably be surfaced rather than silently resolved.

Example:

```text
AUTHORITY CONFLICT

performance-priorities.md says:
"visual fidelity may be reduced"

Project Intent says:
"visual fidelity must not be reduced"
```

CLU-E should fail closed or request governed resolution rather than choosing arbitrarily.

---

# 14. AI Context Integration

Governed project documents must be part of the project's AI reasoning basis where relevant.

They must not simply be displayed in Configuration.

The context construction pipeline should expose the selected active documents to:
- candidate generation;
- experiment planning;
- proof interpretation;
- project analysis;
- Project Intent compilation;
- relevant AI-assisted recognition/reasoning.

The context must bind exact document hashes.

---

# 15. Metric Catalogue

The existing Metric Catalogue remains unchanged.

It should remain a clearly separate Configuration section.

Recommended policy:

```text
Metric Catalogue = CLU-E global measurement authority
Project Authority = target-specific authority
```

Do not duplicate the Metric Catalogue into every Project Profile unless future requirements explicitly demand project-specific catalogue overrides.

---

# 16. Recognition Configuration

Add a per-project:

```text
RECOGNITION
```

section.

At minimum expose:

```text
Source Roots
Excluded Paths
Build / Compiler Config
Adapter Selection
Recognition Policy
```

Example:

```text
RECOGNITION

Source Roots
  src/
  ui/

Excluded
  node_modules/
  dist/
  workspace/

Build Configuration
  tsconfig.json

Adapters
  TypeScript    enabled
  JavaScript    enabled
  WGSL          enabled
```

This becomes increasingly important in P3 as CLU-E gains multiple environment adapters.

---

# 17. PowerShell / Host Configuration

Create a dedicated section:

```text
POWERSHELL / HOST
```

Suggested fields:

```text
PowerShell Executable
Host Script
Host Root Authority
Project Root
Workspace Root
Health
```

Actions:

```text
[ TEST CONNECTION ]
[ RESTART HOST ]
```

Display explicit state:

```text
READY
UNAVAILABLE
INVALID PATH
HANDSHAKE FAILED
ROOT MISMATCH
```

---

## 17.1 Global default vs project override

The PowerShell executable itself may be global.

Project-specific roots and host authority bindings must be project-scoped.

---

# 18. Git Configuration

Create:

```text
GIT
```

section.

Fields should support:

```text
Repository Root
Remote
Provider
Default Branch
Protected / Landing Ref Policy
Current Base Pin
Publication Mode
```

Actions:

```text
[ VALIDATE REPOSITORY ]
[ REFRESH STATE ]
[ SYNC GIT ]
```

Important invariant:

> `START CLU-E` must never automatically synchronize Git.

Git synchronization remains explicit.

---

## 18.1 No remote

Support:

```text
NO_REMOTE_YET
```

as a legitimate state.

A local-only target must still be usable for:
- recognition;
- analysis;
- proof;
- Great Book;
- local optimization.

Publication and landing remain unavailable until configured.

---

# 19. Chrome / Browser Execution & Capture

Create a dedicated:

```text
CHROME / BROWSER EXECUTION & CAPTURE
```

section.

This is not merely a Chrome connection setting.

It defines the governed browser instance, page target, execution channel and evidence-capture channel that CLU-E may use for:
- Chrome console commands;
- runtime inspection;
- benchmark execution;
- performance measurements;
- browser-side diagnostics;
- return-value capture;
- later proof and AI analysis.

CLU-E must never target an arbitrary browser window or "whatever Chrome is currently open".

---

## 19.1 Dedicated browser-instance identity

Each Project Profile must resolve to one explicit browser instance.

Preferred operating mode:

```text
CLU-E MANAGED
```

CLU-E launches Chrome using:
- configured Chrome executable;
- dedicated remote-debugging port;
- dedicated profile directory;
- project-specific allowed origin/URL.

Example:

```text
Chrome Executable:
C:\Program Files\Google\Chrome\Application\chrome.exe

Dedicated Profile:
F:\CLU\browser-profiles\murugan

Remote Debugging Port:
9223

Allowed Origin:
http://127.0.0.1:8080
```

This isolates CLU-E-controlled browser activity from the Creator's normal browsing sessions.

---

## 19.2 Launch mode

Support:

```text
Launch Mode

[ CLU-E MANAGED ]
[ ATTACH TO EXISTING ]
```

### CLU-E MANAGED

Preferred mode.

CLU-E owns the browser process/session identity.

### ATTACH TO EXISTING

Allowed only when the operator explicitly selects a debug-enabled browser instance.

CLU-E must never infer the correct process from ordinary desktop windows alone.

---

## 19.3 Browser target hierarchy

Browser authority should resolve through:

```text
Project Profile
   ↓
Chrome Instance Identity
   ↓
Browser Session ID
   ↓
Target / Page ID
   ↓
Allowed Origin
   ↓
Execution Channel
```

Every browser execution must be bound to the selected project and exact target/page.

---

## 19.4 Target discovery

After connecting to the configured Chrome debugging endpoint, CLU-E must enumerate available targets/pages.

Display at minimum:

```text
Target/Page ID
Title
URL
Origin
Type
Connection State
```

Action:

```text
[ DISCOVER TABS ]
```

The operator must be able to inspect and explicitly select a page when required.

---

## 19.5 Target selection rule

A Project Profile should define:

```text
Target URL
Allowed Origin
Target Selection Rule
```

Recommended resolution order:

```text
1. exact previously selected Target/Page ID if still valid
2. exact configured target URL
3. unique page within configured allowed origin
4. otherwise BLOCK as ambiguous
```

---

## 19.6 Ambiguous target prohibition

If more than one eligible page matches and no exact target has been selected, CLU-E must refuse execution.

Example:

```text
TARGET AMBIGUOUS

2 eligible browser targets found:

A84F...  http://127.0.0.1:8080
B113...  http://127.0.0.1:8080/debug
```

Required state:

```text
Browser Execution Ready = NO
Reason = TARGET_AMBIGUOUS
```

CLU-E must not guess.

---

## 19.7 Active browser identity

Configuration/runtime state should expose:

```text
Chrome Instance ID
Browser Session ID
Target/Page ID
Target URL
Target Origin
Chrome Version
Debug Endpoint
```

This identity should be visible in browser-execution evidence.

---

## 19.8 Execution channel

CLU-E must be able to construct and submit governed browser-side commands/scripts to the selected page target.

Each execution should have an explicit ID:

```text
browserExecutionId
```

Example:

```text
EXEC-000123
```

Execution request must bind at least:

```text
projectId
projectProfileHash
browserExecutionId
browserSessionId
targetPageId
targetUrl
targetOrigin
command/script hash
timestamp
timeout
```

---

## 19.9 Capture channel

CLU-E should support governed capture of permitted browser-side outputs, including where available:

```text
command return value
console.log
console.warn
console.error
runtime exceptions
performance results
benchmark output
selected network/performance information
```

The captured result must remain associated with the exact browser execution that produced it.

---

## 19.10 Request / response evidence

Every browser execution used for analysis or proof should create a durable evidence pair.

Recommended evidence fields:

```text
browserExecutionId
projectId
mission / scenario / proof binding
browserSessionId
targetPageId
targetUrl
Chrome version
request hash
response hash
startedAt
completedAt
status
```

Conceptually:

```text
CLU-E request
      ↓
EXEC-000123
      ↓
selected Browser Session
      ↓
selected Target/Page ID
      ↓
Chrome execution
      ↓
result / console / measurement
      ↓
response bound to EXEC-000123
      ↓
durable evidence
      ↓
future CLU-E analysis / proof
```

---

## 19.11 Origin restriction

Browser execution must remain project-scoped and origin-restricted.

Example:

```text
Project: murugan
Allowed Origin:
http://127.0.0.1:8080
```

CLU-E must reject execution against unrelated pages even if they are visible through the same debugging endpoint.

---

## 19.12 Dedicated profile recommendation

Preferred architecture:

```text
Project CLU
   → dedicated Chrome profile
   → dedicated debugging port/session

Project MURUGAN
   → dedicated Chrome profile
   → dedicated debugging port/session
```

This prevents one project's browser state, cookies, targets or console context from leaking into another project.

---

## 19.13 Browser configuration fields

Recommended Configuration fields:

```text
Chrome Executable
Launch Mode
Dedicated Profile Directory
Remote Debugging Port / Endpoint
Allowed Origin
Target URL
Target Selection Rule

Active Chrome Instance ID
Active Browser Session ID
Active Target/Page ID
Active Target URL
Chrome Version
```

Actions:

```text
[ LAUNCH / ATTACH ]
[ DISCOVER TABS ]
[ SELECT TARGET ]
[ TEST CONNECTION ]
[ TEST EXECUTION ]
[ OPEN TARGET ]
```

---

## 19.14 Browser readiness states

Recommended explicit states:

```text
READY
CHROME NOT FOUND
DEBUG ENDPOINT UNAVAILABLE
SESSION NOT ESTABLISHED
TARGET NOT FOUND
TARGET AMBIGUOUS
ORIGIN FORBIDDEN
TARGET DISCONNECTED
EXECUTION CHANNEL FAILED
CAPTURE CHANNEL FAILED
```

Browser execution is ready only when one exact permitted target/page is resolved.

---

## 19.15 Project switching behavior

Browser session identity is project-scoped.

When switching projects:

```text
Project A
  ↓
release / park Project A browser session as governed
  ↓
activate Project B
  ↓
resolve Project B Chrome configuration
  ↓
launch/attach Project B browser instance
  ↓
resolve exact Target/Page ID
```

A Project A page must never remain the active execution target after Project B becomes active.

---

## 19.16 Acceptance tests

### Multiple Chrome instances

Open several ordinary Chrome instances plus one CLU-E-managed project browser.

Expected:

```text
CLU-E sees/uses only the configured debugging endpoint.
```

### Multiple matching tabs

Open two eligible tabs under the same allowed origin.

Expected:

```text
TARGET_AMBIGUOUS
execution blocked
```

until the operator selects one exact target.

### Wrong-origin tab

Select a tab outside the allowed origin.

Expected:

```text
ORIGIN_FORBIDDEN
execution blocked
```

### Target disappearance

Close the selected target.

Expected:

```text
TARGET_DISCONNECTED
execution blocked until target is re-resolved
```

### Evidence binding

Execute one browser command.

Expected:
- one execution ID;
- one request hash;
- one response hash;
- exact target/page identity;
- result available for later CLU-E analysis.

---

# 20. Benchmark Runtime

Master Benchmark defines benchmark authority, but practical runtime settings also need a dedicated section.

Create:

```text
BENCHMARK RUNTIME
```

Suggested fields:

```text
Working Directory
Benchmark Command
Scenario
Warm-up
Repetitions
Timeout
Target URL
Browser Profile
Resolution
Additional Runtime Args
```

These values must be project-scoped.

Where possible, runtime configuration should be derived from the Master Benchmark or scenario model rather than duplicated.

If duplicated, CLU-E must validate consistency.

---

# 21. GPT / OpenAI Configuration

Create:

```text
GPT / MODEL GATEWAY
```

section.

Suggested fields:

```text
Provider
Model ID
API Key / Credential
Operational State
```

Example:

```text
Provider      OpenAI
Model         gpt-5.6
API Key       ••••••••••••••••
State         READY
```

Actions:

```text
[ TEST CONNECTION ]
```

---

## 21.1 Credential safety

The API key must:
- never be rendered in plain text after storage;
- never appear in logs;
- never appear in Great Book;
- never appear in evidence artifacts;
- never be returned by normal Configuration APIs.

Prefer OS/environment/credential-store-backed storage.

The Project Profile should store a credential **reference**, not the secret itself, where feasible.

---

## 21.2 Exact model

Model identity must remain explicit.

No silent fallback.

Example:

```text
requested: gpt-5.6
effective: gpt-5.6
```

If unavailable:

```text
MODEL UNAVAILABLE
```

rather than silently substituting another model.

---

# 22. Global Defaults and Project Overrides

Configuration must visually distinguish:

```text
GLOBAL DEFAULT
PROJECT OVERRIDE
```

Example:

```text
Chrome executable
  Global: C:\Program Files\Google\Chrome\Application\chrome.exe
  Project override: [ none ]

GPT credential
  Global credential: OpenAI-Primary
  Project override: [ none ]
```

This avoids copying identical installation settings into every project.

---

# 23. Project Profile Persistence Schema

Recommended conceptual shape:

```json
{
  "profileVersion": "clue-project-profile/1",
  "projectId": "murugan",
  "targetRoot": "...",
  "targetRootIdentity": "...",
  "workspaceRoot": "...",

  "authority": {
    "targetDescription": {},
    "masterBenchmark": {},
    "projectIntent": {},
    "additionalDocuments": []
  },

  "recognition": {},
  "benchmarkRuntime": {},

  "integrations": {
    "powershell": {},
    "git": {},
    "chrome": {},
    "gpt": {}
  },

  "state": {
    "database": "...",
    "greatBook": "...",
    "recognition": "...",
    "proof": "..."
  }
}
```

This is conceptual, not a requirement to use JSON as the actual storage layer.

---

# 24. Profile Versioning

Project Profiles must have a schema version.

Example:

```text
clue-project-profile/1
```

Future incompatible configuration changes require explicit migration.

Do not reinterpret old profiles silently.

---

# 25. Project Creation Workflow

Recommended creation flow:

```text
CREATE NEW PROJECT
        ↓
enter Project ID
        ↓
select Target Root
        ↓
validate unique ID
        ↓
canonicalize root
        ↓
validate root not already registered
        ↓
create project-scoped state paths/database
        ↓
select Target Description
        ↓
select Master Benchmark
        ↓
optional Project Intent
        ↓
optional Additional Governed Documents
        ↓
configure recognition
        ↓
configure integrations
        ↓
validate
        ↓
SAVE
```

---

# 26. Project Switching Workflow

Switching active project should be atomic from the user's perspective.

Recommended flow:

```text
select Project B
        ↓
stop/refuse unsafe Project A write activity
        ↓
persist Project A state
        ↓
load Project B profile
        ↓
open Project B database/state
        ↓
load Project B Great Book
        ↓
load/replay Project B inventory
        ↓
load Project B authority basis
        ↓
validate Project B integrations
        ↓
publish Project B as active
```

Do not expose a mixed-generation state where:
- UI says Project B;
- database still belongs to Project A;
- Great Book still belongs to Project A.

---

# 27. Active Project Identity

The active Project ID must be visible beyond Configuration.

Recommended:
- dashboard header;
- Q1 header;
- proof board;
- Great Book;
- Operational Console.

Example:

```text
ACTIVE TARGET: MURUGAN
```

This reduces the risk of running an operation against the wrong target.

---

# 28. Project Readiness Section

Add a prominent:

```text
PROJECT READINESS
```

section.

Example:

```text
PROJECT READINESS

Project ID                PASS
Target Root               PASS
Target Description        PASS
Master Benchmark          PASS
Project Intent            OPTIONAL / PASS
Governed Documents        PASS
Recognition               PASS
PowerShell                PASS
Git                       LOCAL ONLY / NO_REMOTE_YET
Chrome                    PASS
GPT                       PASS
Metric Catalogue          PASS

STATUS: READY
```

---

# 29. Readiness Levels

Recommended states:

```text
READY
READY_LOCAL_ONLY
INCOMPLETE
BLOCKED
INVALID
```

---

## 29.1 READY

All required configuration for intended operations exists.

---

## 29.2 READY_LOCAL_ONLY

Everything required for local recognition/proof is ready, but publication is unavailable because Git remote/provider is absent.

---

## 29.3 INCOMPLETE

Required fields are missing.

---

## 29.4 BLOCKED

Configuration exists but a required connection or authority check fails.

---

## 29.5 INVALID

Profile violates a hard invariant:
- duplicate Project ID;
- duplicate target root;
- invalid root;
- malformed profile;
- authority conflict;
- incompatible schema.

---

# 30. Operation-Specific Readiness

One global readiness flag is not sufficient.

CLU-E should also expose capability readiness.

Example:

```text
Recognition Ready     YES
Proof Ready           YES
Browser Benchmark     YES
AI Candidate Gen      YES
Git Publication       NO
Custodian Landing     NO
```

This is superior to blocking the entire project because an optional remote is absent.

---

# 31. Validation Rules

At minimum enforce:

```text
Project ID unique
Target Root unique
Target Root exists
Target Description exists
Master Benchmark exists where proof is required
Authority files exist
Authority hashes valid
State/database path belongs to correct project
Recognition roots remain inside allowed target scope
PowerShell host root parity valid
Git repo matches target profile
Chrome connection matches configured target/origin
GPT provider/model ready when AI operations are requested
Metric Catalogue valid
```

---

# 32. Save Semantics

Configuration writes must be safe.

Recommended process:

```text
edit draft
  ↓
validate draft
  ↓
compute canonical profile
  ↓
write durable profile
  ↓
emit project-profile.updated authority event
  ↓
activate new profile generation
```

The visible active profile should correspond to one complete generation.

Avoid partially applied field-by-field state.

---

# 33. Profile Hash / Configuration Identity

Each saved canonical profile should produce a deterministic hash.

Example:

```text
projectProfileHash
```

It should bind all behavior-relevant project settings except secret values.

Credential references may be bound, but secret bytes must not be embedded.

This hash can participate in:
- mission basis;
- recognition basis;
- proof basis;
- scenario basis.

---

# 34. Authority Document Change Detection

When a governed document changes:

```text
old SHA != current SHA
```

the profile should show:

```text
AUTHORITY CHANGED
```

and any mission/proof state that requires exact authority binding should be considered stale until properly renewed.

Do not silently ingest changed authority into an already-running proof cycle.

---

# 35. Configuration UI Suggested Structure

Recommended final layout:

```text
CONFIGURATION

┌ PROJECT ──────────────────────────────────────┐
 Saved Project
 Project ID
 Target Root
 Workspace / State
 Profile generation/hash
└───────────────────────────────────────────────┘

┌ PROJECT AUTHORITY ────────────────────────────┐
 Target Description / Context
 Master Benchmark
 Project Intent / Constraints
 Additional Governed Documents [...]
└───────────────────────────────────────────────┘

┌ RECOGNITION ──────────────────────────────────┐
 Source Roots
 Excludes
 Compiler/build configs
 Adapters / environments
└───────────────────────────────────────────────┘

┌ POWERSHELL / HOST ────────────────────────────┐
 Executable
 Host
 Roots
 Health
└───────────────────────────────────────────────┘

┌ GIT ──────────────────────────────────────────┐
 Repository
 Remote/provider
 Branch/policy
 State
└───────────────────────────────────────────────┘

┌ CHROME / BROWSER ─────────────────────────────┐
 Executable
 Profile
 Endpoint
 Target URL
 Connection
└───────────────────────────────────────────────┘

┌ GPT / MODEL GATEWAY ──────────────────────────┐
 Provider
 Model
 Credential
 Operational readiness
└───────────────────────────────────────────────┘

┌ BENCHMARK RUNTIME ────────────────────────────┐
 Scenario
 Command
 Warmup
 Repetitions
 Timeout
 Runtime/browser parameters
└───────────────────────────────────────────────┘

┌ METRIC CATALOGUE ─────────────────────────────┐
 existing implementation unchanged
└───────────────────────────────────────────────┘

┌ PROJECT READINESS ─────────────────────────────┐
 Recognition
 Proof
 AI
 Browser benchmark
 Git publication
 Custodian landing
 Overall profile state
└───────────────────────────────────────────────┘
```

---

# 36. Backend Requirements

The UI must not become the authority for Project Profiles.

Backend must own:
- profile persistence;
- canonical path validation;
- target-root uniqueness;
- Project ID uniqueness;
- profile schema validation;
- document hash validation;
- active-project state;
- project-state/database selection;
- integration readiness;
- projectProfileHash.

The frontend is a control and presentation layer.

---

# 37. Required Backend API Concepts

Exact endpoint names may differ, but the architecture needs equivalents of:

```text
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects
PUT    /api/projects/:id
DELETE /api/projects/:id

POST   /api/projects/:id/activate
POST   /api/projects/:id/validate

POST   /api/projects/:id/test-host
POST   /api/projects/:id/test-git
POST   /api/projects/:id/test-chrome
POST   /api/projects/:id/test-gpt

GET    /api/projects/:id/readiness
```

All mutation endpoints must validate authority server-side.

---

# 38. Active Project Runtime Binding

Every project-scoped operation should resolve against one explicit active project identity.

Do not rely only on the browser's currently selected dropdown.

Important commands/events should carry:

```text
projectId
targetRootIdentity
projectProfileHash
```

where appropriate.

This prevents stale UI or concurrent operations from crossing project boundaries.

---

# 39. Great Book Isolation Acceptance Test

Create two projects:

```text
Project A → Target A
Project B → Target B
```

Produce an ACCEPT for Project A.

Switch to Project B.

Expected:

```text
Project B Great Book contains zero Project A entries.
```

Switch back.

Project A history remains intact.

---

# 40. Duplicate Root Acceptance Test

Create:

```text
Project A
Target Root = X
```

Attempt:

```text
Project B
Target Root = same canonical X
```

Expected:

```text
REJECT
TARGET ROOT ALREADY REGISTERED
```

Test:
- path case differences;
- slash differences;
- symlink/junction aliases where relevant;
- relative vs absolute aliases.

---

# 41. Authority Binding Acceptance Test

Project:
- Target Description A;
- Master Benchmark B;
- Additional Documents C/D.

Save profile.

Change C.

Expected:
- authority hash changes;
- profile reports authority drift;
- existing proof authority cannot silently treat old and new C as identical.

---

# 42. Project Switching Acceptance Test

With Project A active, capture:

```text
database identity
Great Book identity
target root
inventory snapshot
profile hash
```

Switch to Project B.

All five must change to Project B equivalents atomically.

No mixed state is allowed.

---

# 43. Connection Tests

## PowerShell

Must prove:
- executable exists;
- host starts;
- handshake succeeds;
- root authority matches selected project.

## Git

Must prove:
- repository exists;
- repository root belongs to target;
- remote state is explicit;
- local-only is distinguished from invalid.

## Chrome

Must prove:
- executable/endpoint available;
- configured origin allowed;
- target reachable where required.

## GPT

Must prove:
- credential present;
- provider reachable;
- exact requested model available;
- no fallback.

---

# 44. Security Requirements

Never expose:
- GPT API secret;
- host secrets;
- credential-store bytes.

Configuration export should contain credential references, not raw credentials.

Project deletion must not accidentally delete the canonical target repository.

Deleting a Project Profile should delete only CLU-E-owned profile/state data after explicit confirmation.

---

# 45. Configuration and Mission Authority

A Project Profile affects behavior.

Therefore project profile identity should participate in the mission/authority basis.

At minimum:

```text
projectId
targetRootIdentity
projectProfileHash
authority document hashes
Master Benchmark hash
recognition config hash
```

must be bindable into governed operation identity.

Changing them should invalidate relevant stale mission/proof assumptions.

---

# 46. Configuration and SURF/DIVE

When a Project Profile is activated:

SURF must represent only that project's physical target.

DIVE must represent only that project's semantic graph.

Project switching must reset/rebind Q1 cleanly.

A stale SURF inventory from Project A must never remain visible while Project B is active.

---

# 47. Configuration and Incremental Recognition

Each Project Profile must own its durable recognition snapshot.

On activation:

```text
load profile
  ↓
load project's durable physical inventory
  ↓
replay SURF
  ↓
check target changes
  ↓
incrementally recognize invalidated files
```

Do not run full recognition simply because the user switched away and back to an unchanged project.

---

# 48. Configuration and P3

This Project Profile architecture is a prerequisite for clean P3 universalization.

Future adapters should read project-specific configuration from the active profile.

Examples:

```text
TypeScript adapter → tsconfig
WGSL adapter       → shader roots/config
Python adapter     → Python environment
SQL adapter        → SQL source/config
```

Do not encode target-specific paths into global CLU-E configuration.

---

# 49. Implementation Priority

Recommended order:

```text
1. Project Profile backend schema/store
2. Project ID + Target Root uniqueness
3. Saved Projects dropdown / activation
4. Project-scoped database/state switching
5. PROJECT AUTHORITY bindings
6. Master Benchmark and Target Description fields
7. Additional Governed Documents
8. Recognition profile
9. PowerShell configuration
10. Git configuration
11. Chrome configuration
12. GPT credential/provider/model configuration
13. Benchmark Runtime
14. Project Readiness
15. profile hash / mission binding
16. complete acceptance tests
```

---

# 50. Definition of Done

The Configuration supplement is complete when:

- [ ] multiple Project Profiles can be created and persisted;
- [ ] Project ID is keyboard-editable and unique;
- [ ] Target Root is selectable;
- [ ] duplicate canonical target roots are forbidden;
- [ ] existing projects are selectable from a dropdown;
- [ ] project switching changes the entire active target context;
- [ ] every project has isolated SQL/project state;
- [ ] every project has isolated Great Book history;
- [ ] every project has isolated recognition cache/snapshot;
- [ ] Target Description is selectable per project;
- [ ] Master Benchmark is selectable per project;
- [ ] Project Intent / Constraints is supported;
- [ ] multiple Additional Governed Documents can be added;
- [ ] additional documents have role, order, enabled state and hash;
- [ ] governed document changes are detected;
- [ ] recognition settings are project-scoped;
- [ ] PowerShell/Host settings and readiness are visible;
- [ ] Git settings and readiness are visible;
- [ ] Chrome/browser settings and readiness are visible;
- [ ] GPT provider/model/credential readiness is visible;
- [ ] GPT secrets are not exposed;
- [ ] Metric Catalogue remains unchanged;
- [ ] Benchmark Runtime is project-scoped;
- [ ] Global Defaults vs Project Overrides are explicit;
- [ ] Project Readiness exposes operation-specific capability states;
- [ ] project profile has a deterministic version/hash;
- [ ] profile identity participates in governed mission/proof basis;
- [ ] SURF/DIVE switch correctly with active project;
- [ ] switching projects cannot expose mixed state;
- [ ] switching back to an unchanged project reuses durable inventory/recognition state;
- [ ] backend, not browser UI, enforces all hard invariants.

---

# 51. Final Configuration Principle

The intended behavior is:

```text
CLU-E installation
   │
   ├── Global Metric Catalogue
   ├── Global runtime defaults
   ├── Global adapter registry
   └── Credential references
          │
          ▼
   SELECT PROJECT PROFILE
          │
          ├── Project ID
          ├── Target Root
          ├── Target Description
          ├── Master Benchmark
          ├── Project Intent
          ├── Additional Governed Documents
          ├── Recognition Configuration
          ├── Benchmark Runtime
          ├── PowerShell
          ├── Git
          ├── Chrome
          ├── GPT configuration/reference
          ├── SQL / state
          ├── Great Book
          ├── recognition cache
          └── proof history
                  │
                  ▼
             PROJECT READY
                  │
                  ▼
               START CLU-E
```

The Configuration tab should therefore become the place where the Creator defines:

> **Which project CLU-E is working on, what that project means, what rules govern it, how it is measured, which runtimes CLU-E may use, and which durable state belongs to that target.**

That is the correct configuration model for a multi-target CLU-E platform.
