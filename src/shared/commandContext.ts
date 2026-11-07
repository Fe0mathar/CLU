/**
 * Active-command context (DEV-P1-36 flip; cycle plan D4, accepted 2026-08-10).
 *
 * The command-authority registry declares `requiresMission` per command, and DEV-P1-36
 * measured that nothing consumed it — the mission gate was whatever each command happened
 * to pass to `withRuntime`. This module is the consumption path, shaped by layering: the
 * CLI's pre-action hook derives the requirement from the registry and writes it here;
 * `withRuntime` reads it as the **default** when its caller does not say otherwise.
 *
 * Three properties keep this honest:
 *
 * - **The registry stays the sole authority.** This slot never stores an opinion — the
 *   hook writes exactly `requireAuthority(path).requiresMission`, derived at dispatch.
 * - **An explicit option still wins.** A command that passes `requireMission` keeps its
 *   word; the slot only fills silence.
 * - **Non-CLI callers are unchanged.** Daemons, tests, and scripts that never dispatch a
 *   command see `null` here, and `withRuntime` behaves exactly as before the flip.
 */

let requirement: boolean | null = null;

/** Set by the CLI pre-action hook with the dispatched command's declared requirement. */
export function setActiveCommandMissionRequirement(value: boolean): void {
  requirement = value;
}

/** The dispatched command's declared requirement, or null outside a CLI dispatch. */
export function activeCommandMissionRequirement(): boolean | null {
  return requirement;
}
