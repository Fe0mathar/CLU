/**
 * Install the v9 documentation pack as the repository's authority set.
 *
 * Backlog: DEV-P2-01 (installation half) and DEV-P2-02 (filename half) — Gate 7 of
 *          `baklog-report_6.md` §12/§17.2, the `DEP-P0-01` spine.
 * Spec:    `DOCUMENTATION_GOVERNANCE_v9.md` §14 (v8→v9 re-baseline: uniform `_v9` filenames,
 *          content preserved verbatim) and §15 (manifest hashes must pass).
 *          `SHA256SUMS_v9.txt` is the seal this tool enforces; the tool carries no
 *          hashes of its own and invents nothing.
 *
 * ## What this tool is, and is not
 *
 * It makes the repository root byte-agree with `SHA256SUMS_v9.txt`: every declared file
 * present at its declared path with its declared hash. It finds content by hash, not by
 * name — the eleven governed documents already sit in this repository under their v8-era
 * filenames with byte-identical content (verified 2026-08-10, including
 * `CLUE_Execution_Model_v8.md` = declared `CLUE_Execution_Model_v9.md`, sha
 * `7738088aec…`, which resolves the ABSENT record's path 1: the original was never lost
 * here). Those are renamed in place. Files the repository lacks (governance, manifest,
 * README, validation report, templates) are copied from `--source` only when their bytes
 * hash to the declared value.
 *
 * **This tool does not ratify.** The manifest marks `CLUE_Constitution_v9.md` as
 * `reconstructed-pending-ratification`; ratification is the Creator's act and is recorded
 * separately (DEV-P2-05's durable receipt). It also does not touch
 * `config/clue.config.yaml` — re-registering `constitution.tracked_documents` under the
 * v9 names is DEV-P2-02's second half, delivered as its own change. Until that lands,
 * `clue doctor` will honestly report the tracked documents missing; that is the correct
 * report for a half-installed authority, not a defect.
 *
 * ## Refusal rules
 *
 * - A declared path that exists with the wrong hash is a CONFLICT: the whole install is
 *   refused and nothing is written. Divergent content is a Creator decision, never an
 *   overwrite.
 * - Declared content findable nowhere (repo root or source) is MISSING: refused, with the
 *   hash printed so the Creator can locate the file.
 * - Default mode is a dry-run plan. `--apply` executes; after applying, every declared
 *   path is re-hashed from disk and any disagreement fails the run.
 *
 * Usage:
 *   node tools/install-v9-pack.mjs [--source <dir>] [--apply] [--receipt <path>]
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

const SUMS_NAME = 'SHA256SUMS_v9.txt';
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'workspace', 'release', 'shadow']);

const repoRoot = resolve(process.cwd());

/* ---------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
let sourceDir = null;
let apply = false;
let receiptPath = null;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--apply') apply = true;
  else if (arg === '--source') sourceDir = resolve(String(argv[++i] ?? ''));
  else if (arg === '--receipt') receiptPath = resolve(String(argv[++i] ?? ''));
  else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    process.exit(2);
  }
}

/* ------------------------------------------------------------------ helpers */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Declared paths use `/`; join them portably against a root. */
const declaredJoin = (root, declared) => join(root, ...declared.split('/'));

/** Parse `HASH  PATH` lines; tolerate CRLF and blank lines; refuse malformed lines. */
function parseSums(bytes, origin) {
  const entries = [];
  const seen = new Set();
  for (const raw of bytes.toString('utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
    if (!match) {
      process.stderr.write(`malformed line in ${origin}: ${JSON.stringify(line)}\n`);
      process.exit(1);
    }
    const [, hash, path] = match;
    if (seen.has(path)) {
      process.stderr.write(`duplicate declared path in ${origin}: ${path}\n`);
      process.exit(1);
    }
    seen.add(path);
    entries.push({ hash, path });
  }
  if (entries.length === 0) {
    process.stderr.write(`${origin} declares no files\n`);
    process.exit(1);
  }
  return entries;
}

/** Index candidate files by content hash. Small files only; never descends into runtime dirs. */
function indexByHash(root, maxDepth) {
  const byHash = new Map();
  const walk = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let size;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_CANDIDATE_BYTES) continue;
      const hash = sha256(readFileSync(full));
      if (!byHash.has(hash)) byHash.set(hash, full);
    }
  };
  walk(root, 0);
  return byHash;
}

/* -------------------------------------------------------- locate the seal */

const repoSumsPath = join(repoRoot, SUMS_NAME);
const sourceSumsPath = sourceDir === null ? null : join(sourceDir, SUMS_NAME);

let sumsBytes = null;
let sumsOrigin = null;
if (existsSync(repoSumsPath)) {
  sumsBytes = readFileSync(repoSumsPath);
  sumsOrigin = repoSumsPath;
  if (sourceSumsPath !== null && existsSync(sourceSumsPath)) {
    const sourceBytes = readFileSync(sourceSumsPath);
    if (sha256(sourceBytes) !== sha256(sumsBytes)) {
      process.stderr.write(
        `CONFLICT: ${SUMS_NAME} differs between repository and source. ` +
          'Two seals cannot both govern; resolve which is authoritative before installing.\n',
      );
      process.exit(1);
    }
  }
} else if (sourceSumsPath !== null && existsSync(sourceSumsPath)) {
  sumsBytes = readFileSync(sourceSumsPath);
  sumsOrigin = sourceSumsPath;
} else {
  process.stderr.write(
    `${SUMS_NAME} found neither at the repository root nor in --source; nothing to install against.\n`,
  );
  process.exit(1);
}

const declared = parseSums(sumsBytes, sumsOrigin);

/* --------------------------------------------------------------- build plan */

// Depth 0 at the repo root: the governed documents live there; runtime trees are excluded.
const repoIndex = indexByHash(repoRoot, 0);
const sourceIndex = sourceDir === null ? new Map() : indexByHash(sourceDir, 3);

const plan = [];
let conflicts = 0;
let missing = 0;

for (const { hash, path } of declared) {
  const dest = declaredJoin(repoRoot, path);
  if (existsSync(dest)) {
    const actual = sha256(readFileSync(dest));
    if (actual === hash) {
      plan.push({ path, hash, action: 'present' });
    } else {
      plan.push({ path, hash, action: 'conflict', actual });
      conflicts += 1;
    }
    continue;
  }
  const inRepo = repoIndex.get(hash);
  if (inRepo !== undefined && inRepo !== dest) {
    plan.push({ path, hash, action: 'rename', from: basename(inRepo) });
    continue;
  }
  const inSource = sourceIndex.get(hash);
  if (inSource !== undefined) {
    plan.push({ path, hash, action: 'copy', from: inSource });
    continue;
  }
  plan.push({ path, hash, action: 'missing' });
  missing += 1;
}

// The seal itself is installed alongside what it declares.
if (!existsSync(repoSumsPath)) {
  plan.push({ path: SUMS_NAME, hash: sha256(sumsBytes), action: 'copy', from: sumsOrigin });
}

/* -------------------------------------------------------------- report plan */

const counts = { present: 0, rename: 0, copy: 0, conflict: 0, missing: 0 };
for (const step of plan) counts[step.action] += 1;

process.stdout.write(`v9 pack install — seal ${sumsOrigin} (${declared.length} declared files)\n`);
for (const step of plan) {
  const detail =
    step.action === 'rename'
      ? ` <- ${step.from}`
      : step.action === 'copy'
        ? ` <- ${step.from}`
        : step.action === 'conflict'
          ? ` (on disk ${step.actual.slice(0, 12)}…, declared ${step.hash.slice(0, 12)}…)`
          : step.action === 'missing'
            ? ` (declared ${step.hash})`
            : '';
  process.stdout.write(`  ${step.action.padEnd(8)} ${step.path}${detail}\n`);
}
process.stdout.write(
  `  plan: ${counts.present} present, ${counts.rename} rename, ${counts.copy} copy, ` +
    `${counts.conflict} conflict, ${counts.missing} missing\n`,
);

if (conflicts > 0 || missing > 0) {
  process.stderr.write(
    'REFUSED: conflicts or missing content. Nothing was written. Divergent files are a ' +
      'Creator decision; missing content must be located by its declared hash.\n',
  );
  process.exit(1);
}

if (!apply) {
  process.stdout.write('dry-run only; re-run with --apply to execute this plan.\n');
  process.exit(0);
}

/* -------------------------------------------------------------------- apply */

for (const step of plan) {
  const dest = declaredJoin(repoRoot, step.path);
  if (step.action === 'present') continue;
  mkdirSync(dirname(dest), { recursive: true });
  if (step.action === 'rename') {
    renameSync(join(repoRoot, step.from), dest);
  } else if (step.action === 'copy') {
    writeFileSync(dest, readFileSync(step.from));
  }
}

/* -------------------------------------------------- post-apply verification */

let verifyFailures = 0;
for (const { hash, path } of declared) {
  const dest = declaredJoin(repoRoot, path);
  const ok = existsSync(dest) && sha256(readFileSync(dest)) === hash;
  if (!ok) {
    verifyFailures += 1;
    process.stderr.write(`VERIFY FAIL: ${path}\n`);
  }
}
if (!existsSync(repoSumsPath)) {
  verifyFailures += 1;
  process.stderr.write(`VERIFY FAIL: ${SUMS_NAME}\n`);
}

/* ------------------------------------------------------------------ receipt */

const receipt = {
  tool: 'install-v9-pack',
  when: new Date().toISOString(),
  repoRoot,
  sealPath: sumsOrigin,
  sealSha256: sha256(sumsBytes),
  declaredFiles: declared.length,
  actions: plan.map(({ path, hash, action, from }) =>
    from === undefined ? { path, hash, action } : { path, hash, action, from },
  ),
  verified: verifyFailures === 0,
  notes: [
    'Installation only. Ratification of the pack — including the reconstructed Constitution — is a Creator act recorded separately (DEV-P2-05 receipt).',
    'config/clue.config.yaml still registers the v8-era filenames; re-registration under v9 names is DEV-P2-02 second half. `clue doctor` reports the gap honestly until it lands.',
    'CLUE_Execution_Model_v9.md was recovered by content hash from the repository copy formerly named CLUE_Execution_Model_v8.md — resolution path 1 of the ABSENT record.',
  ],
};

const receiptDest =
  receiptPath ??
  join(
    repoRoot,
    'workspace',
    'installation',
    `v9-pack-install-${receipt.when.replace(/[:.]/g, '-')}.json`,
  );
mkdirSync(dirname(receiptDest), { recursive: true });
writeFileSync(receiptDest, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`receipt: ${receiptDest}\n`);

if (verifyFailures > 0) {
  process.stderr.write(`applied with ${verifyFailures} verification failure(s)\n`);
  process.exit(1);
}
process.stdout.write('installed: repository root byte-agrees with the v9 seal.\n');
process.exit(0);
