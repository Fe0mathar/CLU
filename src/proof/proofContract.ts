/**
 * The Proof Contract — frozen before any result exists (DEV-P2-11, Stage H core).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §10 (the contract's field list, reproduced here one
 *       for one), §11 (what a baseline must match), §15.2 ("commit creation does not
 *       retroactively prove the candidate" — nothing downstream may alter what was
 *       frozen); `config.proof.*` in `schemas.ts`, whose two literals are law
 *       (`require_frozen_contract: true`, `inconclusive_counts_as_improvement: false`).
 *
 * ## Placement, stated
 *
 * The continuation brief assigns Stage H core to `src/proof/`; the Directory's current
 * tree shows proof concerns under the analysis and experiment planes (§11.5, §16). The
 * brief's decided shape governs — the ADR-0003 precedent: practice first, the Directory
 * amended in the next governed batch. Execution against a shadow tree will live where
 * §16 puts it (`experiment/proof/executionCoordinator.ts`); *this* module owns only the
 * contract itself: its grammar, its freeze, and its verification.
 *
 * ## Why thresholds and gates are machine rules, not prose
 *
 * §10 requires "success, non-inferiority, and rejection thresholds" and "mandatory
 * gates". A verdict must be computable from the frozen text alone — a threshold that
 * needs interpretation at verdict time is a threshold that can be argued after the
 * result is known, which is exactly the retroactivity §15.2 forbids. So thresholds and
 * guardrails here are small typed rules over named measures (the same rule kinds the
 * Master Benchmark's §7 gates proved out), and the *reviewed prose* — the causal claim,
 * invalid-run rules, confounder rules, rollback conditions — stays prose, because those
 * are for the assessing intelligence (§14) and the operator, not for arithmetic.
 *
 * ## The freeze ceremony
 *
 * §10, last paragraph: "The proof plan is validated against available execution
 * capabilities before patching begins. An AI-authored instrument has no authority until
 * this validation and freeze complete." Made executable: {@link freezeProofContract} is
 * the **single gate** — it parses strictly, enforces the proof policy, validates every
 * required instrument against the declared capabilities, and only then produces the
 * frozen record whose `contract_hash` is the canonical-JSON sha256 of the contract.
 * There is no other way to obtain a `FrozenProofContract`, so possession of one *is*
 * the evidence that validation happened. {@link verifyFrozenContract} recomputes the
 * hash so any later reader — the runner, the verdict, the Custodian — can refuse a
 * contract whose text moved after its result was born.
 */

import { z } from 'zod';

import { canonicalJson, hashText, nowIso, type Sha256 } from '../shared/ids.js';
import { coordinateForMetric } from '../shared/measurementCoordinates.js';
import {
  projectGovernanceBasisSchema,
  type ProjectGovernanceBasis,
} from '../shared/projectGovernanceBasis.js';

/** The proof domain's durable vocabulary — its own namespace, per the epoch/cycle precedent. */
export const PROOF_EVENT_TYPES = {
  contractFrozen: 'proof.contract_frozen',
  baselineBound: 'proof.baseline_bound',
  executionRefused: 'proof.execution_refused',
  verdictRecorded: 'proof.verdict_recorded',
} as const;
import {
  entityIdSchema,
  proofConfigSchema,
  sha256Schema,
} from '../shared/schemas.js';

/** The proof policy slice, as the config schema defines it — the two literals are law. */
export type ProofPolicy = z.infer<typeof proofConfigSchema>;

/* ------------------------------------------------------------------------- */
/* Rule vocabularies — small on purpose                                       */
/* ------------------------------------------------------------------------- */

/** A measure this contract will read, with the direction that makes "better" computable. */
export const measurementRefSchema = z
  .object({
    id: z.string().min(1),
    native_unit: z.string().min(1),
    direction: z.enum(['lower_is_better', 'higher_is_better']),
    /** A deterministic observation must agree across every repetition. Others use execution.statistic. */
    aggregation: z.literal('exact').optional(),
  })
  .strict();

/**
 * A guardrail over a named measure — §10's "mandatory gates", the same rule kinds §7 of
 * the Master Benchmark proved out. `must_not_regress_pct` reads against the measure's
 * declared direction, so one rule kind serves both timing-like and count-like measures.
 */
export const guardrailRuleSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('must_not_decrease'), measure_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('must_not_increase'), measure_id: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal('must_not_regress_pct'),
        measure_id: z.string().min(1),
        pct: z.number().positive().finite(),
      })
      .strict(),
  ]);

/**
 * A threshold over a target measure. `improve_pct_at_least` decides success;
 * `worsen_pct_at_least` decides rejection; `not_worse_pct` states non-inferiority.
 * Everything between success and rejection is *inconclusive*, and the config literal
 * already forbids counting that as improvement.
 */
export const thresholdRuleSchema = z
  .object({
    measure_id: z.string().min(1),
    kind: z.enum(['improve_pct_at_least', 'worsen_pct_at_least', 'not_worse_pct']),
    pct: z.number().nonnegative().finite(),
  })
  .strict();

/**
 * Optional, pre-result mapping from native proof measures to canonical Great Book cells.
 * P2-12 always records generic causal-attribution (MI05) and global-guardrail (MJ06)
 * contributions; this block adds target-specific coordinates without asking a post-result model to reinterpret
 * what the accepted experiment meant. Confidence and coverage are frozen inputs, not values
 * inferred after seeing the candidate.
 */
export const greatBookBindingSchema = z
  .object({
    scope_id: z.string().min(1),
    contributions: z
      .array(
        z
          .object({
            measurement_id: z.string().min(1),
            source_measure_id: z.string().min(1),
            confidence: z.number().finite().min(0).max(1),
            coverage: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

/* ------------------------------------------------------------------------- */
/* The contract — §10's list, one field per line item                          */
/* ------------------------------------------------------------------------- */

export const proofContractSchema = z
  .object({
    /** Grammar version of this record shape, so a future field change is a visible event. */
    contract_version: z.union([z.literal(1), z.literal(2)]),

    /* Binding — whose proof this is (§11 identity, §15.1 seal inputs). */
    mission_version: z.string().min(1),
    cycle_id: entityIdSchema,
    /** The baseline tree's content identity — the Git Base Pin's stand-in until the governed Git lifecycle (P4). */
    snapshot_id: sha256Schema,
    /** Required by contract v2 for a Project Profile-bound proof; absent only in legacy v1 history. */
    project_basis: projectGovernanceBasisSchema.optional(),

    /* §10: causal claim. */
    hypothesis: z
      .object({
        id: z.string().min(1),
        causal_claim: z.string().min(10),
        target_units: z.array(z.string().min(1)).min(1),
      })
      .strict(),

    /* §10: baseline and candidate state. The candidate is described, never hashed —
     * the freeze precedes the patch (§12 comes after §10), and pretending otherwise
     * would let a result pick its own contract. */
    baseline_state: z.string().min(1),
    candidate_state: z.string().min(1),

    /* §10: representative inputs. */
    representative_inputs: z.array(z.string().min(1)).min(1),

    /* §10: target and affected-scope regression measurements. */
    target_measurements: z.array(measurementRefSchema).min(1),
    regression_measurements: z.array(measurementRefSchema),

    /* §10: mandatory gates. Emptiness is judged by policy at freeze, not by the schema —
     * the schema states shape, the policy states requiredness. */
    mandatory_gates: z.array(guardrailRuleSchema),

    /* §10: warm-up, repetitions, duration, and statistics. */
    execution: z
      .object({
        warmup_runs: z.number().int().min(0),
        repetitions: z.number().int().min(1),
        max_duration_seconds: z.number().int().min(1),
        statistic: z.enum(['median', 'mean', 'min']),
      })
      .strict(),

    /* §10: invalid-run and confounder rules — reviewed prose for §14's assessment. */
    invalid_run_rules: z.array(z.string().min(1)).min(1),
    confounder_rules: z.array(z.string().min(1)),

    /* §10: required instruments — validated against capabilities at freeze. */
    required_instruments: z.array(z.string().min(1)).min(1),

    /* §10: success, non-inferiority, and rejection thresholds. */
    thresholds: z
      .object({
        success: thresholdRuleSchema,
        non_inferiority: thresholdRuleSchema.nullable(),
        rejection: thresholdRuleSchema,
      })
      .strict(),

    /* §10: environment fingerprint — the lock's own triple. */
    environment_fingerprint: z
      .object({ node_version: z.string().min(1), platform: z.string().min(1), arch: z.string().min(1) })
      .strict(),

    /* §10: rollback conditions. */
    rollback_conditions: z.array(z.string().min(1)).min(1),

    /* P2-12: optional frozen mapping into the canonical Great Book grid. */
    great_book: greatBookBindingSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.contract_version === 2
        ? value.project_basis !== undefined
        : value.project_basis === undefined,
    {
      message: 'contract_version 2 requires project_basis; legacy version 1 must not reinterpret one',
    },
  )
  .refine((value) => value.thresholds.success.kind === 'improve_pct_at_least', {
    message: 'the success threshold must be an improve_pct_at_least rule — success is an improvement claim',
  })
  .refine((value) => value.thresholds.rejection.kind === 'worsen_pct_at_least', {
    message: 'the rejection threshold must be a worsen_pct_at_least rule — rejection is a regression claim',
  })
  .refine(
    (value) => {
      const targets = new Set(value.target_measurements.map((measure) => measure.id));
      return targets.has(value.thresholds.success.measure_id) && targets.has(value.thresholds.rejection.measure_id);
    },
    { message: 'success and rejection thresholds must name declared target measurements' },
  )
  .refine(
    (value) => {
      const known = new Set(
        [...value.target_measurements, ...value.regression_measurements].map((measure) => measure.id),
      );
      return value.mandatory_gates.every((gate) => known.has(gate.measure_id));
    },
    { message: 'every mandatory gate must name a declared target or regression measurement' },
  )
  .superRefine((value, context) => {
    const known = new Set<string>();
    for (const field of ['target_measurements', 'regression_measurements'] as const) {
      for (const [index, measure] of value[field].entries()) {
        if (known.has(measure.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index, 'id'],
            message: `measurement ${measure.id} is declared more than once`,
          });
        }
        known.add(measure.id);
      }
    }
    const nonInferiority = value.thresholds.non_inferiority;
    if (nonInferiority !== null &&
        (nonInferiority.kind !== 'not_worse_pct' || !known.has(nonInferiority.measure_id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholds', 'non_inferiority'],
        message: 'non-inferiority must use not_worse_pct on a declared target or regression measurement',
      });
    }
    if (value.great_book === undefined) return;
    const coordinates = new Set<string>();
    for (const [index, binding] of value.great_book.contributions.entries()) {
      const coordinate = coordinateForMetric(binding.measurement_id);
      if (coordinate === null || coordinate.family === 'RESERVED') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['great_book', 'contributions', index, 'measurement_id'],
          message: 'must name an active canonical Great Book coordinate',
        });
      }
      if (binding.measurement_id === 'MI05' || binding.measurement_id === 'MJ06') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['great_book', 'contributions', index, 'measurement_id'],
          message: 'MI05 and MJ06 are system-owned Great Book coordinates and cannot be remapped',
        });
      }
      if (!known.has(binding.source_measure_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['great_book', 'contributions', index, 'source_measure_id'],
          message: 'must name a declared target or regression measurement',
        });
      }
      if (coordinates.has(binding.measurement_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['great_book', 'contributions', index, 'measurement_id'],
          message: `duplicate canonical coordinate ${binding.measurement_id}`,
        });
      }
      coordinates.add(binding.measurement_id);
    }
  });

export type ProofContract = z.infer<typeof proofContractSchema>;
export type GuardrailRule = z.infer<typeof guardrailRuleSchema>;
export type ThresholdRule = z.infer<typeof thresholdRuleSchema>;

/* ------------------------------------------------------------------------- */
/* Freeze                                                                     */
/* ------------------------------------------------------------------------- */

/** The only shape with authority: a contract plus the hash that pins its exact text. */
export interface FrozenProofContract {
  readonly contract: ProofContract;
  readonly contract_hash: Sha256;
  readonly frozen_at: string;
}

/** The canonical identity of a contract's text — key order cannot move it. */
export function proofContractHash(contract: ProofContract): Sha256 {
  return hashText(canonicalJson(contract));
}

export interface FreezeInput {
  readonly contract: unknown;
  readonly policy: ProofPolicy;
  /** What the installation can actually execute — instrument names the runner honours. */
  readonly capabilities: readonly string[];
  /** Current runtime identity; when supplied, only a matching v2 contract can freeze. */
  readonly expectedProjectBasis?: ProjectGovernanceBasis;
}

/**
 * The single gate that produces authority (§10, last paragraph).
 *
 * Refusals come back as a named list, never a throw — a contract that cannot freeze is
 * an outcome the caller records, and every reason is stated at once rather than
 * one-per-attempt. Policy first (the config literals are law), capabilities second
 * (declaring an instrument nobody has is a plan that cannot run), and only a contract
 * clean on both earns a hash.
 */
export function freezeProofContract(
  input: FreezeInput,
): FrozenProofContract | { readonly refusals: readonly string[] } {
  const parsed = proofContractSchema.safeParse(input.contract);
  if (!parsed.success) {
    return {
      refusals: parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const contract = parsed.data;
  const refusals: string[] = [];

  if (input.expectedProjectBasis !== undefined) {
    if (contract.project_basis === undefined) {
      refusals.push('a Project Profile-bound proof requires contract_version 2 and exact project_basis');
    } else if (
      canonicalJson(projectGovernanceBasisSchema.parse(contract.project_basis)) !==
      canonicalJson(projectGovernanceBasisSchema.parse(input.expectedProjectBasis))
    ) {
      refusals.push('the proof contract project_basis does not match the active Project Profile generation');
    }
  }

  if (input.policy.require_guardrails && contract.mandatory_gates.length === 0) {
    refusals.push(
      'proof.require_guardrails is in force and the contract declares no mandatory gates — ' +
        'a proof that protects nothing proves nothing',
    );
  }
  if (input.policy.require_baseline && contract.baseline_state.trim().length < 8) {
    refusals.push(
      'proof.require_baseline is in force and baseline_state does not describe a reusable ' +
        'baseline identity (§11: exact identity, not narrative)',
    );
  }

  const available = new Set(input.capabilities);
  for (const instrument of contract.required_instruments) {
    if (!available.has(instrument)) {
      refusals.push(
        `required instrument ${JSON.stringify(instrument)} is not among the declared execution ` +
          `capabilities [${[...available].sort().join(', ')}] — §10: no authority before capability validation`,
      );
    }
  }

  if (refusals.length > 0) return { refusals };
  return { contract, contract_hash: proofContractHash(contract), frozen_at: nowIso() };
}

/**
 * Recomputes the hash so any later reader can refuse a moved contract.
 *
 * The refusal names both hashes: the frozen one is what the result claimed to be
 * measured against, the recomputed one is what the text now says — and a disagreement
 * between them is §15.2's forbidden retroactivity caught in the act.
 */
export function verifyFrozenContract(
  contract: ProofContract,
  expectedHash: Sha256,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return {
      ok: false,
      reason:
        'the claimed contract hash is not a sha256 — a result citing no real freeze cites nothing ' +
        `(got ${JSON.stringify(String(expectedHash)).slice(0, 40)})`,
    };
  }
  const actual = proofContractHash(contract);
  if (actual !== expectedHash) {
    return {
      ok: false,
      reason:
        `the contract's text no longer matches its freeze — frozen ${expectedHash.slice(0, 12)}…, ` +
        `recomputed ${actual.slice(0, 12)}…; a result may only cite the exact contract that predates it`,
    };
  }
  return { ok: true };
}
