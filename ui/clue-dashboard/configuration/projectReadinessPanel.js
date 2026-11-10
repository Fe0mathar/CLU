/** Operation-specific Project Readiness presentation. */

import { badge, escapeHtml, isBusy, sectionHeader, stateLine, timeText } from './viewPrimitives.js';

export const READINESS_OPERATIONS = Object.freeze([
  { value: 'local-proof', label: 'LOCAL PROOF', help: 'Recognise, benchmark and prove a change on this machine. Needs no remote and no AI.' },
  { value: 'ai-candidate', label: 'AI CANDIDATE GENERATION', help: 'Let the AI model propose changes. Needs a working key and exact model.' },
  { value: 'browser-benchmark', label: 'BROWSER BENCHMARK', help: 'Measure a page in the dedicated test browser.' },
  { value: 'publication', label: 'GIT PUBLICATION', help: 'Publish accepted work to the registered remote.' },
]);

const CAPABILITY_LABELS = Object.freeze({
  projectIdentity: 'Project identity',
  targetRoot: 'Target folder',
  authority: 'Governing documents',
  recognition: 'Code recognition',
  host: 'Console host',
  gitLocal: 'Local Git checkout',
  proof: 'Proof',
  browserBenchmark: 'Browser benchmark',
  aiCandidateGeneration: 'AI candidate generation',
  gitPublication: 'Git publication',
  custodianLanding: 'Custodian landing',
  metricCatalogue: 'Metric catalogue',
});

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

function capabilityCard(item) {
  const friendly = CAPABILITY_LABELS[item.name] ?? item.name.replace(/([A-Z])/gu, ' $1');
  return `<article class="cfg-capability${item.required ? ' is-required' : ''}${item.required && !item.ready ? ' is-blocking' : ''}"><div><strong title="${escapeHtml(friendly)}">${escapeHtml(item.name.replace(/([A-Z])/gu, ' $1').toUpperCase())}</strong>${badge(item.state)}</div><p>${escapeHtml(item.code)} · ${escapeHtml(item.detail)}</p><small>${item.required ? 'REQUIRED FOR THIS OPERATION' : 'NOT REQUIRED FOR THIS OPERATION'}</small></article>`;
}

export function renderProjectReadinessPanel(snapshot) {
  const readiness = snapshot.readiness;
  const validation = snapshot.validation;
  const selected = snapshot.selectedRecord;
  const current = READINESS_OPERATIONS.find((operation) => operation.value === snapshot.readinessOperation) ?? READINESS_OPERATIONS[0];
  const operationOptions = READINESS_OPERATIONS.map((operation) => `<option value="${operation.value}"${snapshot.readinessOperation === operation.value ? ' selected' : ''}>${operation.label}</option>`).join('');
  const capabilities = capabilityRows(readiness);
  const required = capabilities.filter((item) => item.required);
  const optional = capabilities.filter((item) => !item.required);
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
  const level = readiness?.level ?? (selected ? 'UNVALIDATED' : 'INCOMPLETE');
  const blocked = !selected
    ? 'Select a saved profile to assess it.'
    : snapshot.dirty
      ? 'Save or discard your changes first — readiness is assessed for the saved profile.'
      : '';
  const checkedAt = timeText(readiness?.checkedAt);

  return `<section class="cfg-card cfg-readiness-card" data-section="project-readiness">
    ${sectionHeader({
      kicker: 'PROJECT READINESS',
      title: 'Can this profile do the work you intend?',
      description: 'Readiness is answered for one kind of work at a time, because different work needs different things. A profile without a remote is fully ready for local proof and simply not ready to publish.',
      badges: badge(level, level === 'UNVALIDATED' ? 'NOT ASSESSED' : level),
    })}
    <div class="cfg-readiness-toolbar"><label><span>INTENDED OPERATION</span><select id="cfgReadinessOperation">${operationOptions}</select></label><button type="button" class="is-primary" data-cfg-action="read-readiness"${!selected || snapshot.dirty || isBusy(snapshot) ? ' disabled' : ''}>ASSESS READINESS</button></div>
    <p class="cfg-note">${escapeHtml(current.help)}</p>
    ${blocked === '' ? '' : `<p class="cfg-note">${escapeHtml(blocked)}</p>`}
    ${readiness ? stateLine(level) : ''}
    ${blockers.length ? `<div class="cfg-blockers" role="alert"><strong>BLOCKERS</strong><ul>${blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join('')}</ul></div>` : ''}
    <div class="cfg-readiness-summary">
      <div><span>Static profile validation</span>${badge(validation?.state ?? 'UNVALIDATED')}</div>
      <div><span>Ready for local work</span>${badge(readiness ? (readiness.readyForLocalWork ? 'READY' : 'BLOCKED') : 'UNVALIDATED')}</div>
      <div><span>Requested operation</span>${badge(readiness ? (readiness.readyForRequestedOperations ? readiness.level : 'BLOCKED') : 'UNVALIDATED')}</div>
      <div><span>Authority</span>${badge(readiness?.authorityState ?? validation?.authority?.state ?? 'UNVALIDATED')}</div>
      <div><span>Authority conflicts</span>${badge(readiness?.authorityConflictState ?? validation?.authorityConflicts?.state ?? 'UNVALIDATED')}</div>
      <div><span>Benchmark runtime</span>${badge(readiness?.benchmarkRuntimeState ?? validation?.benchmarkRuntime?.state ?? 'UNVALIDATED')}</div>
    </div>
    ${capabilities.length ? `${required.length ? `<h4 class="cfg-list-title">Needed for ${escapeHtml(current.label.toLowerCase())}</h4><div class="cfg-capability-grid">${required.map(capabilityCard).join('')}</div>` : ''}${optional.length ? `<h4 class="cfg-list-title">Not needed for this operation</h4><div class="cfg-capability-grid is-optional">${optional.map(capabilityCard).join('')}</div>` : ''}` : '<p class="cfg-empty-copy">Run an assessment to calculate operation-specific readiness. Optional publication or browser integrations do not block unrelated local work.</p>'}
    ${checkedAt ? `<p class="cfg-note">Assessed ${checkedAt}</p>` : ''}
    <p class="cfg-note">READY_LOCAL_ONLY is a valid local proof posture when Git publication is intentionally NO_REMOTE_YET.</p>
  </section>`;
}
