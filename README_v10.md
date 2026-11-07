# CLU-E RPI Documentation Pack v10.0-rc1

**Status:** release candidate, not ratified and not active P2 authority.

This candidate coordinates the implemented Project Profiles architecture across Architecture, Execution, Interface, Project Directory, AI, Git, Status, Q1 and Documentation Governance. It carries forward the v9 Constitution, RPI methodology, Metric Catalogue and benchmark/target templates without semantic modification.

## What this release changes

- one durable Project Profile per target;
- canonical Project ID and Target Root identity;
- isolated SQL, Great Book, recognition, proof and cycle state;
- atomic project activation and runtime generations;
- governed Project Authority and Master Benchmark bindings;
- per-project Host, Git, Chrome, GPT and Benchmark Runtime configuration;
- operation-specific readiness and `READY_LOCAL_ONLY`;
- Status 5.8.0 active-project identity;
- complete Configuration control plane;
- PP-36 acceptance matrix and PP-37 release evidence.

## Authority boundary

The installed v9 pack remains the authority used for P2 closure until the Creator performs an explicit successor ratification. Do not replace v9 tracked-document registration before P2 closure evidence is preserved and the authoritative Windows acceptance gates pass.

## Verification

```powershell
cd F:\CLU\CLU
npm run project-profiles:docs-verify
npm run project-profiles:acceptance -- --full --output PROJECT_PROFILES_ACCEPTANCE_REPORT.runtime.json
npm run p2:closure-preflight -- --output P2_CLOSURE_PREFLIGHT.runtime.json
```

## Promotion after P2

1. verify and preserve the P2 closure receipt;
2. complete all live Windows, PowerShell, Chrome and OpenAI gates;
3. review the v10 manifest/seal;
4. run `npm run project-profiles:promote-v10` to atomically coordinate the pack selector and active tracked-document registration;
5. ratify interactively;
6. seal `POST-P2-PROJECT-PROFILES`;
7. execute representative operations on at least two profiles;
8. record Creator acceptance.
