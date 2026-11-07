import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { ALWAYS_EXCLUDED, captureSnapshot, type SnapshotManifest } from '../analysis/source/snapshot.js';
import { canonicalJson, hashBytes } from '../shared/ids.js';

/** Full project input identity, separate from the configured recognition roots. */
export type ExactRunInputs = SnapshotManifest;

const GENERATED_PATHS = [
  'workspace', 'release', '.clue-shadow-lockfile-sha', '.clue-proof-lease.json',
  '.clue-proof-workspace', '.clue-proof-shadow',
] as const;
const NON_INPUTS: ReadonlySet<string> = new Set([...ALWAYS_EXCLUDED, ...GENERATED_PATHS]);

export function isExactRunInputPath(path: string): boolean {
  return path.split('/').every((component) => !NON_INPUTS.has(component.toLowerCase()));
}

export function captureExactRunInputs(root: string): ExactRunInputs {
  const manifest = captureSnapshot({ root, sourceRoots: ['.'], exclude: GENERATED_PATHS });
  const skipped = manifest.skipped[0];
  if (skipped !== undefined) {
    throw new Error(`Cannot pin exact run inputs: ${skipped.path} (${skipped.reason}).`);
  }
  return manifest;
}

export function assertExactRunInputs(root: string, expected: ExactRunInputs, label: string): void {
  const actual = captureExactRunInputs(root);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} inputs changed (expected ${expected.id.slice(0, 12)}, found ${actual.id.slice(0, 12)}). Capture a new run basis.`);
  }
}

/** Only bytes that match the pinned source manifest can enter the candidate lease. */
export function materializeExactRunInputs(source: string, destination: string, expected: ExactRunInputs): void {
  assertExactRunInputs(source, expected, 'Canonical project');
  const physicalSource = realpathSync.native(source);
  const physicalDestination = realpathSync.native(destination);
  for (const file of expected.files) {
    const segments = file.path.split('/');
    const from = join(physicalSource, ...segments);
    if (!lstatSync(from).isFile() || relative(from, realpathSync.native(from)) !== '') {
      throw new Error(`Pinned input is no longer a regular unlinked file: ${file.path}.`);
    }
    const bytes = readFileSync(from);
    if (hashBytes(bytes) !== file.hash || bytes.length !== file.bytes) {
      throw new Error(`Pinned input changed while copying: ${file.path}.`);
    }
    const to = join(physicalDestination, ...segments);
    const parent = dirname(to);
    mkdirSync(parent, { recursive: true });
    if (relative(parent, realpathSync.native(parent)) !== '') {
      throw new Error(`Candidate input directory resolves through a link: ${file.path}.`);
    }
    writeFileSync(to, bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
  }
  assertExactRunInputs(destination, expected, 'Prepared candidate');
  assertExactRunInputs(source, expected, 'Canonical project');
}
