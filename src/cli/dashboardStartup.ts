/** Bind the local dashboard launcher to the exact saved profile confirmed by its operator. */

import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';

import { validateProjectProfileRecord } from '../daemon/projectProfilesApi.js';
import {
  enableProjectProfileStartup,
  loadActiveProjectProfileForStartup,
  projectProfileCutoverConfirmation,
  ProjectRuntimeManager,
  type ActiveProjectPointer,
  type ProjectProfileCutoverResult,
  type ProjectProfileRegistry,
} from '../control/projectProfiles/index.js';
import { bootstrapProjectWorkspace } from '../control/projectProfiles/projectWorkspaceBootstrap.js';
import { findRepoRoot, openProjectRuntime, withRuntimeAsync, type Runtime } from '../control/runtime.js';
import type { ProjectProfileRecord } from '../shared/schemas.js';

function openDashboardProjectRuntime(repoRoot: string, record: ProjectProfileRecord): Runtime {
  const runtime = openProjectRuntime(record, { repoRoot, withLog: false, readOnly: true });
  try {
    runtime.requireMission();
    runtime.requireFreshProjections();
    return runtime;
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}

export function verifyProjectStartupWorkspace(repoRoot: string, record: ProjectProfileRecord): void {
  openDashboardProjectRuntime(repoRoot, record).dispose();
}

/** Keep the dashboard read-only while the manager owns its current Project Profile generation. */
export async function withDashboardRuntime<T>(
  run: (runtime: Runtime, manager?: ProjectRuntimeManager) => Promise<T>,
  repoRoot = findRepoRoot(),
): Promise<T> {
  const startup = loadActiveProjectProfileForStartup(repoRoot);
  if (startup === null) return withRuntimeAsync({ repoRoot, withLog: false }, run);

  const manager = new ProjectRuntimeManager(startup.registry, {
    openRuntime: ({ record }) => openDashboardProjectRuntime(repoRoot, record),
  });
  try {
    manager.start();
    const runtime = manager.activeRuntime;
    if (runtime === null) throw new Error('The dashboard has no active Project Profile runtime.');
    return await run(runtime, manager);
  } finally {
    manager.dispose();
  }
}

export function bindSavedDashboardProfile(
  repoRoot: string,
  registry: ProjectProfileRegistry,
  pointer: ActiveProjectPointer,
): ProjectProfileCutoverResult {
  const current = registry.active();
  if (current === null || current.projectId !== pointer.projectId ||
    current.profileGeneration !== pointer.profileGeneration ||
    current.projectProfileHash !== pointer.projectProfileHash ||
    current.registryGeneration !== pointer.registryGeneration) {
    throw new Error('STARTUP_POINTER_STALE: the saved profile or registry changed. Reopen CLUE-Dashboard.bat and review the current selection.');
  }

  return enableProjectProfileStartup({
    repoRoot,
    registry,
    projectId: pointer.projectId,
    confirmation: projectProfileCutoverConfirmation(registry.getProfile(pointer.projectId)),
    expectedRegistryGeneration: pointer.registryGeneration,
    actor: 'cli',
    verifyWorkspace(record) {
      if (record.generation !== pointer.profileGeneration || record.projectProfileHash !== pointer.projectProfileHash) {
        throw new Error('STARTUP_POINTER_STALE: the saved profile changed before workspace verification.');
      }
      const validation = validateProjectProfileRecord(record);
      const branchMatches = validation.git.branch === record.profile.integrations.git.defaultBranch;
      const dirtyCheckoutOnly = validation.state === 'BLOCKED' &&
        validation.git.code === 'DIRTY_WORKTREE' && branchMatches && validation.problems.length === 1;
      if (!validation.valid && !dirtyCheckoutOnly) {
        const problems = [...validation.problems];
        if (validation.git.code === 'DIRTY_WORKTREE' && !branchMatches) {
          problems.push(`PROFILE_BRANCH_MISMATCH: Check out ${record.profile.integrations.git.defaultBranch} for this profile.`);
        }
        throw new Error(`Saved profile ${record.profile.projectId} could not start (${validation.state}).\n  - ${problems.join('\n  - ')}`);
      }
      if (record.profile.provenance.source === 'native') {
        bootstrapProjectWorkspace({
          repoRoot,
          registry,
          projectId: record.profile.projectId,
          expectedGeneration: record.generation,
          expectedProfileHash: record.projectProfileHash,
        });
      }
      verifyProjectStartupWorkspace(repoRoot, record);
    },
  });
}

export async function prepareDashboardStartup(repoRoot: string, registry: ProjectProfileRegistry): Promise<number> {
  const active = registry.active();
  if (active === null) return 0;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Open CLUE-Dashboard.bat in an interactive terminal to choose a startup profile.');
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string | null;
  try {
    process.stdout.write('Using the saved profile will prepare its own workspace if needed and save the startup choice.\n');
    answer = await Promise.race([
      once(terminal, 'close').then(() => null),
      terminal.question(
        `Use saved profile ${active.projectId} (generation ${active.profileGeneration}) on this and future launches?\n` +
        '[Y] Use profile / [L] Open legacy / [Enter] Cancel: ',
      ),
    ]);
  } finally {
    terminal.close();
  }
  const choice = answer?.trim().toLowerCase();
  if (choice === 'l') return 0;
  if (choice !== 'y') return 2;

  const result = bindSavedDashboardProfile(repoRoot, registry, active);
  process.stdout.write(`Startup profile selected: ${result.pointer.projectId} (generation ${result.pointer.profileGeneration}).\n`);
  return 0;
}
