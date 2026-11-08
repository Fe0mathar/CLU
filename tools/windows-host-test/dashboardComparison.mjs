import { verifyDashboardComparisonSnapshot } from './dashboardTestInputs.mjs';
import { runDashboardTests } from './dashboardTestRunner.mjs';

const order = [
  ['baseline', 'candidate'],
  ['candidate', 'baseline'],
];

function verified(root, digest, fileCount) {
  try {
    return verifyDashboardComparisonSnapshot(root, digest, fileCount) === true;
  } catch {
    return false;
  }
}

/** Run the same approved test list twice on each copy, with alternating order. */
export async function runDashboardComparison({ node, roots, inputs, signal, progress }) {
  const result = { state: 'HOST_REVIEWED_COMPARISON_INTERRUPTED', runs: [], timing: null };
  const digests = { baseline: inputs.baselineSha256, candidate: inputs.candidateSha256 };
  for (const [index, round] of order.entries()) {
    for (const side of round) {
      if (signal.aborted) return result;
      // Recheck both copies so that tests on one side cannot change the other side unnoticed.
      if (!Object.keys(roots).every((key) => verified(roots[key], digests[key], inputs.fileCount))) {
        result.state = 'HOST_REVIEWED_COMPARISON_SNAPSHOT_CHANGED';
        return result;
      }
      progress?.(index + 1, side);
      const run = await runDashboardTests({ node, cwd: roots[side], testPaths: inputs.trackedTestPaths, signal });
      result.runs.push({ side, round: index + 1, ...run });
      if (signal.aborted) return result;
      if (!Object.keys(roots).every((key) => verified(roots[key], digests[key], inputs.fileCount))) {
        result.state = 'HOST_REVIEWED_COMPARISON_SNAPSHOT_CHANGED';
        return result;
      }
      if (run.state !== 'PASSED') {
        result.state = side === 'baseline' ? 'HOST_REVIEWED_BASELINE_SUITE_UNVERIFIED' : 'HOST_REVIEWED_CANDIDATE_SUITE_UNVERIFIED';
        return result;
      }
      if (run.counts.tests !== result.runs[0].counts.tests) {
        result.state = 'HOST_REVIEWED_COMPARISON_TEST_COUNT_CHANGED';
        return result;
      }
    }
  }

  const median = (side) => {
    const samples = result.runs.filter((run) => run.side === side).map((run) => run.elapsedMs);
    return (samples[0] + samples[1]) / 2;
  };
  const baselineMedianMs = median('baseline');
  const candidateMedianMs = median('candidate');
  const deltaMs = candidateMedianMs - baselineMedianMs;
  result.timing = {
    metric: 'DASHBOARD_TEST_SUITE_WALL_TIME',
    samplesPerSide: 2,
    baselineMedianMs,
    candidateMedianMs,
    deltaMs,
    deltaPercent: baselineMedianMs > 0 ? Math.round(deltaMs * 10000 / baselineMedianMs) / 100 : null,
  };
  result.state = 'HOST_REVIEWED_COMPARISON_COMPLETE';
  return result;
}
