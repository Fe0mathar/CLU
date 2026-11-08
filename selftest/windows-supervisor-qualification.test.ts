import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  captureWindowsQualificationHost,
  requireWindowsSupervisorQualification,
  verifyWindowsSupervisorQualificationReceipt,
  WINDOWS_SUPERVISOR_QUALIFICATION_CASES,
  WINDOWS_SUPERVISOR_QUALIFICATION_SCHEMA,
  windowsSupervisorPathSha256,
} from '../src/benchmark/windowsSupervisorQualification.js';
import { hashBytes } from '../src/shared/ids.js';

const digest = (value: string) => hashBytes(Buffer.from(value));
const supervisor = {
  command: 'C:\\approved\\clue-supervisor.exe',
  argsPrefix: ['--request-file'],
  sha256: digest('fixture supervisor'),
};
const host = {
  hostnameSha256: digest('fixture host'),
  principalSha256: digest('fixture user'),
  platform: 'win32',
  arch: 'x64',
  osRelease: 'fixture release',
  osVersion: 'fixture OS',
  nodeVersion: 'v22.16.0',
  nodeSha256: digest('fixture node'),
};

function fixture() {
  return {
    schemaVersion: WINDOWS_SUPERVISOR_QUALIFICATION_SCHEMA,
    qualificationScope: 'PRODUCTION_PROOF',
    proofAuthorization: true,
    checkedAt: '2026-11-07T18:00:00.000Z',
    supervisorSha256: supervisor.sha256,
    supervisorPathSha256: windowsSupervisorPathSha256(supervisor.command),
    canaryStatus: 'PASS',
    status: 'MEASUREMENT_PENDING',
    fixtureRemoved: true,
    host,
    cases: Object.fromEntries([
      ...WINDOWS_SUPERVISOR_QUALIFICATION_CASES.map((name) => [name, 'PASS']),
      ['measurement-parity', 'NOT_EXECUTED'],
    ]),
  };
}

test('Windows production qualification requires all admission cases and allows later measurement parity', () => {
  const receipt = fixture();
  assert.equal(receipt.schemaVersion, 'clue-windows-supervisor-production-qualification/2');
  assert.ok(WINDOWS_SUPERVISOR_QUALIFICATION_CASES.includes('production-request-admission'));
  assert.ok(WINDOWS_SUPERVISOR_QUALIFICATION_CASES.includes('network-boundary-fault'));
  assert.doesNotThrow(() => verifyWindowsSupervisorQualificationReceipt(receipt, supervisor, host));
  for (const name of WINDOWS_SUPERVISOR_QUALIFICATION_CASES) {
    assert.throws(() => verifyWindowsSupervisorQualificationReceipt({
      ...receipt, cases: { ...receipt.cases, [name]: 'NOT_EXECUTED' },
    }, supervisor, host), /all mandatory pre-proof canaries/);
  }
  assert.throws(() => verifyWindowsSupervisorQualificationReceipt({ ...receipt, canaryStatus: 'FAIL' }, supervisor, host),
    /all mandatory pre-proof canaries/);
  assert.throws(() => verifyWindowsSupervisorQualificationReceipt({ ...receipt, fixtureRemoved: false }, supervisor, host),
    /all mandatory pre-proof canaries/);
});

test('Passing Windows fixture diagnostics cannot authorize production proof', () => {
  const legacy = {
    ...fixture(),
    schemaVersion: 'clue-console-probe-native-supervisor/1',
    cases: {
      'allowed-command': 'PASS',
      'filesystem-denied': 'PASS',
      'secrets-denied': 'PASS',
      'network-denied': 'PASS',
      'descendant-timeout': 'PASS',
      'launcher-cancellation': 'PASS',
      'tamper-refused': 'PASS',
      'measurement-parity': 'NOT_EXECUTED',
    },
  };
  for (const receipt of [
    legacy,
    { ...legacy, qualificationScope: undefined, proofAuthorization: undefined },
    {
      schemaVersion: 'clue-mxc-supervisor-diagnostic/1',
      proofAuthorization: false,
      canaryReport: legacy,
    },
    { ...fixture(), proofAuthorization: false },
  ]) {
    assert.throws(() => verifyWindowsSupervisorQualificationReceipt(receipt, supervisor, host),
      /diagnostic.*cannot authorize/i);
  }
});

test('Windows production qualification needs explicit scope and authorization', () => {
  const receipt = fixture();
  for (const changed of [
    { ...receipt, qualificationScope: undefined },
    { ...receipt, qualificationScope: 'FIXTURE_ONLY' },
    { ...receipt, proofAuthorization: undefined },
    { ...receipt, proofAuthorization: 'true' },
  ]) {
    assert.throws(() => verifyWindowsSupervisorQualificationReceipt(changed, supervisor, host),
      /explicit production authorization/i);
  }
  assert.throws(() => verifyWindowsSupervisorQualificationReceipt({ ...receipt, schemaVersion: 'unknown' }, supervisor, host),
    /receipt is malformed/i);
});

test('Windows qualification refuses stale binary, installed path, OS, account and Node identities', () => {
  const receipt = fixture();
  for (const changed of [{ ...supervisor, sha256: digest('new binary') }, { ...supervisor, command: 'C:\\other\\supervisor.exe' }]) {
    assert.throws(() => verifyWindowsSupervisorQualificationReceipt(receipt, changed, host), /installed executable and pin/);
  }
  for (const changed of [
    { ...host, hostnameSha256: digest('new host') },
    { ...host, principalSha256: digest('new account') },
    { ...host, osRelease: 'new OS' },
    { ...host, nodeSha256: digest('new node') },
  ]) {
    assert.throws(() => verifyWindowsSupervisorQualificationReceipt(receipt, supervisor, changed), /current host, account and Node/);
  }
});

test('Windows qualification rejects missing pins and noncanonical receipt paths before file IO', () => {
  assert.throws(() => requireWindowsSupervisorQualification(supervisor, {}), /execution refused/);
  assert.throws(() => requireWindowsSupervisorQualification(supervisor, {
    CLU_WINDOWS_SUPERVISOR_QUALIFICATION: 'relative.json',
    CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256: digest('receipt'),
  }), /canonical local/);
  assert.throws(() => requireWindowsSupervisorQualification(supervisor, {
    CLU_WINDOWS_SUPERVISOR_QUALIFICATION: 'C:\\evidence\\receipt.json',
    CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256: 'A'.repeat(64),
  }), /lowercase SHA-256/);
});

test('Windows qualification binds the exact external receipt bytes', { skip: process.platform !== 'win32' }, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'clue-qualification-receipt-')));
  try {
    const path = join(root, 'qualification.json');
    const bytes = JSON.stringify({ ...fixture(), host: captureWindowsQualificationHost() });
    const receiptPin = digest(bytes);
    writeFileSync(path, bytes, { flag: 'wx' });
    const environment = {
      CLU_WINDOWS_SUPERVISOR_QUALIFICATION: path,
      CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256: receiptPin,
    };
    assert.equal(requireWindowsSupervisorQualification(supervisor, environment), receiptPin);
    assert.throws(() => requireWindowsSupervisorQualification(supervisor, environment, [root]), /outside the execution roots/);
    writeFileSync(path, `${bytes}\n`);
    assert.throws(() => requireWindowsSupervisorQualification(supervisor, environment), /does not match its SHA-256 pin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
