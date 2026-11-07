/**
 * CLU-E Status — sealed history and comparison.
 *
 * Spec: `CLUE_Status_Contract_v9.md`
 *   §17    `clue status export|validate|diff`; "Exports use atomic writes and content
 *          hashes. Status history is retained according to policy."
 *   §18    an invalid seal blocks automation and production-health claims
 *   §19    the schema is versioned independently; migrations retain the original artifact
 *   §20    gate 9 — exports survive restart and validate independently
 * Directory: `CLUE_Project_Directory_v9.md` §22 — `workspace/status/` holds "sealed Status
 *          snapshots and history indexes"; §19.2 — Status is a projection over durable
 *          records, never a source used to reconstruct them.
 *
 * Backlog: DEV-P1-14 — the last file of Cluster C. Status could be projected and sealed but
 *          not kept, so nothing could answer "what changed since the last one", which is the
 *          question §17's `diff` exists for and the only one a single snapshot cannot.
 *
 * ## What a snapshot is here, and what it is not
 *
 * A retained status snapshot is a *derived* artifact. It can always be reprojected from the
 * event log and the registries, which is what §19.2 means by Status being a projection
 * rather than a source. That has one consequence worth stating plainly, because it governs
 * every design decision below: **losing this directory loses nothing that cannot be
 * rebuilt.** History here is a convenience and an audit aid, not an authority.
 *
 * So retention is allowed to be lossy, and the index deliberately keeps only what a
 * comparison needs rather than a second copy of each body. What retention may *not* do is
 * lie: a pruned snapshot is removed from the index with it, so the index never names a file
 * that is gone, and a body that fails its own seal is refused entry rather than stored and
 * flagged.
 *
 * ## Why the index is rebuilt from the files rather than mutated in place
 *
 * The obvious design is an index file appended on each write. It is also the one that goes
 * wrong quietly: a crash between writing the snapshot and updating the index leaves the two
 * disagreeing forever, and nothing detects it because the index is the thing you would ask.
 * {@link readStatusHistory} instead derives the index from the directory on every read —
 * the files are the authority, the index is a projection of them. That costs a directory
 * scan and a header parse per entry, which is trivially bounded by the retention policy,
 * and buys the property that the index cannot drift from what is on disk because it is
 * never separately stored.
 *
 * ## Diff
 *
 * {@link diffStatus} compares two sealed bodies branch by branch. It reports what changed
 * rather than a textual delta, because the useful question about two status snapshots is
 * almost never "which bytes differ" — it is "did a branch that was backed become
 * unavailable", which is a fact about the system rather than about the file.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { fsyncDir, replaceFileSync, writeAllSync } from '../shared/durableFs.js';
import {
  isBranchUnavailable,
  parseStatusSnapshot,
  type BranchUnavailable,
  type StatusSnapshot,
} from './statusContractV5.js';
import { bodyOf, sealBodyDigest, verifySeal } from './statusSeal.js';
import type { Sha256 } from '../shared/ids.js';

/** A retained status snapshot could not be written, read, or trusted. */
export class StatusHistoryError extends Error {
  public override readonly name = 'StatusHistoryError';
}

/* ------------------------------------------------------------------------- */
/* Layout                                                                     */
/* ------------------------------------------------------------------------- */

/** `workspace/status/` — sealed snapshots and their derived index (Directory §22). */
export function statusHistoryDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, 'status');
}

/**
 * The file name for one sealed snapshot: capture instant first, then the status hash.
 *
 * Time-ordered so a directory listing sorts chronologically without parsing, and
 * hash-suffixed so two snapshots taken in the same millisecond over different state cannot
 * collide. Colons are stripped because they are not portable in filenames on Windows, and
 * this workspace is read from both.
 */
export function statusSnapshotFileName(generatedAt: string, statusHash: string): string {
  const stamp = generatedAt.replace(/[:.]/g, '-');
  return `status-${stamp}-${statusHash.slice(0, 12)}.json`;
}

/* ------------------------------------------------------------------------- */
/* Writing                                                                    */
/* ------------------------------------------------------------------------- */

export interface RetainedSnapshot {
  readonly path: string;
  readonly statusHash: Sha256;
  readonly generatedAt: string;
  readonly bytes: number;
}

/**
 * Retains a sealed snapshot in the workspace history.
 *
 * The seal is verified before the file is written, not after. A snapshot that does not
 * verify is a projector defect (§15) and storing it would put a body into the history that
 * `clue status validate` will later reject — history whose own contents fail the check the
 * history exists to support. It is refused here, where the caller still has the context to
 * say why.
 *
 * Writing is temp → whole-buffer write → fsync → atomic replace, through the shared durable
 * primitives. §17 requires exactly that, and gate 9 ("exports survive restart and validate
 * independently") is the reason: a half-written snapshot that parses is worse than one that
 * does not exist, because it will validate as far as its truncation point.
 */
export function retainStatus(
  workspaceRoot: string,
  snapshot: StatusSnapshot,
): RetainedSnapshot {
  const verification = verifySeal(snapshot);
  if (!verification.valid) {
    throw new StatusHistoryError(
      `refusing to retain a snapshot whose seal does not verify: ${verification.failures
        .map((failure) => `${failure.code} — ${failure.detail}`)
        .join('; ')}`,
    );
  }

  const directory = statusHistoryDirectory(workspaceRoot);
  mkdirSync(directory, { recursive: true });
  const path = join(
    directory,
    statusSnapshotFileName(snapshot.generatedAt, snapshot.seal.statusHash),
  );
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, 'w');
  try {
    writeAllSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  replaceFileSync(temporary, path);

  return {
    path,
    statusHash: snapshot.seal.statusHash,
    generatedAt: snapshot.generatedAt,
    bytes: bytes.byteLength,
  };
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

/** One entry of the derived history index. */
export interface StatusHistoryEntry {
  readonly path: string;
  readonly generatedAt: string;
  readonly statusHash: Sha256;
  readonly schemaVersion: string;
  /** The seal's own consistency verdict, as stored. Not re-evaluated here. */
  readonly consistent: boolean;
  readonly bytes: number;
}

export interface StatusHistory {
  readonly directory: string;
  /** Newest first. */
  readonly entries: readonly StatusHistoryEntry[];
  /**
   * Files in the directory that could not be read as sealed snapshots, with the reason.
   * Reported rather than skipped: a corrupt snapshot is a fact about the workspace, and
   * silently omitting it would make the history look healthier than it is.
   */
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Derives the history index from the files on disk.
 *
 * There is no stored index to fall out of step with the directory — see the module header.
 * Each file is parsed through the full contract schema, so an entry appears only if the
 * snapshot it describes is genuinely a status snapshot of this schema version.
 */
export function readStatusHistory(workspaceRoot: string): StatusHistory {
  const directory = statusHistoryDirectory(workspaceRoot);
  if (!existsSync(directory)) return { directory, entries: [], unreadable: [] };

  const entries: StatusHistoryEntry[] = [];
  const unreadable: { path: string; reason: string }[] = [];

  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const path = join(directory, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      const snapshot = parseStatusSnapshot(JSON.parse(readFileSync(path, 'utf8')));
      entries.push({
        path,
        generatedAt: snapshot.generatedAt,
        statusHash: snapshot.seal.statusHash,
        schemaVersion: snapshot.schemaVersion,
        consistent: snapshot.seal.consistent,
        bytes: stats.size,
      });
    } catch (error) {
      unreadable.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  entries.sort(
    (left, right) =>
      right.generatedAt.localeCompare(left.generatedAt) || right.path.localeCompare(left.path),
  );
  return { directory, entries, unreadable };
}

/** Loads and validates one retained snapshot. */
export function loadRetainedStatus(path: string): StatusSnapshot {
  try {
    return parseStatusSnapshot(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new StatusHistoryError(
      `${path} is not a readable status snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Retention                                                                  */
/* ------------------------------------------------------------------------- */

export interface StatusRetentionPolicy {
  /** Newest snapshots to keep. */
  readonly keep: number;
  /** Status hashes that must survive regardless of age. */
  readonly protect?: readonly string[];
}

export interface StatusRetentionReceipt {
  readonly scanned: number;
  readonly kept: readonly string[];
  readonly removed: readonly string[];
  readonly bytesReclaimed: number;
  readonly failures: readonly string[];
}

/**
 * Applies bounded retention (§17: "Status history is retained according to policy").
 *
 * Unreadable files are counted but never removed. That is deliberate and it is the opposite
 * of the tempting behaviour: a file this module cannot parse is the one most likely to be
 * evidence of a real problem, and a retention pass that quietly tidied it away would erase
 * the symptom while leaving the cause. They are reported by {@link readStatusHistory} and
 * left for a human.
 */
export function pruneStatusHistory(
  workspaceRoot: string,
  policy: StatusRetentionPolicy,
): StatusRetentionReceipt {
  const history = readStatusHistory(workspaceRoot);
  const protectedHashes = new Set(policy.protect ?? []);
  const kept: string[] = [];
  const removed: string[] = [];
  const failures: string[] = [];
  let bytesReclaimed = 0;
  let keptCount = 0;

  for (const entry of history.entries) {
    if (protectedHashes.has(entry.statusHash) || keptCount < policy.keep) {
      kept.push(entry.path);
      if (!protectedHashes.has(entry.statusHash)) keptCount += 1;
      continue;
    }
    try {
      rmSync(entry.path, { force: true });
      removed.push(entry.path);
      bytesReclaimed += entry.bytes;
    } catch (error) {
      failures.push(`${basename(entry.path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (removed.length > 0) {
    try {
      fsyncDir(history.directory);
    } catch {
      /* best-effort, as everywhere else: a weaker directory-entry guarantee is not a failure */
    }
  }

  return {
    scanned: history.entries.length,
    kept,
    removed,
    bytesReclaimed,
    failures,
  };
}

/* ------------------------------------------------------------------------- */
/* Diff — §17 `clue status diff`                                              */
/* ------------------------------------------------------------------------- */

export type BranchChange =
  /** Both sides carry data and it differs. */
  | 'changed'
  /** Backed on the left, a stated non-value on the right. A regression in coverage. */
  | 'lost'
  /** A stated non-value on the left, backed on the right. */
  | 'gained'
  /** Both sides are non-values, but for different stated reasons. */
  | 'reason_changed'
  | 'unchanged';

export interface BranchDiff {
  readonly branch: string;
  readonly change: BranchChange;
  readonly detail: string | null;
}

export interface StatusDiff {
  readonly identical: boolean;
  readonly schemaChanged: boolean;
  readonly left: { readonly generatedAt: string; readonly statusHash: Sha256 };
  readonly right: { readonly generatedAt: string; readonly statusHash: Sha256 };
  /** Branches whose state changed, in contract order. Unchanged branches are omitted. */
  readonly branches: readonly BranchDiff[];
  /** Consistency verdicts, so a snapshot that became inconsistent is visible at a glance. */
  readonly consistency: { readonly left: boolean; readonly right: boolean };
}

/**
 * Members compared elsewhere in the result rather than as branches.
 *
 * `sources` and `capability` are deliberately NOT here. `sources` names the durable
 * identities the body was assembled from, and `capability` is the snapshot's own account of
 * what this build can do — a change to either is exactly the kind of thing a comparison
 * exists to surface, and excluding them as noise would hide a coverage change behind an
 * unchanged branch set.
 */
const IGNORED_KEYS = new Set(['schemaVersion', 'generatedAt', 'seal']);

/**
 * Compares two sealed snapshots branch by branch.
 *
 * `lost` and `gained` are separate outcomes from `changed` because they are separate facts.
 * A branch that went from backed to unavailable is a coverage regression — something that
 * was being observed no longer is — and a diff that reported it identically to a changed
 * value would bury the one result an operator most needs to see between two runs.
 *
 * Freshness is deliberately part of the comparison rather than excluded as noise: two
 * projections over unchanged durable state at different instants *do* differ in age, and
 * hiding that would misrepresent a stale reading as a current one.
 */
export function diffStatus(left: StatusSnapshot, right: StatusSnapshot): StatusDiff {
  const branches: BranchDiff[] = [];
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;

  for (const key of Object.keys(leftRecord)) {
    if (IGNORED_KEYS.has(key)) continue;
    const before = leftRecord[key];
    const after = rightRecord[key];
    const beforeMissing = isBranchUnavailable(before as never);
    const afterMissing = isBranchUnavailable(after as never);

    if (beforeMissing && afterMissing) {
      const beforeReason = (before as BranchUnavailable).reason;
      const afterReason = (after as BranchUnavailable).reason;
      const beforeState = (before as BranchUnavailable).state;
      const afterState = (after as BranchUnavailable).state;
      if (beforeReason !== afterReason || beforeState !== afterState) {
        branches.push({
          branch: key,
          change: 'reason_changed',
          detail: `${beforeState}: ${beforeReason} → ${afterState}: ${afterReason}`,
        });
      }
      continue;
    }
    if (beforeMissing && !afterMissing) {
      branches.push({ branch: key, change: 'gained', detail: 'now backed by durable state' });
      continue;
    }
    if (!beforeMissing && afterMissing) {
      branches.push({
        branch: key,
        change: 'lost',
        detail: `no longer backed: ${(after as BranchUnavailable).state} — ${(after as BranchUnavailable).reason}`,
      });
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      branches.push({ branch: key, change: 'changed', detail: null });
    }
  }

  // Identity is decided by re-digesting both bodies, not by comparing the hashes the seals
  // claim. A body altered after sealing carries its original seal, so trusting the stored
  // hash would report a tampered file as identical while `status validate` reports
  // HASH_MISMATCH on the same file — two commands disagreeing about one pair of files, and
  // the wrong one of them reassuring.
  const identical = sealBodyDigest(bodyOf(left)) === sealBodyDigest(bodyOf(right));

  return {
    identical,
    schemaChanged: left.schemaVersion !== right.schemaVersion,
    left: { generatedAt: left.generatedAt, statusHash: left.seal.statusHash },
    right: { generatedAt: right.generatedAt, statusHash: right.seal.statusHash },
    branches,
    consistency: { left: left.seal.consistent, right: right.seal.consistent },
  };
}
