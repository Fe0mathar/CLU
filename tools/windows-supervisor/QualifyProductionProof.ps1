[CmdletBinding()]
param([string] $AdmissionReport)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$admissionName = 'CLU-E_WINDOWS_PRODUCTION_ADMISSION_20261108-230639-951-0546a7ce.json'
$admissionSha = '9a21107eb79256a9c029b0b2af563a337ed5717bad6ee1d8f7042841e06ceb12'
$wrapperSha = '505ba70cb3068c211680dc9e2f37380cb9fa46f68c2df00886007bcf6459ccbc'
$engineSha = '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a'
$nodeSha = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'
$npmSha = '3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e'
$preludeSha = '334ca86fb237c565f38b17a7b84485c5fc1b603d1b16e07a68a3278cf42a37e9'
$qualifierSha = '6b2016e57bb972f7a20e2c088acd9d6d8c28366a2556b255003dc52a567913b9'
$qualifierCrlfSha = '4dae155f83a3cca310b87dc842148ca09750c63ee0b8c15af8f71eb22b608a59'

function Assert-ExactPath([string] $Path, [bool] $Directory) {
    if ($Path.Length -gt 1024 -or $Path -cnotmatch '^[A-Za-z]:\\(?!\\)' -or
        [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'QUALIFY_PATH_NOT_CANONICAL' }
    $root = [IO.Path]::GetPathRoot($Path)
    $drive = [IO.DriveInfo]::new($root)
    if (!$drive.IsReady -or $drive.DriveType -notin @('Fixed', 'Removable')) { throw 'QUALIFY_LOCAL_DRIVE_REQUIRED' }
    $parts = $Path.Substring($root.Length).Split('\')
    $current = $root
    for ($index = 0; $index -lt $parts.Length; $index++) {
        $part = $parts[$index]
        if (!$part -or $part -match '[ .]$|[<>:"|?*\x00-\x1f]|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)') {
            throw 'QUALIFY_PATH_COMPONENT_INVALID'
        }
        $current = Join-Path $current $part
        $item = Get-Item -LiteralPath $current -Force
        $mustBeDirectory = $index -lt $parts.Length - 1 -or $Directory
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $mustBeDirectory) {
            throw 'QUALIFY_PATH_IDENTITY_INVALID'
        }
    }
}

function Assert-ExternalPath([string] $Path, [string] $ProjectRoot, [string] $ProgramFiles) {
    foreach ($root in @($ProjectRoot, $ProgramFiles)) {
        if ($Path.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
            $Path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'QUALIFY_EXTERNAL_EVIDENCE_REQUIRED'
        }
    }
}

function Get-Digest([IO.Stream] $Stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Open-PinnedFile([string] $Path, [string] $ExpectedSha, [long] $MaximumBytes) {
    Assert-ExactPath $Path $false
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes -or (Get-Digest $stream) -cne $ExpectedSha) {
            throw 'QUALIFY_FILE_PIN_MISMATCH'
        }
        $stream.Position = 0
        return $stream
    } catch {
        $stream.Dispose()
        throw
    }
}

function Read-Json([IO.Stream] $Stream) {
    $Stream.Position = 0
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $reader = [IO.StreamReader]::new($Stream, $encoding, $true, 4096, $true)
    try { return ConvertFrom-Json -InputObject ($reader.ReadToEnd()) -AsHashtable -Depth 48 }
    finally { $reader.Dispose() }
}

function Assert-ProtectedRoot([string] $Path, [string] $OperatorSid) {
    Assert-ExactPath $Path $true
    $section = [Security.AccessControl.AccessControlSections]::Access
    $security = [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($Path), $section)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
    $dacl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;RC;;;OW)(A;OICI;0x1200a9;;;$OperatorSid)"
    $expected = [Security.AccessControl.RawSecurityDescriptor]::new($dacl).DiscretionaryAcl
    $actual = $descriptor.DiscretionaryAcl
    if (!$security.AreAccessRulesProtected -or $null -eq $actual -or $actual.Count -ne $expected.Count) {
        throw 'QUALIFY_PROTECTED_ACL_INVALID'
    }
    $bySid = @{}
    foreach ($ace in $expected) { $bySid.Add($ace.SecurityIdentifier.Value, $ace) }
    foreach ($ace in $actual) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or
            $ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.IsCallback -or $ace.OpaqueLength -ne 0) {
            throw 'QUALIFY_PROTECTED_ACL_INVALID'
        }
        $sid = $ace.SecurityIdentifier.Value
        if (!$bySid.ContainsKey($sid) -or $ace.AccessMask -ne $bySid[$sid].AccessMask -or $ace.AceFlags -ne $bySid[$sid].AceFlags) {
            throw 'QUALIFY_PROTECTED_ACL_INVALID'
        }
        $bySid.Remove($sid)
    }
}

function Assert-InstalledPair([string] $Root, [string] $OperatorSid, [string] $Image, [string] $Engine, [string] $Prelude) {
    Assert-ProtectedRoot $Root $OperatorSid
    Assert-ExactPath (Join-Path $Root 'runs') $true
    Assert-ExactPath $Image $false
    Assert-ExactPath $Engine $false
    Assert-ExactPath $Prelude $false
    $entries = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($Image)) -Force)
    if ($entries.Count -ne 2 -or $entries.Name -cnotcontains 'CLU-E-Windows-Supervisor.exe' -or
        $entries.Name -cnotcontains 'wxc-exec.exe') { throw 'QUALIFY_INSTALLED_PAIR_INVALID' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Engine
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation') {
        throw 'QUALIFY_ENGINE_SIGNATURE_INVALID'
    }
}

$locks = [Collections.Generic.List[IO.Stream]]::new()
$guardian = $null
$qualifier = $null
$output = $null
$result = 2
$phase = 'QUALIFY_PREFLIGHT_UNVERIFIED'
try {
    if (!$IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::UserInteractive) {
        throw 'QUALIFY_INTERACTIVE_WINDOWS_REQUIRED'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $operatorSid = $identity.User.Value
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'QUALIFY_STANDARD_SESSION_REQUIRED'
        }
    } finally { $identity.Dispose() }
    $sessionId = (Get-Process -Id $PID).SessionId
    if ($sessionId -le 0) { throw 'QUALIFY_STANDARD_SESSION_REQUIRED' }

    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    $evidence = Join-Path ([IO.Path]::GetDirectoryName($repo)) 'release-evidence'
    $phase = 'QUALIFY_ADMISSION_REPORT_UNVERIFIED'
    Assert-ExactPath $repo $true
    Assert-ExactPath $programFiles $true
    Assert-ExactPath $evidence $true
    Assert-ExternalPath $evidence $repo $programFiles
    if (!$AdmissionReport) { $AdmissionReport = Join-Path $evidence $admissionName }
    Assert-ExternalPath $AdmissionReport $repo $programFiles
    $admissionStream = Open-PinnedFile $AdmissionReport $admissionSha 1MB
    try { $admission = Read-Json $admissionStream }
    finally { $admissionStream.Dispose() }
    $install = $admission['installation']
    $observed = $admission['productionAdmission']
    $pair = $observed['installedImage']
    if ($admission['schemaVersion'] -cne 'clue-windows-production-admission/1' -or
        $admission['state'] -cne 'PRODUCTION_ADMISSION_OBSERVED' -or $admission['proofAuthorization'] -ne $false -or
        $admission['executionEnvironment'] -cne 'WINDOWS_HOST' -or
        $admission['cleanup'] -cne 'REMOVED' -or $admission['diagnosticStageRetained'] -ne $false -or
        $admission['workloadExitCode'] -ne 0 -or $admission['supervisorSha256'] -cne $wrapperSha -or
        $admission['engineSha256'] -cne $engineSha -or $admission['nodeSha256'] -cne $nodeSha -or
        $admission['npmCliSha256'] -cne $npmSha -or $admission['productionPreludeSha256'] -cne $preludeSha -or
        $install['layout'] -cne 'PROGRAM_FILES_PRODUCTION_PROOF_CONTENT_ADDRESSED' -or
        $install['state'] -cne 'VERIFIED' -or $install['cleanup'] -cne 'RETAINED_PROTECTED_AUDIT' -or
        $install['wrapperSha256'] -cne $wrapperSha -or $install['engineSha256'] -cne $engineSha -or
        $install['verifiedBefore'] -ne $true -or $install['verifiedAfter'] -ne $true -or
        $observed['schemaVersion'] -cne 'clue-windows-production-admission/1' -or
        $observed['state'] -cne 'PRODUCTION_ADMISSION_OBSERVED' -or $observed['proofAuthorization'] -ne $false -or
        $observed['stageCleanupSafe'] -ne $true -or $pair['wrapperSha256'] -cne $wrapperSha -or
        $pair['engineSha256'] -cne $engineSha -or $pair['verifiedBefore'] -ne $true -or $pair['verifiedAfter'] -ne $true) {
        throw 'QUALIFY_ADMISSION_REPORT_UNVERIFIED'
    }

    $phase = 'QUALIFY_INSTALLED_IMAGE_UNVERIFIED'
    $image = $install['wrapperPath']
    $digestFolder = [IO.Path]::GetDirectoryName($image)
    $protectedRoot = [IO.Path]::GetDirectoryName($digestFolder)
    $leaf = [IO.Path]::GetFileName($protectedRoot)
    if ($leaf -cnotmatch '^\.clue-proof-production-[a-f0-9]{32}$' -or
        ![IO.Path]::GetDirectoryName($protectedRoot).Equals($programFiles, [StringComparison]::OrdinalIgnoreCase) -or
        $image -cne (Join-Path (Join-Path $protectedRoot $wrapperSha) 'CLU-E-Windows-Supervisor.exe')) {
        throw 'QUALIFY_INSTALLED_IMAGE_PATH_INVALID'
    }
    $engine = Join-Path $digestFolder 'wxc-exec.exe'
    $prelude = Join-Path $protectedRoot 'production-bind-prelude.cjs'
    Assert-InstalledPair $protectedRoot $operatorSid $image $engine $prelude
    $imageLock = Open-PinnedFile $image $wrapperSha 16MB
    $locks.Add($imageLock)
    $engineLock = Open-PinnedFile $engine $engineSha 768MB
    $locks.Add($engineLock)
    $preludeLock = Open-PinnedFile $prelude $preludeSha 1MB
    $locks.Add($preludeLock)

    $phase = 'QUALIFY_NODE_INSTALLATION_UNVERIFIED'
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $locks.Add((Open-PinnedFile $node $nodeSha 256MB))
    $npm = Join-Path ([IO.Path]::GetDirectoryName($node)) 'node_modules\npm\bin\npm-cli.js'
    $locks.Add((Open-PinnedFile $npm $npmSha 1MB))

    $phase = 'QUALIFY_CANARY_SOURCE_PATH_INVALID'
    $script = Join-Path $repo 'tools\p2-windows-supervisor-qualify-06h2.mjs'
    Assert-ExactPath $script $false
    $phase = 'QUALIFY_CANARY_SOURCE_OPEN_FAILED'
    $scriptLock = [IO.File]::Open($script, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $locks.Add($scriptLock)
    if ($scriptLock.Length -lt 1 -or $scriptLock.Length -gt 1MB) { throw 'QUALIFY_CANARY_SOURCE_SIZE_INVALID' }
    $phase = 'QUALIFY_CANARY_SOURCE_HASH_READ_FAILED'
    $scriptDigest = Get-Digest $scriptLock
    if ($scriptDigest -cne $qualifierSha -and $scriptDigest -cne $qualifierCrlfSha) {
        Write-Host "Qualification source SHA-256: $scriptDigest"
        throw 'QUALIFY_CANARY_SOURCE_PIN_MISMATCH'
    }
    $phase = 'QUALIFY_BUILD_REQUIRED'
    foreach ($file in @('windowsExecutionSupervisor.js', 'containedProcess.js', 'windowsSupervisorQualification.js')) {
        if (!(Test-Path -LiteralPath (Join-Path $repo "dist\src\benchmark\$file") -PathType Leaf)) {
            throw 'QUALIFY_BUILD_REQUIRED'
        }
    }

    $phase = 'QUALIFY_PRODUCTION_SESSION_UNVERIFIED'
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class ClueProductionQualificationPipe {
    [DllImport("kernel32.dll", EntryPoint = "WaitNamedPipeW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WaitNamedPipe(string name, uint milliseconds);
    public static int State(string name, uint milliseconds) {
        return WaitNamedPipe(name, milliseconds) ? 0 : Marshal.GetLastWin32Error();
    }
}
'@
    $pipe = "\\.\pipe\CLU-E-Production-Proof-$leaf-$sessionId"
    # Error 2 means the exact local pipe does not yet exist.
    if ([ClueProductionQualificationPipe]::State($pipe, 1) -ne 2) { throw 'QUALIFY_PRODUCTION_SESSION_ALREADY_PRESENT' }
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match '^(COR_|CORECLR_|COMPLUS_|DOTNET_|APPDOMAIN_MANAGER_|DEVPATH$|__COMPAT_LAYER$|OPENAI_API_KEY$)') {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        }
    }
    Write-Host 'Approve the Windows prompt for the verified CLU-E production supervisor using your current Windows account.'
    $originalPath = $env:PATH
    try {
        $systemDirectory = [Environment]::SystemDirectory
        $env:PATH = "$systemDirectory;$([IO.Path]::GetDirectoryName($systemDirectory))"
        $launch = @{
            FilePath = $image
            WorkingDirectory = $digestFolder
            Verb = 'RunAs'
            PassThru = $true
            WindowStyle = 'Hidden'
            ArgumentList = @('--production-session', $PID.ToString([Globalization.CultureInfo]::InvariantCulture))
        }
        $guardian = Start-Process @launch
    } catch { throw 'QUALIFY_PRODUCTION_SESSION_LAUNCH_FAILED' }
    finally { $env:PATH = $originalPath }
    $wait = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($null -eq $guardian -or $guardian.HasExited) { throw 'QUALIFY_PRODUCTION_SESSION_EXITED' }
        $listening = [ClueProductionQualificationPipe]::State($pipe, 100) -eq 0
        if (!$listening) { Start-Sleep -Milliseconds 75 }
    } while (!$listening -and $wait.ElapsedMilliseconds -lt 10000)
    if (!$listening -or $guardian.HasExited) { throw 'QUALIFY_PRODUCTION_SESSION_NOT_READY' }

    $phase = 'QUALIFY_CANARY_RUN_UNVERIFIED'
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff', [Globalization.CultureInfo]::InvariantCulture)
    $output = Join-Path $evidence "P2_WINDOWS_SUPERVISOR_QUALIFICATION_$stamp-$([Guid]::NewGuid().ToString('N')).json"
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.WorkingDirectory = $repo
    $start.UseShellExecute = $false
    foreach ($arg in @($script, '--output', $output)) { $start.ArgumentList.Add($arg) }
    foreach ($name in @('OPENAI_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_V8_COVERAGE',
            'CLU_WINDOWS_SUPERVISOR_QUALIFICATION', 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256')) {
        $null = $start.Environment.Remove($name)
    }
    $start.Environment['CLU_WINDOWS_SUPERVISOR_PATH'] = $image
    $start.Environment['CLU_WINDOWS_SUPERVISOR_SHA256'] = $wrapperSha
    Write-Host 'Running the native proof supervisor canaries in the current Windows session.'
    $qualifier = [Diagnostics.Process]::Start($start)
    if ($null -eq $qualifier) { throw 'QUALIFY_CANARY_LAUNCH_FAILED' }
    if (!$qualifier.WaitForExit(240000)) {
        try { $qualifier.Kill() } catch { }
        throw 'QUALIFY_CANARY_DEADLINE'
    }

    $phase = 'QUALIFY_INSTALLED_IMAGE_AFTER_RUN_UNVERIFIED'
    Assert-InstalledPair $protectedRoot $operatorSid $image $engine $prelude
    if ((Get-Digest $imageLock) -cne $wrapperSha -or (Get-Digest $engineLock) -cne $engineSha -or
        (Get-Digest $preludeLock) -cne $preludeSha -or $guardian.HasExited) {
        throw 'QUALIFY_INSTALLED_IMAGE_AFTER_RUN_UNVERIFIED'
    }
    $phase = 'QUALIFY_CANARY_REPORT_UNVERIFIED'
    Assert-ExactPath $output $false
    $reportStream = [IO.File]::Open($output, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($reportStream.Length -lt 1 -or $reportStream.Length -gt 1MB) { throw 'QUALIFY_CANARY_REPORT_UNVERIFIED' }
        $report = Read-Json $reportStream
        if ($report['schemaVersion'] -cne 'clue-console-probe-native-supervisor/1') { throw 'QUALIFY_CANARY_REPORT_UNVERIFIED' }
        $receiptDigest = Get-Digest $reportStream
    } finally { $reportStream.Dispose() }
    Write-Host "Qualification report SHA-256: $receiptDigest"
    if ($qualifier.ExitCode -eq 0) {
        if ($report['canaryStatus'] -cne 'PASS' -or $report['fixtureRemoved'] -ne $true -or
            $report['status'] -cne 'MEASUREMENT_PENDING' -or $report['blocker'] -ne $null -or
            $report['supervisorSha256'] -cne $wrapperSha -or $report['host']['nodeSha256'] -cne $nodeSha -or
            $report['cases']['measurement-parity'] -cne 'NOT_EXECUTED') { throw 'QUALIFY_CANARY_REPORT_UNVERIFIED' }
        foreach ($id in @('allowed-command', 'filesystem-denied', 'secrets-denied', 'network-denied',
                'descendant-timeout', 'launcher-cancellation', 'tamper-refused')) {
            if ($report['cases'][$id] -cne 'PASS') { throw 'QUALIFY_CANARY_REPORT_UNVERIFIED' }
        }
        Write-Host 'Native canaries passed. Formal closure evidence is evaluated separately.'
        $result = 0
    } else {
        Write-Host 'Native canaries did not pass. The report contains the observed results.'
        $result = 1
    }
} catch {
    $code = $_.Exception.Message
    if ($code -cnotmatch '^QUALIFY_[A-Z0-9_]{1,72}$') { $code = $phase }
    Write-Host "CLU-E supervisor qualification stopped: $code"
    if ($code -eq 'QUALIFY_STANDARD_SESSION_REQUIRED') { Write-Host 'Run the launcher from your normal Windows session.' }
    if ($code -eq 'QUALIFY_BUILD_REQUIRED') { Write-Host 'Run npm run build in the CLU-E project, then reopen this launcher.' }
} finally {
    if ($null -ne $output -and (Test-Path -LiteralPath $output -PathType Leaf)) {
        Write-Host "Qualification report: $output"
    }
    if ($null -ne $qualifier) { $qualifier.Dispose() }
    if ($null -ne $guardian) { $guardian.Dispose() }
    foreach ($lock in $locks) { $lock.Dispose() }
}
exit $result
