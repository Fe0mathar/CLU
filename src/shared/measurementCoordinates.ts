/**
 * CLUE canonical measurement coordinates — the 10 × 10 Great Book grid.
 *
 * Spec: CLUE_Canonical_Measurement_Catalogue_v9 §2.7–§2.9 (legacy aliases, canonical grid, family
 *       colour policy) — the normative coordinate table this module transcribes;
 *       CLUE_Interface_Design_v9 §10.2.2 (62 / 12 / 7 / 19 family allocation);
 *       CLUE_Status_Contract_v9 §20.11 (all 100 active v6 metrics resolve to unique IDs and cells).
 * Backlog: DEV-P1-20 — exact v6 coordinate/family map, 100 unique active coordinates, and
 *          compile-time/runtime parity.
 *
 * Every metric owns one permanent cell. The coordinate derives from the canonical order and never
 * shifts because a label changed:
 *
 *   x = ((gridIndex - 1) mod 10) + 1
 *   y = floor((gridIndex - 1) / 10) + 1
 *
 * Catalogue v6 activates the final four expansion cells — `MH03` (97), `MG08` (98), `MI12` (99) and
 * `MK19` (100) — rather than shifting any historic coordinate. Cells 1–96 and every legacy alias are
 * byte-for-byte what they were, so no completed record is renumbered; the four new IDs have no v2
 * legacy alias, which is why their `legacyId` is null. A consequence the catalogue states explicitly:
 * family districts remain visually recognizable but are no longer strictly contiguous, so family
 * identity is read from the `family` field and never inferred from physical adjacency.
 *
 * `RESERVED` remains in the family union although no coordinate now carries it. The renderers branch
 * on it, and a future catalogue that reserves cells again needs the behaviour to already exist —
 * deleting it would trade a defined empty state for an undefined one.
 *
 * This module is a governed input to the mission basis (see mission.ts): its bytes are hashed, so
 * editing this table is a governed change that must register a successor mission.
 */

export type CanonicalMetricFamily =
  | 'TARGET_QUALITY'
  | 'EVIDENCE_ASSURANCE'
  | 'ACCEPTANCE_GATES'
  | 'CLUE_SELF'
  | 'RESERVED';

export interface MetricCoordinate {
  readonly gridIndex: number;
  readonly x: number;
  readonly y: number;
  readonly measurementId: string;
  readonly legacyId: string | null;
  readonly family: CanonicalMetricFamily;
  readonly area: string | null;
  readonly name: string;
}

export const METRIC_COORDINATES: readonly MetricCoordinate[] = [
  { gridIndex: 1, x: 1, y: 1, measurementId: 'MA01', legacyId: 'Q01', family: 'TARGET_QUALITY', area: 'A', name: 'Purpose alignment' },
  { gridIndex: 2, x: 2, y: 1, measurementId: 'MA02', legacyId: 'Q02', family: 'TARGET_QUALITY', area: 'A', name: 'Utility and value realization' },
  { gridIndex: 3, x: 3, y: 1, measurementId: 'MA03', legacyId: 'Q03', family: 'TARGET_QUALITY', area: 'A', name: 'Capability preservation and evolution' },
  { gridIndex: 4, x: 4, y: 1, measurementId: 'MA04', legacyId: 'Q04', family: 'TARGET_QUALITY', area: 'A', name: 'Workload integrity' },
  { gridIndex: 5, x: 5, y: 1, measurementId: 'MA05', legacyId: 'Q05', family: 'TARGET_QUALITY', area: 'A', name: 'Stakeholder and user outcome' },
  { gridIndex: 6, x: 6, y: 1, measurementId: 'MA06', legacyId: 'Q06', family: 'TARGET_QUALITY', area: 'A', name: 'Economy and total cost of ownership' },
  { gridIndex: 7, x: 7, y: 1, measurementId: 'MB01', legacyId: 'Q07', family: 'TARGET_QUALITY', area: 'B', name: 'Functional completeness' },
  { gridIndex: 8, x: 8, y: 1, measurementId: 'MB02', legacyId: 'Q08', family: 'TARGET_QUALITY', area: 'B', name: 'Functional correctness' },
  { gridIndex: 9, x: 9, y: 1, measurementId: 'MB03', legacyId: 'Q09', family: 'TARGET_QUALITY', area: 'B', name: 'Contract and API conformance' },
  { gridIndex: 10, x: 10, y: 1, measurementId: 'MB04', legacyId: 'Q10', family: 'TARGET_QUALITY', area: 'B', name: 'State and data integrity' },
  { gridIndex: 11, x: 1, y: 2, measurementId: 'MB05', legacyId: 'Q11', family: 'TARGET_QUALITY', area: 'B', name: 'Temporal and concurrency correctness' },
  { gridIndex: 12, x: 2, y: 2, measurementId: 'MB06', legacyId: 'Q12', family: 'TARGET_QUALITY', area: 'B', name: 'Determinism and controlled variability' },
  { gridIndex: 13, x: 3, y: 2, measurementId: 'MB07', legacyId: 'Q13', family: 'TARGET_QUALITY', area: 'B', name: 'Numerical and precision integrity' },
  { gridIndex: 14, x: 4, y: 2, measurementId: 'MC01', legacyId: 'Q14', family: 'TARGET_QUALITY', area: 'C', name: 'Complexity proportionality' },
  { gridIndex: 15, x: 5, y: 2, measurementId: 'MC02', legacyId: 'Q15', family: 'TARGET_QUALITY', area: 'C', name: 'Architectural coherence' },
  { gridIndex: 16, x: 6, y: 2, measurementId: 'MC03', legacyId: 'Q16', family: 'TARGET_QUALITY', area: 'C', name: 'Cohesion' },
  { gridIndex: 17, x: 7, y: 2, measurementId: 'MC04', legacyId: 'Q17', family: 'TARGET_QUALITY', area: 'C', name: 'Coupling and dependency surface' },
  { gridIndex: 18, x: 8, y: 2, measurementId: 'MC05', legacyId: 'Q18', family: 'TARGET_QUALITY', area: 'C', name: 'Modularity and replaceability' },
  { gridIndex: 19, x: 9, y: 2, measurementId: 'MC06', legacyId: 'Q19', family: 'TARGET_QUALITY', area: 'C', name: 'Boundary and interface quality' },
  { gridIndex: 20, x: 10, y: 2, measurementId: 'MC07', legacyId: 'Q20', family: 'TARGET_QUALITY', area: 'C', name: 'Responsibility concentration' },
  { gridIndex: 21, x: 1, y: 3, measurementId: 'MC08', legacyId: 'Q21', family: 'TARGET_QUALITY', area: 'C', name: 'Redundancy' },
  { gridIndex: 22, x: 2, y: 3, measurementId: 'MC09', legacyId: 'Q22', family: 'TARGET_QUALITY', area: 'C', name: 'Dead code' },
  { gridIndex: 23, x: 3, y: 3, measurementId: 'MC10', legacyId: 'Q23', family: 'TARGET_QUALITY', area: 'C', name: 'Obsolescence' },
  { gridIndex: 24, x: 4, y: 3, measurementId: 'MC11', legacyId: 'Q24', family: 'TARGET_QUALITY', area: 'C', name: 'Technical debt' },
  { gridIndex: 25, x: 5, y: 3, measurementId: 'MC12', legacyId: 'Q25', family: 'TARGET_QUALITY', area: 'C', name: 'Architectural entropy and evolvability' },
  { gridIndex: 26, x: 6, y: 3, measurementId: 'MC13', legacyId: 'Q26', family: 'TARGET_QUALITY', area: 'C', name: 'Analyzability and understandability' },
  { gridIndex: 27, x: 7, y: 3, measurementId: 'MC14', legacyId: 'Q27', family: 'TARGET_QUALITY', area: 'C', name: 'Testability' },
  { gridIndex: 28, x: 8, y: 3, measurementId: 'MC15', legacyId: 'Q28', family: 'TARGET_QUALITY', area: 'C', name: 'Observability' },
  { gridIndex: 29, x: 9, y: 3, measurementId: 'MD01', legacyId: 'Q29', family: 'TARGET_QUALITY', area: 'D', name: 'Intrinsic efficiency' },
  { gridIndex: 30, x: 10, y: 3, measurementId: 'MD02', legacyId: 'Q30', family: 'TARGET_QUALITY', area: 'D', name: 'Cost amplification' },
  { gridIndex: 31, x: 1, y: 4, measurementId: 'MD03', legacyId: 'Q31', family: 'TARGET_QUALITY', area: 'D', name: 'Critical-path influence' },
  { gridIndex: 32, x: 2, y: 4, measurementId: 'MD04', legacyId: 'Q32', family: 'TARGET_QUALITY', area: 'D', name: 'Throughput and latency' },
  { gridIndex: 33, x: 3, y: 4, measurementId: 'MD05', legacyId: 'Q33', family: 'TARGET_QUALITY', area: 'D', name: 'Tail behavior and cost predictability' },
  { gridIndex: 34, x: 4, y: 4, measurementId: 'MD06', legacyId: 'Q34', family: 'TARGET_QUALITY', area: 'D', name: 'Memory and resource lifecycle' },
  { gridIndex: 35, x: 5, y: 4, measurementId: 'MD07', legacyId: 'Q35', family: 'TARGET_QUALITY', area: 'D', name: 'I/O, network, and storage efficiency' },
  { gridIndex: 36, x: 6, y: 4, measurementId: 'MD08', legacyId: 'Q36', family: 'TARGET_QUALITY', area: 'D', name: 'Scalability' },
  { gridIndex: 37, x: 7, y: 4, measurementId: 'MD09', legacyId: 'Q37', family: 'TARGET_QUALITY', area: 'D', name: 'Degradation shape and resource adaptability' },
  { gridIndex: 38, x: 8, y: 4, measurementId: 'MD10', legacyId: 'Q38', family: 'TARGET_QUALITY', area: 'D', name: 'Energy and carbon efficiency' },
  { gridIndex: 39, x: 9, y: 4, measurementId: 'ME01', legacyId: 'Q39', family: 'TARGET_QUALITY', area: 'E', name: 'Reliability and availability' },
  { gridIndex: 40, x: 10, y: 4, measurementId: 'ME02', legacyId: 'Q40', family: 'TARGET_QUALITY', area: 'E', name: 'Fragility and blast radius' },
  { gridIndex: 41, x: 1, y: 5, measurementId: 'ME03', legacyId: 'Q41', family: 'TARGET_QUALITY', area: 'E', name: 'Fault isolation and containment' },
  { gridIndex: 42, x: 2, y: 5, measurementId: 'ME04', legacyId: 'Q42', family: 'TARGET_QUALITY', area: 'E', name: 'Resilience and recovery' },
  { gridIndex: 43, x: 3, y: 5, measurementId: 'ME05', legacyId: 'Q43', family: 'TARGET_QUALITY', area: 'E', name: 'Graceful degradation and fallback quality' },
  { gridIndex: 44, x: 4, y: 5, measurementId: 'ME06', legacyId: 'Q44', family: 'TARGET_QUALITY', area: 'E', name: 'Reversibility and rollback' },
  { gridIndex: 45, x: 5, y: 5, measurementId: 'ME07', legacyId: 'Q45', family: 'TARGET_QUALITY', area: 'E', name: 'Safety and fail-safe behavior' },
  { gridIndex: 46, x: 6, y: 5, measurementId: 'MF01', legacyId: 'Q46', family: 'TARGET_QUALITY', area: 'F', name: 'Security' },
  { gridIndex: 47, x: 7, y: 5, measurementId: 'MF02', legacyId: 'Q47', family: 'TARGET_QUALITY', area: 'F', name: 'Privacy and data minimization' },
  { gridIndex: 48, x: 8, y: 5, measurementId: 'MF03', legacyId: 'Q48', family: 'TARGET_QUALITY', area: 'F', name: 'Supply-chain and provenance integrity' },
  { gridIndex: 49, x: 9, y: 5, measurementId: 'MF04', legacyId: 'Q49', family: 'TARGET_QUALITY', area: 'F', name: 'Abuse and misuse resistance' },
  { gridIndex: 50, x: 10, y: 5, measurementId: 'MF05', legacyId: 'Q50', family: 'TARGET_QUALITY', area: 'F', name: 'Autonomy appropriateness and human control' },
  { gridIndex: 51, x: 1, y: 6, measurementId: 'MF06', legacyId: 'Q51', family: 'TARGET_QUALITY', area: 'F', name: 'Auditability, accountability, and policy conformance' },
  { gridIndex: 52, x: 2, y: 6, measurementId: 'MG01', legacyId: 'Q52', family: 'TARGET_QUALITY', area: 'G', name: 'Compatibility and interoperability' },
  { gridIndex: 53, x: 3, y: 6, measurementId: 'MG02', legacyId: 'Q53', family: 'TARGET_QUALITY', area: 'G', name: 'Backward and forward compatibility' },
  { gridIndex: 54, x: 4, y: 6, measurementId: 'MG03', legacyId: 'Q54', family: 'TARGET_QUALITY', area: 'G', name: 'Portability' },
  { gridIndex: 55, x: 5, y: 6, measurementId: 'MG04', legacyId: 'Q55', family: 'TARGET_QUALITY', area: 'G', name: 'Adaptability and plasticity' },
  { gridIndex: 56, x: 6, y: 6, measurementId: 'MG05', legacyId: 'Q56', family: 'TARGET_QUALITY', area: 'G', name: 'Deployability and operability' },
  { gridIndex: 57, x: 7, y: 6, measurementId: 'MG06', legacyId: 'Q57', family: 'TARGET_QUALITY', area: 'G', name: 'Accessibility, inclusivity, and usability' },
  { gridIndex: 58, x: 8, y: 6, measurementId: 'MG07', legacyId: 'Q58', family: 'TARGET_QUALITY', area: 'G', name: 'Reusability and generalization' },
  { gridIndex: 59, x: 9, y: 6, measurementId: 'MH01', legacyId: 'Q59', family: 'TARGET_QUALITY', area: 'H', name: 'Explainability and transparency' },
  { gridIndex: 60, x: 10, y: 6, measurementId: 'MH02', legacyId: 'Q60', family: 'TARGET_QUALITY', area: 'H', name: 'Quality balance and Pareto integrity' },
  { gridIndex: 61, x: 1, y: 7, measurementId: 'MI01', legacyId: 'A01', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Purpose-context sufficiency' },
  { gridIndex: 62, x: 2, y: 7, measurementId: 'MI02', legacyId: 'A02', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Measurement validity' },
  { gridIndex: 63, x: 3, y: 7, measurementId: 'MI03', legacyId: 'A03', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Benchmark representativeness' },
  { gridIndex: 64, x: 4, y: 7, measurementId: 'MI04', legacyId: 'A04', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Coverage completeness' },
  { gridIndex: 65, x: 5, y: 7, measurementId: 'MI05', legacyId: 'A05', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Causal attribution' },
  { gridIndex: 66, x: 6, y: 7, measurementId: 'MI06', legacyId: 'A06', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Confidence and uncertainty calibration' },
  { gridIndex: 67, x: 7, y: 7, measurementId: 'MI07', legacyId: 'A07', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Knowledge freshness' },
  { gridIndex: 68, x: 8, y: 7, measurementId: 'MI08', legacyId: 'A08', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Instrument self-validity and observer effect' },
  { gridIndex: 69, x: 9, y: 7, measurementId: 'MI09', legacyId: 'A09', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Reproducibility and replicability' },
  { gridIndex: 70, x: 10, y: 7, measurementId: 'MI10', legacyId: 'A10', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Regression sensitivity' },
  { gridIndex: 71, x: 1, y: 8, measurementId: 'MI11', legacyId: 'A11', family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Scope-of-claim integrity and residual unknowns' },
  { gridIndex: 72, x: 2, y: 8, measurementId: 'MJ01', legacyId: 'G01', family: 'ACCEPTANCE_GATES', area: 'J', name: 'Purpose Preservation' },
  { gridIndex: 73, x: 3, y: 8, measurementId: 'MJ02', legacyId: 'G02', family: 'ACCEPTANCE_GATES', area: 'J', name: 'Capability Preservation' },
  { gridIndex: 74, x: 4, y: 8, measurementId: 'MJ03', legacyId: 'G03', family: 'ACCEPTANCE_GATES', area: 'J', name: 'Workload Integrity' },
  { gridIndex: 75, x: 5, y: 8, measurementId: 'MJ04', legacyId: 'G04', family: 'ACCEPTANCE_GATES', area: 'J', name: 'Correctness and Contract Integrity' },
  { gridIndex: 76, x: 6, y: 8, measurementId: 'MJ05', legacyId: 'G05', family: 'ACCEPTANCE_GATES', area: 'J', name: 'Evidence Admissibility' },
  { gridIndex: 77, x: 7, y: 8, measurementId: 'MJ06', legacyId: 'G06', family: 'ACCEPTANCE_GATES', area: 'J', name: 'Global Regression Guardrail' },
  { gridIndex: 78, x: 8, y: 8, measurementId: 'MJ07', legacyId: 'G07', family: 'ACCEPTANCE_GATES', area: 'J', name: 'Reversibility and Recovery' },
  { gridIndex: 79, x: 9, y: 8, measurementId: 'MK01', legacyId: 'S01', family: 'CLUE_SELF', area: 'K', name: 'Cost per proven improvement' },
  { gridIndex: 80, x: 10, y: 8, measurementId: 'MK02', legacyId: 'S02', family: 'CLUE_SELF', area: 'K', name: 'Time to terminal disposition' },
  { gridIndex: 81, x: 1, y: 9, measurementId: 'MK03', legacyId: 'S03', family: 'CLUE_SELF', area: 'K', name: 'Finding precision' },
  { gridIndex: 82, x: 2, y: 9, measurementId: 'MK04', legacyId: 'S04', family: 'CLUE_SELF', area: 'K', name: 'Regression escape rate' },
  { gridIndex: 83, x: 3, y: 9, measurementId: 'MK05', legacyId: 'S05', family: 'CLUE_SELF', area: 'K', name: 'Repeated-work rate' },
  { gridIndex: 84, x: 4, y: 9, measurementId: 'MK06', legacyId: 'S06', family: 'CLUE_SELF', area: 'K', name: 'Coverage and uncertainty reduction' },
  { gridIndex: 85, x: 5, y: 9, measurementId: 'MK07', legacyId: 'S07', family: 'CLUE_SELF', area: 'K', name: 'Forecast calibration' },
  { gridIndex: 86, x: 6, y: 9, measurementId: 'MK08', legacyId: 'S08', family: 'CLUE_SELF', area: 'K', name: 'Instrument validity rate' },
  { gridIndex: 87, x: 7, y: 9, measurementId: 'MK09', legacyId: 'S09', family: 'CLUE_SELF', area: 'K', name: 'Test-catalogue efficiency' },
  { gridIndex: 88, x: 8, y: 9, measurementId: 'MK10', legacyId: 'S10', family: 'CLUE_SELF', area: 'K', name: 'Mission continuity' },
  { gridIndex: 89, x: 9, y: 9, measurementId: 'MK11', legacyId: 'S11', family: 'CLUE_SELF', area: 'K', name: 'Custody safety' },
  { gridIndex: 90, x: 10, y: 9, measurementId: 'MK12', legacyId: 'S12', family: 'CLUE_SELF', area: 'K', name: 'Equilibrium credibility' },
  { gridIndex: 91, x: 1, y: 10, measurementId: 'MK13', legacyId: 'S13', family: 'CLUE_SELF', area: 'K', name: 'Measure-session token efficiency' },
  { gridIndex: 92, x: 2, y: 10, measurementId: 'MK14', legacyId: 'S14', family: 'CLUE_SELF', area: 'K', name: 'Model-routing value' },
  { gridIndex: 93, x: 3, y: 10, measurementId: 'MK15', legacyId: 'S15', family: 'CLUE_SELF', area: 'K', name: 'Catalogue maintainability' },
  { gridIndex: 94, x: 4, y: 10, measurementId: 'MK16', legacyId: 'S16', family: 'CLUE_SELF', area: 'K', name: 'Catalogue-review effectiveness' },
  { gridIndex: 95, x: 5, y: 10, measurementId: 'MK17', legacyId: 'S17', family: 'CLUE_SELF', area: 'K', name: 'Conversation-orchestration integrity' },
  { gridIndex: 96, x: 6, y: 10, measurementId: 'MK18', legacyId: 'S18', family: 'CLUE_SELF', area: 'K', name: 'Status fidelity' },
  { gridIndex: 97, x: 7, y: 10, measurementId: 'MH03', legacyId: null, family: 'TARGET_QUALITY', area: 'H', name: 'Method adequacy and applicable-frontier position' },
  { gridIndex: 98, x: 8, y: 10, measurementId: 'MG08', legacyId: null, family: 'TARGET_QUALITY', area: 'G', name: 'Cross-environment contract integrity and impedance' },
  { gridIndex: 99, x: 9, y: 10, measurementId: 'MI12', legacyId: null, family: 'EVIDENCE_ASSURANCE', area: 'I', name: 'Evidence-plan and benchmark-synthesis validity' },
  { gridIndex: 100, x: 10, y: 10, measurementId: 'MK19', legacyId: null, family: 'CLUE_SELF', area: 'K', name: 'RPI value yield and horizon realization' },
] as const;

const byMeasurement = new Map(
  METRIC_COORDINATES.map((coordinate) => [coordinate.measurementId, coordinate]),
);

/** The number of canonical cells the grid defines. Fixed by the catalogue, not by this array's length. */
export const CANONICAL_GRID_SIZE = 100;

/** Metrics with a real canonical identity — every cell, now that v6 activated the last four. */
export const ACTIVE_COORDINATES: readonly MetricCoordinate[] = METRIC_COORDINATES.filter(
  (coordinate) => coordinate.family !== 'RESERVED',
);

/** Documented family allocation (CLUE_Interface_Design_v9 §10.2.2), asserted below rather than assumed. */
const EXPECTED_FAMILY_COUNTS: Readonly<Record<Exclude<CanonicalMetricFamily, 'RESERVED'>, number>> = {
  TARGET_QUALITY: 62,
  EVIDENCE_ASSURANCE: 12,
  ACCEPTANCE_GATES: 7,
  CLUE_SELF: 19,
};

/**
 * Compile-time/runtime parity (DEV-P1-20).
 *
 * The table above is transcribed from a document, and a transcription can drift: a duplicated ID, a
 * cell claimed twice, an x/y that no longer follows the derivation, or a family that quietly gained a
 * member. Checking at module load makes a corrupted table a startup failure with a precise reason,
 * rather than a projection that renders a plausible but wrong grid. The cost is one pass over 100
 * entries, once.
 */
function assertCoordinateIntegrity(): void {
  if (METRIC_COORDINATES.length !== CANONICAL_GRID_SIZE) {
    throw new Error(
      `measurement coordinates: expected ${CANONICAL_GRID_SIZE} cells, found ${METRIC_COORDINATES.length}`,
    );
  }
  if (byMeasurement.size !== CANONICAL_GRID_SIZE) {
    throw new Error('measurement coordinates: canonical IDs are not unique');
  }

  const cells = new Set<string>();
  const legacy = new Set<string>();
  const familyCounts: Record<string, number> = {};

  for (const [index, coordinate] of METRIC_COORDINATES.entries()) {
    const expectedGrid = index + 1;
    if (coordinate.gridIndex !== expectedGrid) {
      throw new Error(
        `measurement coordinates: cell ${String(expectedGrid)} declares gridIndex ${String(coordinate.gridIndex)}`,
      );
    }
    const expectedX = ((expectedGrid - 1) % 10) + 1;
    const expectedY = Math.floor((expectedGrid - 1) / 10) + 1;
    if (coordinate.x !== expectedX || coordinate.y !== expectedY) {
      throw new Error(
        `measurement coordinates: cell ${String(expectedGrid)} is at (${String(coordinate.x)},${String(coordinate.y)}), ` +
          `not the derived (${String(expectedX)},${String(expectedY)})`,
      );
    }
    const cellKey = `${String(coordinate.x)},${String(coordinate.y)}`;
    if (cells.has(cellKey)) {
      throw new Error(`measurement coordinates: cell (${cellKey}) is claimed twice`);
    }
    cells.add(cellKey);

    if (coordinate.legacyId !== null) {
      if (legacy.has(coordinate.legacyId)) {
        throw new Error(`measurement coordinates: legacy alias ${coordinate.legacyId} is claimed twice`);
      }
      legacy.add(coordinate.legacyId);
    }
    familyCounts[coordinate.family] = (familyCounts[coordinate.family] ?? 0) + 1;
  }

  for (const [family, expected] of Object.entries(EXPECTED_FAMILY_COUNTS)) {
    const actual = familyCounts[family] ?? 0;
    if (actual !== expected) {
      throw new Error(
        `measurement coordinates: family ${family} holds ${String(actual)} cells, not the documented ${String(expected)}`,
      );
    }
  }
}

assertCoordinateIntegrity();

export function coordinateForMetric(measurementId: string): MetricCoordinate | null {
  return byMeasurement.get(measurementId) ?? null;
}
