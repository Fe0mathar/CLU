# ADR-0018 — Q1 SURF/DIVE physical inventory and semantic handoff

**Status:** Accepted for implementation; enters the next documentation ratification set  
**Creator decision:** 2026-08-14 — the supplied `app.js` and `Q1_SURF_DIVE_integration.md` are the authoritative interface/integration baseline  
**Frontend identity:** `ui/clue-dashboard/app.js` SHA-256 `db9b274968ff854c02b11d8ed5e7c54146cdf401665b5febc8950ed68316bbe0`  
**Interface version:** `ULTIMATE-2026.08-Q1-V9-REPOSITORY-OBSERVATORY-R1`

## Decision

Q1 exposes exactly two top-level operator modes:

```text
SURF  = physical repository truth (default)
DIVE  = semantic Navigator
```

The legacy semantic `ALL` state becomes the DIVE overview. The legacy semantic `DIVE`
state remains DIVE detail. Those two semantic states are no longer separate top-level Q1
modes.

Physical membership and technology classification are owned by the backend. Semantic
recognition enriches an existing physical file identity; it never creates, removes, or
reclassifies physical membership.

## Authorities

| Fact | Authority |
|---|---|
| physical files and lifecycle | `src/analysis/source/repositoryInventory.ts` |
| family/environment taxonomy | `src/analysis/environments/artifactTaxonomy.ts` |
| semantic units and relations | existing recognizer/graph authority |
| versioned Q1 wire | `src/analysis/source/navigatorEvents.ts` |
| browser replay model | `ui/system-navigator/src/adapters/SseNavigatorAdapter.js` |
| file-to-semantic resolution | `ui/system-navigator/src/core/FileDiveResolver.js` |
| rendering and operator interaction | the Creator-supplied `ui/clue-dashboard/app.js` |

## Required event order

```text
navigator.reset
inventory.started
inventory.taxonomy
files.upserted        (one or more bounded batches)
inventory.completed
recognition.started
scan.started
...
files.upserted        (semantic enrichment)
file.semantic-summary
[dependency.discovered]
graph.committed
```

Every envelope retains the recognition snapshot identity. Physical records additionally
carry the full-repository snapshot, inventory hash, taxonomy hash, stable location identity
and exact version identity. `graph.committed` repeats the physical seal facts so the final
stream record binds both projections.

## Identity rules

- `fileLocationId` = stable repository + normalized path identity.
- `fileVersionId` = location identity + content hash + byte count + executable mode.
- Editing bytes preserves `fileLocationId` and changes `fileVersionId`.
- A semantic membership ID may accelerate handoff but may never override an exact path
  mismatch.
- Unknown technology remains explicit `unknown`; the browser never invents a family.

## Replay and performance

- The full physical capture is one content-addressed repository traversal.
- Semantic enrichment is O(files + units + edges), not files × edges × units.
- File records are emitted in bounded batches.
- The SSE adapter serializes asynchronous application to preserve wire order.
- Duplicate/stale sequences are rejected and high-water memory is bounded per active stream.
- Reconnect replay cannot overwrite a newer file version with stale enrichment.

## Compatibility boundary

This decision does not modify `app.js`. Backend and adapter code conform to the exact
Creator-supplied file. If no new inventory-bearing recognition stream exists yet, SURF
must remain `PHYSICAL INVENTORY AWAITING DATA`; the operator must run a new recognition
rather than allowing the browser to synthesize physical files from semantic nodes.
