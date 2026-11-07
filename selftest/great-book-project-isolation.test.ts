/** PP-16 — Great Book entries carry and enforce the exact Project Profile basis. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  readGreatBookEntries,
} from '../src/greatBook/greatBookProjection.js';
import { proofContractHash, proofContractSchema, type ProofContract } from '../src/proof/proofContract.js';
import type { DeterministicVerdict } from '../src/proof/verdict.js';
import { inspectProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import { resolveProjectBenchmarkRuntime } from '../src/control/projectProfiles/benchmarkRuntime.js';
import { projectGovernanceBasisFromState } from '../src/control/projectProfiles/projectGovernanceBasis.js';
import type { ProjectGovernanceBasis } from '../src/shared/projectGovernanceBasis.js';
import type { ArtifactRef } from '../src/shared/schemas.js';
import type { Sha256 } from '../src/shared/ids.js';
import {
  makeProjectProfileFixture,
  makeSiblingProjectProfile,
} from './project-profile-fixture.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';

const H = (char: string): Sha256 => char.repeat(64).slice(0, 64) as Sha256;
const AT = '2026-08-14T15:00:00.000Z';

function basisFor(
  fixture: ReturnType<typeof makeProjectProfileFixture>,
  profile: Parameters<typeof recordForProfile>[1],
  storeName: string,
): ProjectGovernanceBasis {
  const record = recordForProfile(fixture, profile, storeName);
  const authority = inspectProjectAuthority(record);
  const benchmarkRuntime = resolveProjectBenchmarkRuntime(record, authority.manifest);
  const basis = projectGovernanceBasisFromState({ record, authority, benchmarkRuntime });
  if (basis === null) throw new Error('fixture did not produce a governance basis');
  return basis;
}

function contract(projectBasis: ProjectGovernanceBasis): ProofContract {
  return proofContractSchema.parse({
    contract_version: 2,
    mission_version: 'MISSION-000001',
    cycle_id: 'CYCLE-000001',
    snapshot_id: H('a'),
    project_basis: projectBasis,
    hypothesis: {
      id: 'HYP-GB-PROJECT',
      causal_claim: 'The project-local candidate lowers cost while preserving the guard.',
      target_units: ['src/cost.ts'],
    },
    baseline_state: 'exact project-local baseline',
    candidate_state: 'same world plus one patch',
    representative_inputs: ['fixture'],
    target_measurements: [{ id: 'SIG-COST', native_unit: 'ms', direction: 'lower_is_better' }],
    regression_measurements: [{ id: 'SIG-GUARD', native_unit: 'count', direction: 'higher_is_better' }],
    mandatory_gates: [{ kind: 'must_not_decrease', measure_id: 'SIG-GUARD' }],
    execution: { warmup_runs: 1, repetitions: 3, max_duration_seconds: 600, statistic: 'median' },
    invalid_run_rules: ['instrument failure invalidates the run'],
    confounder_rules: [],
    required_instruments: ['benchmark:fixture-master'],
    thresholds: {
      success: { measure_id: 'SIG-COST', kind: 'improve_pct_at_least', pct: 2 },
      non_inferiority: null,
      rejection: { measure_id: 'SIG-COST', kind: 'worsen_pct_at_least', pct: 2 },
    },
    environment_fingerprint: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    rollback_conditions: ['guard decreases'],
    great_book: {
      scope_id: 'src/cost.ts',
      contributions: [
        { measurement_id: 'MD04', source_measure_id: 'SIG-COST', confidence: 1, coverage: 1 },
      ],
    },
  });
}

function verdict(contractValue: ProofContract): DeterministicVerdict {
  const hash = proofContractHash(contractValue);
  const projectBasis = contractValue.project_basis;
  if (projectBasis === undefined) throw new Error('project-bound fixture contract omitted project_basis');
  return {
    disposition: 'ACCEPT',
    improvement: true,
    reasons: ['success threshold met and the guard held'],
    deltas: [
      { measure_id: 'SIG-COST', direction: 'lower_is_better', baseline: 100, candidate: 90, delta_pct: 10 },
      { measure_id: 'SIG-GUARD', direction: 'higher_is_better', baseline: 10, candidate: 10, delta_pct: 0 },
    ],
    gates: [
      {
        rule: { kind: 'must_not_decrease', measure_id: 'SIG-GUARD' },
        outcome: 'pass',
        detail: '10 → 10',
      },
    ],
    thresholds: {
      success: {
        rule: { measure_id: 'SIG-COST', kind: 'improve_pct_at_least', pct: 2 },
        met: true,
        detail: '10% >= 2%',
      },
      rejection: {
        rule: { measure_id: 'SIG-COST', kind: 'worsen_pct_at_least', pct: 2 },
        met: false,
        detail: 'candidate improved',
      },
      non_inferiority: null,
    },
    identity: {
      contract_hash: hash,
      baseline_digest: H('b'),
      candidate_digest: H('c'),
      baseline_snapshot: H('a'),
      candidate_snapshot: H('d'),
      project_basis: projectBasis,
    },
  };
}

function artifact(char: string): ArtifactRef {
  return {
    hash: H(char),
    bytes: 10,
    media_type: 'application/json; charset=utf-8',
    label: 'fixture.json',
    created_at: AT,
  };
}

function entry(targetId: string, contractValue: ProofContract): GreatBookEntry {
  const contractHash = proofContractHash(contractValue);
  const built = buildGreatBookEntry({
    targetId,
    missionVersion: 'MISSION-000001',
    cycleId: 'CYCLE-000001',
    contract: contractValue,
    contractHash,
    verdict: verdict(contractValue),
    patchDigest: H('e'),
    changeSet: [{ op: 'write', path: 'src/cost.ts', sha256: H('f'), bytes: 10 }],
    benchmarkRunId: 'EVENT-000010',
    artifacts: { contract: artifact('1'), candidate_run: artifact('2'), verdict: artifact('3') },
    recordedAt: AT,
  });
  if (built.entry === null) throw new Error(built.reason ?? 'entry not built');
  return built.entry;
}

function stack() {
  const root = mkdtempSync(join(tmpdir(), 'clue-great-book-project-'));
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'clue.db'), { modules: [GREAT_BOOK_PROJECTION] });
  const { log } = EventLog.open(join(root, 'events'));
  return {
    log,
    projections,
    close(): void {
      log.close();
      projections.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function append(log: EventLog, book: GreatBookEntry, eventBasis: ProjectGovernanceBasis): void {
  log.append({
    type: 'proof.verdict_recorded',
    actor: 'cli',
    missionVersion: book.mission_version,
    subjectId: book.cycle_id,
    payload: {
      target_id: book.target_id,
      project_basis: eventBasis,
      cycle_id: book.cycle_id,
      disposition: 'ACCEPT',
      improvement: true,
      contract_hash: book.contract_hash,
      baseline_digest: book.baseline_digest,
      candidate_digest: book.candidate_digest,
      patch_digest: book.patch_digest,
      great_book: { state: 'recorded', entry: book },
    },
  });
}

test('PP-16: one accepted contribution remains explicitly bound to its project and invisible to another target', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const alpha = proofReadyProfile(fixture);
  const sibling = makeSiblingProjectProfile(fixture, 'beta');
  const beta = proofReadyProfile(fixture, { profile: sibling, benchmarkId: 'beta-master', scenario: 'beta-master' });
  const basisA = basisFor(fixture, alpha, 'gb-alpha');
  const basisB = basisFor(fixture, beta, 'gb-beta');
  const alphaEntry = entry('alpha', contract(basisA));

  assert.equal(alphaEntry.entry_version, 2);
  assert.deepEqual(alphaEntry.project_basis, basisA);
  assert.doesNotThrow(() => greatBookEntrySchema.parse(alphaEntry));
  assert.throws(
    () => entry('beta', contract(basisA)),
    /Great Book target beta disagrees with Project Profile alpha/,
  );
  assert.notEqual(entry('beta', contract(basisB)).entry_id, alphaEntry.entry_id);

  const s = stack();
  try {
    append(s.log, alphaEntry, basisA);
    s.projections.sync(s.log);
    assert.deepEqual(readGreatBookEntries(s.projections, 'alpha'), [alphaEntry]);
    assert.deepEqual(readGreatBookEntries(s.projections, 'beta'), []);
  } finally {
    s.close();
  }
});

test('PP-16: enclosing verdict and Great Book project bases must match atomically', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const alpha = proofReadyProfile(fixture);
  const sibling = makeSiblingProjectProfile(fixture, 'beta');
  const beta = proofReadyProfile(fixture, { profile: sibling, benchmarkId: 'beta-master', scenario: 'beta-master' });
  const basisA = basisFor(fixture, alpha, 'gb-parity-alpha');
  const basisB = basisFor(fixture, beta, 'gb-parity-beta');
  const alphaEntry = entry('alpha', contract(basisA));

  const s = stack();
  try {
    append(s.log, alphaEntry, basisB);
    assert.throws(() => s.projections.sync(s.log), /project_basis does not match|does not match Project Profile/);
    assert.deepEqual(readGreatBookEntries(s.projections, 'alpha'), []);
  } finally {
    s.close();
  }

  const validVerdict = verdict(contract(basisA));
  const forgedVerdict: DeterministicVerdict = {
    ...validVerdict,
    identity: { ...validVerdict.identity, project_basis: basisB },
  };
  assert.throws(
    () =>
      buildGreatBookEntry({
        targetId: 'alpha',
        missionVersion: 'MISSION-000001',
        cycleId: 'CYCLE-000001',
        contract: contract(basisA),
        contractHash: proofContractHash(contract(basisA)),
        verdict: forgedVerdict,
        patchDigest: H('e'),
        changeSet: [{ op: 'write', path: 'src/cost.ts', sha256: H('f'), bytes: 10 }],
        benchmarkRunId: 'EVENT-000010',
        artifacts: { contract: artifact('1'), candidate_run: artifact('2'), verdict: artifact('3') },
        recordedAt: AT,
      }),
    /Project Profile basis disagrees/,
  );
});


test('PP-16: a not-recorded ACCEPT gap cannot be projected under another project id', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const basisA = basisFor(fixture, proofReadyProfile(fixture), 'gb-gap-alpha');
  const s = stack();
  try {
    s.log.append({
      type: 'proof.verdict_recorded',
      actor: 'cli',
      missionVersion: 'MISSION-000001',
      subjectId: 'CYCLE-000001',
      payload: {
        target_id: 'beta',
        project_basis: basisA,
        cycle_id: 'CYCLE-000001',
        disposition: 'ACCEPT',
        improvement: true,
        contract_hash: H('a'),
        great_book: { state: 'not_recorded', reason: 'fixture gap' },
      },
    });
    assert.throws(() => s.projections.sync(s.log), /does not match Project Profile alpha/);
  } finally {
    s.close();
  }
});
