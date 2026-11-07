/** PP-26 — durable Gateway calls and provider state remain bound to one Project Profile. */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAY_EVENT_TYPES,
  GATEWAY_PROJECTION,
  readGatewayCall,
  readGatewayProviderProjectionState,
} from '../src/ai/gateway/gatewayProjection.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import type { ProjectOperationIdentity } from '../src/shared/projectOperationIdentity.js';

const H = (char: string): string => char.repeat(64).slice(0, 64);
const AT = '2026-08-15T01:00:00.000Z';

function identity(projectId: string, char: string): ProjectOperationIdentity {
  return {
    projectId,
    targetRootIdentity: `path:v1:test:${H(char)}`,
    projectProfileHash: `profile:v1:${H(char)}`, 
  };
}

function stack() {
  const root = mkdtempSync(join(tmpdir(), 'clue-gateway-project-'));
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'clue.db'), { modules: [GATEWAY_PROJECTION] });
  const { log } = EventLog.open(join(root, 'events'));
  return {
    root,
    log,
    projections,
    close() {
      log.close();
      projections.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function startedPayload(callId: string, projectIdentity: ProjectOperationIdentity, generation: number) {
  return {
    call_id: callId,
    target_id: 'clu',
    project_identity: projectIdentity,
    profile_generation: generation,
    task_type: 'DOC_EXTRACT',
    lane: 'extraction',
    mode: 'interactive',
    model: 'gpt-5.6',
    attribution: { task_id: null, experiment_id: null, finding_id: null },
    policy_hash: H('1'),
    routing_hash: H('2'),
    price_schedule_version: 'OPENAI-2026-08',
    request_artifact_hash: H('3'),
    request_hash: H('4'),
    estimated_input_tokens: 10,
    max_output_tokens: 20,
    estimated_usd: 0,
    pricing: {
      input_usd_per_million: 0,
      cached_input_usd_per_million: 0,
      output_usd_per_million: 0,
      batch_discount_fraction: 0,
    },
    started_at: AT,
  } as const;
}

function completedPayload(callId: string, projectIdentity: ProjectOperationIdentity, generation: number) {
  return {
    call_id: callId,
    project_identity: projectIdentity,
    profile_generation: generation,
    provider_request_id: 'resp_exact',
    provider_batch_id: null,
    provider_model: 'gpt-5.6',
    response_artifact_hash: H('5'),
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 },
    actual_usd: 0,
    completed_at: '2026-08-15T01:00:01.000Z',
  } as const;
}

test('PP-26: completed call projection exposes exact project identity and generation', () => {
  const s = stack();
  try {
    const project = identity('clu', 'a');
    const callId = `GWCALL-${'a'.repeat(32)}`;
    s.log.append({
      type: GATEWAY_EVENT_TYPES.callStarted,
      actor: 'gateway',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: startedPayload(callId, project, 7),
    });
    s.log.append({
      type: GATEWAY_EVENT_TYPES.callCompleted,
      actor: 'gateway',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: completedPayload(callId, project, 7),
    });
    s.projections.sync(s.log);

    const call = readGatewayCall(s.projections, callId);
    assert.deepEqual(call?.projectIdentity, project);
    assert.equal(call?.profileGeneration, 7);
    assert.equal(call?.state, 'completed');
  } finally {
    s.close();
  }
});

test('PP-26: a terminal event from another profile generation is refused during projection', () => {
  const s = stack();
  try {
    const projectA = identity('clu', 'a');
    const projectB = identity('clu', 'b');
    const callId = `GWCALL-${'b'.repeat(32)}`;
    s.log.append({
      type: GATEWAY_EVENT_TYPES.callStarted,
      actor: 'gateway',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: startedPayload(callId, projectA, 7),
    });
    s.log.append({
      type: GATEWAY_EVENT_TYPES.callCompleted,
      actor: 'gateway',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: completedPayload(callId, projectB, 8),
    });
    assert.throws(
      () => s.projections.sync(s.log),
      /project identity|profile generation/u,
    );
  } finally {
    s.close();
  }
});

test('PP-26: durable provider pause/resume state carries project identity', () => {
  const s = stack();
  try {
    const project = identity('clu', 'c');
    s.log.append({
      type: GATEWAY_EVENT_TYPES.providerResumed,
      actor: 'creator',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: {
        target_id: 'clu',
        project_identity: project,
        profile_generation: 9,
        provider: 'openai',
        model: 'gpt-5.6',
        resumed_at: AT,
      },
    });
    s.projections.sync(s.log);
    const provider = readGatewayProviderProjectionState(s.projections, 'clu');
    assert.equal(provider.state, 'ready');
    assert.deepEqual(provider.projectIdentity, project);
    assert.equal(provider.profileGeneration, 9);
  } finally {
    s.close();
  }
});
