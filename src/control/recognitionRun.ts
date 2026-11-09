/**
 * The recognition run — one service seam for the CLI and the cycle orchestrator
 * (DEV-P2-08 S4a; extracted 2026-08-10 from `recognizeCommands.ts`).
 *
 * Spec: `CLUE_Project_Directory_v9.md` §11.3 — `recognizer.ts` coordinates adapters over an
 *       exact immutable basis, `scanCache.ts` decides safe incremental reuse, `graph.ts`
 *       owns the durable projections, `navigatorEvents.ts` owns the Q1 stream. This module
 *       is their **coordinator**, and coordination is control-plane (§8) — which is why the
 *       extraction landed here rather than beside them.
 *
 * Behaviour is moved, not changed. Everything below — the DEV-P0-03 capture-parity binding,
 * DEV-P0-04's incremental merge with its full-scan oracle, §24.3's commit-then-seal
 * ordering, DEV-P1-06's seal-before-pointer rule, retention, and the Operational Console
 * mirroring — is the command body verbatim, with exactly four mechanical seams: the
 * navigator path arrives resolved (the CLI keeps its flag conventions), early refusals
 * throw instead of printing, the one mid-run operator notice is returned rather than
 * written, and the outcome is returned rather than printed. The command's own header
 * documented the two load-bearing orderings; they are preserved untouched and the
 * documentation travels with the code that carries them.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Runtime } from './runtime.js';
import { resolveProjectRecognition } from './projectProfiles/projectRecognition.js';
import { recognize, type RecognitionResult } from '../analysis/source/recognizer.js';
import type { RecordResult } from '../analysis/source/graph.js';
import {
  NavigatorEventWriter,
  NavigatorStreamError,
  pruneRunStreams,
  sealRunStream,
  writeGraphPointer,
} from '../analysis/source/navigatorEvents.js';
import { diffSnapshots } from '../analysis/source/snapshot.js';
import {
  captureRepositoryInventory,
  enrichRepositoryInventory,
  readRepositoryInventoryPointer,
  writeRepositoryInventoryPointer,
} from '../analysis/source/repositoryInventory.js';
import {
  mergeIncrementalResult,
  incrementalMatchesOracle,
  type IncrementalMerge,
} from '../analysis/source/scanCache.js';
import { OperationalConsoleRuntime } from '../observability/operationalConsole/runtime.js';
import { hashCanonicalJson, hashText } from '../shared/ids.js';
import { short } from '../cli/output/formatter.js';
import type { ProjectRecognitionIdentity } from '../shared/projectRecognitionIdentity.js';

/** Structural twin of the CLI's Check rows; the CLI spreads these into `printChecks`. */
export interface RunCheck {
  readonly level: 'ok' | 'warn' | 'info';
  readonly label: string;
  readonly detail: string;
}

export interface RecognitionRunOptions {
  /** Force a full rescan instead of consulting the scan cache. */
  readonly force: boolean;
  /** Resolved Navigator stream path, or null when the stream is off. */
  readonly navigatorPath: string | null;
  /** True only for the first recognition run explicitly requested by a profile activation. */
  readonly activated?: boolean;
}

export interface RecognitionRunOutcome {
  readonly snapshotId: string;
  readonly captureId: string;
  readonly runId: string;
  readonly recorded: RecordResult;
  readonly result: RecognitionResult;
  readonly languageCensus: Readonly<Record<string, number>>;
  readonly plan: {
    readonly fullRescan: boolean;
    readonly fullRescanReason: string | null;
    readonly extractedCount: number;
    readonly carriedCount: number;
  };
  readonly navigatorChecks: readonly RunCheck[];
  readonly navigatorPath: string | null;
  /** Mid-run operator notices, in occurrence order (e.g. the oracle-divergence fallback). */
  readonly notices: readonly string[];
  /** Exact profile/config generation that governed this run; null on the legacy startup path. */
  readonly projectRecognition: ProjectRecognitionIdentity | null;
}

/**
 * How many sealed per-run streams a workspace keeps, and the byte budget above which the
 * oldest are dropped first. The run named by `current.json` is always retained regardless.
 * These are the defaults; the numbers are a workspace-hygiene policy, not a truth claim —
 * a sealed stream is a replay convenience, and the durable graph record is the authority.
 */
const NAVIGATOR_STREAM_RETENTION = { keep: 8, maxBytes: 256 * 1024 * 1024 } as const;

/**
 * The hash of the dependency lockfile that governs the target's installed packages, or undefined
 * when the target vendors none. Binding it into the recognition basis makes a dependency change —
 * which can change resolved types, and therefore recognition — visible in the result's identity.
 */
function recognitionLockfileHash(projectRoot: string): string | undefined {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const path = join(projectRoot, name);
    if (existsSync(path)) return hashText(readFileSync(path, 'utf8'));
  }
  return undefined;
}

/** Runs one complete recognition against the registered target. See the header. */
export function runRecognition(
  runtime: Runtime,
  options: RecognitionRunOptions,
): RecognitionRunOutcome {
  const notices: string[] = [];
    // Quadrant 4 write-side: mirror this real operation into the Operational Console
    // stream. Recognition is the single writer of that stream while it runs; recording
    // is best-effort — telemetry must never break a recognition.
    let opconsole: OperationalConsoleRuntime | null = null;
    const opconsoleRecord = (input: {
      title: string;
      what: string;
      why: string;
      status: 'running' | 'ok' | 'failed';
      cinematicCue: 'transmit' | 'status_seal' | 'error_fracture';
      currentWork?: import('../observability/operationalConsole/contract.js').CurrentWorkContract;
    }): void => {
      try {
        opconsole ??= new OperationalConsoleRuntime({ workspaceRoot: runtime.workspaceRoot });
        opconsole.recorder.recordState({ channel: 'RECOGNITION', ...input });
      } catch {
        /* best-effort */
      }
    };
    opconsoleRecord({
      title: 'recognition started',
      what: 'recognition run',
      why: 'operator started a recognition run',
      status: 'running',
      cinematicCue: 'transmit',
      currentWork: {
        targetId: runtime.config.project.id,
        targetLabel: runtime.config.project.root,
        metricId: null,
        metricLabel: null,
        what: 'recognize the registered target (full static recognition)',
        why: 'operator-initiated recognition run',
        howProven: 'durable graph commit with pointer/result-hash parity',
        whoOrModel: 'deterministic static recognizer (TypeScript compiler); no LLM',
        currentStatus: 'scanning source and streaming discovery',
        next: 'commit the durable graph and write the run pointer',
        proofContractHash: null,
        taskId: null,
        logicalSessionId: null,
        updatedAt: new Date().toISOString(),
      },
    });
    const graph = runtime.requireGraph();
    const snapshots = runtime.snapshots;
    const cache = runtime.scanCache;
    if (snapshots === null || cache === null) {
      throw new Error('Snapshot or scan-cache registry unavailable.');
    }

    const recognition = resolveProjectRecognition(runtime);
    const targetRoot = recognition.targetRoot;
    const tsconfigPath = recognition.buildConfigPath;
    const sourceRoots = recognition.sourceRoots;
    const excludedPaths = recognition.excludedPaths;
    const projectRecognition = recognition.projectRecognitionIdentity ?? undefined;
    if (recognition.unsupportedAdapters.length > 0) {
      notices.push(
        `recognition adapters not available in this runtime were ignored: ${recognition.unsupportedAdapters.join(', ')}`,
      );
    }

    const previous = snapshots.latest('canonical');
    const previousManifest = previous === null ? null : snapshots.manifestOf(previous.id);

    const captured = snapshots.capture({
      root: targetRoot,
      sourceRoots,
      exclude: excludedPaths,
      origin: 'canonical',
      ...(projectRecognition === undefined ? {} : { projectRecognition }),
    });
    const snapshotId = captured.record.id;
    // DEV-P0-03: the recognition basis must bind the exact capture it assesses and the toolchain that
    // produced it, so a stored result proves which durable bytes and dependencies it drew conclusions
    // from — not merely that it described *some* live program.
    const captureId = captured.captureId;
    const lockfileHash = recognitionLockfileHash(targetRoot);

    // DEV-P0-03: bind the exact captured bytes into recognition. Passing the snapshot's file hashes makes
    // the recognizer re-hash every compiled file and refuse (RecognitionParityError) unless the program
    // equals the immutable snapshot — so the stored basis records snapshotParityVerified: true and PROVES
    // which durable bytes it drew conclusions from, rather than merely naming a snapshot id (§5.2).
    const snapshotFiles = new Map(captured.manifest.files.map((file) => [file.path, file.hash] as const));

    const navigatorPath = options.navigatorPath;
    // Q1 SURF owns a complete physical repository capture, independent from the
    // recognition snapshot's configured source roots. The prior pointer supplies only
    // added/modified/removed lifecycle context; it is never a second file authority.
    const repositoryInventory = navigatorPath === null
      ? null
      : captureRepositoryInventory({
          root: targetRoot,
          repositoryId: runtime.config.project.id,
          projectName: runtime.config.project.name ?? runtime.config.project.id,
          recognitionSourceRoots: sourceRoots,
          recognitionSnapshotId: snapshotId,
          exclude: excludedPaths,
          ...(projectRecognition === undefined ? {} : { projectRecognition }),
          previous: readRepositoryInventoryPointer(navigatorPath, projectRecognition),
        });
    // DEV-P1-06: what the stream actually did is reported, not assumed. A degraded or
    // unsealed stream appears in the command's own output instead of being swallowed.
    const navigatorChecks: { level: 'ok' | 'warn' | 'info'; label: string; detail: string }[] = [];
    // One identity for this recognition run, distinct from the snapshot (which may be
    // scanned many times). It names the per-run immutable stream and the commit pointer.
    const runId = randomUUID();
    const navigatorWriter = navigatorPath === null
      ? null
      : new NavigatorEventWriter({
          path: navigatorPath,
          projectName: runtime.config.project.name ?? runtime.config.project.id,
          snapshotId,
          captureId,
          runId,
          inventory: repositoryInventory,
          projectRecognition: projectRecognition ?? null,
          // Completion stays provisional until the graph is durably recorded below.
          awaitCommit: true,
          cinematic: true,
        });

    // The physical inventory is complete before recognition begins. Its sequence is
    // reset → started → taxonomy → files → completed → recognition.started.
    navigatorWriter?.publishRepositoryInventory();

    // A full program is always built; only extraction is ever restricted. Resolution
    // needs the whole graph, and a partial program resolves differently. The full probe
    // is also the Navigator's live structural stream, so even an incremental database
    // projection gives the operator a complete visual map.
    let probe: RecognitionResult;
    try {
      probe = recognize({
        projectRoot: targetRoot,
        tsconfigPath,
        exclude: excludedPaths,
        snapshotId,
        captureId,
        snapshotFiles,
        ...(lockfileHash !== undefined ? { lockfileHash } : {}),
        ...(projectRecognition === undefined ? {} : { projectRecognition }),
        ...(navigatorWriter === null ? {} : { observer: navigatorWriter }),
      });
    } catch (error) {
      navigatorWriter?.fail(error);
      throw error;
    }

    // An unchanged recapture has the same content identity, but it is still a valid cache base.
    // Passing the previous manifest preserves the distinction between an ordinary unchanged run
    // and a profile activation whose policy explicitly requests a full scan. Treating equal IDs as
    // “no previous recognition” made `fullScanOnActivation` ineffective and forced needless work.
    const diff = diffSnapshots(previousManifest, captured.manifest);

    const plan = cache.plan(diff, {
      compilerOptionsHash: probe.compilerOptionsHash,
      currentBasis: probe.basis,
      ...(projectRecognition === undefined ? {} : { projectRecognition }),
      ...(
        options.force ||
        (options.activated === true && recognition.policy.fullScanOnActivation) ||
        !recognition.policy.reuseUnchangedSnapshot
          ? { force: true }
          : {}
      ),
    });

    let result = probe;
    let incrementalMerge: IncrementalMerge | null = null;
    const base = plan.fromSnapshot;

    if (
      !plan.fullRescan &&
      base !== null &&
      plan.extractionSurface.length === 0 &&
      plan.droppedFiles.length === 0
    ) {
      // Nothing changed. The full probe already binds this capture receipt and is the oracle, so
      // record it directly. Manufacturing a self-merge (fromSnapshot === toSnapshot) would retain
      // no performance benefit and would make merge provenance claim a change that did not occur.
      result = probe;
    } else if (!plan.fullRescan && base !== null) {
      // Merge the refreshed surface onto the previous complete result, then compare it to the
      // full scan. A subsequent projection rebuild must restore the complete graph.
      let previous: ReturnType<typeof graph.resultOf> = null;
      let previousRecognition: ReturnType<typeof graph.recognition> = null;
      try {
        previous = graph.resultOf(base, projectRecognition);
        previousRecognition = graph.recognition(base);
      } catch {
        notices.push('the previous recognition could not be verified; recording the complete full scan.');
      }
      if (previous !== null && previousRecognition !== null) {
        // The full probe already contains the freshly extracted surface, so both branches
        // use the same compiler inputs and the target is compiled only once.
        incrementalMerge = mergeIncrementalResult({
          plan,
          fresh: probe,
          previous,
          previousResultHash: previousRecognition.result_hash,
        });
        result = incrementalMerge.result;
      }
    }

    // DEV-P0-04 full-oracle parity gate (§5.3): the incremental merge is an optimisation; the full probe
    // (always built above) is the oracle. If the merged graph diverges from it, some file's resolution
    // moved in a way the rescan surface did not capture — an added module shadowing a directory index,
    // say — and the merged result carries a stale edge whose endpoints both exist, invisible to endpoint
    // validation. Trust the oracle: record the full probe and drop the (now inapplicable) merge provenance.
    if (incrementalMerge !== null && !incrementalMatchesOracle(incrementalMerge, probe)) {
      notices.push(
        'incremental recognition diverged from the full-scan oracle; recording the full scan instead ' +
          '(a resolution change the rescan surface did not capture).',
      );
      result = probe;
      incrementalMerge = null;
    }

    // Physical membership/classification is already on the stream. The final recognition
    // result may now enrich those exact identities and publish aggregate file dependencies;
    // it is never allowed to add or reclassify a physical file.
    if (navigatorWriter !== null && repositoryInventory !== null) {
      navigatorWriter.publishRepositoryEnrichment(
        enrichRepositoryInventory(repositoryInventory, result),
      );
    }

    // §24.3 / critique P0: telemetry follows persistence. Signal the commit, persist the
    // graph, and only then seal the stream as committed. If persistence throws, the run is
    // failed (never left showing provisional completion), and the error is redacted.
    navigatorWriter?.graphCommitting();
    let recorded: RecordResult;
    try {
      // Always record the complete result and classify the whole graph, so the persisted artifact
      // and the live projection match what a rehydration recomputes from the artifact alone. When the
      // run was incremental, its merge provenance is embedded in the complete artifact.
      recorded = graph.record(snapshotId, result, {
        complete: true,
        ...(incrementalMerge !== null
          ? {
              merge: {
                previousResultHash: incrementalMerge.previousResultHash,
                mergeVersion: incrementalMerge.mergeVersion,
                carriedCount: incrementalMerge.carriedModules.length,
                extractedCount: incrementalMerge.extractedModules.length,
                droppedCount: incrementalMerge.droppedModules.length,
              },
            }
          : {}),
      });
    } catch (error) {
      navigatorWriter?.fail(error);
      throw error;
    }

    if (incrementalMerge !== null && base !== null) {
      // Durable provenance of the incremental run: base result hash, merge algorithm version, and
      // the carried / re-extracted / dropped file counts.
      cache.recordMerge(base, snapshotId, incrementalMerge);
    }

    if (navigatorWriter !== null && navigatorPath !== null) {
      // The graph fingerprint proves which persisted graph this stream corresponds to;
      // replaying the sealed stream must reproduce this exact record (critique acceptance).
      const graphSha256 = hashCanonicalJson({
        snapshotId,
        resultHash: recorded.record.result_hash,
        unitCount: recorded.record.unit_count,
        edgeCount: recorded.record.edge_count,
        unresolvedCount: recorded.record.unresolved_count,
      });
      const streamReceipt = navigatorWriter.graphCommitted({
        // No record identity distinct from (snapshot id, content hash) exists in the
        // durable schema yet; null declares that (P0.3). The snapshot id already travels
        // on every envelope — copying it here only manufactured a second identity.
        recognitionRecordId: null,
        graphSha256,
        resultHash: recorded.record.result_hash,
        unitCount: recorded.record.unit_count,
        edgeCount: recorded.record.edge_count,
        unresolvedCount: recorded.record.unresolved_count,
      });
      if (repositoryInventory !== null) {
        writeRepositoryInventoryPointer(navigatorPath, repositoryInventory);
      }
      // DEV-P1-06: preserve the sealed stream as the immutable per-run record. The seal
      // verifies the bytes on disk against the writer's own hash and places the record
      // without ever replacing one, so a failed seal is reported rather than producing a
      // truncated file that reads as complete. A seal failure does not fail the
      // recognition — the graph is already durable — but it is never silent either.
      let sealedStream: string | null = null;
      let sealError: string | null = null;
      if (!streamReceipt.degraded) {
        try {
          sealedStream = sealRunStream(navigatorPath, streamReceipt).path;
        } catch (error) {
          sealError = error instanceof NavigatorStreamError ? error.message : String(error);
        }
      } else {
        sealError = `stream degraded after ${streamReceipt.eventCount} event(s): ` +
          `${streamReceipt.lastError ?? 'unknown write failure'}`;
      }
      opconsoleRecord({
        title: 'graph committed',
        what: `units=${recorded.record.unit_count} edges=${recorded.record.edge_count} unresolved=${recorded.record.unresolved_count}`,
        why: 'recognition completed and the graph is durable',
        status: 'ok',
        cinematicCue: 'status_seal',
        currentWork: {
          targetId: runtime.config.project.id,
          targetLabel: runtime.config.project.root,
          metricId: null,
          metricLabel: null,
          what: `recognized ${recorded.record.unit_count} units, ${recorded.record.edge_count} edges`,
          why: 'recognition run completed',
          howProven: 'durable graph record committed; pointer carries result-hash parity',
          whoOrModel: 'deterministic static recognizer (TypeScript compiler); no LLM',
          currentStatus: 'graph committed and sealed',
          next: 'idle — awaiting operator',
          proofContractHash: null,
          taskId: null,
          logicalSessionId: null,
          updatedAt: new Date().toISOString(),
        },
      });
      (opconsole as OperationalConsoleRuntime | null)?.close();
      try {
        writeGraphPointer(navigatorPath, {
          runId,
          snapshotId,
          // The parity anchor: the committed record's own durable identity. The console's
          // reader refuses to attribute this run to any graph whose result_hash differs —
          // a stale pointer must never claim a newer commit. `graphSha256` is the graph
          // record's fingerprint; `streamSha256` is the stream's own, and they are now
          // named for what they actually are.
          resultHash: recorded.record.result_hash,
          graphSha256,
          committedAt: new Date().toISOString(),
          // Only a stream that was actually sealed is named. A pointer must not reference
          // a file that a failed seal never created.
          stream: sealedStream === null ? null : `streams/${runId}.ndjson`,
          streamSha256: sealedStream === null ? null : streamReceipt.sha256,
          streamBytes: sealedStream === null ? null : streamReceipt.bytesWritten,
          streamEventCount: sealedStream === null ? null : streamReceipt.eventCount,
          degraded: streamReceipt.degraded,
          unitCount: recorded.record.unit_count,
          edgeCount: recorded.record.edge_count,
          unresolvedCount: recorded.record.unresolved_count,
          ...(sealedStream !== null && streamReceipt.physicalInventory !== undefined
            ? { physicalInventory: streamReceipt.physicalInventory }
            : {}),
          ...(projectRecognition === undefined ? {} : { projectRecognition }),
        });
      } catch (error) {
        sealError ??= error instanceof NavigatorStreamError ? error.message : String(error);
      }
      // Bounded retention (§22). Runs after the pointer is written, so the run just
      // committed is protected by the pointer it now owns.
      let pruned = 0;
      let reclaimed = 0;
      try {
        const retention = pruneRunStreams(navigatorPath, NAVIGATOR_STREAM_RETENTION);
        pruned = retention.removed.length;
        reclaimed = retention.bytesReclaimed;
      } catch {
        /* retention is workspace hygiene; its failure never invalidates a durable graph */
      }
      navigatorChecks.push(
        sealError === null
          ? {
              level: 'ok',
              label: 'navigator stream',
              detail:
                `${streamReceipt.eventCount} events, ${streamReceipt.bytesWritten} bytes, ` +
                `sha256 ${short(streamReceipt.sha256)}`,
            }
          : { level: 'warn', label: 'navigator stream', detail: sealError },
      );
      if (pruned > 0) {
        navigatorChecks.push({
          level: 'info',
          label: 'stream retention',
          detail: `${pruned} sealed stream(s) removed, ${Math.round(reclaimed / 1048576)} MB reclaimed`,
        });
      }
    }

    return {
      snapshotId,
      captureId,
      runId,
      recorded,
      result,
      languageCensus: captured.manifest.stats.by_language,
      plan: {
        fullRescan: plan.fullRescan,
        fullRescanReason: plan.fullRescanReason,
        extractedCount: plan.extractionSurface.length,
        carriedCount: plan.carriedFiles.length,
      },
      navigatorChecks,
      navigatorPath,
      notices,
      projectRecognition: recognition.projectRecognitionIdentity,
    };
}
