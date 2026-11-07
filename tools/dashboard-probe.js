/*
 * CLU-E dashboard probe — paste into DevTools on http://127.0.0.1:47900
 *
 * Answers what this session could not settle from a sandbox: whether the DEV-P1-15 exposure
 * controls admit the real dashboard page, whether the SSE streams still deliver cleanly under the
 * non-overlapping pump, whether the three surfaces agree (§20 gate 4), and what Status actually
 * says about the branches recent work touched.
 *
 * READ-ONLY. It issues GETs, opens two SSE streams, and — only if you pass {control: true} —
 * one POST to /api/control/refresh, which re-projects the sealed frame and writes nothing
 * durable. It never calls /api/control/start, which spawns child processes against your tree.
 *
 *     await cluePROBE()                 // read-only
 *     await cluePROBE({control: true})  // also exercises POST /api/control/refresh
 *     await cluePROBE({seconds: 20})    // watch the streams longer (default 8)
 *
 * Downloads a JSON report and prints a summary. Written against clueDashboardServer.ts as of
 * DEV-P1-15 turn 2 (sha256 8f18c9df…134c); routes are read from that file, not guessed.
 */
async function cluePROBE(options = {}) {
  const seconds = options.seconds ?? 8;
  const control = options.control === true;
  const base = location.origin;
  const out = {
    probe: 'clue-dashboard-probe',
    version: '1.0.0',
    at: new Date().toISOString(),
    origin: base,
    href: location.href,
    userAgent: navigator.userAgent,
  };
  const log = (...a) => console.log('%c[clue]', 'color:#6cf', ...a);

  /* ------------------------------------------------------------------ */
  /* 1. Exposure — does the page itself pass the DEV-P1-15 gate?         */
  /* ------------------------------------------------------------------ */
  //
  // The interesting case is a same-origin POST. A same-origin GET sends no `Origin` header at
  // all, so it exercises the "absent is allowed" branch; a POST sends one, so it exercises the
  // comparison. If the page can GET but not POST, the allowlist does not contain the hostname
  // you navigated to — which is the failure this section exists to name rather than let you
  // discover as a dead button.
  const routes = [
    ['GET', '/api/frame'],
    ['GET', '/api/run'],
    ['GET', '/api/config'],
    ['GET', '/api/catalogue'],
    ['GET', '/api/catalogues'],
    ['GET', '/api/gauges'],
    ['GET', '/api/improvement-field'],
    ['GET', '/api/operational-console'],
    ['GET', '/api/console/current'],
    ['GET', '/api/status/current'],
    ['GET', '/api/status/schema'],
  ];
  out.routes = [];
  for (const [method, path] of routes) {
    const started = performance.now();
    try {
      const r = await fetch(base + path, { method });
      out.routes.push({
        method,
        path,
        status: r.status,
        ok: r.ok,
        ms: Math.round(performance.now() - started),
        contentType: r.headers.get('content-type'),
      });
    } catch (e) {
      out.routes.push({ method, path, status: null, ok: false, error: String(e) });
    }
  }

  if (control) {
    try {
      const r = await fetch(base + '/api/control/refresh', { method: 'POST' });
      out.controlRefresh = { status: r.status, ok: r.ok, body: await r.text() };
    } catch (e) {
      out.controlRefresh = { status: null, ok: false, error: String(e) };
    }
  } else {
    out.controlRefresh = { skipped: 'pass {control:true} to exercise the same-origin POST path' };
  }

  const denied = out.routes.filter((r) => r.status === 403 || r.status === 401);
  out.exposure = {
    allRoutesReachable: denied.length === 0,
    deniedRoutes: denied.map((r) => `${r.method} ${r.path} → ${r.status}`),
    note:
      denied.length === 0
        ? 'the page passes the Host and Origin checks from this origin'
        : 'DEV-P1-15 refused the page itself — the origin you navigated to is not in the allowlist',
  };

  /* ------------------------------------------------------------------ */
  /* 2. Agreement — §20 gate 4                                           */
  /* ------------------------------------------------------------------ */
  //
  // The contract requires the UI, CLI and API to return the same body and hash. This can only
  // check the two the browser can reach; a mismatch between them is conclusive, agreement is
  // necessary and not sufficient.
  try {
    const status = await (await fetch(base + '/api/status/current')).json();
    const console_ = await (await fetch(base + '/api/console/current')).json();
    const frame = await (await fetch(base + '/api/frame')).json();
    out.agreement = {
      statusHash: status?.seal?.statusHash ?? null,
      statusSnapshotHash: status?.seal?.snapshotHash ?? null,
      consoleSeal: console_?.seal ?? null,
      consoleRevision: console_?.revision ?? null,
      frameRevision: frame?.revision ?? null,
      frameSeal: frame?.seal ?? null,
      consoleAndFrameAgree: JSON.stringify(console_?.seal ?? null) === JSON.stringify(frame?.seal ?? null),
    };

    /* --- 3. What Status says about the branches recent work touched --- */
    out.status = {
      schemaVersion: status?.schemaVersion ?? null,
      generatedAt: status?.generatedAt ?? null,
      sealConsistent: status?.seal?.consistent ?? null,
      inconsistencies: status?.seal?.inconsistencies ?? [],
      sourcesCount: Array.isArray(status?.sources) ? status.sources.length : null,
      backed: status?.capability?.backedBranches ?? [],
      unsupported: status?.capability?.unsupportedBranches ?? [],
      satisfiedGates: status?.capability?.satisfiedGates ?? [],
      unreachableGates: status?.capability?.unreachableGates ?? [],
    };
    // DEV-P1-29 bound `target description.md` and `benchmark.txt` to the mission, but §4.1's
    // projectInputs branch reports them nowhere. Recorded so the gap is a measurement.
    out.status.projectInputs = status?.projectInputs ?? null;
    out.status.goldenMetricsProjectionState = status?.goldenMetrics?.projectionState ?? null;
    out.status.targetBranch = status?.target ?? null;
  } catch (e) {
    out.agreement = { error: String(e) };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Run state and receipts — DEV-P1-15 turn 2                        */
  /* ------------------------------------------------------------------ */
  try {
    const run = await (await fetch(base + '/api/run')).json();
    out.run = run;
    out.run_hasReceipts = Object.prototype.hasOwnProperty.call(run, 'receipts');
  } catch (e) {
    out.run = { error: String(e) };
  }

  /* ------------------------------------------------------------------ */
  /* 5. SSE streams — duplicate detection                                */
  /* ------------------------------------------------------------------ */
  //
  // The pump guard added in DEV-P1-15 turn 2 exists because an overlapping pump delivers the
  // same byte range twice. On this stream that shows up as a repeated (streamId, sequence) pair,
  // or as a line that fails to parse because two half-events were spliced. Both are counted.
  // A clean run proves nothing on its own — the overlap needs a pump slower than 250 ms — but a
  // dirty one is conclusive, and on a 392 MB stream the replay is exactly where it would happen.
  const watchStream = (path, ms) =>
    new Promise((resolve) => {
      const seen = new Map();
      const result = { path, events: 0, parseFailures: 0, duplicates: [], firstError: null, opened: false };
      let source;
      try {
        source = new EventSource(base + path);
      } catch (e) {
        result.firstError = String(e);
        resolve(result);
        return;
      }
      source.onopen = () => {
        result.opened = true;
      };
      source.onmessage = (event) => {
        result.events += 1;
        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          result.parseFailures += 1;
          if (result.firstError === null) result.firstError = `unparseable: ${event.data.slice(0, 120)}`;
          return;
        }
        const key =
          parsed.streamId !== undefined && parsed.sequence !== undefined
            ? `${parsed.streamId}#${parsed.sequence}`
            : null;
        if (key !== null) {
          const count = (seen.get(key) ?? 0) + 1;
          seen.set(key, count);
          if (count === 2 && result.duplicates.length < 20) result.duplicates.push(key);
        }
      };
      source.onerror = () => {
        if (result.firstError === null && !result.opened) result.firstError = 'stream did not open';
      };
      setTimeout(() => {
        try {
          source.close();
        } catch {
          /* already closed */
        }
        result.uniqueKeys = seen.size;
        result.duplicateCount = result.duplicates.length;
        resolve(result);
      }, ms);
    });

  log(`watching SSE for ${seconds}s…`);
  out.streams = await Promise.all([
    watchStream('/api/navigator-events', seconds * 1000),
    watchStream('/api/console-events', seconds * 1000),
  ]);

  /* ------------------------------------------------------------------ */
  /* 6. Page health                                                      */
  /* ------------------------------------------------------------------ */
  out.page = {
    title: document.title,
    scriptCount: document.querySelectorAll('script').length,
    canvasCount: document.querySelectorAll('canvas').length,
    // A quadrant that failed to render usually leaves its container empty rather than throwing.
    emptyContainers: [...document.querySelectorAll('[id]')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '')
      .map((el) => el.id)
      .slice(0, 40),
    documentReadyState: document.readyState,
  };

  /* ------------------------------------------------------------------ */
  /* Summary                                                             */
  /* ------------------------------------------------------------------ */
  console.group('%cCLU-E dashboard probe', 'color:#6cf;font-weight:bold');
  log('origin           :', base);
  log('exposure         :', out.exposure.allRoutesReachable ? 'all routes reachable' : `DENIED: ${out.exposure.deniedRoutes.join(', ')}`);
  if (out.controlRefresh.status !== undefined) log('POST refresh     :', out.controlRefresh.status);
  log('status hash      :', out.agreement?.statusHash ?? '(unavailable)');
  log('console/frame    :', out.agreement?.consoleAndFrameAgree ? 'seals agree' : 'SEALS DIFFER');
  log('sources          :', out.status?.sourcesCount, '(§15 — 0 while branches are populated is the open gap)');
  log('projectInputs    :', out.status?.projectInputs?.state ?? '(absent)');
  log('goldenMetrics    :', out.status?.goldenMetricsProjectionState ?? '(absent)');
  log('run.receipts     :', out.run_hasReceipts ? `present (${out.run?.receipts?.length ?? 0})` : 'ABSENT — DEV-P1-15 turn 2 not applied');
  for (const s of out.streams) {
    log(
      `stream ${s.path}`.padEnd(34),
      `${s.opened ? 'opened' : 'DID NOT OPEN'} · ${s.events} events · ${s.uniqueKeys ?? 0} unique · ` +
        `${s.duplicateCount ?? 0} duplicated · ${s.parseFailures} unparseable` +
        (s.firstError ? ` · ${s.firstError}` : ''),
    );
  }
  console.groupEnd();

  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clue-dashboard-probe-${out.at.replace(/[:.]/g, '-')}.json`;
  a.click();
  log('report downloaded:', a.download);
  return out;
}

await cluePROBE();
