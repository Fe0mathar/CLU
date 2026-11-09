/**
 * DEV-P0-12 — the PowerShell host validates nested git `params` as strictly as top-level command args.
 *
 * `Assert-KnownKeys` guards top-level command arguments, but the nested git `params` object was only
 * shape-discriminated by its `of` field — an extra nested key, or an unknown shape, slipped through.
 * `Get-ParamsShape` now rejects any key outside the shape's set and any unknown `of`. This test drives
 * the real host over its NDJSON protocol.
 *
 * The host is PowerShell, so this suite runs only where a `pwsh` runtime is available (Windows, or a dev
 * box with PowerShell installed; set the `PWSH` env var to point at a specific binary). Where pwsh is
 * absent — a plain Linux CI runner — it skips rather than fails, because the Windows-specific behaviour
 * cannot be exercised there anyway.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

function findPwsh(): string | null {
  for (const candidate of [process.env['PWSH'], 'pwsh', 'pwsh.exe']) {
    if (candidate === undefined || candidate === '') continue;
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'if ($PSVersionTable.PSVersion -lt [version]"7.2") { exit 1 }'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const scriptPath = fileURLToPath(new URL('../../scripts/clue-host.ps1', import.meta.url));

interface Reply {
  readonly id: string;
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

function runHost(
  pwsh: string,
  roots: { canon: string; shadow: string; ws: string; prof: string },
  requests: readonly unknown[],
  extraHostArgs: readonly string[] = [],
): Map<string, Reply> {
  const ndjson = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const result = spawnSync(
    pwsh,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-CanonicalRoot',
      roots.canon,
      '-ShadowRoot',
      roots.shadow,
      '-WorkspaceRoot',
      roots.ws,
      '-BrowserProfileDir',
      roots.prof,
      ...extraHostArgs,
    ],
    { input: ndjson, encoding: 'utf8', timeout: 60_000 },
  );
  const replies = new Map<string, Reply>();
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = JSON.parse(trimmed) as Reply;
    replies.set(parsed.id, parsed);
  }
  return replies;
}


test('PP-21: PowerShell host source pins and validates Project Profile identity', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /\[string\]\s+\$ProjectIdentityJson/);
  assert.match(source, /Assert-ProjectIdentityParity/);
  assert.match(source, /projectIdentity/);
  assert.match(source, /ProjectIdentityJson/);
  assert.match(source, /PROJECT_IDENTITY_MISMATCH/);
});

test('the host rejects unknown and extra nested git params, and accepts valid ones', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('no pwsh runtime available; the PowerShell host cannot be exercised here');
    return;
  }
  assert.ok(existsSync(scriptPath), 'the host script exists');

  const root = mkdtempSync(join(tmpdir(), 'clue-ps1-'));
  const roots = { canon: join(root, 'canonical'), shadow: join(root, 'shadow'), ws: join(root, 'workspace'), prof: join(root, 'profile') };
  for (const p of Object.values(roots)) mkdirSync(p, { recursive: true });
  try {
    const gitReq = (id: string, verb: string, params: unknown) => ({
      v: 1,
      id,
      command: 'git',
      args: { zone: 'shadow', root: roots.shadow, verb, params },
    });
    const replies = runHost(pwsh, roots, [
      gitReq('valid', 'commit', { of: 'commit', message: 'm' }),
      gitReq('extra', 'commit', { of: 'commit', message: 'm', extra: 'x' }),
      gitReq('shape', 'status', { of: 'bogus' }),
      { v: 1, id: 'unknown-cmd', command: 'nope', args: {} },
      { v: 1, id: 'top-key', command: 'fs.stat', args: { zone: 'shadow', path: roots.shadow, BAD: 'x' } },
    ]);

    // Valid params pass the key check (git then runs and fails on a non-repo, but not for a key reason).
    assert.notEqual(replies.get('valid')?.code, 'INVALID_ARGUMENT', 'valid nested params are not rejected for keys');

    // An extra nested key and an unknown shape are refused.
    assert.equal(replies.get('extra')?.code, 'INVALID_ARGUMENT');
    assert.match(replies.get('extra')?.message ?? '', /unknown git param/);
    assert.equal(replies.get('shape')?.code, 'INVALID_ARGUMENT');
    assert.match(replies.get('shape')?.message ?? '', /unknown git params shape/);

    // Baselines: the closed command registry and top-level key check still hold.
    assert.equal(replies.get('unknown-cmd')?.code, 'UNKNOWN_COMMAND');
    assert.equal(replies.get('top-key')?.code, 'INVALID_ARGUMENT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-12: the outer request envelope refuses unknown keys, and git operand VALUES are strictly validated', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('no pwsh runtime available; the PowerShell host cannot be exercised here');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'clue-ps1-'));
  const roots = { canon: join(root, 'canonical'), shadow: join(root, 'shadow'), ws: join(root, 'workspace'), prof: join(root, 'profile') };
  for (const p of Object.values(roots)) mkdirSync(p, { recursive: true });
  try {
    const gitReq = (id: string, verb: string, params: unknown) => ({
      v: 1,
      id,
      command: 'git',
      args: { zone: 'shadow', root: roots.shadow, verb, params },
    });
    const replies = runHost(pwsh, roots, [
      // The envelope is as closed as command args: a fifth top-level key is refused.
      { v: 1, id: 'outer', command: 'fs.stat', args: { zone: 'shadow', path: roots.shadow }, smuggled: 'x' },
      // Operand values, not just shapes: a leading dash would be read by git as an option;
      // ref-pattern syntax, non-hex shas, and traversal paths are injections regardless of intent.
      gitReq('dashref', 'checkout', { of: 'ref', ref: '--upload-pack=evil' }),
      gitReq('patref', 'checkout', { of: 'ref', ref: 'a..b' }),
      gitReq('badsha', 'revert', { of: 'sha', sha: 'not-a-sha!' }),
      gitReq('traverse', 'hashObject', { of: 'path', path: '../../outside' }),
    ]);
    assert.equal(replies.get('outer')?.code, 'INVALID_ARGUMENT');
    assert.match(replies.get('outer')?.message ?? '', /unknown request key/);
    assert.equal(replies.get('dashref')?.code, 'INVALID_ARGUMENT');
    assert.equal(replies.get('patref')?.code, 'INVALID_ARGUMENT');
    assert.match(replies.get('patref')?.message ?? '', /forbidden syntax/);
    assert.equal(replies.get('badsha')?.code, 'INVALID_ARGUMENT');
    assert.equal(replies.get('traverse')?.code, 'INVALID_ARGUMENT');
    assert.match(replies.get('traverse')?.message ?? '', /traversal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-12: the landing ref prefix is enforced independently in the host', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('no pwsh runtime available; the PowerShell host cannot be exercised here');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'clue-ps1-'));
  const roots = { canon: join(root, 'canonical'), shadow: join(root, 'shadow'), ws: join(root, 'workspace'), prof: join(root, 'profile') };
  for (const p of Object.values(roots)) mkdirSync(p, { recursive: true });
  try {
    const land = (id: string, ref: string) => ({
      v: 1,
      id,
      command: 'git',
      args: { zone: 'canonical', root: roots.canon, verb: 'mergeFfOnly', params: { of: 'ref', ref } },
    });

    // With no -LandingRefPrefix configured, canonical landing is refused outright (deny-by-default).
    const unconfigured = runHost(pwsh, roots, [land('noprefix', 'clue/accepted/p1')]);
    assert.equal(unconfigured.get('noprefix')?.code, 'LANDING_NOT_CONFIGURED');

    // With a prefix configured, an off-prefix ref is refused by the HOST — even a compromised client
    // cannot land outside the prefix — while an in-prefix ref clears the rule (git itself then fails
    // on the non-repo directory, which is a different, later concern).
    const configured = runHost(
      pwsh,
      roots,
      [land('offprefix', 'refs-heads-main'), land('inprefix', 'clue/accepted/p1')],
      ['-LandingRefPrefix', 'clue/accepted/'],
    );
    assert.equal(configured.get('offprefix')?.code, 'GIT_REF_FORBIDDEN');
    assert.notEqual(configured.get('inprefix')?.code, 'GIT_REF_FORBIDDEN', 'an in-prefix ref clears the host rule');
    assert.notEqual(configured.get('inprefix')?.code, 'LANDING_NOT_CONFIGURED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the host keeps Git operands in their zones and refreshes only from the canonical checkout', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null || spawnSync('git', ['--version']).status !== 0) {
    t.skip('PowerShell 7.2+ and Git are required');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'clue-ps1-git-zones-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = { canon: join(root, 'canonical'), shadow: join(root, 'shadow'), ws: join(root, 'workspace'), prof: join(root, 'profile') };
  for (const path of Object.values(roots)) mkdirSync(path);
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(roots.canon, 'init');
  git(roots.shadow, 'init');
  git(roots.canon, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'canonical');
  git(roots.shadow, 'remote', 'add', 'origin', 'https://example.invalid/unused.git');

  const gitRequest = (id: string, verb: string, params: unknown) => ({
    v: 1, id, command: 'git', args: { zone: 'shadow', root: roots.shadow, verb, params },
  });
  const refreshRequest = (id: string, commit: string | null) => ({
    v: 1, id, command: 'shadow.refresh', args: { canonicalRoot: roots.canon, shadowRoot: roots.shadow, commit },
  });
  const replies = runHost(pwsh, roots, [
    gitRequest('external-hash', 'hashObject', { of: 'path', path: join(root, 'private.txt') }),
    gitRequest('external-clone', 'clone', { of: 'clone', source: roots.canon, dest: join(root, 'escape') }),
    refreshRequest('checkout-option', '--orphan'),
    refreshRequest('canonical-refresh', null),
  ]);
  assert.equal(replies.get('external-hash')?.code, 'ZONE_MISMATCH');
  assert.equal(replies.get('external-clone')?.code, 'ZONE_MISMATCH');
  assert.equal(replies.get('checkout-option')?.code, 'INVALID_ARGUMENT');
  assert.equal(replies.get('canonical-refresh')?.ok, true, JSON.stringify(replies.get('canonical-refresh')));
  assert.equal(git(roots.shadow, 'rev-parse', 'HEAD'), git(roots.canon, 'rev-parse', 'HEAD'));
});

test('the host invokes the installed npm CLI directly and strips the provider key from the script', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('PowerShell 7.2+ is required');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'clue-ps1-npm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = { canon: join(root, 'canonical'), shadow: join(root, 'shadow'), ws: join(root, 'workspace'), prof: join(root, 'profile') };
  for (const path of Object.values(roots)) mkdirSync(path);
  writeFileSync(join(roots.shadow, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node check-env.cjs' } }));
  writeFileSync(join(roots.shadow, 'check-env.cjs'), 'process.exitCode = process.env.OPENAI_API_KEY ? 12 : 0;');
  const previous = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = 'fixture-only-not-a-real-key';
  t.after(() => {
    if (previous === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = previous;
  });

  const replies = runHost(pwsh, roots, [{
    v: 1, id: 'typecheck', command: 'shadow.run',
    args: { shadowRoot: roots.shadow, script: 'typecheck', timeoutMs: 10_000 },
  }]);
  const reply = replies.get('typecheck');
  assert.equal(reply?.ok, true, JSON.stringify(reply));
  assert.equal((reply as Reply & { result: { exitCode: number } }).result.exitCode, 0);
});

test('DEV-P0-12: browser launch requires a startup-pinned executable and an allowed origin', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('no pwsh runtime available; the PowerShell host cannot be exercised here');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'clue-ps1-'));
  const roots = { canon: join(root, 'canonical'), shadow: join(root, 'shadow'), ws: join(root, 'workspace'), prof: join(root, 'profile') };
  for (const p of Object.values(roots)) mkdirSync(p, { recursive: true });
  try {
    const launch = (id: string, executable: string, url: string) => ({
      v: 1,
      id,
      command: 'browser.launch',
      args: { executable, profileDir: roots.prof, port: 19222, url, timeoutMs: 1000 },
    });

    // Unpinned: refused before any argument is even considered.
    const unpinned = runHost(pwsh, roots, [launch('unpinned', '/bin/true', 'http://127.0.0.1:19222/')]);
    assert.equal(unpinned.get('unpinned')?.code, 'BROWSER_NOT_CONFIGURED');

    // Pinned: a request naming a different executable, or an origin outside the allowlist, is refused
    // before any process starts. Every refusal here precedes Start-Process by construction.
    const pinned = runHost(
      pwsh,
      roots,
      [
        launch('wrongexe', '/bin/false', 'http://127.0.0.1:19222/'),
        launch('badorigin', '/bin/true', 'http://evil.example:9/steal'),
      ],
      ['-BrowserExecutable', '/bin/true', '-AllowedBrowserOrigins', 'http://127.0.0.1:19222'],
    );
    assert.equal(pinned.get('wrongexe')?.code, 'INVALID_ARGUMENT');
    assert.match(pinned.get('wrongexe')?.message ?? '', /pinned/);
    assert.equal(pinned.get('badorigin')?.code, 'ORIGIN_FORBIDDEN');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-12: real-path resolution is component-wise — a link in the middle of a path cannot dodge the zone', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('no pwsh runtime available; the PowerShell host cannot be exercised here');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'clue-ps1-'));
  const roots = { canon: join(root, 'canonical'), shadow: join(root, 'shadow'), ws: join(root, 'workspace'), prof: join(root, 'profile') };
  for (const p of Object.values(roots)) mkdirSync(p, { recursive: true });
  try {
    // shadow/esc is a link to a CANONICAL directory holding f.txt. The leaf (f.txt) is a plain file, so
    // leaf-only resolution kept the lexical shadow path and mis-zoned the real canonical target;
    // component-wise resolution follows `esc` where it stands and lands in the canonical zone, which
    // must not satisfy a command that declared the shadow zone.
    const canonSub = join(roots.canon, 'real');
    mkdirSync(canonSub, { recursive: true });
    writeFileSync(join(canonSub, 'f.txt'), 'x', 'utf8');
    try {
      symlinkSync(canonSub, join(roots.shadow, 'esc'), 'dir');
    } catch (cause) {
      // Creating a symlink/junction needs an elevated shell or Developer Mode on Windows; without that
      // privilege this is an environment limit, not a host defect (the host's own realpath logic is
      // exercised the same way by the live probe). Skip rather than fail.
      t.skip(`symlink creation unavailable here (${(cause as NodeJS.ErrnoException).code ?? 'error'}); run elevated or enable Developer Mode to exercise this`);
      return;
    }

    const replies = runHost(pwsh, roots, [
      { v: 1, id: 'mid', command: 'fs.hash', args: { zone: 'shadow', path: join(roots.shadow, 'esc', 'f.txt') } },
    ]);
    assert.equal(replies.get('mid')?.ok, false);
    assert.equal(replies.get('mid')?.code, 'ZONE_MISMATCH', 'the intermediate link is resolved and the real zone is enforced');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
