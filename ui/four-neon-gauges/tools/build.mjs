import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(root, '../..');
const dist = resolve(root, 'dist');
rmSync(dist, { recursive: true, force: true });

const tsc = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.json')], {
  cwd: projectRoot,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(resolve(dist, 'demo'), { recursive: true });
mkdirSync(resolve(dist, 'shaders'), { recursive: true });
mkdirSync(resolve(dist, 'config'), { recursive: true });
cpSync(resolve(root, 'demo/index.html'), resolve(dist, 'demo/index.html'));
cpSync(resolve(root, 'demo/sample-gauges.json'), resolve(dist, 'demo/sample-gauges.json'));
cpSync(resolve(root, 'shaders'), resolve(dist, 'shaders'), { recursive: true });
cpSync(resolve(root, 'config'), resolve(dist, 'config'), { recursive: true });
console.log('Four Neon Gauges build: PASS');
