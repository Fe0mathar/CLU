/**
 * The Configuration shell as markup: context bar, sidebar, one section pane at a time, save bar,
 * and the open dialog. Pure functions of the view snapshot the panel builds; no state, no events.
 */

import { renderAuthorityEditor } from './authorityEditor.js';
import { renderBenchmarkRuntimeEditor } from './benchmarkRuntimeEditor.js';
import { renderBrowserEditor } from './browserEditor.js';
import { renderDialog } from './configurationDialogs.js';
import { recordMatchesActive } from './configurationState.js';
import { renderGatewayEditor } from './gatewayEditor.js';
import { renderGitEditor } from './gitEditor.js';
import { renderHostEditor } from './hostEditor.js';
import { renderNavigation } from './navigation.js';
import { renderInstallationHealth, renderOverview } from './overviewPanel.js';
import { renderProjectEditor } from './projectEditor.js';
import { renderProjectReadinessPanel } from './projectReadinessPanel.js';
import { renderProfilesIndex, renderProjectSelector, renderRelationBanner, renderStartupBinding } from './projectSelector.js';
import { renderRecognitionEditor } from './recognitionEditor.js';
import { CAPABILITY_SECTIONS, sectionById, visibleSections } from './sectionRegistry.js';
import { escapeHtml, isBusy, sectionHeader } from './viewPrimitives.js';

const PHASE_LABELS = Object.freeze({
  'loading-projects': 'Loading profiles…',
  'loading-project': 'Opening profile…',
  'preparing-project': 'Resolving folders…',
  'preparing-document': 'Resolving and hashing the document…',
  'validating-project': 'Validating the saved profile…',
  'reading-readiness': 'Assessing readiness…',
  'saving-project': 'Saving…',
  'creating-project': 'Creating the profile…',
  'deleting-project': 'Deleting the profile…',
  'activating-project': 'Activating…',
  'testing-console': 'Testing the console host…',
  'testing-chrome': 'Testing the browser…',
  'testing-git': 'Checking the local checkout…',
  'testing-gateway': 'Testing the AI connection…',
  'opening-github-sign-in': 'Opening GitHub sign-in on the host…',
  'listing-github-repositories': 'Listing repositories…',
  'connecting-github': 'Connecting the repository…',
  'reading-gateway-models': 'Loading models…',
  'checking-windows-key': 'Checking the saved key…',
  'waiting-for-windows-key-prompt': 'Waiting for the Windows key prompt…',
});

export function phaseLabel(phase) {
  if (Object.hasOwn(PHASE_LABELS, phase)) return PHASE_LABELS[phase];
  return `${String(phase ?? 'working').replaceAll('-', ' ')}…`;
}

function errorsOf(snapshot) {
  return (Array.isArray(snapshot.issues) ? snapshot.issues : []).filter((issue) => issue.severity === 'error');
}

function renderMetricCatalogue(catalogue) {
  const current = catalogue.activeSource || 'canonical';
  const list = Array.isArray(catalogue.entries) ? catalogue.entries : null;
  const defaultOption = `<option value="canonical"${current === 'canonical' ? ' selected' : ''}>Default Metric Catalogue</option>`;
  const options = defaultOption + (list === null
    ? '<option value="" disabled>SERVER LIST UNAVAILABLE</option>'
    : list.length === 0
      ? '<option value="">NO SERVER CATALOGUES</option>'
      : `<option value=""${current === 'canonical' ? '' : ' selected'}>— SERVER CATALOGUE —</option>${list.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.catalogueId || entry.id)} (${escapeHtml(entry.metricCount ?? '?')})</option>`).join('')}`);
  return `<section class="cfg-card cfg-metric-card" data-section="metric-catalogue">
    ${sectionHeader({
      kicker: 'METRIC CATALOGUE',
      title: 'Global measurement authority',
      description: 'The list of measures CLU-E can take. It belongs to the installation, not to a profile, so every profile is judged against the same catalogue.',
      badges: '<span class="cfg-badge is-good">UNCHANGED</span>',
    })}
    <p class="cfg-card-copy">The Metric Catalogue remains installation-global. Project Authority does not duplicate or override it.</p>
    <div class="cfg-catalogue-controls"><span class="cfg-hash">ACTIVE · ${escapeHtml(current)}</span><select id="cfgCatalogueSelector" aria-label="Preview a catalogue">${options}</select><button type="button" data-cfg-action="local-catalogue">LOCAL .JSON…</button></div>
    <p class="cfg-note">Choosing a catalogue here opens a preview in this browser tab. Deploying one is a catalogue revision on the server, not a switch made from this page.</p>
  </section>`;
}

/** The id the dashboard shell gives its window-composition control. */
export const HOSTED_LAYOUT_CONTROL_ID = 'clue-layout-switch';

/**
 * Dashboard layout: a section for a control this surface does not own.
 *
 * The dashboard shell creates the WINDOW COMPOSITION switch, keeps its state and handles its
 * clicks. It places the control at the top of the Configuration panel; the panel moves that same
 * element into the slot below so the setting has a name, an explanation and a place in the
 * navigation. Nothing about how it works changes, and its state is read from the control itself.
 */
function renderDashboardLayout() {
  return `<section class="cfg-card" data-section="dashboard-layout">
    ${sectionHeader({
      kicker: 'DASHBOARD LAYOUT',
      title: 'How the four quadrants are arranged',
      description: 'A setting of this browser window, not of a profile. It applies immediately and is not part of what SAVE writes.',
    })}
    <div class="cfg-group">
      <div class="cfg-group-head"><h4>Window composition</h4></div>
      <div class="cfg-layout-slot" data-cfg-slot="layout-switch"><p class="cfg-empty-copy" data-cfg-slot-fallback>The dashboard shell has not provided its window-composition control on this page.</p></div>
      <dl class="cfg-definition">
        <div><dt>Fixed</dt><dd>The authored 2 × 2 grid: Q1 System Navigator, Q2 Great Book, Q3 Instrument Cluster, Q4 Operational Console.</dd></div>
        <div><dt>Dynamic</dt><dd>Each quadrant becomes a window you can move by its header, resize by its edges and hide with its red ×. Switching back to Fixed restores the grid.</dd></div>
      </dl>
    </div>
  </section>`;
}

function renderAgents() {
  return `<section class="cfg-card" data-section="agents" tabindex="-1">
    ${sectionHeader({
      kicker: 'AGENTS',
      title: 'CLU-E operator agent',
      description: 'Identity, model and controls for the agent serving the running dashboard. Profile drafts are saved separately.',
    })}
    <div data-cfg-slot="agents"><p class="cfg-empty-copy" data-cfg-slot-fallback>The operator agent is unavailable on this dashboard.</p></div>
  </section>`;
}

function renderNotice(snapshot) {
  if (!snapshot.notice) return '';
  const tone = ['good', 'bad', 'local'].includes(snapshot.notice.tone) ? snapshot.notice.tone : 'neutral';
  return `<div class="cfg-notice is-${tone}" role="${tone === 'bad' ? 'alert' : 'status'}"><span>${escapeHtml(snapshot.notice.message)}</span><button type="button" class="cfg-notice-close" data-cfg-action="dismiss-notice" aria-label="Dismiss this message">×</button></div>`;
}

function renderPaneIssues(sectionId, snapshot) {
  const issues = (Array.isArray(snapshot.issues) ? snapshot.issues : []).filter((issue) => issue.section === sectionId);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length === 0) return '';
  return `<div class="cfg-pane-issues" role="alert"><strong>${errors.length} problem${errors.length === 1 ? '' : 's'} to fix in this section</strong><ul>${errors.map((issue) => `<li><button type="button" class="cfg-link" data-cfg-action="go-issue" data-section-target="${escapeHtml(issue.section)}" data-issue-path="${escapeHtml(issue.path)}">${escapeHtml(issue.message)}</button></li>`).join('')}</ul></div>`;
}

const SECTION_RENDERERS = Object.freeze({
  overview: (snapshot) => renderOverview(snapshot),
  project: (snapshot) => renderProjectEditor(snapshot, { actions: false }),
  'project-authority': (snapshot) => renderAuthorityEditor(snapshot),
  recognition: (snapshot) => renderRecognitionEditor(snapshot),
  'benchmark-runtime': (snapshot) => renderBenchmarkRuntimeEditor(snapshot),
  'powershell-host': (snapshot) => renderHostEditor(snapshot),
  git: (snapshot) => renderGitEditor(snapshot),
  browser: (snapshot) => renderBrowserEditor(snapshot),
  'gpt-gateway': (snapshot) => renderGatewayEditor(snapshot),
  'project-readiness': (snapshot) => renderProjectReadinessPanel(snapshot),
  profiles: (snapshot) => renderProfilesIndex(snapshot),
  agents: () => renderAgents(),
  'metric-catalogue': (snapshot, catalogue) => renderMetricCatalogue(catalogue),
  'dashboard-layout': () => renderDashboardLayout(),
  installation: (snapshot) => renderInstallationHealth(snapshot),
  startup: (snapshot) => renderStartupBinding(snapshot),
});

function renderPane(entry, snapshot, catalogue) {
  const active = snapshot.ui.section === entry.id;
  const capability = Object.keys(CAPABILITY_SECTIONS).find((key) => CAPABILITY_SECTIONS[key] === entry.id);
  const ribbon = capability ? snapshot.ui.ribbonChecks?.[capability] : null;
  const body = SECTION_RENDERERS[entry.id]?.(snapshot, catalogue) ?? '';
  return `<div class="cfg-pane" data-pane="${entry.id}"${active ? '' : ' hidden'}>
    ${ribbon ? `<p class="cfg-connection-detail cfg-ribbon-check" role="status">Ribbon check · ${escapeHtml(ribbon)}</p>` : ''}
    ${renderPaneIssues(entry.id, snapshot)}
    ${body}
  </div>`;
}

/** The contents of the save bar. Re-rendered alone while the operator types. */
export function renderSaveBar(snapshot) {
  const mode = snapshot.draftMode ?? 'none';
  const busy = isBusy(snapshot);
  const errors = errorsOf(snapshot);
  const changes = Array.isArray(snapshot.changes) ? snapshot.changes : [];
  const record = snapshot.selectedRecord ?? null;
  const creating = mode === 'create';
  const dirtyUpdate = mode === 'update' && snapshot.dirty === true && changes.length > 0;
  const canSave = Boolean(snapshot.draft) && !busy && errors.length === 0 && (creating || dirtyUpdate);
  const running = recordMatchesActive(record, snapshot.active);

  let tone = 'neutral';
  let headline = 'No profile open.';
  let detail = '';
  if (busy) {
    tone = 'local';
    headline = phaseLabel(snapshot.phase);
  } else if (mode === 'prepare') {
    tone = 'local';
    headline = 'New profile · step 1 of 2';
    detail = 'Resolve the folders to get a draft you can review.';
  } else if (creating) {
    tone = errors.length ? 'bad' : 'warn';
    headline = 'New profile · step 2 of 2 · not saved yet';
    detail = errors.length ? '' : 'Review the sections, then create it.';
  } else if (dirtyUpdate) {
    tone = errors.length ? 'bad' : 'warn';
    const sections = (snapshot.changedSections ?? []).map((id) => sectionById(id)?.label ?? id);
    headline = `${changes.length} unsaved change${changes.length === 1 ? '' : 's'}`;
    detail = `in ${sections.join(', ')}${running ? ' · this is the running profile: a save takes effect after a dashboard restart' : ''}`;
  } else if (record) {
    tone = 'good';
    headline = 'All changes saved';
    detail = `generation ${record.generation}`;
  }

  const problem = errors.length === 0 || busy ? '' : `<button type="button" class="cfg-savebar-problems" data-cfg-action="go-issue" data-section-target="${escapeHtml(errors[0].section)}" data-issue-path="${escapeHtml(errors[0].path)}" title="${escapeHtml(errors[0].message)}">${errors.length} problem${errors.length === 1 ? '' : 's'} to fix</button>`;
  const discard = mode === 'prepare' || creating
    ? `<button type="button" data-cfg-action="discard-draft"${busy ? ' disabled' : ''}>DISCARD DRAFT</button>`
    : `<button type="button" data-cfg-action="discard-draft"${dirtyUpdate && !busy ? '' : ' disabled'}>DISCARD</button>`;

  return `<div class="cfg-savebar-status is-${tone}" role="status" aria-live="polite"><span class="cfg-savebar-dot" aria-hidden="true"></span><strong>${escapeHtml(headline)}</strong>${detail === '' ? '' : `<span>${escapeHtml(detail)}</span>`}${problem}</div>
    <div class="cfg-savebar-actions">
      ${dirtyUpdate ? `<button type="button" data-cfg-action="open-changes"${busy ? ' disabled' : ''}>REVIEW CHANGES</button>` : ''}
      ${discard}
      <button type="button" class="is-primary" data-cfg-action="save-profile"${canSave ? '' : ' disabled'} title="Ctrl+S">${creating ? 'CREATE PROFILE' : 'SAVE CHANGES'}</button>
    </div>`;
}

export function renderShell(snapshot, catalogue) {
  const busy = isBusy(snapshot);
  const sections = visibleSections(snapshot);
  // tabindex="-1": a click on empty space keeps keyboard focus inside the surface, so its
  // shortcuts (/, Ctrl+S, Escape) keep working without first clicking a control.
  return `<div class="cfg-shell" tabindex="-1" data-phase="${escapeHtml(snapshot.phase)}" data-active-section="${escapeHtml(snapshot.ui.section)}" aria-busy="${busy}">
    <div class="cfg-progress"${busy ? '' : ' hidden'} aria-hidden="true"></div>
    <div class="cfg-topbar" data-cfg-region="topbar">${renderProjectSelector(snapshot)}</div>
    <div class="cfg-body">
      ${renderNavigation(snapshot)}
      <div class="cfg-main" data-cfg-scroll="main">
        ${renderNotice(snapshot)}
        ${renderRelationBanner(snapshot)}
        ${sections.map((entry) => renderPane(entry, snapshot, catalogue)).join('')}
      </div>
    </div>
    <footer class="cfg-savebar" data-cfg-region="savebar">${renderSaveBar(snapshot)}</footer>
    ${renderDialog(snapshot)}
  </div>`;
}
