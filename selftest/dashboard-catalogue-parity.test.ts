/**
 * Dashboard ↔ canonical catalogue parity.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §20.1 — the dashboard shell "must not recreate Q1,
 *       metric, Git, benchmark, or verdict state locally".
 *       `CLUE_Q1_System_Navigator_v9.md` §14.3 — classification is backend-owned.
 *       `CLUE_Status_Contract_v9.md` §20 gate 11 — all 100 active v6 metrics resolve to
 *       unique canonical IDs and grid cells; gate 16 — the Dashboard, CLI, exported JSON,
 *       Great Book and field projection agree on family colours, modes, filters and values.
 *
 * Backlog: DEV-P1-16 — `ui/clue-dashboard/app.js` carried a hardcoded 100-cell list whose
 *          last four entries were still v3's `RESERVED-97..100`. `modelFromView` looks each
 *          server cell up by measurement id in that list; the v6 activations `MH03`, `MG08`,
 *          `MI12` and `MK19` were absent, hit `if (!c) continue`, and were **silently
 *          dropped**. Four active measures rendered as "held for future expansion" and their
 *          evidence never reached the display.
 *
 * ## Why a static parity test rather than a rendering test
 *
 * The defect is not a rendering bug and would not have been caught by one. It is a private
 * copy of a governed artifact drifting from the artifact — the same shape as DEV-P1-31,
 * where the record schema and the recognizer disagreed about the identity grammar. That
 * class of defect is invisible until something reads across the boundary, and by then the
 * symptom looks like missing data rather than like a stale copy.
 *
 * The browser file cannot be executed here, so this asserts what can be asserted from Node:
 * the list's ids, order and family assignment against `METRIC_COORDINATES`. That is exactly
 * the invariant that was broken. It does not prove the dashboard renders the four cells
 * correctly — nothing in this repository can — and the delivery note says so rather than
 * letting a green test imply it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import {
  CANONICAL_GRID_SIZE,
  METRIC_COORDINATES,
} from '../src/shared/measurementCoordinates.js';

/** Locates the authored dashboard client; tests run compiled from `dist/`. */
function appSource(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'ui', 'clue-dashboard', 'app.js');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error('ui/clue-dashboard/app.js could not be located from the test');
}

/**
 * The measurement ids the client's grid list declares, in declaration order.
 *
 * Parsed rather than imported: `app.js` is a browser module with top-level DOM imports and
 * cannot be loaded under Node. Reading the source is the honest way to check a constant that
 * only exists there — and the constant being checkable at all is the point.
 */
function declaredIds(source: string): readonly string[] {
  const start = source.indexOf('const M=[');
  const marker = start === -1 ? source.indexOf('const M = [') : start;
  assert.notEqual(marker, -1, 'the client declares its grid list as `const M`');
  const end = source.indexOf('\n  ];', marker);
  assert.notEqual(end, -1, 'the grid list is terminated');
  const block = source.slice(marker, end);
  // Each row is ["<id>", <legacy>, "<name>"]; take the first quoted field of each.
  return [...block.matchAll(/\[\s*"([A-Z0-9-]+)"\s*,/g)].map((match) => match[1] ?? '');
}

test('DEV-P1-16: the dashboard grid list matches the canonical coordinate map exactly', () => {
  const ids = declaredIds(appSource());
  const canonical = [...METRIC_COORDINATES]
    .sort((left, right) => left.gridIndex - right.gridIndex)
    .map((coordinate) => coordinate.measurementId);

  assert.equal(ids.length, CANONICAL_GRID_SIZE, 'the client declares one entry per grid cell');
  assert.deepEqual(
    ids,
    canonical,
    'the client list and the canonical map must name the same measures in the same grid order',
  );
});

test('DEV-P1-16: the four v6 activations are present and are not reserved placeholders', () => {
  // The exact regression. `modelFromView` looks server cells up by id in this list, so an
  // absent id is a silently dropped measure — not a rendering fault, a data loss.
  const source = appSource();
  const ids = new Set(declaredIds(source));
  for (const id of ['MH03', 'MG08', 'MI12', 'MK19']) {
    assert.ok(ids.has(id), `${id} must be resolvable, or its cell's evidence is dropped`);
  }
  assert.doesNotMatch(
    source,
    /"RESERVED-(97|98|99|100)"/,
    'v3 reserved placeholders must not remain in the grid list',
  );
});

test('DEV-P1-16: the client agrees with the backend on every cell family', () => {
  // Families are contiguous for cells 1-96 and are not for 97-100 — MH03 and MG08 are
  // TARGET_QUALITY, MI12 is EVIDENCE_ASSURANCE, MK19 is CLUE_SELF. A pure range function
  // cannot express that, which is why the client carries explicit exceptions, and why they
  // have to be checked against the map rather than trusted.
  const source = appSource();
  const overrides = source.match(/const FAMILY_97_100 = \{([^}]*)\}/);
  assert.notEqual(overrides, null, 'the client names its non-contiguous family exceptions');

  const declared = new Map<number, string>();
  for (const entry of (overrides?.[1] ?? '').matchAll(/(\d+):\s*"([A-Z_]+)"/g)) {
    declared.set(Number(entry[1]), entry[2] ?? '');
  }

  for (const coordinate of METRIC_COORDINATES) {
    if (coordinate.gridIndex <= 96) continue;
    assert.equal(
      declared.get(coordinate.gridIndex),
      coordinate.family,
      `cell ${String(coordinate.gridIndex)} (${coordinate.measurementId}) must carry its canonical family`,
    );
  }
});
