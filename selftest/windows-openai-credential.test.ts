import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasWindowsOpenAiCredential,
  promptWindowsOpenAiCredential,
  readWindowsOpenAiCredential,
  windowsOpenAiCredentialReference,
} from '../src/control/projectProfiles/windowsOpenAiCredential.js';

test('Windows OpenAI credentials use a stable reference for each canonical project ID', () => {
  assert.equal(windowsOpenAiCredentialReference('project-1'), 'credential-store:CLU-E/OpenAI/project-1');
  assert.notEqual(windowsOpenAiCredentialReference('project-1'), windowsOpenAiCredentialReference('project-2'));
  assert.throws(() => windowsOpenAiCredentialReference("project'; exit 0"));
});

test('Windows OpenAI credential reads refuse other namespaces and malformed references', () => {
  assert.equal(readWindowsOpenAiCredential('env:OPENAI_API_KEY'), null);
  assert.equal(readWindowsOpenAiCredential('credential-store:another-tool/project-1'), null);
  assert.equal(readWindowsOpenAiCredential('credential-store:CLU-E/OpenAI/../project-1'), null);
  assert.equal(readWindowsOpenAiCredential('credential-store:CLU-E/OpenAI/Project-1'), null);
});

test('Windows OpenAI credential operations fail closed on non-Windows hosts', {
  skip: process.platform === 'win32',
}, async () => {
  const projectId = 'project-1';
  const credentialReference = windowsOpenAiCredentialReference(projectId);
  assert.equal(hasWindowsOpenAiCredential(projectId), false);
  assert.equal(readWindowsOpenAiCredential(credentialReference), null);
  assert.deepEqual(await promptWindowsOpenAiCredential(projectId), { state: 'unsupported', credentialReference });
});
