/** PP-21 — explicit Project Profile PowerShell/host readiness states and identity parity. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { realpathSync, writeFileSync } from 'node:fs';

import {
  resolveProjectHostLaunchBinding,
  testProjectHostReadiness,
  type ProjectHostLaunchBinding,
} from '../src/control/projectProfiles/hostReadiness.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';

function readyBanner(binding: ProjectHostLaunchBinding) {
  return {
    host: 'clue-host',
    protocol: 1,
    pwshVersion: '7.5.2',
    os: process.platform,
    roots: binding.roots,
    projectIdentity: binding.projectIdentity,
  } as const;
}

test('matching executable, roots, handshake and project identity produce READY', async (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });

  const result = await testProjectHostReadiness(record, {
    globalPowerShellExecutable: process.execPath,
    checkedAt: '2026-08-14T20:00:00.000Z',
    probe: async (binding) => readyBanner(binding),
  });
  assert.equal(result.state, 'READY');
  assert.equal(result.ready, true);
  assert.equal(result.code, 'HOST_READY');
  assert.ok(result.binding !== null);
  assert.deepEqual(result.banner?.projectIdentity, result.binding.projectIdentity);
  assert.equal(result.binding.roots.canonical, realpathSync.native(fixture.target));
});


test('a bare PowerShell command resolves through PATH instead of being treated as a missing file', async (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const command = process.platform === 'win32' ? 'pwsh-test.exe' : 'pwsh-test';
  const executable = join(fixture.root, command);
  writeFileSync(executable, 'test executable placeholder');
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const initial = registry.create(fixture.profile, { actor: 'creator' });
  const profile = cloneProfile(initial.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const powershell = integrations['powershell'] as Record<string, unknown>;
    powershell['executable'] = {
      source: 'project-override',
      defaultKey: 'powershell.executable',
      value: command,
    };
  });
  const record = registry.update(profile, initial.generation, { actor: 'creator' });

  const result = await testProjectHostReadiness(record, {
    globalPowerShellExecutable: 'unused',
    environment: { PATH: fixture.root, PATHEXT: '.EXE' },
    probe: async (binding) => readyBanner(binding),
  });
  assert.equal(result.state, 'READY');
  assert.equal(result.binding?.executable, executable);
});

test('unavailable executable and invalid host script are distinguished', async (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const initial = registry.create(fixture.profile, { actor: 'creator' });

  const unavailableProfile = cloneProfile(initial.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const powershell = integrations['powershell'] as Record<string, unknown>;
    powershell['executable'] = {
      source: 'project-override',
      defaultKey: 'powershell.executable',
      value: join(fixture.root, 'missing-pwsh.exe'),
    };
  });
  const unavailable = registry.update(unavailableProfile, initial.generation, { actor: 'creator' });
  const unavailableResult = await testProjectHostReadiness(unavailable, {
    globalPowerShellExecutable: process.execPath,
    probe: async (binding) => readyBanner(binding),
  });
  assert.equal(unavailableResult.state, 'UNAVAILABLE');
  assert.equal(unavailableResult.code, 'HOST_EXECUTABLE_UNAVAILABLE');

  const invalidScriptProfile = cloneProfile(unavailable.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const powershell = integrations['powershell'] as Record<string, unknown>;
    powershell['executable'] = {
      source: 'project-override',
      defaultKey: 'powershell.executable',
      value: process.execPath,
    };
    powershell['hostScript'] = join(fixture.root, 'missing-host.ps1');
  });
  const invalidScript = registry.update(invalidScriptProfile, unavailable.generation, { actor: 'creator' });
  const invalidResult = await testProjectHostReadiness(invalidScript, {
    globalPowerShellExecutable: process.execPath,
    probe: async (binding) => readyBanner(binding),
  });
  assert.equal(invalidResult.state, 'INVALID PATH');
  assert.equal(invalidResult.code, 'HOST_SCRIPT_INVALID');
});

test('handshake root or project identity mismatch fails closed as ROOT MISMATCH', async (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });

  const rootMismatch = await testProjectHostReadiness(record, {
    globalPowerShellExecutable: process.execPath,
    probe: async (binding) => ({
      ...readyBanner(binding),
      roots: { ...binding.roots, shadow: join(fixture.root, 'wrong-shadow') },
    }),
  });
  assert.equal(rootMismatch.state, 'ROOT MISMATCH');
  assert.equal(rootMismatch.code, 'HOST_ROOT_OR_IDENTITY_MISMATCH');

  const identityMismatch = await testProjectHostReadiness(record, {
    globalPowerShellExecutable: process.execPath,
    probe: async (binding) => ({
      ...readyBanner(binding),
      projectIdentity: {
        ...binding.projectIdentity,
        projectProfileHash: `profile:v1:${'f'.repeat(64)}`,
      },
    }),
  });
  assert.equal(identityMismatch.state, 'ROOT MISMATCH');
  assert.equal(identityMismatch.code, 'HOST_ROOT_OR_IDENTITY_MISMATCH');
});

test('a failed controlled probe is HANDSHAKE FAILED and never READY', async (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });
  assert.doesNotThrow(() => resolveProjectHostLaunchBinding(record, process.execPath));

  const result = await testProjectHostReadiness(record, {
    globalPowerShellExecutable: process.execPath,
    probe: async () => {
      throw new Error('host process exited before hello');
    },
  });
  assert.equal(result.state, 'HANDSHAKE FAILED');
  assert.equal(result.ready, false);
  assert.equal(result.code, 'HOST_HANDSHAKE_FAILED');
});
