/**
 * Q4 — how the operational console classifies and lays out real traffic — `DEV-P1-16`.
 *
 * Three decisions lifted from `app.js`: how a raw status string becomes one of five visual
 * states, which rows a work contract shows and in what order, and which events the feed keeps.
 * The markup writing stays in `app.js` — it is one string away from these — but the decisions
 * were previously testable only by producing real traffic in a running daemon and looking.
 *
 * ## The classifier's order is load-bearing
 *
 * `semanticEventState` tests failure words before warning words before success words, and that
 * order is the decision: "retry succeeded" must read as a warning, not a success, because a
 * retry is a fact about reliability even when it worked. The regexes were built from the status
 * vocabulary the recorder actually emits; a status matching nothing is `neutral`, never guessed
 * upward into success.
 *
 * ## The work contract's rows are the §9.1 contract
 *
 * WHAT / WHY / HOW-PROVEN / WHO-MODEL / CURRENT / NEXT, in that order, with an absent field
 * rendered as absent rather than dropped — a contract missing its HOW-PROVEN is a different
 * (and worse) thing than a contract with one, and hiding the row would hide that.
 */

/** The five visual states an event can occupy. Order of testing below is deliberate. */
export function semanticEventState(rawStatus) {
  const status = String(rawStatus ?? '').toLowerCase();
  if (/(fail|error|reject|invalid|critical|broken|abort)/.test(status)) return 'critical';
  if (/(warn|skip|defer|inconclusive|stale|retry)/.test(status)) return 'warning';
  if (/(success|complete|accept|pass|verified|sealed|ok)/.test(status)) return 'success';
  if (/(run|start|progress|active|working|dispatch|review)/.test(status)) return 'active';
  return 'neutral';
}

/** The §9.1 row order. Exported so the renderer and the tests share one truth. */
export const WORK_CONTRACT_ROWS = Object.freeze([
  Object.freeze({ key: 'WHAT', field: 'what', className: 'is-objective' }),
  Object.freeze({ key: 'WHY', field: 'why', className: 'is-rationale' }),
  Object.freeze({ key: 'HOW-PROVEN', field: 'howProven', className: 'is-proof' }),
  Object.freeze({ key: 'WHO / MODEL', field: 'whoModel', className: 'is-model' }),
  Object.freeze({ key: 'CURRENT', field: 'current', className: 'is-current' }),
  Object.freeze({ key: 'NEXT', field: 'next', className: 'is-next' }),
]);

/**
 * The rows a work contract shows.
 *
 * @param {unknown} contract
 * @returns {ReadonlyArray<{key: string, className: string, value: string|null}>|null}
 *   null when there is no contract at all — the honest idle state — and otherwise all six rows,
 *   each with its value or null for an absent field.
 */
export function workContractRows(contract) {
  if (contract === null || contract === undefined || typeof contract !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (contract);
  return Object.freeze(
    WORK_CONTRACT_ROWS.map((row) => {
      const raw = record[row.field];
      return Object.freeze({
        key: row.key,
        className: row.className,
        value: typeof raw === 'string' && raw.length > 0 ? raw : null,
      });
    }),
  );
}

/**
 * The events the feed keeps, newest first, and the fields the renderer reads from each.
 *
 * The cap and the order are the decision: the feed shows the latest `limit` events with the most
 * recent at the top, because an operational console is read from "what just happened" downward.
 *
 * @param {unknown} events
 * @param {number} [limit]
 */
export function feedEntries(events, limit = 120) {
  if (!Array.isArray(events) || events.length === 0) return Object.freeze([]);
  return Object.freeze(
    events
      .slice(-limit)
      .reverse()
      .map((event) => {
        const occurredAt = String(event?.occurredAt ?? '');
        const rawStatus = event?.summary?.status ?? event?.status ?? '';
        return Object.freeze({
          occurredAt,
          // A time without a date for the row, since the feed is a same-session surface; the
          // full timestamp still travels for the datetime attribute.
          at: occurredAt.includes('T')
            ? occurredAt.slice(11, 19)
            : occurredAt.slice(0, 8) || '\u2014',
          state: semanticEventState(rawStatus),
          statusText: String(rawStatus || semanticEventState(rawStatus)),
          channel: String(event?.channel ?? 'SYSTEM'),
          title: String(event?.title ?? '\u2014'),
        });
      }),
  );
}
