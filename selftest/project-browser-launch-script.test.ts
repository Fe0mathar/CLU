/** PP-23 — the Windows launcher binds one dedicated browser to one Project Profile identity. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromeLauncherPowerShellArgs,
  ManagedChromeHostError,
  readManagedChromeLauncherOutput,
} from '../src/experiment/browser/managedChromeHost.js';

const scriptPath = resolve(process.cwd(), 'scripts/launch-test-browser.ps1');
const script = readFileSync(scriptPath, 'utf8');

test('Chrome launcher uses an execution policy for its PowerShell process and emits text diagnostics', () => {
  const args = chromeLauncherPowerShellArgs(process.cwd());
  assert.deepEqual(args.slice(-6), ['-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
});

test('Chrome launcher preserves structured failures and redacts unstructured PowerShell errors', () => {
  const success = { status: 'ok', message: 'Attached', statePid: 21 };
  assert.deepEqual(readManagedChromeLauncherOutput({
    error: null, stdout: '\uFEFF' + JSON.stringify(success), stderr: '',
  }, (text) => text), success);
  assert.throws(() => readManagedChromeLauncherOutput({
    error: { code: 5 }, stdout: '{"status":"error","message":"The debugger belongs to an unrelated process."}', stderr: '',
  }, (text) => text), /code 5.*unrelated process/u);
  assert.throws(() => readManagedChromeLauncherOutput({
    error: { code: 1 }, stdout: '', stderr: '\u001b[31mPSSecurityException\u001b[0m\nThe script could not run. token=secret-value',
  }, (text) => text), (error) => {
    assert.ok(error instanceof ManagedChromeHostError);
    assert.match(error.message, /code 1.*PSSecurityException.*script could not run/u);
    assert.doesNotMatch(error.message, /secret-value|\u001b/u);
    return true;
  });
  assert.throws(() => readManagedChromeLauncherOutput({
    error: { code: 'ENOENT' }, stdout: '', stderr: '',
  }, (text) => text), /ENOENT/u);
});

function findPwsh(): string | null {
  const candidates = [process.env['PWSH'], 'pwsh', 'pwsh.exe'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const root of (process.env['PATH'] ?? '').split(delimiter)) {
      if (root.length > 0 && existsSync(resolve(root, candidate))) return resolve(root, candidate);
    }
  }
  return null;
}

test('PP-23: launcher requires the complete governed project identity as one unit', () => {
  assert.match(script, /\$ProjectId/u);
  assert.match(script, /\$TargetRootIdentity/u);
  assert.match(script, /\$ProjectProfileHash/u);
  assert.match(script, /\$ProfileGeneration/u);
  assert.match(script, /ProjectId, TargetRootIdentity, ProjectProfileHash, and ProfileGeneration must be supplied together/u);
  assert.match(script, /\^path:v1:\[a-z0-9\._-\]\+:\[0-9a-f\]\{64\}\$/u);
  assert.match(script, /\^profile:v1:\[0-9a-f\]\{64\}\$/u);
});

test('PP-23: launcher persists and validates one exact runtime binding before status, reuse, or stop', () => {
  assert.match(script, /clue-browser-session\/2/u);
  assert.match(script, /targetRootIdentity\s*=\s*\$TargetRootIdentity/u);
  assert.match(script, /projectProfileHash\s*=\s*\$ProjectProfileHash/u);
  assert.match(script, /profileGeneration\s*=\s*if \(\$ProfileGeneration -gt 0\)/u);
  assert.match(script, /debugEndpoint\s*=\s*"127\.0\.0\.1:\$EndpointPort"/u);
  assert.match(script, /headless\s*=\s*\[bool\]\$Headless/u);
  assert.match(script, /function Assert-StateBinding/u);
  assert.match(script, /mismatches \+= 'profile'/u);
  assert.match(script, /mismatches \+= 'port'/u);
  assert.match(script, /mismatches \+= 'pid'/u);
  assert.match(script, /mismatches \+= 'url'/u);
  assert.match(script, /mismatches \+= 'allowedOrigin'/u);
  assert.match(script, /Assert-StateBinding -State \$state -Context 'Status'/u);
  assert.match(script, /Assert-StateBinding -State \$state -Context 'Reuse'/u);
  assert.match(script, /Assert-StateBinding -State \$state -Context 'Stop'/u);
  assert.match(script, /Move-Item -LiteralPath \$temp -Destination \$path -Force/u);
});

test('PP-23: launcher uses one dedicated profile and loopback endpoint without process-name guessing', () => {
  assert.match(script, /--user-data-dir=/u);
  assert.match(script, /--remote-debugging-address=127\.0\.0\.1/u);
  assert.match(script, /Get-CimInstance -ClassName Win32_Process/u);
  assert.match(script, /Get-CimInstance -ClassName Win32_Process -Filter "Name = 'chrome\.exe'"/u);
  assert.match(script, /\[regex\]::Matches\(\$_\.CommandLine/u);
  assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort/u);
  assert.match(script, /Assert-DebuggerProcessBinding -State \$state -EndpointPort \$Port/u);
  assert.match(script, /listenerVerified\s*=\s*\$true/u);
  assert.match(script, /debugging port already belongs to a process outside the dedicated profile/u);
  assert.match(script, /endpoint answers, but no browser process is bound to the requested dedicated profile/u);
  assert.doesNotMatch(script, /Get-Process\s+(?:-Name\s+)?(?:chrome|msedge)/iu);
  assert.doesNotMatch(script, /Stop-Process\s+(?:-Name\s+)?(?:chrome|msedge)/iu);
});

test('PP-23: launcher enforces the configured HTTP(S) origin before launch and exact URL on reuse', () => {
  assert.match(script, /function Assert-AllowedOrigin/u);
  assert.match(script, /AllowedOrigin and Url must use HTTP or HTTPS/u);
  assert.match(script, /AllowedOrigin must be one pure HTTP\(S\) origin without credentials, path, query, or fragment/u);
  assert.match(script, /outside the governed origin/u);
  assert.match(script, /Assert-AllowedOrigin -Target \$Url/u);
  assert.match(script, /-Target \$Url -VerifyTarget/u);
});

test('PP-23: PowerShell parses the managed-browser launcher where pwsh is available', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('no pwsh runtime available; Windows/PowerShell parser validation remains a live apply gate');
    return;
  }
  const command = [
    '$tokens=$null; $errors=$null;',
    `[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) | Out-Null;`,
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
  ].join(' ');
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('PP-23: launch proof rejects profile-prefix, unrelated listener, and hidden-window substitutions', (t) => {
  const pwsh = findPwsh();
  if (pwsh === null) {
    t.skip('no pwsh runtime available for the launcher fixture');
    return;
  }
  const command = [
    '$ErrorActionPreference = "Stop";',
    '$tokens = $null; $errors = $null;',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors);`,
    'if ($errors.Count -gt 0) { throw $errors[0].Message }',
    '$names = @("Get-ClueBrowserProcess", "Test-DebuggerProcessBinding");',
    '$nodes = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names }, $true);',
    'foreach ($node in $nodes) { Invoke-Expression $node.Extent.Text }',
    String.raw`$profile = 'F:\CLU\dedicated profile';`,
    'function Get-CimInstance {',
    '  param($ClassName, $Filter, $ErrorAction)',
    `  if ($Filter -ne "Name = 'chrome.exe'") { throw "missing Chrome image filter" }`,
    '  [pscustomobject]@{ ProcessId = 101; CommandLine = (\'chrome.exe "--user-data-dir=\' + $profile + \'" --type=renderer\') }',
    '  [pscustomobject]@{ ProcessId = 102; CommandLine = (\'chrome.exe --user-data-dir="\' + $profile + \'" --remote-debugging-port=9222\') }',
    '  [pscustomobject]@{ ProcessId = 103; CommandLine = (\'chrome.exe "--user-data-dir=\' + $profile + \'-other"\') }',
    '  [pscustomobject]@{ ProcessId = 104; CommandLine = (\'chrome.exe "--description=--user-data-dir=\' + $profile + \'"\') }',
    '}',
    '$found = @(Get-ClueBrowserProcess -ResolvedProfile $profile);',
    'if ($found.Count -ne 2 -or $found[0].ProcessId -ne 101 -or $found[1].ProcessId -ne 102) { throw "profile argument binding failed" }',
    'function Get-Process { param($Id, $ErrorAction) [pscustomobject]@{ ProcessName = "chrome"; MainWindowHandle = $script:window } }',
    'function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) $script:listeners }',
    '$script:window = 1;',
    '$script:listeners = @([pscustomobject]@{ OwningProcess = 101; LocalAddress = "127.0.0.1" });',
    'if (-not (Test-DebuggerProcessBinding -EndpointPort 9222 -ExpectedPid 101 -ExpectVisible $true)) { throw "owner on loopback was rejected" }',
    'if (Test-DebuggerProcessBinding -EndpointPort 9222 -ExpectedPid 999 -ExpectVisible $true) { throw "foreign debugger accepted" }',
    '$script:listeners += [pscustomobject]@{ OwningProcess = 101; LocalAddress = "0.0.0.0" };',
    'if (Test-DebuggerProcessBinding -EndpointPort 9222 -ExpectedPid 101 -ExpectVisible $true) { throw "non-loopback listener accepted" }',
    '$script:listeners = @($script:listeners[0]);',
    '$script:window = 0;',
    'if (Test-DebuggerProcessBinding -EndpointPort 9222 -ExpectedPid 101 -ExpectVisible $true) { throw "hidden Chrome accepted" }',
  ].join('\n');
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
