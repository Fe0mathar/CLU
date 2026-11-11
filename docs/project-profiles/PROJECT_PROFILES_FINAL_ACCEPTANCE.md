# Project Profiles — Final Acceptance Contract

## 1. Evidence classes

### Automated cross-platform evidence

Schema, canonicalization, hashing, store/registry, authority, API contracts, UI state, browser target selection, credential-reference safety and documentation integrity can be checked on any compatible host.

### Native Windows evidence

SQLite durability, Windows path identity/junction behavior, PowerShell Host execution, actual installation roots and Configuration-v3 migration/cutover must be checked on the real Windows installation.

### Live connection evidence

Chrome and OpenAI readiness require explicit live tests. Neither is inferred from configuration.

### Human authority

The selector cutover, v10 ratification, epoch sealing and final Creator acceptance are separate deliberate human acts. The acceptance runner records machine evidence for review.

## 2. Machine matrix

`config/project-profiles-acceptance.matrix.json` is the canonical release-candidate mapping of all 28 Definition-of-Done requirements to:

- TypeScript selftests;
- dashboard tests;
- regression commands;
- authoritative Windows/live gates.

The loader refuses duplicate IDs, missing evidence, unknown fields and missing referenced tests.

## 3. Report semantics

The acceptance runner emits one of:

```text
FAIL
PORTABLE_PASS_WINDOWS_ACCEPTANCE_PENDING
STATIC_AND_HOST_AUTOMATION_PASS_LIVE_CONNECTION_GATES_PENDING
```

A final Project Profiles release acceptance additionally requires all live gates to be recorded PASS and explicit Creator acceptance. A portable pass is never promoted to full acceptance.

## 4. Recorded Windows evidence

- P14 qualified the matching `clue1` Host and Git roots, its `REMOTE_REGISTERED` mode, and OpenAI `gpt-6-astra` with fallback forbidden and unused. It created the separate `clue-v10-acceptance-b` fixture with local Git readiness.
- The P15 installation passed the focused native profile-switch integration tests. The P15A run demonstrated live `clue1` → `clue-v10-acceptance-b` → `clue1` with coherent active identity and sealed state. B rendered its seven physical files and separate recognition graph, with zero proof attempts and zero Great Book entries. A recovered its 897-file inventory, exact recognition run, accepted proof and Great Book entry.
- P15A covers live dashboard isolation. The candidate review also calls for a profile-bound Chrome request and response receipt, the full native suite on the refreshed candidate, and corroboration of migration evidence.

## 5. Required live scenarios

- Create A and B; restart; list exact generations.
- Reject duplicate Target Root through case, slash, relative and junction aliases.
- Write project state in A and prove it is absent in B.
- Produce an A Great Book ACCEPT and prove B has no A entry.
- Switch A → B → A with injected failures and no mixed state.
- Reuse unchanged A recognition state on return.
- Modify a governed document and prove authority drift stales proof readiness.
- Run Host root-parity test.
- Run Git local-only test with no network action.
- Resolve one exact Chrome page and preserve request/response evidence.
- Prove ambiguous/wrong-origin/disappeared targets block execution.
- Resolve the profile's approved environment or credential-store reference and keep secret bytes out of the report. For the qualified `clue1` generation, prove requested and effective OpenAI model both equal `gpt-6-astra` with fallback forbidden and unused.
- Explicitly migrate/adopt the legacy workspace and enable Configuration-v3 without history loss.
- Delete a non-active profile and prove target/workspace/shadow remain.

The candidate review correlates the available evidence to these scenarios. Record remaining cases with the applicable profile, generation, installed source and operation scope. Use the full native Windows suite on the refreshed candidate. A Chrome receipt must bind the exact allowed page and the producing profile. Retain the established local-only evidence for B alongside the separately registered remote posture on A.

## 6. Final acceptance statement

After authoritative Windows qualification, selector cutover, v10 ratification, the successor epoch and representative operations on both profiles, the Creator may record the following statement.

```text
Creator acceptance: Project Profiles v10 implementation accepted.
```

This statement is separate from P2 closure approval.
