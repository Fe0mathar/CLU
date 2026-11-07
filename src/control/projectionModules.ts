/**
 * CLUE projection module registry.
 *
 * Architecture: CLUE_Architecture_v8.md (SQLite holds no truth — every projection rebuildable from
 *   the event log and content-addressed blobs).
 * Backlog: DEV-P0-01 — the production runtime constructs its projection store from *registered
 *   modules*, not a bare projector map. Each module owns its schema, its projectors, and — for the
 *   surfaces whose rows come from an artifact rather than from an event — a rehydrate hook, so a full
 *   `ProjectionStore.rebuild()` restores every table, not only the ones a projector can replay.
 *
 * Why a rehydrate hook, and why deferred. A projector receives `(db, record)` and nothing else. It
 * can replay an event into summary rows, but it cannot open a blob, so the bulk tables that the graph
 * and metric registries fill from their stored artifacts (units/edges, metric values/candidates) are
 * left empty by replay. `rebuild()` calls each module's `rehydrate` after replay to repopulate them.
 * The work itself already exists as `GraphRegistry.rehydrateAll()` / `MetricRegistry.rehydrateAll()`,
 * which read the summary rows replay just wrote and hydrate the bulk tables from the artifacts —
 * appending no events and triggering no sync, so it is safe to run mid-rebuild. Those registries are
 * built *after* the store (they take it as a dependency), so the module cannot hold them at
 * construction; instead it calls through a `rehydrators` holder the runtime populates once the
 * registries exist. A rebuild is only ever triggered by `sync()` after `openRuntime` has returned,
 * by which point the holder is set.
 */

import { type ProjectionModule } from '../memory/db.js';
import { CYCLE_PROJECTION } from '../cycle/cycleRegistry.js';
import { CLAIM_PROJECTORS, ensureClaimSchema } from '../analysis/documents/claimRegistry.js';
import { TEST_SEED_PROJECTORS, ensureTestSeedSchema } from '../analysis/documents/testSeeds.js';
import { SNAPSHOT_PROJECTORS, ensureSnapshotSchema } from '../analysis/source/snapshot.js';
import { GRAPH_PROJECTORS, ensureGraphSchema } from '../analysis/source/graph.js';
import { SCAN_CACHE_PROJECTORS, ensureScanCacheSchema } from '../analysis/source/scanCache.js';
import { METRIC_PROJECTORS, ensureMetricSchema } from '../analysis/metrics/registry.js';
import { CONSOLE_PROJECTORS, ensureConsoleSchema } from '../experiment/console/consoleLedger.js';
import { GREAT_BOOK_PROJECTION } from '../greatBook/greatBookProjection.js';
import { GATEWAY_PROJECTION } from '../ai/gateway/gatewayProjection.js';
import { PROOF_BOARD_PROJECTION } from '../daemon/proofBoardProjection.js';

/**
 * Late-bound rehydration for the artifact-backed surfaces. The runtime sets these to the registries'
 * `rehydrateAll` methods once the registries are constructed; an unset hook is a no-op, which is the
 * correct behaviour before any registry exists (there is nothing to rebuild yet).
 */
export interface ProjectionRehydrators {
  graph?: () => void;
  metrics?: () => void;
  /** Re-indexes snapshot_files from stored manifests; without it a rebuild leaves the index empty. */
  snapshots?: () => void;
  /** Re-indexes audit_entries from the durable audit file; without it a rebuild leaves it empty. */
  audit?: () => void;
}

/**
 * The canonical set of projection modules the production runtime installs. Every projection-owning
 * subsystem is represented exactly once; the kernel task and packet projectors are passed separately
 * as bare projectors because their schemas are owned by their own services.
 *
 * `tables` is declared so the store can assert, at construction, that `install()` actually created
 * what the module claims — a cheap check that catches a divergence long before a rebuild would trip
 * over an undiscovered table.
 */
export function buildProjectionModules(
  rehydrators: ProjectionRehydrators = {},
): readonly ProjectionModule[] {
  return [
    // DEV-P2-08 S4: the cycle stage machine's rebuildable rows (src/cycle/cycleRegistry.ts).
    CYCLE_PROJECTION,
    // P2 B6: dashboard read model over benchmark/proof events.
    PROOF_BOARD_PROJECTION,
    // P2-12: ACCEPT proof verdicts project immutable Great Book entries.
    GREAT_BOOK_PROJECTION,
    GATEWAY_PROJECTION,
    {
      name: 'documents',
      install: ensureClaimSchema,
      projectors: CLAIM_PROJECTORS,
      tables: ['documents', 'claims', 'conflicts', 'missing_sources'],
    },
    {
      name: 'test-seeds',
      install: ensureTestSeedSchema,
      projectors: TEST_SEED_PROJECTORS,
      tables: ['test_seeds', 'seed_rejections'],
    },
    {
      name: 'snapshots',
      install: ensureSnapshotSchema,
      projectors: SNAPSHOT_PROJECTORS,
      tables: ['snapshots', 'snapshot_captures', 'snapshot_files'],
      // Replay restores the `snapshots` and `snapshot_captures` receipts; `snapshot_files` is only an
      // index over each manifest artifact and is rebuilt from those manifests here (DEV-P0-01).
      rehydrate: () => {
        rehydrators.snapshots?.();
      },
    },
    {
      name: 'graph',
      install: ensureGraphSchema,
      projectors: GRAPH_PROJECTORS,
      tables: ['recognitions', 'recognition_runs', 'unit_ids', 'units', 'graph_edges', 'unresolved_refs', 'unit_classes'],
      // Replay restores only the `recognitions` receipt; the bulk tables are rebuilt from the
      // recognition artifact here.
      rehydrate: () => {
        rehydrators.graph?.();
      },
    },
    {
      name: 'scan-cache',
      install: ensureScanCacheSchema,
      projectors: SCAN_CACHE_PROJECTORS,
      tables: ['scan_plans', 'scan_merges'],
    },
    {
      name: 'metrics',
      install: ensureMetricSchema,
      projectors: METRIC_PROJECTORS,
      tables: ['metric_sets', 'metric_values', 'rankings', 'ranked_candidates'],
      // Replay restores the metric-set and ranking receipts; the value and candidate tables are
      // rebuilt from their artifacts here.
      rehydrate: () => {
        rehydrators.metrics?.();
      },
    },
    {
      name: 'console',
      install: ensureConsoleSchema,
      projectors: CONSOLE_PROJECTORS,
      tables: [
        'console_sessions',
        'console_signatures',
        'console_sightings',
        'console_batches',
        'console_attributions',
      ],
    },
  ];
}
