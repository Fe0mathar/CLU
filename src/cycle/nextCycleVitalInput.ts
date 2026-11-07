/**
 * Next-cycle vital input — Execution Model §19 made buildable (DEV-P2-08 deferred slice,
 * delivered 2026-08-10; completes the five-module table of ADR-0008).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §19 — twelve bullets, quoted in the schema's field
 *       names; §19's closing sentence ("the next cycle reuses this input only when its
 *       identity and freshness conditions remain valid") is implemented by making the
 *       freshness block exactly the resume planner's §21.2 checks: lock digest and
 *       mission version, valid while both reproduce.
 *
 * ## Sources, and the honesty rule
 *
 * Everything here is read from the cycle's **own evidence** — the lock event, the
 * per-stage evidence artifacts (recognition counts, screening census, closing snapshot) —
 * or from the runtime's durable services (graph coverage at the recognized snapshot,
 * unresolved claim conflicts). Nothing is recomputed that the cycle already recorded, and
 * nothing is invented for a field whose domain does not exist: those fields are null, and
 * every null has a row in `statedAbsences`. A diagnostic cycle's vital input is therefore
 * short on values and long on named gaps — which is precisely the §19 record a first
 * cycle should hand its successor.
 */

import type { Runtime } from '../control/runtime.js';
import type { Sha256 } from '../shared/ids.js';
import { describeTargetPublication } from '../shared/targetPublication.js';
import {
  nextCycleVitalInputSchema,
  parseOrThrow,
  type ArtifactRef,
  type CycleInputLock,
  type CycleRecord,
  type NextCycleVitalInput,
} from '../shared/schemas.js';

interface RecognizedEvidence {
  readonly snapshot_id?: string;
  readonly unit_count?: number;
  readonly edge_count?: number;
  readonly unresolved_count?: number;
}

interface ScreenedEvidence {
  readonly values_stored?: number;
  readonly corpus_size?: number;
  readonly patch_candidates?: number;
  readonly families_unavailable?: readonly string[];
}

interface ClosingEvidence {
  readonly closing_snapshot_id?: string;
  readonly master_benchmark_run?: {
    readonly benchmark_version?: string;
    readonly run_artifact?: { readonly hash?: string };
  } | null;
}

export interface VitalInputDeps {
  readonly runtime: Runtime;
  readonly cycle: CycleRecord;
  readonly lock: CycleInputLock;
  readonly stageEvidence: Readonly<Record<string, ArtifactRef | null>>;
}

function readEvidence<T>(runtime: Runtime, ref: ArtifactRef | null): T | null {
  if (ref === null) return null;
  try {
    return runtime.artifacts.getJson(ref.hash as unknown as Sha256) as T;
  } catch {
    return null;
  }
}

/** Builds the §19 record for a closing cycle. Pure over its deps; the caller stores it. */
export function buildNextCycleVitalInput(deps: VitalInputDeps): NextCycleVitalInput {
  const { runtime, cycle, lock, stageEvidence } = deps;
  const absences: { field: string; reason: string }[] = [];

  const recognized = readEvidence<RecognizedEvidence>(
    runtime,
    stageEvidence['RECOGNIZED'] ?? null,
  );
  const screened = readEvidence<ScreenedEvidence>(runtime, stageEvidence['SCREENED'] ?? null);
  const closing = readEvidence<ClosingEvidence>(
    runtime,
    stageEvidence['CLOSING_EVIDENCE'] ?? null,
  );

  // §19.1 — accepted project and Git identity.
  //
  // DEV-P2-04: the target profile is the authority for target publication identity.
  // `backup.remote` is CLU-E's ledger-backup transport and may be the symbolic name
  // `origin`; treating it as the target remote made local backup configuration look like
  // accepted project identity. The mission-bound remote decision keeps local-only intent
  // distinguishable from an untouched legacy profile.
  const publication = describeTargetPublication(
    runtime.config.project.remote,
    runtime.config.project.credential_env,
    runtime.config.project.remote_decision,
  );
  const gitRemote = publication.remote;
  if (publication.decision !== 'REMOTE_REGISTERED') {
    absences.push({
      field: 'accepted_identity.git_remote',
      reason: publication.reason,
    });
  }
  const closingSnapshotId = closing?.closing_snapshot_id ?? null;
  if (closingSnapshotId === null) {
    absences.push({ field: 'accepted_identity.closing_snapshot_id', reason: 'no closing evidence artifact readable' });
  }

  // §19.2 — Master Benchmark version and closing run (B5: filled from the recorded
  // CLOSING_EVIDENCE run; the lock is the switch, the evidence is the source).
  const recordedRun = closing?.master_benchmark_run ?? null;
  let masterBenchmark: { version: string; closing_run: Sha256 } | null = null;
  if (lock.master_benchmark === null) {
    absences.push({
      field: 'master_benchmark',
      reason: 'unregistered (DEV-P2-07); §18\u2019s closing run did not occur',
    });
  } else if (
    recordedRun === null ||
    recordedRun.benchmark_version === undefined ||
    recordedRun.run_artifact?.hash === undefined
  ) {
    absences.push({
      field: 'master_benchmark',
      reason:
        'the lock names a Master Benchmark but the closing evidence carries no readable run — ' +
        'the §18 record could not be recovered',
    });
  } else {
    masterBenchmark = {
      version: recordedRun.benchmark_version,
      closing_run: recordedRun.run_artifact.hash as Sha256,
    };
    absences.push({
      field: 'master_benchmark.opening_run',
      reason: 'no opening run this cycle — §8\u2019s score and §7\u2019s gates compare runs',
    });
  }

  // §19.4 — Project Intent Model version.
  absences.push({ field: 'intent_model_version', reason: 'AMB-003: no compiler exists' });

  // §19.5 — objective/capability coverage, at the recognized snapshot.
  let coverage: { subsystem: string; units: number; coverage: number }[] | null = null;
  if (recognized?.snapshot_id !== undefined) {
    try {
      coverage = runtime
        .requireGraph()
        .coverage(recognized.snapshot_id)
        .map((entry) => ({
          subsystem: entry.subsystem,
          units: entry.units,
          coverage: entry.coverage,
        }));
    } catch {
      coverage = null;
    }
  }
  if (coverage === null) {
    absences.push({ field: 'coverage', reason: 'no recognition coverage readable for this cycle' });
  }

  // §19.6 — native vital signs; trends need a predecessor.
  const vitalSigns =
    screened === null
      ? null
      : {
          metric_values: screened.values_stored ?? 0,
          corpus_size: screened.corpus_size ?? 0,
          trends: null,
        };
  if (vitalSigns === null) {
    absences.push({ field: 'vital_signs', reason: 'no screening evidence readable' });
  } else {
    absences.push({ field: 'vital_signs.trends', reason: 'first closure — trends need a predecessor cycle' });
  }

  // §19.7 — anomalies and blind spots, from what the cycle actually observed.
  const anomalies: { kind: string; detail: string }[] = [];
  if (recognized?.unresolved_count !== undefined && recognized.unresolved_count > 0) {
    anomalies.push({
      kind: 'unresolved_imports',
      detail: `${recognized.unresolved_count} import(s) unresolved at recognition`,
    });
  }
  for (const family of screened?.families_unavailable ?? []) {
    anomalies.push({ kind: 'metric_family_unavailable', detail: family });
  }
  const conflictCount = runtime.claims?.conflicts(true).length ?? 0;
  if (conflictCount > 0) {
    anomalies.push({ kind: 'corpus_conflicts', detail: `${conflictCount} unresolved claim conflict(s)` });
  }

  // §19.12 — freshness: exactly the resume planner's §21.2 identity checks.
  const freshness = {
    lock_digest: lock.digest,
    mission_version: cycle.mission_version,
    valid_while:
      'the lock digest reproduces and this mission version remains in force (§21.2); ' +
      'otherwise §21.3 restart or §21.4 fork',
  };

  const stage_evidence: Record<string, string | null> = {};
  for (const [stage, ref] of Object.entries(stageEvidence)) {
    stage_evidence[stage] = ref?.hash ?? null;
  }

  return parseOrThrow(
    nextCycleVitalInputSchema,
    {
      cycle_id: cycle.id,
      produced_at: new Date().toISOString(),
      accepted_identity: {
        project_id: runtime.config.project.id,
        git_remote: gitRemote,
        branch: runtime.config.project.main_branch,
        closing_snapshot_id: closingSnapshotId,
      },
      master_benchmark: masterBenchmark,
      environment_fingerprint: lock.environment_fingerprint,
      intent_model_version: null,
      coverage,
      vital_signs: vitalSigns,
      anomalies,
      unresolved_uncertainty: [...lock.absent],
      benchmark_maturity:
        lock.master_benchmark === null ? 'absent' : masterBenchmark !== null ? 'locked' : 'placeholder',
      negative_knowledge: [
        'no candidate loop was executed (diagnostic cycle by plan D3)',
        'no benchmark comparison exists for this cycle',
        `${screened?.patch_candidates ?? 0} patch candidate(s) under Stage G1 static-only ranking`,
      ],
      candidate_seeds: {
        seeds: [],
        source:
          'screening ranking (Stage G1, static evidence only) produced no patch candidates; ' +
          'seeds arrive with observed evidence',
      },
      freshness,
      stage_evidence,
      stated_absences: absences,
    },
    'next-cycle vital input',
  );
}
