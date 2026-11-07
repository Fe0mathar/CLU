/**
 * Node attributor — a stack frame becomes a recognized unit, or says why not (DEV-P2-10, G2).
 *
 * Spec: the ledger's `Attributor` seam (`src/experiment/console/consoleLedger.ts` —
 *       "Supplied by the attribution module"; `AttributionResult.detail` is present even
 *       on success); `CLUE_Execution_Model_v9.md` §8 (observed evidence must name its
 *       affected scope — an observation attributed to nothing ranks nothing).
 *
 * ## The join
 *
 * A recognized unit anchors `{ path, startLine, endLine }` relative to the project root;
 * a Node frame carries `url:line:column`. Attribution is the join between them, walked
 * top-of-stack downward, first project hit wins:
 *
 *   1. **Normalize** the frame url: `file://` unwrapped (Windows `file:///C:/…` included),
 *      backslashes forward, `node:` internals and `[eval]`-style pseudo-locations skipped
 *      as non-code, `node_modules` and paths outside the root remembered as *external*.
 *   2. **Direct match** on the normalized project-relative path — a target run under a
 *      TS loader prints source paths and needs no hop.
 *   3. **The source-map hop** for compiled frames: a `.js` frame reads its map (sibling
 *      `.js.map`, a `sourceMappingURL=` file reference, or an inline base64 payload) and
 *      `node:module`'s `SourceMap.findEntry` — **zero-based both ways, measured on this
 *      Node** — turns the generated location into the original `src/….ts` one, which then
 *      joins like any direct match. `tsconfig.json` has `sourceMap: true`, so for this
 *      target the hop is exact, not approximate; a `.js` frame with no readable map stays
 *      unattributed *with that stated*, never rewritten by guesswork — a wrong line
 *      attributed confidently is worse than an honest refusal.
 *   4. **Innermost span wins.** Units nest (method ⊂ class ⊂ module); the smallest
 *      enclosing span is the subject. A line inside the file but between declarations
 *      falls back to the file's `module` unit, and the detail says which containment it
 *      was — an observation pinned to a module is real evidence, just coarser.
 *
 * ## Purity, and the one injected effect
 *
 * The unit index is built once from the units the caller supplies (read from the
 * committed graph for the session's snapshot — this module never touches the graph or
 * the ledger). The only effect is reading map files, injected as `readTextFile` so the
 * suite can pin every path with a fake filesystem while production passes `readFileSync`.
 * Map parses are cached per file for the attributor's lifetime: one session, one
 * snapshot, one immutable dist tree.
 */

import { readFileSync } from 'node:fs';
import { posix as posixPath, win32 as win32Path } from 'node:path';
import { SourceMap } from 'node:module';

import type {
  AttributionResult,
  Attributor,
  RawConsoleEntry,
  StackFrame,
} from '../../experiment/console/consoleLedger.js';
import type { SourceUnit } from '../source/graph.js';
import { normalisePath } from '../../shared/ids.js';

export interface NodeAttributorDeps {
  /** Absolute project root; frames resolve relative to it. Either separator style. */
  readonly projectRoot: string;
  /** The committed graph's units for the session's snapshot. */
  readonly units: readonly SourceUnit[];
  /** Injected for tests; production default reads the real file or returns null. */
  readonly readTextFile?: (absolutePath: string) => string | null;
}

/* ------------------------------------------------------------------------- */
/* Path normalisation                                                         */
/* ------------------------------------------------------------------------- */

const posixify = (path: string): string => path.replace(/\\/g, '/');

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//;
const WINDOWS_UNC_ABSOLUTE = /^\/\/[^/]+\/[^/]+(?:\/|$)/;

/**
 * `node:path` follows the host OS. Recorded frames and injected test files do not: a
 * Windows host can legitimately attribute a POSIX-shaped `/r/...` fixture, while a Linux
 * host can inspect a `C:/...` or UNC frame. Select path semantics from the recorded path
 * itself so source-map resolution is independent of the machine performing attribution.
 */
function isWindowsAbsolutePath(path: string): boolean {
  const normalized = posixify(path);
  return WINDOWS_DRIVE_ABSOLUTE.test(normalized) || WINDOWS_UNC_ABSOLUTE.test(normalized);
}

function isPortableAbsolute(path: string): boolean {
  const normalized = posixify(path);
  return isWindowsAbsolutePath(normalized) || normalized.startsWith('/');
}

function portableDirname(path: string): string {
  const normalized = posixify(path);
  const api = isWindowsAbsolutePath(normalized) ? win32Path : posixPath;
  return posixify(api.dirname(normalized));
}

/**
 * Resolve path segments using the flavour of the last absolute segment, mirroring
 * `path.resolve()` while remaining independent of `process.platform`.
 */
function portableResolve(base: string, ...segments: readonly string[]): string {
  const normalized = [base, ...segments].map(posixify);
  let start = 0;
  for (let index = 1; index < normalized.length; index += 1) {
    if (isPortableAbsolute(normalized[index]!)) start = index;
  }
  const effective = normalized.slice(start);
  const anchor = effective[0]!;
  const api = isWindowsAbsolutePath(anchor) ? win32Path : posixPath;
  return posixify(api.resolve(...effective));
}

/**
 * A frame url as a filesystem path, or null for non-code locations (`node:` internals,
 * `[eval]`, the `Promise.all (index 1)` sentinel the capture parses with a zero line).
 */
export function frameUrlToPath(url: string): string | null {
  if (url.startsWith('node:') || url.startsWith('[')) return null;
  let path = url;
  if (path.startsWith('file://')) {
    path = decodeURIComponent(path.slice('file://'.length));
    // `file:///C:/x` — the leading slash belongs to the URL, not the drive.
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  path = posixify(path);
  if (!path.includes('/')) return null; // `index 1` and other location-less shapes
  return path;
}

/** Project-relative POSIX path when `absolute` sits under `root`, else null. */
export function relativeUnder(root: string, absolute: string): string | null {
  const rootPosix = posixify(root).replace(/\/+$/, '');
  const absPosix = posixify(absolute);
  if (absPosix === rootPosix) return '';
  if (!absPosix.startsWith(`${rootPosix}/`)) return null;
  return normalisePath(absPosix.slice(rootPosix.length + 1));
}

/* ------------------------------------------------------------------------- */
/* Unit index and innermost selection                                         */
/* ------------------------------------------------------------------------- */

export type Containment = 'enclosing' | 'module-fallback';

/**
 * The unit at (path, line): smallest enclosing span, ties broken by byte length then by
 * latest start (a nested declaration starts after its parent). When the line sits in the
 * file but inside no declared span, the file's `module` unit is the honest subject.
 */
export function unitAt(
  byPath: ReadonlyMap<string, readonly SourceUnit[]>,
  path: string,
  line: number,
): { readonly unit: SourceUnit; readonly containment: Containment } | null {
  const candidates = byPath.get(path);
  if (candidates === undefined) return null;
  let best: SourceUnit | null = null;
  for (const unit of candidates) {
    if (line < unit.anchor.startLine || line > unit.anchor.endLine) continue;
    if (best === null) {
      best = unit;
      continue;
    }
    const bestSpan = best.anchor.endLine - best.anchor.startLine;
    const unitSpan = unit.anchor.endLine - unit.anchor.startLine;
    if (
      unitSpan < bestSpan ||
      (unitSpan === bestSpan && unit.byteLength < best.byteLength) ||
      (unitSpan === bestSpan && unit.byteLength === best.byteLength && unit.anchor.startByte > best.anchor.startByte)
    ) {
      best = unit;
    }
  }
  if (best !== null) return { unit: best, containment: 'enclosing' };
  const moduleUnit = candidates.find((unit) => unit.kind === 'module');
  return moduleUnit === undefined ? null : { unit: moduleUnit, containment: 'module-fallback' };
}

function indexUnits(units: readonly SourceUnit[]): Map<string, SourceUnit[]> {
  const byPath = new Map<string, SourceUnit[]>();
  for (const unit of units) {
    const path = normalisePath(unit.anchor.path);
    const existing = byPath.get(path);
    if (existing === undefined) byPath.set(path, [unit]);
    else existing.push(unit);
  }
  return byPath;
}

/* ------------------------------------------------------------------------- */
/* The source-map hop                                                         */
/* ------------------------------------------------------------------------- */

const INLINE_MAP = /\/\/[#@]\s*sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)\s*$/m;
const FILE_MAP = /\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*$/m;

interface MapPayload {
  readonly sources?: readonly string[];
  readonly sourceRoot?: string;
}

function loadSourceMap(
  read: (path: string) => string | null,
  cache: Map<string, { map: SourceMap; mapDir: string; sourceRoot: string } | null>,
  jsAbsolute: string,
): { map: SourceMap; mapDir: string; sourceRoot: string } | null {
  const cached = cache.get(jsAbsolute);
  if (cached !== undefined) return cached;

  const store = (value: { map: SourceMap; mapDir: string; sourceRoot: string } | null) => {
    cache.set(jsAbsolute, value);
    return value;
  };

  const parse = (payloadText: string, mapDir: string) => {
    try {
      const payload = JSON.parse(payloadText) as MapPayload;
      return store({
        map: new SourceMap(payload as ConstructorParameters<typeof SourceMap>[0]),
        mapDir,
        sourceRoot: payload.sourceRoot ?? '',
      });
    } catch {
      return store(null);
    }
  };

  // Sibling convention first — what tsc emits — then the file's own declaration.
  const sibling = read(`${jsAbsolute}.map`);
  if (sibling !== null) return parse(sibling, portableDirname(jsAbsolute));

  const source = read(jsAbsolute);
  if (source === null) return store(null);
  const inline = INLINE_MAP.exec(source);
  if (inline !== null && inline[1] !== undefined) {
    try {
      return parse(Buffer.from(inline[1], 'base64').toString('utf8'), portableDirname(jsAbsolute));
    } catch {
      return store(null);
    }
  }
  const fileRef = FILE_MAP.exec(source);
  if (fileRef !== null && fileRef[1] !== undefined && !fileRef[1].startsWith('data:')) {
    const mapPath = portableResolve(portableDirname(jsAbsolute), fileRef[1]);
    const referred = read(mapPath);
    if (referred !== null) return parse(referred, portableDirname(mapPath));
  }
  return store(null);
}

/* ------------------------------------------------------------------------- */
/* The attributor                                                             */
/* ------------------------------------------------------------------------- */

const defaultRead = (absolutePath: string): string | null => {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Builds the ledger's `Attributor` for one snapshot's units.
 *
 * Walks each entry's frames top-down and returns on the first project frame that joins a
 * unit; entries whose only located frames are third-party come back `external`, and
 * everything else `unattributable` with the walk's reasons joined — the ledger stores the
 * detail with the signature, so "why is this unattributed" is a read, not an
 * investigation.
 */
export function makeNodeAttributor(deps: NodeAttributorDeps): Attributor {
  const byPath = indexUnits(deps.units);
  const mapCache = new Map<string, { map: SourceMap; mapDir: string; sourceRoot: string } | null>();
  const read = deps.readTextFile ?? defaultRead;
  const rootPosix = posixify(deps.projectRoot).replace(/\/+$/, '');

  const attributeFrame = (
    frame: StackFrame,
  ):
    | { readonly hit: { unit: SourceUnit; containment: Containment; path: string; line: number; via: string } }
    | { readonly external: string }
    | { readonly note: string }
    | null => {
    const rawPath = frameUrlToPath(frame.url);
    if (rawPath === null) return null; // internals and pseudo-locations: silently skipped
    if (frame.line <= 0) return { note: `${frame.url}: no line information` };

    const absolute = isPortableAbsolute(rawPath)
      ? rawPath
      : `${rootPosix}/${normalisePath(rawPath)}`;
    const relative = relativeUnder(rootPosix, absolute);
    if (relative === null) return { external: `${rawPath}:${frame.line}` };
    if (relative.startsWith('node_modules/')) return { external: `${relative}:${frame.line}` };

    const direct = unitAt(byPath, relative, frame.line);
    if (direct !== null) {
      return {
        hit: {
          unit: direct.unit,
          containment: direct.containment,
          path: relative,
          line: frame.line,
          via: 'direct anchor match',
        },
      };
    }

    if (relative.endsWith('.js')) {
      const loaded = loadSourceMap(read, mapCache, absolute);
      if (loaded === null) {
        return { note: `${relative}:${frame.line}: compiled frame with no readable source map` };
      }
      // node:module's SourceMap speaks zero-based on both sides (measured); frames are 1-based.
      const entry = loaded.map.findEntry(frame.line - 1, Math.max(0, frame.column - 1));
      const original = (entry as { originalSource?: string; originalLine?: number }).originalSource;
      const originalLine = (entry as { originalLine?: number }).originalLine;
      if (original === undefined || originalLine === undefined) {
        return { note: `${relative}:${frame.line}: the source map has no entry at this location` };
      }
      const srcAbsolute = portableResolve(loaded.mapDir, loaded.sourceRoot, original);
      const srcRelative = relativeUnder(rootPosix, srcAbsolute);
      if (srcRelative === null) {
        return { note: `${relative}:${frame.line}: source map points outside the project (${original})` };
      }
      const mapped = unitAt(byPath, srcRelative, originalLine + 1);
      if (mapped !== null) {
        return {
          hit: {
            unit: mapped.unit,
            containment: mapped.containment,
            path: srcRelative,
            line: originalLine + 1,
            via: `source map: ${relative}:${frame.line} → ${srcRelative}:${originalLine + 1}`,
          },
        };
      }
      return { note: `${relative}:${frame.line}: mapped to ${srcRelative}:${originalLine + 1}, which anchors no unit` };
    }

    return {
      note: byPath.has(relative)
        ? `${relative}:${frame.line}: the line sits in no declared span and the file has no module unit`
        : `${relative}:${frame.line}: no unit anchors this path`,
    };
  };

  return (entry: RawConsoleEntry): AttributionResult => {
    let firstExternal: string | null = null;
    const notes: string[] = [];

    for (const frame of entry.frames) {
      const verdict = attributeFrame(frame);
      if (verdict === null) continue;
      if ('hit' in verdict) {
        const { unit, containment, path, line, via } = verdict.hit;
        return {
          outcome: 'attributed',
          logicalId: unit.logicalId,
          path,
          line,
          detail:
            `${via}; ${containment === 'enclosing' ? `innermost span ${unit.kind} ${unit.qualifiedName}` : `between declarations — module unit ${unit.logicalId}`}`,
        };
      }
      if ('external' in verdict && firstExternal === null) firstExternal = verdict.external;
      if ('note' in verdict) notes.push(verdict.note);
    }

    if (firstExternal !== null) {
      return {
        outcome: 'external',
        logicalId: null,
        path: firstExternal.slice(0, firstExternal.lastIndexOf(':')),
        line: Number(firstExternal.slice(firstExternal.lastIndexOf(':') + 1)) || null,
        detail: `top located frame is third-party: ${firstExternal}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`,
      };
    }
    return {
      outcome: 'unattributable',
      logicalId: null,
      path: null,
      line: null,
      detail:
        entry.frames.length === 0
          ? 'the entry carries no stack frames'
          : notes.length > 0
            ? notes.slice(0, 4).join('; ')
            : 'every frame was internal or location-less',
    };
  };
}
