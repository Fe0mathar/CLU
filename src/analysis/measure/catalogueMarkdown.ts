/**
 * catalogueMarkdown.ts — deterministic human-readable view of the Measurement
 * Catalogue registry.
 *
 * Single-source-of-truth loop (Catalogue doctrine §3.6): the machine-readable
 * registry (config/measurements/catalogue.yaml, validated by catalogue.ts) is
 * authoritative; this module generates the reviewable Markdown companion from
 * a loaded catalogue and embeds the registry content hash as
 * `Catalogue-Content-Hash: <64-hex>`. Runtime code rejects a registry whose
 * generated Markdown disagrees (verifyGeneratedMarkdownAgreement).
 *
 * Determinism contract: same loaded catalogue ⇒ byte-identical Markdown.
 * No wall-clock timestamps, no environment data, no randomness — catalogue
 * diffs must show semantic changes, not regenerated noise. Ordering is the
 * canonical grid order already enforced by the loader.
 *
 * Purity contract: no filesystem access, no side effects. Callers decide
 * where to write the output (DEFAULT_GENERATED_MARKDOWN_PATH is the
 * recommended location, a sibling of the source registry). CLI wiring belongs
 * to the command layer, not here.
 *
 * Every generation self-verifies: the produced Markdown is checked against
 * the catalogue with verifyGeneratedMarkdownAgreement before being returned,
 * so a formatting regression in this file cannot silently break the
 * hash-agreement contract (instrument self-validity).
 *
 * Note: AREA_SUBJECTS below is area-level presentation metadata (the eleven
 * fixed area subjects from the v3 grammar). It is not part of the per-measure
 * registry; promoting it into the registry schema is a candidate future
 * catalogue revision, recorded here so the duplication is explicit and
 * intentional rather than accidental.
 */

import {
  APPLICABILITY_STATES,
  AREA_FAMILY,
  CATALOGUE_REGISTRY_SCHEMA_VERSION,
  FAMILY_COLOR_POLICY,
  MARKDOWN_CONTENT_HASH_LABEL,
  METRIC_AREAS,
  METRIC_STATUSES,
  RESERVED_GRID_INDICES,
  TERMINAL_MEASURE_OUTCOMES,
  tryLoadMeasurementCatalogue,
  verifyGeneratedMarkdownAgreement,
} from './catalogue.js';
import type {
  CanonicalMetricDefinition,
  CatalogueValidationIssue,
  LoadedMeasurementCatalogue,
  MetricArea,
  MetricFamily,
  MetricStatus,
} from './catalogue.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Recommended output location: sibling of the source registry, reviewable and versioned. */
export const DEFAULT_GENERATED_MARKDOWN_PATH = 'config/measurements/CATALOGUE.generated.md';

/** Default provenance path embedded in the header when the caller supplies none. */
export const DEFAULT_REGISTRY_SOURCE_PATH = 'config/measurements/catalogue.yaml';

/**
 * Fixed area subjects of the v3 grammar (presentation metadata; see module
 * header note about future promotion into the registry schema).
 */
export const AREA_SUBJECTS = {
  A: 'Purpose, value, and outcome',
  B: 'Functional, semantic, and data integrity',
  C: 'Architecture, maintainability, and comprehension',
  D: 'Performance, resource efficiency, and sustainability',
  E: 'Reliability, resilience, and safety',
  F: 'Security, privacy, provenance, and governance',
  G: 'Compatibility, flexibility, delivery, and interaction',
  H: 'Transparency and system-wide synthesis',
  I: 'Evidence and Assurance Metrics',
  J: 'Mandatory Preservation and Acceptance Gates',
  K: 'CLU-E Self-Metrics',
} as const satisfies Record<MetricArea, string>;

const FAMILY_DISPLAY_ORDER: readonly MetricFamily[] = [
  'TARGET_QUALITY',
  'EVIDENCE_ASSURANCE',
  'ACCEPTANCE_GATES',
  'CLUE_SELF',
];

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export interface CatalogueMarkdownOptions {
  /** Provenance path shown in the header; defaults to the standard registry location. */
  registrySourcePath?: string | undefined;
}

export type GenerateFromYamlResult =
  | { ok: true; markdown: string; catalogue: LoadedMeasurementCatalogue }
  | { ok: false; issues: CatalogueValidationIssue[] };

// ---------------------------------------------------------------------------
// Rendering helpers (pure)
// ---------------------------------------------------------------------------

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function statusCounts(catalogue: LoadedMeasurementCatalogue): Record<MetricStatus, number> {
  const counts: Record<MetricStatus, number> = {
    ACTIVE: 0,
    EXPERIMENTAL: 0,
    DEPRECATED: 0,
    RETIRED: 0,
  };
  for (const measure of catalogue.measures) counts[measure.status] += 1;
  return counts;
}

function renderStatusSummary(catalogue: LoadedMeasurementCatalogue): string {
  const counts = statusCounts(catalogue);
  const parts: string[] = [];
  for (const status of METRIC_STATUSES) {
    if (counts[status] > 0) parts.push(`${String(counts[status])} ${status}`);
  }
  return `${String(catalogue.measures.length)} total (${parts.join(' · ')})`;
}

function renderHeader(
  catalogue: LoadedMeasurementCatalogue,
  registrySourcePath: string,
): string {
  const identity = catalogue.identity;
  const freeCells =
    catalogue.reservedGridIndicesFree.length === 0
      ? 'none'
      : catalogue.reservedGridIndicesFree.map(String).join(', ');
  const lines: string[] = [
    '# CLU-E Canonical Measurement Catalogue — Generated Registry View',
    '',
    '> **GENERATED FILE — DO NOT EDIT.** The machine-readable registry is the',
    `> single source of truth. Edit \`${registrySourcePath}\`,`,
    '> revalidate through the catalogue loader, and regenerate this document.',
    '> Runtime code rejects a registry whose generated Markdown hash disagrees.',
    '',
    `Catalogue-Id: ${identity.catalogueId}`,
    `Catalogue-Version: ${identity.version}`,
    `Catalogue-Status: ${catalogue.status}`,
    `Registry-Schema-Version: ${CATALOGUE_REGISTRY_SCHEMA_VERSION}`,
    `${MARKDOWN_CONTENT_HASH_LABEL}: ${identity.contentHash}`,
    `Grid-Layout-Hash: ${identity.gridLayoutHash}`,
    `Legacy-Alias-Map-Hash: ${identity.legacyAliasMapHash}`,
    `Family-Color-Policy-Hash: ${identity.familyColorPolicyHash}`,
    `Source-Artifact-Hash: ${catalogue.sourceArtifactHash ?? '(none)'}`,
    `Effective-From-Cycle: ${catalogue.effectiveFromCycle ?? '(none)'}`,
    `Supersedes: ${catalogue.supersedes ?? '(none)'}`,
    '',
    `Measures: ${renderStatusSummary(catalogue)}`,
    `Reserved grid cells free: ${freeCells} (of ${RESERVED_GRID_INDICES.map(String).join(', ')})`,
  ];
  if (catalogue.targetProfileIds.length > 0) {
    lines.push(`Target profiles: ${catalogue.targetProfileIds.join(', ')}`);
  }
  return lines.join('\n');
}

function renderFamilyTable(catalogue: LoadedMeasurementCatalogue): string {
  const lines: string[] = [
    '## Metric families',
    '',
    '| Family | Canonical color | Metrics |',
    '|---|---|---:|',
  ];
  for (const family of FAMILY_DISPLAY_ORDER) {
    const count = catalogue.familyMetricIds[family].length;
    lines.push(`| \`${family}\` | \`${FAMILY_COLOR_POLICY[family]}\` | ${String(count)} |`);
  }
  return lines.join('\n');
}

function renderCoordinateTable(catalogue: LoadedMeasurementCatalogue): string {
  const lines: string[] = [
    '## Canonical coordinate table',
    '',
    '| Grid | X | Y | Canonical ID | Legacy ID | Family | Area | Metric | Status |',
    '|---:|---:|---:|---|---|---|---|---|---|',
  ];
  for (const measure of catalogue.measures) {
    lines.push(
      `| ${String(measure.grid.index)} | ${String(measure.grid.x)} | ${String(measure.grid.y)} ` +
        `| \`${measure.metricId}\` | ${measure.legacyId === null ? '—' : `\`${measure.legacyId}\``} ` +
        `| \`${measure.family}\` | ${measure.area} | ${escapeTableCell(measure.name)} ` +
        `| ${measure.status} |`,
    );
  }
  return lines.join('\n');
}

function renderMeasure(measure: CanonicalMetricDefinition): string {
  const lines: string[] = [
    `### ${measure.metricId} — ${measure.name}`,
    '',
    `**Grid cell:** ${String(measure.grid.index)} (x ${String(measure.grid.x)}, y ${String(measure.grid.y)})` +
      ` · **Legacy ID:** ${measure.legacyId ?? '—'}` +
      ` · **Family:** \`${measure.family}\`` +
      ` · **Status:** ${measure.status}`,
    `**Projection:** \`${measure.projectionType}\`` +
      ` · **Normalization profile:** \`${measure.normalizationProfileId}\`` +
      ` · **Family color:** \`${measure.familyColor}\``,
    '',
    `**Question:** ${measure.question}`,
  ];
  if (measure.evidenceSources.length > 0) {
    lines.push('', '**Evidence:**');
    for (const item of measure.evidenceSources) lines.push(`- ${item}`);
  }
  if (measure.failurePatterns.length > 0) {
    lines.push('', '**Failure patterns:**');
    for (const item of measure.failurePatterns) lines.push(`- ${item}`);
  }
  if (measure.verdictImpact !== null) {
    lines.push('', `**Typical verdict impact:** ${measure.verdictImpact}`);
  }
  return lines.join('\n');
}

function renderAreaSections(catalogue: LoadedMeasurementCatalogue): string {
  const blocks: string[] = ['## Measures by area'];
  for (const area of METRIC_AREAS) {
    const areaMeasures = catalogue.measures.filter((measure) => measure.area === area);
    if (areaMeasures.length === 0) continue;
    blocks.push(
      '',
      `## Area ${area} — ${AREA_SUBJECTS[area]} (\`${AREA_FAMILY[area]}\`)`,
    );
    for (const measure of areaMeasures) {
      blocks.push('', renderMeasure(measure));
    }
  }
  return blocks.join('\n');
}

function renderVocabularies(): string {
  return [
    '## Registry vocabularies',
    '',
    'Applicability states (per unit × measure; `NOT_APPLICABLE` requires a',
    'durable reason; `UNKNOWN`/`CONFLICTED` create recognition work, never a',
    'silent pass):',
    '',
    APPLICABILITY_STATES.map((state) => `\`${state}\``).join(' · '),
    '',
    'Terminal measure-session outcomes (distinct vocabulary; a session may',
    'close with terminal knowledge and no patch):',
    '',
    TERMINAL_MEASURE_OUTCOMES.map((outcome) => `\`${outcome}\``).join(' · '),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the deterministic Markdown view of a loaded catalogue. Throws only
 * if the internal hash-agreement self-check fails, which indicates a defect
 * in this generator, never in the caller's data.
 */
export function generateCatalogueMarkdown(
  catalogue: LoadedMeasurementCatalogue,
  options?: CatalogueMarkdownOptions,
): string {
  const registrySourcePath = options?.registrySourcePath ?? DEFAULT_REGISTRY_SOURCE_PATH;
  const markdown = [
    renderHeader(catalogue, registrySourcePath),
    '',
    '---',
    '',
    renderFamilyTable(catalogue),
    '',
    renderCoordinateTable(catalogue),
    '',
    renderVocabularies(),
    '',
    renderAreaSections(catalogue),
    '',
  ].join('\n');

  const agreement = verifyGeneratedMarkdownAgreement(markdown, catalogue);
  if (!agreement.agrees) {
    throw new Error(
      `catalogueMarkdown self-check failed: embedded ${String(agreement.embeddedHash)} ` +
        `does not match registry content hash ${agreement.expectedHash}`,
    );
  }
  return markdown;
}

/** Convenience: YAML text → validated catalogue + generated Markdown, or structured issues. */
export function generateCatalogueMarkdownFromYaml(
  yamlText: string,
  options?: CatalogueMarkdownOptions,
): GenerateFromYamlResult {
  const loaded = tryLoadMeasurementCatalogue(yamlText);
  if (!loaded.ok) return { ok: false, issues: loaded.issues };
  return {
    ok: true,
    markdown: generateCatalogueMarkdown(loaded.catalogue, options),
    catalogue: loaded.catalogue,
  };
}
