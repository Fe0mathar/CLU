export const GRANULARITIES = Object.freeze([
  'project',
  'domain',
  'subsystem',
  'module',
  'file',
  'class',
  'function',
]);

export const NODE_PHASES = Object.freeze([
  'stable',
  'discovered',
  'diagnosing',
  'testing',
  'patching',
  'verified',
  'blocked',
]);

export const NAVIGATOR_EVENT_TYPES = Object.freeze([
  'navigator.reset',
  'inventory.started',
  'inventory.taxonomy',
  'files.upserted',
  'files.removed',
  'inventory.completed',
  'dependency.discovered',
  'recognition.started',
  'file.semantic-summary',
  'scan.started',
  'scan.progress',
  'unit.discovered',
  'edge.discovered',
  'reference.unresolved',
  'unit.phase',
  'unit.details',
  'scan.completed',
  'graph.replace',
  // Durable-commit pair (CLUE_Implementation_v3.md §24.3): scan.completed is provisional;
  // graph.committing marks persistence starting, and graph.committed — carrying the
  // recognition record id and graph fingerprint — is the only event that establishes the
  // recognition as committed knowledge (CLUE_v3.md Zasada 17 / A4). Mirrors the producer
  // enum in src/analysis/source/navigatorEvents.ts so consumer and producer cannot drift.
  'graph.committing',
  'graph.committed',
  // Diagnostic, not a graph event: emitted by the writer when the recognizer's observer
  // seam catches a failure (redacted). Accepted here so the stream validator does not
  // reject it; adapters route it to the HUD/diagnostics rather than the graph.
  'observer.error',
]);

export const DEFAULT_PHASE_COLORS = Object.freeze({
  stable: '#00a3e0',
  discovered: '#ff5500',
  diagnosing: '#ff5500',
  testing: '#ff5500',
  // Explicit lifecycle exception requested by the Creator.
  patching: '#39ff88',
  verified: '#00a3e0',
  blocked: '#ff5500',
  selected: '#f4af2d',
});

const PHASE_LABELS = Object.freeze({
  stable: 'STABLE',
  discovered: 'NEWLY DISCOVERED',
  diagnosing: 'DIAGNOSING',
  testing: 'TESTING',
  patching: 'PATCHING',
  verified: 'VERIFIED',
  blocked: 'BLOCKED',
});

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] ?? String(phase ?? 'UNKNOWN').toUpperCase();
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
}

/** Strict enough to prevent malformed stream state, deliberately tolerant in payloads. */
export function assertNavigatorEvent(input) {
  assertObject(input, 'Navigator event');
  if (input.v !== 1) throw new TypeError(`Unsupported Navigator event version: ${String(input.v)}`);
  if (!NAVIGATOR_EVENT_TYPES.includes(input.type)) {
    throw new TypeError(`Unknown Navigator event type: ${String(input.type)}`);
  }
  if (typeof input.streamId !== 'string' || input.streamId.length === 0) {
    throw new TypeError('Navigator event streamId must be a non-empty string.');
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new TypeError('Navigator event sequence must be a non-negative safe integer.');
  }
  assertObject(input.payload ?? {}, 'Navigator event payload');
  if (input.snapshotId != null && typeof input.snapshotId !== 'string') {
    throw new TypeError('Navigator event snapshotId must be a string or null.');
  }
  // runId names the recognition run (distinct from the snapshot). The producer always
  // emits it; tolerate its absence for older streams, but reject a non-string value.
  if (input.runId != null && typeof input.runId !== 'string') {
    throw new TypeError('Navigator event runId must be a string or null.');
  }

  return {
    v: 1,
    type: input.type,
    streamId: input.streamId,
    runId: input.runId ?? null,
    sequence: input.sequence,
    emittedAt: typeof input.emittedAt === 'string' ? input.emittedAt : new Date().toISOString(),
    snapshotId: input.snapshotId ?? null,
    payload: input.payload ?? {},
  };
}