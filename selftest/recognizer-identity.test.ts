/**
 * DEV-P0-03 — recognizer identity-v4 and exact basis binding.
 *
 * identity-v4 separates stable implementation-symbol identities from declaration-contract
 * identities. Declaration kind, namespaces, overload signatures, anonymous structural context and
 * TypeScript merge semantics are encoded unconditionally, so adding/removing a sibling cannot rename
 * an unchanged declaration. Calls use the compiler-selected signature rather than declarations[0].
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  recognize,
  RECOGNITION_IDENTITY_ALGORITHM,
  RECOGNIZER_VERSION,
  type RecognitionResult,
} from '../src/analysis/source/recognizer.js';
import { hashText } from '../src/shared/ids.js';

function makeProject(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-rec-id-'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'node',
        skipLibCheck: true,
      },
      include: ['**/*.ts'],
    }),
  );
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const cfg = (root: string): string => join(root, 'tsconfig.json');
const idsNamed = (result: RecognitionResult, name: string): string[] =>
  result.units.filter((unit) => unit.name === name).map((unit) => unit.logicalId);

function recogniseProject(files: Readonly<Record<string, string>>): RecognitionResult {
  const root = makeProject(files);
  try {
    return recognize({ projectRoot: root, tsconfigPath: cfg(root) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('full tree: every unit id is unique and every internal endpoint resolves', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tsconfigPath = join(repoRoot, 'tsconfig.json');
  assert.ok(existsSync(tsconfigPath), 'the repository acceptance fixture includes a root tsconfig');

  const full = recognize({ projectRoot: repoRoot, tsconfigPath });
  const unitIds = new Set(full.units.map((unit) => unit.logicalId));
  assert.equal(unitIds.size, full.units.length, 'every unit has a unique logical id');
  const dangling = full.edges.filter((edge) => !edge.external && !unitIds.has(edge.to));
  assert.equal(dangling.length, 0, 'every non-external edge resolves to a recognised unit');
  assert.equal(full.basis.identityAlgorithm, RECOGNITION_IDENTITY_ALGORITHM);
  assert.equal(full.basis.identityAlgorithm, 'identity-v4');
});

test('declaration kind is part of identity even when one declaration replaces another', () => {
  const fn = recogniseProject({ 'x.ts': 'export function Thing(): void {}\n' });
  const klass = recogniseProject({ 'x.ts': 'export class Thing {}\n' });
  assert.notEqual(idsNamed(fn, 'Thing')[0], idsNamed(klass, 'Thing')[0]);
  assert.equal(idsNamed(fn, 'Thing')[0], 'x.ts#Thing', 'a concrete function keeps the stable symbol spelling');
  assert.match(idsNamed(klass, 'Thing')[0] ?? '', /\$class$/);
});

test('inserting an unrelated overload does not rename existing overload identities', () => {
  const before = recogniseProject({
    'api.ts': 'export interface Api {\n  of(x: number): void;\n  of(x: string): void;\n  of(x: boolean): void;\n}\n',
  });
  const after = recogniseProject({
    'api.ts':
      'export interface Api {\n  of(x: Date): void;\n  of(x: number): void;\n  of(x: string): void;\n  of(x: boolean): void;\n}\n',
  });
  const ofBefore = idsNamed(before, 'of');
  const ofAfter = idsNamed(after, 'of');
  assert.equal(new Set(ofBefore).size, 3);
  for (const id of ofBefore) assert.ok(ofAfter.includes(id), `existing overload ${id} is stable`);
  assert.equal(ofAfter.length, ofBefore.length + 1);
});

test('an overload retains its identity when the overload set shrinks to one declaration', () => {
  const before = recogniseProject({
    'api.ts': 'export interface Api { of(x: number): void; of(x: string): void; }\n',
  });
  const after = recogniseProject({ 'api.ts': 'export interface Api { of(x: number): void; }\n' });
  const numberId = idsNamed(after, 'of')[0];
  assert.ok(numberId !== undefined);
  assert.ok(idsNamed(before, 'of').includes(numberId), 'the surviving contract keeps its id');
});

test('same-shaped union members keep their identities when another branch is inserted', () => {
  const before = recogniseProject({
    'state.ts': "export type State = | { kind: 'a'; phase: number } | { kind: 'b'; phase: number };\n",
  });
  const after = recogniseProject({
    'state.ts':
      "export type State = | { kind: 'z'; phase: number } | { kind: 'a'; phase: number } | { kind: 'b'; phase: number };\n",
  });

  const phasesBefore = idsNamed(before, 'phase');
  const phasesAfter = idsNamed(after, 'phase');
  const kindsBefore = idsNamed(before, 'kind');
  const kindsAfter = idsNamed(after, 'kind');
  assert.equal(new Set(phasesBefore).size, 2);
  assert.equal(new Set(kindsBefore).size, 2);
  for (const id of [...phasesBefore, ...kindsBefore]) {
    assert.ok([...phasesAfter, ...kindsAfter].includes(id), `existing anonymous-member id ${id} is stable`);
  }
});

test('merged interfaces are one stable semantic unit and their existing children survive a new fragment', () => {
  const before = recogniseProject({
    'x.ts': 'export interface A { a: number }\nexport interface A { b: string }\n',
  });
  const after = recogniseProject({
    'x.ts':
      'export interface A { z: boolean }\nexport interface A { a: number }\nexport interface A { b: string }\n',
  });

  assert.deepEqual(idsNamed(before, 'A'), ['x.ts#A$interface']);
  assert.deepEqual(idsNamed(after, 'A'), ['x.ts#A$interface']);
  for (const name of ['a', 'b']) {
    assert.deepEqual(idsNamed(after, name), idsNamed(before, name), `${name} keeps its identity`);
  }
});

test('outer generic type-parameter renaming is identity-neutral', () => {
  const before = recogniseProject({ 'x.ts': 'export interface A<T> { of(x: T): T }\n' });
  const after = recogniseProject({ 'x.ts': 'export interface A<Value> { of(x: Value): Value }\n' });
  assert.deepEqual(idsNamed(before, 'of'), idsNamed(after, 'of'));
});

test('calls resolve to the compiler-selected overload declaration', () => {
  const result = recogniseProject({
    'x.ts':
      'export function f(x: number): number;\n' +
      'export function f(x: string): string;\n' +
      'export function f(x: number | string): number | string { return x; }\n' +
      'export const n = f(1);\n' +
      "export const s = f('x');\n",
  });

  const calls = result.edges.filter((edge) => edge.kind === 'calls');
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map((edge) => edge.to)).size, 2, 'the two calls target different overloads');
  assert.ok(calls.every((edge) => edge.confidence === 1), 'resolved signatures are authoritative');
  assert.equal(result.unresolved.filter((entry) => entry.kind === 'symbol-ambiguous').length, 0);
});

test('namespaces contribute stable lexical identity', () => {
  const result = recogniseProject({
    'x.ts':
      'export namespace A { export function run(): void {} }\n' +
      'export namespace B { export function run(): void {} }\n',
  });
  const runs = idsNamed(result, 'run');
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs).size, 2);
  assert.ok(runs.some((id) => id.includes('namespace:A')));
  assert.ok(runs.some((id) => id.includes('namespace:B')));
});

test('reformatting and moving unrelated declarations do not change unaffected identities', () => {
  const plain = recogniseProject({
    'x.ts':
      'export interface Api {\n  of(x: number): void;\n  of(x: string): void;\n}\nexport function unrelated(a: number): number { return a; }\n',
  });
  const reformatted = recogniseProject({
    'x.ts':
      'export interface Api {\n  of(x:number)    :    void;   // reformatted + comment\n  of(x: string): void;\n}\n\n\n\nexport function unrelated(a: number): number {\n      return a;\n}\n',
  });
  assert.deepEqual(idsNamed(plain, 'of').sort(), idsNamed(reformatted, 'of').sort());
  assert.equal(idsNamed(plain, 'unrelated')[0], idsNamed(reformatted, 'unrelated')[0]);
});

test('the basis declares the exact identity grammar, snapshot, capture and toolchain', () => {
  const root = makeProject({ 'x.ts': 'export const a = 1;\n' });
  try {
    const lock = hashText('lockfile-bytes');
    const bound = recognize({
      projectRoot: root,
      tsconfigPath: cfg(root),
      snapshotId: 'snap-abc',
      captureId: 'cap-xyz',
      lockfileHash: lock,
    });
    assert.equal(bound.basis.snapshotId, 'snap-abc');
    assert.equal(bound.basis.captureId, 'cap-xyz');
    assert.equal(bound.basis.lockfileHash, lock);
    assert.equal(bound.basis.identityAlgorithm, 'identity-v4');
    assert.equal(bound.basis.recognizerVersion, 'clue-recognizer/4');
    assert.equal(RECOGNIZER_VERSION, 'clue-recognizer/4');
    assert.ok(bound.basis.tsCompilerVersion.length > 0);
    assert.match(bound.basis.tsconfigHash, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});