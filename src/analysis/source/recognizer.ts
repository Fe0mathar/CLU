/**
 * CLUE TypeScript recognizer.
 *
 * Spec: CLUE_Architecture_v8.md (unit identity; compiler-grade resolution; edge taxonomy),
 *       CLUE_Execution_Model_v8.md (recognition & incremental rescan).
 * Backlog: DEV-P0-03 — versioned RecognitionBasis and collision-free identity-v4.
 *
 * Turns a source tree into units and the edges between them.
 *
 * Driven by a real `ts.Program` built from the target's own `tsconfig.json`, not by a
 * syntax-only parser. That choice is the most consequential one in Stage C, and it is
 * not about convenience:
 *
 *   - Path aliases. `@/render/frame` is a string to a syntax parser and a resolved file
 *     to the compiler. A recognizer that cannot resolve it produces a graph with a hole
 *     exactly where the project's internal structure lives.
 *   - Symbol identity. Two functions named `update` in different modules share a token
 *     and differ as symbols. Without the checker, every call to either would attach to
 *     whichever the recognizer happened to see first, and the impact analysis built on
 *     that graph would be confidently wrong.
 *   - Re-exports and barrels. `export * from './ocean'` moves symbols between modules
 *     without naming them.
 *
 * Two disciplines run through the file. **Diagnostics do not stop recognition**:
 * the target project may not typecheck cleanly at any given moment, and a recognizer that refuses
 * to read an imperfect project is useless exactly when it is most needed — so the
 * diagnostic counts are reported as evidence instead. And **ambiguity is recorded, not
 * resolved**: a computed dynamic import, an unresolvable module, a callee the checker
 * cannot type — each becomes an entry in `unresolved` with an anchor, so the graph's
 * blind spots are visible rather than silently absent.
 *
 * This module is pure analysis: source in, result out. Persistence, the graph
 * projection, and incremental caching live elsewhere.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

import ts from 'typescript';

import { hashBytes, hashCanonicalJson, hashText, normalisePath, type Sha256 } from '../../shared/ids.js';
import type { ProjectRecognitionIdentity } from '../../shared/projectRecognitionIdentity.js';
import { absolutePathForm } from '../../shared/schemas.js';
import { ALWAYS_EXCLUDED } from './snapshot.js';
import { decodeSourceByteRange, sourceTextLayout, type SourceTextLayout } from './sourceEncoding.js';

/**
 * The logical-id algorithm version. Bumped whenever the grammar changes, and recorded in the
 * RecognitionBasis so a stored graph declares exactly which identity rules produced it.
 *
 * identity-v4 separates stable symbol identities from declaration-contract identities:
 * concrete function/method implementations keep a stable symbol id, while overload signatures,
 * declaration kinds, anonymous structural contexts, namespaces, and merged declarations receive
 * deterministic declaration identities. The grammar never adds or removes a discriminator merely
 * because a sibling appeared or disappeared.
 */
export const RECOGNITION_IDENTITY_ALGORITHM = 'identity-v4';
export const RECOGNIZER_VERSION = 'clue-recognizer/4';

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

export type UnitKind =
  | 'module'
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'typeAlias'
  | 'enum'
  | 'variable'
  | 'property';

/**
 * Where a unit lives, precisely enough to re-read it.
 *
 * Byte offsets match the captured file, including the encoding prefix when present.
 */
export interface UnitAnchor {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startByte: number;
  readonly endByte: number;
}

export interface SourceUnit {
  /**
   * Stable across versions: `modulePath#qualifiedName`. A unit keeps this identity
   * while its body changes, which is what lets a metric have a history.
   */
  readonly logicalId: string;
  /** Content identity: hash of the declaration's exact text at this snapshot. */
  readonly versionHash: Sha256;
  readonly kind: UnitKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly modulePath: string;
  readonly exported: boolean;
  readonly anchor: UnitAnchor;
  /** Enclosing unit, e.g. the class of a method. Modules have none. */
  readonly parentLogicalId: string | null;
  readonly lineCount: number;
  readonly byteLength: number;
  readonly isAsync: boolean;
  readonly parameterCount: number | null;
}

export type EdgeKind =
  | 'imports'
  | 'reexports'
  | 'calls'
  | 'instantiates'
  | 'extends'
  | 'implements'
  | 'references'
  | 'declares';

export interface SourceEdge {
  readonly from: string;
  /** A logical id, or `external:<name>` when the target is outside the program. */
  readonly to: string;
  readonly kind: EdgeKind;
  /** 1 when the checker resolved it to a single declaration; lower when uncertain. */
  readonly confidence: number;
  readonly external: boolean;
  readonly anchor: UnitAnchor;
}

export type UnresolvedKind =
  | 'dynamic-import'
  | 'module-unresolved'
  | 'call-target-unknown'
  | 'symbol-ambiguous'
  | 'declaration-missing';

/** A place where the graph is knowingly incomplete. */
export interface UnresolvedReference {
  readonly kind: UnresolvedKind;
  readonly detail: string;
  readonly anchor: UnitAnchor;
  readonly fromLogicalId: string | null;
}

export interface RecognitionStats {
  readonly filesInProgram: number;
  readonly filesRecognised: number;
  readonly unitsByKind: Readonly<Record<string, number>>;
  readonly edgesByKind: Readonly<Record<string, number>>;
  readonly unresolvedByKind: Readonly<Record<string, number>>;
  readonly syntacticDiagnostics: number;
  readonly semanticDiagnostics: number;
  readonly elapsedMs: number;
}

export type RecognitionExtractionScope =
  | { readonly mode: 'full' }
  | { readonly mode: 'restricted'; readonly files: readonly string[] };

/**
 * The exact, versioned basis a recognition result was produced from (DEV-P0-03). Binding
 * it is what lets a result hash *prove* which bytes and settings the recognizer analysed:
 * the identity algorithm, the recognizer build, the compiler options, and a hash over every
 * project file in the program. Snapshot/capture/lockfile identities are supplied by the
 * caller when available and included so the whole basis travels with the result.
 */
export interface RecognitionBasis {
  readonly identityAlgorithm: string;
  readonly recognizerVersion: string;
  readonly tsconfigPath: string;
  readonly compilerOptionsHash: Sha256;
  /** The TypeScript compiler version that produced this result (`ts.version`). */
  readonly tsCompilerVersion: string;
  /** Hash of the raw `tsconfig.json` bytes — distinct from the resolved compiler-options hash. */
  readonly tsconfigHash: Sha256;
  readonly programFileCount: number;
  /** Hash over the sorted (path, content-hash) list of every project file in the program. */
  readonly programFilesHash: Sha256;
  readonly extractionScope: RecognitionExtractionScope;
  readonly snapshotId?: string;
  readonly captureId?: string;
  readonly lockfileHash?: string;
  /** Exact Project Profile recognition generation governing this result, when profile-bound. */
  readonly projectRecognition?: ProjectRecognitionIdentity;
  /**
   * Whether the snapshot binding was byte-verified (DEV-P0-03). True only when the caller supplied the
   * snapshot's file hashes and every compiled file matched. A recorder that requires a genuine
   * snapshot binding checks this rather than the mere presence of `snapshotId`.
   */
  readonly snapshotParityVerified: boolean;
}

export interface RecognitionResult {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  /** Hash of the resolved compiler options; a change invalidates cached recognition. */
  readonly compilerOptionsHash: Sha256;
  /** The exact, versioned inputs this result was produced from. */
  readonly basis: RecognitionBasis;
  /** Content hash of `basis`; a change means a different analysed program or settings. */
  readonly basisHash: Sha256;
  readonly units: readonly SourceUnit[];
  readonly edges: readonly SourceEdge[];
  readonly unresolved: readonly UnresolvedReference[];
  readonly stats: RecognitionStats;
  /**
   * Every project file in the analysed program, with the content hash the recognizer actually read
   * (DEV-P0-03). `programFilesHash` in the basis is a digest of this; exposing the list lets a caller
   * prove the analysed program equals an immutable snapshot — every file matched, nothing unaccounted.
   */
  readonly programFiles: readonly ProgramFile[];
}

/** One file in the analysed program: its module path and the hash of the exact bytes recognised. */
export interface ProgramFile {
  readonly path: string;
  readonly hash: Sha256;
}

/** The outcome of checking an analysed program against an immutable snapshot's files (DEV-P0-03). */
export interface SnapshotParityReport {
  /** Program files whose path and hash match a snapshot file exactly. */
  readonly matched: readonly string[];
  /** Program files with no snapshot file at that path, or a different hash — unaccounted evidence. */
  readonly unaccounted: readonly string[];
  /** Snapshot files absent from the program that this adapter does not analyse — correctly omitted. */
  readonly unsupportedOmitted: readonly string[];
  /** Snapshot files this adapter would analyse but which are absent from the program — a real gap. */
  readonly supportedOmitted: readonly string[];
  /** True only when nothing is unaccounted and no supported snapshot file was omitted. */
  readonly exact: boolean;
}

/**
 * Verifies an analysed program against an immutable snapshot (DEV-P0-03). Recognition may claim a
 * snapshot id, but a claim is not proof: this checks that every analysed program file has a matching
 * snapshot file hash, and that every snapshot file the program did not analyse is one this adapter
 * does not support (so its omission is explained, not silent). `isSupported` decides, from a snapshot
 * file's path, whether this adapter would have analysed it. The result is exact only when nothing is
 * unaccounted and no supported snapshot file was omitted — i.e. no unaccounted live file influenced
 * the program and no snapshot evidence was dropped.
 */
export function verifyProgramSnapshotParity(
  programFiles: readonly ProgramFile[],
  snapshotFiles: readonly { readonly path: string; readonly hash: string }[],
  isSupported: (path: string) => boolean,
): SnapshotParityReport {
  const snapshotByPath = new Map(snapshotFiles.map((file) => [file.path, file.hash]));
  const programByPath = new Map(programFiles.map((file) => [file.path, file.hash]));

  const matched: string[] = [];
  const unaccounted: string[] = [];
  for (const file of programFiles) {
    if (snapshotByPath.get(file.path) === file.hash) {
      matched.push(file.path);
    } else {
      unaccounted.push(file.path);
    }
  }

  const unsupportedOmitted: string[] = [];
  const supportedOmitted: string[] = [];
  for (const file of snapshotFiles) {
    if (programByPath.has(file.path)) continue;
    if (isSupported(file.path)) {
      supportedOmitted.push(file.path);
    } else {
      unsupportedOmitted.push(file.path);
    }
  }

  const sort = (list: string[]): string[] => list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    matched: sort(matched),
    unaccounted: sort(unaccounted),
    unsupportedOmitted: sort(unsupportedOmitted),
    supportedOmitted: sort(supportedOmitted),
    exact: unaccounted.length === 0 && supportedOmitted.length === 0,
  };
}

/**
 * Read-only recognition telemetry seam.
 *
 * Observers receive records at the moment the recognizer has already established them.
 * They cannot alter recognition truth. Observer failures are isolated and reported
 * through `onObserverError` rather than aborting the source scan.
 */
export interface RecognitionObserver {
  readonly onScanStart?: (event: { readonly total: number }) => void;
  readonly onFileStart?: (event: {
    readonly path: string;
    readonly index: number;
    readonly total: number;
  }) => void;
  readonly onUnit?: (unit: SourceUnit) => void;
  readonly onEdge?: (edge: SourceEdge) => void;
  readonly onUnresolved?: (reference: UnresolvedReference) => void;
  readonly onFileComplete?: (event: {
    readonly path: string;
    readonly index: number;
    readonly total: number;
    readonly unitCount: number;
    readonly edgeCount: number;
  }) => void;
  readonly onScanComplete?: (result: RecognitionResult) => void;
  readonly onObserverError?: (event: {
    readonly operation: string;
    readonly error: unknown;
  }) => void;
}

export interface RecognizeOptions {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  /**
   * Restricts which files units are extracted from.
   *
   * The program is always built whole, because resolution needs the entire graph, but
   * extraction can be limited to the files a snapshot diff says changed. That asymmetry
   * — full resolution, partial extraction — is what incremental rescan depends on.
   */
  readonly restrictTo?: readonly string[];
  /** Path segments never recognised, in addition to node_modules and library files. */
  readonly exclude?: readonly string[];
  /** Optional read-only stream used by the System Navigator and other observers. */
  readonly observer?: RecognitionObserver;
  /** Content identity of the snapshot this recognition is bound to, when known. */
  readonly snapshotId?: string;
  /**
   * The snapshot's file hashes (module path -> raw-byte hash), DEV-P0-03. When supplied, recognition
   * hashes each compiled file's bytes as they are read and refuses (RecognitionParityError) unless
   * every project input matches;
   * the basis then records `snapshotParityVerified: true`. Omitting them records the snapshot id as an
   * unverified claim (`snapshotParityVerified: false`), which a recorder can reject.
   */
  readonly snapshotFiles?: ReadonlyMap<string, string>;
  /** Identity of the capture receipt the snapshot came from, when known. */
  readonly captureId?: string;
  /** Hash of the dependency lockfile in effect, when the caller can supply it. */
  readonly lockfileHash?: string;
  /** Exact Project Profile recognition generation governing this run, when profile-bound. */
  readonly projectRecognition?: ProjectRecognitionIdentity;
}

export class RecognizerError extends Error {
  public readonly code:
    | 'CONFIG_UNREADABLE'
    | 'CONFIG_INVALID'
    | 'NO_INPUTS'
    | 'IDENTITY_COLLISION';

  public constructor(code: RecognizerError['code'], message: string) {
    super(message);
    this.name = 'RecognizerError';
    this.code = code;
  }
}

/** One file where the recognised program diverges from the snapshot it claims to be bound to. */
export interface SnapshotParityViolation {
  readonly path: string;
  readonly reason: 'not-in-snapshot' | 'hash-mismatch' | 'unreadable';
}

interface CompilerSourceRead extends SourceTextLayout {
  readonly text: string;
  readonly hash: Sha256;
}

/**
 * Thrown when a recognition is asked to bind to a snapshot but the bytes the compiler read do not
 * match that snapshot (DEV-P0-03). A result that records a snapshot id it never checked is not
 * snapshot-bound — it merely claims to be — so parity is verified before the binding is recorded, and
 * a divergence is refused rather than written into the basis.
 */
export class RecognitionParityError extends Error {
  public readonly violations: readonly SnapshotParityViolation[];

  public constructor(message: string, violations: readonly SnapshotParityViolation[]) {
    super(message);
    this.name = 'RecognitionParityError';
    this.violations = violations;
  }
}

/* ------------------------------------------------------------------------- */
/* Byte mapping                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Maps TypeScript character positions to byte offsets in the file it read.
 *
 * The compiler counts UTF-16 code units; snapshots, documents, and patches count bytes.
 * Mixing the two produces anchors that look right and point a few bytes early on any
 * file containing a non-ASCII character.
 *
 * Line byte-starts are computed once per file, so a lookup costs one slice of the
 * containing line rather than of the whole file — the difference between linear and
 * quadratic cost over a large source tree.
 */
class ByteMapper {
  private readonly text: string;
  private readonly lineStarts: readonly number[];
  private readonly lineByteStarts: number[];
  private readonly utf16: boolean;

  public constructor(sourceFile: ts.SourceFile, sourceRead: CompilerSourceRead) {
    this.text = sourceFile.text;
    this.lineStarts = sourceFile.getLineStarts();
    this.lineByteStarts = new Array<number>(this.lineStarts.length).fill(0);
    this.utf16 = sourceRead.encoding !== 'utf8';

    let byteOffset = sourceRead.bomBytes;
    for (let line = 0; line < this.lineStarts.length; line += 1) {
      this.lineByteStarts[line] = byteOffset;
      const start = this.lineStarts[line] ?? 0;
      const end = this.lineStarts[line + 1] ?? this.text.length;
      byteOffset += this.byteLength(start, end);
    }
  }

  /** Zero-based line index containing `position`. */
  public lineOf(position: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.lineStarts[middle] ?? 0) <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  public byteOf(position: number): number {
    const line = this.lineOf(position);
    const lineStart = this.lineStarts[line] ?? 0;
    const lineByteStart = this.lineByteStarts[line] ?? 0;
    return lineByteStart + this.byteLength(lineStart, position);
  }

  private byteLength(start: number, end: number): number {
    return this.utf16 ? (end - start) * 2 : Buffer.byteLength(this.text.slice(start, end), 'utf8');
  }
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Builds a program from the project's own tsconfig and recognises it.
 *
 * The project's configuration is used rather than a synthesised one, so CLUE sees the
 * code the way the project's build sees it. A recognizer with different module
 * resolution than the build is measuring a program that does not exist.
 */
/**
 * Compare the entire compiler input to the snapshot, including files used for dependency
 * resolution during a restricted extraction. The digest comes from the compiler's read.
 */
function snapshotParityViolations(
  projectFiles: readonly ProgramFile[],
  snapshotFiles: ReadonlyMap<string, string>,
): SnapshotParityViolation[] {
  const violations: SnapshotParityViolation[] = [];
  for (const file of projectFiles) {
    const expected = snapshotFiles.get(file.path);
    if (expected === undefined) {
      violations.push({ path: file.path, reason: 'not-in-snapshot' });
    } else if (file.hash !== expected) {
      violations.push({ path: file.path, reason: 'hash-mismatch' });
    }
  }
  return violations;
}

export function recognize(options: RecognizeOptions): RecognitionResult {
  const started = Date.now();
  const projectRoot = options.projectRoot;
  const exclude = new Set([...ALWAYS_EXCLUDED, ...(options.exclude ?? [])]);
  const { program, parsed, configText, compilerRead, readViolations } = buildProgram(options, exclude);
  const restrictTo =
    options.restrictTo === undefined ? null : new Set(options.restrictTo.map(normalisePath));

  const units: SourceUnit[] = [];
  const edges: SourceEdge[] = [];
  const unresolved: UnresolvedReference[] = [];

  const sourceFiles = program.getSourceFiles();
  const compilerFiles = sourceFiles.filter((sourceFile) => isProjectFile(sourceFile, projectRoot, exclude))
    .map((sourceFile) => {
      const path = toModulePath(projectRoot, sourceFile.fileName);
      const read = compilerRead(path);
      if (read === undefined || read.text !== sourceFile.text) {
        throw new RecognitionParityError(`Compiler input could not be verified for ${path}`, [
          { path, reason: 'unreadable' },
        ]);
      }
      return { sourceFile, path, read };
    });
  const programFiles = compilerFiles
    .map(({ path, read }) => ({ path, hash: read.hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const projectFiles = restrictTo === null
    ? compilerFiles
    : compilerFiles.filter(({ path }) => restrictTo.has(path));

  // DEV-P0-03: snapshot/program parity is verified BEFORE anything is recorded. Recording a snapshot
  // id the recogniser never checked would be a claim, not a binding — so if this recognition names a
  // snapshot, its file hashes must be supplied, and every compiled file's bytes must match them.
  // DEV-P0-03: when a snapshot's file hashes are supplied, parity is verified BEFORE anything is
  // recorded — a divergence (the working tree moved on, a file the snapshot never captured, an
  // unreadable file) is refused rather than written into the basis. The basis records whether this
  // check actually ran, so a downstream recorder can REQUIRE a byte-verified binding and never treat an
  // unverified snapshot id as proof of binding. Carrying an id is a claim; a passed check is a binding.
  let snapshotParityVerified = false;
  if (options.snapshotFiles !== undefined) {
    const violations = [...readViolations.values(), ...snapshotParityViolations(programFiles, options.snapshotFiles)];
    if (violations.length > 0) {
      throw new RecognitionParityError(
        `recognised program does not match snapshot ${options.snapshotId ?? '(unnamed)'}: ${violations.length} file(s) diverge`,
        violations,
      );
    }
    snapshotParityVerified = true;
  }
  const checker = program.getTypeChecker();

  observe(options.observer, 'scan-start', (observer) => {
    observer.onScanStart?.({ total: projectFiles.length });
  });

  for (const [index, { sourceFile, path: modulePath, read }] of projectFiles.entries()) {

    observe(options.observer, 'file-start', (observer) => {
      observer.onFileStart?.({ path: modulePath, index, total: projectFiles.length });
    });

    const unitStart = units.length;
    const edgeStart = edges.length;
    const unresolvedStart = unresolved.length;

    recogniseFile({
      sourceFile,
      sourceRead: read,
      modulePath,
      projectRoot,
      exclude,
      checker,
      units,
      edges,
      unresolved,
    });

    for (const unit of units.slice(unitStart)) {
      observe(options.observer, 'unit', (observer) => observer.onUnit?.(unit));
    }
    for (const edge of edges.slice(edgeStart)) {
      observe(options.observer, 'edge', (observer) => observer.onEdge?.(edge));
    }
    for (const reference of unresolved.slice(unresolvedStart)) {
      observe(options.observer, 'unresolved', (observer) => observer.onUnresolved?.(reference));
    }

    observe(options.observer, 'file-complete', (observer) => {
      observer.onFileComplete?.({
        path: modulePath,
        index: index + 1,
        total: projectFiles.length,
        unitCount: units.length - unitStart,
        edgeCount: edges.length - edgeStart,
      });
    });
  }

  const compilerOptionsHash = hashText(JSON.stringify(sortObject(parsed.options as object)));
  // Bind the actual configuration text separately from the resolved compiler options.
  const tsconfigHash = hashText(configText);

  // Identity invariant: identity-v4 assigns every semantic unit a unique logical id. If two
  // units ever share one, a downstream key would silently merge distinct declarations, so
  // recognition fails loudly here rather than persisting an ambiguous graph.
  const unitIds = new Set(units.map((unit) => unit.logicalId));
  if (unitIds.size !== units.length) {
    const duplicates = findDuplicateIds(units.map((unit) => unit.logicalId));
    throw new RecognizerError(
      'IDENTITY_COLLISION',
      `Recognition produced ${units.length - unitIds.size} colliding logical id(s): ` +
        `${duplicates.slice(0, 8).join(', ')}${duplicates.length > 8 ? ', …' : ''}`,
    );
  }

  // Endpoint integrity: in a full scan every project file is recognised, so every internal
  // edge must resolve to a unit. Any that does not is a broken endpoint; it is downgraded to
  // an honest unresolved reference rather than persisted as a dangling edge. Incremental
  // extraction is a subset of the program, so this reconciliation is scoped to full scans.
  let resolvedEdges: readonly SourceEdge[] = edges;
  if (restrictTo === null) {
    const kept: SourceEdge[] = [];
    for (const edge of edges) {
      if (edge.external || unitIds.has(edge.to)) {
        kept.push(edge);
        continue;
      }
      unresolved.push({
        kind: 'declaration-missing',
        detail: `Internal edge target "${edge.to}" resolves to no recognised unit`,
        anchor: edge.anchor,
        fromLogicalId: edge.from,
      });
    }
    resolvedEdges = kept;
  }

  const basis: RecognitionBasis = {
    identityAlgorithm: RECOGNITION_IDENTITY_ALGORITHM,
    recognizerVersion: RECOGNIZER_VERSION,
    tsconfigPath: options.tsconfigPath,
    compilerOptionsHash,
    tsCompilerVersion: ts.version,
    tsconfigHash,
    programFileCount: programFiles.length,
    programFilesHash: hashCanonicalJson(programFiles),
    extractionScope:
      restrictTo === null
        ? { mode: 'full' }
        : { mode: 'restricted', files: [...restrictTo].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) },
    ...(options.snapshotId !== undefined ? { snapshotId: options.snapshotId } : {}),
    ...(options.captureId !== undefined ? { captureId: options.captureId } : {}),
    ...(options.lockfileHash !== undefined ? { lockfileHash: options.lockfileHash } : {}),
    ...(options.projectRecognition !== undefined
      ? { projectRecognition: options.projectRecognition }
      : {}),
    snapshotParityVerified,
  };

  const result: RecognitionResult = {
    projectRoot,
    tsconfigPath: options.tsconfigPath,
    compilerOptionsHash,
    basis,
    basisHash: hashCanonicalJson(basis),
    units,
    edges: resolvedEdges,
    unresolved,
    stats: {
      filesInProgram: sourceFiles.length,
      filesRecognised: projectFiles.length,
      unitsByKind: countBy(units, (unit) => unit.kind),
      edgesByKind: countBy(resolvedEdges, (edge) => edge.kind),
      unresolvedByKind: countBy(unresolved, (entry) => entry.kind),
      // Counted, never fatal. A project that does not currently typecheck is still a
      // project CLUE must be able to read and reason about.
      syntacticDiagnostics: program.getSyntacticDiagnostics().length,
      semanticDiagnostics: program.getSemanticDiagnostics().length,
      elapsedMs: Date.now() - started,
    },
    programFiles,
  };

  observe(options.observer, 'scan-complete', (observer) => {
    observer.onScanComplete?.(result);
  });
  return result;
}

function observe(
  observer: RecognitionObserver | undefined,
  operation: string,
  notify: (observer: RecognitionObserver) => void,
): void {
  if (observer === undefined) return;
  try {
    notify(observer);
  } catch (error) {
    try {
      observer.onObserverError?.({ operation, error });
    } catch {
      // Telemetry may never change recognition behavior.
    }
  }
}

function buildProgram(options: RecognizeOptions, exclude: ReadonlySet<string>): {
  program: ts.Program;
  parsed: ts.ParsedCommandLine;
  configText: string;
  compilerRead: (modulePath: string) => CompilerSourceRead | undefined;
  readViolations: ReadonlyMap<string, SnapshotParityViolation>;
} {
  const configText = ts.sys.readFile(options.tsconfigPath);
  const configFile = ts.readConfigFile(options.tsconfigPath, () => configText);
  if (configFile.error !== undefined) {
    throw new RecognizerError(
      'CONFIG_UNREADABLE',
      `Could not read ${options.tsconfigPath}: ${flattenDiagnostic(configFile.error)}`,
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(options.tsconfigPath),
    undefined,
    options.tsconfigPath,
  );

  const fatal = parsed.errors.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (fatal.length > 0) {
    throw new RecognizerError(
      'CONFIG_INVALID',
      `Invalid tsconfig: ${fatal.map(flattenDiagnostic).join('; ')}`,
    );
  }

  if (parsed.fileNames.length === 0) {
    throw new RecognizerError('NO_INPUTS', `${options.tsconfigPath} matched no input files`);
  }

  const host = ts.createCompilerHost(parsed.options);
  const defaultRead = host.readFile;
  const reads = new Map<string, CompilerSourceRead>();
  const readViolations = new Map<string, SnapshotParityViolation>();
  const snapshotFiles = options.snapshotFiles;
  if (snapshotFiles !== undefined) {
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (fileName, ...args) => {
      const path = toModulePath(options.projectRoot, fileName);
      if (isProjectModulePath(path, exclude) && !snapshotFiles.has(path) && host.fileExists(fileName)) {
        readViolations.set(path, { path, reason: 'not-in-snapshot' });
        return undefined;
      }
      return getSourceFile(fileName, ...args);
    };
  }
  host.readFile = (fileName) => {
    const modulePath = toModulePath(options.projectRoot, fileName);
    if (!isProjectModulePath(modulePath, exclude)) return defaultRead(fileName);
    const key = host.getCanonicalFileName(modulePath);
    const existing = reads.get(key);
    if (existing !== undefined) return existing.text;
    try {
      const read = readCompilerSource(fileName);
      reads.set(key, read);
      return read.text;
    } catch {
      if (snapshotFiles?.has(modulePath) === true) {
        readViolations.set(modulePath, { path: modulePath, reason: 'unreadable' });
      }
      return undefined;
    }
  };
  return {
    program: ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host }),
    parsed,
    configText: configText ?? '',
    compilerRead: (modulePath) => reads.get(host.getCanonicalFileName(modulePath)),
    readViolations,
  };
}

function readCompilerSource(path: string): CompilerSourceRead {
  const bytes = readFileSync(path);
  const layout = sourceTextLayout(bytes);
  return { ...layout, hash: hashBytes(bytes), text: decodeSourceByteRange(bytes, layout) };
}

function flattenDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}

/* ------------------------------------------------------------------------- */
/* File recognition                                                           */
/* ------------------------------------------------------------------------- */

interface FileContext {
  readonly sourceFile: ts.SourceFile;
  readonly sourceRead: CompilerSourceRead;
  readonly modulePath: string;
  readonly projectRoot: string;
  readonly exclude: ReadonlySet<string>;
  readonly checker: ts.TypeChecker;
  readonly units: SourceUnit[];
  readonly edges: SourceEdge[];
  readonly unresolved: UnresolvedReference[];
}

function recogniseFile(context: FileContext): void {
  const mapper = new ByteMapper(context.sourceFile, context.sourceRead);
  const moduleId = context.modulePath;

  context.units.push({
    logicalId: moduleId,
    versionHash: hashText(context.sourceFile.text),
    kind: 'module',
    name: baseName(context.modulePath),
    qualifiedName: context.modulePath,
    modulePath: context.modulePath,
    exported: true,
    anchor: anchorOfRange(context.modulePath, mapper, 0, context.sourceFile.end),
    parentLogicalId: null,
    lineCount: context.sourceFile.getLineStarts().length,
    byteLength: mapper.byteOf(context.sourceFile.end) - mapper.byteOf(0),
    isAsync: false,
    parameterCount: null,
  });

  visit(context.sourceFile, moduleId, context, mapper);
}

interface DeclarationDescription {
  /** The owner id descendants must use, even when this declaration is merged into an existing unit. */
  readonly ownerId: string;
  /** Null for a non-canonical declaration of a merged semantic unit. */
  readonly unit: SourceUnit | null;
}

function visit(node: ts.Node, ownerId: string, context: FileContext, mapper: ByteMapper): void {
  const declared = describeDeclaration(node, ownerId, context, mapper);
  const nextOwner = declared === null ? ownerId : declared.ownerId;

  if (declared?.unit !== null && declared !== null) {
    context.units.push(declared.unit);
    context.edges.push({
      from: ownerId,
      to: declared.unit.logicalId,
      kind: 'declares',
      confidence: 1,
      external: false,
      anchor: declared.unit.anchor,
    });
  }

  collectEdges(node, nextOwner, context, mapper);
  ts.forEachChild(node, (child) => {
    visit(child, nextOwner, context, mapper);
  });
}

/**
 * Recognises a declaration, or returns null when the node declares nothing.
 *
 * Interfaces and enums are semantic merge units in TypeScript. Several declaration nodes can
 * therefore describe one symbol. identity-v4 emits one aggregate unit and lets every contributing
 * declaration use that same owner id, so adding another merge fragment changes the unit version but
 * never creates a collision or renames all of its children.
 */
function describeDeclaration(
  node: ts.Node,
  ownerId: string,
  context: FileContext,
  mapper: ByteMapper,
): DeclarationDescription | null {
  const kind = recognisedUnitKind(node);
  if (kind === null) return null;
  const name = recognisedName(node);
  if (name === null) return null;

  const logicalId = logicalIdOf(node, context.modulePath);
  if (logicalId === null) return null;

  const aggregate = aggregateDeclarations(node);
  if (aggregate.length > 1 && aggregate[0] !== node) {
    return { ownerId: logicalId, unit: null };
  }

  const start = node.getStart(context.sourceFile);
  const anchor = anchorOfRange(context.modulePath, mapper, start, node.end);
  const versionHash =
    aggregate.length <= 1
      ? hashText(context.sourceFile.text.slice(start, node.end))
      : hashCanonicalJson(
          aggregate
            .map((declaration) => normalisePrinted(declaration))
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        );

  const unit: SourceUnit = {
    logicalId,
    versionHash,
    kind,
    name,
    qualifiedName: localName(logicalId),
    modulePath: context.modulePath,
    exported: aggregate.some((declaration) => unitExported(declaration)),
    anchor,
    parentLogicalId: ownerId,
    lineCount: anchor.endLine - anchor.startLine + 1,
    byteLength: anchor.endByte - anchor.startByte,
    isAsync: unitIsAsync(node),
    parameterCount: unitParameterCount(node),
  };

  return { ownerId: logicalId, unit };
}

/* ------------------------------------------------------------------------- */
/* Edges                                                                      */
/* ------------------------------------------------------------------------- */

function collectEdges(
  node: ts.Node,
  ownerId: string,
  context: FileContext,
  mapper: ByteMapper,
): void {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    collectModuleEdge(node, ownerId, context, mapper);
    return;
  }

  if (ts.isCallExpression(node)) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      collectDynamicImport(node, ownerId, context, mapper);
      return;
    }
    resolveCallLikeTarget(node, ownerId, 'calls', context, mapper);
    return;
  }

  if (ts.isNewExpression(node)) {
    resolveCallLikeTarget(node, ownerId, 'instantiates', context, mapper);
    return;
  }

  if (ts.isHeritageClause(node)) {
    const kind: EdgeKind = node.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
    for (const type of node.types) {
      resolveTarget(type.expression, ownerId, kind, context, mapper);
    }
    return;
  }

  if (ts.isTypeReferenceNode(node)) {
    resolveTarget(node.typeName, ownerId, 'references', context, mapper);
  }
}

function collectModuleEdge(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  ownerId: string,
  context: FileContext,
  mapper: ByteMapper,
): void {
  const specifier = node.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return;

  const anchor = anchorOf(node, context, mapper);
  const kind: EdgeKind = ts.isImportDeclaration(node) ? 'imports' : 'reexports';
  const symbol = context.checker.getSymbolAtLocation(specifier);
  const declaration = symbol?.declarations?.[0];

  if (declaration !== undefined && ts.isSourceFile(declaration)) {
    const internal = isProjectFile(declaration, context.projectRoot, context.exclude);
    context.edges.push({
      from: context.modulePath,
      to: internal
        ? toModulePath(context.projectRoot, declaration.fileName)
        : `external:${specifier.text}`,
      kind,
      confidence: 1,
      external: !internal,
      anchor,
    });
    return;
  }

  // A relative specifier the checker could not resolve is a genuine hole in the graph.
  // A bare specifier is simply a dependency the program does not include, which is
  // expected rather than notable.
  if (specifier.text.startsWith('.')) {
    context.unresolved.push({
      kind: 'module-unresolved',
      detail: `Could not resolve "${specifier.text}"`,
      anchor,
      fromLogicalId: ownerId,
    });
  }

  context.edges.push({
    from: context.modulePath,
    to: `external:${specifier.text}`,
    kind,
    confidence: 0.5,
    external: true,
    anchor,
  });
}

/**
 * Handles `import(...)`.
 *
 * A literal specifier resolves like a static import. A computed one cannot be resolved
 * without running the program, so it is recorded as unresolved rather than guessed: an
 * invented edge would place a dependency in the graph that may not exist, and impact
 * analysis would then protect or blame the wrong module.
 */
function collectDynamicImport(
  node: ts.CallExpression,
  ownerId: string,
  context: FileContext,
  mapper: ByteMapper,
): void {
  const anchor = anchorOf(node, context, mapper);
  const argument = node.arguments[0];

  if (argument !== undefined && ts.isStringLiteral(argument)) {
    const symbol = context.checker.getSymbolAtLocation(argument);
    const declaration = symbol?.declarations?.[0];
    if (declaration !== undefined && ts.isSourceFile(declaration)) {
      const internal = isProjectFile(declaration, context.projectRoot, context.exclude);
      context.edges.push({
        from: context.modulePath,
        to: internal
          ? toModulePath(context.projectRoot, declaration.fileName)
          : `external:${argument.text}`,
        kind: 'imports',
        confidence: 1,
        external: !internal,
        anchor,
      });
      return;
    }
  }

  context.unresolved.push({
    kind: 'dynamic-import',
    detail:
      argument === undefined
        ? 'import() with no argument'
        : 'import() with a non-literal specifier; the target cannot be resolved statically',
    anchor,
    fromLogicalId: ownerId,
  });
}

/** A normalized target that can be emitted as a graph edge. */
interface DeclarationTarget {
  readonly id: string;
  readonly external: boolean;
}

/**
 * Resolves a call/new expression through the compiler's selected signature. This is load-bearing for
 * overload identity: `f(1)` and `f("x")` must point to the number and string contracts respectively,
 * not to whichever declaration happened to appear first in the symbol's declaration array.
 */
function resolveCallLikeTarget(
  call: ts.CallExpression | ts.NewExpression,
  ownerId: string,
  kind: Extract<EdgeKind, 'calls' | 'instantiates'>,
  context: FileContext,
  mapper: ByteMapper,
): void {
  const expression = call.expression;
  const anchor = anchorOf(expression, context, mapper);
  const signature = context.checker.getResolvedSignature(call);
  const declaration = signature?.declaration;

  if (declaration !== undefined) {
    const target = declarationTarget(declaration, expression, context);
    if (target !== null) {
      context.edges.push({
        from: ownerId,
        to: target.id,
        kind,
        confidence: 1,
        external: target.external,
        anchor,
      });
      return;
    }
  }

  // Some dynamic/union call sites have no unique resolved signature. Fall back to symbol-level
  // resolution, which records ambiguity explicitly and never chooses declarations[0].
  resolveTarget(expression, ownerId, kind, context, mapper);
}

/**
 * Resolves a referenced entity to one or more declarations and records edges.
 *
 * Aliases are followed. Merged declarations that share one aggregate logical id collapse to one
 * target. Genuine ambiguity produces all plausible edges at reduced confidence plus an unresolved
 * record; selecting the first declaration is forbidden because source order is not semantic identity.
 */
function resolveTarget(
  expression: ts.Node,
  ownerId: string,
  kind: EdgeKind,
  context: FileContext,
  mapper: ByteMapper,
): void {
  const anchor = anchorOf(expression, context, mapper);

  let symbol = context.checker.getSymbolAtLocation(expression);
  if (symbol === undefined && ts.isPropertyAccessExpression(expression)) {
    symbol = context.checker.getSymbolAtLocation(expression.name);
  }

  if (symbol === undefined) {
    if (kind === 'calls') {
      context.unresolved.push({
        kind: 'call-target-unknown',
        detail: `Callee "${truncate(expression.getText(context.sourceFile))}" has no resolvable symbol`,
        anchor,
        fromLogicalId: ownerId,
      });
    }
    return;
  }

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = context.checker.getAliasedSymbol(symbol);
    } catch {
      // An alias that cannot be followed surfaces below as a missing declaration.
    }
  }

  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) {
    context.unresolved.push({
      kind: 'declaration-missing',
      detail: `Symbol "${symbol.getName()}" has no declaration in the program`,
      anchor,
      fromLogicalId: ownerId,
    });
    return;
  }

  const targets = new Map<string, DeclarationTarget>();
  let nonUnitDeclarations = 0;
  for (const declaration of declarations) {
    const target = declarationTarget(declaration, expression, context, symbol.getName());
    if (target === null) {
      nonUnitDeclarations += 1;
      continue;
    }
    targets.set(`${target.external ? 'external' : 'internal'}:${target.id}`, target);
  }

  if (targets.size === 0) {
    context.unresolved.push({
      kind: 'declaration-missing',
      detail:
        nonUnitDeclarations > 0
          ? `Target "${symbol.getName()}" resolves only to local or non-unit declarations`
          : `Target "${symbol.getName()}" has no stable unit identity`,
      anchor,
      fromLogicalId: ownerId,
    });
    return;
  }

  const ambiguous = targets.size > 1;
  if (ambiguous) {
    context.unresolved.push({
      kind: 'symbol-ambiguous',
      detail: `Symbol "${symbol.getName()}" resolves to ${targets.size} semantic declarations`,
      anchor,
      fromLogicalId: ownerId,
    });
  }

  for (const target of targets.values()) {
    context.edges.push({
      from: ownerId,
      to: target.id,
      kind,
      confidence: ambiguous ? 0.6 : 1,
      external: target.external,
      anchor,
    });
  }
}

/** Converts one compiler declaration to the exact graph unit identity, or null for a non-unit. */
function declarationTarget(
  declaration: ts.Declaration,
  expression: ts.Node,
  context: FileContext,
  symbolName?: string,
): DeclarationTarget | null {
  const external = !isProjectFile(declaration.getSourceFile(), context.projectRoot, context.exclude);
  if (external) {
    const name = symbolName ?? truncate(expression.getText(context.sourceFile));
    return { id: `external:${name}`, external: true };
  }

  if (recognisedUnitKind(declaration) === null) return null;
  const targetModule = toModulePath(context.projectRoot, declaration.getSourceFile().fileName);
  const targetId = logicalIdOf(declaration, targetModule);
  return targetId === null ? null : { id: targetId, external: false };
}

/* ------------------------------------------------------------------------- */
/* Identity (identity-v4)                                                     */
/* ------------------------------------------------------------------------- */
/*
 * identity-v4 has three rules:
 *
 *   1. A concrete symbol keeps one stable id while its body changes. A top-level concrete function
 *      intentionally retains the historical `module#name` spelling; in the v4 grammar that spelling
 *      means "function implementation". Every other declaration kind carries an explicit suffix.
 *   2. Declaration contracts that may coexist — overload signatures, method signatures, properties in
 *      anonymous structural branches — always carry a full SHA-256 discriminator. The discriminator is
 *      never conditional on sibling count, so adding/removing a sibling cannot rename an unchanged unit.
 *   3. TypeScript merge symbols (interfaces and enums) are emitted once as aggregate semantic units.
 *      Their fragments share one owner id, which removes collisions without making child identities
 *      depend on which fragment happens to be first.
 */

/** The unit kind recognition assigns to a node, or null when the node is not a unit. */
function recognisedUnitKind(node: ts.Node): UnitKind | null {
  if (ts.isFunctionDeclaration(node)) return node.name === undefined ? null : 'function';
  if (ts.isClassDeclaration(node)) return node.name === undefined ? null : 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'typeAlias';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    return propertyName(node.name) === null ? null : 'method';
  }
  if (ts.isConstructorDeclaration(node)) return 'method';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    return propertyName(node.name) === null ? null : 'property';
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const statement = node.parent.parent;
    if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return null;
    return functionLikeInitializer(node) === null ? 'variable' : 'function';
  }
  return null;
}

/** The name recognition gives a unit node, or null when it has none that is stable. */
function recognisedName(node: ts.Node): string | null {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.text ?? null;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node)
  ) {
    return propertyName(node.name);
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

/** The nearest enclosing recognised unit, or the source file when there is none. */
function nearestRecognisedOwner(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (recognisedUnitKind(current) !== null) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

const recognisedChildrenCache = new WeakMap<ts.Node, ts.Node[]>();

/** Recognised declarations whose nearest recognised owner is `owner`, in source order. */
function directRecognisedChildren(owner: ts.Node): ts.Node[] {
  const cached = recognisedChildrenCache.get(owner);
  if (cached !== undefined) return cached;

  const found: ts.Node[] = [];
  const scan = (child: ts.Node): void => {
    if (recognisedUnitKind(child) !== null) {
      found.push(child);
      return;
    }
    ts.forEachChild(child, scan);
  };
  ts.forEachChild(owner, scan);
  found.sort(compareNodePosition);
  recognisedChildrenCache.set(owner, found);
  return found;
}

function compareNodePosition(a: ts.Node, b: ts.Node): number {
  const aFile = normalisePath(a.getSourceFile().fileName);
  const bFile = normalisePath(b.getSourceFile().fileName);
  if (aFile !== bFile) return aFile < bFile ? -1 : 1;
  return a.getStart(a.getSourceFile()) - b.getStart(b.getSourceFile());
}

/** Canonical AST print, independent of comments and source formatting. */
const identityPrinter = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true });
function normalisePrinted(node: ts.Node): string {
  return identityPrinter
    .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function typeParametersOf(node: ts.Node): readonly ts.TypeParameterDeclaration[] {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.typeParameters ?? [];
  }
  return [];
}

/** Alpha-normalises type parameters from every enclosing generic declaration. */
function typeParameterAlphaMap(node: ts.Node): ReadonlyMap<string, string> {
  const scopes: ts.Node[] = [];
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (typeParametersOf(current).length > 0) scopes.unshift(current);
    current = current.parent;
  }

  const alpha = new Map<string, string>();
  scopes.forEach((scope, scopeIndex) => {
    typeParametersOf(scope).forEach((parameter, parameterIndex) => {
      alpha.set(parameter.name.text, `T${scopeIndex}_${parameterIndex}`);
    });
  });
  return alpha;
}

function applyAlpha(printed: string, alpha: ReadonlyMap<string, string>): string {
  let out = printed;
  const entries = [...alpha.entries()].sort(([a], [b]) => b.length - a.length);
  for (const [name, token] of entries) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), token);
  }
  return out;
}

/** Identity-bearing declaration contract, excluding implementation bodies and formatting. */
function signatureShape(node: ts.Node): string {
  const alpha = typeParameterAlphaMap(node);
  const typeText = (type: ts.TypeNode | undefined): string =>
    type === undefined ? '' : applyAlpha(normalisePrinted(type), alpha);
  const ownTypeParameters = typeParametersOf(node);
  const typeParams = ownTypeParameters
    .map((parameter) => applyAlpha(normalisePrinted(parameter), alpha))
    .join(',');

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    const params = node.parameters
      .map((parameter) => {
        const rest = parameter.dotDotDotToken !== undefined ? '...' : '';
        const optional =
          parameter.questionToken !== undefined || parameter.initializer !== undefined ? '?' : '';
        return `${rest}${typeText(parameter.type)}${optional}`;
      })
      .join(',');
    const staticMarker = hasModifier(node, ts.SyntaxKind.StaticKeyword) ? 'static:' : '';
    return `${staticMarker}fn<${typeParams}>(${params}):${typeText(node.type)}`;
  }

  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    const optional = node.questionToken === undefined ? '' : '?';
    const readonly = hasModifier(node, ts.SyntaxKind.ReadonlyKeyword) ? 'readonly:' : '';
    const staticMarker = hasModifier(node, ts.SyntaxKind.StaticKeyword) ? 'static:' : '';
    return `${staticMarker}${readonly}prop${optional}:${typeText(node.type)}`;
  }

  if (ts.isVariableDeclaration(node)) return `var:${typeText(node.type)}`;
  return '';
}

/** Returns the type-literal member that contains `node`, when one exists. */
function containingTypeMember(typeLiteral: ts.TypeLiteralNode, node: ts.Node): ts.TypeElement | null {
  for (const member of typeLiteral.members) {
    if (node.pos >= member.pos && node.end <= member.end) return member;
  }
  return null;
}

/** Stable context for anonymous structural members, with the member itself replaced by a marker. */
function typeLiteralContextShape(typeLiteral: ts.TypeLiteralNode, node: ts.Node): string {
  const target = containingTypeMember(typeLiteral, node);
  const others = typeLiteral.members
    .filter((member) => member !== target)
    .map((member) => normalisePrinted(member))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `type-literal{${others.join(';')}}`;
}

function controlContextShape(node: ts.Node, child: ts.Node): string | null {
  if (ts.isIfStatement(node)) {
    const branch = child.pos >= node.thenStatement.pos && child.end <= node.thenStatement.end ? 'then' : 'else';
    return `if:${normalisePrinted(node.expression)}:${branch}`;
  }
  if (ts.isCaseClause(node)) return `case:${normalisePrinted(node.expression)}`;
  if (ts.isDefaultClause(node)) return 'case:default';
  if (ts.isForStatement(node)) {
    return `for:${node.initializer === undefined ? '' : normalisePrinted(node.initializer)};${
      node.condition === undefined ? '' : normalisePrinted(node.condition)
    };${node.incrementor === undefined ? '' : normalisePrinted(node.incrementor)}`;
  }
  if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return `${ts.isForInStatement(node) ? 'for-in' : 'for-of'}:${normalisePrinted(node.expression)}`;
  }
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return `${ts.isWhileStatement(node) ? 'while' : 'do'}:${normalisePrinted(node.expression)}`;
  }
  if (ts.isCatchClause(node)) {
    return `catch:${node.variableDeclaration === undefined ? '' : normalisePrinted(node.variableDeclaration)}`;
  }
  if (ts.isLabeledStatement(node)) return `label:${node.label.text}`;
  return null;
}

/** Context between a declaration and its nearest recognised owner. */
function structuralContextShape(node: ts.Node): string {
  const parts: string[] = [];
  let child = node;
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current) && recognisedUnitKind(current) === null) {
    if (ts.isTypeLiteralNode(current)) {
      parts.unshift(typeLiteralContextShape(current, child));
    } else {
      const control = controlContextShape(current, child);
      if (control !== null) parts.unshift(control);
    }
    child = current;
    current = current.parent;
  }
  return parts.join('/');
}

function moduleDeclarationName(node: ts.ModuleDeclaration): string {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : normalisePrinted(node.name);
}

function namespacePath(node: ts.Node): string {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isModuleDeclaration(current)) names.unshift(moduleDeclarationName(current));
    current = current.parent;
  }
  return names.join('/');
}

function isMergeAggregateDeclaration(node: ts.Node): boolean {
  return ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node);
}

/** Same-name interface/enum fragments in the same lexical namespace form one semantic unit. */
function aggregateDeclarations(node: ts.Node): ts.Node[] {
  if (!isMergeAggregateDeclaration(node)) return [node];
  const name = recognisedName(node);
  if (name === null) return [node];
  const owner = nearestRecognisedOwner(node);
  const namespace = namespacePath(node);
  return directRecognisedChildren(owner)
    .filter(
      (candidate) =>
        recognisedUnitKind(candidate) === recognisedUnitKind(node) &&
        recognisedName(candidate) === name &&
        namespacePath(candidate) === namespace,
    )
    .sort(compareNodePosition);
}

/** The declarations that can collide under one logical parent, including merged-owner fragments. */
function identitySiblings(node: ts.Node): ts.Node[] {
  const owner = nearestRecognisedOwner(node);
  if (isMergeAggregateDeclaration(owner)) {
    return aggregateDeclarations(owner).flatMap((fragment) => directRecognisedChildren(fragment)).sort(compareNodePosition);
  }
  return directRecognisedChildren(owner);
}

function encodedName(node: ts.Node): string | null {
  const name = recognisedName(node);
  return name === null ? null : encodeURIComponent(name);
}

/** The deterministic segment before the duplicate-of-identical-contract fallback. */
function basePathSegment(node: ts.Node): string | null {
  const name = encodedName(node);
  if (name === null) return null;
  const context = structuralContextShape(node);
  const contextPart = context.length === 0 ? '' : `~c${hashText(context)}`;

  if (ts.isFunctionDeclaration(node)) {
    // Historical spelling is preserved for a concrete function implementation; in the v4 grammar a
    // bare segment is explicitly the function-symbol identity. Overload contracts are separate units.
    if (node.body !== undefined) return `${name}${contextPart}`;
    return `${name}$functionSignature~s${hashText(signatureShape(node))}${contextPart}`;
  }
  if (ts.isVariableDeclaration(node)) {
    return functionLikeInitializer(node) === null
      ? `${name}$variable${contextPart}`
      : `${name}$functionVariable${contextPart}`;
  }
  if (ts.isClassDeclaration(node)) return `${name}$class${contextPart}`;
  if (ts.isInterfaceDeclaration(node)) return `${name}$interface${contextPart}`;
  if (ts.isTypeAliasDeclaration(node)) return `${name}$typeAlias${contextPart}`;
  if (ts.isEnumDeclaration(node)) return `${name}$enum${contextPart}`;
  if (ts.isConstructorDeclaration(node)) {
    return node.body === undefined
      ? `${name}$constructorSignature~s${hashText(signatureShape(node))}${contextPart}`
      : `${name}$constructor${contextPart}`;
  }
  if (ts.isMethodSignature(node) || (ts.isMethodDeclaration(node) && node.body === undefined)) {
    return `${name}$methodSignature~s${hashText(signatureShape(node))}${contextPart}`;
  }
  if (ts.isMethodDeclaration(node)) {
    const staticPart = hasModifier(node, ts.SyntaxKind.StaticKeyword) ? '$staticMethod' : '$method';
    return `${name}${staticPart}${contextPart}`;
  }
  if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
    const declarationPart = ts.isPropertySignature(node) ? '$propertySignature' : '$property';
    return `${name}${declarationPart}~s${hashText(`${signatureShape(node)}|${context}`)}`;
  }
  return null;
}

/**
 * A declaration's own path segment. Discriminators are unconditional where contracts may coexist.
 * The final ordinal exists only for genuinely identical semantic declarations; because such nodes are
 * indistinguishable, the ordinal cannot reassign meaning between different contracts.
 */
function pathSegment(node: ts.Node): string | null {
  const base = basePathSegment(node);
  if (base === null) return null;
  if (isMergeAggregateDeclaration(node)) return base;

  const collisionGroup = identitySiblings(node).filter((candidate) => basePathSegment(candidate) === base);
  if (collisionGroup.length <= 1) return base;
  const tie = collisionGroup.indexOf(node);
  return `${base}~duplicate${tie < 0 ? 0 : tie}`;
}

/** Dotted segments from the outermost recognised/namespace ancestor down to `node`, or null. */
function qualifiedSegments(node: ts.Node): string[] | null {
  const segments: string[] = [];
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (recognisedUnitKind(current) !== null) {
      const segment = pathSegment(current);
      if (segment === null) return null;
      segments.unshift(segment);
    } else if (ts.isModuleDeclaration(current)) {
      segments.unshift(`namespace:${encodeURIComponent(moduleDeclarationName(current))}`);
    }
    current = current.parent;
  }
  return segments.length === 0 ? null : segments;
}

/** Logical id shared by unit registration and every edge endpoint. */
function logicalIdOf(node: ts.Node, modulePath: string): string | null {
  if (ts.isSourceFile(node)) return modulePath;
  const segments = qualifiedSegments(node);
  return segments === null ? null : `${modulePath}#${segments.join('.')}`;
}

/* --- per-kind unit attributes (kept in step with recognisedUnitKind) ------ */

function unitExported(node: ts.Node): boolean {
  // A module-level variable's `export` sits on its enclosing VariableStatement.
  if (ts.isVariableDeclaration(node)) return hasExportModifier(node.parent.parent);
  return hasExportModifier(node);
}

function functionLikeInitializer(
  node: ts.Node,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!ts.isVariableDeclaration(node)) return null;
  const initializer = node.initializer;
  if (initializer === undefined) return null;
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  return null;
}

function unitIsAsync(node: ts.Node): boolean {
  const initializer = functionLikeInitializer(node);
  return initializer === null ? hasAsyncModifier(node) : hasAsyncModifier(initializer);
}

function unitParameterCount(node: ts.Node): number | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.parameters.length;
  }
  const initializer = functionLikeInitializer(node);
  return initializer === null ? null : initializer.parameters.length;
}

function findDuplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

function anchorOf(node: ts.Node, context: FileContext, mapper: ByteMapper): UnitAnchor {
  return anchorOfRange(context.modulePath, mapper, node.getStart(context.sourceFile), node.end);
}

function anchorOfRange(path: string, mapper: ByteMapper, start: number, end: number): UnitAnchor {
  return {
    path,
    startLine: mapper.lineOf(start) + 1,
    endLine: mapper.lineOf(Math.max(start, end - 1)) + 1,
    startByte: mapper.byteOf(start),
    endByte: mapper.byteOf(end),
  };
}

/**
 * Whether a file belongs to the project rather than to a dependency or the standard
 * library. Declaration files inside the project are included: a `.d.ts` the project
 * authors is part of its structure.
 */
function isProjectFile(
  sourceFile: ts.SourceFile,
  projectRoot: string,
  exclude: ReadonlySet<string>,
): boolean {
  return isProjectModulePath(toModulePath(projectRoot, sourceFile.fileName), exclude);
}

function isProjectModulePath(modulePath: string, exclude: ReadonlySet<string>): boolean {
  if (modulePath === '..' || modulePath.startsWith('../') || absolutePathForm(modulePath) !== null) {
    return false;
  }
  for (const configured of exclude) {
    const rule = normalisePath(configured).replace(/^\.\//u, '').replace(/\/$/u, '');
    if (rule === '') continue;
    if (rule.includes('/')) {
      if (modulePath === rule || modulePath.startsWith(`${rule}/`)) return false;
      continue;
    }
    if (modulePath.split('/').includes(rule)) return false;
  }
  return true;
}

function toModulePath(projectRoot: string, fileName: string): string {
  return normalisePath(relative(projectRoot, fileName));
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** `src/a.ts#Foo.bar` → `Foo.bar`; a bare module id yields an empty local name. */
function localName(logicalId: string): string {
  const index = logicalId.indexOf('#');
  return index === -1 ? '' : logicalId.slice(index + 1);
}

function propertyName(name: ts.PropertyName | undefined): string | null {
  if (name === undefined) return null;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  // A computed property name is not statically known; recording a placeholder would
  // create a unit that nothing could reliably refer to.
  return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasAsyncModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const bucket = key(item);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function sortObject(value: object): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    sorted[key] = item;
  }
  return sorted;
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}
