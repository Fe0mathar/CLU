import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.dirname(url.fileURLToPath(import.meta.url));
const required = [
  '../src/GreatBookFieldElement.ts',
  '../src/render/WebGPUImprovementFieldScene.ts',
  '../src/ui/FieldRenderer.ts',
  '../demo/index.html',
  '../demo/sample-projection.json',
  '../shaders/fieldFloor.wgsl',
  '../shaders/fieldBars.wgsl',
];
for (const relative of required) {
  const file = path.resolve(root, relative);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required file: ${relative}`);
  }
}
console.log('Great Book Improvement Field verify: PASS');
