/**
 * Connects the browser projection to CLUE's localhost-only Navigator event stream.
 *
 * Semantic events are applied to SystemNavigator exactly as before.  Q1 SURF physical
 * inventory events are also retained in a rebuildable adapter-side model and forwarded
 * unchanged to the custom element, so a client mounted just after the first SSE burst can
 * bootstrap from the model without inventing files from semantic nodes.
 */

const PHYSICAL_EVENT_TYPES = new Set([
  'navigator.reset',
  'inventory.started',
  'inventory.taxonomy',
  'files.upserted',
  'files.removed',
  'inventory.completed',
  'dependency.discovered',
  'recognition.started',
  'file.semantic-summary',
]);

// These semantic lifecycle events also drive the SURF phase label, but only when the
// adapter has observed a complete physical envelope for the same stream. A legacy stream
// must still reach the semantic Navigator while remaining physically unavailable.
const PHYSICAL_PHASE_EVENT_TYPES = new Set([
  'scan.completed',
  'graph.committed',
]);

function createInventoryModel() {
  return {
    streamId: null,
    runId: null,
    repositoryId: null,
    projectName: null,
    snapshotId: null,
    inventoryVersion: null,
    inventoryHash: null,
    taxonomyVersion: null,
    taxonomyHash: null,
    expectedFileCount: null,
    counts: null,
    sourceRoots: [],
    excludedNames: [],
    exclusions: [],
    familiesById: new Map(),
    environmentsById: new Map(),
    filesById: new Map(),
    fileEdges: new Map(),
    inventoryStarted: false,
    taxonomyObserved: false,
    inventoryCompleted: false,
    physicalEnvelopeComplete: false,
    requiresFreshRecognition: false,
    phase: 'AWAITING INVENTORY',
  };
}

function detailPayload(envelope) {
  return envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
}

function filesFromPayload(payload) {
  if (Array.isArray(payload?.files)) return payload.files;
  if (payload?.file && typeof payload.file === 'object') return [payload.file];
  return [];
}

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function classificationAuthority(record) {
  if (!record || typeof record !== 'object') return 0;
  const family = normalizeToken(record.familyId || 'unknown') || 'unknown';
  const environment = normalizeToken(record.environmentId || 'unknown') || 'unknown';
  const source = normalizeToken(record.classificationSource || '');
  const hasKnownClassification = family !== 'unknown' || environment !== 'unknown';
  if (source === 'backend-artifact-taxonomy' || record.classifierVersion) return 3;
  if (hasKnownClassification && source) return 2;
  if (hasKnownClassification) return 1;
  return 0;
}

function mergePhysicalFileRecord(previous, incoming) {
  if (!previous) return { ...incoming };
  const merged = { ...previous, ...incoming };
  const previousAuthority = classificationAuthority(previous);
  const incomingAuthority = classificationAuthority(incoming);
  if (previousAuthority > incomingAuthority) {
    merged.familyId = previous.familyId;
    merged.environmentId = previous.environmentId;
    merged.languageId = previous.languageId;
    merged.glyphId = previous.glyphId;
    merged.facets = Array.isArray(previous.facets) ? [...previous.facets] : previous.facets;
    merged.classificationSource = previous.classificationSource;
    merged.classificationConfidence = previous.classificationConfidence;
    merged.classificationReason = previous.classificationReason;
    merged.classifierVersion = previous.classifierVersion;
  }
  return merged;
}

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

function visibleFileCount(model) {
  let count = 0;
  for (const file of model.filesById.values()) {
    if (file?.excluded !== true) count += 1;
  }
  return count;
}

function refreshPhysicalCompleteness(model) {
  const expected = Number(model.expectedFileCount);
  model.physicalEnvelopeComplete = Boolean(
    model.inventoryStarted &&
    model.taxonomyObserved &&
    model.inventoryCompleted &&
    hasText(model.repositoryId) &&
    hasText(model.snapshotId) &&
    hasText(model.inventoryHash) &&
    hasText(model.taxonomyVersion) &&
    hasText(model.taxonomyHash) &&
    Number.isSafeInteger(expected) &&
    expected >= 0 &&
    visibleFileCount(model) === expected &&
    model.familiesById.size > 0 &&
    model.environmentsById.size > 0
  );
  return model.physicalEnvelopeComplete;
}

/** Connects the browser projection to CLUE's localhost-only Navigator event stream. */
export class SseNavigatorAdapter extends EventTarget {
  constructor(navigatorTarget, url = '/navigator/events', options = {}) {
    super();
    this.target = navigatorTarget;
    this.url = url;
    this.options = {
      withCredentials: options.withCredentials ?? false,
      ...options,
    };
    this.source = null;
    this.connected = false;
    this.received = 0;
    this.streamSequences = new Map();
    this.consumeTail = Promise.resolve();
    this.repositoryInventoryModel = createInventoryModel();
    // Compatibility alias consumed by the Q1 SURF bootstrap scan.
    this.inventory = this.repositoryInventoryModel;
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
      this.dispatchEvent(new CustomEvent('status', {
        detail: { connected: false, url: this.url, event },
      }));
    });
    this.source.addEventListener('message', (event) => {
      const serialized = event.data;
      // EventSource preserves wire order; the adapter must preserve it too. `applyEvent`
      // crosses an async custom-element readiness seam, so consuming messages independently
      // could let a later sequence reach the semantic model first and cause the model's
      // high-water mark to reject the earlier event. One promise tail makes application,
      // replay-model projection and exact-event forwarding a single ordered pipeline.
      this.consumeTail = this.consumeTail.then(() => this.#consume(serialized));
    });
    return this;
  }

  disconnect() {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }

  async #consume(serialized) {
    try {
      const envelope = JSON.parse(serialized);
      const streamId = typeof envelope?.streamId === 'string' ? envelope.streamId : '';
      const sequence = Number(envelope?.sequence);
      if (envelope?.type === 'navigator.reset' && streamId !== '' && !this.streamSequences.has(streamId)) {
        // One live/replayed recognition stream is authoritative at a time. Drop stale
        // high-water marks when a distinct stream announces its reset, bounding memory
        // without weakening reconnect deduplication for the current stream.
        this.streamSequences.clear();
      }
      const previous = this.streamSequences.get(streamId) ?? -Infinity;
      if (streamId !== '' && Number.isSafeInteger(sequence) && sequence <= previous) return;
      if (streamId !== '' && Number.isSafeInteger(sequence)) this.streamSequences.set(streamId, sequence);
      this.#projectPhysicalState(envelope);
      const target = await this.#resolveTarget();
      const accepted = await target.applyEvent(envelope);
      if (accepted) this.received += 1;

      const physicalEvent = PHYSICAL_EVENT_TYPES.has(envelope.type);
      const physicalPhaseEvent = PHYSICAL_PHASE_EVENT_TYPES.has(envelope.type);
      const forwardPhysicalPhase = physicalPhaseEvent &&
        this.repositoryInventoryModel.physicalEnvelopeComplete;

      if (physicalEvent || forwardPhysicalPhase) {
        // Forward the original versioned envelope exactly once to the custom element.
        // The dashboard listens there; suppressing the legacy generic adapter event for
        // these types prevents the same physical upsert being consumed twice.
        const eventTarget = this.target?.dispatchEvent ? this.target : this;
        eventTarget.dispatchEvent(new CustomEvent(envelope.type, {
          detail: envelope,
          bubbles: true,
          composed: true,
        }));
      } else if (!physicalPhaseEvent) {
        this.dispatchEvent(new CustomEvent('event', {
          detail: { accepted, payload: envelope, received: this.received },
        }));
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    }
  }

  #projectPhysicalState(envelope) {
    const payload = detailPayload(envelope);
    const model = this.repositoryInventoryModel;
    if (typeof envelope?.streamId === 'string') model.streamId = envelope.streamId;
    if (typeof envelope?.runId === 'string') model.runId = envelope.runId;

    if (envelope?.type === 'navigator.reset') {
      const reset = createInventoryModel();
      Object.assign(model, reset);
      model.familiesById = reset.familiesById;
      model.environmentsById = reset.environmentsById;
      model.filesById = reset.filesById;
      model.fileEdges = reset.fileEdges;
      model.streamId = typeof envelope?.streamId === 'string' ? envelope.streamId : null;
      model.runId = typeof envelope?.runId === 'string' ? envelope.runId : null;
      model.repositoryId = payload.repositoryId ?? null;
      model.projectName = payload.projectName ?? null;
      model.snapshotId = payload.snapshotId ?? envelope.snapshotId ?? null;
      model.inventoryHash = payload.inventoryHash ?? null;
      model.phase = 'INVENTORY RESET';
      return;
    }

    if (envelope?.type === 'inventory.started') {
      model.repositoryId = payload.repositoryId ?? model.repositoryId;
      model.projectName = payload.projectName ?? model.projectName;
      model.snapshotId = payload.snapshotId ?? envelope.snapshotId ?? model.snapshotId;
      model.inventoryVersion = payload.inventoryVersion ?? model.inventoryVersion;
      model.inventoryHash = payload.inventoryHash ?? model.inventoryHash;
      model.expectedFileCount = Number.isFinite(payload.expectedFileCount)
        ? payload.expectedFileCount : model.expectedFileCount;
      model.sourceRoots = Array.isArray(payload.sourceRoots) ? [...payload.sourceRoots] : model.sourceRoots;
      model.excludedNames = Array.isArray(payload.excludedNames) ? [...payload.excludedNames] : model.excludedNames;
      model.exclusions = Array.isArray(payload.exclusions) ? [...payload.exclusions] : model.exclusions;
      model.inventoryStarted = true;
      model.requiresFreshRecognition = false;
      model.phase = 'INVENTORY STREAMING';
      refreshPhysicalCompleteness(model);
      return;
    }

    if (envelope?.type === 'inventory.taxonomy') {
      model.taxonomyVersion = payload.taxonomyVersion ?? null;
      model.taxonomyHash = payload.taxonomyHash ?? null;
      model.familiesById.clear();
      model.environmentsById.clear();
      for (const family of Array.isArray(payload.families) ? payload.families : []) {
        if (typeof family?.id === 'string') model.familiesById.set(family.id, { ...family });
      }
      for (const environment of Array.isArray(payload.environments) ? payload.environments : []) {
        if (typeof environment?.id === 'string') model.environmentsById.set(environment.id, { ...environment });
      }
      model.taxonomyObserved = true;
      refreshPhysicalCompleteness(model);
      return;
    }

    if (envelope?.type === 'files.upserted') {
      for (const file of filesFromPayload(payload)) {
        const id = file?.fileLocationId;
        if (typeof id !== 'string' || id.length === 0) continue;
        model.filesById.set(id, mergePhysicalFileRecord(model.filesById.get(id), file));
      }
      refreshPhysicalCompleteness(model);
      if (model.inventoryCompleted) model.requiresFreshRecognition = !model.physicalEnvelopeComplete;
      return;
    }

    if (envelope?.type === 'files.removed') {
      // The adapter model is the current committed inventory used for late bootstrap.
      // Live clients receive the unchanged removal event and may animate it; a late client
      // must not resurrect a file that is absent from the current snapshot.
      const identities = new Set(
        Array.isArray(payload.fileLocationIds) ? payload.fileLocationIds : [],
      );
      for (const file of Array.isArray(payload.removedFiles) ? payload.removedFiles : []) {
        if (typeof file?.fileLocationId === 'string') identities.add(file.fileLocationId);
      }
      for (const id of identities) {
        if (typeof id === 'string') model.filesById.delete(id);
      }
      refreshPhysicalCompleteness(model);
      if (model.inventoryCompleted) model.requiresFreshRecognition = !model.physicalEnvelopeComplete;
      return;
    }

    if (envelope?.type === 'file.semantic-summary') {
      const id = payload.fileLocationId;
      const current = typeof id === 'string' ? model.filesById.get(id) : null;
      const sameVersion = !payload.fileVersionId || !current?.fileVersionId ||
        payload.fileVersionId === current.fileVersionId;
      if (current && sameVersion) model.filesById.set(id, { ...current, ...payload });
      refreshPhysicalCompleteness(model);
      if (model.inventoryCompleted) model.requiresFreshRecognition = !model.physicalEnvelopeComplete;
      return;
    }

    if (envelope?.type === 'inventory.completed') {
      model.repositoryId = payload.repositoryId ?? model.repositoryId;
      model.projectName = payload.projectName ?? model.projectName;
      model.snapshotId = payload.snapshotId ?? envelope.snapshotId ?? model.snapshotId;
      model.inventoryVersion = payload.inventoryVersion ?? model.inventoryVersion;
      model.inventoryHash = payload.inventoryHash ?? model.inventoryHash;
      model.taxonomyVersion = payload.taxonomyVersion ?? model.taxonomyVersion;
      model.taxonomyHash = payload.taxonomyHash ?? model.taxonomyHash;
      model.expectedFileCount = Number.isFinite(payload.fileCount)
        ? payload.fileCount : model.expectedFileCount;
      model.counts = payload.counts && typeof payload.counts === 'object'
        ? { ...payload.counts } : model.counts;
      model.inventoryCompleted = true;
      refreshPhysicalCompleteness(model);
      model.requiresFreshRecognition = !model.physicalEnvelopeComplete;
      model.phase = model.physicalEnvelopeComplete
        ? 'INVENTORY COMMITTED'
        : 'INVENTORY INCOMPLETE · RUN FRESH RECOGNITION';
      return;
    }

    if (envelope?.type === 'recognition.started') {
      model.phase = model.inventoryStarted
        ? 'RECOGNITION ENRICHING'
        : 'PHYSICAL INVENTORY UNAVAILABLE · RUN FRESH RECOGNITION';
      return;
    }

    if (envelope?.type === 'graph.committed') {
      refreshPhysicalCompleteness(model);
      model.phase = model.physicalEnvelopeComplete
        ? 'SEALED PROJECTION LIVE'
        : 'PHYSICAL INVENTORY UNAVAILABLE · RUN FRESH RECOGNITION';
      model.requiresFreshRecognition = !model.physicalEnvelopeComplete;
      return;
    }

    if (envelope?.type === 'dependency.discovered') {
      const from = payload.fromFileLocationId;
      const to = payload.toFileLocationId;
      if (typeof from === 'string' && typeof to === 'string' && from !== to) {
        const kind = payload.kind ?? 'semantic-dependency';
        const id = `${from}\u0000${to}\u0000${String(kind)}`;
        model.fileEdges.set(id, { id, ...payload });
      }
      return;
    }

    // Existing semantic edge events optionally carry physical endpoint identities.
    if (envelope?.type === 'edge.discovered') {
      const from = payload.fromFileLocationId ?? payload.fileRelation?.fromFileLocationId;
      const to = payload.toFileLocationId ?? payload.fileRelation?.toFileLocationId;
      if (typeof from === 'string' && typeof to === 'string' && from !== to) {
        const kind = payload.fileRelation?.kind ?? payload.edge?.kind ?? 'dependency';
        const id = `${from}\u0000${to}\u0000${String(kind)}`;
        model.fileEdges.set(id, {
          id,
          fromFileLocationId: from,
          toFileLocationId: to,
          kind,
          directed: payload.fileRelation?.directed !== false,
          weight: Number(payload.fileRelation?.weight ?? 1) || 1,
          confidence: payload.fileRelation?.confidence ?? payload.edge?.confidence ?? null,
        });
      }
    }
  }

  async #resolveTarget() {
    if (this.target?.ready) await this.target.ready;
    return this.target?.navigator ?? this.target;
  }
}
