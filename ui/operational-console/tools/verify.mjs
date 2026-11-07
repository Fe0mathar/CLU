import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'dist/src/index.js',
  'dist/src/OperationalConsoleElement.js',
  'dist/src/OperationalConsoleClient.js',
  'dist/src/render/WebGPUConsoleScene.js',
  'dist/demo/demo.js',
  'demo/index.html',
  'demo/sample-events.json',
  'shaders/consoleBackdrop.wgsl',
  'shaders/consoleSignals.wgsl',
  'config/console.channels.json',
];

for (const relative of required) {
  if (!existsSync(resolve(root, relative))) throw new Error(`Missing Operational Console asset: ${relative}`);
}
const sample = JSON.parse(readFileSync(resolve(root, 'demo/sample-events.json'), 'utf8'));
if (!Array.isArray(sample.events) || sample.events.length < 3) {
  throw new Error('Sample projection does not contain the required send/receive/summary sequence.');
}
for (const event of sample.events) {
  if (event.payload && typeof event.payload.preview !== 'string') {
    throw new Error(`Sample event ${event.eventId} lacks exact payload preview.`);
  }
}
console.log(`Operational Console verified: ${required.length} assets, ${sample.events.length} sample events.`);
