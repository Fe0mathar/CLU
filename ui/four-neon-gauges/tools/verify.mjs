import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'src/FourNeonGaugesElement.ts',
  'src/render/WebGPUNeonGaugeScene.ts',
  'src/ui/GaugeOverlayRenderer.ts',
  'shaders/fourNeonGauges.wgsl',
  'demo/sample-gauges.json',
  'config/default-gauges.json',
];
for (const relative of required) {
  if (!existsSync(resolve(root, relative))) throw new Error(`Missing ${relative}`);
}
const sample = JSON.parse(readFileSync(resolve(root, 'demo/sample-gauges.json'), 'utf8'));
if (!Array.isArray(sample.gauges) || sample.gauges.length !== 4) {
  throw new Error('Sample must contain exactly four gauges.');
}
const slots = new Set(sample.gauges.map((gauge) => gauge.slot));
if (slots.size !== 4) throw new Error('Gauge slots are not unique.');
const expectedColors = ['#00a3e0', '#f4af2d', '#ff5500', '#39ff88'];
for (const color of expectedColors) {
  if (!sample.gauges.some((gauge) => gauge.familyColor === color)) {
    throw new Error(`Missing canonical family color ${color}`);
  }
}
const shader = readFileSync(resolve(root, 'shaders/fourNeonGauges.wgsl'), 'utf8');
for (const token of ['@vertex', '@fragment', 'GaugeUniforms', 'values', 'confidence', 'coverage', 'freshness']) {
  if (!shader.includes(token)) throw new Error(`Shader lacks ${token}`);
}
console.log('Four Neon Gauges verify: PASS');
