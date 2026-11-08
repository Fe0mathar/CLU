/**
 * CLU-E exact release command — archive authority v2.
 *
 * This command closes REL-P0-01 / DEV-P1-08 / DEV-P1-30 at the release boundary:
 *
 *   1. validate both documentation packs, the v9 selector, and active target registration;
 *   2. run clean/typecheck/build against the source tree;
 *   3. create a deterministic, source-only ZIP with stored entries from an explicit allowlist plus every
 *      governed authority and active-target input required to interpret the installation;
 *   4. extract the ZIP with this process's own reader and verify exact path/hash parity;
 *   5. run `npm ci`, typecheck, build, every self-test in an isolated bounded process, and
 *      the P0 adversarial item probes against the extracted archive;
 *   6. bind the archive bytes to local Git HEAD and the gates to the archive SHA-256;
 *   7. refuse the RELEASE verdict when any gate, extraction check, authority check, or
 *      archive binding fails.
 *
 * Usage from the repository root:
 *
 *   node tools/release.mjs
 *   node tools/release.mjs --out release
 *   node tools/release.mjs --no-gates       # deterministic archive + structural smoke only
 *   node tools/release.mjs --write-root     # also refresh detached root MANIFEST.txt
 *   node tools/release.mjs --keep-smoke     # retain extracted smoke tree for diagnosis
 *
 * Optional clean-install policy:
 *
 *   CLUE_RELEASE_NPM_MODE=prefer-offline|online|offline   (default: prefer-offline)
 *   CLUE_RELEASE_NPM_CI_TIMEOUT_MS=<positive integer>     (default: 10 minutes)
 *
 * `--no-gates` is diagnostic. It can emit an UNGATED archive but never a RELEASE verdict.
 *
 * The release ZIP is deliberately source-only. Top-level `dist/`, `node_modules/`, `workspace/`,
 * `.git/`, and previous `release/` output are never shipped. The clean extracted tree must install
 * and reproduce its build before it can pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { assessNativeProofIntegration, nativeProofTapCoverage, readTapCounts } from './release-readiness.mjs';
import { resolveNpmInvocation } from './verification-support.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'tools/release.mjs';
const REPORT_VERSION = '2.0.0';
const DOCUMENTATION_PACK_SELECTOR = 'config/documentation-pack.json';
const CONFIG_PATH = 'config/clue.config.yaml';
const DOCUMENTATION_PACKS = {
  v9: { sealFile: 'SHA256SUMS_v9.txt', manifestFile: 'DOCUMENTATION_MANIFEST_v9.json', releaseVersion: '9.0' },
  v10: { sealFile: 'SHA256SUMS_v10.txt', manifestFile: 'DOCUMENTATION_MANIFEST_v10.json', releaseVersion: '10.0-rc1' },
};

const REQUIRED_OPERATOR_PATHS = [
  'CLUE-Dashboard.bat',
  'CLUE-Windows-Setup.bat',
  'CLUE-Windows-Supervisor.bat',
  'CLUE-Windows-WFP-Diagnostic.bat',
  'CLUE-Windows-Sandbox-Diagnostic.bat',
  'CONFIG-EDIT.md',
  'MANIFEST.txt',
  'clue-status.md',
  'docs/P2_CLOSURE_RUNBOOK.md',
  'docs/p2/WINDOWS_EXECUTION_SUPERVISOR.md',
  'templates/p2-closure/P2_ACTIVE_AUTHORITY_MANIFEST.template.json',
  'templates/p2-closure/P2_CLOSURE_CONTEXT.template.json',
  'templates/p2-closure/P2_CREATOR_APPROVAL.template.txt',
  'templates/p2-closure/P2_DEFERRED_POST_P2_AUTHORITY_MANIFEST.template.json',
  'templates/p2-closure/candidate-patch.template.json',
  'templates/p2-closure/proof-contract.template.json',
  'templates/project-profiles/governed-document.operator-input.template.json',
  'templates/project-profiles/project-profile.operator-input.template.json',
];

const DEFAULT_TIMEOUTS = Object.freeze({
  sourceGate: envPositiveInt('CLUE_RELEASE_SOURCE_GATE_TIMEOUT_MS', 900_000),
  npmCi: envPositiveInt('CLUE_RELEASE_NPM_CI_TIMEOUT_MS', 600_000),
  extractedGate: envPositiveInt('CLUE_RELEASE_EXTRACTED_GATE_TIMEOUT_MS', 900_000),
  testFile: envPositiveInt('CLUE_RELEASE_TEST_FILE_TIMEOUT_MS', 900_000),
  p0: envPositiveInt('CLUE_RELEASE_P0_TIMEOUT_MS', 1_800_000),
});

const TEST_CONCURRENCY = Math.max(
  1,
  Math.min(8, envPositiveInt('CLUE_RELEASE_TEST_CONCURRENCY', 1)),
);

/** Generated and live-data directories that can never be source-release content. */
const ALWAYS_EXCLUDED_TOP_LEVEL = new Set([
  '.git',
  'chrome-profile',
  'coverage',
  'dist',
  'node_modules',
  'release',
  'shadow',
  'workspace',
]);

/** Conventional credential files and host/editor/build residue are excluded at any depth. */
const EXCLUDED_ANYWHERE = [
  (name) => /\.(?:tsbuildinfo|node|pem|key|p12|pfx|jks|keystore|db(?:-wal|-shm)?|sqlite3?(?:-wal|-shm)?|log|zip|tgz)$/u.test(name),
  (name) => /^\.env(?:\.|$)/u.test(name),
  (name) => /^clue-\d.*\.(?:report\.json|smoke\.json|zip\.sha256|sha256sums|manifest\.txt)$/u.test(name),
  (name) => ['.ds_store', 'thumbs.db', 'desktop.ini', '.npmrc', '.netrc', '_netrc', 'id_rsa', 'id_ed25519'].includes(name),
];

/** npm's pack rules are not the release contract; these are mandatory source inputs. */
const ALWAYS_INCLUDED = ['package.json', 'package-lock.json', '.gitignore', '.gitattributes', CONFIG_PATH, DOCUMENTATION_PACK_SELECTOR];

function envPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normaliseSlash(value) {
  return value.split(sep).join('/').replace(/\\/g, '/');
}

/** Bytewise UTF-8 ordering is independent of host locale and ICU data. */
function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function canonicalRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`invalid archive path: ${JSON.stringify(value)}`);
  }
  const path = normaliseSlash(value).replace(/^\.\//, '');
  if (path.startsWith('/') || /^[A-Za-z]:\//u.test(path)) {
    throw new Error(`archive path must be relative: ${value}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`archive path is not canonical: ${value}`);
  }
  if (parts.some((part) => /[<>:"|?*\u0000-\u001f]|[. ]$/u.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw new Error(`archive path is not portable on Windows: ${value}`);
  }
  return parts.join('/');
}

function isExcludedAnywhere(name) {
  const lower = name.toLowerCase();
  return ALWAYS_EXCLUDED_TOP_LEVEL.has(lower) || EXCLUDED_ANYWHERE.some((matches) => matches(lower));
}

function fail(message, exitCode = 2) {
  process.stderr.write(`release: ${message}\n`);
  process.exitCode = exitCode;
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    gates: true,
    out: 'release',
    writeRoot: false,
    keepSmoke: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-gates') options.gates = false;
    else if (arg === '--write-root') options.writeRoot = true;
    else if (arg === '--keep-smoke') options.keepSmoke = true;
    else if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('--out requires a directory');
      options.out = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node tools/release.mjs [--out <dir>] [--no-gates] [--write-root] [--keep-smoke]\n',
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* Installed authority and dynamic release surface                            */
/* -------------------------------------------------------------------------- */

function readReleaseFile(root, path) {
  const parts = canonicalRelativePath(path).split('/');
  if (parts.some(isExcludedAnywhere)) throw new Error(`required release file is excluded: ${path}`);
  const absolute = join(realpathSync(root), ...parts);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) throw new Error(`required release file is missing: ${path}`);
  if (!stat.isFile() || stat.nlink !== 1 || relative(absolute, realpathSync(absolute)) !== '') {
    throw new Error(`release file is not an unlinked regular file: ${path}`);
  }
  return readFileSync(absolute);
}

function parseSeal(bytes, sealRelative) {
  const entries = [];
  const seen = new Set();
  const lines = bytes.toString('utf8').split(/\r?\n/u);
  for (const [zeroIndex, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/u);
    if (match === null) {
      throw new Error(`${sealRelative}:${zeroIndex + 1}: invalid SHA-256 entry`);
    }
    const path = canonicalRelativePath(match[2]);
    if (seen.has(path)) throw new Error(`${sealRelative}: duplicate path ${path}`);
    seen.add(path);
    entries.push({ path, sha256: match[1] });
  }
  if (entries.length === 0) throw new Error(`${sealRelative}: seal contains no files`);
  return entries;
}

function verifySeal(root, pack) {
  const sealBytes = readReleaseFile(root, pack.sealFile);
  const sealEntries = parseSeal(sealBytes, pack.sealFile);
  if (!sealEntries.some((entry) => entry.path === pack.manifestFile)) {
    throw new Error(`${pack.sealFile} does not bind ${pack.manifestFile}`);
  }
  const checked = [];
  for (const entry of sealEntries) {
    const full = join(root, entry.path);
    if (!existsSync(full)) {
      checked.push({ ...entry, present: false, matches: false, actual: null });
      continue;
    }
    const actual = sha256(readReleaseFile(root, entry.path));
    checked.push({ ...entry, present: true, matches: actual === entry.sha256, actual });
  }
  return {
    path: pack.sealFile,
    sha256: sha256(sealBytes),
    entries: checked,
    pass: checked.every((entry) => entry.present && entry.matches),
    missing: checked.filter((entry) => !entry.present).map((entry) => entry.path),
    mismatched: checked
      .filter((entry) => entry.present && !entry.matches)
      .map((entry) => ({ path: entry.path, expected: entry.sha256, actual: entry.actual })),
  };
}

function readDocumentationPacks(root) {
  const selector = JSON.parse(readReleaseFile(root, DOCUMENTATION_PACK_SELECTOR).toString('utf8'));
  const active = DOCUMENTATION_PACKS.v9;
  if (selector?.schemaVersion !== 'clue-documentation-pack-selector/1' ||
      Object.entries(active).some(([key, value]) => selector[key] !== value)) {
    throw new Error(`${DOCUMENTATION_PACK_SELECTOR}: pre-P2 release packaging requires the v9 documentation selector`);
  }

  const seals = {};
  for (const [version, pack] of Object.entries(DOCUMENTATION_PACKS)) {
    const seal = verifySeal(root, pack);
    if (!seal.pass) {
      const detail = [
        ...seal.missing.map((path) => `missing ${path}`),
        ...seal.mismatched.map((entry) => `hash mismatch ${entry.path}`),
      ].join('; ');
      throw new Error(`documentation ${version} seal failed: ${detail}`);
    }
    const manifest = JSON.parse(readReleaseFile(root, pack.manifestFile).toString('utf8'));
    if (manifest?.releaseVersion !== pack.releaseVersion ||
        (version === 'v10' && manifest?.status !== 'release-candidate-not-ratified')) {
      throw new Error(`${pack.manifestFile}: unexpected version or candidate status`);
    }
    const declared = version === 'v9' ? manifest.permanentFiles : manifest.files;
    if (!Array.isArray(declared) || declared.length === 0) {
      throw new Error(`${pack.manifestFile}: missing document inventory`);
    }
    const sealed = new Map(seal.entries.map((entry) => [entry.path, entry.sha256]));
    const seen = new Set([pack.manifestFile]);
    for (const entry of declared) {
      if (entry === null || seen.has(entry.path) || !sealed.has(entry.path) || sealed.get(entry.path) !== entry.sha256) {
        throw new Error(`${pack.manifestFile}: inventory disagrees with ${pack.sealFile} at ${entry?.path ?? 'unknown path'}`);
      }
      seen.add(entry.path);
    }
    if (seen.size !== sealed.size) throw new Error(`${pack.sealFile} contains paths absent from ${pack.manifestFile}`);
    seals[version] = seal;
  }
  return { selector, seals };
}

function readYamlFile(root, path) {
  try {
    return parseYaml(readReleaseFile(root, path).toString('utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalisedIdentity(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function allFilesUnder(root, relativeDirectory, excluded) {
  const directory = join(root, relativeDirectory);
  if (!existsSync(directory)) return [];
  if (relative(resolve(realpathSync(root), relativeDirectory), realpathSync(directory)) !== '') {
    throw new Error(`release surface contains a linked directory: ${relativeDirectory}`);
  }
  const found = [];
  const walk = (relativeDir) => {
    const absolute = join(root, relativeDir);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      compareUtf8(a.name, b.name),
    )) {
      if (entry.name.includes('\\')) throw new Error(`release surface contains a non-portable filename: ${entry.name}`);
      const child = canonicalRelativePath(`${normaliseSlash(relativeDir)}/${entry.name}`);
      if (excluded(child)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`release surface contains a symbolic link: ${child}`);
      }
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
      else throw new Error(`release surface contains an unsupported filesystem entry: ${child}`);
    }
  };
  walk(canonicalRelativePath(relativeDirectory));
  return found;
}

function resolveTargetInputForArchive({ input, profile, activeTarget, root }) {
  if (input === null || input === undefined) {
    return { configured: null, archivePath: null, state: 'not-registered' };
  }
  if (typeof input !== 'string' || input.trim() === '') {
    return { configured: input, archivePath: null, state: 'invalid' };
  }

  const configured = input.replace(/\\/g, '/');
  if (isAbsolute(input) || /^[A-Za-z]:\//u.test(configured)) {
    const absolute = resolve(input);
    if (absolute === root || pathInside(root, absolute)) {
      return {
        configured,
        archivePath: canonicalRelativePath(normaliseSlash(relative(root, absolute))),
        state: 'inside-repository',
      };
    }
    return { configured, archivePath: null, state: 'external-absolute' };
  }

  const relativeInput = canonicalRelativePath(configured);
  const rootCandidate = join(root, relativeInput);
  const profileRootBase = basename(String(profile.root).replace(/\\/g, '/'));
  const selfTarget =
    normalisedIdentity(profileRootBase) === normalisedIdentity(profile.id) ||
    normalisedIdentity(profileRootBase) === normalisedIdentity(activeTarget);

  if (existsSync(rootCandidate) && selfTarget) {
    return { configured, archivePath: relativeInput, state: 'self-target-repository-input' };
  }

  if (existsSync(rootCandidate)) {
    return { configured, archivePath: relativeInput, state: 'repository-input' };
  }

  return { configured, archivePath: null, state: 'external-or-missing-relative' };
}

function readAuthority(root) {
  const configFull = join(root, CONFIG_PATH);
  if (!existsSync(configFull)) throw new Error(`configuration is missing: ${CONFIG_PATH}`);
  const config = readYamlFile(root, CONFIG_PATH);
  const activeTarget = config?.project?.active_target;
  if (typeof activeTarget !== 'string' || activeTarget.trim() === '') {
    throw new Error(`${CONFIG_PATH}: project.active_target is not a non-empty string`);
  }

  const profilePath = canonicalRelativePath(`targets/${activeTarget}/profile.yaml`);
  const profileFull = join(root, profilePath);
  if (!existsSync(profileFull)) {
    throw new Error(`${CONFIG_PATH}: active target ${JSON.stringify(activeTarget)} has no ${profilePath}`);
  }
  const profile = readYamlFile(root, profilePath);
  if (profile?.id !== activeTarget) {
    throw new Error(`${profilePath}: id ${JSON.stringify(profile?.id)} does not match directory ${activeTarget}`);
  }

  const { selector: documentationPack, seals: documentationSeals } = readDocumentationPacks(root);

  const trackedDocuments = Array.isArray(config?.constitution?.tracked_documents)
    ? config.constitution.tracked_documents.map(canonicalRelativePath)
    : [];
  const constitutionFile =
    typeof config?.constitution?.file === 'string'
      ? canonicalRelativePath(config.constitution.file)
      : null;
  const v9Files = new Set(documentationSeals.v9.entries.map((entry) => entry.path));
  const v10OnlyFiles = documentationSeals.v10.entries.filter((entry) => !v9Files.has(entry.path));
  if (v10OnlyFiles.some((entry) => entry.path === constitutionFile || trackedDocuments.includes(entry.path))) {
    throw new Error(`${CONFIG_PATH}: tracked authority selects a document reserved for the v10 candidate pack`);
  }

  const targetDirectory = canonicalRelativePath(`targets/${activeTarget}`);
  const excludes = releaseExclusions(root, config);
  const targetFiles = allFilesUnder(root, targetDirectory, excludes);
  const description = resolveTargetInputForArchive({
    input: profile?.inputs?.description ?? null,
    profile,
    activeTarget,
    root,
  });
  const benchmark = resolveTargetInputForArchive({
    input: profile?.inputs?.benchmark ?? null,
    profile,
    activeTarget,
    root,
  });

  const requiredPaths = new Set([
    ...ALWAYS_INCLUDED,
    ...REQUIRED_OPERATOR_PATHS,
    profilePath,
    ...Object.values(documentationSeals).flatMap((seal) => [seal.path, ...seal.entries.map((entry) => entry.path)]),
    ...trackedDocuments,
    ...targetFiles,
  ]);
  if (constitutionFile !== null) requiredPaths.add(constitutionFile);
  if (description.archivePath !== null) requiredPaths.add(description.archivePath);
  if (benchmark.archivePath !== null) requiredPaths.add(benchmark.archivePath);

  return {
    config,
    activeTarget,
    profilePath,
    profile,
    trackedDocuments,
    constitutionFile,
    seal: documentationSeals.v9,
    documentationPack,
    documentationSeals,
    targetDirectory,
    targetFiles,
    inputs: { description, benchmark },
    requiredPaths: [...requiredPaths].sort(compareUtf8),
  };
}

function releaseExclusions(root, config, outputDirectory = null) {
  const liveRoots = [config?.workspace?.root, config?.shadow?.root, config?.browser?.profile_dir]
    .filter((path) => typeof path === 'string' && path !== '')
    .map((path) => resolve(root, path));
  const protectedRoots = outputDirectory === null ? liveRoots : [...liveRoots, outputDirectory];
  return (path) => {
    if (path.split('/').some(isExcludedAnywhere)) return true;
    // These Configuration-v3 files describe this installation and can contain local state.
    if (path.toLowerCase() === 'config/project-profiles.yaml' ||
      /^config\/backups\/clue\.config\.v2\.[^/]*\.yaml$/iu.test(path)) return true;
    const absolute = resolve(root, path);
    return protectedRoots.some((directory) => relative(directory, absolute) === '' || pathInside(directory, absolute));
  };
}

function addFileOrDirectory(found, relativePath, excluded) {
  const path = canonicalRelativePath(relativePath);
  if (excluded(path)) return;

  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) return;

  const stat = lstatSync(absolute, { throwIfNoEntry: true });
  if (stat.isSymbolicLink()) {
    throw new Error(`release surface contains a symbolic link: ${path}`);
  }
  if (stat.isDirectory()) {
    for (const child of allFilesUnder(ROOT, path, excluded)) found.add(child);
  } else if (stat.isFile()) {
    found.add(path);
  } else {
    throw new Error(`unsupported release entry: ${path}`);
  }
}

function collectFiles(packageAllowlist, authority, outputDirectory) {
  const found = new Set();
  const excluded = releaseExclusions(ROOT, authority.config, outputDirectory);
  for (const item of packageAllowlist) {
    const normal = String(item).replace(/\\/g, '/').replace(/\/$/u, '');
    if (normal !== '') addFileOrDirectory(found, normal, excluded);
  }
  for (const item of authority.requiredPaths) addFileOrDirectory(found, item, excluded);

  for (const required of authority.requiredPaths) {
    if (!found.has(required)) {
      throw new Error(`required authority/target file is absent from the release set: ${required}`);
    }
  }

  const paths = [...found].sort(compareUtf8);
  const caseFolded = new Map();
  for (const path of paths) {
    const components = path.split('/');
    for (const [index] of components.entries()) {
      const prefix = components.slice(0, index + 1).join('/');
      const windowsPath = prefix.toLowerCase();
      const prior = caseFolded.get(windowsPath);
      if (prior !== undefined && prior !== prefix) throw new Error(`case-insensitive archive path collision: ${prefix}`);
      caseFolded.set(windowsPath, prefix);
    }
  }
  return paths;
}

/* -------------------------------------------------------------------------- */
/* Deterministic ZIP writer and validating reader                             */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000;
const UTF8_FLAG = 0x0800;

function writeZip(entries) {
  if (entries.length >= 0xffff) throw new Error('ZIP64 is required for 65,535 or more files');
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const path = canonicalRelativePath(entry.path);
    const nameBytes = Buffer.from(path, 'utf8');
    if (nameBytes.length >= 0xffff) throw new Error(`ZIP path is too long: ${path}`);
    const bytes = entry.bytes;
    if (bytes.length >= 0xffffffff) throw new Error(`${path} exceeds the non-ZIP64 size limit`);
    const crc = crc32(bytes);
    // Store bytes without compression. This removes zlib-version variance from the
    // archive identity while retaining a standards-compliant ZIP container.
    const payload = bytes;
    const method = 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(UTF8_FLAG, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(DOS_TIME, 12);
    directory.writeUInt16LE(DOS_DATE, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(payload.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
    if (offset >= 0xffffffff) throw new Error('ZIP64 is required for an archive larger than 4 GiB');
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

function readZipEntries(archive) {
  if (archive.length < 22) throw new Error('truncated ZIP end record');

  // The release format is deliberately closed: one disk, no comment, no ZIP64,
  // one central-directory record per file, and no trailing bytes.
  const endOffset = archive.length - 22;
  if (archive.readUInt32LE(endOffset) !== 0x06054b50) {
    throw new Error('ZIP end-of-central-directory record is missing or not final');
  }
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error('multi-disk ZIP archives are not accepted');
  }
  if (commentLength !== 0 || endOffset + 22 + commentLength !== archive.length) {
    throw new Error('ZIP comments or trailing bytes are not accepted');
  }
  if (totalEntries === 0) throw new Error('ZIP contains no file entries');
  if (centralOffset + centralSize !== endOffset) {
    throw new Error('ZIP central-directory bounds do not match the final end record');
  }

  const central = [];
  const seen = new Set();
  let cursor = centralOffset;
  while (cursor < endOffset) {
    if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`invalid central ZIP signature at byte ${cursor}`);
    }
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const versionNeeded = archive.readUInt16LE(cursor + 6);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const internalAttributes = archive.readUInt16LE(cursor + 36);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const recordEnd = nameStart + nameLength + extraLength + entryCommentLength;
    if (recordEnd > endOffset) throw new Error('truncated ZIP central-directory record');
    if (
      versionMadeBy !== 20 ||
      versionNeeded !== 20 ||
      flags !== UTF8_FLAG ||
      (method !== 0 && method !== 8) ||
      extraLength !== 0 ||
      entryCommentLength !== 0 ||
      diskStart !== 0 ||
      internalAttributes !== 0 ||
      externalAttributes !== 0
    ) {
      throw new Error('ZIP central-directory record is outside the closed release format');
    }
    const path = canonicalRelativePath(
      archive.subarray(nameStart, nameStart + nameLength).toString('utf8'),
    );
    if (seen.has(path)) throw new Error(`duplicate ZIP entry: ${path}`);
    seen.add(path);
    central.push({
      path,
      flags,
      method,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    cursor = recordEnd;
  }
  if (cursor !== endOffset || central.length !== totalEntries) {
    throw new Error(
      `ZIP central-directory entry count mismatch: expected ${totalEntries}, read ${central.length}`,
    );
  }

  const entries = [];
  let expectedLocalOffset = 0;
  for (const record of central) {
    const offset = record.localOffset;
    if (offset !== expectedLocalOffset) {
      throw new Error(`${record.path}: local ZIP records are missing, overlapping, or out of order`);
    }
    if (offset + 30 > centralOffset || archive.readUInt32LE(offset) !== 0x04034b50) {
      throw new Error(`${record.path}: invalid or truncated local ZIP header`);
    }
    const versionNeeded = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const expectedCrc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if (
      versionNeeded !== 20 ||
      flags !== record.flags ||
      method !== record.method ||
      expectedCrc !== record.expectedCrc ||
      compressedSize !== record.compressedSize ||
      uncompressedSize !== record.uncompressedSize ||
      extraLength !== 0
    ) {
      throw new Error(`${record.path}: local and central ZIP authority disagree`);
    }
    const nameStart = offset + 30;
    const payloadStart = nameStart + nameLength + extraLength;
    const payloadEnd = payloadStart + compressedSize;
    if (payloadEnd > centralOffset) throw new Error(`${record.path}: truncated ZIP payload`);
    const localPath = canonicalRelativePath(
      archive.subarray(nameStart, nameStart + nameLength).toString('utf8'),
    );
    if (localPath !== record.path) {
      throw new Error(`${record.path}: local and central ZIP paths disagree (${localPath})`);
    }
    const payload = archive.subarray(payloadStart, payloadEnd);
    const bytes = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    if (bytes.length !== uncompressedSize) {
      throw new Error(`${record.path}: uncompressed size mismatch`);
    }
    if (crc32(bytes) !== expectedCrc) throw new Error(`${record.path}: CRC-32 mismatch`);
    entries.push({ path: record.path, bytes });
    expectedLocalOffset = payloadEnd;
  }
  if (expectedLocalOffset !== centralOffset) {
    throw new Error('ZIP local-file area does not end at the declared central directory');
  }
  return entries;
}

function extractZip(archive, destination) {
  const entries = readZipEntries(archive);
  mkdirSync(destination, { recursive: true });
  const destinationRoot = resolve(destination);
  for (const entry of entries) {
    const path = join(destinationRoot, ...entry.path.split('/'));
    const resolvedPath = resolve(path);
    if (!pathInside(destinationRoot, resolvedPath)) {
      throw new Error(`ZIP entry escapes extraction root: ${entry.path}`);
    }
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, entry.bytes);
  }
  return entries;
}

function enumerateFiles(root, excludedTopLevel = new Set()) {
  const found = [];
  const walk = (relativeDirectory) => {
    const absolute = relativeDirectory === '' ? root : join(root, relativeDirectory);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      compareUtf8(a.name, b.name),
    )) {
      const child = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const canonical = canonicalRelativePath(normaliseSlash(child));
      if (excludedTopLevel.has(canonical.split('/')[0])) continue;
      if (entry.isSymbolicLink()) throw new Error(`unexpected symbolic link in extracted tree: ${canonical}`);
      if (entry.isDirectory()) walk(canonical);
      else if (entry.isFile()) found.push(canonical);
      else throw new Error(`unexpected filesystem entry in extracted tree: ${canonical}`);
    }
  };
  walk('');
  return found.sort(compareUtf8);
}

function verifyExactTree(root, expectedEntries) {
  const expected = new Map(expectedEntries.map((entry) => [entry.path, entry.sha256]));
  const actualPaths = enumerateFiles(root);
  const missing = [...expected.keys()].filter((path) => !actualPaths.includes(path));
  const extra = actualPaths.filter((path) => !expected.has(path));
  const mismatched = [];
  for (const [path, expectedHash] of expected) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const actualHash = sha256(readFileSync(full));
    if (actualHash !== expectedHash) mismatched.push({ path, expected: expectedHash, actual: actualHash });
  }
  return {
    pass: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    expectedFiles: expected.size,
    actualFiles: actualPaths.length,
    missing,
    extra,
    mismatched,
  };
}

function verifyArchivedFilesUnchanged(root, expectedEntries) {
  const missing = [];
  const invalid = [];
  const mismatched = [];
  for (const entry of expectedEntries) {
    const full = join(root, entry.path);
    if (!existsSync(full)) {
      missing.push(entry.path);
      continue;
    }
    try {
      const actual = sha256(readReleaseFile(root, entry.path));
      if (actual !== entry.sha256) mismatched.push({ path: entry.path, expected: entry.sha256, actual });
    } catch {
      invalid.push(entry.path);
    }
  }
  return {
    pass: missing.length === 0 && invalid.length === 0 && mismatched.length === 0,
    checked: expectedEntries.length,
    missing,
    invalid,
    mismatched,
  };
}

/* -------------------------------------------------------------------------- */
/* Bounded, file-backed process execution                                     */
/* -------------------------------------------------------------------------- */

function commandText(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(' ');
}

function releaseTestEnvironment() {
  const configuredKey = readYamlFile(ROOT, CONFIG_PATH).gateway?.api_key_env;
  const excluded = new Set(['OPENAI_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT']);
  if (typeof configuredKey === 'string') excluded.add(configuredKey.toUpperCase());
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.has(name.toUpperCase())));
}

function safeLabel(label) {
  return label.replace(/[^A-Za-z0-9_.-]/gu, '_');
}

function killProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // best effort
    }
    return;
  }

  // POSIX children are started as their own process group. Kill the group so a timed-out npm,
  // compiler, native-addon build, or test cannot leave grandchildren running after the release
  // command has already recorded a failure.
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 2_000).unref?.();
}

function runBounded({
  command,
  args,
  cwd,
  label,
  logDirectory,
  timeoutMs,
  env = releaseTestEnvironment(),
  shell = false,
  acceptedExitCodes = [0],
}) {
  return new Promise((resolveResult) => {
    mkdirSync(logDirectory, { recursive: true });
    const stem = safeLabel(label);
    const stdoutPath = join(logDirectory, `${stem}.stdout.log`);
    const stderrPath = join(logDirectory, `${stem}.stderr.log`);
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let child;
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    let timer = null;

    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } catch (error) {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      resolveResult({
        label,
        command: commandText(command, args),
        cwd,
        startedAt,
        durationMs: Date.now() - started,
        exitCode: null,
        signal: null,
        timedOut: false,
        pass: false,
        spawnError: error instanceof Error ? error.message : String(error),
        stdoutPath,
        stderrPath,
        stdout: '',
        stderr: '',
      });
      return;
    } finally {
      try { closeSync(stdoutFd); } catch { /* already closed */ }
      try { closeSync(stderrFd); } catch { /* already closed */ }
    }

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      let stdout = '';
      let stderr = '';
      try { stdout = readFileSync(stdoutPath, 'utf8'); } catch { /* no output */ }
      try { stderr = readFileSync(stderrPath, 'utf8'); } catch { /* no output */ }
      resolveResult({
        label,
        command: commandText(command, args),
        cwd,
        startedAt,
        durationMs: Date.now() - started,
        exitCode,
        signal,
        timedOut,
        pass:
          !timedOut &&
          spawnError === null &&
          exitCode !== null &&
          acceptedExitCodes.includes(exitCode),
        spawnError,
        stdoutPath,
        stderrPath,
        stdout,
        stderr,
      });
    };

    child.on('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
      finish(null, null);
    });
    child.on('exit', (code, signal) => finish(code, signal));

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timer.unref?.();
  });
}

function npmInvocation(args) {
  return { ...resolveNpmInvocation(args), shell: false };
}

function npmCiInvocation() {
  const mode = process.env.CLUE_RELEASE_NPM_MODE ?? 'prefer-offline';
  const modeArgs = {
    'prefer-offline': ['--prefer-offline'],
    online: [],
    offline: ['--offline'],
  }[mode];
  if (modeArgs === undefined) {
    throw new Error(
      `CLUE_RELEASE_NPM_MODE must be prefer-offline, online, or offline; received ${JSON.stringify(mode)}`,
    );
  }

  // npm gets its own finite network policy inside the outer process timeout. A disconnected
  // registry therefore creates a prompt, explicit BLOCKED report instead of an apparently frozen
  // release command. The outer timeout still covers extraction and native-addon compilation.
  return npmInvocation([
    'ci',
    ...modeArgs,
    '--no-audit',
    '--no-fund',
    '--fetch-retries=1',
    '--fetch-retry-mintimeout=1000',
    '--fetch-retry-maxtimeout=5000',
    '--fetch-timeout=30000',
  ]);
}

function localTsc(root) {
  return join(root, 'node_modules', 'typescript', 'bin', 'tsc');
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

async function runSelfTests(extractedRoot, logDirectory) {
  const directory = join(extractedRoot, 'dist', 'selftest');
  if (!existsSync(directory)) {
    return {
      label: 'selftest',
      pass: false,
      completed: false,
      tests: 0,
      passCount: 0,
      fail: 1,
      skipped: 0,
      files: [],
      reason: 'dist/selftest does not exist after build',
    };
  }
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.test.js'))
    .sort(compareUtf8);
  if (files.length === 0) {
    return {
      label: 'selftest',
      pass: false,
      completed: false,
      tests: 0,
      passCount: 0,
      fail: 1,
      skipped: 0,
      files: [],
      reason: 'no compiled self-test files found',
    };
  }

  const results = await mapWithConcurrency(files, TEST_CONCURRENCY, (file) =>
    runBounded({
      command: process.execPath,
      args: ['--test', '--test-reporter=tap', '--test-force-exit', join(directory, file)],
      cwd: extractedRoot,
      label: `selftest-${file}`,
      logDirectory,
      timeoutMs: DEFAULT_TIMEOUTS.testFile,
      env: releaseTestEnvironment(),
    }),
  );

  const fileResults = results.map((result, index) => {
    const counts = readTapCounts(result.stdout);
    const effectiveFail = Math.max(counts === null ? 0 : counts.fail + counts.cancelled, result.pass && counts !== null ? 0 : 1);
    return {
      file: files[index],
      tests: counts?.tests ?? 0,
      pass: counts?.pass ?? 0,
      fail: effectiveFail,
      reportedFail: counts?.fail ?? 0,
      skipped: counts?.skipped ?? 0,
      summaryValid: counts !== null,
      proofTests: nativeProofTapCoverage(files[index], result.stdout),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      durationMs: result.durationMs,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
    };
  });

  const summary = fileResults.reduce(
    (acc, item) => {
      acc.tests += item.tests;
      acc.passCount += item.pass;
      acc.fail += item.fail;
      acc.skipped += item.skipped;
      if (item.timedOut || item.spawnError !== null || item.exitCode !== 0 || !item.summaryValid) acc.completed = false;
      return acc;
    },
    { tests: 0, passCount: 0, fail: 0, skipped: 0, completed: true },
  );

  return {
    label: 'selftest',
    pass: summary.completed && summary.tests > 0 && summary.fail === 0,
    completed: summary.completed,
    concurrency: TEST_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUTS.testFile,
    tests: summary.tests,
    passCount: summary.passCount,
    fail: summary.fail,
    skipped: summary.skipped,
    files: fileResults,
  };
}

/* -------------------------------------------------------------------------- */
/* Source gates and extracted-archive smoke                                   */
/* -------------------------------------------------------------------------- */

async function runSourceGates(logDirectory) {
  const gates = [];
  const npm = npmInvocation(['run', 'clean']);
  gates.push(
    await runBounded({
      ...npm,
      cwd: ROOT,
      label: 'source-clean',
      logDirectory,
      timeoutMs: DEFAULT_TIMEOUTS.sourceGate,
    }),
  );
  if (!gates.at(-1).pass) return gates;

  const tsc = localTsc(ROOT);
  if (!existsSync(tsc)) {
    gates.push({
      label: 'source-typecheck',
      pass: false,
      reason: 'node_modules/typescript is not installed; run npm ci first',
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
    });
    return gates;
  }

  gates.push(
    await runBounded({
      command: process.execPath,
      args: [tsc, '--noEmit'],
      cwd: ROOT,
      label: 'source-typecheck',
      logDirectory,
      timeoutMs: DEFAULT_TIMEOUTS.sourceGate,
    }),
  );
  if (!gates.at(-1).pass) return gates;

  gates.push(
    await runBounded({
      command: process.execPath,
      args: [tsc],
      cwd: ROOT,
      label: 'source-build',
      logDirectory,
      timeoutMs: DEFAULT_TIMEOUTS.sourceGate,
    }),
  );
  return gates;
}

function structuralSmoke(extractedRoot, expectedEntries, expectedAuthority) {
  const exactTree = verifyExactTree(extractedRoot, expectedEntries);
  let authority = null;
  let error = null;
  try {
    authority = readAuthority(extractedRoot);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const expectedRequired = new Set(expectedAuthority.requiredPaths);
  const extractedRequired = new Set(authority?.requiredPaths ?? []);
  const requiredMissing = [...expectedRequired].filter((path) => !extractedRequired.has(path));
  const sealsMatch = Object.keys(DOCUMENTATION_PACKS).every((version) =>
    authority?.documentationSeals[version].sha256 === expectedAuthority.documentationSeals[version].sha256,
  );
  const targetProfilePresent = existsSync(join(extractedRoot, expectedAuthority.profilePath));
  const masterBenchmarkCandidates = expectedAuthority.targetFiles.filter((path) =>
    /(^|\/)benchmark\/master-benchmark\.md$/u.test(path),
  );

  return {
    pass:
      exactTree.pass &&
      error === null &&
      sealsMatch &&
      authority?.activeTarget === expectedAuthority.activeTarget &&
      targetProfilePresent &&
      requiredMissing.length === 0,
    exactTree,
    authorityError: error,
    documentationSeal: authority?.seal ?? null,
    documentationPack: authority?.documentationPack ?? null,
    documentationSeals: authority?.documentationSeals ?? null,
    activeTarget: authority?.activeTarget ?? null,
    targetProfile: expectedAuthority.profilePath,
    targetProfilePresent,
    targetFiles: authority?.targetFiles ?? [],
    requiredMissing,
    inputs: authority?.inputs ?? null,
    masterBenchmarkCandidates,
  };
}

async function runProductionConfigLoad(extractedRoot, logDirectory) {
  const source = [
    "import { loadConfig } from './dist/src/control/runtime.js';",
    'const config = loadConfig(process.cwd());',
    'process.stdout.write(JSON.stringify({',
    '  activeTarget: config.project.active_target,',
    '  id: config.project.id,',
    '  name: config.project.name ?? null,',
    '  description: config.project.inputs.description,',
    '  benchmark: config.project.inputs.benchmark,',
    '  remote: config.project.remote,',
    '}) + "\\n");',
  ].join('\n');
  const result = await runBounded({
    command: process.execPath,
    args: ['--input-type=module', '--eval', source],
    cwd: extractedRoot,
    label: 'extracted-config-load',
    logDirectory,
    timeoutMs: DEFAULT_TIMEOUTS.extractedGate,
  });
  let loaded = null;
  let parseError = null;
  if (result.pass) {
    try {
      loaded = JSON.parse(result.stdout.trim());
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...result,
    pass: result.pass && loaded !== null && typeof loaded.activeTarget === 'string',
    loaded,
    parseError,
  };
}

async function runProjectProfilesAcceptance({ extractedRoot, logDirectory, outputDirectory, base, archiveSha }) {
  const reportPath = join(logDirectory, 'project-profiles-acceptance.json');
  const windows = process.platform === 'win32';
  const result = await runBounded({
    command: process.execPath,
    args: ['tools/project-profiles-acceptance.mjs', '--output', reportPath, ...(windows ? [] : ['--portable'])],
    cwd: extractedRoot,
    label: 'extracted-project-profiles-acceptance',
    logDirectory,
    timeoutMs: DEFAULT_TIMEOUTS.p0,
  });
  let report = null;
  let evidence = null;
  let readError = null;
  try {
    const bytes = readFileSync(reportPath);
    report = JSON.parse(bytes.toString('utf8'));
    const file = `${base}.project-profiles-acceptance.json`;
    writeFileSync(join(outputDirectory, file), bytes, { flag: 'wx' });
    evidence = { file, sha256: sha256(bytes), archiveSha256: archiveSha };
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }
  const expectedStatus = windows
    ? 'STATIC_AND_HOST_AUTOMATION_PASS_LIVE_CONNECTION_GATES_PENDING'
    : 'PORTABLE_PASS_WINDOWS_ACCEPTANCE_PENDING';
  return {
    ...result,
    pass: result.pass && evidence !== null && report?.schemaVersion === 'clue-project-profiles-acceptance-report/1' &&
      report.status === expectedStatus && report.platform?.platform === process.platform &&
      (!windows || report.execution?.portableSkipped?.length === 0),
    mode: report?.mode ?? null,
    status: report?.status ?? null,
    evidence,
    readError,
  };
}

async function runNativeProofReadiness(extractedRoot, logDirectory, selftest) {
  if (process.platform !== 'win32') return assessNativeProofIntegration(process.platform, null, selftest.files);
  const result = await runBounded({
    command: process.execPath,
    args: ['--input-type=module', '--eval', [
      "import { requireProofExecutionBoundary } from './dist/src/benchmark/restrictedExecution.js';",
      'process.stdout.write(JSON.stringify(requireProofExecutionBoundary()));',
    ].join('\n')],
    cwd: extractedRoot,
    label: 'extracted-proof-supervisor-pin',
    logDirectory,
    timeoutMs: 15_000,
  });
  let pin = null;
  if (result.pass) {
    try { pin = JSON.parse(result.stdout); } catch { /* A malformed response proves no pin. */ }
  }
  return {
    ...assessNativeProofIntegration(process.platform, pin, selftest.files),
    pinCheck: { exitCode: result.exitCode, timedOut: result.timedOut, spawnError: result.spawnError },
  };
}

function evaluateP0Report(report, archiveSha) {
  const items = Array.isArray(report?.items) ? report.items : [];
  const fingerprints = Array.isArray(report?.fingerprints) ? report.fingerprints : [];
  const failedItems = items.filter((item) => item?.pass !== true).map((item) => item?.id ?? 'unknown');
  const missingFingerprints = fingerprints
    .filter((item) => item?.present !== true)
    .map((item) => item?.feature ?? 'unknown');
  const subject = report?.subject ?? null;
  const archiveMatches =
    subject?.bound === true &&
    subject?.matches === true &&
    subject?.archive?.sha256 === archiveSha;
  const platform = String(report?.meta?.platform ?? '');
  const pwshFound = report?.environment?.pwsh?.found === true;
  const sqliteNative = String(report?.environment?.betterSqlite3 ?? '').toLowerCase() === 'native';
  const nativeWindows = platform.startsWith('win32/') && pwshFound && sqliteNative;
  return {
    pass:
      report?.fatal === undefined &&
      items.length >= 16 &&
      failedItems.length === 0 &&
      fingerprints.length > 0 &&
      missingFingerprints.length === 0 &&
      archiveMatches,
    itemsTotal: items.length,
    itemsPassed: items.length - failedItems.length,
    failedItems,
    fingerprintsTotal: fingerprints.length,
    missingFingerprints,
    archiveMatches,
    subject,
    platform,
    pwshFound,
    sqliteNative,
    nativeWindows,
    fatal: report?.fatal ?? null,
    note:
      'The P0 harness intentionally ran with --skip-suite; this release command ran the complete ' +
      'isolated suite separately. Formal acceptance is the conjunction of both gates.',
  };
}

async function runExtractedSmoke({
  extractedRoot,
  expectedEntries,
  authority,
  candidateReportPath,
  archiveSha,
  logDirectory,
  outputDirectory,
  base,
}) {
  const result = {
    schema: 'clue.release.smoke/2',
    extractedRoot,
    structural: structuralSmoke(extractedRoot, expectedEntries, authority),
    install: null,
    typecheck: null,
    build: null,
    configLoad: null,
    archivedFilesAfterBuild: null,
    archivedFilesAfterGates: null,
    selftest: null,
    projectProfiles: null,
    nativeProof: null,
    p0: null,
    pass: false,
  };
  if (!result.structural.pass) return result;

  const npmCi = npmCiInvocation();
  result.install = await runBounded({
    ...npmCi,
    cwd: extractedRoot,
    label: 'extracted-npm-ci',
    logDirectory,
    timeoutMs: DEFAULT_TIMEOUTS.npmCi,
    env: {
      ...releaseTestEnvironment(),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
  });
  if (!result.install.pass) return result;

  const tsc = localTsc(extractedRoot);
  if (!existsSync(tsc)) {
    result.typecheck = { label: 'extracted-typecheck', pass: false, reason: 'typescript was not installed by npm ci' };
    return result;
  }

  result.typecheck = await runBounded({
    command: process.execPath,
    args: [tsc, '--noEmit'],
    cwd: extractedRoot,
    label: 'extracted-typecheck',
    logDirectory,
    timeoutMs: DEFAULT_TIMEOUTS.extractedGate,
  });
  if (!result.typecheck.pass) return result;

  result.build = await runBounded({
    command: process.execPath,
    args: [tsc],
    cwd: extractedRoot,
    label: 'extracted-build',
    logDirectory,
    timeoutMs: DEFAULT_TIMEOUTS.extractedGate,
  });
  if (!result.build.pass) return result;

  result.configLoad = await runProductionConfigLoad(extractedRoot, logDirectory);
  if (!result.configLoad.pass) return result;

  result.archivedFilesAfterBuild = verifyArchivedFilesUnchanged(extractedRoot, expectedEntries);
  if (!result.archivedFilesAfterBuild.pass) return result;

  result.selftest = await runSelfTests(extractedRoot, logDirectory);
  if (!result.selftest.pass) return result;
  result.nativeProof = await runNativeProofReadiness(extractedRoot, logDirectory, result.selftest);
  result.projectProfiles = await runProjectProfilesAcceptance({ extractedRoot, logDirectory, outputDirectory, base, archiveSha });
  if (!result.projectProfiles.pass) return result;

  const p0Run = await runBounded({
    command: process.execPath,
    args: [
      join(extractedRoot, 'tools', 'p0-acceptance.mjs'),
      '--repo',
      extractedRoot,
      '--release',
      candidateReportPath,
      '--no-build',
      '--skip-suite',
    ],
    cwd: extractedRoot,
    label: 'extracted-p0-adversarial',
    logDirectory,
    timeoutMs: DEFAULT_TIMEOUTS.p0,
    env: { ...releaseTestEnvironment(), SKIP_BUILD: '1' },
    // The P0 harness exits 1 because --skip-suite makes its standalone overallPass false. The
    // release command evaluates its item/fingerprint/archive fields below and combines them with
    // the complete isolated suite that has already passed.
    acceptedExitCodes: [0, 1],
  });

  const p0Path = join(extractedRoot, 'p0-acceptance-report.json');
  let p0Report = null;
  let p0ReadError = null;
  try {
    p0Report = JSON.parse(readFileSync(p0Path, 'utf8'));
    copyFileSync(p0Path, join(outputDirectory, `${base}.p0-acceptance-report.json`));
  } catch (error) {
    p0ReadError = error instanceof Error ? error.message : String(error);
  }
  const evaluation = p0Report === null
    ? { pass: false, error: p0ReadError }
    : evaluateP0Report(p0Report, archiveSha);
  result.p0 = {
    process: {
      pass: p0Run.pass,
      exitCode: p0Run.exitCode,
      timedOut: p0Run.timedOut,
      spawnError: p0Run.spawnError,
      durationMs: p0Run.durationMs,
      stdoutPath: p0Run.stdoutPath,
      stderrPath: p0Run.stderrPath,
    },
    evaluation,
  };
  result.archivedFilesAfterGates = verifyArchivedFilesUnchanged(extractedRoot, expectedEntries);

  result.pass =
    result.structural.pass &&
    result.install.pass &&
    result.typecheck.pass &&
    result.build.pass &&
    result.configLoad.pass &&
    result.archivedFilesAfterBuild.pass &&
    result.archivedFilesAfterGates.pass &&
    result.selftest.pass &&
    result.projectProfiles.pass &&
    p0Run.pass &&
    evaluation.pass;
  return result;
}

/* -------------------------------------------------------------------------- */
/* Identity, reports, evidence                                                 */
/* -------------------------------------------------------------------------- */

function gitProbe(args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)));
  const result = spawnSync('git', [
    '--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout ?? '') : null;
}

function gitFacts() {
  const top = gitProbe(['rev-parse', '--show-toplevel'])?.trim();
  if (!top || relative(realpathSync(ROOT), realpathSync(top)) !== '') {
    return { available: false, reason: 'release root is not the root of a local Git worktree, or Git is unavailable' };
  }
  const commit = gitProbe(['rev-parse', '--verify', 'HEAD^{commit}'])?.trim();
  const tree = commit === undefined ? undefined : gitProbe(['rev-parse', '--verify', `${commit}^{tree}`])?.trim();
  const objectFormat = gitProbe(['rev-parse', '--show-object-format'])?.trim();
  if (!commit || !tree || !['sha1', 'sha256'].includes(objectFormat)) {
    return { available: false, reason: 'local Git HEAD, tree or object format could not be read' };
  }
  const status = gitProbe(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  return {
    available: true,
    commit,
    tree,
    objectFormat,
    branch: gitProbe(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? null,
    dirty: status === null ? null : status !== '',
  };
}

function sameGitIdentity(before, after) {
  return before.available && after.available && before.commit === after.commit &&
    before.tree === after.tree && before.objectFormat === after.objectFormat;
}

/** A clean status alone does not bind ignored paths or transformed checkout bytes. */
function bindArchiveToGit(entries, start) {
  const current = gitFacts();
  const unbound = (reason) => ({ ...current, archiveBound: false, reason });
  if (!current.available) return unbound(current.reason);
  if (!sameGitIdentity(start, current)) return unbound('local Git HEAD changed or was unavailable during archive preparation');
  if (start.dirty !== false || current.dirty !== false) return unbound('the local Git worktree was dirty or cleanliness could not be verified');

  const listing = gitProbe(['ls-tree', '-r', '-z', '--full-tree', current.tree]);
  if (listing === null) return unbound('the local Git tree could not be enumerated');
  const blobs = new Map();
  for (const item of listing.split('\0')) {
    if (item === '') continue;
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(item);
    if (match !== null) blobs.set(match[3], match[2]);
  }
  for (const { path, bytes } of entries) {
    const oid = blobs.get(path);
    if (oid === undefined) return unbound(`archive path has no regular Git blob at HEAD: ${path}`);
    const actual = createHash(current.objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (oid !== actual) return unbound(`archive bytes differ from the Git blob at HEAD: ${path}`);
  }
  return { ...current, archiveBound: true, boundEntries: entries.length, reason: null };
}

function confirmArchiveGitBinding(binding) {
  if (!binding.archiveBound) return binding;
  const current = gitFacts();
  if (sameGitIdentity(binding, current) && current.dirty === false) return binding;
  return { ...binding, archiveBound: false, boundEntries: 0, reason: 'local Git HEAD or worktree cleanliness changed after archiving' };
}

function toolchain(root = ROOT) {
  const version = (command, args, shell = false) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      shell,
      windowsHide: true,
    });
    return result.status === 0 ? String(result.stdout ?? '').trim().split(/\r?\n/u)[0] : null;
  };
  const installed = (name) => {
    const manifest = join(root, 'node_modules', name, 'package.json');
    if (!existsSync(manifest)) return null;
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    npm: version('npm', ['--version'], process.platform === 'win32'),
    declaredEngines: pkg.engines ?? null,
    typescript: {
      declared: pkg.dependencies?.typescript ?? null,
      installed: installed('typescript'),
      usedForGates: 'node_modules/typescript/bin/tsc',
    },
    nativeAddon: {
      name: 'better-sqlite3',
      installed: installed('better-sqlite3'),
      note: 'not shipped; npm ci installs/builds it for the extracted host',
    },
  };
}

function previousReport(outputDirectory) {
  if (!existsSync(outputDirectory)) return null;
  const candidates = readdirSync(outputDirectory)
    .filter((name) => name.endsWith('.report.json') && !name.endsWith('.candidate.report.json'))
    .map((name) => join(outputDirectory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Try the next report.
    }
  }
  return null;
}

function documentDrift(authority, prior) {
  if (prior === null || !Array.isArray(prior?.authority?.documentationSeal?.entries)) return null;
  const before = new Map(prior.authority.documentationSeal.entries.map((entry) => [entry.path, entry.actual ?? entry.sha256]));
  const drift = [];
  for (const entry of authority.seal.entries) {
    const was = before.get(entry.path);
    if (was !== undefined && was !== entry.actual) {
      drift.push({ path: entry.path, was, now: entry.actual });
    }
  }
  return drift;
}

function gateSummary(gate) {
  if (gate === null || gate === undefined) return null;
  const output = { ...gate };
  delete output.stdout;
  delete output.stderr;
  return output;
}

function sourceGatePass(gates) {
  return gates.length === 3 && gates.every((gate) => gate.pass === true);
}

function smokeSummary(smoke) {
  if (smoke === null) return null;
  return {
    schema: smoke.schema,
    pass: smoke.pass,
    structural: smoke.structural,
    install: gateSummary(smoke.install),
    typecheck: gateSummary(smoke.typecheck),
    build: gateSummary(smoke.build),
    configLoad: gateSummary(smoke.configLoad),
    archivedFilesAfterBuild: smoke.archivedFilesAfterBuild,
    archivedFilesAfterGates: smoke.archivedFilesAfterGates,
    selftest: smoke.selftest,
    projectProfiles: gateSummary(smoke.projectProfiles),
    nativeProof: smoke.nativeProof,
    p0: smoke.p0,
  };
}

function limitations(report) {
  const items = [];
  if (!report.tree.available) {
    items.push('No Git commit/tree identity is available; the complete per-file SHA-256 manifest is the release identity.');
  } else if (!report.tree.archiveBound) {
    items.push(`Local Git archive binding failed: ${report.tree.reason}.`);
  }
  const skipped = report.smoke?.selftest?.skipped ?? 0;
  if (skipped > 0) {
    items.push(`${skipped} self-test(s) were skipped on this host; native/platform closure still requires their reference-host run.`);
  }
  if (report.authority.target.inputs.benchmark.state === 'not-registered') {
    items.push('The active target profile explicitly registers no Master Benchmark yet; candidate benchmark files are shipped but strict P2 benchmark lock remains open.');
  }
  if (report.authority.target.profile.remote === null) {
    items.push('The active target profile records no remote; publication/Git provenance is outside this release evidence.');
  }
  if (report.verdict === 'UNGATED') {
    items.push('No clean-install, build, self-test, or P0 adversarial gates were run. This archive is diagnostic, not a release.');
  }
  if (report.verdict === 'RELEASE_CANDIDATE') {
    if (report.releaseQualification.nativeWindows !== true) {
      items.push('Portable gates passed, but final RELEASE requires native Windows, live PowerShell, and a native better-sqlite3 load in the bound P0 report.');
    }
    if (report.releaseQualification.nativeProofIntegration !== true) {
      items.push('Final RELEASE requires the pinned Windows supervisor and every named native proof integration test to pass.');
    }
    if (report.releaseQualification.cleanGitTree !== true) {
      items.push('Portable gates passed, but final RELEASE requires a real, clean Git commit/tree identity for the exact source bytes.');
    }
  }
  items.push('Operator supervisor qualification and the live P2 ceremony are separate evidence; this command performs no live provider verification.');
  if (report.smoke?.p0?.evaluation?.subject?.releaseVerdict === 'CANDIDATE') {
    items.push('P0 probes were bound to the immutable pre-execution candidate report for this exact archive; the final verdict remains independently gated by native-platform and Git identity requirements.');
  }
  return items;
}

function renderManifest(report) {
  const lines = [];
  const put = (label, value) => lines.push(`${label.padEnd(24)}${value}`);
  lines.push('CLU-E EXACT RELEASE MANIFEST');
  lines.push('GENERATED. Do not edit by hand.');
  lines.push(`Emitter: ${report.tool} · report ${report.reportVersion}`);
  lines.push('');
  put('VERDICT', report.verdict);
  put('archive', report.archive.file);
  put('archive sha256', report.archive.sha256);
  put('archive bytes', String(report.archive.bytes));
  put('archive files', String(report.archive.fileCount));
  put('deterministic', report.archive.deterministic ? 'yes — second build byte-identical' : 'NO');
  lines.push('');
  lines.push('TREE IDENTITY');
  if (report.tree.available) {
    put('commit', report.tree.commit);
    put('tree', report.tree.tree ?? 'unknown');
    put('branch', report.tree.branch ?? 'unknown');
    put('worktree', report.tree.dirty === false ? 'clean' : report.tree.dirty === true ? 'dirty' : 'unverified');
    put('archive Git binding', report.tree.archiveBound ? 'PASS' : 'NOT PROVED');
  } else {
    put('commit', 'unavailable');
    put('identity', `${report.archive.fileCount}-file SHA-256 manifest`);
  }
  lines.push('');
  lines.push('RELEASE QUALIFICATION');
  put('portable gates', report.releaseQualification.portablePass ? 'PASS' : 'FAIL');
  put('native Windows', report.releaseQualification.nativeWindows ? 'PASS' : 'NOT PROVED');
  put('native proof tests', report.releaseQualification.nativeProofIntegration ? 'PASS' : 'NOT PROVED');
  put('clean Git tree', report.releaseQualification.cleanGitTree ? 'PASS' : 'NOT PROVED');
  lines.push('');
  lines.push('AUTHORITY');
  put('v9 documentation seal', report.authority.documentationSeals.v9.pass ? 'PASS' : 'FAIL');
  put('v10 documentation seal', report.authority.documentationSeals.v10.pass ? 'PASS' : 'FAIL');
  put('active documentation', report.authority.documentationPack.releaseVersion);
  put('active target', report.authority.target.activeTarget);
  put('target profile', report.authority.target.profilePath);
  put('description', report.authority.target.inputs.description.archivePath ?? report.authority.target.inputs.description.state);
  put('benchmark', report.authority.target.inputs.benchmark.archivePath ?? report.authority.target.inputs.benchmark.state);
  lines.push('');
  lines.push('GATES');
  if (report.sourceGates.length === 0 && report.smoke === null) {
    lines.push('  none');
  } else {
    for (const gate of report.sourceGates) {
      put(gate.label, `${gate.pass ? 'PASS' : 'FAIL'} · exit ${gate.exitCode ?? 'n/a'}`);
    }
    if (report.smoke !== null) {
      put('structural extraction', report.smoke.structural.pass ? 'PASS' : 'FAIL');
      put('npm ci', report.smoke.install?.pass ? 'PASS' : 'FAIL');
      put('extracted typecheck', report.smoke.typecheck?.pass ? 'PASS' : 'FAIL');
      put('extracted build', report.smoke.build?.pass ? 'PASS' : 'FAIL');
      put('production config load', report.smoke.configLoad?.pass ? 'PASS' : 'FAIL');
      put(
        'selftest',
        report.smoke.selftest === null
          ? 'NOT RUN'
          : `${report.smoke.selftest.pass ? 'PASS' : 'FAIL'} · ${report.smoke.selftest.passCount}/${report.smoke.selftest.tests} pass · ${report.smoke.selftest.skipped} skipped`,
      );
      put('Project Profiles', report.smoke.projectProfiles?.pass ? 'PASS' : report.smoke.projectProfiles === null ? 'NOT RUN' : 'FAIL');
      put('P0 adversarial items', report.smoke.p0?.evaluation?.pass ? 'PASS' : 'FAIL');
    }
  }
  lines.push('');
  lines.push('EVIDENCE');
  const base = report.archive.file.replace(/\.zip$/u, '');
  put('file manifest', `${base}.SHA256SUMS`);
  put('archive hash', `${base}.zip.sha256`);
  put('machine report', `${base}.report.json`);
  put('smoke report', `${base}.smoke.json`);
  put('gate log', `${base}.gates.log`);
  put('P0 report', `${base}.p0-acceptance-report.json`);
  if (report.smoke?.projectProfiles?.evidence) put('Project Profiles report', report.smoke.projectProfiles.evidence.file);
  lines.push('');
  lines.push('LIMITATIONS');
  for (const item of report.limitations) lines.push(`  - ${item}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderGateLog(sourceGates, smoke, logDirectory) {
  const sections = [];
  const appendGate = (gate) => {
    if (gate === null || gate === undefined) return;
    sections.push(
      `=== ${gate.label} · ${gate.command ?? 'internal'} · exit ${gate.exitCode ?? 'n/a'} · ${gate.pass ? 'PASS' : 'FAIL'} ===\n` +
        `${gate.stdout ?? ''}${gate.stderr ? `\n[stderr]\n${gate.stderr}` : ''}`,
    );
  };
  for (const gate of sourceGates) appendGate(gate);
  if (smoke !== null) {
    appendGate(smoke.install);
    appendGate(smoke.typecheck);
    appendGate(smoke.build);
    appendGate(smoke.configLoad);
    appendGate(smoke.projectProfiles);
    if (smoke.selftest?.files) {
      for (const file of smoke.selftest.files) {
        let stdout = '';
        let stderr = '';
        try { stdout = readFileSync(file.stdoutPath, 'utf8'); } catch { /* absent */ }
        try { stderr = readFileSync(file.stderrPath, 'utf8'); } catch { /* absent */ }
        sections.push(
          `=== selftest ${file.file} · exit ${file.exitCode ?? 'n/a'} · ${file.fail === 0 ? 'PASS' : 'FAIL'} ===\n` +
            `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`,
        );
      }
    }
    if (smoke.p0?.process) {
      const stdoutPath = join(logDirectory, 'extracted-p0-adversarial.stdout.log');
      const stderrPath = join(logDirectory, 'extracted-p0-adversarial.stderr.log');
      let stdout = '';
      let stderr = '';
      try { stdout = readFileSync(stdoutPath, 'utf8'); } catch { /* absent */ }
      try { stderr = readFileSync(stderrPath, 'utf8'); } catch { /* absent */ }
      sections.push(
        `=== extracted P0 adversarial · exit ${smoke.p0.process.exitCode ?? 'n/a'} · ${smoke.p0.evaluation?.pass ? 'PASS' : 'FAIL'} ===\n` +
          `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`,
      );
    }
  }
  return `${sections.join('\n\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDirectory = isAbsolute(options.out) ? resolve(options.out) : resolve(ROOT, options.out);
  mkdirSync(outputDirectory, { recursive: true });
  const prior = previousReport(outputDirectory);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/gu, '-');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail('package.json has no files allowlist');
  }

  process.stdout.write(
    `CLU-E exact release v2\n  root: ${ROOT}\n  out:  ${outputDirectory}\n  mode: ${options.gates ? 'GATED' : 'UNGATED'}\n\n`,
  );

  const authority = readAuthority(ROOT);
  const initialGit = gitFacts();
  process.stdout.write(
    `  [ok] documentation seals v9 (${authority.documentationSeals.v9.entries.length} files), ` +
      `v10 (${authority.documentationSeals.v10.entries.length} files), v9 active\n` +
      `  [ok] active target ${authority.activeTarget} · ${authority.profilePath}\n`,
  );

  const workRoot = mkdtempSync(join(tmpdir(), 'clue-release-v2-'));
  const logDirectory = join(workRoot, 'logs');
  const extractedRoot = join(workRoot, 'extracted');
  mkdirSync(logDirectory, { recursive: true });

  let sourceGates = [];
  let archivePath = null;
  let base = null;
  let smoke = null;
  try {
    if (options.gates) {
      sourceGates = await runSourceGates(logDirectory);
      for (const gate of sourceGates) {
        process.stdout.write(`  [${gate.pass ? 'ok' : 'FAIL'}] ${gate.label}\n`);
      }
      if (!sourceGatePass(sourceGates)) {
        const failureLog = renderGateLog(sourceGates, null, logDirectory);
        writeFileSync(join(outputDirectory, `clue-release-${stamp}.blocked.gates.log`), failureLog);
        fail('source clean/typecheck/build gate failed; no archive was emitted', 1);
      }
    }

    const paths = collectFiles(pkg.files, authority, outputDirectory);
    const entries = paths.map((path) => {
      const bytes = readReleaseFile(ROOT, path);
      return { path, bytes, sha256: sha256(bytes) };
    });
    const gitBinding = bindArchiveToGit(entries, initialGit);

    const archive = writeZip(entries);
    const archiveSha = sha256(archive);
    const repeatSha = sha256(writeZip(entries));
    const deterministic = archiveSha === repeatSha;
    if (!deterministic) fail('deterministic archive self-check failed');

    base = `${pkg.name}-${pkg.version}-${stamp}`;
    archivePath = join(outputDirectory, `${base}.zip`);
    writeFileSync(archivePath, archive, { flag: 'wx' });
    writeFileSync(
      join(outputDirectory, `${base}.SHA256SUMS`),
      `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
    );
    writeFileSync(join(outputDirectory, `${base}.zip.sha256`), `${archiveSha}  ${base}.zip\n`);

    const candidateReport = {
      tool: TOOL,
      reportVersion: REPORT_VERSION,
      startedAt,
      verdict: 'CANDIDATE',
      archive: {
        file: `${base}.zip`,
        sha256: archiveSha,
        bytes: archive.length,
        fileCount: entries.length,
        deterministic,
      },
      files: entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes.length })),
      tree: gitBinding,
      toolchain: toolchain(),
    };
    const candidateReportPath = join(outputDirectory, `${base}.candidate.report.json`);
    const candidateReportBytes = Buffer.from(`${JSON.stringify(candidateReport, null, 2)}\n`);
    writeFileSync(candidateReportPath, candidateReportBytes, { flag: 'wx' });

    extractZip(archive, extractedRoot);
    const structural = structuralSmoke(extractedRoot, entries, authority);
    process.stdout.write(
      `  [${structural.pass ? 'ok' : 'FAIL'}] extracted ZIP exactness, documentation, and active-target resolution\n`,
    );

    if (options.gates) {
      smoke = await runExtractedSmoke({
        extractedRoot,
        expectedEntries: entries,
        authority,
        candidateReportPath,
        archiveSha,
        logDirectory,
        outputDirectory,
        base,
      });
      const selftest = smoke.selftest;
      process.stdout.write(
        `  [${smoke.install?.pass ? 'ok' : 'FAIL'}] extracted npm ci\n` +
          `  [${smoke.typecheck?.pass ? 'ok' : 'FAIL'}] extracted typecheck\n` +
          `  [${smoke.build?.pass ? 'ok' : 'FAIL'}] extracted build\n` +
          `  [${smoke.configLoad?.pass ? 'ok' : 'FAIL'}] production config/profile load\n` +
          `  [${selftest?.pass ? 'ok' : 'FAIL'}] isolated selftest` +
            `${selftest ? ` · ${selftest.passCount}/${selftest.tests} pass · ${selftest.skipped} skipped` : ''}\n` +
          `  [${smoke.projectProfiles?.pass ? 'ok' : 'FAIL'}] extracted Project Profiles acceptance\n` +
          `  [${smoke.nativeProof?.pass ? 'ok' : 'pending'}] native proof integration\n` +
          `  [${smoke.p0?.evaluation?.pass ? 'ok' : 'FAIL'}] P0 adversarial items + archive binding\n`,
      );
    } else {
      smoke = {
        schema: 'clue.release.smoke/2',
        extractedRoot,
        structural,
        install: null,
        typecheck: null,
        build: null,
        configLoad: null,
        archivedFilesAfterBuild: null,
        archivedFilesAfterGates: null,
        selftest: null,
        projectProfiles: null,
        nativeProof: null,
        p0: null,
        pass: false,
      };
    }

    const archiveBinding = {
      zipMatches: sha256(readFileSync(archivePath)) === archiveSha,
      candidateReportMatches: readFileSync(candidateReportPath).equals(candidateReportBytes),
      extractedFiles: verifyArchivedFilesUnchanged(extractedRoot, entries),
    };
    const bindingPass = archiveBinding.zipMatches && archiveBinding.candidateReportMatches && archiveBinding.extractedFiles.pass;
    const gatedPass = options.gates && sourceGatePass(sourceGates) && smoke.pass && bindingPass;
    const structuralPass = smoke.structural?.pass === true && bindingPass;
    const nativeWindows = smoke.p0?.evaluation?.nativeWindows === true;
    const nativeProofIntegration = smoke.nativeProof?.pass === true;
    const tree = confirmArchiveGitBinding(gitBinding);
    const cleanGitTree = tree.archiveBound === true;
    const releaseQualification = {
      portablePass: gatedPass,
      nativeWindows,
      nativeProofIntegration,
      cleanGitTree,
      formalPass: gatedPass && nativeWindows && nativeProofIntegration && cleanGitTree,
    };
    const verdict = options.gates
      ? releaseQualification.formalPass
        ? 'RELEASE'
        : gatedPass
          ? 'RELEASE_CANDIDATE'
          : 'BLOCKED'
      : structuralPass
        ? 'UNGATED'
        : 'BLOCKED';
    const report = {
      tool: TOOL,
      reportVersion: REPORT_VERSION,
      startedAt,
      finishedAt: new Date().toISOString(),
      verdict,
      releaseQualification,
      archive: candidateReport.archive,
      archiveBinding,
      tree,
      toolchain: candidateReport.toolchain,
      packageAllowlist: pkg.files,
      alwaysIncluded: ALWAYS_INCLUDED,
      alwaysExcludedTopLevel: [...ALWAYS_EXCLUDED_TOP_LEVEL].sort(compareUtf8),
      authority: {
        documentationSeal: authority.seal,
        documentationPack: authority.documentationPack,
        documentationSeals: authority.documentationSeals,
        trackedDocuments: authority.trackedDocuments,
        constitutionFile: authority.constitutionFile,
        documentationDrift: documentDrift(authority, prior),
        target: {
          activeTarget: authority.activeTarget,
          profilePath: authority.profilePath,
          profile: authority.profile,
          targetFiles: authority.targetFiles,
          inputs: authority.inputs,
        },
      },
      sourceGates: sourceGates.map(gateSummary),
      smoke: smokeSummary(smoke),
      files: candidateReport.files,
    };
    report.limitations = limitations(report);
    if (options.writeRoot) report.limitations.push('The optional root manifest refresh occurs after the captured release snapshot.');

    writeFileSync(join(outputDirectory, `${base}.smoke.json`), `${JSON.stringify(report.smoke, null, 2)}\n`);
    writeFileSync(join(outputDirectory, `${base}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
    const manifest = renderManifest(report);
    writeFileSync(join(outputDirectory, `${base}.MANIFEST.txt`), manifest);
    writeFileSync(
      join(outputDirectory, `${base}.gates.log`),
      renderGateLog(sourceGates, smoke, logDirectory),
    );
    if (options.writeRoot) writeFileSync(join(ROOT, 'MANIFEST.txt'), manifest);

    process.stdout.write(
      `\n  archive: ${archivePath}\n` +
        `  sha256:  ${archiveSha}\n` +
        `  files:   ${entries.length}\n` +
        `  bytes:   ${archive.length}\n` +
        `  verdict: ${report.verdict}\n\n`,
    );

    if (report.verdict === 'RELEASE') return 0;
    if (report.verdict === 'UNGATED') {
      process.stdout.write('  UNGATED: structural archive checks passed; formal gates were not run.\n\n');
      return 0;
    }
    if (report.verdict === 'RELEASE_CANDIDATE') {
      process.stdout.write(
        '  RELEASE_CANDIDATE: portable exact-archive gates passed; native Windows and/or clean Git identity remains unproved.\n\n',
      );
      return 1;
    }
    process.stdout.write('  BLOCKED: inspect the report, smoke JSON, and gates log.\n\n');
    return 1;
  } finally {
    if (options.keepSmoke) {
      process.stdout.write(`  retained smoke workspace: ${workRoot}\n`);
    } else {
      rmSync(workRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 2;
  process.stderr.write(
    `release: fatal: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}\n`,
  );
}
