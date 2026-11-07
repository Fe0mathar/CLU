# P2 Closure Checklist

## Freeze and preflight

- [ ] Cleaned Batch 8 and Patches 01–05 installed in order.
- [ ] No parallel edits.
- [ ] Full Windows selftest and UI/Navigator/Console/metrics suites pass.
- [ ] Latest Q1/SURF files retained.
- [ ] Project Profiles authoritative acceptance report generated.
- [ ] Both packaged documentation seals verify and v9 is selected.
- [ ] Fresh release ZIP earns `RELEASE` on Windows and is bound to the clean local Git commit and tree.
- [ ] Release ZIP, hashes, report and gate log retained.
- [ ] Final tree inventory generated.
- [ ] Active P2 authority manifest complete and hash-current.
- [ ] Project Profiles supplement/v10 recorded as deferred post-P2 authority.
- [ ] Workspace `F:\CLU\workspace\clue` preserved.
- [ ] Publication state intentionally `NO_REMOTE_YET`.
- [ ] `START CLU-E` does not synchronize Git.

## Runtime gates

- [ ] Pinned Windows proof supervisor passes native host qualification.
- [ ] PowerShell Host handshake and root parity pass.
- [ ] Git repository identity matches target profile.
- [ ] Exact Chrome target passes when the proof requires a browser.
- [ ] `OPENAI_API_KEY` present without exposure.
- [ ] Provider is OpenAI.
- [ ] Requested and effective model are exactly `gpt-5.6`.
- [ ] No fallback.
- [ ] Gateway operationally ready.

## Authority ceremony

- [ ] Active P2 documents frozen.
- [ ] Exact hashes captured.
- [ ] Creator ratifies interactively.
- [ ] `ratificationCurrent = true`.
- [ ] Creator seals `P2-authoritative` interactively.
- [ ] `epochName = P2-authoritative`.
- [ ] `epochCurrent = true`.

## Proof-authoritative cycle

- [ ] Small deterministic candidate selected.
- [ ] Baseline above measurement noise.
- [ ] Proof Contract frozen.
- [ ] Candidate patch frozen.
- [ ] Rollback path recorded.
- [ ] Durable proof attempt recorded.
- [ ] Durable verdict recorded.
- [ ] REJECT/REVISE/INVALID evidence preserved where applicable.
- [ ] Real ACCEPT achieved.
- [ ] Measurable improvement demonstrated.
- [ ] No unacceptable regression.
- [ ] ACCEPT atomically created Great Book entry.

## Closure

- [ ] `proofAttempts >= 1`.
- [ ] `verdicts >= 1`.
- [ ] `accepts >= 1`.
- [ ] `greatBookEntries >= 1`.
- [ ] `lastCycleGrade = proof-authoritative`.
- [ ] `lastCycleCriteriaMet = true`.
- [ ] `formalClosurePass = true`.
- [ ] `p2Closed = true`.
- [ ] `closureState = CLOSED`.
- [ ] No contradictory P2 blockers remain.
- [ ] Fresh P0 acceptance report stored.
- [ ] Immutable P2 closure receipt stored.
- [ ] Creator explicitly approves P2 closure.
