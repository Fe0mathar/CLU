/**
 * `DEV-P1-17` — the Configuration readiness view.
 *
 * These are the questions nobody could ask while this was eight template literals inside an async
 * click handler: what does the panel show when the daemon returns nothing, when a field is
 * missing, when a path contains a `<`. All three are answerable now without a browser.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configurationRows,
  escapeHtml,
  renderConfigurationRows,
} from '../configuration/configurationPanel.js';

function rowFor(rows, label) {
  return rows.find((row) => row.label === label);
}

const HEALTHY = {
  project: { id: 'clue', root: 'F:\\CLU\\CLU', rootPresent: true },
  tsconfigPresent: true,
  workspaceInitialised: true,
  trackedDocuments: [{ path: 'CLUE_Constitution_v8.md', present: true }],
  committedGraphPointer: { resultHash: 'a'.repeat(64), runId: 'RUN-000001' },
  startable: true,
};

test('DEV-P1-17: a healthy configuration decides one row per fact', () => {
  const rows = configurationRows(HEALTHY);

  assert.equal(rowFor(rows, 'project id').text, 'clue');
  assert.equal(rowFor(rows, 'project root').ok, true);
  assert.equal(rowFor(rows, 'tsconfig.json').kind, 'check');
  assert.equal(rowFor(rows, 'CLUE_Constitution_v8.md').ok, true);
  assert.match(rowFor(rows, 'committed graph').text, /^aaaaaaaaaaaa · run RUN-0000$/);
  assert.equal(rowFor(rows, 'startable').ok, true);
});

test('DEV-P1-17: no response at all is one honest row, not a page of dashes', () => {
  for (const empty of [null, undefined, 'not an object', 42]) {
    const rows = configurationRows(empty);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'absent');
    assert.match(rows[0].reason, /returned no configuration body/);
  }
});

test('DEV-P1-17: a missing field is absent with a reason, not an em dash', () => {
  const rows = configurationRows({ project: {}, trackedDocuments: [] });

  const id = rowFor(rows, 'project id');
  // `project.id ?? '—'` reads as tidy and says the same thing for "empty", "the endpoint returned
  // nothing" and "the key is missing". An operator cannot tell those apart from a dash.
  assert.equal(id.kind, 'absent');
  assert.match(id.reason, /declares no project id/);
  assert.equal(id.text, undefined, 'absence carries no text to render as a value');
});

test('DEV-P1-17: "no graph yet" and "a pointer that cannot be read" are different rows', () => {
  const none = rowFor(configurationRows({ ...HEALTHY, committedGraphPointer: null }), 'committed graph');
  const broken = rowFor(
    configurationRows({ ...HEALTHY, committedGraphPointer: { runId: 'RUN-000001' } }),
    'committed graph',
  );

  // Both used to render as the same red "none yet". The first is expected before the first
  // recognition; the second is a fault.
  assert.match(none.reason, /no graph has been committed yet/);
  assert.match(broken.reason, /carries no result hash/);
  assert.notEqual(none.reason, broken.reason);
});

test('DEV-P1-17: a malformed tracked-document list is reported, not skipped', () => {
  const missing = configurationRows({ ...HEALTHY, trackedDocuments: undefined });
  assert.match(rowFor(missing, 'tracked documents').reason, /lists no tracked documents/);

  const nameless = configurationRows({ ...HEALTHY, trackedDocuments: [{ present: true }] });
  assert.match(rowFor(nameless, 'tracked document').reason, /has no path/);
});

test('DEV-P1-17: escaping is decided once, so no interpolation can forget it', () => {
  const rows = configurationRows({
    project: { id: '<img src=x onerror=alert(1)>', root: 'C:\\a"b', rootPresent: true },
  });
  const html = renderConfigurationRows(rows);

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;/);
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('DEV-P1-17: an absent row renders as unknown with its reason, never as a value', () => {
  const html = renderConfigurationRows(configurationRows({ project: {} }));

  assert.match(html, /UNKNOWN — the configuration declares no project id/);
  // A dash would be indistinguishable from a value that happens to look like one.
  assert.doesNotMatch(html, /<span class="mono">—<\/span>/);
});

test('DEV-P1-17: rendering decides nothing, so the rows are the whole contract', () => {
  const rows = configurationRows(HEALTHY);
  const first = renderConfigurationRows(rows);
  const second = renderConfigurationRows(rows);

  assert.equal(first, second, 'the renderer is pure');
  assert.equal((first.match(/class="row"/g) ?? []).length, rows.length, 'one row in, one row out');
});
