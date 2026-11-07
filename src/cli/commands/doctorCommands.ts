/**
 * CLUE `doctor` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command domain,
 *       named `<domain>Commands.ts`.
 *       `CLUE_Architecture_v9.md` — chain, blob, projection-head and boundary integrity.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`.
 *
 * `doctor` inspects the installation rather than the work, which is why it runs without a
 * registered mission: an operator most needs it when something is wrong, and a diagnostic
 * that refuses to run until the system is healthy is not a diagnostic.
 *
 * `--deep` re-hashes every artifact and verifies the whole event chain. The shallow default
 * exists because the deep pass is O(history) and an operator running it reflexively would
 * learn to skip it.
 *
 * Backlog: DEV-P1-29 — target registration. `doctor` reports `project.remote` and the two governed
 *          inputs (`target description.md`, the registered Master Benchmark) per ADR-0005. They
 *          were previously unrepresentable, so an installation with no declared intent looked
 *          identical to one that had registered it — the state Constitution §3.3 forbids being
 *          silent about.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Command } from 'commander';

import { resolvePhysicalPath } from '../../control/policy.js';
import { withRuntime } from '../../control/runtime.js';
import {
  parsePackSeal,
  type EpochRecord,
  type RatificationRecord,
} from '../../control/mission.js';
import { resolveDocumentationPack } from '../../control/documentationPack.js';
import { absolutePathForm } from '../../shared/schemas.js';
import { describeTargetPublication } from '../../shared/targetPublication.js';
import type { MissingSource } from '../../analysis/documents/claimRegistry.js';
import { latestClosedCycle, readCurrentCycle } from '../../cycle/cycleRegistry.js';
import { assessGatewayPolicy, loadGatewayPolicies } from '../../ai/gateway/policy.js';
import type { CycleClosed, CycleRecord } from '../../shared/schemas.js';
import { printChecks, short, write, type Check } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/** The Node the host must provide. Checked here because `doctor` is where an operator looks. */
const MINIMUM_NODE = { major: 22, minor: 11 };

/* ------------------------------------------------------------------------- */
/* Target inputs (DEV-P1-29 / ADR-0005)                                       */
/* ------------------------------------------------------------------------- */

/** What each governed input is for, so an absent one names its own consequence. */
const INPUT_PURPOSE = {
  description: {
    label: 'target description',
    file: 'target description.md',
    template: 'templates/target_description.template_v9.md',
    consequence:
      'CLU-E has no declared intent to compare evidence against (Constitution §3.4)',
  },
  benchmark: {
    label: 'master benchmark',
    file: 'master-benchmark.md',
    template: 'templates/benchmark.template_v9.txt',
    consequence: 'a cycle cannot complete without a valid closing whole-project run (Execution Model §24; §18)',
  },
} as const;

/**
 * Whether a configured input physically resolves at or below the target repository root.
 *
 * Both paths pass through the same real-path normaliser used by policy. This is deliberately
 * stronger than a raw `startsWith`: Windows may spell one path with `/` and the other with `\`,
 * drive-letter case is not significant, and a sibling such as `C:/repo-copy` is not inside
 * `C:/repo`. Existing junctions/symlinks are followed, so a lexically in-repository input that
 * physically escapes is still reported honestly.
 */
export function isInsideTargetRepository(projectRoot: string, candidate: string): boolean {
  const repository = resolvePhysicalPath(projectRoot);
  const input = resolvePhysicalPath(candidate);
  if (input === repository) return true;
  const boundary = repository.endsWith('/') ? repository : `${repository}/`;
  return input.startsWith(boundary);
}

/**
 * Reports the two governed target inputs.
 *
 * A configured path is resolved the way the loader will resolve it — absolute as written,
 * otherwise relative to `project.root` — so what `doctor` reports is the path that will actually
 * be read, not a second interpretation of the same string.
 *
 * The content hash is shown for a present file because these are cycle-locked inputs: Status §4.1
 * compares the current hash against the hash locked at the start of a cycle and requires an
 * explicit `CONTINUE_LOCKED` / `RESTART_WITH_NEW_INPUTS` / `FORK_NEW_MISSION` transition when they
 * differ. An operator who can see the hash can tell those apart without opening the file.
 *
 * `insideRepository` is a warning and not a refusal. §25.2 prefers both inputs inside the target
 * repository so they travel in its Git history, but CLU-E has to be able to assess a target whose
 * owner will not accept two new files in their tree.
 */
function projectInputChecks(
  projectRoot: string,
  inputs: { readonly description: string | null; readonly benchmark: string | null },
): Check[] {
  const checks: Check[] = [];
  for (const key of ['description', 'benchmark'] as const) {
    const purpose = INPUT_PURPOSE[key];
    const configured = inputs[key];

    if (configured === null) {
      checks.push({
        level: 'info',
        label: purpose.label,
        detail: `not registered — ${purpose.consequence}. Template: ${purpose.template}`,
      });
      continue;
    }

    const resolved =
      absolutePathForm(configured) === null ? join(projectRoot, configured) : configured;

    if (!existsSync(resolved)) {
      checks.push({
        level: 'fail',
        label: purpose.label,
        detail: `configured but absent: ${resolved} — registered inputs must exist`,
      });
      continue;
    }

    let hash: string;
    try {
      hash = createHash('sha256').update(readFileSync(resolved)).digest('hex');
    } catch (error) {
      checks.push({
        level: 'fail',
        label: purpose.label,
        detail: `unreadable: ${resolved} (${error instanceof Error ? error.message : String(error)})`,
      });
      continue;
    }

    const insideRepository = isInsideTargetRepository(projectRoot, resolved);
    checks.push({
      level: insideRepository ? 'ok' : 'warn',
      label: purpose.label,
      detail: insideRepository
        ? `${configured} ${short(hash)}`
        : `${resolved} ${short(hash)} — outside the target repository; it will not travel in its Git history (§25.2)`,
    });
  }
  return checks;
}

/* ------------------------------------------------------------------------- */
/* Missing sources, categorized (DEV-P2-06 follow-up, 2026-08-10)              */
/* ------------------------------------------------------------------------- */

/**
 * Splits the registry's missing sources — documents cited by the corpus but never ingested —
 * into the two states an operator can act on differently:
 *
 * **outside the corpus** — the cited file exists on disk under the target root. Nothing is
 * lost; the corpus cites a file that is deliberately not a document (configuration, manifests,
 * package files). Reported at info grade, compressed to a count and examples, because a
 * fifty-name wall of by-design non-documents buried the real holes.
 *
 * **absent** — the cited file exists neither in the corpus nor on disk. These are the real
 * holes: planned files not yet written, stale references to renamed documents, citations of
 * material that lives outside the repository. Reported at warn grade and enumerated in full —
 * there is no other listing surface, and a summarized hole is a hidden hole — each with its
 * most-citing document so a stale ADR reference reads differently from a planned-file citation
 * at a glance.
 *
 * Deliberately *not* a third category: "renamed — content survives elsewhere". Proving it
 * needs the cited path's prior content hash, and a workspace whose first ingest happened after
 * a rename never registered the old path. Where the history exists the registry can answer;
 * where it does not, guessing from filename similarity would be invention, and the citation's
 * named citer already leads the operator to the stale reference.
 */
export function categoriseMissingSources(
  missing: readonly MissingSource[],
  existsAt: (target: string) => boolean,
): { readonly outsideCorpus: readonly MissingSource[]; readonly absent: readonly MissingSource[] } {
  const outsideCorpus: MissingSource[] = [];
  const absent: MissingSource[] = [];
  for (const source of missing) {
    (existsAt(source.target) ? outsideCorpus : absent).push(source);
  }
  return { outsideCorpus, absent };
}

/**
 * The cycle line (DEV-P2-08 S6): where the stage machine is, in one glance.
 *
 * A live cycle names its id, stage and grade — WARN when suspended, because a suspended
 * machine is waiting on an operator. No live cycle falls back to the **last closure's own
 * event**, replayed and parsed, so the line carries §24's verdict (`criteria met` or
 * `unmet, N reason(s)`) from the truth rather than from a row that never stored it. No
 * cycle at all says how to start one. Exported pure over its inputs, like the other
 * builders, so the format is pinnable without a runtime.
 */
export function cycleCheck(
  current: CycleRecord | null,
  lastClosed: CycleClosed | null,
): Check {
  if (current !== null) {
    return {
      level: current.stage === 'SUSPENDED' ? 'warn' : 'ok',
      label: 'cycle',
      detail:
        `${current.id} at ${current.stage}` +
        (current.suspended_from === null ? '' : ` (from ${current.suspended_from})`) +
        (current.grade === null ? '' : ` — ${current.grade}`) +
        (current.lock_digest === null ? '' : `, lock ${short(current.lock_digest)}`),
    };
  }
  if (lastClosed !== null) {
    return {
      level: 'info',
      label: 'cycle',
      detail:
        `none in progress; last ${lastClosed.cycle_id} closed ${lastClosed.grade} at ` +
        `${lastClosed.closed_at} — §24 ${
          lastClosed.criteria_met ? 'criteria met' : `unmet, ${lastClosed.unmet.length} reason(s)`
        }`,
    };
  }
  return { level: 'info', label: 'cycle', detail: 'none — `clue cycle drive` opens the first' };
}

/** Builds the doctor line from the categorized split; severity follows the worse category. */
export function missingSourcesCheck(
  missing: readonly MissingSource[],
  existsAt: (target: string) => boolean,
): Check {
  if (missing.length === 0) return { level: 'ok', label: 'missing sources', detail: 'none' };

  const { outsideCorpus, absent } = categoriseMissingSources(missing, existsAt);
  const parts: string[] = [];
  if (outsideCorpus.length > 0) {
    const examples = outsideCorpus
      .slice(0, 3)
      .map((source) => source.target)
      .join(', ');
    parts.push(
      `${outsideCorpus.length} on disk outside the corpus (${examples}${outsideCorpus.length > 3 ? ', …' : ''})`,
    );
  }
  if (absent.length > 0) {
    const listed = absent
      .map((source) => {
        const citer = source.citations[0];
        return citer === undefined
          ? source.target
          : `${source.target} ← ${basename(citer.document_path)}`;
      })
      .join(', ');
    parts.push(`${absent.length} absent: ${listed}`);
  }
  return {
    level: absent.length > 0 ? 'warn' : 'info',
    label: 'missing sources',
    detail: `${missing.length} cited but never ingested — ${parts.join(' · ')}`,
  };
}

/* ------------------------------------------------------------------------- */
/* Installed authority (DEV-P2-05, Gate 7)                                    */
/* ------------------------------------------------------------------------- */


/**
 * Verifies that the installed documentation pack, the seal that declares it, the manifest that
 * describes it, and the configuration that registers it all agree.
 *
 * Four checks, each a distinct failure an operator has actually hit:
 *
 * 1. **pack seal** — every file `SHA256SUMS_v9.txt` declares exists and hashes to its declared
 *    value. An absent seal is a FAIL, not an absence: under Gate 7 the pack *is* the installed
 *    authority, and a root without its seal is an ungoverned installation
 *    (`tools/install-v9-pack.mjs` installs it).
 * 2. **registration ⊆ pack** — every `constitution.tracked_documents` entry appears among the
 *    seal's declared paths. The tracked set is deliberately smaller than the pack (README and
 *    release evidence are not mission-bound); a tracked document *outside* the pack would mean
 *    the mission binds authority the installation does not govern.
 * 3. **manifest ↔ seal** — the manifest parses, its `permanentFileCount` is consistent, and every
 *    entry's `sha256` equals the seal's for the same path. This is exactly the drift a governed
 *    amendment leaves behind when the document and seal move and the manifest entry does not
 *    (the DEV-P2-03 residue, closed 2026-08-10, is the reference case). Amended entries are
 *    surfaced by name so revision state is visible without opening the file.
 * 4. **ratification** — consumes the durable `authority.pack_ratified` record rather than the
 *    manifest's status field. OK when the ratified seal hash equals the live one; WARN when no
 *    act has been performed (naming the entries whose non-`permanent` status makes the act
 *    matter), or when an act exists but the pack has since moved on under a governed amendment
 *    and needs re-ratifying; FAIL when the record itself is corrupt. The manifest's
 *    `reconstructed-pending-ratification` field is release-time state and is deliberately never
 *    rewritten by the act — editing it would change the pack, change the seal, and un-ratify
 *    the ratification. The event discharges it, and this line says so.
 *
 * 5. **epoch** — consumes the durable `authority.epoch_sealed` record (ADR-0006). OK names
 *    the boundary and the pinned blob census; when the pack was re-ratified after the seal,
 *    the line says so — the epoch stays true about its moment, and the note keeps the
 *    lineage visible. WARN when no epoch is sealed, in the ADR's own words: legacy and
 *    governed evidence are not yet distinguished. FAIL on a corrupt record.
 *
 * Seal grammar and filenames are imported from the mission service (`parsePackSeal`), which is
 * their consolidation point — this module's former local copies are gone (DEV-P1-41's lesson).
 *
 * Everything here is a read; doctor stays a diagnostic.
 */
function installedAuthorityChecks(
  repoRoot: string,
  tracked: readonly string[],
  ratification: RatificationRecord | null | { readonly corrupt: string },
  epoch: EpochRecord | null | { readonly corrupt: string },
): Check[] {
  const checks: Check[] = [];
  const pack = resolveDocumentationPack(repoRoot);
  const sealPath = join(repoRoot, ...pack.sealFile.split('/'));

  if (!existsSync(sealPath)) {
    checks.push({
      level: 'fail',
      label: 'pack seal',
      detail: `${pack.sealFile} absent — ${pack.installHint} first`,
    });
    return checks;
  }

  const sealBytes = readFileSync(sealPath);
  const liveSealSha = createHash('sha256').update(sealBytes).digest('hex');
  const parsedSeal = parsePackSeal(sealBytes.toString('utf8'));
  if ('error' in parsedSeal) {
    checks.push({ level: 'fail', label: 'pack seal', detail: `${pack.sealFile}: ${parsedSeal.error}` });
    return checks;
  }
  const declared = parsedSeal.declared;

  const drifted: string[] = [];
  for (const [relative, expected] of declared) {
    const absolute = join(repoRoot, ...relative.split('/'));
    if (!existsSync(absolute)) {
      drifted.push(`${relative} (absent)`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (actual !== expected) drifted.push(relative);
  }
  checks.push(
    drifted.length === 0
      ? { level: 'ok', label: 'pack seal', detail: `${declared.size}/${declared.size} declared files verified` }
      : {
          level: 'fail',
          label: 'pack seal',
          detail: `${drifted.length}/${declared.size} disagree with ${pack.sealFile}: ${drifted.slice(0, 3).join(', ')}${drifted.length > 3 ? ', …' : ''}`,
        },
  );

  const unregistered = tracked.filter((relative) => !declared.has(relative));
  checks.push(
    unregistered.length === 0
      ? {
          level: 'ok',
          label: 'registration ⊆ pack',
          detail: `${tracked.length} tracked documents all declared by the seal`,
        }
      : {
          level: 'fail',
          label: 'registration ⊆ pack',
          detail: `tracked but outside the installed authority: ${unregistered.join(', ')}`,
        },
  );

  const manifestPath = join(repoRoot, ...pack.manifestFile.split('/'));
  if (!existsSync(manifestPath)) {
    // The seal declares the manifest, so check 1 already failed; this only guards the read below.
    checks.push({ level: 'fail', label: 'pack manifest', detail: `${pack.manifestFile} absent` });
    return checks;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    checks.push({
      level: 'fail',
      label: 'pack manifest',
      detail: `unparseable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return checks;
  }
  const record = manifest as {
    permanentFiles?: unknown;
    permanentFileCount?: unknown;
    files?: unknown;
    fileCount?: unknown;
  };
  const manifestEntries = Array.isArray(record.permanentFiles)
    ? record.permanentFiles
    : Array.isArray(record.files)
      ? record.files
      : null;
  const manifestCount = Array.isArray(record.permanentFiles)
    ? record.permanentFileCount
    : record.fileCount;
  if (manifestEntries === null) {
    checks.push({
      level: 'fail',
      label: 'pack manifest',
      detail: 'neither permanentFiles nor files is an array',
    });
    return checks;
  }
  const entries: { path: string; sha256: string; version: string; status: string; amended: boolean }[] = [];
  for (const candidate of manifestEntries as unknown[]) {
    const entry = candidate as {
      path?: unknown;
      sha256?: unknown;
      version?: unknown;
      status?: unknown;
      amendments?: unknown;
    };
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      checks.push({ level: 'fail', label: 'pack manifest', detail: 'an entry lacks path/sha256' });
      return checks;
    }
    entries.push({
      path: entry.path,
      sha256: entry.sha256,
      version: typeof entry.version === 'string' ? entry.version : '?',
      status: typeof entry.status === 'string' ? entry.status : '?',
      amended: Array.isArray(entry.amendments) && entry.amendments.length > 0,
    });
  }
  const countConsistent = typeof manifestCount === 'number' && manifestCount === entries.length;
  const disagreeing = entries.filter((entry) => declared.get(entry.path) !== entry.sha256);
  const amended = entries.filter((entry) => entry.amended);
  if (!countConsistent || disagreeing.length > 0) {
    checks.push({
      level: 'fail',
      label: 'manifest ↔ seal',
      detail: !countConsistent
        ? `manifest count ${String(manifestCount)} ≠ ${entries.length} entries`
        : `stale against the seal: ${disagreeing.map((entry) => `${entry.path} (manifest ${short(entry.sha256)})`).join(', ')}`,
    });
  } else {
    checks.push({
      level: 'ok',
      label: 'manifest ↔ seal',
      detail:
        `${entries.length} entries agree` +
        (amended.length === 0
          ? ''
          : `; amended: ${amended.map((entry) => `${entry.path} rev ${entry.version}`).join(', ')}`),
    });
  }

  const pending = entries.filter((entry) => entry.status !== 'permanent');
  if (ratification !== null && typeof ratification === 'object' && 'corrupt' in ratification) {
    checks.push({ level: 'fail', label: 'ratification', detail: ratification.corrupt });
  } else if (ratification === null) {
    checks.push({
      level: 'warn',
      label: 'ratification',
      detail:
        'never performed — the Creator ratifies with `clue docs ratify`' +
        (pending.length === 0
          ? ''
          : ` (pending: ${pending.map((entry) => `${entry.path} ${entry.status}`).join('; ')})`),
    });
  } else if (
    ratification.seal_sha256 === liveSealSha &&
    ratification.seal_path === pack.sealFile &&
    ratification.manifest_path === pack.manifestFile
  ) {
    const pendingSummary = pending.slice(0, 6).map((entry) => entry.path).join(', ');
    checks.push({
      level: 'ok',
      label: 'ratification',
      detail:
        `${ratification.event_id} by ${ratification.ratified_by} at ${ratification.ratified_at}; ` +
        `${pack.releaseName} ${pack.releaseVersion} current` +
        (pending.length === 0
          ? ''
          : `; discharges ${pendingSummary}${pending.length > 6 ? ` and ${pending.length - 6} more` : ''}`),
    });
  } else {
    checks.push({
      level: 'warn',
      label: 'ratification',
      detail:
        `${ratification.event_id} covered ${ratification.seal_path} ${short(ratification.seal_sha256)}, ` +
        `while selected ${pack.sealFile} is ${short(liveSealSha)} — the installed authority has ` +
        'moved on; re-ratify with `clue docs ratify`',
    });
  }

  if (epoch !== null && typeof epoch === 'object' && 'corrupt' in epoch) {
    checks.push({ level: 'fail', label: 'epoch', detail: epoch.corrupt });
  } else if (epoch === null) {
    checks.push({
      level: 'warn',
      label: 'epoch',
      detail:
        'no epoch sealed — legacy and governed evidence are not yet distinguished; the Creator ' +
        'seals with `clue epoch seal`',
    });
  } else {
    const reRatified =
      ratification !== null &&
      !('corrupt' in ratification) &&
      ratification.event_id !== epoch.ratification_event_id
        ? `; pack re-ratified since (${ratification.event_id})`
        : '';
    checks.push({
      level: 'ok',
      label: 'epoch',
      detail:
        `${epoch.epoch_name} sealed as ${epoch.event_id} by ${epoch.sealed_by} ` +
        `(boundary ${epoch.legacy_head_sequence}, ${epoch.blob_count} blobs) at ${epoch.sealed_at}` +
        reRatified,
    });
  }

  return checks;
}

/* ------------------------------------------------------------------------- */
/* clue doctor                                                                */
/* ------------------------------------------------------------------------- */

function commandDoctor(deep: boolean): number {
  return withRuntime({ withLog: true, verifyLog: deep ? 'full' : 'tail' }, (runtime) => {
    const checks: Check[] = [];
    const { config } = runtime;

    const node = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
    const major = node[0] ?? 0;
    const minor = node[1] ?? 0;
    const nodeOk =
      major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor);
    checks.push({
      level: nodeOk ? 'ok' : 'fail',
      label: 'node',
      detail: `${process.versions.node} (need >= ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor})`,
    });

    // C0 — target identity. The framework is target-agnostic; identity lives in config, not
    // in code. Doctor reports the registered target and flags the drift the review calls out
    // (a project.id that names a different program than the scanned root).
    const targetName = config.project.name ?? config.project.id;
    const rootBase = config.project.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const idLooksLikeRoot =
      config.project.id.toLowerCase() === rootBase.toLowerCase() ||
      targetName.toLowerCase().replace(/[^a-z0-9]/g, '') === rootBase.toLowerCase().replace(/[^a-z0-9]/g, '');
    checks.push({
      level: 'ok',
      label: 'target identity',
      detail: `${targetName} (id=${config.project.id})`,
    });
    checks.push(
      idLooksLikeRoot
        ? { level: 'ok', label: 'identity ↔ root', detail: `id matches ${rootBase}` }
        : {
            level: 'warn',
            label: 'identity ↔ root',
            detail: `id "${config.project.id}" does not match scanned root "${rootBase}" — register the correct target`,
          },
    );
    checks.push(
      existsSync(config.project.root)
        ? { level: 'ok', label: 'canonical root', detail: config.project.root }
        : { level: 'fail', label: 'canonical root', detail: `missing: ${config.project.root}` },
    );
    checks.push(
      existsSync(join(config.project.root, 'tsconfig.json'))
        ? { level: 'ok', label: 'canonical tsconfig', detail: 'present' }
        : { level: 'fail', label: 'canonical tsconfig', detail: 'absent — recognition cannot run' },
    );
    // DEV-P1-29 / ADR-0005 — target registration.
    //
    // Three facts that were invisible before this item: where a proven improvement is published,
    // and the two governed inputs. Each is reported at the level its state deserves, and the
    // distinction that matters is `null` versus missing. A null input is an installation that has
    // not registered one — informational, and the normal state of a fresh install. A *configured*
    // input that is not on disk is a fault: the operator declared it, so its absence is a broken
    // promise rather than an empty slot, and Status §4.1 classes that as a blocking error.
    const publication = describeTargetPublication(
      config.project.remote,
      config.project.credential_env,
      config.project.remote_decision,
    );
    checks.push(
      publication.decision === 'UNRECORDED'
        ? {
            level: 'warn',
            label: 'target publication',
            detail: `${publication.reason}; record remote_decision in the active target profile`,
          }
        : publication.decision === 'NO_REMOTE_YET'
          ? {
              level: 'ok',
              label: 'target publication',
              detail:
                `${publication.decisionId} · recorded ${publication.recordedAt} by creator · ` +
                'local-only stated absence; DEV-P2-04 closed and publication not permitted',
            }
          : {
              // Safe to print: validation refuses credential-bearing remote forms, so a URL
              // that reached this point cannot contain a secret (Git Integration §5.3).
              level: 'info',
              label: 'target publication',
              detail:
                `${publication.remote} · ${publication.decisionId} · remote identity only; ` +
                'governed Git publication is not implemented or authorized in this build',
            },
    );
    checks.push({
      level: 'info',
      label: 'target credential reference',
      detail:
        publication.credentialEnv === null
          ? 'null — no credential environment-variable name is registered'
          : `${publication.credentialEnv} — environment-variable name only; secret value is never read by doctor`,
    });
    checks.push(...projectInputChecks(config.project.root, config.project.inputs));
    // C0 — document corpus: tracked constitution documents must resolve on disk. Missing ones
    // are honestly surfaced (recognition tolerates them; assessment eventually should not).
    {
      const tracked = config.constitution.tracked_documents;
      // Tracked authority documents live at the CLU-E repository root (as collectDocumentSources reads
      // them), not the target's project root. DEV-P0-13: an absent tracked authority document is a
      // FAIL, not a warning — a mission cannot register without its founding documents on disk, so a
      // green doctor with missing authority files would be a false all-clear.
      const missing = tracked.filter((rel) => !existsSync(join(runtime.repoRoot, rel)));
      checks.push(
        missing.length === 0
          ? { level: 'ok', label: 'tracked documents', detail: `${tracked.length} present` }
          : {
              level: 'fail',
              label: 'tracked documents',
              detail: `${missing.length}/${tracked.length} absent: ${missing.join(', ')} — a mission cannot register without them`,
            },
      );
    }
    // DEV-P2-05 — the installed authority: seal, registration, manifest, ratification state.
    let ratification: RatificationRecord | null | { readonly corrupt: string } = null;
    try {
      ratification = runtime.mission?.ratification() ?? null;
    } catch (error) {
      ratification = { corrupt: error instanceof Error ? error.message : String(error) };
    }
    let epoch: EpochRecord | null | { readonly corrupt: string } = null;
    try {
      epoch = runtime.mission?.latestEpoch() ?? null;
    } catch (error) {
      epoch = { corrupt: error instanceof Error ? error.message : String(error) };
    }
    checks.push(
      ...installedAuthorityChecks(
        runtime.repoRoot,
        config.constitution.tracked_documents,
        ratification,
        epoch,
      ),
    );
    checks.push(
      cycleCheck(
        readCurrentCycle(runtime.projections),
        runtime.log === null ? null : latestClosedCycle(runtime.log),
      ),
    );
    checks.push(
      existsSync(config.shadow.root)
        ? { level: 'ok', label: 'shadow clone', detail: config.shadow.root }
        : { level: 'info', label: 'shadow clone', detail: 'not created yet (Stage F)' },
    );
    checks.push(
      existsSync(config.browser.executable)
        ? { level: 'ok', label: 'chrome', detail: config.browser.executable }
        : { level: 'warn', label: 'chrome', detail: `not found: ${config.browser.executable}` },
    );
    checks.push(checkPowerShell(config.powershell.executable));

    if (runtime.log === null) {
      checks.push({
        level: 'warn',
        label: 'event log',
        detail: runtime.logUnavailable ?? 'unavailable',
      });
    } else {
      const head = runtime.log.getHead();
      const verified = deep ? runtime.log.verify() : null;
      checks.push({
        level: 'ok',
        label: 'event log',
        detail:
          head === null
            ? 'empty'
            : `head ${head.sequence}` +
              (verified === null ? ' (tail verified)' : ` (${verified.records} records verified)`),
      });
      const stale = runtime.projections.isStale(runtime.log);
      checks.push({
        level: stale ? 'warn' : 'ok',
        label: 'projections',
        detail: stale ? 'stale — run `clue init` to resynchronise' : 'in step with the log',
      });
    }

    if (deep) {
      const report = runtime.artifacts.verifyAll();
      const damaged = report.mismatched.length + report.unreadable.length;
      checks.push({
        level: damaged === 0 ? 'ok' : 'fail',
        label: 'artifacts',
        detail: `${report.ok}/${report.checked} verified${damaged === 0 ? '' : `, ${damaged} damaged`}`,
      });
    } else {
      checks.push({ level: 'info', label: 'artifacts', detail: 'run with --deep to re-hash' });
    }

    const mission = runtime.mission?.current() ?? null;
    checks.push(
      mission === null
        ? { level: 'fail', label: 'mission', detail: 'not registered — run `clue init`' }
        : {
            level: 'ok',
            label: 'mission',
            detail: `${mission.id} version ${mission.version}, ${mission.documents.length} documents`,
          },
    );

    if (runtime.claims !== null) {
      const claims = runtime.claims.claims({});
      const conflicts = runtime.claims.conflicts(true);
      const missing = runtime.claims.missingSources(true);
      checks.push({
        level: claims.length === 0 ? 'info' : 'ok',
        label: 'claims',
        detail:
          claims.length === 0 ? 'none ingested — run `clue docs ingest`' : `${claims.length} active`,
      });
      checks.push({
        level: conflicts.length === 0 ? 'ok' : 'warn',
        label: 'conflicts',
        detail: conflicts.length === 0 ? 'none unresolved' : `${conflicts.length} unresolved`,
      });
      checks.push(
        missingSourcesCheck(missing, (target) =>
          existsSync(join(config.project.root, ...target.split('/'))),
        ),
      );
    }

    const snapshot = runtime.snapshots?.latest('canonical') ?? null;
    checks.push(
      snapshot === null
        ? { level: 'info', label: 'snapshot', detail: 'none captured — run `clue snapshot`' }
        : {
            level: 'ok',
            label: 'snapshot',
            detail: `${short(snapshot.id)} · ${snapshot.file_count} files · ${snapshot.captured_at}`,
          },
    );

    if (snapshot !== null && runtime.graph !== null) {
      const recognition = runtime.graph.recognition(snapshot.id);
      checks.push(
        recognition === null
          ? { level: 'info', label: 'recognition', detail: 'not run for this snapshot' }
          : {
              level: recognition.unresolved_count === 0 ? 'ok' : 'warn',
              label: 'recognition',
              detail:
                `${recognition.unit_count} units, ${recognition.edge_count} edges, ` +
                `${recognition.unresolved_count} unresolved`,
            },
      );
    }

    // Zero protected rules while AUTO is on is precisely what
    // `protected_surfaces_verified: false` exists to catch.
    checks.push({
      level: runtime.protectedRuleCount === 0 && config.patching.mode === 'AUTO' ? 'fail' : 'info',
      label: 'protected surfaces',
      detail:
        runtime.protectedRuleCount === 0
          ? 'no rules loaded from patching.yaml'
          : `${runtime.protectedRuleCount} rule(s) in force`,
    });
    checks.push({
      level: 'info',
      label: 'canonical writes',
      detail: config.security.canonical_source_writes,
    });
    checks.push({
      level: config.patching.mode === 'AUTO' ? 'warn' : 'info',
      label: 'patching mode',
      detail:
        config.patching.mode === 'AUTO'
          ? 'AUTO — proven patches land without confirmation'
          : config.patching.mode,
    });

    try {
      const policies = loadGatewayPolicies(runtime.repoRoot, config);
      const assessment = assessGatewayPolicy(config, policies);
      checks.push({
        level: config.gateway.enabled
          ? assessment.operationallyReady
            ? 'ok'
            : 'fail'
          : 'info',
        label: 'gateway',
        detail: config.gateway.enabled
          ? assessment.operationallyReady
            ? `enabled · ${assessment.enabledRouteCount} route(s) · policies ${short(policies.budgetHash)}/${short(policies.routingHash)}`
            : `enabled but not ready — ${assessment.problems.join('; ')}`
          : `implemented, disabled by policy · ${assessment.enabledRouteCount} enabled route(s) · ${assessment.problems.join('; ')}`,
      });
      checks.push({
        level: assessment.apiKeyPresent ? 'ok' : 'info',
        label: 'model key',
        detail: `${config.gateway.api_key_env} ${assessment.apiKeyPresent ? 'present' : 'absent'} (value never displayed)`,
      });
    } catch (error) {
      checks.push({
        level: config.gateway.enabled ? 'fail' : 'warn',
        label: 'gateway policy',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (runtime.queue !== null) {
      const stats = runtime.queue.stats();
      checks.push({
        level: 'info',
        label: 'queue',
        detail:
          `${stats.byState['pending'] ?? 0} pending, ${stats.byState['leased'] ?? 0} leased, ` +
          `${stats.byState['dead'] ?? 0} dead`,
      });
    }

    printChecks(checks);
    return checks.some((check) => check.level === 'fail') ? 1 : 0;
  });
}

function checkPowerShell(executable: string): Check {
  try {
    const result = spawnSync(
      executable,
      ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    if (result.status !== 0) {
      return { level: 'warn', label: 'powershell', detail: `${executable} did not respond` };
    }
    const version = Number.parseInt((result.stdout ?? '').trim(), 10);
    return Number.isSafeInteger(version) && version >= 7
      ? { level: 'ok', label: 'powershell', detail: `version ${version}` }
      : {
          level: 'warn',
          label: 'powershell',
          detail: `version ${(result.stdout ?? '').trim()} (need 7+)`,
        };
  } catch {
    return { level: 'warn', label: 'powershell', detail: `${executable} not available` };
  }
}

/** Registers the `doctor` command. */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('verify configuration, host tools, log integrity, corpus and boundaries')
    .option('--deep', 're-hash every artifact and verify the whole event chain', false)
    .action((options: { deep: boolean }) => {
      process.exitCode = runGuarded(() => commandDoctor(options.deep));
    });
}
