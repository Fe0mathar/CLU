/**
 * CLU-E Status — composition from a live runtime.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §1 — "The same durable state must produce the same
 *       status body. The UI, CLI, HTTP API and exported JSON consume one validated
 *       snapshot; none assembles an independent interpretation."
 *       §20 gate 4 — the UI, CLI and API return the same body/hash.
 * Directory: `CLUE_Project_Directory_v9.md` §19.2.
 *
 * Backlog: ADR-0002 step 5 — this exists because §1's rule was quietly being broken.
 *
 * ## Why this file exists
 *
 * `statusProjector.ts` is pure: it takes a `RegistrySource` and a fully-specified options
 * object and performs no I/O. That purity is what makes gate 1's determinism provable, and
 * it should stay. But a real caller has to come up with those options from somewhere, and
 * two callers were doing it separately.
 *
 * `clue status show` assembled them from the runtime — mission hash, recognizer version, the
 * catalogue loaded from disk, the Q1 pointer. `ConsoleStateService.refresh()` passed nulls
 * for all four, because it had no equivalent. The result was two Status bodies over one
 * workspace, differently populated depending on who asked: the CLI's catalogue branch backed
 * and the dashboard's unavailable, from the same durable state at the same moment.
 *
 * That is precisely the "separate manual status format" §19 prohibits, arrived at without
 * anyone writing a second format — just by two callers filling one options object
 * differently. One composition function closes it, and the closure is checkable: a third
 * caller either uses this or is visibly not using it.
 *
 * ## What it may and may not do
 *
 * It reads. It loads the catalogue through the *non-throwing* loader and reads the graph
 * pointer through the owner that writes it, and any failure of either becomes an
 * unavailable branch with its reason rather than a thrown call. A status projection that
 * refuses to produce a body because one of its inputs is unreadable would be inspection that
 * only works when nothing needs inspecting.
 *
 * It does not decide the capture instant. That stays a parameter, for the same reason it is
 * one in `statusSeal.ts`: §15's determinism rule requires the same durable inputs *and
 * declared timestamp* to reproduce the same seal, and a function that read the clock could
 * not satisfy it.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assessCatalogueReadiness,
  tryLoadMeasurementCatalogue,
} from '../analysis/measure/catalogue.js';
import { readCommittedInventoryParity, readGraphPointer } from '../analysis/source/navigatorEvents.js';
import { RECOGNIZER_VERSION } from '../analysis/source/recognizer.js';
import { RuntimeRegistrySource } from '../daemon/runtimeRegistrySource.js';
import type { RegistrySource } from '../daemon/consoleStateCollector.js';
import type { ReadinessSummary } from '../ui/viewModel.js';
import type { Runtime } from '../control/runtime.js';
import type { ProjectReadinessAssessment } from '../control/projectProfiles/projectReadiness.js';
import { projectStatus, type CatalogueFacts, type ProjectionReport } from './statusProjector.js';
import type { MissionVersion } from '../shared/schemas.js';

/**
 * The hash of everything the mission version binds — `DEV-P1-50`.
 *
 * `TargetBranch` declares `missionBasisHash` and `constitutionHash` as two fields, and both were
 * filled from `mission.constitution_hash`: the hash of one file. Two missions binding different
 * documents therefore reported the same basis, and on this tree that is not hypothetical —
 * versions 2 through 6 share one constitution and differ only in documents the field could not
 * see. `DEV-P1-49` made an edited `target description.md` register a successor mission; this is
 * what makes that successor distinguishable once it exists.
 *
 * It matters because `statusSeal.ts` binds `missionHash` from this field. A seal that cannot tell
 * two missions apart cannot support §4.2.7 — no accepted change confused with a different commit,
 * tree, benchmark, environment or proof contract — and §4.2.4's "no verdict depends on an
 * unversioned input" is only true if the versioning covers the whole input set.
 *
 * Derived rather than stored: the mission record already carries its documents, so this is a
 * projection of a durable record and not a second authority for it. Paths are sorted so the hash
 * describes the set rather than the order it happened to be read in, and both path and hash go in
 * — hashing only the content hashes would make a renamed document invisible.
 */
function missionBasisHashOf(mission: MissionVersion | null): string | null {
  if (mission === null) return null;
  const canonical = [...mission.documents]
    .map((document) => `${document.path}\u0000${document.hash}`)
    .sort()
    .join('\u0001');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The catalogue in force, or null when it cannot be loaded.
 *
 * Every failure path returns null rather than throwing, and the projector turns that into an
 * unavailable branch naming the file. A catalogue that cannot govern a run must not also
 * prevent the operator from seeing why it cannot.
 */
export function catalogueFactsFor(repoRoot: string): CatalogueFacts | null {
  try {
    const yamlPath = join(repoRoot, 'config', 'measurements', 'catalogue.yaml');
    if (!existsSync(yamlPath)) return null;
    const loaded = tryLoadMeasurementCatalogue(readFileSync(yamlPath, 'utf8'));
    // A discriminated result: a catalogue that failed validation carries issues and no
    // catalogue, and that is an unavailable branch, not a crash.
    if (!loaded.ok) return null;
    const readiness = assessCatalogueReadiness(loaded.catalogue);
    return {
      version: loaded.catalogue.identity.version,
      hash: loaded.catalogue.identity.contentHash,
      activeCount: loaded.catalogue.activeMeasureCount,
      reservedCount: loaded.catalogue.reservedGridIndicesFree.length,
      // A catalogue that loaded cleanly has unique coordinates: the loader's completeness
      // gate refuses a collision, so reaching here is the evidence.
      coordinatesUnique: true,
      productionReady: readiness.ready,
    };
  } catch {
    return null;
  }
}

export interface StatusFromRuntimeOptions {
  /** The declared capture instant. Never read from a clock here (§15). */
  readonly capturedAt: string;
  /** Configuration readiness, when the caller has evaluated it. */
  readonly readiness?: ReadinessSummary;
  /** Durable source identities to stamp on the body. */
  readonly sources?: readonly string[];
  /** Complete readiness assessment for this exact active Project Profile generation, when evaluated. */
  readonly projectReadiness?: ProjectReadinessAssessment | null;
  /** Override the reader, for tests that drive the composition without a workspace. */
  readonly source?: RegistrySource;
}

/**
 * Composes and projects the sealed Status body for a live runtime.
 *
 * The single place the projector's options are filled from a runtime. Both `clue status`
 * and `ConsoleStateService` call it, so the CLI, the dashboard and any future HTTP surface
 * describe one workspace the same way — which is what §20 gate 4 asks for and what two
 * independent option-fillings quietly prevented.
 */
export function projectStatusFromRuntime(
  runtime: Runtime,
  options: StatusFromRuntimeOptions,
): ProjectionReport {
  const source =
    options.source ??
    new RuntimeRegistrySource(runtime, {
      readiness: options.readiness ?? ({ status: 'ready', sections: [] } as ReadinessSummary),
      sources: options.sources ?? [],
      projectReadiness: options.projectReadiness ?? null,
    });

  const navigatorPath = join(runtime.workspaceRoot, 'graph', 'system-navigator.ndjson');
  const pointer = readGraphPointer(navigatorPath, runtime.projectBinding?.recognition.identity);

  return projectStatus(source, {
    capturedAt: options.capturedAt,
    targetId: runtime.config.project.id,
    targetName: runtime.config.project.name ?? null,
    canonicalRoot: runtime.config.project.root,
    targetRemote: runtime.config.project.remote,
    targetCredentialEnv: runtime.config.project.credential_env,
    targetRemoteDecision: runtime.config.project.remote_decision,
    missionBasisHash: missionBasisHashOf(runtime.mission?.current() ?? null),
    // The recognizer's own version (`clue-recognizer/4`), not the identity grammar
    // (`identity-v4`). §4 asks for the recognizer version; the two move together but they are
    // different facts, and DEV-P1-31 is a standing reminder of what conflating them costs.
    recognizerVersion: RECOGNIZER_VERSION,
    catalogue: catalogueFactsFor(runtime.repoRoot),
    q1:
      pointer === null
        ? null
        : {
            runId: pointer.runId,
            snapshotId: pointer.snapshotId,
            resultHash: pointer.resultHash,
            streamSha256: pointer.streamSha256,
            streamEventCount: pointer.streamEventCount,
            degraded: pointer.degraded,
            inventoryReconciles: readCommittedInventoryParity(navigatorPath, pointer, runtime.config.project.id),
          },
    provenance: {
      eventLogFrom: null,
      eventLogTo: null,
      projectionVersion: null,
      goldenDefinitionHash: null,
    },
  });
}
