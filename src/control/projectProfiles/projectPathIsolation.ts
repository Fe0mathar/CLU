/** Physical boundaries for one project's mutable runtime state. */

import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertPathZonesDisjoint,
  containsPath,
  normaliseIdentityPath,
  PathIdentityError,
  resolvePathIdentity,
  type ResolvedPathIdentity,
} from '../../shared/pathIdentity.js';
import type { ProjectProfile } from '../../shared/schemas.js';

export function resolveProjectOperatingZones(profile: ProjectProfile) {
  const zones = [
    resolvePathIdentity(profile.targetRoot, { zone: 'target', expectedKind: 'directory' }),
    resolvePathIdentity(profile.workspaceRoot, { zone: 'workspace', expectedKind: 'directory', mustExist: false }),
    resolvePathIdentity(profile.shadowRoot, { zone: 'shadow', expectedKind: 'directory', mustExist: false }),
    resolvePathIdentity(profile.integrations.chrome.dedicatedProfileDirectory, {
      zone: 'browser-profile', expectedKind: 'directory', mustExist: false,
    }),
  ] as const;
  assertPathZonesDisjoint(zones);
  return zones;
}

/** Revalidate after registration: aliases and links can appear before the next runtime open. */
export function assertProjectStatePaths(profile: ProjectProfile): void {
  const [, workspace] = resolveProjectOperatingZones(profile);
  assertUnredirected(workspace, 'directory');

  const { databasePath, eventLogRoot, artifactStoreRoot, greatBookScope: _scope, ...directories } = profile.state;
  const auditRoot = join(workspace.canonicalPath, 'logs');
  const legacyArtifacts = join(workspace.canonicalPath, 'blobs');
  if (profile.provenance.source === 'legacy-target-profile' &&
      normaliseIdentityPath(artifactStoreRoot) !== normaliseIdentityPath(legacyArtifacts) &&
      resolvePathIdentity(legacyArtifacts, { zone: 'clue-owned-state', expectedKind: 'directory', mustExist: false }).exists) {
    throw new PathIdentityError('ZONE_OVERLAP',
      `Migrated Project Profile must preserve its legacy artifact store at ${legacyArtifacts}. Review and update state.artifactStoreRoot before adoption or startup.`,
      artifactStoreRoot);
  }
  const stateRoots = [
    statePath(databasePath, 'file'),
    ...[eventLogRoot, artifactStoreRoot, auditRoot, ...Object.values(directories)]
      .map((path) => statePath(path, 'directory')),
  ];
  for (const path of stateRoots) {
    if (workspace.comparablePath === path.comparablePath || !containsPath(workspace.canonicalPath, path.canonicalPath)) {
      throw new PathIdentityError('ZONE_OVERLAP', `Project state ${path.displayPath} must be strictly inside ${workspace.displayPath}.`);
    }
  }
  assertPathZonesDisjoint(stateRoots);

  // These service-owned leaves can redirect I/O even when their configured roots are sound.
  for (const suffix of ['-wal', '-shm', '-journal']) statePath(`${databasePath}${suffix}`, 'file');
  for (const name of ['events.ndjson', 'events.ndjson.lock', 'checkpoint.json']) statePath(join(eventLogRoot, name), 'file');
  statePath(join(eventLogRoot, 'recovery'), 'directory');
  statePath(join(artifactStoreRoot, '.tmp'), 'directory');
  statePath(join(artifactStoreRoot, 'sha256'), 'directory');
  for (const name of ['audit.ndjson', 'audit-archive.json']) statePath(join(auditRoot, name), 'file');
  const graphRoot = join(workspace.canonicalPath, 'graph');
  statePath(graphRoot, 'directory');
  for (const name of ['system-navigator.ndjson', 'current.json', 'repository-inventory.current.json']) {
    statePath(join(graphRoot, name), 'file');
  }
}

function statePath(path: string, kind: 'directory' | 'file'): ResolvedPathIdentity {
  const result = resolvePathIdentity(path, { zone: 'clue-owned-state', expectedKind: kind, mustExist: false });
  assertUnredirected(result, kind);
  return result;
}

function assertUnredirected(path: ResolvedPathIdentity, kind: 'directory' | 'file'): void {
  const stats = path.exists ? lstatSync(path.inputPath) : null;
  if (path.comparablePath !== normaliseIdentityPath(resolve(path.inputPath)) || stats?.isSymbolicLink()) {
    throw new PathIdentityError('ZONE_OVERLAP', `Project state redirects through a link at ${path.inputPath}.`);
  }
  if (kind === 'file' && stats !== null && stats.nlink !== 1) {
    throw new PathIdentityError('ZONE_OVERLAP', `Project state file has additional hard links at ${path.inputPath}.`);
  }
}
