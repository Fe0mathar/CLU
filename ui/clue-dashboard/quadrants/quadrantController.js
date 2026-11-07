/**
 * The quadrant controller contract — `DEV-P1-16`.
 *
 * The obligation is to "decompose into quadrant controllers and one Status v5 store/identity
 * bus/fullscreen contract". The store, bus and contract exist; this is the seam the four
 * quadrants move behind, one at a time, instead of `app.js` being rewritten in a single turn that
 * nothing could review.
 *
 * ## Declared branches are how §20.1 becomes checkable
 *
 * §20.1 says the shell "must not recreate Q1, metric, Git, benchmark, or verdict state locally".
 * Stated that way it is a rule nobody can enforce — every reviewer has to notice every violation
 * by eye, and 6180 lines is where that stops working. So a controller declares the Status branches
 * it consumes, and `branch()` refuses any name it did not declare.
 *
 * That turns the prohibition into something a test can hold: a quadrant reaching for state it has
 * no business reading fails immediately and by name, rather than quietly growing a second copy of
 * another quadrant's data. It also documents each quadrant's real dependencies in one line, which
 * is the thing nobody could state about `app.js` without reading all of it.
 *
 * ## The controller never fetches
 *
 * There is no transport here on purpose. A controller that could fetch would eventually fetch, and
 * the six endpoints scattered through `app.js` are what that looks like after two years. Status
 * arrives from the store; everything else arrives from the quadrant's own module.
 *
 * ## A failing quadrant fails alone, and says so
 *
 * §10.1.3 requires unknown, unsupported, partial, stale, failed and discovered to be explicit
 * states rather than blank panels. A render that throws puts the controller in `failed` with the
 * reason attached, leaves the other three running, and gives the shell something truthful to draw.
 * The alternative — an exception escaping into the shell — takes down three working quadrants to
 * report a fault in one.
 */

const FROZEN_EMPTY = Object.freeze([]);

/**
 * @param {object} spec
 * @param {string} spec.id                      quadrant id, e.g. 'q1'
 * @param {object} spec.store                   the sealed Status store
 * @param {object} spec.bus                     the selection and cross-highlighting bus
 * @param {object} [spec.fullscreen]            the shared fullscreen contract
 * @param {readonly string[]} [spec.branches]   Status branches this quadrant consumes
 * @param {(context: object) => void} [spec.render]
 * @param {(selection: object) => object[]} [spec.resolveRelated]
 * @param {object} [spec.element]               the panel, for fullscreen registration
 */
export function createQuadrantController(spec) {
  const id = String(spec.id);
  const declared = Object.freeze([...(spec.branches ?? [])].map(String));
  const declaredSet = new Set(declared);

  let state = Object.freeze({ id, mounted: false, status: 'idle', reason: null, renders: 0 });
  const listeners = new Set();
  const releases = [];

  function publish(next) {
    state = Object.freeze({ ...state, ...next });
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        /* a subscriber's fault is its own */
      }
    }
  }

  /**
   * One declared Status branch, as the contract wrote it.
   *
   * An undeclared name throws rather than returning the branch. Returning it "just this once" is
   * how the prohibition erodes: the first undeclared read is always reasonable in context, and the
   * tenth is a second copy of another quadrant's state.
   */
  function branch(name) {
    const key = String(name);
    if (!declaredSet.has(key)) {
      throw new Error(
        `${id} did not declare Status branch "${key}"; declared: ${declared.join(', ') || '(none)'}`,
      );
    }
    return spec.store.branch(key);
  }

  /** What this quadrant should highlight because of a selection elsewhere. */
  function highlights() {
    return spec.bus.highlightsFor(id) ?? FROZEN_EMPTY;
  }

  /** Selecting from within this quadrant. The bus carries identity only. */
  function select(kind, entityId) {
    return spec.bus.select({ quadrant: id, kind: String(kind), id: String(entityId) });
  }

  function context() {
    return Object.freeze({
      id,
      branch,
      branches: declared,
      highlights,
      select,
      statusState: spec.store.get().state,
      selection: spec.bus.get().selection,
    });
  }

  function draw() {
    if (typeof spec.render !== 'function') return;
    try {
      spec.render(context());
      publish({ status: 'ready', reason: null, renders: state.renders + 1 });
    } catch (error) {
      // Explicit failure, per §10.1.3. The shell draws a quadrant that says what went wrong; the
      // other three keep running.
      publish({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        renders: state.renders + 1,
      });
    }
  }

  function mount() {
    if (state.mounted) return state;

    releases.push(spec.store.subscribe(() => draw()));
    releases.push(spec.bus.subscribe(() => draw()));
    if (typeof spec.resolveRelated === 'function') {
      releases.push(spec.bus.registerResolver(id, spec.resolveRelated));
    }
    if (spec.fullscreen !== undefined && spec.element !== undefined) {
      releases.push(
        spec.fullscreen.register(id, spec.element, {
          onEnter: () => draw(),
          onLeave: () => draw(),
        }),
      );
    }

    publish({ mounted: true, status: 'ready' });
    draw();
    return state;
  }

  /**
   * Releases everything mount acquired.
   *
   * Every registration returns its own release and they are run in reverse, so a controller that
   * is unmounted leaves no subscription, no resolver and no fullscreen registration behind. A
   * quadrant that keeps drawing after it is gone is the failure mode that makes hot-swapping a
   * panel impossible, and it is invisible until the second swap.
   */
  function unmount() {
    while (releases.length > 0) {
      const release = releases.pop();
      try {
        release();
      } catch {
        /* releasing must not throw past the others */
      }
    }
    publish({ mounted: false, status: 'idle', reason: null });
    return state;
  }

  function get() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { id, declaredBranches: declared, mount, unmount, get, subscribe, draw, context };
}
