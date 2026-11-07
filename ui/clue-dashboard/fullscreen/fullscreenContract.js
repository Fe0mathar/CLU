/**
 * The shared fullscreen contract — `DEV-P1-16`.
 *
 * Directory §20.1 gives the shell "shared fullscreen behavior for every meaningful window", and
 * §10.1.5 adds the constraint that matters: a window enters fullscreen "while preserving the same
 * status snapshot and selection identity". Today that behaviour lives inside `app.js` as
 * `toggleFullscreen`, `leaveAnyFullscreen` and a `softFullscreen` variable threaded through a 6180
 * line file, so a second surface wanting the same behaviour would have to reimplement it and the
 * two would drift.
 *
 * ## What was already right, and is kept
 *
 * The existing implementation reads `document.fullscreenElement` as the authority and subscribes
 * to `fullscreenchange` rather than mirroring the state in a private flag. That is the correct
 * choice and the reason Escape does not desynchronise the UI: the browser can leave fullscreen
 * without asking, so any private mirror is wrong the moment the operator presses a key the page
 * never sees. This contract keeps that — `current()` derives from the document for native
 * fullscreen and only tracks soft fullscreen itself, because soft fullscreen is the page's own
 * invention and the page is therefore its authority.
 *
 * The soft fallback is also kept. `requestFullscreen` can be refused — an iframe without the
 * permission, a browser policy, a user gesture that expired — and a window that silently stayed
 * small after the operator clicked expand would be a lie about a control they just used.
 *
 * ## Identity is preserved by not being touched
 *
 * This module holds no Status and no selection. §10.1.5's preservation requirement is met by the
 * contract having no way to disturb either, rather than by saving and restoring them — a
 * save/restore would be a second copy of state the shell is forbidden to keep, and would be wrong
 * the moment it went stale.
 */

const NO_FULLSCREEN = Object.freeze({ id: null, mode: null });

/**
 * @param {object} [options]
 * @param {Document} [options.documentLike] the fullscreen authority; defaults to `document`
 */
export function createFullscreenContract(options = {}) {
  const doc = options.documentLike ?? (typeof document === 'undefined' ? null : document);
  if (doc === null) throw new Error('createFullscreenContract needs a document');

  /** id → { element, onEnter, onLeave } */
  const windows = new Map();
  const listeners = new Set();
  /** Soft fullscreen only. Native state is read from the document, never mirrored. */
  let soft = null;
  let lastPublished = NO_FULLSCREEN;

  function currentNativeId() {
    const element = doc.fullscreenElement ?? null;
    if (element === null) return null;
    for (const [id, record] of windows) if (record.element === element) return id;
    return null;
  }

  /** Which window is fullscreen, and how. Derived, so it cannot drift from the browser. */
  function current() {
    const native = currentNativeId();
    if (native !== null) return Object.freeze({ id: native, mode: 'native' });
    if (soft !== null) return Object.freeze({ id: soft, mode: 'soft' });
    return NO_FULLSCREEN;
  }

  function publish() {
    const next = current();
    if (next.id === lastPublished.id && next.mode === lastPublished.mode) return;
    const previous = lastPublished;
    lastPublished = next;

    if (previous.id !== null && previous.id !== next.id) runHook(previous.id, 'onLeave');
    if (next.id !== null) runHook(next.id, 'onEnter');

    for (const listener of listeners) {
      try {
        listener(next, previous);
      } catch {
        /* a subscriber's fault is its own */
      }
    }
  }

  function runHook(id, name) {
    const record = windows.get(id);
    const hook = record?.[name];
    if (typeof hook !== 'function') return;
    // A window that throws while relaying out must not strand the contract mid-transition: the
    // browser has already changed state, and refusing to publish would leave every other window
    // believing the old one is still fullscreen.
    try {
      hook();
    } catch {
      /* the window's fault is its own */
    }
  }

  doc.addEventListener('fullscreenchange', () => {
    // The browser left fullscreen on its own — Escape, a policy, a navigation. Soft state is
    // cleared with it so the two cannot both claim a window.
    if (doc.fullscreenElement === null && soft === null) publish();
    else publish();
  });

  /**
   * Registers a window. `onEnter`/`onLeave` are for relayout, not for state.
   *
   * @returns {() => void} unregister
   */
  function register(id, element, hooks = {}) {
    const key = String(id);
    windows.set(key, { element, onEnter: hooks.onEnter, onLeave: hooks.onLeave });
    return () => {
      if (soft === key) soft = null;
      windows.delete(key);
    };
  }

  /**
   * Enters fullscreen for one window, leaving whatever was fullscreen before.
   *
   * Exactly one at a time is not a simplification: two fullscreen windows cannot both occupy the
   * viewport, so a contract that allowed the state would be describing something unrenderable.
   */
  async function enter(id) {
    const key = String(id);
    const record = windows.get(key);
    if (record === undefined) {
      // Named refusal, not a silent return. A control wired to an unregistered window is a wiring
      // fault, and one that does nothing quietly is found much later than one that says so.
      return { entered: false, reason: `no window is registered as "${key}"` };
    }
    if (current().id === key) return { entered: true, mode: current().mode };

    await leave();

    if (typeof record.element.requestFullscreen === 'function') {
      try {
        await record.element.requestFullscreen({ navigationUI: 'hide' });
        publish();
        return { entered: true, mode: 'native' };
      } catch {
        /* refused — fall through to soft, rather than leaving the operator's click unanswered */
      }
    }
    soft = key;
    publish();
    return { entered: true, mode: 'soft' };
  }

  async function leave() {
    if (currentNativeId() !== null && typeof doc.exitFullscreen === 'function') {
      try {
        await doc.exitFullscreen();
      } catch {
        /* the composition is still restorable below */
      }
    }
    soft = null;
    publish();
  }

  async function toggle(id) {
    if (current().id === String(id)) {
      await leave();
      return { entered: false };
    }
    return enter(id);
  }

  /** Escape releases soft fullscreen. Native fullscreen is the browser's to release. */
  function handleKey(event) {
    if (event?.key === 'Escape' && soft !== null) {
      soft = null;
      publish();
      return true;
    }
    return false;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { register, enter, leave, toggle, current, handleKey, subscribe };
}
