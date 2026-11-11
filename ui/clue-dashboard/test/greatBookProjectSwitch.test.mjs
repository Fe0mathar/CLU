import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function field(entryId) {
  return {
    improvementField: {
      cells: [{
        measurementId: 'SIG-001',
        name: 'Recognition time',
        segments: [{ greatBookEntryId: entryId, native: { baseline: 10, result: 5 } }],
      }],
    },
  };
}

test('Great Book clears open history and discards a response from the preceding project', async () => {
  const start = app.indexOf('(function initBookViewer()');
  const end = app.indexOf('/* ===================== Measurement Catalogue viewer', start);
  assert.ok(start >= 0 && end > start);
  const overlay = { body: { innerHTML: '', querySelector: () => null }, setSub() {} };
  const pending = [];
  const context = {
    bookViewer: null,
    projectTransition: false,
    window: {},
    CLUE_UI: {
      esc: String,
      panelButton: () => new EventTarget(),
      makeOverlay: () => overlay,
    },
    fetchJson: () => new Promise((resolve) => pending.push(resolve)),
  };
  runInNewContext(app.slice(start, end), context);
  const board = context.bookViewer;
  const first = board.refresh();
  pending.shift()(field('GBE-PROJECT-A'));
  await first;
  assert.match(overlay.body.innerHTML, /GBE-PROJECT-A/u);

  const late = board.refresh();
  const resolveLate = pending.shift();
  context.projectTransition = true;
  board.invalidate();
  assert.match(overlay.body.innerHTML, /Awaiting active project Great Book history/u);
  await board.refresh();
  assert.equal(pending.length, 0);

  context.projectTransition = false;
  const successor = board.refresh();
  pending.shift()(field('GBE-PROJECT-B'));
  await successor;
  resolveLate(field('GBE-PROJECT-A'));
  await late;
  assert.match(overlay.body.innerHTML, /GBE-PROJECT-B/u);
  assert.doesNotMatch(overlay.body.innerHTML, /GBE-PROJECT-A/u);
});
