import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const supportPath = new URL('../../tools/verification-support.mjs', import.meta.url).href;
const support = await import(supportPath);

test('Patch 01: the Windows npm launcher uses Node and preserves separate arguments', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clue npm path '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const npmCli = join(root, 'npm-cli.js');
  writeFileSync(npmCli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const args = ['run', 'script', '--', 'path with spaces', '&'];
  const invocation = support.resolveNpmInvocation(args, {
    platform: 'win32', env: { npm_execpath: npmCli },
  });
  assert.deepEqual(invocation, { command: process.execPath, args: [npmCli, ...args] });
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);

  const adjacentDir = join(root, 'node_modules', 'npm', 'bin');
  mkdirSync(adjacentDir, { recursive: true });
  const adjacent = join(adjacentDir, 'npm-cli.js');
  writeFileSync(adjacent, '');
  const options = { platform: 'win32', nodePath: join(root, 'node.exe'), env: { npm_execpath: 'npm.cmd' } };
  assert.deepEqual(support.resolveNpmInvocation(['--version'], options), {
    command: options.nodePath, args: [adjacent, '--version'],
  });
  rmSync(adjacent);
  assert.throws(() => support.resolveNpmInvocation(args, options), /npm\.cmd run/);
});

test('Patch 01: external reports reject project paths and directory aliases', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clue-reports-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'CLU');
  const evidence = join(root, 'CLU-evidence');
  mkdirSync(repo);
  mkdirSync(evidence);
  const sealed = join(repo, 'sealed.json');
  writeFileSync(sealed, 'keep these bytes');
  const alias = join(evidence, 'alias');
  symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => support.writeExternalReport(repo, sealed, {}), /outside the CLU-E project/);
  assert.throws(() => support.writeExternalReport(repo, join(alias, 'new', 'receipt.json'), {}), /outside the CLU-E project/);
  assert.equal(existsSync(join(repo, 'new')), false);

  const report = join(evidence, 'new', 'receipt.json');
  support.writeExternalReport(repo, report, { status: 'FIRST' });
  support.writeExternalReport(repo, report, { status: 'REPLACED' });
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), { status: 'REPLACED' });
  assert.equal(readFileSync(sealed, 'utf8'), 'keep these bytes');
});

test('Patch 01: migration inventory defaults to stdout and preserves the sealed report', () => {
  const repo = new URL('../../', import.meta.url);
  const sealed = new URL('PROJECT_PROFILES_MIGRATION_REPORT.json', repo);
  const before = readFileSync(sealed);
  const script = 'tools/project-profiles-migration-report.mjs';
  const options = { cwd: repo, encoding: 'utf8' as const };
  const report = spawnSync(process.execPath, [script], options);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).schemaVersion, 'clue-project-profiles-migration-report/1');

  const blocked = spawnSync(process.execPath, [script, '--output', 'PROJECT_PROFILES_MIGRATION_REPORT.json'], options);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /outside the CLU-E project/);
  assert.deepEqual(readFileSync(sealed), before);
});
