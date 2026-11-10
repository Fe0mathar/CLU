/**
 * Configuration UX patch 01 — navigation, unsaved-change review, inline problems, dialogs and
 * render timing.
 *
 * These run without a browser. The panel is mounted on small fakes: a "string" root (as the
 * existing suites use) to assert on rendered markup, and a "live" root that looks enough like an
 * element to switch on the timing rules that only matter in a browser.
 */

import assert from 'node:assert/strict';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createActionClient } from '../configuration/actionContracts.js';
import { renderAuthorityEditor } from '../configuration/authorityEditor.js';
import { renderBenchmarkRuntimeEditor } from '../configuration/benchmarkRuntimeEditor.js';
import { renderBrowserEditor } from '../configuration/browserEditor.js';
import { exactDeletePhrase } from '../configuration/configurationDialogs.js';
import { mountConfigurationPanel } from '../configuration/configurationPanel.js';
import { changedSections, draftChanges, formatValue, labelOfPath, sameValue, sectionOfPath } from '../configuration/draftChanges.js';
import { blockingProblems, draftIssues } from '../configuration/draftIssues.js';
import { renderGatewayEditor } from '../configuration/gatewayEditor.js';
import { renderGitEditor } from '../configuration/gitEditor.js';
import { renderHostEditor } from '../configuration/hostEditor.js';
import { resolveSection, sectionAvailable, sectionStatus } from '../configuration/navigation.js';
import { nextStep } from '../configuration/overviewPanel.js';
import { projectDraftProblems, renderProjectEditor, suggestSiblingPath } from '../configuration/projectEditor.js';
import { renderRelationBanner } from '../configuration/projectSelector.js';
import { renderRecognitionEditor } from '../configuration/recognitionEditor.js';
import { CAPABILITY_SECTIONS, FIELD_CATALOGUE, SECTIONS, searchSections, visibleSections } from '../configuration/sectionRegistry.js';
import { captureContinuity, restoreContinuity } from '../configuration/uiContinuity.js';
import { metadata, pointer, profile, record, snapshot } from './projectProfileUiFixture.mjs';

/* ------------------------------------------------------------------ helpers */

function backend(overrides = {}) {
  const store = new Map([['alpha', record('alpha')], ['beta', record('beta')]]);
  let active = pointer('alpha');
  const calls = [];
  const actionClient = createActionClient({ request: async (request) => {
    calls.push(request);
    const key = `${request.method} ${request.path}`;
    if (Object.hasOwn(overrides, key)) return overrides[key](request, { store, calls });
    const project = request.path.match(/^\/api\/projects\/([a-z]+)(\/.*)?$/u);
    if (key === 'GET /api/config') return { projectProfiles: { runtimeMode: 'project-profile' } };
    if (key === 'GET /api/projects') return { active, projects: [...store.values()].map((entry) => metadata(entry.profile.projectId, entry.generation)), registryGeneration: 3 };
    if (project && request.method === 'GET' && !project[2]) return { record: store.get(project[1]) };
    if (project && request.method === 'PUT' && !project[2]) {
      const previous = store.get(project[1]);
      const next = { ...previous, profile: structuredClone(request.payload.profile), generation: previous.generation + 1 };
      store.set(project[1], next);
      return { record: next };
    }
    if (project && request.method === 'DELETE') {
      store.delete(project[1]);
      return { projectId: project[1] };
    }
    if (project && project[2] === '/validate') {
      const entry = store.get(project[1]);
      return { projectId: project[1], generation: entry.generation, valid: true, state: 'VALID', authority: { state: 'CURRENT', issues: [] }, authorityConflicts: { state: 'CLEAR' }, benchmarkRuntime: { state: 'READY' }, recognition: { identity: {} }, recognitionError: null, problems: [] };
    }
    if (project && project[2] === '/activate') {
      active = pointer(project[1], store.get(project[1]).generation);
      return { pointer: active };
    }
    throw new Error(`Unexpected request ${key}`);
  } });
  return { actionClient, calls, store };
}

/** A root that is only a string sink, as the existing Configuration suites use. */
function stringRoot(elements = {}) {
  const listeners = new Map();
  const root = {
    innerHTML: '',
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelector(selector) { return elements[selector] ?? null; },
  };
  const click = async (action, dataset = {}) => {
    listeners.get('click')({ preventDefault() {}, target: { closest: () => ({ dataset: { cfgAction: action, ...dataset } }) } });
    await setImmediate();
  };
  const edit = (dataset, value, events = ['input', 'change']) => {
    const target = { dataset, value, checked: value === true };
    for (const name of events) listeners.get(name)({ target });
  };
  return { root, listeners, click, edit };
}

function visiblePanes(html) {
  return [...html.matchAll(/<div class="cfg-pane" data-pane="([a-z-]+)"( hidden)?>/gu)].filter((match) => !match[2]).map((match) => match[1]);
}

function saveBarOf(html) {
  return html.match(/<footer class="cfg-savebar"[\s\S]*?<\/footer>/u)?.[0] ?? '';
}

/* ------------------------------------------------------------------ draft problems */

test('UX-01: the original nine blocking rules keep their wording and order', () => {
  const broken = profile('alpha');
  broken.projectId = 'Not Valid';
  broken.targetRoot = '';
  broken.targetRootIdentity = 'nope';
  broken.workspaceRoot = '';
  broken.shadowRoot = '';
  broken.integrations.powershell.hostScript = '';
  broken.integrations.chrome.dedicatedProfileDirectory = '';
  broken.benchmarkRuntime.resolution = { width: 1920, height: null };
  broken.integrations.gpt.credential = { source: 'project-override', defaultKey: 'gateway.credential', value: 'sk-raw-secret-value' };
  assert.deepEqual(projectDraftProblems(broken).slice(0, 9), [
    'Project ID is invalid.',
    'Target Root is required.',
    'Target Root identity must be resolved by the backend.',
    'Workspace Root is required.',
    'Shadow Root is required.',
    'PowerShell Host Script is required.',
    'Dedicated browser profile directory is required.',
    'Benchmark resolution requires both a positive width and height, or neither.',
    'GPT override must be an env:/credential-store: reference, never secret bytes.',
  ]);
  assert.deepEqual(projectDraftProblems(null), ['No Project Profile draft is loaded.']);
  assert.deepEqual(blockingProblems(profile('alpha')), [], 'a valid profile blocks nothing');
});

test('UX-01: every problem names the section and field that owns it', () => {
  const draft = profile('alpha');
  draft.integrations.chrome.remoteDebuggingPort = 70000;
  draft.integrations.chrome.allowedOrigins = [];
  draft.integrations.git.publicationMode = 'REMOTE_REGISTERED';
  draft.integrations.gpt.modelId = null;
  draft.recognition.sourceRoots = [];
  draft.benchmarkRuntime.repetitions = 0;
  draft.integrations.powershell.executable = { source: 'project-override', defaultKey: 'powershell.executable', value: '' };
  const byPath = new Map(draftIssues(draft).map((issue) => [issue.path, issue]));
  for (const [path, section] of [
    ['integrations.chrome.remoteDebuggingPort', 'browser'],
    ['integrations.chrome.allowedOrigins', 'browser'],
    ['integrations.git.remote', 'git'],
    ['integrations.gpt.modelId', 'gpt-gateway'],
    ['recognition.sourceRoots', 'recognition'],
    ['benchmarkRuntime.repetitions', 'benchmark-runtime'],
    ['integrations.powershell.executable', 'powershell-host'],
  ]) {
    assert.equal(byPath.get(path)?.section, section, path);
    assert.equal(byPath.get(path)?.severity, 'error', path);
  }
});

test('UX-01: advice never blocks SAVE; only mirrored backend rules do', () => {
  const draft = profile('alpha');
  draft.authority.masterBenchmark = null;
  draft.integrations.chrome.targetUrl = 'not a url';
  const issues = draftIssues(draft);
  assert.deepEqual(issues.map((issue) => issue.severity), ['warning', 'warning']);
  assert.deepEqual(blockingProblems(draft), []);
  // The publication-mode/remote contradiction is a backend refusal, so it does block.
  draft.integrations.git.remote = 'https://example.invalid/repo.git';
  assert.match(blockingProblems(draft).join(' '), /NO_REMOTE_YET requires the remote to be empty/);
});

test('UX-01: a problem is rendered under its own field', () => {
  const state = snapshot();
  state.draft.integrations.chrome.remoteDebuggingPort = 0;
  state.issues = draftIssues(state.draft);
  const html = renderBrowserEditor(state);
  const field = html.match(/<label class="[^"]*"[^>]*data-field-path="integrations\.chrome\.remoteDebuggingPort"[\s\S]*?<\/label>/u)?.[0];
  assert.ok(field);
  assert.match(field, /class="cfg-field has-error"/);
  assert.match(field, /role="alert">Port must be between 1 and 65535\./);
  assert.doesNotMatch(renderBrowserEditor(snapshot()), /has-error/);
});

/* ------------------------------------------------------------------ unsaved changes */

test('UX-02: the change list is the difference between the saved generation and the draft', () => {
  const saved = profile('alpha');
  const draft = profile('alpha');
  assert.deepEqual(draftChanges(saved, draft), []);
  draft.displayName = 'Renamed';
  draft.integrations.chrome.remoteDebuggingPort = 9333;
  draft.recognition.sourceRoots = ['src', 'ui'];
  draft.integrations.powershell.executable = { source: 'project-override', defaultKey: 'powershell.executable', value: 'C:/pwsh.exe' };
  draft.authority.projectIntent = { bindingId: 'project-intent', path: 'intent.md', sha256: '7'.repeat(64) };
  const changes = draftChanges(saved, draft);
  assert.deepEqual(changes.map((change) => change.path), [
    'authority.projectIntent',
    'displayName',
    'integrations.chrome.remoteDebuggingPort',
    'integrations.powershell.executable',
    'recognition.sourceRoots',
  ]);
  const port = changes.find((change) => change.path === 'integrations.chrome.remoteDebuggingPort');
  assert.deepEqual([port.label, port.section, port.beforeText, port.afterText], ['Remote Debugging Port', 'browser', '9222', '9333']);
  assert.deepEqual(changedSections(changes), ['project-authority', 'project', 'browser', 'powershell-host', 'recognition']);
});

test('UX-02: values are compared structurally and described honestly', () => {
  assert.equal(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true, 'key order is not a change');
  assert.equal(sameValue(['a', 'b'], ['b', 'a']), false, 'list order is a change');
  assert.equal(formatValue(null), 'empty');
  assert.equal(formatValue(true), 'on');
  assert.equal(formatValue([]), 'none');
  assert.equal(formatValue({ source: 'global-default', defaultKey: 'x', value: null }), 'installation default');
  assert.equal(formatValue({ source: 'project-override', defaultKey: 'x', value: 'C:/a.exe' }), 'custom: C:/a.exe');
  assert.equal(formatValue({ width: 1920, height: 1080 }), '1920 × 1080');
  assert.equal(sectionOfPath('integrations.gpt.modelId'), 'gpt-gateway');
  assert.equal(sectionOfPath('displayName'), 'project');
  assert.equal(labelOfPath('some.unknownSetting'), 'Unknown Setting', 'an uncatalogued path is humanised, never hidden');
});

test('UX-02: every editable profile field has a catalogue label and an owning section', () => {
  const state = snapshot();
  const html = [renderProjectEditor, renderAuthorityEditor, renderRecognitionEditor, renderBenchmarkRuntimeEditor, renderHostEditor, renderGitEditor, renderBrowserEditor, renderGatewayEditor]
    .map((render) => render(state)).join('');
  const rendered = new Set([...html.matchAll(/data-(?:profile-path|cfg-override)="([^"]+)"/gu)].map((match) => match[1]));
  rendered.delete('benchmarkRuntime.resolution.width');
  rendered.delete('benchmarkRuntime.resolution.height');
  rendered.add('benchmarkRuntime.resolution');
  const catalogued = new Set(FIELD_CATALOGUE.map((entry) => entry.path));
  assert.deepEqual([...rendered].filter((path) => !catalogued.has(path)), []);
  const sections = new Set(SECTIONS.map((entry) => entry.id));
  for (const entry of FIELD_CATALOGUE) {
    assert.ok(sections.has(entry.section), entry.path);
    assert.equal(sectionOfPath(entry.path), entry.section, entry.path);
  }
});

/* ------------------------------------------------------------------ navigation and search */

test('UX-03: section ids are the rendered data-section ids, and the ribbon contract is unchanged', async () => {
  const { actionClient } = backend();
  const { root } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    for (const entry of visibleSections(panel.snapshot())) {
      assert.match(root.innerHTML, new RegExp(`data-section="${entry.id}"`), entry.id);
    }
    assert.doesNotMatch(root.innerHTML, /data-section="startup"/, 'the legacy section exists only in legacy mode');
  } finally {
    panel.destroy();
  }
  assert.deepEqual({ ...CAPABILITY_SECTIONS }, { git: 'git', ai: 'gpt-gateway', chrome: 'browser', console: 'powershell-host' });
});

test('UX-03: exactly one section is on screen, and navigation changes which', async () => {
  const { actionClient } = backend();
  const { root, click } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    assert.deepEqual(visiblePanes(root.innerHTML), ['overview']);
    await click('go-section', { sectionTarget: 'git' });
    assert.deepEqual(visiblePanes(root.innerHTML), ['git']);
    assert.match(root.innerHTML, /data-section-target="git" data-cfg-action="go-section" aria-current="page"/);
    await click('go-section', { sectionTarget: 'no-such-section' });
    assert.deepEqual(visiblePanes(root.innerHTML), ['overview'], 'an unknown section falls back to Overview');
    assert.equal(panel.focusCapability('unknown'), false);
    panel.focusCapability('chrome', { summary: 'Run Test Chrome in Configuration.' });
    assert.deepEqual(visiblePanes(root.innerHTML), ['browser']);
    assert.match(root.innerHTML, /Ribbon check · Run Test Chrome in Configuration\./);
  } finally {
    panel.destroy();
  }
});

test('UX-03: search finds a setting by a word of its name, not by a substring', () => {
  assert.deepEqual(searchSections('port'), [{ id: 'browser', fields: ['Remote Debugging Port'] }]);
  assert.deepEqual(searchSections('default branch'), [{ id: 'git', fields: ['Default Branch'] }]);
  assert.deepEqual(searchSections('api key').map((result) => result.id), ['gpt-gateway']);
  assert.deepEqual(searchSections('zzzz'), []);
  assert.equal(searchSections('').length, SECTIONS.length);
  assert.equal(searchSections('').every((result) => result.fields.length === 0), true);
});

test('UX-03: a section reports only what is known — untested is not passed', () => {
  const state = snapshot();
  assert.deepEqual(sectionStatus('powershell-host', state), { tone: 'neutral', text: 'Not tested' });
  assert.deepEqual(sectionStatus('browser', state), { tone: 'neutral', text: 'Not tested' });
  assert.deepEqual(sectionStatus('git', state), { tone: 'local', text: 'Local only' });
  assert.deepEqual(sectionStatus('project-readiness', state), { tone: 'neutral', text: 'Not assessed' });
  state.connectionChecks.browser = { state: 'failed' };
  assert.deepEqual(sectionStatus('browser', state), { tone: 'bad', text: 'Failed' });
  state.draft.integrations.gpt.enabled = false;
  assert.deepEqual(sectionStatus('gpt-gateway', state), { tone: 'neutral', text: 'Off' });
  state.draft.authority.masterBenchmark = null;
  assert.deepEqual(sectionStatus('project-authority', state), { tone: 'warn', text: 'No benchmark' });
  assert.deepEqual(sectionStatus('git', { draft: null }), { tone: 'neutral', text: '' }, 'no profile, no claim');
});

test('UX-03: while a new profile is prepared, sections that need a draft are unavailable', () => {
  const preparing = { draftMode: 'prepare' };
  assert.equal(sectionAvailable('project', preparing), true);
  assert.equal(sectionAvailable('profiles', preparing), true);
  assert.equal(sectionAvailable('git', preparing), false);
  assert.equal(resolveSection('git', preparing), 'project');
  assert.equal(resolveSection('git', { draftMode: 'update' }), 'git');
  assert.equal(resolveSection('startup', { draftMode: 'update' }), 'overview');
});

/* ------------------------------------------------------------------ save bar and review */

test('UX-04: the save bar is always present and tells the truth about the draft', async () => {
  const { actionClient, calls } = backend();
  const { root, click, edit } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    assert.match(saveBarOf(root.innerHTML), /No profile open\./);
    assert.match(saveBarOf(root.innerHTML), /data-cfg-action="save-profile" disabled/);
    await panel.load();
    assert.match(saveBarOf(root.innerHTML), /All changes saved<\/strong><span>generation 1</);
    assert.match(saveBarOf(root.innerHTML), /data-cfg-action="save-profile" disabled/);

    edit({ profilePath: 'displayName' }, 'Renamed');
    edit({ profilePath: 'integrations.chrome.remoteDebuggingPort' }, '9333');
    assert.match(saveBarOf(root.innerHTML), /2 unsaved changes<\/strong><span>in Project &amp; paths, Test browser/);
    assert.match(saveBarOf(root.innerHTML), /this is the running profile: a save takes effect after a dashboard restart/);
    assert.match(saveBarOf(root.innerHTML), /data-cfg-action="save-profile" title="Ctrl\+S">SAVE CHANGES/);

    edit({ profilePath: 'integrations.chrome.remoteDebuggingPort' }, '0');
    assert.match(saveBarOf(root.innerHTML), /data-issue-path="integrations\.chrome\.remoteDebuggingPort"[^>]*>1 problem to fix/);
    assert.match(saveBarOf(root.innerHTML), /data-cfg-action="save-profile" disabled/);
    await click('save-profile');
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'a blocked draft is never sent');

    edit({ profilePath: 'integrations.chrome.remoteDebuggingPort' }, '9333');
    await click('save-profile');
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
    assert.match(saveBarOf(root.innerHTML), /All changes saved<\/strong><span>generation 2</);
    assert.match(root.innerHTML, /Saved alpha generation 2\./);
  } finally {
    panel.destroy();
  }
});

test('UX-04: editing a field back to its saved value is not an unsaved change', async () => {
  const { actionClient } = backend();
  const { root, edit } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    edit({ profilePath: 'displayName' }, 'Something else');
    assert.equal(panel.snapshot().dirty, true);
    edit({ profilePath: 'displayName' }, 'ALPHA');
    assert.equal(panel.snapshot().dirty, false);
    assert.match(saveBarOf(root.innerHTML), /All changes saved/);
  } finally {
    panel.destroy();
  }
});

test('UX-04: the review dialog lists every change and can undo one', async () => {
  const { actionClient } = backend();
  const { root, click, edit } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    edit({ profilePath: 'displayName' }, 'Renamed');
    edit({ profilePath: 'integrations.git.defaultBranch' }, 'work');
    await click('open-changes');
    const dialog = root.innerHTML.match(/<div class="cfg-overlay" data-cfg-dialog="changes">[\s\S]*$/u)?.[0] ?? '';
    assert.match(dialog, /Unsaved changes \(2\)/);
    assert.match(dialog, /<td class="cfg-diff-before">ALPHA<\/td>\s*<td class="cfg-diff-after">Renamed<\/td>/);
    assert.match(dialog, /<td class="cfg-diff-before">main<\/td>\s*<td class="cfg-diff-after">work<\/td>/);
    await click('revert-change', { changePath: 'integrations.git.defaultBranch' });
    assert.equal(panel.snapshot().draft.integrations.git.defaultBranch, 'main');
    assert.equal(panel.snapshot().draft.displayName, 'Renamed');
    assert.match(root.innerHTML, /Unsaved changes \(1\)/);
    await click('revert-change', { changePath: 'displayName' });
    assert.equal(panel.snapshot().dirty, false);
    assert.match(root.innerHTML, /The draft is identical to the saved generation\./);
  } finally {
    panel.destroy();
  }
});

/* ------------------------------------------------------------------ profiles: switch, activate, delete */

test('UX-05: opening another profile with unsaved changes asks first, and can save then continue', async () => {
  const { actionClient, calls } = backend();
  const { root, click, edit, listeners } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    edit({ profilePath: 'displayName' }, 'Renamed');
    // The same guard serves the selector, the profile list, REFRESH and NEW PROFILE.
    listeners.get('change')({ target: { id: 'cfgProjectSelector', dataset: {}, value: 'beta' } });
    assert.match(root.innerHTML, /data-cfg-dialog="discard"/);
    assert.match(root.innerHTML, /Opening beta discards them\./);
    assert.equal(panel.snapshot().selectedProjectId, 'alpha', 'nothing is switched until the operator decides');

    await click('dialog-cancel');
    assert.doesNotMatch(root.innerHTML, /data-cfg-dialog=/);
    assert.equal(panel.snapshot().dirty, true);

    await click('edit-profile', { projectId: 'beta' });
    await click('dialog-save-continue');
    await setImmediate();
    await setImmediate();
    const sequence = calls.map((call) => `${call.method} ${call.path}`);
    assert.ok(sequence.indexOf('PUT /api/projects/alpha') > -1);
    assert.ok(sequence.lastIndexOf('GET /api/projects/beta') > sequence.indexOf('PUT /api/projects/alpha'), 'the save completes before the other profile is opened');
    assert.equal(panel.snapshot().selectedProjectId, 'beta');
    assert.equal(sequence.some((entry) => entry.endsWith('/activate')), false, 'opening a profile never activates it');
  } finally {
    panel.destroy();
  }
});

test('UX-05: the relation between the edited and the running profile is stated', () => {
  const editingOther = snapshot('beta');
  assert.match(renderRelationBanner(editingOther), /You are editing <strong>BETA<\/strong>\. CLU-E is running <strong>alpha<\/strong>/);
  assert.equal(renderRelationBanner(snapshot('alpha')), '', 'the same saved generation needs no explanation');
  const newer = snapshot('alpha', 2);
  assert.match(renderRelationBanner(newer), /Generation 2 of this profile is saved, but CLU-E is still running generation 1\. Restart the dashboard/);
  assert.match(renderRelationBanner({ ...snapshot('alpha'), active: null }), /No profile is running\./);
  assert.match(renderRelationBanner({ draftMode: 'create' }), /exists only in this browser tab/);
});

test('UX-05: activation is guided — validate, then confirm — and never happens on the first click', async () => {
  const events = [];
  const { actionClient, calls } = backend();
  const { root, click } = stringRoot();
  const panel = mountConfigurationPanel({
    root, actionClient,
    onActivationPending: (entry) => { events.push(['pending', entry.profile.projectId]); return true; },
    onActiveProjectChanged: ({ pointer: next }) => events.push(['active', next.projectId]),
  });
  const activations = () => calls.filter((call) => call.path.endsWith('/activate')).length;
  try {
    await panel.load();
    await click('edit-profile', { projectId: 'beta' });
    await click('activate-project');
    assert.match(root.innerHTML, /data-cfg-dialog="activate"/);
    assert.match(root.innerHTML, /PROJECT_VALIDATION_REQUIRED/);
    assert.match(root.innerHTML, /stop working with <strong>alpha<\/strong> and start working with <strong>BETA<\/strong>/);
    assert.match(root.innerHTML, /data-cfg-action="confirm-activate-project" data-cfg-dialog-primary disabled/);
    await click('confirm-activate-project');
    assert.equal(activations(), 0, 'confirming without a valid validation activates nothing');

    await click('validate-profile');
    assert.match(root.innerHTML, /Validated: the saved generation matches the files on disk\./);
    assert.match(root.innerHTML, /data-cfg-action="confirm-activate-project" data-cfg-dialog-primary>ACTIVATE</);
    await click('confirm-activate-project');
    await setImmediate();
    assert.equal(activations(), 1);
    assert.deepEqual(calls.find((call) => call.path.endsWith('/activate')).payload, {
      expectedGeneration: 1, expectedProfileHash: record('beta').projectProfileHash,
    });
    assert.deepEqual(events, [['pending', 'beta'], ['active', 'beta']]);
    assert.equal(panel.snapshot().active.projectId, 'beta');
    assert.doesNotMatch(root.innerHTML, /data-cfg-dialog=/, 'the dialog closes on success');
  } finally {
    panel.destroy();
  }
});

test('UX-05: delete requires the exact state-bound phrase, typed in the dialog', async () => {
  const input = { value: '' };
  const { actionClient, calls } = backend();
  const { root, click } = stringRoot({ '#cfgDialogConfirmInput': input });
  const panel = mountConfigurationPanel({ root, actionClient });
  const deletions = () => calls.filter((call) => call.method === 'DELETE');
  try {
    await panel.load();
    await click('delete-profile');
    assert.doesNotMatch(root.innerHTML, /data-cfg-dialog="delete"/, 'the running profile cannot be deleted');
    await click('edit-profile', { projectId: 'beta' });
    await click('delete-profile');
    const phrase = exactDeletePhrase(record('beta'));
    assert.match(root.innerHTML, /data-cfg-dialog="delete"/);
    assert.ok(root.innerHTML.includes(`<code class="cfg-phrase">${phrase}</code>`));
    assert.match(root.innerHTML, /Kept: the target repository at <code>F:\/Targets\/Beta<\/code>/);

    input.value = 'DELETE PROFILE beta';
    await click('confirm-delete-profile');
    assert.equal(deletions().length, 0);
    assert.match(root.innerHTML, /The phrase does not match\./);

    input.value = phrase;
    await click('confirm-delete-profile');
    await setImmediate();
    assert.deepEqual(deletions().map((call) => call.payload), [{ expectedGeneration: 1, confirmation: phrase }]);
    assert.match(root.innerHTML, /Deleted CLU-E profile beta; target and workspace data were not deleted\./);
  } finally {
    panel.destroy();
  }
});

/* ------------------------------------------------------------------ credentials, overrides, guidance */

test('UX-06: the credential dialog accepts a reference and refuses anything else, clearing the field', async () => {
  const kind = { value: 'env' };
  const name = { value: 'sk-live-abcdefghijklmnop' };
  const { actionClient } = backend();
  const { root, click, listeners } = stringRoot({ '#cfgDialogCredentialKind': kind, '#cfgDialogCredentialName': name });
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    await click('use-gateway-override');
    assert.match(root.innerHTML, /data-cfg-dialog="credential"/);
    assert.doesNotMatch(root.innerHTML, /type="password"/);

    // Typing: a key-shaped value is removed from the field before anything reads it.
    const typed = { id: 'cfgDialogCredentialName', dataset: {}, value: 'sk-live-abcdefghijklmnop' };
    listeners.get('input')({ target: typed });
    assert.equal(typed.value, '');

    await click('confirm-credential-reference');
    assert.equal(name.value, '', 'a refused value is cleared from the field');
    assert.match(root.innerHTML, /CREDENTIAL_REFERENCE_INVALID/);
    assert.equal(JSON.stringify(panel.snapshot()).includes('sk-live'), false, 'no secret-shaped value reaches browser state');
    assert.equal(panel.snapshot().draft.integrations.gpt.credential.value, 'env:OPENAI_API_KEY');

    name.value = 'MY_OPENAI_KEY';
    await click('confirm-credential-reference');
    assert.deepEqual(panel.snapshot().draft.integrations.gpt.credential, { source: 'project-override', defaultKey: 'gateway.credential', value: 'env:MY_OPENAI_KEY' });
    assert.doesNotMatch(root.innerHTML, /data-cfg-dialog=/);

    kind.value = 'credential-store';
    name.value = 'CLU-E/OpenAI/alpha';
    await click('use-gateway-override');
    await click('confirm-credential-reference');
    assert.equal(panel.snapshot().draft.integrations.gpt.credential.value, 'credential-store:CLU-E/OpenAI/alpha');
  } finally {
    panel.destroy();
  }
});

test('UX-06: an executable is switched between the installation default and a custom path in place', async () => {
  const { actionClient } = backend();
  const { root, click, edit } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    await click('use-host-override');
    assert.deepEqual(panel.snapshot().draft.integrations.powershell.executable, { source: 'project-override', defaultKey: 'powershell.executable', value: '' });
    assert.match(root.innerHTML, /data-cfg-override="integrations\.powershell\.executable" data-default-key="powershell\.executable" value=""/);
    assert.match(root.innerHTML, /Enter the full path of the PowerShell executable, or use the installation default\./);
    assert.match(saveBarOf(root.innerHTML), /data-cfg-action="save-profile" disabled/, 'an empty custom path cannot be saved');

    edit({ cfgOverride: 'integrations.powershell.executable', defaultKey: 'powershell.executable' }, ' C:/pwsh/pwsh.exe ');
    assert.deepEqual(panel.snapshot().draft.integrations.powershell.executable, { source: 'project-override', defaultKey: 'powershell.executable', value: 'C:/pwsh/pwsh.exe' });

    await click('use-host-global');
    assert.equal(panel.snapshot().dirty, false, 'back on the default is back on the saved value');
  } finally {
    panel.destroy();
  }
});

test('UX-06: the overview names one next step from the facts it has', () => {
  const base = { ...snapshot('beta'), issues: [], changes: [] };
  assert.equal(nextStep({ ...base, draft: null, projects: [] }).action.action, 'new-project');
  assert.equal(nextStep({ ...base, draft: null }).action, null);
  assert.equal(nextStep({ ...base, issues: [{ section: 'browser', path: 'x', severity: 'error', message: 'Port must be between 1 and 65535.' }] }).action.action, 'go-issue');
  assert.equal(nextStep({ ...base, dirty: true }).action.action, 'save-profile');
  assert.equal(nextStep(base).action.action, 'validate-profile');
  assert.equal(nextStep({ ...base, validation: { valid: false } }).action, null);
  assert.equal(nextStep({ ...base, validation: { valid: true } }).action.action, 'activate-project');
  const running = { ...snapshot('alpha'), issues: [], changes: [], validation: { valid: true } };
  assert.match(nextStep(running).title, /This profile is running/);
  assert.match(nextStep({ ...running, selectedRecord: record('alpha', 2) }).title, /Restart the dashboard/);
});

test('UX-06: folders for a new profile are suggested only when an existing profile shows the pattern', () => {
  assert.equal(suggestSiblingPath('F:\\CLU\\workspace\\alpha', 'alpha', 'Beta'), 'F:\\CLU\\workspace\\beta');
  assert.equal(suggestSiblingPath('F:/CLU/workspace/alpha', 'alpha', 'beta'), 'F:/CLU/workspace/beta');
  assert.equal(suggestSiblingPath('F:/CLU/workspace/main', 'alpha', 'beta'), '', 'no pattern, no suggestion');
  assert.equal(suggestSiblingPath('F:/CLU/workspace/alpha', 'alpha', 'Not Valid!'), '');
});

/* ------------------------------------------------------------------ render timing (browser-only rules) */

/** A root that looks enough like an element to switch on the browser timing rules. */
function liveRoot() {
  const listeners = new Map();
  const documentListeners = new Map();
  const writes = [];
  let html = '';
  const root = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; writes.push(value); },
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    ownerDocument: {
      activeElement: null,
      addEventListener(name, listener) { documentListeners.set(name, listener); },
      removeEventListener() {},
    },
  };
  return { root, listeners, documentListeners, writes };
}

test('UX-07: the markup is not replaced during a change event or while a pointer is down', async () => {
  const { actionClient } = backend();
  const { root, listeners, documentListeners, writes } = liveRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    await delay(5);

    // `change` fires in the middle of a focus move: the render waits until it has completed.
    let before = writes.length;
    listeners.get('change')({ target: { dataset: { profilePath: 'displayName' }, value: 'Renamed' } });
    assert.equal(panel.snapshot().draft.displayName, 'Renamed', 'the draft is updated at once');
    assert.equal(writes.length, before, 'the markup is not replaced inside the change event');
    await delay(5);
    assert.equal(writes.length > before, true, 'it is replaced once the focus move is over');
    assert.match(root.innerHTML, /1 unsaved change</);

    // A press that has not been released: a click must still find the element it started on.
    before = writes.length;
    listeners.get('pointerdown')({ target: { tagName: 'BUTTON' } });
    panel.state.setNotice('local', 'a backend response arrives mid-press');
    assert.equal(writes.length, before, 'the markup is not replaced while the pointer is down');
    documentListeners.get('pointerup')({});
    assert.equal(writes.length, before, 'nor in the same task as the release, where the click is delivered');
    await delay(5);
    assert.equal(writes.length > before, true);
    assert.match(root.innerHTML, /a backend response arrives mid-press/);

    // A native <select> swallows the release, so a press on one must not hold rendering.
    before = writes.length;
    listeners.get('pointerdown')({ target: { tagName: 'SELECT' } });
    panel.state.setNotice('local', 'not held');
    assert.equal(writes.length > before, true);
  } finally {
    panel.destroy();
  }
});

test('UX-07: a render requested while another is replacing nodes is performed afterwards, not nested', async () => {
  const { actionClient } = backend();
  const listeners = new Map();
  let html = '';
  let depth = 0;
  let maxDepth = 0;
  let fired = false;
  const root = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      // A browser fires the removed control's pending `change` during the replacement.
      if (!fired && panel?.snapshot().draft) {
        fired = true;
        listeners.get('change')({ target: { dataset: { profilePath: 'displayName' }, value: 'Typed, not yet committed' } });
      }
      html = value;
      depth -= 1;
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelector() { return null; },
  };
  let panel = null;
  panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    panel.state.setNotice('local', 'refresh');
    assert.equal(fired, true);
    assert.equal(maxDepth, 1, 'replacements never nest');
    assert.equal(panel.snapshot().draft.displayName, 'Typed, not yet committed', 'the pending edit is kept');
    assert.match(root.innerHTML, /value="Typed, not yet committed"/, 'and the final markup reflects it');
  } finally {
    panel.destroy();
  }
});

/* ------------------------------------------------------------------ continuity across a re-render */

function fakeElement(tag, attributes = {}, extra = {}) {
  return {
    tagName: tag.toUpperCase(), attributes: { ...attributes }, scrollTop: 0, open: false, value: '', checked: false, disabled: false, focused: 0,
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
    focus() { this.focused += 1; },
    setSelectionRange(start, end) { this.selection = [start, end]; },
    ...extra,
  };
}

/** Enough of querySelectorAll for the selectors uiContinuity uses. */
function fakeDom(elements) {
  const root = {
    ownerDocument: { activeElement: null },
    contains: (element) => elements.includes(element),
    querySelectorAll(selector) {
      const match = selector.match(/^([a-z]*)((?:\[[^\]]+\])+)$/u);
      if (!match) return [];
      const conditions = [...match[2].matchAll(/\[([a-z-]+)(?:="((?:[^"\\]|\\.)*)")?\]/gu)].map((part) => [part[1], part[2]]);
      return elements.filter((element) => (match[1] === '' || element.tagName.toLowerCase() === match[1]) && conditions.every(([name, value]) => {
        if (name === 'open') return element.open === true;
        const actual = element.getAttribute(name);
        return value === undefined ? actual !== null : actual === value.replace(/\\(.)/gu, '$1');
      }));
    },
  };
  return root;
}

test('UX-08: focus, caret, scroll, open disclosures and half-typed inputs survive a re-render', () => {
  const build = () => [
    fakeElement('div', { 'data-cfg-scroll': 'main' }),
    fakeElement('details', { 'data-cfg-details': 'git-advanced' }),
    fakeElement('details', { 'data-cfg-details': 'other' }),
    fakeElement('input', { 'data-profile-path': 'displayName' }),
    fakeElement('input', { id: 'cfgAdditionalDocumentPath', 'data-cfg-transient': '' }),
    fakeElement('input', { id: 'cfgAuthorityPath-masterBenchmark', 'data-cfg-transient': '' }),
    fakeElement('input', { id: 'cfgDialogCredentialName', 'data-cfg-transient': 'volatile' }),
  ];
  const before = build();
  const [scroll, advanced, , name, half, bound, credential] = before;
  scroll.scrollTop = 420;
  advanced.open = true;
  name.selectionStart = 3;
  name.selectionEnd = 5;
  half.value = 'docs/half-typed.md';
  bound.value = 'bench/master.md';
  credential.value = 'TYPED_NAME';
  const oldRoot = fakeDom(before);
  oldRoot.ownerDocument.activeElement = name;
  const memo = captureContinuity(oldRoot);

  const after = build();
  const focused = restoreContinuity(fakeDom(after), memo, { dropTransient: ['cfgAuthorityPath-masterBenchmark'] });
  const [scroll2, advanced2, other2, name2, half2, bound2, credential2] = after;
  assert.equal(focused, true);
  assert.equal(name2.focused, 1);
  assert.deepEqual(name2.selection, [3, 5]);
  assert.equal(scroll2.scrollTop, 420);
  assert.equal(advanced2.open, true);
  assert.equal(other2.open, false);
  assert.equal(half2.value, 'docs/half-typed.md');
  assert.equal(bound2.value, '', 'an input whose content was just consumed is cleared');
  assert.equal(credential2.value, '', 'a credential-reference field is never carried across a render');

  const reset = build();
  restoreContinuity(fakeDom(reset), memo, { resetScroll: ['main'] });
  assert.equal(reset[0].scrollTop, 0, 'a newly opened section starts at its top');
  assert.equal(captureContinuity({ innerHTML: '' }), null, 'a root that is not a DOM element is left alone');
  assert.equal(restoreContinuity({ innerHTML: '' }, null), false);
});

/* ------------------------------------------------------------------ a control the dashboard shell owns */

test('UX-09: the dashboard layout control has a section of its own, reachable without a profile', async () => {
  const { actionClient } = backend();
  const { root, click } = stringRoot();
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    assert.ok(SECTIONS.some((entry) => entry.id === 'dashboard-layout' && entry.group === 'installation'));
    assert.match(root.innerHTML, /<section class="cfg-card" data-section="dashboard-layout">/);
    assert.match(root.innerHTML, /data-cfg-slot="layout-switch"/);
    assert.deepEqual(searchSections('composition').map((result) => result.id), ['dashboard-layout']);

    await click('go-section', { sectionTarget: 'dashboard-layout' });
    assert.deepEqual(visiblePanes(root.innerHTML), ['dashboard-layout']);

    // It is a setting of the window, so preparing a new profile does not take it away.
    await click('new-project');
    assert.equal(sectionAvailable('dashboard-layout', panel.snapshot()), true);
    assert.equal(resolveSection('dashboard-layout', panel.snapshot()), 'dashboard-layout');
  } finally {
    panel.destroy();
  }
});

test('UX-09: the shell-owned control is moved into its slot on every paint and handed back on destroy', async () => {
  const { actionClient } = backend();
  const { root, writes } = liveRoot();
  const control = { id: 'clue-layout-switch', parentElement: null, contains: () => false };
  const appended = [];
  const fallback = { hidden: false };
  const slot = {
    appendChild(child) { appended.push(child); child.parentElement = slot; },
    querySelector: (selector) => (selector === '[data-cfg-slot-fallback]' ? fallback : null),
  };
  const prepended = [];
  let connected = true;
  root.querySelector = (selector) => (selector === '[data-cfg-slot="layout-switch"]' ? slot : null);
  root.ownerDocument.getElementById = (id) => (id === 'clue-layout-switch' && connected ? control : null);
  root.parentElement = { prepend(child) { prepended.push(child); } };

  const panel = mountConfigurationPanel({ root, actionClient });
  await panel.load();
  await delay(5);
  assert.equal(appended.length, 1, 'adopted once while it stays in the slot');
  assert.equal(appended[0], control, 'the shell\'s own element, not a copy');
  assert.equal(fallback.hidden, true);

  // Replacing the markup detaches whatever was inside it. The same element must come back.
  connected = false;
  control.parentElement = null;
  const before = writes.length;
  panel.state.setNotice('local', 'a re-render');
  assert.equal(writes.length > before, true);
  assert.equal(appended.length, 2);
  assert.equal(appended[1], control, 'the detached element is re-attached, never recreated');

  panel.destroy();
  assert.deepEqual(prepended, [control], 'destroy returns it to where the shell placed it');
});

test('UX-09: without the shell control the section says so and nothing is adopted', async () => {
  const { actionClient } = backend();
  const { root } = liveRoot();
  const appended = [];
  root.querySelector = (selector) => (selector === '[data-cfg-slot="layout-switch"]' ? { appendChild: (child) => appended.push(child) } : null);
  root.ownerDocument.getElementById = () => null;
  const panel = mountConfigurationPanel({ root, actionClient });
  try {
    await panel.load();
    await delay(5);
    assert.deepEqual(appended, []);
    assert.match(root.innerHTML, /data-cfg-slot-fallback>The dashboard shell has not provided its window-composition control/);
  } finally {
    panel.destroy();
  }
});

test('Agents is searchable and keeps the live editor only for the same active profile', async () => {
  let active = pointer('alpha');
  const { actionClient } = backend({
    'GET /api/projects': () => ({ active, projects: [metadata('alpha'), metadata('beta')], registryGeneration: 3 }),
  });
  const { root } = liveRoot();
  const fallback = { hidden: false };
  const appendToSlot = () => ({
    appendChild(child) { child.parentElement = this; },
    querySelector: (selector) => selector === '[data-cfg-slot-fallback]' ? fallback : null,
  });
  let slot = appendToSlot();
  root.querySelector = (selector) => selector === '[data-cfg-slot="agents"]' ? slot : null;
  root.ownerDocument.createElement = (tag) => ({ tag, parentElement: null });
  const mounts = [];
  const unmounts = [];
  const panel = mountConfigurationPanel({
    root,
    actionClient,
    mountAgents(host) {
      mounts.push(host);
      return { destroy() { unmounts.push(host); } };
    },
  });
  try {
    await panel.load();
    assert.deepEqual(searchSections('brain').map((result) => result.id), ['agents']);
    assert.equal(mounts.length, 0);
    panel.showSection('agents');
    assert.deepEqual(visiblePanes(root.innerHTML), ['agents']);
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].parentElement, slot);
    assert.equal(fallback.hidden, true);

    slot = appendToSlot();
    panel.state.setNotice('local', 'repaint');
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].parentElement, slot, 'repaints retain the live editor element');

    active = pointer('beta');
    await panel.reload();
    assert.deepEqual(unmounts, [mounts[0]]);
    assert.equal(mounts.length, 2);
    assert.notEqual(mounts[0], mounts[1]);
  } finally {
    panel.destroy();
  }
  assert.deepEqual(unmounts, mounts);
});
