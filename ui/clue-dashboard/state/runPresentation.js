export function runIdentity(run) {
  if (run?.cycleId || run?.runId) return `Cycle ${run.cycleId || run.runId}`;
  return run?.dispatchId ? `Dispatch ${run.dispatchId}` : '';
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
  return {
    processState,
    processLabel,
    stage,
    stageLabel,
    guidance,
    detail: [runIdentity(run), stageLabel, run?.checkpointAt && `Checkpoint ${run.checkpointAt}`, guidance, run?.phase, run?.lastLine]
      .filter(Boolean).join(' · '),
  };
}

export function describeStartReceipt(result) {
  switch (result.disposition) {
    case 'attached':
      return { state: 'attached', detail: 'Attached to the cycle drive already in progress. Enter /status to follow it.' };
    case 'already-screened':
      return { state: 'already-screened', detail: 'This cycle already reached screening. Enter /status to see its saved stage.' };
    default:
      return { state: 'accepted', detail: 'Cycle drive accepted. Enter /status to follow its progress through screening.' };
  }
}
