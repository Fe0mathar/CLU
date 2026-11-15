/**
 * Resume planner — Execution Model §21.2 made computable (DEV-P2-08, deferred slice).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §21.2 — "Resume verifies mission, cycle locks,
 *       projection parity, task leases, repository state, tool health, and artifact
 *       integrity before continuing."; `docs/cycle-implementation-plan_v1.md` §3
 *       (`resumePlanner.ts`, "refusal-shaped like doctor"), accepted 2026-08-10.
 *
 * ## What this composes, and what it owns
 *
 * §21.2 is a checklist over other domains' verifiers, so this module invents none of them:
 * the mission comes from the registry, the lock is recomputed by `computeInputLock`, the
 * projections' freshness by the runtime's own staleness law, the log by its full-chain
 * `verify()`, the artifacts by `verifyAll()`. What the planner owns is the composition,
 * the verdict, and the **receipt**: every check's outcome — pass or fail, with the facts —
 * goes into one artifact, and the resumed event references it. A resume that passed is as
 * documented as one that was refused.
 *
 * ## The lock check's exact meaning
 *
 * The lock digest is time-blind and world-sensitive by construction, so recomputing it
 * answers §21.2's question precisely: **is this still the world the cycle locked?** A
 * changed digest is not automatically fatal in the Execution Model's own terms — §21.3
 * says a restart with a new identity and new lock is the answer "when material inputs
 * changed" — so the refusal message says exactly that: resume is refused, and restart is
 * the named alternative. The mission check is the same shape: a successor mission in
 * force means the cycle's authority moved beneath it (§21.4's territory), and the refusal
 * names both versions.
 *
 * ## Stated non-checks
 *
 * §21.2 also names task leases, repository state beyond the lock's inputs, and tool
 * health. Task-lease verification belongs to the queue domain and no cycle work holds
 * leases yet; repository state *is* the lock's tracked-document set for a diagnostic
 * cycle; tool health is doctor's surface. The receipt lists these as `not_checked` with
 * those reasons — absences stated, per the house rule, not silently narrowed.
 */

import type { Runtime } from '../control/runtime.js';
import { readCurrentCycleAuthority } from './cycleAuthority.js';
import { computeInputLock } from './cycleInputLock.js';
import type { CycleRecord } from '../shared/schemas.js';

export interface ResumeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ResumeVerification {
  readonly cycleId: string;
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly checks: readonly ResumeCheck[];
  readonly notChecked: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Runs §21.2's verification for a suspended or interrupted cycle. Pure over the runtime's services;
 * writes nothing — the caller records the receipt and decides (the orchestrator refuses
 * the resume when `ok` is false, quoting the failed checks).
 */
export function verifyResume(
  runtime: Runtime,
  cycle: CycleRecord,
  options: { readonly allowUnsealedOpened?: boolean } = {},
): ResumeVerification {
  const checks: ResumeCheck[] = [];

  // Mission: the cycle's authority must still be the authority (§21.4 otherwise).
  const missionRegistry = runtime.requireMission();
  const mission = missionRegistry.current();
  if (mission === null) {
    checks.push({ name: 'mission', ok: false, detail: 'no mission registered' });
  } else {
    checks.push({
      name: 'mission',
      ok: mission.id === cycle.mission_version,
      detail:
        mission.id === cycle.mission_version
          ? `${mission.id} unchanged`
          : `cycle opened under ${cycle.mission_version}, ${mission.id} now in force — ` +
            'a fork or successor moved the authority (§21.4); restart the cycle under it (§21.3)',
    });
  }

  // Cycle lock: is this still the world the cycle locked?
  if (cycle.lock_digest === null) {
    const unsealedOpened = (options.allowUnsealedOpened === true && cycle.stage === 'OPENED') ||
      (cycle.stage === 'SUSPENDED' && cycle.suspended_from === 'OPENED');
    checks.push({
      name: 'lock',
      ok: unsealedOpened,
      detail: unsealedOpened ? 'inputs have yet to be locked at OPENED' : 'the cycle carries no lock digest',
    });
  } else if (mission === null || runtime.log === null) {
    checks.push({ name: 'lock', ok: false, detail: 'not recomputable without a mission and verified event log' });
  } else {
    const lock = computeInputLock({
      repoRoot: runtime.repoRoot,
      config: runtime.config,
      mission,
      ...readCurrentCycleAuthority(runtime.log.replay(), mission.id),
      projectBinding: runtime.projectBinding,
    });
    checks.push({
      name: 'lock',
      ok: lock.digest === cycle.lock_digest,
      detail:
        lock.digest === cycle.lock_digest
          ? `digest ${lock.digest.slice(0, 12)}… reproduced`
          : `locked ${cycle.lock_digest.slice(0, 12)}…, world now ${lock.digest.slice(0, 12)}… — ` +
            'material inputs changed; §21.3: restart with a new identity and a new lock',
    });
  }

  // Projection parity: the runtime's own staleness law, re-checked now.
  try {
    runtime.requireFreshProjections();
    checks.push({ name: 'projections', ok: true, detail: 'fresh against the log' });
  } catch (error) {
    checks.push({
      name: 'projections',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // Log integrity: the full chain, not the tail — a resume trusts all of history.
  const log = runtime.log;
  if (log === null) {
    checks.push({ name: 'log', ok: false, detail: 'no event log in this runtime' });
  } else {
    try {
      const verified = log.verify();
      checks.push({
        name: 'log',
        ok: true,
        detail: `${verified.records} record(s), head ${verified.head?.hash.slice(0, 12) ?? '(empty)'}…`,
      });
    } catch (error) {
      checks.push({
        name: 'log',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Artifact integrity: every blob hashes to its name.
  const report = runtime.artifacts.verifyAll();
  const bad = report.mismatched.length + report.unreadable.length;
  checks.push({
    name: 'artifacts',
    ok: bad === 0,
    detail:
      bad === 0
        ? `${report.checked} blob(s) verified`
        : `${bad}/${report.checked} blob(s) failed (${[...report.mismatched, ...report.unreadable]
            .slice(0, 3)
            .join(', ')}${bad > 3 ? ', …' : ''})`,
  });

  return {
    cycleId: cycle.id,
    checkedAt: new Date().toISOString(),
    ok: checks.every((check) => check.ok),
    checks,
    notChecked: [
      { name: 'task leases', reason: 'queue domain; no cycle work holds leases yet' },
      {
        name: 'repository state',
        reason: "covered by the lock's tracked-document set for a diagnostic cycle",
      },
      { name: 'tool health', reason: "doctor's surface; run `clue doctor` alongside" },
    ],
  };
}
