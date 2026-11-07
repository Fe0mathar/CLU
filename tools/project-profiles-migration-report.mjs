#!/usr/bin/env node
/**
 * Read-only legacy-to-Project-Profiles migration inventory.
 *
 * This command never creates a registry, adopts a workspace, moves an active pointer or writes the
 * Configuration-v3 selector. It records the exact starting state and the operator commands that may
 * be used later under explicit confirmations.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { externalReportPath, writeExternalReport } from './verification-support.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = argument('--output');
if (outputArg !== null) externalReportPath(repoRoot, outputArg);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function argument(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function slash(value) {
  return String(value).replace(/\\/gu, '/');
}

function windowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function parentTwice(value) {
  if (windowsAbsolute(value)) return slash(win32.dirname(win32.dirname(value)));
  return slash(dirname(dirname(resolve(repoRoot, value))));
}

function pathState(value) {
  if (typeof value !== 'string' || value.trim() === '') return { configured: value ?? null, state: 'MISSING' };
  if (windowsAbsolute(value) && process.platform !== 'win32') {
    return { configured: slash(value), state: 'HOST_NOT_AUTHORITATIVE' };
  }
  const absolute = windowsAbsolute(value) ? value : resolve(repoRoot, value);
  return {
    configured: slash(value),
    state: existsSync(absolute) ? (statSync(absolute).isDirectory() ? 'DIRECTORY_PRESENT' : 'FILE_PRESENT') : 'ABSENT',
  };
}

const configPath = join(repoRoot, 'config', 'clue.config.yaml');
if (!existsSync(configPath)) throw new Error('config/clue.config.yaml is absent');
const configBytes = readFileSync(configPath);
const config = parseYaml(configBytes.toString('utf8'));
const activeTargetId = config?.project?.active_target ?? null;
const targetProfilePath = typeof activeTargetId === 'string'
  ? join(repoRoot, 'targets', activeTargetId, 'profile.yaml')
  : null;
const targetProfile = targetProfilePath !== null && existsSync(targetProfilePath)
  ? parseYaml(readFileSync(targetProfilePath, 'utf8'))
  : null;
const selectorPath = join(repoRoot, 'config', 'project-profiles.yaml');
const selectorPresent = existsSync(selectorPath);
const defaultProfilesRoot = `${parentTwice(config?.workspace?.root ?? '')}/profiles`;
let configuredProfilesRoot = defaultProfilesRoot;
if (selectorPresent) {
  const selector = parseYaml(readFileSync(selectorPath, 'utf8'));
  if (typeof selector?.profiles?.registry_root === 'string') configuredProfilesRoot = selector.profiles.registry_root;
}

let registeredProfiles = [];
if (!(windowsAbsolute(configuredProfilesRoot) && process.platform !== 'win32') && existsSync(configuredProfilesRoot)) {
  const profilesDirectory = join(configuredProfilesRoot, 'profiles');
  if (existsSync(profilesDirectory)) {
    registeredProfiles = readdirSync(profilesDirectory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => name.slice(0, -5));
  }
}

const state = selectorPresent
  ? 'CUTOVER_ENABLED_REVIEW_REQUIRED'
  : registeredProfiles.length > 0
    ? 'MIGRATION_PARTIAL_REVIEW_REQUIRED'
    : 'PREPARED_NOT_EXECUTED';
const report = {
  schemaVersion: 'clue-project-profiles-migration-report/1',
  generatedAt: new Date().toISOString(),
  mode: 'READ_ONLY',
  state,
  repoRoot: slash(repoRoot),
  source: {
    configurationPath: 'config/clue.config.yaml',
    configurationVersion: config?.version ?? null,
    configurationSha256: sha256(configBytes),
    activeTargetId,
    targetProfilePath: targetProfilePath === null ? null : slash(targetProfilePath),
    targetProfileSha256: targetProfilePath !== null && existsSync(targetProfilePath)
      ? sha256(readFileSync(targetProfilePath))
      : null,
  },
  intendedIdentity: {
    projectId: targetProfile?.id ?? activeTargetId,
    targetRoot: targetProfile?.root ?? null,
    workspaceRoot: config?.workspace?.root ?? null,
    shadowRoot: config?.shadow?.root ?? null,
    profilesRoot: slash(configuredProfilesRoot),
    publicationState: targetProfile?.remote_decision?.state ?? null,
  },
  observed: {
    startupSelector: { path: 'config/project-profiles.yaml', present: selectorPresent },
    registeredProfiles,
    targetRoot: pathState(targetProfile?.root),
    workspaceRoot: pathState(config?.workspace?.root),
    shadowRoot: pathState(config?.shadow?.root),
    profilesRoot: pathState(configuredProfilesRoot),
  },
  executionPlan: [
    'npm run build',
    'node dist/src/cli/index.js project migrate-legacy --confirmation "MIGRATE LEGACY ACTIVE TARGET"',
    'Review the returned Project Profile record, exact Target Root identity, state roots and generation.',
    'Run the returned project adopt-legacy command with its exact state-bound phrase.',
    'node dist/src/cli/index.js project validate <project-id>',
    'Run project test-host, test-git, test-chrome and test-gpt as required by the intended operation.',
    'Run the returned project cutover-v3 command with its exact state-bound phrase.',
    'Restart CLU-E and verify project active plus Status 5.8.0 identity agreement.',
  ],
  safety: {
    automaticActionsPerformed: [],
    targetRepositoryModified: false,
    workspaceModified: false,
    shadowModified: false,
    registryModified: false,
    startupSelectorModified: false,
    gitSynchronizationPerformed: false,
    browserLaunched: false,
    openAiContacted: false,
    credentialBytesIncluded: false,
  },
  acceptanceRequired: [
    'The legacy workspace and its existing event/projection history remain intact.',
    'Workspace identity is adopted only through the explicit state-bound command.',
    'The Configuration-v2 file has a byte-exact backup before v3 cutover.',
    'The active profile, registry pointer, runtime generation, Status and dashboard agree.',
    'Rollback-v3 disables only startup selection and does not delete profile or workspace data.',
  ],
};
if (outputArg === null) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const output = writeExternalReport(repoRoot, outputArg, report);
  process.stdout.write(`Project Profiles migration report: ${state}\n`);
  process.stdout.write(`  output: ${slash(output)}\n`);
  process.stdout.write('  no migration, adoption or cutover action was performed\n');
}
