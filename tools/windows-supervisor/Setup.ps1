[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $EvidenceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-LocalPath([string] $Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/](?![\\/])') { throw "Use an absolute local Windows path: $Path" }
    $parts = $Path.Substring(3).TrimEnd([char[]] '\/') -split '[\\/]'
    foreach ($part in $parts) {
        if (!$part -or $part -match '[ .]$|[<>:"|?*\x00-\x1f]|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)') {
            throw "Use canonical local path components: $Path"
        }
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
    if (!$drive.IsReady -or $drive.DriveType -notin @('Fixed', 'Removable')) { throw "Use an available local drive: $Path" }
    return $full
}

function Test-Inside([string] $Root, [string] $Path) {
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath([string] $Path, [switch] $CreateDirectory) {
    $root = [IO.Path]::GetPathRoot($Path)
    $current = $root
    $parts = $Path.Substring($root.Length) -split '\\'
    for ($index = 0; $index -lt $parts.Length; $index++) {
        $current = [IO.Path]::Combine($current, $parts[$index])
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -eq $item -and $CreateDirectory) {
            $null = [IO.Directory]::CreateDirectory($current)
            $item = Get-Item -LiteralPath $current -Force
        }
        if ($null -eq $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Path must exist without junctions or symbolic links: $current"
        }
        if (($CreateDirectory -or $index -lt $parts.Length - 1) -and !$item.PSIsContainer) {
            throw "Expected a directory: $current"
        }
    }
}

function Get-Sha256([string] $Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-MicrosoftSignature([string] $Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Microsoft Corporation') {
        throw 'Microsoft Authenticode validation failed for wxc-exec.exe.'
    }
}

function Invoke-ExactExecutable([string] $File, [string[]] $Arguments, [string] $WorkingDirectory, [int] $TimeoutSeconds = 0) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $File
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start)
    try {
        if ($TimeoutSeconds -eq 0) { $process.WaitForExit() }
        elseif (!$process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw "Timed out running $([IO.Path]::GetFileName($File))."
        }
        return $process.ExitCode
    } finally { $process.Dispose() }
}

function Get-MxcExecutable([string] $Arch, [string] $Stage, [string] $Destination) {
    $version = 'v1.0.1'
    $name = 'mxc-release-binaries.zip'
    $download = "https://github.com/microsoft/mxc/releases/download/$version/$name"
    $headers = @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/microsoft/mxc/releases/tags/$version" -Headers $headers -TimeoutSec 30
    $matchingAssets = @($release.assets | Where-Object { $_.name -ceq $name })
    if ($release.tag_name -cne $version -or $release.draft -or $release.prerelease -or $matchingAssets.Count -ne 1) {
        throw "GitHub did not return the official Microsoft MXC $version release asset."
    }
    $asset = $matchingAssets[0]
    if ($asset.state -cne 'uploaded' -or $asset.browser_download_url -cne $download -or
        $asset.digest -cnotmatch '^sha256:([a-f0-9]{64})$' -or $asset.size -le 0 -or $asset.size -gt 536870912) {
        throw 'GitHub release metadata did not provide an admissible asset URL, size and SHA-256.'
    }
    $archive = Join-Path $Stage $name
    Invoke-WebRequest -Uri $download -OutFile $archive -TimeoutSec 180
    $assetHash = $asset.digest.Substring(7)
    if ((Get-Item -LiteralPath $archive).Length -ne $asset.size -or (Get-Sha256 $archive) -cne $assetHash) {
        throw 'The downloaded MXC ZIP did not match its release size and SHA-256.'
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entries = @($zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -ceq "$Arch/wxc-exec.exe" })
        if ($entries.Count -ne 1 -or $entries[0].Length -le 0 -or $entries[0].Length -gt 134217728) {
            throw "The MXC release did not contain exactly one expected $Arch/wxc-exec.exe."
        }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $Destination, $false)
    } finally { $zip.Dispose() }
    Assert-MicrosoftSignature $Destination
    Write-Host "Verified Microsoft MXC $version archive SHA-256 $assetHash"
}

function Write-DiagnosticFile([string] $Path, [System.Collections.IDictionary] $Report) {
    $encoded = $Report | ConvertTo-Json -Depth 20
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($encoded + "`n")
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

$stage = $null
$report = $null
$mxcHash = $null
$windowsHost = $null
$setupStage = 'HOST_PREREQUISITES'
try {
    if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows) { throw 'Run this setup on native Windows with PowerShell 7.' }
    $repo = Get-LocalPath (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    Assert-NoReparsePath $repo
    if (!$InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'CLU-E\WindowsSupervisor' }
    if (!$EvidenceRoot) { $EvidenceRoot = Join-Path (Split-Path -Parent $repo) 'release-evidence' }
    $install = Get-LocalPath $InstallRoot
    $evidence = Get-LocalPath $EvidenceRoot
    if ((Test-Inside $repo $install) -or (Test-Inside $install $repo) -or
        (Test-Inside $repo $evidence) -or (Test-Inside $evidence $repo) -or
        (Test-Inside $install $evidence) -or (Test-Inside $evidence $install)) {
        throw 'Keep the project, supervisor installation and evidence in separate directories.'
    }
    Assert-NoReparsePath $evidence -CreateDirectory
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $report = Join-Path $evidence "CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_$stamp.json"
    Assert-NoReparsePath $install -CreateDirectory

    $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $windowsHost = [ordered]@{
        version = [Environment]::OSVersion.Version.ToString()
        updateBuildRevision = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name UBR -ErrorAction SilentlyContinue
        architecture = $arch
    }
    if ($arch -notin @('x64', 'arm64')) { throw 'Microsoft MXC requires a supported x64 or ARM64 Windows installation.' }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $nodeResult = @(& $node -p "require('node:fs').realpathSync.native(process.execPath)")
    if ($LASTEXITCODE -ne 0 -or $nodeResult.Count -ne 1) { throw 'Could not resolve the selected native Node executable.' }
    $node = Get-LocalPath $nodeResult[0]
    Assert-NoReparsePath $node
    $npm = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
    if (!(Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'Install Node.js with npm, then reopen this launcher.' }
    if (!(Test-Path -LiteralPath (Join-Path $repo 'node_modules\typescript\bin\tsc') -PathType Leaf)) {
        throw 'Run npm.cmd ci in the CLU-E project, then reopen this launcher.'
    }
    $framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
    $csc = Join-Path $framework 'csc.exe'
    $web = Join-Path $env:SystemRoot 'Microsoft.NET\assembly\GAC_MSIL\System.Web.Extensions\v4.0_4.0.0.0__31bf3856ad364e35\System.Web.Extensions.dll'
    if (!(Test-Path -LiteralPath $csc -PathType Leaf) -or !(Test-Path -LiteralPath $web -PathType Leaf)) {
        throw 'The Windows .NET Framework 4.x C# compiler and System.Web.Extensions are required.'
    }
    $sourceNames = @('Supervisor.cs', 'Protocol.cs', 'NativeJob.cs')
    $sources = foreach ($sourceName in $sourceNames) {
        $source = Join-Path $PSScriptRoot $sourceName
        Assert-NoReparsePath $source
        $source
    }

    foreach ($key in @('OPENAI_API_KEY', 'CLU_WINDOWS_SUPERVISOR_PATH', 'CLU_WINDOWS_SUPERVISOR_SHA256',
        'CLU_WINDOWS_SUPERVISOR_QUALIFICATION', 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256')) {
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    }
    $env:PATH = (Split-Path -Parent $node) + ';' + (Join-Path $env:SystemRoot 'System32') + ';' + $env:PATH
    $tempResult = @(& $node -p "require('node:fs').realpathSync.native(require('node:os').tmpdir())")
    if ($LASTEXITCODE -ne 0 -or $tempResult.Count -ne 1) { throw 'Node could not resolve its native qualification temp root.' }
    $qualificationTemp = Get-LocalPath $tempResult[0]
    Assert-NoReparsePath $qualificationTemp

    $setupStage = 'CLUE_BUILD'
    Write-Host '[1/4] Building CLU-E and checking supervisor prerequisites.'
    if ((Invoke-ExactExecutable $node @($npm, 'run', 'build') $repo) -ne 0) { throw 'CLU-E build failed.' }

    $setupStage = 'MXC_RELEASE_VERIFICATION'
    Write-Host '[2/4] Verifying the pinned Microsoft MXC release and building the CLU-E supervisor.'
    $stage = Join-Path $install ('.setup-' + [Guid]::NewGuid().ToString('N'))
    Assert-NoReparsePath $stage -CreateDirectory
    $bin = Join-Path $stage 'bin'
    Assert-NoReparsePath $bin -CreateDirectory
    $mxc = Join-Path $bin 'wxc-exec.exe'
    Get-MxcExecutable $arch $stage $mxc
    if ((Invoke-ExactExecutable $mxc @('--help') $bin 15) -ne 0) {
        throw 'The signed MXC executor could not start standalone on this Windows installation.'
    }
    $mxcHash = Get-Sha256 $mxc
    $setupStage = 'SUPERVISOR_BUILD_AND_INSTALL'
    $pinSource = Join-Path $stage 'MxcPin.cs'
    $quotedTemp = $qualificationTemp.Replace('"', '""')
    $quotedNode = $node.Replace('"', '""')
    $generatedPin = @"
internal static class MxcPin {
    internal const string Sha256 = "$mxcHash";
    internal const string QualificationTempRoot = @"$quotedTemp";
    internal const string QualificationNodeExe = @"$quotedNode";
}
"@
    [IO.File]::WriteAllText($pinSource, $generatedPin)
    $wrapper = Join-Path $bin 'CLU-E-Windows-Supervisor.exe'
    $frameworkReferences = @('mscorlib.dll', 'System.dll', 'System.Core.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
    $compilerArgs = @('/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/optimize+', '/platform:anycpu', '/langversion:5', '/codepage:65001',
        "/out:$wrapper", "/reference:$web") + $frameworkReferences + $sources + $pinSource
    if ((Invoke-ExactExecutable $csc $compilerArgs $stage 60) -ne 0) { throw 'Native supervisor compilation failed.' }
    $wrapperHash = Get-Sha256 $wrapper
    $installed = Join-Path $install $wrapperHash
    if (!(Test-Path -LiteralPath $installed)) { [IO.Directory]::Move($bin, $installed) }
    $wrapper = Join-Path $installed 'CLU-E-Windows-Supervisor.exe'
    $mxc = Join-Path $installed 'wxc-exec.exe'
    Assert-NoReparsePath $wrapper
    Assert-NoReparsePath $mxc
    if (@(Get-ChildItem -LiteralPath $installed -Force).Count -ne 2 -or
        (Get-Sha256 $wrapper) -cne $wrapperHash -or (Get-Sha256 $mxc) -cne $mxcHash) {
        throw 'The content-addressed installation has unexpected files or changed bytes.'
    }
    Assert-MicrosoftSignature $mxc

    $setupStage = 'CANARY_EXECUTION'
    Write-Host '[3/4] Running native Windows isolation canaries with disposable fixtures.'
    $env:CLU_WINDOWS_SUPERVISOR_PATH = $wrapper
    $env:CLU_WINDOWS_SUPERVISOR_SHA256 = $wrapperHash
    $stagedReport = Join-Path $stage 'canaries.json'
    try {
        $code = Invoke-ExactExecutable $node @('tools/p2-windows-supervisor-qualify.mjs', '--output', $stagedReport) $repo 180
    } finally {
        Remove-Item Env:CLU_WINDOWS_SUPERVISOR_PATH, Env:CLU_WINDOWS_SUPERVISOR_SHA256 -ErrorAction SilentlyContinue
    }
    if (!(Test-Path -LiteralPath $stagedReport -PathType Leaf)) { throw 'The native canary runner did not write a diagnostic report.' }
    Assert-NoReparsePath $stagedReport
    $payload = [ordered]@{
        schemaVersion = 'clue-mxc-supervisor-diagnostic/1'
        checkedAt = [DateTime]::UtcNow.ToString('o')
        setupStage = 'CANARIES_COMPLETED'
        proofAuthorization = $false
        blocker = 'SUPPORTED_INTRA_SANDBOX_LOOPBACK_ENFORCEMENT_REQUIRED'
        windowsHost = $windowsHost
        engineVersion = 'v1.0.1'
        engineSha256 = $mxcHash
        canaryExitCode = $code
        canaryReport = (Get-Content -LiteralPath $stagedReport -Raw | ConvertFrom-Json -AsHashtable)
    }
    Write-DiagnosticFile $report $payload
    Write-Host "[4/4] Diagnostic report: $report"
    Write-Host 'Native proof remains blocked pending a supported intra-sandbox loopback enforcement mechanism.'
    exit $code
} catch {
    Write-Host "CLU-E supervisor setup stopped: $($_.Exception.Message)"
    if ($null -ne $report -and !(Test-Path -LiteralPath $report)) {
        try {
            Assert-NoReparsePath (Split-Path -Parent $report)
            Write-DiagnosticFile $report ([ordered]@{
                schemaVersion = 'clue-mxc-supervisor-diagnostic/1'
                checkedAt = [DateTime]::UtcNow.ToString('o')
                setupStage = $setupStage
                proofAuthorization = $false
                blocker = $setupStage + '_FAILED'
                windowsHost = $windowsHost
                engineVersion = 'v1.0.1'
                engineSha256 = $mxcHash
                canaryExitCode = $null
                canaryReport = $null
            })
            Write-Host "Diagnostic report: $report"
        } catch { Write-Host 'The diagnostic report could not be written.' }
    }
    exit 1
} finally {
    if ($null -ne $stage -and (Test-Path -LiteralPath $stage -PathType Container)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
