/**
 * CLUE console attribution.
 *
 * Spec: CLUE_implementation.md §23.4 (ambiguity is reported, never guessed).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part IX §40; provisioning item 10.
 *
 * Turns a stack frame into a unit.
 *
 * The chain is: frame URL and position → source map → original file and line → snapshot
 * file → unit anchor → logical id. Every link can fail, and each failure is reported
 * with the reason rather than collapsed into a shrug. An entry that resolved to nothing
 * is `unattributable` and stays in the ledger; an entry that resolved to two possible
 * files is `unattributable` **because it was ambiguous**, which is a different and more
 * actionable problem than not resolving at all.
 *
 * Two decisions shape the file.
 *
 * **The VLQ decoder is in-repo rather than a dependency.** The mappings format is small,
 * stable, and fully specified, and the only query CLUE ever makes of it is "given a
 * generated position, what was the original one". A dependency would add a maintenance
 * surface for sixty lines of arithmetic, and the strategy's dependency budget says to
 * write that rather than import it. The decoder is exported so it can be tested against
 * fixtures directly, because a silently wrong offset here would misattribute every
 * console entry in a file and look entirely plausible doing it.
 *
 * **Ambiguous path matches are refused.** A source map names its originals relatively —
 * `../../src/render/frame.ts` — and matching that back to a snapshot path is a suffix
 * problem. When a suffix matches two snapshot files, attributing to the first would file
 * a real defect against the wrong unit, and nothing downstream would ever notice. So it
 * refuses, and says how many candidates it found.
 *
 * Position convention: `StackFrame.line` and `.column` are **1-based**, matching every
 * other anchor in CLUE. Source maps and CDP are 0-based, and the conversion happens here
 * so that exactly one place in the system has to know.
 */

import type Database from 'better-sqlite3';

import { normalisePath } from '../../shared/ids.js';
import type { ProjectionStore } from '../../memory/db.js';
import type { AttributionResult, Attributor, RawConsoleEntry, StackFrame } from './consoleLedger.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* VLQ decoding                                                               */
/* ------------------------------------------------------------------------- */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
  [...BASE64_ALPHABET].map((character, index) => [character, index]),
);

const VLQ_CONTINUATION = 32;
const VLQ_VALUE_MASK = 31;
const VLQ_SHIFT = 5;

export interface VlqRead {
  readonly value: number;
  readonly next: number;
}

/**
 * Reads one base64 VLQ value starting at `start`.
 *
 * Arithmetic rather than bit shifts for the accumulator: a shift past 31 bits wraps in
 * JavaScript, and column deltas in a large bundle can genuinely exceed that. The failure
 * would be a plausible-looking wrong number, which is the worst kind here.
 */
export function readVlq(text: string, start: number): VlqRead {
  let result = 0;
  let scale = 1;
  let index = start;

  for (;;) {
    const character = text[index];
    if (character === undefined) {
      throw new Error(`Truncated VLQ at offset ${start}`);
    }
    const digit = BASE64_VALUES.get(character);
    if (digit === undefined) {
      throw new Error(`Invalid base64 character "${character}" at offset ${index}`);
    }
    index += 1;

    result += (digit & VLQ_VALUE_MASK) * scale;
    scale *= 2 ** VLQ_SHIFT;

    if ((digit & VLQ_CONTINUATION) === 0) break;
  }

  const negative = result % 2 === 1;
  const magnitude = Math.floor(result / 2);
  return { value: negative ? -magnitude : magnitude, next: index };
}

export interface MappingSegment {
  readonly generatedColumn: number;
  readonly sourceIndex: number;
  readonly originalLine: number;
  readonly originalColumn: number;
}

/**
 * Decodes the `mappings` field into per-line segment lists.
 *
 * Deltas for source index, original line, and original column carry **across** lines;
 * only the generated column resets at each semicolon. Getting that wrong produces
 * mappings that are correct near the top of a file and drift further down it — which is
 * exactly the kind of defect that survives casual testing.
 */
export function decodeMappings(mappings: string): MappingSegment[][] {
  const lines: MappingSegment[][] = [];

  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;

  for (const lineText of mappings.split(';')) {
    const segments: MappingSegment[] = [];
    let generatedColumn = 0;

    if (lineText.length > 0) {
      for (const segmentText of lineText.split(',')) {
        if (segmentText.length === 0) continue;

        const values: number[] = [];
        let cursor = 0;
        while (cursor < segmentText.length) {
          const read = readVlq(segmentText, cursor);
          values.push(read.value);
          cursor = read.next;
        }

        generatedColumn += values[0] ?? 0;
        if (values.length >= 4) {
          sourceIndex += values[1] ?? 0;
          originalLine += values[2] ?? 0;
          originalColumn += values[3] ?? 0;
          segments.push({ generatedColumn, sourceIndex, originalLine, originalColumn });
        }
        // A one-field segment marks a generated position with no original. It is kept
        // out of the list rather than recorded as pointing at source zero.
      }
    }

    segments.sort((a, b) => a.generatedColumn - b.generatedColumn);
    lines.push(segments);
  }

  return lines;
}

/* ------------------------------------------------------------------------- */
/* Source maps                                                                */
/* ------------------------------------------------------------------------- */

export interface ParsedSourceMap {
  readonly sources: readonly string[];
  readonly sourceRoot: string;
  readonly lines: readonly MappingSegment[][];
}

export interface OriginalPosition {
  readonly source: string;
  /** 1-based, converted from the map's 0-based representation. */
  readonly line: number;
  readonly column: number;
}

export function parseSourceMap(json: string): ParsedSourceMap | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as Record<string, unknown>;
  const sources = record['sources'];
  const mappings = record['mappings'];
  if (!Array.isArray(sources) || typeof mappings !== 'string') return null;

  try {
    return {
      sources: sources.filter((source): source is string => typeof source === 'string'),
      sourceRoot: typeof record['sourceRoot'] === 'string' ? record['sourceRoot'] : '',
      lines: decodeMappings(mappings),
    };
  } catch {
    return null;
  }
}

/**
 * Finds the original position for a generated one.
 *
 * Takes the last segment whose generated column is at or before the target, which is the
 * standard interpretation: a segment maps everything from its column until the next one
 * begins. Returns null when the line has no mappings at all rather than reaching into a
 * neighbouring line, because a position that was never mapped is a fact worth reporting.
 */
export function originalPositionFor(
  map: ParsedSourceMap,
  generatedLine: number,
  generatedColumn: number,
): OriginalPosition | null {
  const segments = map.lines[generatedLine];
  if (segments === undefined || segments.length === 0) return null;

  let found: MappingSegment | null = null;
  for (const segment of segments) {
    if (segment.generatedColumn > generatedColumn) break;
    found = segment;
  }
  // A position before the first segment still belongs to that line; using the first
  // segment is closer to the truth than refusing.
  const chosen = found ?? segments[0];
  if (chosen === undefined) return null;

  const source = map.sources[chosen.sourceIndex];
  if (source === undefined) return null;

  const prefix = map.sourceRoot.length === 0 ? '' : `${map.sourceRoot.replace(/\/$/, '')}/`;
  return {
    source: `${prefix}${source}`,
    line: chosen.originalLine + 1,
    column: chosen.originalColumn + 1,
  };
}

/**
 * Pulls a source map out of served module text.
 *
 * Vite's dev server appends an inline base64 map to each module it transforms, so this
 * is the usual path. A plain URL comment is returned as a marker the caller can fetch.
 */
export function extractInlineSourceMap(
  scriptText: string,
): { kind: 'inline'; json: string } | { kind: 'url'; url: string } | null {
  const match = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(scriptText);
  const reference = match?.[1];
  if (reference === undefined) return null;

  const inline = /^data:application\/json;(?:charset=[^;]+;)?base64,(.*)$/i.exec(reference);
  const encoded = inline?.[1];
  if (encoded !== undefined) {
    try {
      return { kind: 'inline', json: Buffer.from(encoded, 'base64').toString('utf8') };
    } catch {
      return null;
    }
  }

  const plain = /^data:application\/json[,;]/i.test(reference)
    ? decodeURIComponent(reference.slice(reference.indexOf(',') + 1))
    : null;
  if (plain !== null) return { kind: 'inline', json: plain };

  return { kind: 'url', url: reference };
}

/* ------------------------------------------------------------------------- */
/* Path matching                                                              */
/* ------------------------------------------------------------------------- */

export type PathMatch =
  | { readonly kind: 'exact'; readonly path: string }
  | { readonly kind: 'suffix'; readonly path: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'none' };

/** Strips the decorations a dev server and a bundler add to an original source name. */
export function cleanSourcePath(source: string): string {
  return normalisePath(
    source
      .replace(/^[a-z]+:\/\/[^/]+/i, '')
      .replace(/[?#].*$/, '')
      .replace(/^\/@fs\//, '')
      .replace(/^\/@id\//, '')
      .replace(/^[A-Za-z]:\//, '')
      .replace(/^\/+/, '')
      .replace(/^(\.\.\/)+/, '')
      .replace(/^\.\//, ''),
  );
}

/**
 * Matches a source-map original against the snapshot's file list.
 *
 * Exact first, then longest unique suffix. A suffix matching more than one snapshot file
 * returns `ambiguous` rather than picking one: attributing a real defect to the wrong
 * unit is worse than not attributing it, because the wrong attribution will be believed.
 */
export function matchSnapshotPath(source: string, snapshotPaths: readonly string[]): PathMatch {
  const cleaned = cleanSourcePath(source);
  if (cleaned.length === 0) return { kind: 'none' };

  for (const path of snapshotPaths) {
    if (path.toLowerCase() === cleaned.toLowerCase()) return { kind: 'exact', path };
  }

  const segments = cleaned.split('/');
  for (let start = 0; start < segments.length; start += 1) {
    const suffix = segments.slice(start).join('/').toLowerCase();
    if (suffix.length === 0) continue;

    const candidates = snapshotPaths.filter(
      (path) => path.toLowerCase() === suffix || path.toLowerCase().endsWith(`/${suffix}`),
    );
    if (candidates.length === 1) {
      const path = candidates[0];
      if (path !== undefined) return { kind: 'suffix', path };
    }
    if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  }

  return { kind: 'none' };
}

/* ------------------------------------------------------------------------- */
/* Unit location                                                              */
/* ------------------------------------------------------------------------- */

export type UnitLocator = (modulePath: string, line: number) => string | null;

/**
 * Finds the innermost unit covering a line.
 *
 * Innermost, so a method is preferred over its class and a class over its module: the
 * most specific attribution is the most useful one. Falls back to the module unit when
 * no declaration covers the line — an import statement or a top-level side effect still
 * belongs to a file, and saying so beats saying nothing.
 */
export function makeUnitLocator(projections: ProjectionStore, snapshotId: string): UnitLocator {
  const db: Db = projections.db;

  const innermost = db.prepare(
    `SELECT i.logical_id AS logical_id
       FROM units u JOIN unit_ids i ON i.unit_id = u.unit_id
      WHERE u.snapshot_id = ? AND u.module_path = ? AND u.kind != 'module'
        AND u.start_line <= ? AND u.end_line >= ?
      ORDER BY (u.end_line - u.start_line) ASC, u.start_line DESC
      LIMIT 1`,
  );

  const moduleUnit = db.prepare(
    `SELECT i.logical_id AS logical_id
       FROM units u JOIN unit_ids i ON i.unit_id = u.unit_id
      WHERE u.snapshot_id = ? AND u.module_path = ? AND u.kind = 'module'
      LIMIT 1`,
  );

  return (modulePath: string, line: number): string | null => {
    const covering = innermost.get(snapshotId, modulePath, line, line);
    if (covering !== undefined) return readLogicalId(covering);

    const container = moduleUnit.get(snapshotId, modulePath);
    return container === undefined ? null : readLogicalId(container);
  };
}

function readLogicalId(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as Record<string, unknown>)['logical_id'];
  return typeof value === 'string' ? value : null;
}

/* ------------------------------------------------------------------------- */
/* Attributor                                                                 */
/* ------------------------------------------------------------------------- */

/** Returns the raw source-map JSON for a script URL, or null when there is none. */
export type SourceMapProvider = (scriptUrl: string) => string | null;

export interface AttributorOptions {
  /** Module paths in the snapshot the console session is measured against. */
  readonly snapshotPaths: readonly string[];
  readonly locateUnit: UnitLocator;
  readonly sourceMaps: SourceMapProvider;
  /**
   * URL fragments that mark a frame as belonging to a dependency or the browser rather
   * than to the project. A frame matching one is `external`, not a failure to resolve.
   */
  readonly externalPatterns?: readonly RegExp[];
}

const DEFAULT_EXTERNAL_PATTERNS: readonly RegExp[] = [
  /\/node_modules\//i,
  /^chrome-extension:/i,
  /^chrome:/i,
  /^devtools:/i,
  /\/\.vite\/deps\//i,
  /\/@vite\//i,
];

/**
 * Builds an attributor over one snapshot.
 *
 * Source maps are cached by URL for the life of the attributor. Parsing one is not cheap
 * and a session emits many entries from the same handful of modules, so without the
 * cache the cost would scale with occurrences rather than with distinct scripts.
 */
export function createAttributor(options: AttributorOptions): Attributor {
  const externalPatterns = options.externalPatterns ?? DEFAULT_EXTERNAL_PATTERNS;
  const cache = new Map<string, ParsedSourceMap | null>();

  const mapFor = (url: string): ParsedSourceMap | null => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;

    const json = options.sourceMaps(url);
    const parsed = json === null ? null : parseSourceMap(json);
    cache.set(url, parsed);
    return parsed;
  };

  return (entry: RawConsoleEntry): AttributionResult => {
    if (entry.frames.length === 0) {
      return unresolved('the entry carried no stack frames');
    }

    const failures: string[] = [];

    for (const frame of entry.frames) {
      if (frame.url.length === 0) {
        failures.push('a frame had no url');
        continue;
      }
      if (externalPatterns.some((pattern) => pattern.test(frame.url))) {
        // Not a failure. A dependency's own warning is somebody else's problem, and
        // saying so is more useful than trying to file it against project code.
        return {
          outcome: 'external',
          logicalId: null,
          path: null,
          line: null,
          detail: `resolves to ${frame.url}, outside the project`,
        };
      }

      const resolved = resolveFrame(frame, mapFor, options, failures);
      if (resolved !== null) return resolved;
    }

    return unresolved(
      failures.length === 0 ? 'no frame could be resolved' : failures.slice(0, 3).join('; '),
    );
  };
}

function resolveFrame(
  frame: StackFrame,
  mapFor: (url: string) => ParsedSourceMap | null,
  options: AttributorOptions,
  failures: string[],
): AttributionResult | null {
  const map = mapFor(frame.url);
  if (map === null) {
    failures.push(`no source map for ${frame.url}`);
    return null;
  }

  // Frames are 1-based throughout CLUE; source maps are 0-based. This is the one place
  // that knows, so the conversion cannot drift.
  const original = originalPositionFor(map, frame.line - 1, Math.max(0, frame.column - 1));
  if (original === null) {
    failures.push(`${frame.url}:${frame.line}:${frame.column} has no mapping`);
    return null;
  }

  const match = matchSnapshotPath(original.source, options.snapshotPaths);
  if (match.kind === 'none') {
    failures.push(`${original.source} matches no file in the snapshot`);
    return null;
  }
  if (match.kind === 'ambiguous') {
    // Reported rather than guessed. A defect filed against the wrong unit is believed.
    failures.push(
      `${original.source} matches ${match.candidates.length} snapshot files ambiguously`,
    );
    return null;
  }

  const logicalId = options.locateUnit(match.path, original.line);
  if (logicalId === null) {
    failures.push(`no unit covers ${match.path}:${original.line}`);
    return null;
  }

  return {
    outcome: 'attributed',
    logicalId,
    path: match.path,
    line: original.line,
    detail:
      `${frame.url}:${frame.line}:${frame.column} → ${match.path}:${original.line}` +
      `${match.kind === 'suffix' ? ' (matched by suffix)' : ''}`,
  };
}

function unresolved(detail: string): AttributionResult {
  return { outcome: 'unattributable', logicalId: null, path: null, line: null, detail };
}

/* ------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* ------------------------------------------------------------------------- */

export interface AttributionHealth {
  readonly scriptsSeen: number;
  readonly scriptsWithMaps: number;
  readonly ratio: number;
  readonly missing: readonly string[];
}

/**
 * How much of a session's stack surface could be mapped at all.
 *
 * Worth checking before the ledger is trusted for ranking. A dev server configured
 * without source maps produces a ledger in which everything is `unclassified` — which
 * looks like a corpus problem and is really a configuration one, and `clue doctor`
 * should be able to tell the difference.
 */
export function assessAttribution(
  entries: readonly RawConsoleEntry[],
  sourceMaps: SourceMapProvider,
  externalPatterns: readonly RegExp[] = DEFAULT_EXTERNAL_PATTERNS,
): AttributionHealth {
  const scripts = new Set<string>();
  for (const entry of entries) {
    for (const frame of entry.frames) {
      if (frame.url.length === 0) continue;
      if (externalPatterns.some((pattern) => pattern.test(frame.url))) continue;
      scripts.add(frame.url);
    }
  }

  const missing: string[] = [];
  let withMaps = 0;
  for (const url of scripts) {
    if (sourceMaps(url) === null) missing.push(url);
    else withMaps += 1;
  }

  return {
    scriptsSeen: scripts.size,
    scriptsWithMaps: withMaps,
    ratio: scripts.size === 0 ? 0 : Number((withMaps / scripts.size).toFixed(3)),
    missing: missing.slice(0, 20),
  };
}
