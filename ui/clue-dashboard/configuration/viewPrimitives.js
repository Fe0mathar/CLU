/** Shared, side-effect-free primitives for the Project Profile Configuration surface. */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function readPath(root, path) {
  const segments = Array.isArray(path) ? path : String(path).split('.').filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

export function writePath(root, path, value) {
  const segments = Array.isArray(path) ? path : String(path).split('.').filter(Boolean);
  if (segments.length === 0) return value;
  const copy = cloneValue(root ?? {});
  let cursor = copy;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const next = cursor[segment];
    if (next === null || typeof next !== 'object') {
      cursor[segment] = /^\d+$/u.test(nextSegment) ? [] : {};
    }
    cursor = cursor[segment];
  }
  const finalSegment = segments[segments.length - 1];
  cursor[finalSegment] = value;
  return copy;
}

export function lines(value) {
  return String(value ?? '')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function lineText(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

export function nullableText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

export function integer(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function boolAttribute(value) {
  return value ? ' checked' : '';
}

export function selectedAttribute(value, expected) {
  return value === expected ? ' selected' : '';
}

export function stateTone(state) {
  switch (String(state ?? '').toUpperCase()) {
    case 'READY':
    case 'VALID':
    case 'CLEAR':
      return 'good';
    case 'READY_LOCAL_ONLY':
    case 'NOT_REQUIRED':
    case 'UNVALIDATED':
      return 'local';
    case 'INCOMPLETE':
    case 'DRIFTED':
    case 'TARGET_AMBIGUOUS':
    case 'NO_REMOTE_YET':
      return 'warn';
    case 'BLOCKED':
    case 'INVALID':
    case 'MISSING':
    case 'ORIGIN_FORBIDDEN':
    case 'MODEL_UNAVAILABLE':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function badge(state, label = state) {
  if (state === null || state === undefined || state === '') {
    return '<span class="cfg-badge is-neutral">UNKNOWN</span>';
  }
  return `<span class="cfg-badge is-${stateTone(state)}">${escapeHtml(label)}</span>`;
}

export function shortIdentity(value, size = 14) {
  const text = typeof value === 'string' ? value : '';
  return text === '' ? '—' : `${text.slice(0, size)}${text.length > size ? '…' : ''}`;
}

export function fieldShell({ label, control, note = '', wide = false, status = '' }) {
  return `<label class="cfg-field${wide ? ' is-wide' : ''}">
    <span class="cfg-field-label">${escapeHtml(label)}</span>
    ${control}
    ${note === '' ? '' : `<small>${escapeHtml(note)}</small>`}
    ${status === '' ? '' : `<span class="cfg-field-status">${status}</span>`}
  </label>`;
}

export function textInput(path, value, options = {}) {
  const type = options.type ?? 'text';
  const attributes = [
    `type="${escapeHtml(type)}"`,
    `data-profile-path="${escapeHtml(path)}"`,
    `value="${escapeHtml(value ?? '')}"`,
  ];
  if (options.placeholder) attributes.push(`placeholder="${escapeHtml(options.placeholder)}"`);
  if (options.readonly) attributes.push('readonly');
  if (options.disabled) attributes.push('disabled');
  if (options.inputMode) attributes.push(`inputmode="${escapeHtml(options.inputMode)}"`);
  if (options.min !== undefined) attributes.push(`min="${escapeHtml(options.min)}"`);
  if (options.max !== undefined) attributes.push(`max="${escapeHtml(options.max)}"`);
  return `<input ${attributes.join(' ')} />`;
}

export function textarea(path, value, options = {}) {
  const attributes = [`data-profile-path="${escapeHtml(path)}"`];
  if (options.kind) attributes.push(`data-value-kind="${escapeHtml(options.kind)}"`);
  if (options.placeholder) attributes.push(`placeholder="${escapeHtml(options.placeholder)}"`);
  if (options.rows) attributes.push(`rows="${Number(options.rows)}"`);
  return `<textarea ${attributes.join(' ')}>${escapeHtml(value ?? '')}</textarea>`;
}

export function select(path, value, options, config = {}) {
  const attributes = [`data-profile-path="${escapeHtml(path)}"`];
  if (config.kind) attributes.push(`data-value-kind="${escapeHtml(config.kind)}"`);
  if (config.disabled) attributes.push('disabled');
  return `<select ${attributes.join(' ')}>${options.map((option) => {
    const item = typeof option === 'string' ? { value: option, label: option } : option;
    return `<option value="${escapeHtml(item.value)}"${selectedAttribute(value, item.value)}>${escapeHtml(item.label)}</option>`;
  }).join('')}</select>`;
}

export function checkbox(path, checked, label) {
  return `<label class="cfg-check"><input type="checkbox" data-profile-path="${escapeHtml(path)}" data-value-kind="boolean"${boolAttribute(checked)} /><span>${escapeHtml(label)}</span></label>`;
}

export function operationIdentityOf(record) {
  const profile = record?.profile;
  if (!profile || typeof profile !== 'object') return null;
  const generation = record?.generation;
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  if (typeof profile.projectId !== 'string' || typeof profile.targetRootIdentity !== 'string' || typeof record.projectProfileHash !== 'string') return null;
  return Object.freeze({
    projectId: profile.projectId,
    targetRootIdentity: profile.targetRootIdentity,
    projectProfileHash: record.projectProfileHash,
    profileGeneration: generation,
  });
}

export function sameOperationIdentity(left, right) {
  return Boolean(
    left && right &&
    left.projectId === right.projectId &&
    left.targetRootIdentity === right.targetRootIdentity &&
    left.projectProfileHash === right.projectProfileHash &&
    left.profileGeneration === right.profileGeneration,
  );
}

export function unwrapApiData(value) {
  const body = asObject(value);
  if (body?.ok === true && Object.prototype.hasOwnProperty.call(body, 'data')) return body.data;
  return value;
}
