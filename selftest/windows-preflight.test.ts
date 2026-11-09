import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import {
  enableProjectProfileStartup,
  projectProfileCutoverConfirmation,
  projectProfileStartupPath,
} from '../src/control/projectProfiles/projectProfileStartup.js';
import { bootstrapProjectWorkspace } from '../src/control/projectProfiles/projectWorkspaceBootstrap.js';
import { runWindowsPreflight, type WindowsPreflightReport } from '../src/control/projectProfiles/windowsPreflight.js';
import { proofReadyProfile } from './project-governance-fixture.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation } from './project-recognition-fixture.js';

const FAKE_CREDENTIAL = 'sk-p01-regression-fixture-never-expose';

function inventory(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const path = join(root, entry.name);
    return [entry.name, entry.isDirectory() ? inventory(path) : readFileSync(path)];
  });
}

function setup(t: TestContext) {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  writeFileSync(join(fixture.root, 'package.json'), '{"name":"p01-fixture"}\n', 'utf8');
  const registry = new ProjectProfileRegistry(fixture.profilesRoot);
  const record = registry.create(proofReadyProfile(fixture), { actor: 'creator' });
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: fixture.target,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--initial-branch=main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'CLU-E preflight fixture');
  git('config', 'user.email', 'preflight@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(fixture.target, '.gitattributes'), 'target-description.md filter=p01test\n', 'utf8');
  git('add', '.');
  git('-c', 'core.hooksPath=.git/no-hooks', 'commit', '-m', 'Initialize preflight fixture');
  const workspace = bootstrapProjectWorkspace({
    repoRoot: fixture.root,
    registry,
    projectId: record.profile.projectId,
    expectedGeneration: record.generation,
    expectedProfileHash: record.projectProfileHash,
  });
  enableProjectProfileStartup({
    repoRoot: fixture.root,
    registry,
    projectId: record.profile.projectId,
    confirmation: projectProfileCutoverConfirmation(record),
  });
  return { fixture, record, git, workspace };
}

test('P01 CLI reports the active profile, authority, benchmark and Git without writing project state', (t) => {
  const { fixture, record, git, workspace } = setup(t);
  git('config', 'remote.origin.url', `https://${FAKE_CREDENTIAL}@example.invalid/target`);
  git('config', 'filter.p01unused.clean', 'cat; touch .git/p01-unused-filter-executed');
  const before = inventory(fixture.root);
  const child = spawnSync(process.execPath, [
    resolve('dist/src/cli/index.js'), 'project', '--repo-root', fixture.root, 'preflight',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENAI_API_KEY: FAKE_CREDENTIAL,
      CLU_WINDOWS_SUPERVISOR_PATH: '',
      CLU_WINDOWS_SUPERVISOR_SHA256: '',
    },
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  const report = JSON.parse(child.stdout) as WindowsPreflightReport;
  assert.equal(report.schemaVersion, 'clue-windows-preflight/1');
  assert.equal(report.status, process.platform === 'win32' ? 'BLOCKED' : 'NOT_WINDOWS');
  assert.ok(report.profile !== null);
  assert.equal(report.profile.projectId, record.profile.projectId);
  assert.equal(report.profile.profileGeneration, record.generation);
  assert.equal(report.profile.projectProfileHash, record.projectProfileHash);
  assert.equal(report.profile.targetRootIdentity, record.profile.targetRootIdentity);
  assert.equal(report.authority?.state, 'CURRENT');
  assert.equal(report.benchmark?.state, 'READY');
  assert.equal(report.workspace?.ownerProjectId, record.profile.projectId);
  assert.equal(report.mission?.id, workspace.missionId);
  assert.equal(report.mission?.state, 'CURRENT');
  assert.equal(report.liveAcceptance.status, 'NOT_RUN');
  assert.equal(report.git?.branch, 'main');
  assert.equal(report.git.head, git('rev-parse', 'HEAD'));
  assert.equal(report.git?.dirty, false);
  const override = spawnSync(process.execPath, [
    resolve('dist/src/cli/index.js'), 'project', '--repo-root', fixture.root,
    '--profiles-root', fixture.profilesRoot, 'preflight',
  ], { encoding: 'utf8' });
  assert.equal(override.status, 1);
  assert.match(override.stderr, /saved startup registry/u);
  assert.equal(override.stdout, '');
  assert.deepEqual(inventory(fixture.root), before);
  assert.equal(`${child.stdout}\n${child.stderr}`.includes(FAKE_CREDENTIAL), false);
});

test('P01 identifies authority drift and a dirty local-only checkout independently', (t) => {
  const { fixture, record } = setup(t);
  appendFileSync(fixture.targetDescription, `\n${FAKE_CREDENTIAL}\n`, 'utf8');
  const before = inventory(fixture.root);
  const report = runWindowsPreflight(fixture.root);

  assert.equal(report.profile?.projectProfileHash, record.projectProfileHash);
  assert.equal(report.authority?.state, 'DRIFTED');
  const changed = report.authority.documents.find(({ bindingId }) => bindingId === 'target-description');
  assert.ok(changed);
  assert.notEqual(changed.observedSha256, changed.configuredSha256);
  assert.ok(report.blockers.some(({ code }) => code === 'PROJECT_AUTHORITY_DRIFTED'));
  assert.equal(report.git?.dirty, true);
  assert.ok(report.blockers.some(({ code }) => code === 'DIRTY_WORKTREE'));
  assert.equal(JSON.stringify(report).includes(FAKE_CREDENTIAL), false);
  assert.deepEqual(inventory(fixture.root), before);
});

test('P01 refuses a pending profile transaction without recovering it', (t) => {
  const { fixture } = setup(t);
  const transaction = join(fixture.profilesRoot, '.transactions', 'preflight-pending.json');
  writeFileSync(transaction, 'fixture transaction marker', 'utf8');
  const before = inventory(fixture.root);
  const report = runWindowsPreflight(fixture.root);

  assert.equal(report.profile, null);
  assert.ok(report.blockers.some(({ code }) => code === 'STARTUP_POINTER_STALE'));
  assert.deepEqual(inventory(fixture.root), before);
});

test('P01 reports a malformed startup selector without falling back to legacy configuration', (t) => {
  const { fixture } = setup(t);
  const selector = projectProfileStartupPath(fixture.root);
  writeFileSync(selector, 'version: 3\nmode: project-profile\n', 'utf8');
  const before = inventory(fixture.root);
  const report = runWindowsPreflight(fixture.root);

  assert.equal(report.profile, null);
  assert.ok(report.blockers.some(({ code }) => code === 'STARTUP_SELECTOR_MALFORMED'));
  assert.deepEqual(inventory(fixture.root), before);

  rmSync(selector);
  const legacy = inventory(fixture.root);
  const missing = runWindowsPreflight(fixture.root);
  assert.equal(missing.profile, null);
  assert.ok(missing.blockers.some(({ id }) => id === 'activeProfile'));
  assert.deepEqual(inventory(fixture.root), legacy);
});

test('P01 blocks Git inspection before configured worktree filters can run', (t) => {
  const { fixture, git } = setup(t);
  const marker = join(fixture.target, '.git', 'p01-filter-executed');
  git('config', 'filter.p01test.clean', 'cat; touch .git/p01-filter-executed');
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  utimesSync(fixture.targetDescription, tomorrow, tomorrow);
  const before = inventory(fixture.root);
  const report = runWindowsPreflight(fixture.root);

  assert.ok(report.blockers.some(({ code }) => code === 'GIT_EXTERNAL_FILTER_CONFIGURED'));
  assert.equal(existsSync(marker), false);
  assert.deepEqual(inventory(fixture.root), before);
});
