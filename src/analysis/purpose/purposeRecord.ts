/**
 * Purpose records — Purpose Recognition v1.
 *
 * Spec: CLUE_Recommended_Next_Milestone_v4.md §4 (Workstream C — the first operational Purpose
 *       Recognition layer, implemented *before* CLUE judges any imperfection). Doctrine: static
 *       structure can reveal suspicious code, but it cannot decide whether changing that code
 *       improves or destroys the program. A purpose record is what lets CLUE answer "what does
 *       this do, why does it exist, what must remain" before it is ever allowed to propose a
 *       change — the guard against metric gaming and mission drift.
 *
 * A {@link PurposeRecord} is a versioned, evidence-backed statement of a unit's purpose. It is
 * deliberately explicit about uncertainty: every record carries a status, a confidence, the
 * evidence it rests on (each item tagged with where it came from), and the questions that remain
 * open. A record that does not yet answer the questions a change would depend on is **not**
 * assessable, and {@link canBeAssessed} says so — a unit missing required purpose context must
 * not become a patch candidate.
 *
 * This module is the schema and its guards only. It performs no recognition and reads nothing;
 * the collector and the (later) purpose-inference workstream produce records, and this module
 * validates and reasons about them. It reuses the codebase's existing vocabulary rather than
 * inventing a parallel one: `confidence` is the same [0,1] measure the interface uses, and the
 * evidence-source ladder mirrors the hierarchy-provenance ladder (declared → confirmed →
 * derived → inferred → unknown) so purpose evidence and structural provenance speak the same
 * language.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * How well a unit's purpose is established. Distinct from a finding's {@link EvidenceState}
 * (which tracks a *finding's* lifecycle): this tracks a *purpose's* epistemic standing.
 *
 *   confirmed   — supported by declared or authoritative evidence (Creator, docs, tests)
 *   inferred    — derived from strong signals (types, callers, consumers) but not declared
 *   provisional — a working interpretation from weak signals (path, naming) only
 *   conflicted  — the evidence disagrees; the purpose cannot yet be stated with one voice
 *   unknown     — no sufficient evidence has been gathered
 */
export const purposeStatusSchema = z.enum([
  'confirmed',
  'inferred',
  'provisional',
  'conflicted',
  'unknown',
]);
export type PurposeStatus = z.infer<typeof purposeStatusSchema>;

/**
 * Where a piece of purpose evidence came from, strongest to weakest. Mirrors the Navigator's
 * hierarchy-provenance ladder so the two layers agree on what counts as declared vs inferred.
 */
export const purposeEvidenceSourceSchema = z.enum([
  'creator_declared',
  'document_declared',
  'test_confirmed',
  'type_derived',
  'caller_derived',
  'comment_stated',
  'config_declared',
  'runtime_observed',
  'path_inferred',
  'unknown',
]);
export type PurposeEvidenceSource = z.infer<typeof purposeEvidenceSourceSchema>;

/** Evidence-source values that denote inference rather than confirmed/declared support. */
const INFERRED_SOURCES: ReadonlySet<PurposeEvidenceSource> = new Set([
  'type_derived',
  'caller_derived',
  'comment_stated',
  'runtime_observed',
  'path_inferred',
  'unknown',
]);

/** Confidence in [0,1], the same measure the interface uses. */
export const purposeConfidenceSchema = z.number().min(0).max(1);

/* ------------------------------------------------------------------------- */
/* Record                                                                     */
/* ------------------------------------------------------------------------- */

/** One piece of evidence supporting (or contradicting) a purpose statement. */
export const purposeEvidenceSchema = z
  .object({
    source: purposeEvidenceSourceSchema,
    /** A concrete pointer: a document anchor, a file path, a test id, a caller logical id. */
    reference: z.string(),
    /** What this evidence establishes, in one line. */
    detail: z.string(),
    /** True when this evidence contradicts the stated purpose rather than supporting it. */
    contradicts: z.boolean().default(false),
  })
  .strict();
export type PurposeEvidence = z.infer<typeof purposeEvidenceSchema>;

/**
 * A versioned, evidence-backed statement of one unit's purpose (§4). `unitId` is the unit's
 * logical id (e.g. `src/render/ocean.ts#tick`). Arrays default to empty so a minimal record is
 * still valid, but an empty record is `unknown`/low-confidence and therefore not assessable.
 */
export const purposeRecordSchema = z
  .object({
    unitId: z.string().min(1),
    /** Monotonic version for this unit's purpose record; a re-derivation increments it. */
    version: z.number().int().positive(),
    /** One-sentence purpose statement. */
    statement: z.string(),
    /** What the unit does (behaviour). */
    does: z.string(),
    /** Why the unit exists (intent). */
    whyItExists: z.string(),
    /** Higher-level purpose ids this unit serves. */
    supportsPurposeIds: z.array(z.string()).default([]),
    inputs: z.array(z.string()).default([]),
    outputs: z.array(z.string()).default([]),
    sideEffects: z.array(z.string()).default([]),
    /** Logical ids of units/consumers that depend on this one. */
    consumers: z.array(z.string()).default([]),
    /** Behaviours that must remain true across any change (the change's hard constraints). */
    protectedInvariants: z.array(z.string()).default([]),
    /** Capabilities the unit requires to do its job. */
    requiredCapabilities: z.array(z.string()).default([]),
    evidence: z.array(purposeEvidenceSchema).default([]),
    confidence: purposeConfidenceSchema,
    status: purposeStatusSchema,
    /** Questions that remain open; a non-empty list means the purpose is not fully established. */
    unresolvedQuestions: z.array(z.string()).default([]),
  })
  .strict();
export type PurposeRecord = z.infer<typeof purposeRecordSchema>;

/** Parses and validates an unknown value as a {@link PurposeRecord}, throwing on any mismatch. */
export function parsePurposeRecord(input: unknown): PurposeRecord {
  return purposeRecordSchema.parse(input);
}

/* ------------------------------------------------------------------------- */
/* Reasoning                                                                  */
/* ------------------------------------------------------------------------- */

/** True when the record rests only on inferred/weak evidence (no declared or confirmed source). */
export function isInferredOnly(record: PurposeRecord): boolean {
  const supporting = record.evidence.filter((item) => !item.contradicts);
  if (supporting.length === 0) return true;
  return supporting.every((item) => INFERRED_SOURCES.has(item.source));
}

/** The minimum confidence a purpose must reach before a unit may be assessed for a change. */
export const ASSESSABLE_CONFIDENCE_FLOOR = 0.6;

/**
 * The reason a unit is not yet assessable, or null when it is. Assessment requires a purpose
 * that is (a) not `unknown` or `conflicted`, (b) confident enough, (c) free of open questions,
 * and (d) explicit about what must not break. This is the gate the milestone requires: a unit
 * missing required purpose context must not become a patch candidate.
 */
export function assessabilityBlocker(record: PurposeRecord): string | null {
  if (record.status === 'unknown') return 'purpose is unknown';
  if (record.status === 'conflicted') return 'purpose evidence is in conflict';
  if (record.confidence < ASSESSABLE_CONFIDENCE_FLOOR) {
    return `purpose confidence ${record.confidence.toFixed(2)} is below the assessment floor ${ASSESSABLE_CONFIDENCE_FLOOR.toFixed(2)}`;
  }
  if (record.unresolvedQuestions.length > 0) {
    return `${record.unresolvedQuestions.length} purpose question(s) remain unresolved`;
  }
  if (record.protectedInvariants.length === 0) {
    return 'no protected invariants recorded; a safe change cannot be bounded';
  }
  return null;
}

/** Whether a unit may be assessed for a change, given the current understanding of its purpose. */
export function canBeAssessed(record: PurposeRecord): boolean {
  return assessabilityBlocker(record) === null;
}
