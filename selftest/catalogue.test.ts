/**
 * catalogue.test.ts — selftest for the structured Measurement Catalogue registry.
 *
 * Proves, without DB or host dependencies (pure Node + zod + yaml):
 *   1. frozen v3 coordinate/alias derivation is deterministic and matches the
 *      canonical table (spot-checked cells across all four families);
 *   2. a complete synthetic v3 catalogue loads with correct counts, lookups,
 *      grid cells, legacy aliases, and family colors;
 *   3. the content hash is stable across repeated loads, independent of input
 *      order, identical through a YAML round trip, and changes on any semantic
 *      change; grid-layout / alias-map / color-policy hashes are exposed;
 *   4. generated-Markdown agreement (`Catalogue-Content-Hash`) is enforced;
 *   5. malformed registries are strictly rejected with structured issue codes
 *      (duplicates, v3 incompleteness, frozen-grid conflicts, alias conflicts,
 *      family conflicts, unknown fields, malformed YAML, reserved-cell rules,
 *      reserved-cell collisions, declared-alias-map drift);
 *   6. the six-state applicability model and the eleven terminal measure
 *      outcomes are modeled as separate vocabularies with the constitutional
 *      scheduling semantics, and the applicability record schema is strict;
 *   7. conditionally: if `config/measurements/catalogue.yaml` exists (delivered
 *      as the next Workstream D file), it must load cleanly — its identity is
 *      printed; absent file is a reported SKIP, not a failure.
 *
 * Run from the repository root (plain script, no test framework — matches the
 * kernel/projector/observer selftest style). Exit code 0 only if no check fails.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import {
  APPLICABILITY_STATES,
  RESERVED_GRID_INDICES,
  SHA256_HEX_PATTERN,
  TERMINAL_MEASURE_OUTCOMES,
  applicabilityAvoidsAssessment,
  applicabilityCreatesRecognitionTask,
  applicabilityRequiresConditionResolution,
  applicabilitySchedulesAssessment,
  derivedLegacyAliasMap,
  expectedV3MetricIds,
  frozenV3GridIndexFor,
  gridCellForIndex,
  isCanonicalMetricId,
  legacyAliasFor,
  measureApplicabilityRecordSchema,
  parseCanonicalMetricId,
  tryLoadMeasurementCatalogue,
  tryLoadMeasurementCatalogueFromValue,
  loadMeasurementCatalogue,
  assessCatalogueReadiness,
  assertProductionCatalogue,
  verifyGeneratedMarkdownAgreement,
} from '../src/analysis/measure/catalogue.js';
import type {
  CatalogueLoadResult,
  CatalogueValidationIssue,
  LoadedMeasurementCatalogue,
} from '../src/analysis/measure/catalogue.js';

// ---------------------------------------------------------------------------
// Minimal check harness (no framework; matches existing selftest style)
// ---------------------------------------------------------------------------

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const results: CheckResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function check(name: string, run: () => CheckStatus | void): void {
  try {
    const status = run();
    results.push({ name, status: status ?? 'PASS', detail: '' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, status: 'FAIL', detail });
  }
}

function expectOk(result: CatalogueLoadResult, context: string): LoadedMeasurementCatalogue {
  if (!result.ok) {
    const preview = result.issues
      .slice(0, 3)
      .map((entry) => `${entry.code}@${entry.path}`)
      .join('; ');
    throw new Error(`${context}: expected clean load, got issues [${preview}]`);
  }
  return result.catalogue;
}

function expectIssue(
  result: CatalogueLoadResult,
  code: string,
  context: string,
): CatalogueValidationIssue[] {
  if (result.ok) throw new Error(`${context}: expected rejection with ${code}, load succeeded`);
  const found = result.issues.some((entry) => entry.code === code);
  if (!found) {
    const preview = result.issues
      .slice(0, 5)
      .map((entry) => entry.code)
      .join(', ');
    throw new Error(`${context}: expected issue ${code}, got [${preview}]`);
  }
  return result.issues;
}

// ---------------------------------------------------------------------------
// Synthetic v3 registry builders
// ---------------------------------------------------------------------------

function syntheticMeasures(): Record<string, unknown>[] {
  return expectedV3MetricIds().map((id) => {
    const parsed = parseCanonicalMetricId(id);
    assert(parsed !== null, `builder produced invalid ID ${id}`);
    const area = parsed === null ? 'A' : parsed.area;
    return {
      id,
      name: `Synthetic ${id}`,
      question: `Does ${id} hold for the assessed unit?`,
      evidenceSources: ['synthetic evidence source'],
      failurePatterns: ['synthetic failure pattern'],
      projectionType: area === 'J' ? 'gate_state' : 'signed_score',
      normalizationProfileId: `NORM-${id}-v1`,
      status: 'ACTIVE',
    };
  });
}

function syntheticCatalogue(extraMeasures?: Record<string, unknown>[]): Record<string, unknown> {
  return {
    catalogueId: 'MCAT-selftest',
    version: '3.0',
    status: 'ACTIVE',
    targetProfileIds: ['PROFILE-clue', 'PROFILE-murugan'],
    measures: [...syntheticMeasures(), ...(extraMeasures ?? [])],
  };
}

/** The four measures catalogue v6 activates, shaped for the synthetic builder (DEV-P1-19). */
function v6ActivationMeasures(): Record<string, unknown>[] {
  const cells: Record<string, number> = { MH03: 97, MG08: 98, MI12: 99, MK19: 100 };
  return Object.entries(cells).map(([id, index]) => ({
    id,
    name: `${id} activation`,
    question: `Synthetic question for ${id}?`,
    projectionType: 'signed_score',
    normalizationProfileId: `NORM-${id}-v1`,
    status: 'ACTIVE',
    grid: { index },
  }));
}

function measuresOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  const measures = doc['measures'];
  assert(Array.isArray(measures), 'builder document has no measures array');
  return measures as Record<string, unknown>[];
}

function expansionMeasure(id: string, gridIndex?: number): Record<string, unknown> {
  const measure: Record<string, unknown> = {
    id,
    name: `Expansion ${id}`,
    question: `Does expansion ${id} hold?`,
    projectionType: 'signed_score',
    normalizationProfileId: `NORM-${id}-v1`,
    status: 'EXPERIMENTAL',
  };
  if (gridIndex !== undefined) measure['grid'] = { index: gridIndex };
  return measure;
}

// ---------------------------------------------------------------------------
// 1. Frozen derivation determinism
// ---------------------------------------------------------------------------

check('frozen v3 ID set: 96 unique grammar-valid IDs', () => {
  const ids = expectedV3MetricIds();
  assert(ids.length === 96, `expected 96 IDs, got ${String(ids.length)}`);
  assert(new Set(ids).size === 96, 'duplicate IDs in frozen set');
  for (const id of ids) assert(isCanonicalMetricId(id), `invalid grammar: ${id}`);
});

check('legacy alias derivation: 96 entries, spot values correct', () => {
  const aliasMap = derivedLegacyAliasMap();
  assert(Object.keys(aliasMap).length === 96, 'alias map must have 96 entries');
  assert(aliasMap['Q01'] === 'MA01', 'Q01 must map to MA01');
  assert(aliasMap['Q17'] === 'MC04', 'Q17 must map to MC04');
  assert(aliasMap['Q60'] === 'MH02', 'Q60 must map to MH02');
  assert(aliasMap['A05'] === 'MI05', 'A05 must map to MI05');
  assert(aliasMap['G07'] === 'MJ07', 'G07 must map to MJ07');
  assert(aliasMap['S18'] === 'MK18', 'S18 must map to MK18');
});

check('grid formula edges and frozen-set boundaries', () => {
  const c1 = gridCellForIndex(1);
  const c10 = gridCellForIndex(10);
  const c11 = gridCellForIndex(11);
  const c100 = gridCellForIndex(100);
  assert(c1.x === 1 && c1.y === 1, 'cell 1 must be (1,1)');
  assert(c10.x === 10 && c10.y === 1, 'cell 10 must be (10,1)');
  assert(c11.x === 1 && c11.y === 2, 'cell 11 must be (1,2)');
  assert(c100.x === 10 && c100.y === 10, 'cell 100 must be (10,10)');
  assert(frozenV3GridIndexFor('A', 6) === 6, 'MA06 must own cell 6');
  assert(frozenV3GridIndexFor('A', 7) === null, 'MA07 is outside the frozen set');
  assert(frozenV3GridIndexFor('K', 18) === 96, 'MK18 must own cell 96');
  assert(legacyAliasFor('K', 19) === null, 'MK19 has no legacy alias');
});

// ---------------------------------------------------------------------------
// 2. Full synthetic v3 load: counts, coordinates, lookups
// ---------------------------------------------------------------------------

const baseLoad = tryLoadMeasurementCatalogueFromValue(syntheticCatalogue());
let baseCatalogue: LoadedMeasurementCatalogue | null = null;

check('complete synthetic v3 catalogue loads cleanly', () => {
  baseCatalogue = expectOk(baseLoad, 'base load');
});

check('counts: 96 measures, 96 active, families 60/11/7/18', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  assert(baseCatalogue.measures.length === 96, 'measure count');
  assert(baseCatalogue.activeMeasureCount === 96, 'active count');
  assert(baseCatalogue.familyMetricIds.TARGET_QUALITY.length === 60, 'target-quality count');
  assert(baseCatalogue.familyMetricIds.EVIDENCE_ASSURANCE.length === 11, 'evidence count');
  assert(baseCatalogue.familyMetricIds.ACCEPTANCE_GATES.length === 7, 'gate count');
  assert(baseCatalogue.familyMetricIds.CLUE_SELF.length === 18, 'self count');
});

check('canonical table spot checks across all four families', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  const ma01 = baseCatalogue.measuresById.get('MA01');
  assert(
    ma01 !== undefined && ma01.grid.index === 1 && ma01.grid.x === 1 && ma01.grid.y === 1,
    'MA01 must occupy cell 1 (1,1)',
  );
  assert(ma01 !== undefined && ma01.legacyId === 'Q01' && ma01.familyColor === '#00a3e0', 'MA01 alias/color');
  const mc04 = baseCatalogue.measuresById.get('MC04');
  assert(
    mc04 !== undefined && mc04.grid.index === 17 && mc04.grid.x === 7 && mc04.grid.y === 2,
    'MC04 must occupy cell 17 (7,2)',
  );
  const mi01 = baseCatalogue.measuresById.get('MI01');
  assert(
    mi01 !== undefined && mi01.grid.index === 61 && mi01.grid.x === 1 && mi01.grid.y === 7,
    'MI01 must occupy cell 61 (1,7)',
  );
  assert(mi01 !== undefined && mi01.familyColor === '#f4af2d', 'MI01 must carry the gold family color');
  const mj06 = baseCatalogue.measuresById.get('MJ06');
  assert(
    mj06 !== undefined && mj06.grid.index === 77 && mj06.grid.x === 7 && mj06.grid.y === 8,
    'MJ06 must occupy cell 77 (7,8)',
  );
  assert(mj06 !== undefined && mj06.familyColor === '#ff5500', 'MJ06 must carry the gate family color');
  const mk18 = baseCatalogue.measuresById.get('MK18');
  assert(
    mk18 !== undefined && mk18.grid.index === 96 && mk18.grid.x === 6 && mk18.grid.y === 10,
    'MK18 must occupy cell 96 (6,10)',
  );
  assert(mk18 !== undefined && mk18.familyColor === '#39ff88', 'MK18 must carry the self family color');
});

check('lookup maps and reserved cells', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  const viaLegacy = baseCatalogue.measuresByLegacyId.get('G06');
  assert(viaLegacy !== undefined && viaLegacy.metricId === 'MJ06', 'legacy G06 must resolve to MJ06');
  const viaId = baseCatalogue.measuresById.get('MJ06');
  assert(viaId !== undefined && viaId === viaLegacy, 'both lookup maps must return one record');
  assert(
    baseCatalogue.reservedGridIndicesFree.length === RESERVED_GRID_INDICES.length,
    'all reserved cells must be free in the pure v3 set',
  );
});

// ---------------------------------------------------------------------------
// 3. Hash stability and identity
// ---------------------------------------------------------------------------

check('content hash stable across repeated loads', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  const again = expectOk(tryLoadMeasurementCatalogueFromValue(syntheticCatalogue()), 'repeat load');
  assert(again.identity.contentHash === baseCatalogue.identity.contentHash, 'repeat hash differs');
});

check('content hash independent of input measure order', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  const doc = syntheticCatalogue();
  doc['measures'] = measuresOf(doc).slice().reverse();
  const reversed = expectOk(tryLoadMeasurementCatalogueFromValue(doc), 'reversed load');
  assert(reversed.identity.contentHash === baseCatalogue.identity.contentHash, 'order changed the hash');
  assert(
    reversed.identity.gridLayoutHash === baseCatalogue.identity.gridLayoutHash,
    'order changed the grid-layout hash',
  );
});

check('YAML round trip preserves identity', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  const yamlText = toYaml(syntheticCatalogue());
  const fromYaml = expectOk(tryLoadMeasurementCatalogue(yamlText), 'yaml load');
  assert(
    fromYaml.identity.contentHash === baseCatalogue.identity.contentHash,
    'yaml round trip changed the hash',
  );
});

check('semantic change changes the content hash; identity hashes well-formed', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  const doc = syntheticCatalogue();
  const first = measuresOf(doc)[0];
  assert(first !== undefined, 'builder produced empty measures');
  if (first !== undefined) first['question'] = 'A materially different question?';
  const changed = expectOk(tryLoadMeasurementCatalogueFromValue(doc), 'changed load');
  assert(changed.identity.contentHash !== baseCatalogue.identity.contentHash, 'semantic change kept hash');
  for (const hash of [
    baseCatalogue.identity.contentHash,
    baseCatalogue.identity.gridLayoutHash,
    baseCatalogue.identity.legacyAliasMapHash,
    baseCatalogue.identity.familyColorPolicyHash,
  ]) {
    assert(SHA256_HEX_PATTERN.test(hash), `identity hash not 64-hex: ${hash}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Generated-Markdown agreement
// ---------------------------------------------------------------------------

check('markdown agreement: match, mismatch, and missing hash detected', () => {
  assert(baseCatalogue !== null, 'base catalogue unavailable');
  if (baseCatalogue === null) return;
  const good = `# Generated catalogue\nCatalogue-Content-Hash: ${baseCatalogue.identity.contentHash}\n`;
  const bad = `# Generated catalogue\nCatalogue-Content-Hash: ${'a'.repeat(64)}\n`;
  assert(verifyGeneratedMarkdownAgreement(good, baseCatalogue).agrees, 'matching hash must agree');
  const mismatch = verifyGeneratedMarkdownAgreement(bad, baseCatalogue);
  assert(!mismatch.agrees && mismatch.embeddedHash !== null, 'wrong hash must disagree');
  const missing = verifyGeneratedMarkdownAgreement('no hash present', baseCatalogue);
  assert(!missing.agrees && missing.embeddedHash === null, 'missing hash must disagree');
});

// ---------------------------------------------------------------------------
// 5. Strict rejection of malformed registries
// ---------------------------------------------------------------------------

check('duplicate canonical ID rejected', () => {
  const doc = syntheticCatalogue();
  const measures = measuresOf(doc);
  const third = measures[3];
  assert(third !== undefined, 'builder produced too few measures');
  if (third !== undefined) measures.push({ ...third });
  expectIssue(tryLoadMeasurementCatalogueFromValue(doc), 'METRIC_ID_DUPLICATE', 'duplicate ID');
});

check('v3 incompleteness rejected', () => {
  const doc = syntheticCatalogue();
  doc['measures'] = measuresOf(doc).slice(0, 95);
  const result = tryLoadMeasurementCatalogueFromValue(doc);
  assert(!result.ok, 'incomplete v3 must be rejected');
  if (!result.ok) {
    const codes = new Set(result.issues.map((entry) => entry.code));
    assert(
      codes.has('V3_INCOMPLETE') || codes.has('ORDINAL_GAP'),
      `expected V3_INCOMPLETE/ORDINAL_GAP, got [${[...codes].join(', ')}]`,
    );
  }
});

check('frozen-grid conflict and x/y mismatch rejected', () => {
  const conflictDoc = syntheticCatalogue();
  const conflictFirst = measuresOf(conflictDoc)[0];
  assert(conflictFirst !== undefined, 'builder produced empty measures');
  if (conflictFirst !== undefined) conflictFirst['grid'] = { index: 50 };
  expectIssue(tryLoadMeasurementCatalogueFromValue(conflictDoc), 'GRID_FROZEN_MISMATCH', 'frozen conflict');

  const xyDoc = syntheticCatalogue();
  const xyFirst = measuresOf(xyDoc)[0];
  assert(xyFirst !== undefined, 'builder produced empty measures');
  if (xyFirst !== undefined) xyFirst['grid'] = { index: 1, x: 9 };
  expectIssue(tryLoadMeasurementCatalogueFromValue(xyDoc), 'GRID_XY_MISMATCH', 'xy mismatch');
});

check('legacy-alias conflict and family conflict rejected', () => {
  const aliasDoc = syntheticCatalogue();
  const aliasTarget = measuresOf(aliasDoc)[10];
  assert(aliasTarget !== undefined, 'builder produced too few measures');
  if (aliasTarget !== undefined) aliasTarget['legacyId'] = 'Q01';
  expectIssue(tryLoadMeasurementCatalogueFromValue(aliasDoc), 'LEGACY_ALIAS_MISMATCH', 'alias conflict');

  const familyDoc = syntheticCatalogue();
  const familyTarget = measuresOf(familyDoc)[0];
  assert(familyTarget !== undefined, 'builder produced empty measures');
  if (familyTarget !== undefined) familyTarget['family'] = 'CLUE_SELF';
  expectIssue(tryLoadMeasurementCatalogueFromValue(familyDoc), 'FAMILY_MISMATCH', 'family conflict');
});

check('unknown fields and malformed YAML rejected with structured issues', () => {
  const doc = syntheticCatalogue();
  doc['surprise'] = true;
  expectIssue(tryLoadMeasurementCatalogueFromValue(doc), 'SCHEMA', 'unknown field');
  expectIssue(tryLoadMeasurementCatalogue('measures: [unclosed'), 'YAML_PARSE', 'malformed yaml');
});

check('reserved-cell expansion rules enforced', () => {
  const okResult = tryLoadMeasurementCatalogueFromValue(
    syntheticCatalogue([expansionMeasure('MK19', 97)]),
  );
  const okCatalogue = expectOk(okResult, 'valid expansion');
  assert(okCatalogue.measures.length === 97, 'expansion must add one measure');
  assert(okCatalogue.reservedGridIndicesFree.length === 3, 'one reserved cell must be consumed');
  const mk19 = okCatalogue.measuresById.get('MK19');
  assert(mk19 !== undefined && mk19.legacyId === null, 'expansion metric has no legacy alias');

  expectIssue(
    tryLoadMeasurementCatalogueFromValue(syntheticCatalogue([expansionMeasure('MK19')])),
    'GRID_RESERVED_REQUIRED',
    'expansion without cell',
  );
  expectIssue(
    tryLoadMeasurementCatalogueFromValue(syntheticCatalogue([expansionMeasure('MK19', 50)])),
    'GRID_RESERVED_RANGE',
    'expansion outside reserved range',
  );
  expectIssue(
    tryLoadMeasurementCatalogueFromValue(
      syntheticCatalogue([expansionMeasure('MK19', 97), expansionMeasure('MK20', 97)]),
    ),
    'GRID_COLLISION',
    'reserved-cell collision',
  );
});

check('declared alias map must equal the derived map exactly', () => {
  const exactDoc = syntheticCatalogue();
  exactDoc['declaredLegacyAliases'] = derivedLegacyAliasMap();
  expectOk(tryLoadMeasurementCatalogueFromValue(exactDoc), 'exact declared alias map');

  const wrongDoc = syntheticCatalogue();
  const wrongMap = derivedLegacyAliasMap();
  wrongMap['Q01'] = 'MB01';
  wrongDoc['declaredLegacyAliases'] = wrongMap;
  expectIssue(tryLoadMeasurementCatalogueFromValue(wrongDoc), 'ALIAS_MISMATCH', 'wrong declared alias');

  const subsetDoc = syntheticCatalogue();
  subsetDoc['declaredLegacyAliases'] = { Q01: 'MA01' };
  expectIssue(tryLoadMeasurementCatalogueFromValue(subsetDoc), 'ALIAS_INCOMPLETE', 'subset alias map');
});

// ---------------------------------------------------------------------------
// 6. Applicability model and terminal outcomes (separate vocabularies)
// ---------------------------------------------------------------------------

check('applicability states, scheduling semantics, and outcome separation', () => {
  assert(APPLICABILITY_STATES.length === 6, 'six applicability states required');
  assert(
    applicabilitySchedulesAssessment('REQUIRED') && applicabilitySchedulesAssessment('APPLICABLE'),
    'REQUIRED/APPLICABLE must schedule assessment',
  );
  assert(
    !applicabilitySchedulesAssessment('CONDITIONAL') &&
      applicabilityRequiresConditionResolution('CONDITIONAL'),
    'CONDITIONAL must not schedule before its condition is resolved',
  );
  assert(applicabilityAvoidsAssessment('NOT_APPLICABLE'), 'NOT_APPLICABLE must avoid the model call');
  assert(
    applicabilityCreatesRecognitionTask('UNKNOWN') && applicabilityCreatesRecognitionTask('CONFLICTED'),
    'UNKNOWN/CONFLICTED must create recognition work',
  );
  assert(TERMINAL_MEASURE_OUTCOMES.length === 11, 'eleven terminal outcomes required');
  const stateSet = new Set<string>(APPLICABILITY_STATES);
  assert(
    !stateSet.has('CONTEXT_INSUFFICIENT') && !stateSet.has('DEFERRED_WITH_REASON'),
    'terminal outcomes must not leak into applicability states',
  );
  const outcomeSet = new Set<string>(TERMINAL_MEASURE_OUTCOMES);
  assert(
    outcomeSet.has('CONTEXT_INSUFFICIENT') && outcomeSet.has('DEFERRED_WITH_REASON'),
    'CONTEXT_INSUFFICIENT/DEFERRED_WITH_REASON are terminal outcomes',
  );
});

check('applicability record schema: strict validation', () => {
  const valid = measureApplicabilityRecordSchema.safeParse({
    applicabilityId: 'MAP-0001',
    unitVersionId: 'UVR-0001',
    measureId: 'MC04',
    catalogueHash: 'b'.repeat(64),
    state: 'NOT_APPLICABLE',
    reason: 'pure type declaration file; no runtime throughput to measure',
    evidence: ['CLAIM-0001'],
    confidence: 0.9,
    resolvedBy: 'deterministic',
    snapshotId: 'SNP-0001',
  });
  assert(valid.success, 'well-formed applicability record must validate');

  const emptyReason = measureApplicabilityRecordSchema.safeParse({
    applicabilityId: 'MAP-0002',
    unitVersionId: 'UVR-0001',
    measureId: 'MC04',
    catalogueHash: 'b'.repeat(64),
    state: 'NOT_APPLICABLE',
    reason: '',
    evidence: [],
    confidence: 0.9,
    resolvedBy: 'deterministic',
    snapshotId: 'SNP-0001',
  });
  assert(!emptyReason.success, 'empty reason must be rejected');

  const badConfidence = measureApplicabilityRecordSchema.safeParse({
    applicabilityId: 'MAP-0003',
    unitVersionId: 'UVR-0001',
    measureId: 'MC04',
    catalogueHash: 'b'.repeat(64),
    state: 'APPLICABLE',
    reason: 'direct evidence available',
    evidence: [],
    confidence: 1.5,
    resolvedBy: 'ai',
    snapshotId: 'SNP-0001',
  });
  assert(!badConfidence.success, 'confidence above 1 must be rejected');

  const badPrefix = measureApplicabilityRecordSchema.safeParse({
    applicabilityId: 'WRONG-0004',
    unitVersionId: 'UVR-0001',
    measureId: 'MC04',
    catalogueHash: 'b'.repeat(64),
    state: 'APPLICABLE',
    reason: 'direct evidence available',
    evidence: [],
    confidence: 0.5,
    resolvedBy: 'ai',
    snapshotId: 'SNP-0001',
  });
  assert(!badPrefix.success, 'wrong applicability ID prefix must be rejected');
});

// ---------------------------------------------------------------------------
// 7. Conditional: real registry data, once delivered
// ---------------------------------------------------------------------------

check('DEV-P1-18: the real registry is catalogue v6 with 100 active coordinates', () => {
  const realPath = join(process.cwd(), 'config', 'measurements', 'catalogue.yaml');
  if (!existsSync(realPath)) return 'SKIP';
  const loaded = expectOk(tryLoadMeasurementCatalogue(readFileSync(realPath, 'utf8')), 'real registry');

  assert(loaded.identity.version === '6.0', `expected version 6.0, got ${loaded.identity.version}`);
  assert(loaded.measures.length === 100, `expected 100 measures, got ${String(loaded.measures.length)}`);
  assert(loaded.activeMeasureCount === 100, 'all 100 coordinates must be active under v6');
  assert(loaded.reservedGridIndicesFree.length === 0, 'v6 leaves no reserved cell free');

  // The four activations occupy exactly the cells v3 reserved, and carry no v2 legacy alias.
  const expected: Record<string, number> = { MH03: 97, MG08: 98, MI12: 99, MK19: 100 };
  for (const [metricId, gridIndex] of Object.entries(expected)) {
    const measure = loaded.measuresById.get(metricId);
    assert(measure !== undefined, `${metricId} is present`);
    if (measure === undefined) continue;
    assert(measure.grid.index === gridIndex, `${metricId} owns cell ${String(gridIndex)}`);
    assert(measure.legacyId === null, `${metricId} has no v2 legacy alias`);
  }

  // No historic cell moved: the frozen v3 set still owns cells 1-96.
  for (const metricId of expectedV3MetricIds()) {
    const measure = loaded.measuresById.get(metricId);
    assert(measure !== undefined, `frozen metric ${metricId} survives the migration`);
    if (measure === undefined) continue;
    assert(measure.grid.index <= 96, `${metricId} stays inside the frozen 1-96 range`);
  }
  return 'PASS';
});

check('DEV-P1-19: v6 requires an explicit migration declaration', () => {
  // A v6 document that activates the last four cells but never says what it replaces is refused:
  // an undeclared migration cannot be distinguished from a catalogue authored from nothing.
  const doc = syntheticCatalogue(v6ActivationMeasures());
  doc['version'] = '6.0';
  const result = tryLoadMeasurementCatalogueFromValue(doc);
  assert(!result.ok, 'a v6 catalogue without supersedes must be rejected');
  if (result.ok) return 'FAIL';
  const codes = result.issues.map((entry) => entry.code);
  assert(codes.includes('V6_MIGRATION_UNDECLARED'), `expected V6_MIGRATION_UNDECLARED, got ${codes.join(',')}`);

  // With the declaration present the same document loads.
  doc['supersedes'] = '3.0';
  const migrated = expectOk(tryLoadMeasurementCatalogueFromValue(doc), 'declared migration');
  assert(migrated.activeMeasureCount === 100, 'the migrated catalogue carries 100 active coordinates');
  return 'PASS';
});

check('DEV-P1-19: a v3 catalogue loads as history but is refused for production', () => {
  // Validity and readiness are separate judgements: v3 records must stay readable.
  const historic = expectOk(tryLoadMeasurementCatalogueFromValue(syntheticCatalogue()), 'v3 load');
  assert(historic.identity.version === '3.0', 'the historic catalogue still loads');

  const readiness = assessCatalogueReadiness(historic);
  assert(!readiness.ready, 'a v3 catalogue must not be production ready');
  assert(readiness.major === 3, `expected major 3, got ${String(readiness.major)}`);
  assert(
    readiness.reasons.some((reason) => reason.includes('below the production minimum')),
    `expected a revision reason, got ${readiness.reasons.join(' | ')}`,
  );
  // It also names the concrete consequence: the expansion cells are not active.
  assert(
    readiness.reasons.some((reason) => reason.includes('reserved') || reason.includes('97')),
    'readiness explains that cells 97-100 are not active',
  );

  let threw = false;
  try {
    assertProductionCatalogue(historic);
  } catch {
    threw = true;
  }
  assert(threw, 'assertProductionCatalogue must reject a v3 catalogue');
  return 'PASS';
});

check('DEV-P1-19: the real v6 registry is production ready, and the throwing loader gates on it', () => {
  const realPath = join(process.cwd(), 'config', 'measurements', 'catalogue.yaml');
  if (!existsSync(realPath)) return 'SKIP';
  const yamlText = readFileSync(realPath, 'utf8');

  const readiness = assessCatalogueReadiness(expectOk(tryLoadMeasurementCatalogue(yamlText), 'real'));
  assert(readiness.ready, `real registry must be production ready: ${readiness.reasons.join(' | ')}`);
  assert(readiness.major === 6, 'the real registry is revision 6');

  // The throwing loader — the variant the daemon and dashboard use — enforces readiness by default.
  const loaded = loadMeasurementCatalogue(yamlText);
  assert(loaded.activeMeasureCount === 100, 'production load yields 100 active coordinates');
  return 'PASS';
});

check('DEV-P1-18: a v6 catalogue missing an activation metric is rejected', () => {
  // Before this change the completeness gate only ran for major version 3, so bumping to 6.0
  // silently switched it off. A v6 document missing MK19 must now fail to load.
  const doc = syntheticCatalogue();
  doc['version'] = '6.0';
  const result = tryLoadMeasurementCatalogueFromValue(doc);
  assert(!result.ok, 'a v6 catalogue without the activation metrics must be rejected');
  if (result.ok) return 'FAIL';
  const codes = result.issues.map((entry) => entry.code);
  assert(codes.includes('V6_INCOMPLETE'), `expected V6_INCOMPLETE, got ${codes.join(',')}`);
  return 'PASS';
});

check('real config/measurements/catalogue.yaml loads cleanly (SKIP if absent)', () => {
  const realPath = join(process.cwd(), 'config', 'measurements', 'catalogue.yaml');
  if (!existsSync(realPath)) {
    console.log('  note: config/measurements/catalogue.yaml not present yet — skipping');
    return 'SKIP';
  }
  const yamlText = readFileSync(realPath, 'utf8');
  const loaded = expectOk(tryLoadMeasurementCatalogue(yamlText), 'real registry');
  console.log(
    `  real catalogue: version ${loaded.identity.version} · ` +
      `content ${loaded.identity.contentHash.slice(0, 12)}… · ` +
      `${String(loaded.measures.length)} measures · ${String(loaded.activeMeasureCount)} active`,
  );
  return 'PASS';
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;
let skipCount = 0;
for (const result of results) {
  if (result.status === 'PASS') passCount += 1;
  else if (result.status === 'FAIL') failCount += 1;
  else skipCount += 1;
  const suffix = result.detail === '' ? '' : ` — ${result.detail}`;
  console.log(`${result.status} ${result.name}${suffix}`);
}
const judged = passCount + failCount;
const skipNote = skipCount > 0 ? ` (${String(skipCount)} skipped)` : '';
console.log(`catalogue selftest: ${String(passCount)}/${String(judged)} checks passed${skipNote}`);
process.exit(failCount === 0 ? 0 : 1);
