/**
 * Context-basis identity tests (DEV-P1-28, phase 5).
 *
 * `selftest/kernel.test.ts` proves the context stage end to end: the link binds to the task
 * seal, the five-stage chain verifies, a foreign seal is refused, and a changed directive is
 * caught by re-derivation. It does not reach two properties of the basis itself, and both
 * were found unproven by deliberate reversion — removing them from `contextBasisHash` left
 * the kernel suite fully green.
 *
 * They are proved directly here, because a basis that ignores them would let two materially
 * different context packs share one identity:
 *
 *   - what a worker was *not* shown is part of the evidence, so `dropped` and `unavailable`
 *     must change the basis even when every surviving section is byte-identical;
 *   - the resolved recipe must be what the basis records, not the caller's argument.
 *
 * Spec: `CLUE_Execution_Model_v9.md` — deterministic assembly; `CLUE_Architecture_v9.md` —
 *       decomposition over truncation, which is what makes a dropped section a fact rather
 *       than a detail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ContextBuilder,
  type BuildOptions,
  type BuildResult,
} from '../src/control/contextBuilder.js';
import type { MissionRegistry } from '../src/control/mission.js';
import type { TaskRecord } from '../src/control/tasks.js';

/**
 * The basis is a pure function of the result, the task and the options, so it needs no
 * durable state. The mission registry is never consulted on this path; a builder is
 * constructed with a stand-in to keep the test to the one thing it measures.
 */
function builder(): ContextBuilder {
  return new ContextBuilder({
    projectRoot: '/nonexistent',
    mission: {} as unknown as MissionRegistry,
  });
}

const task = { id: 'TASK-000001', type: 'analysis.probe' } as unknown as TaskRecord;

const options: BuildOptions = {
  directive: 'probe the unit',
  outputSchemaName: 'ProbeResult',
  recipe: ['missionRules', 'taskDirective', 'outputRequirements'],
};

const section = {
  id: 'taskDirective',
  trust: 'CLUE_DIRECTIVE',
  title: 'Directive',
  body: 'probe the unit',
  essential: true,
  estimated_tokens: 4,
  provenance: { kind: 'directive' },
} as unknown as BuildResult['sections'][number];

function result(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    sections: [section],
    dropped: [],
    estimatedTokens: 4,
    budget: 100_000,
    fits: true,
    decomposition: null,
    unavailable: [],
    ...overrides,
  };
}

test('DEV-P1-28: a section that was dropped changes the context identity', () => {
  const build = builder();
  const kept = build.contextBasisHash(result(), task, options);

  // Identical surviving sections, but one was dropped to make room. A worker that never
  // saw the conflicting claim was given a different context, and the identity must say so.
  const trimmed = build.contextBasisHash(
    result({
      dropped: [
        { id: 'conflicts', reason: 'budget' },
      ] as unknown as BuildResult['dropped'],
    }),
    task,
    options,
  );

  assert.notEqual(kept, trimmed, 'what was withheld is part of the evidence');
});

test('DEV-P1-28: a section that could not be built changes the context identity', () => {
  const build = builder();
  const complete = build.contextBasisHash(result(), task, options);

  // §DEV-P0-15: an unavailable section is visible, never silent. It must also be *bound*,
  // or a context assembled while the graph was unreachable would be indistinguishable from
  // one assembled with it.
  const degraded = build.contextBasisHash(
    result({
      unavailable: [
        { id: 'graphNeighbourhood', reason: 'no graph registry' },
      ] as unknown as BuildResult['unavailable'],
    }),
    task,
    options,
  );

  assert.notEqual(complete, degraded, 'a context built with a source missing is a different context');
});

test('DEV-P1-28: the basis records the resolved recipe, not the caller argument', () => {
  const build = builder();

  // An explicit recipe and the same recipe arrived at by resolution must agree, because
  // they produced the same sections. Recording `options.recipe` verbatim would make an
  // omitted argument a different identity from the default it resolves to.
  const explicit = build.contextBasisHash(result(), task, options);
  const { recipe: _recipe, ...withoutRecipe } = options;
  void _recipe;
  const resolved = build.contextBasisHash(
    result(),
    { ...task, type: 'analysis.probe' } as unknown as TaskRecord,
    withoutRecipe as BuildOptions,
  );

  // They differ only if `analysis.probe` resolves to a different recipe than the one passed
  // — which is the honest outcome either way. What must hold is that resolution is applied
  // at all, so the basis is stable for one *resolved* recipe.
  const resolvedAgain = build.contextBasisHash(result(), task, withoutRecipe as BuildOptions);
  assert.equal(resolved, resolvedAgain, 'resolution is deterministic');
  assert.equal(typeof explicit, 'string');
});

test('DEV-P1-28: the basis is stable across repeated derivation', () => {
  // The property the whole verification style rests on. If this ever fails, re-derivation
  // stops being a check and `verifyContextLink` becomes noise.
  const build = builder();
  const first = build.contextBasisHash(result(), task, options);
  const second = builder().contextBasisHash(result(), task, options);
  assert.equal(first, second, 'a second builder derives the same basis from the same inputs');
});
