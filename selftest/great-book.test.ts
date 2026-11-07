/**
 * DEV-P2-12 — accepted proof verdicts become immutable, replayable Great Book memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import {
  buildGreatBookEntry,
  greatBookEntrySchema,
  type GreatBookEntry,
} from '../src/greatBook/greatBookEntry.js';
import {
  GREAT_BOOK_PROJECTION,
  readGreatBookContributions,
  readGreatBookEntries,
  readGreatBookFacts,
} from '../src/greatBook/greatBookProjection.js';
import { PROOF_EVENT_TYPES, proofContractSchema, type ProofContract } from '../src/proof/proofContract.js';
import type { DeterministicVerdict } from '../src/proof/verdict.js';
import type { ArtifactRef } from '../src/shared/schemas.js';
import type { Sha256 } from '../src/shared/ids.js';
import { buildGreatBookImprovementField } from '../src/analysis/metrics/improvementField/projection.js';

const H = (value: string): Sha256 => value.repeat(64).slice(0, 64) as Sha256;
const AT = '2026-08-13T19:30:00.000Z';

function artifact(char: string, label: string): ArtifactRef {
  return {
    hash: H(char),
    bytes: 123,
    media_type: 'application/json; charset=utf-8',
    label,
    created_at: AT,
  };
}

function contract(over: Partial<ProofContract> = {}): ProofContract {
  return proofContractSchema.parse({
    contract_version: 1,
    mission_version: 'MISSION-000001',
    cycle_id: 'CYCLE-000001',
    snapshot_id: H('a'),
    hypothesis: {
      id: 'HYP-GB-000001',
      causal_claim: 'The candidate lowers fixture cost without reducing the protective guard.',
      target_units: ['src/cost.txt'],
    },
    baseline_state: 'the locked fixture baseline',
    candidate_state: 'the same fixture plus one sealed patch',
    representative_inputs: ['fixture input'],
    target_measurements: [
      { id: 'SIG-COST', native_unit: 'ms', direction: 'lower_is_better' },
    ],
    regression_measurements: [
      { id: 'SIG-GUARD', native_unit: 'count', direction: 'higher_is_better' },
    ],
    mandatory_gates: [{ kind: 'must_not_decrease', measure_id: 'SIG-GUARD' }],
    execution: { warmup_runs: 0, repetitions: 1, max_duration_seconds: 120, statistic: 'median' },
    invalid_run_rules: ['a failed instrument voids the run'],
    confounder_rules: [],
    required_instruments: ['benchmark:fixture-stick'],
    thresholds: {
      success: { measure_id: 'SIG-COST', kind: 'improve_pct_at_least', pct: 10 },
      non_inferiority: null,
      rejection: { measure_id: 'SIG-COST', kind: 'worsen_pct_at_least', pct: 5 },
    },
    environment_fingerprint: { node_version: process.version, platform: process.platform, arch: process.arch },
    rollback_conditions: ['the guard decreases after landing'],
    great_book: {
      scope_id: 'src/cost.txt',
      contributions: [
        { measurement_id: 'MD04', source_measure_id: 'SIG-COST', confidence: 0.95, coverage: 0.9 },
      ],
    },
    ...over,
  });
}

function verdict(over: Partial<DeterministicVerdict> = {}): DeterministicVerdict {
  return {
    disposition: 'ACCEPT',
    improvement: true,
    reasons: ['success threshold met; every mandatory gate held'],
    deltas: [
      { measure_id: 'SIG-COST', direction: 'lower_is_better', baseline: 100, candidate: 80, delta_pct: 20 },
      { measure_id: 'SIG-GUARD', direction: 'higher_is_better', baseline: 497, candidate: 497, delta_pct: 0 },
    ],
    gates: [
      {
        rule: { kind: 'must_not_decrease', measure_id: 'SIG-GUARD' },
        outcome: 'pass',
        detail: 'SIG-GUARD 497→497',
      },
    ],
    thresholds: {
      success: {
        rule: { measure_id: 'SIG-COST', kind: 'improve_pct_at_least', pct: 10 },
        met: true,
        detail: '20% vs 10%',
      },
      rejection: {
        rule: { measure_id: 'SIG-COST', kind: 'worsen_pct_at_least', pct: 5 },
        met: false,
        detail: '20% vs -5%',
      },
      non_inferiority: null,
    },
    identity: {
      contract_hash: H('b'),
      baseline_digest: H('c'),
      candidate_digest: H('d'),
      baseline_snapshot: H('a'),
      candidate_snapshot: H('e'),
    },
    ...over,
  };
}

function build(over: { contract?: ProofContract; verdict?: DeterministicVerdict } = {}) {
  return buildGreatBookEntry({
    targetId: 'clu',
    missionVersion: 'MISSION-000001',
    cycleId: 'CYCLE-000001',
    contract: over.contract ?? contract(),
    contractHash: H('b'),
    verdict: over.verdict ?? verdict(),
    patchDigest: H('f'),
    changeSet: [{ op: 'write', path: 'src/cost.txt', sha256: H('9'), bytes: 2 }],
    benchmarkRunId: 'EVENT-000010',
    artifacts: {
      contract: artifact('1', 'contract'),
      candidate_run: artifact('2', 'candidate'),
      verdict: artifact('3', 'verdict'),
    },
    recordedAt: AT,
  });
}

function stack(): {
  readonly root: string;
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'clue-great-book-'));
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'clue.db'), {
    modules: [GREAT_BOOK_PROJECTION],
  });
  const { log } = EventLog.open(join(root, 'events'));
  return {
    root,
    log,
    projections,
    close(): void {
      log.close();
      projections.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function appendVerdict(
  log: EventLog,
  entry: GreatBookEntry,
  overrides: Readonly<Record<string, unknown>> = {},
): void {
  log.append({
    type: PROOF_EVENT_TYPES.verdictRecorded,
    actor: 'cli',
    missionVersion: entry.mission_version,
    subjectId: entry.cycle_id,
    payload: {
      target_id: entry.target_id,
      cycle_id: entry.cycle_id,
      disposition: 'ACCEPT',
      improvement: true,
      contract_hash: entry.contract_hash,
      baseline_digest: entry.baseline_digest,
      candidate_digest: entry.candidate_digest,
      patch_digest: entry.patch_digest,
      great_book: { state: 'recorded', entry },
      ...overrides,
    },
  });
}

test('DEV-P2-12: ACCEPT seals generic and contract-bound coordinates into one content-addressed entry', () => {
  const first = build();
  assert.ok(first.entry !== null);
  if (first.entry === null) return;
  const second = build();
  assert.deepEqual(second, first, 'identical accepted evidence creates the identical immutable lesson');

  assert.match(first.entry.entry_id, /^GBI-[0-9a-f]{32}$/);
  assert.match(first.entry.entry_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    first.entry.contributions.map((item) => item.measurement_id),
    ['MD04', 'MI05', 'MJ06'],
    'one frozen target mapping plus the two deterministic generic facts',
  );
  assert.equal(first.entry.contributions.find((item) => item.measurement_id === 'MD04')?.confidence, 0.95);
  assert.equal(first.entry.contributions.find((item) => item.measurement_id === 'MD04')?.coverage, 0.9);
  assert.equal(first.entry.contributions.find((item) => item.measurement_id === 'MJ06')?.native.display, '1 / 1 mandatory gates passed');
  assert.equal(first.entry.causal_claim, contract().hypothesis.causal_claim);
  assert.deepEqual(first.entry.change_set, [{ op: 'write', path: 'src/cost.txt', sha256: H('9'), bytes: 2 }]);
  assert.doesNotThrow(() => greatBookEntrySchema.parse(first.entry));

  const moved = build({
    verdict: verdict({
      identity: { ...verdict().identity, candidate_digest: H('8') },
    }),
  });
  assert.ok(moved.entry !== null);
  assert.notEqual(moved.entry?.entry_id, first.entry.entry_id, 'a different candidate cannot inherit the lesson');
});

test('DEV-P2-12: rejected or internally contradictory outcomes cannot become Great Book memory', () => {
  const rejected = build({
    verdict: verdict({ disposition: 'REJECT', improvement: false }),
  });
  assert.equal(rejected.entry, null);
  assert.match(rejected.reason ?? '', /only an ACCEPT/);

  assert.throws(
    () => build({ verdict: verdict({ identity: { ...verdict().identity, contract_hash: H('0') } }) }),
    /contract hashes disagree/,
  );
  assert.throws(
    () => build({ verdict: verdict({ gates: [{ ...verdict().gates[0]!, outcome: 'fail' }] }) }),
    /passing guardrail set/,
  );
});

test('DEV-P2-12: the frozen mapping refuses unknown measures, reserved cells and duplicate coordinates', () => {
  const body = contract() as unknown as Record<string, unknown>;
  const base = body['great_book'] as { scope_id: string; contributions: unknown[] };

  assert.equal(
    proofContractSchema.safeParse({
      ...body,
      great_book: {
        ...base,
        contributions: [{ measurement_id: 'MD04', source_measure_id: 'NOPE', confidence: 1, coverage: 1 }],
      },
    }).success,
    false,
  );
  assert.equal(
    proofContractSchema.safeParse({
      ...body,
      great_book: {
        ...base,
        contributions: [{ measurement_id: 'MZ99', source_measure_id: 'SIG-COST', confidence: 1, coverage: 1 }],
      },
    }).success,
    false,
  );
  assert.equal(
    proofContractSchema.safeParse({
      ...body,
      great_book: {
        ...base,
        contributions: [
          { measurement_id: 'MD04', source_measure_id: 'SIG-COST', confidence: 1, coverage: 1 },
          { measurement_id: 'MD04', source_measure_id: 'SIG-GUARD', confidence: 1, coverage: 1 },
        ],
      },
    }).success,
    false,
  );
});

test('DEV-P2-12: the event projection replays the exact entry and feeds the 10×10 field', () => {
  const s = stack();
  try {
    const built = build();
    assert.ok(built.entry !== null);
    if (built.entry === null) return;
    appendVerdict(s.log, built.entry);
    s.projections.sync(s.log);

    const entries = readGreatBookEntries(s.projections, 'clu');
    assert.deepEqual(entries, [built.entry]);
    const facts = readGreatBookFacts(s.projections, 'clu');
    assert.equal(facts.entryCount, 1);
    assert.equal(facts.contributionCount, 3);
    assert.equal(facts.latestEntry?.entryId, built.entry.entry_id);

    const contributions = readGreatBookContributions(s.projections, 'clu');
    const field = buildGreatBookImprovementField({
      capturedAt: AT,
      targetId: 'clu',
      cycleId: built.entry.cycle_id,
      catalogueVersion: '6.0',
      catalogueHash: H('7'),
      normalizationVersion: facts.normalizationVersion,
      normalizationHash: facts.normalizationHash,
      aggregationMode: 'CURRENT_CERTIFIED',
      selectedMeasurementId: null,
      contributions,
    });
    assert.equal(field.grid.activeCells, 3);
    assert.equal(field.cells.find((cell) => cell.measurementId === 'MD04')?.state, 'available');
    assert.equal(field.cells.find((cell) => cell.measurementId === 'MI05')?.segments[0]?.greatBookEntryId, built.entry.entry_id);
    assert.deepEqual(field.warnings, []);

    const before = JSON.stringify(entries);
    s.projections.db.prepare("UPDATE great_book_entries SET entry_json = replace(entry_json, '80', '81')").run();
    assert.throws(() => readGreatBookEntries(s.projections, 'clu'), /entry hash mismatch/);

    s.projections.rebuild(s.log);
    assert.equal(JSON.stringify(readGreatBookEntries(s.projections, 'clu')), before, 'replay removes DB tampering exactly');
  } finally {
    s.close();
  }
});

test('DEV-P2-12: a Great Book/parity contradiction rolls back the projection instead of half-recording', () => {
  const s = stack();
  try {
    const built = build();
    assert.ok(built.entry !== null);
    if (built.entry === null) return;
    appendVerdict(s.log, built.entry, { candidate_digest: H('0') });
    assert.throws(() => s.projections.sync(s.log), /candidate_digest does not match/);
    assert.equal(readGreatBookFacts(s.projections, 'clu').entryCount, 0);
    assert.equal(s.projections.status().lastSequence, null, 'the transaction did not advance the projected head');
  } finally {
    s.close();
  }
});

test('DEV-P2-12: connected-but-empty Great Book is stated as empty, not unimplemented', () => {
  const field = buildGreatBookImprovementField({
    capturedAt: AT,
    targetId: 'clu',
    cycleId: null,
    catalogueVersion: '6.0',
    catalogueHash: H('7'),
    normalizationVersion: 'proof-verdict/v1',
    normalizationHash: H('6'),
    aggregationMode: 'CURRENT_CERTIFIED',
    selectedMeasurementId: null,
    contributions: [],
  });
  assert.equal(field.grid.activeCells, 0);
  assert.deepEqual(field.warnings, ['Great Book is connected; no accepted proof verdict has been recorded yet.']);
  assert.equal(field.targetId, 'clu');
});

test('DEV-P2-12: an accepted verdict without a canonical recording is a visible gap, never silent absence', () => {
  const s = stack();
  try {
    s.log.append({
      type: PROOF_EVENT_TYPES.verdictRecorded,
      actor: 'cli',
      missionVersion: 'MISSION-000001',
      subjectId: 'CYCLE-000001',
      payload: {
        target_id: 'clu',
        cycle_id: 'CYCLE-000001',
        disposition: 'ACCEPT',
        improvement: true,
        contract_hash: H('b'),
        baseline_digest: H('c'),
        candidate_digest: H('d'),
        patch_digest: H('f'),
        great_book: {
          state: 'not_recorded',
          reason: 'fixture: frozen contract carried no valid canonical mapping',
        },
      },
    });
    s.projections.sync(s.log);

    const facts = readGreatBookFacts(s.projections, 'clu');
    assert.equal(facts.entryCount, 0);
    assert.equal(facts.contributionCount, 0);
    assert.equal(facts.recordingGapCount, 1);
    assert.equal(facts.latestEntry, null);

    s.projections.rebuild(s.log);
    assert.equal(readGreatBookFacts(s.projections, 'clu').recordingGapCount, 1, 'gap survives replay');
  } finally {
    s.close();
  }
});


test('DEV-P2-12: shipped JSON schemas agree with the live v6/100-cell field contract', () => {
  const contribution = JSON.parse(
    readFileSync(join(process.cwd(), 'schemas', 'great-book-field-contribution.schema.json'), 'utf8'),
  ) as {
    additionalProperties?: unknown;
    required?: unknown[];
    properties?: { family?: { enum?: string[] }; contributionId?: { pattern?: string } };
  };
  assert.equal(contribution.additionalProperties, false);
  assert.deepEqual(contribution.properties?.family?.enum, [
    'TARGET_QUALITY',
    'EVIDENCE_ASSURANCE',
    'ACCEPTANCE_GATES',
    'CLUE_SELF',
  ]);
  assert.equal(contribution.properties?.contributionId?.pattern, '^GBIC-[0-9a-f]{24}$');
  assert.ok(contribution.required?.includes('greatBookEntryId'));
  assert.ok(contribution.required?.includes('recordedAt'));

  const projection = JSON.parse(
    readFileSync(join(process.cwd(), 'schemas', 'great-book-field-projection.schema.json'), 'utf8'),
  ) as {
    additionalProperties?: unknown;
    properties?: {
      grid?: { properties?: { activeCells?: { maximum?: number }; reservedCells?: { maximum?: number } } };
      cells?: { minItems?: number; maxItems?: number };
    };
  };
  assert.equal(projection.additionalProperties, false);
  assert.equal(projection.properties?.grid?.properties?.activeCells?.maximum, 100);
  assert.equal(projection.properties?.grid?.properties?.reservedCells?.maximum, 100);
  assert.equal(projection.properties?.cells?.minItems, 100);
  assert.equal(projection.properties?.cells?.maxItems, 100);
});
