# Batch 7 — Configuration UI Control Plane

## Delivered scope

Batch 7 implements PP-32 through PP-35 from the Project Profiles completion strategy:

- modular Project Profile Configuration shell;
- saved-project selector and exact active identity;
- keyboard-editable Project ID during creation preparation;
- backend-prepared canonical profile drafts;
- create, save, validate, delete and activate controls;
- unsaved-change and optimistic-generation boundaries;
- Project Authority document editor;
- Recognition, Host, Git, Browser, GPT and Benchmark Runtime editors;
- operation-specific Project Readiness panel;
- closed action contracts for all Project Profile operations;
- project-switch guards for Q1, Q2, Q3 and Q4;
- active-target identity in the dashboard rail;
- server-side preparation of physical roots and governed-document hashes.

## Apply-only behavior

Extracting the patch changes project source files only. It does not:

```text
run the legacy migration
adopt the live workspace
create a Project Profile
save a profile generation
activate or switch a target
launch or attach Chrome
contact OpenAI
read or write OPENAI_API_KEY
synchronize Git
start P2 ratification
open P2-authoritative
run an authoritative proof
close P2
```

The first live migration/adoption and activation remain explicit operator actions after cumulative validation.

## Validation gates

Required after extraction:

```powershell
npm run typecheck
npm run build
npm run selftest
npm run dashboard:verify
npm run navigator:verify
npm run console:verify
npm run dashboard-metrics:verify
```

Windows-only PowerShell/Host checks remain live-machine gates.

## Project-switch invariant

```text
Project A active
→ operator selects/validates Project B
→ project-bound views park
→ backend activation succeeds atomically
→ Project B active pointer published
→ only Project B evidence may repopulate views
```

A failed transition leaves Project A active. A selected or unsaved Project B draft never impersonates active runtime state.

The standard legacy dashboard process still owns one immutable Runtime. In that hosting mode the backend returns `RUNTIME_SWITCH_UNAVAILABLE` rather than pretending that the UI changed the target. Successful live switching requires the existing `ProjectRuntimeManager` activation seam; the CLI remains available for explicit next-startup activation.
