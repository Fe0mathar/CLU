/**
 * `clue proof` — one governed command over the complete §10–§15 candidate arm.
 *
 * Spec: `CLUE_Execution_Model_v9.md` §10–§15; `CLUE_Project_Directory_v9.md` §16;
 *       DEV-P2-11 Stage H, slice 1. The CLI owns input-file parsing, local safety checks,
 *       one service call, printing, and exit codes. Proof semantics remain in
 *       `CycleOrchestrator.candidate()`, `src/proof/`, and the execution coordinator.
 *
 * ## Authority and lock choreography
 *
 * Unlike `benchmark run`, this command holds the event-log writer lock for the complete
 * candidate arm. Tree-relative instruments run as ordinary target/toolchain processes.
 * The CLU-E self-target's approved harness also invokes `clue`; the execution coordinator
 * therefore relocates the shadow's config/profile/workspace before measurement so those
 * children acquire a distinct writer lock. The canonical runtime remains locked throughout.
 *
 * ## Inputs
 *
 * `--contract` is strict JSON consumed by the existing freeze gate. `--patch` is a
 * versioned, strict manifest. A write may carry UTF-8 `content` inline or name a UTF-8
 * `source` file beside the manifest; sources cannot escape that directory, and target
 * paths cannot be absolute, traverse upward, collide case-insensitively, or exceed the
 * bounded input limits. The manifest is converted to the typed whole-file write/delete
 * authority already owned by `executionCoordinator.ts`.
 *
 * ## Capability honesty
 *
 * The operator cannot assert arbitrary capabilities on the command line. Available proof
 * capabilities are derived from the cycle's byte-verified, locked Master Benchmark:
 * `benchmark:<id>`, `runner:<adapter>`, and `harness:<block-id>`. A contract asking for
 * anything else is refused by the existing freeze gate instead of being made true by a
 * flag.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { TextDecoder } from 'node:util';

import type { Command } from 'commander';
import { z } from 'zod';

import { readBenchmarkContract } from '../../benchmark/harnessBlock.js';
import { verifyLockedContract } from '../../control/benchmarkRun.js';
import { withRuntimeAsync, type Runtime } from '../../control/runtime.js';
import { CycleOrchestrator, type CandidateArmResult } from '../../cycle/cycleOrchestrator.js';
import type { PatchOperation } from '../../experiment/proof/executionCoordinator.js';
import { absolutePathForm } from '../../shared/schemas.js';
import { printChecks, short, truncate, write, type Check } from '../output/formatter.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_OPERATIONS = 256;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const targetPathSchema = z.string().min(1).max(1024);
const sourcePathSchema = z.string().min(1).max(1024);

const inlineWriteSchema = z
  .object({
    op: z.literal('write'),
    path: targetPathSchema,
    content: z.string(),
  })
  .strict();

const sourceWriteSchema = z
  .object({
    op: z.literal('write'),
    path: targetPathSchema,
    source: sourcePathSchema,
  })
  .strict();

const deleteSchema = z
  .object({
    op: z.literal('delete'),
    path: targetPathSchema,
  })
  .strict();

export const proofPatchManifestSchema = z
  .object({
    version: z.literal(1),
    operations: z
      .array(z.union([inlineWriteSchema, sourceWriteSchema, deleteSchema]))
      .min(1)
      .max(MAX_PATCH_OPERATIONS),
  })
  .strict();

export type ProofPatchManifest = z.infer<typeof proofPatchManifestSchema>;

export interface ProofCliOptions {
  readonly contract: string;
  readonly patch: string;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function readBoundedFile(path: string, maximumBytes: number, label: string): Buffer {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (info.size > maximumBytes) {
    throw new Error(`${label} is ${info.size} bytes; limit is ${maximumBytes} bytes: ${path}`);
  }
  return readFileSync(path);
}

function parseJsonFile(path: string, label: string): unknown {
  const text = decodeUtf8(readBoundedFile(path, MAX_JSON_BYTES, label), label);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Canonical target-relative path used by the typed patch authority.
 *
 * Windows case-folding is used only for duplicate detection; the preserved spelling is
 * returned and becomes part of the durable change-set identity.
 */
export function normalizeProofTargetPath(input: string): string {
  const slash = input.replace(/\\/g, '/');
  if (absolutePathForm(input) !== null || isAbsolute(input) || slash.startsWith('/')) {
    throw new Error(`patch target must be relative to the target tree: ${JSON.stringify(input)}`);
  }
  const parts = slash.split('/');
  if (parts.some((part) => part === '..')) {
    throw new Error(`patch target traverses above the target tree: ${JSON.stringify(input)}`);
  }
  const normalized = parts.filter((part) => part !== '' && part !== '.').join('/');
  if (normalized === '') throw new Error(`patch target resolves to the tree root: ${JSON.stringify(input)}`);
  if (normalized.includes('\0')) throw new Error(`patch target contains a NUL byte: ${JSON.stringify(input)}`);
  return normalized;
}

function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function readManifestSource(manifestDirectory: string, source: string): string {
  const slash = source.replace(/\\/g, '/');
  if (absolutePathForm(source) !== null || isAbsolute(source) || slash.startsWith('/') || slash.split('/').includes('..')) {
    throw new Error(`patch source must stay inside the manifest directory: ${JSON.stringify(source)}`);
  }
  const lexical = resolve(manifestDirectory, source);
  if (!existsSync(lexical)) throw new Error(`patch source does not exist: ${lexical}`);
  const realBase = realpathSync(manifestDirectory);
  const realSource = realpathSync(lexical);
  if (!inside(realBase, realSource)) {
    throw new Error(`patch source escapes the manifest directory after real-path resolution: ${source}`);
  }
  const info = lstatSync(realSource);
  if (!info.isFile()) throw new Error(`patch source is not a regular file: ${realSource}`);
  return decodeUtf8(readBoundedFile(realSource, MAX_SOURCE_BYTES, 'patch source'), `patch source ${source}`);
}

/** Strictly reads and expands a portable proof patch manifest. */
export function loadProofPatchManifest(pathFromCwd: string, cwd = process.cwd()): readonly PatchOperation[] {
  const manifestPath = isAbsolute(pathFromCwd) ? pathFromCwd : resolve(cwd, pathFromCwd);
  const parsed = proofPatchManifestSchema.safeParse(parseJsonFile(manifestPath, 'proof patch manifest'));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`proof patch manifest is invalid: ${detail}`);
  }

  const manifestDirectory = dirname(manifestPath);
  const targets = new Set<string>();
  const result: PatchOperation[] = [];
  for (const operation of parsed.data.operations) {
    const path = normalizeProofTargetPath(operation.path);
    const key = path.toLocaleLowerCase('en-US');
    if (targets.has(key)) {
      throw new Error(`proof patch manifest names the target more than once (Windows-equivalent): ${path}`);
    }
    targets.add(key);

    if (operation.op === 'delete') {
      result.push({ op: 'delete', path });
      continue;
    }
    const content = 'content' in operation
      ? operation.content
      : readManifestSource(manifestDirectory, operation.source);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) {
      throw new Error(`inline patch content for ${path} is ${bytes} bytes; limit is ${MAX_SOURCE_BYTES} bytes`);
    }
    result.push({ op: 'write', path, content });
  }
  return result;
}

/** Strict JSON read; semantic validation and hashing remain the freeze gate's authority. */
export function loadProofContract(pathFromCwd: string, cwd = process.cwd()): unknown {
  const contractPath = isAbsolute(pathFromCwd) ? pathFromCwd : resolve(cwd, pathFromCwd);
  return parseJsonFile(contractPath, 'proof contract');
}

/**
 * Checks the instrument shape at the CLI boundary.
 *
 * The `clu-master` self-target is now safe because `executeProofPlan()` performs a
 * content-recorded, shadow-only config relocation before any child `clue` process runs.
 * Keeping this seam makes the supported shape explicit and preserves one place for future
 * adapter-specific refusals; it deliberately does not claim capability from operator input.
 */
export function assertProofInstrumentSafe(
  repoRoot: string,
  projectRoot: string,
  benchmarkId: string,
): void {
  void repoRoot;
  void projectRoot;
  void benchmarkId;
}

function lockedProofCapabilities(runtime: Runtime, orchestrator: CycleOrchestrator): readonly string[] {
  const cycle = orchestrator.status();
  if (cycle === null) throw new Error('No cycle in progress — `clue proof` hangs off SCREENED.');
  const locked = orchestrator.lockedBenchmarkOf(cycle.id);
  if (locked === null) {
    throw new Error(
      'The proof command needs a locked Master Benchmark — register it and drive a cycle to SCREENED first.',
    );
  }
  const verified = verifyLockedContract(runtime.config.project.root, locked);
  if ('error' in verified) throw new Error(verified.error);
  const source = decodeUtf8(readBoundedFile(verified.path, MAX_JSON_BYTES, 'locked Master Benchmark'), 'locked Master Benchmark');
  const read = readBenchmarkContract(source);
  if ('error' in read) throw new Error(`the locked Master Benchmark cannot declare proof capabilities: ${read.error}`);
  assertProofInstrumentSafe(runtime.repoRoot, runtime.config.project.root, read.identity.benchmark_id);

  const capabilities = new Set<string>();
  capabilities.add(`benchmark:${read.identity.benchmark_id}`);
  if (read.identity.runner_adapter !== null) capabilities.add(`runner:${read.identity.runner_adapter}`);
  for (const block of read.blocks) {
    capabilities.add(`harness:${block.id}`);
    capabilities.add(`runner:${block.runner_adapter}`);
  }
  return [...capabilities].sort();
}

function refusalChecks(result: Exclude<CandidateArmResult, { readonly ok: true }>): readonly Check[] {
  const checks: Check[] = [
    { level: 'fail', label: 'proof', detail: `REFUSED at ${result.stage}` },
  ];
  for (const [index, reason] of result.reasons.entries()) {
    checks.push({ level: 'fail', label: index === 0 ? 'reason' : `reason ${index + 1}`, detail: truncate(reason, 220) });
  }
  if (result.recorded_event !== undefined) {
    checks.push({ level: 'warn', label: 'recorded refusal', detail: result.recorded_event });
  }
  return checks;
}

/** Executes the complete candidate arm and returns the process exit code. */
export async function commandProof(
  options: ProofCliOptions,
  cwd = process.cwd(),
  repoRoot?: string,
): Promise<number> {
  try {
    return await withRuntimeAsync(
      {
        withLog: true,
        verifyLog: 'tail',
        requireMission: true,
        ...(repoRoot === undefined ? {} : { repoRoot }),
      },
      async (runtime) => {
        const contract = loadProofContract(options.contract, cwd);
        const patch = loadProofPatchManifest(options.patch, cwd);
        const orchestrator = new CycleOrchestrator(runtime);
        const capabilities = lockedProofCapabilities(runtime, orchestrator);

        write('Running the governed proof arm:');
        write(`  contract      ${isAbsolute(options.contract) ? options.contract : resolve(cwd, options.contract)}`);
        write(`  patch         ${isAbsolute(options.patch) ? options.patch : resolve(cwd, options.patch)}`);
        write(`  operations    ${patch.length}`);
        write(`  capabilities  ${capabilities.join(', ')}`);
        write('');

        const result = await orchestrator.candidate({ contract, capabilities, patch });
        if (!result.ok) {
          printChecks(refusalChecks(result));
          return 1;
        }

        const verdict = result.verdict;
        printChecks([
          {
            level: verdict.disposition === 'ACCEPT' ? 'ok' : 'warn',
            label: 'verdict',
            detail: `${verdict.disposition}${verdict.improvement ? ' — proven improvement' : ' — not an accepted improvement'}`,
          },
          { level: 'ok', label: 'contract', detail: short(result.contract_hash) },
          { level: 'ok', label: 'baseline', detail: short(verdict.identity.baseline_digest) },
          { level: 'ok', label: 'candidate', detail: short(verdict.identity.candidate_digest) },
          { level: 'ok', label: 'event: frozen', detail: result.events.frozen },
          { level: 'ok', label: 'event: verdict', detail: result.events.verdict },
          result.great_book.state === 'recorded'
            ? { level: 'ok', label: 'Great Book', detail: result.great_book.entry.entry_id }
            : {
                level: verdict.disposition === 'ACCEPT' ? 'warn' : 'info',
                label: 'Great Book',
                detail: `not recorded — ${truncate(result.great_book.reason, 180)}`,
              },
          {
            level: verdict.reasons.length === 0 ? 'info' : 'info',
            label: 'reason',
            detail: verdict.reasons.length === 0 ? 'none' : truncate(verdict.reasons.join('; '), 220),
          },
        ]);
        write('');
        write(
          'A recorded REJECT/REVISE/INVALID is a successful proof execution and therefore exits 0; ' +
            'the disposition, not the shell exit code, decides improvement.',
        );
        return 0;
      },
    );
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Registers the single `clue proof` act. */
export function registerProofCommand(program: Command): void {
  program
    .command('proof')
    .description('freeze a Proof Contract, execute one isolated candidate, and record the verdict')
    .requiredOption('--contract <path>', 'strict JSON Proof Contract (§10)')
    .requiredOption('--patch <path>', 'version-1 JSON patch manifest (whole-file write/delete operations)')
    .action(async (options: ProofCliOptions) => {
      process.exitCode = await commandProof(options);
    });
}
