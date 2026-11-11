/**
 * Console state service.
 *
 * Spec: CLUE_Recommended_Next_Milestone_v4.md §3 (Workstream B — one authoritative daemon-side
 *       state collector feeding the projector, published through the read-only transport).
 *       Doctrine: CLUE_v4 — the interface becomes authoritative when one path maps durable state
 *       into a sealed snapshot; Dashboard, Navigator, status export, and diagnostics all consume
 *       the same published revision.
 *
 * This service owns the read-side flow end to end: it reads durable state through
 * {@link RuntimeRegistrySource}, shapes it with {@link collectProjectorInput}, seals and
 * validates it with {@link projectConsoleSnapshot}, and hands the result to a publisher (the
 * read-only daemon). It is the one place the three read-side pieces are composed.
 *
 * It is typed, so the composition is fully typecheck-covered; and it depends on a
 * {@link SnapshotPublisher} interface rather than importing the daemon directly, so it is
 * testable without a running server (a test passes a capturing fake; the real `ConsoleDaemon`
 * satisfies the interface structurally through its `publish` method). The projector, collector,
 * and reader all remain what they were — this service adds composition and a readiness
 * evaluation, no new assembly.
 *
 * Determinism carries through: because the collector and projector are deterministic given the
 * same durable state and the same captured-at, two refreshes over unchanged state produce the
 * same sealed snapshot, and the publisher advances its revision only when the seal changes. A
 * refresh after a real state change publishes exactly one new revision.
 *
 * Readiness note (honest scope): a full configuration-readiness evaluator (per-integration
 * health across Chrome, PowerShell, IDE, AI providers, testing, storage, safety) is later
 * milestone work. This service evaluates only what is durably knowable now — whether the
 * project repository is configured and a snapshot exists — and reports the remaining sections
 * as not-yet-ready with a plain reason, rather than asserting readiness it cannot substantiate.
 */

import { collectProjectorInput } from './consoleStateCollector.js';
import { RuntimeRegistrySource } from './runtimeRegistrySource.js';
import { projectConsoleSnapshot } from '../ui/consoleProjector.js';
import { projectStatusFromRuntime } from '../status/statusFromRuntime.js';
import { CONFIG_SECTIONS, type ConfigSection, type ConsoleSnapshot, type ConsoleTab, type ReadinessSummary, type SectionReadiness } from '../ui/viewModel.js';
import type { Runtime } from '../control/runtime.js';

/** The read-only sink this service publishes to. `ConsoleDaemon` satisfies it structurally. */
export interface SnapshotPublisher {
  /** Publishes a sealed snapshot; returns the revision now current. */
  publish(snapshot: ConsoleSnapshot): number;
}

export interface ConsoleStateServiceOptions {
  /** The operator identity for display. */
  readonly operator: string;
  /** Which tab the console shows by default. */
  readonly activeTab?: ConsoleTab;
  /** Display title for the mission; falls back to the config project id. */
  readonly missionTitle?: string;
  /** Absolute path to the navigator live stream, used to locate current.json. */
  readonly navigatorPath?: string;
  /**
   * A clock returning the capture timestamp. Injected so tests are deterministic; defaults to
   * the wall clock. The value is the snapshot's `capturedAt` — the only non-durable input.
   */
  readonly now?: () => string;
}

/**
 * Composes the read side and publishes sealed snapshots built from live durable state.
 */
export class ConsoleStateService {
  readonly #runtime: Runtime;
  readonly #publisher: SnapshotPublisher;
  readonly #options: Required<Pick<ConsoleStateServiceOptions, 'operator' | 'activeTab'>> &
    Omit<ConsoleStateServiceOptions, 'operator' | 'activeTab'>;

  public constructor(runtime: Runtime, publisher: SnapshotPublisher, options: ConsoleStateServiceOptions) {
    this.#runtime = runtime;
    this.#publisher = publisher;
    this.#options = {
      operator: options.operator,
      activeTab: options.activeTab ?? 'dashboard',
      ...(options.missionTitle !== undefined ? { missionTitle: options.missionTitle } : {}),
      ...(options.navigatorPath !== undefined ? { navigatorPath: options.navigatorPath } : {}),
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  /**
   * Builds one sealed snapshot from current durable state and publishes it. Returns both the
   * snapshot and the revision the publisher reports. Idempotent over unchanged state: a second
   * refresh with no state change publishes the same seal, and the publisher does not advance.
   */
  public refresh(): { snapshot: ConsoleSnapshot; revision: number } {
    const snapshot = this.capture();
    return { snapshot, revision: this.#publisher.publish(snapshot) };
  }

  /** Prepare a sealed frame without replacing the published runtime generation. */
  public capture(): ConsoleSnapshot {
    const readiness = this.#evaluateReadiness();
    const sources = this.#stateSources();
    const source = new RuntimeRegistrySource(this.#runtime, {
      readiness,
      sources,
      ...(this.#options.missionTitle !== undefined ? { missionTitle: this.#options.missionTitle } : {}),
      ...(this.#options.navigatorPath !== undefined ? { navigatorPath: this.#options.navigatorPath } : {}),
    });
    const capturedAt = (this.#options.now ?? (() => new Date().toISOString()))();

    // ADR-0002 steps 4 and 5: Status is projected first, from the same reader and the same
    // capture instant, and the console is projected downstream of it. The composition itself
    // is shared with `clue status` — step 4 filled these options with nulls here while the
    // CLI filled them properly, so one workspace produced two differently-populated Status
    // bodies depending on who asked. §1 allows exactly one.
    const status = projectStatusFromRuntime(this.#runtime, {
      capturedAt,
      source,
    }).snapshot;

    const input = collectProjectorInput(source, {
      capturedAt,
      operator: this.#options.operator,
      activeTab: this.#options.activeTab,
      status,
    });
    return projectConsoleSnapshot(input);
  }

  /**
   * Durable source identities stamped on the seal. These name the state the snapshot was built
   * from so a reader can tell whether two snapshots derive from the same durable point.
   */
  #stateSources(): readonly string[] {
    const sources: string[] = [];
    const snapshot = this.#runtime.snapshots?.latest('canonical') ?? null;
    if (snapshot !== null) sources.push(`snapshot@${snapshot.id.slice(0, 12)}`);
    const mission = this.#runtime.mission?.current() ?? null;
    if (mission !== null) sources.push(`mission@${mission.id}`);
    sources.push(this.#runtime.log === null ? 'log@unavailable' : 'log@present');
    return sources;
  }

  /**
   * Evaluates configuration readiness from what is durably knowable now. Only
   * `project_repository` and `storage_ledger` are assessed against real state; the remaining
   * sections are reported not-ready with a plain "not yet evaluated" reason rather than a
   * fabricated pass. When any required section is not ready, readiness is `blocked` and names
   * the first such section — the discriminated union makes a contradictory "ready with a
   * blocker" state impossible to construct.
   */
  #evaluateReadiness(): ReadinessSummary {
    const hasProject = this.#runtime.config.project.root.length > 0;
    const hasSnapshot = (this.#runtime.snapshots?.latest('canonical') ?? null) !== null;
    const hasLedger = this.#runtime.console !== null;

    const evaluated: ReadonlyMap<ConfigSection, boolean> = new Map([
      ['project_repository', hasProject && hasSnapshot],
      ['storage_ledger', hasLedger],
    ]);

    const sections: SectionReadiness[] = CONFIG_SECTIONS.map((section) => ({
      section,
      // A section not yet backed by a real evaluator is reported not-ready, never assumed pass.
      ready: evaluated.get(section) ?? false,
    }));

    const firstBlocking = sections.find((entry) => !entry.ready);
    if (firstBlocking === undefined) {
      return { status: 'ready', sections };
    }
    return { status: 'blocked', sections, firstBlocking: firstBlocking.section };
  }
}
