/**
 * `DEV-P1-16` — how a Status branch is presented.
 *
 * Almost every assertion here is a separation: two states that must not render the same way. That
 * is the shape of the risk. The projector is tested never to substitute one state for another and
 * the store refuses to default them, but all of that is undone if the last hop draws them
 * identically — and the last hop is the only one the operator sees.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESENTATION_KINDS,
  presentBranch,
  presentationAriaLabel,
  presentationLabel,
} from '../components/branchPresentation.js';
import { createStatusStore } from '../state/statusStore.js';

test('DEV-P1-16: a real zero is a value, not an absence', () => {
  const decision = presentBranch({ state: 'backed', value: 0 });

  assert.equal(decision.kind, 'value');
  assert.equal(decision.value, 0);
  // The case the whole module exists for. `|| '—'` and `?? 0` in a template each get exactly one
  // of these wrong, and neither author notices.
  assert.equal(presentationLabel(decision), '0');
  assert.notEqual(presentationLabel(decision), presentationLabel(presentBranch({
    state: 'unavailable',
    reason: 'src/metrics/golden/ is absent',
  })));
});

test('DEV-P1-16: unsupported and unavailable never collapse into one another', () => {
  const unsupported = presentBranch({ state: 'unsupported', reason: 'no src/benchmark/ domain' });
  const unavailable = presentBranch({ state: 'unavailable', reason: 'the reader failed' });

  assert.equal(unsupported.kind, 'unsupported');
  assert.equal(unavailable.kind, 'unavailable');
  assert.notEqual(presentationLabel(unsupported), presentationLabel(unavailable));
  // "this build cannot do it" and "it has not run yet" need different responses from the
  // operator, which is why the contract separates them and why the tile must too.
  assert.match(unsupported.reason, /no src\/benchmark/);
  assert.match(unavailable.reason, /the reader failed/);
});

test('DEV-P1-16: stale keeps its value and says so, rather than hiding it', () => {
  const decision = presentBranch({
    state: 'stale',
    reason: 'head moved past the projection',
    value: 42,
    ageMs: 90_000,
  });

  assert.equal(decision.kind, 'stale');
  assert.equal(decision.value, 42);
  assert.equal(decision.ageMs, 90_000);
  // Hiding it would replace a labelled old answer with no answer, and §18 labels staleness for
  // exactly the opposite reason.
  assert.equal(presentationLabel(decision), '42 (stale)');
});

test('DEV-P1-16: an unbacked branch with no reason is malformed, and names the projector', () => {
  const decision = presentBranch({ state: 'unavailable' });

  // The contract makes `reason` mandatory because a bare `unsupported` is not useful. A branch
  // arriving without one is a fault upstream, and saying so points at the right place.
  assert.equal(decision.kind, 'malformed');
  assert.match(decision.reason, /arrived with no reason, which the contract requires/);
});

test('DEV-P1-16: an unknown branch is its own kind, distinct from unavailable', () => {
  const unknown = presentBranch({ state: 'unknown-branch', reason: 'no such branch "cycle"' });
  const unavailable = presentBranch({ state: 'unavailable', reason: 'the domain is absent' });

  assert.equal(unknown.kind, 'unknown-branch');
  assert.notEqual(unknown.kind, unavailable.kind);
  assert.notEqual(presentationLabel(unknown), presentationLabel(unavailable));
});

test('DEV-P1-16: no kind is falsy, so none can be skipped by an `if (kind)`', () => {
  for (const kind of PRESENTATION_KINDS) {
    assert.ok(kind, `${kind} must be truthy`);
    assert.equal(typeof kind, 'string');
  }
  assert.equal(new Set(PRESENTATION_KINDS).size, PRESENTATION_KINDS.length);
});

test('DEV-P1-16: a caller reads its own value field, because only it knows which one', () => {
  const branch = { state: 'backed', fileCount: 600 };

  assert.equal(presentBranch(branch).kind, 'malformed', 'no default field to read');
  const decision = presentBranch(branch, { readValue: (b) => b.fileCount });
  assert.equal(decision.kind, 'value');
  assert.equal(decision.value, 600);
});

test('DEV-P1-16: a reader that throws yields malformed, not a silent blank', () => {
  const decision = presentBranch(
    { state: 'backed', value: 1 },
    {
      readValue: () => {
        throw new Error('bad shape');
      },
    },
  );
  assert.equal(decision.kind, 'malformed');
});

test('DEV-P1-16: the screen reader is told the reason, not just the word', () => {
  const decision = presentBranch({ state: 'unsupported', reason: 'no src/benchmark/ domain' });

  // §20.1 lists accessibility beside error presentation deliberately: a bare "UNSUPPORTED"
  // announced with no cause is the least useful thing this could say.
  assert.equal(
    presentationAriaLabel(decision, 'Benchmark'),
    'Benchmark: UNSUPPORTED — no src/benchmark/ domain',
  );
  assert.equal(
    presentationAriaLabel(presentBranch({ state: 'backed', value: 3 }), 'Cycles'),
    'Cycles: 3',
  );
});

test('DEV-P1-16: a branch straight from the store presents without translation', async () => {
  const store = createStatusStore({
    fetchJson: async (url) =>
      url.endsWith('/schema')
        ? { schemaVersion: '5.1.0' }
        : {
            schemaVersion: '5.1.0',
            repositoryInventory: { state: 'backed', fileCount: 600 },
            benchmark: { state: 'unsupported', reason: 'no src/benchmark/ domain in this build' },
          },
    createEventSource: () => ({ addEventListener() {}, close() {} }),
  });
  await store.refresh();

  // End to end: what the store hands over is what this reads. A translation step between them
  // would be a third place for the states to blur.
  const inventory = presentBranch(store.branch('repositoryInventory'), {
    readValue: (b) => b.fileCount,
  });
  assert.deepEqual([inventory.kind, inventory.value], ['value', 600]);

  assert.equal(presentBranch(store.branch('benchmark')).kind, 'unsupported');
  assert.equal(presentBranch(store.branch('cycle')).kind, 'unknown-branch');
});
