import { createHash } from 'node:crypto';
import { request } from 'node:http';

const SAMPLE_COUNT = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 3000;
const SHA256 = /^[0-9a-f]{64}$/u;

function readAsset(path, port, signal) {
  const started = performance.now();
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      agent: false,
      headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' },
      signal: requestSignal,
    }, (response) => {
      response.once('error', reject);
      if (response.statusCode !== 200) {
        reject(new Error('Dashboard request did not return HTTP 200.'));
        response.destroy();
        return;
      }

      const hash = createHash('sha256');
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          reject(new Error('Dashboard response exceeded the size limit.'));
          response.destroy();
          return;
        }
        hash.update(chunk);
      });
      response.once('end', () => {
        if (!response.complete) {
          reject(new Error('Dashboard response was incomplete.'));
          return;
        }
        resolve({ sha256: hash.digest('hex'), bytes, elapsedMs: performance.now() - started });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

const roundedMs = (value) => Math.round(value * 1000) / 1000;

/** Measures static-asset transfer on the actual host, including reading each response body. */
export async function measureDashboardHttpBaseline({ expectedHtmlSha256, expectedAppSha256, port = 47900, signal }) {
  if (typeof expectedHtmlSha256 !== 'string' || !SHA256.test(expectedHtmlSha256) ||
      typeof expectedAppSha256 !== 'string' || !SHA256.test(expectedAppSha256) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return { state: 'REQUEST_UNVERIFIED' };
  }

  const assets = {};
  for (const [name, path, expectedHash] of [
    ['html', '/', expectedHtmlSha256],
    ['app', '/ui/app.js', expectedAppSha256],
  ]) {
    const samples = [];
    let bytes = 0;
    for (let round = 0; round <= SAMPLE_COUNT; round += 1) {
      let response;
      try {
        response = await readAsset(path, port, signal);
      } catch (error) {
        return { state: name === 'html' && round === 0 && error?.code === 'ECONNREFUSED'
          ? 'NOT_RUNNING' : 'REQUEST_UNVERIFIED' };
      }
      if (response.sha256 !== expectedHash) return { state: 'SOURCE_MISMATCH' };
      bytes = response.bytes;
      if (round > 0) samples.push(response.elapsedMs);
    }
    assets[name] = {
      bytes,
      samplesMs: samples.map(roundedMs),
      medianMs: roundedMs([...samples].sort((a, b) => a - b)[Math.floor(SAMPLE_COUNT / 2)]),
    };
  }
  return { state: 'MEASURED', sampleCountPerPath: SAMPLE_COUNT, assets };
}
