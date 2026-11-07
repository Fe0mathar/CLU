/**
 * DEV-P0-11 — a host reply becomes evidence only if the host resolved the target to the EXACT path
 * the client authorised.
 *
 * The parity check previously compared only the zone the host reported, so a host that resolved into
 * the authorised zone but at a DIFFERENT path — a same-zone symlink or junction, or a substituted file
 * — was accepted. `checkZoneParity` now also requires the host's resolved path to equal the client's
 * authorised `resolvedTarget` (compared in the engine's normalised space), refusing a same-zone path
 * substitution before the reply is trusted. This check runs on every path-bearing command in `call()`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkZoneParity,
  parseLine,
  type ParsedResponse,
  type HostCommandName,
} from '../src/experiment/host/hostClient.js';
import { normaliseAbsolute, type PolicyDecision, type PathZone } from '../src/control/policy.js';

const decision = (zone: PolicyDecision['zone'], target: string | null): PolicyDecision => ({
  decision: 'allowed',
  code: null,
  reason: null,
  zone,
  resolvedTarget: target === null ? null : normaliseAbsolute(target),
});

const response = (resolvedPath: string | null, zone: string | null): ParsedResponse =>
  ({
    id: 'fs.stat#1',
    rawLine: '{}',
    ok: true,
    result: {},
    code: null,
    message: null,
    resolvedPath,
    zone,
  } as ParsedResponse);

const stat = 'fs.stat' as HostCommandName;

test('an exact resolved path in the authorised zone is accepted', () => {
  assert.equal(checkZoneParity(stat, decision('workspace', '/srv/ws/a.txt'), response('/srv/ws/a.txt', 'workspace')), null);
  // A case/separator variant is the same file on the engine's normalised comparison.
  assert.equal(checkZoneParity(stat, decision('workspace', '/srv/ws/a.txt'), response('\\srv\\ws\\A.txt', 'workspace')), null);
});

test('a different path in the same zone is rejected as a path substitution', () => {
  const err = checkZoneParity(stat, decision('workspace', '/srv/ws/a.txt'), response('/srv/ws/b.txt', 'workspace'));
  assert.ok(err !== null);
  assert.equal(err.code, 'PATH_PARITY_MISMATCH');
});

test('a different zone, and a missing resolution, are rejected', () => {
  assert.equal(
    checkZoneParity(stat, decision('workspace', '/srv/ws/a.txt'), response('/srv/shadow/a.txt', 'shadow'))?.code,
    'ZONE_PARITY_MISMATCH',
  );
  assert.equal(
    checkZoneParity(stat, decision('workspace', '/srv/ws/a.txt'), response(null, null))?.code,
    'ZONE_PARITY_MISMATCH',
  );
});

test('a command with no authorised zone imposes no parity', () => {
  assert.equal(checkZoneParity('browser.status' as HostCommandName, decision(null, null), response(null, null)), null);
});

/* ========================================================================= */
/* DEV-P0-11 — strict outer response envelope                                 */
/* ========================================================================= */

const V = 1;
const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

test('the strict envelope accepts well-formed success and error replies', () => {
  const ok = parseLine(line({ v: V, id: 'fs.stat#1', ok: true, result: { size: 10 }, resolvedPath: '/srv/ws/a', zone: 'workspace' }));
  assert.equal(ok.of, 'response');
  if (ok.of === 'response') {
    assert.equal(ok.response.ok, true);
    assert.equal(ok.response.code, null);
    assert.equal(ok.response.zone, 'workspace');
  }

  const err = parseLine(line({ v: V, id: 'fs.stat#1', ok: false, code: 'NOT_FOUND', message: 'missing' }));
  assert.equal(err.of, 'response');
  if (err.of === 'response') {
    assert.equal(err.response.ok, false);
    assert.equal(err.response.code, 'NOT_FOUND');
  }
});

test('the strict envelope rejects unknown fields and contradictory success/error replies', () => {
  const malformed = (obj: Record<string, unknown>): boolean => parseLine(line(obj)).of === 'malformed';

  // Unknown key.
  assert.ok(malformed({ v: V, id: 'x', ok: true, result: 1, sneaky: 'extra' }));
  // ok:true carrying an error code (contradiction).
  assert.ok(malformed({ v: V, id: 'x', ok: true, result: 1, code: 'NOT_FOUND' }));
  // ok:false with no code.
  assert.ok(malformed({ v: V, id: 'x', ok: false, message: 'no code' }));
  // ok:false carrying a result (contradiction).
  assert.ok(malformed({ v: V, id: 'x', ok: false, code: 'DENIED', result: { leaked: true } }));
  // ok:false with an empty code.
  assert.ok(malformed({ v: V, id: 'x', ok: false, code: '' }));
  // Wrong protocol version.
  assert.ok(malformed({ v: 999, id: 'x', ok: true, result: 1 }));
  // Missing ok entirely.
  assert.ok(malformed({ v: V, id: 'x', result: 1 }));
  // Not JSON.
  assert.equal(parseLine('{not json').of, 'malformed');
});

/* ========================================================================= */
/* DEV-P0-09 — the client independently classifies the host-resolved path     */
/* ========================================================================= */

const classify = (path: string): PathZone => (path.includes('/canonical/') ? 'canonical' : 'workspace');

test('the client refuses a host-resolved path it classifies into a different zone than the host labelled', () => {
  // The host labels the reply "workspace" (matching the authorised zone), but the resolved path is
  // physically in the canonical tree. With no exact target to compare, the client's own classification
  // of the returned path is what catches it — the host's label is not trusted on its own.
  const err = checkZoneParity(stat, decision('workspace', null), response('/srv/canonical/sneaky.txt', 'workspace'), classify);
  assert.ok(err !== null, 'a mislabelled zone is refused');
  assert.equal(err.code, 'ZONE_PARITY_MISMATCH');
});

test('a host-resolved path the client classifies into the authorised zone is accepted', () => {
  const ok = checkZoneParity(stat, decision('workspace', null), response('/srv/workspace/real.txt', 'workspace'), classify);
  assert.equal(ok, null, 'agreement across decision, host label, and independent classification passes');
});

/* ========================================================================= */
/* DEV-P0-11 — browser-profile operations get zone parity via an explicit zone */
/* ========================================================================= */

const browserClassify = (path: string): PathZone => (path.includes('/profile/') ? 'browserProfile' : 'workspace');
const launch = 'browser.launch' as HostCommandName;

test('a browser-profile op is held to browser-profile parity even though its capability is unzoned', () => {
  // browser.control does not zone the target, so decision.zone is null; the explicit expected zone is
  // what makes the profile-dir path subject to parity.
  const unzoned = decision(null, null);

  // The host resolved the profile dir correctly into the browser-profile zone: parity passes.
  const ok = checkZoneParity(launch, unzoned, response('/srv/profile/p', 'browserProfile'), browserClassify, 'browserProfile');
  assert.equal(ok, null, 'a correctly-resolved profile dir passes');

  // The host resolved somewhere else (an escaped/symlinked profile dir): refused.
  const escaped = checkZoneParity(launch, unzoned, response('/srv/workspace/p', 'workspace'), browserClassify, 'browserProfile');
  assert.ok(escaped !== null, 'a profile dir that resolved outside the browser-profile zone is refused');
  assert.equal(escaped.code, 'ZONE_PARITY_MISMATCH');

  // The host LABELS browser-profile but the path is elsewhere: the independent classification catches it.
  const mislabelled = checkZoneParity(launch, unzoned, response('/srv/workspace/p', 'browserProfile'), browserClassify, 'browserProfile');
  assert.ok(mislabelled !== null, 'a mislabelled profile zone is refused');
});
