/** An optional Windows console that observes typed host activity without carrying host input. */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { win32 } from 'node:path';

export interface WindowsHostObserver {
  show(message: string): void;
  finish(): void;
}

const CONNECTION_WINDOW_MS = 12_000;
const MAX_LINES = 128;

/** Accepts only short status lines composed by HostClient. The observer cannot call the host. */
export function openWindowsHostObserver(): WindowsHostObserver | null {
  if (process.platform !== 'win32' || process.env['CLU_SHOW_HOST_CONSOLE'] !== '1') return null;
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) return null;
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  const pipeName = `clue-host-view-${randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const server = createServer({ pauseOnConnect: true });
  server.maxConnections = 1;
  const queue: string[] = [];
  let viewer: Socket | null = null;
  let finished = false;
  let lines = 0;

  const waitForViewer = setTimeout(() => server.close(), CONNECTION_WINDOW_MS).unref();
  server.on('error', () => clearTimeout(waitForViewer));
  server.once('connection', (socket) => {
    clearTimeout(waitForViewer);
    viewer = socket.unref();
    socket.on('error', () => { viewer = null; });
    socket.on('close', () => { viewer = null; });
    server.close();
    socket.write(queue.join(''));
    queue.length = 0;
    if (finished) socket.end();
  });

  server.listen(pipePath, () => {
    const display = encodedPowerShell(`
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'CLU-E - PowerShell Host Activity'
Write-Host 'CLU-E PowerShell host activity'
Write-Host 'Typed requests and validated results. Press Enter after the session ends.'
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}', [System.IO.Pipes.PipeDirection]::In)
try {
  $pipe.Connect(8000)
  $reader = [System.IO.StreamReader]::new($pipe)
  while ($null -ne ($line = $reader.ReadLine())) { Write-Host $line }
} catch {
  Write-Host 'The CLU-E activity display disconnected.'
} finally {
  $pipe.Dispose()
}
[void] (Read-Host 'Press Enter to close')
`);
    const launcher = encodedPowerShell(`$ErrorActionPreference = 'Stop'; Start-Process -FilePath ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', '${display}') -WindowStyle Normal`);
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', launcher], {
      env: environment,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => server.close());
    child.unref();
  });
  server.unref();

  return {
    show(message) {
      if (finished || lines >= MAX_LINES) return;
      lines += 1;
      const line = `${new Date().toISOString().slice(11, 19)}Z  ${message}\n`;
      if (viewer === null) queue.push(line);
      else viewer.write(line);
    },
    finish() {
      finished = true;
      viewer?.end();
    },
  };
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
