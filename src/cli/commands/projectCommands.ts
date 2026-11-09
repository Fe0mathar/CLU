/** `clue project` — Project Profile control plane before the browser UI. */

import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import {
  findRepoRoot,
  loadLegacyConfig,
  openProjectRuntime,
  resolveConfigPaths,
} from '../../control/runtime.js';
import {
  adoptLegacyWorkspaceForProfile,
  configuredProjectProfilesRoot,
  disableProjectProfileStartup,
  enableProjectProfileStartup,
  loadActiveProjectProfileForStartup,
  loadProjectProfileStartup,
  migrateLegacyActiveTarget,
  projectProfileCutoverConfirmation,
  ProjectProfileRegistry,
} from '../../control/projectProfiles/index.js';
import { bootstrapProjectWorkspace } from '../../control/projectProfiles/projectWorkspaceBootstrap.js';
import { runWindowsPreflight } from '../../control/projectProfiles/windowsPreflight.js';
import {
  deleteConfirmation,
  ProjectProfilesApiService,
  validateProjectProfileRecord,
} from '../../daemon/projectProfilesApi.js';
import { assertNoSecretMaterial } from '../../shared/secretSafety.js';
import { projectProfileSchema, type ProjectProfileRecord } from '../../shared/schemas.js';
import { write } from '../output/formatter.js';
import { prepareDashboardStartup, verifyProjectStartupWorkspace } from '../dashboardStartup.js';
import { commandProjectBrowserRun, type BrowserRunOptions } from '../projectBrowserRun.js';

interface ProjectGroupOptions {
  readonly repoRoot?: string;
  readonly profilesRoot?: string;
}

interface ProjectContext {
  readonly repoRoot: string;
  readonly profilesRoot: string;
  readonly registry: ProjectProfileRegistry;
}

export function registerProjectCommands(program: Command): void {
  const project = program
    .command('project')
    .description('create, validate, migrate and activate Project Profiles')
    .option('--repo-root <path>', 'CLU-E repository root')
    .option('--profiles-root <path>', 'Project Profile registry root');

  project.command('list').description('list registered Project Profiles').action(() => {
    process.exitCode = guarded(() => {
      const context = projectContext(project.opts<ProjectGroupOptions>());
      output({ profilesRoot: context.profilesRoot, active: context.registry.active(), projects: context.registry.listMetadata() });
      return 0;
    });
  });

  project.command('active').description('show the registry and Configuration-v3 startup identity').action(() => {
    process.exitCode = guarded(() => {
      const context = projectContext(project.opts<ProjectGroupOptions>());
      const startup = loadActiveProjectProfileForStartup(context.repoRoot);
      output({
        profilesRoot: context.profilesRoot,
        registryActive: context.registry.active(),
        startup: startup === null ? null : {
          selector: startup.selector,
          selectorPath: startup.selectorPath,
          pointer: startup.pointer,
          record: startup.record,
        },
      });
      return 0;
    });
  });

  project.command('preflight').description('report Windows local-proof prerequisites for the active startup profile').action(() => {
    process.exitCode = guarded(() => {
      const options = project.opts<ProjectGroupOptions>();
      if (options.profilesRoot !== undefined) {
        throw new Error('Project preflight uses the saved startup registry. Remove --profiles-root.');
      }
      const report = runWindowsPreflight(findRepoRoot(options.repoRoot));
      output(report);
      return report.status === 'READY_FOR_LOCAL_PROOF_PREFLIGHT' ? 0 : 1;
    });
  });

  project
    .command('show')
    .description('show one complete durable Project Profile record')
    .argument('<project-id>')
    .action((projectId: string) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        output(context.registry.getProfile(projectId));
        return 0;
      });
    });

  project
    .command('create')
    .description('create one Project Profile from strict JSON')
    .requiredOption('--file <path>', 'Project Profile JSON draft')
    .action((options: { readonly file: string }) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const draft = readProfileDraft(options.file);
        output(context.registry.create(draft, { actor: 'cli', reason: 'CLI_CREATE' }));
        return 0;
      });
    });

  project
    .command('update')
    .description('replace one Project Profile generation from strict JSON')
    .argument('<project-id>')
    .requiredOption('--file <path>', 'Project Profile JSON draft')
    .requiredOption('--expected-generation <number>', 'current durable generation')
    .action((projectId: string, options: { readonly file: string; readonly expectedGeneration: string }) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const draft = readProfileDraft(options.file);
        output(context.registry.update(
          projectId,
          draft,
          positiveInteger(options.expectedGeneration, '--expected-generation'),
          { actor: 'cli', reason: 'CLI_UPDATE' },
        ));
        return 0;
      });
    });

  project
    .command('delete')
    .description('delete only CLU-E-owned profile registration; never the target/workspace')
    .argument('<project-id>')
    .requiredOption('--expected-generation <number>', 'current durable generation')
    .requiredOption('--confirmation <phrase>', 'state-bound phrase printed by `project show`/error')
    .action((projectId: string, options: { readonly expectedGeneration: string; readonly confirmation: string }) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const record = context.registry.getProfile(projectId);
        const expected = deleteConfirmation(record);
        if (options.confirmation !== expected) {
          throw new Error(`Deletion requires exact confirmation: ${expected}`);
        }
        if (context.registry.activeProjectId() === record.profile.projectId) {
          throw new Error(`Project ${record.profile.projectId} is active; activate another profile before deletion.`);
        }
        context.registry.delete(
          record.profile.projectId,
          positiveInteger(options.expectedGeneration, '--expected-generation'),
          { actor: 'cli', reason: 'CLI_DELETE_PROFILE_ONLY' },
        );
        output({
          deleted: true,
          projectId: record.profile.projectId,
          targetRepositoryDeleted: false,
          projectWorkspaceDeleted: false,
        });
        return 0;
      });
    });

  project
    .command('validate')
    .description('validate one profile, live authority, recognition, benchmark and local Git identity')
    .argument('<project-id>')
    .action((projectId: string) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const result = validateProjectProfileRecord(context.registry.getProfile(projectId));
        output(result);
        return result.valid ? 0 : 1;
      });
    });

  project
    .command('init')
    .description('preview or initialize one exact native Project Profile workspace')
    .argument('<project-id>')
    .option('--confirmation <phrase>', 'INIT WORKSPACE <id> <generation> <hash-prefix>')
    .action((projectId: string, options: { readonly confirmation?: string }) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const record = context.registry.getProfile(projectId);
        const digest = record.projectProfileHash.slice('profile:v1:'.length);
        const expected = `INIT WORKSPACE ${record.profile.projectId} ${record.generation} ${digest.slice(0, 12)}`;
        if (options.confirmation === undefined) {
          output({
            state: 'CONFIRMATION_REQUIRED',
            projectId: record.profile.projectId,
            profileGeneration: record.generation,
            workspaceRoot: record.profile.workspaceRoot,
            databasePath: record.profile.state.databasePath,
            confirmation: expected,
          });
          return 0;
        }
        if (options.confirmation !== expected) throw new Error(`Workspace initialization requires exact confirmation: ${expected}`);
        output(bootstrapProjectWorkspace({
          repoRoot: context.repoRoot,
          registry: context.registry,
          projectId: record.profile.projectId,
          expectedGeneration: record.generation,
          expectedProfileHash: record.projectProfileHash,
        }));
        return 0;
      });
    });

  project
    .command('readiness')
    .description('calculate operation-specific readiness through a profile-bound read-only runtime')
    .argument('<project-id>')
    .option('--operation <name>', 'local-proof | ai-candidate | browser-benchmark | publication', 'local-proof')
    .action((projectId: string, options: { readonly operation: string }) => {
      process.exitCode = guarded(() => withProfileApi(project, projectId, (service) => {
        const operation = readinessOperation(options.operation);
        const result = service.readiness(projectId, operation);
        output(result);
        return result.readyForRequestedOperations ? 0 : 1;
      }));
    });

  project
    .command('test-host')
    .description('launch and verify the exact profile-bound PowerShell host')
    .argument('<project-id>')
    .action(async (projectId: string) => {
      process.exitCode = await guardedAsync(() => withProfileApiAsync(project, projectId, async (service) => {
        const result = await service.testHost(projectId);
        output(result);
        return result.ready ? 0 : 1;
      }));
    });

  project
    .command('test-git')
    .description('validate local Git identity without fetch/push/network synchronization')
    .argument('<project-id>')
    .action((projectId: string) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const record = context.registry.getProfile(projectId);
        const result = validateProjectProfileRecord(record).git;
        output(result);
        return result.localOperationsReady ? 0 : 1;
      });
    });

  project
    .command('browser-run')
    .description('launch dedicated Chrome and execute one reviewed WebGPU scenario with durable evidence')
    .argument('<project-id>')
    .requiredOption('--scenario <file>', 'reviewed JSON scenario')
    .requiredOption('--sha256 <digest>', 'exact SHA-256 of the reviewed scenario file')
    .requiredOption('--build-id <id>', 'expected build identity reported by the served app')
    .option('--phase <name>', 'canary, baseline or candidate', 'canary')
    .option('--baseline <execution-id>', 'baseline evidence to compare with a candidate run')
    .action(async (projectId: string, options: BrowserRunOptions) => {
      process.exitCode = await guardedAsync(() => {
        const groupOptions = project.opts<ProjectGroupOptions>();
        if (groupOptions.profilesRoot !== undefined) {
          throw new Error('Browser scenarios use the active startup registry. Omit --profiles-root.');
        }
        return commandProjectBrowserRun(findRepoRoot(groupOptions.repoRoot), projectId, options);
      });
    });

  project
    .command('test-chrome')
    .description('attach to the configured debug endpoint and verify one exact allowed page target')
    .argument('<project-id>')
    .action(async (projectId: string) => {
      process.exitCode = await guardedAsync(() => withProfileApiAsync(project, projectId, async (service) => {
        const result = await service.testBrowser(projectId);
        output(result);
        return result.ready ? 0 : 1;
      }));
    });

  project
    .command('test-gpt')
    .description('verify credential presence and exact OpenAI model identity without fallback')
    .argument('<project-id>')
    .action(async (projectId: string) => {
      process.exitCode = await guardedAsync(() => withProfileApiAsync(project, projectId, async (service) => {
        const result = await service.testGpt(projectId);
        output(result);
        return result.ready ? 0 : 1;
      }));
    });

  project
    .command('activate')
    .description('set the registry active pointer for the next profile-bound startup')
    .argument('<project-id>')
    .requiredOption('--confirmation <phrase>', 'ACTIVATE <id> <generation> <hash-prefix>')
    .action((projectId: string, options: { readonly confirmation: string }) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const record = context.registry.getProfile(projectId);
        const expected = activationConfirmation(record);
        if (options.confirmation !== expected) throw new Error(`Activation requires exact confirmation: ${expected}`);
        const pointer = context.registry.activate(record.profile.projectId, {
          actor: 'cli',
          reason: 'CLI_NEXT_STARTUP_ACTIVATION',
        }, record);
        output({ pointer, effective: 'next startup or ProjectRuntimeManager live switch' });
        return 0;
      });
    });

  project
    .command('migrate-legacy')
    .description('explicitly convert the current configuration-v2 target to one durable profile')
    .requiredOption('--confirmation <phrase>', 'MIGRATE LEGACY ACTIVE TARGET')
    .action((options: { readonly confirmation: string }) => {
      process.exitCode = guarded(() => {
        if (options.confirmation !== 'MIGRATE LEGACY ACTIVE TARGET') {
          throw new Error('Legacy migration requires exact confirmation: MIGRATE LEGACY ACTIVE TARGET');
        }
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const result = migrateLegacyActiveTarget({
          repoRoot: context.repoRoot,
          registry: context.registry,
          actor: 'cli',
        });
        output({
          ...result,
          next: `clue project adopt-legacy ${result.registered.profile.projectId} --confirmation \"${adoptionConfirmation(result.registered)}\"`,
        });
        return 0;
      });
    });

  project
    .command('adopt-legacy')
    .description('write workspace ownership for a migrated legacy profile without rewriting history')
    .argument('<project-id>')
    .requiredOption('--confirmation <phrase>', 'ADOPT LEGACY WORKSPACE <id> <generation> <hash-prefix>')
    .action((projectId: string, options: { readonly confirmation: string }) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const record = context.registry.getProfile(projectId);
        const expected = adoptionConfirmation(record);
        if (options.confirmation !== expected) throw new Error(`Legacy adoption requires exact confirmation: ${expected}`);
        output(adoptLegacyWorkspaceForProfile(record));
        return 0;
      });
    });

  project
    .command('prepare-dashboard')
    .description('prompt to bind dashboard startup to the exact saved active profile')
    .action(async () => {
      process.exitCode = await guardedAsync(async () => {
        const options = project.opts<ProjectGroupOptions>();
        const repoRoot = findRepoRoot(options.repoRoot);
        if (loadProjectProfileStartup(repoRoot) !== null) return 0;
        const context = projectContext(options);
        return prepareDashboardStartup(context.repoRoot, context.registry);
      });
    });

  project
    .command('cutover-v3')
    .description('enable profile-bound startup for a validated, initialized workspace')
    .argument('<project-id>')
    .requiredOption('--confirmation <phrase>', 'CUTOVER <id> <generation> <hash-prefix>')
    .action((projectId: string, options: { readonly confirmation: string }) => {
      process.exitCode = guarded(() => {
        const context = projectContext(project.opts<ProjectGroupOptions>());
        const record = context.registry.getProfile(projectId);
        const expected = projectProfileCutoverConfirmation(record);
        if (options.confirmation !== expected) throw new Error(`Configuration-v3 cutover requires exact confirmation: ${expected}`);
        output(enableProjectProfileStartup({
          repoRoot: context.repoRoot,
          registry: context.registry,
          projectId,
          confirmation: options.confirmation,
          actor: 'cli',
          verifyWorkspace: (candidate) => {
            const validation = validateProjectProfileRecord(candidate);
            if (!validation.valid) throw new Error(`Run project validate ${candidate.profile.projectId} and resolve the validation issues before cutover.`);
            verifyProjectStartupWorkspace(context.repoRoot, candidate);
          },
        }));
        return 0;
      });
    });

  project
    .command('rollback-v3')
    .description('disable profile-bound startup only; preserve all profile/state/history data')
    .requiredOption('--confirmation <phrase>', 'DISABLE PROJECT PROFILE STARTUP')
    .action((options: { readonly confirmation: string }) => {
      process.exitCode = guarded(() => {
        if (options.confirmation !== 'DISABLE PROJECT PROFILE STARTUP') {
          throw new Error('Rollback requires exact confirmation: DISABLE PROJECT PROFILE STARTUP');
        }
        const repoRoot = findRepoRoot(project.opts<ProjectGroupOptions>().repoRoot);
        output({ disabled: disableProjectProfileStartup(repoRoot), profileDataDeleted: false });
        return 0;
      });
    });
}

function projectContext(options: ProjectGroupOptions): ProjectContext {
  const repoRoot = options.repoRoot === undefined ? findRepoRoot() : findRepoRoot(options.repoRoot);
  const legacy = resolveConfigPaths(loadLegacyConfig(repoRoot), repoRoot);
  const profilesRoot = configuredProjectProfilesRoot(
    repoRoot,
    legacy.workspace.root,
    options.profilesRoot,
  );
  return { repoRoot, profilesRoot, registry: new ProjectProfileRegistry(profilesRoot) };
}

function withProfileApi(
  project: Command,
  projectId: string,
  work: (service: ProjectProfilesApiService) => number,
): number {
  const context = projectContext(project.opts<ProjectGroupOptions>());
  const record = context.registry.getProfile(projectId);
  const runtime = openProjectRuntime(record, {
    withLog: false,
    readOnly: true,
    repoRoot: context.repoRoot,
  });
  try {
    return work(new ProjectProfilesApiService({ registry: context.registry, runtime, actor: 'cli' }));
  } finally {
    runtime.dispose();
  }
}

async function withProfileApiAsync(
  project: Command,
  projectId: string,
  work: (service: ProjectProfilesApiService) => Promise<number>,
): Promise<number> {
  const context = projectContext(project.opts<ProjectGroupOptions>());
  const record = context.registry.getProfile(projectId);
  const runtime = openProjectRuntime(record, {
    withLog: false,
    readOnly: true,
    repoRoot: context.repoRoot,
  });
  try {
    return await work(new ProjectProfilesApiService({ registry: context.registry, runtime, actor: 'cli' }));
  } finally {
    runtime.dispose();
  }
}

function readProfileDraft(path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Cannot read Project Profile JSON ${path}: ${(error as Error).message}`);
  }
  assertNoSecretMaterial(parsed, `Project Profile draft ${path}`);
  const candidate =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'profile' in parsed
      ? (parsed as Record<string, unknown>)['profile']
      : parsed;
  return projectProfileSchema.parse(candidate);
}

function activationConfirmation(record: ProjectProfileRecord): string {
  return `ACTIVATE ${record.profile.projectId} ${record.generation} ${record.projectProfileHash.slice(0, 12)}`;
}

function adoptionConfirmation(record: ProjectProfileRecord): string {
  return `ADOPT LEGACY WORKSPACE ${record.profile.projectId} ${record.generation} ${record.projectProfileHash.slice(0, 12)}`;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function readinessOperation(
  value: string,
): 'local-proof' | 'ai-candidate' | 'browser-benchmark' | 'publication' {
  if (value === 'local-proof' || value === 'ai-candidate' || value === 'browser-benchmark' || value === 'publication') return value;
  throw new Error(`--operation must be local-proof, ai-candidate, browser-benchmark, or publication; got ${JSON.stringify(value)}.`);
}

function output(value: unknown): void {
  assertNoSecretMaterial(value, 'CLI Project Profile output');
  write(JSON.stringify(value, null, 2));
}

function guarded(work: () => number): number {
  try {
    return work();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function guardedAsync(work: () => Promise<number>): Promise<number> {
  try {
    return await work();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
