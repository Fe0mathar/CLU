/** PP-37 — v10 release-candidate manifest/seal integrity and authority boundary. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const lines = (text: string): number => text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const words = (text: string): number => text.trim() === '' ? 0 : text.trim().split(/\s+/u).length;

function parseSeal(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === '') continue;
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(raw);
    assert.ok(match, `invalid v10 seal line: ${raw}`);
    const hash = match[1];
    const path = match[2];
    assert.ok(hash !== undefined && path !== undefined);
    assert.equal(result.has(path), false, `duplicate v10 seal path ${path}`);
    result.set(path, hash);
  }
  return result;
}

test('PP-37 v10 release candidate is fully sealed but explicitly not ratified', () => {
  const root = process.cwd();
  const sealPath = join(root, 'SHA256SUMS_v10.txt');
  const manifestPath = join(root, 'DOCUMENTATION_MANIFEST_v10.json');
  assert.equal(existsSync(sealPath), true);
  assert.equal(existsSync(manifestPath), true);
  const seal = parseSeal(readFileSync(sealPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly manifestVersion: string;
    readonly releaseVersion: string;
    readonly status: string;
    readonly files: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly lines: number;
      readonly words: number;
    }[];
  };
  assert.equal(manifest.manifestVersion, '3.0.0');
  assert.equal(manifest.releaseVersion, '10.0-rc1');
  assert.equal(manifest.status, 'release-candidate-not-ratified');
  assert.equal(seal.get('DOCUMENTATION_MANIFEST_v10.json'), sha256(readFileSync(manifestPath)));

  for (const item of manifest.files) {
    const absolute = join(root, ...item.path.split('/'));
    assert.equal(existsSync(absolute), true, item.path);
    const bytes = readFileSync(absolute);
    const text = bytes.toString('utf8');
    assert.equal(item.sha256, sha256(bytes), `${item.path} manifest hash`);
    assert.equal(seal.get(item.path), item.sha256, `${item.path} seal hash`);
    assert.equal(item.bytes, statSync(absolute).size, `${item.path} bytes`);
    assert.equal(item.lines, lines(text), `${item.path} lines`);
    assert.equal(item.words, words(text), `${item.path} words`);
  }
});

test('PP-37 v10 pack carries forward unchanged constitutional/methodology/catalogue bytes', () => {
  const root = process.cwd();
  const manifest = JSON.parse(readFileSync(join(root, 'DOCUMENTATION_MANIFEST_v10.json'), 'utf8')) as {
    readonly carriedForwardUnchanged: readonly { readonly path: string; readonly sha256: string }[];
  };
  for (const item of manifest.carriedForwardUnchanged) {
    assert.equal(sha256(readFileSync(join(root, ...item.path.split('/')))), item.sha256, item.path);
  }
});

test('PP-37 source supplement is preserved byte-for-byte in the release candidate', () => {
  const root = process.cwd();
  const source = readFileSync(join(root, 'docs', 'source-authority', 'CLUE_CONFIGURATION_PROJECT_PROFILES_SUPPLEMENT_2026-08-14.md'));
  const release = readFileSync(join(root, 'docs', 'project-profiles', 'CLUE_CONFIGURATION_PROJECT_PROFILES_SUPPLEMENT_2026-08-14.md'));
  assert.deepEqual(release, source);
});
