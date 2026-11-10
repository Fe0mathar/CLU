/**
 * Section navigation for the Configuration surface.
 *
 * Each entry shows three independent facts about its section: the state of the thing it configures
 * (from backend evidence already in the snapshot), whether the draft has a problem there, and
 * whether the draft differs from the saved generation there. None of them is inferred — a section
 * nobody has tested says "Not tested".
 */

import { SECTION_GROUPS, searchSections, sectionById, visibleSections } from './sectionRegistry.js';
import { browserCheckOf } from './browserEditor.js';
import { gatewayStateOf } from './gatewayEditor.js';
import { gitStateOf } from './gitEditor.js';
import { hostCheckOf } from './hostEditor.js';
import { escapeHtml, stateTone } from './viewPrimitives.js';

const PROFILE_FREE_SECTIONS = new Set(['project', 'profiles', 'agents', 'metric-catalogue', 'dashboard-layout', 'installation', 'startup']);

/** Sections that have nothing to show until a draft exists are unavailable while one is prepared. */
export function sectionAvailable(id, snapshot) {
  if (snapshot?.draftMode !== 'prepare') return true;
  return PROFILE_FREE_SECTIONS.has(id);
}

function testStatus(state) {
  switch (state) {
    case 'READY': return { tone: 'good', text: 'Passed' };
    case 'FAILED': return { tone: 'bad', text: 'Failed' };
    case 'TESTING': case 'PENDING': return { tone: 'local', text: 'Testing…' };
    case 'UNVALIDATED': return { tone: 'neutral', text: 'Not tested' };
    default: return { tone: stateTone(state), text: state.replaceAll('_', ' ').toLowerCase() };
  }
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The state of what one section configures, from evidence already in the snapshot.
 *
 * @returns {{tone:'good'|'local'|'warn'|'bad'|'neutral', text:string}}
 */
export function sectionStatus(id, snapshot) {
  const none = { tone: 'neutral', text: '' };
  const draft = snapshot?.draft ?? null;
  const validation = snapshot?.validation ?? null;
  switch (id) {
    case 'project':
      if (snapshot?.draftMode === 'prepare') return { tone: 'local', text: 'New' };
      if (!draft) return none;
      return snapshot.draftMode === 'create' ? { tone: 'local', text: 'New' } : { tone: 'good', text: 'Set' };
    case 'project-authority': {
      if (!draft) return none;
      const conflicts = validation?.authorityConflicts;
      if (Array.isArray(conflicts?.unresolved) && conflicts.unresolved.length > 0) return { tone: 'bad', text: 'Conflict' };
      const state = validation?.authority?.state;
      if (state === 'DRIFTED') return { tone: 'warn', text: 'Drifted' };
      if (state === 'CURRENT' || state === 'VALID') return { tone: 'good', text: 'Current' };
      const authority = draft.authority ?? {};
      if (!authority.masterBenchmark) return { tone: 'warn', text: 'No benchmark' };
      const bound = [authority.targetDescription, authority.masterBenchmark, authority.projectIntent].filter(Boolean).length
        + (Array.isArray(authority.additionalDocuments) ? authority.additionalDocuments.length : 0);
      return { tone: 'neutral', text: `${bound} bound` };
    }
    case 'recognition': {
      if (!draft) return none;
      if (validation?.recognitionError) return { tone: 'bad', text: 'Refused' };
      if (validation?.recognition) return { tone: 'good', text: 'Valid' };
      const roots = Array.isArray(draft.recognition?.sourceRoots) ? draft.recognition.sourceRoots.length : 0;
      return { tone: 'neutral', text: plural(roots, 'root') };
    }
    case 'benchmark-runtime': {
      if (!draft) return none;
      const state = validation?.benchmarkRuntime?.state;
      if (state) return { tone: stateTone(state), text: state.replaceAll('_', ' ').toLowerCase() };
      return { tone: 'neutral', text: draft.benchmarkRuntime?.command ? 'Command set' : 'No command' };
    }
    case 'powershell-host': {
      if (!draft) return none;
      if (draft.integrations?.powershell?.autonomousProfile === 'disabled') return { tone: 'neutral', text: 'Off' };
      return testStatus(hostCheckOf(snapshot).state);
    }
    case 'git': {
      if (!draft) return none;
      const state = String(gitStateOf(snapshot));
      if (state === 'CONNECTED') return { tone: 'good', text: 'Connected' };
      if (['READY_LOCAL_ONLY', 'NO_REMOTE_YET', 'LOCAL_ONLY'].includes(state)) return { tone: 'local', text: 'Local only' };
      if (state === 'REMOTE_REGISTERED') return { tone: 'neutral', text: 'Remote set' };
      return testStatus(state);
    }
    case 'browser': {
      if (!draft) return none;
      return testStatus(browserCheckOf(snapshot).state);
    }
    case 'gpt-gateway': {
      if (!draft) return none;
      const { state, check } = gatewayStateOf(snapshot);
      if (draft.integrations?.gpt?.enabled !== true && !check) return { tone: 'neutral', text: 'Off' };
      if (state === 'INVALID') return { tone: 'bad', text: 'Invalid' };
      return testStatus(String(state));
    }
    case 'project-readiness': {
      const level = snapshot?.readiness?.level;
      if (!level) return snapshot?.selectedRecord ? { tone: 'neutral', text: 'Not assessed' } : none;
      return { tone: stateTone(level), text: level.replaceAll('_', ' ').toLowerCase() };
    }
    case 'profiles': {
      const count = Array.isArray(snapshot?.projects) ? snapshot.projects.length : 0;
      return { tone: 'neutral', text: String(count) };
    }
    case 'installation': {
      const startable = snapshot?.legacyConfiguration?.startable;
      if (startable === true) return { tone: 'good', text: 'Startable' };
      if (startable === false) return { tone: 'warn', text: 'Not startable' };
      return none;
    }
    case 'startup':
      return { tone: 'warn', text: 'Legacy' };
    default:
      return none;
  }
}

function navItem(entry, snapshot, hits) {
  const active = snapshot.ui?.section === entry.id;
  const available = sectionAvailable(entry.id, snapshot);
  const issues = Array.isArray(snapshot.issues) ? snapshot.issues.filter((issue) => issue.section === entry.id) : [];
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const changed = Array.isArray(snapshot.changedSections) && snapshot.changedSections.includes(entry.id);
  const status = errors > 0 ? { tone: 'bad', text: `${errors} to fix` } : sectionStatus(entry.id, snapshot);
  const spoken = [entry.label, status.text, changed ? 'unsaved changes' : ''].filter(Boolean).join(', ');
  const title = available ? entry.summary : 'Available once the new profile draft is prepared.';
  return `<li><button type="button" class="cfg-nav-item${active ? ' is-active' : ''}" data-section-target="${entry.id}" data-cfg-action="go-section"${active ? ' aria-current="page"' : ''}${available ? '' : ' disabled'} aria-label="${escapeHtml(spoken)}" title="${escapeHtml(title)}">
      <span class="cfg-nav-dot is-${status.tone}" aria-hidden="true"></span>
      <span class="cfg-nav-label">${escapeHtml(entry.label)}</span>
      ${changed ? '<span class="cfg-nav-changed" aria-hidden="true" title="Unsaved changes"></span>' : ''}
      <span class="cfg-nav-status is-${status.tone}" aria-hidden="true">${escapeHtml(status.text)}</span>
    </button>${hits.length ? `<p class="cfg-nav-hits">${escapeHtml(hits.slice(0, 4).join(' · '))}</p>` : ''}</li>`;
}

/** The grouped section list. Re-rendered alone while the operator types or searches. */
export function renderNavigationList(snapshot) {
  const sections = visibleSections(snapshot);
  const query = String(snapshot.ui?.search ?? '').trim();
  const results = searchSections(query, sections);
  const matched = new Map(results.map((result) => [result.id, result.fields]));
  if (query !== '' && results.length === 0) {
    return `<p class="cfg-nav-empty">No setting matches “${escapeHtml(query)}”.</p><button type="button" class="cfg-nav-clear" data-cfg-action="clear-search">CLEAR SEARCH</button>`;
  }
  return SECTION_GROUPS.map((group) => {
    const entries = sections.filter((entry) => entry.group === group.id && matched.has(entry.id));
    if (entries.length === 0) return '';
    return `<div class="cfg-nav-group"><h4>${escapeHtml(group.label)}</h4><ul>${entries.map((entry) => navItem(entry, snapshot, query === '' ? [] : matched.get(entry.id))).join('')}</ul></div>`;
  }).join('');
}

export function renderNavigation(snapshot) {
  const query = String(snapshot.ui?.search ?? '');
  return `<nav class="cfg-nav" aria-label="Configuration sections" data-cfg-scroll="nav">
    <div class="cfg-nav-search">
      <input id="cfgNavSearch" type="search" value="${escapeHtml(query)}" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false" />
      <kbd aria-hidden="true">/</kbd>
    </div>
    <div data-cfg-region="navlist">${renderNavigationList(snapshot)}</div>
  </nav>`;
}

/** The section to show for this snapshot, correcting one that is unavailable or does not exist. */
export function resolveSection(requested, snapshot) {
  const known = visibleSections(snapshot);
  const entry = sectionById(requested);
  if (snapshot?.draftMode === 'prepare' && !sectionAvailable(requested, snapshot)) return 'project';
  if (!entry || !known.some((candidate) => candidate.id === entry.id)) return 'overview';
  return entry.id;
}
