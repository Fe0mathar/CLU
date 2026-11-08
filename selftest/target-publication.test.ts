/**
 * DEV-P2-04 / ADR-0014 — target publication decision and stated absence.
 *
 * A nullable remote alone cannot distinguish an intentional local-only target from an
 * untouched legacy profile because legacy configuration defaults to null. These tests pin
 * the explicit mission-bound decision, its cross-field refusals, the sealed Status view and
 * the §19 next-cycle handoff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { loadLegacyConfig } from '../src/control/runtime.js';
import { buildNextCycleVitalInput } from '../src/cycle/nextCycleVitalInput.js';
import type { RegistrySource } from '../src/daemon/consoleStateCollector.js';
import type { Runtime } from '../src/control/runtime.js';
import {
  cycleInputLockSchema,
  cycleRecordSchema,
  projectConfigSchema,
  targetProfileSchema,
} from '../src/shared/schemas.js';
import {
  describeTargetPublication,
  UNRECORDED_TARGET_REMOTE_DECISION,
} from '../src/shared/targetPublication.js';
import { projectStatus } from '../src/status/statusProjector.js';

const AT = '2026-08-14T00:00:00.000Z';
const NO_REMOTE_REASON =
  'Remote publication is intentionally deferred beyond P2; CLU-E remains local-only until a later Creator decision registers a remote and the governed Git lifecycle is implemented.';

function baseProfile(): Record<string, unknown> {
  return {
    id: 'fixture',
    name: 'Fixture',
    root: '/fixture',
    main_branch: 'main',
    source_roots: ['src'],
    document_roots: ['.'],
    exclude: [],
    remote: null,
    credential_env: null,
    inputs: { description: null, benchmark: null },
  };
}

const noRemoteDecision = {
  state: 'NO_REMOTE_YET' as const,
  decision_id: 'P2-D5-NO-REMOTE-YET',
  recorded_at: '2026-08-14',
  recorded_by: 'creator' as const,
  reason: NO_REMOTE_REASON,
};

function source(): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'MISSION-000001',
      title: 'fixture',
      constitutionHash: 'a'.repeat(64),
      lastChange: 'initial',
    }),
    latestSnapshot: () => null,
    recognitionFor: () => null,
    runIdForSnapshot: () => null,
    configReadiness: () => ({ ready: true, sections: [] }) as never,
    stateSources: () => ['events:0-1'],
  };
}

function handoffRuntime(input: {
  readonly remote: string | null;
  readonly credentialEnv: string | null;
  readonly decision: typeof noRemoteDecision | { readonly state: 'UNRECORDED' } | {
    readonly state: 'REMOTE_REGISTERED';
    readonly decision_id: string;
    readonly recorded_at: string;
    readonly recorded_by: 'creator';
    readonly reason: string;
  };
}): Runtime {
  return {
    config: {
      project: {
        id: 'fixture',
        main_branch: 'main',
        remote: input.remote,
        credential_env: input.credentialEnv,
        remote_decision: input.decision,
      },
    },
    artifacts: {
      getJson(): never {
        throw new Error('no artifact');
      },
    },
    requireGraph(): never {
      throw new Error('no graph');
    },
    claims: null,
  } as unknown as Runtime;
}

const lock = cycleInputLockSchema.parse({
  digest: 'b'.repeat(64),
  grade: 'diagnostic',
  computed_at: AT,
  target_description: null,
  master_benchmark: null,
  tracked_documents: [{ path: 'CLUE.md', sha256: 'c'.repeat(64) }],
  catalogue_version: null,
  policy_files: [],
  environment_fingerprint: { node_version: '22.0.0', platform: 'test', arch: 'x64' },
  ratification_event_id: null,
  epoch_name: null,
  absent: ['target_description', 'master_benchmark'],
});

const cycle = cycleRecordSchema.parse({
  id: 'CYCLE-000001',
  mission_version: 'MISSION-000001',
  stage: 'HANDOFF',
  suspended_from: null,
  grade: 'diagnostic',
  lock_digest: lock.digest,
  opened_at: AT,
  updated_at: AT,
  closed_at: null,
  criteria_met: null,
  unmet_count: null,
});

test('DEV-P2-04: legacy null/null resolves to UNRECORDED, not an invented Creator decision', () => {
  const parsed = targetProfileSchema.parse(baseProfile());
  assert.deepEqual(parsed.remote_decision, UNRECORDED_TARGET_REMOTE_DECISION);

  const publication = describeTargetPublication(
    parsed.remote,
    parsed.credential_env,
    parsed.remote_decision,
  );
  assert.equal(publication.decision, 'UNRECORDED');
  assert.equal(publication.publicationPermitted, false);
  assert.match(publication.reason, /remains open/u);
});

test('DEV-P2-04: NO_REMOTE_YET is explicit, mission-serializable and local-only', () => {
  const parsed = targetProfileSchema.parse({
    ...baseProfile(),
    remote_decision: noRemoteDecision,
  });
  const publication = describeTargetPublication(
    parsed.remote,
    parsed.credential_env,
    parsed.remote_decision,
  );

  assert.equal(publication.decision, 'NO_REMOTE_YET');
  assert.equal(publication.decisionId, 'P2-D5-NO-REMOTE-YET');
  assert.equal(publication.recordedAt, '2026-08-14');
  assert.equal(publication.recordedBy, 'creator');
  assert.equal(publication.remote, null);
  assert.equal(publication.credentialEnv, null);
  assert.equal(publication.localOnly, true);
  assert.equal(publication.gitLifecycleImplemented, false);
  assert.equal(publication.publicationPermitted, false);
  assert.equal(publication.reason, NO_REMOTE_REASON);
});

test('DEV-P2-04: contradictory or implicit publication configuration is refused', () => {
  assert.throws(
    () => targetProfileSchema.parse({ ...baseProfile(), remote: 'git@example.com:repo.git' }),
    /explicit Creator remote_decision/u,
  );
  assert.throws(
    () =>
      targetProfileSchema.parse({
        ...baseProfile(),
        remote: 'git@example.com:repo.git',
        remote_decision: noRemoteDecision,
      }),
    /NO_REMOTE_YET requires remote: null/u,
  );
  assert.throws(
    () =>
      targetProfileSchema.parse({
        ...baseProfile(),
        credential_env: 'CLUE_GIT_CREDENTIAL',
        remote_decision: noRemoteDecision,
      }),
    /credential_env requires a registered project.remote/u,
  );
  assert.throws(
    () =>
      targetProfileSchema.parse({
        ...baseProfile(),
        remote_decision: {
          ...noRemoteDecision,
          state: 'REMOTE_REGISTERED',
          decision_id: 'D5-REMOTE',
        },
      }),
    /REMOTE_REGISTERED requires/u,
  );
});

test('DEV-P2-04: a registered remote is identity only and grants no publication authority', () => {
  const parsed = projectConfigSchema.parse({
    ...baseProfile(),
    active_target: null,
    remote: 'git@example.com:owner/repo.git',
    credential_env: 'CLUE_GIT_CREDENTIAL',
    remote_decision: {
      state: 'REMOTE_REGISTERED',
      decision_id: 'D5-REMOTE',
      recorded_at: '2026-08-14',
      recorded_by: 'creator',
      reason: 'The Creator registered this credential-free remote identity for later Git work.',
    },
  });
  const publication = describeTargetPublication(
    parsed.remote,
    parsed.credential_env,
    parsed.remote_decision,
  );

  assert.equal(publication.decision, 'REMOTE_REGISTERED');
  assert.equal(publication.localOnly, false);
  assert.equal(publication.gitLifecycleImplemented, false);
  assert.equal(publication.publicationPermitted, false);
});

test('DEV-P2-04 / ADR-0014: Status 5.8.0 seals the explicit decision while versionControl stays unsupported', () => {
  const snapshot = projectStatus(source(), {
    capturedAt: AT,
    targetId: 'fixture',
    targetName: 'Fixture',
    canonicalRoot: '/fixture',
    targetRemote: null,
    targetCredentialEnv: null,
    targetRemoteDecision: noRemoteDecision,
    missionBasisHash: 'd'.repeat(64),
    recognizerVersion: 'clue-recognizer/4',
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: null,
      eventLogTo: null,
      projectionVersion: null,
      goldenDefinitionHash: null,
    },
  }).snapshot;

  assert.equal(snapshot.schemaVersion, '5.8.0');
  assert.ok(!('state' in snapshot.target));
  if ('state' in snapshot.target) throw new Error('target unavailable');
  assert.equal(snapshot.target.publication.decision, 'NO_REMOTE_YET');
  assert.equal(snapshot.target.publication.decisionId, 'P2-D5-NO-REMOTE-YET');
  assert.equal(snapshot.target.publication.publicationPermitted, false);
  assert.equal(snapshot.versionControl.state, 'unsupported');
});

test('DEV-P2-04: the §19 handoff uses project.remote, not backup.remote, and preserves stated absence', () => {
  const handoff = buildNextCycleVitalInput({
    runtime: handoffRuntime({ remote: null, credentialEnv: null, decision: noRemoteDecision }),
    cycle,
    lock,
    stageEvidence: {},
  });

  assert.equal(handoff.accepted_identity.git_remote, null);
  const absence = handoff.stated_absences.find(
    (entry) => entry.field === 'accepted_identity.git_remote',
  );
  assert.equal(absence?.reason, NO_REMOTE_REASON);
});

test('DEV-P2-04: a registered project remote enters the §19 identity without a false absence', () => {
  const decision = {
    state: 'REMOTE_REGISTERED' as const,
    decision_id: 'D5-REMOTE',
    recorded_at: '2026-08-14',
    recorded_by: 'creator' as const,
    reason: 'The Creator registered this credential-free remote identity for later Git work.',
  };
  const handoff = buildNextCycleVitalInput({
    runtime: handoffRuntime({
      remote: 'git@example.com:owner/repo.git',
      credentialEnv: 'CLUE_GIT_CREDENTIAL',
      decision,
    }),
    cycle,
    lock,
    stageEvidence: {},
  });

  assert.equal(handoff.accepted_identity.git_remote, 'git@example.com:owner/repo.git');
  assert.equal(
    handoff.stated_absences.some((entry) => entry.field === 'accepted_identity.git_remote'),
    false,
  );
});

test('DEV-P2-04: the shipped active profile resolves the exact Creator NO_REMOTE_YET record', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const config = loadLegacyConfig(repoRoot);
  assert.equal(config.project.active_target, 'clu');
  assert.equal(config.project.remote, null);
  assert.equal(config.project.credential_env, null);
  assert.deepEqual(config.project.remote_decision, noRemoteDecision);
});
