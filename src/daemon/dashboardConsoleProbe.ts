import {
  resolveProjectHostLaunchBinding,
  type ProjectHostLaunchBinding,
} from '../control/projectProfiles/hostReadiness.js';
import type { Runtime } from '../control/runtime.js';
import { HostClient, HostClientError, type HostBanner } from '../experiment/host/hostClient.js';
import type { ProjectProfileRecord } from '../shared/schemas.js';
import { redactSecretText } from '../shared/secretSafety.js';
import type { DashboardReadiness, ReadinessCheck } from './dashboardReadiness.js';

/** Run a fixed, read-only canary against the same governed host used for project operations. */
export async function probeDashboardConsole(runtime: Runtime, record: ProjectProfileRecord): Promise<DashboardReadiness> {
  const host = 'PowerShell host';
  const workspace = 'Workspace read';
  const shutdown = 'Host shutdown';
  if (record.profile.integrations.powershell.autonomousProfile === 'disabled') {
    const summary = 'This Project Profile disables host shell operations.';
    return { state: 'pending', summary, checks: [{ label: host, state: 'pending', detail: summary }] };
  }

  const checks: ReadinessCheck[] = [];
  let stage = host;
  try {
    const binding = resolveProjectHostLaunchBinding(record, runtime.config.powershell.executable);
    await runProjectHostProbe(binding, runtime, async (client) => {
      checks.push({ label: host, state: 'ready', detail: 'Typed handshake, operating roots and Project Profile identity verified.' });
      stage = workspace;
      const stat = await client.statPath({ zone: 'workspace', path: binding.roots.workspace });
      if (!stat.ok) throw stat.error;
      if (!stat.value.exists || !stat.value.isDirectory || stat.value.isFile) {
        throw new Error('The governed host did not confirm the workspace directory.');
      }
      checks.push({ label: workspace, state: 'ready', detail: 'The host returned a validated result for the workspace directory.' });
      stage = shutdown;
    });
    checks.push({ label: shutdown, state: 'ready', detail: 'The one-shot host closed its input and exited successfully.' });
    return { state: 'ready', summary: 'Governed PowerShell command and response verified. The test host has closed.', checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The test did not complete.';
    const detail = redactSecretText(runtime.secrets.redact(error instanceof HostClientError ? `${error.code} · ${message}` : message)).text
      .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').slice(0, 700);
    checks.push({ label: stage, state: 'failed', detail });
    return { state: 'failed', summary: `${stage} failed. ${detail}`, checks };
  }
}

/** Preserve the normal handshake while letting the dashboard run its quiet canary on the same client. */
export async function runProjectHostProbe(
  binding: ProjectHostLaunchBinding,
  runtime: Runtime,
  verify?: (client: HostClient) => Promise<void>,
): Promise<HostBanner> {
  const subjectId = `PROJECT-READINESS-${binding.projectIdentity.projectId}`;
  const purpose = verify === undefined ? 'project-readiness' : 'dashboard-console-test';
  const token = runtime.policy.issueToken('daemon', verify === undefined
    ? ['process.run.host']
    : ['process.run.host', 'fs.read.workspace'], { subjectId, purpose, attempt: 1 });
  const client = new HostClient({
    executable: binding.executable,
    scriptPath: binding.scriptPath,
    policy: runtime.policy,
    actor: 'daemon',
    tokenSecret: token.secret,
    operationSubjectId: subjectId,
    operationPurpose: purpose,
    operationAttempt: 1,
    hostRoots: binding.roots,
    projectIdentity: binding.projectIdentity,
    quiet: verify !== undefined,
  });
  try {
    const result = await client.start();
    if (!result.ok) throw result.error;
    await verify?.(client);
    if (verify !== undefined) await client.stopAndWait();
    return result.value;
  } catch (error) {
    // Retain the first failure while still closing the one-shot host and releasing its token.
    if (verify !== undefined) await client.stopAndWait().catch(() => {});
    throw error;
  } finally {
    client.stop();
    runtime.policy.revokeToken(token.secret);
  }
}
