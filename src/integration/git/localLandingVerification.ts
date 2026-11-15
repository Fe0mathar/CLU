/** Verify the accepted source in a fresh, isolated copy using the existing proof broker. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseScriptCommand } from '../../analysis/scenarios/scenarioRunner.js';
import { createRestrictedExecution } from '../../benchmark/restrictedExecution.js';
import { assertExactRunInputs, materializeExactRunInputs, type ExactRunInputs } from '../../control/exactRunInputs.js';
import type { Runtime } from '../../control/runtime.js';
import { canonicalJson } from '../../shared/ids.js';
import { containsPath } from '../../shared/pathIdentity.js';
import { insistLanding } from './localLandingEvidence.js';

export interface LocalLandingCheck {
  readonly name: 'dependency_install' | 'typecheck' | 'build' | 'regression_suite';
  readonly durationMs: number;
}

interface LocalVerificationInput {
  readonly before: ExactRunInputs;
  readonly candidate: ExactRunInputs;
  readonly path: string;
  readonly content: Uint8Array;
  readonly boundary: ReturnType<typeof createRestrictedExecution>['boundary'];
  readonly timeoutSeconds: number;
  readonly verifyCommands: readonly [string, string];
  readonly minPassingTests: number;
  readonly maxSkippedTests: number;
}

export function assertLandingVerificationConfigured(runtime: Runtime, input: LocalVerificationInput): void {
  insistLanding(runtime.config.shadow.install_command === 'npm ci' &&
    runtime.config.runtime.scripts['typecheck'] === 'npm run typecheck' &&
    runtime.config.runtime.scripts['build'] === 'npm run build' &&
    input.verifyCommands[0] === 'npm run typecheck' &&
    input.verifyCommands[1] === 'node dist/selftest/benchmark-offline-suite-v1.js' &&
    runtime.config.patching.post_land_verify.join(',') === 'typecheck,regression_suite' &&
    input.timeoutSeconds >= 1 && input.timeoutSeconds <= 5_400,
  'The approved local typecheck, build and regression-suite configuration is unavailable.');
}

function assertRegressionSummary(stdout: string, input: LocalVerificationInput): void {
  function count(key: string): number | null {
    const lines = [...stdout.matchAll(new RegExp('^# ' + key + ' ([0-9]+)\\r?$', 'gmu'))];
    const value = Number(lines[0]?.[1]);
    return lines.length === 1 && Number.isSafeInteger(value) ? value : null;
  }
  const passing = count('pass');
  const skipped = count('skipped');
  insistLanding(/^CLU-E_OFFLINE_SUITE_V1\r?$/mu.test(stdout) &&
    passing !== null && passing >= input.minPassingTests && skipped !== null && skipped <= input.maxSkippedTests &&
    count('tests') === passing + skipped && count('fail') === 0 && count('cancelled') === 0 && count('todo') === 0,
  'The contained SCN-006 regression suite failed or differs from accepted coverage.');
}

export async function verifyAcceptedLanding(runtime: Runtime, input: LocalVerificationInput): Promise<readonly LocalLandingCheck[]> {
  assertLandingVerificationConfigured(runtime, input);
  const shadow = realpathSync.native(runtime.config.shadow.root);
  const canonical = realpathSync.native(runtime.config.project.root);
  const workspaceRoot = realpathSync.native(runtime.workspaceRoot);
  insistLanding(!containsPath(shadow, canonical) && !containsPath(canonical, shadow) &&
    !containsPath(workspaceRoot, shadow) && !containsPath(shadow, workspaceRoot),
  'Landing verification requires a physical shadow root disjoint from canonical source and workspace.');
  const area = mkdtempSync(join(shadow, 'landing-verify-'));
  try {
    const candidate = join(area, 'candidate');
    const workspace = join(area, 'candidate-workspace');
    mkdirSync(candidate);
    mkdirSync(workspace);
    materializeExactRunInputs(canonical, candidate, input.before);
    const file = join(candidate, ...input.path.split('/'));
    writeFileSync(file, input.content);
    assertExactRunInputs(candidate, input.candidate, 'Accepted verification copy');
    const broker = createRestrictedExecution({ repoRoot: candidate, projectRoot: candidate, workspaceRoot: workspace, mode: 'candidate' });
    try {
      insistLanding(canonicalJson(broker.boundary) === canonicalJson(input.boundary),
        'The active verifier qualification differs from the accepted proof boundary.');
      const commands = [['dependency_install', 'npm ci'], ['typecheck', input.verifyCommands[0]],
        ['build', 'npm run build'], ['regression_suite', input.verifyCommands[1]]] as const;
      const checks: LocalLandingCheck[] = [];
      for (const [name, configured] of commands) {
        const command = parseScriptCommand(name, configured);
        insistLanding(!('reason' in command), 'An approved landing verification command became unavailable.');
        const result = await broker.exec(command.argv, { timeoutSeconds: input.timeoutSeconds });
        insistLanding(result.code === 0 && !result.timedOut, 'Post-landing ' + name + ' failed in the approved verifier.');
        if (name === 'regression_suite') assertRegressionSummary(result.stdout, input);
        assertExactRunInputs(candidate, input.candidate, 'Accepted verification copy after ' + name);
        checks.push({ name, durationMs: Math.round(result.wallMs) });
      }
      assertExactRunInputs(canonical, input.before, 'Screened project after landing verification');
      return checks;
    } finally {
      broker.dispose();
    }
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
}
