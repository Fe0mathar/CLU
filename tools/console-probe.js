/*
 * CLU-E console probe v3 — read-only, browser side.
 *
 * Paste into DevTools on the dashboard (http://localhost:47900 or 127.0.0.1:47900), press Enter.
 * It prints a readable summary AND automatically downloads a JSON artifact containing everything
 * it read, so nothing has to be copied out of a console pane by hand.
 *
 * ## What changed from v1, and why
 *
 * v1 reported almost every field as ABSENT or NOT PRESENT. That was the probe being wrong, not
 * the console being empty. Three bad assumptions, all made from the contract documents rather
 * than from the shape the daemon actually emits:
 *
 *   1. Seal fields were looked for at the top of `/api/console/current`. The real body is
 *      `{ revision, seal, snapshot }` — `snapshotHash`, `statusHash` and `consistent` are one
 *      level down, under `.seal`.
 *   2. The five §19.3 surfaces were looked for at the top of the console body. They live at
 *      `snapshot.dashboard.startStop`, `.sessions`, `.pipeline`, and readiness hangs off
 *      `startStop` rather than standing alone.
 *   3. Status was searched for a `branches` map. There is none: the branch names ARE the
 *      top-level keys of the Status body, alongside `schemaVersion`, `generatedAt` and `seal`.
 *
 * v2 reads the real paths, and where it still cannot find something it prints the path it tried,
 * so the next correction is one line rather than another round trip.
 *
 * ## What it will not do
 *
 * GET only, and only: /api/status/current, /api/console/current, /api/config, /api/gauges,
 * /api/frame. The two `/api/*-events` endpoints are Server-Sent Event streams and are
 * deliberately NOT fetched — v2 hung forever on them. It never calls /api/control/start,
 * /api/control/refresh or /api/run — those are the write surface, and a diagnostic that can
 * start a run is not a diagnostic.
 *
 * Every request is bounded at 5 seconds. The whole run should finish in about one.
 *
 * ## Output
 *
 * A file lands in Downloads: `clue-console-probe-<timestamp>.json`, containing the raw bodies
 * and the derived tables. Send that; the console text is only for reading along.
 */

(async () => {
  const lines = [];
  const say = (text = '') => {
    lines.push(text);
    console.log(text);
  };
  const head = (text) => {
    say('');
    say(text);
    say('-'.repeat(text.length));
  };

  const raw = {};
  const errors = {};

  /*
   * Every request is bounded, and the reason is a defect this probe had in v2.
   *
   * `/api/console-events` and `/api/navigator-events` are `text/event-stream` — Server-Sent
   * Events. `response.json()` on a stream that never ends never resolves, so the probe printed
   * its header and hung forever with no error to report. A `try/catch` cannot catch a promise
   * that simply never settles.
   *
   * Two fixes, both needed. The stream endpoints are no longer fetched at all — they are noted
   * and skipped, because a probe has no business holding a subscription open. And every
   * remaining request carries a timeout, so a slow or wedged endpoint costs five seconds and a
   * printed reason rather than the whole run.
   */
  const STREAM_ENDPOINTS = ['/api/console-events', '/api/navigator-events'];

  const get = async (path) => {
    if (STREAM_ENDPOINTS.includes(path)) {
      errors[path] = 'text/event-stream — not fetched; a probe must not hold a subscription open';
      raw[path] = null;
      return null;
    }
    // The deadline is enforced HERE rather than delegated to `fetch`.
    //
    // `AbortSignal.timeout` is the obvious tool and it is not sufficient on its own: it only
    // helps if the fetch implementation honours the signal, and the whole reason this version
    // exists is that a request which never settles produces no error to catch. Racing against a
    // timer bounds the wait whatever fetch does, and the abort signal is still passed so a real
    // browser also stops the transfer rather than leaving it running behind a resolved promise.
    const deadline = (work) =>
      Promise.race([
        work,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 5s')), 5000)),
      ]);

    try {
      const response = await deadline(
        fetch(path, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
          headers: { accept: 'application/json' },
        }),
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('json')) {
        // Read as text under the same deadline rather than calling `.json()` on something that
        // may not terminate. An unexpected content type is a finding, not a reason to hang.
        const text = await deadline(response.text());
        throw new Error(`content-type ${type || '(none)'} — first 60 chars: ${text.slice(0, 60)}`);
      }
      const body = await deadline(response.json());
      raw[path] = body;
      return body;
    } catch (error) {
      const name = error?.name ?? '';
      errors[path] =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'timed out after 5s'
          : (error?.message ?? String(error));
      raw[path] = null;
      return null;
    }
  };

  /** Reads a dotted path, returning `undefined` rather than throwing. */
  const at = (root, path) =>
    path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), root);

  /** Describes shape without dumping content — the summary has to stay readable. */
  const shape = (value, depth = 0) => {
    if (value === undefined) return 'ABSENT';
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array[${value.length}]`;
    const type = typeof value;
    if (type !== 'object') {
      return type === 'string' ? JSON.stringify(value).slice(0, 60) : String(value);
    }
    const keys = Object.keys(value);
    return depth === 0 ? `object{${keys.join(', ')}}` : `object{${keys.length} keys}`;
  };

  say('CLU-E console probe v3 — read-only');
  say(`origin:  ${window.location.origin}`);
  say(`run at:  ${new Date().toISOString()}`);

  const status = await get('/api/status/current');
  const consoleBody = await get('/api/console/current');
  const config = await get('/api/config');
  await get('/api/gauges');
  await get('/api/frame');
  // The two event-stream endpoints are recorded as skipped rather than fetched. See `get`.
  await get('/api/console-events');
  await get('/api/navigator-events');

  const derived = {};

  /* --------------------------------------------------------------------- */

  head('A. Endpoints');
  for (const [path, body] of Object.entries(raw)) {
    say(`  ${path.padEnd(26)} ${errors[path] ? `FAILED: ${errors[path]}` : shape(body)}`);
  }

  /* --------------------------------------------------------------------- */

  head('B. The seal — ADR-0002 split it deliberately');
  {
    const seal = at(consoleBody, 'seal');
    const statusSeal = at(status, 'seal');
    derived.seal = { console: seal ?? null, status: statusSeal ?? null };

    say(`  console.seal            ${shape(seal)}`);
    for (const field of ['snapshotHash', 'statusHash', 'consistent', 'capturedAt', 'statusCapturedAt']) {
      say(`      .${field.padEnd(20)} ${shape(at(seal, field), 1)}`);
    }
    say(`  status.seal             ${shape(statusSeal)}`);

    // `snapshotHash` is change detection and must move when readiness or the active tab moves;
    // `statusHash` names the Status body reflected. Repointing the first at the second was tried
    // and stopped the dashboard republishing — the regression ADR-0002 records.
    const a = at(seal, 'statusHash');
    const b = at(statusSeal, 'hash') ?? at(statusSeal, 'statusHash') ?? at(statusSeal, 'sha256');
    say('');
    say(`  console.seal.statusHash vs the Status seal: ${
      a === undefined || b === undefined
        ? 'one was not found — the paths tried are printed above'
        : a === b
          ? 'MATCH'
          : 'DIFFER'
    }`);
    say('  A difference is not automatically a defect — a capture-instant skew is expected.');
    say('  What the ADR needs is whether the console names a Status body at all.');
  }

  /* --------------------------------------------------------------------- */

  head('C. §19.3 — the contested surfaces, at their real paths');
  {
    const paths = {
      startStop: 'snapshot.dashboard.startStop',
      readiness: 'snapshot.dashboard.startStop.readiness',
      sessions: 'snapshot.dashboard.sessions',
      pipeline: 'snapshot.dashboard.pipeline',
      shell: 'snapshot.shell',
      configuration: 'snapshot.configuration',
    };
    derived.surfaces = {};
    for (const [name, path] of Object.entries(paths)) {
      const value = at(consoleBody, path);
      derived.surfaces[name] = value ?? null;
      say(`  ${name.padEnd(14)} ${path.padEnd(44)} ${shape(value)}`);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, inner] of Object.entries(value)) {
          say(`      .${key.padEnd(26)} ${shape(inner, 1)}`);
        }
      }
    }

    say('');
    say('  Does Status already carry the same facts? (searched over the whole Status body)');
    const statusText = JSON.stringify(status ?? {});
    derived.statusMentions = {};
    for (const term of ['startStop', 'sessions', 'pipeline', 'readiness', 'chrome', 'powershell']) {
      const found = statusText.includes(`"${term}"`);
      derived.statusMentions[term] = found;
      say(`      "${term}"${' '.repeat(Math.max(1, 13 - term.length))}${found ? 'YES' : 'no'}`);
    }
    say('');
    say('  A surface the console has and Status does not is either a host fact — correctly kept');
    say('  local — or a missing Status branch. Which one it is, is the ADR.');
  }

  /* --------------------------------------------------------------------- */

  head('D. Status branches — the top-level keys ARE the branches');
  {
    const BACKED = ['target', 'repositoryInventory', 'recognition', 'q1', 'currentWork', 'units',
      'measurementCatalogue', 'improvementField', 'gauges', 'operationalConsole', 'runtimeDiagnostics'];
    const NON_BRANCH = ['schemaVersion', 'generatedAt', 'seal', 'sources', 'capability', 'goldenMetrics'];

    const table = [];
    for (const key of Object.keys(status ?? {})) {
      if (NON_BRANCH.includes(key)) continue;
      const value = status[key];
      const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
      table.push({
        branch: key,
        expected: BACKED.includes(key) ? 'backed' : 'unsupported',
        state: isObject ? (value.state ?? value.status ?? null) : null,
        reason: isObject ? (value.reason ?? value.unsupportedReason ?? null) : null,
      });
    }
    derived.branches = table;

    const backedSeen = table.filter((r) => r.expected === 'backed').length;
    say(`  branch-shaped keys: ${table.length}   (source says 35: 11 backed + 24 unsupported)`);
    say(`  expected-backed present: ${backedSeen}   expected-unsupported present: ${table.length - backedSeen}`);
    say('');

    const withState = table.filter((r) => r.state !== null);
    say(`  carrying an explicit state: ${withState.length}`);
    for (const row of withState) {
      say(`      ${row.branch.padEnd(30)} ${String(row.state).padEnd(14)} ${row.reason ? String(row.reason).slice(0, 58) : 'NO REASON GIVEN'}`);
    }

    const noState = table.filter((r) => r.state === null).map((r) => r.branch);
    if (noState.length > 0) {
      say('');
      say(`  no explicit state field: ${noState.join(', ')}`);
      say('  (expected for backed branches, which carry data instead)');
    }
    say('');
    say('  11/24 matching means the running daemon agrees with the source. Every unsupported');
    say('  branch should carry a stated reason — one without is a branch claiming nothing');
    say('  rather than declaring why it has nothing.');
  }

  /* --------------------------------------------------------------------- */

  head('E. /api/config — bootstrap readiness, not host configuration');
  {
    derived.config = config ?? null;
    if (config) {
      for (const [key, value] of Object.entries(config)) {
        say(`  ${key.padEnd(26)} ${shape(value, 1)}`);
      }
      say('');
      say('  v1 expected chrome/powershell/ide here; they are not present. This endpoint answers');
      say('  "can a run start", not "what machine is this". `startable` is the readiness fact and');
      say('  is derived from local disk state — a tsconfig, an initialised workspace, a committed');
      say('  graph pointer. That is the strongest evidence yet that readiness is a host fact.');
    }
  }

  /* --------------------------------------------------------------------- */

  head('F. Download');
  {
    const report = {
      probeVersion: 3,
      origin: window.location.origin,
      runAt: new Date().toISOString(),
      errors,
      derived,
      raw,
      summaryText: lines.join('\n'),
    };

    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const name = `clue-console-probe-${stamp}.json`;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    window.__clueProbe = report;
    say(`  downloading: ${name}`);
    say('  If the browser blocked it, the same object is at `window.__clueProbe` —');
    say('  run  copy(JSON.stringify(window.__clueProbe, null, 2))  instead.');
  }

  say('');
  say('REPORT COMPLETE — send the downloaded .json');
})();
