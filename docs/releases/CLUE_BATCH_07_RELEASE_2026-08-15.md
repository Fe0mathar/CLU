# CLU-E Batch 7 Release — 15 August 2026

## Release name

**Project Profiles Configuration UI & Control Plane Integration**

## Prerequisites

Batches 1 through 6 must already be applied in order.

## Major changes

1. Added a full modular Configuration interface for Project Profiles.
2. Added backend preparation endpoints for canonical new-profile drafts and SHA-256-bound governed Markdown documents.
3. Added explicit profile lifecycle actions with closed request contracts.
4. Added Project Authority, recognition, Host, Git, Chrome, GPT and benchmark-runtime editors.
5. Added operation-specific readiness presentation, including valid `READY_LOCAL_ONLY` handling.
6. Added active-project generation guards across Q1 and the shared sealed-frame bus.
7. Added stale Project A frame rejection and clearing of Q2/Q3/Q4 project-bound presentation during switching.
8. Added credential-reference-only browser handling and request-level secret rejection.
9. Added focused backend and dashboard acceptance tests.

## Compatibility

- Existing Configuration readiness-row exports remain available for older tests and consumers.
- Existing configuration-v2 startup remains available until explicit migration/cutover.
- The supplied Q1/SURF interface behavior is retained and covered by its unchanged acceptance test.
- The Metric Catalogue is unchanged.
- No live Project Profile state is created merely by installing this patch.
- Live browser activation succeeds only when the dashboard host supplies the atomic `ProjectRuntimeManager` seam; the legacy single-Runtime host fails closed with `RUNTIME_SWITCH_UNAVAILABLE`.

## Next batch

Batch 8 performs cumulative cross-project acceptance, documentation/release consolidation and P2 closure-preparation assets. It does not replace the real authoritative closure ceremony.
