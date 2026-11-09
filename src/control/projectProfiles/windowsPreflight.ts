/** Read-only inventory for the exact saved Project Profile used at dashboard startup. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assessCatalogueReadiness, loadMeasurementCatalogue } from '../../analysis/measure/catalogue.js';
import { resolveWindowsSupervisor } from '../../benchmark/windowsExecutionSupervisor.js';
import { requireWindowsSupervisorQualification } from '../../benchmark/windowsSupervisorQualification.js';
import { containsPath, resolvePathIdentity } from '../../shared/pathIdentity.js';
import type { ProjectProfileRecord } from '../../shared/schemas.js';
import { redactSecretText } from '../../shared/secretSafety.js';
import { verifyInstalledPackAgainstSeal } from '../mission.js';
import { withProjectRuntimeSnapshot } from '../runtime.js';
import { assessAuthorityConflicts } from './authorityConflict.js';
import { resolveProjectBenchmarkRuntime } from './benchmarkRuntime.js';
import { inspectProjectGitReadiness, preflightGitRunner } from './gitReadiness.js';
import { inspectProjectAuthority } from './projectAuthority.js';
import {
  loadProjectProfileStartup,
  readActiveProjectProfileForBenchmark,
  resolveProjectProfilesRoot,
} from './projectProfileStartup.js';
import { resolveProjectRecognitionConfiguration } from './projectRecognition.js';
import { assessProjectReadiness, type ProjectReadinessAssessment } from './projectReadiness.js';

export interface WindowsPreflightCheck {
  readonly id: string;
  readonly state: 'PASS' | 'BLOCKED' | 'NOT_RUN';
  readonly code: string;
  readonly detail: string;
  readonly action?: string;
}

type RecordObservation = { readonly registryRoot: string; readonly record: ProjectProfileRecord };

function observeProfile(repoRoot: string): RecordObservation | null {
  const selector = loadProjectProfileStartup(repoRoot);
  if (selector === null) return null;
  const record = readActiveProjectProfileForBenchmark(repoRoot);
  if (record === null) return null;
  return {
    registryRoot: resolveProjectProfilesRoot(repoRoot, selector.profiles.registry_root),
    record,
  };
}

function publicText(value: string): string {
  return redactSecretText(value).text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 2048);
}

function errorCode(error: unknown, fallback: string): string {
  if (error === null || typeof error !== 'object' || !('code' in error)) return fallback;
  return typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code) ? error.code : fallback;
}

function profileFacts({ record, registryRoot }: RecordObservation) {
  const { profile } = record;
  return {
    projectId: publicText(profile.projectId),
    profileGeneration: record.generation,
    projectProfileHash: record.projectProfileHash,
    targetRootIdentity: profile.targetRootIdentity,
    registryRoot: publicText(registryRoot),
    targetRoot: publicText(profile.targetRoot),
    workspaceRoot: publicText(profile.workspaceRoot),
    shadowRoot: publicText(profile.shadowRoot),
    databasePath: publicText(profile.state.databasePath),
    eventLogRoot: publicText(profile.state.eventLogRoot),
    browserProfileRoot: publicText(profile.integrations.chrome.dedicatedProfileDirectory),
  };
}

function inspectDocumentation(repoRoot: string) {
  const verified = verifyInstalledPackAgainstSeal(repoRoot, 'inspect Windows preflight');
  const manifestSha256 = verified.declared.get(verified.pack.manifestFile);
  if (manifestSha256 === undefined) throw new Error('The selected seal must cover its manifest.');
  return {
    releaseVersion: publicText(verified.pack.releaseVersion),
    sealPath: publicText(verified.pack.sealFile),
    sealSha256: verified.sealSha,
    manifestPath: publicText(verified.pack.manifestFile),
    manifestSha256,
    sealedFileCount: verified.declared.size,
  };
}

function inspectCatalogue(repoRoot: string) {
  const catalogue = loadMeasurementCatalogue(readFileSync(join(repoRoot, 'config', 'measurements', 'catalogue.yaml'), 'utf8'));
  const readiness = assessCatalogueReadiness(catalogue);
  return {
    version: publicText(catalogue.identity.version),
    contentSha256: catalogue.identity.contentHash,
    activeMeasures: catalogue.activeMeasureCount,
    productionReady: readiness.ready,
  };
}

function inspectWorkspace(repoRoot: string, { record, registryRoot }: RecordObservation) {
  return withProjectRuntimeSnapshot(record, repoRoot, registryRoot, (runtime) => {
    const owner = runtime.projections.workspaceIdentity();
    const head = runtime.projections.status();
    const current = runtime.mission?.current() ?? null;
    let mission = null;
    if (current !== null) {
      let basisHash: string | null = null;
      let state: 'CURRENT' | 'STALE' = 'STALE';
      try {
        runtime.requireMission();
        basisHash = runtime.mission?.basis().basisHash ?? null;
        if (basisHash !== null) state = 'CURRENT';
      } catch {
        // A stale basis may include sensitive raw document or configuration errors.
      }
      mission = { id: publicText(current.id), version: current.version, state, basisHash };
    }
    return {
      workspace: {
        ownerProjectId: owner === null ? null : publicText(owner.projectId),
        targetRootIdentity: owner?.targetRootIdentity ?? null,
        projectionSchemaVersion: head.schemaVersion,
        eventSequence: head.lastSequence,
        eventHeadSha256: head.headHash,
      },
      mission,
    };
  });
}

function inspectSupervisor(repoRoot: string, profile: RecordObservation | null) {
  const configured = profile?.record.profile;
  const paths = configured === undefined ? [repoRoot] : [
    repoRoot, profile?.registryRoot ?? repoRoot, configured.targetRoot, configured.workspaceRoot,
    configured.shadowRoot, configured.integrations.chrome.dedicatedProfileDirectory,
  ];
  const roots = paths.map((path) => resolvePathIdentity(path, {
    zone: 'clue-owned-state', expectedKind: 'directory', mustExist: false,
  }).canonicalPath);
  const supervisor = resolveWindowsSupervisor();
  if (roots.some((root) => containsPath(root, supervisor.command))) {
    throw new Error('The supervisor executable must be outside the CLU-E operating roots.');
  }
  const qualificationSha256 = requireWindowsSupervisorQualification(supervisor, process.env, roots);
  return { kind: 'windows-supervisor' as const, sha256: supervisor.sha256, qualificationSha256 };
}

function gitAction(code: string): string {
  switch (code) {
    case 'GIT_EXTERNAL_FILTER_CONFIGURED':
    case 'GIT_FILTER_CONFIGURATION_UNVERIFIED':
      return 'Use a trusted checkout whose tracked files can be inspected without external Git filters.';
    case 'GIT_SUBMODULES_REQUIRE_REVIEW':
      return 'Use a preflight target without submodule worktrees or arrange a separately reviewed Git inspection.';
    case 'GIT_UNAVAILABLE':
      return 'Install a trusted Git executable outside the checkout and put it on PATH.';
    case 'GIT_BASE_PIN_MISMATCH':
      return 'Review HEAD and the saved Git base pin in the Project Profile.';
    case 'DIRTY_WORKTREE':
      return 'Review tracked and untracked changes and prepare a clean checkout before the proof pilot.';
    case 'DETACHED_HEAD':
    case 'PROFILE_BRANCH_MISMATCH':
      return 'Check out the branch selected in the active Project Profile.';
    default:
      return 'Review the local checkout and the saved Git settings for the active Project Profile.';
  }
}

const liveAcceptance = Object.freeze({
  status: 'NOT_RUN' as const,
  detail: 'This preflight inspects saved configuration and local evidence. Live Windows acceptance is separate.',
  checks: ['PowerShell Host execution', 'Chrome target and GPU run', 'Exact-model OpenAI request',
    'Two-profile isolation', 'Native proof execution', 'Creator v10 acceptance'],
});

/** Static prerequisites only. The report is never a proof, connection, or Creator acceptance receipt. */
export function runWindowsPreflight(repoRoot: string) {
  const installationRoot = resolve(repoRoot);
  const checkedAt = new Date().toISOString();
  const checks: WindowsPreflightCheck[] = [];
  const pass = (id: string, code: string, detail: string) =>
    checks.push({ id, state: 'PASS', code, detail });
  const block = (id: string, code: string, detail: string, action: string) =>
    checks.push({ id, state: 'BLOCKED', code, detail, action });
  const skip = (id: string, code: string, detail: string) =>
    checks.push({ id, state: 'NOT_RUN', code, detail });

  let profile: RecordObservation | null = null;
  let authority: ReturnType<typeof authorityFacts> | null = null;
  let benchmark: ReturnType<typeof benchmarkFacts> | null = null;
  let git: ReturnType<typeof gitFacts> | null = null;
  let localProof: ReturnType<typeof localProofFacts> | null = null;
  let documentation: ReturnType<typeof inspectDocumentation> | null = null;
  let catalogue: ReturnType<typeof inspectCatalogue> | null = null;
  let workspace: ReturnType<typeof inspectWorkspace>['workspace'] | null = null;
  let mission: ReturnType<typeof inspectWorkspace>['mission'] = null;
  let supervisor: ReturnType<typeof inspectSupervisor> | null = null;

  if (process.platform === 'win32') {
    pass('platform', 'WINDOWS_HOST', 'Native Windows installation.');
  } else {
    skip('platform', 'WINDOWS_REQUIRED', 'Run on the target Windows installation for native preflight.');
  }
  try {
    profile = observeProfile(installationRoot);
    if (profile === null) {
      block('activeProfile', 'STARTUP_SELECTOR_MISSING', 'No Configuration-v3 startup profile is selected.',
        'Open the dashboard and complete the reviewed Project Profile selection before rerunning.');
    } else {
      pass('activeProfile', 'ACTIVE_PROFILE_VERIFIED', 'Read the current registry selection and verified the saved profile hash.');
    }
  } catch (error) {
    block('activeProfile', errorCode(error, 'STARTUP_PROFILE_UNREADABLE'),
      'The active startup profile could not be verified.',
      'Review the active profile in dashboard Configuration. Finish or recover any pending profile transaction before rerunning.');
  }

  try {
    documentation = inspectDocumentation(installationRoot);
    pass('documentation', 'ACTIVE_DOCUMENTATION_SEAL_VERIFIED', 'The active documentation seal and manifest match the installed files.');
  } catch {
    block('documentation', 'ACTIVE_DOCUMENTATION_SEAL_UNVERIFIED', 'The active documentation seal or manifest could not be verified.',
      'Verify the installed documentation pack before choosing or promoting a successor pack.');
  }

  try {
    catalogue = inspectCatalogue(installationRoot);
    if (catalogue.productionReady) {
      pass('catalogue', 'METRIC_CATALOGUE_READY', 'The installed Metric Catalogue is valid for production measurement.');
    } else {
      block('catalogue', 'METRIC_CATALOGUE_NOT_PRODUCTION_READY', 'The installed catalogue is valid historical data but fails current production requirements.',
        'Restore the active production catalogue and verify its normative source.');
    }
  } catch {
    block('catalogue', 'METRIC_CATALOGUE_INVALID', 'The installed Metric Catalogue could not be validated.',
      'Review config/measurements/catalogue.yaml against the governed catalogue.');
  }

  if (profile !== null) {
    const { record } = profile;
    try {
      const observed = inspectProjectAuthority(record);
      const conflicts = assessAuthorityConflicts(observed);
      authority = authorityFacts(observed, conflicts.state);
      if (observed.proofReady && conflicts.state === 'CLEAR') {
        pass('authority', 'PROJECT_AUTHORITY_CURRENT', 'The governed documents match the saved Project Profile.');
      } else {
        const code = conflicts.state !== 'CLEAR' ? 'AUTHORITY_CONFLICT'
          : observed.state === 'CURRENT' ? 'PROJECT_AUTHORITY_NOT_PROOF_READY' : `PROJECT_AUTHORITY_${observed.state}`;
        block('authority', code, 'The governed document binding is incomplete, invalid, changed, or conflicted.',
          'Review the configured and observed digests. Restore the approved files or explicitly validate and activate a successor profile.');
      }

      const resolvedBenchmark = resolveProjectBenchmarkRuntime(record, observed.manifest);
      benchmark = benchmarkFacts(record, resolvedBenchmark);
      if (resolvedBenchmark.state === 'READY') {
        pass('benchmark', 'MASTER_BENCHMARK_RUNTIME_READY', 'The registered Master Benchmark and runtime configuration agree.');
      } else {
        block('benchmark', `BENCHMARK_RUNTIME_${resolvedBenchmark.state}`, 'The Master Benchmark contract or runtime configuration is unresolved.',
          'Review the benchmark issue codes and align the registered contract, harness, and runtime settings.');
      }

      let recognition: ReturnType<typeof resolveProjectRecognitionConfiguration> | null = null;
      try {
        recognition = resolveProjectRecognitionConfiguration(record);
        pass('recognition', 'RECOGNITION_CONFIGURATION_READY', 'The exact profile has a valid recognition configuration.');
      } catch (error) {
        block('recognition', errorCode(error, 'PROJECT_RECOGNITION_INVALID'), 'The recognition configuration could not be verified.',
          'Review the target source roots and recognition settings in the saved profile.');
      }

      const inspectedGit = inspectProjectGitReadiness(record, { runGit: preflightGitRunner, checkedAt });
      git = gitFacts(inspectedGit);
      const gitBlocker = !inspectedGit.localOperationsReady ? inspectedGit.code
        : inspectedGit.branch === null ? 'DETACHED_HEAD'
          : inspectedGit.branch !== inspectedGit.defaultBranch ? 'PROFILE_BRANCH_MISMATCH'
            : inspectedGit.dirty !== false ? 'DIRTY_WORKTREE' : null;
      if (gitBlocker === null) {
        pass('git', inspectedGit.code, 'The local checkout is clean, attached, and on the saved profile branch.');
      } else {
        block('git', gitBlocker, 'The local checkout did not meet the profile branch, HEAD, or clean-worktree requirements.',
          gitAction(gitBlocker));
      }

      const assessment = assessProjectReadiness({
        record, authority: observed, authorityConflicts: conflicts, benchmarkRuntime: resolvedBenchmark,
        recognition, host: null, git: inspectedGit, browser: null, gateway: null,
        metricCatalogueValid: catalogue?.productionReady === true,
        requirements: { browserBenchmark: false }, checkedAt,
      });
      localProof = localProofFacts(assessment, gitBlocker);
      if (!localProof.ready && checks.every(({ state }) => state !== 'BLOCKED')) {
        block('localProof', 'LOCAL_PROOF_PREREQUISITES_UNVERIFIED', 'The required local proof capabilities are incomplete.',
          'Review the localProof capability states before the proof pilot.');
      }
    } catch (error) {
      block('projectValidation', errorCode(error, 'PROJECT_STATIC_VALIDATION_UNVERIFIED'), 'Some profile settings could not be verified.',
        'Review the active Project Profile configuration and the resolved target paths.');
    }

    try {
      ({ workspace, mission } = inspectWorkspace(installationRoot, profile));
      pass('workspace', 'WORKSPACE_OWNERSHIP_VERIFIED', 'The workspace belongs to the active profile and its projections match the verified event log.');
      if (mission?.state === 'CURRENT') {
        pass('mission', 'MISSION_BASIS_CURRENT', 'The registered mission agrees with the current governed inputs.');
      } else {
        block('mission', mission === null ? 'MISSION_MISSING' : 'MISSION_BASIS_STALE',
          'No current verified mission basis was found for this profile.',
          'Review the governed documents and use the documented workspace and mission registration procedure.');
      }
    } catch (error) {
      block('workspace', errorCode(error, 'WORKSPACE_UNVERIFIED'),
        'Workspace ownership or a stable projection and event-log snapshot could not be verified.',
        'Close CLU-E and retry. Verify the workspace exists and the OS temp directory is outside all CLU-E operating roots, with room for the database and WAL.');
      skip('mission', 'WORKSPACE_REQUIRED', 'A verified workspace is required to read the current mission.');
    }
  }

  if (process.platform !== 'win32') {
    skip('supervisor', 'WINDOWS_REQUIRED', 'Only native Windows can verify the installed supervisor and qualification.');
  } else {
    try {
      supervisor = inspectSupervisor(installationRoot, profile);
      pass('supervisor', 'WINDOWS_SUPERVISOR_QUALIFICATION_VERIFIED',
        'The installed supervisor and native qualification receipt match their configured SHA-256 pins.');
    } catch {
      block('supervisor', 'WINDOWS_SUPERVISOR_UNVERIFIED', 'The supervisor pin or native qualification receipt could not be verified.',
        'Review CLUE-Windows-Setup.bat and CLUE-Windows-Qualify-Proof-Supervisor.bat. Keep the executable and receipt outside CLU-E operating roots.');
    }
  }

  if (profile !== null) {
    let stable = false;
    try {
      const current = observeProfile(installationRoot);
      stable = current !== null && current.registryRoot === profile.registryRoot &&
        current.record.profile.projectId === profile.record.profile.projectId &&
        current.record.generation === profile.record.generation &&
        current.record.projectProfileHash === profile.record.projectProfileHash;
    } catch {
      // An unstable selector or registry is itself a blocker.
    }
    if (!stable) {
      block('profileStability', 'STARTUP_POINTER_STALE', 'The active profile changed during inspection.',
        'Wait for profile updates to finish and rerun preflight.');
    }
  }
  const blockers = checks.filter(({ state }) => state === 'BLOCKED');
  const status = process.platform !== 'win32' ? 'NOT_WINDOWS'
    : blockers.length === 0 ? 'READY_FOR_LOCAL_PROOF_PREFLIGHT' : 'BLOCKED';
  return {
    schemaVersion: 'clue-windows-preflight/1' as const,
    checkedAt,
    platform: process.platform,
    installationRoot: publicText(installationRoot),
    status,
    profile: profile === null ? null : profileFacts(profile),
    documentation, catalogue, authority, benchmark, git, localProof, workspace, mission, supervisor,
    liveAcceptance, checks, blockers,
  } as const;
}

export type WindowsPreflightReport = ReturnType<typeof runWindowsPreflight>;

function authorityFacts(authority: ReturnType<typeof inspectProjectAuthority>, conflictState: string) {
  return {
    state: authority.state,
    conflictState,
    configuredAuthoritySha256: authority.configuredAuthorityHash,
    manifestSha256: authority.manifest?.manifestHash ?? null,
    documents: authority.documents.map((document) => ({
      bindingId: publicText(document.bindingId),
      kind: document.kind,
      path: publicText(document.configuredPath),
      state: document.state,
      configuredSha256: document.configuredSha256,
      observedSha256: document.observedSha256,
    })),
    issues: authority.issues.map((issue) => ({ code: issue.code, bindingId: issue.bindingId === null ? null : publicText(issue.bindingId) })),
  };
}

function benchmarkFacts(record: ProjectProfileRecord, runtime: ReturnType<typeof resolveProjectBenchmarkRuntime>) {
  const binding = record.profile.authority.masterBenchmark;
  return {
    state: runtime.state,
    id: binding?.benchmarkId == null ? null : publicText(binding.benchmarkId),
    version: binding?.benchmarkVersion == null ? null : publicText(binding.benchmarkVersion),
    contractSha256: runtime.masterBenchmarkHash,
    runtimeSha256: runtime.runtimeHash,
    consistencySha256: runtime.consistencyHash,
    browserRequired: runtime.browserRequired,
    issueCodes: runtime.issues.map(({ code }) => code),
  };
}

function gitFacts(git: ReturnType<typeof inspectProjectGitReadiness>) {
  return {
    state: git.state,
    code: git.code,
    repositoryRoot: publicText(git.repositoryRoot),
    repositoryTopLevel: git.repositoryTopLevel === null ? null : publicText(git.repositoryTopLevel),
    branch: git.branch === null ? null : publicText(git.branch),
    defaultBranch: publicText(git.defaultBranch),
    head: git.head === null ? null : publicText(git.head),
    dirty: git.dirty,
    publicationMode: git.publicationMode,
  };
}

function localProofFacts(assessment: ProjectReadinessAssessment, gitBlocker: string | null) {
  const requiredCapabilityCodes = Object.entries(assessment.capabilities)
    .filter(([, item]) => item.required)
    .map(([name, { state, code }]) => ({ name, state, code }));
  return {
    level: gitBlocker === null ? assessment.level : 'BLOCKED',
    ready: assessment.readyForRequestedOperations && gitBlocker === null,
    requiredCapabilityCodes,
  };
}
