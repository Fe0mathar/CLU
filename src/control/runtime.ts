/**
 * CLUE runtime assembly.
 *
 * Architecture: CLUE_Architecture_v9.md (single-writer daemon; the CLI is a veneer).
 * Execution: CLUE_Execution_Model_v9.md (Stages A–E and G1). Constitution: CLUE_Constitution_v9.md.
 * Backlog: DEV-P0-10 — protected-policy startup gate, true read-only mode, projection-head parity,
 *          and a registered mission required for analysis/orchestration.
 *          DEV-P1-35 — a configured root that is absolute on another platform was resolved as
 *          relative on this one, so the whole workspace silently moved.
 *          DEV-P1-38 — read-only commands took the single-writer lock because the registries
 *          they needed were not built on the read-only path.
 *          DEV-P1-40 — the protected-surface policy path carried the same platform defect, and
 *          there it failed open rather than quiet.
 *          DEV-P1-41 — two notions of "absolute" reduced to one.
 *          DEV-P1-44 — the read-only attach built whichever registries somebody had needed so
 *          far, so a reader that needed another one took the writer lock to reach its own data.
 *
 * Revision 10 (DEV-P1-44) — registry assembly is one construction taking one of two logs, rather
 * than two branches that had drifted apart. The read-only branch grew by discovery — `claims` and
 * `seeds` in revision 6, `metrics` in revision 7, and `queue` was about to be the fourth. A defect
 * that recurs on a schedule is a structural fact rather than four mistakes, so the structure
 * changed. The read/write split is enforced by the log a registry holds; presence was never the
 * mechanism, only an accident of who had asked.
 *
 * Revision 9 (DEV-P1-41) — `foreignAbsoluteForm` no longer carries its own copy of the path
 * grammar. Revisions 5 and 8 fixed the defect by adding a predicate here that matched
 * `schemas.ts`'s rules by hand, which is the arrangement that drifts: neither edit site knows
 * about the other. `absolutePathForm` is now the single implementation, and this file decides
 * only what depends on the host — whether an absolute path is absolute *here*.
 *
 * Revision 8 (DEV-P1-40) — `readProtectedPolicy` resolves through the same guard as the workspace
 * roots. It had its own `isAbsolute` branch, so a Windows policy path on POSIX resolved to a
 * non-existent file — and because *absent* is a legitimate state for this policy, the result was
 * `present: false`: nothing protected, nothing to report, every downstream check passing. Found by
 * following the fix in revision 5 to the other callers of the same pattern rather than stopping at
 * the one the binary happened to hit.
 *
 * Revision 7 (DEV-P1-37 groundwork) — the read-only attach also builds the metric registry, so
 * `clue candidates` can stop attaching as a writer to run a bounded SELECT. Same omission as
 * revision 6, one registry later; the read-only branch has been extended each time a reader
 * turned out to need something, which suggests the branch should mirror the writable one by
 * default rather than by discovery.
 *
 * Revision 6 (DEV-P1-38) — the read-only attach now builds the claim and seed registries as well
 * as snapshot, graph and mission. Their absence was historical: this branch was written for the
 * dashboard, which does not use them. The effect was that three commands declared `mutates:
 * false` had to open with the writer lock to reach their own data, blocking a concurrent
 * `recognize` for want of two constructor calls.
 *
 * Revision 5 (DEV-P1-35) — `resolveConfigPaths` refuses a platform-foreign root instead of
 * joining it to the repository root. The shipped configuration uses Windows drive paths; on a
 * POSIX host every command was opening a brand-new workspace under `<repo>/F:/…` and reporting
 * an empty system, truthfully, about the wrong tree. Found by running the binary — the suite was
 * green throughout, because every test supplies its own roots.
 *
 * Revision 4 (DEV-P0-10) — assembly now fails closed at the boundaries that matter. A malformed or
 * missing protected-surface policy is fatal whenever patching or landing can be enabled, because a
 * patch that runs without the protected matcher could modify a protected surface unchecked. A true
 * read-only mode opens the projections read-only and touches the log not at all, so attaching to a
 * workspace performs no DB write. The projection head is compared to the log head so a stale
 * database is reported rather than silently read. And a command that analyses or orchestrates
 * requires a committed mission, so nothing is produced against no rules.
 *
 * Revision 3 — the console ledger is wired in, together with the pieces needed to build
 * an attributor over a snapshot.
 *
 * One shape decision worth stating, because it looks like an inconsistency until the
 * reason is visible. `Attributor` is synchronous; `BrowserAgent.sourceMapFor` is not.
 * Rather than make the ledger asynchronous — which would spread promises through every
 * synchronous registry it shares a transaction with — capture and attribution are
 * separated in time: entries are collected while the browser runs, source maps are
 * fetched afterwards into a plain map, and a synchronous provider is built from that.
 * `makeAttributor` is the seam. The ledger never learns that a network was involved.
 *
 * One place where the whole system is put together. The CLI calls it, the daemon will
 * call it, the service API will call it, and the self-tests call it. If assembly lived
 * in the CLI, every other surface would either duplicate it or drift from it — and the
 * first symptom of drift is a projector registered in one entry point and missing from
 * another, which produces empty tables rather than an error.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { ArtifactStore } from '../memory/artifactStore.js';
import { EventLog, EventLogError, type VerificationDepth } from '../memory/eventLog.js';
import { ProjectionStore, type WorkspaceIdentityMissingPolicy } from '../memory/db.js';
import { AuditLog, AuditedDispatcher } from './audit.js';
import { BOOTSTRAP_MISSION_ID, MissionRegistry } from './mission.js';
import { PolicyEngine, SecretRegistry, sourceRootOutsideProject } from './policy.js';
import { TASK_PROJECTORS, TaskQueue } from './tasks.js';
import { OutputSchemaRegistry, PACKET_PROJECTORS, SessionPacketService } from './sessionPackets.js';
import { ContextBuilder } from './contextBuilder.js';
import { buildProjectionModules, type ProjectionRehydrators } from './projectionModules.js';
import {
  absolutePathForm,
  assertZonesDisjoint,
  clueConfigSchema,
  ConfigZoneError,
  parseOrThrow,
  type ClueConfig,
  type ProjectProfileRecord,
  targetProfileSchema,
} from '../shared/schemas.js';
import { activeCommandMissionRequirement } from '../shared/commandContext.js';
import type { ProjectOperationIdentity } from '../shared/projectOperationIdentity.js';
import {
  resolveProjectRuntimeBinding,
  type ProjectRuntimeStateBinding,
  type ResolvedProjectRuntimeBinding,
} from './projectProfiles/projectRuntimeBinding.js';
import { ClaimRegistry } from '../analysis/documents/claimRegistry.js';
import { TestSeedRegistry } from '../analysis/documents/testSeeds.js';
import { SnapshotRegistry } from '../analysis/source/snapshot.js';
import { GraphRegistry, type ProtectedMatcher } from '../analysis/source/graph.js';
import { ScanCache } from '../analysis/source/scanCache.js';
import { MetricRegistry } from '../analysis/metrics/registry.js';
import {
  ConsoleLedger,
  NO_ATTRIBUTION,
  type Attributor,
  type IntentionalDeclaration,
} from '../experiment/console/consoleLedger.js';
import { createAttributor, makeUnitLocator, type SourceMapProvider } from '../experiment/console/attribution.js';
import { loadActiveProjectProfileForStartup } from './projectProfiles/projectProfileStartup.js';

/* ------------------------------------------------------------------------- */
/* Workspace layout                                                           */
/* ------------------------------------------------------------------------- */

/** Strategy Part II §5. Created by `clue init`, expected by every later stage. */
export const WORKSPACE_DIRECTORIES = [
  'db',
  'events',
  'blobs',
  'documents',
  'snapshots',
  'graph',
  'coverage',
  'tasks',
  'findings',
  'proof-contracts',
  'patches',
  'implementations',
  'landings',
  'tests',
  'runs',
  'console',
  'environments',
  'ledger',
  'certificates',
  'logs',
  'temp',
] as const;

/**
 * Every projector CLUE knows about now lives in a projection module — see
 * `buildProjectionModules` in ./projectionModules.js. A new stage adds a module there and nowhere
 * else; the kernel task and packet projectors are the only bare projectors the store construction
 * passes directly, because their schemas belong to their own services. Keeping the registry in one
 * place is what prevents the silent failure where an unregistered projector indexes events and
 * projects nothing, returning an empty list from a database that contains everything.
 */

/* ------------------------------------------------------------------------- */
/* Errors                                                                     */
/* ------------------------------------------------------------------------- */

export type RuntimeErrorCode =
  | 'NO_REPO_ROOT'
  | 'NO_CONFIG'
  | 'LOG_LOCKED'
  | 'LOG_REQUIRED'
  | 'PROTECTED_POLICY_MISSING'
  | 'PROTECTED_POLICY_MALFORMED'
  | 'MISSION_REQUIRED'
  | 'PROJECTIONS_STALE'
  /** DEV-P1-35: a configured root is absolute under another platform's rules, not this one's. */
  | 'CONFIG_PATH_FOREIGN'
  /** D1 (2026-08-11): the configuration and a target profile disagree about the target. */
  | 'CONFIG_TARGET_AMBIGUOUS';

export class RuntimeError extends Error {
  public readonly code: RuntimeErrorCode;

  public constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

export interface RuntimeOptions {
  readonly withLog: boolean;
  readonly verifyLog?: VerificationDepth;
  /**
   * Appends between durable full-chain checkpoints for this runtime's writer.
   *
   * Defaults to {@link CHECKPOINT_EVERY_APPENDS}. Pass 0 to disable — a bulk importer
   * that will checkpoint once at the end has a reason to; ordinary commands do not.
   */
  readonly checkpointEveryAppends?: number;
  /** Overrides root discovery. Used by the self-tests. */
  readonly repoRoot?: string;
  /**
   * Explicit durable Project Profile to bind. When absent, the legacy v2 configuration path is
   * retained byte-for-byte. Passing a record is the only Batch-2 cutover seam; applying this patch
   * alone never selects or activates a profile.
   */
  readonly projectProfile?: ProjectProfileRecord;
  /**
   * Missing workspace ownership policy for an explicitly supplied profile. Ordinary opens refuse;
   * project creation and the one legacy migration must opt into their distinct write semantics.
   */
  readonly workspaceIdentityOnMissing?: WorkspaceIdentityMissingPolicy;
  /**
   * Attach read-only: the projections are opened read-only and the event log is not opened at
   * all, so nothing is written to the workspace. Implies no writer. The workspace must already
   * be initialised. Used by the dashboard and any observer that must not perturb the daemon.
   */
  readonly readOnly?: boolean;
  /**
   * Mission gate (DEV-P0-07). When true, `withRuntime` calls `requireMission()` and
   * `requireFreshProjections()` before the command body runs, so a non-bootstrap analysis, task,
   * packet, metric, host, or Git operation cannot emit an event while no committed mission is in
   * force or the projections are stale. Bootstrap and init commands leave it off — they create the
   * mission — as do pure read commands that emit nothing.
   */
  readonly requireMission?: boolean;
}

/**
 * Appends between durable full-chain checkpoints.
 *
 * A checkpoint re-verifies the whole chain, so the value amortises that cost against the
 * event rate. CLUE's event rate is low — registries append per operation, not per unit —
 * so 250 appends is a small multiple of an ordinary command's output while keeping the
 * trust anchor within a bounded distance of the head.
 */
export const CHECKPOINT_EVERY_APPENDS = 250;

/**
 * Heartbeat age after which a lock whose holder cannot be *proven* live may be reclaimed.
 *
 * This only applies where a process start time is unreadable (non-Linux). On a platform
 * that can read one, a same-host PID with a matching start time is never stolen from and
 * a recycled PID is always reclaimed, both regardless of this value. Ten minutes is far
 * longer than any command's lock hold and far shorter than a stale lock's nuisance value.
 */
export const LOCK_STALE_AFTER_MS = 10 * 60 * 1000;

export interface Runtime {
  readonly repoRoot: string;
  readonly config: ClueConfig;
  readonly workspaceRoot: string;
  /** Durable profile and governed identity for a profile-bound runtime; null for legacy runtime. */
  readonly projectProfile: ProjectProfileRecord | null;
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly projectState: ProjectRuntimeStateBinding | null;
  readonly projectBinding: ResolvedProjectRuntimeBinding | null;
  readonly profileMode: 'legacy-v2' | 'project-profile';

  readonly secrets: SecretRegistry;
  readonly policy: PolicyEngine;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  readonly audit: AuditLog;
  readonly dispatcher: AuditedDispatcher;

  readonly log: EventLog | null;
  readonly logUnavailable: string | null;

  readonly mission: MissionRegistry | null;
  readonly claims: ClaimRegistry | null;
  readonly seeds: TestSeedRegistry | null;
  readonly snapshots: SnapshotRegistry | null;
  readonly graph: GraphRegistry | null;
  readonly scanCache: ScanCache | null;
  readonly metrics: MetricRegistry | null;
  readonly queue: TaskQueue | null;
  readonly packets: SessionPacketService | null;
  readonly schemas: OutputSchemaRegistry;
  readonly contextBuilder: ContextBuilder | null;
  /** Query-only ledger. Ingestion uses `makeConsoleLedger` with a real attributor. */
  readonly console: ConsoleLedger | null;

  readonly isProtected: ProtectedMatcher;
  readonly protectedRuleCount: number;
  /** Declared diagnostic surfaces. Empty means nothing is silenced by default. */
  readonly intentionalDeclarations: readonly IntentionalDeclaration[];

  /** Whether this runtime was attached read-only (no workspace writes). */
  readonly readOnly: boolean;
  /**
   * Whether the projections lag or diverge from the log head. `null` when it cannot be
   * determined (a read-only attach does not open the log, so it cannot compare heads).
   */
  readonly projectionsStale: boolean | null;

  /**
   * A ledger that attributes with the supplied function.
   *
   * The registries are thin services over shared storage, so a second instance is not a
   * second source of truth — it is the same tables with a different lens.
   */
  makeConsoleLedger(attributor: Attributor): ConsoleLedger;
  /** Builds an attributor over a snapshot from an already-collected map of source maps. */
  makeAttributor(snapshotId: string, sourceMaps: SourceMapProvider): Attributor;

  requireLog(): EventLog;
  requireClaims(): ClaimRegistry;
  requireGraph(): GraphRegistry;
  requireQueue(): TaskQueue;
  requireConsole(): ConsoleLedger;
  /** The committed mission, or an error — analysis and orchestration must not run without one. */
  requireMission(): MissionRegistry;
  /** Throws if the projections lag or diverge from the log, so a command never reads stale data. */
  requireFreshProjections(): void;
  currentMissionId(): string;
  dispose(): void;
}

/* ------------------------------------------------------------------------- */
/* Discovery and configuration                                                */
/* ------------------------------------------------------------------------- */

/**
 * Walks upward looking for the repository root.
 *
 * The compiled entry point sits at `dist/src/...` and the tsx entry point at `src/...`,
 * so a fixed relative depth works in exactly one of them.
 */
export function findRepoRoot(startFrom?: string): string {
  let current = startFrom ?? dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'config'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new RuntimeError(
    'NO_REPO_ROOT',
    'Could not locate the CLU repository root. Run from inside the repository, or pass repoRoot.',
  );
}

/**
 * Where a target profile lives, given its id (D1, accepted 2026-08-11).
 *
 * Repo-relative and by convention rather than configurable: a profile the configuration
 * could point anywhere would be a second place to look for the first place to look.
 */
export function targetProfilePath(repoRoot: string, id: string): string {
  return join(repoRoot, 'targets', id, 'profile.yaml');
}

/**
 * Resolves the active target profile onto `config.project`, if one is named.
 *
 * **Overlay, not merge.** A profile supplies the whole `project` block except
 * `active_target` itself; it is not a set of overrides sprinkled over config values,
 * because half-and-half provenance is exactly the ambiguity D1 removes. What the
 * configuration keeps is the *choice* of target; what the profile carries is the target.
 *
 * A configuration naming no profile is untouched and stays legal — the single-file form is
 * not deprecated by this, and every existing workspace keeps working. A configuration that
 * names one and *also* fills `project` in place is refused rather than silently preferred:
 * two answers to "what is the target" is the second source of truth the Status contract's
 * §19 forbids, and the same reasoning applies upstream of it.
 */
function resolveActiveProfile(repoRoot: string, raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const project = (raw as Record<string, unknown>)['project'];
  if (typeof project !== 'object' || project === null) return raw;
  const id = (project as Record<string, unknown>)['active_target'];
  if (typeof id !== 'string' || id.trim() === '') return raw;

  const inPlace = [
    'root',
    'source_roots',
    'document_roots',
    'inputs',
    'remote',
    'credential_env',
    'remote_decision',
  ].filter(
    (key) => (project as Record<string, unknown>)[key] !== undefined,
  );
  if (inPlace.length > 0) {
    throw new RuntimeError(
      'CONFIG_TARGET_AMBIGUOUS',
      `project.active_target names "${id}", but project also defines ${inPlace.join(', ')} ` +
        'in place. A target is described by its profile or by the configuration, never both — ' +
        `move those fields into ${join('targets', id, 'profile.yaml')}.`,
    );
  }

  const profilePath = targetProfilePath(repoRoot, id);
  if (!existsSync(profilePath)) {
    throw new RuntimeError(
      'NO_CONFIG',
      `project.active_target names "${id}", but no profile exists at ${profilePath}.`,
    );
  }
  const profile = parseOrThrow(
    targetProfileSchema,
    parseYaml(readFileSync(profilePath, 'utf8')),
    `targets/${id}/profile.yaml`,
  );
  if (profile.id !== id) {
    throw new RuntimeError(
      'CONFIG_TARGET_AMBIGUOUS',
      `targets/${id}/profile.yaml declares id "${profile.id}" — a profile that disagrees ` +
        'with its own location cannot be resolved unambiguously.',
    );
  }
  return {
    ...(raw as Record<string, unknown>),
    project: { ...profile, active_target: id },
  };
}

export function loadLegacyConfig(repoRoot: string): ClueConfig {
  const configPath = join(repoRoot, 'config', 'clue.config.yaml');
  if (!existsSync(configPath)) {
    throw new RuntimeError('NO_CONFIG', `Configuration not found at ${configPath}`);
  }
  const raw: unknown = parseYaml(readFileSync(configPath, 'utf8'));
  return parseOrThrow(
    clueConfigSchema,
    resolveActiveProfile(repoRoot, raw),
    'config/clue.config.yaml',
  );
}


/**
 * Loads the effective configuration for readers that do not assemble a Runtime themselves.
 * Legacy-v2 remains the default. When the explicit Configuration-v3 selector exists, target-
 * specific values are projected from the registry's exact active Project Profile generation.
 */
export function loadConfig(repoRoot: string): ClueConfig {
  const installationConfig = loadLegacyConfig(repoRoot);
  const startup = loadActiveProjectProfileForStartup(repoRoot);
  return startup === null
    ? installationConfig
    : resolveProjectRuntimeBinding(installationConfig, startup.record).config;
}

/**
 * Names the platform whose rules make a path absolute, when it is not this one's.
 *
 * DEV-P1-35 found the defect: `node:path`'s `isAbsolute` answers for the *running* platform,
 * which is the right question for resolving a path and the wrong one for judging it. On Linux
 * `isAbsolute('F:/CLU')` is `false` — not "absolute elsewhere", simply false — so the caller
 * below treated a Windows drive path as relative and joined it to the repository root.
 *
 * DEV-P1-41 removed the duplication that fix introduced. This used to carry its own three
 * regexes, written to match `schemas.ts`'s rules by hand. `absolutePathForm` is now the single
 * implementation, and this function does nothing but decide *foreignness* — absolute somewhere,
 * not absolute here — and pick the wording.
 *
 * The distinction is worth keeping separate from the classification, because foreignness is the
 * only part that depends on the host. The same string is a foreign absolute on Linux and a
 * perfectly ordinary one on Windows, and the asymmetry runs one way in practice: Windows accepts
 * a POSIX-rooted path as absolute, so it is POSIX hosts that silently mis-resolve Windows
 * configuration and never the reverse.
 */
function foreignAbsoluteForm(value: string): string | null {
  if (isAbsolute(value)) return null;

  const form = absolutePathForm(value);
  if (form === null) return null;

  switch (form) {
    case 'windows-drive':
      return 'a Windows drive-letter path';
    case 'windows-unc':
      return 'a Windows UNC path';
    case 'windows-rooted':
      return 'a Windows root-relative path';
    case 'posix-root':
      // Absolute under POSIX rules but not under this host's — so this host is Windows, and the
      // path is a rooted POSIX path. Windows' own `isAbsolute` accepts those, so this branch is
      // unreachable today. It is written out rather than folded into a default because the
      // exhaustive switch is what makes a future `AbsolutePathForm` member a compile error here
      // instead of a silently unhandled case.
      return 'a POSIX rooted path';
    default:
      return null;
  }
}

/**
 * Resolves one configured path, refusing anything absolute under another platform's rules.
 *
 * DEV-P1-35 introduced this check for the four workspace roots. DEV-P1-40 extracted it here
 * because `readProtectedPolicy` resolved its own path with a bare `isAbsolute` and inherited the
 * whole defect — see the note there for why that instance was the worse of the two.
 *
 * `label` is the configuration key as an operator would find it in the file. An error that says
 * "a path is wrong" and not *which* path sends someone reading YAML by hand.
 */
function resolveConfiguredPath(label: string, value: string, repoRoot: string): string {
  const foreign = foreignAbsoluteForm(value);
  if (foreign !== null) {
    throw new RuntimeError(
      'CONFIG_PATH_FOREIGN',
      `config/clue.config.yaml: ${label} is ${foreign} ("${value}"), which is not absolute on ` +
        `${process.platform}. Resolving it here would silently create ` +
        `${resolve(repoRoot, value)} instead of using the configured location. Set ${label} to ` +
        `a path absolute on this host, or to one relative to the repository root.`,
    );
  }
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

/**
 * Resolves every configured root to an absolute path.
 *
 * The policy engine compares path prefixes, so a relative root would classify everything
 * as `external` and deny it — a failure that looks like a permissions bug and is really
 * a path bug.
 *
 * ## DEV-P1-35 — why a foreign root is fatal rather than resolved
 *
 * A root that is absolute on another platform used to fall through to the relative branch and be
 * joined to the repository root. Nothing failed. `workspace.root: "F:/CLU/workspace/clue"` on a
 * Linux host produced `<repo>/F:/CLU/workspace/clue`, and CLU-E created a directory literally
 * named `F:` inside its own source tree and opened a **new, empty** event log, blob store and
 * projection database in it.
 *
 * That is the worst available outcome. The event log is where truth lives — the projections are
 * rebuildable and the database holds none of it — so a silently relocated workspace does not
 * degrade the system, it forks it: evidence accumulates in a tree nobody configured while the
 * configured one sits untouched, and the operator's only symptom is a workspace that reports no
 * mission, no snapshots and no claims. Every one of those readings is *true* of the tree being
 * read, which is what makes the failure so quiet.
 *
 * The alternative to refusing is guessing, and there is nothing to guess from: `F:` names a
 * volume this host does not have and cannot be mapped to one that it does. So the command fails
 * closed, names the offending key, prints the path that would otherwise have been created, and
 * stops. A configuration written for another machine is not this machine's to interpret.
 *
 * This is deliberately *not* a schema error. The file is well-formed and correct on the host it
 * was written for; the same bytes are valid on Windows and unusable here. Portability of a path
 * is a fact about the running host, so it is checked where the host is known rather than at
 * parse time.
 *
 * Note that `project.source_roots`, `project.document_roots`, `constitution.file` and
 * `constitution.tracked_documents` need no check here: they are `relativePathSchema`, whose
 * `isAbsolutePath` already understands drive letters and rejects them at parse time. The four
 * roots below and `patching.policy_file` are `pathSchema` — a non-empty string — which is why
 * they are the ones that could go wrong.
 */
export function resolveConfigPaths(config: ClueConfig, repoRoot: string): ClueConfig {
  const absolute = (label: string, value: string): string =>
    resolveConfiguredPath(label, value, repoRoot);
  const project = normalizeTargetIdentity(config.project);

  const resolved: ClueConfig = {
    ...config,
    project: { ...project, root: absolute('project.root', project.root) },
    shadow: { ...config.shadow, root: absolute('shadow.root', config.shadow.root) },
    workspace: { root: absolute('workspace.root', config.workspace.root) },
    browser: {
      ...config.browser,
      profile_dir: absolute('browser.profile_dir', config.browser.profile_dir),
    },
  };

  // DEV-P0-08: the operating zones must be validated as disjoint on their RESOLVED absolute paths,
  // not the raw YAML. A relative workspace like "workspace" resolves against the installation root and
  // can land inside project.root — an overlap the parse-time check on raw strings cannot see. Fail
  // closed here so no runtime ever opens with a workspace nested in the canonical source.
  assertZonesDisjoint(resolved);

  // DEV-P0-08: a source root must physically resolve inside the project tree. A `..` segment or a
  // symlink pointing out of the project would otherwise let the scanner recognise, snapshot, and
  // eventually patch files outside the target program. Fail closed here, before any scan.
  const escape = sourceRootOutsideProject(resolved.project.root, resolved.project.source_roots);
  if (escape !== null) throw new ConfigZoneError(escape);

  return resolved;
}

/**
 * C0 — truthful target identity (review §3.2). The scanned root is the ground truth for
 * WHICH program is the target; the framework itself is target-agnostic. When the configured
 * id/name disagree with the root basename — the internal contradiction the review flags
 * (`id: murugan` while `root: .../CLU`) — identity is derived from the root so the graph,
 * status, Great Book, and benchmarks all name the program actually being assessed. An id
 * that already matches the root is respected untouched; an explicit `name` is always kept.
 * The correction is announced once on stderr rather than applied silently.
 */
function normalizeTargetIdentity(project: ClueConfig['project']): ClueConfig['project'] {
  const base = project.root.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? '';
  if (base.length === 0) return project;
  const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/gu, '');
  const derivedId = base.toLowerCase();
  if (norm(project.id) === norm(base)) return project; // id already names the root
  const corrected = { ...project, id: derivedId, name: project.name ?? base };
  process.stderr.write(
    `identity: config id "${project.id}" does not match target root "${base}"; ` +
      `using derived target id "${derivedId}" (name "${corrected.name}"). ` +
      `Set project.id/name in config to silence this.\n`,
  );
  return corrected;
}

export function createWorkspaceLayout(workspaceRoot: string): void {
  for (const directory of WORKSPACE_DIRECTORIES) {
    mkdirSync(join(workspaceRoot, directory), { recursive: true });
  }
}

/* ------------------------------------------------------------------------- */
/* Protected surfaces                                                         */
/* ------------------------------------------------------------------------- */

interface ProtectedRule {
  readonly id: string;
  readonly reason: string;
  readonly identifiers: readonly string[];
  readonly pathPatterns: readonly RegExp[];
}

/** The state of the protected-surface policy on disk, distinguishing absent from malformed. */
interface ProtectedPolicyState {
  readonly present: boolean;
  readonly malformed: boolean;
  readonly rules: ProtectedRule[];
}

/**
 * Reads the protected-surface policy and reports its state.
 *
 * Absent and malformed are different facts: a missing policy may be a deliberate choice when
 * nothing can mutate the canonical tree, but a policy that exists and cannot be parsed is a defect
 * whatever the mode. Only `identifiers` and `path_globs` are honoured; `file_contains` needs the
 * file's text and belongs in a snapshot-time pass, so it is deliberately not faked here.
 *
 * ## DEV-P1-40 — this was the dangerous instance of DEV-P1-35, and it failed open
 *
 * The path was resolved with a bare `isAbsolute`, so `patching.policy_file: "F:/CLU/policies.yaml"`
 * on a POSIX host became `<repo>/F:/CLU/policies.yaml` — a path that does not exist.
 *
 * The workspace case was quiet. This one was worse, because of the line immediately below:
 * absence is a **legitimate** state here, so a policy that could not be found reported
 * `present: false, rules: []` — indistinguishable from a deliberate declaration that nothing is
 * protected. The file that governs what CLU-E may modify without a human present evaluated to
 * "nothing is protected", and every check downstream passed.
 *
 * That is a fail-open on the one surface where DEV-P0-10 chose fail-closed everywhere else: a
 * *malformed* policy blocks a patch-capable startup, while an *unfindable* one waved it through.
 * Resolving through `resolveConfiguredPath` makes the unfindable case a refusal at attach, before
 * the absent/malformed distinction is ever reached.
 *
 * What is still not covered: a policy path that is portable and simply wrong — a typo naming a
 * file that does not exist — remains `present: false`. Distinguishing "configured but missing"
 * from "not configured" needs a schema change (a nullable `policy_file`), which is the Creator's,
 * not this function's.
 */
export function readProtectedPolicy(repoRoot: string, config: ClueConfig): ProtectedPolicyState {
  const policyPath = resolveConfiguredPath('patching.policy_file', config.patching.policy_file, repoRoot);

  if (!existsSync(policyPath)) return { present: false, malformed: false, rules: [] };

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(policyPath, 'utf8'));
  } catch {
    return { present: true, malformed: true, rules: [] };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { present: true, malformed: true, rules: [] };
  }
  const surfaces = (parsed as Record<string, unknown>)['protected_surfaces'];
  // A policy that declares no surfaces is valid and empty; a surfaces key of the wrong shape is a
  // defect. Absence of the key is treated as "nothing declared", not malformed.
  if (surfaces === undefined) return { present: true, malformed: false, rules: [] };
  if (!Array.isArray(surfaces)) return { present: true, malformed: true, rules: [] };

  const malformed = (): ProtectedPolicyState => ({ present: true, malformed: true, rules: [] });

  const rules: ProtectedRule[] = [];
  for (const entry of surfaces) {
    // DEV-P0-10: a defective entry must block, not disappear. Silently skipping a malformed rule would
    // leave the surface it was meant to protect unguarded while the policy still reported healthy — so
    // any entry that is not a well-formed, actually-matching rule marks the whole policy malformed,
    // which stops a patch-capable startup.
    if (typeof entry !== 'object' || entry === null) return malformed();
    const record = entry as Record<string, unknown>;
    const match = record['match'];
    if (typeof match !== 'object' || match === null) return malformed();
    const matcher = match as Record<string, unknown>;

    const identifiers = readStringArray(matcher['identifiers']).map((value) => value.toLowerCase());
    const pathGlobs = readStringArray(matcher['path_globs']);
    const fileContains = readStringArray(matcher['file_contains']);
    // A rule must carry at least one matcher of some kind. identifiers and path_globs are enforced here;
    // file_contains is a legitimate matcher too, but it needs the file's text and is enforced in the
    // snapshot-time pass (this reader deliberately does not fake it). So an entry that carries ONLY
    // file_contains is well-formed — it is not "matches nothing" — and simply contributes no startup
    // rule; only an entry with no matcher at all is the defect this gate must catch.
    if (identifiers.length === 0 && pathGlobs.length === 0 && fileContains.length === 0) return malformed();
    if (identifiers.length === 0 && pathGlobs.length === 0) continue;

    rules.push({
      id: typeof record['id'] === 'string' ? record['id'] : 'unnamed',
      reason: typeof record['reason'] === 'string' ? record['reason'].trim() : 'declared protected',
      identifiers,
      pathPatterns: pathGlobs.map(globToRegExp),
    });
  }
  return { present: true, malformed: false, rules };
}

/** Builds the protected-surface matcher from policy. */
export function loadProtectedRules(repoRoot: string, config: ClueConfig): ProtectedRule[] {
  return readProtectedPolicy(repoRoot, config).rules;
}

/**
 * Whether a patch could ever change the canonical tree in this configuration.
 *
 * Landing under amendment A2 (`canonical_source_writes: custodian_only`) is the one authorised
 * mutation, and AUTO patching applies patches without a human in the loop. Either means the
 * protected-surface policy is load-bearing, so a missing or malformed one must stop startup.
 */
export function landingOrPatchingEnabled(config: ClueConfig): boolean {
  return (
    config.security.canonical_source_writes === 'custodian_only' || config.patching.mode === 'AUTO'
  );
}

export function makeProtectedMatcher(rules: readonly ProtectedRule[]): ProtectedMatcher {
  if (rules.length === 0) return () => null;

  return (unit) => {
    const name = unit.name.toLowerCase();
    const logical = unit.logicalId.toLowerCase();
    const path = unit.modulePath.toLowerCase();

    for (const rule of rules) {
      for (const identifier of rule.identifiers) {
        if (name.includes(identifier) || logical.includes(identifier)) {
          return `${rule.id}: ${rule.reason}`;
        }
      }
      for (const pattern of rule.pathPatterns) {
        if (pattern.test(path)) return `${rule.id}: ${rule.reason}`;
      }
    }
    return null;
  };
}

/* ------------------------------------------------------------------------- */
/* Declared diagnostics                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Loads the declarations that move console output to `intentional`.
 *
 * Read from `config/policies/console.yaml`. **Absent means nothing is silenced**, and
 * that is the correct default: an entry is excluded from the clean-console criterion
 * only by a recorded decision, never because a pattern happened to match something CLUE
 * guessed was a diagnostic. FrameDoctor and the HUD are supposed to speak; declaring
 * them is the Creator's act, not an inference.
 *
 * A YAML entry looks like:
 *
 *     intentional:
 *       - id: framedoctor
 *         reason: FrameDoctor reports frame timing by design
 *         text_prefixes: ["[FrameDoctor]"]
 *         unit_patterns: ["probes/"]
 */
export function loadIntentionalDeclarations(repoRoot: string): IntentionalDeclaration[] {
  const policyPath = join(repoRoot, 'config', 'policies', 'console.yaml');
  if (!existsSync(policyPath)) return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(policyPath, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];

  const entries = (parsed as Record<string, unknown>)['intentional'];
  if (!Array.isArray(entries)) return [];

  const declarations: IntentionalDeclaration[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const id = typeof record['id'] === 'string' ? record['id'] : null;
    const reason = typeof record['reason'] === 'string' ? record['reason'].trim() : null;
    // A declaration without a stated reason is a silencer, not a decision. Refused.
    if (id === null || reason === null || reason.length === 0) continue;

    declarations.push({
      id,
      reason,
      textPrefixes: readStringArray(record['text_prefixes']),
      textPatterns: readStringArray(record['text_patterns']).map((value) => safeRegExp(value)),
      unitPatterns: readStringArray(record['unit_patterns']).map((value) => safeRegExp(value)),
    });
  }
  return declarations;
}

function safeRegExp(source: string): RegExp {
  try {
    return new RegExp(source, 'i');
  } catch {
    // An unparseable pattern matches nothing rather than throwing at startup; the
    // declaration count reported by `clue doctor` is how it becomes visible.
    return /$^/;
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Minimal glob support: `**` crosses separators, `*` does not. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/* ------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Builds the runtime.
 *
 * Order matters in two places. Projection schemas are ensured before anything can call
 * `sync`, because replaying an event against a database without its table fails at
 * exactly the moment recovery is most needed. And the event log is opened last, so a
 * lock held by another writer leaves a usable read-only runtime rather than an exception.
 */
export function openRuntime(options: RuntimeOptions): Runtime {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const installationConfig = loadLegacyConfig(repoRoot);
  const startup =
    options.projectProfile === undefined
      ? loadActiveProjectProfileForStartup(repoRoot)
      : null;
  const selectedProfile = options.projectProfile ?? startup?.record ?? null;
  const projectBinding =
    selectedProfile === null
      ? null
      : resolveProjectRuntimeBinding(installationConfig, selectedProfile);
  const config = resolveConfigPaths(projectBinding?.config ?? installationConfig, repoRoot);
  const workspaceRoot = config.workspace.root;
  const projectIdentity = projectBinding?.identity ?? null;
  const projectState = projectBinding?.state ?? null;
  const readOnly = options.readOnly ?? false;
  // DEV-P0-10 (no mutable observer paths): the store is writable ONLY when this runtime holds the
  // single writer — `withLog` and not an explicit read-only attach. Every other runtime, including a
  // command opened without the writer (`withLog: false`), opens projections, artifacts, and audit
  // READ-ONLY. Before this, a `withLog: false` observer left the store writable, so it could mutate a
  // projection, artifact, or audit row directly — bypassing the event log that authorises the change.
  // The registries below still receive a stand-in log that throws on any write; this closes the second
  // half of the same hole, the store itself.
  const holdsWriter = options.withLog && !readOnly;
  const storeReadOnly = !holdsWriter;

  const secrets = new SecretRegistry();
  secrets.loadFromConfig(config);

  const policy = new PolicyEngine(config, secrets);

  // The protected-surface policy is load-bearing the moment a patch could change the canonical
  // tree. If it is missing or malformed while patching or landing can be enabled, refuse to start:
  // running with an empty matcher would let a patch modify a protected surface unchecked, which is
  // exactly the outcome the policy exists to prevent. This is checked before any resource is
  // opened, so a refusal costs nothing and holds no lock.
  const protectedPolicy = readProtectedPolicy(repoRoot, config);
  if (landingOrPatchingEnabled(config)) {
    if (!protectedPolicy.present) {
      throw new RuntimeError(
        'PROTECTED_POLICY_MISSING',
        `Patching or landing can be enabled (canonical_source_writes=${config.security.canonical_source_writes}, ` +
          `patching.mode=${config.patching.mode}), but the protected-surface policy ` +
          `${config.patching.policy_file} is missing. Refusing to start.`,
      );
    }
    if (protectedPolicy.malformed) {
      throw new RuntimeError(
        'PROTECTED_POLICY_MALFORMED',
        `The protected-surface policy ${config.patching.policy_file} is malformed. ` +
          'Refusing to start while patching or landing can be enabled.',
      );
    }
  }

  // DEV-P0-01: the store is built from registered projection modules, not a bare projector map.
  // Each module owns its schema (installed here for a writable store), its projectors, and — for the
  // graph and metric surfaces — a rehydrate hook wired below, so a full rebuild restores every table.
  // The kernel task and packet projectors ride as bare projectors: their schemas belong to their own
  // services (TaskQueue / SessionPacketService), which install them when constructed.
  const rehydrators: ProjectionRehydrators = {};
  const databasePath = projectState?.databasePath ?? join(workspaceRoot, 'db', 'clue.db');
  const eventLogRoot = projectState?.eventLogRoot ?? join(workspaceRoot, 'events');
  const artifactStoreRoot = projectState?.artifactStoreRoot ?? join(workspaceRoot, 'blobs');

  const projections = new ProjectionStore(databasePath, {
    modules: buildProjectionModules(rehydrators),
    projectors: { ...TASK_PROJECTORS, ...PACKET_PROJECTORS },
    rehydrateKernel: () => {
      rehydrators.audit?.();
    },
    readOnly: storeReadOnly,
    ...(projectBinding === null
      ? {}
      : {
          workspaceIdentity: {
            expected: projectBinding.workspaceIdentity,
            onMissing: options.workspaceIdentityOnMissing ?? 'reject',
          },
        }),
  });

  const artifacts = new ArtifactStore(artifactStoreRoot, {
    readOnly: storeReadOnly,
    ...(projectIdentity === null ? {} : { projectIdentity }),
  });
  const audit = new AuditLog(join(workspaceRoot, 'logs'), projections, secrets, { readOnly: storeReadOnly });

  const protectedRules = protectedPolicy.rules;
  const isProtected = makeProtectedMatcher(protectedRules);
  const intentionalDeclarations = loadIntentionalDeclarations(repoRoot);
  const schemas = new OutputSchemaRegistry();

  let log: EventLog | null = null;
  let logUnavailable: string | null = null;

  // A read-only attach never opens the log: it must not hold the single-writer lock, and it must
  // not create the events file. It reads projections and reports; it does not record.
  if (options.withLog && !readOnly) {
    try {
      const opened = EventLog.open(eventLogRoot, {
        verifyOnOpen: options.verifyLog ?? 'tail',
        // DEV-P1-01 follow-up: the event log's seventh guarantee — a committed head found
        // behind a durable checkpoint is refused as lost history — needs a checkpoint to
        // exist. The mechanism was implemented and proven, but every production open used
        // the default of 0, so no checkpoint was ever written and the protection had
        // nothing to compare against. It is now on by default for every writer.
        checkpointEveryAppends: options.checkpointEveryAppends ?? CHECKPOINT_EVERY_APPENDS,
        // Likewise, the heartbeat-age fallback used when a holder's liveness cannot be
        // proven (no readable process start time, e.g. Windows) was unreachable at the
        // default of Infinity. A bounded window makes it reachable there, while a
        // same-host PID whose start time *can* be read is still never stolen from.
        lockStaleAfterMs: LOCK_STALE_AFTER_MS,
        ...(projectIdentity === null ? {} : { projectIdentity }),
      });
      log = opened.log;
    } catch (error) {
      // DEV-P0-10: `withLog: true` means the writer was acquired, or the command body never begins.
      // A held writer lock is not a reason to silently fall back to read-only and let the callback run
      // (it would do reads and side effects, then fail only at the first durable write). Refuse to
      // construct instead, so the caller either gets a writer or gets nothing.
      projections.close();
      if (error instanceof EventLogError && error.code === 'LOCKED') {
        throw new RuntimeError(
          'LOG_LOCKED',
          `A writable runtime was requested but the event-log writer is held elsewhere: ${error.message}. ` +
            'Refusing to begin without it.',
        );
      }
      throw error;
    }
  } else {
    logUnavailable = readOnly
      ? 'runtime attached read-only'
      : 'runtime opened without a writer';
  }

  let mission: MissionRegistry | null = null;
  let claims: ClaimRegistry | null = null;
  let seeds: TestSeedRegistry | null = null;
  let snapshots: SnapshotRegistry | null = null;
  let graph: GraphRegistry | null = null;
  let scanCache: ScanCache | null = null;
  let metrics: MetricRegistry | null = null;
  let queue: TaskQueue | null = null;
  let packets: SessionPacketService | null = null;
  let contextBuilder: ContextBuilder | null = null;
  let consoleLedger: ConsoleLedger | null = null;

  const currentMissionId = (): string => mission?.currentId() ?? BOOTSTRAP_MISSION_ID;

  const dispatcher = new AuditedDispatcher(policy, audit, currentMissionId);

  /*
   * Registry assembly — ONE construction, two logs.
   *
   * DEV-P1-44. This used to be two branches: a writable one that built every registry, and a
   * read-only one that built whichever ones somebody had needed so far. The second was written
   * for the dashboard, which wants snapshot, graph and mission, and it grew by discovery — a
   * reader would turn out to need a registry, find `null`, and the only way to reach its own data
   * was to take the single-writer lock.
   *
   * That happened four times: `claims` and `seeds` (revision 6), `metrics` (revision 7), and
   * `queue` — `clue task list` and `clue task show` are declared read-only and take the writer
   * today for exactly this reason. Revision 7's header said the branch "should probably mirror
   * the writable one by default rather than by discovery". This is that change; a defect that
   * recurs on a schedule is a structural fact, not four mistakes.
   *
   * ## Why one construction is safe
   *
   * Nothing here consults the log while constructing. Every registry stores it and reaches for it
   * only on a write, which is why the read-only branch could already build `MissionRegistry`,
   * `SnapshotRegistry` and `GraphRegistry` with a stand-in that throws on any property access.
   * The stand-in is unchanged and now covers all of them: a durable write attempted through a
   * read-only runtime throws where it is attempted rather than succeeding quietly.
   *
   * ## What this does NOT change
   *
   * The read/write split is enforced by the log a registry holds, never by which registries
   * exist. Presence was only ever an accident of who had asked. `withLog: false` still opens the
   * projections `readonly: true` and the artifact store refusing, so the guarantee is now three
   * deep — database, store, and log stand-in — instead of resting on absence.
   */
  const registryLog: EventLog =
    log ??
    (new Proxy(
      {},
      {
        get(): never {
          throw new Error(
            'This runtime is read-only (withLog: false); durable writes require the event-log writer.',
          );
        },
      },
    ) as unknown as EventLog);
  const missionVersion = currentMissionId;

  mission = new MissionRegistry({
    repoRoot,
    config,
    log: registryLog,
    projections,
    artifacts,
    ...(projectBinding === null ? {} : { projectBinding }),
  });
  claims = new ClaimRegistry({ log: registryLog, projections, artifacts, missionVersion });
  seeds = new TestSeedRegistry({ log: registryLog, projections, missionVersion });
  snapshots = new SnapshotRegistry({ log: registryLog, projections, artifacts, missionVersion });
  graph = new GraphRegistry({
    log: registryLog,
    projections,
    artifacts,
    missionVersion,
    isProtected,
  });
  scanCache = new ScanCache({ log: registryLog, projections, artifacts, missionVersion });
  metrics = new MetricRegistry({ log: registryLog, projections, artifacts, missionVersion });
  queue = new TaskQueue({ log: registryLog, projections, missionVersion });
  packets = new SessionPacketService({
    log: registryLog,
    projections,
    artifacts,
    queue,
    schemas,
    secrets,
    missionVersion,
    tokenBudget: config.analysis.max_context_tokens - config.analysis.reserve_output_tokens,
  });
  contextBuilder = new ContextBuilder({
    projectRoot: config.project.root,
    mission,
    graph,
    claims,
    snapshots,
    tokenBudget: config.analysis.max_context_tokens - config.analysis.reserve_output_tokens,
  });
  // Query lens. Without an attributor it would classify everything as unattributable,
  // which is why ingestion always goes through `makeConsoleLedger` instead.
  consoleLedger = new ConsoleLedger({
    log: registryLog,
    projections,
    artifacts,
    missionVersion,
    attributor: NO_ATTRIBUTION,
    intentional: intentionalDeclarations,
  });


  // Now that the registries exist, point the projection modules' rehydrate hooks at them. On a
  // rebuild, `ProjectionStore.rebuild()` replays events (restoring the summary receipts) and then
  // calls these, which rehydrate the artifact-backed bulk tables from the stored recognition and
  // metric artifacts. A read-only attach leaves `metrics` null and never rebuilds, so its unset hook
  // is inert.
  rehydrators.graph = () => {
    graph?.rehydrateAll();
  };
  rehydrators.metrics = () => {
    metrics?.rehydrateAll();
  };
  rehydrators.snapshots = () => {
    snapshots?.rehydrateAll();
  };
  rehydrators.audit = () => {
    audit.reindex();
  };

  const requireWithLog = <T>(value: T | null, what: string): T => {
    if (value === null) {
      throw new RuntimeError(
        'LOG_REQUIRED',
        `This command needs ${what}, which needs a writable event log: ${
          logUnavailable ?? 'unknown reason'
        }`,
      );
    }
    return value;
  };

  // Projection-head parity: the projections are compared to the log head, so a database that lags or
  // diverges is reported rather than silently read. DEV-P0-10: a read-only attach holds no writer log,
  // but it still proves staleness by reading the log head WITHOUT the lock and comparing heads — so it
  // never reports a stale projection as healthy by implication. If the log cannot be read, it does not
  // imply health: it reports stale so a read requiring fresh projections refuses.
  //
  // This is evaluated on demand, not cached: a runtime that stays open must notice the log advancing
  // beneath it, so `requireFreshProjections` re-checks every time rather than trusting a startup value.
  const computeStaleness = (): boolean | null => {
    if (readOnly) {
      try {
        return projections.isStaleAgainst(EventLog.readHead(eventLogRoot));
      } catch {
        return true;
      }
    }
    return log === null ? null : projections.isStale(log);
  };

  // A construction-time snapshot, exposed for diagnostics; the freshness gate re-checks live.
  const projectionsStale: boolean | null = computeStaleness();

  return {
    repoRoot,
    config,
    workspaceRoot,
    projectProfile: projectBinding?.record ?? null,
    projectIdentity,
    projectState,
    projectBinding,
    profileMode: projectBinding === null ? 'legacy-v2' : 'project-profile',
    secrets,
    policy,
    projections,
    artifacts,
    audit,
    dispatcher,
    log,
    logUnavailable,
    mission,
    claims,
    seeds,
    snapshots,
    graph,
    scanCache,
    metrics,
    queue,
    packets,
    schemas,
    contextBuilder,
    console: consoleLedger,
    isProtected,
    protectedRuleCount: protectedRules.length,
    intentionalDeclarations,
    readOnly: storeReadOnly,
    projectionsStale,

    makeConsoleLedger(attributor: Attributor): ConsoleLedger {
      const writableLog = requireWithLog(log, 'the console ledger');
      return new ConsoleLedger({
        log: writableLog,
        projections,
        artifacts,
        missionVersion: currentMissionId,
        attributor,
        intentional: intentionalDeclarations,
      });
    },

    makeAttributor(snapshotId: string, sourceMaps: SourceMapProvider): Attributor {
      const registry = requireWithLog(snapshots, 'the snapshot registry');
      return createAttributor({
        snapshotPaths: registry.files(snapshotId).map((file) => file.path),
        locateUnit: makeUnitLocator(projections, snapshotId),
        sourceMaps,
      });
    },

    requireLog: () => requireWithLog(log, 'the event log'),
    requireClaims: () => requireWithLog(claims, 'the claim registry'),
    requireGraph: () => requireWithLog(graph, 'the unit graph'),
    requireQueue: () => requireWithLog(queue, 'the task queue'),
    requireConsole: () => requireWithLog(consoleLedger, 'the console ledger'),

    requireMission(): MissionRegistry {
      const registry = mission;
      if (registry === null) {
        throw new RuntimeError(
          'MISSION_REQUIRED',
          `Analysis and orchestration need a mission registry: ${logUnavailable ?? 'unavailable'}`,
        );
      }
      // DEV-P0-07/P0-10: require not just that a mission exists, but that the governed inputs on disk
      // still match the committed basis. Rechecking drift at command entry means a writable command
      // never produces evidence under a mission whose founding documents changed after registration;
      // the fix for drift is to register a successor (bootstrap).
      registry.requireCurrentBasis();
      return registry;
    },

    requireFreshProjections(): void {
      // DEV-P0-10: re-check the projection head against the log on every call. A stable double-read
      // guards the race where the head advances mid-check: only a reading that is stale on two
      // consecutive head reads is trusted as stale, and a head that moved between them is itself proof
      // the projections are behind.
      const first = computeStaleness();
      const stale = first === true ? true : computeStaleness() === true;
      if (stale) {
        throw new RuntimeError(
          'PROJECTIONS_STALE',
          'Projections lag or diverge from the event log; sync before reading, or the answer ' +
            'would describe a head the log no longer contains.',
        );
      }
    },

    currentMissionId,


    dispose(): void {
      log?.close();
      projections.close();
    },
  };
}

/**
 * Opens a runtime, runs `work`, and always disposes.
 *
 * Leaking the event-log lock turns a crashed command into a system that refuses to
 * start, and it is exactly the mistake a forgotten `finally` produces.
 */
export function withRuntime<T>(options: RuntimeOptions, work: (runtime: Runtime) => T): T {
  const runtime = openRuntime(options);
  try {
    // DEV-P1-36 flip (cycle plan D4, 2026-08-10): the command-authority declaration is now
    // consumed. An explicit option keeps its word; silence defaults to what the dispatched
    // command declared; callers outside a CLI dispatch (daemon, tests, scripts) see null
    // and behave exactly as before the flip.
    if (options.requireMission ?? activeCommandMissionRequirement() ?? false) {
      // Gate before the command body: no committed mission (or stale projections) means no
      // authoritative event may be written under it.
      runtime.requireMission();
      runtime.requireFreshProjections();
    }
    return work(runtime);
  } finally {
    runtime.dispose();
  }
}

/** Explicit convenience surface for callers that have already resolved a durable profile record. */
export function openProjectRuntime(
  projectProfile: ProjectProfileRecord,
  options: Omit<RuntimeOptions, 'projectProfile'>,
): Runtime {
  return openRuntime({ ...options, projectProfile });
}

/**
 * Asynchronous form, for commands that talk to a browser.
 *
 * Separate rather than making `withRuntime` generic over both, because a synchronous
 * caller accidentally receiving a promise would dispose the runtime — and release the
 * event-log lock — while the work was still running.
 */
export async function withRuntimeAsync<T>(
  options: RuntimeOptions,
  work: (runtime: Runtime) => Promise<T>,
): Promise<T> {
  const runtime = openRuntime(options);
  try {
    // DEV-P1-36 flip: same default as the synchronous form — declaration fills silence.
    if (options.requireMission ?? activeCommandMissionRequirement() ?? false) {
      runtime.requireMission();
      runtime.requireFreshProjections();
    }
    return await work(runtime);
  } finally {
    runtime.dispose();
  }
}

/* ------------------------------------------------------------------------- */
/* Document set                                                               */
/* ------------------------------------------------------------------------- */

export interface DocumentSource {
  readonly path: string;
  readonly absolutePath: string;
  readonly origin: 'founding' | 'project';
}

const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown']);
const MAX_DOCUMENT_DEPTH = 6;

/**
 * The documents CLUE treats as the corpus.
 *
 * The tracked founding documents always count, and a missing one is reported rather than
 * skipped. Beyond them, `project.document_roots` names directories in the Murugan
 * repository whose Markdown is ingested read-only — otherwise CLUE could recite its own
 * constitution and had never read the design notes of the system it analyses.
 */
export function collectDocumentSources(runtime: Runtime): {
  sources: DocumentSource[];
  missing: string[];
} {
  const sources: DocumentSource[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const relativePath of runtime.config.constitution.tracked_documents) {
    const absolutePath = join(runtime.repoRoot, relativePath);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);

    if (existsSync(absolutePath)) {
      sources.push({ path: relativePath, absolutePath, origin: 'founding' });
    } else {
      missing.push(relativePath);
    }
  }

  const excluded = new Set([...runtime.config.project.exclude, '.git', 'node_modules', 'dist']);

  for (const documentRoot of runtime.config.project.document_roots) {
    const absoluteRoot = join(runtime.config.project.root, documentRoot);
    if (!existsSync(absoluteRoot)) {
      missing.push(`${runtime.config.project.id}:${documentRoot}`);
      continue;
    }

    for (const absolutePath of walkDocuments(absoluteRoot, excluded, 0)) {
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      sources.push({
        // Namespaced so a Murugan README and a CLUE README cannot collide in the corpus.
        path: `${runtime.config.project.id}/${relative(runtime.config.project.root, absolutePath).replace(/\\/g, '/')}`,
        absolutePath,
        origin: 'project',
      });
    }
  }

  return { sources, missing };
}

function* walkDocuments(
  directory: string,
  excluded: ReadonlySet<string>,
  depth: number,
): Generator<string> {
  if (depth > MAX_DOCUMENT_DEPTH) return;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    const absolute = join(directory, entry.name);

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walkDocuments(absolute, excluded, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    const index = entry.name.lastIndexOf('.');
    if (index < 0) continue;
    if (!DOCUMENT_EXTENSIONS.has(entry.name.slice(index + 1).toLowerCase())) continue;

    try {
      if (statSync(absolute).size === 0) continue;
    } catch {
      continue;
    }
    yield absolute;
  }
}