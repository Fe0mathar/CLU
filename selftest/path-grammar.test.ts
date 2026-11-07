/**
 * DEV-P1-41 / DEV-P1-42 — the path grammar in `schemas.ts`, tested where it is decided.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §22 — the four operating zones and what may be written
 *       where. Every one of those judgements is a path comparison, and every path comparison in
 *       this system funnels through `normaliseSegments`.
 *       `CLUE_Architecture_v9.md` — the config is validated before anything opens.
 *
 * Backlog: DEV-P1-41 — `absolutePathForm` was extracted so `control/runtime.ts` would stop
 *          carrying a second copy of this grammar. The classification *decision* is guarded by
 *          `config-path-portability.test.ts`, which fails when a drive path stops being treated
 *          as absolute. The **form label** is not: a drive path mislabelled `posix-root` is still
 *          refused, only with the wrong wording, so no caller-level test can see it.
 *
 *          DEV-P1-42 — `relativePathSchema`'s rejection of absolute paths had **no test at all**.
 *          Found by neutralising `isAbsolutePath` to always return `false`, rebuilding, and
 *          running the entire suite: 430 pass, 0 fail. That refinement is the only reason a
 *          Windows path in `source_roots` is refused on a POSIX host — the mechanism cited when
 *          DEV-P1-35 concluded those keys needed no further treatment. The conclusion was right
 *          and rested on something nothing checked.
 *
 * ## Why here rather than through a caller
 *
 * A caller can only observe the consequences it happens to depend on. `resolveConfigPaths` needs
 * to know *that* a path is absolute elsewhere; it renders the form into prose, and its tests
 * deliberately do not assert prose — pinning wording turns a behavioural guard into a change
 * detector. So the label has no caller that can guard it, and the only honest place to check it
 * is against the function.
 *
 * The same argument applies to `relativePathSchema`. Its absolute-rejection is load-bearing for
 * three config keys and one whole class of defect, and it was invisible to 435 tests because
 * every one of them supplies paths that are already valid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  absolutePathForm,
  relativePathSchema,
  type AbsolutePathForm,
} from '../src/shared/schemas.js';

/* ------------------------------------------------------------------------- */
/* DEV-P1-41 — classification                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The full table, including the cases that decide the boundaries rather than the middle.
 *
 * `F:relative` is the one worth reading twice. `normaliseSegments` requires a separator or the end
 * of the string after a drive, which matches Windows' own drive-relative semantics: `F:src` means
 * "src, relative to the current directory on drive F", not "the root of F". Classifying it
 * absolute would make CLU-E refuse a path Windows itself treats as relative — over-reach in the
 * name of caution, which is still wrong.
 */
const CLASSIFICATION: ReadonlyArray<readonly [string, AbsolutePathForm | null]> = [
  // Windows drive letters, both separators, with and without a trailing path.
  ['F:/CLU/workspace', 'windows-drive'],
  ['F:\\CLU\\workspace', 'windows-drive'],
  ['F:/', 'windows-drive'],
  ['F:', 'windows-drive'],
  ['c:/lower/case/drive', 'windows-drive'],

  // UNC and root-relative.
  ['\\\\build-01\\clue\\workspace', 'windows-unc'],
  ['\\CLU\\workspace', 'windows-rooted'],

  // POSIX.
  ['/etc/clue', 'posix-root'],
  ['/', 'posix-root'],

  // Relative under every platform's rules.
  ['src', null],
  ['./src', null],
  ['../sibling', null],
  ['config/policies/patching.yaml', null],

  // Boundaries.
  ['F:relative', null], // drive-relative on Windows too; see above
  ['run:2026-08-07', null], // a colon that is not a drive letter
  ['workspace/run:2026-08-07', null], // and one that is not even leading
  ['1:/not/a/drive', null], // drives are letters
];

test('DEV-P1-41: absolutePathForm classifies every form, including the boundaries', () => {
  for (const [value, expected] of CLASSIFICATION) {
    assert.equal(
      absolutePathForm(value),
      expected,
      `${JSON.stringify(value)} should classify as ${String(expected)}`,
    );
  }
});

test('DEV-P1-41: classification does not depend on the running platform', () => {
  // The whole point of extracting this. `node:path`'s `isAbsolute` gives a different answer for
  // the same string on Linux and Windows; this function must not. It is asserted by construction
  // rather than by running twice — the implementation consults `normaliseSegments` and inspects
  // the raw string, and touches nothing host-derived — so what is checked here is that the answers
  // are the ones a Windows host would also give.
  assert.equal(absolutePathForm('F:/CLU'), 'windows-drive', 'a drive path is absolute anywhere');
  assert.equal(absolutePathForm('/etc'), 'posix-root', 'a rooted path is absolute anywhere');
  assert.equal(absolutePathForm('src'), null, 'a relative path is relative anywhere');
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-42 — relativePathSchema                                             */
/* ------------------------------------------------------------------------- */

test('DEV-P1-42: relativePathSchema rejects every absolute form', () => {
  // This is what keeps a Windows path out of `source_roots`, `document_roots`,
  // `constitution.file` and `constitution.tracked_documents` on a POSIX host. Those four keys
  // were excluded from DEV-P1-35's treatment precisely because this refinement covers them.
  for (const [value, form] of CLASSIFICATION) {
    if (form === null) continue;
    const result = relativePathSchema.safeParse(value);
    assert.equal(
      result.success,
      false,
      `${JSON.stringify(value)} is absolute (${form}) and must not pass as a relative path`,
    );
  }
});

test('DEV-P1-42: relativePathSchema accepts ordinary relative paths', () => {
  // The control. Without it, the rejection above would also pass against a schema that refused
  // everything — and a config schema that refuses every path fails loudly enough that nobody
  // would ship it, but the test would have proved nothing either way.
  for (const value of ['src', './src', 'config/policies/patching.yaml', 'docs/adr/0001.md']) {
    const result = relativePathSchema.safeParse(value);
    assert.equal(result.success, true, `${JSON.stringify(value)} should be a valid relative path`);
  }
});

test('DEV-P1-42: relativePathSchema still rejects traversal above its base', () => {
  // The other half of the refinement, and it has to stay working while the absolute half is
  // guarded — a fix to one that quietly disabled the other would otherwise land green.
  for (const value of ['../up', '../../way/up', 'inside/../../out']) {
    assert.equal(
      relativePathSchema.safeParse(value).success,
      false,
      `${JSON.stringify(value)} escapes its base`,
    );
  }

  // A `..` that resolves back inside is fine: the check is about where a path lands, not how it
  // is spelled.
  assert.equal(relativePathSchema.safeParse('src/analysis/../source').success, true);
});

test('DEV-P1-42: an empty path is refused before either refinement', () => {
  // `pathSchema` and `relativePathSchema` both require a non-empty string. An empty path resolves
  // to the base itself, which would silently widen a source root to the whole project.
  assert.equal(relativePathSchema.safeParse('').success, false);
});
