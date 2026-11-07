/**
 * Master Benchmark contract grammar — extraction and integrity (DEV-P2-07, slice B3).
 *
 * Spec: ADR-0010 (the benchmark is one artifact; the harness lives in a `[harness.<id>]`
 *       block inside the contract); `templates/benchmark.template_v9.txt` rev 9.1 (the
 *       block's field set and fence markers); `CLUE_Execution_Model_v9.md` §17–§18 (what
 *       the contract exists to make executable); the draft contract
 *       `targets/clu/benchmark/master-benchmark.md` §11a.
 *
 * ## Ownership
 *
 * This module is the **single grammar owner** for the Master Benchmark contract as a
 * machine-read document: the identity fields (`benchmark_id`, `benchmark_version`,
 * `runner_adapter`), the `[execution]` numbers the runner consumes, and every
 * `[harness.<id>]` block. `parsePackSeal()` set the precedent —
 * one file format, one parser, and every consumer imports it. The runner
 * (`benchmarkRunner.ts`) owns execution and result-shape validation; it never re-reads the
 * document's text itself. Pure functions over text: no filesystem, no process, no clock.
 *
 * ## Two renderings, one field set
 *
 * The sealed template prescribes `key = value` lines. The approved *instance* for target
 * `clu` renders the same governed fields as Markdown (`**Benchmark version:** 0.1.0`) —
 * finding F1 of the draft: the template governs the fields, the instance's rendering is
 * free. Both renderings are read here, first occurrence governing, so a plain-text contract
 * and a Markdown contract parse identically. Two occurrences that *disagree* are a refusal,
 * not a choice: a document that states its version twice differently has no version.
 *
 * ## The integrity canon
 *
 * `integrity` is a sha256 over the fenced body, recorded when the contract version is
 * approved. The recorded hash must verify on every host, and the tree lives on Windows and
 * Linux both, so the hash is defined over a **canonical form**, not raw bytes: the lines
 * strictly between the begin/end markers, each stripped of one trailing `\r`, joined with
 * `\n`, no trailing newline appended. `canonicalHarnessBody()` is that definition made
 * executable, exported so the recording ceremony and the verifier can never drift apart.
 * A CRLF checkout and an LF checkout of the same contract therefore verify identically,
 * while any edit to the body — even whitespace inside a line — moves the hash.
 *
 * The draft's placeholder (`<sha256 of the fenced body, …>`) is a **stated absence**: the
 * version is unapproved, so no integrity is recorded yet. Extraction represents it as
 * `{ state: 'unrecorded' }` rather than refusing the document — the absence is real and is
 * carried, and it is `verifyHarnessIntegrity()` that refuses to *bless* an unrecorded body.
 *
 * ## Refusals
 *
 * Every malformed input returns `{ error }` with the offending line or field named —
 * never a throw, never a silent default. A body that fails here fails **at extraction**,
 * before any question of executing it arises (ADR-0010 §3's mitigation).
 */

import { hashText, type Sha256 } from '../shared/ids.js';

/** Exact fence markers from the template, compared against trimmed lines. */
export const HARNESS_BEGIN_MARKER = '--- begin harness ---';
export const HARNESS_END_MARKER = '--- end harness ---';

const BLOCK_HEADER = /^\[harness\.([A-Za-z][A-Za-z0-9_-]*)\]$/;
const KEY_VALUE = /^([a-z_]+)\s*=\s*(.*)$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ID_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const REQUIRED_KEYS = ['runner_adapter', 'scenario_ids', 'language', 'integrity'] as const;
type HarnessKey = (typeof REQUIRED_KEYS)[number];

/**
 * The declared integrity of a harness body.
 *
 * `declared` carries the recorded hash; `unrecorded` is the draft placeholder — an honest
 * absence with the raw placeholder text preserved so a report can show what stood in the
 * field. Anything else is a grammar refusal, not a third state.
 */
export type HarnessIntegrity =
  | { readonly state: 'declared'; readonly sha256: Sha256 }
  | { readonly state: 'unrecorded'; readonly raw: string };

/** One `[harness.<id>]` block, extracted and canonicalized. */
export interface HarnessBlock {
  readonly id: string;
  readonly runner_adapter: string;
  readonly scenario_ids: readonly string[];
  readonly language: string;
  readonly integrity: HarnessIntegrity;
  /** The body in canonical form (see the integrity canon above). */
  readonly body: string;
  /** sha256 over `body` — what a recorded `integrity` must equal. */
  readonly body_sha256: Sha256;
}

/** The contract's identity fields, read from either rendering. */
export interface ContractIdentity {
  readonly benchmark_id: string;
  readonly benchmark_version: string;
  /**
   * The header-level adapter declaration. `null` is a stated absence — blocks each declare
   * their own adapter and selection runs on those, so a contract may legally omit the
   * header field; when present it must not disagree with itself.
   */
  readonly runner_adapter: string | null;
}

export interface BenchmarkContractRead {
  readonly identity: ContractIdentity;
  readonly blocks: readonly HarnessBlock[];
}

/** Applies the integrity canon to raw body text. Exported so recorder and verifier share it. */
export function canonicalHarnessBody(rawBody: string): string {
  return rawBody
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .join('\n');
}

/**
 * Reads one identity field in both renderings.
 *
 * Markdown: `**<Label>:** value` with the value optionally backticked; template-literal:
 * `<key> = value`. First occurrence governs; a later occurrence with a different value is
 * reported as a conflict by the caller.
 */
function identityOccurrences(lines: readonly string[], key: string, label: string): readonly string[] {
  const literal = new RegExp(`^${key}\\s*=\\s*(.+)$`);
  const markdown = new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`);
  const found: string[] = [];
  for (const line of lines) {
    const match = literal.exec(line) ?? markdown.exec(line);
    if (match === null || match[1] === undefined) continue;
    const raw = match[1].trim();
    const ticked = /^`([^`]+)`/.exec(raw);
    const value = ticked !== null && ticked[1] !== undefined ? ticked[1] : (raw.split(/\s/)[0] ?? raw);
    if (value !== '') found.push(value);
  }
  return found;
}

function readIdentityField(
  lines: readonly string[],
  key: string,
  label: string,
): { readonly value: string } | { readonly error: string } | null {
  const occurrences = identityOccurrences(lines, key, label);
  const first = occurrences[0];
  if (first === undefined) return null;
  for (const other of occurrences) {
    if (other !== first) {
      return { error: `the contract states ${key} more than once with different values: ${JSON.stringify(first)} vs ${JSON.stringify(other)}` };
    }
  }
  return { value: first };
}

function parseIntegrity(raw: string): HarnessIntegrity | { readonly error: string } {
  if (HEX_64.test(raw)) return { state: 'declared', sha256: raw as Sha256 };
  if (raw.startsWith('<') && raw.endsWith('>')) return { state: 'unrecorded', raw };
  return {
    error: `integrity must be 64 lowercase hex characters or the template's <placeholder>; got ${JSON.stringify(raw.slice(0, 60))}`,
  };
}

function parseScenarioIds(raw: string): readonly string[] | { readonly error: string } {
  const tokens = raw.split(',').map((token) => token.trim());
  if (tokens.length === 0 || tokens.every((token) => token === '')) {
    return { error: 'scenario_ids declares no scenarios' };
  }
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!ID_TOKEN.test(token)) {
      return { error: `scenario_ids contains a malformed id: ${JSON.stringify(token)}` };
    }
    if (seen.has(token)) return { error: `scenario_ids repeats ${token}` };
    seen.add(token);
  }
  return tokens;
}

/**
 * Reads the whole contract: identity plus every `[harness.<id>]` block.
 *
 * A contract with zero blocks parses — the read reports what is there, and it is the
 * runner that refuses to run without a block for its adapter. A contract whose *grammar*
 * is broken anywhere refuses as a whole: half-read measurement instructions are worse
 * than none.
 */
export function readBenchmarkContract(text: string): BenchmarkContractRead | { readonly error: string } {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));

  const id = readIdentityField(lines, 'benchmark_id', 'Benchmark id');
  if (id === null) return { error: 'the contract declares no benchmark_id' };
  if ('error' in id) return id;
  const version = readIdentityField(lines, 'benchmark_version', 'Benchmark version');
  if (version === null) return { error: 'the contract declares no benchmark_version' };
  if ('error' in version) return version;
  const adapter = readIdentityField(lines, 'runner_adapter', 'Runner adapter');
  if (adapter !== null && 'error' in adapter) return adapter;

  const blocks: HarnessBlock[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = lines[index];
    if (headerLine === undefined) break;
    const header = BLOCK_HEADER.exec(headerLine.trim());
    if (header === null || header[1] === undefined) continue;
    const blockId = header[1];
    if (seenIds.has(blockId)) return { error: `duplicate harness block id: ${blockId}` };
    seenIds.add(blockId);

    const fields = new Map<HarnessKey, string>();
    let cursor = index + 1;
    let beginFound = false;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line === undefined) break;
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (trimmed === HARNESS_BEGIN_MARKER) {
        beginFound = true;
        break;
      }
      const kv = KEY_VALUE.exec(trimmed);
      if (kv === null || kv[1] === undefined || kv[2] === undefined) {
        return { error: `harness ${blockId}: unparseable line before the begin marker: ${JSON.stringify(trimmed.slice(0, 60))}` };
      }
      const key = kv[1];
      if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
        return { error: `harness ${blockId}: unknown key ${JSON.stringify(key)}` };
      }
      const known = key as HarnessKey;
      if (fields.has(known)) return { error: `harness ${blockId}: duplicate key ${known}` };
      const value = kv[2].trim();
      if (value === '') return { error: `harness ${blockId}: ${known} has no value` };
      fields.set(known, value);
    }
    if (!beginFound) {
      return { error: `harness ${blockId}: no ${JSON.stringify(HARNESS_BEGIN_MARKER)} marker before end of document` };
    }
    for (const required of REQUIRED_KEYS) {
      if (!fields.has(required)) return { error: `harness ${blockId}: missing required key ${required}` };
    }

    const bodyLines: string[] = [];
    let endFound = false;
    for (cursor += 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line === undefined) break;
      if (line.trim() === HARNESS_END_MARKER) {
        endFound = true;
        break;
      }
      bodyLines.push(line);
    }
    if (!endFound) {
      return { error: `harness ${blockId}: unterminated — no ${JSON.stringify(HARNESS_END_MARKER)} marker` };
    }

    const integrityRaw = fields.get('integrity');
    const adapterValue = fields.get('runner_adapter');
    const languageValue = fields.get('language');
    const scenarioRaw = fields.get('scenario_ids');
    if (integrityRaw === undefined || adapterValue === undefined || languageValue === undefined || scenarioRaw === undefined) {
      return { error: `harness ${blockId}: missing required key` };
    }
    const integrity = parseIntegrity(integrityRaw);
    if ('error' in integrity) return { error: `harness ${blockId}: ${integrity.error}` };
    const scenarioIds = parseScenarioIds(scenarioRaw);
    if ('error' in scenarioIds) return { error: `harness ${blockId}: ${scenarioIds.error}` };

    const body = canonicalHarnessBody(bodyLines.join('\n'));
    blocks.push({
      id: blockId,
      runner_adapter: adapterValue,
      scenario_ids: scenarioIds,
      language: languageValue,
      integrity,
      body,
      body_sha256: hashText(body),
    });

    index = cursor;
  }

  return {
    identity: {
      benchmark_id: id.value,
      benchmark_version: version.value,
      runner_adapter: adapter === null ? null : adapter.value,
    },
    blocks,
  };
}

/**
 * The `[execution]` numbers the runner consumes, each `null` when the contract omits it —
 * a stated absence the runner fills from its own defaults, never a guess.
 */
export interface ExecutionPolicyRead {
  readonly default_timeout_seconds: number | null;
  readonly default_warmup_runs: number | null;
  readonly default_repetitions: number | null;
  readonly maximum_total_runtime_seconds: number | null;
}

const EXECUTION_FIELDS = [
  { key: 'default_timeout_seconds', minimum: 1 },
  { key: 'default_warmup_runs', minimum: 0 },
  { key: 'default_repetitions', minimum: 1 },
  { key: 'maximum_total_runtime_seconds', minimum: 1 },
] as const;

/**
 * Reads §4's execution numbers in both renderings.
 *
 * The template writes `default_repetitions = 3` on its own line; the approved instance
 * writes `` `default_repetitions` 3 `` inline in prose. Both are read, every occurrence is
 * collected, and two occurrences that disagree refuse — the same law the identity fields
 * follow, for the same reason: a contract that states its repetition count twice
 * differently has no repetition count. Zero warmups is a legitimate policy; zero
 * repetitions or a zero timeout is not, and refuses by minimum.
 */
export function readExecutionPolicy(text: string): ExecutionPolicyRead | { readonly error: string } {
  const values: Record<string, number | null> = {};
  for (const field of EXECUTION_FIELDS) {
    const literal = new RegExp(`^${field.key}\\s*=\\s*(\\d+)\\s*$`, 'gm');
    const markdown = new RegExp('`' + field.key + '`\\s*[:=]?\\s*(\\d+)', 'g');
    const found: number[] = [];
    for (const pattern of [literal, markdown]) {
      for (const match of text.matchAll(pattern)) {
        if (match[1] !== undefined) found.push(Number(match[1]));
      }
    }
    const first = found[0];
    if (first === undefined) {
      values[field.key] = null;
      continue;
    }
    for (const other of found) {
      if (other !== first) {
        return {
          error: `the contract states ${field.key} more than once with different values: ${first} vs ${other}`,
        };
      }
    }
    if (first < field.minimum) {
      return { error: `${field.key} must be at least ${field.minimum}; got ${first}` };
    }
    values[field.key] = first;
  }
  return {
    default_timeout_seconds: values['default_timeout_seconds'] ?? null,
    default_warmup_runs: values['default_warmup_runs'] ?? null,
    default_repetitions: values['default_repetitions'] ?? null,
    maximum_total_runtime_seconds: values['maximum_total_runtime_seconds'] ?? null,
  };
}

/**
 * Selects the one block for a runner adapter. The template prescribes one block *per*
 * adapter, so zero matches and two matches are both refusals — the first is a contract
 * that cannot serve this runner, the second a contract that cannot decide which body
 * measures.
 */
export function selectHarnessBlock(
  read: BenchmarkContractRead,
  runnerAdapter: string,
): HarnessBlock | { readonly error: string } {
  const matches = read.blocks.filter((block) => block.runner_adapter === runnerAdapter);
  const first = matches[0];
  if (first === undefined) {
    return { error: `the contract carries no [harness.*] block for runner adapter ${JSON.stringify(runnerAdapter)}` };
  }
  if (matches.length > 1) {
    return {
      error: `the contract carries ${matches.length} harness blocks for runner adapter ${JSON.stringify(runnerAdapter)} (${matches.map((block) => block.id).join(', ')}) — one per adapter is the rule`,
    };
  }
  return first;
}

/**
 * Verifies a block's recorded integrity against its body.
 *
 * An `unrecorded` integrity refuses: the placeholder means no version of this body was
 * ever approved, and blessing it here would let a draft masquerade as a contract. The
 * refusal names the body's actual hash so the approval ceremony can record it without
 * recomputing.
 */
export function verifyHarnessIntegrity(
  block: HarnessBlock,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (block.integrity.state === 'unrecorded') {
    return {
      ok: false,
      reason:
        `harness ${block.id}: integrity is unrecorded (the contract version is unapproved); ` +
        `the body's canonical hash is ${block.body_sha256}`,
    };
  }
  if (block.integrity.sha256 !== block.body_sha256) {
    return {
      ok: false,
      reason:
        `harness ${block.id}: integrity mismatch — declared ${block.integrity.sha256}, ` +
        `body hashes to ${block.body_sha256}`,
    };
  }
  return { ok: true };
}
