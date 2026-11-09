/** Starts or reuses the bundled loopback fixture for the dashboard's fixed Chrome scenario. */
import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { BrowserRunOptions } from '../experiment/browser/projectBrowserRun.js';
import { hashBytes } from '../shared/ids.js';

export const DASHBOARD_WEBGPU_CANARY_URL = 'http://127.0.0.1:5179/';
const SERVER_PATH = 'tools/serve-webgpu-canary.mjs';
const SCENARIO_PATH = 'tools/browser-scenarios/webgpu-canary.json';
const SERVER_SHA256 = 'c210425cb4424e62f81de0f735c346699a4f01699241586e50098c4f89d869dc';
const SCENARIO_SHA256 = 'f512647035556161d79489422b895562e3d170eaaaf02657544515b4fdc4f7c2';
const PAGE_SHA256 = 'd9349d1d7d402885f7e4a27e2c2c047b358cd6caa83cbfb9a773caaf1d468cab';
const MAX_BYTES = 64 * 1024;
const STARTUP_MS = 8_000;

type FixtureEndpoint = 'available' | 'absent' | 'foreign';

function canonicalHash(bytes: Buffer): string {
  return hashBytes(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function readPinnedFile(path: string, expected: string, label: string): Buffer {
  let bytes: Buffer;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid canary file.');
    bytes = readFileSync(path);
  } catch {
    throw new Error(`The bundled WebGPU ${label} is missing or unreadable. Reapply the Chrome canary patch.`);
  }
  if (bytes.byteLength > MAX_BYTES || canonicalHash(bytes) !== expected) {
    throw new Error(`The bundled WebGPU ${label} differs from its reviewed hash. Reapply the Chrome canary patch.`);
  }
  return bytes;
}

function probeFixture(): Promise<FixtureEndpoint> {
  return new Promise((resolve) => {
    const request = get(DASHBOARD_WEBGPU_CANARY_URL, {
      agent: false, signal: AbortSignal.timeout(1_000),
    }, (response) => {
      response.once('error', () => resolve('foreign'));
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/html')) {
        response.destroy();
        resolve('foreign');
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > MAX_BYTES) {
          response.destroy();
          resolve('foreign');
        } else {
          chunks.push(chunk);
        }
      });
      response.once('end', () => resolve(canonicalHash(Buffer.concat(chunks)) === PAGE_SHA256 ? 'available' : 'foreign'));
    });
    request.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED' ? 'absent' : 'foreign'));
  });
}

function stopOwnedFixture(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finished = (): void => {
      clearTimeout(limit);
      child.removeListener('close', finished);
      resolve();
    };
    const limit = setTimeout(() => {
      child.kill('SIGKILL');
      finished();
    }, 1_000);
    child.once('close', finished);
    child.kill('SIGTERM');
  });
}

export async function withDashboardWebGpuCanary<T>(
  repoRoot: string,
  run: (options: BrowserRunOptions) => Promise<T>,
  assertRunning: () => void = () => {},
): Promise<T> {
  assertRunning();
  const source = readPinnedFile(join(repoRoot, SERVER_PATH), SERVER_SHA256, 'fixture server');
  const scenario = join(repoRoot, SCENARIO_PATH);
  const scenarioBytes = readPinnedFile(scenario, SCENARIO_SHA256, 'scenario');
  const options = { scenario, sha256: hashBytes(scenarioBytes), buildId: 'webgpu-canary-1', phase: 'canary' };
  const foreignEndpoint = (): Error => new Error('Port 5179 is occupied by a service other than the bundled CLU-E WebGPU canary.');
  const existing = await probeFixture();
  assertRunning();
  if (existing === 'available') return run(options);
  if (existing === 'foreign') throw foreignEndpoint();

  // Start the verified bytes so the process cannot load a substituted script after the pin check.
  // The fixture imports only node:http and needs no inherited Node options or credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir)$/i.test(key)));
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source.toString('utf8')], {
    cwd: repoRoot, env, windowsHide: true, stdio: 'ignore',
  });
  let spawnError = false;
  child.on('error', () => { spawnError = true; });
  try {
    const deadline = Date.now() + STARTUP_MS;
    while (Date.now() < deadline) {
      assertRunning();
      const endpoint = await probeFixture();
      if (endpoint === 'foreign') throw foreignEndpoint();
      if (endpoint === 'available') {
        assertRunning();
        return await run(options);
      }
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    throw new Error('The bundled WebGPU canary could not start on loopback port 5179.');
  } finally {
    await stopOwnedFixture(child);
  }
}
