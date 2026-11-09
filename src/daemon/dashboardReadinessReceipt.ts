/** Last-known advisory checks. The current browser still makes a fresh live check on opening. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { Runtime } from '../control/runtime.js';
import { replaceFileSync, writeAllSync } from '../shared/durableFs.js';
import { hashCanonicalJson, nowIso } from '../shared/ids.js';
import type { ReadinessState } from './dashboardReadiness.js';

const capabilities = ['ai', 'git'] as const;
type RememberedCapability = typeof capabilities[number];
const receiptSchema = z.object({
  scope: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['ready', 'pending', 'failed', 'unknown']),
  checkedAt: z.string().datetime(),
}).strict();

type ReadinessReceipt = Pick<z.infer<typeof receiptSchema>, 'state' | 'checkedAt'>;

export function dashboardReadinessScope(runtime: Runtime): string {
  const profile = runtime.projectProfile;
  if (profile !== null) {
    return hashCanonicalJson(['profile', profile.profile.projectId, profile.generation, profile.projectProfileHash]);
  }
  const { project, gateway } = runtime.config;
  return hashCanonicalJson([
    'legacy', project.id, project.root, project.remote, project.remote_decision, project.main_branch,
    gateway.enabled, gateway.api_key_env, gateway.routing_file,
  ]);
}

function pathFor(workspace: string, capability: RememberedCapability): string {
  return join(workspace, `.dashboard-readiness-${capability}.json`);
}

export function readDashboardReadinessReceipts(workspace: string, scope: string): Partial<Record<RememberedCapability, ReadinessReceipt>> {
  const receipts: Partial<Record<RememberedCapability, ReadinessReceipt>> = {};
  for (const capability of capabilities) {
    try {
      const path = pathFor(workspace, capability);
      const file = lstatSync(path);
      if (!file.isFile() || file.nlink !== 1 || file.size > 1024) continue;
      const parsed = receiptSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success && parsed.data.scope === scope) {
        receipts[capability] = { state: parsed.data.state, checkedAt: parsed.data.checkedAt };
      }
    } catch { /* absent, unreadable or invalid advisory receipt */ }
  }
  return receipts;
}

export function rememberDashboardReadiness(
  workspace: string, scope: string, capability: string, state: ReadinessState,
): void {
  if (capability !== 'ai' && capability !== 'git') return;
  const path = pathFor(workspace, capability);
  const temp = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing !== undefined && (!existing.isFile() || existing.nlink !== 1)) return;
    const fd = openSync(temp, 'wx', 0o600);
    created = true;
    try {
      writeAllSync(fd, Buffer.from(JSON.stringify({ scope, state, checkedAt: nowIso() }), 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    replaceFileSync(temp, path);
    created = false;
  } catch { /* advisory persistence cannot change the live result */ }
  finally {
    if (created) {
      try { rmSync(temp, { force: true }); } catch { /* temporary receipt cleanup is best effort */ }
    }
  }
}
