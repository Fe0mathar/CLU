import { setTimeout as delay } from 'node:timers/promises';

import { parseWindowsSandboxInventory, parseWindowsSandboxStartId } from './windowsSandboxCli.mjs';

const listArgs = ['list', '--raw'];

async function inventory(invoke, signal) {
  const result = await invoke(listArgs, 6000, signal);
  if (result.code !== 0) return null;
  try {
    return parseWindowsSandboxInventory(result.stdout);
  } catch {
    return null;
  }
}

async function confirmOwned(invoke, id, signal, pause) {
  for (let attempt = 0; attempt < 4 && !signal?.aborted; attempt++) {
    const ids = await inventory(invoke, signal);
    if (ids?.length) return ids;
    if (attempt < 3) await pause(350);
  }
  return null;
}

async function cleanup(invoke, id, start, ownershipObserved, pause) {
  const seen = await inventory(invoke);
  if (!ownershipObserved && !seen?.includes(id)) {
    if (start.code === null || start.code === 0 || seen === null) return 'UNVERIFIED';
    await pause(700);
    const settled = await inventory(invoke);
    if (settled === null) return 'UNVERIFIED';
    if (!settled.includes(id)) return 'NO_OWNED_SESSION_OBSERVED';
  }
  await invoke(['stop', '--id', id], 20000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const remaining = await inventory(invoke);
    if (remaining !== null && !remaining.includes(id)) return 'EXACT_SESSION_ABSENT';
    if (attempt < 4) await pause(500);
  }
  return 'UNVERIFIED';
}

/** Start and clean up only the newly allocated ID. The caller owns the mapped fixture stage. */
export async function exerciseWindowsSandboxSession({ id, configuration, invoke, collect, signal, pause = delay }) {
  const report = {
    state: 'WSB_INVENTORY_UNAVAILABLE',
    inventory: 'UNVERIFIED',
    start: null,
    connect: { attempted: false, exitCode: null },
    cleanup: 'NOT_REQUIRED',
    fixture: null,
  };
  const initial = await inventory(invoke, signal);
  if (initial === null) return report;
  if (initial.length !== 0) {
    report.inventory = 'EXISTING_SESSION';
    report.state = 'WSB_EXISTING_SESSION';
    return report;
  }
  report.inventory = 'CLEAR';
  if (signal?.aborted) {
    report.state = 'WSB_INTERRUPTED';
    return report;
  }

  let start = { code: null, stdout: '' };
  let ownershipObserved = false;
  let connection = null;
  const connectAbort = new AbortController();
  try {
    report.state = 'WSB_START_FAILED';
    start = await invoke(['start', '--id', id, '--config', configuration, '--raw'], 65000, signal);
    const reportedId = parseWindowsSandboxStartId(start.stdout);
    ownershipObserved = reportedId === id;
    report.start = {
      exitCode: start.code,
      failure: start.failure ?? null,
      hresult: start.hresult ?? null,
      returnedId: reportedId === null ? 'UNRECOGNIZED' : ownershipObserved ? 'MATCHED' : 'DIFFERENT',
      ownershipObserved,
    };
    if (signal?.aborted) return report;
    if (start.code !== 0) return report;

    const active = await confirmOwned(invoke, id, signal, pause);
    if (active?.includes(id)) ownershipObserved = true;
    report.start.ownershipObserved = ownershipObserved;
    if (active?.length !== 1 || active[0] !== id || (reportedId !== null && reportedId !== id)) {
      report.state = 'WSB_SESSION_IDENTITY_UNVERIFIED';
      return report;
    }

    report.state = 'WSB_FIXTURE_RESULT_UNAVAILABLE';
    report.fixture = await collect(() => {
      if (connection !== null || signal?.aborted) return;
      report.connect.attempted = true;
      connection = invoke(['connect', '--id', id], 60000, connectAbort.signal).then((result) => {
        report.connect.exitCode = result.code;
      });
    });
    if (report.fixture !== null) report.state = 'WSB_FIXTURE_OBSERVED';
  } catch {
    report.state = 'WSB_FIXTURE_OR_LIFECYCLE_UNVERIFIED';
  } finally {
    try {
      report.cleanup = await cleanup(invoke, id, start, ownershipObserved, pause);
    } catch {
      report.cleanup = 'UNVERIFIED';
    } finally {
      connectAbort.abort();
      await connection;
    }
    if (signal?.aborted) report.state = 'WSB_INTERRUPTED';
    if (report.cleanup === 'UNVERIFIED') report.state = 'WSB_CLEANUP_UNVERIFIED';
  }
  return report;
}
