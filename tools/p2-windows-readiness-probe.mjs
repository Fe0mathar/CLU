#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalReportPath, writeExternalReport } from './verification-support.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const USAGE = 'Usage: node tools/p2-windows-readiness-probe.mjs [--output <external .json>] [--json]';
const BROKER = 'dist/src/benchmark/restrictedExecution.js';
const SUPERVISOR_PATH = 'CLU_WINDOWS_SUPERVISOR_PATH';
const SUPERVISOR_SHA256 = 'CLU_WINDOWS_SUPERVISOR_SHA256';
const QUALIFICATION_PATH = 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION';
const QUALIFICATION_SHA256 = 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256';
const EXPECTED_SOURCE = {
  'src/analysis/source/navigatorEvents.ts': 'a2946cd2cb3f433742f9f3d7fcac0eb78b271bca73dad73128345fca92e13c1a',
  'src/control/recognitionRun.ts': '5d1e84433261011b5bdbf99a8701b1111314a1e77063ef414f139c589176e699',
  'src/status/statusFromRuntime.ts': '30a125131f1f0ee5c4a411bf4515015082745760550ed2224d6892d218096270',
  'src/status/statusProjector.ts': 'c6d1963172f4e087add7e50c7e1fe71164fefc9fd48676f24fd73f7441febf21',
  'tools/dashboard-status-probe.js': '59a27b1e35ce366bf12aa18cd4ad70b533cc4c9b78070e7a7136789145d5fac7',
  'ui/clue-dashboard/app.js': '68666bb5a835aa2fc5eb88caaf54d36e406760622d23989c0ab558ae1be657c9',
};
const CHILD_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'TEMP', 'TMP', 'TMPDIR', 'NPM_EXECPATH',
]);
const DIGEST = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;

function options(args) {
  let output = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--output' && output === null) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--') || !/\.json$/iu.test(value)) throw new Error(USAGE);
      output = externalReportPath(ROOT, value);
    } else if (item === '--json' && !json) {
      json = true;
    } else {
      throw new Error(USAGE);
    }
  }
  return { output, json };
}

function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => CHILD_ENV_KEYS.has(key.toUpperCase())));
}

function execute(command, args, env, { timeout = 10000, maxBuffer = 256 * 1024 } = {}) {
  return spawnSync(command, args, {
    cwd: ROOT, encoding: 'utf8', env, timeout, maxBuffer, shell: false, windowsHide: true,
  });
}

function childRecord(run, allowed = [0]) {
  if (run.error || !allowed.includes(run.status)) return null;
  try {
    const parsed = JSON.parse(run.stdout);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function state(value) {
  return ['PASS', 'FAIL', 'HOST_NOT_AUTHORITATIVE'].includes(value) ? value : 'UNVERIFIED';
}

function configData() {
  try {
    const { parse } = require('yaml');
    return parse(readFileSync(join(ROOT, 'config/clue.config.yaml'), 'utf8')) ?? null;
  } catch {
    return null;
  }
}

function fileExists(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function gatewayKeyName(config) {
  const key = config?.gateway?.api_key_env;
  return typeof key === 'string' && /^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD)$/u.test(key) &&
    !/^(?:NODE_|GIT_|NPM_|CLU_)/u.test(key) ? key : null;
}

function inspectPreflight(config, env) {
  if (config === null) return { state: 'CONFIG_OR_DEPENDENCIES_UNAVAILABLE', data: null };
  // The existing preflight invokes the configured PowerShell command for its version.
  // Restrict the automatic run to the shipped executable names or the standard installed path.
  const executable = config?.powershell?.executable ?? 'pwsh';
  const standardPath = process.env.ProgramFiles && join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  const windows = process.platform === 'win32';
  const safe = typeof executable === 'string' && (
    /^(?:pwsh|pwsh\.exe)$/iu.test(executable) ||
    (windows && standardPath && executable.replaceAll('/', '\\').toLowerCase() === standardPath.toLowerCase())
  );
  if (!safe) return { state: 'CUSTOM_POWERSHELL_COMMAND_REQUIRES_REVIEW', data: null };
  if (windows && process.env[SUPERVISOR_PATH]) {
    try {
      const selected = realpathSync.native(process.env[SUPERVISOR_PATH]);
      const matchingPaths = /^(?:pwsh|pwsh\.exe)$/iu.test(executable)
        ? [ROOT, ...(env.PATH ?? env.Path ?? '').split(';')].filter(Boolean).map((path) => join(path.replace(/^"|"$/gu, ''), 'pwsh.exe'))
        : [executable];
      if (matchingPaths.some((candidate) => {
        try { return relative(realpathSync.native(candidate), selected) === ''; } catch { return false; }
      })) return { state: 'POWERSHELL_ALIASES_SUPERVISOR', data: null };
    } catch {
      // The preflight's own pin check reports invalid supervisor paths.
    }
  }
  const keyName = gatewayKeyName(config);
  const childEnv = { ...env };
  for (const key of [SUPERVISOR_PATH, SUPERVISOR_SHA256, QUALIFICATION_PATH, QUALIFICATION_SHA256]) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  if (keyName !== null && process.env[keyName]?.trim()) {
    // Preflight only tests presence. The child process receives a fixture marker, never the credential.
    childEnv[keyName] = 'p2-readiness-presence-only';
  }
  const run = execute(process.execPath, ['tools/p2-closure-preflight.mjs', '--json'], childEnv, { timeout: 45000 });
  const data = childRecord(run, [0, 1]);
  if (data?.schemaVersion !== 'clue-p2-closure-preflight/1') {
    return { state: run.error?.code === 'ETIMEDOUT' ? 'TIMED_OUT' : 'REPORT_UNAVAILABLE', data: null };
  }
  return { state: ['READY_FOR_LIVE_RUNTIME_VERIFICATION', 'BLOCKED'].includes(data.status) ? data.status : 'REPORT_UNAVAILABLE', data };
}

function inspectSqlite(env) {
  const source = `
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(':memory:');
  db.exec('CREATE TABLE probe (value INTEGER NOT NULL)');
  db.prepare('INSERT INTO probe VALUES (?)').run(38);
  const result = db.prepare('SELECT value, sqlite_version() AS version FROM probe').get();
  if (result?.value !== 38) process.exitCode = 3;
  else process.stdout.write(JSON.stringify({ version: result.version }));
} catch (error) {
  process.exitCode = error?.code === 'MODULE_NOT_FOUND' ? 2 : 3;
} finally { db?.close(); }
`;
  const run = execute(process.execPath, ['--input-type=commonjs', '--eval', source], env);
  const version = childRecord(run)?.version;
  if (typeof version === 'string' && VERSION.test(version)) return { state: 'PASS', version };
  if (run.status === 2) return { state: 'DEPENDENCY_UNAVAILABLE', version: null };
  if (run.error?.code === 'ETIMEDOUT') return { state: 'TIMED_OUT', version: null };
  return { state: 'NATIVE_LOAD_OR_QUERY_FAILED', version: null };
}

function inspectGit(env) {
  const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const git = (args) => execute('git', [
    '--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args,
  ], gitEnv, { maxBuffer: 1024 * 1024 });
  const root = git(['rev-parse', '--show-toplevel']);
  if (root.error || root.status !== 0) return { state: 'UNAVAILABLE', commit: null, tree: null };
  try {
    if (relative(realpathSync.native(ROOT), realpathSync.native(root.stdout.trim())) !== '') {
      return { state: 'DIFFERENT_ROOT', commit: null, tree: null };
    }
  } catch {
    return { state: 'ROOT_UNVERIFIED', commit: null, tree: null };
  }
  const id = (ref) => {
    const run = git(['rev-parse', '--verify', ref]);
    const value = run.stdout?.trim() ?? '';
    return !run.error && run.status === 0 && OBJECT_ID.test(value) ? value : null;
  };
  const commit = id('HEAD^{commit}');
  const tree = id('HEAD^{tree}');
  if (commit === null || tree === null) return { state: 'NO_COMMITTED_TREE', commit: null, tree: null };
  const worktree = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  return {
    state: worktree.error || worktree.status !== 0 ? 'WORKTREE_UNVERIFIED' : worktree.stdout.length > 0 ? 'DIRTY' : 'CLEAN',
    commit, tree,
  };
}

function inspectSource() {
  const files = Object.entries(EXPECTED_SOURCE).map(([file, expectedSha256]) => {
    let sha256 = null;
    try {
      const path = join(ROOT, file);
      const stat = lstatSync(path);
      if (stat.isFile() && stat.size < 4 * 1024 * 1024) sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch { /* missing or unreadable */ }
    return { file, expectedSha256, sha256, matches: sha256 === expectedSha256 };
  });
  return { baseline: 'PATCH_05D_PLUS_05L', state: files.every((file) => file.matches) ? 'MATCH' : 'REVIEW_REQUIRED', files };
}

function inspectGraph(env, windows) {
  if (!windows) return { state: 'WINDOWS_HOST_REQUIRED' };
  if (!fileExists(join(ROOT, 'dist/src/analysis/source/navigatorEvents.js'))) return { state: 'BUILD_REQUIRED' };
  const source = `
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { readCommittedInventoryParity, readGraphPointer } from './dist/src/analysis/source/navigatorEvents.js';
let out = { state: 'POINTER_UNAVAILABLE' };
try {
  const config = parse(readFileSync('config/clue.config.yaml', 'utf8'));
  const workspace = config?.workspace?.root;
  const target = config?.project?.active_target;
  if (typeof workspace === 'string' && isAbsolute(workspace) && typeof target === 'string') {
    const livePath = join(workspace, 'graph', 'system-navigator.ndjson');
    const info = lstatSync(join(workspace, 'graph', 'current.json'));
    const pointer = info.isFile() && info.size <= 256 * 1024 ? readGraphPointer(livePath) : null;
    if (pointer !== null) {
      const receipt = pointer.physicalInventory;
      const parity = readCommittedInventoryParity(livePath, pointer, target);
      out = {
        state: parity === null ? 'FRESH_RECOGNITION_EVIDENCE_REQUIRED' : 'COMMITTED_RECEIPT_PRESENT',
        parity,
        expectedPhysicalFiles: receipt?.expectedFileCount ?? null,
        observedPhysicalFiles: receipt?.allFileCount ?? null,
      };
    }
  }
} catch { /* no configured, readable pointer */ }
process.stdout.write(JSON.stringify(out));
`;
  const result = childRecord(execute(process.execPath, ['--input-type=module', '--eval', source], env));
  if (!['POINTER_UNAVAILABLE', 'FRESH_RECOGNITION_EVIDENCE_REQUIRED', 'COMMITTED_RECEIPT_PRESENT'].includes(result?.state)) {
    return { state: 'POINTER_CHECK_UNAVAILABLE' };
  }
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    state: result.state,
    parity: typeof result.parity === 'boolean' ? result.parity : null,
    expectedPhysicalFiles: count(result.expectedPhysicalFiles),
    observedPhysicalFiles: count(result.observedPhysicalFiles),
  };
}

function report() {
  const env = environment();
  const windows = process.platform === 'win32';
  const config = configData();
  const { state: preflightState, data } = inspectPreflight(config, env);
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeSupported = major > 22 || (major === 22 && minor >= 11);
  const [authority, v10] = [state(data?.activeAuthority?.state), state(data?.deferredPostP2Documentation?.status)];
  const activeV9 = data?.activeAuthority?.documentationPack?.source === 'selector' &&
    data.activeAuthority.documentationPack.releaseVersion === '9.0' &&
    data.activeAuthority.documentationPack.sealFile === 'SHA256SUMS_v9.txt' &&
    data.activeAuthority.documentationPack.manifestFile === 'DOCUMENTATION_MANIFEST_v9.json';
  const preflightRoot = (label) => state(Array.isArray(data?.roots) ? data.roots.find((row) => row?.label === label)?.state : undefined);
  const sqlite = inspectSqlite(env);
  const git = inspectGit(env);
  const source = inspectSource();
  const navigator = inspectGraph(env, windows);
  const keyName = gatewayKeyName(config);
  const keyPresent = keyName !== null && Boolean(process.env[keyName]?.trim());
  const exactGatewayPolicy = data?.gateway?.provider === 'openai' && data?.gateway?.spendAuthority === 'openai_platform' &&
    data?.gateway?.exactModelPolicy === true;
  const builtBrokerPresent = fileExists(join(ROOT, BROKER));
  const pathConfigured = Boolean(process.env[SUPERVISOR_PATH]?.trim());
  const pinConfigured = Boolean(process.env[SUPERVISOR_SHA256]?.trim());
  const pinShapeValid = DIGEST.test(process.env[SUPERVISOR_SHA256] ?? '');
  const observedPin = data?.proofExecutionBoundary?.sha256;
  const pinVerified = windows && builtBrokerPresent && pathConfigured && pinConfigured && pinShapeValid &&
    data?.proofExecutionBoundary?.kind === 'windows-supervisor' && observedPin === process.env[SUPERVISOR_SHA256];
  const qualificationConfigured = Boolean(process.env[QUALIFICATION_PATH]?.trim() && process.env[QUALIFICATION_SHA256]?.trim());
  const qualificationVerified = pinVerified && qualificationConfigured &&
    data?.proofExecutionBoundary?.nativeQualification === 'VERIFIED' &&
    data.proofExecutionBoundary.qualificationSha256 === process.env[QUALIFICATION_SHA256];
  const qualification = qualificationVerified ? 'VERIFIED'
    : qualificationConfigured ? 'RECEIPT_NOT_VERIFIED' : 'PENDING_PRODUCTION_QUALIFICATION';
  const supervisorState = !windows ? 'WINDOWS_HOST_REQUIRED' : !builtBrokerPresent ? 'BUILD_REQUIRED'
    : !pathConfigured || !pinConfigured ? 'CONFIGURATION_MISSING' : !pinShapeValid ? 'PIN_INVALID'
    : qualificationVerified ? 'PIN_AND_QUALIFICATION_VERIFIED'
    : pinVerified ? 'PIN_VERIFIED_QUALIFICATION_PENDING' : 'PIN_NOT_VERIFIED';
  const blockers = [];
  if (!windows) blockers.push('NATIVE_WINDOWS_REQUIRED');
  if (!nodeSupported) blockers.push('NODE_VERSION_UNSUPPORTED');
  if (preflightState !== 'READY_FOR_LIVE_RUNTIME_VERIFICATION') blockers.push('CLOSURE_PREFLIGHT_INCOMPLETE');
  if (data?.hostTools?.npm !== true) blockers.push('NPM_UNVERIFIED');
  if (data?.hostTools?.powershell !== true) blockers.push('POWERSHELL_7_UNVERIFIED');
  if (preflightRoot('Chrome executable') !== 'PASS') blockers.push('CHROME_UNVERIFIED');
  if (preflightRoot('workspace') !== 'PASS' || preflightRoot('shadow') !== 'PASS') blockers.push('WORKSPACE_OR_SHADOW_UNVERIFIED');
  if (!activeV9 || authority !== 'PASS' || v10 !== 'PASS') blockers.push('DOCUMENTATION_PACK_CHECK_INCOMPLETE');
  if (sqlite.state !== 'PASS') blockers.push('NATIVE_SQLITE_CHECK_FAILED');
  if (git.state !== 'CLEAN') blockers.push('CLEAN_LOCAL_GIT_TREE_UNVERIFIED');
  if (!pinVerified) blockers.push('SUPERVISOR_PIN_UNVERIFIED');
  if (!keyPresent) blockers.push('GATEWAY_KEY_PRESENCE_UNVERIFIED');
  if (!exactGatewayPolicy) blockers.push('GATEWAY_POLICY_UNVERIFIED');
  if (source.state !== 'MATCH') blockers.push('PATCH_05D_SOURCE_REVIEW_REQUIRED');
  if (navigator.parity === false) blockers.push('NAVIGATOR_RECEIPT_PARITY_FAILED');

  return {
    schemaVersion: 'clue-p2-windows-readiness/1',
    checkedAt: new Date().toISOString(),
    status: blockers.length > 0 ? 'BLOCKED' : qualificationVerified
      ? 'QUALIFICATION_RECEIPT_VERIFIED_LIVE_CHECKS_PENDING' : 'PREREQUISITES_PRESENT_QUALIFICATION_PENDING',
    platform: { name: process.platform, arch: process.arch, nativeWindows: windows },
    host: { node: process.versions.node, nodeSupported, npm: data?.hostTools?.npm === true, powershell7: data?.hostTools?.powershell === true, sqlite, git },
    paths: { workspace: preflightRoot('workspace'), shadow: preflightRoot('shadow'), chromeExecutable: preflightRoot('Chrome executable') },
    documentation: { activeV9, activeSeal: authority, deferredV10Seal: v10 },
    preflight: { state: preflightState },
    supervisor: { state: supervisorState, builtBrokerPresent, pathConfigured, pinConfigured, pinShapeValid, verifiedSha256: pinVerified ? observedPin : null, qualificationConfigured, qualification },
    gateway: { keyPresentInThisProcess: keyPresent, approvedModel: data?.gateway?.approvedModel ?? null, exactModelAndBudgetPolicy: exactGatewayPolicy, liveProviderCheck: 'PENDING' },
    source, navigator,
    blockers,
  };
}

try {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log(USAGE);
  } else {
    const selected = options(process.argv.slice(2));
    const result = report();
    if (selected.output !== null) writeExternalReport(ROOT, selected.output, result);
    if (selected.json || selected.output === null) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      console.log(`Windows readiness: ${result.status}`);
      console.log('Diagnostic JSON written to the requested evidence path.');
      for (const blocker of result.blockers) console.log('  ' + blocker);
    }
    if (result.status === 'BLOCKED') process.exitCode = 1;
  }
} catch {
  console.error(USAGE);
  console.error('Could not produce the readiness report. Use a writable evidence path outside the project.');
  process.exitCode = 2;
}
