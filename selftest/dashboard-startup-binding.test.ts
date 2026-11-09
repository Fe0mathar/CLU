import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { bindSavedDashboardProfile } from '../src/cli/dashboardStartup.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { loadActiveProjectProfileForStartup, projectProfileStartupPath } from '../src/control/projectProfiles/projectProfileStartup.js';
import { openRuntime } from '../src/control/runtime.js';
import { startClueDashboard, type ClueDashboardOptions } from '../src/daemon/clueDashboardServer.js';
import type { DashboardChromeTestReceipt } from '../src/daemon/dashboardChromeTest.js';
import type { DashboardSessionTestReceipt } from '../src/daemon/dashboardSessionTest.js';
import { DASHBOARD_WEBGPU_CANARY_URL } from '../src/daemon/dashboardWebGpuCanary.js';
import { validateProjectProfileRecord } from '../src/daemon/projectProfilesApi.js';
import type { BrowserScenarioReport } from '../src/experiment/browser/browserScenario.js';
import { manualProjectGitSync } from '../src/integration/git/manualGitSync.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { proofReadyProfile } from './project-governance-fixture.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation } from './project-recognition-fixture.js';

function setup(t: TestContext, branch = 'main') {
  const fixture = makeProjectProfileFixture({ projectId: 'clue1' });
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  const profile = proofReadyProfile(fixture);

  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: fixture.target,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const remote = 'https://github.com/example/clue-target.git';
  git('init', '--initial-branch', branch);
  git('remote', 'add', 'origin', remote);
  git('add', '--all');
  git('-c', 'user.name=CLU-E fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=.git/no-hooks',
    'commit', '--message', 'Initial fixture');
  const pendingFile = join(fixture.target, 'pending.txt');
  writeFileSync(pendingFile, 'Uncommitted operator work\n', 'utf8');

  const registry = new ProjectProfileRegistry(fixture.profilesRoot);
  const record = registry.create({
    ...profile,
    integrations: {
      ...profile.integrations,
      git: {
        ...profile.integrations.git,
        publicationMode: 'REMOTE_REGISTERED',
        provider: 'github',
        remote,
      },
      gpt: {
        ...profile.integrations.gpt,
        credential: {
          source: 'project-override',
          defaultKey: 'gateway.credential',
          value: 'env:CLU_FIXTURE_OPENAI_KEY',
        },
      },
    },
  });
  const pointer = registry.activate(record.profile.projectId);
  const configPath = join(fixture.root, 'config', 'clue.config.yaml');
  const selectorPath = projectProfileStartupPath(fixture.root);
  const databasePath = record.profile.state.databasePath;
  return { fixture, git, registry, record, pointer, configPath, selectorPath, databasePath, pendingFile };
}

test('dashboard profile binding initializes the selected native workspace with uncommitted changes intact', (t) => {
  const { fixture, git, registry, record, pointer, configPath, selectorPath, databasePath, pendingFile } = setup(t);
  const legacyConfig = readFileSync(configPath);
  const oldHead = git('rev-parse', 'HEAD');
  assert.equal(validateProjectProfileRecord(record).git.code, 'DIRTY_WORKTREE');
  assert.equal(loadActiveProjectProfileForStartup(fixture.root), null);
  assert.equal(existsSync(databasePath), false);

  const cutover = bindSavedDashboardProfile(fixture.root, registry, pointer);
  assert.equal(cutover.state, 'enabled');
  assert.equal(cutover.selectorPath, selectorPath);
  assert.equal(existsSync(databasePath), true);
  assert.deepEqual(readFileSync(configPath), legacyConfig);
  assert.deepEqual(readFileSync(cutover.backupPath), legacyConfig);
  assert.equal(git('rev-parse', 'HEAD'), oldHead);
  assert.equal(git('status', '--porcelain=v1'), '?? pending.txt');
  assert.equal(readFileSync(pendingFile, 'utf8'), 'Uncommitted operator work\n');

  const startup = loadActiveProjectProfileForStartup(fixture.root);
  assert.equal(startup?.pointer.projectId, pointer.projectId);
  assert.equal(startup?.pointer.profileGeneration, pointer.profileGeneration);
  assert.equal(startup?.pointer.projectProfileHash, pointer.projectProfileHash);
  const runtime = openRuntime({ repoRoot: fixture.root, withLog: false, readOnly: true });
  try {
    assert.equal(runtime.profileMode, 'project-profile');
    assert.equal(runtime.config.project.id, 'clue1');
    assert.equal(runtime.config.project.remote, record.profile.integrations.git.remote);
    assert.equal(runtime.config.gateway.api_key_env, 'CLU_FIXTURE_OPENAI_KEY');
    assert.equal(runtime.projections.workspaceIdentity()?.origin, 'new-workspace');
    runtime.requireMission();
    runtime.requireFreshProjections();
  } finally {
    runtime.dispose();
  }

  const sync = manualProjectGitSync(record, operationIdentityFromProfileRecord(record));
  assert.equal(sync.state, 'refused');
  assert.equal(sync.code, 'DIRTY_WORKTREE');
});

test('dashboard profile binding refuses a dirty checkout on the wrong branch', (t) => {
  const { fixture, registry, record, pointer, selectorPath, databasePath } = setup(t, 'other');
  const { git } = validateProjectProfileRecord(record);
  assert.equal(git.code, 'DIRTY_WORKTREE');
  assert.notEqual(git.branch, git.defaultBranch);
  assert.throws(() => bindSavedDashboardProfile(fixture.root, registry, pointer));
  assert.equal(existsSync(selectorPath), false);
  assert.equal(existsSync(databasePath), false);
});

test('dashboard profile binding preserves authority checks alongside the dirty checkout exception', (t) => {
  const { fixture, registry, record, pointer, selectorPath, databasePath } = setup(t);
  writeFileSync(fixture.targetDescription, 'Changed governed requirements\n', 'utf8');
  const validation = validateProjectProfileRecord(record);
  assert.equal(validation.authority.state, 'DRIFTED');
  assert.equal(validation.git.code, 'DIRTY_WORKTREE');
  assert.throws(() => bindSavedDashboardProfile(fixture.root, registry, pointer));
  assert.equal(existsSync(selectorPath), false);
  assert.equal(existsSync(databasePath), false);
});

test('dashboard profile binding refuses a generation changed after the operator preview', (t) => {
  const { fixture, registry, record, pointer, selectorPath, databasePath } = setup(t);
  const updated = registry.update({ ...record.profile, displayName: 'Updated after preview' }, record.generation);
  assert.equal(registry.active()?.profileGeneration, updated.generation);
  assert.throws(() => bindSavedDashboardProfile(fixture.root, registry, pointer));
  assert.equal(existsSync(selectorPath), false);
  assert.equal(existsSync(databasePath), false);
});

test('Test Chrome keeps its completed pass until the dashboard daemon restarts', { timeout: 15_000 }, async (t) => {
  const { fixture, registry, record } = setup(t);
  const updated = registry.update({
    ...record.profile, integrations: {
      ...record.profile.integrations, chrome: {
        ...record.profile.integrations.chrome, launchMode: 'CLUE_MANAGED',
        targetUrl: DASHBOARD_WEBGPU_CANARY_URL, allowedOrigins: [new URL(DASHBOARD_WEBGPU_CANARY_URL).origin],
      },
    },
  }, record.generation);
  const pointer = registry.activate(updated.profile.projectId);
  bindSavedDashboardProfile(fixture.root, registry, pointer);
  const runtime = openRuntime({ repoRoot: fixture.root, withLog: false, readOnly: true });
  t.after(() => runtime.dispose());
  const executionId = `BEXEC-${'1'.repeat(32)}`;
  const report: BrowserScenarioReport = {
    version: 'clue-browser-scenario/1', scenarioId: 'dedicated-webgpu-canary', buildId: 'webgpu-canary-1',
    warmups: 1, repetitions: 3, samples: Array.from({ length: 3 }, () => [{ name: 'gpu-readback', unit: 'count', value: 42 }]),
    metrics: [{ name: 'gpu-readback', unit: 'count', min: 42, median: 42, max: 42 }],
    webgpuWorkloadReported: true, commandExecuted: true, consoleCaptured: true,
    environment: {
      width: 1000, height: 700, devicePixelRatio: 1, visibility: 'visible',
      adapter: { vendor: 'fixture', architecture: 'fixture', isFallbackAdapter: false },
      browser: 'Chrome/fixture', protocolVersion: '1.3',
    },
    console: { warnings: 0, errors: 0, omitted: 0, entries: [] }, screenshotCaptured: true, wallMs: 12,
  };
  let runs = 0;
  let allowFinish: () => void = () => {};
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const finish = new Promise<void>((resolve) => { allowFinish = resolve; });
  const options: ClueDashboardOptions = {
    operator: 'test', port: 0,
    async chromeTestRun(candidate) {
      assert.equal(candidate.projectProfileHash, updated.projectProfileHash);
      runs += 1;
      begin();
      await finish;
      return { status: 'COMPLETED', browserExecutionId: executionId, evidence: 'local-evidence', comparison: null, report };
    },
  };
  const body = {
    projectId: updated.profile.projectId, expectedGeneration: updated.generation, expectedProfileHash: updated.projectProfileHash,
  };
  const post = (base: string, path: string, value: unknown) => fetch(new URL(path, base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  const readChrome = async (base: string): Promise<DashboardChromeTestReceipt> =>
    (await (await post(base, 'api/control/readiness', { capability: 'chrome' })).json()) as DashboardChromeTestReceipt;
  const handle = await startClueDashboard(runtime, options);
  try {
    assert.equal((await readChrome(handle.url)).state, 'pending');
    assert.equal(runs, 0);
    const stale = await post(handle.url, 'api/control/chrome-test', { ...body, expectedGeneration: 1 });
    assert.equal(stale.status, 409);
    assert.equal(runs, 0);
    const running = post(handle.url, 'api/control/chrome-test', body);
    await started;
    assert.equal((await readChrome(handle.url)).state, 'pending');
    allowFinish();
    const result = (await (await running).json()) as DashboardChromeTestReceipt;
    assert.equal(runs, 1);
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.gpuReadbacks, [42, 42, 42]);
    assert.equal(result.executionId, executionId);
    assert.deepEqual(await readChrome(handle.url), result);
    const config = (await (await fetch(new URL('api/config', handle.url))).json()) as { chromeTest: DashboardChromeTestReceipt };
    assert.deepEqual(config.chromeTest, result);
    assert.equal(runs, 1);
  } finally {
    allowFinish();
    await handle.stop();
  }
  const restarted = await startClueDashboard(runtime, options);
  try {
    assert.equal((await readChrome(restarted.url)).state, 'pending');
    assert.equal(runs, 1);
  } finally {
    await restarted.stop();
  }
});

test('Test Console verifies the running profile and retains its result only for the daemon session', { timeout: 15_000 }, async (t) => {
  const { fixture, registry, record, pointer } = setup(t);
  bindSavedDashboardProfile(fixture.root, registry, pointer);
  const runtime = openRuntime({ repoRoot: fixture.root, withLog: false, readOnly: true });
  t.after(() => runtime.dispose());

  let runs = 0;
  let begin: () => void = () => {};
  let allowFinish: () => void = () => {};
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const finish = new Promise<void>((resolve) => { allowFinish = resolve; });
  const options: ClueDashboardOptions = {
    operator: 'test', port: 0,
    async consoleTestRun(candidateRuntime, candidateRecord) {
      assert.equal(candidateRuntime, runtime);
      assert.equal(candidateRecord.projectProfileHash, record.projectProfileHash);
      runs += 1;
      begin();
      await finish;
      return { state: 'ready', summary: 'Verified governed workspace operation.', checks: [] };
    },
  };
  const body = {
    projectId: record.profile.projectId, expectedGeneration: record.generation, expectedProfileHash: record.projectProfileHash,
  };
  const post = (base: string, path: string, value: unknown, origin?: string) => fetch(new URL(path, base), {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) },
    body: JSON.stringify(value),
  });
  const readConsole = async (base: string): Promise<DashboardSessionTestReceipt> =>
    (await (await post(base, 'api/control/readiness', { capability: 'console' })).json()) as DashboardSessionTestReceipt;
  const handle = await startClueDashboard(runtime, options);
  try {
    assert.equal((await readConsole(handle.url)).state, 'pending');
    assert.equal((await post(handle.url, 'api/control/console-test', { ...body, expectedGeneration: record.generation + 1 })).status, 409);
    assert.equal((await post(handle.url, 'api/control/console-test', { ...body, command: 'Get-Process' })).status, 400);
    assert.equal((await post(handle.url, 'api/control/console-test', body, 'https://other.example')).status, 403);
    assert.equal(runs, 0);

    const running = post(handle.url, 'api/control/console-test', body);
    await started;
    assert.match((await readConsole(handle.url)).summary, /Running Test Console/u);
    allowFinish();
    const result = (await (await running).json()) as DashboardSessionTestReceipt;
    assert.equal(result.state, 'ready');
    assert.equal(result.profileGeneration, record.generation);
    assert.deepEqual(result.projectIdentity, operationIdentityFromProfileRecord(record));
    assert.ok(result.testedAt);
    assert.equal(result.checks.find((check) => check.label === 'Elevated operations')?.state, 'unknown');
    assert.deepEqual(await readConsole(handle.url), result);
    const config = (await (await fetch(new URL('api/config', handle.url))).json()) as { consoleTest: DashboardSessionTestReceipt };
    assert.deepEqual(config.consoleTest, result);
    assert.equal(runs, 1);
  } finally {
    allowFinish();
    await handle.stop();
  }
  const restarted = await startClueDashboard(runtime, options);
  try {
    assert.equal((await readConsole(restarted.url)).state, 'pending');
    assert.equal(runs, 1);
  } finally {
    await restarted.stop();
  }
});
