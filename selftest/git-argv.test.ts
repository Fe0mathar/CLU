/**
 * DEV-P0-09 — the client's Git argv builder refuses unsafe operands.
 *
 * `gitArgv` is the client-side allowlist: it produces the exact argument vector for a verb. Beyond
 * matching the parameter shape, it now refuses any operand that would be misread — a path or ref that
 * begins with a dash (which Git reads as an option) or a path that contains a `..` traversal — so a
 * malicious operand never reaches the wire, independent of the host's own equivalent checks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gitArgv, type GitVerb, type GitParams } from '../src/experiment/host/hostClient.js';

test('gitArgv builds the intended argv for safe operands', () => {
  assert.deepEqual(gitArgv('checkout', { of: 'ref', ref: 'clue/accepted/patch-1' }), ['checkout', 'clue/accepted/patch-1']);
  assert.deepEqual(gitArgv('apply', { of: 'path', path: 'patches/p.diff' }), ['apply', 'patches/p.diff']);
  assert.deepEqual(gitArgv('clone', { of: 'clone', source: '/srv/canonical', dest: '/srv/shadow/clue' }), [
    'clone',
    '--no-checkout',
    '/srv/canonical',
    '/srv/shadow/clue',
  ]);
});

test('gitArgv refuses operands that begin with a dash or contain a traversal', () => {
  const refused = (verb: GitVerb, params: GitParams): void =>
    assert.throws(() => gitArgv(verb, params), /INVALID_ARGUMENT|dash|traversal/i, `${verb} ${JSON.stringify(params)}`);

  // A leading dash would be read by Git as an option.
  refused('checkout', { of: 'ref', ref: '--upload-pack=evil' });
  refused('apply', { of: 'path', path: '-oProxyCommand=x' });
  refused('clone', { of: 'clone', source: '--evil', dest: '/srv/shadow/x' });
  refused('clone', { of: 'clone', source: '/srv/canonical', dest: '-x' });

  // A `..` traversal in a path operand would escape its zone.
  refused('apply', { of: 'path', path: '../../../etc/passwd' });
  refused('hashObject', { of: 'path', path: 'a/../../b' });
  refused('clone', { of: 'clone', source: '/srv/../etc', dest: '/srv/shadow/x' });
});
