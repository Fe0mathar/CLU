/** Compare complete native benchmarks on the same screened source and executable inputs. */
import { z } from 'zod';
import { snapshotManifestSchema } from '../analysis/source/snapshot.js';
import {
  benchmarkResultSchema, compareBenchmarkTimings, evaluateGates, isCompleteCluBenchmarkV020,
  type BenchmarkResult, type RunOutcome,
} from '../benchmark/benchmarkRunner.js';
import { BENCHMARK_EVENT_TYPES, type PerformedRun } from '../control/benchmarkRun.js';
import type { Runtime } from '../control/runtime.js';
import { canonicalJson, requireSha256 } from '../shared/ids.js';
import { artifactRefSchema, cycleStageAdvancedSchema, entityIdSchema, sha256Schema,
  type CycleInputLock, type CycleRecord, type EventRecord } from '../shared/schemas.js';
import { CYCLE_EVENT_TYPES } from './cycleRegistry.js';

const headSchema = z.object({ sequence: z.number().int().nonnegative(), hash: sha256Schema }).strict();
const openingEventSchema = z.object({
  registered: z.literal(true), proof_eligible: z.literal(true), budget_exhausted: z.literal(false),
  measures_count: z.literal(13), incomplete_count: z.literal(0), unified_score: z.null(),
  snapshot_id: sha256Schema, inputs_id: sha256Schema, config_sha256: sha256Schema,
  project_basis: z.unknown(), execution_boundary: z.unknown(), executable_inputs: z.unknown(),
  contract: z.unknown(), environment: z.unknown(), protective: z.unknown(),
  started_at: z.string(), finished_at: z.string(), log_head_before: headSchema, result_artifact: artifactRefSchema,
});
const openingArtifactSchema = z.object({
  proof_eligible: z.literal(true), budget: z.object({ exhausted: z.literal(false) }),
  timing: z.object({ started_at: z.string(), finished_at: z.string() }),
  inputs: snapshotManifestSchema, config_sha256: sha256Schema, result: benchmarkResultSchema,
  contract: z.unknown(), project_basis: z.unknown(), executable_inputs: z.unknown(),
  execution_boundary: z.unknown(), policy: z.unknown(),
});
const screenedSchema = z.object({
  stage: z.literal('SCREENED'), cycle_id: entityIdSchema, snapshot_id: sha256Schema, inputs: snapshotManifestSchema,
});

export const recordedOpeningComparisonSchema = z.object({
  opening_event_id: entityIdSchema, opening_event_sha256: sha256Schema, opening_artifact_sha256: sha256Schema,
  opening_log_head_before: headSchema, unified_score: z.number().finite().positive(),
  advisory_regressions: z.array(z.object({ id: z.string().min(1), opening_ms: z.number().finite().positive(),
    closing_ms: z.number().finite().positive() }).strict()).max(6),
}).strict();

const same = (one: unknown, two: unknown) => canonicalJson(one) === canonicalJson(two);

function completeNativeResult(result: BenchmarkResult, policy: Extract<RunOutcome, { ok: true }>['policy']): boolean {
  const protective = ['SIG-005', 'SIG-008', 'SIG-012', 'SIG-013'].map((id) =>
    ({ id, value: result.measures.find((measure) => measure.id === id)?.value }));
  return isCompleteCluBenchmarkV020(result) && policy.repetitions === 3 && policy.warmupRuns === 1 &&
    same(protective, result.protective) &&
    result.measures.every(({ id, samples, warmup_samples }) => id === 'SIG-002'
      ? samples.length === 1 && warmup_samples === undefined
      : samples.length === policy.repetitions && warmup_samples?.length === policy.warmupRuns);
}

export function compareClosingBenchmark(
  artifacts: Pick<Runtime['artifacts'], 'getBytes' | 'getJson'>,
  journal: Iterable<EventRecord>,
  cycle: Pick<CycleRecord, 'id' | 'mission_version' | 'grade'>,
  lock: Pick<CycleInputLock, 'master_benchmark' | 'project_basis' | 'environment_fingerprint'>,
  closing: PerformedRun,
) {
  const { outcome, subject, log_head_before: closingHead } = closing;
  if (!outcome.ok || subject?.project_basis == null || !subject.registered || closingHead === null ||
      cycle.grade !== 'proof-authoritative' || cycle.mission_version !== subject.mission_version ||
      outcome.contract.benchmark_id !== 'clu-master' || outcome.contract.benchmark_version !== '0.2.0' ||
      lock.master_benchmark?.sha256 !== outcome.contract.sha256 || !same(lock.project_basis, subject.project_basis) ||
      !same(lock.environment_fingerprint, outcome.result.environment) ||
      outcome.result.benchmarkVersion !== outcome.contract.benchmark_version || outcome.execution_boundary === undefined ||
      outcome.budget.exhausted || !completeNativeResult(outcome.result, outcome.policy)) return null;

  const events = [...journal];
  if (events[closingHead.sequence]?.hash !== closingHead.hash) return null;
  const checkpoints = events.filter((event) => event.sequence <= closingHead.sequence &&
    event.type === CYCLE_EVENT_TYPES.stageAdvanced && event.actor === 'daemon' && event.subject_id === cycle.id &&
    event.mission_version === cycle.mission_version && (event.payload as { to?: unknown } | null)?.to === 'SCREENED');
  const checkpoint = checkpoints[0];
  if (checkpoints.length !== 1 || checkpoint === undefined) return null;
  const stage = cycleStageAdvancedSchema.parse(checkpoint.payload);
  if (stage.cycle_id !== cycle.id || stage.evidence === null) return null;
  const screened = screenedSchema.parse(artifacts.getJson(requireSha256(stage.evidence.hash, 'screened evidence')));
  if (screened.cycle_id !== cycle.id || screened.snapshot_id !== subject.snapshot_id || !same(screened.inputs, subject.inputs)) return null;

  const observations = events.flatMap((event) => {
    if (event.sequence <= checkpoint.sequence || event.sequence > closingHead.sequence ||
        event.type !== BENCHMARK_EVENT_TYPES.runRecorded || event.actor !== 'cli' || event.subject_id !== null ||
        event.mission_version !== cycle.mission_version) return [];
    const parsed = openingEventSchema.safeParse(event.payload);
    if (!parsed.success) return [];
    const opening = parsed.data;
    const runHead = opening.log_head_before;
    if (runHead.sequence < checkpoint.sequence || runHead.sequence >= event.sequence ||
        events[runHead.sequence]?.hash !== runHead.hash || opening.snapshot_id !== subject.snapshot_id ||
        opening.inputs_id !== subject.inputs.id || opening.config_sha256 !== subject.config_sha256 ||
        !same(opening.project_basis, subject.project_basis) || !same(opening.contract, outcome.contract) ||
        !same(opening.executable_inputs, subject.executable_inputs) || !same(opening.execution_boundary, outcome.execution_boundary) ||
        !same(opening.environment, outcome.result.environment)) return [];
    return [{ event, opening }];
  });
  const observation = observations[0];
  if (observations.length !== 1 || observation === undefined) return null;
  const { event, opening } = observation;
  const bytes = artifacts.getBytes(requireSha256(opening.result_artifact.hash, 'opening benchmark artifact'));
  if (bytes.length !== opening.result_artifact.bytes) return null;
  const archived = openingArtifactSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (!same(archived.inputs, subject.inputs) || archived.config_sha256 !== subject.config_sha256 ||
      !same(archived.contract, opening.contract) || !same(archived.project_basis, opening.project_basis) ||
      !same(archived.executable_inputs, opening.executable_inputs) || !same(archived.execution_boundary, opening.execution_boundary) ||
      !same(archived.policy, outcome.policy) || archived.timing.started_at !== opening.started_at ||
      archived.timing.finished_at !== opening.finished_at || !same(archived.result.environment, opening.environment) ||
      !same(archived.result.protective, opening.protective) || archived.result.unifiedScore !== null ||
      archived.result.benchmarkVersion !== outcome.contract.benchmark_version || !completeNativeResult(archived.result, outcome.policy)) return null;

  const before = archived.result.measures;
  const after = outcome.result.measures;
  if (!before.every((measure) => after.some((value) => value.id === measure.id && value.scenario === measure.scenario &&
      value.native_unit === measure.native_unit && value.aggregation === measure.aggregation))) return null;
  const { score, regressions } = compareBenchmarkTimings(before, after);
  const gates = evaluateGates({ identity: outcome.contract, opening: before, closing: after });
  if (score === null || 'error' in gates || (outcome.result.unifiedScore !== null &&
      Math.abs(score - outcome.result.unifiedScore) > 8 * Number.EPSILON * score)) return null;
  return {
    gates,
    opening: recordedOpeningComparisonSchema.parse({
      opening_event_id: event.id, opening_event_sha256: event.hash, opening_artifact_sha256: opening.result_artifact.hash,
      opening_log_head_before: opening.log_head_before, unified_score: score,
      advisory_regressions: gates.run_verdict === 'valid' && !gates.equilibrium_blocked ? regressions : [],
    }),
  };
}
