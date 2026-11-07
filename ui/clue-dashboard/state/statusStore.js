/**
 * The one sealed Status v5 store — `DEV-P1-16`.
 *
 * Directory §20.1 gives the shell "one sealed Status state store" and then the constraint that
 * makes it mean something: it *must not recreate Q1, metric, Git, benchmark, or verdict state
 * locally*. `app.js` is 6180 lines with no such store — six endpoints are fetched from wherever
 * they happen to be needed and each quadrant keeps its own copy, which is the shape §20.1 exists
 * to forbid. This is where that copy stops being made.
 *
 * ## What it holds, and what it refuses to do
 *
 * It holds the sealed Status body from `/api/status/current` and nothing else. It does not derive,
 * default, merge, or repair. That restraint is the whole point: the Status Contract spends its
 * length distinguishing `unsupported` from `unavailable` from `stale` from a real zero, the
 * projector is tested to never invent one for another, and a store that helpfully substituted
 * `0` or `{}` for an absent branch would undo all of it at the last hop — in the one place no
 * server-side test can see.
 *
 * So `branch()` returns the branch as the contract wrote it, and a branch that was never in the
 * body comes back as `{ state: 'unknown-branch' }` rather than `undefined`. `undefined` is what a
 * caller writes `?? 0` after; a named state is not.
 *
 * ## Why the transports are injected
 *
 * `fetchJson` and `createEventSource` are parameters with browser defaults. That is not
 * indirection for its own sake — it is the only reason this file can be proven at all. Nothing in
 * a session can execute a browser, so a store wired directly to the globals could only be reviewed
 * by reading it. Injected, it runs under `node --test` against a fake endpoint, which is how
 * `browserAgent.ts` came to have its first tests in this same session.
 *
 * ## Schema agreement is checked, not assumed
 *
 * `/api/status/schema` exists precisely so a consumer can validate independently rather than trust
 * the shape it happens to receive (§17). A body whose `schemaVersion` disagrees with the server's
 * declared version is refused into a `schema-mismatch` state rather than rendered: a dashboard
 * drawing a 5.0.0 body under 5.1.0 labels is worse than one showing nothing, because the operator
 * cannot tell.
 */

/** States this store itself can be in. Distinct from any branch's state. */
export const STATUS_STORE_STATES = /** @type {const} */ ([
  'idle',
  'loading',
  'ready',
  'unreachable',
  'schema-mismatch',
]);

const FROZEN_EMPTY = Object.freeze([]);

/**
 * Reads only the existing Status v5 target identity. An unavailable/malformed target yields null;
 * callers must not infer a project from another branch.
 *
 * @param {unknown} body
 * @returns {null|{ projectId: string, canonicalRoot: string, key: string }}
 */
function readProjectIdentity(body) {
  if (body === null || typeof body !== 'object') return null;
  const target = /** @type {Record<string, unknown>} */ (body)['target'];
  if (target === null || typeof target !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (target);
  const projectId = record['targetId'];
  const canonicalRoot = record['canonicalRoot'];
  if (typeof projectId !== 'string' || projectId.length === 0) return null;
  if (typeof canonicalRoot !== 'string' || canonicalRoot.length === 0) return null;
  return Object.freeze({
    projectId,
    canonicalRoot,
    key: JSON.stringify([projectId, canonicalRoot.replace(/\\/gu, '/').toLowerCase()]),
  });
}


/**
 * Reads only the active Project ID carried by a sealed console frame. Legacy frames may omit it;
 * a present identity is authoritative enough to reject a cross-project frame before adopting its
 * revision/seal, while Status remains the authority for the complete target body.
 *
 * @param {unknown} frame
 * @returns {string|null}
 */
function readFrameProjectId(frame) {
  if (frame === null || typeof frame !== 'object') return null;
  const snapshot = /** @type {Record<string, unknown>} */ (frame)['snapshot'];
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const configuration = /** @type {Record<string, unknown>} */ (snapshot)['configuration'];
  if (configuration === null || typeof configuration !== 'object') return null;
  const project = /** @type {Record<string, unknown>} */ (configuration)['project'];
  if (project === null || typeof project !== 'object') return null;
  const activeProject = /** @type {Record<string, unknown>} */ (project)['activeProject'];
  if (activeProject === null || typeof activeProject !== 'object') return null;
  const operationIdentity = /** @type {Record<string, unknown>} */ (activeProject)['operationIdentity'];
  if (operationIdentity === null || typeof operationIdentity !== 'object') return null;
  const projectId = /** @type {Record<string, unknown>} */ (operationIdentity)['projectId'];
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}

/**
 * @param {object} [options]
 * @param {(url: string) => Promise<unknown>} [options.fetchJson]
 * @param {(url: string) => { addEventListener: Function, close: Function }} [options.createEventSource]
 * @param {string} [options.statusUrl]
 * @param {string} [options.schemaUrl]
 * @param {string} [options.frameEventsUrl]
 */
export function createStatusStore(options = {}) {
  const statusUrl = options.statusUrl ?? '/api/status/current';
  const schemaUrl = options.schemaUrl ?? '/api/status/schema';
  const frameEventsUrl = options.frameEventsUrl ?? '/api/console-events';

  const fetchJson =
    options.fetchJson ??
    (async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
      return response.json();
    });
  const createEventSource =
    options.createEventSource ?? ((url) => new EventSource(url));

  /** @type {{ state: string, body: unknown, schemaVersion: string|null, reason: string|null, revision: number|null, seal: unknown, projectIdentity: null|{ projectId: string, canonicalRoot: string, key: string }, projectRevision: number }} */
  let current = {
    state: 'idle',
    body: null,
    schemaVersion: null,
    reason: null,
    revision: null,
    seal: null,
    projectIdentity: null,
    projectRevision: 0,
  };

  const listeners = new Set();
  let source = null;
  let refreshing = false;

  function publish(next) {
    current = Object.freeze(next);
    for (const listener of listeners) {
      // One failing subscriber must not silence the others or take the store down with it —
      // the same isolation `DEV-P1-22` required of the operational console's listeners.
      try {
        listener(current);
      } catch {
        /* a subscriber's fault is its own */
      }
    }
  }

  /** The current state. Frozen, so a consumer cannot mutate the store through what it reads. */
  function get() {
    return current;
  }

  /**
   * One branch of the sealed body, exactly as the contract wrote it.
   *
   * A branch absent from the body is `unknown-branch`, never `undefined`. A store that returns
   * `undefined` invites `?? 0` at the call site, and a fabricated zero is the failure the Status
   * Contract is largely about.
   */
  function branch(name) {
    if (current.body === null || typeof current.body !== 'object') {
      return { state: 'unavailable', reason: `status is ${current.state}` };
    }
    const value = /** @type {Record<string, unknown>} */ (current.body)[name];
    if (value === undefined) {
      return { state: 'unknown-branch', reason: `the sealed body declares no branch "${name}"` };
    }
    return value;
  }

  /**
   * The selected target identity carried by the sealed Status target branch.
   *
   * This is deliberately narrower than the future Project Profile wire identity: Status v5 does
   * not yet carry `projectProfileHash` or `profileGeneration`. The store therefore exposes exactly
   * the two identity fields Status already owns and never invents the missing profile fields.
   */
  function projectIdentity() {
    return current.projectIdentity;
  }

  /** Every branch name the sealed body carries, sorted. Empty until a body has been read. */
  function branchNames() {
    if (current.body === null || typeof current.body !== 'object') return FROZEN_EMPTY;
    return Object.freeze(Object.keys(current.body).sort());
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (current.state !== 'idle') listener(current);
    return () => listeners.delete(listener);
  }

  /**
   * Reads the sealed body once, checking schema agreement first.
   *
   * A failed read leaves the previous body in place under an `unreachable` state rather than
   * clearing it. Losing the last known truth because one poll failed would replace a stale answer
   * with no answer, and §18's stale handling exists because the stale one is more useful — as long
   * as it is labelled, which is what `state` does.
   */
  async function refresh() {
    if (refreshing) return current;
    refreshing = true;
    try {
      let declaredVersion = null;
      try {
        const schema = await fetchJson(schemaUrl);
        declaredVersion =
          typeof schema === 'object' && schema !== null
            ? /** @type {Record<string, unknown>} */ (schema)['schemaVersion'] ?? null
            : null;
      } catch {
        // The schema endpoint being unavailable is not itself a mismatch; the body's own
        // declared version is still checked for presence below.
        declaredVersion = null;
      }

      const body = await fetchJson(statusUrl);
      if (typeof body !== 'object' || body === null) {
        publish({ ...current, state: 'unreachable', reason: `${statusUrl} returned no body` });
        return current;
      }

      const bodyVersion = /** @type {Record<string, unknown>} */ (body)['schemaVersion'] ?? null;
      if (typeof bodyVersion !== 'string') {
        publish({
          ...current,
          state: 'schema-mismatch',
          reason: 'the body declares no schemaVersion',
        });
        return current;
      }
      if (declaredVersion !== null && bodyVersion !== declaredVersion) {
        publish({
          ...current,
          state: 'schema-mismatch',
          reason: `body is ${bodyVersion}, server declares ${String(declaredVersion)}`,
        });
        return current;
      }

      const nextProjectIdentity = readProjectIdentity(body);
      const previousProjectIdentity = current.projectIdentity;
      const previousProjectKey = previousProjectIdentity?.key ?? null;
      const nextProjectKey = nextProjectIdentity?.key ?? null;
      const projectChanged = previousProjectKey !== nextProjectKey;

      publish({
        state: 'ready',
        body,
        schemaVersion: bodyVersion,
        reason: null,
        // A console frame revision and seal belong to one target projection. They cannot survive a
        // target switch and then be presented as Project B evidence.
        revision: projectChanged ? null : current.revision,
        seal: projectChanged ? null : current.seal,
        projectIdentity: nextProjectIdentity,
        projectRevision: projectChanged ? current.projectRevision + 1 : current.projectRevision,
      });
    } catch (error) {
      publish({
        ...current,
        state: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshing = false;
    }
    return current;
  }

  /**
   * Follows the sealed console frame stream, and re-reads Status when the revision advances.
   *
   * The frame stream is the change signal, not the source: the frame carries the console
   * projection, Status carries the sealed body, and ADR-0002 makes them two views of one
   * workspace rather than two truths. Using the frame's revision as a trigger keeps them in step
   * without this store ever reading a value out of the frame.
   */
  function connect() {
    if (source !== null) return;
    publish({ ...current, state: current.state === 'ready' ? 'ready' : 'loading' });
    void refresh();

    source = createEventSource(frameEventsUrl);
    source.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof frame !== 'object' || frame === null) return;
      const revision = frame['revision'];
      if (typeof revision !== 'number' || revision === current.revision) return;
      const frameProjectId = readFrameProjectId(frame);
      const currentProjectId = current.projectIdentity?.projectId ?? null;
      if (frameProjectId !== null && frameProjectId !== currentProjectId) {
        // The frame is a change signal for another project. Re-read Status first, but never pair
        // Project B's revision/seal with Project A's still-visible body during the transition.
        void refresh();
        return;
      }
      publish({ ...current, revision, seal: frame['seal'] ?? null });
      void refresh();
    });
    source.addEventListener('error', () => {
      publish({ ...current, state: 'unreachable', reason: 'the status frame stream errored' });
    });
  }

  function disconnect() {
    if (source === null) return;
    try {
      source.close();
    } catch {
      /* already gone */
    }
    source = null;
  }

  return { get, branch, branchNames, projectIdentity, subscribe, refresh, connect, disconnect };
}
