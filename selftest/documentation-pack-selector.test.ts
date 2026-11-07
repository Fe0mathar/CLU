/** Batch 8 — documentation-pack selection is explicit, safe and version-neutral. */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DOCUMENTATION_PACK_SELECTOR_PATH,
  DocumentationPackSelectorError,
  LEGACY_DOCUMENTATION_PACK,
  resolveDocumentationPack,
  validateDocumentationPackSelector,
} from '../src/control/documentationPack.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

test('Batch 8: missing selector preserves the historical v9 authority instead of guessing v10', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const pack = resolveDocumentationPack(fixture.root);
  assert.equal(pack.source, 'legacy-default');
  assert.equal(pack.releaseName, LEGACY_DOCUMENTATION_PACK.releaseName);
  assert.equal(pack.sealFile, 'SHA256SUMS_v9.txt');
  assert.equal(pack.manifestFile, 'DOCUMENTATION_MANIFEST_v9.json');
});

test('Batch 8: one selector changes seal and manifest identity atomically', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const selector = join(fixture.root, ...DOCUMENTATION_PACK_SELECTOR_PATH.split('/'));
  mkdirSync(join(fixture.root, 'config'), { recursive: true });
  writeFileSync(
    selector,
    `${JSON.stringify({
      schemaVersion: 'clue-documentation-pack-selector/1',
      releaseName: 'CLU-E RPI Documentation Pack v10',
      releaseVersion: '10.0',
      sealFile: 'SHA256SUMS_v10.txt',
      manifestFile: 'DOCUMENTATION_MANIFEST_v10.json',
      installHint: 'apply the governed v10 pack',
    }, null, 2)}\n`,
    'utf8',
  );
  const pack = resolveDocumentationPack(fixture.root);
  assert.equal(pack.source, 'selector');
  assert.equal(pack.releaseVersion, '10.0');
  assert.equal(pack.sealFile, 'SHA256SUMS_v10.txt');
  assert.equal(pack.manifestFile, 'DOCUMENTATION_MANIFEST_v10.json');
});

test('Batch 8: selector refuses traversal, absolute paths, unknown keys and same seal/manifest file', () => {
  const base = {
    schemaVersion: 'clue-documentation-pack-selector/1',
    releaseName: 'Pack',
    releaseVersion: '1',
    sealFile: 'SHA256SUMS.txt',
    manifestFile: 'MANIFEST.json',
    installHint: 'install it',
  };
  assert.throws(
    () => validateDocumentationPackSelector({ ...base, sealFile: '../SHA256SUMS.txt' }),
    DocumentationPackSelectorError,
  );
  assert.throws(
    () => validateDocumentationPackSelector({ ...base, manifestFile: 'C:/MANIFEST.json' }),
    DocumentationPackSelectorError,
  );
  assert.throws(
    () => validateDocumentationPackSelector({ ...base, unexpected: true }),
    DocumentationPackSelectorError,
  );
  assert.throws(
    () => validateDocumentationPackSelector({ ...base, manifestFile: 'SHA256SUMS.txt' }),
    /must be different/u,
  );
});
