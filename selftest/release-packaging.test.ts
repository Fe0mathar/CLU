import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const excludedFromFixture = new Set(['.git', 'dist', 'node_modules', 'workspace', 'release']);
const sealNames = ['SHA256SUMS_v9.txt', 'SHA256SUMS_v10.txt'];
const proofTemplate = 'templates/p2-closure/proof-contract.template.json';
const selector = 'config/documentation-pack.json';
const releaseConfig = 'config/clue.config.yaml';
const localProfileSelector = 'config/project-profiles.yaml';
const localConfigBackup = 'config/backups/clue.config.v2.1bd8e5d20223.yaml';
const localDocumentationBackups = [
  'config/backups/clue.config.2026-11-14T10-10-10-100Z.yaml',
  'config/backups/documentation-pack.2026-11-14T10-10-10-100Z.json',
];
const operatorPaths = [
  '.gitattributes',
  'agents/clue/identity.md',
  'AUDIT_AND_UPGRADE.md',
  'CLUE-Windows-Supervisor.bat',
  'CLUE-Windows-WFP-Diagnostic.bat',
  'CLUE-Windows-WFP-BFE-Lab.bat',
  'CLUE-Windows-Production-Network-Fault.bat',
  'CLUE-Windows-Reviewed-Release.bat',
  'CLUE-Windows-P03-Proof-Pilot.bat',
  'templates/project-profiles/governed-document.operator-input.template.json',
  'templates/project-profiles/project-profile.operator-input.template.json',
];

interface DocumentationSelector {
  readonly schemaVersion: string;
  readonly releaseName: string;
  readonly releaseVersion: string;
  readonly sealFile: string;
  readonly manifestFile: string;
  readonly installHint: string;
}

interface DocumentationSeal {
  readonly path: string;
  readonly sha256: string;
  readonly pass: boolean;
}

interface ReleaseAuthority {
  readonly documentationPack: DocumentationSelector;
  readonly documentationSeal: DocumentationSeal;
  readonly documentationSeals: { readonly v9: DocumentationSeal; readonly v10: DocumentationSeal };
}

interface ReleaseReport {
  readonly verdict: string;
  readonly archive: { readonly file: string; readonly sha256: string; readonly fileCount: number };
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly tree: {
    readonly available: boolean;
    readonly commit?: string;
    readonly tree?: string;
    readonly dirty?: boolean;
    readonly archiveBound?: boolean;
    readonly reason?: string;
  };
  readonly releaseQualification: {
    readonly cleanGitTree: boolean;
    readonly formalPass: boolean;
    readonly nativeProofIntegration: boolean;
  };
  readonly authority: ReleaseAuthority;
  readonly smoke: { readonly structural: ReleaseAuthority & { readonly pass: boolean } };
}

function fixture(t: TestContext): { readonly root: string; readonly parent: string; readonly env: NodeJS.ProcessEnv } {
  const parent = mkdtempSync(join(tmpdir(), 'clue-release-fixture-'));
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(parent, 'CLU');
  cpSync(projectRoot, root, {
    recursive: true,
    filter: (file) => !excludedFromFixture.has(basename(file)) &&
      file !== join(projectRoot, localProfileSelector) &&
      !(dirname(file) === join(projectRoot, 'config', 'backups') &&
        /^clue\.config\.v2\..*\.yaml$/iu.test(basename(file))),
  });
  cpSync(join(projectRoot, 'node_modules', 'yaml'), join(root, 'node_modules', 'yaml'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  const globalGitConfig = join(parent, 'empty-gitconfig');
  writeFileSync(globalGitConfig, '');
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_GLOBAL'] = globalGitConfig;
  env['GIT_TERMINAL_PROMPT'] = '0';
  return { root, parent, env };
}

function runRelease(root: string, output: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['tools/release.mjs', '--no-gates', '--out', output], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function archiveEntries(bytes: Buffer): ReadonlyMap<string, Buffer> {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'expected an archive with no end comment');
  const entries = new Map<string, Buffer>();
  const count = bytes.readUInt16LE(end + 10);
  let position = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    const method = bytes.readUInt16LE(position + 10);
    const compressedBytes = bytes.readUInt32LE(position + 20);
    const nameBytes = bytes.readUInt16LE(position + 28);
    const extraBytes = bytes.readUInt16LE(position + 30);
    const commentBytes = bytes.readUInt16LE(position + 32);
    const local = bytes.readUInt32LE(position + 42);
    const name = bytes.toString('utf8', position + 46, position + 46 + nameBytes);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const payload = bytes.subarray(start, start + compressedBytes);
    assert.ok(method === 0 || method === 8, `unsupported compression for ${name}`);
    assert.equal(entries.has(name), false, `duplicate entry ${name}`);
    entries.set(name, method === 0 ? payload : inflateRawSync(payload));
    position += 46 + nameBytes + extraBytes + commentBytes;
  }
  assert.equal(position, end);
  return entries;
}

function inspectRelease(
  root: string, output: string, env: NodeJS.ProcessEnv,
): { readonly report: ReleaseReport; readonly entries: ReadonlyMap<string, Buffer> } {
  const run = runRelease(root, output, env);
  assert.equal(run.status, 0, run.error?.message ?? `${run.stdout}\n${run.stderr}`);
  const files = readdirSync(output).filter((file) =>
    file.endsWith('.report.json') && !file.endsWith('.candidate.report.json'));
  assert.equal(files.length, 1);
  const report = JSON.parse(readFileSync(join(output, files[0]!), 'utf8')) as ReleaseReport;
  const archive = readFileSync(join(output, report.archive.file));
  assert.equal(sha256(archive), report.archive.sha256);
  const entries = archiveEntries(archive);
  assert.equal(entries.size, report.archive.fileCount);
  assert.deepEqual([...entries.keys()].sort(), report.files.map(({ path }) => path).sort());
  for (const file of report.files) assert.equal(sha256(entries.get(file.path)!), file.sha256);
  assert.equal(report.verdict, 'UNGATED');
  assert.equal(report.releaseQualification.formalPass, false);
  assert.equal(report.releaseQualification.nativeProofIntegration, false);
  return { report, entries };
}

function expectRefusal(root: string, output: string, env: NodeJS.ProcessEnv, message: RegExp): void {
  const run = runRelease(root, output, env);
  assert.ok(run.status !== null && run.status !== 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, message);
  assert.equal(existsSync(output) && readdirSync(output).some((name) => name.endsWith('.zip')), false);
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(run.status, 0, run.error?.message ?? `${run.stdout}\n${run.stderr}`);
  return run.stdout.trim();
}

function addLocalProfileState(root: string, canary: string): void {
  mkdirSync(dirname(join(root, localConfigBackup)), { recursive: true });
  writeFileSync(join(root, localProfileSelector), `# ${canary}\nregistry_root: F:/CLU/profiles\n`);
  writeFileSync(join(root, localConfigBackup), `# ${canary}\n`);
}

function packSelector(pack: 'v9' | 'v10'): DocumentationSelector {
  return {
    schemaVersion: 'clue-documentation-pack-selector/1',
    releaseName: `CLU-E RPI Documentation Pack ${pack}`,
    releaseVersion: pack === 'v9' ? '9.0' : '10.0-rc1',
    sealFile: `SHA256SUMS_${pack}.txt`,
    manifestFile: `DOCUMENTATION_MANIFEST_${pack}.json`,
    installHint: 'fixture only',
  };
}

function selectFixturePack(root: string, pack: 'v9' | 'v10'): DocumentationSelector {
  const active = packSelector(pack);
  const configPath = join(root, releaseConfig);
  const config = readFileSync(configPath, 'utf8').replace(
    /"(CLUE_(?:AI_Utilization|Git_Integration|Status_Contract|Q1_System_Navigator|Architecture|Execution_Model|Interface_Design|Project_Directory))_v(?:9|10)\.md"/gu,
    `"$1_${pack}.md"`,
  );
  writeFileSync(configPath, config);
  writeFileSync(join(root, selector), JSON.stringify(active));
  return active;
}

function assertPackIdentity(report: ReleaseReport, entries: ReadonlyMap<string, Buffer>, active: DocumentationSelector): void {
  assert.deepEqual(JSON.parse(entries.get(selector)!.toString('utf8')), active);
  assert.equal(report.smoke.structural.pass, true);
  for (const authority of [report.authority, report.smoke.structural]) {
    assert.deepEqual(authority.documentationPack, active);
    assert.equal(authority.documentationSeal.path, active.sealFile);
    assert.equal(authority.documentationSeal.sha256, sha256(entries.get(active.sealFile)!));
    for (const pack of ['v9', 'v10'] as const) {
      const seal = authority.documentationSeals[pack];
      assert.equal(seal.path, packSelector(pack).sealFile);
      assert.equal(seal.pass, true);
      assert.equal(seal.sha256, sha256(entries.get(seal.path)!));
    }
  }
}

test('release archive carries both verified packs, the active v10 selector, and operator inputs without local state', (t) => {
  const { root, parent, env } = fixture(t);
  const active = selectFixturePack(root, 'v10');
  const canary = randomBytes(24).toString('hex');
  env['OPENAI_API_KEY'] = canary;
  addLocalProfileState(root, canary);
  for (const path of [
    '.env.local', 'config/.env', 'src/.env', 'config/.npmrc', 'config/local-test.pem',
    'workspace/events/events.ndjson', 'release/old.zip',
    ...localDocumentationBackups,
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), canary);
  }
  const { report, entries } = inspectRelease(root, join(parent, 'out'), env);
  assert.equal(report.tree.available, false);
  assert.equal(report.releaseQualification.cleanGitTree, false);
  assert.equal(JSON.stringify(report).includes(canary), false);
  for (const sealName of sealNames) {
    const seal = entries.get(sealName);
    assert.ok(seal, sealName);
    for (const line of seal.toString('utf8').split(/\r?\n/u).filter(Boolean)) {
      const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
      assert.ok(match, line);
      const entry = entries.get(match[2]!);
      assert.ok(entry, match[2]);
      assert.equal(sha256(entry), match[1], match[2]);
    }
  }
  assertPackIdentity(report, entries, active);
  const candidateManifest = JSON.parse(entries.get(active.manifestFile)!.toString('utf8'));
  assert.equal(candidateManifest.status, 'release-candidate-not-ratified');
  for (const file of readdirSync(join(root, 'templates', 'p2-closure'))) {
    assert.ok(entries.has(`templates/p2-closure/${file}`), file);
  }
  for (const file of [
    'CLUE-Dashboard.bat',
    'docs/p2/P2_CLOSURE_RUNBOOK.md',
    'docs/p2/WINDOWS_EXECUTION_SUPERVISOR.md',
    'tools/p2-closure-preflight.mjs',
    'tools/p2-closure-inventory.mjs',
  ]) assert.ok(entries.has(file), file);
  for (const path of operatorPaths) assert.deepEqual(entries.get(path), readFileSync(join(root, path)), path);
  for (const path of [localProfileSelector, localConfigBackup, ...localDocumentationBackups]) {
    assert.equal(entries.has(path), false, path);
  }
  for (const [path, data] of entries) {
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|workspace\/|release\/|\.git\/|node_modules\/)|\.pem$/iu);
    assert.equal(data.includes(canary), false, path);
  }
});

test('release preserves the historical v9 selection while still verifying v10', (t) => {
  const { root, parent, env } = fixture(t);
  const active = selectFixturePack(root, 'v9');
  const { report, entries } = inspectRelease(root, join(parent, 'v9'), env);
  assertPackIdentity(report, entries, active);

  const configPath = join(root, releaseConfig);
  const config = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, config.replace('"CLUE_Architecture_v9.md"', '"CLUE_Architecture_v10.md"'));
  expectRefusal(root, join(parent, 'v9-v10-authority'), env, /tracked authority|CLUE_Architecture_v10/iu);
});

test('release refuses v9-only authority when v10 is active', (t) => {
  const { root, parent, env } = fixture(t);
  selectFixturePack(root, 'v10');
  const configPath = join(root, releaseConfig);
  const config = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, config.replace('"CLUE_Architecture_v10.md"', '"CLUE_Architecture_v9.md"'));
  expectRefusal(root, join(parent, 'v10-v9-authority'), env, /tracked authority|CLUE_Architecture_v9/iu);
});

test('release refuses broken seals and missing operator inputs', (t) => {
  const { root, parent, env } = fixture(t);
  selectFixturePack(root, 'v10');
  for (const pack of ['v9', 'v10']) {
    const document = `CLUE_Architecture_${pack}.md`;
    const path = join(root, document);
    const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from('\nfixture tamper\n')]));
    expectRefusal(root, join(parent, `bad-seal-${pack}`), env, new RegExp(`hash mismatch ${document}`, 'iu'));
    writeFileSync(path, bytes);
  }
  const templatePath = join(root, proofTemplate);
  const templateBytes = readFileSync(templatePath);
  rmSync(templatePath);
  expectRefusal(root, join(parent, 'missing-template'), env, /proof-contract\.template\.json/iu);
  writeFileSync(templatePath, templateBytes);
  const launcherPath = join(root, 'CLUE-Windows-WFP-Diagnostic.bat');
  const launcherBytes = readFileSync(launcherPath);
  rmSync(launcherPath);
  expectRefusal(root, join(parent, 'missing-launcher'), env, /CLUE-Windows-WFP-Diagnostic\.bat/u);
  writeFileSync(launcherPath, launcherBytes);
});

test('release refuses unsupported, crossed, and malformed documentation selectors', (t) => {
  const { root, parent, env } = fixture(t);
  const active = selectFixturePack(root, 'v10');
  const { installHint: _installHint, ...missingHint } = active;
  const cases = {
    'unsupported-version': { ...active, releaseVersion: '10.0' },
    'crossed-seal': { ...active, sealFile: packSelector('v9').sealFile },
    'crossed-manifest': { ...active, manifestFile: packSelector('v9').manifestFile },
    'missing-hint': missingHint,
    'extra-key': { ...active, unknown: true },
    'bad-schema': { ...active, schemaVersion: 'not-supported' },
  };
  for (const [name, value] of Object.entries(cases)) {
    writeFileSync(join(root, selector), JSON.stringify(value));
    expectRefusal(root, join(parent, name), env, /documentation-pack\.json|selector/iu);
  }
});

test('release Git binding requires exact archived bytes at the clean local repository HEAD', (t) => {
  if (spawnSync('git', ['--version'], { windowsHide: true }).status !== 0) {
    t.skip('Local Git is unavailable.');
    return;
  }
  const { root, parent, env } = fixture(t);
  git(root, env, 'init', '-q');
  git(root, env, 'config', 'core.autocrlf', 'false');
  git(root, env, 'add', '-A');
  git(root, env, '-c', 'user.email=clue-release@example.invalid', '-c', 'user.name=CLU-E fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  addLocalProfileState(root, randomBytes(24).toString('hex'));
  assert.deepEqual(git(root, env, 'check-ignore', localProfileSelector, localConfigBackup).split(/\r?\n/u),
    [localProfileSelector, localConfigBackup]);
  const { report: clean, entries } = inspectRelease(root, join(parent, 'clean'), env);
  assert.equal(clean.tree.available, true);
  assert.equal(clean.tree.commit, git(root, env, 'rev-parse', 'HEAD'));
  assert.equal(clean.tree.tree, git(root, env, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(clean.tree.dirty, false);
  assert.equal(clean.tree.archiveBound, true);
  assert.equal(clean.releaseQualification.cleanGitTree, true);
  for (const path of [localProfileSelector, localConfigBackup]) assert.equal(entries.has(path), false, path);

  const manifest = join(root, 'MANIFEST.txt');
  const manifestBytes = readFileSync(manifest);
  assert.equal(manifestBytes.includes(13), false);
  git(root, env, 'update-index', '--assume-unchanged', 'MANIFEST.txt');
  writeFileSync(manifest, manifestBytes.toString('utf8').replace(/\n/gu, '\r\n'));
  assert.equal(git(root, env, 'status', '--porcelain'), '');
  const { report: converted } = inspectRelease(root, join(parent, 'manifest-crlf'), env);
  assert.equal(converted.tree.archiveBound, false);
  assert.match(converted.tree.reason ?? '', /archive bytes differ from the Git blob at HEAD: MANIFEST\.txt/u);
  git(root, env, 'update-index', '--no-assume-unchanged', 'MANIFEST.txt');
  rmSync(manifest);
  git(root, env, 'checkout', '--', 'MANIFEST.txt');
  assert.deepEqual(readFileSync(manifest), manifestBytes);

  const tracked = join(root, 'src', 'shared', 'ids.ts');
  const original = readFileSync(tracked);
  writeFileSync(tracked, Buffer.concat([original, Buffer.from('\n// local change\n')]));
  const { report: dirty } = inspectRelease(root, join(parent, 'dirty'), env);
  assert.equal(dirty.tree.available, true);
  assert.equal(dirty.tree.dirty, true);
  assert.equal(dirty.releaseQualification.cleanGitTree, false);
  writeFileSync(tracked, original);

  git(root, env, 'update-index', '--assume-unchanged', 'src/shared/ids.ts');
  writeFileSync(tracked, Buffer.concat([original, Buffer.from('\n// hidden local change\n')]));
  assert.equal(git(root, env, 'status', '--porcelain'), '');
  const { report: hidden } = inspectRelease(root, join(parent, 'hidden-drift'), env);
  assert.equal(hidden.tree.archiveBound, false);
  assert.equal(hidden.releaseQualification.cleanGitTree, false);
});

test('a parent repository cannot provide provenance for a nested CLU-E folder', (t) => {
  if (spawnSync('git', ['--version'], { windowsHide: true }).status !== 0) {
    t.skip('Local Git is unavailable.');
    return;
  }
  const { root, parent, env } = fixture(t);
  git(parent, env, 'init', '-q');
  git(parent, env, '-c', 'user.email=clue-release@example.invalid', '-c', 'user.name=CLU-E fixture',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'parent only');
  const { report } = inspectRelease(root, join(parent, 'nested'), env);
  assert.equal(report.tree.available, false);
  assert.equal(report.releaseQualification.cleanGitTree, false);
});
