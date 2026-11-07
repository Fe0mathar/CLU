/**
 * Q2 — what the Great Book field's panel state claims — `DEV-P1-16`.
 *
 * Lifted from `setFoot` in `app.js`, where it read the exclusion set out of the live field object
 * and wrote its conclusion straight into `ClueInterface.setPanelState`. The decision — given a
 * projection and the operator's exclusions, what may the panel claim — was fused to both the DOM
 * it read from and the DOM it wrote to, so nothing could ask it a question.
 *
 * ## The distinction this file exists to keep
 *
 * "AWAITING PROOF" and "N MEASURES EXCLUDED" were already separate states in the original, and
 * that separation is Q2's version of the rule every quadrant carries: absence of evidence and
 * evidence deliberately set aside are different facts. An operator seeing AWAITING PROOF when
 * they excluded everything themselves would conclude the engine has proven nothing, which is not
 * what happened. The tests state the separation as a requirement rather than trusting the ternary
 * to keep encoding it.
 *
 * ## Live counts count what is shown
 *
 * `active` counts cells that are available or stale *after* exclusions, because the panel label
 * describes the field the operator is looking at — an excluded measure is not on the field, so it
 * is not an active measure, however proven it is. Stale still counts as active: a labelled old
 * answer is on the field, and §18's whole point is that labelled staleness remains information.
 */

/**
 * @param {unknown} view the improvement-field projection, or null when unavailable
 * @param {Set<string>} [excluded] measurement ids the operator excluded
 * @returns {{ state: string, label: string, pulse: boolean, active: number, excluded: number }}
 */
export function q2PanelDecision(view, excluded = new Set()) {
  const record = /** @type {{ cells?: unknown }} */ (view ?? {});
  const sourceCells = Array.isArray(record.cells) ? record.cells : [];

  const visible = sourceCells.filter(
    (cell) => !excluded.has(String(cell?.measurementId ?? '')),
  );
  const active = visible.filter(
    (cell) => cell?.state === 'available' || cell?.state === 'stale',
  ).length;
  const excludedCount = sourceCells.length - visible.length;

  if (active > 0) {
    return Object.freeze({
      state: 'live',
      label: `${active} ACTIVE PROVEN ${active === 1 ? 'MEASURE' : 'MEASURES'}`,
      pulse: true,
      active,
      excluded: excludedCount,
    });
  }

  if (excludedCount > 0) {
    // The operator set these aside; the engine did not fail to prove them. Reporting this as
    // AWAITING PROOF would tell the operator the opposite of what they themselves did.
    return Object.freeze({
      state: 'warning',
      label: `${excludedCount} MEASURES EXCLUDED`,
      pulse: false,
      active: 0,
      excluded: excludedCount,
    });
  }

  return Object.freeze({
    state: 'idle',
    label: 'AWAITING PROOF',
    pulse: false,
    active: 0,
    excluded: 0,
  });
}
