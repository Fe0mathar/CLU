/** Batch 6 — server-authoritative Project Profile API and safety boundaries. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Runtime } from '../src/control/runtime.js';
import { join } from 'node:path';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/index.js';
import {
  deleteConfirmation,
  handleProjectProfilesApiRequest,
  ProjectProfilesApiError,
  ProjectProfilesApiService,
} from '../src/daemon/projectProfilesApi.js';
import type { ProjectProfileRecord } from '../src/shared/schemas.js';
import {
  cloneProfile,
  makeProjectProfileFixture,
} from './project-profile-fixture.js';

function minimalRuntime(repoRoot: string): Runtime {
  return {
    repoRoot,
    projectProfile: null,
  } as unknown as Runtime;
}

test('An empty registry prepares and saves its first profile without a template', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    const runtime = {
      ...minimalRuntime(fixture.root),
      config: {
        powershell: { autonomous_profile: 'restricted' },
        browser: { remote_debugging_port: 9222, allowed_origins: ['http://localhost:*'] },
        gateway: { enabled: false },
      },
    } as unknown as Runtime;
    const service = new ProjectProfilesApiService({ registry, runtime });
    const result = service.prepareDraft({
      projectId: 'first',
      templateProjectId: null,
      targetRoot: fixture.target,
      workspaceRoot: fixture.workspace,
      shadowRoot: join(fixture.root, 'first-shadow'),
    }) as { templateProjectId: string | null; profile: ProjectProfileRecord['profile'] };
    assert.equal(result.templateProjectId, null);
    assert.equal(result.profile.authority.masterBenchmark, null);
    assert.equal(result.profile.integrations.chrome.executable.defaultKey, 'browser.executable');
    assert.equal(result.profile.integrations.powershell.projectRoot, result.profile.targetRoot);
    assert.equal(result.profile.integrations.gpt.credential.source, 'global-default');
    assert.equal(registry.listMetadata().length, 0);
    const saved = service.create(result.profile) as { record: ProjectProfileRecord };
    assert.equal(saved.record.generation, 1);
    assert.equal(registry.getProfile('first').profile.projectId, 'first');
    assert.equal(registry.active(), null);
  } finally {
    fixture.dispose();
  }
});

test('Profile connections require local access and a current profile generation before host actions', async () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    const record = registry.create(fixture.profile, { actor: 'daemon', reason: 'TEST_CREATE' });
    const projectId = record.profile.projectId;
    const runtime = minimalRuntime(fixture.root);
    const remote = new ProjectProfilesApiService({ registry, runtime });
    const local = new ProjectProfilesApiService({ registry, runtime, allowHostConnections: true });
    assert.throws(() => remote.signInGitHub(projectId), { code: 'LOCAL_DASHBOARD_REQUIRED' });
    assert.throws(() => remote.listGitHub(projectId), { code: 'LOCAL_DASHBOARD_REQUIRED' });
    assert.throws(() => remote.openAiKeyStatus(projectId), { code: 'LOCAL_DASHBOARD_REQUIRED' });
    await assert.rejects(remote.setOpenAiKey(projectId, record.generation), { code: 'LOCAL_DASHBOARD_REQUIRED' });
    await assert.rejects(local.setOpenAiKey(projectId, record.generation + 1), { code: 'PROFILE_PRECONDITION_FAILED' });
    await assert.rejects(
      local.connectGitHub(projectId, record.generation + 1, 'owner/repository', 'main'),
      { code: 'PROFILE_PRECONDITION_FAILED' },
    );
    await assert.rejects(remote.openTestChrome(projectId, record.generation), { code: 'LOCAL_DASHBOARD_REQUIRED' });
    await assert.rejects(local.openTestChrome(projectId, record.generation + 1), { code: 'PROFILE_PRECONDITION_FAILED' });
    assert.deepEqual(registry.getProfile(projectId), record);
  } finally {
    fixture.dispose();
  }
});

test('Batch 6: API CRUD enforces generation, secret and profile-only deletion safety', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    const service = new ProjectProfilesApiService({
      registry,
      runtime: minimalRuntime(fixture.root),
      actor: 'daemon',
    });

    const created = service.create(fixture.profile) as { readonly record: ProjectProfileRecord };
    assert.equal(created.record.generation, 1);
    assert.equal(registry.listMetadata().length, 1);

    const changed = cloneProfile(created.record.profile, (draft) => {
      draft['displayName'] = 'ALPHA UPDATED';
    });
    const updated = service.update(
      created.record.profile.projectId,
      changed,
      created.record.generation,
    ) as { readonly record: ProjectProfileRecord };
    assert.equal(updated.record.generation, 2);
    assert.equal(updated.record.profile.displayName, 'ALPHA UPDATED');

    assert.throws(
      () => service.update(updated.record.profile.projectId, changed, 1),
      (error: unknown) =>
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'GENERATION_CONFLICT',
    );

    assert.throws(
      () => service.create({
        projectId: 'secret-profile',
        integrations: {
          gpt: {
            credential: { value: 'sk-proj-this-must-never-enter-the-profile-store' },
          },
        },
      }),
      /secret|credential/i,
    );

    assert.throws(
      () => service.delete(
        updated.record.profile.projectId,
        updated.record.generation,
        'DELETE PROFILE alpha wrong-generation wrong-hash',
      ),
      (error: unknown) =>
        error instanceof ProjectProfilesApiError &&
        error.code === 'DELETE_CONFIRMATION_REQUIRED',
    );

    const receipt = service.delete(
      updated.record.profile.projectId,
      updated.record.generation,
      deleteConfirmation(updated.record),
    ) as {
      readonly deleted: boolean;
      readonly targetRepositoryDeleted: boolean;
      readonly projectWorkspaceDeleted: boolean;
    };
    assert.equal(receipt.deleted, true);
    assert.equal(receipt.targetRepositoryDeleted, false);
    assert.equal(receipt.projectWorkspaceDeleted, false);
    assert.equal(existsSync(fixture.target), true, 'target repository must survive profile deletion');
    assert.equal(existsSync(fixture.workspace), true, 'workspace must survive profile deletion');
    assert.equal(registry.get(updated.record.profile.projectId), null);
  } finally {
    fixture.dispose();
  }
});

test('Batch 6: live API activation fails closed without an atomic runtime switch seam', async () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    const record = registry.create(fixture.profile, { actor: 'daemon', reason: 'TEST_CREATE' });
    const service = new ProjectProfilesApiService({
      registry,
      runtime: minimalRuntime(fixture.root),
      actor: 'daemon',
    });

    await assert.rejects(
      () => service.activate(
        record.profile.projectId,
        record.generation,
        record.projectProfileHash,
      ),
      (error: unknown) =>
        error instanceof ProjectProfilesApiError &&
        error.code === 'RUNTIME_SWITCH_UNAVAILABLE',
    );
    assert.equal(registry.active(), null, 'registry must not diverge from the live runtime');
  } finally {
    fixture.dispose();
  }
});

test('Batch 6: HTTP clients cannot spoof the durable mutation actor', async () => {
  const fixture = makeProjectProfileFixture();
  try {
    const body = JSON.stringify({ profile: fixture.profile, actor: 'creator' });
    const request = Readable.from([body]) as unknown as IncomingMessage;
    Object.defineProperty(request, 'method', { value: 'POST' });

    let createArguments: readonly unknown[] = [];
    const fakeService = {
      create: (...arguments_: readonly unknown[]) => {
        createArguments = arguments_;
        return { created: true };
      },
    } as unknown as ProjectProfilesApiService;

    let status = 0;
    let responseBody = '';
    const response = {
      writeHead(code: number): void {
        status = code;
      },
      end(value?: string): void {
        responseBody = value ?? '';
      },
    } as unknown as ServerResponse;

    const handled = await handleProjectProfilesApiRequest(
      request,
      response,
      fakeService,
      new URL('http://127.0.0.1/api/projects'),
    );
    assert.equal(handled, true);
    assert.equal(status, 201);
    assert.equal(createArguments.length, 1, 'HTTP actor is fixed by the server service');
    assert.deepEqual(createArguments[0], fixture.profile);
    assert.equal(JSON.parse(responseBody).ok, true);
  } finally {
    fixture.dispose();
  }
});

test('Batch 7: HTTP preparation endpoints receive direct bodies and return server-derived bindings', async () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    const template = registry.create(fixture.profile, { actor: 'daemon', reason: 'TEST_TEMPLATE' });
    const service = new ProjectProfilesApiService({
      registry,
      runtime: minimalRuntime(fixture.root),
      actor: 'daemon',
      now: () => '2026-08-15T11:00:00.000Z',
    });

    async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
      const request = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
      Object.defineProperty(request, 'method', { value: 'POST' });
      let status = 0;
      let responseBody = '';
      const response = {
        writeHead(code: number): void { status = code; },
        end(value?: string): void { responseBody = value ?? ''; },
      } as unknown as ServerResponse;
      const handled = await handleProjectProfilesApiRequest(
        request,
        response,
        service,
        new URL(`http://127.0.0.1${path}`),
      );
      assert.equal(handled, true);
      return { status, body: JSON.parse(responseBody) };
    }

    const target = `${fixture.root}/api-second-target`;
    const workspace = `${fixture.root}/api-second-workspace`;
    const shadow = `${fixture.root}/api-second-shadow`;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(target, { recursive: true });

    const prepared = await post('/api/projects/prepare-draft', {
      templateProjectId: template.profile.projectId,
      projectId: 'api-project',
      displayName: 'API Project',
      targetRoot: target,
      workspaceRoot: workspace,
      shadowRoot: shadow,
      browserProfileDirectory: null,
    });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.ok, true);
    assert.equal(prepared.body.data.profile.projectId, 'api-project');
    assert.equal(registry.listMetadata().length, 1, 'preparation endpoint must not persist');

    const document = await post('/api/projects/prepare-document', {
      targetRoot: fixture.target,
      path: fixture.targetDescription,
      bindingId: 'target-description',
      kind: 'target-description',
      role: 'product-requirements',
      enabled: false,
      order: 800,
    });
    assert.equal(document.status, 200);
    assert.equal(document.body.ok, true);
    assert.equal(document.body.data.binding.kind, 'target-description');
    assert.equal(document.body.data.binding.enabled, true);
    assert.equal(document.body.data.binding.order, 0);
    assert.equal(document.body.data.binding.lastValidated, '2026-08-15T11:00:00.000Z');
  } finally {
    fixture.dispose();
  }
});

test('Batch 7: HTTP draft preparation returns a structured 409 for duplicate physical targets', async () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    const template = registry.create(fixture.profile, { actor: 'daemon', reason: 'TEST_TEMPLATE' });
    const service = new ProjectProfilesApiService({ registry, runtime: minimalRuntime(fixture.root), actor: 'daemon' });
    const request = Readable.from([JSON.stringify({
      templateProjectId: template.profile.projectId,
      projectId: 'duplicate-target',
      targetRoot: fixture.target,
      workspaceRoot: `${fixture.root}/dup-workspace`,
      shadowRoot: `${fixture.root}/dup-shadow`,
    })]) as unknown as IncomingMessage;
    Object.defineProperty(request, 'method', { value: 'POST' });
    let status = 0;
    let responseBody = '';
    const response = {
      writeHead(code: number): void { status = code; },
      end(value?: string): void { responseBody = value ?? ''; },
    } as unknown as ServerResponse;

    await handleProjectProfilesApiRequest(
      request,
      response,
      service,
      new URL('http://127.0.0.1/api/projects/prepare-draft'),
    );
    const body = JSON.parse(responseBody);
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PROJECT_DRAFT_TARGET_ALREADY_REGISTERED');
    assert.equal(body.error.existingProjectId, template.profile.projectId);
  } finally {
    fixture.dispose();
  }
});
