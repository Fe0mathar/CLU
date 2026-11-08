# CLU-E Patch 05P — Static filters and guardian loss

## Why

05N4 established ordered cleanup after the outer supervisor was terminated. Its guardian still owned a dynamic Windows Filtering Platform (WFP) session. Windows removes that session’s dynamic objects when it ends, so guardian death could remove policy before job termination had finished. The proposed static lifetime removes that process-exit dependency for the package-scoped loopback policy.

05O already demonstrated exact archive binding on the Windows installation. This patch advances the isolation track.

## Changes

- The Windows launcher keeps the paired bind and supervisor-loss checks and adds a separate disposable guardian-loss scenario. It installs one static sublayer and six static filters for the verified AppContainer SID. Each run receives unique keys. The host-only recovery intent records the keys, scope, session, private job name, and process identities before WFP changes begin.
- The guardian owns the only job handle used during the crash test. The job is session-local, named, access-restricted and configured for kill on close without breakaway. The guardian publishes a bounded native job process list. The outside observer retains process handles for the reported job members and never opens the job during injection.
- The observer kills the exact guardian, verifies exit of the recorded job members while the exact WFP objects are still present, and checks the fixture escape markers. Recovery then confirms the recorded processes have exited and the specific named job is absent in the original session. It verifies the recorded sublayer and six filters and removes only those objects in a transaction. An independent readback verifies absence.
- The recovery stage survives ambiguous cleanup. A retry of the diagnostic in the same session refuses while a retained intent is unresolved. Scoped recovery can be retried from the retained controller and refuses live or unverified process and job state.

## Evidence and scope

`wfpStaticGuardianLoss.state = STATIC_GUARDIAN_LOSS_AND_RECOVERY_OBSERVED` requires both independent observation and the verified recovery receipt. The report continues to record paired bind causality and Windows filter-ID attribution separately. Exact filter-ID evidence remains open where the event source produces no match.

The test covers guardian process loss for a pinned disposable workload. Static WFP objects can be removed by BFE stop or system shutdown. This patch leaves those scenarios for separate qualification. `guardianLossQualified` and `proofAuthorization` remain false pending production integration and the wider fault suite.

05P uses a private per-run sublayer and recovery record. It leaves a shared provider and automated `clue doctor` reconciliation for a later production design. For the crash test, job state is supported by the native membership snapshot, retained process handles and specific job absence. Completion-port messages can be missed.

## Validation

Static interface, interop layout and recovery ordering checks passed. The manifest is bound to the uploaded Windows 05O archive. Native compilation, filter lifetime and crash recovery still require the Windows run.

- [WFP object lifetime](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Job completion notifications](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port)
