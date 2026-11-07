/**
 * CLUE Stage B acceptance suite.
 *
 * Spec: CLUE_implementation.md §21-22 (document bootstrap, claims and anchors),
 *       §24 (conflicts preserved), §26 (contracts must be falsifiable).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.2, Part V Stage B gate.
 *
 * The Stage B gate has four clauses, each with a test that fails if it stops holding:
 *
 *   1. every supplied document content-hashed and indexed → "ingestion" group
 *   2. conflicts preserved as objects, never merged        → "conflicts" group
 *   3. every claim resolves to an exact anchor             → "anchors are byte-exact…"
 *   4. missing referenced documents are visible            → "missing sources…"
 *
 * The anchor tests deserve their prominence. An anchor that is off by a few bytes still
 * looks plausible in a report and quietly points a reader at the wrong sentence, and
 * every finding, contract, and verdict downstream inherits that error without any of
 * them being wrong themselves. Non-ASCII content and CRLF line endings are the two ways
 * that happens in practice, so both are tested directly rather than assumed.
 *
 * Run: npm run selftest
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hashBytes } from '../src/shared/ids.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import {
  extractDocumentStructure,
  sliceAnchor,
  type DocumentStructure,
} from '../src/analysis/documents/markdownStructure.js';
import { extractClaims, splitSentences } from '../src/analysis/documents/claimExtractor.js';
import {
  CLAIM_PROJECTORS,
  ClaimRegistry,
  ClaimTransitionError,
  ConflictPreconditionError,
  claimContentIdFor,
  claimIdFor,
  conflictIdFor,
} from '../src/analysis/documents/claimRegistry.js';
import { TEST_SEED_PROJECTORS, TestSeedRegistry } from '../src/analysis/documents/testSeeds.js';

/* ========================================================================= */
/* Fixtures                                                                   */
/* ========================================================================= */

function encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function parse(path: string, text: string): DocumentStructure {
  const bytes = encode(text);
  return extractDocumentStructure({ path, hash: hashBytes(bytes), bytes });
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'clue-docs-'));
}

function removeRoot(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      chmodSync(join(entry.parentPath, entry.name), 0o666);
    } catch {
      // Best effort; rmSync reports whatever genuinely cannot be removed.
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

interface Stack {
  readonly claims: ClaimRegistry;
  readonly seeds: TestSeedRegistry;
  dispose(): void;
}

function openStack(root: string): Stack {
  const workspace = join(root, 'workspace');
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(workspace, directory), { recursive: true });
  }

  const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'), {
    projectors: { ...CLAIM_PROJECTORS, ...TEST_SEED_PROJECTORS },
  });
  const artifacts = new ArtifactStore(join(workspace, 'blobs'));
  const { log } = EventLog.open(join(workspace, 'events'));
  const missionVersion = (): string => 'MISSION-000001';

  return {
    claims: new ClaimRegistry({ log, projections, artifacts, missionVersion }),
    seeds: new TestSeedRegistry({ log, projections, missionVersion }),
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

/** Two documents that disagree, plus enough structure to exercise the scanner. */
const DOC_STRATEGY = [
  '# Strategy §1 — Ingestión',
  '',
  'The `shadow.root` directory must never be placed inside the canonical tree.',
  '',
  '`clean_passes` must be at least 3 before a certificate is issued.',
  '',
  'The `frame_budget` must not exceed 16 ms per frame on the reference host.',
  '',
  '```ts',
  '# not a heading',
  'const path = "Fake_Document.md";',
  '```',
  '',
  '| Setting | Value | Note |',
  '|---|---|---|',
  '| `retry_limit` | 4 | applies to probe runs |',
  '',
  '- The `probe` must restore every runtime mutation in a finally block.',
  '- Seeds will be generated in a later stage.',
  '',
  'See Items_Economy.md for the item model.',
  '',
].join('\n');

const DOC_SPEC = [
  '# Specification',
  '',
  'The `shadow.root` directory must be placed inside the canonical tree.',
  '',
  '`clean_passes` must be at least 5 before a certificate is issued.',
  '',
  'The renderer uses a modular architecture with explicit lifecycle phases.',
  '',
].join('\n');

/* ========================================================================= */
/* Structure and anchors — gate 3                                             */
/* ========================================================================= */

test('anchors are byte-exact on non-ASCII content', () => {
  const text = '# Título §1\n\nThe `renderer` must not exceed 16 ms per frame.\n';
  const bytes = encode(text);
  const structure = extractDocumentStructure({ path: 'doc.md', hash: hashBytes(bytes), bytes });

  const paragraph = structure.blocks.find((block) => block.kind === 'paragraph');
  assert.ok(paragraph !== undefined);

  // The heading contains two multi-byte characters, so a character-based offset would
  // land three bytes early — the exact failure this test exists to catch.
  const headingByteLength = Buffer.byteLength('# Título §1\n', 'utf8');
  assert.equal(paragraph.anchor.startByte, headingByteLength + 1);
  assert.equal(sliceAnchor(bytes, paragraph.anchor), 'The `renderer` must not exceed 16 ms per frame.');
});

test('anchors survive CRLF line endings', () => {
  const text = '# Heading\r\n\r\nThe `budget` must not exceed 16 ms.\r\n';
  const bytes = encode(text);
  const structure = extractDocumentStructure({ path: 'doc.md', hash: hashBytes(bytes), bytes });

  assert.equal(structure.hasCrlf, true);
  const paragraph = structure.blocks.find((block) => block.kind === 'paragraph');
  assert.ok(paragraph !== undefined);
  assert.equal(sliceAnchor(bytes, paragraph.anchor), 'The `budget` must not exceed 16 ms.');
});

test('a hash inside a fenced block is content, not a heading', () => {
  const structure = parse('strategy.md', DOC_STRATEGY);
  const headings = structure.blocks.filter((block) => block.kind === 'heading');

  assert.equal(headings.some((heading) => heading.title === 'not a heading'), false);
  const code = structure.blocks.find((block) => block.kind === 'code');
  assert.ok(code !== undefined);
  assert.equal(code.language, 'ts');
  assert.equal(code.closed, true);
});

test('pipe tables are parsed into columns and rows', () => {
  const structure = parse('strategy.md', DOC_STRATEGY);
  const table = structure.blocks.find((block) => block.kind === 'table');

  assert.ok(table !== undefined);
  assert.deepEqual([...table.columns], ['Setting', 'Value', 'Note']);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0]?.[0], '`retry_limit`');
});

test('document references exclude code blocks', () => {
  const structure = parse('strategy.md', DOC_STRATEGY);
  const targets = structure.references.map((reference) => reference.target);

  assert.ok(targets.includes('Items_Economy.md'), 'prose mention is captured');
  assert.equal(
    targets.includes('Fake_Document.md'),
    false,
    'a path inside a code sample is an illustration, not a dependency',
  );
});

test('sections nest and carry their title path', () => {
  const structure = parse('doc.md', '# Top\n\nText.\n\n## Inner\n\nMore text.\n');
  const top = structure.sections[0];

  assert.equal(top?.title, 'Top');
  assert.equal(top?.children.length, 1);
  assert.deepEqual([...(top?.children[0]?.titlePath ?? [])], ['Top', 'Inner']);
});

/* ========================================================================= */
/* Claim extraction                                                           */
/* ========================================================================= */

test('prohibitions are not misfiled as requirements', () => {
  const structure = parse('doc.md', 'The `cache` must not be shared between runs.\n');
  const claims = extractClaims(structure);

  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.modality, 'prohibition');
  assert.equal(claims[0]?.polarity, 'negative');
});

test('list items stay whole rather than fragmenting', () => {
  const structure = parse('doc.md', '- The `probe` must restore state. It runs in a finally block.\n');
  const claims = extractClaims(structure);

  assert.equal(claims.length, 1);
  assert.ok(claims[0]?.rawText.includes('finally block'));
});

test('sentence splitting protects inline code and abbreviations', () => {
  const sentences = splitSentences(
    'The root is `window.__murugan`. Feature-detect it, e.g. before use. Then proceed.',
  );

  assert.equal(sentences.length, 3);
  assert.ok(sentences[0]?.includes('`window.__murugan`'));
  assert.ok(sentences[1]?.includes('e.g. before use'));
});

test('claim identity separates the statement from the document that made it', () => {
  const sameText = 'The `shadow.root` directory must never be placed inside the canonical tree.\n';
  const first = extractClaims(parse('a.md', sameText))[0];
  const second = extractClaims(parse('b.md', sameText))[0];

  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.textKey, second.textKey, 'same statement, same textKey');
  assert.notEqual(first.fingerprint, second.fingerprint, 'different documents, different fingerprint');
});

/* ========================================================================= */
/* Ingestion — gate 1                                                         */
/* ========================================================================= */

test('documents are content-hashed and indexed, and re-ingestion is a no-op', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const bytes = encode(DOC_STRATEGY);
    const first = stack.claims.ingestDocument('strategy.md', bytes);

    assert.equal(first.unchanged, false);
    assert.equal(first.document.hash, hashBytes(bytes));
    assert.ok(first.registered.length > 0);
    assert.equal(stack.claims.getDocument(first.document.hash)?.path, 'strategy.md');

    const second = stack.claims.ingestDocument('strategy.md', bytes);
    assert.equal(second.unchanged, true);
    assert.equal(stack.claims.claims({}).length, first.registered.length);
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('a revised document supersedes its old claims instead of deleting them', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const original = stack.claims.ingestDocument('spec.md', encode(DOC_SPEC));
    const revised = stack.claims.ingestDocument(
      'spec.md',
      encode(DOC_SPEC.replace('at least 5', 'at least 7')),
    );

    assert.equal(revised.superseded.length, original.registered.length);
    assert.equal(stack.claims.claims({}).every((claim) => claim.document_hash === revised.document.hash), true);

    // The old wording is still retrievable, which is what keeps old findings auditable.
    const all = stack.claims.claims({ includeSuperseded: true });
    assert.ok(all.some((claim) => claim.raw_text.includes('at least 5')));
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('every registered claim resolves to an exact anchor', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const bytes = encode(DOC_STRATEGY);
    const result = stack.claims.ingestDocument('strategy.md', bytes);

    for (const claim of result.registered) {
      assert.equal(claim.document_hash, hashBytes(bytes));
      assert.ok(claim.start_line >= 1);
      assert.ok(claim.end_byte > claim.start_byte);
      assert.ok(claim.end_byte <= bytes.byteLength);

      const slice = sliceAnchor(bytes, {
        documentPath: claim.document_path,
        documentHash: claim.document_hash as never,
        startLine: claim.start_line,
        endLine: claim.end_line,
        startByte: claim.start_byte,
        endByte: claim.end_byte,
      });
      assert.ok(slice.length > 0, `anchor for ${claim.id} resolves to content`);
    }
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

/* ========================================================================= */
/* Conflicts — gate 2                                                         */
/* ========================================================================= */

test('opposing normative claims become a conflict, and both sides survive', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    stack.claims.ingestDocument('spec.md', encode(DOC_SPEC));

    const detected = stack.claims.detectConflicts();
    const polarity = detected.find((conflict) => conflict.kind === 'polarity');

    assert.ok(polarity !== undefined, 'the shadow.root disagreement is detected');
    assert.equal(polarity.severity, 'high', 'two normative claims in opposition is high severity');
    assert.equal(polarity.scope, 'cross-document');
    assert.equal(polarity.claim_ids.length, 2);

    // Neither claim was edited, removed, or preferred.
    for (const claimId of polarity.claim_ids) {
      const claim = stack.claims.getClaim(claimId);
      assert.ok(claim !== null);
      assert.equal(claim.superseded_at, null);
      assert.equal(claim.status, 'declared');
    }
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('claims stating different values for the same subject conflict numerically', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    stack.claims.ingestDocument('spec.md', encode(DOC_SPEC));

    const numeric = stack.claims.detectConflicts().find((conflict) => conflict.kind === 'numeric');
    assert.ok(numeric !== undefined, 'clean_passes 3 versus 5 is detected');
    assert.equal(numeric.subject_key, 'clean_passes');
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('re-detection does not duplicate conflicts, and resolution keeps the record', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    stack.claims.ingestDocument('spec.md', encode(DOC_SPEC));

    const first = stack.claims.detectConflicts();
    assert.ok(first.length > 0);

    const second = stack.claims.detectConflicts();
    assert.equal(second.length, 0, 'signatures are stable, so nothing is re-registered');
    assert.equal(stack.claims.conflicts(true).length, first.length);

    const target = first[0];
    assert.ok(target !== undefined);
    stack.claims.resolveConflict(target.id, 'misdetected', 'Unrelated statements about one subject.');

    assert.equal(stack.claims.conflicts(true).length, first.length - 1);
    const all = stack.claims.conflicts(false);
    const resolved = all.find((conflict) => conflict.id === target.id);
    assert.equal(resolved?.resolution, 'misdetected', 'a false positive stays on the record');
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('identical statements in two documents are corroboration, not conflict', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const shared = 'The `cache` must never be shared between runs.\n';
    stack.claims.ingestDocument('a.md', encode(shared));
    stack.claims.ingestDocument('b.md', encode(shared));

    assert.equal(stack.claims.detectConflicts().length, 0);
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

/* ========================================================================= */
/* Missing sources — gate 4                                                   */
/* ========================================================================= */

test('missing referenced documents are visible, and stop being missing once ingested', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const strategy = stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    const missing = stack.claims.refreshMissingSources([strategy.structure]);

    const target = missing.find((source) => source.target === 'Items_Economy.md');
    assert.ok(target !== undefined, 'a cited but un-ingested document is registered');
    assert.equal(target.citations[0]?.document_path, 'strategy.md');

    const economy = stack.claims.ingestDocument('Items_Economy.md', encode('# Items\n\nThe `item` must have an id.\n'));
    stack.claims.refreshMissingSources([strategy.structure, economy.structure]);

    assert.equal(
      stack.claims.missingSources(true).some((source) => source.target === 'Items_Economy.md'),
      false,
    );
    assert.equal(
      stack.claims.missingSources(false).some((source) => source.target === 'Items_Economy.md'),
      true,
      'the record of having been missing is kept',
    );
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

/* ========================================================================= */
/* Test seeds                                                                 */
/* ========================================================================= */

test('every emitted seed states an observation that would refute it', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const ingested = stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    const generated = stack.seeds.generate(ingested.registered);

    assert.ok(generated.seeds.length > 0, 'the corpus yields at least one testable claim');
    for (const seed of generated.seeds) {
      assert.ok(seed.falsifier.trim().length > 0, `${seed.id} has a falsifier`);
      assert.ok(seed.statement.trim().length > 0);
      assert.ok(seed.domains.length > 0);
    }
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('claims that cannot become contracts are rejected with a recorded reason', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const ingested = stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    const generated = stack.seeds.generate(ingested.registered);

    assert.ok(generated.rejections.length > 0, 'not every sentence is a contract');
    assert.ok(
      generated.rejections.some((rejection) => rejection.reason === 'plan-only'),
      '"will be generated in a later stage" states an intention, not a guarantee',
    );

    const summary = stack.seeds.rejectionSummary();
    assert.ok(Object.keys(summary).length > 0);
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('a prohibition on exceeding a value becomes an upper-bound constraint', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const ingested = stack.claims.ingestDocument(
      'budget.md',
      encode('The `frame_budget` must not exceed 16 ms per frame.\n'),
    );
    const generated = stack.seeds.generate(ingested.registered);
    const seed = generated.seeds[0];

    assert.ok(seed !== undefined);
    assert.equal(seed.kind, 'guardrail');
    // "must not exceed 16" reads as "> 16" and inverts to "<= 16". Failing to invert
    // would produce a contract asserting the opposite of what the document says.
    assert.equal(seed.measurement?.comparator, '<=');
    assert.equal(seed.measurement?.value, 16);
    assert.equal(seed.measurement?.unit, 'ms');
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('seeds survive regeneration without changing identity', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const ingested = stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    const first = stack.seeds.generate(ingested.registered);
    stack.seeds.generate(ingested.registered);

    const stored = stack.seeds.seeds({ includeAdvisory: true, limit: 200 });
    const signatures = new Set(stored.map((seed) => seed.signature));

    assert.equal(signatures.size, stored.length, 'signatures are unique');
    assert.equal(stored.length, first.seeds.length, 'regeneration upserts rather than duplicating');
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

/* ========================================================================= */
/* DEV-P1-05: content-derived identity, legal transitions, conflict gates     */
/* ========================================================================= */

const P1_05_DOC = [
  '# Renderer',
  '',
  'The renderer must not exceed 16 ms per frame.',
  '',
  'The cache must be invalidated on resize.',
  '',
].join('\n');

test('DEV-P1-05: a claim id is a function of the claim, not of how many rows exist', () => {
  const rootA = makeRoot();
  const rootB = makeRoot();
  const a = openStack(rootA);
  const b = openStack(rootB);
  try {
    // Two independent workspaces ingest the same bytes. Under MAX(id)+1 the ids depended on table
    // contents; a finding citing a claim in one workspace did not resolve in the other.
    const bytes = new TextEncoder().encode(P1_05_DOC);

    // Give workspace B a different amount of prior content, so any counter would diverge.
    b.claims.ingestDocument('other.md', new TextEncoder().encode('# Other\n\nThe log must be append-only.\n'));

    const first = a.claims.ingestDocument('spec.md', bytes);
    const second = b.claims.ingestDocument('spec.md', bytes);

    assert.ok(first.registered.length > 0, 'the document produced claims');
    assert.deepEqual(
      first.registered.map((claim) => claim.id).sort(),
      second.registered.map((claim) => claim.id).sort(),
      'identical content yields identical claim ids in an unrelated workspace',
    );

    // The id is derived from the claim's own content identity.
    for (const claim of first.registered) {
      assert.equal(claim.id, claimIdFor(claim.fingerprint, claim.document_hash));
      assert.match(claim.id, /^CLAIM-[0-9]{6,}$/, 'still a canonical CLUE entity id');
    }
  } finally {
    a.dispose();
    b.dispose();
    removeRoot(rootA);
    removeRoot(rootB);
  }
});

test('DEV-P1-05: status promotion refuses demotion, unevidenced moves and superseded claims', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const ingested = stack.claims.ingestDocument('spec.md', new TextEncoder().encode(P1_05_DOC));
    const claim = ingested.registered[0];
    assert.ok(claim);
    assert.equal(claim.status, 'declared');

    // A promotion must cite evidence.
    assert.throws(
      () => stack.claims.promoteStatus(claim.id, 'source-confirmed', '   '),
      (error: unknown) => error instanceof ClaimTransitionError,
    );

    // The legal ladder: declared -> source-confirmed -> runtime-observed.
    stack.claims.promoteStatus(claim.id, 'source-confirmed', 'src/renderer.ts#draw');
    assert.equal(stack.claims.getClaim(claim.id)?.status, 'source-confirmed');

    // Demotion discards the evidence that justified the current status, so it is refused.
    assert.throws(
      () => stack.claims.promoteStatus(claim.id, 'declared', 'because I said so'),
      (error: unknown) => error instanceof ClaimTransitionError,
    );

    stack.claims.promoteStatus(claim.id, 'runtime-observed', 'trace-2026-08-06');
    assert.equal(stack.claims.getClaim(claim.id)?.status, 'runtime-observed');

    // contradicted is terminal for promotion: that standing belongs to the conflict object.
    stack.claims.promoteStatus(claim.id, 'contradicted', 'CONFLICT evidence');
    assert.throws(
      () => stack.claims.promoteStatus(claim.id, 'runtime-observed', 'trace-again'),
      (error: unknown) => error instanceof ClaimTransitionError,
    );

    // A superseded claim's wording no longer exists to be confirmed.
    const other = ingested.registered[1];
    assert.ok(other);
    stack.claims.ingestDocument('spec.md', new TextEncoder().encode(`${P1_05_DOC}\nThe cache must be warm.\n`));
    const superseded = stack.claims.getClaim(other.id);
    assert.ok(superseded?.superseded_at !== null, 'the revision superseded the old claim');
    assert.throws(
      () => stack.claims.promoteStatus(other.id, 'source-confirmed', 'src/cache.ts'),
      (error: unknown) => error instanceof ClaimTransitionError,
    );
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('DEV-P1-05: resolving a conflict requires a real, still-open conflict and a reason', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    // Reuse the fixture the existing polarity test relies on, so this proof exercises a real
    // detected conflict rather than one contrived for the assertion.
    stack.claims.ingestDocument('strategy.md', encode(DOC_STRATEGY));
    stack.claims.ingestDocument('spec.md', encode(DOC_SPEC));

    const conflict = stack.claims.detectConflicts().find((entry) => entry.kind === 'polarity');
    assert.ok(conflict, 'the opposing claims produced a conflict');

    // The id is derived from the conflict's signature.
    assert.equal(conflict.id, conflictIdFor(conflict.signature));

    // An unknown id used to record a resolution for a conflict that does not exist.
    assert.throws(
      () => stack.claims.resolveConflict('CONFLICT-000000', 'both-valid', 'reason'),
      (error: unknown) => error instanceof ConflictPreconditionError,
    );

    // A resolution must say why.
    assert.throws(
      () => stack.claims.resolveConflict(conflict.id, 'both-valid', '  '),
      (error: unknown) => error instanceof ConflictPreconditionError,
    );

    stack.claims.resolveConflict(conflict.id, 'both-valid', 'the two documents scope different modes');
    assert.equal(stack.claims.getConflict(conflict.id)?.resolution, 'both-valid');

    // Re-resolving would silently overwrite a decision someone already reasoned about.
    assert.throws(
      () => stack.claims.resolveConflict(conflict.id, 'misdetected', 'changed my mind'),
      (error: unknown) => error instanceof ConflictPreconditionError,
    );
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('DEV-P1-05: content identity is separate from location identity', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const sentence = 'The renderer must not exceed 16 ms per frame.';
    const a = stack.claims.ingestDocument('a.md', encode(`# A\n\n${sentence}\n`));
    const b = stack.claims.ingestDocument('b.md', encode(`# B\n\nSome preamble.\n\n${sentence}\n`));

    const left = a.registered.find((claim) => claim.text.includes('16 ms'));
    const right = b.registered.find((claim) => claim.text.includes('16 ms'));
    assert.ok(left && right);

    // Same assertion, two places: one content identity, two anchored identities.
    assert.equal(left.content_id, right.content_id, 'the same statement shares a content id');
    assert.notEqual(left.id, right.id, 'each occurrence keeps its own anchored id');
    assert.equal(left.content_id, claimContentIdFor(left.text_key));
    // The fingerprint is location-bearing (path + text), which is exactly why it cannot be the
    // content identity: the two occurrences have different fingerprints but one content id.
    assert.notEqual(left.fingerprint, right.fingerprint);
    assert.equal(left.text_key, right.text_key);

    // Location differs and never enters the content id.
    assert.notEqual(left.document_path, right.document_path);
    assert.notEqual(left.start_line, right.start_line);

    const occurrences = stack.claims.claimsByContent(left.content_id);
    assert.equal(occurrences.length, 2, 'both occurrences resolve from the content id');
    assert.deepEqual(
      occurrences.map((claim) => claim.document_path).sort(),
      ['a.md', 'b.md'],
    );
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});

test('DEV-P1-05: domains and subjects are queryable rows, not JSON inside a column', () => {
  const root = makeRoot();
  const stack = openStack(root);
  try {
    const ingested = stack.claims.ingestDocument('spec.md', encode(DOC_SPEC));
    const claim = ingested.registered[0];
    assert.ok(claim);
    assert.ok(claim.domains.length > 0, 'the claim carries at least one domain');

    // Every domain on the record has a matching normalized row, and the join finds the claim.
    for (const domain of claim.domains) {
      assert.ok(
        stack.claims.claimIdsInDomain(domain).includes(claim.id),
        `claim is reachable through domain ${domain}`,
      );
    }
    for (const subject of claim.subjects) {
      assert.ok(
        stack.claims.claimIdsAboutSubject(subject).includes(claim.id),
        `claim is reachable through subject ${subject}`,
      );
    }

    // A domain the claim does not carry must not resolve to it: the rows are exact, not a superset.
    assert.ok(
      !stack.claims.claimIdsInDomain('a-domain-no-claim-declares').includes(claim.id),
      'the normalized table does not over-report membership',
    );

    // Re-ingesting the same document replays the projector; membership stays exact rather than
    // accumulating duplicate rows.
    stack.claims.ingestDocument('spec.md', encode(DOC_SPEC));
    for (const domain of claim.domains) {
      const ids = stack.claims.claimIdsInDomain(domain);
      assert.equal(
        ids.filter((id) => id === claim.id).length,
        1,
        'a re-ingest leaves exactly one membership row, not a duplicate',
      );
    }
  } finally {
    stack.dispose();
    removeRoot(root);
  }
});
