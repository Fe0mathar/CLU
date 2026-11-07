# ADR-0017 — OpenAI provider-budget authority, exact-model activation and manual Git sync

**Status:** implementation candidate for Creator ratification  
**Date:** 2026-08-14  
**Owner:** Model Gateway / Status and Q3 / dashboard control plane / local Git convenience

## Context

P2 ZIP 05 delivered an event-first OpenAI gateway in a deliberately disabled state. ZIP 06
recorded `NO_REMOTE_YET`; ZIP 07 exposed proof and benchmark evidence; ZIP 08 installed the
closure controller. The Creator has now made the remaining D4 and operator-UX decisions:

- OpenAI is activated for real CLU-E work;
- the exact requested model identity is `gpt-5.6`;
- OpenAI Platform/project/key controls money and credit, not a second CLU-E budget;
- an explicit provider billing or credit refusal must pause new AI work safely;
- Q3 may show observed token use, but may show remaining tokens only when a provider-authoritative
  allowance exists;
- CLU-E remains local-first, while Git synchronization is an explicit button next to Start and is
  never an automatic side effect of Start, proof, ACCEPT or cycle closure.

The model name is a Creator-selected configuration identity. CLU-E does not infer global provider
availability from documentation or substitute a nearby model. The provider must confirm the exact
ID for the configured key/project before a call is submitted.

## Decision 1 — OpenAI Platform is the sole monetary authority

`config/policies/budget.yaml` records:

```text
spend_authority: openai_platform
provider_exhaustion_action: controlled_pause
remaining_token_authority: provider_only
```

Compatibility cap fields remain zero and non-authoritative. They must not refuse or degrade a call
while provider authority is active. Local pricing is also non-authoritative: routing carries the published model rates only for observed
cost attribution, and CLU-E never represents locally calculated USD as provider billing truth or
permission to spend.

CLU-E continues to record exact input, cached-input, output and total token counts returned on each
provider receipt. Provider cost/balance telemetry may be added only from a provider-authoritative
surface with separately governed credentials and provenance.

## Decision 2 — exact `gpt-5.6`, provider-validated, no fallback

Every enabled P2 route names `gpt-5.6`. Immediately before submission, the adapter performs an
authenticated model-identity probe. The call proceeds only when the provider returns the exact same
ID. A missing, unavailable or mismatched model is a named refusal. No alternate model, alias or
cheaper route is selected silently.

The model probe consumes no inference tokens, but it is still provider I/O and therefore obeys the
configured timeout, response-size bound, secret boundary and typed HTTP error classification.

## Decision 3 — billing exhaustion is narrower than rate limiting

A generic HTTP 429 is `PROVIDER_RATE_LIMIT`: retryable, recorded, and never rendered as lack of
money. `PROVIDER_BUDGET_EXHAUSTED` is emitted only for explicit billing/credit/funding evidence,
including HTTP 402 or provider error codes/messages that unambiguously name insufficient quota,
credit, funds, billing inactivity or a reached hard billing limit.

That event becomes the durable authority for a controlled pause:

```text
finish the current durable event write
→ block new gateway submissions
→ block a new CLU-E pipeline start
→ preserve queued/evidence state
→ Status/Q3 = LACK OF $ / controlled pause
```

Recovery is explicit. `clue gateway resume` first probes the exact approved model and only then
records `gateway.provider_resumed`. A browser flag or process restart cannot erase the pause.

## Decision 4 — token telemetry is honest about scope

Status 5.7.0 carries cumulative observed token counts and the exact configured model. It carries:

```text
providerRemainingTokens: null
providerRemainingTokensAuthoritative: false
```

unless a future provider-authoritative allowance surface is implemented. Q3 displays `TOK LEFT`
only when that authority flag is true. Money is never converted into a fictional token balance.

## Decision 5 — Git sync is one explicit local-first operator action

The dashboard action registry adds `syncGit` as a distinct mutating action. Start does not invoke
it. The server endpoint calls a narrow local Git synchronizer with these rules:

- `NO_REMOTE_YET` returns `NO_REMOTE_CONFIGURED` without spawning Git;
- a dirty worktree or detached HEAD is refused;
- fetch happens first;
- an unchanged branch is reported unchanged;
- behind-only state fast-forwards;
- ahead-only state pushes;
- divergence is refused;
- merge commits, rebase, force push, stash and semantic conflict resolution are absent.

Credentials remain with the host Git credential helper or SSH agent. This convenience action does
not implement repository registration, worktree leasing, proof-to-commit binding, protected-ref
landing, remote checks, publication receipts or automatic revert. Status therefore continues to
report `versionControl` as unsupported until P4.

## Decision 6 — closure policy and phase boundary

`config/policies/p2-closure.yaml` records the Creator decision as `OPERATIONAL`, exact model
`gpt-5.6`, `OPENAI_PLATFORM`, no local budget enforcement, `CONTROLLED_PAUSE`, and
`PROVIDER_ONLY` remaining-token authority. The policy remains mission-bound.

P2 is still not closed merely because this patch is installed. Closure additionally requires the
current pack ratification, a current `P2-authoritative` epoch, one proof-authoritative cycle with a
real verdict, at least one ACCEPT with a matching Great Book entry, a successful cycle closure and
the final explicit Creator approval of the machine result.

`REJECT`, `REVISE` and `INVALID` remain durable proof/event evidence for later analysis. Only
`ACCEPT` creates proven-improvement Great Book memory.

## Acceptance

1. TypeScript typecheck and production build pass.
2. The exact model is probed before every provider submission and no fallback exists.
3. Zero local caps cannot stop provider-authority traffic.
4. The published route price table is observational telemetry and is never provider billing authority.
5. Explicit billing exhaustion records one durable pause and blocks subsequent gateway/pipeline
   starts; generic rate limiting does not.
6. Resume requires a successful exact-model probe.
7. Status 5.7.0, CLI and Q3 agree on model, provider pause and exact token use.
8. Remaining tokens are absent unless provider-authoritative.
9. Start and Sync Git remain distinct actions.
10. No-remote, dirty, diverged and detached Git states fail closed; unchanged, ahead-only and
    behind-only controlled fixtures behave deterministically.
11. The final backend/governance patch excludes `ui/clue-dashboard/app.js`, whose separately
    reviewed artifact remains the interface authority.
