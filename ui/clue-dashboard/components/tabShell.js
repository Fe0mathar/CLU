/**
 * The two-tab shell — `DEV-P1-17`.
 *
 * Directory §20.1 requires "exactly two top-level tabs: Dashboard and Configuration", and §20.1
 * lists "accessibility, focus, density" among the shell's responsibilities. `index.html` has
 * neither: Configuration is an `<aside id="cfg">` drawer toggled by a button, there is no tablist,
 * no `<main>`, and — measured across the whole file — **zero** `role=` or `aria-` attributes.
 *
 * ## Exactly two is enforced, not assumed
 *
 * "Exactly two" reads like prose until something checks it. A third tab is how a dashboard becomes
 * a settings app one reasonable addition at a time, and each addition looks fine on the day. So
 * construction with anything other than two tabs throws, by name, with the count it was given.
 *
 * ## Roving tabindex, because a tablist is one stop
 *
 * Both tabs being focusable puts every panel behind an extra Tab press and makes the arrow keys
 * dead — which is precisely backwards, since arrow keys are how a tablist is meant to be driven.
 * The selected tab holds `tabindex="0"` and the other `-1`, so Tab enters and leaves the tablist
 * once and Left/Right/Home/End move within it. This is the WAI-ARIA tabs pattern, and following it
 * matters more than usual here: an operator watching a mission run is exactly the person who
 * should not have to hunt for a control.
 *
 * ## The DOM is written, not remembered
 *
 * Every state change writes `aria-selected`, `tabindex` and `hidden` onto the elements rather than
 * tracking them in a variable and hoping the two agree. A private mirror of DOM state is wrong the
 * moment anything else touches the DOM, and something always does.
 */

/** The two tabs the shell may have, in order. */
export const TOP_LEVEL_TABS = Object.freeze(['dashboard', 'configuration']);

/**
 * @param {object} spec
 * @param {ReadonlyArray<{id: string, tab: object, panel: object}>} spec.tabs exactly two
 * @param {(id: string) => void} [spec.onChange]
 * @param {string} [spec.initial]
 */
export function createTabShell(spec) {
  const tabs = [...(spec.tabs ?? [])];

  if (tabs.length !== 2) {
    // A third tab is how a dashboard becomes a settings app one reasonable addition at a time.
    throw new Error(
      `the shell has exactly two top-level tabs (Directory §20.1); received ${tabs.length}`,
    );
  }
  const ids = tabs.map((entry) => String(entry.id));
  if (ids[0] === ids[1]) throw new Error(`both tabs are "${ids[0]}"`);
  for (const id of ids) {
    if (!TOP_LEVEL_TABS.includes(id)) {
      throw new Error(`"${id}" is not a top-level tab; expected ${TOP_LEVEL_TABS.join(' and ')}`);
    }
  }

  let selected = String(spec.initial ?? ids[0]);
  if (!ids.includes(selected)) selected = ids[0];

    /**
   * The id an element already answers to, or one minted for it.
   *
   * DEV-P1-17: this used to overwrite the id unconditionally, and that was a real fault rather
   * than a tidiness question. Handed the live dashboard, it renamed `#grid` to `#panel-dashboard`
   * and `#cfg` to `#panel-configuration`. Every stylesheet rule keyed on those ids stopped
   * matching — `#grid { height: calc(100% - 52px); display: grid; grid-template-rows: 1fr 1fr }`
   * among them, so the quadrants lost their grid and collapsed — and every later
   * `getElementById('grid')` in `app.js` returned null, so their content never arrived either.
   *
   * A shell wires elements together; it does not get to rename them. It mints an id only where
   * there is none to refer to.
   */
  function identify(element, fallback) {
    const existing = element.getAttribute?.('id');
    if (typeof existing === 'string' && existing.length > 0) return existing;
    element.setAttribute('id', fallback);
    return fallback;
  }

  function applyRoles() {
    for (const entry of tabs) {
      const id = String(entry.id);
      const isSelected = id === selected;

      const tabId = identify(entry.tab, `tab-${id}`);
      const panelId = identify(entry.panel, `panel-${id}`);

      entry.tab.setAttribute('role', 'tab');
      entry.tab.setAttribute('aria-selected', String(isSelected));
      entry.tab.setAttribute('aria-controls', panelId);
      // Roving: one stop for the whole tablist, arrows to move within it.
      entry.tab.setAttribute('tabindex', isSelected ? '0' : '-1');

      entry.panel.setAttribute('role', 'tabpanel');
      entry.panel.setAttribute('aria-labelledby', tabId);
      // The panel itself is focusable so that moving into it from the tab lands somewhere
      // announced, rather than on whatever element happens to be first.
      entry.panel.setAttribute('tabindex', '0');
      if (isSelected) entry.panel.removeAttribute('hidden');
      else entry.panel.setAttribute('hidden', '');
    }
  }

  /**
   * Selects a tab.
   *
   * `moveFocus` is false for a programmatic selection — restoring a remembered tab on load should
   * not steal focus from wherever the operator is — and true when the selection came from the
   * keyboard, where focus must follow or the next arrow press starts from the wrong place.
   */
  function select(id, { moveFocus = false } = {}) {
    const key = String(id);
    if (!ids.includes(key)) {
      return { selected, refused: `"${key}" is not one of ${ids.join(', ')}` };
    }
    const changed = key !== selected;
    selected = key;
    applyRoles();
    if (moveFocus) {
      const entry = tabs.find((candidate) => String(candidate.id) === key);
      if (typeof entry?.tab?.focus === 'function') entry.tab.focus();
    }
    if (changed && typeof spec.onChange === 'function') {
      try {
        spec.onChange(selected);
      } catch {
        /* a listener's fault is its own; the tab still changed */
      }
    }
    return { selected };
  }

  /**
   * The WAI-ARIA tablist keys. Returns whether the event was consumed, so the caller knows
   * whether to prevent the default.
   */
  function handleKey(event) {
    const key = event?.key;
    const index = ids.indexOf(selected);
    switch (key) {
      case 'ArrowRight':
      case 'ArrowDown':
        select(ids[(index + 1) % ids.length], { moveFocus: true });
        return true;
      case 'ArrowLeft':
      case 'ArrowUp':
        select(ids[(index - 1 + ids.length) % ids.length], { moveFocus: true });
        return true;
      case 'Home':
        select(ids[0], { moveFocus: true });
        return true;
      case 'End':
        select(ids[ids.length - 1], { moveFocus: true });
        return true;
      default:
        return false;
    }
  }

  function current() {
    return selected;
  }

  applyRoles();
  return { select, handleKey, current, tabIds: Object.freeze(ids) };
}
