import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DASHBOARD_WEBGPU_CANARY_URL, withDashboardWebGpuCanary } from '../src/daemon/dashboardWebGpuCanary.js';
import { hashBytes } from '../src/shared/ids.js';

const fixture = 'tools/serve-webgpu-canary.mjs';
const scenario = 'tools/browser-scenarios/webgpu-canary.json';

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(5179, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('dashboard canary verifies the fixture, preserves existing services and cleans up its own server', async (t) => {
  const foreign = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('Different service');
  });
  try {
    await listen(foreign);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    t.skip('The local canary port is already in use.');
    return;
  }
  try {
    await assert.rejects(withDashboardWebGpuCanary(process.cwd(), async () => assert.fail('Unexpected run')), /Port 5179 is occupied/u);
    assert.equal(await (await fetch(DASHBOARD_WEBGPU_CANARY_URL)).text(), 'Different service');
  } finally {
    await close(foreign);
  }

  const root = mkdtempSync(join(tmpdir(), 'clue-dashboard-canary-'));
  try {
    mkdirSync(join(root, 'tools', 'browser-scenarios'), { recursive: true });
    for (const file of [fixture, scenario]) {
      writeFileSync(join(root, file), readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    const rejected = new Error('Scenario failed after fixture start');
    await assert.rejects(withDashboardWebGpuCanary(root, async (options) => {
      assert.equal(options.sha256, hashBytes(readFileSync(join(root, scenario))));
      assert.equal(options.phase, 'canary');
      assert.equal(options.buildId, 'webgpu-canary-1');
      assert.match(await (await fetch(DASHBOARD_WEBGPU_CANARY_URL)).text(), /Arm benchmark/u);
      const reused = await withDashboardWebGpuCanary(root, async () => 'reused');
      assert.equal(reused, 'reused');
      assert.equal((await fetch(DASHBOARD_WEBGPU_CANARY_URL)).status, 200);
      throw rejected;
    }), rejected);
    await assert.rejects(fetch(DASHBOARD_WEBGPU_CANARY_URL, { signal: AbortSignal.timeout(1_000) }));
    writeFileSync(join(root, scenario), '{}');
    await assert.rejects(withDashboardWebGpuCanary(root, async () => assert.fail('Unexpected run')), /scenario differs from its reviewed hash/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
