/**
 * DEV-P1-21 assessment probe — measures, it does not assert and it fixes nothing.
 *
 * Three questions the obligation asks, put to the running ledger rather than to the source:
 *
 *   A  two batches into one session — are both raw batches still reachable?
 *   B  a signature re-observed under a better attributor — is the earlier attribution
 *      still queryable, or only present in the raw event log?
 *   C  scenario / checkpoint / run — which of the four bindings actually reach a record?
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactStore } from '../dist/src/memory/artifactStore.js';
import { EventLog } from '../dist/src/memory/eventLog.js';
import { ProjectionStore } from '../dist/src/memory/db.js';
import {
  ConsoleLedger,
  CONSOLE_PROJECTORS,
  ensureConsoleSchema,
} from '../dist/src/experiment/console/consoleLedger.js';

const root = mkdtempSync(join(tmpdir(), 'p1-21-'));
const workspace = join(root, 'workspace');
for (const dir of ['db', 'events', 'blobs']) mkdirSync(join(workspace, dir), { recursive: true });

const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'), {
  projectors: CONSOLE_PROJECTORS,
});
const artifacts = new ArtifactStore(join(workspace, 'blobs'));
const { log } = EventLog.open(join(workspace, 'events'));
const eventFile = join(workspace, 'events', 'events.ndjson');
ensureConsoleSchema(projections.db);

/** The log has no public reader; the NDJSON file is the authority. */
function readEvents() {
  return readFileSync(eventFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function entry(text, scenarioId, checkpointId) {
  return {
    level: 'error',
    text,
    frames: [{ url: 'http://localhost:5173/src/world.ts', line: 42, column: 7, functionName: 'tick' }],
    timestamp: new Date().toISOString(),
    scenarioId,
    stepIndex: 3,
    checkpointId,
  };
}

/** First pass: nothing resolves. Second pass: a source map arrived. */
let attributionDetail = 'no attributor configured';
let attributionOutcome = 'unattributable';
let attributedTo = null;

console.log('--- DEV-P1-21 assessment probe ---');

/* -- 0: can the ledger append at all? ------------------------------------ */

const blocked = new ConsoleLedger({
  log,
  projections,
  artifacts,
  missionVersion: () => 'MISSION-000001',
});
console.log('\n0  beginSession against the real EventLog');
try {
  blocked.beginSession({ snapshotId: 'a'.repeat(64), scenarioId: 'SCEN-boot', origin: 'shadow' });
  console.log('   APPENDED');
} catch (error) {
  console.log(`   REFUSED  ${String(error.message).split('\n').slice(0, 2).join(' | ').trim()}`);
}

/**
 * To answer anything else the session id has to be acceptable to the log, so the rest of
 * the probe runs against a log whose subject id is rewritten on the way in. A measurement
 * harness, not a proposed fix.
 */
const relaxedLog = new Proxy(log, {
  get(target, property, receiver) {
    if (property === 'append') {
      return (input) => target.append({ ...input, subjectId: 'SESSION-000001' });
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const ledger = new ConsoleLedger({
  log: relaxedLog,
  projections,
  artifacts,
  missionVersion: () => 'MISSION-000001',
  attributor: () => ({
    outcome: attributionOutcome,
    logicalId: attributedTo,
    path: attributedTo === null ? null : 'src/world.ts',
    line: attributedTo === null ? null : 42,
    detail: attributionDetail,
  }),
});

const session = ledger.beginSession({
  snapshotId: 'a'.repeat(64),
  scenarioId: 'SCEN-boot',
  origin: 'shadow',
});
console.log(`session ${session.id}`);

/* -- A: two batches into one session ------------------------------------- */

ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot', 'CHK-01')]);
const afterFirst = ledger.session(session.id);
const firstBatchHash = afterFirst.raw_log_hash;
const firstEntries = ledger.rawEntries(session.id);

ledger.ingest(session.id, [entry('failed to load tile 92', 'SCEN-combat', 'CHK-07')]);
const afterSecond = ledger.session(session.id);
const secondBatchHash = afterSecond.raw_log_hash;
const secondEntries = ledger.rawEntries(session.id);

console.log('\nA  raw batches');
console.log(`   batch 1 hash            : ${firstBatchHash?.slice(0, 16)}`);
console.log(`   batch 2 hash            : ${secondBatchHash?.slice(0, 16)}`);
console.log(`   pointer changed         : ${String(firstBatchHash !== secondBatchHash)}`);
console.log(`   rawEntries() after 1    : ${firstEntries.length} entr(ies) — ${firstEntries.map((e) => e.text).join(', ')}`);
console.log(`   rawEntries() after 2    : ${secondEntries.length} entr(ies) — ${secondEntries.map((e) => e.text).join(', ')}`);
console.log(`   entry_count on session  : ${afterSecond.entry_count}`);

// Is batch 1 still IN the artifact store, and does any record still point at it?
let batch1StillStored = false;
try {
  const blob = artifacts.getJson(firstBatchHash);
  batch1StillStored = Array.isArray(blob?.entries);
} catch {
  batch1StillStored = false;
}
const sessionPointers = projections.db
  .prepare('SELECT COUNT(*) AS n FROM console_sessions WHERE raw_log_hash = ?')
  .get(firstBatchHash).n;
let manifestPointers = 0;
try {
  manifestPointers = projections.db
    .prepare('SELECT COUNT(*) AS n FROM console_batches WHERE artifact_hash = ?')
    .get(firstBatchHash).n;
} catch {
  manifestPointers = -1; // no manifest table in this build
}
console.log(`   batch 1 blob still exists : ${String(batch1StillStored)}`);
console.log(`   session rows pointing at it : ${String(sessionPointers)}`);
console.log(`   manifest rows pointing at it: ${manifestPointers === -1 ? 'no console_batches table' : String(manifestPointers)}`);

let manifest = [];
try {
  manifest = projections.db
    .prepare('SELECT sequence, artifact_hash, entry_count FROM console_batches WHERE session_id = ? ORDER BY sequence')
    .all(session.id);
} catch { /* no manifest table */ }
console.log(`   manifest rows            : ${manifest.length}`);
for (const row of manifest) {
  console.log(`     #${row.sequence} ${row.artifact_hash.slice(0, 16)} entries=${row.entry_count}`);
}

/* -- B: attribution revision --------------------------------------------- */

attributionOutcome = 'attributed';
attributedTo = 'unit:src/world.ts#tick';
attributionDetail = 'source map resolved the top frame';
ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot', 'CHK-01')]);

const sig = ledger.signatures({})[0];
console.log('\nB  attribution revision');
console.log(`   current outcome        : ${sig.attribution_outcome}`);
console.log(`   current attributed_to  : ${sig.attributed_to ?? 'null'}`);
console.log(`   current detail         : ${sig.attribution_detail}`);

const observed = readEvents()
  .filter((record) => record.type === 'console.signature_observed')
  .map((record) => record.payload.signature_record);
console.log(`   revisions in event log : ${observed.length}`);
for (const [index, record] of observed.entries()) {
  console.log(`     ${index + 1}. ${record.attribution_outcome.padEnd(15)} ${record.attribution_detail}`);
}
let history = [];
try {
  history = projections.db
    .prepare('SELECT revision, attribution_outcome, attribution_detail FROM console_attributions ORDER BY revision')
    .all();
} catch { /* no history table in this build */ }
console.log(`   revisions queryable    : ${history.length}`);
for (const row of history) {
  console.log(`     r${row.revision} ${row.attribution_outcome.padEnd(15)} ${row.attribution_detail}`);
}
const revisionTables = projections.db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'console%'")
  .all()
  .map((row) => row.name);
console.log(`   console tables         : ${revisionTables.join(', ')}`);

/* -- C: the four bindings ------------------------------------------------ */

const sightingRows = projections.db.prepare('SELECT * FROM console_sightings').all();
console.log('\nC  bindings that reach a record');
console.log(`   snapshot   : session.snapshot_id = ${afterSecond.snapshot_id?.slice(0, 8)}…`);
console.log(`   scenario   : ${sightingRows.length} sighting row(s) for a session that saw two scenarios`);
for (const row of sightingRows) {
  console.log(`                session=${row.session_id} scenario=${row.scenario_id} occurrences=${row.occurrences}`);
}
const sigRow = projections.db.prepare('SELECT scenario_count, occurrences FROM console_signatures').get();
console.log(`                signature.scenario_count=${sigRow.scenario_count} occurrences=${sigRow.occurrences}`);
const checkpointRows = projections.db
  .prepare('SELECT scenario_id, checkpoint_id, occurrences FROM console_sightings ORDER BY scenario_id')
  .all();
console.log(`   checkpoint : entries carried CHK-01 / CHK-07`);
for (const row of checkpointRows) {
  console.log(`                scenario=${row.scenario_id} checkpoint=${row.checkpoint_id ?? 'null'} occurrences=${row.occurrences}`);
}
console.log(`                columns holding a checkpoint: ${
  revisionTables
    .flatMap((t) => projections.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${t}.${c.name}`))
    .filter((n) => n.toLowerCase().includes('checkpoint'))
    .join(', ') || 'none'
}`);
console.log(`   run        : columns holding a run id: ${
  revisionTables
    .flatMap((t) => projections.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${t}.${c.name}`))
    .filter((n) => /run/i.test(n))
    .join(', ') || 'none'
}`);

projections.close();
log.close();
rmSync(root, { recursive: true, force: true });
