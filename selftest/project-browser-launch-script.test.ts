/** PP-23 — the Windows launcher binds one dedicated browser to one Project Profile identity. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scriptPath = resolve(process.cwd(), 'scripts/launch-test-browser.ps1');
const script = readFileSync(scriptPath, 'utf8');

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
  assert.match(script, /\.CommandLine\.Contains/u);
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
