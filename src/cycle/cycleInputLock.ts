/**
 * Cycle input lock — Execution Model §2/§3.3 made computable (DEV-P2-08 S3).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §2 (required cycle inputs; diagnostic mode's honesty
 *       clause), §3.3 (lock cycle inputs); `docs/cycle-implementation-plan_v1.md` §3
 *       (`cycleInputLock`), accepted 2026-08-10; the shape and its refinement live in
 *       `schemas.ts` (`cycleInputLockSchema`).
 *
 * ## What a lock is
 *
 * A statement of exactly which world a cycle ran against — every input identified by
 * content, every §2 requirement that could not be locked named in `absent`, and one
 * canonical digest over the whole set so "these two cycles locked identical worlds" is a
 * string comparison. The grade falls out rather than being chosen:
 * `proof-authoritative` only when `absent` is empty, and the schema's refinement makes
 * the opposite unwritable.
 *
 * ## Where each fact comes from
 *
 * File-shaped inputs (the registered description and benchmark, every config-declared
 * policy file) are hashed from disk here. The mission's tracked documents are taken from
 * the **mission record**, not re-hashed — the mission is the registered basis, disk
 * agreement is `requireMission()`'s law, and a lock that re-derived the basis would be a
 * second authority on it. Other domains' truths (ratification, epoch, catalogue version)
 * are injected as records by the caller; this module does not reach into their services.
 *
 * ## The structural absences
 *
 * Some §2 requirements have nothing to hash because the machinery does not exist yet. A
 * pre-ZIP-08 installation names those absences directly. Under the mission-bound P2 closure
 * policy, the Project Intent Model and environment adapters are explicit P3 deferrals, while
 * the gateway remains an absence until the Creator records either operational activation or
 * safe-disabled deferral. The policy bytes enter `policy_files`, so phase scope is evidence,
 * not narrative.
 *
 * ## Refusal
 *
 * A **registered** input whose file is missing or unreadable is not an absence — it is a
 * registration that lies, and locking over it would launder a broken installation into a
 * diagnostic grade. That throws.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  cycleInputLockSchema,
  parseOrThrow,
  type ClueConfig,
  type CycleInputLock,
  type MissionVersion,
} from '../shared/schemas.js';
import { hashBytes } from '../shared/ids.js';
import { loadMeasurementCatalogue } from '../analysis/measure/catalogue.js';
import type { EpochRecord, RatificationRecord } from '../control/mission.js';
import type { ResolvedProjectRuntimeBinding } from '../control/projectProfiles/projectRuntimeBinding.js';
import { inspectProjectAuthority } from '../control/projectProfiles/projectAuthority.js';
import { assessAuthorityConflicts } from '../control/projectProfiles/authorityConflict.js';
import { resolveProjectBenchmarkRuntime } from '../control/projectProfiles/benchmarkRuntime.js';
import { projectGovernanceBasisFromBinding } from '../control/projectProfiles/projectGovernanceBasis.js';
import { P2_CLOSURE_POLICY_PATH, tryReadP2ClosurePolicy } from '../control/p2ClosurePolicy.js';

export interface InputLockDeps {
  /** CLU-E's own repository root — where policy files and its module tree live. */
  readonly repoRoot: string;
  readonly config: ClueConfig;
  /** The mission in force. The caller resolves it; a missionless lock is not a lock. */
  readonly mission: MissionVersion;
  readonly ratification: RatificationRecord | null;
  readonly epoch: EpochRecord | null;
  readonly projectBinding?: ResolvedProjectRuntimeBinding | null;
}

/** Hashes a registered project input, or throws when the registration lies. */
function lockRegisteredFile(
  label: string,
  projectRoot: string,
  relative: string,
): { readonly path: string; readonly sha256: string } {
  const absolute = join(projectRoot, ...relative.split('/'));
  if (!existsSync(absolute)) {
    throw new Error(
      `Registered input ${label} (${relative}) is absent on disk — a lock over a lying ` +
        'registration is refused; repair the registration or the file first.',
    );
  }
  return { path: relative, sha256: hashBytes(readFileSync(absolute)) };
}

/**
 * The digest covers everything the lock states **except** the digest itself and
 * `computed_at` — two cycles that locked identical worlds at different moments must
 * compare equal. Key order is fixed by construction and `absent` is sorted, so the
 * canonical JSON is deterministic.
 */
function lockDigest(body: Omit<CycleInputLock, 'digest'>): string {
  const canonical = {
    grade: body.grade,
    ...(body.project_basis === undefined ? {} : { project_basis: body.project_basis }),
    target_description: body.target_description,
    master_benchmark: body.master_benchmark,
    tracked_documents: body.tracked_documents,
    catalogue_version: body.catalogue_version,
    policy_files: body.policy_files,
    environment_fingerprint: body.environment_fingerprint,
    ratification_event_id: body.ratification_event_id,
    epoch_name: body.epoch_name,
    absent: body.absent,
  };
  return hashBytes(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

/** Assembles, grades, digests, and schema-validates the lock. Pure over its deps. */
export function computeInputLock(deps: InputLockDeps): CycleInputLock {
  const { repoRoot, config, mission } = deps;
  const absent: string[] = [];

  const profileBinding = deps.projectBinding ?? null;
  let project_basis: CycleInputLock['project_basis'];
  let target_description: CycleInputLock['target_description'];
  let master_benchmark: CycleInputLock['master_benchmark'];

  if (profileBinding === null) {
    const descriptionRel = config.project.inputs.description;
    target_description =
      descriptionRel === null
        ? (absent.push('target_description (unregistered)'), null)
        : lockRegisteredFile('target_description', config.project.root, descriptionRel);
    const benchmarkRel = config.project.inputs.benchmark;
    master_benchmark =
      benchmarkRel === null
        ? (absent.push('master_benchmark (unregistered)'), null)
        : lockRegisteredFile('master_benchmark', config.project.root, benchmarkRel);
  } else {
    const authority = inspectProjectAuthority(profileBinding.record);
    const conflicts = assessAuthorityConflicts(authority);
    const benchmarkRuntime = resolveProjectBenchmarkRuntime(profileBinding.record, authority.manifest);
    const rebound: ResolvedProjectRuntimeBinding = {
      ...profileBinding,
      authority,
      authorityConflicts: conflicts,
      benchmarkRuntime,
    };
    project_basis = projectGovernanceBasisFromBinding(rebound) ?? undefined;
    if (authority.manifest === null) {
      absent.push(`project_authority (${authority.state})`);
      target_description = null;
      master_benchmark = null;
    } else {
      const target = authority.manifest.documents.find((document) => document.kind === 'target-description');
      const benchmark = authority.manifest.documents.find((document) => document.kind === 'master-benchmark');
      target_description = target === undefined ? null : { path: target.canonicalPath, sha256: target.sha256 };
      master_benchmark = benchmark === undefined ? null : { path: benchmark.canonicalPath, sha256: benchmark.sha256 };
      if (target_description === null) absent.push('target_description (Project Authority missing)');
      if (master_benchmark === null) absent.push('master_benchmark (Project Authority missing)');
    }
    if (conflicts.state !== 'CLEAR') absent.push('project_authority (AUTHORITY CONFLICT)');
    if (benchmarkRuntime.state !== 'READY') {
      absent.push(`benchmark_runtime (${benchmarkRuntime.state}: ${benchmarkRuntime.issues.map((issue) => issue.code).join(',')})`);
    }
    if (project_basis === undefined) absent.push('project_governance_basis (unavailable)');
  }

  const tracked_documents = mission.documents.map((document) => ({
    path: document.path,
    sha256: document.hash,
  }));

  // Catalogue version: sourced here, once, so the orchestrator's lock and the resume
  // planner's recompute can never disagree. The file's *bytes* are already in the lock —
  // mission binds `config/measurements/catalogue.yaml` by content hash into
  // `tracked_documents` — so this contributes only the version label, with parse failures
  // stated rather than thrown: a diagnostic lock over an unparseable catalogue is honest
  // about exactly that.
  let catalogueVersion: string | null = null;
  const cataloguePath = join(repoRoot, 'config', 'measurements', 'catalogue.yaml');
  if (!existsSync(cataloguePath)) {
    absent.push('catalogue_version (config/measurements/catalogue.yaml absent)');
  } else {
    try {
      const loaded = loadMeasurementCatalogue(readFileSync(cataloguePath, 'utf8'));
      catalogueVersion = loaded.identity.version;
    } catch (error) {
      absent.push(
        `catalogue_version (unparseable: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)})`,
      );
    }
  }
  if (deps.ratification === null) absent.push('ratification (clue docs ratify)');
  if (deps.epoch === null) absent.push('epoch (clue epoch seal)');

  // Phase scope is itself governed input. Before ZIP 08, structural absences were always
  // counted. With a mission-bound P2 closure policy, the two explicitly post-P2 domains are
  // represented by the policy hash rather than misreported as missing P2 evidence. The gateway
  // remains an absence until D4 is explicitly closed; SAFE_DISABLED_DEFERRED is a real Creator
  // decision, not an implicit consequence of `enabled: false`.
  const p2Closure = tryReadP2ClosurePolicy(repoRoot);
  if (p2Closure?.policy.p3_deferrals.project_intent_model !== true) {
    absent.push('project_intent_model (AMB-003: no compiler exists)');
  }
  if (
    p2Closure?.policy.p3_deferrals.environment_adapters !== true &&
    !existsSync(join(repoRoot, 'src', 'analysis', 'environments'))
  ) {
    absent.push('environment_adapters (src/analysis/environments/ absent)');
  }
  if (p2Closure === null) {
    if (!config.gateway.enabled) absent.push('model_provider (gateway disabled)');
  } else {
    switch (p2Closure.policy.gateway.decision) {
      case 'PENDING_CREATOR_DECISION':
        absent.push('model_provider (D4 gateway closure decision pending)');
        break;
      case 'SAFE_DISABLED_DEFERRED':
        if (config.gateway.enabled) {
          absent.push('model_provider (SAFE_DISABLED_DEFERRED contradicts gateway.enabled=true)');
        }
        break;
      case 'OPERATIONAL':
        if (!config.gateway.enabled) {
          absent.push('model_provider (OPERATIONAL decision contradicts gateway.enabled=false)');
        }
        break;
    }
  }

  const declaredPolicies = [
    config.patching.policy_file,
    config.equilibrium.policy_file,
    config.gateway.budget_policy_file,
    config.gateway.routing_file,
    ...(p2Closure === null ? [] : [P2_CLOSURE_POLICY_PATH]),
  ];
  const policy_files: { path: string; sha256: string }[] = [];
  for (const relative of [...new Set(declaredPolicies)].sort()) {
    const absolute = join(repoRoot, ...relative.split('/'));
    if (existsSync(absolute)) {
      policy_files.push({ path: relative, sha256: hashBytes(readFileSync(absolute)) });
    } else {
      absent.push(`policy:${relative} (declared but missing)`);
    }
  }

  absent.sort();
  const body: Omit<CycleInputLock, 'digest'> = {
    grade: absent.length === 0 ? 'proof-authoritative' : 'diagnostic',
    computed_at: new Date().toISOString(),
    ...(project_basis === undefined ? {} : { project_basis }),
    target_description,
    master_benchmark,
    tracked_documents,
    catalogue_version: catalogueVersion,
    policy_files,
    environment_fingerprint: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    ratification_event_id: deps.ratification?.event_id ?? null,
    epoch_name: deps.epoch?.epoch_name ?? null,
    absent,
  };

  return parseOrThrow(
    cycleInputLockSchema,
    { digest: lockDigest(body), ...body },
    'cycle input lock',
  );
}
