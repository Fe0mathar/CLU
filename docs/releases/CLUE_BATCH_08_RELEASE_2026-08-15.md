# CLU-E Batch 8 Release — 15 August 2026

## Scope

Final planned Project Profiles package: PP-36 complete acceptance/fault matrix and PP-37 coordinated v10 documentation release candidate, plus read-only P2 closure-preparation assets.

## Important non-claims

Extraction does not run migration, adopt a workspace, enable Configuration-v3, activate a project, launch Chrome, contact OpenAI, synchronize Git, ratify documents, seal an epoch, execute a proof, write Great Book history or close P2.

## Required predecessor

Batches 1–7 must already be installed. The exact Batch 7 archive prerequisite is:

```text
CLUE_BATCH_07_CONFIGURATION_UI_CONTROL_PLANE_PATCH_2026-08-15.zip
SHA-256: 76e9cdcf1d40d3a6e147ef69ca96a65f3594323183ea359a7474c5c2adf67b8e
```

## Package-host validation

```text
Typecheck/build                         PASS
Repository selftests                   839 pass / 7 skip / 0 fail (846 total)
Dashboard                              169/169 PASS
System Navigator                       12/12 PASS; 28 modules; 59 edges
Operational Console                    11/11 PASS
Great Book field / Four Neon Gauges    PASS / PASS
Project Profiles matrix                28 requirements / 57 files PASS
v10 documentation candidate            PASS, unratified
```

The seven skips require Windows/PowerShell and remain live installation gates.

## Post-apply validation

```powershell
npm run typecheck
npm run build
npm run selftest
npm run dashboard:verify
npm run navigator:verify
npm run console:verify
npm run dashboard-metrics:verify
npm run project-profiles:docs-verify
npm run project-profiles:acceptance -- --full
npm run p2:closure-preflight
```
