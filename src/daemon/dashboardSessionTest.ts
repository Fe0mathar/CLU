/** In-memory verdicts for tests bound to the dashboard's running Project Profile. */

import { z } from 'zod';

import { nowIso } from '../shared/ids.js';
import { operationIdentityFromProfileRecord, type ProjectOperationIdentity } from '../shared/projectOperationIdentity.js';
import { projectIdSchema, projectProfileHashSchema, type ProjectProfileRecord } from '../shared/schemas.js';
import { redactSecretText } from '../shared/secretSafety.js';
import type { DashboardReadiness } from './dashboardReadiness.js';

export const dashboardSessionTestRequestSchema = z.object({
  projectId: projectIdSchema,
  expectedGeneration: z.number().int().positive(),
  expectedProfileHash: projectProfileHashSchema,
}).strict();

export interface DashboardSessionTestReceipt extends DashboardReadiness {
  readonly projectIdentity?: ProjectOperationIdentity;
  readonly profileGeneration?: number;
  readonly testedAt?: string;
}

export function createDashboardSessionTest(
  label: string,
  runningSummary: string,
  runTest: (record: ProjectProfileRecord, assertRunning: () => void) => Promise<DashboardReadiness>,
  assertRunning: () => void,
  redact: (text: string) => string,
) {
  let receipt: DashboardSessionTestReceipt | null = null;
  let inFlight: Promise<DashboardSessionTestReceipt> | null = null;

  function read(record: ProjectProfileRecord | null): DashboardSessionTestReceipt {
    if (record !== null && receipt?.projectIdentity?.projectId === record.profile.projectId &&
        receipt.projectIdentity.targetRootIdentity === record.profile.targetRootIdentity &&
        receipt.projectIdentity.projectProfileHash === record.projectProfileHash &&
        receipt.profileGeneration === record.generation) return receipt;
    return {
      state: 'pending',
      summary: record === null
        ? `Start the dashboard under a saved Project Profile to run ${label}.`
        : `Run ${label} in Configuration to verify this dashboard session.`,
      checks: [],
    };
  }

  function run(record: ProjectProfileRecord): Promise<DashboardSessionTestReceipt> {
    if (inFlight !== null) return inFlight;
    const identity = {
      projectIdentity: operationIdentityFromProfileRecord(record),
      profileGeneration: record.generation,
    };
    receipt = { ...identity, state: 'pending', summary: runningSummary, checks: [] };
    inFlight = Promise.resolve().then(async () => {
      try {
        assertRunning();
        const result = await runTest(record, assertRunning);
        assertRunning();
        receipt = { ...result, ...identity, testedAt: nowIso() };
      } catch (error) {
        const message = redactSecretText(redact(error instanceof Error ? error.message : 'The test could not complete.')).text
          .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').slice(0, 800);
        receipt = { ...identity, state: 'failed', summary: message, checks: [], testedAt: nowIso() };
      } finally {
        inFlight = null;
      }
      return receipt;
    });
    return inFlight;
  }

  return { read, run };
}
