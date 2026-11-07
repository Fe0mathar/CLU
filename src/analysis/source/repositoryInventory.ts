/**
 * Governed physical repository inventory for Q1 SURF.
 *
 * Recognition is intentionally not the file authority: TypeScript may omit documentation,
 * configuration, images, unsupported languages, or excluded directories. This module walks
 * the complete configured repository independently, classifies every observed regular file
 * through the backend taxonomy, records skipped/excluded surfaces explicitly, and creates
 * stable location/version identities. Semantic recognition may enrich these records later;
 * it never creates them.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import {
  ARTIFACT_TAXONOMY,
  artifactTaxonomySchema,
  classifyArtifactPath,
  type ArtifactClassification,
  type ArtifactTaxonomy,
} from '../environments/artifactTaxonomy.js';
import {
  captureSnapshot,
  type SnapshotManifest,
  type SourceFile,
} from './snapshot.js';
import {
  RECOGNIZER_VERSION,
  type RecognitionResult,
  type SourceUnit,
} from './recognizer.js';
import { replaceFileSync, writeAllSync } from '../../shared/durableFs.js';
import { hashCanonicalJson, type Sha256 } from '../../shared/ids.js';
import {
  projectRecognitionIdentityEquals,
  projectRecognitionIdentitySchema,
  type ProjectRecognitionIdentity,
} from '../../shared/projectRecognitionIdentity.js';

export const REPOSITORY_INVENTORY_SCHEMA_VERSION = 'q1-repository-inventory/1';
export const REPOSITORY_INVENTORY_POINTER_VERSION = 1;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const nullableSha256 = sha256.nullable();

export const repositoryClassificationSchema = z
  .object({
    source: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
    classifierVersion: z.string().min(1),
  })
  .strict();

export const repositoryFileRecordSchema = z
  .object({
    fileLocationId: sha256,
    fileVersionId: sha256,
    repositoryId: z.string().min(1),
    snapshotId: sha256,
    recognitionSnapshotId: sha256,
    path: z.string().min(1),
    name: z.string().min(1),
    familyId: z.string().min(1),
    environmentId: z.string().min(1),
    contentHash: nullableSha256,
    bytes: z.number().int().nonnegative(),
    physicalFormat: z.string().min(1),
    glyphId: z.string().min(1),
    facets: z.array(z.string().min(1)),
    classification: repositoryClassificationSchema,
    inventoryState: z.enum(['observed', 'committed', 'added', 'modified', 'removed']),
    recognitionState: z.enum(['pending', 'recognized', 'partial', 'unsupported', 'failed']),
    adapterId: z.string().min(1).nullable(),
    adapterVersion: z.string().min(1).nullable(),
    semanticDepth: z.string().min(1).nullable(),
    semanticMembershipIds: z.array(z.string().min(1)),
    preferredSemanticRootId: z.string().min(1).nullable(),
    tracked: z.boolean().nullable(),
    generated: z.boolean(),
    excluded: z.boolean(),
    exclusionReason: z.string().min(1).nullable(),
    executable: z.boolean(),
  })
  .strict();

export type RepositoryFileRecord = z.infer<typeof repositoryFileRecordSchema>;

export const repositoryExclusionSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['configured', 'symlink', 'unreadable', 'special']),
    reason: z.string().min(1),
  })
  .strict();

export type RepositoryExclusion = z.infer<typeof repositoryExclusionSchema>;

export const repositoryInventorySchema = z
  .object({
    schemaVersion: z.literal(REPOSITORY_INVENTORY_SCHEMA_VERSION),
    repositoryId: z.string().min(1),
    projectName: z.string().min(1),
    snapshotId: sha256,
    recognitionSnapshotId: sha256,
    projectRecognition: projectRecognitionIdentitySchema.optional(),
    inventoryHash: sha256,
    sourceRoots: z.array(z.string().min(1)),
    recognitionSourceRoots: z.array(z.string().min(1)),
    excludedNames: z.array(z.string().min(1)),
    taxonomy: artifactTaxonomySchema,
    files: z.array(repositoryFileRecordSchema),
    removedFiles: z.array(repositoryFileRecordSchema),
    exclusions: z.array(repositoryExclusionSchema),
    counts: z.object({
      files: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
      families: z.number().int().nonnegative(),
      environments: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      modified: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      unsupported: z.number().int().nonnegative(),
    }).strict(),
  })
  .strict();

export type RepositoryInventory = z.infer<typeof repositoryInventorySchema>;

export interface RepositoryInventoryCaptureOptions {
  readonly root: string;
  readonly repositoryId: string;
  readonly projectName: string;
  /** Source roots assessed by the semantic recognizer, used only to label adapter eligibility. */
  readonly recognitionSourceRoots: readonly string[];
  readonly recognitionSnapshotId: string;
  readonly projectRecognition?: ProjectRecognitionIdentity;
  readonly exclude: readonly string[];
  readonly previous?: RepositoryInventoryPointer | null;
}

export const repositorySemanticSummarySchema = z
  .object({
    fileLocationId: sha256,
    fileVersionId: sha256,
    path: z.string().min(1),
    recognitionState: z.enum(['recognized', 'partial', 'unsupported', 'failed']),
    adapterId: z.string().min(1).nullable(),
    adapterVersion: z.string().min(1).nullable(),
    semanticDepth: z.string().min(1).nullable(),
    semanticMembershipIds: z.array(z.string().min(1)),
    preferredSemanticRootId: z.string().min(1).nullable(),
    semanticSummary: z.object({
      unitCount: z.number().int().nonnegative(),
      classCount: z.number().int().nonnegative(),
      functionCount: z.number().int().nonnegative(),
      edgeCount: z.number().int().nonnegative(),
      inboundCount: z.number().int().nonnegative(),
      outboundCount: z.number().int().nonnegative(),
      unresolvedCount: z.number().int().nonnegative(),
      membershipIds: z.array(z.string().min(1)),
    }).strict(),
  })
  .strict();

export type RepositorySemanticSummary = z.infer<typeof repositorySemanticSummarySchema>;

export const repositoryFileEdgeSchema = z
  .object({
    fromFileLocationId: sha256,
    toFileLocationId: sha256,
    kind: z.string().min(1),
    directed: z.literal(true),
    weight: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    edgeKinds: z.array(z.string().min(1)),
  })
  .strict();

export type RepositoryFileEdge = z.infer<typeof repositoryFileEdgeSchema>;

export interface RepositoryInventoryEnrichment {
  readonly files: readonly RepositoryFileRecord[];
  readonly summaries: readonly RepositorySemanticSummary[];
  readonly edges: readonly RepositoryFileEdge[];
}

const pointerFileSchema = z
  .object({
    path: z.string().min(1),
    contentHash: nullableSha256,
    fileLocationId: sha256,
    fileVersionId: sha256,
    familyId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

export const repositoryInventoryPointerSchema = z
  .object({
    v: z.literal(REPOSITORY_INVENTORY_POINTER_VERSION),
    repositoryId: z.string().min(1),
    snapshotId: sha256,
    inventoryHash: sha256,
    projectRecognition: projectRecognitionIdentitySchema.optional(),
    files: z.array(pointerFileSchema),
  })
  .strict();

export type RepositoryInventoryPointer = z.infer<typeof repositoryInventoryPointerSchema>;

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
}

function pathWithinSourceRoots(path: string, roots: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return roots.some((root) => {
    const candidate = normalizePath(root).replace(/\/$/u, '');
    return candidate === '.' || normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

function fileLocationId(repositoryId: string, path: string): Sha256 {
  return hashCanonicalJson({
    v: REPOSITORY_INVENTORY_SCHEMA_VERSION,
    kind: 'file-location',
    repositoryId,
    path: normalizePath(path),
  });
}

function fileVersionId(locationId: string, file: Pick<SourceFile, 'hash' | 'bytes' | 'executable'>): Sha256 {
  return hashCanonicalJson({
    v: REPOSITORY_INVENTORY_SCHEMA_VERSION,
    kind: 'file-version',
    fileLocationId: locationId,
    contentHash: file.hash,
    bytes: file.bytes,
    executable: file.executable,
  });
}

function skippedVersionId(locationId: string, reason: string, detail: string): Sha256 {
  return hashCanonicalJson({
    v: REPOSITORY_INVENTORY_SCHEMA_VERSION,
    kind: 'unreadable-file-version',
    fileLocationId: locationId,
    reason,
    detail,
  });
}

function previousByPath(previous: RepositoryInventoryPointer | null | undefined): Map<string, RepositoryInventoryPointer['files'][number]> {
  return new Map((previous?.files ?? []).map((file) => [normalizePath(file.path), file] as const));
}

function lifecycleState(
  path: string,
  contentHash: string | null,
  previous: ReadonlyMap<string, RepositoryInventoryPointer['files'][number]>,
): RepositoryFileRecord['inventoryState'] {
  const prior = previous.get(path);
  if (prior === undefined) return previous.size === 0 ? 'committed' : 'added';
  return prior.contentHash === contentHash ? 'committed' : 'modified';
}

function generatedPath(path: string): boolean {
  const normalized = `/${normalizePath(path).toLowerCase()}/`;
  return /\/(?:dist|build|coverage|generated|out|target|release|logs|backups|tmp|temp|\.cache)\//u.test(normalized);
}

function initialRecognitionState(
  path: string,
  classification: ArtifactClassification,
  recognitionRoots: readonly string[],
): RepositoryFileRecord['recognitionState'] {
  if (!pathWithinSourceRoots(path, recognitionRoots)) return 'unsupported';
  return classification.adapterId === 'typescript-static' ? 'pending' : 'unsupported';
}

function recordForSourceFile(
  input: RepositoryInventoryCaptureOptions,
  manifest: SnapshotManifest,
  source: SourceFile,
  previous: ReadonlyMap<string, RepositoryInventoryPointer['files'][number]>,
): RepositoryFileRecord {
  const path = normalizePath(source.path);
  const classification = classifyArtifactPath(path);
  const locationId = fileLocationId(input.repositoryId, path);
  return repositoryFileRecordSchema.parse({
    fileLocationId: locationId,
    fileVersionId: fileVersionId(locationId, source),
    repositoryId: input.repositoryId,
    snapshotId: manifest.id,
    recognitionSnapshotId: input.recognitionSnapshotId,
    path,
    name: basename(path),
    familyId: classification.familyId,
    environmentId: classification.environmentId,
    contentHash: source.hash,
    bytes: source.bytes,
    physicalFormat: classification.physicalFormat,
    glyphId: classification.glyphId,
    facets: [...new Set([...classification.facets, `language:${source.language}`, source.executable ? 'executable' : 'non-executable'])],
    classification: {
      source: classification.source,
      confidence: classification.confidence,
      reason: classification.reason,
      classifierVersion: classification.classifierVersion,
    },
    inventoryState: lifecycleState(path, source.hash, previous),
    recognitionState: initialRecognitionState(path, classification, input.recognitionSourceRoots),
    adapterId: classification.adapterId,
    adapterVersion: classification.adapterVersion,
    semanticDepth: null,
    semanticMembershipIds: [],
    preferredSemanticRootId: null,
    tracked: null,
    generated: generatedPath(path),
    excluded: false,
    exclusionReason: null,
    executable: source.executable,
  });
}

function recordForSkipped(
  input: RepositoryInventoryCaptureOptions,
  manifest: SnapshotManifest,
  skipped: SnapshotManifest['skipped'][number],
  previous: ReadonlyMap<string, RepositoryInventoryPointer['files'][number]>,
): RepositoryFileRecord {
  const path = normalizePath(skipped.path);
  const classification = classifyArtifactPath(path);
  const locationId = fileLocationId(input.repositoryId, path);
  return repositoryFileRecordSchema.parse({
    fileLocationId: locationId,
    fileVersionId: skippedVersionId(locationId, skipped.reason, skipped.detail),
    repositoryId: input.repositoryId,
    snapshotId: manifest.id,
    recognitionSnapshotId: input.recognitionSnapshotId,
    path,
    name: basename(path),
    familyId: classification.familyId,
    environmentId: classification.environmentId,
    contentHash: null,
    bytes: 0,
    physicalFormat: classification.physicalFormat,
    glyphId: classification.glyphId,
    facets: [...new Set([...classification.facets, `skipped:${skipped.reason}`])],
    classification: {
      source: classification.source,
      confidence: classification.confidence,
      reason: classification.reason,
      classifierVersion: classification.classifierVersion,
    },
    inventoryState: lifecycleState(path, null, previous),
    recognitionState: 'unsupported',
    adapterId: null,
    adapterVersion: null,
    semanticDepth: null,
    semanticMembershipIds: [],
    preferredSemanticRootId: null,
    tracked: null,
    generated: generatedPath(path),
    excluded: true,
    exclusionReason: `${skipped.reason}: ${skipped.detail}`,
    executable: false,
  });
}

function removedRecords(
  input: RepositoryInventoryCaptureOptions,
  manifest: SnapshotManifest,
  currentPaths: ReadonlySet<string>,
  previous: ReadonlyMap<string, RepositoryInventoryPointer['files'][number]>,
): RepositoryFileRecord[] {
  const output: RepositoryFileRecord[] = [];
  for (const prior of previous.values()) {
    if (currentPaths.has(prior.path)) continue;
    const classification = classifyArtifactPath(prior.path);
    output.push(repositoryFileRecordSchema.parse({
      fileLocationId: prior.fileLocationId,
      fileVersionId: prior.fileVersionId,
      repositoryId: input.repositoryId,
      snapshotId: manifest.id,
      recognitionSnapshotId: input.recognitionSnapshotId,
      path: prior.path,
      name: basename(prior.path),
      familyId: prior.familyId,
      environmentId: prior.environmentId,
      contentHash: prior.contentHash,
      bytes: 0,
      physicalFormat: classification.physicalFormat,
      glyphId: classification.glyphId,
      facets: [...new Set([...classification.facets, 'removed'])],
      classification: {
        source: classification.source,
        confidence: classification.confidence,
        reason: classification.reason,
        classifierVersion: classification.classifierVersion,
      },
      inventoryState: 'removed',
      recognitionState: 'unsupported',
      adapterId: classification.adapterId,
      adapterVersion: classification.adapterVersion,
      semanticDepth: null,
      semanticMembershipIds: [],
      preferredSemanticRootId: null,
      tracked: null,
      generated: generatedPath(prior.path),
      excluded: false,
      exclusionReason: null,
      executable: false,
    }));
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function configuredExclusions(exclude: readonly string[]): RepositoryExclusion[] {
  return [...new Set(exclude.map(normalizePath))]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ path, kind: 'configured' as const, reason: 'configured repository exclusion; subtree not traversed' }));
}

export function captureRepositoryInventory(options: RepositoryInventoryCaptureOptions): RepositoryInventory {
  // A pure, content-addressed full-repository capture. It is deliberately not recorded as
  // the recognition snapshot: semantic recognition retains its own source-root identity.
  const manifest = captureSnapshot({
    root: options.root,
    sourceRoots: ['.'],
    exclude: options.exclude,
  });
  const previous = previousByPath(options.previous);
  const files = manifest.files.map((file) => recordForSourceFile(options, manifest, file, previous));
  const skipped = manifest.skipped.map((entry) => recordForSkipped(options, manifest, entry, previous));
  const all = [...files, ...skipped].sort((a, b) => a.path.localeCompare(b.path));
  const currentPaths = new Set(all.map((file) => file.path));
  const removed = removedRecords(options, manifest, currentPaths, previous);
  const exclusions = [
    ...configuredExclusions(options.exclude),
    ...manifest.skipped.map((entry) => ({
      path: normalizePath(entry.path),
      kind: entry.reason,
      reason: entry.detail,
    } as RepositoryExclusion)),
  ];
  const visible = all.filter((file) => !file.excluded);
  const families = new Set(visible.map((file) => file.familyId));
  const environments = new Set(visible.map((file) => file.environmentId));
  const counts = {
    files: visible.length,
    excluded: all.length - visible.length,
    families: families.size,
    environments: environments.size,
    added: all.filter((file) => file.inventoryState === 'added').length,
    modified: all.filter((file) => file.inventoryState === 'modified').length,
    removed: removed.length,
    unsupported: visible.filter((file) => file.recognitionState === 'unsupported').length,
  };
  const taxonomy: ArtifactTaxonomy = ARTIFACT_TAXONOMY;
  const inventoryHash = hashCanonicalJson({
    v: REPOSITORY_INVENTORY_SCHEMA_VERSION,
    repositoryId: options.repositoryId,
    snapshotId: manifest.id,
    recognitionSnapshotId: options.recognitionSnapshotId,
    projectRecognition: options.projectRecognition ?? null,
    taxonomyHash: taxonomy.taxonomyHash,
    sourceRoots: ['.'],
    recognitionSourceRoots: [...new Set(options.recognitionSourceRoots.map(normalizePath))]
      .sort((a, b) => a.localeCompare(b)),
    excludedNames: [...new Set(options.exclude.map(normalizePath))]
      .sort((a, b) => a.localeCompare(b)),
    files: all,
    removed,
    exclusions,
    counts,
  });

  return repositoryInventorySchema.parse({
    schemaVersion: REPOSITORY_INVENTORY_SCHEMA_VERSION,
    repositoryId: options.repositoryId,
    projectName: options.projectName,
    snapshotId: manifest.id,
    recognitionSnapshotId: options.recognitionSnapshotId,
    ...(options.projectRecognition === undefined
      ? {}
      : { projectRecognition: options.projectRecognition }),
    inventoryHash,
    sourceRoots: ['.'],
    recognitionSourceRoots: [...new Set(options.recognitionSourceRoots.map(normalizePath))]
      .sort((a, b) => a.localeCompare(b)),
    excludedNames: [...new Set(options.exclude.map(normalizePath))]
      .sort((a, b) => a.localeCompare(b)),
    taxonomy,
    files: all,
    removedFiles: removed,
    exclusions,
    counts,
  });
}

function unitsByPath(result: RecognitionResult): Map<string, SourceUnit[]> {
  const map = new Map<string, SourceUnit[]>();
  for (const unit of result.units) {
    const path = normalizePath(unit.modulePath || unit.anchor.path);
    const list = map.get(path) ?? [];
    list.push(unit);
    map.set(path, list);
  }
  return map;
}

function unresolvedByPath(result: RecognitionResult): Map<string, number> {
  const map = new Map<string, number>();
  for (const unresolved of result.unresolved) {
    const path = normalizePath(unresolved.anchor.path);
    map.set(path, (map.get(path) ?? 0) + 1);
  }
  return map;
}

function fileEdgeRecords(
  result: RecognitionResult,
  filesByPath: ReadonlyMap<string, RepositoryFileRecord>,
): RepositoryFileEdge[] {
  const logicalToPath = new Map(result.units.map((unit) => [unit.logicalId, normalizePath(unit.modulePath)] as const));
  const aggregates = new Map<string, {
    from: string;
    to: string;
    count: number;
    confidence: number;
    kinds: Set<string>;
  }>();
  for (const edge of result.edges) {
    if (edge.external) continue;
    const fromPath = logicalToPath.get(edge.from);
    const toPath = logicalToPath.get(edge.to);
    if (fromPath === undefined || toPath === undefined || fromPath === toPath) continue;
    const from = filesByPath.get(fromPath);
    const to = filesByPath.get(toPath);
    if (from === undefined || to === undefined) continue;
    const key = `${from.fileLocationId}\u0000${to.fileLocationId}`;
    const aggregate = aggregates.get(key) ?? {
      from: from.fileLocationId,
      to: to.fileLocationId,
      count: 0,
      confidence: 0,
      kinds: new Set<string>(),
    };
    aggregate.count += 1;
    aggregate.confidence += edge.confidence;
    aggregate.kinds.add(edge.kind);
    aggregates.set(key, aggregate);
  }
  return [...aggregates.values()]
    .map((aggregate) => repositoryFileEdgeSchema.parse({
      fromFileLocationId: aggregate.from,
      toFileLocationId: aggregate.to,
      kind: 'semantic-dependency',
      directed: true,
      weight: aggregate.count,
      confidence: aggregate.count === 0 ? 0 : aggregate.confidence / aggregate.count,
      edgeKinds: [...aggregate.kinds].sort(),
    }))
    .sort((a, b) => `${a.fromFileLocationId}:${a.toFileLocationId}`.localeCompare(`${b.fromFileLocationId}:${b.toFileLocationId}`));
}

export function enrichRepositoryInventory(
  inventory: RepositoryInventory,
  result: RecognitionResult,
): RepositoryInventoryEnrichment {
  const byPath = new Map(inventory.files.map((file) => [normalizePath(file.path), file] as const));
  const grouped = unitsByPath(result);
  const unresolved = unresolvedByPath(result);
  const programPaths = new Set(result.programFiles.map((file) => normalizePath(file.path)));
  const logicalToPath = new Map(
    result.units.map((unit) => [unit.logicalId, normalizePath(unit.modulePath)] as const),
  );
  const inboundByPath = new Map<string, number>();
  const outboundByPath = new Map<string, number>();
  for (const edge of result.edges) {
    const fromPath = logicalToPath.get(edge.from);
    const toPath = logicalToPath.get(edge.to);
    if (fromPath !== undefined) {
      outboundByPath.set(fromPath, (outboundByPath.get(fromPath) ?? 0) + 1);
    }
    if (!edge.external && toPath !== undefined) {
      inboundByPath.set(toPath, (inboundByPath.get(toPath) ?? 0) + 1);
    }
  }
  const summaries: RepositorySemanticSummary[] = [];
  const files: RepositoryFileRecord[] = [];

  for (const file of inventory.files) {
    if (file.excluded) continue;
    const path = normalizePath(file.path);
    const units = grouped.get(path) ?? [];
    const membershipIds = units.map((unit) => unit.logicalId).sort();
    const module = units.find((unit) => unit.kind === 'module') ?? units[0] ?? null;
    const unresolvedCount = unresolved.get(path) ?? 0;
    const isProgramFile = programPaths.has(path);
    const state: RepositoryFileRecord['recognitionState'] = !isProgramFile
      ? 'unsupported'
      : units.length === 0 || unresolvedCount > 0
        ? 'partial'
        : 'recognized';
    const outgoing = outboundByPath.get(path) ?? 0;
    const incoming = inboundByPath.get(path) ?? 0;
    const summary = repositorySemanticSummarySchema.parse({
      fileLocationId: file.fileLocationId,
      fileVersionId: file.fileVersionId,
      path,
      recognitionState: state,
      adapterId: isProgramFile ? 'typescript-static' : null,
      adapterVersion: isProgramFile ? RECOGNIZER_VERSION : null,
      semanticDepth: isProgramFile ? 'file→class→function' : null,
      semanticMembershipIds: membershipIds,
      preferredSemanticRootId: module?.logicalId ?? null,
      semanticSummary: {
        unitCount: units.length,
        classCount: units.filter((unit) => ['class', 'interface', 'typeAlias', 'enum'].includes(unit.kind)).length,
        functionCount: units.filter((unit) => ['function', 'method'].includes(unit.kind)).length,
        edgeCount: incoming + outgoing,
        inboundCount: incoming,
        outboundCount: outgoing,
        unresolvedCount,
        membershipIds,
      },
    });
    summaries.push(summary);
    files.push(repositoryFileRecordSchema.parse({
      ...file,
      recognitionState: state,
      adapterId: summary.adapterId,
      adapterVersion: summary.adapterVersion,
      semanticDepth: summary.semanticDepth,
      semanticMembershipIds: membershipIds,
      preferredSemanticRootId: summary.preferredSemanticRootId,
    }));
  }

  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    summaries: summaries.sort((a, b) => a.path.localeCompare(b.path)),
    edges: fileEdgeRecords(result, byPath),
  };
}

export function repositoryInventoryPointerPath(navigatorPath: string): string {
  return join(dirname(navigatorPath), 'repository-inventory.current.json');
}

export function toRepositoryInventoryPointer(inventory: RepositoryInventory): RepositoryInventoryPointer {
  return repositoryInventoryPointerSchema.parse({
    v: REPOSITORY_INVENTORY_POINTER_VERSION,
    repositoryId: inventory.repositoryId,
    snapshotId: inventory.snapshotId,
    inventoryHash: inventory.inventoryHash,
    ...(inventory.projectRecognition === undefined
      ? {}
      : { projectRecognition: inventory.projectRecognition }),
    files: inventory.files
      .filter((file) => !file.excluded)
      .map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        fileLocationId: file.fileLocationId,
        fileVersionId: file.fileVersionId,
        familyId: file.familyId,
        environmentId: file.environmentId,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}

export function readRepositoryInventoryPointer(
  navigatorPath: string,
  expectedProjectRecognition?: ProjectRecognitionIdentity,
): RepositoryInventoryPointer | null {
  const path = repositoryInventoryPointerPath(navigatorPath);
  if (!existsSync(path)) return null;
  try {
    const pointer = repositoryInventoryPointerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (expectedProjectRecognition === undefined) return pointer;
    if (
      pointer.projectRecognition === undefined ||
      !projectRecognitionIdentityEquals(pointer.projectRecognition, expectedProjectRecognition)
    ) {
      // A pointer from another project/profile generation is stale lifecycle context, not evidence.
      return null;
    }
    return pointer;
  } catch {
    return null;
  }
}

export function writeRepositoryInventoryPointer(
  navigatorPath: string,
  inventory: RepositoryInventory,
): string {
  const finalPath = repositoryInventoryPointerPath(navigatorPath);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const bytes = Buffer.from(`${JSON.stringify(toRepositoryInventoryPointer(inventory), null, 2)}\n`, 'utf8');
  const descriptor = openSync(tempPath, 'wx');
  try {
    writeAllSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  replaceFileSync(tempPath, finalPath);
  return finalPath;
}

export function repositoryInventorySealFacts(inventory: RepositoryInventory): {
  taxonomyVersion: string;
  taxonomyHash: Sha256;
  inventoryHash: Sha256;
  fileCount: number;
  familyCount: number;
  environmentCount: number;
} {
  return {
    taxonomyVersion: inventory.taxonomy.taxonomyVersion,
    taxonomyHash: inventory.taxonomy.taxonomyHash as Sha256,
    inventoryHash: inventory.inventoryHash as Sha256,
    fileCount: inventory.counts.files,
    familyCount: inventory.counts.families,
    environmentCount: inventory.counts.environments,
  };
}
