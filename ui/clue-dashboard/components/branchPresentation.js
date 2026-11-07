/**
 * How a Status branch is presented — `DEV-P1-16`.
 *
 * §20.1 gives the shell "error/unknown presentation" as one of its six responsibilities, and
 * §10.1.3 says what that has to achieve: "Unknown, unsupported, partial, stale, failed, and
 * discovered states are explicit." One place decides it, because the failure this prevents is
 * exactly the kind that arrives one panel at a time — a quadrant author writes `?? 0` or
 * `|| '—'` in a template, it looks fine, and a branch that could not be read becomes a zero
 * nobody questions.
 *
 * ## The rule this file exists to enforce
 *
 * **An absent value never becomes a number.** The Status Contract spends its length keeping
 * `unsupported`, `unavailable`, `stale` and a real zero apart; `statusProjector` is tested to
 * never substitute one for another; the store refuses to default them. All of that is undone if
 * the last hop renders them identically, and the last hop is the only one the operator sees.
 *
 * So this returns a decision, not a string: a `kind` the caller must handle, and a `value` that is
 * present only when there genuinely is one. A caller that wants to shortcut to text can, but it
 * has to pass through `kind` to do it, and `kind` has no falsy member.
 *
 * ## Why a missing reason is itself reported
 *
 * The contract makes `reason` mandatory on an unbacked branch because "the honest answer is
 * specific — `no src/benchmark/ domain in this build` is useful; a bare `unsupported` is not".
 * A branch that arrives unbacked with no reason is therefore malformed, and saying so is more
 * useful than printing an empty parenthesis: it points at the projector rather than at the data.
 */

/** Every kind a caller must handle. None is falsy, so none can be skipped by accident. */
export const PRESENTATION_KINDS = Object.freeze([
  'value',
  'stale',
  'unsupported',
  'unavailable',
  'unknown',
  'not-applicable',
  'conflicted',
  'unknown-branch',
  'malformed',
]);

/** Tone is advisory styling, never meaning. Two kinds may share a tone; they never merge. */
const TONE = Object.freeze({
  value: 'normal',
  stale: 'warn',
  unsupported: 'muted',
  unavailable: 'muted',
  unknown: 'muted',
  'not-applicable': 'muted',
  conflicted: 'bad',
  'unknown-branch': 'bad',
  malformed: 'bad',
});

const UNBACKED_STATES = new Set([
  'unsupported',
  'unavailable',
  'unknown',
  'not_applicable',
  'conflicted',
  'stale',
]);

function normaliseState(state) {
  return String(state).replace(/_/g, '-');
}

/**
 * Decides how one branch should be shown.
 *
 * @param {unknown} branch the branch exactly as the store returned it
 * @param {object} [options]
 * @param {(branch: object) => unknown} [options.readValue] pulls the displayable value out of a
 *        backed branch. Supplied by the caller because only the caller knows which field of its
 *        own branch is the number on the tile.
 * @returns {{ kind: string, tone: string, reason: string|null, value?: unknown, since?: unknown, ageMs?: unknown }}
 */
export function presentBranch(branch, options = {}) {
  if (branch === null || branch === undefined || typeof branch !== 'object') {
    return Object.freeze({
      kind: 'malformed',
      tone: TONE.malformed,
      reason: 'the branch is not an object',
    });
  }

  const record = /** @type {Record<string, unknown>} */ (branch);
  const state = normaliseState(record['state'] ?? '');

  if (state === 'unknown-branch') {
    return Object.freeze({
      kind: 'unknown-branch',
      tone: TONE['unknown-branch'],
      reason: typeof record['reason'] === 'string' ? record['reason'] : 'no such branch',
    });
  }

  if (UNBACKED_STATES.has(String(record['state']))) {
    const reason = record['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      // Points at the projector rather than at the data, which is where the fault is.
      return Object.freeze({
        kind: 'malformed',
        tone: TONE.malformed,
        reason: `a ${state} branch arrived with no reason, which the contract requires`,
      });
    }

    if (state === 'stale') {
      // Stale still has a value, and hiding it would replace a labelled old answer with no
      // answer. §18 labels staleness for exactly that reason.
      const value = readValue(record, options);
      return Object.freeze({
        kind: 'stale',
        tone: TONE.stale,
        reason,
        ...(value === undefined ? {} : { value }),
        ...(record['ageMs'] === undefined ? {} : { ageMs: record['ageMs'] }),
        ...(record['since'] === undefined ? {} : { since: record['since'] }),
      });
    }

    return Object.freeze({ kind: state, tone: TONE[state] ?? 'muted', reason });
  }

  const value = readValue(record, options);
  if (value === undefined) {
    return Object.freeze({
      kind: 'malformed',
      tone: TONE.malformed,
      reason: 'the branch is backed but carries no readable value',
    });
  }

  // A real zero is a value. This is the case the whole file exists to keep separate from absence,
  // and it is the one a `|| '—'` in a template gets wrong.
  return Object.freeze({ kind: 'value', tone: TONE.value, reason: null, value });
}

function readValue(record, options) {
  if (typeof options.readValue === 'function') {
    try {
      return options.readValue(record);
    } catch {
      return undefined;
    }
  }
  return record['value'];
}

/**
 * A short label for a decision, for a tile that has room for one line.
 *
 * The unbacked kinds render as words rather than as a dash, because a dash is what a caller writes
 * when it does not know, and every one of these is a state someone recorded deliberately.
 */
export function presentationLabel(decision, formatValue = String) {
  switch (decision.kind) {
    case 'value':
      return formatValue(decision.value);
    case 'stale':
      return decision.value === undefined ? 'STALE' : `${formatValue(decision.value)} (stale)`;
    case 'unsupported':
      return 'UNSUPPORTED';
    case 'unavailable':
      return 'UNAVAILABLE';
    case 'unknown':
      return 'UNKNOWN';
    case 'not-applicable':
      return 'N/A';
    case 'conflicted':
      return 'CONFLICTED';
    case 'unknown-branch':
      return 'UNKNOWN BRANCH';
    case 'malformed':
      return 'MALFORMED';
    default:
      return 'UNKNOWN';
  }
}

/**
 * The text a screen reader should get, which is the label plus the reason.
 *
 * §20.1 lists accessibility beside error presentation deliberately: an operator who cannot see the
 * tooltip has the same right to the reason as one who can, and a bare "UNAVAILABLE" announced with
 * no cause is the least useful thing this could say.
 */
export function presentationAriaLabel(decision, name, formatValue = String) {
  const label = presentationLabel(decision, formatValue);
  return decision.reason === null ? `${name}: ${label}` : `${name}: ${label} — ${decision.reason}`;
}
