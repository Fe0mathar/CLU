/**
 * DEV-P1-15 — unified dashboard-server exposure, stream and child-process authority.
 *
 * These tests drive the real HTTP server. They do not duplicate its helper predicates: a request
 * must cross the same Host/Origin/auth gate, a Navigator client must consume the same bounded SSE
 * pump, and a pipeline timeout must terminate the same child process and leave the same receipt an
 * operator reads from `/api/run`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';

import {
  gatewayPipelineStartRefusal,
  startClueDashboard,
  type ClueDashboardHandle,
  type ClueDashboardOptions,
} from '../src/daemon/clueDashboardServer.js';
import {
  withRuntime,
  withRuntimeAsync,
  type Runtime,
} from '../src/control/runtime.js';
import { PROJECTION_SCHEMA_VERSION } from '../src/memory/db.js';

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface RunningServer {
  readonly root: string;
  readonly port: number;
  readonly handle: ClueDashboardHandle;
  readonly runtime: Runtime;
}

function makeRepo(cliSource = 'process.exit(0);\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-dashboard-authority-'));
  const projectRoot = join(root, 'target');
  const workspaceRoot = join(root, 'workspace');

  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(join(root, 'config', 'policies'), { recursive: true });
  mkdirSync(join(root, 'dist', 'src', 'cli'), { recursive: true });
  for (const directory of ['db', 'events', 'blobs', 'logs', 'graph', 'console']) {
    mkdirSync(join(workspaceRoot, directory), { recursive: true });
  }

  writeFileSync(join(root, 'CLUE.md'), '# CLU-E test constitution\n', 'utf8');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }), 'utf8');
  writeFileSync(join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
  writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  writeFileSync(join(root, 'dist', 'src', 'cli', 'index.js'), cliSource, 'utf8');

  const config = {
    version: 2,
    project: {
      id: 'target',
      name: 'Dashboard fixture',
      root: projectRoot,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
      remote: null,
      credential_env: null,
      remote_decision: {
        state: 'NO_REMOTE_YET',
        decision_id: 'P2-D5-NO-REMOTE-YET',
        recorded_at: '2026-08-14',
        recorded_by: 'creator',
        reason: 'Remote publication is intentionally deferred beyond P2 for this dashboard fixture.',
      },
      inputs: { description: null, benchmark: null },
    },
    workspace: { root: workspaceRoot },
    shadow: {
      root: join(root, 'shadow'),
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'npm ci',
    },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: {
      package_manager: 'npm',
      scripts: { typecheck: 'npm run typecheck', build: 'npm run build' },
    },
    browser: {
      executable: join(root, 'chrome.exe'),
      remote_debugging_port: 9222,
      profile_dir: join(root, 'chrome-profile'),
      allowed_origins: ['http://localhost:*'],
      require_webgpu: true,
    },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
    analysis: {
      max_context_tokens: 120000,
      reserve_output_tokens: 20000,
      dynamic_edge_confidence_threshold: 0.75,
      monodependency_percentile: 0.35,
    },
    proof: {
      require_frozen_contract: true,
      inconclusive_counts_as_improvement: false,
      require_baseline: true,
      require_guardrails: true,
    },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: {
      mode: 'NOTIFY',
      policy_file: 'config/policies/patching.yaml',
      landing_branch_prefix: 'clue/accepted/',
      merge_strategy: 'fast_forward_only',
      post_land_verify: ['typecheck'],
      auto_revert_on_post_land_failure: true,
    },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: {
      enabled: false,
      provider: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_mode: 'batch',
      batch_poll_interval_seconds: 300,
      prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] },
      budget_policy_file: 'config/policies/budget.yaml',
      routing_file: 'config/policies/routing.yaml',
    },
    backup: {
      remote: 'origin',
      push_on_verdict: true,
      push_on_landing: true,
      max_remote_staleness_hours: 24,
    },
    security: {
      canonical_source_writes: 'denied',
      real_settlement: 'denied',
      redact_environment: true,
    },
    logging: { level: 'info' },
  };
  writeFileSync(join(root, 'config', 'clue.config.yaml'), toYaml(config), 'utf8');
  writeFileSync(
    join(root, 'config', 'policies', 'p2-closure.yaml'),
    toYaml({
      version: 1,
      phase: 'P2',
      gateway: {
        decision: 'PENDING_CREATOR_DECISION',
        decision_id: null,
        recorded_at: null,
        recorded_by: null,
        reason: 'The dashboard fixture intentionally leaves D4 for the Creator.',
      },
      p3_deferrals: {
        project_intent_model: true,
        environment_adapters: true,
      },
    }),
    'utf8',
  );

  // Install projection schemas and read-side files once; the live dashboard then attaches without
  // the writer, exactly as the CLI does.
  withRuntime({ withLog: true, repoRoot: root }, () => undefined);
  return root;
}

async function freePort(): Promise<number> {
  const probe = createHttpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return address.port;
}

async function withServer<T>(
  root: string,
  options: Omit<ClueDashboardOptions, 'operator' | 'port'>,
  work: (server: RunningServer) => Promise<T>,
): Promise<T> {
  const port = await freePort();
  return withRuntimeAsync(
    { withLog: false, readOnly: true, repoRoot: root },
    async (runtime) => {
      const handle = await startClueDashboard(runtime, {
        operator: 'selftest',
        port,
        refreshIntervalMs: 60_000,
        ...options,
      });
      try {
        return await work({ root, port, handle, runtime });
      } finally {
        await handle.stop();
      }
    },
  );
}

function request(
  port: number,
  pathname: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string | Buffer;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolveRequest({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.once('error', rejectRequest);
    req.end(options.body);
  });
}

function openSse(
  port: number,
  pathname: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly request: ReturnType<typeof httpRequest>; readonly response: IncomingMessage }> {
  return new Promise((resolveSse, rejectSse) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, headers });
    req.once('response', (response) => resolveSse({ request: req, response }));
    req.once('error', rejectSse);
    req.end();
  });
}

function collectSseBlocks(
  response: IncomingMessage,
  wanted: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  return new Promise((resolveBlocks, rejectBlocks) => {
    const blocks: string[] = [];
    let carry = '';
    const timer = setTimeout(() => finish(new Error(`timed out after ${String(timeoutMs)} ms`)), timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      response.off('data', onData);
      response.off('end', onEnd);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error !== undefined) rejectBlocks(error);
      else resolveBlocks(blocks);
    };
    const onData = (chunk: Buffer): void => {
      carry += chunk.toString('utf8');
      for (;;) {
        const separator = carry.indexOf('\n\n');
        if (separator < 0) break;
        const block = carry.slice(0, separator);
        carry = carry.slice(separator + 2);
        if (block.length === 0 || block.startsWith(':')) continue;
        blocks.push(block);
        if (blocks.length >= wanted) {
          finish();
          return;
        }
      }
    };
    const onEnd = (): void => finish(new Error(`stream ended after ${String(blocks.length)} block(s)`));
    const onClose = (): void => {
      if (blocks.length < wanted) finish(new Error(`stream closed after ${String(blocks.length)} block(s)`));
    };
    const onError = (error: Error): void => finish(error);

    response.on('data', onData);
    response.once('end', onEnd);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

async function waitForRunState(port: number, state: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(port, '/api/run');
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    if (parsed['state'] === state) return parsed;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`run did not reach ${state} within ${String(timeoutMs)} ms`);
}

test('DEV-P1-15: non-loopback exposure is refused before listen unless a real token is supplied', async () => {
  const port = await freePort();
  await assert.rejects(
    startClueDashboard({} as Runtime, {
      operator: 'selftest',
      host: '0.0.0.0',
      port,
      authToken: 'too-short',
    }),
    /Refusing to bind.*non-loopback.*authentication/i,
  );
});

test('DEV-P2-04: /api/config exposes the explicit local-only publication decision without a secret value', async () => {
  const root = makeRepo();
  try {
    await withServer(root, {}, async ({ port }) => {
      const result = await request(port, '/api/config');
      assert.equal(result.status, 200, result.body);
      assert.equal(result.headers['cache-control'], 'no-store');
      const body = JSON.parse(result.body) as {
        project?: {
          activeTarget?: string | null;
          publication?: Record<string, unknown>;
        };
      };
      const publication = body.project?.publication;
      assert.ok(publication !== undefined);
      assert.equal(publication['decision'], 'NO_REMOTE_YET');
      assert.equal(publication['decisionId'], 'P2-D5-NO-REMOTE-YET');
      assert.equal(publication['remote'], null);
      assert.equal(publication['credentialEnv'], null);
      assert.equal(publication['localOnly'], true);
      assert.equal(publication['gitLifecycleImplemented'], false);
      assert.equal(publication['publicationPermitted'], false);
      assert.equal(JSON.stringify(body).includes('credentialValue'), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('P2-B6: /api/proof-board exposes a no-store, read-only durable projection', async () => {
  const root = makeRepo();
  try {
    await withServer(root, {}, async ({ port }) => {
      const result = await request(port, '/api/proof-board');
      assert.equal(result.status, 200, result.body);
      assert.equal(result.headers['cache-control'], 'no-store');
      const body = JSON.parse(result.body) as Record<string, unknown>;
      assert.equal(body['schemaVersion'], '1.0.0');
      assert.equal(body['targetId'], 'target');
      const projection = body['projection'] as Record<string, unknown>;
      assert.equal(projection['schemaVersion'], PROJECTION_SCHEMA_VERSION);
      const registered = body['registeredBenchmark'] as Record<string, unknown>;
      assert.equal(registered['state'], 'unregistered');
      assert.equal(registered['integrityVerified'], false);
      const summary = body['summary'] as Record<string, unknown>;
      for (const key of [
        'benchmarkRuns', 'proofAttempts', 'accepts', 'rejects', 'revises',
        'invalids', 'refusals', 'openAttempts',
      ]) assert.equal(summary[key], 0, `${key} is honestly empty`);
      assert.deepEqual(body['benchmarkRuns'], []);
      assert.deepEqual(body['proofAttempts'], []);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'decision'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'verdict'), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('P2-CLOSURE-04: /api/p2-closure is no-store and refuses to call a pending tree closed', async () => {
  const root = makeRepo();
  try {
    await withServer(root, {}, async ({ port }) => {
      const status = await request(port, '/api/status/current');
      assert.equal(status.status, 200, status.body);
      assert.equal(status.headers['cache-control'], 'no-store');
      const result = await request(port, '/api/p2-closure');
      assert.equal(result.status, 200, result.body);
      assert.equal(result.headers['cache-control'], 'no-store');
      const body = JSON.parse(result.body) as {
        schemaVersion?: string;
        targetId?: string;
        policy?: { gateway?: { decision?: string } };
        decision?: { state?: string; closed?: boolean; blockers?: readonly { id?: string }[] };
      };
      assert.equal(body.schemaVersion, '1.0.0');
      assert.equal(body.targetId, 'target');
      assert.equal(body.policy?.gateway?.decision, 'PENDING_CREATOR_DECISION');
      assert.equal(body.decision?.closed, false);
      assert.notEqual(body.decision?.state, 'CLOSED');
      assert.ok(body.decision?.blockers?.some((item) => item.id === 'P2-D4-GATEWAY-DECISION'));
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P1-15: Host, Origin and bearer checks fail closed on every route', async () => {
  const root = makeRepo();
  try {
    const token = '0123456789abcdef';
    await withServer(root, { authToken: token }, async ({ port }) => {
      const noToken = await request(port, '/api/run');
      assert.equal(noToken.status, 401);
      assert.equal(noToken.headers['www-authenticate'], 'Bearer');

      const wrongHost = await request(port, '/api/run', {
        headers: { Host: `attacker.invalid:${String(port)}`, Authorization: `Bearer ${token}` },
      });
      assert.equal(wrongHost.status, 403);
      assert.match(wrongHost.body, /Host header/);

      const foreignPost = await request(port, '/api/control/refresh', {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${String(port)}`,
          Origin: 'http://attacker.invalid',
          Authorization: `Bearer ${token}`,
        },
      });
      assert.equal(foreignPost.status, 403);
      assert.match(foreignPost.body, /cross-origin/);

      const sameOrigin = await request(port, '/api/control/refresh', {
        method: 'POST',
        headers: {
          Host: `localhost:${String(port)}`,
          Origin: `http://localhost:${String(port)}`,
          Authorization: `Bearer ${token}`,
        },
      });
      assert.equal(sameOrigin.status, 200, sameOrigin.body);
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P1-15: oversized catalogue uploads are rejected without resetting the connection', async () => {
  const root = makeRepo();
  try {
    await withServer(root, {}, async ({ port }) => {
      const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
      const refusal = await request(port, '/api/catalogues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
      assert.equal(refusal.status, 413);
      assert.match(refusal.body, /2 MB limit/);

      const valid = await request(port, '/api/catalogues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'after-refusal', catalogue: { catalogueId: 'after-refusal', metrics: [{}] } }),
      });
      assert.equal(valid.status, 201, valid.body);
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P1-15: Navigator replay is chunked, UTF-8 safe, line-bounded and exact', async () => {
  const root = makeRepo();
  try {
    const navigator = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
    const payload = `prefix-${'a'.repeat(70_000)}-żółć-🙂-suffix`;
    const line = JSON.stringify({ type: 'probe', payload });
    writeFileSync(navigator, `${line}\n`, 'utf8');

    await withServer(root, {}, async ({ port }) => {
      const first = await openSse(port, '/api/navigator-events');
      const [block] = await collectSseBlocks(first.response, 1);
      first.request.destroy();
      assert.equal(block, `data: ${line}`);

      writeFileSync(navigator, Buffer.alloc(1024 * 1024 + 1, 0x78));
      const second = await openSse(port, '/api/navigator-events');
      const [errorBlock] = await collectSseBlocks(second.response, 1);
      second.request.destroy();
      assert.match(errorBlock ?? '', /^event: error\ndata: navigator record exceeds 1048576 bytes$/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P1-15: a backpressured Navigator pump never overlaps or duplicates records', async () => {
  const root = makeRepo();
  try {
    const navigator = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
    writeFileSync(navigator, '', 'utf8');

    await withServer(root, {}, async ({ port }) => {
      const connection = await openSse(port, '/api/navigator-events');
      connection.response.pause();
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 350));

      const recordCount = 2_000;
      const filler = 'x'.repeat(4_000);
      const records = Array.from({ length: recordCount }, (_, index) =>
        JSON.stringify({ type: 'bulk', index, filler }),
      );
      appendFileSync(navigator, `${records.join('\n')}\n`, 'utf8');

      // Keep the client paused across several 250 ms ticks so the first pump is forced to wait on
      // socket backpressure while later ticks attempt to enter it.
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 900));
      connection.response.resume();
      const blocks = await collectSseBlocks(connection.response, recordCount, 20_000);
      connection.request.destroy();

      const indexes = blocks.map((block) => {
        const payloadText = block.replace(/^data: /, '');
        return (JSON.parse(payloadText) as { index: number }).index;
      });
      assert.equal(indexes.length, recordCount);
      assert.equal(new Set(indexes).size, recordCount, 'no record was duplicated by overlapping pumps');
      assert.deepEqual(indexes, Array.from({ length: recordCount }, (_, index) => index));
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P1-15: a timed-out pipeline records one phase receipt and can be started again', async () => {
  const root = makeRepo('setInterval(() => undefined, 1000);\n');
  try {
    await withServer(
      root,
      { childTimeoutMs: 120, childKillGraceMs: 50 },
      async ({ port }) => {
        const started = await request(port, '/api/control/start', { method: 'POST' });
        assert.equal(started.status, 202);

        const duplicate = await request(port, '/api/control/start', { method: 'POST' });
        assert.equal(duplicate.status, 409);

        const timedOut = await waitForRunState(port, 'timeout');
        assert.equal(timedOut['phase'], null);
        assert.match(String(timedOut['lastLine']), /exceeded.*budget.*terminated/);
        const receipts = timedOut['receipts'];
        assert.ok(Array.isArray(receipts));
        assert.equal(receipts.length, 1);
        const first = receipts[0] as Record<string, unknown>;
        assert.equal(first['phase'], 'snapshot');
        assert.equal(first['timedOut'], true);

        const restarted = await request(port, '/api/control/start', { method: 'POST' });
        assert.equal(restarted.status, 202, restarted.body);
        await waitForRunState(port, 'timeout');
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P1-15: stop owns and closes an idle Navigator SSE connection', async () => {
  const root = makeRepo();
  try {
    const navigator = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
    writeFileSync(navigator, '', 'utf8');
    const port = await freePort();

    await withRuntimeAsync(
      { withLog: false, readOnly: true, repoRoot: root },
      async (runtime) => {
        const handle = await startClueDashboard(runtime, {
          operator: 'selftest',
          port,
          refreshIntervalMs: 60_000,
        });
        const connection = await openSse(port, '/api/navigator-events');
        connection.response.resume();
        const ended = new Promise<void>((resolveEnd) => {
          connection.response.once('end', resolveEnd);
          connection.response.once('close', resolveEnd);
        });
        await Promise.race([
          handle.stop(),
          new Promise<never>((_, rejectTimeout) =>
            setTimeout(() => rejectTimeout(new Error('dashboard stop timed out with Navigator SSE open')), 2_000),
          ),
        ]);
        await Promise.race([
          ended,
          new Promise<never>((_, rejectTimeout) =>
            setTimeout(() => rejectTimeout(new Error('Navigator SSE did not end')), 2_000),
          ),
        ]);
        connection.request.destroy();
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});


test('ADR-0017: provider billing exhaustion blocks Start without confusing a generic gateway problem', () => {
  assert.equal(
    gatewayPipelineStartRefusal({
      enabled: true,
      providerPaused: true,
      providerPauseReason: 'Project credit balance is exhausted.',
    }),
    'Project credit balance is exhausted.',
  );
  assert.equal(
    gatewayPipelineStartRefusal({ enabled: true, providerPaused: false, providerPauseReason: null }),
    null,
  );
  assert.equal(
    gatewayPipelineStartRefusal({ enabled: false, providerPaused: true, providerPauseReason: 'ignored' }),
    null,
  );
});

test('ADR-0017: dashboard Git sync is a manual fail-closed action under NO_REMOTE_YET', async () => {
  const root = makeRepo();
  try {
    await withServer(root, {}, async ({ port }) => {
      const response = await request(port, '/api/control/git-sync', { method: 'POST' });
      assert.equal(response.status, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const body = JSON.parse(response.body) as Record<string, unknown>;
      assert.equal(body['state'], 'refused');
      assert.equal(body['code'], 'NO_REMOTE_CONFIGURED');
      assert.equal(body['governedGitLifecycle'], false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('Q1 SURF/DIVE: Navigator tail detects truncate-and-regrow even when the replacement exceeds the old offset', async () => {
  const root = makeRepo();
  try {
    const navigator = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
    const oldRecords = Array.from({ length: 24 }, (_, index) => JSON.stringify({
      v: 1,
      type: index === 0 ? 'navigator.reset' : 'scan.progress',
      streamId: 'old-stream',
      runId: 'old-run',
      sequence: index,
      emittedAt: new Date().toISOString(),
      snapshotId: 'a'.repeat(64),
      payload: { index, filler: 'o'.repeat(4_000) },
    }));
    writeFileSync(navigator, `${oldRecords.join('\n')}\n`, 'utf8');

    await withServer(root, {}, async ({ port }) => {
      const connection = await openSse(port, '/api/navigator-events');
      const replay = await collectSseBlocks(connection.response, oldRecords.length);
      assert.equal(replay.length, oldRecords.length);

      connection.response.pause();
      const newTypes = [
        'navigator.reset',
        'inventory.started',
        'inventory.taxonomy',
        'files.upserted',
        'inventory.completed',
        'recognition.started',
        ...Array.from({ length: 30 }, () => 'scan.progress'),
        'graph.committed',
      ];
      const newRecords = newTypes.map((type, index) => JSON.stringify({
        v: 1,
        type,
        streamId: 'new-stream',
        runId: 'new-run',
        sequence: index,
        emittedAt: new Date().toISOString(),
        snapshotId: 'b'.repeat(64),
        payload: {
          index,
          repositoryId: 'target',
          snapshotId: 'b'.repeat(64),
          filler: 'n'.repeat(4_000),
        },
      }));
      const oldBytes = Buffer.byteLength(`${oldRecords.join('\n')}\n`);
      const newText = `${newRecords.join('\n')}\n`;
      assert.ok(Buffer.byteLength(newText) > oldBytes, 'replacement must regrow beyond the previous offset');
      writeFileSync(navigator, newText, 'utf8');

      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 420));
      const newBlocksPromise = collectSseBlocks(connection.response, newRecords.length, 10_000);
      connection.response.resume();
      const newBlocks = await newBlocksPromise;
      connection.request.destroy();

      const delivered = newBlocks.map((block) => JSON.parse(block.replace(/^data: /u, '')) as {
        type: string;
        streamId: string;
        sequence: number;
      });
      assert.equal(delivered[0]?.streamId, 'new-stream');
      assert.equal(delivered[0]?.type, 'navigator.reset');
      assert.deepEqual(delivered.slice(0, 6).map((event) => event.type), newTypes.slice(0, 6));
      assert.deepEqual(delivered.map((event) => event.sequence), newRecords.map((_, index) => index));
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
