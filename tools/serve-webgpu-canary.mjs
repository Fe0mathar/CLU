/** Loopback-only, dependency-free page for the dedicated Chrome acceptance scenario. */
import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = 5179;
const page = `<!doctype html>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<title>CLU-E WebGPU canary</title>
<style>
:root { color-scheme: dark; font: 16px system-ui; }
body { margin: 0; background: #091721; color: #b6e8ed; }
button, input, main { position: absolute; left: 16px; }
button, input { box-sizing: border-box; width: 180px; height: 36px; }
button { top: 20px; } input { top: 68px; } main { top: 120px; }
</style>
<button id="arm" type="button">Arm benchmark</button>
<input id="answer" aria-label="Test input" autocomplete="off">
<main><h1>CLU-E dedicated Chrome</h1><p id="result">Awaiting the scenario.</p></main>
<script>
'use strict';
let clicked = false;
let entered = false;
const input = document.querySelector('#answer');
const result = document.querySelector('#result');
document.querySelector('#arm').addEventListener('click', event => { clicked = event.isTrusted; });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter') entered = event.isTrusted && input.value === 'CLU-E';
});
globalThis.clueWebGpuCanary = {
  async measure() {
    if (!clicked || !entered) throw new Error('Expected trusted click, text, and Enter.');
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter.');
    const device = await adapter.requestDevice();
    const storage = device.createBuffer({size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    const readback = device.createBuffer({size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const shader = device.createShaderModule({
        code: '@group(0) @binding(0) var<storage,read_write> result: array<u32>; @compute @workgroup_size(1) fn main() { result[0] = 6u * 7u; }',
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto', compute: {module: shader, entryPoint: 'main'},
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: storage}}],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(storage, 0, readback, 0, 4);
      const commands = encoder.finish();
      const start = performance.now();
      device.queue.submit([commands]);
      await readback.mapAsync(GPUMapMode.READ);
      const elapsed = performance.now() - start;
      const value = new Uint32Array(readback.getMappedRange())[0];
      readback.unmap();
      if (value !== 42) throw new Error('Unexpected WebGPU readback.');
      result.textContent = 'Trusted input verified. WebGPU readback = ' + value;
      console.info('[CLU-E canary] WebGPU compute and readback verified.');
      return {
        buildId: 'webgpu-canary-1',
        webgpuWorkload: true,
        metrics: [
          {name: 'gpu-submit-to-readback', unit: 'ms', value: elapsed},
          {name: 'gpu-readback', unit: 'count', value},
        ],
      };
    } finally {
      readback.destroy();
      storage.destroy();
      device.destroy();
    }
  },
};
</script>`;

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/' || request.headers.host !== `${host}:${port}`) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }).end(page);
});
server.on('error', (error) => {
  process.stderr.write(`WebGPU canary server could not start. ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, host, () => process.stdout.write(`WebGPU canary ready at http://${host}:${port}/\n`));
