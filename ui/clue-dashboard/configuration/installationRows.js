/**
 * Installation-readiness rows: what the running dashboard reports about itself.
 *
 * `DEV-P1-17`. A row is one fact with one of three honest shapes — a value, a check, or an absence
 * with its reason. Rendering decides nothing, so the rows are the whole contract.
 */

import { escapeHtml } from './viewPrimitives.js';

function value(label, text) { return { kind: 'value', label, text: String(text) }; }
function absent(label, reason) { return { kind: 'absent', label, reason }; }
function check(label, ok, note) { return { kind: 'check', label, ok: Boolean(ok), ...(note === undefined ? {} : { note }) }; }
function readString(source, key) { const raw = source?.[key]; return typeof raw === 'string' && raw.length > 0 ? raw : null; }

export function configurationRows(config) {
  if (config === null || config === undefined || typeof config !== 'object') {
    return Object.freeze([absent('configuration', 'the daemon returned no configuration body')]);
  }
  const body = config;
  const project = body.project ?? {};
  const rows = [];
  const id = readString(project, 'id');
  rows.push(id === null ? absent('project id', 'the configuration declares no project id') : value('project id', id));
  const root = readString(project, 'root');
  rows.push(root === null ? absent('project root', 'the configuration declares no project root') : check('project root', project.rootPresent, root));
  rows.push(check('tsconfig.json', body.tsconfigPresent));
  rows.push(check('workspace initialised', body.workspaceInitialised));
  const documents = body.trackedDocuments;
  if (!Array.isArray(documents)) rows.push(absent('tracked documents', 'the configuration lists no tracked documents'));
  else for (const document of documents) {
    const path = readString(document, 'path');
    rows.push(path === null ? absent('tracked document', 'a tracked document has no path') : check(path, document?.present));
  }
  const graph = body.committedGraphPointer;
  if (graph === null || graph === undefined || typeof graph !== 'object') rows.push(absent('committed graph', 'no graph has been committed yet'));
  else {
    const hash = readString(graph, 'resultHash');
    const run = readString(graph, 'runId');
    rows.push(hash === null ? absent('committed graph', 'the pointer carries no result hash') : value('committed graph', `${hash.slice(0, 12)} · run ${run === null ? 'unknown' : run.slice(0, 8)}`));
  }
  rows.push(check('startable', body.startable));
  return Object.freeze(rows);
}

export function renderConfigurationRows(rows) {
  return rows.map((row) => {
    const label = escapeHtml(row.label);
    if (row.kind === 'value') return `<div class="row"><span>${label}</span><span class="mono">${escapeHtml(row.text)}</span></div>`;
    if (row.kind === 'check') return `<div class="row"><span>${label}</span><span>${row.note === undefined ? '' : `<span class="mono">${escapeHtml(row.note)}</span> `}${row.ok ? '<span class="ok">OK</span>' : '<span class="fail">FAIL</span>'}</span></div>`;
    if (row.kind === 'absent') return `<div class="row"><span>${label}</span><span class="mono" title="${escapeHtml(row.reason)}">UNKNOWN — ${escapeHtml(row.reason)}</span></div>`;
    return `<div class="row"><span>${label}</span><span class="fail">MALFORMED ROW</span></div>`;
  }).join('');
}
