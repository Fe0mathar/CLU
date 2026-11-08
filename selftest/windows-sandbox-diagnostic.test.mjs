import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWindowsSandboxInventory, parseWindowsSandboxStartId } from '../tools/windows-supervisor/windowsSandboxCli.mjs';
import { buildWindowsSandboxConfiguration } from '../tools/windows-supervisor/windowsSandboxConfiguration.mjs';
import { privateProbeAddresses } from '../tools/windows-supervisor/windowsSandboxHostEndpoint.mjs';
import { exerciseWindowsSandboxSession } from '../tools/windows-supervisor/windowsSandboxSession.mjs';

const owned = 'abcdef12-abcd-abcd-abcd-abcdefabcdef';
const unrelated = '12345678-1234-1234-1234-1234567890ab';
const emptyConfiguration = '<Configuration />';
const list = ['list', '--raw'];
const start = ['start', '--id', owned, '--config', emptyConfiguration, '--raw'];
const stop = ['stop', '--id', owned];

const rawInventory = (...ids) => JSON.stringify({
  WindowsSandboxEnvironments: ids.map((id) => ({ Id: id })),
});

test('Windows Sandbox XML confines mounts to fixture input and output and disables sharing features', () => {
  const input = String.raw`C:\CLU & E's stage\Input`;
  const output = String.raw`C:\CLU & E's stage\Output`;
  const xml = buildWindowsSandboxConfiguration(input, output);
  assert.doesNotMatch(xml, /[\r\n]/u);
  for (const setting of ['vGPU', 'Networking', 'AudioInput', 'VideoInput', 'PrinterRedirection', 'ClipboardRedirection']) {
    const values = [...xml.matchAll(new RegExp(`<${setting}>([^<]+)</${setting}>`, 'gu'))].map(([, value]) => value);
    assert.deepEqual(values, ['Disable']);
  }
  assert.match(xml, /<ProtectedClient>Enable<\/ProtectedClient>/u);
  const mounts = [...xml.matchAll(/<MappedFolder>(.*?)<\/MappedFolder>/gu)].map(([, folder]) => folder);
  assert.deepEqual(mounts, [
    String.raw`<HostFolder>C:\CLU &amp; E&apos;s stage\Input</HostFolder><SandboxFolder>C:\CLU-E-Fixture\Input</SandboxFolder><ReadOnly>true</ReadOnly>`,
    String.raw`<HostFolder>C:\CLU &amp; E&apos;s stage\Output</HostFolder><SandboxFolder>C:\CLU-E-Fixture\Output</SandboxFolder><ReadOnly>false</ReadOnly>`,
  ]);
  assert.ok(xml.includes(String.raw`<LogonCommand><Command>C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\CLU-E-Fixture\Input\fixture.ps1</Command></LogonCommand>`));
});

test('Windows Sandbox XML rejects malformed paths, aliases, and overlapping or separate mounts', () => {
  const output = String.raw`C:\Stage\Output`;
  for (const path of [
    undefined, '', String.raw`C:Input`, String.raw`\\server\share\Input`, String.raw`\\?\C:\Stage\Input`,
    String.raw`C:\Stage\..\Input`, 'C:\\Stage\\Input\\', 'C:\\Stage\\Input ', 'C:\\Stage\\Input.',
    String.raw`C:\Stage\Input:stream`, String.raw`C:\Stage\CON .txt`, String.raw`C:\PROGRA~1\Input`,
    String.raw`C:\%TEMP%\Input`, String.raw`C:/Stage/Input`, String.raw`K:\Stage\Input`, '\ud800',
    String.raw`C:\Stage\output`, String.raw`C:\Stage\Output\Input`, String.raw`C:\Other\Input`,
    String.raw`D:\Stage\Input`, String.raw`C:\Input`,
  ]) {
    assert.throws(() => buildWindowsSandboxConfiguration(path, output), /Sandbox/u);
  }
});

test('Windows Sandbox inventory requires bounded raw JSON with unique exact session IDs', () => {
  assert.deepEqual(parseWindowsSandboxInventory(rawInventory()), []);
  assert.deepEqual(parseWindowsSandboxInventory(rawInventory(owned.toUpperCase(), unrelated)), [owned, unrelated]);
  for (const text of [
    '', '[ ]', '{}', '{"WindowsSandboxEnvironments":null}', rawInventory('not-a-guid'),
    rawInventory(owned, owned.toUpperCase()), ' '.repeat(16_385) + rawInventory(),
  ]) {
    assert.throws(() => parseWindowsSandboxInventory(text), /WSB_INVENTORY_INVALID/u);
  }
});

test('Windows Sandbox start parser accepts bounded structured or exact supported start text', () => {
  assert.equal(parseWindowsSandboxStartId(JSON.stringify({ Id: owned.toUpperCase() })), owned);
  assert.equal(parseWindowsSandboxStartId(JSON.stringify({ WindowsSandboxEnvironment: { Id: owned } })), owned);
  assert.equal(parseWindowsSandboxStartId(`Windows Sandbox environment started successfully:\r\nId: ${owned}`), owned);
  assert.equal(parseWindowsSandboxStartId(`Id: ${owned}`), owned);
  for (const text of [
    '', owned, rawInventory(owned), `unrelated log Id: ${owned}`, `Id: ${owned}\nId: ${unrelated}`,
    JSON.stringify({ Id: owned, WindowsSandboxEnvironment: { Id: unrelated } }),
    ' '.repeat(16_385) + `Id: ${owned}`,
  ]) {
    assert.equal(parseWindowsSandboxStartId(text), null);
  }
});

async function runSession(inventories, startText = JSON.stringify({ Id: owned })) {
  const calls = [];
  let collections = 0;
  const fixture = { state: 'OBSERVED' };
  const report = await exerciseWindowsSandboxSession({
    id: owned,
    configuration: emptyConfiguration,
    invoke: async (args) => {
      calls.push([...args]);
      if (args[0] === 'list') return { code: 0, stdout: rawInventory(...inventories.shift()) };
      if (args[0] === 'start') return { code: 0, stdout: startText };
      return { code: 0, stdout: '' };
    },
    collect: async (connect) => {
      collections++;
      connect();
      connect();
      return fixture;
    },
    pause: async () => {},
  });
  assert.equal(inventories.length, 0);
  return { calls, collections, fixture, report };
}

test('Windows Sandbox probe leaves a pre-existing session alone', async () => {
  const { calls, collections, report } = await runSession([[unrelated]]);
  assert.deepEqual(calls, [list]);
  assert.equal(collections, 0);
  assert.equal(report.state, 'WSB_EXISTING_SESSION');
  assert.equal(report.cleanup, 'NOT_REQUIRED');
});

test('Windows Sandbox probe collects from its exact session and verifies its absence even if another appears', async () => {
  const { calls, collections, fixture, report } = await runSession([[], [owned], [owned], [unrelated]]);
  assert.deepEqual(calls, [list, start, list, ['connect', '--id', owned], list, stop, list]);
  assert.equal(collections, 1);
  assert.deepEqual(report.fixture, fixture);
  assert.equal(report.state, 'WSB_FIXTURE_OBSERVED');
  assert.equal(report.cleanup, 'EXACT_SESSION_ABSENT');
});

test('Windows Sandbox probe never stops a mismatched ID returned by start or inventory', async () => {
  const { calls, collections, report } = await runSession([[], [unrelated], [unrelated]], JSON.stringify({ Id: unrelated }));
  assert.deepEqual(calls, [list, start, list, list]);
  assert.equal(collections, 0);
  assert.equal(report.start.returnedId, 'DIFFERENT');
  assert.equal(report.state, 'WSB_CLEANUP_UNVERIFIED');
  assert.equal(report.cleanup, 'UNVERIFIED');
});

test('Windows Sandbox probe cleans only its own ID when inventory contains two sessions', async () => {
  const { calls, collections, report } = await runSession([[], [owned, unrelated], [owned, unrelated], [unrelated]]);
  assert.deepEqual(calls, [list, start, list, list, stop, list]);
  assert.equal(collections, 0);
  assert.equal(report.state, 'WSB_SESSION_IDENTITY_UNVERIFIED');
  assert.equal(report.cleanup, 'EXACT_SESSION_ABSENT');
});

test('Windows Sandbox probe reports failed cleanup when its exact session is still present', async () => {
  const { calls, report } = await runSession([[], ...Array.from({ length: 7 }, () => [owned])]);
  assert.deepEqual(calls.filter(([command]) => command === 'stop'), [stop]);
  assert.equal(report.state, 'WSB_CLEANUP_UNVERIFIED');
  assert.equal(report.cleanup, 'UNVERIFIED');
});

test('Windows Sandbox host control only considers unique non-internal RFC1918 IPv4 addresses', () => {
  const entry = (address, internal = false) => ({ address, internal });
  assert.deepEqual(privateProbeAddresses({
    primary: [entry('10.0.0.4'), entry('172.16.0.4'), entry('172.31.255.254'), entry('192.168.1.7')],
    secondary: [entry('10.0.0.4'), entry('172.15.0.4'), entry('172.32.0.4'), entry('100.64.0.1')],
    other: [entry('192.168.1.9', true), entry('127.0.0.1'), entry('169.254.0.8'), entry('8.8.8.8'),
      entry('fd00::1'), entry('::ffff:192.168.1.8'), entry('10.00.0.1')],
  }), ['10.0.0.4', '172.16.0.4', '172.31.255.254', '192.168.1.7']);
});
