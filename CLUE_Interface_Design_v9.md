# CLU-E Interface Design v9
## Two-Tab, Four-Quadrant WebGPU Mission-Control Console for Recursive Project Improvement

**Document status:** permanent normative operator-interface contract  
**Revision:** 9.3 (pack release 9.0). ADR-0017 introduced separate manual `SYNC GIT` and provider-authoritative funding and token presentation. The sample uses the active mission's model pin.

**Language:** English  
**Normative methodology:** `RPI_Core_Methodology_v9.md`  
**Constitutional companion:** `CLUE_Constitution_v9.md`  
**Normative state companion:** `CLUE_Status_Contract_v9.md`  
**Measurement companion:** `CLUE_Canonical_Measurement_Catalogue_v9.md`  
**Architecture companion:** `CLUE_Architecture_v9.md`  
**AI companion:** `CLUE_AI_Utilization_v9.md`  
**Q1 companion:** `CLUE_Q1_System_Navigator_v9.md`  
**Git lifecycle companion:** `CLUE_Git_Integration_v9.md`  
**Intentionally out of scope:** current implementation status, backend data authority, and file-by-file backlog


---

## Revision Decision

CLU-E uses **exactly two top-level tabs**:

1. **DASHBOARD** — the default operational view.
2. **CONFIGURATION** — the setup, maintenance, catalogue, benchmark, Great Book, integration, and authority surface.

There are no additional top-level tabs and no nested tab systems.

The Dashboard now has one definitive geometry. Beneath the persistent mission rail, its usable body is divided into four equal 25% quadrants:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ CLU-E · DASHBOARD · CONFIGURATION · START/STOP · CLU-E STATUS · HEALTH   │
├──────────────────────────────────┬───────────────────────────────────────┤
│ 1. SYSTEM NAVIGATOR              │ 2. GREAT BOOK IMPROVEMENT FIELD       │
│ target structure / current area  │ canonical 10 × 10 metric grid         │
│                                  │ stacked proven contributions          │
├──────────────────────────────────┼───────────────────────────────────────┤
│ 3. FOUR NEON GAUGES              │ 4. OPERATIONAL CONSOLE                │
│ four selected metrics / families │ real AI / benchmark / PS / CDP I/O  │
│                                  │ cinematic WHAT / WHY / NOW / NEXT     │
└──────────────────────────────────┴───────────────────────────────────────┘
```

The four quadrants are equal within the Dashboard body. The top mission rail is outside that 2 × 2 division.

The permanent action:

```text
CLU-E STATUS
```

opens an in-place, State-Sealed status surface and exports the same validated `clue-status.json` used by automation and production diagnostics.

The interface remains WebGPU-first, black and neon, highly animated, console-like, and governed by CLU-E evidence discipline. Visual intensity may improve comprehension and cinematic identity; it may never invent progress or operational traffic.

Revision v10 preserves all v8 RPI truth and adds full Git and cloud lifecycle visibility without adding a third tab: environment-native recognition, capability slices, cross-environment boundaries, intent/problem-class/current-method records, Applicable Solution Frontier state, proof authority, proof-instrument lineage, value horizon, and multi-dimensional equilibrium are composed inside the existing quadrants and Configuration flow. Git repository registration, Base Pins, leased worktrees, CLU-E branches/commits, remote reviews/checks, cloud evidence publication, divergence, landing, and recovery are added without a third tab and without allowing Git state to impersonate proof.

---

# 1. Product Intent

The CLU-E interface is a **two-tab command environment for continuous, evidence-governed software evolution**.

It is not a conventional SaaS dashboard, chat client, IDE replacement, or administrative form system. It is a visible control surface for:

- a long-running CLU-E mission,
- model-orchestrated logical Measure Assessment Sessions and their physical AI-model calls,
- module and function recognition,
- findings and mitigation candidates,
- sealed patch proposals,
- isolated Git-worktree application, candidate commits, proof, remote review/check state, landing eligibility, and Custodian-controlled protected-ref changes,
- browser and PowerShell testing,
- benchmark evidence,
- certification cycles,
- the living Measurement Catalogue, canonical metric coordinates, normalization profiles, and AI review state,
- the Great Book and its 10 × 10 WebGPU Improvement Field,
- exactly four configurable neon metric gauges,
- a cinematic but source-faithful Operational Console,
- environment-adapter coverage and unsupported material surfaces;
- capability slices and cross-environment contract/impedance analysis;
- Intent & Method Intelligence and Applicable Solution Frontier evidence;
- instrumented or empirical proof authority, including controlled human evaluation;
- value horizon, forecast versus realized value, and RPI conformance;
- full repository/worktree/branch/commit/remote/cloud provenance and recovery;
- and the sealed CLU-E Status used by production diagnostics.

The user should feel that CLU-E is a living machine under deliberate human authority.

The interface must answer two different classes of question without mixing them:

## 1.1 Dashboard questions

- Is CLU-E running?
- What is it doing now?
- What happens next?
- Which measure sessions and AI models are active, why were they routed, and how many calls/tokens are being consumed?
- How much work has been completed?
- How fast is the mission moving?
- When is the next meaningful result expected?
- What has been proven?
- What and why is CLU-E fixing right now?
- Is the current status snapshot valid and exportable?
- Which canonical metrics have accumulated proven improvement, regression, uncertainty, or equilibrium evidence?
- What real commands, code, prompts, benchmark operations, PowerShell responses, and Chrome/CDP events are flowing now?
- Which environments are recognized natively, partially supported, or unsupported?
- What protected intent, problem class, and current method are being assessed?
- Is the current work implementation optimization or a Methodological Opportunity?
- Which proof authority and instrument will decide the claim?
- What value horizon and equilibrium dimension govern continuation?
- Which registered repository, Base Pin, leased worktree, CLU-E branch, and exact candidate commit carry the current experiment?
- Has the result been published for review, which remote checks are current, and are they protective gates or merely informational?
- Is the local/remote/protected-ref state in sync, blocked, stale, diverged, landed, reverted, or recovered?

## 1.2 Configuration questions

- Which project is being scanned?
- Which workspace is maintained?
- Which repository snapshot is authoritative?
- Which Chrome process, tab, frame, and console are controlled?
- Which PowerShell process and working directory are controlled?
- Which IDE and AI systems cooperate with CLUE?
- What limits and safety policies govern execution?
- Which catalogue version, normalization profiles, grid coordinates, family colors, four gauges, Improvement Field mode, and console channels are active?
- Which Environment Adapters and minimum semantic depths are required?
- Which cross-environment contracts and platform profiles are protected?
- Which method-knowledge sources, freshness policy, and frontier-review policy are active?
- Which benchmark-synthesis, human-evaluation, and value-horizon policies are active?
- Which repositories, repository-set roles, remotes/providers, protected branches, CLU-E branch namespaces, merge methods, remote checks, signing rules, and credential scopes are approved?
- Which evidence may be published to source remotes, the CLU-E remote, or an external evidence store, and under which retention/recovery policy?

---

# 2. Absolute Interface Rules

## 2.1 Exactly two tabs

The top-level navigation contains only:

```text
[DASHBOARD]   [CONFIGURATION]
```

No third tab may be introduced for:

- findings,
- sessions,
- tests,
- ledger,
- Chrome,
- PowerShell,
- project selection,
- analytics,
- logs,
- or AI configuration.

All operational content belongs to Dashboard. All environment and policy setup belongs to Configuration.

## 2.2 Dashboard is the launch default

CLU-E always opens on **Dashboard**.

The operator should not need to see configuration during normal operation. Configuration appears only when:

- the operator selects the tab,
- a required dependency is missing,
- the Start action detects an invalid setup,
- or a Dashboard health indicator is selected to focus the corresponding configuration section.

## 2.3 One primary Start / Stop control

Dashboard contains one unmistakable stateful control:

```text
START CLU-E
```

When running, the same control becomes:

```text
STOP CLU-E
```

This is not a decorative button. It is the primary mission authority control.

## 2.4 No generic button farm

Controls must remain sparse and meaningful.

Dashboard should contain only:

- the Start / Stop control,
- the two top-level tabs,
- compact focus controls where necessary,
- and a minimal command rail for expert operation.

Configuration may contain explicit actions such as:

- Browse,
- Detect,
- Attach,
- Test Connection,
- Validate,
- Apply,

but they must be visually integrated into the console and not multiplied into generic toolbar clutter.

## 2.5 Strict palette and four metric-family colors

The permanent analytical palette is:

- Black
- `#00a3e0` — Neon Blue — `TARGET_QUALITY`
- `#f4af2d` — CLU-E Gold — `EVIDENCE_ASSURANCE`
- `#ff5500` — Orange / Red — `ACCEPTANCE_GATES`
- `#39ff88` — Analytical Green — `CLUE_SELF`

The four colors are canonical metric-family identities inside the Improvement Field and gauges.

Lifecycle state is a separate visual channel:

- stable graph truth: blue body with explicit status label;
- Creator focus: gold halo;
- discovery / diagnosis / testing / blocked: orange pulse or fracture;
- active candidate-worktree patching: labeled green moving contour;
- positive contribution: above-floor segment;
- negative contribution: below-floor segment with orange/red fault core;
- stale / weak evidence: reduced opacity;
- invalidated: broken cap glyph and explicit text.

Because green can appear both as the CLU-E Self family color and as a patching lifecycle pulse, context, metric ID, label, geometry, and motion are mandatory. Color alone never carries meaning.

Opacity variants are allowed. No uncontrolled white, purple, pink, gray-blue, or target-specific palette may alter canonical family identity.

## 2.6 WebGPU-first presentation

The interface is designed as a WebGPU-rendered console surface with:

- emissive line architecture,
- animated neon channels,
- depth-separated panels,
- procedural grids,
- energy pulses,
- dynamic data traces,
- glowing edge activation,
- animated topology,
- and smooth, cinematic state transitions.

HTML may support accessibility or failure fallback, but the intended visual experience is WebGPU-native.

---

## 2.7 Every quadrant and major instrument supports fullscreen

Q1, Q2, Q3, Q4, Status, configuration inspectors, evidence viewers, and major diagnostic panels provide an explicit fullscreen action. Fullscreen is a presentation transition only:

- it preserves the same sealed status identity, selection, filters, and evidence references;
- it never creates a second data model;
- closing fullscreen restores the previous quadrant layout and focus;
- keyboard activation and escape behavior are accessible;
- no control or legend required to interpret the surface disappears in fullscreen.


# 3. Visual Direction — More Animated and More Neon

The final interface should be visibly more energetic than the first mockup while preserving clarity.

The desired style is not merely “blue outlines on black.” It is an **active neon information system**.

## 3.1 Layered neon depth

Every major panel should use three visual layers:

1. **Structural line** — sharp, thin, high-precision geometry.
2. **Energy bloom** — restrained luminous halo surrounding active lines.
3. **Depth shadow** — black separation that prevents adjacent panels from merging.

Inactive regions remain dark and quiet. Active regions energize.

## 3.2 Motion language

The interface should use:

- moving energy pulses along dependency and pipeline lines,
- slow breathing glow around active sessions,
- animated scan sweeps across analysis fields,
- live waveform motion for AI calls, Chrome console activity, and PowerShell output,
- small particle packets traveling between session nodes,
- expanding rings when a checkpoint is written,
- gold convergence animations when evidence is accepted,
- short orange interruption arcs when a test fails or a session blocks,
- subtle parallax depth between foreground panels and the background grid.

## 3.3 Motion hierarchy

Motion must communicate meaning:

```text
Continuous slow motion   CLU-E is alive.
Traveling pulse          Work or evidence is moving.
Breathing glow           A task or session is active.
Gold convergence         Proof has been accepted.
Orange interruption      A fault, rejection, or invalid condition exists.
Frozen line              Work is paused or waiting.
```

## 3.4 Avoiding visual waste

Animation must never obscure metrics or consume unnecessary GPU time.

Recommended behavior:

- active operation: full intended animation rate,
- idle observation: reduced animation frequency,
- background tab or minimized window: render-on-demand,
- reduced-motion preference: static glow and state changes only,
- emergency or fault state: animation simplifies rather than becoming chaotic.

The system should look powerful because its movement is purposeful.

---

# 4. Global Two-Tab Shell

## 4.1 Top Mission Rail

The upper edge contains:

```text
CLU-E
Continuous Learning Unit for Efficiency

[DASHBOARD] [CONFIGURATION]

MISSION STATUS
OPERATOR
UTC TIME
SYSTEM HEALTH
```

### Tab appearance

- Active tab: gold interior edge with animated blue-to-gold energy intake.
- Inactive tab: blue outline, low glow.
- Fault requiring configuration: Configuration receives a restrained orange pulse.
- No tab uses filled conventional web-button styling.

## 4.2 Tab transition

Switching tabs should feel like the console is reconfiguring itself rather than loading a new webpage.

Recommended transition:

1. current panel lines retract toward the frame,
2. a horizontal energy sweep crosses the display,
3. the new panel architecture draws itself outward from anchor points,
4. live values appear immediately,
5. slower secondary visualizations fade in afterward.

The transition should complete quickly enough to remain operational: approximately 250–450 ms.

## 4.3 Persistent elements across both tabs

The following never disappear:

- CLU-E identity,
- Dashboard / Configuration tabs,
- one persistent `CLU-E STATUS` control,
- overall mission state,
- Start / Stop authority state,
- system health,
- operator identity,
- emergency fault indicator,
- and the State Integrity Seal.

The Start / Stop control is visually dominant on Dashboard and compact but still visible in Configuration.

---

# 5. DASHBOARD — Default Operational View

## 5.1 Dashboard purpose

Dashboard is for observation and mission control.

It must not expose full path forms, Chrome setup forms, PowerShell environment configuration, or provider credentials. It shows only their operational health.

The Dashboard tells the operator:

> CLU-E is running, this is what it is doing, this is what happens next, these AI resources are being consumed, this is how quickly the mission is progressing, and this is what the evidence has proven.

## 5.2 Dashboard visual composition

The top mission rail contains:

```text
[DASHBOARD] [CONFIGURATION]
START / STOP CLU-E
CLU-E STATUS
mission · target · cycle · snapshot · state seal · integration health
```

The remaining usable body is a fixed equal 2 × 2 matrix:

```text
┌──────────────────────────────────┬──────────────────────────────────┐
│ Q1 SYSTEM NAVIGATOR              │ Q2 GREAT BOOK IMPROVEMENT FIELD │
│                                  │                                  │
│ structural location              │ 10 × 10 canonical metric floor  │
│ semantic zoom                    │ positive / negative stacks       │
│ current target and dependencies  │ Great Book drill-down            │
├──────────────────────────────────┼──────────────────────────────────┤
│ Q3 FOUR NEON GAUGES              │ Q4 OPERATIONAL CONSOLE           │
│                                  │                                  │
│ four selected metric projections │ real subsystem I/O               │
│ native + normalized + confidence │ WHAT / WHY / CURRENT / NEXT      │
│                                  │ CLU-E STATUS control             │
└──────────────────────────────────┴──────────────────────────────────┘
```

Rules:

1. each quadrant occupies 25% of the Dashboard body;
2. no quadrant becomes a third navigation system;
3. selection in one quadrant may focus the same durable IDs in another;
4. all four consume one sealed `ConsoleSnapshot`;
5. no quadrant queries authoritative registries independently;
6. each quadrant has a reduced textual fallback, but no fallback may claim WebGPU health;
7. dense detail opens in-place and returns to the same composition.

# 6. Dashboard Start / Stop Core

## 6.1 Primary control states

The control changes label and energy state according to CLU-E status.

### Stopped

```text
START CLU-E
```

- blue frame,
- quiet glow,
- no moving mission pulse,
- configuration readiness shown beside it.

### Starting

```text
STARTING…
```

- gold energy builds clockwise around the control,
- prerequisite checks stream outward,
- control is temporarily locked.

### Running

```text
STOP CLU-E
```

- gold active ring,
- slow heartbeat,
- mission energy flows into the rest of Dashboard.

### Graceful stopping

```text
STOPPING AFTER CHECKPOINT…
```

- gold fades toward blue,
- current session remains visibly active,
- next sessions are prevented from starting,
- estimated checkpoint time is shown.

### Blocked

```text
START BLOCKED
```

- orange edge,
- exact prerequisite named,
- selecting the control switches to Configuration and focuses the invalid section.

### Error

```text
CLU-E HALTED
```

- orange pulse,
- fault reason visible,
- no claim that work stopped cleanly unless confirmed.

## 6.2 Stop semantics

A normal click on `STOP CLU-E` performs a **graceful stop after the current safe checkpoint**.

A deliberate hold interaction may invoke emergency termination:

```text
HOLD 2 SECONDS — HALT ALL
```

Emergency halt must be visually and semantically distinct. It may leave sessions requiring recovery and must never be presented as an ordinary clean stop.

## 6.3 Start validation

Before starting, CLU-E validates:

- Scan Root,
- Maintenance Root,
- repository state,
- storage availability,
- AI provider availability,
- session policy,
- Chrome policy when browser tests are required,
- PowerShell policy when local execution is required.

If a nonessential integration is unavailable, CLU-E may start in a clearly declared degraded mode. If a required integration is unavailable, Start is blocked with an exact reason.

---

# 7. Dashboard Command Crown

The upper operational band must show:

- overall CLU-E state,
- mission,
- campaign,
- cycle,
- repository snapshot,
- elapsed mission time,
- current session count,
- call count,
- remaining call budget,
- integration health.

Example:

```text
CLU-E STATUS      RUNNING — STABLE
MISSION          MURUGAN PERFECT EFFICIENCY
CAMPAIGN         GPU MEMORY LIFECYCLE
CYCLE            0148
SNAPSHOT         81ac72f
UPTIME           14:26:38

SESSIONS         4 ACTIVE / 6 LIMIT
CALLS            186 TODAY / 3 IN FLIGHT / 11 QUEUED
BUDGET           214 / 400 REMAINING
INTEGRATIONS     PROJECT OK · CHROME OK · PS OK · IDE OK · AI OK
```

Integration health indicators are summaries only. Selecting one switches to Configuration and focuses its section.

---

# 8. Dashboard AI Mission Context Lens

The largest panel displays the current operational narrative.

## 8.1 Permanent sequence

```text
NOW
NEXT
THEN
```

### NOW

Must show:

- active session ID,
- role,
- exact target,
- current task,
- active AI call,
- elapsed time,
- context usage,
- checkpoint state,
- current evidence or code focus.

### NEXT

Must show:

- next session or next action,
- trigger condition,
- estimated start,
- estimated call range,
- reason for its priority,
- whether it may start automatically.

### THEN

Must show:

- the next meaningful milestone,
- patch sealing, candidate-worktree application, benchmark, verdict, landing eligibility, canonical landing, post-land verification, catalogue review, or synthesis step,
- expected dependency on human action under `NOTIFY` or exceptional authority gates,
- earliest plausible result.

## 8.2 No false countdowns

The display must distinguish:

```text
NEXT SESSION IN 00:06:20
NEXT SESSION AFTER CHECKPOINT SES-042
NEXT SESSION AFTER OPERATOR PATCH RECEIPT
NEXT SESSION MANUALLY GATED
NO NEXT SESSION — QUEUE EMPTY
```

Unknown event timing must not be converted into a fake clock.

---

# 9. Dashboard Work, AI, RPI, and Version-Control Lenses

## 9.1 Current Work Contract — WHAT / WHY / HOW PROVEN

This panel is permanent while CLU-E is active. It must never reduce work to “optimizing…” or “analyzing…”. It displays:

```text
WHAT
Target program · Domain/Subsystem · Unit · Granularity · Source anchor
Current canonical measure · Applicability · Finding · Lifecycle stage

WHY
Unit purpose · Parent purpose · Required capability
Evidence · Confidence · Why prioritized · Risk / blast radius

HOW PROVEN
Frozen local metric · Threshold · Mandatory gates
Master Benchmark guardrail · Purpose/workload protection

WHO / MODEL
Logical session · Role · AI model · Route rationale
Token/call budget · Context usage · Refutation status

NEXT
Next tool, benchmark, turn, checkpoint, handoff or terminal condition
```

Selecting the target focuses the same durable ID in the System Navigator. Selecting the measure opens its catalogue record in-place. Unknown purpose or evidence is shown as `CONTEXT INSUFFICIENT`, never filled with generic prose.

## 9.2 AI Orchestration Lens

The interface represents the actual model hierarchy:

```text
CLU-E Scheduler
→ Logical Measure Session
→ Model Orchestrator
→ AI call / Batch item / refuter
→ validated result
```

It must make clear that CLU-E is conducting the conversation. The operator is not expected to copy prompts or responses between AI chats.

For each logical session show:

- unit and measure;
- role;
- selected model and exact version;
- why that model/tier was selected;
- interactive or Batch mode;
- calls completed / projected;
- input, output and cached tokens;
- context utilization;
- current turn and checkpoint;
- escalation and refutation state;
- terminal outcome or next trigger.

Physical calls are grouped beneath the logical session. One Batch may carry many sessions, but the UI must not merge their evidence or cost attribution.

A frontier-model badge is informational, not celebratory. Gold indicates active authority/focus, not model prestige.

## 9.3 AI Sessions and Calls

### 9.3.1 Session telemetry

Always show:

- active sessions,
- configured concurrency limit,
- queued sessions,
- checkpointing sessions,
- completed sessions,
- failed sessions,
- cancelled sessions,
- orphaned or recovery-required sessions.

Each active session row should include:

- session ID,
- role,
- target,
- state,
- calls consumed,
- estimated remaining calls,
- elapsed time,
- P50 / P80 completion estimate,
- successor or handoff target.

### 9.3.2 Call telemetry

Always show:

- calls today,
- calls in the current cycle,
- calls in flight,
- queued calls,
- successful calls,
- failed calls,
- retries,
- discarded responses,
- calls avoided through cached knowledge,
- remaining daily or campaign budget,
- current burn rate.

### 9.3.3 Animated call representation

Active calls may appear as traveling blue packets through session lines.

- outgoing request: blue pulse traveling from session node to provider boundary,
- active inference: breathing gold ring,
- successful result: blue packet returns and locks into checkpoint memory,
- rejected or failed call: orange packet fractures at the boundary,
- cached result: short internal blue path with no provider traversal.

This makes AI consumption visible without relying only on numbers.

---

## 9.4 RPI Current Work Lens — INTENT / METHOD / PROOF / VALUE

The Dashboard preserves the existing `WHAT / WHY / HOW PROVEN` contract and extends it with a compact RPI lens. It is not a fifth quadrant. It is a governed overlay or inspector shared by the selected item across all four quadrants.

It shows, when known:

```text
OBSERVED IMPLEMENTATION
INFERRED INTENT
PROTECTED CAPABILITY
PROBLEM CLASS
CURRENT METHOD
APPLICABLE FRONTIER POSITION
CANDIDATE METHOD OR IMPLEMENTATION CHANGE
EVIDENCE AUTHORITY / PROOF INSTRUMENT
VALUE HORIZON
EQUILIBRIUM DIMENSION
```

Unknown, conflicted, provisional, unsupported, and stale fields remain visible. The lens must never turn an inferred intent or a retrieved method into a fact through typography.

## 9.5 Version Control & Cloud Publication Lens

This compact governed lens is shared by the selected patch, proof, review, landing, or Great Book contribution. It is not a fifth quadrant and is hidden when no Git-backed state applies.

It shows:

```text
REPOSITORY / REPOSITORY-SET ROLE
GIT STATE ENVELOPE / BASE PIN
CREATOR WORKTREE SEAL
LEASED WORKTREE / BRANCH
CHANGE-SET PARTITION
PROVISIONAL / SEALED CANDIDATE COMMIT
LOCAL / REMOTE / PROTECTED REF STATE
REVIEW / APPROVAL / REMOTE CHECKS
EVIDENCE PUBLICATION / RECOVERY
LANDING TRANSPORT / GATE / REVERT
```

The visual hierarchy keeps four facts separate:

```text
VERSION STATE
PROOF STATE
PUBLICATION/REVIEW STATE
LANDING/RECOVERY STATE
```

A green CI check can illuminate the **REMOTE CHECKS** row but may never illuminate the **PROVEN** state. A merged review can show **MERGED — POST-LAND VERIFICATION PENDING**. A changed review head, rewritten remote, or rebased candidate receives an orange `STALE PROOF BINDING` warning until compatibility or re-proof completes.

The lens always includes the exact candidate tree/commit and a direct path to the sealed proof, change-set partition, publication receipt, and raw remote-check artifacts.

# 10. Dashboard Quadrants

Quadrant 1 is the live repository and semantic-navigation surface. It consumes the sealed Repository Inventory and semantic recognition projections from Status v5. Its detailed behavior is owned exclusively by `CLUE_Q1_System_Navigator_v9.md`.

## 10.1 Quadrant 1 — System Navigator

### 10.1.1 Two complementary truths

```text
ALL  = physical repository topology
DIVE = semantic architecture scoped by a selected file
```

ALL shows every eligible governed physical file exactly once:

```text
Project → Artifact Family → Environment → File
```

DIVE excludes File as a visible hierarchy level. The selected file remains in the context header while visible semantic roots follow:

```text
Domain → Subsystem → Module → Class/Type → Function/Method
```

A file may produce several semantic branches. A semantic module may span several files. Neither truth is forced into the other's containment model.

### 10.1.2 Interaction

- single-click inspects a project, family, environment, file, or semantic entity;
- double-click on an ALL file enters DIVE with an exact handoff record;
- double-click on a family or environment frames that group and remains in ALL;
- zoom in ALL changes camera distance and rendering LOD only;
- zoom never changes ALL into DIVE;
- ALL and DIVE preserve separate cameras and selections;
- returning to ALL restores and frames the originating file;
- unsupported files still open a truthful DIVE context explaining the missing adapter or failed recognition.

### 10.1.3 Visual truth

Lifecycle core color and motion remain separate from technology family accent/pattern and environment glyph. Family/environment groups are projection containers, not architectural claims. Unknown, unsupported, partial, stale, failed, and discovered states are explicit. Complete file dependency meshes are not shown by default; selected-file and aggregate relationship lenses reveal evidence-backed edges.

### 10.1.4 Dynamic behavior

Inventory events create and update physical files independently of semantic-unit events. New files appear without reload, modified files retain location identity and receive new version identity, removed files transition explicitly, and reclassified files move deterministically. Replay reconstructs the same truth and stable positions.

### 10.1.5 Q1 controls and fullscreen

The existing top-right `DIVE / ALL` segmented control is the only top-level Q1 mode selector. Search, filters, relationship lenses, family/environment legends, breadcrumbs, and inspectors remain secondary lenses. Q1 supports one-click fullscreen while preserving the same status snapshot and selection identity.


## 10.2 Quadrant 2 — Great Book Improvement Field

### 10.2.1 Purpose

The Great Book Improvement Field answers:

> Across the complete canonical metric system, where has CLU-E produced proven value, where has it accumulated regressions or trade-offs, where is evidence weak, and which areas approach equilibrium?

It is a WebGPU 3D field generated from Great Book contribution records. It is not a benchmark, ledger, or verdict engine.
The field can therefore show implementation quality, method adequacy, cross-environment quality, proof-instrument quality, and RPI value yield without summing their native units.

### 10.2.2 Canonical 10 × 10 floor

The floor contains 100 permanent cells:

- 62 Target Quality coordinates across `MA–MH`;
- 12 Evidence & Assurance coordinates in `MI`;
- 7 Mandatory Acceptance Gates in `MJ`;
- 19 CLU-E Self-Measures in `MK`;
- the final four historical activation cells remain `MH03`, `MG08`, `MI12`, and `MK19` at their permanent coordinates.

Each cell displays:

- canonical ID;
- short name;
- area/family district;
- active aggregation mode;
- coverage and freshness;
- current positive and negative height;
- equilibrium or invalidation marker.

Coordinates come from the Measurement Catalogue. The UI cannot rearrange metric truth. A profile may rotate or tilt the whole field, but it cannot change canonical cell ownership.

### 10.2.3 Column semantics

Each cell owns a stacked 3D column:

- positive certified contribution rises above the floor;
- regression, warning-level compromise, or negative historic contribution extends below;
- one segment equals one immutable Great Book contribution;
- default height is bounded to preserve comparison across metrics;
- frequent experiments cannot create infinite height;
- invalidated evidence leaves certified mode but remains available in historic mode.

The field must never sum native units directly.

### 10.2.4 Family colors

```text
TARGET_QUALITY       #00a3e0
EVIDENCE_ASSURANCE   #f4af2d
ACCEPTANCE_GATES     #ff5500
CLUE_SELF            #39ff88
```

A selected column receives a gold focus halo without losing its family body. Negative segments use a fault core and below-floor position. Confidence and freshness affect intensity/opacity, not family color.

### 10.2.5 Stacked-segment inspector

Immediate hover shows metric ID and current normalized summary.

Dwell opens a glass inspector containing:

- canonical and legacy IDs;
- metric purpose and family;
- native baseline, result, delta and unit;
- magnitude score;
- normalization profile version/hash;
- confidence and freshness factors;
- normalized contribution;
- Target Program, scope, unit, capability and cycle;
- finding, proof contract, benchmark and verdict;
- certificate state and invalidation;
- repository registrations, Git State Envelope, Base Pin, Creator-tree seal, worktree leases, branches, Change-Set Partition, commits, reviews, remote checks, reconciliation and landing/revert state;
- Great Book record;
- purpose/capability/workload gate result.

No segment without this evidence path may be rendered as a proven contribution.

### 10.2.6 Modes and filters

Modes:

```text
CURRENT CERTIFIED
SELECTED CYCLE
HISTORICAL NET
CONFIDENCE ADJUSTED
AVERAGE PER EXPERIMENT
EXPERIMENT COUNT
COVERAGE
EQUILIBRIUM
```

Filters:

- Target Program;
- program/domain/subsystem/module/file/class/function scope;
- capability;
- cycle/pass;
- metric family/area;
- accepted/rejected/invalidated;
- date and Assessment Envelope.

The active mode and filters remain visible in the corner of the quadrant.

### 10.2.7 Motion

- a newly accepted Great Book contribution travels from the Operational Console into its metric cell;
- the target column acquires in family color, pulses in gold, and adds one segment;
- negative contribution descends below the floor with an orange fracture;
- invalidation removes certified energy but leaves a ghost history in historic mode;
- equilibrium adds a restrained cap ring, never a celebratory success color.

Motion is event-driven and render-on-demand when idle.

## 10.3 Quadrant 3 — Four Neon Gauges

### 10.3.1 Exactly four

Quadrant 3 contains exactly four large gauges arranged symmetrically in a 2 × 2 composition. Their selections are configured in Configuration and persisted by operator profile.

A gauge may select:

- one canonical metric;
- one governed metric-family aggregate;
- one required gate summary;
- one target-specific indicator explicitly mapped to a canonical metric.

### 10.3.2 Gauge truth

Every gauge shows:

```text
Metric ID + name
Native value + unit
Normalized value or gate/category state
Delta and trend
Confidence
Coverage
Freshness
Scope
Aggregation mode
Warning / gray area / stale / unknown
```

A categorical metric cannot be presented as a fake percentage. A gate shows `PASS / WARNING / FAIL / UNKNOWN`. A distribution may show a compact band rather than one needle.

### 10.3.3 Gauge color

The gauge inherits its metric family color. Selection or alarm uses separate halo/motion. If several chosen gauges belong to the same family, they retain that color and remain distinct by ID, label, geometry, and native unit.

### 10.3.4 Interaction

- click focuses the metric column in Quadrant 2;
- double-click opens the catalogue record and normalization profile in-place;
- hover shows native evidence and freshness;
- a stale or unavailable gauge remains visible and explicitly degraded.

### 10.3.5 RPI-aware gauge examples

The four configurable slots may select, for example:

- environment semantic coverage;
- applicable-frontier distance or state;
- proof-instrument admissibility/coverage;
- RPI value yield or realized-value ratio.

They remain governed projections. A forecast-value gauge must say `FORECAST`; an unsupported-environment gauge may not render 100%; a categorical frontier state may not be converted into a fake percentage.

## 10.4 Quadrant 4 — Cinematic Operational Console

### 10.4.1 Purpose

The Operational Console answers:

> What is CLU-E computing, sending, receiving, proving, waiting for, and recording right now—and why?

It is cinematic because the data flow is alive. It is trustworthy because every visible operation comes from an ordered, typed, redacted backend event.

### 10.4.2 Canonical channels

```text
CLU-E CORE
RECOGNITION / GRAPH
AI / BATCH
BENCHMARK / PROOF
POWERSHELL
CHROME / CDP
CUSTODIAN
GIT / CLOUD
GREAT BOOK
CLU-E STATUS
```

Every line has:

- sequence;
- timestamp;
- channel;
- inbound/outbound/internal direction;
- kind;
- source IDs;
- status;
- duration when known;
- redaction marker;
- raw artifact link when allowed.

### 10.4.3 Narrative header

The console permanently displays:

```text
WHAT
WHY
CURRENT STATUS
HOW PROVEN
WHO / MODEL
NEXT
```

Example:

```text
BENCHMARKING MC04 · COUPLING AND DEPENDENCY SURFACE
Target: GraphModel.aggregatedEdgesFor()
Why: opposite dependency directions may collapse in semantic aggregation
Proof: directed-edge fixture + global Navigator regression guardrail
Status: baseline command sent to PowerShell
Next: receive exit code, then run the sealed candidate commit from its leased worktree in Chrome
```

### 10.4.4 Real code and command display

When policy permits, the evidence layer shows the actual redacted payload:

```text
AI OUTBOUND       role/context manifest and model route
AI INBOUND        validated structured result summary
BENCHMARK CODE     registered script/probe hash and source excerpt
POWERSHELL OUT     exact approved command
POWERSHELL IN      exit code, stdout/stderr summary, artifact hashes
CHROME/CDP OUT     method, target, frame/context and arguments
CHROME/CDP IN      result, exception, trace or console signatures
CUSTODIAN          gate result, protected-ref landing/revert receipt
GIT / CLOUD         state capture, Base Pin, worktree, branch, commit, push, review, checks, reconciliation, publication
GREAT BOOK         contribution and ledger hash
STATUS             projection/export/seal result
```

Raw artifacts remain outside the visual buffer and open through an auditable link.

### 10.4.5 Cinematic grammar

Allowed:

- channel acquisition;
- neon direction trails;
- code reveal;
- benchmark countdown after real start acknowledgment;
- waveform based on real event rate;
- result lock-in;
- warning fracture;
- checkpoint pulse;
- Great Book transfer animation;
- status-seal ceremony.

Forbidden:

- fake typing unrelated to an event;
- invented benchmark progress;
- fabricated success;
- hidden retries or dropped events;
- decorative console output that resembles evidence;
- changing order to make a better story.

### 10.4.6 Reliability and load management

- repeated lines may be deduplicated with count/rate;
- the UI must disclose collapsed and dropped events;
- filters may hide channels but never change the underlying sequence;
- errors and invalid tests remain pinned;
- secrets are redacted before projection;
- rendering failure cannot stop the underlying operation;
- a textual fallback exposes the same ordered event facts.

### 10.4.7 Controls

Quadrant 4 contains:

```text
CLU-E STATUS
PAUSE AUTO-SCROLL
FILTER CHANNELS
OPEN RAW ARTIFACT
```

`CLU-E STATUS` opens the in-place sealed status surface. It is not a third tab.


### 10.4.8 RPI traffic projection

The canonical channels carry additional typed events for adapter discovery, UPR integration, intent/method classification, method-source retrieval, frontier filtering, proof-instrument synthesis, human-evaluation packet creation, value forecast, and equilibrium evaluation. The `GIT / CLOUD` channel carries real repository/worktree/branch/commit/fetch/push/review/check/publication/reconciliation/landing/revert events. It never reports a commit, PR, green pipeline, approval, or merge as proof. The console does not add a decorative “research” stream; every line resolves to a real event or artifact.

# 11. Cross-Quadrant Progress, Velocity, and Forecasting

## 11.1 Separate progress lanes

These projections feed the top mission rail, gauge selections, console narrative, and in-place overlays. Never collapse the whole mission into one misleading percentage.

Show at least:

1. Recognition Coverage
2. Deep Review Coverage
3. Proven Improvement Coverage
4. Three-Pass Certification Coverage
5. Test-System Maturity

Example:

```text
RECOGNITION          82.4%
DEEP REVIEW          34.1%
PROVEN IMPROVEMENT   11.8%
CERTIFICATION         3.7%
TEST MATURITY        68.2%
```

## 11.2 Progress speed

Show multiple throughput measures:

```text
Recognition velocity    MB/day
Deep-review velocity    weighted KB/day
Proven velocity         proven KB/day
Accepted patches        patches/day
Certification velocity  certified units/day
Test growth             valid tests/cycle
```

The interface must label trend direction:

- accelerating,
- stable,
- slowing,
- blocked,
- volatile.

## 11.3 Weighted work

KB/day remains visible because it is intuitive, but forecasts must use weighted work units accounting for:

- file span,
- dependency surface,
- runtime criticality,
- test cost,
- uncertainty,
- patch risk.

A 3 KB systemic core cannot be treated as easier than 100 KB of isolated helpers.

## 11.4 Forecast format

Every forecast includes:

- P50 estimate,
- conservative P80 estimate,
- confidence,
- evidence basis,
- largest uncertainty,
- recent estimator accuracy.

Example:

```text
NEXT PATCH PACKAGE       P50 00:41:00 · P80 01:07:00
NEXT BENCHMARK VERDICT   P50 01:12:00 · P80 01:48:00
CAMPAIGN FIRST PASS      P50 4.2 days · P80 6.8 days
NEXT EQUILIBRIUM REVIEW  P50 11.6 days · P80 17.3 days
```

When history is insufficient:

```text
FORECAST CALIBRATING
8 MORE COMPARABLE COMPLETIONS REQUIRED
```

---

# 12. Dashboard Patch-to-Proof Pipeline

The lower central spine displays:

```text
ARTIFACT INVENTORY + NATIVE RECOGNITION COMMITTED
→ UPR + CAPABILITY SLICE COMMITTED
→ PURPOSE / INTENT / PROBLEM CLASS / CURRENT METHOD
→ APPLICABLE FRONTIER FILTERED
→ MEASURE SESSION
→ FINDING / METHODOLOGICAL OPPORTUNITY / TERMINAL CLEAN RESULT
→ PROOF AUTHORITY SELECTED
→ PROOF INSTRUMENT VALIDATED
→ PROOF CONTRACT FROZEN
→ BASELINE CAPTURED
→ PATCH SEALED
→ CANDIDATE APPLIED
→ PATCHED EXPERIMENT
→ VERDICT
→ LANDING ELIGIBILITY
→ AUTO / NOTIFY / OUTBOX
→ CANONICAL LANDING
→ POST-LAND VERIFIED / AUTO-REVERTED
→ GREAT BOOK + STATUS
```

The proof, Landing Authority, and Custodian boundaries must remain explicit. Candidate-worktree application is automatic; canonical landing follows the active `AUTO`, `NOTIFY`, or `OUTBOX` policy and all gates. The UI may never collapse `PROVEN`, `ELIGIBLE`, `LANDED`, and `POST-LAND VERIFIED` into one green success state.

## 12.1 Color state

- blue: completed neutral stage,
- gold: active authority, selected stage, or proven evidence,
- orange: discovery, diagnosis, testing, blocked, invalid, rejected, or regressed stage,
- green: candidate-worktree patch application only,
- dark: not yet reached.

Traveling energy should make the current movement of work obvious.

---

# 13. Great Book and Equilibrium Cross-Projection

Great Book truth is visualized primarily in Quadrant 2, narrated in Quadrant 4, and summarized in the mission rail and gauges.

Required compact summaries:

- accepted, rejected, inconclusive and invalid records;
- newly added or invalidated contributions;
- catalogue/normalization review state;
- new finding rate;
- new test rate;
- repeated finding rate;
- regression escape rate;
- clean-cycle count;
- metrics and scopes approaching equilibrium;
- residual uncertainty.

Gold is used for proven evidence/focus, not generic celebration. Equilibrium is a scoped certificate, not a maximum-height bar.

---

## 13.1 CLU-E STATUS — In-Place Status Surface

### 13.1.1 Control behavior

`CLU-E STATUS` is visible in the persistent mission rail on both tabs. It is neither a third tab nor a generic download button.

Activation opens a cinematic in-place overlay with four actions:

```text
VIEW STATUS
EXPORT JSON
VALIDATE SEAL
COMPARE PREVIOUS
```

The overlay may be dismissed without changing mission state. Export uses the daemon's current validated snapshot; the browser does not assemble its own JSON.

### 13.1.2 Status sections

The status surface shows:

- Target, mission, snapshot, Assessment Envelope, catalogue hash, normalization-profile hash and coordinate-map hash;
- recognition, purpose, dependency and runtime-enrichment coverage;
- current cycle/pass and all terminal finding counts;
- current WHAT/WHY/HOW-PROVEN contract;
- unit-level and capability-level state;
- measure applicability and measure-session outcomes;
- AI model routes, calls, tokens, checkpoints, refutations and costs;
- benchmark baseline/latest/net result;
- proof, landing and post-land state;
- Chrome/CDP, PowerShell, database, event log, Git Integration Service, worktree pool, remotes/providers, evidence publication, and Custodian health;
- Great Book, metric contributions, Improvement Field mode/filter, four gauges and equilibrium;
- Operational Console sequence, collapsed/dropped events, channels and source-artifact reconciliation;
- State Seal, source identities and freshness.

Assessment state and live runtime health are rendered in separate columns. `ASSESSED` must never visually imply `HEALTHY NOW`.

### 13.1.3 Production diagnostics

A compact production mode consumes the same schema family and shows runtime diagnostics, capability health, last verified snapshot, freshness, active errors and links to the corresponding assessment record. Production status cannot acquire patch, proof or landing authority.

### 13.1.4 Failure behavior

When the current projection is invalid, the overlay shows the last valid snapshot plus an orange `STATUS PROJECTION FAULT`. It must never render a partially assembled state as current truth.

## 13.2 Measurement Catalogue Status
## 13.3 RPI Conformance and Equilibrium Status

The in-place status surface exposes:

- verified RPI conformance level;
- native environments and adapter depth;
- unsupported material artifacts;
- capability-slice and cross-environment coverage;
- intent/problem-class/current-method confidence;
- active Solution Frontier snapshot and freshness;
- proof authority and instrument validity;
- forecast versus realized value;
- repository registration, Base Pin, worktree lease, branch/commit identity, remote review/check state, publication state, divergence, and recovery readiness;
- evidence, capability, economic, assurance, environment, and method-frontier equilibrium.

A single green `EQUILIBRIUM` label is forbidden when any required dimension is blocked or unknown.


Dashboard shows catalogue version/hash, review freshness and open proposals. Configuration provides no free-form measure editor. Changes are made through validated registry records and a governed AI review workflow.

The Catalogue panel shows:

- active, experimental, deprecated and retired measures;
- applicability coverage;
- sessions/terminal outcomes per measure;
- false-positive and proven-improvement yield;
- escaped-regression and gaming warnings;
- token/cost per decisive verdict;
- next light/full review;
- pending AI proposals and Creator gates.

# 14. CONFIGURATION — Environment and Cooperation View

## 14.1 Configuration purpose

Configuration defines what CLU-E can see, control, call, test, and write.

It must make setup easy without hiding exact paths or contexts.

It is one continuous configuration page inside the second tab. It does **not** introduce nested tabs.

Recommended vertical section order:

1. Project and Repository
2. Git Repositories, Worktrees, Remotes, Reviews, and Cloud Publication
3. Environments, Adapters, and Platform Profiles
4. Cross-Environment Contracts and Capability Slices
5. Intent, Method Knowledge, and Frontier Policy
6. Chrome and Browser Console
7. PowerShell
8. Visual Studio / IDE Cooperation
9. AI Providers and Session Policy
10. Measurement Catalogue, Normalization, Great Book, Gauges and Visualization
11. Testing, Proof Instruments, and Human Evaluation
12. Value Horizon and Equilibrium Policy
13. Storage and Ledger
14. Safety and Authority
15. Configuration Validation

Each section is a framed neon instrument with a visible health state.

---

# 15. Configuration — Project and Repository

## 15.1 Required paths

### Scan Root

The source tree CLU-E reads, indexes, maps, and analyzes.

### Git Worktree Pool / Maintenance Root

The isolated writable worktree where CLU-E applies sealed patches, builds, exercises, benchmarks, and proves them before any canonical landing. It is not the canonical repository. Manual implementation work may use a separately declared maintenance worktree, but the normal proof loop uses the registered leased experiment worktree.

### Artifact Root

The location for:

- patch packages,
- reports,
- traces,
- screenshots,
- benchmark outputs,
- context packs,
- and exported ledger records.

## 15.2 Easy selection methods

Each path supports:

- drag-and-drop folder selection,
- native folder picker,
- direct path entry,
- recent-folder history,
- environment-variable expansion,
- detection from an opened IDE workspace.

## 15.3 Visible repository state

Show:

- absolute path,
- repository detection,
- branch,
- commit,
- dirty-file count,
- submodule state,
- Scan Root / Maintenance Root relationship,
- last index time,
- file watcher state,
- snapshot alignment,
- excluded paths.

## 15.4 Project controls

Compact actions:

```text
BROWSE
DETECT FROM IDE
VALIDATE
SCAN NOW
REBUILD INDEX
WATCH CHANGES
CREATE SNAPSHOT
```

No path is considered valid merely because text exists in the field.

The interface distinguishes:

```text
PATH ENTERED
PATH EXISTS
REPOSITORY DETECTED
SNAPSHOT CONFIRMED
INDEX CURRENT
```

---

## 15.5 Project Intent and Master Benchmark files

Configuration contains two explicit file selectors:

```text
target description.md
benchmark.txt
```

Each selector shows:

- absolute and repository-relative path;
- existence, readability, encoding, and parser/adapter status;
- content hash and last successful load;
- whether the file is inside the registered repository;
- active cycle-lock hash and changed-after-lock warning;
- blocking errors and non-blocking warnings;
- `BROWSE`, `OPEN`, `RELOAD`, and `VALIDATE` actions.

`target description.md` additionally shows Project Intent Model status, objective/capability counts, unresolved ambiguities, and critical objectives lacking an evidence path. It must never imply that declared capabilities are implemented.

`benchmark.txt` additionally shows normalized specification status, runner/adapter readiness, scenario/signal/gate counts, benchmark version and parent, historical comparability, coverage, stability, execution cost, maturity, opening/closing run state, pending contributions, and next-cycle candidate seeds.

A mid-cycle file change presents only these explicit choices:

```text
CONTINUE WITH LOCKED VERSION
RESTART CYCLE WITH NEW INPUTS
FORK NEW MISSION
```

The UI must never silently reload a changed file into the active mission.


## 15.6 Git, Remotes, Cloud Review, and CI

This section configures the full A14 lifecycle without exposing raw Git commands.

### 15.6.1 Repository registrations

For every target, CLU-E, evidence, mirror, or auxiliary repository show/configure:

- repository ID, local root, repository-set role, object format, default and protected refs;
- Creator working-tree protection and Base Pin policy;
- material submodules, LFS, sparse/partial clone, hooks, filters, signing, and generated-content policy;
- allowed CLU-E branch namespaces and worktree-pool quotas;
- repository health, last state capture, object reachability, and configuration drift.

### 15.6.2 Remotes and providers

Configure:

- remote ID and redacted URL;
- purpose: source, review, evidence, mirror, or archive;
- provider adapter: generic Git, GitHub, GitLab, Azure Repos, Bitbucket, or approved extension;
- fetch policy and allowed read/write ref namespaces;
- authentication source, minimum credential scope, expiry/rotation status, and webhook secret identity;
- branch protection, required reviewers/checks, allowed merge methods, commit-signing and tag policy;
- offline/local-only behavior.

Secrets remain in the host secret facility. The UI shows identity and health, never token values.

### 15.6.3 Branch, commit, and review policy

Configure:

```text
clue/experiment/*
clue/review/*
clue/accepted/*
clue/evidence/*
clue/archive/*
```

Show whether provisional commits, signed commits, review publication, provider comments, automated review updates, accepted refs, and branch cleanup are allowed. Force push, protected-ref direct write, blind rebase, semantic conflict auto-resolution, and verdict derivation from CI remain permanent denied states.

### 15.6.4 Remote checks and cloud results

For every required workflow/check configure:

- name/provider/workflow identity;
- exact commit binding;
- informational, protective-gate, or transport-required role;
- timeout, freshness, retry, artifact and log-retention policy;
- whether CLU-E may trigger, poll, or only ingest it;
- required environment/platform matrix;
- mapping to proof/protective gates without making CI the Verdict Engine.

Evidence publication declares source/evidence destination, classification, redaction, encryption/access policy, maximum size, retention, restore-test interval, and deletion rules.

### 15.6.5 Reconciliation and landing transport

Show/configure:

- local fast-forward, remote review merge, accepted branch, or outbox-only transport;
- expected protected-ref, allowed provider merge method, G1–G12 gate status;
- divergence handling, changed-review-head invalidation, new-Base-Pin/re-proof policy;
- post-land verification and automatic revert;
- branch/worktree/archive retention.

The interface presents `FETCH`, `PUBLISH REVIEW`, `REFRESH CHECKS`, `RECONCILE`, `ARCHIVE`, and permit-bound landing actions only when the backend has already produced an allowed typed operation. There is no arbitrary Git command input.

---

## 15.7 Measurement and Visualization Governance

This section controls metadata and projections, not verdict truth.

It shows:

- active Measurement Catalogue version/hash;
- canonical `M<Area><Ordinal>` IDs and legacy aliases;
- 10 × 10 coordinate-map validation;
- four family colors;
- Normalization Profile versions, status and review freshness;
- Great Book hash-chain and contribution replay;
- default Improvement Field mode and filters;
- exactly four gauge selections;
- console channel visibility, verbosity, retention, redaction and artifact access;
- pending AI catalogue/normalization proposals;
- Creator approvals required for gates or doctrine.

No free-form UI edit may silently alter metric meaning. Changes create validated registry records, impact analysis, a new version/hash, and the required governance workflow.

Gauge configuration must reject:

- retired or unknown metric IDs without explicit historical mode;
- incompatible projection types;
- more or fewer than four active slots;
- family aggregate without a declared formula;
- hidden scope or aggregation mode.


## 15.8 Environments, Adapters, and Cross-Environment Contracts

This section shows a complete artifact-family inventory and adapter matrix:

```text
ENVIRONMENT
ADAPTER / VERSION
REQUIRED DEPTH
ACTUAL DEPTH
CONFIDENCE
SELF-TEST STATUS
MATERIAL ARTIFACT COUNT
UNSUPPORTED COUNT
LIMITATIONS
```

Controls allow validated adapter registration, conformance-test execution, minimum-depth policy, and materiality classification. The UI may not mark an environment “ready” because files were merely counted.

Cross-environment configuration identifies protected contracts, schemas, units, layouts, generated bindings, data-transfer paths, platform profiles, and the policy that blocks global claims when material boundaries remain unresolved.

## 15.9 Intent, Method Knowledge, and Applicable Solution Frontier

This section controls source and governance metadata, not the answer to a method question. It shows:

- approved knowledge-source classes;
- network/research permissions;
- source freshness and conflict policy;
- problem-class taxonomy versions;
- frontier review and refutation requirements;
- target constraints used for applicability;
- active frontier snapshots and recertification triggers.

No free-form field may convert “latest,” “popular,” or “industry standard” into an authoritative recommendation.

## 15.10 Proof Authority, Benchmark Synthesis, and Human Evaluation

This section configures:

- allowed proof authorities and subtypes;
- instrument-calibration requirements;
- independent-review policy;
- statistical defaults and non-inferiority rules;
- human-evaluation A/B, blinding, ordering, rubric, and observer-scope policy;
- artifact retention and privacy.

A generated benchmark is displayed as `DRAFT INSTRUMENT`, `CALIBRATED`, `FROZEN`, `INVALID`, or `SUPERSEDED`—never merely “ready.”

## 15.11 Value Horizon and RPI Equilibrium

This section configures value horizons, discount/risk policy, assurance objectives, forecast-confidence rules, realized-value updates, marginal-search thresholds, and which equilibrium dimensions are required for a global certificate. Monetary fields are optional where value is assurance; mandatory gates remain non-tradeable.

# 16. Configuration — Chrome and Browser Console

Chrome control is essential and must be one of the strongest sections in Configuration.

## 16.1 Connection chain

The interface must display every stage independently:

```text
CHROME PROCESS
→ CDP ENDPOINT
→ TARGET TAB
→ FRAME
→ EXECUTION CONTEXT
→ MURUGAN RUNTIME BRIDGE
→ CONSOLE CAPTURE
→ INJECTION AUTHORITY
```

## 16.2 Configurable fields

- Chrome / Chromium executable path,
- launch arguments,
- user-data directory,
- remote debugging port,
- launch managed browser or attach to existing browser,
- target URL rule,
- target title rule,
- preferred frame,
- preferred execution context,
- runtime bridge name and version requirement,
- console capture level,
- WebGPU requirement,
- trace and screenshot artifact paths,
- mutation and restoration policy.

## 16.3 Essential controls

```text
DETECT CHROME
LAUNCH MANAGED
ATTACH
LIST TARGETS
SELECT TARGET
TEST CDP
TEST CONSOLE
TEST RUNTIME BRIDGE
RUN SAFE INJECTION
CAPTURE SCREENSHOT
CAPTURE TRACE
DETACH
```

## 16.4 Live console preview

Configuration contains a real live console surface showing:

- timestamp,
- source,
- level,
- message,
- execution context,
- whether the line originated from Murugan, Chrome, WebGPU, CLU-E injection, or a probe.

The preview is not merely a text box. It should animate as a neon signal stream while preserving exact text.

## 16.5 Injection audit

Every injected operation records:

- origin,
- operator or AI requester,
- policy decision,
- Chrome target,
- frame,
- execution context,
- exact command or probe ID,
- start and completion times,
- result or exception,
- mutations performed,
- restoration status,
- artifact links.

## 16.6 No false connectivity

The interface must never collapse the chain into one vague `CONNECTED` state.

```text
CHROME RUNNING       ≠ CDP CONNECTED
CDP CONNECTED        ≠ CORRECT TAB SELECTED
TAB SELECTED         ≠ CORRECT FRAME
FRAME SELECTED       ≠ CORRECT EXECUTION CONTEXT
CONTEXT SELECTED     ≠ RUNTIME BRIDGE HEALTHY
BRIDGE HEALTHY       ≠ INJECTION SUCCEEDED
```

Dashboard receives only the summarized result of this chain.

---

# 17. Configuration — PowerShell

## 17.1 Configurable fields

- PowerShell executable,
- PowerShell version,
- profile policy,
- default working directory,
- project environment variables,
- command timeout,
- allowed command families,
- blocked commands,
- process supervision policy,
- log and artifact destination,
- privilege policy.

## 17.2 Project command presets

Recommended presets:

```text
START DEV SERVER
TYPECHECK
BUILD
PREVIEW
GIT STATUS
GIT DIFF
CREATE SNAPSHOT
COLLECT PROCESS METRICS
STOP DEV SERVER
```

The actual command remains visible and auditable.

## 17.3 Live PowerShell preview

Show:

- process ID,
- version,
- current working directory,
- active command,
- elapsed time,
- background jobs,
- stdout,
- stderr,
- exit code,
- process health.

## 17.4 Command authority

Every command is labeled as:

```text
OPERATOR
CLU-E TYPED GATEWAY
AI REQUEST — POLICY APPROVED
AI REQUEST — BLOCKED
```

AI must not receive an unrestricted shell merely because PowerShell is connected.

## 17.5 No false execution state

```text
POWERSHELL OPEN       ≠ CORRECT WORKING DIRECTORY
COMMAND STARTED       ≠ COMMAND COMPLETED
COMMAND COMPLETED     ≠ COMMAND SUCCEEDED
EXIT CODE 0           ≠ BEHAVIOR PROVEN
SERVER RUNNING        ≠ CORRECT BUILD SERVED
```

---

# 18. Configuration — Visual Studio / IDE Cooperation

This section configures cooperation with the operator’s development environment.

The supported concept is **IDE cooperation**, with Visual Studio or Visual Studio Code as likely adapters.

## 18.1 Configurable fields

- IDE type,
- executable path,
- workspace or solution path,
- preferred project,
- open-file integration,
- open-at-line integration,
- diff viewer integration,
- patch-package handoff folder,
- operator implementation-session handoff method,
- file-change notification policy,
- save-state detection,
- terminal reuse policy.

## 18.2 Cooperation actions

```text
DETECT IDE
OPEN WORKSPACE
OPEN CURRENT TARGET
OPEN PATCH DIFF
REVEAL FILE AT LINE
SEND PATCH PACKAGE
VERIFY EXTERNAL EDITS
REFRESH SNAPSHOT
```

## 18.3 AI-assisted IDE cooperation

Where an IDE-hosted AI is used, Configuration may define:

- adapter name,
- session handoff format,
- context package location,
- patch receipt format,
- required completion report,
- whether the IDE AI may edit Maintenance Root,
- whether it may commit,
- whether it may run tests,
- and what evidence must return to CLUE.

This remains distinct from CLUE’s own analysis sessions.

The interface must not call an IDE integration “connected” unless it can perform the exact configured handoff and receive a verifiable receipt.

---

# 19. Configuration — AI Providers, Model Orchestrator, and Session Policy

## 19.1 Provider configuration

Support provider-neutral configuration for:

- provider endpoint,
- model,
- authentication source,
- role suitability,
- context size,
- output allowance,
- timeout,
- retry policy,
- cost or call quota,
- availability check.

Secrets should be referenced through a secure source and never displayed in full.

## 19.2 Session policy

Configurable values:

- maximum parallel sessions,
- maximum calls per session,
- daily call cap,
- cycle call cap,
- context utilization threshold,
- checkpoint interval,
- automatic handoff threshold,
- retry count,
- orphan recovery policy,
- automatic next-session policy,
- pause-after-checkpoint policy,
- model assignment by role.

## 19.3 AI roles

Potential roles include:

- Mapper,
- Analyst,
- Probe Designer,
- Patch Designer,
- Reviewer,
- Synthesizer,
- Benchmark Analyst,
- Ledger Curator.

The Configuration tab determines which model may perform which role, when frontier escalation is mandatory, which tasks may use Batch, refutation policy, token/call ceilings, checkpoint thresholds, and how the Model Orchestrator chooses among eligible models.

## 19.4 Validation

Provider readiness must distinguish:

```text
CONFIGURED
CREDENTIAL AVAILABLE
ENDPOINT REACHABLE
MODEL AVAILABLE
TEST CALL PASSED
ROLE POLICY VALID
```

---

# 20. Configuration — Testing and Benchmarks

Configuration distinguishes two proof scopes.

## 20.1 Candidate-specific proof

Configurable areas include:

- baseline and candidate snapshot policy;
- browser/tool profile;
- warm-up, repetitions, duration, timeout, and seed policy;
- target measurements and affected-scope guardrails;
- P50/P80 or other forecast policy;
- invalid-run and variance rules;
- screenshots, traces, profiles, recordings, and logs;
- proof preregistration and freeze state;
- test-library and regression-protection policy;
- human-evaluation protocol when applicable.

## 20.2 Master Benchmark governance

The panel shows and configures:

- current benchmark version, parent, and source hash;
- normalized specification and execution adapter;
- opening and closing whole-project run policy;
- objective, capability, domain, runtime-path, metric-family, gate, risk, and environment coverage;
- contribution queue from accepted/rejected/inconclusive work;
- enrichment, consolidation, pruning, threshold, and stress-envelope proposals;
- independent critic state;
- deterministic validation, variance, cost, and information-gain results;
- fully/partially/non-comparable classification and bridge runs;
- maturity and equilibrium blockers;
- next-cycle vital input and candidate seeds.

Configuration defines how evidence is collected. Dashboard shows what the evidence concluded. A benchmark source file, runner connection, or green result does not by itself establish proof readiness.


## 20.3 Proof-instrument and human-evaluation readiness

Testing readiness separately reports:

```text
instrument defined
instrument calibrated
known-good/known-bad discrimination
observer effect bounded
protocol frozen
baseline compatible
human packet ready / not applicable
independent review complete
```

A test runner connection does not imply proof readiness.

# 21. Configuration — Storage, Ledger, and Safety

## 21.1 Storage

Show and configure:

- CLU-E database location,
- artifact root,
- context-pack location,
- trace retention,
- screenshot retention,
- benchmark retention,
- backup policy,
- Git worktree/object-cache quotas,
- source/CLU-E/evidence remote publication policy,
- cloud evidence retention and restore-test state,
- export policy,
- free disk space.

## 21.2 Great Book

Configure:

- ledger location,
- append policy,
- hash-chain validation,
- export format,
- backup destination,
- invalidation-record policy.

## 21.3 Authority boundaries

Always display and validate:

- Creator working-tree and index protection,
- protected-ref write protection,
- Git Worktree Pool write permission,
- CLU-E branch/commit/push/review permission,
- Custodian permit-bound landing/revert permission,
- remote/provider credential and evidence-publication classification,
- shell command policy,
- Chrome injection policy,
- AI provider limits,
- operator approval requirements,
- emergency stop behavior.

A strong default is:

```text
CLU-E MAY READ REGISTERED REPOSITORIES.
CLU-E MAY MODIFY ONLY LEASED EXPERIMENT WORKTREES AND CLU-E-OWNED REFS.
CLU-E MAY CREATE PROVISIONAL AND SEALED CANDIDATE COMMITS.
CLU-E MAY PUBLISH ONLY TO APPROVED REMOTES, NAMESPACES, AND EVIDENCE DESTINATIONS.
COMMIT / PUSH / REVIEW / CI / MERGE DO NOT CREATE AN RPI VERDICT.
ONLY THE PERMIT-BOUND CUSTODIAN MAY CHANGE A PROTECTED REF.
```

---

# 22. Configuration Validation and Apply Model

## 22.1 Live validation

Every field validates as it changes.

Configuration values may be:

- valid,
- valid but degraded,
- incomplete,
- conflicting,
- unavailable,
- unsafe,
- requiring restart.

## 22.2 Apply behavior

Most safe values may autosave locally.

Changes affecting active execution require an explicit integrated action:

```text
VALIDATE CONFIGURATION
APPLY AT NEXT CHECKPOINT
```

Dangerous changes while CLU-E is running should not silently reconfigure active sessions.

## 22.3 Readiness summary

The bottom of Configuration shows:

```text
PROJECT          READY
GIT / REMOTES    READY
WORKTREE POOL    READY
CLOUD EVIDENCE   READY
CHROME           READY
POWERSHELL       READY
IDE              READY
AI PROVIDERS     READY
TEST SYSTEM      READY
STORAGE          READY
SAFETY POLICY    READY

CLU-E START READINESS: READY
```

If not ready, the exact blocking field is named.

---

# 23. Dashboard ↔ Configuration Cooperation

The two tabs should behave as one console.

Examples:

- Selecting `CHROME DEGRADED` on Dashboard opens Configuration at Chrome.
- Selecting the repository snapshot opens Project and Repository.
- Selecting `BASE DRIFT`, `REMOTE DIVERGED`, `CHECKS STALE`, or `EVIDENCE UPLOAD FAILED` opens Git, Remotes, Cloud Review, and CI at the exact blocking record.
- Selecting a candidate commit opens the Version Control & Cloud Publication Lens with proof binding and change-set partition.
- Selecting the call budget opens AI Providers and Session Policy.
- Selecting a PowerShell failure opens PowerShell with the failed command visible.
- Selecting `START BLOCKED` opens the first blocking configuration section.
- Applying configuration returns the operator to Dashboard if CLU-E can now start.

No additional navigation layer is created.

---

# 24. Typography and Console Grammar

Typography must be:

- geometric,
- narrow,
- technical,
- highly legible at small sizes,
- strong for uppercase headings,
- excellent for numbers and code paths.

Use:

- uppercase labels,
- tabular numerals,
- monospaced or semi-monospaced technical values,
- slightly expanded heading tracking,
- strong hierarchy between state, label, and evidence.

The design may evoke cinematic digital typography but should not copy a proprietary film titleface exactly.

---

# 25. Interaction Efficiency

## 25.1 Dashboard

Dashboard favors observation.

- No forms.
- No path editing.
- No provider setup.
- Minimal direct controls.
- Start / Stop remains primary.
- Selecting a health issue moves to Configuration.

## 25.2 Configuration

Configuration favors exact setup.

- Paths can be pasted or browsed.
- Processes can be detected.
- Connections can be tested.
- Raw technical values remain visible.
- Each section reports its real state.
- No nested tabs.

## 25.3 Keyboard behavior

Recommended shortcuts:

```text
F1 or Ctrl+1     Dashboard
F2 or Ctrl+2     Configuration
Ctrl+Enter       Start CLU-E when stopped
Ctrl+Shift+Enter Request graceful stop when running
Ctrl+O           Select Scan Root
Ctrl+Shift+O     Select Maintenance Root
Ctrl+K           Focus command rail
Esc              Release panel focus
```

---

# 26. Performance Discipline

The UI itself must respect CLUE’s efficiency philosophy.

Recommended performance targets:

- 60 fps during active interaction and high-priority animation,
- render-on-demand when static,
- reduced background motion while the operator is reading,
- no unbounded telemetry history in GPU buffers,
- bounded console line retention,
- pooled geometry for charts and panel lines,
- no full-scene rebuild for a metric update,
- scalable animation quality based on GPU capability,
- deterministic fallback for reduced motion or lower-end hardware.

Neon should come from efficient emissive geometry and controlled bloom, not from wasteful full-screen blur abuse.

---

# 27. Final Dashboard Snapshot

A healthy running Dashboard should communicate one coherent picture:

```text
CLU-E / TGT-CLUE                 RUNNING — STABLE · SEAL 8F21…
[DASHBOARD] [CONFIGURATION]      [STOP CLU-E] [CLU-E STATUS]

┌────────────────────────────────┬────────────────────────────────┐
│ SYSTEM NAVIGATOR               │ GREAT BOOK IMPROVEMENT FIELD   │
│ Current: MC04                  │ Mode: CURRENT CERTIFIED        │
│ GraphModel.aggregatedEdges…    │ 10 × 10 metric coordinates     │
│ Purpose: preserve directed     │ MC04 +42.1 · MI05 +18.4        │
│ dependency meaning             │ MJ06 PASS · MK17 +31.8          │
│ In 14 · Out 7 · Risk medium    │ 27 active segments · 2 below   │
├────────────────────────────────┼────────────────────────────────┤
│ FOUR NEON GAUGES               │ OPERATIONAL CONSOLE            │
│ MD04  +61 · 89.2 FPS           │ BENCHMARKING MC04              │
│ MI05  0.94 causal attribution  │ WHY directional collapse       │
│ MJ06  PASS global guardrail    │ PS OUT npm run benchmark       │
│ MK17  87% orchestration truth  │ PS IN exit 0 · artifact 71A…   │
│ Coverage / confidence / fresh  │ NEXT Chrome/CDP patched run    │
└────────────────────────────────┴────────────────────────────────┘

NOW       MAS-0042 · Proof Designer · frontier reasoning model
NEXT      baseline result validation after checkpoint
THEN      candidate A/B comparison → terminal verdict

SESSIONS  4 active / 6 · CALLS 186 today · 214 / 400 remaining
PROGRESS  recognition 82.4 · purpose 73.8 · proof 11.8 · certification 3.7
```

Every number and console line resolves to the current sealed status snapshot.

---

# 28. Final Configuration Snapshot

A healthy Configuration tab should communicate:

```text
CLU-E / TGT-CLUE                         CONFIGURATION READY
[DASHBOARD] [CONFIGURATION]              [START CLU-E] [CLU-E STATUS]

PROJECT
Canonical Root       F:\CLU\CLU
Git Worktree Pool    F:\CLU\worktrees\clue
Artifact Root        F:\CLU\CLU\workspace
Repository           TGT-CLUE · main · Base Pin 81ac72f · Creator tree sealed
Worktree             WT-0042 · clue/experiment/CYC-12/PAT-123 · candidate 9bd10e4
Remote Review        PR/MR 184 · head exact · 5/5 checks · not a verdict
Cloud Evidence       manifest sha256:... · verified · restore tested

MEASUREMENTS / GREAT BOOK
Catalogue Target     v5 · 100 active coordinates
Runtime Catalogue    v3 until migration · hash valid
Coordinates          target 100 · runtime 96 + 4 reserved · no collisions
Normalization        profile set valid · review current
Field Default        CURRENT CERTIFIED
Gauges               MD04 · MI05 · MJ06 · MK17
Great Book           hash chain valid
Console              all channels · redaction enforced

CHROME / CDP
Executable           Chrome
Endpoint             ws://127.0.0.1:9222
Target / Context     verified
Console Capture      active

POWERSHELL
Executable           pwsh.exe 7.x
Host                 READY
Policy               typed gateway only

AI ORCHESTRATION
Provider             OpenAI · reachable
Critical Model       <mission-pinned model> · exact ID validated
Concurrency          6
Spend Authority      OpenAI Platform · provider-controlled

TEST SYSTEM
Benchmark            registered and hash-frozen
Warmups / Iterations 5 / 30
Evidence Policy      frozen proof required

READINESS            READY TO START CLU-E
```

---

# 29. Final Design Formula

> **CLU-E is a two-tab WebGPU mission-control console for Recursive Project Improvement. Dashboard remains a strict four-quadrant surface: System Navigator projects native environments, capability slices, dependencies and cross-environment boundaries; the 10 × 10 Great Book Improvement Field projects 100 canonical v5 measures while preserving native evidence; four neon gauges expose governed current signals; and the Operational Console mirrors real adapter, model, benchmark, PowerShell, Chrome/CDP, proof, Git/cloud, Custodian, Great Book, value and status traffic. The shared RPI Current Work Lens states observed implementation, inferred intent, protected capability, problem class, current method, frontier position, proof authority, value horizon and limiting equilibrium dimension. Configuration is the single setup surface for targets, repositories, worktree pools, remotes/providers, branches/commits/reviews/checks, cloud evidence, environments, adapters, contracts, method knowledge, proof instruments, human evaluation, value policy, catalogue, benchmarks, storage and authority. The visual language remains black, glass, neon and cinematic, but every claim resolves to durable evidence and one State Seal; Git transports exact versions and cloud results but never becomes the judge of improvement.**


---


---

# 30. 2026-08-14 executable-alignment amendment — OpenAI pause and manual Git control

The primary control rail places the explicit `SYNC GIT` action beside `START CLU-E`. Sync is never
implicit in Start and is disabled/fail-closed when no remote is registered or the backend action is
unavailable. The UI renders the server's result and does not create Git authority.

Q3's AI instrument distinguishes three states:

```text
provider operational         → LIVE / READY
technical throttling/fault   → BLOCKED or PAUSED, but not LACK OF $
explicit billing exhaustion  → LACK OF $ / AI PAUSED / CONTROLLED PAUSE
```

It shows exact observed token use. `TOK LEFT` is a number only when the backend marks a provider
allowance as authoritative; otherwise it displays unavailable. The interface never converts a
monetary balance into an invented token count and never uses CLU-E compatibility caps as billing
truth.

The separately reviewed `ui/clue-dashboard/app.js` is the interface implementation for this
amendment. The final backend/governance patch intentionally excludes that file so its accepted
identity cannot be replaced by a broad patch.
