# Target Profiles and the Master Benchmark — design v1

**Status:** accepted — the Creator decided 2026-08-11: **D1** a profile per target; **D2** the benchmark's identity is the pair (`.md` + `.js`); **D5** build order begins at B1. **D3** (score alongside native measures, §18) and **D4** (credentials by reference only) were taken as settled rather than put to a vote — the first is required by the Execution Model, the second by the convention `gateway.api_key_env` already sets.
**Date:** 2026-08-11
**Origin:** the Creator's two design statements of 2026-08-11, which reframe **DEV-P2-04**
(the remote) and **DEV-P2-07** (the Master Benchmark) from *values I was waiting on* into
*features to be built*. Recorded here before any code, because both change shapes that
several modules already depend on.

---

## 1. What the Creator specified

1. **The remote is a dashboard act, not a config literal.** The configuration panel offers
   a field for the Git URL and a control that grants the dashboard authority to push.
2. **The Master Benchmark is two artifacts, not one.** A dedicated `.md` describes the
   benchmark; a stored `.js` harness is **injected into the browser by CLU-E and executed**
   against the running target, returning a **unified score**.
3. **Both are selected per target.** The benchmark and the target's documentation are the
   operator's selection, "since Murugan will not always be the target."

## 2. Three findings that make this cheaper than it looks

**F1 — the injection seam already exists and already knows the word "benchmark".**
`src/experiment/browser/browserAgent.ts` (1186 lines) attaches over CDP and exposes
`evaluate(expression)` → `Runtime.evaluate` with `returnByValue` and `awaitPromise`,
raising `PROTOCOL_ERROR` on an in-page throw. Its telemetry already cues
`Runtime.evaluate` as `benchmark_start`. The harness needs a **runner** over this seam,
not a new browser integration. Its own doc-comment states the discipline the harness must
inherit: evaluate only against surfaces the caller declared and probed for.

**F2 — the secret convention is already established, and it is not "store the secret".**
`gateway.api_key_env` and `notifications.webhook_url_env` store the *name of an environment
variable*, never a value. Git authority follows the same rule: the configuration stores a
credential **reference**, the dashboard grants and revokes, and no secret ever reaches the
event log, an artifact, or a status snapshot.

**F3 — the target/CLU-E boundary is already in the config, and it is the seam profiles cut
along.** `constitution.tracked_documents` is CLU-E's own governing pack — never
target-selectable. Everything under `project.*` (`document_roots`, `source_roots`,
`inputs.description`, `inputs.benchmark`) is the target's, and that is exactly the set a
profile carries.

## 3. Proposed shape — target profiles

A profile is one directory per target under `targets/<id>/`, carrying that target's
selections; the configuration names the **active** profile and nothing more:

```yaml
project:
  active_target: murugan          # names targets/murugan/profile.yaml
```

```yaml
# targets/murugan/profile.yaml
id: murugan
root: "F:/murugan"
source_roots: [src]
document_roots: [.]
inputs:
  description: "target description.md"
  benchmark:
    contract: "benchmark/master-benchmark.md"   # the .md the Creator specified
    harness:  "benchmark/master-benchmark.js"   # the injected .js
remote:
  url: null                        # set from the dashboard
  credential_env: null             # a name, never a secret (F2)
```

Consequences, deliberately small: `computeInputLock` locks **both** benchmark artifacts by
content hash (the `.md` and the `.js` are jointly the benchmark identity — a harness change
with an unchanged contract is still a different benchmark); `project.inputs.benchmark`
becomes a pair; switching targets is switching one config line, and every lock digest
changes with it, which is correct — a different target is a different world.

## 4. Proposed shape — the benchmark contract and harness

**The `.md` (the contract).** What the score means, before any number exists: the objectives
and capabilities in scope; each measure with its native unit; the protective metrics that
must not regress; run conditions (cold/warm, iterations, discard rules); how the unified
score composes from the measures, stated as an explicit formula; and the invalidation
conditions that retire the version. It is a **governed input** — hashed into the lock,
versioned, and the Creator's to author or approve.

**The `.js` (the harness).** A single module evaluated in the page, returning a JSON-safe
result. Proposed return contract:

```js
{
  benchmarkVersion: "1.0.0",       // must equal the contract's version or the run is void
  unifiedScore: 0.0,               // composed exactly as the contract's formula states
  measures: [                      // §18: native-unit vital signs are preserved, never
    { id, value, unit, samples }   // replaced by the composite
  ],
  protective: [{ id, value, unit, threshold, held: true }],
  environment: { userAgent, webgpu, viewport, … },
  incomplete: [{ measure, reason }]   // honest partials, never silent omission
}
```

**The unified score does not replace its parts.** §18 requires the closing result to
preserve native-unit vital signs and raw artifacts, so a composite that hid its components
would violate the Execution Model. The score is a summary *carried alongside* the measures,
never instead of them — and a run reporting `incomplete` entries is a partial run that says
so rather than a lower score that lies.

**Refusals the runner owes.** Version disagreement between `.md` and `.js` voids the run;
a harness that throws in-page is a failed run, never a zero score; a run against a target
whose identity does not match the cycle's lock is refused; `security.real_settlement:
denied` means a harness that would perform real settlement is refused rather than executed.

## 5. Proposed shape — the dashboard configuration panel

Reading order matters here, so this is stated plainly: **the panel is a surface over acts
that must exist first.** Every control below has a CLI equivalent and writes through the
same service, because a dashboard that could do something no command can do would be a
second authority.

- **Target** — select the active profile; show the resulting lock identity.
- **Documentation** — choose the target's `document_roots`; show what ingest would see.
- **Benchmark** — select the contract and harness; show both hashes and the version they
  agree on (or the disagreement).
- **Remote** — the URL field, plus **Grant** / **Revoke** for push authority. Grant stores
  a credential *reference* (F2) and records an authority event naming who granted it and
  when; revoke records its own. The secret never enters the log, an artifact, or Status.

**One honest dependency:** `ui/clue-dashboard/app.js` is stale in my snapshot, and the
standing rule is that it is only ever taken fresh. Panel work needs a fresh copy from the
Creator before it starts — the same precondition DEV-P1-16 carries.

## 6. Proposed slices

| | |
|---|---|
| **B1** | profile schema + `active_target` resolution + lock over the benchmark pair |
| **B2** | the contract template (`templates/master-benchmark.template.md`) and a worked Murugan draft for the Creator to amend |
| **B3** | the harness runner over `browserAgent.evaluate`, with its refusals and a fixture harness proving them |
| **B4** | `clue benchmark run` — the CLI act, its authority declaration, and the run recorded as evidence |
| **B5** | the cycle's §18 stage: `CLOSING_EVIDENCE` performs the closing run when a benchmark is locked, and the closure's grade becomes decidable |
| **B6** | the dashboard panel (needs a fresh `app.js`) |
| **B7** | remote wiring: grant/revoke as authority events, push on verdict per `backup.*` |

B1–B5 need nothing further from the Creator except the contract's content, which B2 puts in
front of him as a draft rather than a blank page.

## 7. Decisions requested

- **D1** — target profiles as `targets/<id>/profile.yaml` with `project.active_target`,
  rather than more fields on the single config.
- **D2** — ~~the benchmark is the **pair**~~ — **superseded by ADR-0010** (accepted
  2026-08-11): the benchmark is **one artifact** with the harness embedded, because a harness
  change *is* a comparability event and the pair let one move without the other's version.
- **D3** — the unified score is carried **alongside** native-unit measures, never instead
  of them (§18), and partial runs report `incomplete` rather than a depressed score.
- **D4** — Git credentials by reference only (`credential_env`), grant/revoke recorded as
  authority events, no secret in log, artifact or Status.
- **D5** — slice order B1…B7, with B2 delivering a worked draft contract for amendment.

Accepted 2026-08-11. B1 began immediately; this record governs the shapes it builds.
