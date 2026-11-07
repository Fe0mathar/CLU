/** Project-scoped OpenAI credentials managed by the interactive Windows user. */

import { execFile, spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

import { projectIdSchema } from '../../shared/schemas.js';

const REFERENCE_PREFIX = 'credential-store:CLU-E/OpenAI/';
const TARGET_PREFIX = 'CLU-E/OpenAI/';
const MAX_SECRET_LENGTH = 1280;
const NATIVE_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 120_000;
const PRESENT_TTL_MS = 30_000;
const MISSING_TTL_MS = 2_000;

const NATIVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;

public static class ClueOpenAiCredential
{
    private const uint Generic = 1;
    private const uint PersistOnThisComputer = 2;
    private const int NotFound = 1168;
    private const int MaxBlobSize = 2560;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredReadW(string targetName, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr buffer);

    public static bool Save(string target, SecureString secret)
    {
        if (secret.Length < 8 || secret.Length * 2 > MaxBlobSize) return false;
        IntPtr blob = Marshal.SecureStringToBSTR(secret);
        try
        {
            for (int offset = 0; offset < secret.Length * 2; offset += 2)
            {
                short character = Marshal.ReadInt16(blob, offset);
                if (character < 33 || character > 126) return false;
            }
            Credential credential = new Credential {
                Type = Generic,
                TargetName = target,
                UserName = "OpenAI",
                Persist = PersistOnThisComputer,
                CredentialBlob = blob,
                CredentialBlobSize = (uint)(secret.Length * 2)
            };
            if (!CredWriteW(ref credential, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return true;
        }
        finally { Marshal.ZeroFreeBSTR(blob); }
    }

    public static int Read(string target, bool sendSecret)
    {
        IntPtr result;
        if (!CredReadW(target, Generic, 0, out result))
            return Marshal.GetLastWin32Error() == NotFound ? 11 : 20;
        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(result, typeof(Credential));
            int size = (int)credential.CredentialBlobSize;
            if (size < 16 || size > MaxBlobSize || size % 2 != 0 || credential.CredentialBlob == IntPtr.Zero)
                return 20;
            try
            {
                for (int offset = 0; offset < size; offset += 2)
                {
                    short character = Marshal.ReadInt16(credential.CredentialBlob, offset);
                    if (character < 33 || character > 126) return 20;
                }
                if (sendSecret)
                {
                    byte[] bytes = new byte[size];
                    try
                    {
                        Marshal.Copy(credential.CredentialBlob, bytes, 0, size);
                        using (Stream pipe = Console.OpenStandardOutput())
                        {
                            pipe.Write(bytes, 0, bytes.Length);
                            pipe.Flush();
                        }
                    }
                    finally { Array.Clear(bytes, 0, bytes.Length); }
                }
                return 0;
            }
            finally
            {
                for (int offset = 0; offset < size; offset++)
                    Marshal.WriteByte(credential.CredentialBlob, offset, 0);
            }
        }
        finally { CredFree(result); }
    }
}
'@

    if ($operation -eq 'read') { exit ([ClueOpenAiCredential]::Read($target, $true)) }
    if ($operation -eq 'present') { exit ([ClueOpenAiCredential]::Read($target, $false)) }
    if ($operation -ne 'prompt' -or -not [Environment]::UserInteractive) { exit 20 }

    Add-Type -AssemblyName PresentationFramework
    $dialog = New-Object System.Windows.Window
    $dialog.Title = 'CLU-E OpenAI API key'
    $dialog.SizeToContent = 'WidthAndHeight'
    $dialog.ResizeMode = 'NoResize'
    $dialog.WindowStartupLocation = 'CenterScreen'
    $dialog.Topmost = $true
    $panel = New-Object System.Windows.Controls.StackPanel
    $panel.Width = 420
    $panel.Margin = '20'
    $dialog.Content = $panel
    $label = New-Object System.Windows.Controls.TextBlock
    $label.Text = "Enter the OpenAI API key for project $projectId."
    $label.TextWrapping = 'Wrap'
    [void] $panel.Children.Add($label)
    $password = New-Object System.Windows.Controls.PasswordBox
    $password.MaxLength = 1280
    $password.Margin = '0,10,0,6'
    [void] $panel.Children.Add($password)
    $message = New-Object System.Windows.Controls.TextBlock
    $message.TextWrapping = 'Wrap'
    [void] $panel.Children.Add($message)
    $buttons = New-Object System.Windows.Controls.StackPanel
    $buttons.Orientation = 'Horizontal'
    $buttons.HorizontalAlignment = 'Right'
    $buttons.Margin = '0,12,0,0'
    [void] $panel.Children.Add($buttons)
    $cancel = New-Object System.Windows.Controls.Button
    $cancel.Content = 'Cancel'
    $cancel.IsCancel = $true
    $cancel.Padding = '10,4'
    [void] $buttons.Children.Add($cancel)
    $save = New-Object System.Windows.Controls.Button
    $save.Content = 'Save key'
    $save.IsDefault = $true
    $save.Margin = '8,0,0,0'
    $save.Padding = '10,4'
    [void] $buttons.Children.Add($save)
    $save.Add_Click({
        $secret = $password.SecurePassword
        try {
            if ([ClueOpenAiCredential]::Save($target, $secret)) {
                $password.Clear()
                $dialog.DialogResult = $true
            } else {
                $message.Text = 'Enter a valid API key without spaces or line breaks.'
                [void] $password.Focus()
            }
        } catch {
            $message.Text = 'Windows could not save the key to Credential Manager.'
        } finally {
            $secret.Dispose()
        }
    })
    $dialog.Add_Loaded({ [void] $password.Focus() })
    try { $accepted = $dialog.ShowDialog() }
    finally { $password.Clear() }
    if ($accepted -eq $true) { exit 0 }
    exit 10
} catch {
    exit 20
}
`;

type Operation = 'prompt' | 'present' | 'read';
type PromptState = 'stored' | 'cancelled' | 'unsupported' | 'failed';

export interface WindowsOpenAiCredentialPrompt {
  readonly state: PromptState;
  readonly credentialReference: string;
}

export function windowsOpenAiCredentialReference(projectId: string): string {
  return REFERENCE_PREFIX + projectIdSchema.parse(projectId);
}

function invocation(operation: Operation, projectId: string) {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  if (!/^[A-Za-z]:\\/u.test(systemRoot)) return null;
  const system32 = win32.join(systemRoot, 'System32');
  const cwd = win32.join(system32, 'WindowsPowerShell', 'v1.0');
  const script = [
    `$operation = '${operation}'`,
    `$projectId = '${projectIdSchema.parse(projectId)}'`,
    `$target = '${TARGET_PREFIX}' + $projectId`,
    NATIVE_SCRIPT,
  ].join('\n');
  const env: NodeJS.ProcessEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, Path: `${system32};${cwd}` };
  for (const name of ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USERDOMAIN']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    executable: win32.join(cwd, 'powershell.exe'),
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    options: { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 },
  };
}

let promptOpen = false;

const credentialCache = new Map<string, {
  readonly value: string | null | undefined;
  readonly expiration: NodeJS.Timeout;
}>();

function forgetCredential(projectId: string): void {
  const prior = credentialCache.get(projectId);
  if (prior === undefined) return;
  clearTimeout(prior.expiration);
  credentialCache.delete(projectId);
}

/** Undefined represents presence verified without reading the credential bytes. */
function rememberCredential(projectId: string, value: string | null | undefined): void {
  forgetCredential(projectId);
  const ttl = value === null ? MISSING_TTL_MS : PRESENT_TTL_MS;
  const expiration = setTimeout(() => credentialCache.delete(projectId), ttl).unref();
  credentialCache.set(projectId, { value, expiration });
}

export async function promptWindowsOpenAiCredential(projectId: string): Promise<WindowsOpenAiCredentialPrompt> {
  const credentialReference = windowsOpenAiCredentialReference(projectId);
  if (process.platform !== 'win32') return { state: 'unsupported', credentialReference };
  const command = invocation('prompt', projectId);
  if (command === null || promptOpen) return { state: 'failed', credentialReference };
  promptOpen = true;
  try {
    const state = await new Promise<PromptState>((resolve) => {
      execFile(command.executable, command.args, { ...command.options, timeout: PROMPT_TIMEOUT_MS }, (error) => {
        resolve(error === null ? 'stored' : error.code === 10 ? 'cancelled' : 'failed');
      });
    });
    if (state === 'stored') forgetCredential(projectId);
    return { state, credentialReference };
  } catch {
    return { state: 'failed', credentialReference };
  } finally {
    promptOpen = false;
  }
}

function readNative(operation: 'read' | 'present', projectId: string) {
  if (process.platform !== 'win32') return null;
  const command = invocation(operation, projectId);
  if (command === null) return null;
  return spawnSync(command.executable, command.args, {
    ...command.options, timeout: NATIVE_TIMEOUT_MS,
  });
}

export function hasWindowsOpenAiCredential(projectId: string): boolean {
  const id = projectIdSchema.parse(projectId);
  if (process.platform !== 'win32') return false;
  const cached = credentialCache.get(id);
  if (cached !== undefined) return cached.value !== null;
  const result = readNative('present', id);
  const present = result?.status === 0 && result.error === undefined;
  rememberCredential(id, present ? undefined : null);
  return present;
}

/** Only use this value in the host gateway, never in HTTP responses or persisted data. */
export function readWindowsOpenAiCredential(reference: string): string | null {
  if (process.platform !== 'win32' || !reference.startsWith(REFERENCE_PREFIX)) return null;
  const parsed = projectIdSchema.safeParse(reference.slice(REFERENCE_PREFIX.length));
  if (!parsed.success) return null;
  const projectId = parsed.data;
  const cached = credentialCache.get(projectId);
  if (cached?.value !== undefined) return cached.value;
  const value = readCredentialValue(projectId);
  rememberCredential(projectId, value);
  return value;
}

function readCredentialValue(projectId: string): string | null {
  const result = readNative('read', projectId);
  const secret = result?.stdout;
  if (!secret) return null;
  try {
    if (result?.status !== 0 || result.error !== undefined ||
        secret.length < 16 || secret.length > MAX_SECRET_LENGTH * 2 || secret.length % 2 !== 0) return null;
    const key = secret.toString('utf16le');
    return /^[\x21-\x7e]+$/u.test(key) ? key : null;
  } finally {
    secret.fill(0);
  }
}
