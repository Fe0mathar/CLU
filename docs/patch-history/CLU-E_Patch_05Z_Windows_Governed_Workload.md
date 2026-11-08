# CLU-E Patch 05Z — Windows governed workload

05Y2 passed 183 dashboard tests on both reviewed copies under the regular Windows account. 05Z moves to the committed CLU-E source and its production-shaped preparation commands inside the same MXC engine.

## Evidence

- The host stages committed Git HEAD, fingerprints the source, package lock and Master Benchmark, and stages only applicable lock-verified cache content and the matching native SQLite prebuild. The native prebuild is a locally reviewed artifact with a recorded SHA-256. The run requires the operator's `RUN GOVERNED` approval.
- The candidate receives a disposable writable checkout, private request files, isolated npm configuration, and the targeted offline cache. The pinned Node bootstrap uses the adjacent npm CLI for locked `npm ci --offline`, `npm run typecheck`, and `npm run build`. A local SQLite query verifies the installed native addon.
- The host checks the original source and stages the prepared tree read-only for the benchmark check. It binds a disposable workspace and target configuration, initializes the local mission, and runs `clue doctor --deep`, the Master Benchmark's `SCN-005` workload. It records the derived configuration separately.
- The report records command stages, exact input identities, checks of rejected requests and cleanup. `GOVERNED_WORKLOAD_OBSERVED` means the scoped preparation and benchmark check passed. It records `proofAuthorization: false`.

Full registered benchmark coverage, fault qualification, and a host-bound production receipt remain separate release gates.

[npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci/)
