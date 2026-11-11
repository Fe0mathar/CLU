/**
 * Proof execution coordinator — §12–§13 as one refusable sequence (DEV-P2-11, Stage H).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §12 (isolated candidate implementation: the lease,
 *       the typed patch, the change-set record, static preparation — "a failed candidate
 *       may be revised only when failure evidence changes the next attempt", so every
 *       failure here carries its evidence) and §13 (the frozen plan executed, with
 *       "instrument health … separately from target behavior" — an instrument that
 *       cannot run is a refusal, never a low score); `CLUE_Project_Directory_v9.md` §16,
 *       which places this exact module (`experiment/proof/executionCoordinator.ts`:
 *       "orchestration of baseline and candidate runs under one Proof Contract") and
 *       whose closing law is kept literally: **it may collect evidence; it may not
 *       reinterpret or accept its own result** — this module returns measurements and
 *       records, and `decide()` in `src/proof/verdict.ts` is the only place a
 *       disposition is born.
 *
 * ## The lease, under today's config
 *
 * §12.1 speaks of a Git worktree lease; the governed Git lifecycle is P4 and is not built in P2.
 * What *is* governed today is `config.shadow` (`clone_mode: local`, `persistent`,
 * `install_command`, `install_on_lockfile_change`), so the lease is a filesystem copy of
 * the pinned project inputs under `shadow.root`, keyed by the contract and patch — one
 * contract, one lease, reused when `persistent` and re-installed only when the lockfile
 * hash moved (the marker file records which lockfile the last install saw). When the P4 Git/worktree capability
 * lands, the worktree lease slots behind this same function; the sequence above it does
 * not change.
 *
 * ## Self-target instrument relocation
 *
 * The `clu-master` harness legitimately drives `clue`. The parent proof act holds the
 * canonical writer lock for the whole candidate arm, so those child processes must not
 * resolve the canonical workspace. For a physical CLU-E self-target, this coordinator
 * rewrites only the leased shadow copies of `config/clue.config.yaml` and the active target
 * profile. They point at the candidate shadow and lease-local workspace/shadow roots. The
 * before/after hashes are returned as instrument-plane evidence; canonical bytes are never
 * changed, and a candidate that tries to edit either relocation authority is refused.
 *
 * ## Candidate identity
 *
 * The candidate ID names the actual, verified tree after applying the typed change set.
 * The subsequent instrument relocation has its own receipts and is checked against the
 * candidate manifest before and after execution.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { canonicalJson, hashBytes, hashText, normalisePath, requireSha256, type Sha256 } from '../../shared/ids.js';
import {
  isCompleteCluBenchmarkV020,
  runMasterBenchmark,
  type ExecFn,
  type RunOutcome,
} from '../../benchmark/benchmarkRunner.js';
import { readBenchmarkContract } from '../../benchmark/harnessBlock.js';
import { OFFLINE_SUITE_V1_TESTS } from '../../benchmark/offlineSuiteV1.js';
import { parseScriptCommand } from '../../analysis/scenarios/scenarioRunner.js';
import { captureBenchmarkExecutableInputs } from '../../control/benchmarkRun.js';
import { isBenchmarkProfileContract } from '../../control/projectProfiles/benchmarkProfileInputs.js';
import { projectProfileStartupPath, readActiveProjectProfileForBenchmark } from '../../control/projectProfiles/projectProfileStartup.js';
import { prepareShadowBenchmarkProfileInputs, type ShadowBenchmarkProfileInputs } from '../../control/projectProfiles/shadowBenchmarkProfile.js';
import { createRestrictedExecution, requireProofExecutionBoundary } from '../../benchmark/restrictedExecution.js';
import {
  assertExactRunInputs,
  captureExactRunInputs,
  isExactRunInputPath,
  materializeExactRunInputs,
  type ExactRunInputs,
} from '../../control/exactRunInputs.js';
import { verifyFrozenContract, type FrozenProofContract } from '../../proof/proofContract.js';
import { assessBaselineValidity, type BaselinePackage } from '../../proof/baselineRegistry.js';
import type { ProjectProfileRecord } from '../../shared/schemas.js';

/* ------------------------------------------------------------------------- */
/* The typed patch and its record                                             */
/* ------------------------------------------------------------------------- */

/** §12.3's typed write authority: whole-file writes and deletions, nothing cleverer. */
export type PatchOperation =
  | { readonly op: 'write'; readonly path: string; readonly content: string }
  | { readonly op: 'delete'; readonly path: string };

export interface ChangeSetEntry {
  readonly op: 'write' | 'delete';
  readonly path: string;
  readonly sha256: Sha256 | null;
  readonly bytes: number;
}

/**
 * Ephemeral instrument-plane mutation required to measure a self-target safely.
 *
 * These bytes are never part of the candidate change set and never land. They exist only
 * inside the leased shadow so the benchmark's child `clue` processes address the shadow
 * repository and a lease-local workspace rather than the canonical writer lock.
 */
export interface ProofInstrumentationChange {
  readonly path: string;
  readonly purpose: 'self_target_config_relocation';
  readonly before_sha256: Sha256;
  readonly after_sha256: Sha256;
}

export interface ProofExecutionDeps {
  readonly frozen: FrozenProofContract;
  readonly baseline: BaselinePackage;
  readonly patch: readonly PatchOperation[];
  /** The source tree and exact executable inputs bound by the baseline receipt. */
  readonly projectRoot: string;
  readonly pinnedInputs: ExactRunInputs;
  readonly shadow: {
    readonly root: string;
    readonly persistent: boolean;
    readonly install_command: string | null;
    readonly install_on_lockfile_change: boolean;
  };
  /** The governed scripts §12.4's static preparation runs, in this order. */
  readonly scripts: { readonly typecheck: string; readonly build: string };
  /** The measuring stick — the same benchmark contract path the baseline ran. */
  readonly benchmarkContractPath: string;
  /** CLU-E repo root (the runner composes the cli argv from it). */
  readonly repoRoot: string;
  readonly projectProfile?: ProjectProfileRecord;
  readonly execImpl?: ExecFn;
  readonly log?: (line: string) => void;
}

export type ProofExecutionRefusalStage = 'contract' | 'baseline' | 'shadow' | 'patch' | 'static' | 'instrument';

interface RecognitionCommandTiming {
  readonly role: 'control' | 'candidate';
  readonly command: 'cold-recognize' | 'incremental-recognize';
  readonly sample: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallMs: number;
  readonly internalElapsedMs: number | null;
  readonly code: number;
  readonly timedOut: boolean;
}

export type ProofExecution =
  | {
      readonly ok: true;
      readonly outcome: Extract<RunOutcome, { ok: true }>;
      readonly candidate_snapshot_id: Sha256;
      readonly candidate_snapshot_basis: string;
      readonly candidate_inputs: ExactRunInputs;
      readonly executable_inputs: ReturnType<typeof captureBenchmarkExecutableInputs>;
      readonly patch_digest: Sha256;
      readonly change_set: readonly ChangeSetEntry[];
      readonly shadow_dir: string;
      readonly installed: boolean;
      readonly static_preparation: readonly { readonly script: string; readonly wall_ms: number }[];
      readonly instrumentation: readonly ProofInstrumentationChange[];
      readonly profile_relocation?: ShadowBenchmarkProfileInputs['receipt'];
      readonly recognition_timings?: readonly RecognitionCommandTiming[];
      readonly anomalies: readonly string[];
    }
  | {
      readonly ok: false;
      readonly stage: ProofExecutionRefusalStage;
      readonly reason: string;
      /** §12.4: failure evidence that changes the next attempt travels with the failure. */
      readonly evidence?: readonly string[];
    };

const LOCKFILE_MARKER = '.clue-shadow-lockfile-sha';
const LEASE_IDENTITY_MARKER = '.clue-proof-lease.json';

const CLU_V020_INSTRUMENT_PATHS = new Set([
  'selftest/benchmark-offline-suite-v1.ts',
  'selftest/project-profile-fixture.ts',
  ...OFFLINE_SUITE_V1_TESTS.map((name) => `selftest/${name}.ts`),
  'config/project-profiles.yaml',
  'src/benchmark/benchmarkProfileWorker.ts',
  'src/benchmark/offlineSuiteV1.ts',
  'src/cli/commandAuthority.ts',
  'src/cli/commands/benchmarkCommands.ts',
  'src/cli/index.ts',
  'src/control/projectProfiles/benchmarkProfileInputs.ts',
  'src/control/projectProfiles/projectAuthority.ts',
  'src/control/projectProfiles/projectPathIsolation.ts',
  'src/control/projectProfiles/projectProfileStartup.ts',
  'src/control/projectProfiles/projectRuntimeBinding.ts',
  'src/control/projectProfiles/shadowBenchmarkProfile.ts',
  'src/control/runtime.ts',
  'src/memory/db.ts',
  'src/memory/eventLog.ts',
].map(pathKey));

interface PreparedPatch {
  readonly operations: readonly {
    readonly operation: PatchOperation;
    readonly relative_path: string;
  }[];
  readonly change_set: readonly ChangeSetEntry[];
  readonly patch_digest: Sha256;
}

interface ExecutionLocation {
  readonly runner_repo_root: string;
  readonly workspace_root: string;
  readonly instrumentation: readonly ProofInstrumentationChange[];
  readonly self_target: boolean;
}

function physical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(physical(parent), basename(absolute));
  }
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  const a = physical(left);
  const b = physical(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function pathKey(value: string): string {
  return process.platform === 'win32'
    ? value.toLocaleLowerCase('en-US')
    : value;
}

/**
 * Refuses an existing symbolic-link/junction component in a patch target.
 *
 * Lexical containment alone is not enough: `inside/link/file.ts` may physically resolve
 * outside the leased tree. The candidate write authority is deliberately narrower than
 * the host filesystem, so an ambiguous linked target is refused rather than followed.
 */
function assertPatchTargetUnlinked(root: string, relativePath: string): void {
  const rootPhysical = pathKey(physical(root));
  let cursor = root;
  for (const component of relativePath.split('/')) {
    cursor = join(cursor, component);
    const stat = lstatIfPresent(cursor);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`patch target crosses a symbolic link or junction: ${relativePath}`);
    }
    const candidatePhysical = pathKey(physical(cursor));
    if (
      candidatePhysical !== rootPhysical &&
      !candidatePhysical.startsWith(`${rootPhysical}${sep}`)
    ) {
      throw new Error(`patch target resolves outside the leased tree: ${relativePath}`);
    }
  }
}

/**
 * Rehydrates a reused lease from the pinned source, keeping only dependency identity.
 * The materializer verifies file bytes while copying and checks the resulting tree.
 */
function resetReusableLease(shadowDir: string): void {
  const retained = new Set(['node_modules', LOCKFILE_MARKER, LEASE_IDENTITY_MARKER]);
  for (const entry of readdirSync(shadowDir)) {
    if (retained.has(entry)) continue;
    rmSync(join(shadowDir, entry), { recursive: true, force: true });
  }
}

function assertMeasuredChanges(
  before: ExactRunInputs,
  after: ExactRunInputs,
  changes: readonly {
    readonly path: string;
    readonly sha256: Sha256 | null;
    readonly bytes?: number;
    readonly before_sha256?: Sha256;
  }[],
): void {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const remaining = new Map(after.files.map((file) => [file.path, file]));
  for (const change of changes) {
    const observed = remaining.get(change.path);
    const previous = beforeFiles.get(change.path);
    if (change.before_sha256 !== undefined && previous?.hash !== change.before_sha256) {
      throw new Error(`input does not match the recorded before state: ${change.path}`);
    }
    if (change.sha256 === null) {
      if (observed !== undefined) throw new Error(`deleted input is still present: ${change.path}`);
    } else if (
      observed?.hash !== change.sha256 ||
      (change.bytes !== undefined && observed.bytes !== change.bytes) ||
      observed.executable !== (previous?.executable ?? false)
    ) {
      throw new Error(`input does not match the recorded change: ${change.path}`);
    }
    beforeFiles.delete(change.path);
    remaining.delete(change.path);
  }

  for (const [path, previous] of beforeFiles) {
    const observed = remaining.get(path);
    if (
      observed?.hash !== previous.hash ||
      observed.bytes !== previous.bytes ||
      observed.executable !== previous.executable
    ) {
      throw new Error(`unrecorded input change: ${path}`);
    }
    remaining.delete(path);
  }
  if (remaining.size > 0) {
    throw new Error(`unrecorded input added: ${remaining.keys().next().value}`);
  }
}

function portableAbsolute(path: string): string {
  return path.replace(/\\/g, '/');
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a YAML mapping.`);
  }
  return value as Record<string, unknown>;
}

function preparePatch(patch: readonly PatchOperation[]): PreparedPatch | ProofExecution {
  const operations: { operation: PatchOperation; relative_path: string }[] = [];
  const changeSet: ChangeSetEntry[] = [];
  const names = new Set<string>();

  for (const operation of patch) {
    const rel = normalisePath(operation.path);
    const components = rel.split('/');
    if (
      isAbsolute(operation.path) ||
      rel.startsWith('/') ||
      components.some((part) =>
        part === '' || /[<>:"|?*\u0000-\u001f]|[ .]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
      )
    ) {
      return {
        ok: false,
        stage: 'patch',
        reason:
          `unsafe or non-portable patch path: ${JSON.stringify(operation.path)} — ` +
          'the typed write authority covers the shadow and nothing above it',
      };
    }
    if (!isExactRunInputPath(rel)) {
      return { ok: false, stage: 'patch', reason: `patch target is excluded from proof inputs: ${rel}` };
    }
    const key = rel.toLowerCase();
    if (names.has(key)) {
      return {
        ok: false,
        stage: 'patch',
        reason: `patch names the same target more than once: ${rel}`,
      };
    }
    names.add(key);
    operations.push({ operation, relative_path: rel });
    if (operation.op === 'write') {
      changeSet.push({
        op: 'write',
        path: rel,
        sha256: hashText(operation.content),
        bytes: Buffer.byteLength(operation.content, 'utf8'),
      });
    } else {
      changeSet.push({ op: 'delete', path: rel, sha256: null, bytes: 0 });
    }
  }

  return {
    operations,
    change_set: changeSet,
    patch_digest: hashText(canonicalJson(changeSet)),
  };
}

function writeRelocatedYaml(
  root: string,
  relativePath: string,
  value: Record<string, unknown>,
): ProofInstrumentationChange {
  const path = join(root, ...relativePath.split('/'));
  if (!inside(root, path) || !existsSync(path)) {
    throw new Error(`self-target relocation authority is missing or outside the shadow: ${relativePath}`);
  }
  const before = readFileSync(path);
  const afterText = stringifyYaml(value, { lineWidth: 0 });
  const after = Buffer.from(afterText, 'utf8');
  writeFileSync(path, after);
  return {
    path: relativePath,
    purpose: 'self_target_config_relocation',
    before_sha256: hashBytes(before),
    after_sha256: hashBytes(after),
  };
}

/**
 * Relocates only the shadow copy's installation authority for a CLU-E self-target.
 *
 * The candidate is forbidden to edit either relocation authority. The benchmark then
 * drives the built CLI inside the shadow, whose profile points at the shadow and whose
 * workspace/shadow roots are lease-local siblings outside the measured tree. Canonical
 * config/profile bytes remain untouched.
 */
export function prepareSelfTargetExecution(input: {
  readonly canonical_repo_root: string;
  readonly canonical_project_root: string;
  readonly shadow_dir: string;
  readonly patch_paths: readonly string[];
  readonly fromPinnedCopy?: boolean;
}): ExecutionLocation {
  const leaseParent = dirname(input.shadow_dir);
  const leaseName = basename(input.shadow_dir);
  const workspaceRoot = join(leaseParent, `${leaseName}-workspace`);
  if (!samePhysicalPath(input.canonical_repo_root, input.canonical_project_root)) {
    return {
      runner_repo_root: input.canonical_repo_root,
      workspace_root: workspaceRoot,
      instrumentation: [],
      self_target: false,
    };
  }

  const configRelative = 'config/clue.config.yaml';
  const configPath = join(input.shadow_dir, 'config', 'clue.config.yaml');
  const canonicalConfigPath = join(input.canonical_repo_root, 'config', 'clue.config.yaml');
  // Production starts with the verified lease copy. Standalone relocation can be
  // reapplied to an existing lease by restoring its canonical authority bytes.
  const sourceConfig = readFileSync(input.fromPinnedCopy ? configPath : canonicalConfigPath);
  if (!input.fromPinnedCopy) writeFileSync(configPath, sourceConfig);
  const config = asRecord(parseYaml(sourceConfig.toString('utf8')), configRelative);
  const project = asRecord(config['project'], `${configRelative}: project`);
  const activeTarget = typeof project['active_target'] === 'string'
    ? project['active_target'].trim()
    : '';
  const profileRelative = activeTarget === '' ? null : `targets/${activeTarget}/profile.yaml`;
  const authorityPaths = new Set(
    [configRelative, profileRelative]
      .filter((value): value is string => value !== null)
      .map((value) => value.toLocaleLowerCase('en-US')),
  );
  const conflict = input.patch_paths.find((path) =>
    authorityPaths.has(path.toLocaleLowerCase('en-US')),
  );
  if (conflict !== undefined) {
    throw new Error(
      `a self-target proof candidate cannot modify relocation authority ${conflict}; ` +
        'configuration/profile changes require their own governed mission and cannot be instrumented away',
    );
  }

  const nestedShadowRoot = join(leaseParent, `${leaseName}-nested-shadow`);
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(nestedShadowRoot, { recursive: true, force: true });

  const workspace = asRecord(config['workspace'], `${configRelative}: workspace`);
  const shadow = asRecord(config['shadow'], `${configRelative}: shadow`);
  workspace['root'] = portableAbsolute(workspaceRoot);
  shadow['root'] = portableAbsolute(nestedShadowRoot);

  const instrumentation: ProofInstrumentationChange[] = [];
  if (profileRelative === null) {
    project['root'] = portableAbsolute(input.shadow_dir);
  } else {
    const profilePath = join(input.shadow_dir, ...profileRelative.split('/'));
    const canonicalProfilePath = join(input.canonical_repo_root, ...profileRelative.split('/'));
    const sourceProfile = readFileSync(input.fromPinnedCopy ? profilePath : canonicalProfilePath);
    if (!input.fromPinnedCopy) writeFileSync(profilePath, sourceProfile);
    const profile = asRecord(parseYaml(sourceProfile.toString('utf8')), profileRelative);
    profile['root'] = portableAbsolute(input.shadow_dir);
    instrumentation.push(writeRelocatedYaml(input.shadow_dir, profileRelative, profile));
  }
  instrumentation.push(writeRelocatedYaml(input.shadow_dir, configRelative, config));

  return {
    runner_repo_root: input.shadow_dir,
    workspace_root: workspaceRoot,
    instrumentation,
    self_target: true,
  };
}

/* ------------------------------------------------------------------------- */
/* The sequence                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Runs §12–§13 for one frozen contract and one patch, refusals first, evidence always.
 *
 * The instrument runs the *same* stick the baseline ran, over the patched shadow, with
 * the shadow as the tree under measurement (`projectRoot`) and a lease-local workspace
 * for whatever the stick's harness writes. Nothing here reads the outcome's numbers:
 * per Directory §16 this plane collects and hands over, and only the verdict decides.
 */
export function executeProofPlan(deps: ProofExecutionDeps): Promise<ProofExecution> {
  return executeShadowProof(deps, false);
}

/** Rehearse the unchanged input in a fresh shadow with the candidate's exact execution policy. */
export function executeMatchedProofControl(deps: Omit<ProofExecutionDeps, 'patch'>): Promise<ProofExecution> {
  return executeShadowProof({ ...deps, shadow: { ...deps.shadow, persistent: false }, patch: [] }, true);
}

async function executeShadowProof(deps: ProofExecutionDeps, matchedControl: boolean): Promise<ProofExecution> {
  const log = deps.log ?? (() => {});

  if (deps.execImpl === undefined) {
    try {
      requireProofExecutionBoundary();
    } catch (error) {
      return { ok: false, stage: 'instrument', reason: (error as Error).message };
    }
  }

  // §10/§15.2 at the door: a moved contract executes nothing.
  const contractOk = verifyFrozenContract(deps.frozen.contract, deps.frozen.contract_hash);
  if (!contractOk.ok) return { ok: false, stage: 'contract', reason: contractOk.reason };

  // §11 at the door: an unusable baseline makes the candidate run unpayable-for.
  const baselineOk = assessBaselineValidity(deps.frozen.contract, deps.baseline);
  if (!baselineOk.valid) {
    return { ok: false, stage: 'baseline', reason: baselineOk.reasons.join('; ') };
  }

  // §12.1/§12.3 — validate and identity-bind the patch before any shadow byte lands.
  const prepared = preparePatch(deps.patch);
  if ('ok' in prepared) return prepared;
  const patchDigest = prepared.patch_digest;
  const changeSet = prepared.change_set;
  let benchmarkBytes: Buffer;
  let requiresCompleteCluBenchmark = false;
  try {
    benchmarkBytes = readFileSync(deps.benchmarkContractPath);
    if (hashBytes(benchmarkBytes) !== deps.baseline.benchmark.contract_sha256) {
      throw new Error('benchmark contract does not match the baseline receipt');
    }
    const source = pathKey(physical(deps.projectRoot));
    const benchmark = pathKey(physical(deps.benchmarkContractPath));
    const benchmarkRelative = normalisePath(relative(source, benchmark));
    if (inside(source, benchmark) &&
        changeSet.some((change) => pathKey(change.path) === benchmarkRelative)) {
      return { ok: false, stage: 'patch', reason: 'a proof candidate cannot modify its benchmark authority' };
    }
    const benchmarkContract = readBenchmarkContract(benchmarkBytes.toString('utf8'));
    requiresCompleteCluBenchmark = !('error' in benchmarkContract) &&
      benchmarkContract.identity.benchmark_id === 'clu-master' &&
      benchmarkContract.identity.benchmark_version === '0.2.0';
    if (requiresCompleteCluBenchmark) {
      const instrumentChange = changeSet.find((change) => CLU_V020_INSTRUMENT_PATHS.has(pathKey(change.path)));
      if (instrumentChange !== undefined) {
        return { ok: false, stage: 'patch', reason: `a proof candidate cannot modify the benchmark instrument: ${instrumentChange.path}` };
      }
    }
  } catch (error) {
    return { ok: false, stage: 'instrument', reason: (error as Error).message };
  }

  // A persistent lease is keyed by the frozen contract AND exact patch, never just the
  // contract. Two candidate attempts therefore cannot contaminate one another with stale
  // files, while an exact rerun may reuse its dependencies safely.
  const leaseId =
    `proof-${matchedControl ? 'control-' : ''}${deps.frozen.contract_hash.slice(0, 10)}-${patchDigest.slice(0, 10)}`;
  const shadowDir = join(deps.shadow.root, leaseId);
  const expectedLeaseIdentity = canonicalJson({
    contract_hash: deps.frozen.contract_hash,
    snapshot_id: deps.frozen.contract.snapshot_id,
    pinned_inputs_id: deps.pinnedInputs.id,
    patch_digest: patchDigest,
  });
  const leaseMarker = join(shadowDir, LEASE_IDENTITY_MARKER);
  let reusable: boolean;
  try {
    const source = pathKey(physical(deps.projectRoot));
    const shadowRoot = pathKey(physical(deps.shadow.root));
    if (inside(source, shadowRoot) || inside(shadowRoot, source)) {
      throw new Error('candidate shadow must be disjoint from the source tree');
    }
    const lease = lstatIfPresent(shadowDir);
    if (lease !== null && !lease.isDirectory()) {
      throw new Error('candidate lease is not an unlinked directory');
    }
    const marker = lstatIfPresent(leaseMarker);
    reusable = deps.shadow.persistent && marker?.isFile() === true &&
      readFileSync(leaseMarker, 'utf8') === expectedLeaseIdentity;
    assertExactRunInputs(deps.projectRoot, deps.pinnedInputs, 'candidate source');
    if (reusable) {
      const dependencies = lstatIfPresent(join(shadowDir, 'node_modules'));
      const lockMarker = lstatIfPresent(join(shadowDir, LOCKFILE_MARKER));
      if ((dependencies !== null && !dependencies.isDirectory()) ||
          (lockMarker !== null && !lockMarker.isFile())) {
        throw new Error('reusable lease dependency state contains a linked or special entry');
      }
      resetReusableLease(shadowDir);
    } else {
      rmSync(shadowDir, { recursive: true, force: true });
      mkdirSync(shadowDir, { recursive: true });
    }
    materializeExactRunInputs(deps.projectRoot, shadowDir, deps.pinnedInputs);
    log(`shadow: ${reusable ? 'reused' : 'fresh'} lease materialized from pinned inputs at ${shadowDir}`);
  } catch (error) {
    return {
      ok: false,
      stage: 'shadow',
      reason: `shadow copy failed: ${String((error as Error).message)}`,
    };
  }

  // Apply through the typed write authority. Reapplication on an exact reusable lease is
  // intentional and idempotent; it also repairs an interrupted write before measurement.
  for (const item of prepared.operations) {
    const target = join(shadowDir, ...item.relative_path.split('/'));
    if (!inside(shadowDir, target)) {
      return {
        ok: false,
        stage: 'patch',
        reason: `patch target escaped after join: ${item.relative_path}`,
      };
    }
    try {
      assertPatchTargetUnlinked(shadowDir, item.relative_path);
      if (item.operation.op === 'write') {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, item.operation.content, 'utf8');
      } else if (existsSync(target)) {
        unlinkSync(target);
      }
    } catch (error) {
      return { ok: false, stage: 'patch', reason: (error as Error).message };
    }
  }
  let candidateInputs: ExactRunInputs;
  try {
    candidateInputs = captureExactRunInputs(shadowDir);
    assertMeasuredChanges(deps.pinnedInputs, candidateInputs, changeSet);
    if (matchedControl && canonicalJson(candidateInputs) !== canonicalJson(deps.pinnedInputs)) {
      return { ok: false, stage: 'patch', reason: 'The matched control must use exactly the unchanged screened project inputs.' };
    }
    if (!matchedControl && candidateInputs.id === deps.pinnedInputs.id) {
      return { ok: false, stage: 'patch', reason: 'The candidate patch did not change the pinned project inputs.' };
    }
  } catch (error) {
    return { ok: false, stage: 'patch', reason: (error as Error).message };
  }
  log(`patch: ${changeSet.length} operation(s), digest ${patchDigest.slice(0, 12)}…`);

  // The CLU-E self-target needs a distinct CLI/config/workspace identity inside the
  // shadow. This is instrument-plane relocation, never part of the candidate change set.
  let executionLocation: ExecutionLocation;
  let executionInputs: ExactRunInputs;
  const canonicalProfile = deps.projectProfile;
  const candidateProfile = process.platform === 'win32' && deps.execImpl === undefined &&
    samePhysicalPath(deps.repoRoot, deps.projectRoot) &&
    (canonicalProfile !== undefined || existsSync(projectProfileStartupPath(deps.repoRoot)));
  try {
    if (candidateProfile) {
      if (canonicalProfile === undefined || !samePhysicalPath(deps.projectRoot, canonicalProfile.profile.targetRoot) ||
          !isBenchmarkProfileContract(deps.baseline.benchmark.contract_sha256)) {
        throw new Error('Profile-bound candidate requires the verified CLU-E self-target and exact clu-master@0.2.0 contract.');
      }
      const authorityPaths = new Set([
        'config/clue.config.yaml',
        'config/project-profiles.yaml',
        ...[canonicalProfile.profile.authority.targetDescription, canonicalProfile.profile.authority.masterBenchmark,
          canonicalProfile.profile.authority.projectIntent, ...canonicalProfile.profile.authority.additionalDocuments]
          .flatMap((entry) => entry?.enabled ? [normalisePath(relative(deps.projectRoot, entry.canonicalPath))] : []),
      ].map(pathKey));
      const authorityChange = changeSet.find(({ path }) => authorityPaths.has(pathKey(path)));
      if (authorityChange !== undefined) throw new Error(`a candidate cannot modify profile authority: ${authorityChange.path}`);
      executionLocation = {
        runner_repo_root: shadowDir,
        workspace_root: join(dirname(shadowDir), `${basename(shadowDir)}-workspace`),
        instrumentation: [],
        self_target: true,
      };
    } else {
      executionLocation = prepareSelfTargetExecution({
        canonical_repo_root: deps.repoRoot,
        canonical_project_root: deps.projectRoot,
        shadow_dir: shadowDir,
        patch_paths: changeSet.map((entry) => entry.path),
        fromPinnedCopy: true,
      });
    }
    executionInputs = captureExactRunInputs(shadowDir);
    assertMeasuredChanges(candidateInputs, executionInputs, executionLocation.instrumentation.map((change) => ({
      path: change.path,
      sha256: change.after_sha256,
      before_sha256: change.before_sha256,
    })));
  } catch (error) {
    return {
      ok: false,
      stage: 'shadow',
      reason: `self-target relocation refused: ${String((error as Error).message)}`,
    };
  }

  let executionScope: ReturnType<typeof createRestrictedExecution> | undefined;
  try {
    rmSync(executionLocation.workspace_root, { recursive: true, force: true });
    mkdirSync(join(executionLocation.workspace_root, 'graph'), { recursive: true });
    let profileInputs: ShadowBenchmarkProfileInputs | undefined;
    if (candidateProfile && canonicalProfile !== undefined) {
      profileInputs = await prepareShadowBenchmarkProfileInputs({
        canonical: canonicalProfile,
        shadow: shadowDir,
        workspace: executionLocation.workspace_root,
        verifyActiveProfile: () => {
          const current = readActiveProjectProfileForBenchmark(deps.repoRoot);
          if (current === null || canonicalJson(current) !== canonicalJson(canonicalProfile)) {
            throw new Error('The active Project Profile changed during candidate proof.');
          }
        },
      });
      log(`instrument: lease-local Project Profile bound (${hashBytes(profileInputs.bytes).slice(0, 12)}…)`);
    }
    if (deps.execImpl === undefined) {
      executionScope = createRestrictedExecution({
        repoRoot: executionLocation.runner_repo_root,
        projectRoot: shadowDir,
        workspaceRoot: executionLocation.workspace_root,
        mode: 'candidate',
        ...(profileInputs === undefined ? {} : { benchmarkProfileInputs: profileInputs }),
      });
    }
    const exec = deps.execImpl ?? executionScope?.exec;
    if (exec === undefined) throw new Error('Candidate execution has no isolation boundary.');

    // Install after the candidate patch is applied, so a changed lockfile governs the
    // candidate's dependencies rather than the canonical tree's dependencies.
    let installed = false;
    if (deps.shadow.install_command !== null) {
      const lockPath = join(shadowDir, 'package-lock.json');
      const lockSha = existsSync(lockPath) ? hashBytes(readFileSync(lockPath)) : 'no-lockfile';
      const markerPath = join(shadowDir, LOCKFILE_MARKER);
      const lastSha = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;
      const mustInstall = !reusable ||
        (deps.shadow.install_on_lockfile_change && lastSha !== lockSha);
      if (mustInstall) {
        const parsed = parseScriptCommand('install', deps.shadow.install_command);
        if ('reason' in parsed) {
          return { ok: false, stage: 'shadow', reason: `install: ${parsed.reason}` };
        }
        const install = await exec(parsed.argv, { timeoutSeconds: 900 });
        if (install.code !== 0 || install.timedOut) {
          return {
            ok: false,
            stage: 'shadow',
            reason:
              `install (${deps.shadow.install_command}) ` +
              `${install.timedOut ? 'timed out' : `exited ${install.code}`}`,
            evidence: [install.stderr.trim().slice(0, 400) || install.stdout.trim().slice(-400)],
          };
        }
        try {
          assertExactRunInputs(shadowDir, executionInputs, 'candidate inputs after install');
          rmSync(markerPath, { force: true });
          writeFileSync(markerPath, lockSha, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
          return { ok: false, stage: 'shadow', reason: (error as Error).message };
        }
        installed = true;
      }
    }
    try {
      rmSync(leaseMarker, { force: true });
      writeFileSync(leaseMarker, expectedLeaseIdentity, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      return { ok: false, stage: 'shadow', reason: (error as Error).message };
    }

    // A deleted/renamed source must not survive as an old compiled file. The candidate
    // build therefore starts from an empty dist, independent of package-script habits.
    rmSync(join(shadowDir, 'dist'), { recursive: true, force: true });

    // §12.4 — static preparation, in the governed order, failure evidence attached.
    const staticReceipts: { script: string; wall_ms: number }[] = [];
    for (const name of ['typecheck', 'build'] as const) {
      const parsed = parseScriptCommand(name, deps.scripts[name]);
      if ('reason' in parsed) return { ok: false, stage: 'static', reason: `${name}: ${parsed.reason}` };
      const run = await exec(parsed.argv, { timeoutSeconds: 900 });
      if (run.code !== 0 || run.timedOut) {
        return {
          ok: false,
          stage: 'static',
          reason: `${name} (${deps.scripts[name]}) ${run.timedOut ? 'timed out' : `exited ${run.code}`} on the candidate — §12.4: revised only when this evidence changes the next attempt`,
          evidence: [run.stderr.trim().slice(0, 400) || run.stdout.trim().slice(-400)],
        };
      }
      try {
        assertExactRunInputs(shadowDir, executionInputs, `candidate inputs after ${name}`);
      } catch (error) {
        return { ok: false, stage: 'static', reason: (error as Error).message };
      }
      staticReceipts.push({ script: name, wall_ms: Math.round(run.wallMs) });
      log(`static: ${name} ok (${Math.round(run.wallMs)} ms)`);
    }

    // The relocated self-target CLI needs its own mission/projections before the approved
    // harness can drive snapshot/recognition/status commands. This child uses a different
    // workspace and therefore never contends with the canonical proof writer lock.
    if (executionLocation.self_target && profileInputs === undefined) {
      const cli = join(shadowDir, 'dist', 'src', 'cli', 'index.js');
      if (!existsSync(cli)) {
        return {
          ok: false,
          stage: 'instrument',
          reason: `self-target relocation built no CLI at ${cli}`,
        };
      }
      const initialized = await exec(['node', cli, 'init'], { timeoutSeconds: 900 });
      if (initialized.code !== 0 || initialized.timedOut) {
        return {
          ok: false,
          stage: 'instrument',
          reason:
            `relocated self-target init ${initialized.timedOut ? 'timed out' : `exited ${initialized.code}`}`,
          evidence: [initialized.stderr.trim().slice(0, 400) || initialized.stdout.trim().slice(-400)],
        };
      }
      log(`instrument: self-target authority relocated (${executionLocation.instrumentation.length} file(s))`);
    }

    let executableInputs: ReturnType<typeof captureBenchmarkExecutableInputs>;
    try {
      assertExactRunInputs(shadowDir, executionInputs, 'candidate inputs before benchmark');
      assertExactRunInputs(deps.projectRoot, deps.pinnedInputs, 'canonical inputs before benchmark');
      if (hashBytes(readFileSync(deps.benchmarkContractPath)) !== deps.baseline.benchmark.contract_sha256) {
        throw new Error('benchmark contract changed before execution');
      }
      executableInputs = captureBenchmarkExecutableInputs(executionLocation.runner_repo_root, shadowDir);
    } catch (error) {
      return { ok: false, stage: 'instrument', reason: (error as Error).message };
    }

    // §13 — the frozen plan's instrument: the same stick, over the candidate tree.
    const recognitionTimings: RecognitionCommandTiming[] = [];
    const recognitionSamples = { 'cold-recognize': 0, 'incremental-recognize': 0 };
    const observedExec: ExecFn = async (argv, options) => {
      if (argv[2] !== 'recognize' || argv.at(-1) !== '--navigator') return exec(argv, options);
      const command = argv[3] === '--full' ? 'cold-recognize' : 'incremental-recognize';
      const sample = ++recognitionSamples[command];
      const startedAt = new Date().toISOString();
      const run = await exec(argv, options);
      const internal = /^INFO\s+elapsed\s+(\d+) ms\s*$/m.exec(run.stdout)?.[1];
      if (recognitionTimings.length < 8 && Number.isFinite(run.wallMs)) {
        recognitionTimings.push({ role: matchedControl ? 'control' : 'candidate', command, sample,
          startedAt, finishedAt: new Date().toISOString(), wallMs: run.wallMs,
          internalElapsedMs: internal === undefined ? null : Number(internal), code: run.code, timedOut: run.timedOut });
      }
      return run;
    };
    const timingEvidence = () => recognitionTimings.map((timing) => `BENCHMARK_TIMING ${JSON.stringify(timing)}`);
    const outcome = await runMasterBenchmark({
      repoRoot: executionLocation.runner_repo_root,
      projectRoot: shadowDir,
      workspaceRoot: executionLocation.workspace_root,
      contractPath: deps.benchmarkContractPath,
      contractBytes: benchmarkBytes,
      maxProofDurationSeconds: deps.frozen.contract.execution.max_duration_seconds,
      execImpl: requiresCompleteCluBenchmark ? observedExec : exec,
      ...(executionScope === undefined ? {} : { executionBoundary: executionScope.boundary }),
      log: (line) => log(`instrument: ${line}`),
    });
    if (!outcome.ok) {
      return {
        ok: false,
        stage: 'instrument',
        reason: `the measuring stick refused at ${outcome.stage}: ${outcome.reason}`,
        evidence: timingEvidence(),
      };
    }

    try {
      assertExactRunInputs(shadowDir, executionInputs, 'candidate inputs after benchmark');
      profileInputs?.verifyCurrent();
      assertExactRunInputs(deps.projectRoot, deps.pinnedInputs, 'canonical inputs after benchmark');
      const afterExecutables = captureBenchmarkExecutableInputs(executionLocation.runner_repo_root, shadowDir);
      if (canonicalJson(afterExecutables) !== canonicalJson(executableInputs)) {
        throw new Error('candidate executable inputs changed during benchmark');
      }
      if (outcome.contract.sha256 !== deps.baseline.benchmark.contract_sha256 ||
          hashBytes(readFileSync(deps.benchmarkContractPath)) !== deps.baseline.benchmark.contract_sha256) {
        throw new Error('benchmark contract changed during execution');
      }
    } catch (error) {
      return { ok: false, stage: 'instrument', reason: (error as Error).message, evidence: timingEvidence() };
    }

    if (requiresCompleteCluBenchmark && !isCompleteCluBenchmarkV020(outcome.result)) {
      return {
        ok: false,
        stage: 'instrument',
        reason: 'the candidate benchmark did not produce all 13 required signals',
        evidence: [...outcome.result.incomplete.map(({ id, reason }) => `${id}: ${reason}`), ...timingEvidence()],
      };
    }

    const anomalies: string[] = [];
    if (outcome.budget.exhausted) {
      anomalies.push('the instrument exhausted its total runtime budget — the run is incomplete, not slow');
    }

    return {
      ok: true,
      outcome,
      candidate_snapshot_id: requireSha256(candidateInputs.id, 'candidate input manifest'),
      candidate_snapshot_basis: matchedControl
        ? 'verified unchanged screened input manifest before matched control instrument relocation'
        : 'verified measured candidate input manifest before instrument relocation',
      candidate_inputs: candidateInputs,
      executable_inputs: executableInputs,
      patch_digest: patchDigest,
      change_set: changeSet,
      shadow_dir: shadowDir,
      installed,
      static_preparation: staticReceipts,
      instrumentation: executionLocation.instrumentation,
      ...(profileInputs === undefined ? {} : { profile_relocation: profileInputs.receipt }),
      ...(recognitionTimings.length === 0 ? {} : { recognition_timings: recognitionTimings }),
      anomalies,
    };
  } catch (error) {
    return { ok: false, stage: 'instrument', reason: (error as Error).message };
  } finally {
    executionScope?.dispose();
  }
}
