/** Lease-local profile for the supervised Windows CLU-E self-target benchmark. */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, hashBytes, type Sha256 } from '../../shared/ids.js';
import { normalisePathForStorage, resolveTargetRootIdentity } from '../../shared/pathIdentity.js';
import type { GovernedDocumentBinding, ProjectProfileRecord } from '../../shared/schemas.js';
import { captureBenchmarkProfileInputs, type PreparedBenchmarkProfileInputs } from './benchmarkProfileInputs.js';
import { canonicalProfileWithHash, assertProjectProfileHash } from './profileHash.js';
import { requireCurrentProjectAuthority } from './projectAuthority.js';

export interface ShadowBenchmarkProfileInputs extends PreparedBenchmarkProfileInputs {
  readonly receipt: {
    readonly canonicalProfileHash: string;
    readonly canonicalAuthoritySha256: Sha256;
    readonly shadowProfileHash: string;
    readonly shadowAuthoritySha256: Sha256;
    readonly shadowMission: string;
    readonly capsuleSha256: Sha256;
  };
}

/** Preserve input spelling where it is relative. Absolute inputs must relocate with the tree. */
function relocateTargetPath(target: string, shadow: string, path: string): string {
  const delta = relative(target, resolve(target, path));
  if (isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) {
    throw new Error('Candidate benchmark input escapes the canonical target.');
  }
  return isAbsolute(path) ? normalisePathForStorage(join(shadow, delta)) : path;
}

export async function prepareShadowBenchmarkProfileInputs(input: {
  readonly canonical: ProjectProfileRecord;
  readonly shadow: string;
  readonly workspace: string;
  readonly verifyActiveProfile: () => void;
}): Promise<ShadowBenchmarkProfileInputs> {
  input.verifyActiveProfile();
  assertProjectProfileHash(input.canonical, 'Canonical proof profile');
  const { profile } = input.canonical;
  const canonicalManifest = requireCurrentProjectAuthority(input.canonical);
  const target = realpathSync.native(input.shadow);
  const workspace = realpathSync.native(input.workspace);
  const shadowParent = dirname(target);
  if (relative(realpathSync.native(profile.shadowRoot), shadowParent) !== '' ||
      relative(join(shadowParent, `${basename(target)}-workspace`), workspace) !== '') {
    throw new Error('Candidate workspace must be the exact lease-local sibling of the candidate tree.');
  }
  if (profile.benchmarkRuntime.targetUrl !== null) {
    throw new Error('Browser-backed candidate benchmarks require a separate reviewed instrument.');
  }

  const childShadow = join(shadowParent, `${basename(target)}-nested-shadow`);
  const childBrowser = join(shadowParent, `${basename(target)}-browser`);
  const authorityRoot = join(workspace, 'proof-authority');
  mkdirSync(authorityRoot);
  const relocateDocument = <T extends GovernedDocumentBinding>(binding: T): T => {
    if (!binding.enabled) return binding;
    const document = canonicalManifest.documents.find(({ bindingId }) => bindingId === binding.bindingId);
    if (document === undefined || document.sha256 !== binding.sha256 ||
        relative(document.canonicalPath, realpathSync.native(document.canonicalPath)) !== '') {
      throw new Error('Candidate authority differs from the verified canonical profile.');
    }
    const content = readFileSync(document.canonicalPath);
    if (content.byteLength !== document.bytes || hashBytes(content) !== document.sha256) {
      throw new Error('Candidate authority changed while it was staged.');
    }
    const file = join(authorityRoot, `${hashBytes(Buffer.from(binding.bindingId))}.md`);
    writeFileSync(file, content, { flag: 'wx' });
    const local = normalisePathForStorage(file);
    return { ...binding, path: local, canonicalPath: local };
  };

  const { targetDescription, masterBenchmark, projectIntent, additionalDocuments } = profile.authority;
  const record = {
    ...input.canonical,
    ...canonicalProfileWithHash({
      ...profile,
      targetRoot: target,
      targetRootIdentity: resolveTargetRootIdentity(target),
      workspaceRoot: workspace,
      shadowRoot: childShadow,
      authority: {
        targetDescription: targetDescription === null ? null : relocateDocument(targetDescription),
        masterBenchmark: masterBenchmark === null ? null : relocateDocument(masterBenchmark),
        projectIntent: projectIntent === null ? null : relocateDocument(projectIntent),
        additionalDocuments: additionalDocuments.map(relocateDocument),
      },
      recognition: {
        ...profile.recognition,
        buildConfig: profile.recognition.buildConfig === null
          ? null : relocateTargetPath(profile.targetRoot, target, profile.recognition.buildConfig),
      },
      benchmarkRuntime: {
        ...profile.benchmarkRuntime,
        workingDirectory: relocateTargetPath(profile.targetRoot, target, profile.benchmarkRuntime.workingDirectory),
        browserProfile: profile.benchmarkRuntime.browserProfile === null ? null : childBrowser,
      },
      integrations: {
        powershell: {
          ...profile.integrations.powershell,
          hostScript: join(target, 'scripts', 'clue-host.ps1'),
          projectRoot: target,
          workspaceRoot: workspace,
          shadowRoot: childShadow,
          autonomousProfile: 'disabled',
        },
        git: {
          ...profile.integrations.git,
          repositoryRoot: target,
          remote: null,
          provider: null,
          protectedLandingPolicy: null,
          currentBasePin: null,
          publicationMode: 'LOCAL_ONLY',
        },
        chrome: { ...profile.integrations.chrome, dedicatedProfileDirectory: childBrowser, targetUrl: null },
        gpt: {
          ...profile.integrations.gpt,
          enabled: false,
          modelId: null,
          credential: { source: 'global-default', defaultKey: 'gateway.credential', value: null },
        },
      },
      state: {
        databasePath: join(workspace, 'db', 'clue.db'),
        eventLogRoot: join(workspace, 'events'),
        artifactStoreRoot: join(workspace, 'blobs'),
        greatBookScope: profile.projectId,
        recognitionRoot: join(workspace, 'recognition'),
        proofRoot: join(workspace, 'proof-contracts'),
        cycleRoot: join(workspace, 'cycles'),
        snapshotRoot: join(workspace, 'snapshots'),
      },
      provenance: { source: 'native' },
    }),
  };
  const stagedManifest = requireCurrentProjectAuthority(record);
  const comparable = (documents: typeof stagedManifest.documents) =>
    canonicalJson(documents.map(({ bindingId, kind, role, order, sha256, bytes }) => ({ bindingId, kind, role, order, sha256, bytes })));
  if (comparable(canonicalManifest.documents) !== comparable(stagedManifest.documents)) {
    throw new Error('Candidate authority inventory changed during relocation.');
  }

  // Bootstrap with the trusted host runtime. The measured build cannot initialize the
  // canonical registry, and the fixed supervised worker can only open this local mission.
  const { createWorkspaceLayout, openProjectRuntime } = await import('../runtime.js');
  createWorkspaceLayout(workspace);
  const runtime = openProjectRuntime(record, {
    repoRoot: target, withLog: true, verifyLog: 'full', workspaceIdentityOnMissing: 'initialize-new',
  });
  let missionVersion: string;
  try {
    if (runtime.projectBinding?.authorityConflicts.state !== 'CLEAR' ||
        runtime.projectBinding.benchmarkRuntime.state !== 'READY' || runtime.mission?.current() !== null) {
      throw new Error('Candidate benchmark workspace is not fresh or its profile authority is invalid.');
    }
    missionVersion = runtime.mission.bootstrap().mission.id;
  } finally {
    runtime.dispose();
  }

  const verifyCurrent = () => {
    input.verifyActiveProfile();
    if (requireCurrentProjectAuthority(input.canonical).manifestHash !== canonicalManifest.manifestHash ||
        requireCurrentProjectAuthority(record).manifestHash !== stagedManifest.manifestHash) {
      throw new Error('Canonical or candidate profile authority changed during benchmark execution.');
    }
  };
  verifyCurrent();
  const bytes = captureBenchmarkProfileInputs({ repoRoot: target, missionVersion, record, documents: stagedManifest.documents });
  return {
    bytes,
    verifyCurrent,
    receipt: {
      canonicalProfileHash: input.canonical.projectProfileHash,
      canonicalAuthoritySha256: canonicalManifest.manifestHash,
      shadowProfileHash: record.projectProfileHash,
      shadowAuthoritySha256: stagedManifest.manifestHash,
      shadowMission: missionVersion,
      capsuleSha256: hashBytes(bytes),
    },
  };
}
