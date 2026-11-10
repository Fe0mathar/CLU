/**
 * Keeps the operator's place across a re-render.
 *
 * The Configuration surface renders as one HTML string. Replacing that string used to throw away
 * everything the DOM was holding that the state store does not: which control had focus and where
 * the caret was, how far each pane was scrolled, which "Advanced" blocks were open, and text typed
 * into inputs that are not part of the profile draft. Editing one field therefore moved the page.
 *
 * `captureContinuity` reads those four things immediately before the string is replaced and
 * `restoreContinuity` puts them back immediately after. The values live in one local object for
 * the duration of a render; nothing is stored and nothing is sent.
 *
 * Every access is guarded, because the panel is also mounted on roots that are not DOM elements.
 */

const FOCUS_ATTRIBUTES = Object.freeze([
  'data-profile-path',
  'data-new-project-field',
  'data-cfg-override',
  'data-additional-role-index',
  'data-additional-enabled-index',
  'data-section-target',
  'data-change-path',
  'data-cfg-action',
]);

function quote(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function all(root, selector) {
  try {
    return typeof root?.querySelectorAll === 'function' ? Array.from(root.querySelectorAll(selector)) : [];
  } catch {
    return [];
  }
}

function describeFocus(root, element) {
  if (!element || typeof element.getAttribute !== 'function') return null;
  const tag = String(element.tagName ?? '').toLowerCase();
  let selector = null;
  const id = element.getAttribute('id');
  if (id) selector = `[id="${quote(id)}"]`;
  else {
    for (const attribute of FOCUS_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null || value === undefined) continue;
      selector = `${tag}[${attribute}="${quote(value)}"]`;
      break;
    }
  }
  if (selector === null) return null;
  const index = Math.max(0, all(root, selector).indexOf(element));
  let start = null;
  let end = null;
  try {
    if (typeof element.selectionStart === 'number') {
      start = element.selectionStart;
      end = element.selectionEnd;
    }
  } catch { /* number and checkbox inputs expose no selection */ }
  return { selector, index, start, end };
}

/** Describes the focused control inside `root` so focus can be returned to it later, or null. */
export function describeActiveFocus(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const active = root.ownerDocument?.activeElement ?? null;
  if (!active || active === root || typeof root.contains !== 'function' || !root.contains(active)) return null;
  return describeFocus(root, active);
}

/**
 * @param {Element|object} root
 * @returns {null|{focus:object|null, scroll:[string,number][], open:string[], transient:[string,unknown,boolean][]}}
 */
export function captureContinuity(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const memo = { focus: null, scroll: [], open: [], transient: [] };
  const active = root.ownerDocument?.activeElement ?? null;
  if (active && active !== root && typeof root.contains === 'function' && root.contains(active)) {
    memo.focus = describeFocus(root, active);
  }
  for (const element of all(root, '[data-cfg-scroll]')) {
    memo.scroll.push([element.getAttribute('data-cfg-scroll'), element.scrollTop]);
  }
  for (const element of all(root, 'details[open][data-cfg-details]')) {
    memo.open.push(element.getAttribute('data-cfg-details'));
  }
  for (const element of all(root, '[data-cfg-transient]')) {
    const id = element.getAttribute('id');
    if (!id || element.getAttribute('data-cfg-transient') === 'volatile') continue;
    const checkbox = element.type === 'checkbox';
    memo.transient.push([id, checkbox ? element.checked : element.value, checkbox]);
  }
  return memo;
}

/**
 * @param {Element|object} root
 * @param {ReturnType<typeof captureContinuity>} memo
 * @param {{resetScroll?: string[], dropTransient?: Iterable<string>, focus?: unknown}} [options]
 *   `focus` is a selector, a focus descriptor, or a list of either, tried in order before the
 *   previously focused control.
 * @returns {boolean} whether a control received focus
 */
export function restoreContinuity(root, memo, options = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return false;
  const reset = new Set(options.resetScroll ?? []);
  const drop = new Set(options.dropTransient ?? []);

  if (memo) {
    for (const key of memo.open) {
      for (const element of all(root, `details[data-cfg-details="${quote(key)}"]`)) element.open = true;
    }
    for (const [id, value, checkbox] of memo.transient) {
      if (drop.has(id)) continue;
      const element = all(root, `[id="${quote(id)}"]`)[0];
      if (!element) continue;
      if (checkbox) element.checked = Boolean(value);
      else if (element.value !== value) {
        element.value = value;
        // A <select> silently ignores a value it no longer offers; leave its rendered choice.
      }
    }
    for (const [key, top] of memo.scroll) {
      if (reset.has(key)) continue;
      for (const element of all(root, `[data-cfg-scroll="${quote(key)}"]`)) element.scrollTop = top;
    }
  }

  const candidates = [];
  for (const wanted of Array.isArray(options.focus) ? options.focus : [options.focus]) {
    if (typeof wanted === 'string' && wanted !== '') candidates.push({ selector: wanted, index: 0, start: null, end: null });
    else if (wanted && typeof wanted === 'object' && typeof wanted.selector === 'string') candidates.push({ start: null, end: null, index: 0, ...wanted });
  }
  if (memo?.focus) candidates.push(memo.focus);
  for (const target of candidates) {
    const element = all(root, target.selector)[target.index] ?? all(root, target.selector)[0];
    if (!element || element.disabled || typeof element.focus !== 'function') continue;
    if (typeof element.closest === 'function' && element.closest('[hidden]')) continue;
    try {
      element.focus({ preventScroll: true });
      if (target.start !== null && typeof element.setSelectionRange === 'function') {
        element.setSelectionRange(target.start, target.end ?? target.start);
      }
    } catch { /* focus is a convenience; a control that refuses it is not an error */ }
    return true;
  }
  return false;
}
