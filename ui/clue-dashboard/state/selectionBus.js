/**
 * The quadrant selection and cross-highlighting bus — `DEV-P1-16`.
 *
 * Directory §20.1 gives the shell "quadrant selection and cross-highlighting bus" in the same
 * breath as the constraint that it *must not recreate Q1, metric, Git, benchmark, or verdict state
 * locally*. Those two clauses decide this file's entire design, and the decision is the first
 * one below.
 *
 * ## The bus carries identity, never the entity
 *
 * A selection is `{ quadrant, kind, id }` and nothing more. The obvious alternative — publishing
 * the selected object so subscribers do not have to look it up — is exactly the prohibited shape:
 * every quadrant that received it would hold a copy of another quadrant's state, the copies would
 * age at different rates, and two panels would disagree about one entity with no way to say which
 * was right. An identity cannot go stale, because it is not an answer; it is a question the holder
 * re-asks its own source.
 *
 * ## Cross-highlighting is registered, not known
 *
 * The bus does not know that a metric relates to a file, or that a verdict relates to a benchmark.
 * It cannot: knowing would put domain meaning in the shell, which is the same violation from the
 * other direction. Quadrants register a resolver — given a selection, which identities of mine
 * relate to it — and the bus asks each in turn. A quadrant that has nothing to say returns nothing
 * and remains unhighlighted, which is different from having no opinion recorded.
 *
 * ## What "no relation" and "not asked" must not become
 *
 * A resolver that throws is not a resolver that found nothing. Its quadrant is recorded as
 * `failed` with the reason, and the other resolvers still run — the listener isolation
 * `DEV-P1-22` required of the operational console, for the same reason: one bad participant must
 * not silence the rest or take the bus down.
 */

/** A selection identity. The three fields are the whole contract. */
export function selectionIdentity(quadrant, kind, id) {
  return Object.freeze({ quadrant: String(quadrant), kind: String(kind), id: String(id) });
}

function sameIdentity(a, b) {
  if (a === null || b === null) return a === b;
  return a.quadrant === b.quadrant && a.kind === b.kind && a.id === b.id;
}

const NO_SELECTION = Object.freeze({
  selection: null,
  highlights: Object.freeze({}),
  failures: Object.freeze({}),
});

export function createSelectionBus() {
  let current = NO_SELECTION;
  const listeners = new Set();
  const resolvers = new Map();

  function publish(next) {
    current = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        /* a subscriber's fault is its own */
      }
    }
  }

  /**
   * Registers a quadrant's answer to "what of yours relates to this selection?".
   *
   * The resolver returns an array of identities, or an empty array. Returning nothing and being
   * unable to answer are different states and must stay different: the first is a fact about the
   * data, the second a fault in the quadrant, and a viewer that cannot tell them apart will read
   * a broken panel as an empty one.
   */
  function registerResolver(quadrant, resolve) {
    resolvers.set(String(quadrant), resolve);
    return () => resolvers.delete(String(quadrant));
  }

  function recompute(selection) {
    const highlights = {};
    const failures = {};
    if (selection === null) return { selection: null, highlights: Object.freeze({}), failures: Object.freeze({}) };

    for (const [quadrant, resolve] of resolvers) {
      // The originating quadrant owns the selection; telling it to highlight its own selection
      // would make one entity both selected and related to itself, which no panel can render
      // meaningfully.
      if (quadrant === selection.quadrant) continue;
      try {
        const related = resolve(selection);
        highlights[quadrant] = Object.freeze(
          Array.isArray(related)
            ? related.map((item) =>
                selectionIdentity(item.quadrant ?? quadrant, item.kind, item.id),
              )
            : [],
        );
      } catch (error) {
        failures[quadrant] = error instanceof Error ? error.message : String(error);
        highlights[quadrant] = Object.freeze([]);
      }
    }
    return {
      selection,
      highlights: Object.freeze(highlights),
      failures: Object.freeze(failures),
    };
  }

  /**
   * Selects an identity, and recomputes cross-highlighting.
   *
   * Selecting what is already selected publishes nothing. A bus that re-emitted on every click
   * would make every quadrant redraw whenever the operator clicked the same thing twice, and the
   * cost of that is paid in the quadrant that is most expensive to redraw.
   */
  function select(identity) {
    if (sameIdentity(current.selection, identity)) return current;
    publish(recompute(identity));
    return current;
  }

  function clear() {
    if (current.selection === null) return current;
    publish(recompute(null));
    return current;
  }

  /** Re-asks every resolver about the current selection. For use when a quadrant's data changed. */
  function refresh() {
    publish(recompute(current.selection));
    return current;
  }

  function get() {
    return current;
  }

  /** The identities `quadrant` should highlight. Empty when nothing relates, or when it failed. */
  function highlightsFor(quadrant) {
    return current.highlights[String(quadrant)] ?? Object.freeze([]);
  }

  /** The reason `quadrant` could not answer, or null. Never conflated with an empty result. */
  function failureFor(quadrant) {
    return current.failures[String(quadrant)] ?? null;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    select,
    clear,
    refresh,
    get,
    highlightsFor,
    failureFor,
    registerResolver,
    subscribe,
  };
}
