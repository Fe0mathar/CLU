# Master Benchmark — target `clu`

**Status:** DRAFT FOR CREATOR REVIEW — benchmark repair awaiting native validation and ratification.
**Benchmark id:** `clu-master`
**Benchmark version:** 0.2.0
**Parent version:** 0.1.0
**Runner adapter:** `cli-node` (see §0; the browser-injection adapter is a sibling, not a
replacement).

> **Read §0 first.** This contract follows the field structure of the sealed template
> `templates/benchmark.template_v9.txt`, which turned out to specify the Master Benchmark
> far more completely than the session's design record assumed. Nothing here invents a new
> contract format; it fills in the governed one for a target CLU-E can actually measure
> today, and preserves which choices were Creator decisions and which still belong to Murugan.

---

## 0. Approval basis retained with the contract

**F1 — the contract format already exists and is sealed.** `benchmark.template_v9.txt` is
one of the seventeen files under `SHA256SUMS_v9.txt`, and it already prescribes
`benchmark_id`, versioning and parentage, a `runner_adapter`, environment and command
blocks, execution policy (warmups, repetitions, seeds, freshness), repeatable
`[scenario.*]` and `[telemetry.*]` blocks with **native units preserved**, deterministic
`[gate.*]` rules that "must not be inferred solely from an AI judgment", comparability,
coverage including `known_blind_spots`, and governance. The session's design record
proposed a `.md` shape as if from scratch — this contract instead **fills the governed fields**
and renders them as Markdown, which the Creator asked for. The instance's extension is free:
the template governs the *fields*, and only the template itself is sealed.

**F2 — the browser-injected harness is an adapter, not the model.** The Creator specified
a stored `.js` that CLU-E injects into a page to produce a unified score. That fits the
governed model exactly: it is a `runner_adapter` (`browser-injection`) alongside others.
But **the active target today is `clu` — CLU-E assessing itself** — and CLU-E is a Node CLI
whose only browser surface is its dashboard. A browser-injected harness cannot score it. So:

- **this** contract uses `cli-node`, and is measurable today;
- the browser-injection adapter and its harness belong with **Murugan's** profile, and its
  scenarios need Murugan's knowledge, which the session does not have and will not invent.

The consequence is worth stating plainly: approval of this contract makes a
**proof-authoritative cycle possible for the `clu` target** without waiting for Murugan.

## 1. Purpose and scope

This benchmark exercises the complete accepted CLU-E program end to end and observes it in
native units. It is not a candidate A/B benchmark and it is not a results file. Its job is
to answer one question at cycle closure: **did the accepted project get better, worse, or
stay the same, in ways that were declared before the change?**

## 2. Environment

| Field | Value |
|---|---|
| `required_os` | any (Windows and Linux both exercised) |
| `required_runtime` | Node ≥ 22.11 |
| `required_browser` | none (this adapter) |
| `required_hardware` | any; results are compared only within a fingerprint class |
| `required_dependencies` | the repository lockfile, hashed into the recognition basis |
| `environment_fingerprint_policy` | **record-only**, with comparison refused across differing `node_version`/`platform`/`arch` — the cycle lock already carries this triple |

## 3. Commands

| Field | Value |
|---|---|
| `build` | `npm run build` |
| `launch` | not applicable — each scenario invokes the CLI directly |
| `readiness` | `clue doctor` exits 0 with no `fail` check |
| `cleanup` | dispose the runtime; no residue outside the workspace |

## 4. Execution policy

`default_timeout_seconds` 1800 · `default_warmup_runs` 1 · `default_repetitions` 3 ·
`maximum_total_runtime_seconds` 5400 · `parallelism_policy` **serial** (these scenarios
contend for the workspace lock and the disk) · `random_seed_policy` **fixed** ·
`freshness_policy` an opening result may be reused while the cycle's lock digest and mission
version both still reproduce — the same condition §19's handoff and §21.2's resume already use.

## 5. Scenarios

Each is a whole-program operation CLU-E genuinely performs. Objective and capability ids are
left as `<…>` because the Project Intent Model does not exist yet (`AMB-003`) — that absence
is real and is recorded rather than filled with plausible-looking ids.

**`SCN-001` — cold recognition.** Full rescan of the target from a clean scan cache.
*Setup:* clear the cache; capture a canonical snapshot. *Action:* `clue recognize --full`.
*Completion:* the recognition record is sealed and its pointer written.
*Artifacts:* the run's Navigator stream, the graph record.
*Invalid when:* the snapshot and the compiled program disagree (the parity refusal), or the
oracle-divergence fallback fires — a diverged run is not a slow run.

**`SCN-002` — incremental recognition.** The same operation with a warm cache and no source
change. *Completion:* the recorded result hash equals `SCN-001`'s. *Invalid when:* the hashes
differ, which would make the timing meaningless.

**`SCN-003` — screening.** `clue metrics` over the recognized graph.
*Completion:* the metric record and ranking are stored.

**`SCN-004` — projection rebuild.** `clue benchmark rebuild-projections` replays the verified
committed event chain into an empty scratch database. It checks normalized Status facts against
the current projections at the same event head. The timed interval is the scratch replay and
projection rebuild. The live database, sidecars, log and artifacts are inputs only.
*Invalid when:* replay, event head or Status fact parity cannot be confirmed.

**`SCN-005` — full-chain log verification.** `clue benchmark verify-chain` reads and verifies
every committed event and checks the existing rollback checkpoint. It reports the count and
head without opening a writer or using provider credentials. The regular `clue doctor --deep` readiness checks remain part of host operations.

**`SCN-006` — offline benchmark suite v1.** The versioned Node entry
`dist/selftest/benchmark-offline-suite-v1.js` imports an explicit list of offline tests in one
process. It exercises functional regressions with network access denied. The complete selftest
suite, including real dashboard HTTP and host integration, remains a separate release gate.
*Invalid when:* the marker or totals are missing, zero tests pass, or any test fails, is
cancelled, or is marked todo. Skips are counted and protected by GATE-001.

## 6. Telemetry — native units, preserved

| id | signal | scenarios | native unit | aggregation | required | quality check |
|---|---|---|---|---|---|---|
| `SIG-001` | cold recognition wall time | SCN-001 | ms | median of 3 | yes | relative spread ≤ 15% or the run is `incomplete` |
| `SIG-002` | recognition throughput | SCN-001 | units/s | median | yes | derived from SIG-001 and SIG-003. Raw rates support proof when their median reproduces the published value |
| `SIG-003` | units recognized | SCN-001 | count | exact | yes | must equal SCN-002's or both are invalid |
| `SIG-004` | edges recognized | SCN-001 | count | exact | yes | as above |
| `SIG-005` | unresolved imports | SCN-001 | count | exact | yes | **protective** (§7) |
| `SIG-006` | incremental recognition wall time | SCN-002 | ms | median of 3 | yes | spread ≤ 15% |
| `SIG-007` | screening wall time | SCN-003 | ms | median of 3 | yes | spread ≤ 15% |
| `SIG-008` | metric values stored | SCN-003 | count | exact | yes | **protective** — a drop means coverage was lost |
| `SIG-009` | scratch projection rebuild time | SCN-004 | ms | median of 3 | yes | spread ≤ 15% |
| `SIG-010` | full-chain verify wall time | SCN-005 | ms | median of 3 | yes | spread ≤ 15% |
| `SIG-011` | offline suite wall time | SCN-006 | ms | median of 3 | yes | spread ≤ 20% (I/O-bound) |
| `SIG-012` | offline tests passing | SCN-006 | count | exact | yes | **protective** |
| `SIG-013` | offline tests skipped | SCN-006 | count | exact | yes | **protective** — skips must not grow silently |

Record a fresh opening baseline under this version. The earlier suite timing and counts do not
describe the fixed offline suite.

## 7. Gates — deterministic, never inferred

| id | rule | severity | on failure |
|---|---|---|---|
| `GATE-001` | `SIG-012` must not decrease and `SIG-013` must not increase | mandatory | invalidate the run |
| `GATE-002` | `SIG-003` and `SIG-004` must not decrease by more than 0.5% without a declared removal | mandatory | invalidate the run |
| `GATE-003` | `SIG-005` must not increase | mandatory | block equilibrium |
| `GATE-004` | `SIG-008` must not decrease | mandatory | block equilibrium |
| `GATE-005` | no timing signal may regress more than 10% against the opening run of the same cycle | advisory | create a candidate seed |

Every gate is machine-evaluable from the signals above. None consults a judgement.

## 8. The unified score

A single number, composed only of the timing signals, each expressed as a ratio against the
same cycle's opening run so the score is dimensionless and comparable:

```
speed(SIG) = opening(SIG) / closing(SIG)      # >1 is faster
unifiedScore = geometric_mean(
  speed(SIG-001), speed(SIG-006), speed(SIG-007), speed(SIG-009), speed(SIG-010), speed(SIG-011)
)
```

Geometric mean because these are ratios: it refuses to let one dramatic improvement mask
several regressions, which an arithmetic mean would allow.

**The score never travels alone.** Execution Model §18 requires native-unit vital signs and
raw artifacts to be preserved, so every run reports the full `measures[]` table alongside
`unifiedScore`, and any signal that could not be collected appears in `incomplete[]` rather
than depressing the number. **A mandatory gate failure voids the run**; it does not produce a
low score. `unifiedScore = 1.0` exactly means "indistinguishable from the opening run", which
is a legitimate and common honest outcome.

## 9. Comparability

`compatibility_class` **partially-comparable** with 0.1.0. SCN-001 through SCN-003 and SIG-001
through SIG-008 retain their definitions. SCN-004 through SCN-006 and SIG-009 through SIG-013
change execution or scope and require a new baseline. Stable ids are retained. Compare proof
runs only when the full contract identity, input basis and environment match.

## 10. Coverage and blind spots

`required_metric_families` — the catalogue's active v6 set. Declared blind spots, stated
because omitting uncertainty is the one thing this system may not do:

- **no objective/capability ids** — the Project Intent Model does not exist (`AMB-003`), so
  no scenario can claim an evidence path to a declared objective;
- **no browser surface measured** — the dashboard is untested by this adapter;
- **wall time is host-sensitive** — cross-host comparison is refused by §2's fingerprint rule,
  which means a two-host program compares only within each host;
- **no adversarial or holdout scenarios** — every scenario here is a happy path;
- **no memory or allocation signal** — deliberately omitted rather than measured badly.

## 11. Governance

`change_rationale` — preserve the live projection database during measurement and make
chain verification and the regression suite executable inside the qualified offline boundary.
`critic_review_required` **true** for any version that changes a gate.
`information_gain_validation` — the Windows rehearsal of 0.1.0 collected 9 of 13 signals.
Validate that this revision can collect all 13 in a disposable Windows workspace, then run
the full registered measurement policy on a fresh governed opening baseline.
`execution_cost_budget` — 90 minutes wall time; a run exceeding it is `incomplete`, not slow.

## 11a. Harness

ADR-0010 (accepted 2026-08-11): the harness lives here, in this document, so that a change to
how something is measured cannot slip past the version that governs comparability. The block
below follows the template's `[section.<id>]` convention; the runner extracts the fenced body,
checks its `integrity` hash, syntax-checks it, and refuses rather than scoring on a body that
does not parse. The body hash identifies the exact draft for rehearsal. Creator approval
and mission registration are separate from the integrity check.

**Execution contract.** The body is executed as an async JavaScript function of one argument,
`context`, supplied by `src/benchmark/benchmarkRunner.ts`. Everything the harness touches
arrives through it — `repoRoot`, `workspaceRoot`, argv prefixes for `clue`/`npm`/`node`, an
`exec(argv, opts)` primitive whose `wallMs` is the runner's clock, the `baseline` measures of
the same cycle's opening run (or `null`), `repetitions`/`warmupRuns` from §4, and the
`environment` fingerprint triple. The harness opens no file and owns no clock, so the runner
holds execution authority and timeout policy, and the body stays a pure measurement procedure.

**Result fields.** `measures[]` entries are `{ id, name, scenario, native_unit, aggregation,
value, samples, warmup_samples }`. Measured repetitions and warm-up observations are kept
separately. Warm-up observations do not contribute to the statistic. Exact signals carry
each measured count and require those counts to agree. A derived SIG-002 value whose raw
rates do not reproduce the published aggregate is available for diagnostics.
`protective[]` restates the four protective signals (SIG-005, SIG-008, SIG-012, SIG-013) as
`{ id, value }`, `value: null` when uncollected, so gate evaluation reads one place.
`incomplete[]` entries are `{ id, reason }` — a signal that failed its §6 quality check or
whose scenario went invalid lands there rather than depressing the score. `unifiedScore` is
`null` when no `baseline` was supplied: a run with no opening to compare against states the
absence rather than fabricating the 1.0 that "indistinguishable" would claim.

**Operational bindings.** SCN-001 and SCN-002 compare the durable graph pointer's
`resultHash` (`<workspace>/graph/current.json`). Both generate the Navigator stream.
SCN-004 accepts the verified scratch rebuild receipt and uses the internal elapsed time.
SCN-005 accepts a successful committed-chain count and head. SCN-006 accepts the offline
suite v1 marker and complete TAP totals.

The `integrity` value below is the sha256 of the fenced body in canonical form (CR-stripped
lines, LF-joined, no trailing newline — `canonicalHarnessBody()` in `harnessBlock.ts` is the
executable definition). It identifies the exact body under review.

```
[harness.HRN-001]
runner_adapter  = cli-node
scenario_ids    = SCN-001,SCN-002,SCN-003,SCN-004,SCN-005,SCN-006
language        = javascript
integrity       = 14eb2aa15973cec47a2bc31b6ebe06ec0f091f08b8b59f8a8203d4afc47795a7
--- begin harness ---
// Master Benchmark harness — target `clu`, adapter `cli-node`, benchmark_version 0.2.0.
// Executed by benchmarkRunner.ts as an async function body: (context) => result.
// Everything the body touches arrives through `context`; it opens no file and spawns no
// process except through context.exec, so the runner owns timeouts, cwd, and the clock.
//
// context contract (implemented by src/benchmark/benchmarkRunner.ts):
//   repoRoot        absolute path of the target repository (cwd of every exec)
//   workspaceRoot   absolute path of the CLU-E workspace for this target
//   cliArgv         argv prefix invoking the clue CLI          e.g. ['node','<dist>/cli/index.js']
//   nodeArgv        argv prefix invoking node                   e.g. ['node']
//   exec(argv,opts) -> Promise<{code,stdout,stderr,wallMs,timedOut}>; opts:{timeoutSeconds?}
//   baseline        opening run's measures[] (same shape as returned), or null
//   repetitions     [execution] default_repetitions        (3)
//   warmupRuns      [execution] default_warmup_runs        (1)
//   environment     { node_version, platform, arch } — the lock's fingerprint triple
//   log(line)       progress narration; may be a no-op
//
// Result shape (the contract's, §11a prose defines the fields):
//   { benchmarkVersion, unifiedScore, measures[], protective[], environment, incomplete[] }

const BENCHMARK_VERSION = '0.2.0';
const PROTECTIVE_IDS = ['SIG-005', 'SIG-008', 'SIG-012', 'SIG-013'];
const SCORE_IDS = ['SIG-001', 'SIG-006', 'SIG-007', 'SIG-009', 'SIG-010', 'SIG-011'];

const measures = [];
const incomplete = [];
const log = typeof context.log === 'function' ? context.log : () => {};

function record(id, name, scenario, unit, aggregation, value, samples, warmupSamples) {
  measures.push({
    id, name, scenario, native_unit: unit, aggregation, value, samples,
    ...(warmupSamples === undefined ? {} : { warmup_samples: warmupSamples }),
  });
}
function miss(id, reason) {
  incomplete.push({ id, reason });
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function relSpread(values) {
  const m = median(values);
  return m === 0 ? 0 : (Math.max(...values) - Math.min(...values)) / m;
}
// One check line from the CLI formatter: `  OK  <label padded>  <detail>`.
function checkDetail(stdout, label) {
  const re = new RegExp('^\\s*(?:OK|WARN|INFO|FAIL)\\s+' + label + ' {2,}(.*)$', 'm');
  const m = re.exec(stdout);
  return m === null ? null : m[1].trim();
}
function leadingInt(text) {
  if (text === null) return null;
  const m = /^(\d+)/.exec(text);
  return m === null ? null : Number(m[1]);
}
async function clue(args, timeoutSeconds) {
  return context.exec([...context.cliArgv, ...args], timeoutSeconds ? { timeoutSeconds } : {});
}
async function readPointerResultHash() {
  const pointer = context.workspaceRoot + '/graph/current.json';
  const probe = await context.exec([
    ...context.nodeArgv,
    '-p',
    'JSON.parse(require("fs").readFileSync(' + JSON.stringify(pointer) + ',"utf8")).resultHash',
  ]);
  return probe.code === 0 ? probe.stdout.trim() : null;
}
// Keep warm-up observations for proof while excluding them from the measured statistic.
async function timed(action, validity) {
  const warmups = [];
  const runs = [];
  const total = context.warmupRuns + context.repetitions;
  for (let i = 0; i < total; i += 1) {
    const run = await action();
    const refusal = await validity(run);
    if (refusal !== null) return { invalid: refusal };
    (i < context.warmupRuns ? warmups : runs).push(run);
  }
  return { warmups, runs };
}
function timing(id, name, scenario, observations, spreadLimit) {
  const wallMs = observations.runs.map((run) => run.wallMs);
  const spread = relSpread(wallMs);
  if (spread > spreadLimit) {
    miss(id, scenario + ': relative spread ' + (spread * 100).toFixed(1) + '% exceeds ' + spreadLimit * 100 + '% — the timing is not trustworthy');
    return null;
  }
  const value = median(wallMs);
  record(id, name, scenario, 'ms', 'median', value, wallMs, observations.warmups.map((run) => run.wallMs));
  return value;
}
function exactCount(id, name, scenario, observations, readCount) {
  const samples = observations.runs.map(readCount);
  const warmupSamples = observations.warmups.map(readCount);
  const first = samples[0];
  if (first === undefined || first === null || !samples.every((value) => value === first) || warmupSamples.includes(null)) {
    miss(id, scenario + ': exact counts disagreed or could not be read');
    return null;
  }
  record(id, name, scenario, 'count', 'exact', first, samples, warmupSamples);
  return first;
}

/* SCN-001 — cold recognition. Setup: the scan cache is a projection, so `--full` — which
 * forces a rescan instead of consulting it — is the operational clean-cache semantics; a
 * canonical snapshot is captured explicitly per §5. */
log('SCN-001 cold recognition');
let scn1 = null;
{
  const snap = await clue(['snapshot'], 1800);
  if (snap.code !== 0) {
    for (const id of ['SIG-001', 'SIG-002', 'SIG-003', 'SIG-004', 'SIG-005']) {
      miss(id, 'SCN-001 setup: `clue snapshot` exited ' + snap.code + ' — ' + snap.stderr.trim().slice(0, 200));
    }
  } else {
    const out = await timed(
      () => clue(['recognize', '--full', '--navigator'], 1800),
      async (run) => {
        if (run.timedOut) return 'SCN-001: recognition timed out';
        if (run.code !== 0) return 'SCN-001: recognition exited ' + run.code + ' (parity refusal or divergence voids the run) — ' + run.stderr.trim().slice(0, 200);
        return null;
      },
    );
    if ('invalid' in out) {
      for (const id of ['SIG-001', 'SIG-002', 'SIG-003', 'SIG-004', 'SIG-005']) miss(id, out.invalid);
    } else {
      const units = (run) => leadingInt(checkDetail(run.stdout, 'units'));
      const unitCount = exactCount('SIG-003', 'units recognized', 'SCN-001', out, units);
      const edges = exactCount('SIG-004', 'edges recognized', 'SCN-001', out, (run) => leadingInt(checkDetail(run.stdout, 'edges')));
      const unresolved = exactCount('SIG-005', 'unresolved imports', 'SCN-001', out, (run) => leadingInt(checkDetail(run.stdout, 'unresolved')));
      const wall = timing('SIG-001', 'cold recognition wall time', 'SCN-001', out, 0.15);
      if (wall === null || unitCount === null || [...out.warmups, ...out.runs].some((run) => run.wallMs <= 0)) {
        miss('SIG-002', 'SCN-001: throughput requires valid positive recognition time and unit count observations');
      } else {
        const throughput = (run) => units(run) / (run.wallMs / 1000);
        const samples = out.runs.map(throughput);
        const value = unitCount / (wall / 1000);
        // With an even repetition count, median timing then division can differ
        // from the median of raw rates. Preserve the published derived value.
        if (median(samples) === value) {
          record('SIG-002', 'recognition throughput', 'SCN-001', 'units/s', 'median', value, samples, out.warmups.map(throughput));
        } else {
          record('SIG-002', 'recognition throughput', 'SCN-001', 'units/s', 'median', value, [value]);
        }
      }
      if (unitCount !== null && edges !== null && unresolved !== null) {
        scn1 = { resultHash: await readPointerResultHash() };
      }
    }
  }
}

/* SCN-002 — incremental recognition: warm cache, no source change; the recorded result
 * hash (the graph pointer's resultHash, §14.5's durable result identity) must equal
 * SCN-001's or the timing is meaningless and SIG-003/004 are invalid with it. */
log('SCN-002 incremental recognition');
{
  const out = await timed(
    () => clue(['recognize', '--navigator'], 1800),
    async (run) => {
      if (run.timedOut) return 'SCN-002: recognition timed out';
      if (run.code !== 0) return 'SCN-002: recognition exited ' + run.code + ' — ' + run.stderr.trim().slice(0, 200);
      const hash = await readPointerResultHash();
      if (scn1 === null || scn1.resultHash === null) return 'SCN-002: SCN-001 produced no result hash to compare against';
      if (hash !== scn1.resultHash) {
        const detail = 'SCN-002: result hash ' + String(hash).slice(0, 12) + '… differs from SCN-001 ' + scn1.resultHash.slice(0, 12) + '… — the timing is meaningless';
        miss('SIG-003', detail);
        miss('SIG-004', detail);
        for (let i = measures.length - 1; i >= 0; i -= 1) {
          if (measures[i].id === 'SIG-003' || measures[i].id === 'SIG-004') measures.splice(i, 1);
        }
        return detail;
      }
      return null;
    },
  );
  if ('invalid' in out) miss('SIG-006', out.invalid);
  else timing('SIG-006', 'incremental recognition wall time', 'SCN-002', out, 0.15);
}

/* SCN-003 — screening. */
log('SCN-003 screening');
{
  const stored = (run) => leadingInt(checkDetail(run.stdout, 'values stored'));
  const out = await timed(
    () => clue(['metrics'], 1800),
    async (run) => {
      if (run.timedOut) return 'SCN-003: screening timed out';
      if (run.code !== 0) return 'SCN-003: `clue metrics` exited ' + run.code + ' — ' + run.stderr.trim().slice(0, 200);
      if (stored(run) === null) return 'SCN-003: `values stored` line unreadable — the record cannot be confirmed';
      return null;
    },
  );
  if ('invalid' in out) {
    miss('SIG-007', out.invalid);
    miss('SIG-008', out.invalid);
  } else {
    timing('SIG-007', 'screening wall time', 'SCN-003', out, 0.15);
    exactCount('SIG-008', 'metric values stored', 'SCN-003', out, stored);
  }
}

/* SCN-004 — replay into a disposable database and verify Status facts. */
log('SCN-004 projection rebuild');
{
  const out = await timed(
    async () => {
      const run = await clue(['benchmark', 'rebuild-projections'], 1800);
      let receipt;
      try { receipt = JSON.parse(run.stdout); } catch { /* Report invalid output below. */ }
      return { ...run, receipt };
    },
    async (run) => {
      if (run.timedOut) return 'SCN-004: projection rebuild timed out';
      if (run.code !== 0) return 'SCN-004: rebuild exited ' + run.code + ' — ' +
        (run.stdout.trim() || run.stderr.trim()).slice(0, 200);
      const receipt = run.receipt;
      if (receipt?.state !== 'PROJECTION_REBUILD_VERIFIED' ||
          !Number.isSafeInteger(receipt.eventCount) || receipt.eventCount <= 0 ||
          !/^[a-f0-9]{64}$/.test(receipt.eventHead) || !/^[a-f0-9]{64}$/.test(receipt.factsDigest) ||
          !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs <= 0 || receipt.elapsedMs > run.wallMs) {
        return 'SCN-004: scratch rebuild receipt or Status fact parity was unverified';
      }
      return null;
    },
  );
  if ('invalid' in out) miss('SIG-009', out.invalid);
  else {
    const rebuildTime = (run) => ({ ...run, wallMs: run.receipt.elapsedMs });
    timing('SIG-009', 'scratch projection rebuild time', 'SCN-004', {
      runs: out.runs.map(rebuildTime), warmups: out.warmups.map(rebuildTime),
    }, 0.15);
  }
}

/* SCN-005 — measure full committed-chain verification without a provider or writer. */
log('SCN-005 full-chain verification');
{
  const out = await timed(
    () => clue(['benchmark', 'verify-chain'], 1800),
    async (run) => {
      if (run.timedOut) return 'SCN-005: full-chain verification timed out';
      if (run.code !== 0) return 'SCN-005: verify-chain exited ' + run.code + ' — ' +
        (run.stdout.trim() || run.stderr.trim()).slice(0, 200);
      const receipt = checkDetail(run.stdout, 'event chain');
      if (!/^[1-9]\d* committed records verified, head [a-f0-9]{64}$/.test(receipt ?? '')) {
        return 'SCN-005: committed-chain verification receipt was unverified';
      }
      return null;
    },
  );
  if ('invalid' in out) miss('SIG-010', out.invalid);
  else timing('SIG-010', 'full-chain verify wall time', 'SCN-005', out, 0.15);
}

/* SCN-006 — fixed offline suite with a version marker and complete TAP totals. */
log('SCN-006 offline benchmark suite');
{
  const summary = (run, label) => {
    const matches = [...run.stdout.matchAll(new RegExp('^# ' + label + ' (\\d+)[ \\t]*\\r?$', 'gm'))];
    if (matches.length !== 1) return null;
    const value = Number(matches[0][1]);
    return Number.isSafeInteger(value) ? value : null;
  };
  const passCount = (run) => summary(run, 'pass');
  const skipCount = (run) => summary(run, 'skipped');
  const out = await timed(
    () => context.exec([...context.nodeArgv, 'dist/selftest/benchmark-offline-suite-v1.js'], { timeoutSeconds: 1800 }),
    async (run) => {
      if (run.timedOut) return 'SCN-006: the offline suite timed out';
      if (run.code !== 0) return 'SCN-006: the offline suite exited ' + run.code + ' — ' +
        (run.stderr.trim() || 'failed tests: ' + String(summary(run, 'fail'))).slice(0, 200);
      if (!/^CLU-E_OFFLINE_SUITE_V1\r?$/m.test(run.stdout)) return 'SCN-006: offline suite version was unverified';
      const pass = passCount(run);
      const skip = skipCount(run);
      const tests = summary(run, 'tests');
      if (pass === null || pass === 0 || skip === null || tests !== pass + skip ||
          summary(run, 'fail') !== 0 || summary(run, 'cancelled') !== 0 || summary(run, 'todo') !== 0) {
        return 'SCN-006: offline suite summary was incomplete, unreadable or red';
      }
      return null;
    },
  );
  if ('invalid' in out) {
    for (const id of ['SIG-011', 'SIG-012', 'SIG-013']) miss(id, out.invalid);
  } else {
    timing('SIG-011', 'offline suite wall time', 'SCN-006', out, 0.2);
    exactCount('SIG-012', 'offline tests passing', 'SCN-006', out, passCount);
    exactCount('SIG-013', 'offline tests skipped', 'SCN-006', out, skipCount);
  }
}

/* §8 — the unified score: geometric mean of opening/closing ratios over the timing
 * signals, computed only against a provided baseline; a run with no opening to compare
 * against carries null, a stated absence, never a fabricated 1.0. Signals missing on
 * either side are excluded rather than allowed to depress the number. */
let unifiedScore = null;
if (context.baseline !== null && context.baseline !== undefined) {
  const opening = new Map(context.baseline.map((m) => [m.id, m.value]));
  const ratios = [];
  for (const id of SCORE_IDS) {
    const closing = measures.find((m) => m.id === id);
    const open = opening.get(id);
    if (closing !== undefined && typeof open === 'number' && closing.value > 0) {
      ratios.push(open / closing.value);
    }
  }
  if (ratios.length > 0) {
    unifiedScore = Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length);
  } else {
    miss('unifiedScore', 'no timing signal was collected on both the opening and closing run');
  }
}

const protective = PROTECTIVE_IDS.map((id) => {
  const m = measures.find((entry) => entry.id === id);
  return m !== undefined ? { id, value: m.value } : { id, value: null };
});

return {
  benchmarkVersion: BENCHMARK_VERSION,
  unifiedScore,
  measures,
  protective,
  environment: context.environment,
  incomplete,
};
--- end harness ---
```

## 12. Creator review and registration

Version 0.1.0 was Creator-approved on 2026-08-13. Its evidence remains bound to that
version. Version 0.2.0 preserves the five gate rules and changes the three scenarios
identified in §9. This draft needs Windows validation, Creator approval and a successor
mission before it can govern proof. The registered path remains
`targets/clu/benchmark/master-benchmark.md`.
