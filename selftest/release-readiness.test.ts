import assert from 'node:assert/strict';
import { test } from 'node:test';

const modulePath = new URL('../../tools/release-readiness.mjs', import.meta.url).href;
const { assessNativeProofIntegration, nativeProofTapCoverage, readTapCounts } = await import(modulePath);

const completeTap = [
  'TAP version 13',
  'ok 1 - fixture',
  '# tests 2',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 1',
  '# todo 0',
  '',
].join('\r\n');

test('release self-test accounting rejects absent, empty, conflicting or incomplete TAP summaries', () => {
  assert.deepEqual(readTapCounts(completeTap), { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.equal(readTapCounts('ℹ pass 2'), null);
  assert.equal(readTapCounts(completeTap.replace('# tests 2', '# tests 0')), null);
  assert.equal(readTapCounts(completeTap.replace('# pass 1', '# pass 2')), null);
  assert.equal(readTapCounts(`${completeTap}# tests 2\n`), null);
  assert.equal(readTapCounts(completeTap.replace('# skipped 1', '')), null);
});

test('a Windows proof gate requires the pinned supervisor and each named integration case to execute', () => {
  const files = [
    ['proof-cli.test.js', 'ok 1 - DEV-P2-11 CLI: real command records ACCEPT, other details'],
    ['proof.test.js', 'ok 1 - proof §12–§13: the coordinator collects on a real tree\nok 2 - proof arm: the durable chain'],
    ['self-target-proof-relocation.test.js', 'ok 1 - P2-CLOSURE-02: self-target proof'],
    ['windows-execution-supervisor.test.js', 'ok 1 - native Windows supervisor resolves only the exact pinned file'],
  ].map(([file, tap]) => ({ file, proofTests: nativeProofTapCoverage(file, tap) }));
  const pin = { kind: 'windows-supervisor', sha256: 'a'.repeat(64) };
  const qualified = assessNativeProofIntegration('win32', pin, files);
  assert.equal(qualified.pass, true);
  assert.equal(qualified.operatorQualification, 'SEPARATE_NATIVE_HOST_CHECK_REQUIRED');
  assert.equal(assessNativeProofIntegration('linux', pin, files).state, 'WINDOWS_REQUIRED');
  assert.equal(assessNativeProofIntegration('win32', null, files).pass, false);
  assert.equal(assessNativeProofIntegration('win32', { ...pin, sha256: 'wrong' }, files).pass, false);
  assert.equal(assessNativeProofIntegration('win32', pin, files.slice(1)).pass, false);
  const skipped = nativeProofTapCoverage('proof-cli.test.js',
    'ok 7 - DEV-P2-11 CLI: real command records ACCEPT, other details # SKIP No native supervisor');
  assert.deepEqual(skipped, [{ id: 'governed-proof-command', state: 'NOT_EXECUTED' }]);
  assert.equal(assessNativeProofIntegration('win32', pin, [
    { file: 'proof-cli.test.js', proofTests: skipped }, ...files.slice(1),
  ]).pass, false);
});
