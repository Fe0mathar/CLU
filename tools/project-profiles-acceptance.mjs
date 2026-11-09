#!/usr/bin/env node
/**
 * PP-36 cumulative Project Profiles acceptance runner.
 *
 * Default mode is authoritative: all matrix selftests and regression commands are run.
 * `--portable` exists only for package construction on a host that cannot load the supplied
 * Windows native SQLite binary; it never counts as final Windows acceptance.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTapFailures, externalReportPath, resolveNpmInvocation, writeExternalReport } from './verification-support.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const portable = args.has('--portable');
const fullRegression = args.has('--full');
const jsonOnly = args.has('--json');
const outputArg = valueAfter('--output');
if (outputArg !== null) externalReportPath(repoRoot, outputArg);
const windowsHost = process.platform === 'win32';
const matrixPath = join(repoRoot, 'config', 'project-profiles-acceptance.matrix.json');
const startedAt = new Date().toISOString();

const nativeSqliteTests = new Set([
  'workspace-project-identity.test.ts',
  'project-state-isolation.test.ts',
  'project-profile-runtime.test.ts',
  'project-profile-migration.test.ts',
  'project-switching.test.ts',
  'project-profiles-fault-injection-acceptance.test.ts',
  'project-recognition-isolation.test.ts',
  'project-recognition-reuse.test.ts',
  'great-book-project-isolation.test.ts',
  'gateway-project-identity.test.ts',
  'great-book.test.ts',
  'proof-cycle-project-isolation.test.ts',
  'mission-profile-binding.test.ts',
  'authority-drift-stales-proof.test.ts',
  'surf-dive-project-switch.test.ts',
  'project-profile-status.test.ts',
  'status-console-agreement.test.ts',
  'status-seal.test.ts',
  'clue-dashboard-server-authority.test.ts',
  'command-authority.test.ts',
  'catalogue.test.ts',
  'status-gate4-parity.test.ts',
]);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a path`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, '[REDACTED_OPENAI_KEY]')
    .replace(/(OPENAI_API_KEY\s*[=:]\s*)[^\s"']+/giu, '$1[REDACTED]');
}

function run(label, command, commandArgs, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    ...options,
  });
  const status = result.status ?? (result.error === undefined ? 1 : 127);
  const stdout = redact(result.stdout ?? '');
  const stderr = redact(result.stderr ?? '');
  const failureDetails = status === 0 ? [] : collectTapFailures(stdout, stderr);
  return Object.freeze({
    label,
    command: [command, ...commandArgs].join(' '),
    status,
    pass: status === 0,
    durationMs: Date.now() - started,
    stdout: stdout.slice(-12000),
    stderr: (result.error === undefined ? stderr : redact(result.error.message)).slice(-12000),
    ...(failureDetails.length > 0 ? { failureDetails } : {}),
  });
}

function runNpm(label, args) {
  const invocation = resolveNpmInvocation(args);
  return run(label, invocation.command, invocation.args);
}

function groups(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function safeMatrix() {
  if (!existsSync(matrixPath)) throw new Error('Project Profiles acceptance matrix is absent.');
  const value = JSON.parse(readFileSync(matrixPath, 'utf8'));
  if (value.matrixVersion !== 'clue-project-profiles-acceptance-matrix/1') {
    throw new Error(`Unsupported acceptance matrix version: ${String(value.matrixVersion)}`);
  }
  if (!Array.isArray(value.requirements) || value.requirements.length !== 28) {
    throw new Error('Acceptance matrix must contain the 28 Definition-of-Done requirements.');
  }
  return value;
}

function matrixTests(matrix) {
  const source = [...new Set(matrix.requirements.flatMap((item) => item.tests ?? []))].sort();
  const missing = source.filter((path) => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) throw new Error(`Acceptance matrix references missing tests: ${missing.join(', ')}`);
  return source;
}

function runtimeTestPath(source) {
  if (source.startsWith('selftest/') && source.endsWith('.ts')) {
    return `dist/${source.slice(0, -3)}.js`;
  }
  return source;
}

function scanCredentialStores() {
  const roots = ['config', 'targets'];
  const findings = [];
  const visit = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = join(absolute, entry.name);
      if (entry.isDirectory()) visit(path);
      if (!entry.isFile()) continue;
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue;
      const text = bytes.toString('utf8');
      if (/sk-[A-Za-z0-9_-]{16,}/u.test(text)) findings.push(relative(repoRoot, path));
      if (/api[_-]?key\s*[:=]\s*["']?(?!env:|credential-store:|OPENAI_API_KEY|null)[A-Za-z0-9_-]{16,}/iu.test(text)) {
        findings.push(relative(repoRoot, path));
      }
    }
  };
  for (const root of roots) {
    const absolute = join(repoRoot, root);
    if (existsSync(absolute)) visit(absolute);
  }
  return [...new Set(findings)].sort();
}

const matrix = safeMatrix();
const allTests = matrixTests(matrix);
const portableSkipped = [];
const selectedSelftests = [];
const selectedUiTests = [];
for (const source of allTests) {
  if (source.startsWith('selftest/')) {
    if (portable && nativeSqliteTests.has(source.slice('selftest/'.length))) portableSkipped.push(source);
    else selectedSelftests.push(runtimeTestPath(source));
  } else {
    selectedUiTests.push(source);
  }
}

const steps = [];
steps.push(runNpm('TypeScript typecheck', ['run', 'typecheck']));
steps.push(runNpm('Production build', ['run', 'build']));
if (steps.at(-1)?.pass) {
  for (const [index, group] of groups(selectedSelftests, 18).entries()) {
    steps.push(run(`Acceptance selftests ${index + 1}`, process.execPath, ['--test', ...group]));
  }
}
if (selectedUiTests.length > 0) {
  steps.push(run('Acceptance dashboard tests', process.execPath, ['--test', ...selectedUiTests]));
}
for (const commandLine of matrix.regressionCommands) {
  const parts = commandLine.trim().split(/\s+/u);
  if (parts[0] !== 'npm' || parts[1] !== 'run' || parts.length !== 3) {
    throw new Error(`Unsupported regression command in matrix: ${commandLine}`);
  }
  steps.push(runNpm(commandLine, ['run', parts[2]]));
}
steps.push(run('v10 documentation candidate', process.execPath, ['tools/project-profiles-docs-verify.mjs', '--json']));
if (fullRegression) {
  steps.push(runNpm('Complete repository selftest', ['run', 'selftest']));
}

const secretFindings = scanCredentialStores();
const staticPass = steps.every((step) => step.pass) && secretFindings.length === 0;
const finishedAt = new Date().toISOString();
const report = {
  schemaVersion: 'clue-project-profiles-acceptance-report/1',
  release: matrix.release,
  mode: portable || !windowsHost ? 'PORTABLE_PACKAGE_VALIDATION' : 'AUTHORITATIVE_HOST_ACCEPTANCE',
  status: staticPass
    ? portable || !windowsHost
      ? 'PORTABLE_PASS_WINDOWS_ACCEPTANCE_PENDING'
      : 'STATIC_AND_HOST_AUTOMATION_PASS_LIVE_CONNECTION_GATES_PENDING'
    : 'FAIL',
  startedAt,
  finishedAt,
  platform: { platform: process.platform, arch: process.arch, node: process.version },
  matrix: {
    path: relative(repoRoot, matrixPath).replace(/\\/gu, '/'),
    sha256: sha256(readFileSync(matrixPath)),
    requirementCount: matrix.requirements.length,
    uniqueTestCount: allTests.length,
  },
  execution: {
    selectedSelftests: selectedSelftests.length,
    selectedUiTests: selectedUiTests.length,
    portableSkipped,
    fullRegression,
    steps,
  },
  credentialSafety: {
    scannedRoots: ['config', 'targets'],
    rawCredentialFindings: secretFindings,
    pass: secretFindings.length === 0,
  },
  authoritativeWindowsGates: matrix.authoritativeWindowsGates.map((gate) => ({ gate, state: 'NOT_RECORDED' })),
  creatorAcceptance: { state: 'NOT_RECORDED' },
  claims: {
    projectProfilesImplemented: staticPass,
    fullDefinitionOfDoneAccepted: false,
    reason: 'Live Windows, Chrome and OpenAI connection evidence plus explicit Creator acceptance remain separate governed acts.',
  },
};

const output = outputArg === null ? null : writeExternalReport(repoRoot, outputArg, report);
if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
else {
  process.stdout.write(`Project Profiles acceptance: ${report.status}\n`);
  for (const step of steps) {
    process.stdout.write(`  ${step.pass ? 'PASS' : 'FAIL'}  ${step.label} (${step.durationMs} ms)\n`);
    if (!step.pass) {
      const diagnostic = step.failureDetails?.join('\n\n') || step.stderr.trim() || step.stdout.trim() || 'No diagnostic output.';
      process.stdout.write(`    ${diagnostic}\n`);
    }
  }
  if (portableSkipped.length > 0) process.stdout.write(`  PENDING ${portableSkipped.length} native/Windows tests intentionally skipped in portable mode\n`);
  for (const finding of secretFindings) process.stdout.write(`  FAIL  raw credential-like material in ${finding}\n`);
  if (output !== null) process.stdout.write(`  report ${output}\n`);
}
process.exitCode = staticPass ? 0 : 1;
