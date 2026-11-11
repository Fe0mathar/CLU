/**
 * P2 B6 — benchmark/proof dashboard workspace.
 *
 * This module is a renderer over `/api/proof-board`. It intentionally has no verdict
 * algorithm: dispositions, improvement booleans, reasons, digests and Great Book links
 * are rendered exactly as the durable server projection reports them. The only client-side
 * computation is structural validation and summary parity.
 */

export const PROOF_BOARD_VIEW_SCHEMA = '1.0.0';

const DISPOSITIONS = new Set(['ACCEPT', 'REJECT', 'REVISE', 'INVALID']);
const ATTEMPT_STATES = new Set(['frozen', 'baseline_bound', 'refused', 'verdict_recorded']);
const GREAT_BOOK_STATES = new Set(['recorded', 'not_recorded', 'legacy_unrecorded']);
const SHA256 = /^[0-9a-f]{64}$/u;

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function hash(value, label, nullable = false) {
  const result = text(value, label, nullable);
  if (result === null) return null;
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256`);
  return result;
}

function integer(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function finiteOrNull(value, label) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite or null`);
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function optionalEvent(value, label) {
  if (value === null) return null;
  const row = object(value, label);
  return {
    ...row,
    eventId: text(row.eventId, `${label}.eventId`),
    sequence: integer(row.sequence, `${label}.sequence`),
    recordedAt: text(row.recordedAt, `${label}.recordedAt`),
  };
}

function normalizeRegisteredBenchmark(raw) {
  const row = object(raw, 'registeredBenchmark');
  if (!['registered', 'unregistered', 'invalid'].includes(row.state)) {
    throw new Error('registeredBenchmark.state is unknown');
  }
  const normalized = {
    state: row.state,
    path: text(row.path, 'registeredBenchmark.path', true),
    sha256: hash(row.sha256, 'registeredBenchmark.sha256', true),
    benchmarkId: text(row.benchmarkId, 'registeredBenchmark.benchmarkId', true),
    benchmarkVersion: text(row.benchmarkVersion, 'registeredBenchmark.benchmarkVersion', true),
    runnerAdapter: text(row.runnerAdapter, 'registeredBenchmark.runnerAdapter', true),
    harnessId: text(row.harnessId, 'registeredBenchmark.harnessId', true),
    integritySha256: hash(row.integritySha256, 'registeredBenchmark.integritySha256', true),
    integrityVerified: bool(row.integrityVerified, 'registeredBenchmark.integrityVerified'),
    reason: text(row.reason, 'registeredBenchmark.reason', true),
  };
  if (normalized.state === 'registered') {
    for (const key of ['path', 'sha256', 'benchmarkId', 'benchmarkVersion', 'runnerAdapter', 'harnessId', 'integritySha256']) {
      if (normalized[key] === null) throw new Error(`registeredBenchmark.${key} is required when registered`);
    }
    if (!normalized.integrityVerified || normalized.reason !== null) {
      throw new Error('registeredBenchmark registered state contradicts integrity fields');
    }
  } else {
    if (normalized.integrityVerified) throw new Error('a non-registered benchmark cannot be integrity-verified');
    if (normalized.reason === null) throw new Error('a non-registered benchmark must explain why');
  }
  return normalized;
}

function normalizeBenchmark(raw, index) {
  const row = object(raw, `benchmarkRuns[${index}]`);
  const protective = array(row.protective, `benchmarkRuns[${index}].protective`).map((rawItem, itemIndex) => {
    const item = object(rawItem, `benchmarkRuns[${index}].protective[${itemIndex}]`);
    return {
      id: text(item.id, `benchmarkRuns[${index}].protective[${itemIndex}].id`),
      value: finiteOrNull(item.value, `benchmarkRuns[${index}].protective[${itemIndex}].value`),
    };
  });
  return {
    ...row,
    eventId: text(row.eventId, `benchmarkRuns[${index}].eventId`),
    sequence: integer(row.sequence, `benchmarkRuns[${index}].sequence`),
    recordedAt: text(row.recordedAt, `benchmarkRuns[${index}].recordedAt`),
    missionVersion: text(row.missionVersion, `benchmarkRuns[${index}].missionVersion`),
    snapshotId: text(row.snapshotId, `benchmarkRuns[${index}].snapshotId`, true),
    registered: bool(row.registered, `benchmarkRuns[${index}].registered`),
    benchmarkId: text(row.benchmarkId, `benchmarkRuns[${index}].benchmarkId`),
    benchmarkVersion: text(row.benchmarkVersion, `benchmarkRuns[${index}].benchmarkVersion`),
    blockId: text(row.blockId, `benchmarkRuns[${index}].blockId`),
    runnerAdapter: text(row.runnerAdapter, `benchmarkRuns[${index}].runnerAdapter`),
    contractSha256: hash(row.contractSha256, `benchmarkRuns[${index}].contractSha256`),
    integritySha256: hash(row.integritySha256, `benchmarkRuns[${index}].integritySha256`),
    resultArtifactHash: hash(row.resultArtifactHash, `benchmarkRuns[${index}].resultArtifactHash`),
    unifiedScore: finiteOrNull(row.unifiedScore, `benchmarkRuns[${index}].unifiedScore`),
    measuresCount: integer(row.measuresCount, `benchmarkRuns[${index}].measuresCount`),
    incompleteCount: integer(row.incompleteCount, `benchmarkRuns[${index}].incompleteCount`),
    protective,
    startedAt: text(row.startedAt, `benchmarkRuns[${index}].startedAt`),
    finishedAt: text(row.finishedAt, `benchmarkRuns[${index}].finishedAt`),
    wallMs: integer(row.wallMs, `benchmarkRuns[${index}].wallMs`),
    budgetExhausted: bool(row.budgetExhausted, `benchmarkRuns[${index}].budgetExhausted`),
  };
}

function normalizeAttempt(raw, index) {
  const label = `proofAttempts[${index}]`;
  const row = object(raw, label);
  if (!ATTEMPT_STATES.has(row.state)) throw new Error(`${label}.state is unknown`);
  const contract = optionalEvent(row.contract, `${label}.contract`);
  if (contract === null) throw new Error(`${label}.contract is required`);

  const baselineEvent = optionalEvent(row.baseline, `${label}.baseline`);
  const baseline = baselineEvent === null ? null : {
    ...baselineEvent,
    digest: hash(baselineEvent.digest, `${label}.baseline.digest`),
    sourceBenchmarkEventId: text(baselineEvent.sourceBenchmarkEventId, `${label}.baseline.sourceBenchmarkEventId`, true),
    runArtifactHash: hash(baselineEvent.runArtifactHash, `${label}.baseline.runArtifactHash`, true),
    reused: bool(baselineEvent.reused, `${label}.baseline.reused`),
  };

  const refusalEvent = optionalEvent(row.refusal, `${label}.refusal`);
  const refusal = refusalEvent === null ? null : {
    ...refusalEvent,
    stage: text(refusalEvent.stage, `${label}.refusal.stage`),
    reason: text(refusalEvent.reason, `${label}.refusal.reason`),
    evidenceCount: integer(refusalEvent.evidenceCount, `${label}.refusal.evidenceCount`),
  };

  const verdictEvent = optionalEvent(row.verdict, `${label}.verdict`);
  let verdict = null;
  if (verdictEvent !== null) {
    if (!DISPOSITIONS.has(verdictEvent.disposition)) throw new Error(`${label}.verdict.disposition is unknown`);
    const improvement = bool(verdictEvent.improvement, `${label}.verdict.improvement`);
    if ((verdictEvent.disposition === 'ACCEPT') !== improvement) {
      throw new Error(`${label} disposition/improvement contradiction`);
    }
    const reasons = array(verdictEvent.reasons, `${label}.verdict.reasons`).map((reason, reasonIndex) =>
      text(reason, `${label}.verdict.reasons[${reasonIndex}]`));
    const deltas = array(verdictEvent.deltas, `${label}.verdict.deltas`).map((rawDelta, deltaIndex) => {
      const delta = object(rawDelta, `${label}.verdict.deltas[${deltaIndex}]`);
      if (!['lower_is_better', 'higher_is_better'].includes(delta.direction)) {
        throw new Error(`${label}.verdict.deltas[${deltaIndex}].direction is unknown`);
      }
      return {
        measure_id: text(delta.measure_id, `${label}.verdict.deltas[${deltaIndex}].measure_id`),
        direction: delta.direction,
        baseline: finiteOrNull(delta.baseline, `${label}.verdict.deltas[${deltaIndex}].baseline`),
        candidate: finiteOrNull(delta.candidate, `${label}.verdict.deltas[${deltaIndex}].candidate`),
        delta_pct: finiteOrNull(delta.delta_pct, `${label}.verdict.deltas[${deltaIndex}].delta_pct`),
      };
    });
    if (!GREAT_BOOK_STATES.has(verdictEvent.greatBookState)) {
      throw new Error(`${label}.verdict.greatBookState is unknown`);
    }
    const greatBookEntryId = text(verdictEvent.greatBookEntryId, `${label}.verdict.greatBookEntryId`, true);
    if ((verdictEvent.greatBookState === 'recorded') !== (greatBookEntryId !== null)) {
      throw new Error(`${label}.verdict Great Book state/entry contradiction`);
    }
    verdict = {
      ...verdictEvent,
      disposition: verdictEvent.disposition,
      improvement,
      reasons,
      deltas,
      baselineDigest: hash(verdictEvent.baselineDigest, `${label}.verdict.baselineDigest`),
      candidateDigest: hash(verdictEvent.candidateDigest, `${label}.verdict.candidateDigest`),
      candidateSnapshotId: text(verdictEvent.candidateSnapshotId, `${label}.verdict.candidateSnapshotId`),
      patchDigest: hash(verdictEvent.patchDigest, `${label}.verdict.patchDigest`),
      verdictArtifactHash: hash(verdictEvent.verdictArtifactHash, `${label}.verdict.verdictArtifactHash`),
      greatBookState: verdictEvent.greatBookState,
      greatBookEntryId,
    };
  }

  if (refusal !== null && verdict !== null) throw new Error(`${label} has both refusal and verdict`);
  if ((refusal !== null || verdict !== null) && baseline === null) {
    throw new Error(`${label} has a terminal event without baseline`);
  }
  const expectedState = verdict !== null
    ? 'verdict_recorded'
    : refusal !== null
      ? 'refused'
      : baseline !== null
        ? 'baseline_bound'
        : 'frozen';
  if (row.state !== expectedState) throw new Error(`${label}.state does not agree with durable events`);
  if (verdict !== null && baseline !== null && verdict.baselineDigest !== baseline.digest) {
    throw new Error(`${label}.verdict does not bind its baseline`);
  }

  return {
    ...row,
    cycleId: text(row.cycleId, `${label}.cycleId`),
    missionVersion: text(row.missionVersion, `${label}.missionVersion`),
    targetId: text(row.targetId, `${label}.targetId`),
    contractHash: hash(row.contractHash, `${label}.contractHash`),
    hypothesisId: text(row.hypothesisId, `${label}.hypothesisId`),
    snapshotId: text(row.snapshotId, `${label}.snapshotId`),
    contractArtifactHash: hash(row.contractArtifactHash, `${label}.contractArtifactHash`),
    frozenAt: text(row.frozenAt, `${label}.frozenAt`),
    contract,
    baseline,
    refusal,
    verdict,
    state: row.state,
  };
}

/** Strict client boundary plus server-summary parity. No verdict is calculated here. */
export function normalizeProofBoard(raw) {
  const source = object(raw, 'proof board');
  if (source.schemaVersion !== PROOF_BOARD_VIEW_SCHEMA) {
    throw new Error(`unsupported proof board schema ${String(source.schemaVersion)}`);
  }
  const targetId = text(source.targetId, 'targetId');
  const projection = object(source.projection, 'projection');
  const registeredBenchmark = normalizeRegisteredBenchmark(source.registeredBenchmark);
  const summary = object(source.summary, 'summary');
  const benchmarkRuns = array(source.benchmarkRuns, 'benchmarkRuns').map(normalizeBenchmark);
  const proofAttempts = array(source.proofAttempts, 'proofAttempts').map(normalizeAttempt);
  for (const [index, attempt] of proofAttempts.entries()) {
    if (attempt.targetId !== targetId) throw new Error(`proofAttempts[${index}] belongs to a different target`);
  }

  const expected = {
    benchmarkRuns: benchmarkRuns.length,
    proofAttempts: proofAttempts.length,
    accepts: proofAttempts.filter((attempt) => attempt.verdict?.disposition === 'ACCEPT').length,
    rejects: proofAttempts.filter((attempt) => attempt.verdict?.disposition === 'REJECT').length,
    revises: proofAttempts.filter((attempt) => attempt.verdict?.disposition === 'REVISE').length,
    invalids: proofAttempts.filter((attempt) => attempt.verdict?.disposition === 'INVALID').length,
    refusals: proofAttempts.filter((attempt) => attempt.refusal !== null).length,
    openAttempts: proofAttempts.filter((attempt) => attempt.refusal === null && attempt.verdict === null).length,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (integer(summary[key], `summary.${key}`) !== value) {
      throw new Error(`summary.${key} does not agree with the durable rows`);
    }
  }
  const latestBenchmarkEventId = text(summary.latestBenchmarkEventId, 'summary.latestBenchmarkEventId', true);
  const latestVerdictEventId = text(summary.latestVerdictEventId, 'summary.latestVerdictEventId', true);
  if (latestBenchmarkEventId !== (benchmarkRuns[0]?.eventId ?? null)) {
    throw new Error('summary.latestBenchmarkEventId does not agree with the durable rows');
  }
  const expectedLatestVerdict = proofAttempts.find((attempt) => attempt.verdict !== null)?.verdict?.eventId ?? null;
  if (latestVerdictEventId !== expectedLatestVerdict) {
    throw new Error('summary.latestVerdictEventId does not agree with the durable rows');
  }

  const eventIds = [
    ...benchmarkRuns.map((run) => run.eventId),
    ...proofAttempts.flatMap((attempt) =>
      [attempt.contract, attempt.baseline, attempt.refusal, attempt.verdict]
        .filter((event) => event !== null)
        .map((event) => event.eventId)),
  ];
  if (new Set(eventIds).size !== eventIds.length) throw new Error('proof board contains duplicate event identities');

  return {
    ...source,
    generatedAt: text(source.generatedAt, 'generatedAt'),
    targetId,
    missionVersionId: text(source.missionVersionId, 'missionVersionId', true),
    projection: {
      ...projection,
      schemaVersion: integer(projection.schemaVersion, 'projection.schemaVersion'),
      lastSequence: projection.lastSequence === null ? null : integer(projection.lastSequence, 'projection.lastSequence'),
      headHash: hash(projection.headHash, 'projection.headHash', true),
    },
    registeredBenchmark,
    summary: { ...summary, ...expected, latestBenchmarkEventId, latestVerdictEventId },
    benchmarkRuns,
    proofAttempts,
  };
}

const defaultEscape = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const short = (value, size = 12) => value === null || value === undefined ? '—' : String(value).slice(0, size);
const time = (value) => value ? String(value).replace('T', ' ').replace(/\.\d{3}Z$/u, 'Z') : '—';
const duration = (ms) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
const number = (value) => value === null || value === undefined ? '—' : new Intl.NumberFormat().format(value);

function badgeClass(disposition) {
  if (disposition === 'ACCEPT') return 'is-accept';
  if (disposition === 'REJECT') return 'is-reject';
  if (disposition === 'REVISE') return 'is-revise';
  if (disposition === 'INVALID') return 'is-invalid';
  return 'is-open';
}

export function renderProofBoard(view, escape = defaultEscape) {
  const esc = (value) => escape(String(value ?? ''));
  const benchmark = view.registeredBenchmark;
  const stat = (label, value, cls = '') => `<div class="pb-stat ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  const cards = [
    stat('benchmark', benchmark.state === 'registered' ? `${benchmark.benchmarkId} · ${benchmark.benchmarkVersion}` : benchmark.state, benchmark.integrityVerified ? 'is-good' : 'is-warn'),
    stat('integrity', benchmark.integrityVerified ? 'VERIFIED' : 'NOT VERIFIED', benchmark.integrityVerified ? 'is-good' : 'is-warn'),
    stat('benchmark runs', number(view.summary.benchmarkRuns)),
    stat('proof attempts', number(view.summary.proofAttempts)),
    stat('accepted', number(view.summary.accepts), view.summary.accepts > 0 ? 'is-good' : ''),
    stat('refused/open', `${view.summary.refusals} / ${view.summary.openAttempts}`),
  ].join('');

  const attemptRows = view.proofAttempts.length === 0
    ? '<div class="pb-empty">No durable proof attempt has been recorded yet. The board is connected and waiting for the first proof-authoritative cycle.</div>'
    : view.proofAttempts.map((attempt) => {
      const terminal = attempt.verdict?.disposition ?? (attempt.refusal ? 'REFUSED' : attempt.state.toUpperCase());
      const reasons = attempt.verdict?.reasons ?? (attempt.refusal ? [attempt.refusal.reason] : []);
      const deltas = attempt.verdict?.deltas ?? [];
      const detail = reasons.length
        ? `<ul class="pb-reasons">${reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>`
        : '<div class="pb-muted">No terminal reason recorded.</div>';
      const deltaRows = deltas.length
        ? `<div class="pb-deltas">${deltas.map((delta) => `<span><b>${esc(delta.measure_id)}</b> ${esc(delta.baseline)} → ${esc(delta.candidate)} · ${esc(delta.delta_pct)}%</span>`).join('')}</div>`
        : '';
      return `<article class="pb-attempt" data-proof-event="${esc(attempt.contract.eventId)}" data-disposition="${esc(terminal)}">
        <header>
          <span class="pb-badge ${badgeClass(terminal)}">${esc(terminal)}</span>
          <strong>${esc(attempt.hypothesisId)}</strong>
          <time>${esc(time(attempt.contract.recordedAt))}</time>
        </header>
        <div class="pb-identities">
          <span>cycle <code>${esc(attempt.cycleId)}</code></span>
          <span>contract <code>${esc(short(attempt.contractHash, 16))}</code></span>
          <span>snapshot <code>${esc(short(attempt.snapshotId, 16))}</code></span>
          <span>baseline <code>${esc(short(attempt.baseline?.digest, 16))}</code></span>
          <span>candidate <code>${esc(short(attempt.verdict?.candidateDigest, 16))}</code></span>
        </div>
        ${detail}${deltaRows}
        <footer>
          <span>contract event <code>${esc(attempt.contract.eventId)}</code></span>
          <span>verdict event <code>${esc(attempt.verdict?.eventId ?? '—')}</code></span>
          <span>Great Book <code>${esc(attempt.verdict?.greatBookEntryId ?? attempt.verdict?.greatBookState ?? '—')}</code></span>
        </footer>
      </article>`;
    }).join('');

  const benchmarkRows = view.benchmarkRuns.length === 0
    ? '<tr><td colspan="8" class="pb-table-empty">No benchmark run recorded yet.</td></tr>'
    : view.benchmarkRuns.map((run) => `<tr data-benchmark-event="${esc(run.eventId)}">
        <td>${esc(time(run.recordedAt))}</td>
        <td><code>${esc(run.eventId)}</code></td>
        <td>${esc(`${run.benchmarkId} · ${run.benchmarkVersion}`)}</td>
        <td>${esc(run.runnerAdapter)}</td>
        <td>${esc(run.unifiedScore ?? '—')}</td>
        <td>${esc(`${run.incompleteCount}/${run.measuresCount}`)}</td>
        <td>${esc(duration(run.wallMs))}</td>
        <td><code>${esc(short(run.resultArtifactHash, 16))}</code></td>
      </tr>`).join('');

  return `<div class="pb-board" data-target-id="${esc(view.targetId)}">
    <div class="pb-toolbar"><div><b>Durable evidence board</b><span>${esc(view.targetId)} · Projection schema ${esc(view.projection.schemaVersion)} · log ${esc(view.projection.lastSequence ?? 'empty')}</span></div><button type="button" data-proof-refresh>↻ refresh</button></div>
    <section class="pb-stats">${cards}</section>
    <section class="pb-section"><div class="pb-section-head"><h3>Proof attempts</h3><span>verdicts are displayed, never calculated in this browser</span></div>${attemptRows}</section>
    <section class="pb-section"><div class="pb-section-head"><h3>Benchmark runs</h3><span>${esc(benchmark.path ?? 'no registered file')}</span></div>
      <div class="pb-table-wrap"><table class="pb-table"><thead><tr><th>recorded</th><th>event</th><th>benchmark</th><th>runner</th><th>score</th><th>incomplete</th><th>wall</th><th>artifact</th></tr></thead><tbody>${benchmarkRows}</tbody></table></div>
    </section>
  </div>`;
}

function injectProofBoardStyles() {
  if (document.getElementById('clue-proof-board-style')) return;
  const style = document.createElement('style');
  style.id = 'clue-proof-board-style';
  style.textContent = `
.pb-board{padding:14px;display:grid;gap:14px;color:#cde8f7;font:500 10.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.pb-toolbar{position:sticky;top:0;z-index:7;display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid rgba(0,163,224,.2);border-radius:10px;background:rgba(3,12,21,.94);backdrop-filter:blur(14px)}
.pb-toolbar>div{display:grid}.pb-toolbar b{color:#e9f8ff;font-size:11px;letter-spacing:.08em;text-transform:uppercase}.pb-toolbar span{color:#55788e;font-size:9px}.pb-toolbar button{margin-left:auto;border:1px solid rgba(0,163,224,.35);border-radius:6px;background:rgba(0,163,224,.08);color:#7fdfff;padding:7px 10px;cursor:pointer;font:700 9px ui-monospace,monospace}
.pb-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}.pb-stat{min-width:0;padding:10px;border:1px solid rgba(110,190,230,.15);border-radius:9px;background:rgba(4,14,24,.75)}.pb-stat span{display:block;color:#53748a;font-size:8px;text-transform:uppercase;letter-spacing:.1em}.pb-stat b{display:block;margin-top:5px;overflow:hidden;text-overflow:ellipsis;color:#cde8f7;font-size:11px;white-space:nowrap}.pb-stat.is-good b{color:#39ff88}.pb-stat.is-warn b{color:#f4af2d}
.pb-section{display:grid;gap:9px}.pb-section-head{display:flex;align-items:end;gap:12px;padding:0 2px}.pb-section-head h3{margin:0;color:#e8f7ff;font-size:11px;letter-spacing:.12em;text-transform:uppercase}.pb-section-head span{margin-left:auto;color:#506f83;font-size:8.5px}
.pb-attempt{display:grid;gap:9px;padding:11px 12px;border:1px solid rgba(105,185,225,.16);border-radius:10px;background:linear-gradient(135deg,rgba(255,255,255,.025),transparent 35%),rgba(3,12,21,.76)}.pb-attempt header{display:flex;align-items:center;gap:9px}.pb-attempt header strong{color:#dff5ff}.pb-attempt header time{margin-left:auto;color:#55768a;font-size:9px}.pb-badge{display:inline-flex;padding:3px 7px;border:1px solid currentColor;border-radius:999px;font-size:8px;font-weight:800;letter-spacing:.1em}.pb-badge.is-accept{color:#39ff88}.pb-badge.is-reject{color:#ff6574}.pb-badge.is-revise{color:#f4af2d}.pb-badge.is-invalid{color:#ff5500}.pb-badge.is-open{color:#73caee}
.pb-identities{display:flex;flex-wrap:wrap;gap:6px 13px;color:#607f93}.pb-identities code,.pb-attempt footer code{color:#90cbe5}.pb-reasons{margin:0;padding-left:18px;color:#abc8d8}.pb-deltas{display:flex;flex-wrap:wrap;gap:6px}.pb-deltas span{padding:4px 7px;border:1px solid rgba(244,175,45,.18);border-radius:5px;color:#d8bc78;background:rgba(244,175,45,.045)}.pb-muted,.pb-empty{color:#58778a}.pb-empty{padding:28px;text-align:center;border:1px dashed rgba(105,185,225,.17);border-radius:10px}.pb-attempt footer{display:flex;flex-wrap:wrap;gap:7px 14px;padding-top:7px;border-top:1px solid rgba(100,178,216,.1);color:#536f82;font-size:8.5px}
.pb-table-wrap{overflow:auto;border:1px solid rgba(105,185,225,.14);border-radius:10px}.pb-table{width:100%;border-collapse:collapse;white-space:nowrap}.pb-table th,.pb-table td{padding:8px 9px;text-align:left;border-bottom:1px solid rgba(105,185,225,.08)}.pb-table th{position:sticky;top:0;color:#5f849a;background:#071522;font-size:8px;text-transform:uppercase;letter-spacing:.09em}.pb-table td{color:#a9c8d8}.pb-table code{color:#77cbe9}.pb-table-empty{text-align:center!important;color:#56768a!important;padding:24px!important}
@media(max-width:900px){.pb-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.pb-section-head{align-items:start;flex-direction:column}.pb-section-head span{margin-left:0}.pb-attempt header{align-items:flex-start;flex-wrap:wrap}.pb-attempt header time{width:100%;margin-left:0}}
`;
  document.head.appendChild(style);
}

export function mountProofBoard({
  overlayUi, fetchJson, interfaceApi = null,
  activeProjectId = () => null, isProjectTransition = () => false,
}) {
  if (!overlayUi || typeof overlayUi.panelButton !== 'function' || typeof overlayUi.makeOverlay !== 'function') {
    throw new Error('Proof Board requires the shared overlay UI');
  }
  if (typeof fetchJson !== 'function') throw new Error('Proof Board requires fetchJson');
  injectProofBoardStyles();
  const button = overlayUi.panelButton('q4', 'proofBoardBtn', '⊢ PROOF', 'Recorded benchmark runs and durable proof verdicts');
  if (!button) throw new Error('Proof Board could not attach to the mission rail');
  const overlay = overlayUi.makeOverlay(
    'proofBoardOverlay',
    'PROOF & BENCHMARK BOARD',
    'Durable runs · frozen contracts · recorded dispositions',
    { accent: '#39ff88', code: 'PB' },
  );
  let current = null;
  let requestGeneration = 0;

  const invalidate = () => {
    requestGeneration += 1;
    current = null;
    delete button.dataset.proofState;
    overlay.setSub('awaiting project-bound proof history');
    overlay.body.innerHTML = '<div class="clue-ov-empty">Awaiting active project proof history.</div>';
  };

  const refresh = async () => {
    if (isProjectTransition()) return null;
    const generation = ++requestGeneration;
    const expectedTarget = activeProjectId();
    overlay.body.innerHTML = '<div class="clue-ov-loading">loading durable proof history…</div>';
    try {
      const board = normalizeProofBoard(await fetchJson('/api/proof-board', { cache: 'no-store' }));
      if (generation !== requestGeneration || isProjectTransition()) return null;
      const target = activeProjectId() ?? expectedTarget;
      if (target && board.targetId !== target) {
        throw new Error('Proof history does not belong to the active project.');
      }
      current = board;
      overlay.body.innerHTML = renderProofBoard(current, overlayUi.esc);
      overlay.setSub(`${current.summary.benchmarkRuns} benchmark run(s) · ${current.summary.proofAttempts} proof attempt(s) · projection v${current.projection.schemaVersion}`);
      overlay.body.querySelector('[data-proof-refresh]')?.addEventListener('click', () => void refresh());
      button.dataset.proofState = current.summary.openAttempts > 0 ? 'open' : current.summary.accepts > 0 ? 'accepted' : 'idle';
    } catch (error) {
      if (generation !== requestGeneration || isProjectTransition()) return null;
      current = null;
      overlay.setSub('projection unavailable');
      overlay.body.innerHTML = `<div class="clue-ov-empty">Proof Board unavailable — ${overlayUi.esc(error?.message ?? error)}</div>`;
      button.dataset.proofState = 'unavailable';
    }
    return current;
  };

  button.addEventListener('click', () => {
    overlay.open();
    void refresh();
  });

  const api = {
    button,
    overlay,
    refresh,
    invalidate,
    get current() { return current; },
    interfaceVersion: interfaceApi?.version ?? null,
  };
  try { window.__clueProofBoard = api; } catch { /* diagnostic exposure is optional */ }
  return api;
}
