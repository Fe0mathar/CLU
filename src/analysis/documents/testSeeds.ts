/**
 * CLUE test-seed generator.
 *
 * Spec: CLUE_implementation.md §21 (document bootstrap), §26 (proof contracts must be
 *       falsifiable before they are frozen), §71 (an inconclusive result is not a win).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.2, Part V Stage B.
 *
 * A test seed is the bridge from a documented claim to a future proof contract. It is
 * not a test, and it proves nothing. It records: this claim asserts something checkable,
 * this is the shape of instrument that could check it, and **this is the observation
 * that would refute it**.
 *
 * That last field is the whole point, and it is mandatory. CLUE's proof engine refuses
 * to freeze a contract that cannot be falsified, so a seed that cannot state its own
 * falsifier would produce a contract that can only ever succeed — the most expensive
 * kind of nothing a system like this can manufacture. When a falsifier cannot be
 * derived, the claim is **rejected with a recorded reason** rather than downgraded into
 * a vague seed. A visible count of rejections is information; a registry full of
 * unfalsifiable seeds is decoration.
 *
 * Generation is deterministic. The same claims always produce the same seeds, so the
 * set can be diffed across document revisions and a new seed genuinely means something
 * new was asserted.
 *
 * Integration mirrors the claim registry: call `ensureTestSeedSchema(db)` after
 * constructing the ProjectionStore and merge `TEST_SEED_PROJECTORS` into its projectors.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { canonicalJson, hashText, nowIso, type Sha256 } from '../../shared/ids.js';
import { parseOrThrow } from '../../shared/schemas.js';
import type { Projector, ProjectionStore } from '../../memory/db.js';
import type { EventLog } from '../../memory/eventLog.js';
import type { ClaimRecord } from './claimRegistry.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * What shape of guarantee the seed describes.
 *
 * The kind decides how the eventual contract is written: a guardrail is a thing that
 * must never be observed, a threshold is a number that must not be crossed, and a
 * structural seed is answered by the recognizer without running anything at all.
 */
export type SeedKind =
  | 'guardrail'
  | 'invariant'
  | 'threshold'
  | 'behaviour'
  | 'structural'
  | 'definition';

/** How the seed would actually be checked. `manualReview` is an honest answer. */
export type InstrumentKind =
  | 'staticAnalysis'
  | 'typecheck'
  | 'unitTest'
  | 'runtimeProbe'
  | 'performanceSeries'
  | 'manualReview';

/** Whether the instrument exists today, must be built, or cannot be automated. */
export type SeedReadiness = 'automatable' | 'needs-instrument' | 'manual-only';

export type Comparator = '<' | '<=' | '==' | '>=' | '>' | '!=';

export type RejectionReason =
  | 'not-normative'
  | 'plan-only'
  | 'no-subject'
  | 'unfalsifiable'
  | 'too-vague';

/* ------------------------------------------------------------------------- */
/* Records                                                                    */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/**
 * Seed identifiers are local to this registry rather than global entity IDs, on the
 * same reasoning as audit IDs: a seed is a working artifact, not an entity that
 * findings and contracts cite. A seed that survives into a contract is referenced by
 * the contract's own PROOF id.
 */
const seedIdSchema = z.string().regex(/^SEED-[0-9]{6,}$/);

export const seedMeasurementSchema = z
  .object({
    metric: z.string().min(1),
    comparator: z.enum(['<', '<=', '==', '>=', '>', '!=']),
    value: z.number(),
    unit: z.string().nullable(),
  })
  .strict();

export type SeedMeasurement = z.infer<typeof seedMeasurementSchema>;

export const testSeedSchema = z
  .object({
    id: seedIdSchema,
    /** Stable across regeneration: hash of the claim fingerprint and the seed kind. */
    signature: sha256,
    claim_id: z.string().min(1),
    claim_fingerprint: sha256,
    document_path: z.string().min(1),
    start_line: z.number().int().positive(),
    kind: z.enum(['guardrail', 'invariant', 'threshold', 'behaviour', 'structural', 'definition']),
    instrument: z.enum([
      'staticAnalysis',
      'typecheck',
      'unitTest',
      'runtimeProbe',
      'performanceSeries',
      'manualReview',
    ]),
    readiness: z.enum(['automatable', 'needs-instrument', 'manual-only']),
    subject: z.string().nullable(),
    /** What must hold, restated plainly. */
    statement: z.string().min(1),
    /** The observation that would refute it. Never empty — that is the invariant. */
    falsifier: z.string().min(1),
    measurement: seedMeasurementSchema.nullable(),
    guardrails: z.array(z.string()),
    domains: z.array(z.string()).min(1),
    /** Advisory seeds come from "should", not "must", and never become guardrails. */
    advisory: z.boolean(),
    confidence: z.number().min(0).max(1),
    notes: z.array(z.string()),
    generated_at: isoTime,
    /** Set when a seed is turned into a frozen proof contract in a later stage. */
    promoted_to: z.string().nullable(),
  })
  .strict();

export type TestSeed = z.infer<typeof testSeedSchema>;

export const seedRejectionSchema = z
  .object({
    claim_id: z.string().min(1),
    claim_fingerprint: sha256,
    reason: z.enum(['not-normative', 'plan-only', 'no-subject', 'unfalsifiable', 'too-vague']),
    detail: z.string().min(1),
    recorded_at: isoTime,
  })
  .strict();

export type SeedRejection = z.infer<typeof seedRejectionSchema>;

export interface GenerationResult {
  readonly seeds: readonly TestSeed[];
  readonly rejections: readonly SeedRejection[];
}

/* ------------------------------------------------------------------------- */
/* Events and schema                                                          */
/* ------------------------------------------------------------------------- */

export const SEED_EVENT_TYPES = {
  seedGenerated: 'seed.generated',
  seedRejected: 'seed.rejected',
  seedPromoted: 'seed.promoted',
} as const;

export const TEST_SEED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS test_seeds (
  id                TEXT PRIMARY KEY,
  signature         TEXT NOT NULL UNIQUE,
  claim_id          TEXT NOT NULL,
  claim_fingerprint TEXT NOT NULL,
  document_path     TEXT NOT NULL,
  start_line        INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  readiness         TEXT NOT NULL,
  subject           TEXT,
  statement         TEXT NOT NULL,
  falsifier         TEXT NOT NULL,
  measurement       TEXT,
  guardrails        TEXT NOT NULL,
  domains           TEXT NOT NULL,
  advisory          INTEGER NOT NULL,
  confidence        REAL NOT NULL,
  notes             TEXT NOT NULL,
  generated_at      TEXT NOT NULL,
  promoted_to       TEXT
);
CREATE INDEX IF NOT EXISTS test_seeds_kind      ON test_seeds(kind);
CREATE INDEX IF NOT EXISTS test_seeds_readiness ON test_seeds(readiness);
CREATE INDEX IF NOT EXISTS test_seeds_claim     ON test_seeds(claim_id);

CREATE TABLE IF NOT EXISTS seed_rejections (
  claim_id          TEXT PRIMARY KEY,
  claim_fingerprint TEXT NOT NULL,
  reason            TEXT NOT NULL,
  detail            TEXT NOT NULL,
  recorded_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seed_rejections_reason ON seed_rejections(reason);
`;

export function ensureTestSeedSchema(db: Db): void {
  db.exec(TEST_SEED_SCHEMA_SQL);
}

export const TEST_SEED_PROJECTORS: Readonly<Record<string, Projector>> = {
  [SEED_EVENT_TYPES.seedGenerated]: (db, record) => {
    const seed = parseOrThrow(testSeedSchema, record.payload, 'seed.generated');
    db.prepare(
      `INSERT INTO test_seeds (
         id, signature, claim_id, claim_fingerprint, document_path, start_line, kind,
         instrument, readiness, subject, statement, falsifier, measurement, guardrails,
         domains, advisory, confidence, notes, generated_at, promoted_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signature) DO UPDATE SET
         readiness = excluded.readiness,
         confidence = excluded.confidence,
         promoted_to = excluded.promoted_to`,
    ).run(
      seed.id,
      seed.signature,
      seed.claim_id,
      seed.claim_fingerprint,
      seed.document_path,
      seed.start_line,
      seed.kind,
      seed.instrument,
      seed.readiness,
      seed.subject,
      seed.statement,
      seed.falsifier,
      seed.measurement === null ? null : canonicalJson(seed.measurement),
      canonicalJson(seed.guardrails),
      canonicalJson(seed.domains),
      seed.advisory ? 1 : 0,
      seed.confidence,
      canonicalJson(seed.notes),
      seed.generated_at,
      seed.promoted_to,
    );
  },

  [SEED_EVENT_TYPES.seedRejected]: (db, record) => {
    const rejection = parseOrThrow(seedRejectionSchema, record.payload, 'seed.rejected');
    db.prepare(
      `INSERT INTO seed_rejections (claim_id, claim_fingerprint, reason, detail, recorded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(claim_id) DO UPDATE SET
         reason = excluded.reason, detail = excluded.detail, recorded_at = excluded.recorded_at`,
    ).run(
      rejection.claim_id,
      rejection.claim_fingerprint,
      rejection.reason,
      rejection.detail,
      rejection.recorded_at,
    );
  },

  [SEED_EVENT_TYPES.seedPromoted]: (db, record) => {
    const payload = record.payload;
    if (typeof payload !== 'object' || payload === null) return;
    const fields = payload as Record<string, unknown>;
    const seedId = fields['seed_id'];
    const contractId = fields['contract_id'];
    if (typeof seedId !== 'string' || typeof contractId !== 'string') return;
    db.prepare('UPDATE test_seeds SET promoted_to = ? WHERE id = ?').run(contractId, seedId);
  },
};

/* ------------------------------------------------------------------------- */
/* Generation                                                                 */
/* ------------------------------------------------------------------------- */

const COMPARATOR_PHRASES: readonly { pattern: RegExp; comparator: Comparator }[] = [
  { pattern: /\b(?:at most|no more than|not more than|up to|within|under|below|fewer than|less than)\b/i, comparator: '<=' },
  { pattern: /\b(?:at least|no less than|not less than|minimum of)\b/i, comparator: '>=' },
  { pattern: /\b(?:exactly|precisely|equal to)\b/i, comparator: '==' },
  { pattern: /\b(?:exceeds?|exceeding|above|over|greater than|more than)\b/i, comparator: '>' },
];

const PERFORMANCE_TERMS = /\b(?:ms|milliseconds?|fps|frame|latency|throughput|allocation|memory|budget|p9[59]|median)\b/i;
const RUNTIME_TERMS = /\b(?:runtime|browser|window\.|console|device|gpu|canvas|render(?:s|ed|ing)?|probe|session)\b/i;
const STRUCTURAL_TERMS = /\b(?:path|module|file|import|export|separate|merged?|directory|folder|identifier|naming|spelling)\b/i;
const TYPE_TERMS = /\b(?:typecheck|type-?check|compiles?|typescript|strict mode|type error)\b/i;
const IDENTIFIER_SHAPE = /[`][^`]*[`]|\b\w+\.(?:ts|tsx|js|wgsl|glb|ply|md)\b|\b\w+[A-Z]\w*\b|\b\w+_\w+\b/;

/**
 * Turns claims into seeds.
 *
 * Only normative and definitional claims are considered. Descriptions record what the
 * system is believed to do and are useful context, but a contract built on "the
 * renderer uses a modular architecture" cannot be failed by any observation, and a
 * contract that cannot be failed is not evidence.
 */
export function generateTestSeeds(
  claims: readonly ClaimRecord[],
  startSequence = 1,
): GenerationResult {
  const timestamp = nowIso();
  const seeds: TestSeed[] = [];
  const rejections: SeedRejection[] = [];
  const seen = new Set<string>();
  let sequence = startSequence;

  for (const claim of claims) {
    const rejection = screen(claim, timestamp);
    if (rejection !== null) {
      rejections.push(rejection);
      continue;
    }

    const kind = deriveKind(claim);
    const measurement = deriveMeasurement(claim);
    const falsifier = deriveFalsifier(claim, kind, measurement);

    if (falsifier === null) {
      rejections.push(
        makeRejection(
          claim,
          'unfalsifiable',
          'No observation could be stated that would refute this claim as written.',
          timestamp,
        ),
      );
      continue;
    }

    const signature = hashText(`${claim.fingerprint}\0${kind}`);
    if (seen.has(signature)) continue;
    seen.add(signature);

    const instrument = deriveInstrument(claim, kind, measurement);
    const advisory = claim.modality === 'recommendation';
    const notes: string[] = [];
    if (advisory) {
      notes.push('Derived from a recommendation, not a requirement. Must not become a guardrail.');
    }
    if (claim.status === 'declared') {
      notes.push('Claim is declared only; confirm against source before freezing a contract.');
    }
    if (instrument === 'manualReview') {
      notes.push('No automatable instrument identified. Requires a human judgement.');
    }

    seeds.push(
      parseOrThrow(
        testSeedSchema,
        {
          id: `SEED-${String(sequence).padStart(6, '0')}`,
          signature,
          claim_id: claim.id,
          claim_fingerprint: claim.fingerprint,
          document_path: claim.document_path,
          start_line: claim.start_line,
          kind,
          instrument,
          readiness: deriveReadiness(instrument),
          subject: claim.subject_key,
          statement: buildStatement(claim, kind),
          falsifier,
          measurement,
          guardrails: suggestGuardrails(claim, kind),
          domains: [...claim.domains],
          advisory,
          confidence: scoreConfidence(claim, measurement, instrument),
          notes,
          generated_at: timestamp,
          promoted_to: null,
        },
        `test seed for ${claim.id}`,
      ),
    );
    sequence += 1;
  }

  return { seeds, rejections };
}

/** Rejects claims that cannot become contracts, with the reason recorded. */
function screen(claim: ClaimRecord, timestamp: string): SeedRejection | null {
  if (claim.modality === 'plan') {
    return makeRejection(claim, 'plan-only', 'States an intention, not a current guarantee.', timestamp);
  }
  if (claim.modality === 'description') {
    return makeRejection(claim, 'not-normative', 'Descriptive statement with no asserted guarantee.', timestamp);
  }
  if (claim.subject_key === null) {
    return makeRejection(claim, 'no-subject', 'No identifiable subject to test against.', timestamp);
  }
  if (claim.strength < 0.35) {
    return makeRejection(claim, 'too-vague', `Triage strength ${claim.strength} is below the seed threshold.`, timestamp);
  }
  return null;
}

function makeRejection(
  claim: ClaimRecord,
  reason: RejectionReason,
  detail: string,
  timestamp: string,
): SeedRejection {
  return parseOrThrow(
    seedRejectionSchema,
    {
      claim_id: claim.id,
      claim_fingerprint: claim.fingerprint,
      reason,
      detail,
      recorded_at: timestamp,
    },
    `seed rejection for ${claim.id}`,
  );
}

function deriveKind(claim: ClaimRecord): SeedKind {
  if (claim.modality === 'definition') return 'definition';
  if (claim.modality === 'prohibition') return 'guardrail';
  if (claim.numbers.length > 0 && claim.measurable) return 'threshold';
  if (claim.modality === 'invariant') return 'invariant';
  if (STRUCTURAL_TERMS.test(claim.text) && !PERFORMANCE_TERMS.test(claim.text)) return 'structural';
  return 'behaviour';
}

/**
 * Extracts the numeric constraint, if there is one.
 *
 * Polarity is applied last and matters: "must not exceed 16 ms" is a prohibition on
 * exceeding, which is the constraint `<= 16 ms`. Reading the comparator without
 * inverting for the negation would produce a contract asserting the opposite of what
 * the document says.
 */
export function deriveMeasurement(claim: ClaimRecord): SeedMeasurement | null {
  const candidate = claim.numbers.find((number) => number.unit !== null) ?? claim.numbers[0];
  if (candidate === undefined) return null;

  const position = claim.text.indexOf(candidate.raw);
  const preceding = claim.text.slice(Math.max(0, position - 48), position < 0 ? 48 : position);

  let comparator: Comparator | null = null;
  for (const phrase of COMPARATOR_PHRASES) {
    if (phrase.pattern.test(preceding)) {
      comparator = phrase.comparator;
      break;
    }
  }
  if (comparator === null) return null;

  if (claim.polarity === 'negative') comparator = invert(comparator);

  return parseOrThrow(
    seedMeasurementSchema,
    {
      metric: claim.subject_key ?? 'value',
      comparator,
      value: candidate.value,
      unit: candidate.unit,
    },
    `measurement for ${claim.id}`,
  );
}

function invert(comparator: Comparator): Comparator {
  switch (comparator) {
    case '<':
      return '>=';
    case '<=':
      return '>';
    case '>':
      return '<=';
    case '>=':
      return '<';
    case '==':
      return '!=';
    default:
      return '==';
  }
}

/**
 * States the observation that would refute the claim.
 *
 * Returns null when no such observation can be phrased, which is a rejection rather
 * than a weak seed. A generic falsifier such as "the behaviour is wrong" reads like a
 * falsifier and functions as none.
 */
function deriveFalsifier(
  claim: ClaimRecord,
  kind: SeedKind,
  measurement: SeedMeasurement | null,
): string | null {
  const subject = claim.subject_key;
  if (subject === null) return null;

  switch (kind) {
    case 'threshold': {
      if (measurement === null) return null;
      const unit = measurement.unit === null ? '' : ` ${measurement.unit}`;
      return `A valid run in which ${measurement.metric} is ${describe(invert(measurement.comparator))} ${measurement.value}${unit}.`;
    }
    case 'guardrail':
      return `Any observation of ${subject} doing what this claim forbids, in a run that otherwise passes its validity gates.`;
    case 'invariant':
      return `Any observed state in which the stated property of ${subject} does not hold.`;
    case 'structural':
      return IDENTIFIER_SHAPE.test(claim.text)
        ? `Static analysis of the snapshot finds ${subject} not arranged as stated.`
        : null;
    case 'definition':
      return `${subject} is found to resolve to, or be used as, something other than this definition states.`;
    case 'behaviour':
      return measurement !== null || IDENTIFIER_SHAPE.test(claim.text)
        ? `A run in which ${subject} does not behave as stated, with the deviation captured by the instrument.`
        : null;
    default:
      return null;
  }
}

function describe(comparator: Comparator): string {
  switch (comparator) {
    case '<':
      return 'below';
    case '<=':
      return 'at or below';
    case '>':
      return 'above';
    case '>=':
      return 'at or above';
    case '==':
      return 'exactly';
    default:
      return 'other than';
  }
}

function deriveInstrument(
  claim: ClaimRecord,
  kind: SeedKind,
  measurement: SeedMeasurement | null,
): InstrumentKind {
  if (TYPE_TERMS.test(claim.text)) return 'typecheck';
  if (kind === 'structural' || kind === 'definition') return 'staticAnalysis';
  if (measurement !== null && PERFORMANCE_TERMS.test(claim.text)) return 'performanceSeries';
  if (PERFORMANCE_TERMS.test(claim.text)) return 'performanceSeries';
  if (RUNTIME_TERMS.test(claim.text)) return 'runtimeProbe';
  if (IDENTIFIER_SHAPE.test(claim.text)) return 'unitTest';
  return 'manualReview';
}

function deriveReadiness(instrument: InstrumentKind): SeedReadiness {
  switch (instrument) {
    case 'staticAnalysis':
    case 'typecheck':
    case 'unitTest':
      return 'automatable';
    case 'runtimeProbe':
    case 'performanceSeries':
      return 'needs-instrument';
    default:
      return 'manual-only';
  }
}

function buildStatement(claim: ClaimRecord, kind: SeedKind): string {
  const subject = claim.subject_key ?? 'the subject';
  const prefix =
    kind === 'guardrail'
      ? 'Must never hold'
      : kind === 'threshold'
        ? 'Must stay within'
        : kind === 'invariant'
          ? 'Must always hold'
          : kind === 'definition'
            ? 'Must match the stated definition'
            : 'Must hold';
  return `${prefix} for ${subject}: ${claim.raw_text}`;
}

/**
 * Adjacent properties that must not regress while the seed's own condition improves.
 *
 * A performance seed without a correctness guardrail is an invitation to buy speed by
 * breaking something, and the proof engine rejects an improvement whose guardrails were
 * never defined — so they are proposed here rather than left to be remembered later.
 */
function suggestGuardrails(claim: ClaimRecord, kind: SeedKind): string[] {
  const guardrails = new Set<string>();

  if (kind === 'threshold' || kind === 'behaviour') {
    guardrails.add('Typecheck remains clean at the patched snapshot.');
  }
  for (const domain of claim.domains) {
    switch (domain) {
      case 'rendering':
        guardrails.add('No new WebGPU validation errors during the run.');
        guardrails.add('Rendered output remains visually equivalent.');
        break;
      case 'gaussian':
        guardrails.add('Splat density and coverage are unchanged.');
        break;
      case 'npcAi':
        guardrails.add('Deterministic baseline behaviour still produces valid decisions.');
        break;
      case 'economy':
      case 'settlement':
        guardrails.add('No real settlement is attempted; mock adapter only.');
        break;
      case 'diagnostics':
        guardrails.add('Probe self-test passes before and after the measurement.');
        break;
      default:
        break;
    }
  }
  return [...guardrails];
}

function scoreConfidence(
  claim: ClaimRecord,
  measurement: SeedMeasurement | null,
  instrument: InstrumentKind,
): number {
  let score = claim.strength * 0.6;
  if (measurement !== null) score += 0.2;
  if (instrument !== 'manualReview') score += 0.15;
  if (claim.modality === 'recommendation') score -= 0.15;
  if (claim.status === 'source-confirmed' || claim.status === 'runtime-observed') score += 0.1;
  return Math.min(1, Math.max(0, Number(score.toFixed(3))));
}

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

export interface TestSeedRegistryDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly missionVersion: () => string;
}

export interface SeedFilter {
  readonly kind?: SeedKind;
  readonly readiness?: SeedReadiness;
  readonly instrument?: InstrumentKind;
  readonly includeAdvisory?: boolean;
  readonly minimumConfidence?: number;
  readonly onlyUnpromoted?: boolean;
  readonly limit?: number;
}

export class TestSeedRegistry {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly missionVersion: () => string;

  public constructor(deps: TestSeedRegistryDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.missionVersion = deps.missionVersion;
    ensureTestSeedSchema(this.projections.db);
  }

  /** Generates seeds for the supplied claims and records both seeds and rejections. */
  public generate(claims: readonly ClaimRecord[]): GenerationResult {
    const result = generateTestSeeds(claims, this.nextSequence());

    for (const seed of result.seeds) {
      this.append(SEED_EVENT_TYPES.seedGenerated, seed, seed.claim_id);
    }
    for (const rejection of result.rejections) {
      this.append(SEED_EVENT_TYPES.seedRejected, rejection, rejection.claim_id);
    }

    this.projections.sync(this.log);
    return result;
  }

  /** Records that a seed became a frozen proof contract. */
  public promote(seedId: string, contractId: string): void {
    this.append(SEED_EVENT_TYPES.seedPromoted, { seed_id: seedId, contract_id: contractId }, seedId);
    this.projections.sync(this.log);
  }

  public seeds(filter: SeedFilter = {}): TestSeed[] {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      parameters.push(filter.kind);
    }
    if (filter.readiness !== undefined) {
      conditions.push('readiness = ?');
      parameters.push(filter.readiness);
    }
    if (filter.instrument !== undefined) {
      conditions.push('instrument = ?');
      parameters.push(filter.instrument);
    }
    if (filter.includeAdvisory !== true) conditions.push('advisory = 0');
    if (filter.minimumConfidence !== undefined) {
      conditions.push('confidence >= ?');
      parameters.push(filter.minimumConfidence);
    }
    if (filter.onlyUnpromoted === true) conditions.push('promoted_to IS NULL');

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const limit = filter.limit === undefined ? '' : `LIMIT ${Math.max(1, filter.limit)}`;

    return this.projections.db
      .prepare(`SELECT * FROM test_seeds ${where} ORDER BY confidence DESC, id ${limit}`)
      .all(...parameters)
      .map(readSeedRow);
  }

  /** Rejections, grouped by reason. The shape of what the corpus could not promise. */
  public rejectionSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const row of this.projections.db
      .prepare('SELECT reason, COUNT(*) AS n FROM seed_rejections GROUP BY reason')
      .all()) {
      if (typeof row !== 'object' || row === null) continue;
      const fields = row as Record<string, unknown>;
      const reason = fields['reason'];
      const count = fields['n'];
      if (typeof reason === 'string' && typeof count === 'number') summary[reason] = count;
    }
    return summary;
  }

  private append(type: string, payload: unknown, subjectId: string | null): void {
    this.log.append({
      type,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId,
      payload,
    });
  }

  private nextSequence(): number {
    const row = this.projections.db.prepare('SELECT MAX(id) AS max_id FROM test_seeds').get();
    if (typeof row !== 'object' || row === null) return 1;
    const value = (row as Record<string, unknown>)['max_id'];
    if (typeof value !== 'string') return 1;
    const parsed = Number.parseInt(value.slice('SEED-'.length), 10);
    return Number.isSafeInteger(parsed) ? parsed + 1 : 1;
  }
}

/* ------------------------------------------------------------------------- */
/* Row reading                                                                */
/* ------------------------------------------------------------------------- */

function readSeedRow(row: unknown): TestSeed {
  if (typeof row !== 'object' || row === null) throw new Error('test_seeds row is not an object');
  const record = row as Record<string, unknown>;

  const measurement = record['measurement'];
  return parseOrThrow(
    testSeedSchema,
    {
      ...record,
      measurement: typeof measurement === 'string' ? (JSON.parse(measurement) as unknown) : null,
      guardrails: JSON.parse(readString(record, 'guardrails')) as unknown,
      domains: JSON.parse(readString(record, 'domains')) as unknown,
      notes: JSON.parse(readString(record, 'notes')) as unknown,
      advisory: record['advisory'] === 1,
    },
    'test_seeds row',
  );
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Expected string field "${field}"`);
  return value;
}

/** Convenience for callers that only need the signature scheme. */
export function seedSignature(claimFingerprint: Sha256, kind: SeedKind): Sha256 {
  return hashText(`${claimFingerprint}\0${kind}`);
}
