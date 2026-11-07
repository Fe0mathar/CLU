/**
 * Console seal adapter — binds the System Navigator to the shared State Seal.
 *
 * Spec: CLUE_Milestone_Review_and_Forward_Plan_v3.md §5.4 (integrate the System Navigator as
 *       a Dashboard projection). Doctrine: the Navigator is one projection inside CLUE's
 *       Dashboard, not a visually separate application with its own meaning of "current".
 *
 * The Navigator receives high-volume graph events on its own stream (SseNavigatorAdapter),
 * which is correct — those records are too many to route through the snapshot. But which run
 * and snapshot is *current*, whether the graph has durably committed, and what the coverage
 * is are decided by one authority: the ConsoleSnapshot the daemon publishes. This adapter
 * subscribes to that snapshot and reconciles it against the identity of the stream the
 * Navigator is showing, so the two agree — and, crucially, so a Navigator that is displaying
 * an old or uncommitted run is visibly marked stale rather than silently shown as current.
 *
 *   **One authority for "current".** The daemon's snapshot carries the authoritative runId,
 *   snapshotId, committed graph hash, and coverage. This adapter never invents those; it
 *   reads them from the sealed snapshot and reports them, so the Navigator and the Dashboard
 *   cannot disagree about which run and snapshot is live.
 *
 *   **Staleness is explicit, never silent.** The Navigator tracks the identity of the stream
 *   it is rendering (its current runId/snapshotId, set from the events it applies). When the
 *   published snapshot names a different run or a newer snapshot, the graph on screen is no
 *   longer the current one; this adapter emits a `stale` status carrying both identities so
 *   the UI can mark it, rather than presenting an old graph as though it were live.
 *
 *   **It reads only; it never mutates.** It consumes the read-only daemon endpoint and emits
 *   status events. It applies nothing to the graph and writes nothing anywhere — the graph is
 *   still driven solely by the Navigator's own event stream.
 */

export class ConsoleSealAdapter extends EventTarget {
  /**
   * @param navigatorTarget the SystemNavigator (or an element exposing `.navigator`)
   * @param snapshotUrl     the daemon's SSE console-events endpoint
   */
  constructor(navigatorTarget, snapshotUrl = '/api/console-events', options = {}) {
    super();
    this.target = navigatorTarget;
    this.url = snapshotUrl;
    this.options = { withCredentials: options.withCredentials ?? false, ...options };
    this.source = null;
    this.connected = false;
    // The last authoritative snapshot identity the daemon published.
    this.authority = null; // { revision, runId, snapshotId, graphSha256, recognitionComplete }
  }

  connect() {
    if (this.source) return this;
    this.source = new EventSource(this.url, { withCredentials: this.options.withCredentials });
    this.source.addEventListener('open', () => {
      this.connected = true;
      this.dispatchEvent(new CustomEvent('status', { detail: { connected: true, url: this.url } }));
    });
    this.source.addEventListener('error', (event) => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('status', { detail: { connected: false, url: this.url, event } }));
    });
    this.source.addEventListener('message', (event) => this.#consume(event.data));
    return this;
  }

  disconnect() {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }

  /** The authoritative identity of the current run, or null before the first snapshot. */
  get current() {
    return this.authority;
  }

  #consume(serialized) {
    let frame;
    try {
      frame = JSON.parse(serialized);
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      return;
    }
    const snapshot = frame?.snapshot;
    const seal = frame?.seal ?? snapshot?.seal ?? null;
    if (!snapshot || !seal) return;

    // Read the authoritative identity from the sealed snapshot. These are the values the
    // Dashboard shows; the Navigator must agree with them.
    const topology = snapshot.dashboard?.recognition?.topology ?? {};
    this.authority = {
      revision: Number(frame.revision ?? 0),
      snapshotId: snapshot.dashboard?.crown?.snapshot ?? null,
      // currentTarget carries the run's snapshot on the recognition field; the run identity
      // itself travels on the graph stream, so staleness is decided on snapshot identity.
      currentTarget: topology.currentTarget ?? null,
      sealHash: seal.snapshotHash ?? null,
      // A committed graph has no unresolved-driven "hidden edges" ambiguity about durability:
      // the Dashboard only advances recognition to 100 once a record is committed.
      recognitionLane: Number(snapshot.dashboard?.progress?.recognition ?? 0),
    };

    this.#reconcile();
    this.dispatchEvent(new CustomEvent('authority', { detail: this.authority }));
  }

  /**
   * Compares the authoritative snapshot identity against the identity of the stream the
   * Navigator is showing and emits a staleness verdict. Never mutates the graph.
   */
  #reconcile() {
    const nav = this.target?.navigator ?? this.target;
    const shown = this.#shownIdentity(nav);
    const authority = this.authority;
    if (!authority) return;

    // The Navigator is stale when it is displaying a run whose snapshot differs from the
    // authoritative current snapshot. If the Navigator has not shown any run yet, it is not
    // stale — it is simply awaiting its first stream.
    const stale =
      shown.snapshotId !== null &&
      authority.snapshotId !== null &&
      shown.snapshotId !== authority.snapshotId;

    this.dispatchEvent(
      new CustomEvent('staleness', {
        detail: {
          stale,
          shownSnapshotId: shown.snapshotId,
          currentSnapshotId: authority.snapshotId,
          revision: authority.revision,
        },
      }),
    );
  }

  /** The snapshot identity the Navigator is currently rendering, read from its model state. */
  #shownIdentity(nav) {
    // The Navigator records the snapshot it began scanning on model.progress.snapshotId
    // (set by GraphModel.beginScan). Read it there first, with defensive fallbacks for any
    // alternate exposure, without assuming a single internal field.
    const model = nav?.model ?? null;
    const snapshotId =
      model?.progress?.snapshotId ??
      nav?.currentSnapshotId ??
      model?.snapshotId ??
      null;
    return { snapshotId: snapshotId ?? null };
  }
}
