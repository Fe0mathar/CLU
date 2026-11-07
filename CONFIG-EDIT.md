# Configuring a CLU-E installation

**Implements:** `CLUE_Project_Directory_v9.md` §3 and §4.1, the target-profile decision recorded in `docs/target-profiles-and-benchmark_v1.md`, and the root-file placement decision in `docs/architecture-decisions/ADR-0009-root-operator-files.md`.

**Applies to:** `config/clue.config.yaml` schema `version: 2`, `targets/<id>/profile.yaml`, and the current v9 command surface.

**Backlog:** `DEV-P1-27`.

This is an operator workflow, not a historical patch note. Where this file and a permanent contract disagree, the permanent contract wins.

---

## 1. The configuration model

CLU-E supports two configuration forms.

### 1.1 Profile mode — current and recommended

`config/clue.config.yaml` selects one target:

```yaml
project:
  active_target: clu
```

That value names:

```text
targets/clu/profile.yaml
```

The profile supplies the complete target definition. The configuration keeps the **choice of target**; the profile carries **what that target is**.

The current installation resolves as:

```text
config/clue.config.yaml
        ↓ project.active_target: clu
targets/clu/profile.yaml
        ↓
resolved config.project
```

The loader overlays the profile before schema validation completes, so runtime code reads one resolved `config.project` object. A component must not separately merge profile values at use time.

### 1.2 Self-contained mode — supported for legacy installations

A configuration may instead set:

```yaml
project:
  active_target: null
  id: example
  root: "D:/example"
  main_branch: main
  source_roots: [src]
  document_roots: [.]
  exclude: [node_modules, dist, .git]
  remote: null
  credential_env: null
  remote_decision:
    state: UNRECORDED
  inputs:
    description: null
    benchmark: null
```

This mode remains valid. It does not load an arbitrary profile.

### 1.3 Never combine the two forms

When `project.active_target` names a profile, do not also define target fields in `config/clue.config.yaml`. In particular, do not define an inline `project.root`, `source_roots`, `document_roots`, `inputs`, or `remote` beside `active_target`.

Two answers to “what is the target?” are refused with `CONFIG_TARGET_AMBIGUOUS`; CLU-E does not guess which source should win.

---

## 2. Which file owns which decision

### `config/clue.config.yaml` — installation and CLU-E policy

This file owns workstation and framework concerns:

- which target profile is active;
- workspace root;
- shadow root and clone/install policy;
- CLU-E constitutional documents;
- runtime command names;
- browser executable, profile and allowed origins;
- PowerShell executable and host mode;
- analysis, proof, certification and equilibrium policy;
- patching and landing policy;
- notifications;
- Model Gateway policy and environment-variable names;
- backup, security and logging policy.

It does **not** own the selected target’s source root, document scope, publication URL, target description or Master Benchmark when profile mode is active.

### `targets/<id>/profile.yaml` — the selected target

A profile owns:

```yaml
id:
name:
root:
main_branch:
source_roots:
document_roots:
exclude:
remote:
credential_env:
remote_decision:
inputs:
  description:
  benchmark:
```

For the current self-target, the authority file is:

```text
targets/clu/profile.yaml
```

Its current effective state is:

```text
id:                clu
name:              CLU-E
root:              F:/CLU/CLU
source roots:      src, selftest
document roots:    .
remote:            null
credential env:    null
remote decision:   NO_REMOTE_YET · P2-D5-NO-REMOTE-YET
description:       target description.md
benchmark:         targets/clu/benchmark/master-benchmark.md
```

`remote: null` is a closed stated absence only when the same governed profile carries an
explicit `remote_decision.state: NO_REMOTE_YET`. A legacy profile with no decision resolves to
`UNRECORDED`; `clue doctor` warns and P2-04 remains open rather than inventing Creator intent.

---

## 3. Governed-file effect of an edit

`config/clue.config.yaml` and the selected `targets/<id>/profile.yaml` participate in the mission basis.

The selected profile is bound by:

- its exact repository-relative path; and
- its exact content hash.

Changing any target field therefore moves the governed world. Existing evidence remains historical, but governed work must not continue under the previous mission as though nothing changed.

The required transition is:

```text
edit config or active profile
        ↓
current mission basis drifts
        ↓
clue init
        ↓
successor mission is registered
        ↓
recapture/re-ingest under the successor
```

Inactive profiles do not move the selected target mission. Editing `targets/murugan/profile.yaml`, for example, does not change a mission whose `active_target` remains `clu`.

---

## 4. Path rules

### 4.1 Host roots

These roots may be absolute on the current host or relative to the CLU-E repository root:

```text
project.root              profile or self-contained project block
workspace.root            config/clue.config.yaml
shadow.root               config/clue.config.yaml
browser.profile_dir       config/clue.config.yaml
```

A path written as absolute for another operating system is refused rather than reinterpreted as relative. For example, `F:/CLU/workspace/clue` is valid on Windows and must not silently become a directory named `F:` on POSIX.

### 4.2 Relative target scopes

These are relative to `project.root` and must not escape it:

```text
source_roots
document_roots
exclude entries
```

Source roots are additionally checked against their physical path. A symlink or `..` path may not make the scanner recognize files outside the target tree.

### 4.3 Target input paths

`inputs.description` and `inputs.benchmark` may be:

- relative to `project.root`; or
- absolute on the current host.

A relative path may not traverse outside `project.root` with `..`.

Keeping these files inside the target repository is preferred because their history then travels with the target. An external absolute path is legal, but `doctor` reports that it is outside the repository.

For the current CLU-E tree, both governed inputs are registered:

```yaml
inputs:
  description: "target description.md"
  benchmark: "targets/clu/benchmark/master-benchmark.md"
```

The runtime resolves the relative benchmark path against `project.root`, producing:

```text
F:/CLU/CLU/targets/clu/benchmark/master-benchmark.md
```

Do not use `benchmark/master-benchmark.md` unless a file actually exists at `<project.root>/benchmark/master-benchmark.md`.

---

## 5. Root separation

The following zones must not overlap after path resolution:

```text
canonical target root
workspace root
shadow root
browser profile directory
```

For the current Windows installation:

```yaml
# targets/clu/profile.yaml
root: "F:/CLU/CLU"

# config/clue.config.yaml
workspace:
  root: "F:/CLU/workspace/clue"

shadow:
  root: "F:/CLU/shadow/clue"

browser:
  profile_dir: "F:/CLU/chrome-profile"
```

The workspace, generated evidence, browser profile and experimental clone must remain outside the canonical source tree. CLU-E refuses an overlapping layout before opening the runtime.

---

## 6. Secrets, remotes and the Model Gateway

Never store a credential in YAML.

The only permitted configuration value is the **name of an environment variable**:

```yaml
credential_env: "CLUE_GIT_CREDENTIAL"
```

or:

```yaml
gateway:
  api_key_env: "OPENAI_API_KEY"
```

The actual value belongs to the host environment or credential helper. It must not enter:

- `config/clue.config.yaml`;
- a target profile;
- the event log;
- an artifact;
- Status;
- a release archive.

A deliberate local-only target records both the null identity and the Creator decision:

```yaml
remote: null
credential_env: null
remote_decision:
  state: NO_REMOTE_YET
  decision_id: P2-D5-NO-REMOTE-YET
  recorded_at: "2026-08-14"
  recorded_by: creator
  reason: "Remote publication is intentionally deferred beyond P2."
```

Omitting `remote_decision` does **not** mean the same thing: it resolves to `UNRECORDED` and
keeps DEV-P2-04 open. Setting a remote URL requires `REMOTE_REGISTERED`; neither state grants
landing or push capability by itself. Git publication remains subject to the Git and Custodian
authority model.

The current Model Gateway remains:

```yaml
gateway:
  enabled: false
```

Do not enable it until the named budget and routing policies exist and the provider policy has been accepted.

---

## 7. Safe edit workflow

Run this ceremony from the CLU-E repository root.

### Step 1 — inspect the current state

```powershell
Set-Location F:\CLU\CLU

npm run build
node dist/src/cli/index.js doctor --deep
node dist/src/cli/index.js mission
```

Record any existing warnings before editing so a new warning is distinguishable from an old one.

### Step 2 — edit one authority layer

For installation policy, edit:

```text
config/clue.config.yaml
```

For target identity or scope, edit:

```text
targets/<active_target>/profile.yaml
```

For switching targets, create or validate the new profile first, then change only:

```yaml
project:
  active_target: <new-id>
```

### Step 3 — validate syntax, schema and platform paths

```powershell
npm run typecheck
npm run build
node dist/src/cli/index.js doctor --deep
```

Stop on any `FAIL`. Do not run `init` to legitimize a malformed or ambiguous configuration.

### Step 4 — register the successor mission

```powershell
node dist/src/cli/index.js init
```

Expected behavior after a governed edit:

```text
OK    mission              MISSION-<next> (version <next>, ...)
INFO  document changed     config/clue.config.yaml
```

or:

```text
INFO  document changed     targets/<id>/profile.yaml
```

Running `init` again without further drift is idempotent.

### Step 5 — refresh evidence under the successor

```powershell
node dist/src/cli/index.js docs ingest
node dist/src/cli/index.js snapshot
node dist/src/cli/index.js recognize
node dist/src/cli/index.js status report
```

Run the complete verification baseline before treating the edited installation as a release candidate:

```powershell
npm run selftest
node tools/p0-acceptance.mjs
```

### Step 6 — cut a new exact release only after the batch is complete

```powershell
node tools/release.mjs
```

Every governed source/configuration change invalidates the prior archive/tree match. Preserve the prior ZIP as historical evidence and create a new exact archive; never overwrite or relabel the old one.

---

## 8. Switching targets

To add a target called `murugan`:

1. Create `targets/murugan/profile.yaml`.
2. Ensure its `id` is exactly `murugan`.
3. Set its real root, source roots, document roots and explicit absences.
4. Run `doctor --deep` while `clu` remains active if you are only preparing the file.
5. Change `config/clue.config.yaml`:

```yaml
project:
  active_target: murugan
```

6. Run `doctor --deep` again.
7. Run `init` to register the successor mission.
8. Ingest, snapshot and recognize the new target.

A profile whose `id` disagrees with its directory is refused. A missing selected profile is refused. CLU-E does not fall back to another target.

---

## 9. Registering the Master Benchmark

A benchmark file being present in the repository is not the same as it being governed.

To register the current candidate:

1. Review and approve the thresholds in:

```text
targets/clu/benchmark/master-benchmark.md
```

2. Edit `targets/clu/profile.yaml`:

```yaml
inputs:
  description: "target description.md"
  benchmark: "targets/clu/benchmark/master-benchmark.md"
```

3. Run:

```powershell
npm run build
node dist/src/cli/index.js doctor --deep
node dist/src/cli/index.js init
node dist/src/cli/index.js benchmark run
node dist/src/cli/index.js status report
```

With no `--contract`, `benchmark run` uses only the registered profile input. When `inputs.benchmark` is `null`, it refuses rather than silently substituting a candidate file.

An explicit `--contract <path>` is an out-of-registration engineering run. Its evidence must remain marked `registered: false`; it does not close the strict benchmark lock by itself.

---

## 10. Documentation ratification and evidence epochs

These are separate Creator acts.

### `clue docs ratify`

Use after a governed documentation-pack amendment has been reviewed and accepted. A target-profile or installation-path edit alone is not documentation-pack ratification.

```powershell
node dist/src/cli/index.js docs ratify
```

### `clue epoch seal`

Use after the intended mission, authority pack, target profile and release state are final for the evidence boundary being declared.

```powershell
node dist/src/cli/index.js epoch seal
```

Do not seal an epoch merely to remove a warning while configuration work is still in progress.

---

## 11. Current Windows diagnostic note

The current Windows build can report an in-repository target input as “outside the target repository” when one path uses `\` and the canonical root uses `/`. The input is still resolved and hashed correctly; the warning is a path-comparison diagnostic defect, not authority to move the file or ignore other path failures.

Until that diagnostic is repaired:

- verify the displayed absolute path manually;
- treat `configured but absent` or `unreadable` as real failures;
- do not move `target description.md` solely to silence the separator warning.

---

## 12. Operator files remain at the repository root

ADR-0009 settles the placement of:

```text
CONFIG-EDIT.md
clue-status.md
MANIFEST.txt
```

All three remain at the repository root. `clue-status.md` and release manifests are generated evidence surfaces; this file is the durable operator workflow. None should be moved to `docs/` without a new governed decision.

---

## 13. Minimal verification checklist

After any accepted configuration/profile edit:

```powershell
Set-Location F:\CLU\CLU

npm run typecheck
npm run build
node dist/src/cli/index.js doctor --deep
node dist/src/cli/index.js init
node dist/src/cli/index.js docs ingest
node dist/src/cli/index.js snapshot
node dist/src/cli/index.js recognize
npm run selftest
node dist/src/cli/index.js status report
```

Before release:

```powershell
node tools/p0-acceptance.mjs
node tools/release.mjs
```

The result is acceptable only when absence stays explicit, the successor mission is registered, tests have zero failures, and the newly produced archive matches the tree it claims to contain.
