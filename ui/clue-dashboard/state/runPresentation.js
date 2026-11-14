export function runIdentity(run) {
  if (run?.cycleId || run?.runId) return `Cycle ${run.cycleId || run.runId}`;
  return run?.dispatchId ? `Dispatch ${run.dispatchId}` : '';
}

export function describeFindingsRun(run) {
  const outcome = run?.findingsOutcome;
  if (outcome === 'BLOCKED' && run.state === 'failed') {
    return { outcome, eventId: null, detail: ['Findings blocked', run.findingsCode].filter(Boolean).join(' · ') };
  }
  if (run?.state !== 'completed' || !['SELECTED', 'NO_CANDIDATE'].includes(outcome) ||
      typeof run.findingsEventId !== 'string' || !/^EVENT-\d+$/u.test(run.findingsEventId)) return null;
  return { outcome, eventId: run.findingsEventId, detail: `Findings ${outcome} · ${run.findingsEventId}` };
}

export function describeDashboardRun(run) {
  const processState = String(run?.state ?? 'unknown').toLowerCase() || 'unknown';
  const processLabel = processState === 'unknown'
    ? 'Awaiting run telemetry'
    : processState[0].toUpperCase() + processState.slice(1);
  const stage = run?.cycleStage || null;
  const paused = stage === 'SUSPENDED';
  const recoverable = run?.recoveryRequired === true;
  const stageLabel = stage === 'SCREENED' ? 'Screening reached (SCREENED)' : stage;
  const guidance = paused
    ? 'Run `node .\\dist\\src\\cli\\index.js cycle resume` from the CLU-E directory, then enter /start here.'
    : recoverable && processState !== 'running' ? 'Enter /start to continue this cycle from its saved checkpoint.' : '';
  const findings = describeFindingsRun(run);
  return {
    processState,
    processLabel,
    stage,
    stageLabel,
    guidance,
    findings,
    detail: [runIdentity(run), stageLabel, run?.checkpointAt && `Checkpoint ${run.checkpointAt}`, guidance, run?.phase,
      findings?.detail, run?.lastLine].filter(Boolean).join(' · '),
  };
}

export function describeStartReceipt(result, withFindings = false) {
  switch (result.disposition) {
    case 'attached':
      return {
        state: 'attached',
        detail: withFindings
          ? 'Attached to the cycle drive with findings. Enter /status to follow screening and assessment.'
          : 'Attached to the cycle drive already in progress. Enter /status to follow it.',
      };
    case 'already-screened':
      return { state: 'already-screened', detail: 'This cycle already reached screening. Enter /status to see its saved stage.' };
    default:
      return {
        state: 'accepted',
        detail: withFindings
          ? 'Cycle drive with findings accepted. Enter /status to follow screening and assessment.'
          : 'Cycle drive accepted. Enter /status to follow its progress through screening.',
      };
  }
}
