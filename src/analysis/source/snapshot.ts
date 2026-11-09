/**
 * CLUE source snapshots.
 *
 * Spec: CLUE_Architecture_v8.md (source inventory; snapshot identity),
 *       CLUE_Execution_Model_v8.md (incremental rescan economy).
 * Backlog: DEV-P0-02 — split immutable source-content identity from the capture receipt.
 *          DEV-P1-28 (phase 2) — the snapshot stage of the evidence spine: `spineLink`/`spineSeal`
 *          bind a capture's content id, manifest hash, and receipt id to the mission root, and
 *          `verifySnapshotLink` checks a presented link against the mission predecessor and this
 *          registry's own record.
 *
 * A snapshot is the answer to "which exact bytes was this conclusion drawn from". Every
 * finding, metric, patch, and verdict names one, and a snapshot identity that could
 * drift would make all of them unfalsifiable at once.
 *
 * Identity is therefore **content-only**. Not modification times, not sizes, not walk
 * order, not the absolute path the tree happened to live at, and — crucially — not the
 * wall-clock moment of capture. Two consequences follow, and both are load-bearing:
 *
 *   1. A fresh clone of the same commit produces the same snapshot ID as the original.
 *      That is what makes a measurement taken in the shadow clone comparable to an
 *      analysis performed against the canonical tree — without it, every experiment
 *      would be comparing two trees it could not prove were the same.
 *   2. Cache invalidation is exact. A changed file changes exactly its own entry, so
 *      the recognizer can invalidate the surface that actually moved instead of
 *      rescanning everything on a timestamp it cannot trust.
 *
 * Content identity and capture receipt are kept in separate records (DEV-P0-02). The
 * *content manifest* stored in the artifact store contains only content-derived data, so
 * re-capturing an unchanged tree deduplicates to a single immutable blob. The volatile
 * facts of a particular capture — when it happened, from which tree, under which Git
 * state and scan policy — live in an append-only *capture receipt* keyed by its own id.
 * The `snapshots` projection row is therefore pure content identity and is never mutated;
 * per-capture fields are read from the latest receipt, never mixed into the identity row.
 *
 * This module reads and never writes outside the workspace. It does not shell out —
 * Git facts arrive as parameters from the command layer, which owns process execution
 * under the restricted host. Keeping process control out of the analysis plane is what
 * lets snapshots be captured in a self-test with no target checkout present.
 */

import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, readdirSync, statSync, readlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import {
  HASH_ALGORITHM,
  canonicalJson,
  hashCanonicalJson,
  makeSnapshotId,
  normalisePath,
  nowIso,
  requireSha256,
  type Sha256,
  type SnapshotId,
} from '../../shared/ids.js';
import {
  EvidenceChainError,
  requireSpineHash,
  requireSpineId,
  sealLink as sealEvidenceLink,
  verifyLink as verifyEvidenceLink,
  type BindingHash,
  type MissionLink,
  type SnapshotLink,
} from '../../shared/evidenceIdentity.js';
import { absolutePathForm, parseOrThrow } from '../../shared/schemas.js';
import {
  projectRecognitionIdentitySchema,
  type ProjectRecognitionIdentity,
} from '../../shared/projectRecognitionIdentity.js';
import type { ArtifactStore } from '../../memory/artifactStore.js';
import type { EventLog } from '../../memory/eventLog.js';
import type { ProjectionStore, Projector } from '../../memory/db.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* Languages                                                                  */
/* ------------------------------------------------------------------------- */

export type SourceLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'wgsl'
  | 'glsl'
  | 'json'
  | 'yaml'
  | 'markdown'
  | 'html'
  | 'css'
  | 'binary'
  | 'other';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SourceLanguage>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  wgsl: 'wgsl',
  glsl: 'glsl',
  vert: 'glsl',
  frag: 'glsl',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  glb: 'binary',
  gltf: 'binary',
  ply: 'binary',
  png: 'binary',
  jpg: 'binary',
  jpeg: 'binary',
  webp: 'binary',
  ktx2: 'binary',
  bin: 'binary',
  wasm: 'binary',
};

export function classifyLanguage(path: string): SourceLanguage {
  const index = path.lastIndexOf('.');
  if (index < 0) return 'other';
  return LANGUAGE_BY_EXTENSION[path.slice(index + 1).toLowerCase()] ?? 'other';
}

/* ------------------------------------------------------------------------- */
/* Manifest (content identity)                                                */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const sourceFileSchema = z
  .object({
    /** Forward-slashed, relative to the project root. Case preserved. */
    path: z.string().min(1),
    hash: sha256,
    bytes: z.number().int().nonnegative(),
    language: z.string().min(1),
    /**
     * The POSIX executable bit, part of content identity: a file gaining or losing `+x` is a
     * meaningful change (source control tracks exactly this). Cross-platform rule: on Windows, which
     * has no executable bit, it is normalised to `false`, so the identity rule is explicit and
     * platform-defined rather than accidentally dependent on how a filesystem reports mode.
     *
     * Defaulted to false so a manifest written before the bit was tracked still reads back — a
     * missing bit IS false, exactly the normalisation above. Every live capture sets it explicitly, so
     * the default only ever applies to a stored manifest from an earlier schema; it is never a way for
     * a fresh capture to omit the field.
     */
    executable: z.boolean().default(false),
  })
  .strict();

export type SourceFile = z.infer<typeof sourceFileSchema>;

/** Something encountered that was neither ingested nor silently ignored by policy. */
export const skippedEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: z.enum(['symlink', 'unreadable', 'special']),
    detail: z.string().min(1),
  })
  .strict();

export type SkippedEntry = z.infer<typeof skippedEntrySchema>;

/**
 * The content manifest — a deterministic function of the scanned bytes and scan policy.
 * It carries NO volatile capture fields (no `captured_at`, no Git state, no origin), so
 * an unchanged tree always serialises to the same canonical JSON and therefore the same
 * artifact blob. That property is exactly what DEV-P0-02 requires: one content identity
 * maps to one immutable manifest. Volatile capture facts live in the capture receipt.
 */
export const snapshotManifestSchema = z
  .object({
    id: sha256,
    source_roots: z.array(z.string().min(1)).min(1),
    files: z.array(sourceFileSchema),
    skipped: z.array(skippedEntrySchema),
    stats: z
      .object({
        file_count: z.number().int().nonnegative(),
        total_bytes: z.number().int().nonnegative(),
        by_language: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
  })
  .strict();

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

/** Git facts, supplied by the command layer. Never discovered by this module. */
export const gitContextSchema = z
  .object({
    commit: z.string().min(1).nullable(),
    branch: z.string().min(1).nullable(),
    /** True when the working tree had uncommitted changes at capture time. */
    dirty: z.boolean(),
  })
  .strict();

export type GitContext = z.infer<typeof gitContextSchema>;

/** The scan policy under which a capture was taken, recorded so a capture is reproducible. */
export const captureExcludesSchema = z
  .object({
    dirs: z.array(z.string()),
    extensions: z.array(z.string()),
  })
  .strict();

export type CaptureExcludes = z.infer<typeof captureExcludesSchema>;

/**
 * The resolved snapshot record returned by the registry: immutable content identity
 * joined with the *latest* capture receipt for that identity. Its shape is stable for
 * callers; what changed under DEV-P0-02 is where each field comes from — content columns
 * from the immutable `snapshots` row, capture columns from an explicit receipt.
 */
export const snapshotRecordSchema = z
  .object({
    id: sha256,
    captured_at: isoTime,
    manifest_hash: sha256,
    file_count: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
    skipped_count: z.number().int().nonnegative(),
    git_commit: z.string().nullable(),
    git_branch: z.string().nullable(),
    git_dirty: z.boolean(),
    /** Which tree it was taken from: the canonical repository or the shadow clone. */
    origin: z.enum(['canonical', 'shadow']),
  })
  .strict();

export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;

/**
 * The durable payload of a `snapshot.captured` event: content identity plus the full
 * capture receipt. The receipt fields (`capture_id`, `capture_basis_hash`, `source_roots`,
 * `excludes`) are optional so that events written before DEV-P0-02 still project — the
 * projector derives a receipt identity for them from their content and Git fields.
 */
export const captureRecordSchema = z.object({
  id: sha256,
  manifest_hash: sha256,
  file_count: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  skipped_count: z.number().int().nonnegative(),
  captured_at: isoTime,
  git_commit: z.string().nullable(),
  git_branch: z.string().nullable(),
  git_dirty: z.boolean(),
  origin: z.enum(['canonical', 'shadow']),
  capture_id: sha256.optional(),
  capture_basis_hash: sha256.optional(),
  source_roots: z.array(z.string()).optional(),
  excludes: captureExcludesSchema.optional(),
  /** Exact Project Profile recognition generation; absent on legacy captures. */
  project_recognition: projectRecognitionIdentitySchema.optional(),
});

export type CaptureRecord = z.infer<typeof captureRecordSchema>;

/* ------------------------------------------------------------------------- */
/* Capture                                                                    */
/* ------------------------------------------------------------------------- */

export interface CaptureOptions {
  /** Absolute path of the tree root. */
  readonly root: string;
  /** Directories under the root to inventory, e.g. ['src']. */
  readonly sourceRoots: readonly string[];
  /** Path segments never descended into, e.g. ['node_modules', 'dist']. */
  readonly exclude?: readonly string[];
  /**
   * Authoritative source of each file's executable bit, keyed by its normalised relative path
   * (DEV-P0-02). When it returns a boolean, that value is used; when it returns null the file's mode
   * is taken from the local filesystem. Supply a provider backed by Git's recorded mode (100755 vs
   * 100644) so that the same repository yields the same content identity on Windows and POSIX, where
   * local filesystem mode disagrees. Absent, identity falls back to platform mode as before.
   */
  readonly executableOf?: (relativePath: string) => boolean | null;
  /**
   * Extensions excluded by policy. Use for large binary assets whose bytes are not
   * the subject of analysis. This is a recorded policy decision, not an approximation:
   * excluded files are absent from identity, so two trees differing only in excluded
   * assets are deliberately treated as the same snapshot.
   */
  readonly excludeExtensions?: readonly string[];
}

/** Always pruned, whatever the configuration says. */
export const ALWAYS_EXCLUDED = ['.git', 'node_modules', 'dist', '.clue', '.vscode', '.idea'] as const;

/**
 * Version of the content-identity rule. It is folded into the id so that if the identity function
 * ever changes, old and new ids cannot silently collide — a captured id names both the content and
 * the rule that produced it. Bumped to 2 by DEV-P0-02, which folds the governed capture basis
 * (roots, excludes, modes, skipped records) into the id instead of hashing file paths+hashes alone.
 */
const SNAPSHOT_CONTENT_ID_VERSION = 2;

const CHUNK_BYTES = 256 * 1024;

/** Sorted, de-duplicated view of the effective scan policy for a capture. */
function resolveExcludes(options: CaptureOptions): CaptureExcludes {
  const dirs = [...new Set<string>([...ALWAYS_EXCLUDED, ...(options.exclude ?? [])])].sort(compareStr);
  const extensions = [
    ...new Set((options.excludeExtensions ?? []).map((ext) => ext.replace(/^\./, '').toLowerCase())),
  ].sort(compareStr);
  return { dirs, extensions };
}

/**
 * Walks the configured roots and produces a content manifest.
 *
 * Symlinks are recorded and **not followed**. A link pointing outside the tree would
 * pull foreign content into the identity, so the snapshot would change for reasons
 * invisible in the repository — the exact class of irreproducibility this module exists
 * to prevent. Recording rather than ignoring them keeps the decision visible.
 *
 * The returned manifest is content-only; the moment of capture is stamped by the caller
 * into a separate receipt, never into the manifest whose hash is the content identity.
 */
export function captureSnapshot(options: CaptureOptions): SnapshotManifest {
  const excluded = new Set<string>([...ALWAYS_EXCLUDED, ...(options.exclude ?? [])]);
  const excludedExtensions = new Set(
    (options.excludeExtensions ?? []).map((extension) => extension.replace(/^\./, '').toLowerCase()),
  );

  const files: SourceFile[] = [];
  const skipped: SkippedEntry[] = [];

  // DEV-P0-02: canonicalize and de-duplicate the roots exactly once, up front. The walk, the content
  // id, and the stored manifest all derive from this one list, so root order or equivalent spelling
  // ('src' vs './src', or a repeated root) can neither double-inventory a file nor produce a different
  // manifest for the same tree.
  const canonicalRoots = [...new Set(options.sourceRoots.map(canonicalSourceRoot))].sort(compareStr);
  const coveredRoots: string[] = [];
  const skippedRoots = new Set<string>();
  for (const sourceRoot of canonicalRoots) {
    // Overlapping configured roots still describe one physical file set. Keep the complete
    // declared policy in the manifest, while walking each subtree at most once.
    const comparable = process.platform === 'win32' ? sourceRoot.toLowerCase() : sourceRoot;
    if (coveredRoots.some((root) => root === '.' || comparable === root || comparable.startsWith(`${root}/`))) {
      continue;
    }
    coveredRoots.push(comparable);
    const inspected = inspectSourceRoot(options.root, sourceRoot, excluded);
    if (inspected === null) continue;
    if (typeof inspected !== 'string') {
      if (!skippedRoots.has(inspected.path)) {
        skippedRoots.add(inspected.path);
        skipped.push(inspected);
      }
      continue;
    }
    walk(inspected, options.root, excluded, excludedExtensions, files, skipped, options.executableOf);
  }

  // Sorting here is a convenience for readers; identity does not depend on it, because
  // makeSnapshotId sorts its own manifest. Both being true is the point: a reordering
  // bug in this function cannot change a snapshot ID.
  files.sort((a, b) => compareStr(a.path, b.path));
  skipped.sort((a, b) => compareStr(a.path, b.path));

  // makeSnapshotId enforces the no-duplicate / no-case-collision invariant on the file set and
  // yields the path+content identity. DEV-P0-02: the content id then folds in every input that
  // governs which files are included and how they are interpreted — normalised source roots, the
  // effective excludes, the executable mode of each file, and the skipped/symlink/special records —
  // so two different governed bases can never share one id while carrying different manifests. The
  // manifest below also stores these fields, so the id is a hash of exactly what the manifest shows.
  // DEV-P0-02: the content id and stored manifest both derive from the one canonical root list
  // computed before the walk, so they can never disagree for the same tree.
  const filesIdentity = makeSnapshotId(
    files.map((file) => ({ path: file.path, hash: requireSha256(file.hash, file.path) })),
  );
  const id = hashCanonicalJson({
    v: SNAPSHOT_CONTENT_ID_VERSION,
    source_roots: canonicalRoots,
    excludes: [...excluded].sort(compareStr),
    exclude_extensions: [...excludedExtensions].sort(compareStr),
    files: filesIdentity,
    modes: files.map((file) => ({ path: file.path, executable: file.executable })),
    skipped,
  });

  const byLanguage: Record<string, number> = {};
  let totalBytes = 0;
  for (const file of files) {
    byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;
    totalBytes += file.bytes;
  }

  return parseOrThrow(
    snapshotManifestSchema,
    {
      id,
      source_roots: canonicalRoots,
      files,
      skipped,
      stats: { file_count: files.length, total_bytes: totalBytes, by_language: byLanguage },
    },
    'snapshot manifest',
  );
}

function canonicalSourceRoot(sourceRoot: string): string {
  const segments = normalisePath(sourceRoot).split('/');
  if (
    sourceRoot.length === 0 ||
    sourceRoot.includes('\0') ||
    absolutePathForm(sourceRoot) !== null ||
    /^[a-z]:/iu.test(segments[0] ?? '') ||
    segments.includes('..')
  ) {
    throw new Error(`Invalid snapshot source root: ${JSON.stringify(sourceRoot)}`);
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/') || '.';
}

/** Check each path component before opening the directory. lstat of only the final
 * component would miss an intermediate symlink or Windows junction. */
function inspectSourceRoot(
  root: string,
  sourceRoot: string,
  excluded: ReadonlySet<string>,
): string | SkippedEntry | null {
  let absolute = join(root, '.');
  let path = '.';
  for (const component of ['.', ...(sourceRoot === '.' ? [] : sourceRoot.split('/'))]) {
    if (component !== '.') {
      absolute = join(absolute, component);
      path = path === '.' ? component : `${path}/${component}`;
      if (matchesConfiguredExclusion(path, component, excluded)) return null;
    }
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) return skippedSymlink(path, absolute);
      if (!stat.isDirectory()) return { path, reason: 'special', detail: 'not a directory' };
    } catch (error) {
      return { path, reason: 'unreadable', detail: (error as Error).message };
    }
  }
  return absolute;
}

function walk(
  directory: string,
  root: string,
  excluded: ReadonlySet<string>,
  excludedExtensions: ReadonlySet<string>,
  files: SourceFile[],
  skipped: SkippedEntry[],
  executableOf?: (relativePath: string) => boolean | null,
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    skipped.push({
      path: toRelative(root, directory),
      reason: 'unreadable',
      detail: (error as Error).message,
    });
    return;
  }

  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relativePath = toRelative(root, absolute);
    if (matchesConfiguredExclusion(relativePath, entry.name, excluded)) continue;

    if (entry.isSymbolicLink()) {
      // DEV-P0-02: record the actual link target text (via readlink), not just "file link". The skipped
      // records are folded into the content id, so re-pointing a symlink at a different target now
      // changes the snapshot identity instead of being invisible.
      skipped.push(skippedSymlink(relativePath, absolute));
      continue;
    }

    if (entry.isDirectory()) {
      walk(absolute, root, excluded, excludedExtensions, files, skipped, executableOf);
      continue;
    }

    if (!entry.isFile()) {
      skipped.push({ path: relativePath, reason: 'special', detail: 'not a regular file' });
      continue;
    }

    const extensionIndex = entry.name.lastIndexOf('.');
    if (extensionIndex >= 0 && excludedExtensions.has(entry.name.slice(extensionIndex + 1).toLowerCase())) {
      continue;
    }

    try {
      const measured = hashFile(absolute);
      files.push({
        path: relativePath,
        hash: measured.hash,
        bytes: measured.bytes,
        language: classifyLanguage(relativePath),
        executable: executableOf?.(relativePath) ?? isExecutable(absolute),
      });
    } catch (error) {
      skipped.push({ path: relativePath, reason: 'unreadable', detail: (error as Error).message });
    }
  }
}

function skippedSymlink(path: string, absolute: string): SkippedEntry {
  let target: string;
  try {
    target = readlinkSync(absolute);
  } catch {
    target = 'unresolved';
  }
  // Preserve the existing manifest spelling for links without dereferencing their target.
  return { path, reason: 'symlink', detail: `file-link -> ${target}` };
}


/**
 * A simple rule such as `dist` preserves the historical path-segment behavior at any depth.
 * A rule containing `/`, such as `src/generated`, excludes only that exact project-relative
 * path and its descendants. Both forms are recorded unchanged in the capture basis.
 */
function matchesConfiguredExclusion(
  relativePath: string,
  entryName: string,
  excluded: ReadonlySet<string>,
): boolean {
  const candidate = normalisePath(relativePath).replace(/^\.\//u, '');
  for (const configured of excluded) {
    const rule = normalisePath(configured).replace(/^\.\//u, '').replace(/\/$/u, '');
    if (rule === '') continue;
    if (!rule.includes('/')) {
      if (entryName === rule) return true;
      continue;
    }
    if (candidate === rule || candidate.startsWith(`${rule}/`)) return true;
  }
  return false;
}

/**
 * The executable bit that participates in content identity. Cross-platform rule: on POSIX, any
 * execute bit (`0o111`) marks the file executable — the same distinction source control records as
 * `100755` vs `100644`; on Windows, which has no executable bit, the answer is always `false`. A
 * stat failure is treated as non-executable rather than aborting the scan.
 */
function isExecutable(absolutePath: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    return (statSync(absolutePath).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function toRelative(root: string, absolute: string): string {
  return normalisePath(relative(root, absolute));
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Hashes a file in one streaming pass.
 *
 * Streaming rather than reading whole: source trees contain assets, and a snapshot that
 * cannot be taken because one file is large is a snapshot that will be skipped.
 */
function hashFile(path: string): { hash: Sha256; bytes: number } {
  const hasher = createHash(HASH_ALGORITHM);
  const fd = openSync(path, 'r');
  let bytes = 0;

  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, bytes);
      if (read === 0) break;
      hasher.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(fd);
  }

  return { hash: hasher.digest('hex') as Sha256, bytes };
}

/* ------------------------------------------------------------------------- */
/* Diffing                                                                    */
/* ------------------------------------------------------------------------- */

export interface SnapshotDiff {
  readonly from: SnapshotId | null;
  readonly to: SnapshotId;
  readonly added: readonly SourceFile[];
  readonly removed: readonly SourceFile[];
  /** Files present in both with different content. */
  readonly modified: readonly { readonly before: SourceFile; readonly after: SourceFile }[];
  readonly unchangedCount: number;
  /**
   * Every path whose bytes differ between the two snapshots, added and removed
   * included. This is the invalidation set: nothing outside it needs rescanning, and
   * everything inside it does.
   */
  readonly changedPaths: readonly string[];
}

/**
 * Compares two manifests.
 *
 * A null `before` means everything is new, which is the honest description of a first
 * capture rather than a special case to be hidden.
 */
export function diffSnapshots(before: SnapshotManifest | null, after: SnapshotManifest): SnapshotDiff {
  const beforeFiles = new Map((before?.files ?? []).map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));

  const added: SourceFile[] = [];
  const removed: SourceFile[] = [];
  const modified: { before: SourceFile; after: SourceFile }[] = [];
  const changed = new Set<string>();
  let unchangedCount = 0;

  for (const [path, file] of afterFiles) {
    const previous = beforeFiles.get(path);
    if (previous === undefined) {
      added.push(file);
      changed.add(path);
    } else if (previous.hash !== file.hash || previous.executable !== file.executable) {
      // DEV-P0-02: a file whose executable bit flipped is a change even when its bytes are identical.
      // The bit is part of content identity, so a mode-only change must land in the modified set and
      // the invalidation set rather than being counted as unchanged and rescanned by nobody.
      modified.push({ before: previous, after: file });
      changed.add(path);
    } else {
      unchangedCount += 1;
    }
  }

  for (const [path, file] of beforeFiles) {
    if (!afterFiles.has(path)) {
      removed.push(file);
      changed.add(path);
    }
  }

  return {
    from: (before?.id ?? null) as SnapshotId | null,
    to: after.id as SnapshotId,
    added,
    removed,
    modified,
    unchangedCount,
    changedPaths: [...changed].sort(compareStr),
  };
}

/* ------------------------------------------------------------------------- */
/* Persistence                                                                */
/* ------------------------------------------------------------------------- */

export const SNAPSHOT_EVENT_TYPES = {
  snapshotCaptured: 'snapshot.captured',
} as const;

export const SNAPSHOT_SCHEMA_SQL = `
-- Immutable content identity. One row per content id, written once and never mutated;
-- volatile per-capture fields live in snapshot_captures. Content columns are a pure
-- function of the analysed bytes, so a rebuild reproduces this row exactly.
CREATE TABLE IF NOT EXISTS snapshots (
  id            TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  file_count    INTEGER NOT NULL,
  total_bytes   INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL
);

-- Append-only capture receipts. Each capture of a content identity records when it
-- happened, under which Git state, from which origin, and under which scan policy. This
-- is the "capture identity" half of DEV-P0-02; the identity row above is never overwritten
-- with these fields, so one snapshot id can no longer mix metadata from two captures.
CREATE TABLE IF NOT EXISTS snapshot_captures (
  capture_id         TEXT PRIMARY KEY,
  snapshot_id        TEXT NOT NULL,
  captured_at        TEXT NOT NULL,
  git_commit         TEXT,
  git_branch         TEXT,
  git_dirty          INTEGER NOT NULL,
  origin             TEXT NOT NULL,
  capture_basis_hash TEXT NOT NULL,
  source_roots       TEXT NOT NULL,
  excludes           TEXT NOT NULL,
  project_recognition TEXT
);
CREATE INDEX IF NOT EXISTS snapshot_captures_snapshot ON snapshot_captures(snapshot_id);
CREATE INDEX IF NOT EXISTS snapshot_captures_origin   ON snapshot_captures(origin, captured_at);
CREATE INDEX IF NOT EXISTS snapshot_captures_time     ON snapshot_captures(captured_at);

-- A cache, not a record. Rebuildable at any time from the manifest artifact, which is
-- why the event log stays readable instead of carrying thousands of file rows.
CREATE TABLE IF NOT EXISTS snapshot_files (
  snapshot_id TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  language    TEXT NOT NULL,
  executable  INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);
CREATE INDEX IF NOT EXISTS snapshot_files_hash     ON snapshot_files(hash);
CREATE INDEX IF NOT EXISTS snapshot_files_language ON snapshot_files(language);
`;

export function ensureSnapshotSchema(db: Db): void {
  db.exec(SNAPSHOT_SCHEMA_SQL);
  // Existing workspaces predate project-scoped recognition identity. Additive nullable
  // migration preserves every historical receipt and keeps replay idempotent.
  if (!hasColumn(db, 'snapshot_captures', 'project_recognition')) {
    db.exec('ALTER TABLE snapshot_captures ADD COLUMN project_recognition TEXT');
  }
}

function hasColumn(db: Db, table: string, column: string): boolean {
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (typeof row === 'object' && row !== null && (row as Record<string, unknown>)['name'] === column) {
      return true;
    }
  }
  return false;
}

/**
 * Raised when one snapshot content id is asked to carry two different manifests. Because the content
 * id is a hash of the full governed basis (DEV-P0-02), this cannot happen for honestly-captured data;
 * if it does, some input that defines identity was left out of the id, and the only safe response is
 * to fail loudly rather than silently keep whichever manifest was written first.
 */
export class SnapshotIdentityError extends Error {
  public constructor(
    public readonly snapshotId: string,
    public readonly existingManifestHash: string,
    public readonly incomingManifestHash: string,
  ) {
    super(
      `Snapshot identity collision for ${snapshotId}: existing manifest ${existingManifestHash} ` +
        `differs from incoming ${incomingManifestHash}. One content id must carry exactly one manifest.`,
    );
    this.name = 'SnapshotIdentityError';
  }
}

export const SNAPSHOT_PROJECTORS: Readonly<Record<string, Projector>> = {
  [SNAPSHOT_EVENT_TYPES.snapshotCaptured]: (db, record) => {
    const capture = parseOrThrow(captureRecordSchema, record.payload, 'snapshot.captured');

    // Content identity: written once, never mutated. DEV-P0-02 invariant — a given id must always
    // carry the same manifest_hash. The old `ON CONFLICT(id) DO NOTHING` silently kept whichever
    // manifest landed first, so a collision (two governed bases sharing an id) went unnoticed. Now a
    // repeat of the same manifest is an idempotent no-op (replay, re-capture), but a *different*
    // manifest under the same id throws — the identity function must be repaired, not papered over.
    const existing = db
      .prepare('SELECT manifest_hash FROM snapshots WHERE id = ?')
      .get(capture.id) as { manifest_hash: string } | undefined;
    if (existing === undefined) {
      db.prepare(
        `INSERT INTO snapshots (id, manifest_hash, file_count, total_bytes, skipped_count)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        capture.id,
        capture.manifest_hash,
        capture.file_count,
        capture.total_bytes,
        capture.skipped_count,
      );
    } else if (existing.manifest_hash !== capture.manifest_hash) {
      throw new SnapshotIdentityError(capture.id, existing.manifest_hash, capture.manifest_hash);
    }

    // Capture receipt. Events written before DEV-P0-02 carry no receipt identity, so derive
    // one deterministically from their content and Git fields; new events supply it directly.
    const gitBasis = {
      commit: capture.git_commit,
      branch: capture.git_branch,
      dirty: capture.git_dirty,
    };
    const captureBasisHash =
      capture.capture_basis_hash ??
      hashCanonicalJson({ snapshot_id: capture.id, origin: capture.origin, git: gitBasis });
    const captureId =
      capture.capture_id ??
      hashCanonicalJson({
        snapshot_id: capture.id,
        origin: capture.origin,
        captured_at: capture.captured_at,
        git: gitBasis,
      });
    const sourceRoots = capture.source_roots ?? [];
    const excludes: CaptureExcludes = capture.excludes ?? { dirs: [], extensions: [] };

    db.prepare(
      `INSERT INTO snapshot_captures
         (capture_id, snapshot_id, captured_at, git_commit, git_branch, git_dirty, origin,
          capture_basis_hash, source_roots, excludes, project_recognition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(capture_id) DO NOTHING`,
    ).run(
      captureId,
      capture.id,
      capture.captured_at,
      capture.git_commit,
      capture.git_branch,
      capture.git_dirty ? 1 : 0,
      capture.origin,
      captureBasisHash,
      canonicalJson(sourceRoots),
      canonicalJson(excludes),
      capture.project_recognition === undefined ? null : canonicalJson(capture.project_recognition),
    );
  },
};

export interface SnapshotRegistryDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  readonly missionVersion: () => string;
}

export interface CaptureRequest extends CaptureOptions {
  readonly origin: 'canonical' | 'shadow';
  readonly git?: GitContext;
  /** Exact project recognition generation governing this capture; absent in legacy mode. */
  readonly projectRecognition?: ProjectRecognitionIdentity;
}

export interface CaptureResult {
  readonly record: SnapshotRecord;
  readonly manifest: SnapshotManifest;
  /** Durable identity of this specific capture receipt. */
  readonly captureId: Sha256;
  /** True when a snapshot with this content identity already existed. */
  readonly alreadyKnown: boolean;
  readonly diff: SnapshotDiff | null;
}

/** The projected shape returned by the identity-plus-latest-receipt join. */
const SNAPSHOT_RECORD_COLUMNS = `
  s.id            AS id,
  c.captured_at   AS captured_at,
  s.manifest_hash AS manifest_hash,
  s.file_count    AS file_count,
  s.total_bytes   AS total_bytes,
  s.skipped_count AS skipped_count,
  c.git_commit    AS git_commit,
  c.git_branch    AS git_branch,
  c.git_dirty     AS git_dirty,
  c.origin        AS origin
`;

export class SnapshotRegistry {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly artifacts: ArtifactStore;
  private readonly missionVersion: () => string;

  public constructor(deps: SnapshotRegistryDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.artifacts = deps.artifacts;
    this.missionVersion = deps.missionVersion;
    ensureSnapshotSchema(this.projections.db);
  }

  /**
   * Captures a snapshot and records it.
   *
   * Re-capturing an unchanged tree is cheap and idempotent for the content identity: the
   * manifest is content-only, so it deduplicates to the same blob and the `snapshots` row
   * is written once. The capture itself is still recorded as a fresh receipt, so history
   * is preserved without ever mutating the identity. `alreadyKnown` says whether the
   * content was already known; `diff` compares against the most recent snapshot of the
   * same origin.
   */
  public capture(request: CaptureRequest): CaptureResult {
    const manifest = captureSnapshot(request);
    const previous = this.latest(request.origin);
    const previousManifest = previous === null ? null : this.manifestOf(previous.id);

    // The content manifest is content-only, so an identical tree always yields an
    // identical blob and repeated captures store nothing new.
    const artifact = this.artifacts.putJson(manifest, {
      label: `snapshot-${manifest.id.slice(0, 12)}.json`,
    });

    const capturedAt = nowIso();
    const git: GitContext = request.git ?? { commit: null, branch: null, dirty: false };
    const excludes = resolveExcludes(request);
    const sourceRoots = [...request.sourceRoots];

    // The capture basis is the reproducible "how/where" of this capture (content id, the immutable
    // manifest it produced, origin, roots, excludes, Git). DEV-P0-02: binding `manifest_hash` here
    // means `capture_basis_hash` — and therefore `capture_id` — commit to the exact manifest, so a
    // receipt can never be reused to point a content id at a different manifest.
    const captureBasis = {
      snapshot_id: manifest.id,
      manifest_hash: artifact.hash,
      origin: request.origin,
      source_roots: [...sourceRoots].sort(compareStr),
      excludes,
      git,
      ...(request.projectRecognition === undefined
        ? {}
        : { project_recognition: projectRecognitionIdentitySchema.parse(request.projectRecognition) }),
    };
    const captureBasisHash = hashCanonicalJson(captureBasis);
    // DEV-P0-02: the capture receipt identity must be unique per capture. The basis hash above is
    // deterministic (it commits to the manifest, roots, excludes, and Git facts); the receipt id adds a
    // nonce so two captures of an unchanged tree in the same millisecond are still distinct receipts
    // over the one shared content manifest, rather than colliding into a single receipt.
    const captureId = hashCanonicalJson({ ...captureBasis, captured_at: capturedAt, nonce: randomUUID() });

    const alreadyKnown = this.get(manifest.id) !== null;

    const payload = parseOrThrow(
      captureRecordSchema,
      {
        id: manifest.id,
        manifest_hash: artifact.hash,
        file_count: manifest.stats.file_count,
        total_bytes: manifest.stats.total_bytes,
        skipped_count: manifest.skipped.length,
        captured_at: capturedAt,
        git_commit: git.commit,
        git_branch: git.branch,
        git_dirty: git.dirty,
        origin: request.origin,
        capture_id: captureId,
        capture_basis_hash: captureBasisHash,
        source_roots: sourceRoots,
        excludes,
        ...(request.projectRecognition === undefined
          ? {}
          : { project_recognition: request.projectRecognition }),
      },
      `snapshot ${manifest.id}`,
    );

    this.log.append({
      type: SNAPSHOT_EVENT_TYPES.snapshotCaptured,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId: null,
      payload,
    });
    this.projections.sync(this.log);
    this.hydrateFiles(manifest);

    const record = parseOrThrow(
      snapshotRecordSchema,
      {
        id: manifest.id,
        captured_at: capturedAt,
        manifest_hash: artifact.hash,
        file_count: manifest.stats.file_count,
        total_bytes: manifest.stats.total_bytes,
        skipped_count: manifest.skipped.length,
        git_commit: git.commit,
        git_branch: git.branch,
        git_dirty: git.dirty,
        origin: request.origin,
      },
      `snapshot record ${manifest.id}`,
    );

    return {
      record,
      manifest,
      captureId,
      alreadyKnown,
      diff: previousManifest === null ? null : diffSnapshots(previousManifest, manifest),
    };
  }

  /**
   * The snapshot link for a capture, bound to the mission root seal (DEV-P1-28, phase 2).
   *
   * Content identity, manifest hash, and capture-receipt id come straight from the capture the
   * registry just recorded; `missionSeal` is the mission registry's `spineSeal()`. Sealing this link
   * yields the value the recognition stage binds to next.
   */
  public spineLink(capture: CaptureResult, missionSeal: BindingHash): SnapshotLink {
    return {
      stage: 'snapshot',
      boundTo: missionSeal,
      snapshotContentId: requireSpineHash(capture.record.id, 'SnapshotContentId'),
      manifestHash: requireSpineHash(capture.record.manifest_hash, 'ManifestHash'),
      captureId: requireSpineId(capture.captureId, 'CaptureId'),
    };
  }

  /** The sealed binding hash of the snapshot link — the value the recognition stage binds to. */
  public spineSeal(capture: CaptureResult, missionSeal: BindingHash): BindingHash {
    return sealEvidenceLink(this.spineLink(capture, missionSeal));
  }

  /**
   * Verifies a presented snapshot link against both its mission predecessor and this registry's own
   * record (DEV-P1-28, phase 2).
   *
   * Two independent checks. The link must bind to the given mission root — recomputed, so a mission
   * altered after the fact is caught — and its content identity and manifest hash must match a snapshot
   * this registry actually recorded, so a link cannot claim a content id the registry never captured,
   * nor pair a real content id with a manifest hash that was never its own.
   */
  public verifySnapshotLink(link: SnapshotLink, missionLink: MissionLink): void {
    verifyEvidenceLink(link, missionLink);
    const record = this.get(link.snapshotContentId);
    if (record === null) {
      throw new EvidenceChainError(
        `snapshot link references content id ${link.snapshotContentId}, which this registry never recorded`,
      );
    }
    if (record.manifest_hash !== link.manifestHash) {
      throw new EvidenceChainError(
        `snapshot link manifest ${link.manifestHash} does not match the recorded manifest ` +
          `${record.manifest_hash} for content id ${link.snapshotContentId}`,
      );
    }
  }

  public get(snapshotId: string): SnapshotRecord | null {
    const row = this.projections.db
      .prepare(
        `SELECT ${SNAPSHOT_RECORD_COLUMNS}
         FROM snapshots s
         JOIN snapshot_captures c ON c.snapshot_id = s.id
         WHERE s.id = ?
         ORDER BY c.captured_at DESC, c.capture_id DESC
         LIMIT 1`,
      )
      .get(snapshotId);
    return row === undefined ? null : readSnapshotRow(row);
  }

  public latest(origin: 'canonical' | 'shadow'): SnapshotRecord | null {
    const row = this.projections.db
      .prepare(
        `SELECT ${SNAPSHOT_RECORD_COLUMNS}
         FROM snapshot_captures c
         JOIN snapshots s ON s.id = c.snapshot_id
         WHERE c.origin = ?
         ORDER BY c.captured_at DESC, c.capture_id DESC
         LIMIT 1`,
      )
      .get(origin);
    return row === undefined ? null : readSnapshotRow(row);
  }

  public history(limit = 20): SnapshotRecord[] {
    return this.projections.db
      .prepare(
        `SELECT ${SNAPSHOT_RECORD_COLUMNS}
         FROM snapshots s
         JOIN snapshot_captures c ON c.snapshot_id = s.id
         WHERE c.capture_id = (
           SELECT capture_id FROM snapshot_captures c2
           WHERE c2.snapshot_id = s.id
           ORDER BY c2.captured_at DESC, c2.capture_id DESC
           LIMIT 1
         )
         ORDER BY c.captured_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, limit))
      .map(readSnapshotRow);
  }

  /**
   * Reads a stored content manifest back from the artifact store.
   *
   * The manifest is the durable content record; `snapshot_files` is only an index over it.
   * That split is why the event log holds one small row per capture rather than thousands.
   */
  public manifestOf(snapshotId: string): SnapshotManifest | null {
    const record = this.get(snapshotId);
    if (record === null) return null;
    const raw = this.artifacts.getJson(requireSha256(record.manifest_hash, 'manifest hash'));
    return parseOrThrow(snapshotManifestSchema, raw, `manifest of ${snapshotId}`);
  }

  /** Every recorded capture of a content identity, most recent first. */
  public captures(snapshotId: string): CaptureReceipt[] {
    return this.projections.db
      .prepare(
        `SELECT capture_id, snapshot_id, captured_at, git_commit, git_branch, git_dirty,
                origin, capture_basis_hash, source_roots, excludes, project_recognition
         FROM snapshot_captures
         WHERE snapshot_id = ?
         ORDER BY captured_at DESC, capture_id DESC`,
      )
      .all(snapshotId)
      .map(readCaptureRow);
  }

  /** Files of a snapshot, served from the index and hydrated on demand. */
  public files(snapshotId: string): SourceFile[] {
    const rows = this.projections.db
      .prepare(
        'SELECT path, hash, bytes, language, executable FROM snapshot_files WHERE snapshot_id = ? ORDER BY path',
      )
      .all(snapshotId);

    if (rows.length > 0) {
      return rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        // The cache stores the executable bit as 0/1; the manifest schema is a boolean.
        return parseOrThrow(sourceFileSchema, { ...row, executable: row['executable'] === 1 }, 'snapshot_files row');
      });
    }

    const manifest = this.manifestOf(snapshotId);
    if (manifest === null) return [];
    this.hydrateFiles(manifest);
    return [...manifest.files];
  }

  /** Compares two stored snapshots. */
  public diff(fromId: string | null, toId: string): SnapshotDiff {
    const after = this.manifestOf(toId);
    if (after === null) throw new Error(`Unknown snapshot ${toId}`);
    const before = fromId === null ? null : this.manifestOf(fromId);
    return diffSnapshots(before, after);
  }

  /**
   * Re-indexes `snapshot_files` from stored manifests after a projection rebuild (DEV-P0-01).
   *
   * `snapshot_files` is only an index over each snapshot's manifest artifact; it is filled at capture,
   * not by event replay. A rebuild replays the `snapshots` and `snapshot_captures` receipts but leaves
   * the file index empty, so this reads every snapshot's manifest by its stored hash and rebuilds the
   * index — making the rebuilt projections match a clean build exactly. Idempotent.
   */
  public rehydrateAll(): void {
    const rows = this.projections.db.prepare('SELECT id FROM snapshots').all() as ReadonlyArray<{ id: string }>;
    for (const row of rows) {
      const manifest = this.manifestOf(row.id);
      if (manifest !== null) {
        this.hydrateFiles(manifest);
      }
    }
  }

  /** Fills the file index for a manifest. Idempotent, and transaction-aware. */
  private hydrateFiles(manifest: SnapshotManifest): void {
    const db = this.projections.db;
    const insert = db.prepare(
      `INSERT INTO snapshot_files (snapshot_id, path, hash, bytes, language, executable)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, path) DO NOTHING`,
    );
    const fill = (): void => {
      for (const file of manifest.files) {
        insert.run(manifest.id, file.path, file.hash, file.bytes, file.language, file.executable ? 1 : 0);
      }
    };

    // When rehydrateAll runs inside rebuild()'s transaction, do not open a nested one.
    if (db.inTransaction) {
      fill();
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      fill();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Capture receipt                                                            */
/* ------------------------------------------------------------------------- */

export interface CaptureReceipt {
  readonly captureId: Sha256;
  readonly snapshotId: SnapshotId;
  readonly capturedAt: string;
  readonly git: GitContext;
  readonly origin: 'canonical' | 'shadow';
  readonly captureBasisHash: Sha256;
  readonly sourceRoots: readonly string[];
  readonly excludes: CaptureExcludes;
  readonly projectRecognition: ProjectRecognitionIdentity | null;
}

/* ------------------------------------------------------------------------- */
/* Row reading                                                                */
/* ------------------------------------------------------------------------- */

function readSnapshotRow(row: unknown): SnapshotRecord {
  if (typeof row !== 'object' || row === null) throw new Error('snapshots row is not an object');
  const record = row as Record<string, unknown>;
  return parseOrThrow(
    snapshotRecordSchema,
    { ...record, git_dirty: record['git_dirty'] === 1 },
    'snapshots row',
  );
}

function readCaptureRow(row: unknown): CaptureReceipt {
  if (typeof row !== 'object' || row === null) throw new Error('snapshot_captures row is not an object');
  const record = row as Record<string, unknown>;
  return {
    captureId: requireSha256(readString(record, 'capture_id'), 'capture_id'),
    snapshotId: requireSha256(readString(record, 'snapshot_id'), 'snapshot_id') as unknown as SnapshotId,
    capturedAt: readString(record, 'captured_at'),
    git: {
      commit: readNullableString(record, 'git_commit'),
      branch: readNullableString(record, 'git_branch'),
      dirty: record['git_dirty'] === 1,
    },
    origin: readString(record, 'origin') === 'shadow' ? 'shadow' : 'canonical',
    captureBasisHash: requireSha256(readString(record, 'capture_basis_hash'), 'capture_basis_hash'),
    sourceRoots: parseOrThrow(z.array(z.string()), parseJson(readString(record, 'source_roots')), 'source_roots'),
    excludes: parseOrThrow(captureExcludesSchema, parseJson(readString(record, 'excludes')), 'excludes'),
    projectRecognition:
      readNullableString(record, 'project_recognition') === null
        ? null
        : parseOrThrow(
            projectRecognitionIdentitySchema,
            parseJson(readString(record, 'project_recognition')),
            'project_recognition',
          ),
  };
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Expected string field "${field}" in row`);
  return value;
}

function readNullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Expected string-or-null field "${field}" in row`);
  return value;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Exposed so callers can hash a manifest without importing the canonical serialiser. */
export function manifestFingerprint(manifest: SnapshotManifest): string {
  return canonicalJson({ id: manifest.id, files: manifest.files });
}
