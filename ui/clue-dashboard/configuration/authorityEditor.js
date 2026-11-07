/** Project Authority editor: distinguished bindings plus ordered additional governed documents. */

import { badge, escapeHtml, shortIdentity } from './viewPrimitives.js';

export const GOVERNED_DOCUMENT_ROLES = Object.freeze([
  'architecture', 'coding-standard', 'performance', 'security', 'product-requirements',
  'operational-constraint', 'testing', 'deployment', 'creator-instruction',
  'known-limitation', 'other',
]);

const DISTINGUISHED = Object.freeze([
  { field: 'targetDescription', kind: 'target-description', label: 'TARGET DESCRIPTION / CONTEXT', bindingId: 'target-description', role: 'product-requirements', order: 0 },
  { field: 'masterBenchmark', kind: 'master-benchmark', label: 'MASTER BENCHMARK', bindingId: 'master-benchmark', role: 'performance', order: 1 },
  { field: 'projectIntent', kind: 'project-intent', label: 'PROJECT INTENT / CONSTRAINTS', bindingId: 'project-intent', role: 'creator-instruction', order: 2 },
]);

export function nextAdditionalOrder(documents) {
  const values = Array.isArray(documents) ? documents.map((item) => Number(item?.order)).filter(Number.isSafeInteger) : [];
  return Math.max(99, ...values) + 1;
}

export function canonicalAdditionalDocuments(documents) {
  return [...(Array.isArray(documents) ? documents : [])]
    .map((document, index) => ({ ...document, kind: 'additional', order: 100 + index }))
    .sort((left, right) => left.order - right.order || String(left.bindingId).localeCompare(String(right.bindingId)));
}

function bindingStatus(binding) {
  if (!binding) return badge('INCOMPLETE', 'NOT BOUND');
  return `${badge(binding.validationState)}<span class="cfg-hash" title="${escapeHtml(binding.sha256 ?? '')}">${escapeHtml(shortIdentity(binding.sha256, 16))}</span>`;
}

function distinguishedCard(spec, binding, snapshot) {
  const authorityState = snapshot.validation?.authority?.state ?? null;
  const driftedPaths = snapshot.validation?.authority?.issues ?? [];
  const drifted = Array.isArray(driftedPaths) && driftedPaths.some((issue) => String(issue?.bindingId ?? issue?.path ?? '').includes(binding?.bindingId ?? '__none__'));
  return `<article class="cfg-authority-binding${drifted ? ' is-drifted' : ''}">
    <div class="cfg-authority-title"><span>${escapeHtml(spec.label)}</span><div>${bindingStatus(binding)}${drifted ? badge('DRIFTED') : ''}</div></div>
    ${binding ? `<dl class="cfg-binding-facts"><div><dt>Path</dt><dd title="${escapeHtml(binding.canonicalPath)}">${escapeHtml(binding.path)}</dd></div><div><dt>Role</dt><dd>${escapeHtml(binding.role)}</dd></div><div><dt>Order</dt><dd>${binding.order}</dd></div></dl>` : '<p class="cfg-empty-copy">No governed Markdown document is bound.</p>'}
    <div class="cfg-action-row"><button type="button" data-cfg-action="prepare-distinguished-document" data-authority-field="${spec.field}" data-authority-kind="${spec.kind}" data-binding-id="${spec.bindingId}" data-binding-role="${spec.role}" data-binding-order="${spec.order}">${binding ? 'REPLACE' : 'SELECT .MD'}</button><button type="button" data-cfg-action="remove-distinguished-document" data-authority-field="${spec.field}"${binding ? '' : ' disabled'}>REMOVE</button></div>
    ${spec.kind === 'master-benchmark' ? '<p class="cfg-note">Proof readiness remains incomplete until a valid Master Benchmark is bound.</p>' : ''}
    ${authorityState ? `<span class="cfg-sr-only">Authority state ${escapeHtml(authorityState)}</span>` : ''}
  </article>`;
}

function roleOptions(value) {
  return GOVERNED_DOCUMENT_ROLES.map((role) => `<option value="${role}"${role === value ? ' selected' : ''}>${escapeHtml(role.replaceAll('-', ' ').toUpperCase())}</option>`).join('');
}

function additionalRow(binding, index, count) {
  return `<article class="cfg-governed-row" data-binding-id="${escapeHtml(binding.bindingId)}">
    <div class="cfg-governed-main"><strong>${escapeHtml(binding.bindingId)}</strong><span title="${escapeHtml(binding.canonicalPath)}">${escapeHtml(binding.path)}</span><span class="cfg-hash" title="${escapeHtml(binding.sha256)}">${escapeHtml(shortIdentity(binding.sha256, 18))}</span></div>
    <div class="cfg-governed-controls">
      <select data-additional-role-index="${index}" aria-label="Role for ${escapeHtml(binding.bindingId)}">${roleOptions(binding.role)}</select>
      <label class="cfg-mini-check"><input type="checkbox" data-additional-enabled-index="${index}"${binding.enabled ? ' checked' : ''} /> enabled</label>
      ${badge(binding.validationState)}
      <button type="button" data-cfg-action="move-additional-up" data-additional-index="${index}"${index === 0 ? ' disabled' : ''} aria-label="Move ${escapeHtml(binding.bindingId)} up">↑</button>
      <button type="button" data-cfg-action="move-additional-down" data-additional-index="${index}"${index === count - 1 ? ' disabled' : ''} aria-label="Move ${escapeHtml(binding.bindingId)} down">↓</button>
      <button type="button" data-cfg-action="remove-additional-document" data-additional-index="${index}" class="is-danger">REMOVE</button>
    </div>
  </article>`;
}

export function renderAuthorityEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return '<section class="cfg-card cfg-authority-card" data-section="project-authority"><header class="cfg-card-head"><div><span class="cfg-kicker">PROJECT AUTHORITY</span><h3>Governed project documents</h3></div></header><p class="cfg-empty-copy">Create or select a Project Profile to bind its Target Description, Master Benchmark, Project Intent and additional Markdown documents.</p></section>';
  const authority = profile.authority ?? {};
  const additional = Array.isArray(authority.additionalDocuments) ? authority.additionalDocuments : [];
  const conflict = snapshot.validation?.authorityConflicts ?? null;
  const authorityState = snapshot.validation?.authority?.state ?? (snapshot.dirty ? 'UNVALIDATED' : null);
  const conflicts = [
    ...(Array.isArray(conflict?.unresolved) ? conflict.unresolved : []),
    ...(Array.isArray(conflict?.staleResolutions) ? conflict.staleResolutions : []),
  ];

  return `<section class="cfg-card cfg-authority-card" data-section="project-authority">
    <header class="cfg-card-head"><div><span class="cfg-kicker">PROJECT AUTHORITY</span><h3>Governed project meaning and proof basis</h3></div><div class="cfg-badge-row">${badge(authorityState ?? 'UNVALIDATED')}${conflict ? badge(conflict.state) : ''}</div></header>
    <p class="cfg-card-copy">The backend resolves exact paths and SHA-256 hashes. Modified documents create a new authority basis; they are never silently absorbed into an active proof cycle.</p>
    <div class="cfg-authority-grid">${DISTINGUISHED.map((spec) => distinguishedCard(spec, authority[spec.field] ?? null, snapshot)).join('')}</div>
    <div class="cfg-subsection-head"><div><h4>ADDITIONAL GOVERNED DOCUMENTS</h4><p>Deterministic order starts at 100. Disabled documents remain in the profile but leave the active authority basis.</p></div>${badge(additional.length ? 'VALID' : 'NOT_REQUIRED', `${additional.length} BOUND`)}</div>
    <div class="cfg-add-document">
      <input id="cfgAdditionalDocumentPath" placeholder="relative/or absolute path to .md" aria-label="Additional governed document path" />
      <input id="cfgAdditionalBindingId" placeholder="binding-id (optional)" aria-label="Additional document binding ID" />
      <select id="cfgAdditionalRole" aria-label="Additional governed document role">${roleOptions('other')}</select>
      <label class="cfg-mini-check"><input id="cfgAdditionalEnabled" type="checkbox" checked /> enabled</label>
      <button type="button" data-cfg-action="add-additional-document">ADD & HASH</button>
    </div>
    <div class="cfg-governed-list">${additional.length ? additional.map((binding, index) => additionalRow(binding, index, additional.length)).join('') : '<p class="cfg-empty-copy">No additional governed documents.</p>'}</div>
    ${conflicts.length ? `<div class="cfg-conflict" role="alert"><strong>AUTHORITY CONFLICT — FAIL CLOSED</strong><ul>${conflicts.map((item) => `<li>${escapeHtml(item.description ?? item.conflictId ?? String(item))}</li>`).join('')}</ul></div>` : ''}
  </section>`;
}

/** Returns the immutable definition for one distinguished authority field. */
export function distinguishedSpec(field) {
  return DISTINGUISHED.find((item) => item.field === field) ?? null;
}

/** Backward-compatible name used by the Configuration controller. */
export function distinguishedDocumentDescriptor(field) {
  return distinguishedSpec(field);
}
