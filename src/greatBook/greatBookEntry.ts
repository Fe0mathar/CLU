/**
 * Durable Great Book entry — P2-12.
 *
 * The Great Book does not infer an improvement from dashboard state. One immutable entry
 * is derived while the ACCEPT verdict, frozen contract, baseline, candidate, patch and
 * native deltas are all present in the same writer transaction. The entry is embedded in
 * `proof.verdict_recorded`, so verdict authority and recursive-memory consequence cannot
 * diverge through a dual write.
 */

import { z } from 'zod';

import { clampNormalized } from '../analysis/metrics/improvementField/normalization.js';
import type { ChangeSetEntry } from '../experiment/proof/executionCoordinator.js';
import type { ProofContract } from '../proof/proofContract.js';
import type { DeterministicVerdict } from '../proof/verdict.js';
import { canonicalJson, hashText, type Sha256 } from '../shared/ids.js';
import {
  coordinateForMetric,
  type CanonicalMetricFamily,
} from '../shared/measurementCoordinates.js';
import {
  artifactRefSchema,
  sha256Schema,
  type ArtifactRef,
} from '../shared/schemas.js';
import { projectGovernanceBasisSchema } from '../shared/projectGovernanceBasis.js';

export const GREAT_BOOK_ENTRY_VERSION = 2 as const;
export const GREAT_BOOK_NORMALIZATION_VERSION = 'proof-delta-pct/v1' as const;
export const GREAT_BOOK_NORMALIZATION_HASH = hashText(
  canonicalJson({
    version: GREAT_BOOK_NORMALIZATION_VERSION,
    target_source: 'DeterministicVerdict.deltas[].delta_pct',
    target_direction: 'improvement-positive',
    target_clamp: [-100, 100],
    causal_attribution: 100,
    global_guardrail: 100,
    confidence: 'frozen contract mapping or deterministic 1',
    freshness_at_recording: 1,
  }),
);

const SYSTEM_COORDINATES = ['MI05', 'MJ06'] as const;
const isoTime = z.string().datetime({ offset: false });
const activeFamilySchema = z.enum([
  'TARGET_QUALITY',
  'EVIDENCE_ASSURANCE',
  'ACCEPTANCE_GATES',
  'CLUE_SELF',
]);

const changeSetEntrySchema = z
  .object({
    op: z.enum(['write', 'delete']),
    path: z.string().min(1),
    sha256: sha256Schema.nullable(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const greatBookContributionSchema = z
  .object({
    contribution_id: z.string().regex(/^GBIC-[0-9a-f]{24}$/),
    measurement_id: z.string().min(1),
    source_measure_id: z.string().min(1),
    grid_index: z.number().int().min(1).max(100),
    x: z.number().int().min(1).max(10),
    y: z.number().int().min(1).max(10),
    family: activeFamilySchema,
    scope_id: z.string().min(1),
    native: z
      .object({
        baseline: z.number().finite(),
        result: z.number().finite(),
        delta: z.number().finite(),
        unit: z.string().min(1),
        display: z.string().min(1),
      })
      .strict(),
    normalized_contribution: z.number().min(-100).max(100),
    confidence: z.number().min(0).max(1),
    freshness: z.number().min(0).max(1),
    coverage: z.number().min(0).max(1),
    certified: z.literal(true),
    invalidated: z.literal(false),
  })
  .strict();

export type GreatBookContribution = z.infer<typeof greatBookContributionSchema>;

const greatBookEntryContentSchema = z
  .object({
    entry_version: z.union([z.literal(1), z.literal(GREAT_BOOK_ENTRY_VERSION)]),
    target_id: z.string().min(1),
    project_basis: projectGovernanceBasisSchema.optional(),
    mission_version: z.string().min(1),
    cycle_id: z.string().min(1),
    hypothesis_id: z.string().min(1),
    causal_claim: z.string().min(10),
    target_units: z.array(z.string().min(1)).min(1),
    disposition: z.literal('ACCEPT'),
    improvement: z.literal(true),
    contract_hash: sha256Schema,
    baseline_digest: sha256Schema,
    candidate_digest: sha256Schema,
    baseline_snapshot_id: sha256Schema,
    candidate_snapshot_id: sha256Schema,
    patch_digest: sha256Schema,
    change_set: z.array(changeSetEntrySchema).min(1),
    normalization: z
      .object({
        version: z.literal(GREAT_BOOK_NORMALIZATION_VERSION),
        hash: z.literal(GREAT_BOOK_NORMALIZATION_HASH),
      })
      .strict(),
    benchmark_run_id: z.string().min(1).nullable(),
    artifacts: z
      .object({
        contract: artifactRefSchema,
        candidate_run: artifactRefSchema,
        verdict: artifactRefSchema,
      })
      .strict(),
    recorded_at: isoTime,
    contributions: z.array(greatBookContributionSchema).min(2),
  })
  .strict();

export type GreatBookEntryContent = z.infer<typeof greatBookEntryContentSchema>;

function contentHash(content: GreatBookEntryContent): Sha256 {
  return hashText(canonicalJson(content));
}

export const greatBookEntrySchema = greatBookEntryContentSchema
  .extend({
    entry_id: z.string().regex(/^GBI-[0-9a-f]{32}$/),
    entry_hash: sha256Schema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      (entry.entry_version === GREAT_BOOK_ENTRY_VERSION && entry.project_basis === undefined) ||
      (entry.entry_version === 1 && entry.project_basis !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project_basis'],
        message: 'Great Book entry v2 requires project_basis; legacy v1 must omit it',
      });
    }
    if (
      entry.project_basis !== undefined &&
      entry.target_id !== entry.project_basis.operationIdentity.projectId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_id'],
        message: 'Great Book target_id must equal project_basis.operationIdentity.projectId',
      });
    }
    const { entry_id: _entryId, entry_hash: _entryHash, ...content } = entry;
    const expectedHash = contentHash(content);
    if (entry.entry_hash !== expectedHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entry_hash'],
        message: `entry hash mismatch: expected ${expectedHash}, received ${entry.entry_hash}`,
      });
    }
    const expectedId = `GBI-${expectedHash.slice(0, 32)}`;
    if (entry.entry_id !== expectedId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entry_id'],
        message: `entry id mismatch: expected ${expectedId}, received ${entry.entry_id}`,
      });
    }

    const seen = new Set<string>();
    for (const [index, contribution] of entry.contributions.entries()) {
      const coordinate = coordinateForMetric(contribution.measurement_id);
      if (
        coordinate === null ||
        coordinate.family === 'RESERVED' ||
        coordinate.gridIndex !== contribution.grid_index ||
        coordinate.x !== contribution.x ||
        coordinate.y !== contribution.y ||
        coordinate.family !== contribution.family
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributions', index],
          message: `contribution does not match canonical coordinate ${contribution.measurement_id}`,
        });
      }
      const key = `${contribution.measurement_id}\u0000${contribution.scope_id}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributions', index],
          message: 'duplicate measurement/scope contribution in one Great Book entry',
        });
      }
      seen.add(key);
    }

    for (const systemCoordinate of SYSTEM_COORDINATES) {
      if (!entry.contributions.some((item) => item.measurement_id === systemCoordinate)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributions'],
          message: `missing mandatory system contribution ${systemCoordinate}`,
        });
      }
    }
  });

export type GreatBookEntry = z.infer<typeof greatBookEntrySchema>;

/** The explicit recording result embedded in every new proof verdict event. */
export const greatBookRecordingSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('recorded'), entry: greatBookEntrySchema }).strict(),
  z.object({ state: z.literal('not_recorded'), reason: z.string().min(1) }).strict(),
]);
export type GreatBookRecording = z.infer<typeof greatBookRecordingSchema>;

export interface BuildGreatBookEntryInput {
  readonly targetId: string;
  readonly missionVersion: string;
  readonly cycleId: string;
  readonly contract: ProofContract;
  readonly contractHash: Sha256;
  readonly verdict: DeterministicVerdict;
  readonly patchDigest: Sha256;
  readonly changeSet: readonly ChangeSetEntry[];
  readonly benchmarkRunId: string | null;
  readonly artifacts: {
    readonly contract: ArtifactRef;
    readonly candidate_run: ArtifactRef;
    readonly verdict: ArtifactRef;
  };
  readonly recordedAt: string;
}

export type BuildGreatBookEntryResult =
  | { readonly entry: GreatBookEntry; readonly reason: null }
  | { readonly entry: null; readonly reason: string };

interface FrozenMapping {
  readonly measurement_id: string;
  readonly source_measure_id: string;
  readonly scope_id: string;
  readonly confidence: number;
  readonly coverage: number;
}

function defaultScopeId(contract: ProofContract): string {
  if (contract.great_book !== undefined) return contract.great_book.scope_id;
  if (contract.hypothesis.target_units.length === 1) {
    return contract.hypothesis.target_units[0] as string;
  }
  return `MULTI-${hashText(canonicalJson([...contract.hypothesis.target_units].sort())).slice(0, 16)}`;
}

function mappingsOf(contract: ProofContract): readonly FrozenMapping[] {
  const scopeId = defaultScopeId(contract);
  if (contract.great_book !== undefined) {
    return contract.great_book.contributions.map((mapping) => ({
      measurement_id: mapping.measurement_id,
      source_measure_id: mapping.source_measure_id,
      scope_id: scopeId,
      confidence: mapping.confidence,
      coverage: mapping.coverage,
    }));
  }
  return contract.target_measurements.flatMap((measurement) => {
    const coordinate = coordinateForMetric(measurement.id);
    return coordinate === null || coordinate.family === 'RESERVED'
      ? []
      : [{
          measurement_id: measurement.id,
          source_measure_id: measurement.id,
          scope_id: scopeId,
          confidence: 1,
          coverage: 1,
        }];
  });
}

function contributionId(
  seed: Readonly<Record<string, unknown>>,
  measurementId: string,
  scopeId: string,
  sourceMeasureId: string,
): string {
  return `GBIC-${hashText(
    canonicalJson({ ...seed, measurement_id: measurementId, scope_id: scopeId, source_measure_id: sourceMeasureId }),
  ).slice(0, 24)}`;
}

function coordinateFields(measurementId: string): {
  readonly grid_index: number;
  readonly x: number;
  readonly y: number;
  readonly family: Exclude<CanonicalMetricFamily, 'RESERVED'>;
} {
  const coordinate = coordinateForMetric(measurementId);
  if (coordinate === null || coordinate.family === 'RESERVED') {
    throw new Error(`Great Book mapping ${measurementId} is not an active canonical coordinate.`);
  }
  return {
    grid_index: coordinate.gridIndex,
    x: coordinate.x,
    y: coordinate.y,
    family: coordinate.family as Exclude<CanonicalMetricFamily, 'RESERVED'>,
  };
}

/**
 * Builds the immutable record carried by an ACCEPT verdict.
 *
 * Every accepted proof receives two non-negotiable canonical facts: MI05 records that the
 * frozen causal claim survived the experiment, and MJ06 records that every mandatory gate
 * held. Contract mappings add target-specific native deltas. No model interprets the result
 * after observation, and no accepted proof can disappear merely because its native measure
 * ID is not itself a canonical catalogue coordinate.
 */
export function buildGreatBookEntry(input: BuildGreatBookEntryInput): BuildGreatBookEntryResult {
  if (input.verdict.disposition !== 'ACCEPT' || !input.verdict.improvement) {
    return { entry: null, reason: 'only an ACCEPT verdict with improvement=true enters the Great Book' };
  }
  if (input.contractHash !== input.verdict.identity.contract_hash) {
    throw new Error(
      `Great Book contract hashes disagree: frozen ${input.contractHash}, verdict ${input.verdict.identity.contract_hash}.`,
    );
  }
  if (
    canonicalJson(input.contract.project_basis ?? null) !==
    canonicalJson(input.verdict.identity.project_basis ?? null)
  ) {
    throw new Error('Great Book Project Profile basis disagrees between the frozen contract and verdict.');
  }
  if (
    input.contract.project_basis !== undefined &&
    input.targetId !== input.contract.project_basis.operationIdentity.projectId
  ) {
    throw new Error(
      `Great Book target ${input.targetId} disagrees with Project Profile ${input.contract.project_basis.operationIdentity.projectId}.`,
    );
  }
  if (input.verdict.thresholds?.success.met !== true) {
    throw new Error('An ACCEPT Great Book entry requires the success threshold to be met.');
  }
  const failedGates = input.verdict.gates.filter((gate) => gate.outcome !== 'pass');
  if (failedGates.length > 0) {
    throw new Error('An ACCEPT Great Book entry requires a passing guardrail set.');
  }

  const mappings = mappingsOf(input.contract);
  const targetMeasures = new Map(
    [...input.contract.target_measurements, ...input.contract.regression_measurements].map(
      (measurement) => [measurement.id, measurement],
    ),
  );
  const deltas = new Map(input.verdict.deltas.map((delta) => [delta.measure_id, delta]));
  const scopeDefault = defaultScopeId(input.contract);
  const identitySeed = {
    target_id: input.targetId,
    mission_version: input.missionVersion,
    cycle_id: input.cycleId,
    contract_hash: input.contractHash,
    candidate_digest: input.verdict.identity.candidate_digest,
    patch_digest: input.patchDigest,
    recorded_at: input.recordedAt,
  };

  const targetContributions: GreatBookContribution[] = mappings.map((mapping) => {
    if ((SYSTEM_COORDINATES as readonly string[]).includes(mapping.measurement_id)) {
      throw new Error(
        `Great Book coordinate ${mapping.measurement_id} is system-owned and cannot be remapped by a proof contract.`,
      );
    }
    const source = targetMeasures.get(mapping.source_measure_id);
    const delta = deltas.get(mapping.source_measure_id);
    if (source === undefined || delta === undefined) {
      throw new Error(
        `Great Book mapping ${mapping.measurement_id} references unavailable target delta ${mapping.source_measure_id}.`,
      );
    }
    return {
      contribution_id: contributionId(
        identitySeed,
        mapping.measurement_id,
        mapping.scope_id,
        mapping.source_measure_id,
      ),
      measurement_id: mapping.measurement_id,
      source_measure_id: mapping.source_measure_id,
      ...coordinateFields(mapping.measurement_id),
      scope_id: mapping.scope_id,
      native: {
        baseline: delta.baseline,
        result: delta.candidate,
        delta: delta.candidate - delta.baseline,
        unit: source.native_unit,
        display: `${delta.baseline} → ${delta.candidate} ${source.native_unit}`,
      },
      normalized_contribution: clampNormalized(delta.delta_pct),
      confidence: mapping.confidence,
      freshness: 1,
      coverage: mapping.coverage,
      certified: true,
      invalidated: false,
    };
  });

  const causalContribution: GreatBookContribution = {
    contribution_id: contributionId(identitySeed, 'MI05', scopeDefault, 'PROOF-CAUSAL-ATTRIBUTION'),
    measurement_id: 'MI05',
    source_measure_id: 'PROOF-CAUSAL-ATTRIBUTION',
    ...coordinateFields('MI05'),
    scope_id: scopeDefault,
    native: {
      baseline: 0,
      result: 1,
      delta: 1,
      unit: 'proof',
      display: 'causal claim accepted under the frozen proof contract',
    },
    normalized_contribution: 100,
    confidence: 1,
    freshness: 1,
    coverage: 1,
    certified: true,
    invalidated: false,
  };

  const passedGateCount = input.verdict.gates.filter((gate) => gate.outcome === 'pass').length;
  const totalGateCount = input.verdict.gates.length;
  const guardrailContribution: GreatBookContribution = {
    contribution_id: contributionId(identitySeed, 'MJ06', scopeDefault, 'PROOF-MANDATORY-GATES'),
    measurement_id: 'MJ06',
    source_measure_id: 'PROOF-MANDATORY-GATES',
    ...coordinateFields('MJ06'),
    scope_id: scopeDefault,
    native: {
      baseline: totalGateCount,
      result: passedGateCount,
      delta: passedGateCount - totalGateCount,
      unit: 'gates',
      display: `${passedGateCount} / ${totalGateCount} mandatory gates passed`,
    },
    normalized_contribution: 100,
    confidence: 1,
    freshness: 1,
    coverage: 1,
    certified: true,
    invalidated: false,
  };

  const content: GreatBookEntryContent = {
    entry_version: input.contract.project_basis === undefined ? 1 : GREAT_BOOK_ENTRY_VERSION,
    target_id: input.targetId,
    ...(input.contract.project_basis === undefined
      ? {}
      : { project_basis: projectGovernanceBasisSchema.parse(input.contract.project_basis) }),
    mission_version: input.missionVersion,
    cycle_id: input.cycleId,
    hypothesis_id: input.contract.hypothesis.id,
    causal_claim: input.contract.hypothesis.causal_claim,
    target_units: [...input.contract.hypothesis.target_units],
    disposition: 'ACCEPT',
    improvement: true,
    contract_hash: input.contractHash,
    baseline_digest: input.verdict.identity.baseline_digest,
    candidate_digest: input.verdict.identity.candidate_digest,
    baseline_snapshot_id: input.verdict.identity.baseline_snapshot,
    candidate_snapshot_id: input.verdict.identity.candidate_snapshot,
    patch_digest: input.patchDigest,
    change_set: [...input.changeSet],
    normalization: {
      version: GREAT_BOOK_NORMALIZATION_VERSION,
      hash: GREAT_BOOK_NORMALIZATION_HASH,
    },
    benchmark_run_id: input.benchmarkRunId,
    artifacts: input.artifacts,
    recorded_at: input.recordedAt,
    contributions: [...targetContributions, causalContribution, guardrailContribution],
  };
  const entryHash = contentHash(content);
  const entry: GreatBookEntry = {
    ...content,
    entry_id: `GBI-${entryHash.slice(0, 32)}`,
    entry_hash: entryHash,
  };
  return { entry: greatBookEntrySchema.parse(entry), reason: null };
}
