/** Operation-specific Project Readiness presentation. */

import { badge, escapeHtml } from './viewPrimitives.js';

export const READINESS_OPERATIONS = Object.freeze([
  { value: 'local-proof', label: 'LOCAL PROOF' },
  { value: 'ai-candidate', label: 'AI CANDIDATE GENERATION' },
  { value: 'browser-benchmark', label: 'BROWSER BENCHMARK' },
  { value: 'publication', label: 'GIT PUBLICATION' },
]);

function capabilityRows(readiness) {
  const capabilities = readiness?.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return [];
  return Object.entries(capabilities).map(([name, item]) => ({
    name,
    state: item?.state ?? 'UNKNOWN',
    required: Boolean(item?.required),
    ready: Boolean(item?.ready),
    code: item?.code ?? 'UNKNOWN',
    detail: item?.detail ?? '',
  }));
}

export function renderProjectReadinessPanel(snapshot) {
  const readiness = snapshot.readiness;
  const validation = snapshot.validation;
  const selected = snapshot.selectedRecord;
  const operationOptions = READINESS_OPERATIONS.map((operation) => `<option value="${operation.value}"${snapshot.readinessOperation === operation.value ? ' selected' : ''}>${operation.label}</option>`).join('');
  const capabilities = capabilityRows(readiness);
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
  const level = readiness?.level ?? (selected ? 'UNVALIDATED' : 'INCOMPLETE');

  return `<section class="cfg-card cfg-readiness-card" data-section="project-readiness">
    <header class="cfg-card-head"><div><span class="cfg-kicker">PROJECT READINESS</span><h3>Capability-by-capability execution gate</h3></div>${badge(level)}</header>
    <div class="cfg-readiness-toolbar"><label><span>INTENDED OPERATION</span><select id="cfgReadinessOperation">${operationOptions}</select></label><button type="button" data-cfg-action="read-readiness"${!selected || snapshot.dirty ? ' disabled' : ''}>ASSESS READINESS</button></div>
    <div class="cfg-readiness-summary">
      <div><span>Static profile validation</span>${badge(validation?.state ?? 'UNVALIDATED')}</div>
      <div><span>Ready for local work</span>${badge(readiness ? (readiness.readyForLocalWork ? 'READY' : 'BLOCKED') : 'UNVALIDATED')}</div>
      <div><span>Requested operation</span>${badge(readiness ? (readiness.readyForRequestedOperations ? readiness.level : 'BLOCKED') : 'UNVALIDATED')}</div>
      <div><span>Authority</span>${badge(readiness?.authorityState ?? validation?.authority?.state ?? 'UNVALIDATED')}</div>
      <div><span>Authority conflicts</span>${badge(readiness?.authorityConflictState ?? validation?.authorityConflicts?.state ?? 'UNVALIDATED')}</div>
      <div><span>Benchmark runtime</span>${badge(readiness?.benchmarkRuntimeState ?? validation?.benchmarkRuntime?.state ?? 'UNVALIDATED')}</div>
    </div>
    ${capabilities.length ? `<div class="cfg-capability-grid">${capabilities.map((item) => `<article class="cfg-capability"><div><strong>${escapeHtml(item.name.replace(/([A-Z])/gu, ' $1').toUpperCase())}</strong>${badge(item.state)}</div><p>${escapeHtml(item.code)} · ${escapeHtml(item.detail)}</p><small>${item.required ? 'REQUIRED FOR THIS OPERATION' : 'NOT REQUIRED FOR THIS OPERATION'}</small></article>`).join('')}</div>` : '<p class="cfg-empty-copy">Run an assessment to calculate operation-specific readiness. Optional publication or browser integrations do not block unrelated local work.</p>'}
    ${blockers.length ? `<div class="cfg-blockers" role="alert"><strong>BLOCKERS</strong><ul>${blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join('')}</ul></div>` : ''}
    <p class="cfg-note">READY_LOCAL_ONLY is a valid local proof posture when Git publication is intentionally NO_REMOTE_YET.</p>
  </section>`;
}
