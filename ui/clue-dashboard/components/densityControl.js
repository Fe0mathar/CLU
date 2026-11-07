/**
 * Density — the shell's presentation-density preference — `DEV-P1-17`.
 *
 * §20.1 lists density among the shell's responsibilities, and Directory §3.6 says what kind of
 * thing it is allowed to be: a *non-authoritative presentation preference* that "cannot redefine
 * lifecycle states, measure meaning, Q1 classification, or verdicts." That sentence is this
 * module's whole design: density is one attribute on the document root, stylesheets read it, and
 * nothing else can.
 *
 * ## One attribute, not a class per surface
 *
 * The mechanism is `data-density` on the root element. A quadrant, panel or overlay that wants to
 * be denser writes CSS keyed on `[data-density="compact"]` and nothing in JavaScript ever asks
 * "what density are we?" to decide *content*. That is enforceable because the module exposes no
 * value-changing hooks — a subscriber is told the density changed so it can relayout a canvas,
 * and receives the mode, but there is no way to register "when compact, drop this row." Dropping
 * rows is meaning; §3.6 forbids the preference to reach it.
 *
 * ## Persistence follows the existing convention
 *
 * `clue.density` in localStorage, matching `clue.excluded` and `clue.q2.projection`. Storage is
 * injected, both because localStorage can be absent (private windows throw on access) and because
 * that is what lets this run under `node --test`. A storage failure degrades to the default and
 * says nothing — a preference that cannot persist is still a preference for the session.
 *
 * ## The modes are closed
 *
 * `comfortable` and `compact`. Not a scale, not a pixel value: a third density is a design
 * decision that belongs in a review, not a value that belongs in storage, and an unrecognised
 * stored value falls back to the default rather than being applied blind.
 */

export const DENSITY_MODES = Object.freeze(['comfortable', 'compact']);
export const DEFAULT_DENSITY = 'comfortable';
const STORAGE_KEY = 'clue.density';

/**
 * @param {object} [options]
 * @param {object} [options.root] the element that carries `data-density`; defaults to
 *        `document.documentElement`
 * @param {{getItem: Function, setItem: Function}|null} [options.storage] injected persistence;
 *        defaults to `window.localStorage` where it exists, and absence is fine
 */
export function createDensityControl(options = {}) {
  const root =
    options.root ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (root === null) throw new Error('createDensityControl needs a root element');

  const storage =
    options.storage !== undefined
      ? options.storage
      : (() => {
          try {
            return typeof window === 'undefined' ? null : window.localStorage ?? null;
          } catch {
            return null; // access itself can throw in private windows
          }
        })();

  const listeners = new Set();

  function readStored() {
    if (storage === null) return DEFAULT_DENSITY;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      // An unrecognised stored value is not applied blind: densities are closed, and whatever
      // wrote this was not this module.
      return DENSITY_MODES.includes(raw) ? raw : DEFAULT_DENSITY;
    } catch {
      return DEFAULT_DENSITY;
    }
  }

  let mode = readStored();

  function apply() {
    root.setAttribute('data-density', mode);
  }

  function current() {
    return mode;
  }

  /**
   * Sets the density. An unknown mode is refused by name rather than clamped, because a caller
   * passing "cozy" has a bug, and clamping would hide it under a working screen.
   */
  function set(next) {
    const key = String(next);
    if (!DENSITY_MODES.includes(key)) {
      return { mode, refused: `"${key}" is not a density; densities are ${DENSITY_MODES.join(', ')}` };
    }
    const changed = key !== mode;
    mode = key;
    apply();
    if (storage !== null) {
      try {
        storage.setItem(STORAGE_KEY, mode);
      } catch {
        /* a preference that cannot persist is still a preference for the session */
      }
    }
    if (changed) {
      for (const listener of listeners) {
        try {
          listener(mode);
        } catch {
          /* a subscriber's fault is its own */
        }
      }
    }
    return { mode };
  }

  function toggle() {
    return set(mode === 'comfortable' ? 'compact' : 'comfortable');
  }

  /** Told so a canvas can relayout — the mode is information, never an instruction to omit. */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  apply();
  return { current, set, toggle, subscribe, modes: DENSITY_MODES };
}
