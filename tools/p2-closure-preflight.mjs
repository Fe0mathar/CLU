#!/usr/bin/env node
/**
 * Read-only P2 closure preflight.
 *
 * This tool never ratifies documents, seals an epoch, contacts OpenAI, runs a proof,
 * writes Great Book history, synchronizes Git or changes the active project.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { externalReportPath, resolveNpmInvocation, writeExternalReport } from './verification-support.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = argument('--output');
if (output !== null) externalReportPath(repoRoot, output);
const jsonOnly = process.argv.includes('--json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');


function documentationPack() {
  const selectorPath = join(repoRoot, 'config', 'documentation-pack.json');
  if (!existsSync(selectorPath)) {
    return { releaseName: 'CLU-E RPI Documentation Pack v9', releaseVersion: '9.0', sealFile: 'SHA256SUMS_v9.txt', manifestFile: 'DOCUMENTATION_MANIFEST_v9.json', source: 'legacy-default' };
  }
  const parsed = JSON.parse(readFileSync(selectorPath, 'utf8'));
  const safe = (value, label) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/u.test(value)) {
      throw new Error(`config/documentation-pack.json has unsafe ${label}`);
    }
    return value;
  };
  return {
    releaseName: String(parsed.releaseName ?? ''),
    releaseVersion: String(parsed.releaseVersion ?? ''),
    sealFile: safe(parsed.sealFile, 'sealFile'),
    manifestFile: safe(parsed.manifestFile, 'manifestFile'),
    source: 'selector',
  };
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseSeal(path) {
  const declared = new Map();
  const problems = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (match === null) {
      problems.push(`unparseable seal line: ${line}`);
      continue;
    }
    if (match[2].includes('\\') || match[2].includes(':') || match[2].split('/').some((part) => part === '' || part === '.' || part === '..')) {
      problems.push(`invalid relative seal path: ${match[2]}`);
      continue;
    }
    if (declared.has(match[2])) problems.push(`duplicate seal path ${match[2]}`);
    declared.set(match[2], match[1]);
  }
  if (declared.size === 0) problems.push('the active authority seal has no entries');
  return { declared, problems };
}

function verifySeal(name) {
  const path = join(repoRoot, name);
  if (!existsSync(path)) return { state: 'FAIL', seal: name, problems: [`${name} absent`], declared: 0 };
  const { declared, problems } = parseSeal(path);
  for (const [relativePath, expected] of declared) {
    const absolute = join(repoRoot, ...relativePath.split('/'));
    if (!existsSync(absolute)) {
      problems.push(`${relativePath} absent`);
      continue;
    }
    const actual = sha256(readFileSync(absolute));
    if (actual !== expected) problems.push(`${relativePath} SHA-256 mismatch`);
  }
  return {
    state: problems.length === 0 ? 'PASS' : 'FAIL',
    seal: name,
    sealSha256: sha256(readFileSync(path)),
    declared: declared.size,
    problems,
  };
}

function probeVersion(command, args, expected) {
  const probe = spawnSync(command, args, {
    cwd: repoRoot, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 10_000, maxBuffer: 64 * 1024,
  });
  if (probe.error) return { ok: false, detail: probe.error.code ?? 'spawn failed' };
  if (probe.status !== 0) return { ok: false, detail: `exit ${probe.status ?? probe.signal}` };
  const version = expected.exec(probe.stdout?.trim() ?? '')?.[1];
  return version === undefined
    ? { ok: false, detail: 'unexpected version output' }
    : { ok: true, detail: version };
}

function probeNpm() {
  let invocation;
  try {
    invocation = resolveNpmInvocation(['--version']);
  } catch (error) {
    return { ok: false, detail: error.message };
  }
  return probeVersion(invocation.command, invocation.args, /^(\d+\.\d+\.\d+)/u);
}

function pathCheck(label, value, kind) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { label, configured: value ?? null, state: 'FAIL', detail: 'missing path' };
  }
  const windowsDrive = /^[A-Za-z]:[\\/]/u.test(value);
  if (windowsDrive && process.platform !== 'win32') {
    return { label, configured: value, state: 'HOST_NOT_AUTHORITATIVE', detail: 'Windows path cannot be verified on this host' };
  }
  const absolute = resolve(repoRoot, value);
  const stat = statSync(absolute, { throwIfNoEntry: false });
  const matches = kind === 'directory' ? stat?.isDirectory() : stat?.isFile();
  return {
    label,
    configured: value,
    state: matches ? 'PASS' : 'FAIL',
    detail: matches ? `${kind} exists` : `expected an existing ${kind}`,
  };
}

const problems = [];
const notes = [];
const windowsHost = process.platform === 'win32';
if (!windowsHost) problems.push('Authoritative P2 preflight requires the Windows installation.');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 11)) {
  problems.push(`Node.js 22.11 or later is required (found ${process.version}).`);
}
const configPath = join(repoRoot, 'config', 'clue.config.yaml');
if (!existsSync(configPath)) throw new Error('config/clue.config.yaml is absent');
const config = parseYaml(readFileSync(configPath, 'utf8'));
const pack = documentationPack();
const activeSeal = verifySeal(pack.sealFile);
if (activeSeal.state !== 'PASS') problems.push(...activeSeal.problems.map((item) => `active authority: ${item}`));
if (pack.source !== 'selector' || pack.releaseVersion !== '9.0' || pack.sealFile !== 'SHA256SUMS_v9.txt' ||
    pack.manifestFile !== 'DOCUMENTATION_MANIFEST_v9.json') {
  problems.push('P2 preflight requires the v9 documentation selector. Use v10 only after P2 closure.');
}

const docsCandidate = spawnSync(process.execPath, ['tools/project-profiles-docs-verify.mjs', '--json'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: false,
  timeout: 10_000,
});
let docsCandidateResult = null;
try {
  docsCandidateResult = docsCandidate.stdout?.trim() ? JSON.parse(docsCandidate.stdout) : null;
} catch {
  docsCandidateResult = { status: 'FAIL', problems: ['documentation verifier returned invalid JSON'] };
}
if (docsCandidate.status !== 0 || docsCandidateResult?.status !== 'PASS') {
  problems.push('The bundled v10 candidate seal and manifest must verify before release packaging.');
}
notes.push('The packaged v10 candidate remains deferred post-P2 authority.');

const routingPath = join(repoRoot, config.gateway.routing_file);
const budgetPath = join(repoRoot, config.gateway.budget_policy_file);
const routing = existsSync(routingPath) ? parseYaml(readFileSync(routingPath, 'utf8')) : null;
const budget = existsSync(budgetPath) ? parseYaml(readFileSync(budgetPath, 'utf8')) : null;
const enabledModels = routing === null
  ? []
  : [...new Set(Object.values(routing.routes ?? {}).filter((route) => route?.enabled).map((route) => route.model).filter(Boolean))];
const apiKeyEnv = config.gateway.api_key_env;
const apiKeyPresent = typeof apiKeyEnv === 'string' && Boolean(process.env[apiKeyEnv]);
if (config.gateway.provider !== 'openai') problems.push('gateway provider is not openai');
if (enabledModels.length !== 1 || enabledModels[0] !== 'gpt-5.6') problems.push(`enabled gateway routes do not resolve exactly to gpt-5.6 (${enabledModels.join(', ') || 'none'})`);
if (budget?.spend_authority !== 'openai_platform') problems.push('OpenAI Platform is not the configured spend authority');
if (!apiKeyPresent) problems.push(`${apiKeyEnv ?? 'OPENAI_API_KEY'} is not present in this process environment`);

const roots = [
  pathCheck('workspace', config.workspace?.root, 'directory'),
  pathCheck('shadow', config.shadow?.root, 'directory'),
  pathCheck('Chrome executable', config.browser?.executable, 'file'),
];
for (const item of roots) {
  if (item.state === 'FAIL') problems.push(`${item.label}: ${item.detail}`);
}

const powershell = probeVersion(config.powershell?.executable ?? 'pwsh', ['--version'], /^PowerShell (\d+\.\d+\.\d+)/u);
if (powershell.ok && Number(powershell.detail.split('.')[0]) < 7) {
  powershell.detail = `PowerShell 7 or later is required (found ${powershell.detail}).`;
  powershell.ok = false;
}
const hostToolDetails = {
  npm: probeNpm(),
  git: probeVersion('git', ['--version'], /^git version (\d+\.\d+\.\d+)/u),
  powershell,
};
const toolHints = {
  npm: 'Install Node.js with npm and run this check via npm.cmd run.',
  git: 'Install Git and ensure git.exe is on PATH.',
  powershell: 'Install PowerShell 7 or later and check powershell.executable in config/clue.config.yaml.',
};
for (const [name, tool] of Object.entries(hostToolDetails)) {
  if (!tool.ok) problems.push(`${name} is unavailable or incompatible (${tool.detail}). ${toolHints[name]}`);
}

let proofExecutionBoundary = null;
if (windowsHost) {
  const broker = join(repoRoot, 'dist', 'src', 'benchmark', 'restrictedExecution.js');
  if (!existsSync(broker)) {
    problems.push('Build CLU-E before checking the Windows proof supervisor (npm.cmd run build).');
  } else {
    try {
      const { requireProofExecutionBoundary } = await import(new URL('../dist/src/benchmark/restrictedExecution.js', import.meta.url));
      proofExecutionBoundary = { ...requireProofExecutionBoundary(), nativeQualification: 'REQUIRED' };
    } catch (error) {
      problems.push(`Proof isolation: ${error.message}`);
    }
  }
}

const requiredScripts = ['typecheck', 'build', 'selftest', 'dashboard:verify', 'navigator:verify', 'project-profiles:acceptance', 'p2:closure-inventory', 'release:package'];
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const missingScripts = requiredScripts.filter((name) => typeof packageJson.scripts?.[name] !== 'string');
if (missingScripts.length > 0) problems.push(`package scripts missing: ${missingScripts.join(', ')}`);

const result = {
  schemaVersion: 'clue-p2-closure-preflight/1',
  checkedAt: new Date().toISOString(),
  mode: 'READ_ONLY',
  status: problems.length === 0 ? 'READY_FOR_LIVE_RUNTIME_VERIFICATION' : 'BLOCKED',
  repoRoot,
  activeAuthority: { ...activeSeal, documentationPack: pack },
  deferredPostP2Documentation: docsCandidateResult,
  projectProfiles: {
    selectorPresent: existsSync(join(repoRoot, 'config', 'project-profiles.yaml')),
    acceptanceMatrixPresent: existsSync(join(repoRoot, 'config', 'project-profiles-acceptance.matrix.json')),
  },
  roots,
  hostTools: {
    node: process.version,
    npm: hostToolDetails.npm.ok,
    git: hostToolDetails.git.ok,
    powershell: hostToolDetails.powershell.ok,
  },
  hostToolDetails,
  proofExecutionBoundary,
  gateway: {
    provider: config.gateway.provider,
    requestedModels: enabledModels,
    apiKeyReference: typeof apiKeyEnv === 'string' ? `env:${apiKeyEnv}` : null,
    apiKeyPresent,
    secretValueIncluded: false,
    spendAuthority: budget?.spend_authority ?? null,
    operationallyReady: null,
    operationallyReadyReason: 'A live provider test is required; this preflight intentionally performs no network request.',
  },
  publication: {
    intendedState: 'NO_REMOTE_YET',
    localOnly: true,
    automaticSyncPerformed: false,
  },
  requiredNextLiveChecks: [
    'Qualify the pinned Windows proof supervisor on this host and preserve the native qualification evidence.',
    'Run npm.cmd run release:package -- --out <external-evidence-directory> from the clean local Git tree.',
    'Run the Project Profile Host, Git, Chrome and GPT connection tests against the active profile.',
    'Confirm requestedModel = effectiveModel = gpt-5.6 and fallbackUsed = false.',
    'Generate closure inventory and authority manifests in the external closure evidence directory.',
    'Only then perform interactive docs ratify and epoch seal P2-authoritative.',
  ],
  blockers: problems,
  notes,
  nonClaims: [
    'No document was ratified.',
    'No epoch was sealed.',
    'No OpenAI request was made.',
    'No Git synchronization occurred.',
    'No proof attempt or Great Book entry was created.',
    'P2 was not closed by this command.',
  ],
};

const reportPath = output === null ? null : writeExternalReport(repoRoot, output, result);
if (jsonOnly) process.stdout.write(`${JSON.stringify(result)}\n`);
else {
  process.stdout.write(`P2 closure preflight: ${result.status}\n`);
  process.stdout.write(`  active authority: ${activeSeal.state} (${activeSeal.declared} files)\n`);
  process.stdout.write(`  deferred v10 pack: ${docsCandidateResult?.status ?? 'FAIL'}\n`);
  process.stdout.write(`  exact model: ${enabledModels.join(', ') || 'none'}\n`);
  process.stdout.write(`  ${apiKeyEnv ?? 'OPENAI_API_KEY'} present: ${String(apiKeyPresent)}\n`);
  for (const blocker of problems) process.stdout.write(`  BLOCKER: ${blocker}\n`);
  if (reportPath !== null) process.stdout.write(`  report: ${reportPath}\n`);
}
process.exitCode = problems.length === 0 ? 0 : 1;
