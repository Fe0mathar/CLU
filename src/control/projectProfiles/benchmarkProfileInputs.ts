/** Exact active authority supplied to the fixed, supervised CLU benchmark worker. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import { hashBytes } from '../../shared/ids.js';
import { projectProfileRecordSchema, sha256Schema, type ProjectProfileRecord } from '../../shared/schemas.js';
import { assertProjectProfileHash } from './profileHash.js';
import type { ActiveAuthorityDocument } from './projectAuthority.js';

export const BENCHMARK_PROFILE_INPUTS_FILE = 'clue-benchmark-profile-inputs.json';
const MAX_CAPSULE_BYTES = 8 * 1024 * 1024;

/** Exact recovered clu-master@0.2.0 bytes in the supported LF and CRLF checkout forms. */
const CLU_V020_CONTRACT_HASHES = new Set<string>([
  'f4ed32fa892f2a9716db44d4d0dd458d5bb029993054fefa0d06c4c68f04199f',
  '377c2da40446dda8adc94ef90a5186e5a8a5afb01789c76f70ec2565385799cb',
]);

export function isBenchmarkProfileContract(sha256: string): boolean {
  return CLU_V020_CONTRACT_HASHES.has(sha256);
}

export interface PreparedBenchmarkProfileInputs {
  readonly bytes: Uint8Array;
  /** The host re-verifies the active generation and physical documents before each worker. */
  readonly verifyCurrent: () => void;
}

const capsuleSchema = z.object({
  version: z.literal(1),
  repoRoot: z.string().min(1),
  missionVersion: z.string().regex(/^MISSION-[0-9]+$/u),
  record: projectProfileRecordSchema,
  documents: z.array(z.object({
    bindingId: z.string().min(1),
    canonicalPath: z.string().min(1),
    sha256: sha256Schema,
    base64: z.string(),
  }).strict()).max(258),
}).strict();

type Capsule = z.infer<typeof capsuleSchema>;
type ActiveCapsule = Capsule & { readonly bytes: ReadonlyMap<string, Buffer> };
const scope = new AsyncLocalStorage<ActiveCapsule>();

function enabledDocuments(record: ProjectProfileRecord) {
  const authority = record.profile.authority;
  return [authority.targetDescription, authority.masterBenchmark, authority.projectIntent,
    ...authority.additionalDocuments].filter((entry) => entry !== null).filter((entry) => entry.enabled);
}

function assertRoot(capsule: Capsule, repoRoot: string): void {
  if (!isAbsolute(capsule.repoRoot) || relative(repoRoot, capsule.repoRoot) !== '' ||
      relative(repoRoot, resolve(capsule.record.profile.targetRoot)) !== '') {
    throw new Error('Supervised benchmark profile must bind the exact CLU-E self-target.');
  }
}

function readBoundedFile(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CAPSULE_BYTES) {
    throw new Error('Supervised benchmark input must be a bounded regular file.');
  }
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== info.size) {
      throw new Error('Supervised benchmark input changed while it was opened.');
    }
    const bytes = Buffer.alloc(info.size);
    for (let offset = 0; offset < bytes.byteLength;) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new Error('Supervised benchmark input was truncated.');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.byteLength) !== 0) {
      throw new Error('Supervised benchmark input grew while it was read.');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Called by the host after inspecting the current mission, profile and physical authority paths. */
export function captureBenchmarkProfileInputs(input: {
  readonly repoRoot: string;
  readonly missionVersion: string;
  readonly record: ProjectProfileRecord;
  readonly documents: readonly ActiveAuthorityDocument[];
}): Buffer {
  if (input.documents.reduce((size, document) => size + Math.ceil(document.bytes / 3) * 4, 0) > MAX_CAPSULE_BYTES) {
    throw new Error('Supervised benchmark authority inventory exceeds its size limit.');
  }
  const documents = input.documents.map(({ bindingId, canonicalPath, sha256, bytes }) => {
    if (relative(canonicalPath, realpathSync.native(canonicalPath)) !== '') {
      throw new Error('Supervised benchmark authority path changed during capture.');
    }
    const content = readBoundedFile(canonicalPath);
    if (content.byteLength !== bytes || hashBytes(content) !== sha256) {
      throw new Error('Supervised benchmark authority bytes changed during capture.');
    }
    return { bindingId, canonicalPath, sha256, base64: content.toString('base64') };
  });
  const bytes = Buffer.from(JSON.stringify({ version: 1, ...input, documents }), 'utf8');
  parseInputs(bytes, hashBytes(bytes), input.repoRoot);
  return bytes;
}

function parseInputs(bytes: Buffer, expectedSha256: string, repoRoot: string): ActiveCapsule {
  if (bytes.byteLength > MAX_CAPSULE_BYTES || hashBytes(bytes) !== expectedSha256) {
    throw new Error('Supervised benchmark profile input digest does not match.');
  }
  const capsule = capsuleSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  assertRoot(capsule, repoRoot);
  assertProjectProfileHash(capsule.record, 'Supervised benchmark profile');
  const enabled = enabledDocuments(capsule.record);
  if (capsule.documents.length !== enabled.length) {
    throw new Error('Supervised benchmark authority inventory differs from the profile.');
  }
  const inputs = new Map<string, Buffer>();
  for (const document of capsule.documents) {
    const expected = enabled.find(({ bindingId }) => bindingId === document.bindingId);
    const content = Buffer.from(document.base64, 'base64');
    if (expected === undefined || inputs.has(document.bindingId) ||
        document.canonicalPath !== expected.canonicalPath || document.sha256 !== expected.sha256 ||
        hashBytes(content) !== expected.sha256 || content.toString('base64') !== document.base64) {
      throw new Error('Supervised benchmark authority binding or bytes do not match.');
    }
    inputs.set(document.bindingId, content);
  }
  return { ...capsule, bytes: inputs };
}

/** Broker admission also pins the profile to the exact writable workspace granted by the OS. */
export function assertBenchmarkProfileWorkspace(
  bytes: Uint8Array,
  sha256: string,
  repoRoot: string,
  workspaceRoot: string,
): void {
  const verified = parseInputs(Buffer.from(bytes), sha256, repoRoot);
  if (relative(workspaceRoot, realpathSync.native(verified.record.profile.workspaceRoot)) !== '') {
    throw new Error('Supervised benchmark profile does not bind the granted workspace.');
  }
}

/** The explicit worker entry point establishes this scope only for one fixed CLI command. */
export function withBenchmarkProfileInputs<T>(
  path: string,
  sha256: string,
  repoRoot: string,
  run: (missionVersion: string) => T,
): T {
  const verified = parseInputs(readBoundedFile(path), sha256, repoRoot);
  return scope.run(verified, () => run(verified.missionVersion));
}

export function benchmarkWorkerProfile(repoRoot: string): ProjectProfileRecord | null {
  const capsule = scope.getStore();
  if (capsule === undefined) return null;
  assertRoot(capsule, repoRoot);
  return capsule.record;
}

export function benchmarkWorkerMission(): string | null {
  return scope.getStore()?.missionVersion ?? null;
}

export function benchmarkWorkerAuthority(record: ProjectProfileRecord, bindingId: string): Buffer | null {
  const capsule = scope.getStore();
  if (capsule === undefined) return null;
  if (capsule.record.projectProfileHash !== record.projectProfileHash ||
      capsule.record.generation !== record.generation) {
    throw new Error('Supervised benchmark profile generation changed.');
  }
  const bytes = capsule.bytes.get(bindingId);
  if (bytes === undefined) throw new Error('Supervised benchmark authority input is absent.');
  return Buffer.from(bytes);
}

export function isBenchmarkWorkerProfile(record: ProjectProfileRecord): boolean {
  const capsule = scope.getStore();
  if (capsule === undefined) return false;
  if (capsule.record.projectProfileHash !== record.projectProfileHash ||
      capsule.record.generation !== record.generation) {
    throw new Error('Supervised benchmark profile generation changed.');
  }
  return true;
}

/** Exact argument forms used by clu-master@0.2.0. */
export function isBenchmarkProfileCommand(args: readonly string[]): boolean {
  return [
    '["snapshot"]',
    '["recognize","--full","--navigator"]',
    '["recognize","--navigator"]',
    '["metrics"]',
    '["benchmark","rebuild-projections"]',
    '["benchmark","verify-chain"]',
  ].includes(JSON.stringify(args));
}
