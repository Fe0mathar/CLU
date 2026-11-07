/** Bootstrap one native workspace without publishing or switching a project. */

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { MissionDriftError } from '../mission.js';
import {
  createWorkspaceLayout,
  loadLegacyConfig,
  openProjectRuntime,
  resolveConfigPaths,
  WORKSPACE_DIRECTORIES,
} from '../runtime.js';
import { KERNEL_EVENT_TYPES } from '../../memory/db.js';
import { EventLog } from '../../memory/eventLog.js';
import type { MissionVersion, ProjectProfileRecord, WorkspaceProjectIdentity } from '../../shared/schemas.js';
import { normaliseIdentityPath, resolvePathIdentity } from '../../shared/pathIdentity.js';
import type { ProjectProfileRegistry } from './profileRegistry.js';
import {
  ProfilePersistenceError,
  readJsonFile,
  removeFileDurably,
  withExclusiveFileLock,
  writeJsonAtomically,
} from './profileFileSystem.js';

export interface ProjectWorkspaceBootstrapOptions {
  readonly repoRoot: string;
  readonly registry: ProjectProfileRegistry;
  readonly projectId: string;
  readonly expectedGeneration: number;
  readonly expectedProfileHash: string;
}

export interface ProjectWorkspaceBootstrapResult {
  readonly state: 'INITIALIZED' | 'ALREADY_INITIALIZED' | 'RESUMED' | 'REFRESHED';
  readonly projectId: string;
  readonly profileGeneration: number;
  readonly projectProfileHash: string;
  readonly targetRootIdentity: string;
  readonly workspaceIdentityOrigin: WorkspaceProjectIdentity['origin'];
  readonly missionId: string;
  readonly missionVersion: number;
}

export class ProjectWorkspaceBootstrapError extends Error {
  public constructor(
    public readonly code:
      | 'WORKSPACE_BOOTSTRAP_PROFILE_CHANGED'
      | 'WORKSPACE_BOOTSTRAP_NATIVE_REQUIRED'
      | 'WORKSPACE_BOOTSTRAP_PATH_UNSAFE'
      | 'WORKSPACE_BOOTSTRAP_CONFLICT'
      | 'WORKSPACE_BOOTSTRAP_LOCKED',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectWorkspaceBootstrapError';
  }
}

export function bootstrapProjectWorkspace(options: ProjectWorkspaceBootstrapOptions): ProjectWorkspaceBootstrapResult {
  try {
    return options.registry.withStableProfile(options.projectId, (record) => {
      if (record.generation !== options.expectedGeneration || record.projectProfileHash !== options.expectedProfileHash) {
        throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PROFILE_CHANGED', 'The saved Project Profile changed. Read its current generation before initializing.');
      }
      if (record.profile.provenance.source !== 'native') {
        throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_NATIVE_REQUIRED', 'Only a native Project Profile can initialize a new workspace.');
      }

      const workspace = validateWorkspacePaths(options, record);
      const lockPath = join(workspace, '.clue-workspace-bootstrap.lock');
      safePath(lockPath, 'file');
      return withExclusiveFileLock(lockPath, () => {
        validateWorkspacePaths(options, record);
        return initializeWorkspace(options.repoRoot, record, workspace);
      });
    });
  } catch (error) {
    if (error instanceof ProfilePersistenceError && error.code === 'LOCKED') {
      throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_LOCKED', error.message);
    }
    throw error;
  }
}

function initializeWorkspace(repoRoot: string, record: ProjectProfileRecord, workspace: string): ProjectWorkspaceBootstrapResult {
  const { databasePath, eventLogRoot, artifactStoreRoot } = record.profile.state;
  const logRoot = join(workspace, 'logs');
  const markerPath = join(workspace, '.clue-workspace-bootstrap.json');
  const hasDatabase = entryAt(databasePath) !== null;
  const hasMarker = entryAt(markerPath) !== null;
  let refreshBasis = false;

  if (hasDatabase) {
    // A writable ProjectionStore can migrate SQLite before it checks ownership.
    const observer = openProjectRuntime(record, { repoRoot, withLog: false, readOnly: true });
    try {
      const mission = observer.mission;
      const ownership = observer.projections.workspaceIdentity();
      if (mission === null || ownership?.origin !== 'new-workspace') {
        throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', 'The native profile does not own a native workspace with a mission registry.');
      }
      if (mission.current() !== null) {
        try {
          const current = mission.requireCurrentBasis();
          if (observer.projectionsStale === false) {
            if (hasMarker) {
              assertBootstrapMarker(markerPath, record);
              removeFileDurably(markerPath);
            }
            return receipt('ALREADY_INITIALIZED', record, ownership, current);
          }
        } catch (error) {
          if (!(error instanceof MissionDriftError)) throw error;
          refreshBasis = true;
        }
      }
      if (!hasMarker && observer.projectionsStale !== false) {
        throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', 'Workspace projections do not match the durable event history. Diagnose their state before initializing.');
      }
    } finally {
      observer.dispose();
    }
  }

  const marker = hasMarker ? assertBootstrapMarker(markerPath, record) : null;
  if (!hasDatabase || (!hasMarker && !refreshBasis)) {
    for (const root of [eventLogRoot, artifactStoreRoot, logRoot]) {
      if (entryAt(root) !== null && readdirSync(root).length !== 0) {
        throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', `Workspace contains existing history at ${root}.`);
      }
    }
  } else {
    for (const root of [eventLogRoot, artifactStoreRoot, logRoot]) assertUnredirectedTree(root);
  }
  if (marker !== null) {
    assertBootstrapHistory(eventLogRoot, marker);
  } else {
    const head = EventLog.readHead(eventLogRoot);
    writeJsonAtomically(markerPath, {
      ...bootstrapMarker(record),
      eventSequence: head?.sequence ?? 0,
      eventHash: head?.hash ?? null,
    }, { createOnly: true });
  }

  createWorkspaceLayout(workspace);
  const runtime = openProjectRuntime(record, {
    repoRoot,
    withLog: true,
    verifyLog: 'full',
    workspaceIdentityOnMissing: hasDatabase ? 'reject' : 'initialize-new',
  });
  try {
    runtime.projections.sync(runtime.requireLog());
    const mission = runtime.mission;
    const ownership = runtime.projections.workspaceIdentity();
    if (mission === null || ownership === null) {
      throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', 'The workspace did not publish a mission registry and project ownership.');
    }
    const current = refreshBasis ? mission.bootstrap().mission : mission.current() ?? mission.bootstrap().mission;
    removeFileDurably(markerPath);
    return receipt(hasMarker ? 'RESUMED' : refreshBasis ? 'REFRESHED' : hasDatabase ? 'RESUMED' : 'INITIALIZED', record, ownership, current);
  } finally {
    runtime.dispose();
  }
}

function bootstrapMarker(record: ProjectProfileRecord) {
  return {
    version: 'clue-workspace-bootstrap/1',
    projectId: record.profile.projectId,
    generation: record.generation,
    projectProfileHash: record.projectProfileHash,
  };
}

function assertBootstrapMarker(path: string, record: ProjectProfileRecord): { eventSequence: number; eventHash: string | null } {
  const marker = readJsonFile(path);
  if (marker === null || typeof marker !== 'object' ||
      !Object.entries(bootstrapMarker(record)).every(([key, value]) => Reflect.get(marker, key) === value)) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', 'Workspace has an initialization marker for a different saved profile.');
  }
  const eventSequence: unknown = Reflect.get(marker, 'eventSequence');
  const eventHash: unknown = Reflect.get(marker, 'eventHash');
  if (typeof eventSequence !== 'number' || !Number.isSafeInteger(eventSequence) || eventSequence < 0 ||
      (eventSequence === 0 ? eventHash !== null : typeof eventHash !== 'string' || !/^[0-9a-f]{64}$/u.test(eventHash))) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', 'Workspace initialization marker has an invalid event head.');
  }
  return { eventSequence, eventHash: eventHash as string | null };
}

function assertBootstrapHistory(eventsRoot: string, marker: { eventSequence: number; eventHash: string | null }): void {
  let anchorMatches = marker.eventSequence === 0;
  const bootstrapEvents: ReadonlySet<string> = new Set(Object.values(KERNEL_EVENT_TYPES));
  for (const event of EventLog.replayReadOnly(eventsRoot)) {
    if (event.sequence === marker.eventSequence) anchorMatches = event.hash === marker.eventHash;
    if (event.sequence > marker.eventSequence && (event.actor !== 'daemon' || !bootstrapEvents.has(event.type))) {
      throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', 'Workspace has unrelated events after the interrupted initialization.');
    }
  }
  if (!anchorMatches) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', 'Workspace event history differs from the start of the interrupted initialization.');
  }
}

function receipt(
  state: ProjectWorkspaceBootstrapResult['state'],
  record: ProjectProfileRecord,
  ownership: WorkspaceProjectIdentity,
  mission: MissionVersion,
): ProjectWorkspaceBootstrapResult {
  return {
    state,
    projectId: record.profile.projectId,
    profileGeneration: record.generation,
    projectProfileHash: record.projectProfileHash,
    targetRootIdentity: record.profile.targetRootIdentity,
    workspaceIdentityOrigin: ownership.origin,
    missionId: mission.id,
    missionVersion: mission.version,
  };
}

function validateWorkspacePaths(options: ProjectWorkspaceBootstrapOptions, record: ProjectProfileRecord): string {
  const profile = record.profile;
  const workspace = safePath(profile.workspaceRoot, 'directory');
  const target = resolvePathIdentity(profile.targetRoot, { zone: 'target', expectedKind: 'directory' });
  if (target.identity !== profile.targetRootIdentity) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PATH_UNSAFE', 'The physical Target Root identity changed.');
  }
  const legacy = resolveConfigPaths(loadLegacyConfig(options.repoRoot), options.repoRoot);
  const otherRoots = [
    target.canonicalPath,
    profile.shadowRoot,
    profile.integrations.chrome.dedicatedProfileDirectory,
    options.registry.root,
    legacy.project.root,
    legacy.workspace.root,
    legacy.shadow.root,
    legacy.browser.profile_dir,
  ];
  for (const { record: other } of options.registry.list()) {
    if (other.profile.projectId === profile.projectId) continue;
    otherRoots.push(other.profile.workspaceRoot, other.profile.targetRoot, other.profile.shadowRoot,
      other.profile.integrations.chrome.dedicatedProfileDirectory);
  }
  for (const root of otherRoots) {
    assertDisjoint(workspace, physicalPath(root, 'directory'));
  }

  const { databasePath, eventLogRoot, artifactStoreRoot, greatBookScope: _scope, ...stateDirectories } = profile.state;
  const database = safePath(databasePath, 'file');
  const events = safePath(eventLogRoot, 'directory');
  const artifacts = safePath(artifactStoreRoot, 'directory');
  const logs = safePath(join(workspace, 'logs'), 'directory');
  for (const directory of [...Object.values(stateDirectories), ...WORKSPACE_DIRECTORIES.map((name) => join(workspace, name))]) {
    requireWithin(workspace, safePath(directory, 'directory'));
  }
  for (const path of [database, events, artifacts, logs]) requireWithin(workspace, path);
  for (const [left, right] of [[database, events], [database, artifacts], [database, logs], [events, artifacts], [events, logs], [artifacts, logs]] as const) {
    assertDisjoint(left, right);
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = safePath(`${database}${suffix}`, 'file');
    if (entryAt(database) === null && entryAt(sidecar) !== null) {
      throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_CONFLICT', `Workspace has a SQLite sidecar without its database at ${sidecar}.`);
    }
  }
  safePath(join(events, 'events.ndjson'), 'file');
  safePath(join(workspace, '.clue-workspace-bootstrap.json'), 'file');
  return workspace;
}

function assertUnredirectedTree(root: string): void {
  if (entryAt(root) === null) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      assertUnredirectedTree(safePath(path, 'directory'));
    } else {
      safePath(path, 'file');
    }
  }
}

function entryAt(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function safePath(path: string, kind: 'directory' | 'file'): string {
  if (entryAt(path)?.isSymbolicLink()) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PATH_UNSAFE', `Workspace path is a link at ${path}.`);
  }
  const canonical = physicalPath(path, kind);
  if (normaliseIdentityPath(canonical) !== normaliseIdentityPath(resolve(path))) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PATH_UNSAFE', `Workspace path redirects through a link at ${path}.`);
  }
  return canonical;
}

/** Resolve the nearest existing ancestor as well as the leaf, which can be absent. */
function physicalPath(path: string, kind: 'directory' | 'file'): string {
  const leaf = resolvePathIdentity(path, { zone: 'clue-owned-state', expectedKind: kind, mustExist: false });
  if (entryAt(path) !== null) {
    const stat = statSync(path);
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
      throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PATH_UNSAFE', `Unexpected path kind at ${path}.`);
    }
    if (kind === 'file' && stat.nlink !== 1) {
      throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PATH_UNSAFE', `Workspace file has additional hard links at ${path}.`);
    }
    return leaf.canonicalPath;
  }
  let parent = dirname(leaf.canonicalPath);
  while (entryAt(parent) === null && dirname(parent) !== parent) parent = dirname(parent);
  const resolvedParent = resolvePathIdentity(parent, { zone: 'clue-owned-state', expectedKind: 'directory' });
  return join(resolvedParent.canonicalPath, relative(parent, leaf.canonicalPath));
}

function strictlyWithin(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent !== '' && fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function requireWithin(parent: string, child: string): void {
  if (!strictlyWithin(parent, child)) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PATH_UNSAFE', `Workspace state ${child} is outside ${parent}.`);
  }
}

function assertDisjoint(left: string, right: string): void {
  if (normaliseIdentityPath(left) === normaliseIdentityPath(right) || strictlyWithin(left, right) || strictlyWithin(right, left)) {
    throw new ProjectWorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_PATH_UNSAFE', `Workspace paths overlap at ${left} and ${right}.`);
  }
}
