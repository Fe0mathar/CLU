import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  matchesChromeTarget,
  probeChromeConsole,
  readinessRequestSchema,
  registeredGitHubRepository,
} from '../src/daemon/dashboardReadiness.js';
import type { ConsoleListener } from '../src/experiment/browser/browserAgent.js';
import { readDashboardReadinessReceipts, rememberDashboardReadiness } from '../src/daemon/dashboardReadinessReceipt.js';
import { legacyWindowsOpenAiCredentialReference, windowsOpenAiCredentialReference } from '../src/control/projectProfiles/windowsOpenAiCredential.js';

test('legacy Windows OpenAI credential references are stable and bound to the target and configured slot', () => {
  const first = legacyWindowsOpenAiCredentialReference(join(tmpdir(), 'clue-a'), 'OPENAI_API_KEY');
  assert.match(first, /^credential-store:CLU-E\/OpenAI\/legacy\/[a-f0-9]{64}$/u);
  assert.equal(first, legacyWindowsOpenAiCredentialReference(join(tmpdir(), 'clue-a'), 'OPENAI_API_KEY'));
  assert.notEqual(first, legacyWindowsOpenAiCredentialReference(join(tmpdir(), 'clue-b'), 'OPENAI_API_KEY'));
  assert.notEqual(first, legacyWindowsOpenAiCredentialReference(join(tmpdir(), 'clue-a'), 'ALT_OPENAI_KEY'));
  assert.notEqual(first, windowsOpenAiCredentialReference('clue-a'));
});

test('only scoped AI and Git state and timestamps are restored from advisory receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-readiness-receipts-'));
  try {
    const scope = 'a'.repeat(64);
    rememberDashboardReadiness(root, scope, 'ai', 'ready');
    rememberDashboardReadiness(root, scope, 'git', 'pending');
    rememberDashboardReadiness(root, scope, 'chrome', 'ready');
    const receipts = readDashboardReadinessReceipts(root, scope);
    assert.deepEqual(Object.keys(receipts), ['ai', 'git']);
    assert.deepEqual(Object.keys(receipts.ai ?? {}), ['state', 'checkedAt']);
    assert.equal(receipts.ai?.state, 'ready');
    assert.equal(receipts.git?.state, 'pending');
    assert.deepEqual(readDashboardReadinessReceipts(root, 'b'.repeat(64)), {});
    writeFileSync(join(root, '.dashboard-readiness-ai.json'), JSON.stringify({ scope, ...receipts.ai, extra: 'unexpected' }));
    assert.equal(readDashboardReadinessReceipts(root, scope).ai, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readiness accepts only named canaries with no user-supplied command or URL', () => {
  for (const capability of ['git', 'ai', 'chrome', 'console']) assert.equal(readinessRequestSchema.safeParse({ capability }).success, true);
  assert.equal(readinessRequestSchema.safeParse({ capability: 'cmd' }).success, false);
  assert.equal(readinessRequestSchema.safeParse({ capability: 'console', command: 'whoami' }).success, false);
  assert.equal(readinessRequestSchema.safeParse({ capability: 'chrome', target: 'http://127.0.0.1' }).success, false);
});

test('GitHub readiness binds to a credential-free GitHub.com repository', () => {
  assert.equal(registeredGitHubRepository('https://github.com/Owner/Repo.git'), 'Owner/Repo');
  assert.equal(registeredGitHubRepository('git@github.com:Owner/Repo.git'), 'Owner/Repo');
  for (const url of ['https://token@github.com/Owner/Repo', 'https://github.com.evil.test/Owner/Repo', 'ext::ssh github.com', 'https://github.com/Owner/Repo?token=abc']) {
    assert.equal(registeredGitHubRepository(url), null, url);
  }
});

test('Chrome readiness accepts only the expected page and loopback debugger target', () => {
  const target = { id: 'target1', type: 'page', title: '', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target1' };
  assert.equal(matchesChromeTarget(target, target.url, 9222), true);
  for (const webSocketDebuggerUrl of [
    'ws://other-host.invalid:9222/devtools/page/target1', 'ws://127.0.0.1:9233/devtools/page/target1',
    'ws://127.0.0.1:9222/devtools/page/target2', 'ws://127.0.0.1:9222/devtools/page/target1?token=abc',
  ]) assert.equal(matchesChromeTarget({ ...target, webSocketDebuggerUrl }, target.url, 9222), false);
  assert.equal(matchesChromeTarget(target, `${target.url}another-page`, 9222), false);
});

test('Chrome readiness distinguishes returned JavaScript from captured console output', async () => {
  for (const scenario of ['captured', 'missing-event', 'wrong-result'] as const) {
    let listener: ConsoleListener | undefined;
    let unsubscribed = false;
    const result = await probeChromeConsole({
      onConsole(callback) { listener = callback; return () => { unsubscribed = true; }; },
    }, async (source) => {
      const marker = source.match(/"(CLU-E console verification [a-z0-9-]+)"/u)?.[1];
      assert.ok(marker);
      listener?.({ level: 'info', text: scenario === 'missing-event' ? 'unrelated console log' : marker, frames: [], timestamp: new Date().toISOString() });
      return scenario === 'wrong-result' ? null : marker;
    }, 1);
    assert.deepEqual(result, { executed: scenario !== 'wrong-result', captured: scenario === 'captured' });
    assert.equal(unsubscribed, true);
  }
});
