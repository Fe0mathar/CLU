/* CLU-E Patch 05D focused, read-only Status and Navigator probe. */
(async () => {
  'use strict';
  const report = {
    schemaVersion: 'clue-status-navigator-probe/2',
    collectedAt: new Date().toISOString(),
    checks: [],
  };
  const check = (id, outcome) => {
    report.checks.push({ id, state: outcome === null ? 'PENDING' : outcome ? 'PASS' : 'FAIL' });
  };
  const backedBranches = [
    'target', 'projectProfile', 'cycle', 'repositoryInventory', 'recognition', 'q1',
    'currentWork', 'units', 'measurementCatalogue', 'improvementField', 'gauges',
    'operationalConsole', 'aiOrchestration', 'proofPipeline', 'greatBook', 'runtimeDiagnostics',
  ];
  const unsupportedBranches = [
    'projectInputs', 'assessmentEnvelope', 'rpi', 'environments', 'universalProjectRepresentation',
    'crossEnvironment', 'purposeAndCapabilities', 'intentAndMethods', 'solutionFrontier',
    'functionalities', 'measureSessions', 'proofInstruments', 'humanEvaluations', 'findings',
    'benchmarks', 'improvementEconomics', 'versionControl', 'integrations', 'assessment', 'equilibrium',
  ];
  const absenceStates = ['unsupported', 'unavailable', 'unknown', 'not_applicable', 'conflicted', 'stale'];
  const statusBranches = [...backedBranches, ...unsupportedBranches];
  const quadrantBranches = {
    q1: 'repositoryInventory', q2: 'improvementField', q3: 'gauges', q4: 'operationalConsole',
  };
  const projectedRoutes = [
    ['console', '/api/console/current', 'snapshot'], ['field', '/api/improvement-field', 'improvementField'],
    ['gauges', '/api/gauges', 'gauges'], ['operation', '/api/operational-console', 'operationalConsole'],
  ];
  const routes = new Set([
    '/api/frame', '/api/status/current', '/api/status/schema', '/api/config',
    ...projectedRoutes.map(([, path]) => path),
  ]);
  const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const flag = (value) => typeof value === 'boolean' ? value : null;
  const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
  const present = (value) => typeof value === 'string' && value.length > 0;
  const equals = (left, right) => present(left) && present(right) ? left === right : null;
  const allowed = (value, list) => list.includes(value) ? value : null;

  function reconcile(comparisons) {
    if (comparisons.includes(false)) return false;
    return comparisons.includes(null) ? null : true;
  }

  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (record(value)) {
      return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  async function sealedHash(value) {
    if (!record(value) || !globalThis.crypto?.subtle) return null;
    const { seal: ignored, ...body } = value;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(body)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function get(path) {
    if (!routes.has(path)) throw new Error('Unsupported probe route');
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 6500);
    const limit = 20 * 1024 * 1024;
    let reader;
    let http = null;
    try {
      const response = await fetch(new URL(path, location.origin), {
        method: 'GET', credentials: 'omit', mode: 'same-origin', redirect: 'error',
        cache: 'no-store', signal: abort.signal, headers: { Accept: 'application/json' },
      });
      http = response.status;
      if (!response.ok) return { http, state: 'HTTP_ERROR' };
      if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        return { http, state: 'UNEXPECTED_CONTENT' };
      }
      if (Number(response.headers.get('content-length')) > limit) return { http, state: 'SIZE_LIMIT' };
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) return { http, state: 'SIZE_LIMIT' };
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      try { return { http, state: 'OK', value: JSON.parse(chunks.join('')) }; }
      catch { return { http, state: 'INVALID_JSON' }; }
    } catch {
      return { http, state: abort.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
    } finally {
      clearTimeout(deadline);
      if (reader) void reader.cancel().catch(() => {});
      abort.abort();
    }
  }

  function branchState(branch) {
    if (Array.isArray(branch) || (record(branch) && !own(branch, 'state'))) return 'backed';
    if (record(branch) && absenceStates.includes(branch.state) && typeof branch.reason === 'string' && branch.reason.trim() !== '') {
      return branch.state;
    }
    return branch === undefined ? 'missing' : 'malformed';
  }

  function inspectInventory(status) {
    if (!record(status)) return null;
    const branches = Object.fromEntries(statusBranches.map((key) => [key, branchState(status[key])]));
    const capable = Array.isArray(status.capability?.backedBranches) && Array.isArray(status.capability?.unsupportedBranches);
    const listedBacked = capable ? status.capability.backedBranches : [];
    const listedUnsupported = capable ? status.capability.unsupportedBranches : [];
    const populated = backedBranches.filter((key) => branches[key] === 'backed');
    const expectedKeys = new Set([...statusBranches, 'schemaVersion', 'generatedAt', 'goldenMetrics', 'sources', 'capability', 'seal']);
    const declaredBacked = backedBranches.filter((key) => listedBacked.includes(key));
    const declaredUnsupported = unsupportedBranches.filter((key) => listedUnsupported.includes(key));
    const undeclaredPopulated = populated.filter((key) => !listedBacked.includes(key));
    const declaredBackedWithoutValue = declaredBacked.filter((key) => branches[key] !== 'backed');
    const unsupportedShapeMismatches = unsupportedBranches.filter((key) => branches[key] !== 'unsupported');
    const shapeErrors = statusBranches.filter((key) => ['missing', 'malformed'].includes(branches[key]));
    const unknownTopLevelCount = Object.keys(status).filter((key) => !expectedKeys.has(key)).length;
    const absentTopLevel = [...expectedKeys].filter((key) => !own(status, key));
    const exact = capable && listedBacked.length === declaredBacked.length &&
      listedUnsupported.length === declaredUnsupported.length && declaredUnsupported.length === unsupportedBranches.length &&
      [undeclaredPopulated, declaredBackedWithoutValue, unsupportedShapeMismatches, shapeErrors, absentTopLevel].every((items) => items.length === 0) &&
      unknownTopLevelCount === 0;
    return {
      exact, branches, declaredBacked, declaredUnsupported, populated, undeclaredPopulated,
      declaredBackedWithoutValue, unsupportedShapeMismatches, shapeErrors, unknownTopLevelCount, absentTopLevel,
    };
  }

  function inspectUi(status) {
    const panelStates = Object.fromEntries(Object.entries(quadrantBranches).map(([id, branch]) => {
      const panel = document.getElementById(id);
      const source = branchState(status?.[branch]);
      const expected = source === 'backed' ? 'value' : allowed(source, absenceStates)?.replaceAll('_', '-') ?? null;
      const actual = allowed(panel?.dataset.statusState, [
        'value', 'unknown-branch', 'malformed', ...absenceStates.map((state) => state.replaceAll('_', '-')),
      ]);
      const declared = allowed(panel?.dataset.statusBranch, Object.values(quadrantBranches));
      const matches = expected === null || !panel ? null
        : actual === null ? null
          : actual === expected && declared === branch;
      check('quadrant-' + id, matches);
      return [id, { expectedBranch: branch, reportedBranch: declared, expected, actual, matches }];
    }));
    const configurationSelected = document.getElementById('tabConfiguration')?.getAttribute('aria-selected') === 'true';
    const config = document.getElementById('cfgBody');
    const allowedSections = ['project', 'project-authority', 'recognition', 'powershell-host', 'git', 'browser', 'gpt-gateway', 'project-readiness'];
    const sections = allowedSections.filter((section) => config?.querySelector('[data-section="' + section + '"]'));
    const configurationReady = configurationSelected ? sections.includes('project') && sections.includes('project-readiness') : null;
    check('configuration-panels-mounted', configurationReady === true ? true : null);
    return { panelStates, configurationSelected, sections, configurationReady };
  }

  async function sampleFrame() {
    const attempts = [];
    for (let index = 0; index < 3; index += 1) {
      const before = await get('/api/frame');
      const projections = await Promise.all(projectedRoutes.map(([, path]) => get(path)));
      const after = await get('/api/frame');
      const left = before.value;
      const right = after.value;
      const stable = record(left) && record(right) && count(left.revision) !== null &&
        left.revision === right.revision && hash(left.seal?.snapshotHash) !== null &&
        left.seal.snapshotHash === right.seal?.snapshotHash && hash(left.seal?.statusHash) !== null &&
        left.seal.statusHash === right.seal?.statusHash;
      attempts.push({
        before: count(left?.revision), after: count(right?.revision), stable,
        frameHttp: [before.http, after.http], projectionRevisions: projections.map((result) => count(result.value?.revision)),
      });
      if (!stable) continue;

      const frameHash = await sealedHash(left.snapshot).catch(() => null);
      const contentChecks = {};
      check('frame-content-hash', frameHash === null ? null : frameHash === left.seal.snapshotHash);
      for (const [position, [name, , field]] of projectedRoutes.entries()) {
        const projection = projections[position];
        const body = projection.value;
        const expected = field === 'snapshot' ? left.snapshot : left.snapshot?.dashboard?.[field];
        const sameRevision = record(body) ? body.revision === left.revision : null;
        const sameSeal = record(body) ? body.seal?.snapshotHash === left.seal.snapshotHash &&
          body.seal?.statusHash === left.seal.statusHash : null;
        const sameBody = record(body) ? expected !== undefined && body[field] !== undefined &&
          canonical(expected) === canonical(body[field]) : null;
        contentChecks[name] = { http: projection.http, state: projection.state, sameRevision, sameSeal, sameBody };
        check('projection-' + name, record(body) ? sameRevision && sameSeal && sameBody : null);
      }
      check('stable-frame-revision', true);
      return { attempts, revision: left.revision, contentChecks, snapshotHash: left.seal.snapshotHash, recomputedSnapshotHash: frameHash };
    }
    check('stable-frame-revision', null);
    check('frame-content-hash', null);
    for (const [name] of projectedRoutes) check('projection-' + name, null);
    return { attempts, revision: null, contentChecks: null };
  }

  function inspectNavigator(status, config) {
    let q1;
    try { q1 = globalThis.__q1V9?.getState?.(); } catch { /* no UI evidence */ }
    const adapter = globalThis.__q1Navigator?.adapter?.repositoryInventoryModel;
    const committed = config?.committedGraphPointer;
    const receipt = committed?.physicalInventory;
    const statusQ1 = status?.q1;
    const recognition = status?.recognition;
    const verified = q1?.verification;
    // The outer graph pointer names a semantic recognition snapshot. The SURF
    // renderer and adapter name the separate, full-repository physical snapshot.
    const semanticIdentity = {
      renderedRunMatchesAdapter: equals(q1?.runId, adapter?.runId),
      adapterRunMatchesStatus: equals(adapter?.runId, statusQ1?.runId),
      committedRunMatchesStatus: equals(committed?.runId, statusQ1?.runId),
      committedSnapshotMatchesStatus: equals(committed?.snapshotId, statusQ1?.snapshotId),
      recognitionSnapshotMatchesStatus: equals(recognition?.snapshotId, statusQ1?.snapshotId),
      recognitionResultMatchesStatus: equals(recognition?.resultHash, statusQ1?.resultHash),
      committedResultMatchesStatus: equals(committed?.resultHash, statusQ1?.resultHash),
      committedStreamMatchesStatus: equals(committed?.streamSha256, statusQ1?.streamSha256),
    };
    const physicalIdentity = {
      renderedSnapshotMatchesAdapter: equals(q1?.snapshotId, adapter?.snapshotId),
      adapterSnapshotMatchesReceipt: equals(adapter?.snapshotId, receipt?.snapshotId),
      adapterInventoryMatchesReceipt: equals(adapter?.inventoryHash, receipt?.inventoryHash),
      adapterRepositoryMatchesReceipt: equals(adapter?.repositoryId, receipt?.repositoryId),
    };
    const semanticBound = reconcile(Object.values(semanticIdentity));
    const physicalBound = semanticBound === true ? reconcile(Object.values(physicalIdentity)) : null;
    const bound = reconcile([semanticBound, physicalBound]);
    const gate38 = flag(statusQ1?.inventoryReconciles);
    const adapterRows = adapter?.filesById instanceof Map ? [...adapter.filesById.values()] : null;
    const visible = adapterRows?.filter((file) => file?.excluded !== true);
    const uniqueVisible = visible && visible.every((file) => present(file?.fileLocationId))
      ? new Set(visible.map((file) => file.fileLocationId)).size
      : null;
    const physical = {
      active: count(verified?.activeFileCount),
      expected: count(verified?.expectedFileCount),
      adapterExpected: count(adapter?.expectedFileCount),
      adapterTotalRows: count(adapterRows?.length),
      adapterVisibleRows: count(visible?.length),
      adapterUniqueVisibleLocations: uniqueVisible,
      completed: flag(adapter?.physicalEnvelopeComplete),
      duplicates: count(verified?.duplicateCount),
      missingLocations: count(verified?.missingLocation),
      missingVersions: count(verified?.missingVersion),
      unclassified: count(verified?.unclassified),
      danglingEdges: count(verified?.danglingEdges),
      projectionErrors: count(verified?.projectionErrors),
    };
    const physicalReceipt = {
      present: record(receipt),
      expectedFileCount: count(receipt?.expectedFileCount),
      allFileCount: count(receipt?.allFileCount),
      identityConsistent: flag(receipt?.identityConsistent),
    };
    const physicalCounts = [
      physical.active, physical.expected, physical.adapterExpected, physical.adapterVisibleRows,
      physical.adapterUniqueVisibleLocations, physicalReceipt.expectedFileCount, physicalReceipt.allFileCount,
    ];
    const rendererIdentityCounts = [physical.duplicates, physical.missingLocations, physical.missingVersions];
    const rendererIdentityConsistent = rendererIdentityCounts.every((value) => value !== null)
      ? rendererIdentityCounts.every((value) => value === 0)
      : null;
    const sameCounts = bound === true && physical.completed === true && physicalCounts.every((value) => value !== null)
      ? physicalCounts.every((value) => value === physical.active)
      : null;
    const gate38ReceiptCoherent = semanticBound === true && gate38 !== null && physicalReceipt.present &&
      [physicalReceipt.expectedFileCount, physicalReceipt.allFileCount, physicalReceipt.identityConsistent].every((value) => value !== null)
      ? gate38 === (physicalReceipt.identityConsistent && physicalReceipt.expectedFileCount === physicalReceipt.allFileCount)
      : null;
    check('navigator-run-binding', semanticBound);
    check('navigator-physical-binding', physicalBound);
    check('navigator-physical-inventory', sameCounts);
    check('navigator-rendered-location-and-version-identities', bound === true ? rendererIdentityConsistent : null);
    check('status-gate-38', gate38);
    check('status-gate-38-receipt-coherence', gate38ReceiptCoherent);
    return {
      mounted: flag(q1?.mounted), mode: allowed(q1?.mode, ['surf', 'dive']),
      verification: allowed(verified?.state, ['ok', 'warn', 'bad']),
      semanticIdentity, physicalIdentity, sameRunAndPhysicalInventory: bound, physical, physicalReceipt,
      samePhysicalCounts: sameCounts, rendererIdentityConsistent, gate38, gate38ReceiptCoherent,
      inventoryHash: hash(adapter?.inventoryHash),
      semanticRecognition: {
        programFiles: count(recognition?.filesInProgram), recognizedFiles: count(recognition?.filesRecognised),
        complete: flag(recognition?.complete),
      },
    };
  }

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'CLU-E_Status_Navigator_' + report.collectedAt.replace(/[:.]/g, '-') + '.json';
    anchor.hidden = true;
    (document.body ?? document.documentElement).append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    console.info('CLU-E focused probe downloaded', anchor.download);
  }

  try {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) &&
      ['http:', 'https:'].includes(location.protocol);
    const dashboard = !!document.getElementById('q1') && !!document.getElementById('tabConfiguration');
    check('dashboard-context', loopback && dashboard);
    if (loopback && dashboard) {
      const [statusResponse, schemaResponse, configResponse, frame] = await Promise.all([
        get('/api/status/current'), get('/api/status/schema'), get('/api/config'), sampleFrame(),
      ]);
      const status = statusResponse.value;
      const statusHash = hash(status?.seal?.statusHash);
      const recomputedHash = await sealedHash(status).catch(() => null);
      const inventory = inspectInventory(status);
      const schemaVersion = allowed(status?.schemaVersion, ['5.8.0']);
      check('status-schema', record(status) && record(schemaResponse.value)
        ? schemaVersion !== null && schemaResponse.value.schemaVersion === schemaVersion : null);
      check('status-seal', statusHash && recomputedHash ? statusHash === recomputedHash : null);
      check('status-consistency', flag(status?.seal?.consistent));
      check('status-branch-inventory', schemaVersion ? inventory?.exact ?? null : null);
      report.status = {
        schemaVersion, statusHash, recomputedHash, consistent: flag(status?.seal?.consistent),
        inventory,
        responses: [statusResponse, schemaResponse, configResponse].map(({ http, state }) => ({ http, state })),
      };
      report.frame = frame;
      report.ui = inspectUi(status);
      report.navigator = inspectNavigator(status, configResponse.value);
    }
  } catch {
    check('probe-completed', false);
  }
  report.summary = Object.fromEntries(['PASS', 'FAIL', 'PENDING'].map((state) => [
    state, report.checks.filter((entry) => entry.state === state).length,
  ]));
  download();
})();
