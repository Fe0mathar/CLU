/**
 * DEV-P1-23 vacuity probe — measures, it does not assert.
 *
 * Three cases against the built recorder:
 *   A  an exchange opened with NO correlation identity
 *   B  an exchange opened as hostClient/browserAgent open one (physicalCallId present)
 *   C  recordState, which carries exchangeId null and must stay exempt
 *
 * Prints, for each, whether the append was refused and how many events reached the
 * append-only file. Run once with the guard present and once with it reverted; the
 * difference between the two runs is the proof the guard does something.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactStore } from '../dist/src/memory/artifactStore.js';
import { OperationalConsoleEventStore } from '../dist/src/observability/operationalConsole/store.js';
import { OperationalConsoleRecorder } from '../dist/src/observability/operationalConsole/recorder.js';
import { readOperationalConsoleEvents } from '../dist/src/observability/operationalConsole/store.js';

const root = mkdtempSync(join(tmpdir(), 'p1-23-'));
const eventFile = join(root, 'events.ndjson');
const store = OperationalConsoleEventStore.open(eventFile);
const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(join(root, 'blobs')), {
  environment: {},
});

const base = {
  channel: 'CHROME_CDP',
  kind: 'request',
  title: 'CDP request · Page.navigate',
  what: 'Transmit the exact CDP request.',
  why: 'Probe.',
  status: 'TRANSMITTING',
  exactPayload: JSON.stringify({ id: 1, method: 'Page.navigate' }),
  payloadFormat: 'json',
};

function attempt(label, fn) {
  const before = readOperationalConsoleEvents(eventFile).length;
  let outcome;
  try {
    fn();
    outcome = 'APPENDED';
  } catch (error) {
    outcome = `REFUSED  ${error?.name ?? 'Error'}/${error?.code ?? '-'}: ${error?.message ?? String(error)}`;
  }
  const after = readOperationalConsoleEvents(eventFile).length;
  console.log(`${label.padEnd(46)} ${outcome}`);
  console.log(`${''.padEnd(46)} events ${before} -> ${after}`);
  return after;
}

console.log('--- DEV-P1-23 correlation probe ---');

attempt('A  exchange, no correlation identity', () => {
  recorder.beginExchange({ ...base });
});

attempt('A2 exchange, correlation present but blank', () => {
  recorder.beginExchange({ ...base, physicalCallId: '   ' });
});

attempt('B  exchange, physicalCallId (production shape)', () => {
  const exchange = recorder.beginExchange({ ...base, physicalCallId: 'CDP-1' });
  exchange.receive({
    title: 'CDP response',
    what: 'Receive.',
    why: 'Probe.',
    status: 'RECEIVED',
    exactPayload: JSON.stringify({ id: 1, result: {} }),
    payloadFormat: 'json',
  });
  exchange.summarize({
    title: 'Navigated',
    what: 'Done.',
    why: 'Probe.',
    status: 'OK',
    validationState: 'schema_validated',
  });
});

attempt('C  recordState (exchangeId null, exempt)', () => {
  recorder.recordState({
    channel: 'CLUE_CORE',
    title: 'daemon started',
    what: 'Probe.',
    why: 'Probe.',
    status: 'RUNNING',
  });
});

const final = readOperationalConsoleEvents(eventFile);
console.log(`\nfinal events: ${final.length}`);
for (const event of final) {
  console.log(
    `  seq=${event.sequence} kind=${event.kind} exchangeId=${event.exchangeId ?? 'null'} ` +
      `physicalCallId=${event.physicalCallId ?? 'null'} runId=${event.runId ?? 'null'}`,
  );
}

store.close();
rmSync(root, { recursive: true, force: true });
