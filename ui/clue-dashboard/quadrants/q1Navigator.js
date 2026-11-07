/**
 * Q1 connection state and project-generation guard.
 *
 * Panel phases describe transport availability. Project-generation decisions independently protect
 * the physical/semantic projection from a late event belonging to another active Project Profile.
 */

export const Q1_PHASES = Object.freeze(['unavailable', 'awaiting', 'connected', 'reconnecting']);

/**
 * @param {string} phase one of Q1_PHASES
 * @returns {{ state: string, label: string, streamText: string }}
 */
export function q1PanelDecision(phase) {
  switch (phase) {
    case 'connected':
      return Object.freeze({
        state: 'live',
        label: 'RECOGNITION LIVE',
        streamText: 'CLUE STREAM · CONNECTED',
      });
    case 'reconnecting':
      return Object.freeze({
        state: 'connecting',
        label: 'RECONNECTING',
        streamText: 'CLUE STREAM · RECONNECTING',
      });
    case 'awaiting':
      return Object.freeze({
        state: 'connecting',
        label: 'AWAITING RECOGNITION',
        streamText: 'AWAITING RECOGNITION',
      });
    case 'unavailable':
      return Object.freeze({
        state: 'unavailable',
        label: 'NAVIGATOR UNAVAILABLE',
        streamText: 'Q1 UNAVAILABLE',
      });
    default:
      return Object.freeze({
        state: 'unavailable',
        label: `UNKNOWN PHASE: ${String(phase)}`,
        streamText: 'Q1 UNAVAILABLE',
      });
  }
}

const PROJECT_START_TYPES = new Set([
  'navigator.reset',
  'navigator-reset',
  'inventory.reset',
  'inventory-reset',
  'reset',
  'inventory.started',
  'inventory-started',
  'inventory-start',
]);

/** @param {unknown} value */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** @param {unknown} root */
function objectCandidates(root) {
  const queue = [];
  const seen = new Set();
  const first = asObject(root);
  if (first) queue.push(first);
  while (queue.length > 0 && seen.size < 64) {
    const item = queue.shift();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    for (const value of Object.values(item)) {
      const child = asObject(value);
      if (child && !seen.has(child)) queue.push(child);
    }
  }
  return [...seen];
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const TARGET_ROOT_IDENTITY_RE = /^path:v1:[a-z0-9._-]+:[0-9a-f]{64}$/u;
const PROJECT_PROFILE_HASH_RE = /^profile:v1:[0-9a-f]{64}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

/** @param {unknown} value @param {RegExp} pattern */
function matchingText(value, pattern) {
  return typeof value === 'string' && pattern.test(value.trim()) ? value.trim() : null;
}

/** @param {unknown} candidate */
function directProjectGeneration(candidate) {
  const object = asObject(candidate);
  if (!object) return null;
  const projectId = matchingText(object.projectId, PROJECT_ID_RE);
  const targetRootIdentity = matchingText(object.targetRootIdentity, TARGET_ROOT_IDENTITY_RE);
  const projectProfileHash = matchingText(object.projectProfileHash, PROJECT_PROFILE_HASH_RE);
  const profileGeneration = Number.isSafeInteger(object.profileGeneration) && object.profileGeneration > 0
    ? object.profileGeneration
    : null;
  const recognitionConfigHash = matchingText(object.recognitionConfigHash, SHA256_RE);
  return projectId && targetRootIdentity && projectProfileHash && profileGeneration && recognitionConfigHash
    ? { projectId, targetRootIdentity, projectProfileHash, profileGeneration, recognitionConfigHash }
    : null;
}

/** @param {unknown} candidate */
function governedProjectGeneration(candidate) {
  const object = asObject(candidate);
  if (!object) return null;
  const recognition = asObject(object.projectRecognition) ??
    (object.identityVersion === 'clue-project-recognition-identity/1' ? object : null);
  if (!recognition || recognition.identityVersion !== 'clue-project-recognition-identity/1') return null;
  const operationIdentity = asObject(recognition.operationIdentity);
  if (!operationIdentity) return null;
  return directProjectGeneration({
    projectId: operationIdentity.projectId,
    targetRootIdentity: operationIdentity.targetRootIdentity,
    projectProfileHash: operationIdentity.projectProfileHash,
    profileGeneration: recognition.profileGeneration,
    recognitionConfigHash: recognition.recognitionConfigHash,
  });
}

/** @param {object[]} objects @param {string[]} names */
function metadataTextOf(objects, names) {
  for (const object of objects) {
    for (const name of names) {
      const value = object[name];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return null;
}

/**
 * Extracts the project/recognition generation carried by a Navigator envelope or payload.
 * Identity fields must come from one valid governed identity object; fields from unrelated nested
 * objects are never combined. Legacy or malformed streams return null.
 *
 * @param {unknown} input
 * @returns {null|{projectId:string,targetRootIdentity:string,projectProfileHash:string,profileGeneration:number,recognitionConfigHash:string,streamId:string|null,runId:string|null,emittedAt:string|null,emittedAtMs:number|null}}
 */
export function q1ProjectGenerationOf(input) {
  const objects = objectCandidates(input);
  let identity = null;
  for (const object of objects) {
    identity = governedProjectGeneration(object) ?? directProjectGeneration(object);
    if (identity !== null) break;
  }
  if (identity === null) return null;
  const emittedAt = metadataTextOf(objects, ['emittedAt', 'startedAt', 'capturedAt']);
  const parsedTime = emittedAt === null ? Number.NaN : Date.parse(emittedAt);
  return Object.freeze({
    ...identity,
    streamId: metadataTextOf(objects, ['streamId']),
    runId: metadataTextOf(objects, ['runId', 'recognitionRunId']),
    emittedAt,
    emittedAtMs: Number.isFinite(parsedTime) ? parsedTime : null,
  });
}

/** @param {ReturnType<typeof q1ProjectGenerationOf>} left @param {ReturnType<typeof q1ProjectGenerationOf>} right */
function sameGeneration(left, right) {
  return Boolean(
    left && right &&
    left.projectId === right.projectId &&
    left.targetRootIdentity === right.targetRootIdentity &&
    left.projectProfileHash === right.projectProfileHash &&
    left.profileGeneration === right.profileGeneration &&
    left.recognitionConfigHash === right.recognitionConfigHash,
  );
}

/** A stream boundary may replace the current stream only when its evidence timestamp is newer. */
function boundaryIsNewer(current, incoming) {
  if (!current || !incoming) return true;
  if (incoming.emittedAtMs === null) return false;
  if (current.emittedAtMs === null) return true;
  return incoming.emittedAtMs > current.emittedAtMs;
}

/**
 * Stateful fail-closed guard used by Q1's event bridge.
 *
 * The first profile-bound generation may bind directly. A *different* Project Profile generation
 * is accepted only after the runtime explicitly authorises that exact successor generation and the
 * Navigator delivers a reset/inventory-start boundary for it. Authorisation immediately suspends
 * the previous generation, so a late Project A payload cannot repopulate Q1 while Project B is
 * being activated. This is deliberately stricter than comparing timestamps: a delayed reset from
 * another project is not authority to switch the selected target.
 *
 * A new stream for the same generation may rebind on a newer boundary. Legacy events with no
 * project identity are accepted only before any profile-bound generation has been observed.
 */
export function createQ1ProjectGenerationGuard() {
  let current = null;
  let expectedNext = null;

  return Object.freeze({
    current: () => current,
    pending: () => expectedNext,
    reset: () => {
      current = null;
      expectedNext = null;
    },
    /**
     * Authorises exactly one successor Project Profile generation. The returned identity can be
     * used by the caller to clear/park its current projection before the successor stream arrives.
     *
     * @param {unknown} input
     */
    authorizeNext(input) {
      const identity = q1ProjectGenerationOf(input);
      if (identity === null) return null;
      expectedNext = identity;
      return identity;
    },
    cancelPending() {
      if (expectedNext === null) return null;
      // Activation already cleared the old projection. Re-authorise the exact current generation
      // so it may return only through a fresh reset/start boundary, never through late data.
      expectedNext = current;
      return current;
    },
    /** @param {unknown} input @param {string} eventType */
    decide(input, eventType) {
      const incoming = q1ProjectGenerationOf(input);
      const boundary = PROJECT_START_TYPES.has(String(eventType || '').toLowerCase());

      if (incoming === null) {
        return Object.freeze({
          accept: current === null && expectedNext === null,
          reason:
            current === null && expectedNext === null
              ? 'LEGACY_UNBOUND'
              : expectedNext !== null
                ? 'PROJECT_SWITCH_PENDING'
                : 'PROJECT_IDENTITY_MISSING',
          switched: false,
          requiresReset: false,
          identity: current,
        });
      }

      // Project activation is a two-phase handoff: the control plane authorises B and clears A,
      // then only B's reset/start boundary may publish the successor projection.
      if (expectedNext !== null) {
        if (!sameGeneration(expectedNext, incoming)) {
          return Object.freeze({
            accept: false,
            reason: 'PROJECT_SWITCH_PENDING',
            switched: false,
            requiresReset: false,
            identity: current,
          });
        }
        if (!boundary) {
          return Object.freeze({
            accept: false,
            reason: 'PROJECT_SWITCH_BOUNDARY_REQUIRED',
            switched: false,
            requiresReset: false,
            identity: current,
          });
        }
        const switched = current === null || !sameGeneration(current, incoming);
        current = incoming;
        expectedNext = null;
        return Object.freeze({
          accept: true,
          reason: switched ? 'PROJECT_SWITCHED' : 'PROJECT_REBOUND',
          switched,
          requiresReset: true,
          identity: current,
        });
      }

      if (current === null) {
        current = incoming;
        return Object.freeze({
          accept: true,
          reason: 'PROJECT_BOUND',
          switched: true,
          requiresReset: true,
          identity: current,
        });
      }

      if (!sameGeneration(current, incoming)) {
        return Object.freeze({
          accept: false,
          reason: boundary ? 'PROJECT_SWITCH_NOT_AUTHORIZED' : 'STALE_PROJECT_GENERATION',
          switched: false,
          requiresReset: false,
          identity: current,
        });
      }

      const streamChanged =
        current.streamId !== null &&
        incoming.streamId !== null &&
        current.streamId !== incoming.streamId;
      if (streamChanged && (!boundary || !boundaryIsNewer(current, incoming))) {
        return Object.freeze({
          accept: false,
          reason: boundary ? 'STALE_STREAM_BOUNDARY' : 'STALE_NAVIGATOR_STREAM',
          switched: false,
          requiresReset: false,
          identity: current,
        });
      }
      if (streamChanged) {
        current = incoming;
        return Object.freeze({
          accept: true,
          reason: 'STREAM_REBOUND',
          switched: false,
          requiresReset: true,
          identity: current,
        });
      }

      if (boundaryIsNewer(current, incoming)) current = incoming;
      return Object.freeze({
        accept: true,
        reason: 'CURRENT_PROJECT_GENERATION',
        switched: false,
        requiresReset: false,
        identity: current,
      });
    },
  });
}
