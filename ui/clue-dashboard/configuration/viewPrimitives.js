/** Shared, side-effect-free primitives for the Project Profile Configuration surface. */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderReadinessReceipt(snapshot, capability, legacy = false) {
  const active = snapshot.active;
  const selected = snapshot.selectedRecord;
  if (!legacy && (snapshot.legacyConfiguration?.legacyConnectionControls === true ||
    !active || selected?.profile?.projectId !== active.projectId ||
    selected?.generation !== active.profileGeneration || selected?.projectProfileHash !== active.projectProfileHash)) return '';
  const receipt = snapshot.readinessReceipts?.[capability];
  if (!receipt || typeof receipt.checkedAt !== 'string') return '';
  const date = new Date(receipt.checkedAt);
  if (!Number.isFinite(date.getTime())) return '';
  return `<p class="cfg-note">Last check · ${escapeHtml(String(receipt.state).toUpperCase())} · <time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toLocaleString())}</time></p>`;
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

export function fieldShell({
  label,
  control,
  note = '',
  wide = false,
  status = '',
  path = '',
  error = '',
  warning = '',
  modified = false,
  required = false,
}) {
  const classes = ['cfg-field'];
  if (wide) classes.push('is-wide');
  if (modified) classes.push('is-modified');
  if (error !== '') classes.push('has-error');
  else if (warning !== '') classes.push('has-warning');
  const message = error !== ''
    ? `<span class="cfg-field-error" role="alert">${escapeHtml(error)}</span>`
    : warning !== ''
      ? `<span class="cfg-field-warning">${escapeHtml(warning)}</span>`
      : '';
  return `<label class="${classes.join(' ')}"${path === '' ? '' : ` data-field-path="${escapeHtml(path)}"`}>
    <span class="cfg-field-label">${escapeHtml(label)}${required ? '<em class="cfg-required" title="Required">required</em>' : ''}<i class="cfg-modified-mark" title="Changed — not saved yet" aria-hidden="true"></i></span>
    ${control}
    ${message}
    ${note === '' ? '' : `<small>${escapeHtml(note)}</small>`}
    ${status === '' ? '' : `<span class="cfg-field-status">${status}</span>`}
  </label>`;
}

/**
 * Decorations for one profile field: its inline problem and whether it differs from the saved
 * generation. Both come from facts the panel computed once for this render (`snapshot.issues`,
 * `snapshot.changedPaths`); a snapshot without them simply renders an undecorated field.
 */
export function fieldMeta(snapshot, path) {
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  const issue = issues.find((entry) => entry.path === path) ?? null;
  const changed = Array.isArray(snapshot?.changedPaths) && snapshot.changedPaths.some(
    (candidate) => candidate === path || candidate.startsWith(`${path}.`) || path.startsWith(`${candidate}.`),
  );
  return {
    path,
    error: issue?.severity === 'error' ? issue.message : '',
    warning: issue?.severity === 'warning' ? issue.message : '',
    modified: Boolean(changed),
  };
}

/** One consistent card header: what this section is, in a sentence, and its current state. */
export function sectionHeader({ kicker, title, description = '', badges = '' }) {
  return `<header class="cfg-card-head"><div><span class="cfg-kicker">${escapeHtml(kicker)}</span><h3>${escapeHtml(title)}</h3>${description === '' ? '' : `<p class="cfg-card-lede">${escapeHtml(description)}</p>`}</div>${badges === '' ? '' : `<div class="cfg-badge-row">${badges}</div>`}</header>`;
}

/** A titled group of related fields inside a section. Never a nested <section>. */
export function fieldGroup({ title, description = '', body, id = '' }) {
  return `<div class="cfg-group"${id === '' ? '' : ` data-cfg-group="${escapeHtml(id)}"`}><div class="cfg-group-head"><h4>${escapeHtml(title)}</h4>${description === '' ? '' : `<p>${escapeHtml(description)}</p>`}</div>${body}</div>`;
}

const STATE_EXPLANATIONS = Object.freeze({
  READY: 'Checked and working.',
  VALID: 'Checked: no problems found.',
  CURRENT: 'Matches the files on disk.',
  CLEAR: 'No conflicts.',
  CONNECTED: 'Connected and verified.',
  READY_LOCAL_ONLY: 'Ready for local work. Publishing to a remote is not set up, which is a valid choice.',
  NOT_REQUIRED: 'Not needed for the selected operation.',
  UNVALIDATED: 'Not checked yet in this session.',
  NO_REMOTE_YET: 'No remote repository is registered. Local recognition, proof and Great Book work are unaffected.',
  LOCAL_ONLY: 'This profile works on the local checkout only.',
  REMOTE_REGISTERED: 'A remote repository is registered for this profile.',
  INCOMPLETE: 'Something required is still missing.',
  DRIFTED: 'A bound document changed on disk since it was hashed.',
  TARGET_AMBIGUOUS: 'More than one browser page matches the target, so CLU-E refuses to pick one.',
  BLOCKED: 'A required check failed.',
  INVALID: 'The saved value was refused.',
  MISSING: 'The file or setting could not be found.',
  ORIGIN_FORBIDDEN: 'The page origin is not in this profile’s allowed list.',
  MODEL_UNAVAILABLE: 'The saved model is not available to this credential.',
  TESTING: 'A test is running.',
  PENDING: 'A test has started and has not reported yet.',
  FAILED: 'The last test failed.',
});

/** A plain-language reading of a backend state token. Unknown tokens explain nothing. */
export function stateExplanation(state) {
  const key = String(state ?? '').toUpperCase();
  return Object.hasOwn(STATE_EXPLANATIONS, key) ? STATE_EXPLANATIONS[key] : '';
}

export function stateLine(state) {
  const text = stateExplanation(state);
  return text === '' ? '' : `<p class="cfg-state-line">${escapeHtml(text)}</p>`;
}

export function timeText(value) {
  if (typeof value !== 'string' || value === '') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toLocaleString())}</time>`;
}

/** True while any backend operation for this panel is in flight. */
export function isBusy(snapshot) {
  return !['idle', 'ready'].includes(snapshot?.phase ?? 'idle');
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

/**
 * A setting that either follows the installation default or carries a value of its own.
 *
 * Rendered as a two-way switch with the custom value editable in place. The switch buttons carry
 * the caller's declared actions; the input carries `data-cfg-override`, which the panel turns into
 * a `{ source: 'project-override', defaultKey, value }` draft value.
 */
export function inheritedPathControl({ setting, path, defaultKey, globalAction, overrideAction, name, placeholder = '' }) {
  const override = setting?.source === 'project-override';
  const key = setting?.defaultKey ?? defaultKey;
  const input = override
    ? `<input data-cfg-override="${escapeHtml(path)}" data-default-key="${escapeHtml(key)}" value="${escapeHtml(setting?.value ?? '')}" placeholder="${escapeHtml(placeholder)}" aria-label="Custom ${escapeHtml(name)}" autocomplete="off" spellcheck="false" />`
    : `<input value="${escapeHtml(`GLOBAL DEFAULT · ${key}`)}" readonly aria-label="${escapeHtml(name)} follows the installation default" />`;
  return `<div class="cfg-inherit">
    <div class="cfg-segmented" role="group" aria-label="${escapeHtml(name)} source">
      <button type="button" data-cfg-action="${escapeHtml(globalAction)}" aria-pressed="${override ? 'false' : 'true'}">INSTALLATION DEFAULT</button>
      <button type="button" data-cfg-action="${escapeHtml(overrideAction)}" aria-pressed="${override ? 'true' : 'false'}">CUSTOM PATH</button>
    </div>
    ${input}
  </div>`;
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
