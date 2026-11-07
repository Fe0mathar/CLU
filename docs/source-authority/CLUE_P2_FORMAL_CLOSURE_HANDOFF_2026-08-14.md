# CLU-E P2 — Formal Closure Handoff

## Purpose

This document defines only what remains to be done to formally close **P2**.

It does not cover:
- Q1 visual refinement,
- general UI redesign,
- unrelated feature work,
- P3 implementation.

Current status should be treated as:

**P2 implementation essentially complete / ready for authoritative closure, but not yet formally closed.**

---

## 1. Required Terminal Outcome

P2 is closed only when the authoritative closure state reaches:

```text
ratificationCurrent = true
epochName = P2-authoritative
epochCurrent = true

proofAttempts >= 1
verdicts >= 1
accepts >= 1
greatBookEntries >= 1

lastCycleGrade = proof-authoritative
lastCycleCriteriaMet = true

formalClosurePass = true
p2Closed = true
closureState = CLOSED
```

In addition, the Creator must give explicit final approval after the machine-verifiable closure state is reached.

---

## 2. OpenAI Gateway Must Be Operational

The configured provider/model must be operational before the authoritative P2 cycle.

Required target state:

```text
provider = openai
model = gpt-5.6
configured = true
enabled = true
apiKeyPresent = true
operationallyReady = true
problem = null
```

The model identity must be exact.

No silent fallback to another model is permitted.

### Required action

Provide the runtime environment with:

```text
OPENAI_API_KEY
```

Then restart/reload the relevant CLU-E runtime and verify that the gateway reports:

```text
operationallyReady = true
```

### Billing/funding behavior

CLU-E does not administer a local dollar budget.

Authority remains with OpenAI Platform.

If provider billing/credit is exhausted:

```text
controlled PAUSE
```

must occur rather than a crash.

The system must:
- finish the current durable write/checkpoint,
- refuse new AI submissions,
- preserve state,
- surface provider funding exhaustion in Q3.

---

## 3. Freeze and Ratify the Current Normative State

Before opening the authoritative epoch, freeze the exact current governance/normative inputs.

This includes the exact current versions/hashes of the governing documents and benchmark-related normative material used for P2.

The ratification act must bind the exact documents and hashes that will govern the authoritative proof cycle.

Required result:

```text
ratificationCurrent = true
```

No silent document changes should occur after ratification and before/during the authoritative cycle.

If a normative document changes, ratification must be considered stale until renewed.

---

## 4. Open a New Authoritative Epoch

Immediately after ratification, open a fresh epoch named:

```text
P2-authoritative
```

Required result:

```text
epochName = P2-authoritative
epochCurrent = true
```

This epoch must be bound to the current ratified normative state.

The authoritative proof cycle must occur inside this epoch.

---

## 5. Keep the First Authoritative P2 Cycle Local-Only

The first P2 authoritative proof cycle is intentionally local-only.

Current publication posture remains:

```text
remote = null
publicationState = NO_REMOTE_YET
localOnly = true
publicationPermitted = false
```

This is not a blocker for local P2 closure.

Git synchronization remains explicit/operator-controlled.

`START CLU-E` must not automatically perform Git synchronization.

The Git Sync control may remain blocked while no remote is configured.

---

## 6. Select a Small, Deterministic Improvement Candidate

The first authoritative P2 improvement should be:

- small,
- deterministic,
- measurable,
- low-risk,
- within CLU-E itself,
- suitable for proving measurable improvement without regression.

Avoid choosing a broad architectural refactor for the first authoritative cycle.

Preferred candidate characteristics:

```text
clear baseline
clear patch
clear measurable delta
stable benchmark/probe
small blast radius
easy rollback
```

The goal is to prove the full P2 proof pipeline, not to maximize improvement magnitude.

---

## 7. Run One Full Proof-Authoritative Cycle

One complete successful proof-authoritative cycle is sufficient for P2 closure.

The cycle must exercise the real durable proof pipeline.

At minimum the cycle must produce:

```text
proofAttempts >= 1
verdicts >= 1
```

The cycle must use the frozen proof contract and current registered benchmark/evidence policy.

The cycle must not rely on an ad-hoc/manual verdict outside the durable proof pipeline.

---

## 8. Iterate Through REJECT / REVISE if Necessary

A first attempt does not have to immediately produce ACCEPT.

Valid durable outcomes include:

```text
REJECT
REVISE
ACCEPT
```

If the candidate is rejected or requires revision:
- preserve the verdict durably,
- analyze the evidence,
- revise the candidate,
- run the next proof attempt.

Continue until an admissible improvement produces:

```text
ACCEPT
```

Do not convert an inconclusive or failed proof into an artificial success.

---

## 9. Obtain at Least One Real ACCEPT

P2 requires at least one accepted proven improvement.

Required result:

```text
accepts >= 1
```

The ACCEPT must be produced by the authoritative proof pipeline.

The improvement must be supported by measurable evidence and must not introduce unacceptable regression.

The intended success criterion is:

**measurable improvement without regression.**

---

## 10. Great Book Entry Must Be Created Atomically from ACCEPT

Great Book remains ACCEPT-only.

A proof ACCEPT must atomically produce the corresponding durable Great Book contribution.

Required result:

```text
greatBookEntries >= 1
```

No Great Book entry should be fabricated from:
- REJECT,
- REVISE,
- incomplete proof,
- non-authoritative manual state.

The proof verdict remains the durable authority.

---

## 11. Close the Cycle as Proof-Authoritative

After the accepted improvement and all required evidence are present, the cycle must close with:

```text
lastCycleGrade = proof-authoritative
lastCycleCriteriaMet = true
```

The cycle must not close under a weaker grade.

The closure assessment must confirm that the required proof-authoritative criteria were actually met.

---

## 12. Automatic Formal P2 Closure Assessment

Once all required conditions are present, the formal closure mechanism should automatically evaluate P2.

Expected machine state:

```text
formalClosurePass = true
p2Closed = true
closureState = CLOSED
```

There must be no unresolved P2 closure blocker that contradicts this state.

Previously relevant blocker categories should be cleared, including equivalents of:

```text
P2-D4-OPERATIONAL-CONTRADICTION
P2-RATIFICATION
P2-EPOCH
P2-PROOF-AUTHORITATIVE-CYCLE
P2-FIRST-PROVEN-IMPROVEMENT
P2-CYCLE-CLOSURE
```

---

## 13. Explicit Creator Approval

Even after machine closure reaches:

```text
formalClosurePass = true
p2Closed = true
closureState = CLOSED
```

the Creator must explicitly approve the final P2 closure.

This is the final human authority step.

The desired final statement can be explicit and simple, for example:

```text
Creator approval: P2 closure accepted.
```

After that, P2 can be treated as formally closed.

---

## 14. P3 Deferrals Must Remain Deferred

The following items remain P3 work and must not block P2 closure:

```text
Project Intent Model compiler (AMB-003)
environment adapter registry
```

Do not accidentally pull these into the P2 closure scope.

---

## 15. Recommended Execution Order

Use this exact sequence:

```text
1. Provide OPENAI_API_KEY
2. Verify exact gpt-5.6 gateway operationallyReady=true

3. Freeze exact current normative docs/hashes
4. Ratify them

5. Open epoch P2-authoritative

6. Select a small deterministic measurable CLU-E hotspot

7. Run authoritative proof attempt
8. If REJECT/REVISE -> improve candidate and retry
9. Reach real ACCEPT

10. Verify ACCEPT produced Great Book entry

11. Close cycle:
    grade = proof-authoritative
    criteriaMet = true

12. Run/read formal P2 closure assessment

13. Verify:
    formalClosurePass = true
    p2Closed = true
    closureState = CLOSED

14. Creator gives explicit final approval
```

---

## 16. Pre-Ceremony Verification Checklist

Before starting the authoritative proof cycle, confirm:

```text
[ ] latest runtime healthy
[ ] status consistent
[ ] current Q1/SURF fixes retained
[ ] no known runtime regression
[ ] OpenAI provider configured
[ ] exact model gpt-5.6
[ ] OPENAI_API_KEY present
[ ] operationallyReady = true
[ ] no silent model fallback
[ ] remote remains intentionally NO_REMOTE_YET
[ ] Start CLU-E does not auto-sync Git
[ ] normative docs frozen
[ ] exact hashes captured
[ ] ratificationCurrent = true
[ ] epochName = P2-authoritative
[ ] epochCurrent = true
```

---

## 17. Post-Cycle Verification Checklist

After the successful authoritative cycle, confirm:

```text
[ ] proofAttempts >= 1
[ ] verdicts >= 1
[ ] accepts >= 1
[ ] greatBookEntries >= 1

[ ] lastCycleGrade = proof-authoritative
[ ] lastCycleCriteriaMet = true

[ ] formalClosurePass = true
[ ] p2Closed = true
[ ] closureState = CLOSED

[ ] no contradictory P2 blockers remain
[ ] Creator final approval recorded
```

---

## 18. What Does NOT Count as P2 Closure

Do not consider P2 closed merely because:

- Q1 SURF works visually,
- runtime is healthy,
- tests pass,
- proof command exists,
- proof board exists,
- Great Book projection exists,
- OpenAI configuration exists but key is missing,
- an engineering patch was validated,
- a candidate improvement appears better,
- a manual benchmark looks positive.

P2 closure requires the full authoritative chain:

```text
operational AI
→ ratification
→ authoritative epoch
→ durable proof cycle
→ real ACCEPT
→ Great Book
→ proof-authoritative cycle closure
→ formal machine closure
→ Creator approval
```

---

## 19. Definition of Done

P2 is DONE only when both conditions are true:

### Machine closure

```text
formalClosurePass = true
p2Closed = true
closureState = CLOSED
```

### Human closure

```text
Creator explicitly approves P2 closure
```

Only then should the project move forward with P2 considered formally complete.
