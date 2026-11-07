/**
 * Missing-source categorisation (DEV-P2-06 follow-up, 2026-08-10).
 *
 * Spec: the categorizer's own header in `doctorCommands.ts` — two provable states, a
 *       severity ladder that follows the worse one, absent holes enumerated in full
 *       because no other listing surface exists.
 *
 * These pins guard the honesty properties, not the prose: every source lands in exactly
 * one category by the one provable fact (existence under the target root); registry
 * ordering survives the split; the ladder is ok → info → warn as holes appear; the
 * outside-corpus set compresses while the absent set never does; and each absent entry
 * names its top citer, because `target ← citer` is what lets a stale reference, a planned
 * file, and a history citation read differently at a glance.
 *
 * Fixtures satisfy `missingSourceSchema` exactly — citations are `.min(1)`, so a
 * citationless source is not a state, and no test fabricates one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MissingSource } from '../src/analysis/documents/claimRegistry.js';
import {
  categoriseMissingSources,
  missingSourcesCheck,
} from '../src/cli/commands/doctorCommands.js';

function source(target: string, citer: string, citations = 1): MissingSource {
  return {
    target,
    first_seen_at: '2026-08-10T00:00:00.000Z',
    citation_count: citations,
    citations: Array.from({ length: citations }, (_, index) => ({
      document_path: citer,
      line: index + 1,
    })),
    resolved: false,
  };
}

/* ========================================================================= */
/* The split                                                                  */
/* ========================================================================= */

test('missing-source categorisation: one provable fact splits, order survives, nothing is dropped', () => {
  const onDisk = new Set(['package.json', 'config/clue.config.yaml']);
  const missing = [
    source('benchmark.yaml', 'CLUE_Project_Directory_v9.md'),
    source('package.json', 'CLUE_Architecture_v9.md'),
    source('CLUE_Constitution_v8.md', 'CHANGELOG_session3-4.md'),
    source('config/clue.config.yaml', 'CONFIG-EDIT.md'),
  ];

  const { outsideCorpus, absent } = categoriseMissingSources(missing, (target) =>
    onDisk.has(target),
  );

  assert.deepEqual(
    outsideCorpus.map((entry) => entry.target),
    ['package.json', 'config/clue.config.yaml'],
    'existing targets, in registry order',
  );
  assert.deepEqual(
    absent.map((entry) => entry.target),
    ['benchmark.yaml', 'CLUE_Constitution_v8.md'],
    'absent targets, in registry order',
  );
  assert.equal(outsideCorpus.length + absent.length, missing.length, 'exactly once each');
});

/* ========================================================================= */
/* The ladder and the line                                                    */
/* ========================================================================= */

test('missing-source check: ok when none, info when only by-design, warn when holes exist', () => {
  assert.deepEqual(missingSourcesCheck([], () => true), {
    level: 'ok',
    label: 'missing sources',
    detail: 'none',
  });

  const onlyOutside = missingSourcesCheck(
    [source('package.json', 'CLUE_Architecture_v9.md'), source('MANIFEST.txt', 'README_v9.md')],
    () => true,
  );
  assert.equal(onlyOutside.level, 'info', 'by-design non-documents are not a warning');
  assert.ok(onlyOutside.detail.includes('2 on disk outside the corpus'));
  assert.ok(!onlyOutside.detail.includes('absent'), 'no hole, no hole clause');

  const withHole = missingSourcesCheck(
    [source('package.json', 'CLUE_Architecture_v9.md'), source('benchmark.yaml', 'CLUE_Project_Directory_v9.md')],
    (target) => target === 'package.json',
  );
  assert.equal(withHole.level, 'warn', 'one real hole outranks any amount of by-design');
});

test('missing-source check: the outside set compresses, the absent set never does', () => {
  const outside = ['a.json', 'b.json', 'c.json', 'd.json', 'e.json'].map((target) =>
    source(target, 'CLUE_Architecture_v9.md'),
  );
  const holes = ['h1.yaml', 'h2.yaml', 'h3.yaml', 'h4.yaml', 'h5.yaml'].map((target) =>
    source(target, 'docs/architecture-decisions/ADR-0001-status-wire-schema-5-1-0.md'),
  );

  const check = missingSourcesCheck([...outside, ...holes], (target) => target.endsWith('.json'));
  assert.equal(check.level, 'warn');
  assert.ok(check.detail.includes('10 cited but never ingested'));
  assert.ok(
    check.detail.includes('5 on disk outside the corpus (a.json, b.json, c.json, …)'),
    'three examples and an ellipsis stand in for the by-design set',
  );
  assert.ok(!check.detail.includes('e.json'), 'compression is real');
  for (const hole of holes) {
    assert.ok(check.detail.includes(hole.target), `hole ${hole.target} is enumerated`);
  }
  assert.ok(
    check.detail.includes('h1.yaml ← ADR-0001-status-wire-schema-5-1-0.md'),
    'each hole names its top citer by basename',
  );
});
