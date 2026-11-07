/** Strict loader for the Project Profiles Definition-of-Done acceptance matrix. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_PROFILES_ACCEPTANCE_MATRIX_VERSION =
  'clue-project-profiles-acceptance-matrix/1' as const;

export interface ProjectProfilesAcceptanceRequirement {
  readonly id: string;
  readonly title: string;
  readonly tests: readonly string[];
  readonly commands: readonly string[];
  readonly liveWindows: readonly string[];
}

export interface ProjectProfilesAcceptanceMatrix {
  readonly matrixVersion: typeof PROJECT_PROFILES_ACCEPTANCE_MATRIX_VERSION;
  readonly release: string;
  readonly requirements: readonly ProjectProfilesAcceptanceRequirement[];
  readonly regressionCommands: readonly string[];
  readonly authoritativeWindowsGates: readonly string[];
}

export class ProjectProfilesAcceptanceMatrixError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProjectProfilesAcceptanceMatrixError';
  }
}

export function loadProjectProfilesAcceptanceMatrix(
  repoRoot: string,
  relativePath = 'config/project-profiles-acceptance.matrix.json',
): ProjectProfilesAcceptanceMatrix {
  const full = join(repoRoot, relativePath);
  if (!existsSync(full)) {
    throw new ProjectProfilesAcceptanceMatrixError(`Acceptance matrix is missing: ${relativePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
  } catch (error) {
    throw new ProjectProfilesAcceptanceMatrixError(
      `Acceptance matrix is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateProjectProfilesAcceptanceMatrix(parsed, repoRoot);
}

export function validateProjectProfilesAcceptanceMatrix(
  input: unknown,
  repoRoot?: string,
): ProjectProfilesAcceptanceMatrix {
  const root = record(input, 'acceptance matrix');
  exactKeys(
    root,
    ['matrixVersion', 'release', 'requirements', 'regressionCommands', 'authoritativeWindowsGates'],
    'acceptance matrix',
  );
  if (root['matrixVersion'] !== PROJECT_PROFILES_ACCEPTANCE_MATRIX_VERSION) {
    throw new ProjectProfilesAcceptanceMatrixError(
      `Unsupported acceptance matrix version: ${String(root['matrixVersion'])}`,
    );
  }
  const release = nonEmpty(root['release'], 'release');
  const requirements = array(root['requirements'], 'requirements').map((item, index) =>
    requirement(item, index, repoRoot),
  );
  if (requirements.length === 0) {
    throw new ProjectProfilesAcceptanceMatrixError('Acceptance matrix must declare requirements.');
  }
  const ids = new Set<string>();
  for (const item of requirements) {
    if (ids.has(item.id)) {
      throw new ProjectProfilesAcceptanceMatrixError(`Duplicate acceptance requirement ID: ${item.id}`);
    }
    ids.add(item.id);
  }
  const regressionCommands = stringArray(root['regressionCommands'], 'regressionCommands', true);
  const authoritativeWindowsGates = stringArray(
    root['authoritativeWindowsGates'],
    'authoritativeWindowsGates',
    true,
  );
  return Object.freeze({
    matrixVersion: PROJECT_PROFILES_ACCEPTANCE_MATRIX_VERSION,
    release,
    requirements: Object.freeze(requirements),
    regressionCommands: Object.freeze(regressionCommands),
    authoritativeWindowsGates: Object.freeze(authoritativeWindowsGates),
  });
}

export function uniqueAcceptanceTestPaths(
  matrix: ProjectProfilesAcceptanceMatrix,
): readonly string[] {
  return Object.freeze(
    [...new Set(matrix.requirements.flatMap((requirement) => requirement.tests))].sort(compareUtf8),
  );
}

export function acceptanceTestRuntimePath(sourcePath: string): string {
  if (sourcePath.startsWith('selftest/') && sourcePath.endsWith('.ts')) {
    return `dist/${sourcePath.slice(0, -3)}.js`;
  }
  return sourcePath;
}

function requirement(
  input: unknown,
  index: number,
  repoRoot?: string,
): ProjectProfilesAcceptanceRequirement {
  const item = record(input, `requirements[${index}]`);
  exactKeys(item, ['id', 'title', 'tests', 'commands', 'liveWindows'], `requirements[${index}]`, true);
  const id = nonEmpty(item['id'], `requirements[${index}].id`);
  if (!/^PP-DOD-[0-9]{2}$/u.test(id)) {
    throw new ProjectProfilesAcceptanceMatrixError(`Invalid requirement ID: ${id}`);
  }
  const title = nonEmpty(item['title'], `requirements[${index}].title`);
  const tests = optionalStringArray(item['tests'], `requirements[${index}].tests`);
  const commands = optionalStringArray(item['commands'], `requirements[${index}].commands`);
  const liveWindows = optionalStringArray(item['liveWindows'], `requirements[${index}].liveWindows`);
  if (tests.length === 0 && commands.length === 0 && liveWindows.length === 0) {
    throw new ProjectProfilesAcceptanceMatrixError(`${id} has no acceptance evidence.`);
  }
  for (const path of tests) {
    if (!/^(selftest\/.+\.test\.ts|ui\/clue-dashboard\/test\/.+\.test\.mjs)$/u.test(path)) {
      throw new ProjectProfilesAcceptanceMatrixError(`${id}: unsupported test path ${path}`);
    }
    if (repoRoot !== undefined && !existsSync(join(repoRoot, path))) {
      throw new ProjectProfilesAcceptanceMatrixError(`${id}: referenced test does not exist: ${path}`);
    }
  }
  return Object.freeze({
    id,
    title,
    tests: Object.freeze(tests),
    commands: Object.freeze(commands),
    liveWindows: Object.freeze(liveWindows),
  });
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProjectProfilesAcceptanceMatrixError(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function array(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new ProjectProfilesAcceptanceMatrixError(`${label} must be an array.`);
  }
  return input;
}

function nonEmpty(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ProjectProfilesAcceptanceMatrixError(`${label} must be a non-empty string.`);
  }
  return input.trim();
}

function optionalStringArray(input: unknown, label: string): string[] {
  return input === undefined ? [] : stringArray(input, label, false);
}

function stringArray(input: unknown, label: string, requireNonEmpty: boolean): string[] {
  const values = array(input, label).map((value, index) => nonEmpty(value, `${label}[${index}]`));
  if (requireNonEmpty && values.length === 0) {
    throw new ProjectProfilesAcceptanceMatrixError(`${label} must not be empty.`);
  }
  if (new Set(values).size !== values.length) {
    throw new ProjectProfilesAcceptanceMatrixError(`${label} contains duplicate values.`);
  }
  return values;
}

function exactKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional = false,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new ProjectProfilesAcceptanceMatrixError(`${label} has unknown keys: ${unknown.join(', ')}`);
  }
  if (!optional) {
    const missing = allowed.filter((key) => !(key in input));
    if (missing.length > 0) {
      throw new ProjectProfilesAcceptanceMatrixError(`${label} is missing keys: ${missing.join(', ')}`);
    }
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
