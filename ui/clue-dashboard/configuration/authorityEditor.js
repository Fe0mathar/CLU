/** Project Authority editor: distinguished bindings plus ordered additional governed documents. */

import { badge, escapeHtml, fieldGroup, isBusy, sectionHeader, shortIdentity, stateLine, timeText } from './viewPrimitives.js';

export const GOVERNED_DOCUMENT_ROLES = Object.freeze([
  'architecture', 'coding-standard', 'performance', 'security', 'product-requirements',
  'operational-constraint', 'testing', 'deployment', 'creator-instruction',
  'known-limitation', 'other',
]);

const DISTINGUISHED = Object.freeze([
  {
    field: 'targetDescription', kind: 'target-description', label: 'TARGET DESCRIPTION / CONTEXT', bindingId: 'target-description', role: 'product-requirements', order: 0,
    purpose: 'What the target program is and what it is for. CLU-E reads this before it judges anything.',
    placeholder: 'target description.md',
  },
  {
    field: 'masterBenchmark', kind: 'master-benchmark', label: 'MASTER BENCHMARK', bindingId: 'master-benchmark', role: 'performance', order: 1,
    purpose: 'How the whole program is measured at the start and end of every cycle. Required for proof.',
    placeholder: 'targets/clu/benchmark/master-benchmark.md',
  },
  {
    field: 'projectIntent', kind: 'project-intent', label: 'PROJECT INTENT / CONSTRAINTS', bindingId: 'project-intent', role: 'creator-instruction', order: 2,
    purpose: 'Optional. Standing instructions and limits you want every cycle to respect.',
    placeholder: 'docs/project-intent.md',
  },
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

/** The id of the path input that belongs to one distinguished binding. */
export function distinguishedPathInputId(field) {
  return `cfgAuthorityPath-${field}`;
}

function distinguishedCard(spec, binding, snapshot) {
  const authorityState = snapshot.validation?.authority?.state ?? null;
  const driftedPaths = snapshot.validation?.authority?.issues ?? [];
  const drifted = Array.isArray(driftedPaths) && driftedPaths.some((issue) => String(issue?.bindingId ?? issue?.path ?? '').includes(binding?.bindingId ?? '__none__'));
  const busy = isBusy(snapshot);
  const inputId = distinguishedPathInputId(spec.field);
  const validated = binding ? timeText(binding.lastValidated) : '';
  return `<article class="cfg-authority-binding${drifted ? ' is-drifted' : ''}${binding ? '' : ' is-unbound'}" data-authority-field="${spec.field}">
    <div class="cfg-authority-title"><span>${escapeHtml(spec.label)}</span><div>${bindingStatus(binding)}${drifted ? badge('DRIFTED') : ''}</div></div>
    <p class="cfg-authority-purpose">${escapeHtml(spec.purpose)}</p>
    ${binding ? `<dl class="cfg-binding-facts"><div><dt>Path</dt><dd title="${escapeHtml(binding.canonicalPath)}">${escapeHtml(binding.path)}</dd></div><div><dt>Role</dt><dd>${escapeHtml(binding.role)}</dd></div><div><dt>Order</dt><dd>${binding.order}</dd></div>${validated ? `<div><dt>Hashed</dt><dd>${validated}</dd></div>` : ''}</dl>` : '<p class="cfg-empty-copy">No governed Markdown document is bound.</p>'}
    ${drifted ? '<p class="cfg-field-warning">The file changed on disk after it was hashed. Bind it again to accept the new content as authority.</p>' : ''}
    <div class="cfg-bind-row">
      <input id="${inputId}" data-cfg-transient placeholder="${escapeHtml(spec.placeholder)}" aria-label="Path of the ${escapeHtml(spec.label.toLowerCase())} Markdown file" autocomplete="off" spellcheck="false" />
      <button type="button" data-cfg-action="prepare-distinguished-document" data-authority-field="${spec.field}" data-authority-kind="${spec.kind}" data-binding-id="${spec.bindingId}" data-binding-role="${spec.role}" data-binding-order="${spec.order}"${busy ? ' disabled' : ''}>${binding ? 'REPLACE' : 'BIND & HASH'}</button>
      <button type="button" data-cfg-action="remove-distinguished-document" data-authority-field="${spec.field}"${binding && !busy ? '' : ' disabled'}>REMOVE</button>
    </div>
    ${spec.kind === 'master-benchmark' && !binding ? '<p class="cfg-note">Proof readiness remains incomplete until a valid Master Benchmark is bound.</p>' : ''}
    ${authorityState ? `<span class="cfg-sr-only">Authority state ${escapeHtml(authorityState)}</span>` : ''}
  </article>`;
}

function roleOptions(value) {
  return GOVERNED_DOCUMENT_ROLES.map((role) => `<option value="${role}"${role === value ? ' selected' : ''}>${escapeHtml(role.replaceAll('-', ' ').toUpperCase())}</option>`).join('');
}

function additionalRow(binding, index, count) {
  return `<article class="cfg-governed-row${binding.enabled ? '' : ' is-disabled'}" data-binding-id="${escapeHtml(binding.bindingId)}">
    <div class="cfg-governed-main"><strong>${escapeHtml(binding.bindingId)}</strong><span title="${escapeHtml(binding.canonicalPath)}">${escapeHtml(binding.path)}</span><span class="cfg-hash" title="${escapeHtml(binding.sha256)}">${escapeHtml(shortIdentity(binding.sha256, 18))}</span></div>
    <div class="cfg-governed-controls">
      <select data-additional-role-index="${index}" aria-label="Role for ${escapeHtml(binding.bindingId)}">${roleOptions(binding.role)}</select>
      <label class="cfg-mini-check"><input type="checkbox" data-additional-enabled-index="${index}"${binding.enabled ? ' checked' : ''} /> enabled</label>
      ${badge(binding.validationState)}
      <button type="button" data-cfg-action="move-additional-up" data-additional-index="${index}"${index === 0 ? ' disabled' : ''} aria-label="Move ${escapeHtml(binding.bindingId)} up" title="Move up">↑</button>
      <button type="button" data-cfg-action="move-additional-down" data-additional-index="${index}"${index === count - 1 ? ' disabled' : ''} aria-label="Move ${escapeHtml(binding.bindingId)} down" title="Move down">↓</button>
      <button type="button" data-cfg-action="remove-additional-document" data-additional-index="${index}" class="is-danger">REMOVE</button>
    </div>
  </article>`;
}

export function renderAuthorityEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return `<section class="cfg-card cfg-authority-card" data-section="project-authority">${sectionHeader({ kicker: 'PROJECT AUTHORITY', title: 'Governed project documents' })}<p class="cfg-empty-copy">Create or select a Project Profile to bind its Target Description, Master Benchmark, Project Intent and additional Markdown documents.</p></section>`;
  const authority = profile.authority ?? {};
  const additional = Array.isArray(authority.additionalDocuments) ? authority.additionalDocuments : [];
  const conflict = snapshot.validation?.authorityConflicts ?? null;
  const authorityState = snapshot.validation?.authority?.state ?? (snapshot.dirty ? 'UNVALIDATED' : null);
  const conflicts = [
    ...(Array.isArray(conflict?.unresolved) ? conflict.unresolved : []),
    ...(Array.isArray(conflict?.staleResolutions) ? conflict.staleResolutions : []),
  ];
  const busy = isBusy(snapshot);

  return `<section class="cfg-card cfg-authority-card" data-section="project-authority">
    ${sectionHeader({
      kicker: 'GOVERNING DOCUMENTS',
      title: 'What the target is for, and how it is judged',
      description: 'Bind the Markdown files CLU-E must treat as authority. Type a path relative to the Target Root (or absolute); the backend resolves it and records its SHA-256. A bound file that later changes is reported as drift and is never silently absorbed into a running proof cycle.',
      badges: `${authorityState ? badge(authorityState) : badge('UNVALIDATED', 'NOT CHECKED')}${conflict ? badge(conflict.state) : ''}`,
    })}
    ${conflicts.length ? `<div class="cfg-conflict" role="alert"><strong>AUTHORITY CONFLICT — FAIL CLOSED</strong><p>Two governed documents disagree. Work that depends on them stays blocked until the conflict is resolved.</p><ul>${conflicts.map((item) => `<li>${escapeHtml(item.description ?? item.conflictId ?? String(item))}</li>`).join('')}</ul></div>` : ''}
    ${stateLine(authorityState)}
    ${fieldGroup({
      title: 'Core documents',
      description: 'Three fixed roles, always in this order.',
      body: `<div class="cfg-authority-grid">${DISTINGUISHED.map((spec) => distinguishedCard(spec, authority[spec.field] ?? null, snapshot)).join('')}</div>`,
    })}
    <div class="cfg-group">
      <div class="cfg-subsection-head"><div><h4>Additional governed documents</h4><p>Any other Markdown file that should carry authority — architecture notes, coding standards, known limitations. Order decides precedence and starts at 100. A disabled document stays listed but leaves the active authority basis.</p></div>${badge(additional.length ? 'VALID' : 'NOT_REQUIRED', `${additional.length} BOUND`)}</div>
      <div class="cfg-governed-list">${additional.length ? additional.map((binding, index) => additionalRow(binding, index, additional.length)).join('') : '<p class="cfg-empty-copy">No additional governed documents.</p>'}</div>
      <div class="cfg-add-document">
        <input id="cfgAdditionalDocumentPath" data-cfg-transient placeholder="relative/or absolute path to .md" aria-label="Additional governed document path" autocomplete="off" spellcheck="false" />
        <input id="cfgAdditionalBindingId" data-cfg-transient placeholder="binding-id (optional)" aria-label="Additional document binding ID" autocomplete="off" spellcheck="false" />
        <select id="cfgAdditionalRole" data-cfg-transient aria-label="Additional governed document role">${roleOptions('other')}</select>
        <label class="cfg-mini-check"><input id="cfgAdditionalEnabled" data-cfg-transient type="checkbox" checked /> enabled</label>
        <button type="button" data-cfg-action="add-additional-document"${busy ? ' disabled' : ''}>ADD & HASH</button>
      </div>
    </div>
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
