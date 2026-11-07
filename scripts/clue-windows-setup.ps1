$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-ClueNode {
    param([string[]] $Arguments, [string] $ApiKey = '', [switch] $Background)

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $script:NodePath
    $start.WorkingDirectory = $script:RepoRoot
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $null = $start.Environment.Remove('OPENAI_API_KEY')
    if ($ApiKey.Length -gt 0) { $start.Environment['OPENAI_API_KEY'] = $ApiKey }
    try { $process = [System.Diagnostics.Process]::Start($start) }
    finally { $null = $start.Environment.Remove('OPENAI_API_KEY') }
    if ($Background) { return $process }
    try {
        $process.WaitForExit()
        return $process.ExitCode
    }
    finally { $process.Dispose() }
}

function Clear-SupervisorSettings {
    foreach ($name in @('CLU_WINDOWS_SUPERVISOR_PATH', 'CLU_WINDOWS_SUPERVISOR_SHA256',
        'CLU_WINDOWS_SUPERVISOR_QUALIFICATION', 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256')) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
}

function Test-DashboardPort {
    $client = [System.Net.Sockets.TcpClient]::new()
    try { return $client.ConnectAsync('127.0.0.1', 47900).Wait(500) -and $client.Connected }
    catch { return $false }
    finally { $client.Dispose() }
}

if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows) {
    Write-Host 'Run CLUE-Windows-Setup.bat on native Windows with PowerShell 7.'
    exit 2
}

$key = ''
$supervisorReady = $false
$dashboard = $null
try {
    $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    Set-Location -LiteralPath $RepoRoot
    $script:NodePath = (Get-Command node.exe -CommandType Application).Source
    $evidence = Join-Path (Split-Path -Parent $RepoRoot) 'release-evidence'
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
    $canaries = Join-Path $evidence "P2_WINDOWS_SUPERVISOR_$stamp.json"
    $gateway = Join-Path $evidence "P2_LEGACY_GATEWAY_$stamp.json"
    $readiness = Join-Path $evidence "P2_WINDOWS_READINESS_$stamp.json"

    # This is a new launcher process. Avoid forwarding inherited secrets to npm or tools.
    Remove-Item -LiteralPath Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
    $supervisor = $env:CLU_WINDOWS_SUPERVISOR_PATH
    $digest = $env:CLU_WINDOWS_SUPERVISOR_SHA256
    $existingReceipt = $env:CLU_WINDOWS_SUPERVISOR_QUALIFICATION
    $existingReceiptDigest = $env:CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256
    Clear-SupervisorSettings
    $env:CLU_SHOW_HOST_CONSOLE = '1'
    $env:CLU_PROOF_VISIBLE = '1'

    Write-Host '[1/5] Building CLU-E and preparing the configured shadow directory.'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Check dependencies and the errors above.' }
    if ((Invoke-ClueNode @('tools/p2-windows-setup.mjs', 'prepare')) -ne 0) {
        throw 'Shadow or evidence directory preparation failed.'
    }

    Write-Host '[2/5] Checking the native supervisor.'
    if ($supervisor -and $digest) {
        $reuse = Read-Host 'Use the supervisor path and independent SHA-256 pin supplied by your launcher? [y/N]'
        if ($reuse -notmatch '^(y|yes)$') {
            $supervisor = $null; $digest = $null
            $existingReceipt = $null; $existingReceiptDigest = $null
        }
    }
    if (!$supervisor -or !$digest) {
        $supervisor = Read-Host 'Absolute path of a separately supplied CLU-E supervisor .exe, or Enter to skip'
        $digest = if ($supervisor) { Read-Host 'Expected SHA-256 from its trusted release record' } else { $null }
    }
    if ($supervisor -and $digest) {
        $env:CLU_WINDOWS_SUPERVISOR_PATH = $supervisor.Trim().Trim('"')
        $env:CLU_WINDOWS_SUPERVISOR_SHA256 = $digest.Trim().ToLowerInvariant()
        if ((Invoke-ClueNode @('tools/p2-windows-setup.mjs', 'pin')) -eq 0) {
            if ($existingReceipt -and $existingReceiptDigest) {
                $env:CLU_WINDOWS_SUPERVISOR_QUALIFICATION = $existingReceipt
                $env:CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256 = $existingReceiptDigest
                $supervisorReady = (Invoke-ClueNode @('tools/p2-windows-setup.mjs', 'receipt')) -eq 0
            }
            $qualify = if (!$supervisorReady) { Read-Host 'Run the native containment canaries against this pinned executable? [y/N]' } else { '' }
            if ($qualify -match '^(y|yes)$') {
                if ((Invoke-ClueNode @('tools/p2-windows-supervisor-qualify.mjs', '--output', $canaries)) -eq 0 -and
                    (Test-Path -LiteralPath $canaries -PathType Leaf)) {
                    $env:CLU_WINDOWS_SUPERVISOR_QUALIFICATION = $canaries
                    $env:CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256 = (Get-FileHash -LiteralPath $canaries -Algorithm SHA256).Hash.ToLowerInvariant()
                    $supervisorReady = (Invoke-ClueNode @('tools/p2-windows-setup.mjs', 'receipt')) -eq 0
                    if ($supervisorReady) { Write-Host "Native canaries passed. Receipt $canaries" }
                }
            }
        }
    }
    if (!$supervisorReady) {
        Write-Host 'Native proof is blocked pending a trusted compatible supervisor and a passing qualification receipt.'
    }

    Write-Host '[3/5] Checking legacy clu OpenAI model access.'
    $secret = Read-Host 'Paste the legacy OPENAI_API_KEY into this masked prompt, or Enter to skip' -AsSecureString
    try {
        if ($secret.Length -gt 0) {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
            try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim() }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        }
    }
    finally { $secret.Dispose() }
    $gatewayCode = Invoke-ClueNode @('tools/p2-windows-setup.mjs', 'gateway', $gateway) -ApiKey $key
    if (Test-Path -LiteralPath $gateway -PathType Leaf) { Write-Host "OpenAI check report $gateway" }

    Write-Host '[4/5] Collecting the Windows readiness report.'
    $readinessCode = Invoke-ClueNode @('tools/p2-windows-readiness-probe.mjs', '--output', $readiness) -ApiKey $key
    if (Test-Path -LiteralPath $readiness -PathType Leaf) { Write-Host "Windows readiness report $readiness" }
    if (!$supervisorReady) { Clear-SupervisorSettings }
    if ($gatewayCode -ne 0) { $key = '' }

    Write-Host '[5/5] Dashboard.'
    $open = Read-Host 'Open the CLU-E dashboard with visible host operations? [y/N]'
    if ($open -match '^(y|yes)$') {
        if (Test-DashboardPort) { throw 'Port 47900 is in use. Close the previous dashboard and run setup again.' }
        if ((Invoke-ClueNode @('dist/src/cli/index.js', 'init')) -ne 0) { throw 'Workspace initialization failed.' }
        $dashboard = Invoke-ClueNode @('dist/src/cli/index.js', 'console', 'dashboard', '--port', '47900') -ApiKey $key -Background
        $key = ''
        for ($attempt = 0; $attempt -lt 40 -and !$dashboard.HasExited; $attempt++) {
            if (Test-DashboardPort) {
                Start-Process 'http://127.0.0.1:47900/'
                break
            }
            Start-Sleep -Milliseconds 200
        }
        Write-Host 'Dashboard output stays in this window. Use Ctrl+C to stop.'
        $dashboard.WaitForExit()
        if ($dashboard.ExitCode -ne 0) { throw 'Dashboard exited with an error.' }
    }
    if (!$supervisorReady -or $gatewayCode -ne 0 -or $readinessCode -ne 0) { exit 1 }
    exit 0
}
catch {
    Write-Host "Windows setup stopped. $($_.Exception.Message)"
    exit 2
}
finally {
    $key = ''
    if ($null -ne $dashboard) {
        try { if (!$dashboard.HasExited) { $dashboard.Kill($true) } }
        finally { $dashboard.Dispose() }
    }
    Clear-SupervisorSettings
}
