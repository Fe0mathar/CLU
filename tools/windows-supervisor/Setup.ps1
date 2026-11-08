[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $EvidenceRoot,
    [switch] $WfpDiagnostic,
    [switch] $WfpPairedDiagnostic,
    [switch] $WfpBfeLab
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

function Receive-MxcArchive([uri] $Uri, [string] $Archive, [long] $ExpectedBytes) {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(15))
    $response = $null
    try {
        for ($hop = 0; $hop -lt 5; $hop++) {
            if ($Uri.Scheme -cne 'https' -or !$Uri.IsDefaultPort -or $Uri.UserInfo -or
                $Uri.Host -notin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) {
                throw 'The MXC download attempted an unexpected redirect.'
            }
            $response = $client.GetAsync($Uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead,
                $deadline.Token).GetAwaiter().GetResult()
            if ([int] $response.StatusCode -notin @(301, 302, 303, 307, 308)) { break }
            $location = $response.Headers.Location
            if ($null -eq $location) { throw 'The MXC download redirect had no destination.' }
            $Uri = [uri]::new($Uri, $location)
            $response.Dispose()
            $response = $null
        }
        if ($null -eq $response) { throw 'The MXC download exceeded its redirect limit.' }
        if (!$response.IsSuccessStatusCode) { throw "MXC download returned HTTP $([int] $response.StatusCode)." }
        $advertised = $response.Content.Headers.ContentLength
        if ($null -ne $advertised -and $advertised -ne $ExpectedBytes) {
            throw 'The MXC download Content-Length differs from GitHub release metadata.'
        }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        try {
            $outputStream = [IO.File]::Open($Archive, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = [byte[]]::new(262144)
                [long] $total = 0
                while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length,
                    $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
                    $total += $count
                    if ($total -gt $ExpectedBytes) { throw 'The MXC download exceeded the published asset size.' }
                    $outputStream.Write($buffer, 0, $count)
                }
                if ($total -ne $ExpectedBytes) { throw 'The MXC download ended before the published asset size.' }
            } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $deadline.Dispose()
        $client.Dispose()
    }
}

function Get-MxcExecutable([string] $Arch, [string] $Stage, [string] $Destination, [System.Collections.IDictionary] $Evidence) {
    $version = 'v1.0.1'
    $name = 'mxc-release-binaries.zip'
    $download = "https://github.com/microsoft/mxc/releases/download/$version/$name"
    $headers = @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $Evidence.state = 'RELEASE_METADATA_FETCH'
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/microsoft/mxc/releases/tags/$version" -Headers $headers -TimeoutSec 30
    $matchingAssets = @($release.assets | Where-Object { $_.name -ceq $name })
    if ($release.tag_name -cne $version -or $release.draft -or $release.prerelease -or $matchingAssets.Count -ne 1) {
        $Evidence.state = 'RELEASE_IDENTITY_INVALID'
        throw "GitHub did not return the official Microsoft MXC $version release asset."
    }
    $asset = $matchingAssets[0]
    if ($asset.state -cne 'uploaded') {
        $Evidence.state = 'ASSET_NOT_UPLOADED'
        throw 'GitHub release metadata did not report the MXC asset as uploaded.'
    }
    if ($asset.browser_download_url -cne $download) {
        $Evidence.state = 'ASSET_URL_MISMATCH'
        throw 'GitHub release metadata returned a different MXC asset URL.'
    }
    $sizeProperty = $asset.PSObject.Properties['size']
    $size = if ($null -ne $sizeProperty) { $sizeProperty.Value } else { $null }
    if (($size -isnot [int] -and $size -isnot [long]) -or $size -le 0) {
        $Evidence.state = 'ASSET_SIZE_INVALID'
        throw 'GitHub release metadata did not report a positive MXC asset size.'
    }
    $Evidence.assetBytes = [long] $size
    if ($size -gt 1073741824) {
        $Evidence.state = 'ASSET_SIZE_LIMIT'
        throw "GitHub reports an MXC asset of $size bytes, above the 1 GiB download limit."
    }
    $digest = $asset.PSObject.Properties['digest']
    if ($null -eq $digest -or $digest.Value -cnotmatch '^sha256:[a-f0-9]{64}$') {
        $Evidence.state = 'ASSET_SHA256_UNAVAILABLE'
        throw 'GitHub release metadata did not provide a valid MXC asset SHA-256.'
    }
    $archive = Join-Path $Stage $name
    $Evidence.state = 'ASSET_DOWNLOAD'
    Write-Host ("Downloading the {0:N1} MB Microsoft MXC archive. Allow up to 15 minutes." -f ($size / 1000000))
    Receive-MxcArchive $download $archive $size
    $Evidence.state = 'ASSET_SHA256_CHECK'
    $assetHash = $digest.Value.Substring(7)
    if ((Get-Sha256 $archive) -cne $assetHash) {
        throw 'The downloaded MXC ZIP did not match the SHA-256 in GitHub release metadata.'
    }
    $Evidence.state = 'ASSET_EXECUTABLE_EXTRACTION'
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entries = @($zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -ceq "$Arch/wxc-exec.exe" })
        if ($entries.Count -ne 1 -or $entries[0].Length -le 0 -or $entries[0].Length -gt 134217728) {
            throw "The MXC release did not contain exactly one expected $Arch/wxc-exec.exe."
        }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $Destination, $false)
    } finally { $zip.Dispose() }
    $Evidence.state = 'ASSET_SIGNATURE_CHECK'
    Assert-MicrosoftSignature $Destination
    $Evidence.state = 'VERIFIED'
    Write-Host "Verified Microsoft MXC $version archive SHA-256 $assetHash"
}

function Copy-PinnedInstalledMxc([string] $Arch, [string] $Install, [string] $Destination, [System.Collections.IDictionary] $Evidence) {
    if ($Arch -cne 'x64') { return $false }
    # Exact x64 image observed after verified v1.0.1 extraction and signature validation.
    $expected = '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a'
    foreach ($directory in Get-ChildItem -LiteralPath $Install -Directory -Force) {
        if ($directory.Name -cnotmatch '^[a-f0-9]{64}$' -or
            ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
        $source = Join-Path $directory.FullName 'wxc-exec.exe'
        $entry = Get-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
        if ($null -eq $entry -or $entry.PSIsContainer -or
            ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $entry.Length -lt 1 -or $entry.Length -gt 134217728) { continue }
        Assert-NoReparsePath $source
        if ((Get-Sha256 $source) -cne $expected) { continue }

        $Evidence.state = 'INSTALLED_EXECUTABLE_CHECK'
        [IO.File]::Copy($source, $Destination, $false)
        if ((Get-Sha256 $Destination) -cne $expected) {
            throw 'The installed MXC executable changed while it was copied.'
        }
        Assert-MicrosoftSignature $Destination
        $Evidence.state = 'VERIFIED_INSTALLED_EXECUTABLE'
        Write-Host 'Reusing the installed Microsoft MXC v1.0.1 x64 executable after hash and signature verification.'
        return $true
    }
    return $false
}

function Write-DiagnosticFile([string] $Path, [System.Collections.IDictionary] $Report) {
    $encoded = $Report | ConvertTo-Json -Depth 20
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($encoded + "`n")
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Get-WfpAttribution([System.Collections.IDictionary] $CanaryReport) {
    $summary = [ordered]@{ state = 'FILTERED_LEASE_INCOMPLETE'; bfe = $null; security = $null; bindCases = $null }
    $wfp = $CanaryReport['wfp']
    if ($null -eq $wfp -or $null -eq $wfp.filtered) { return $summary }
    $filtered = $wfp.filtered
    $summary.bfe = $filtered.dropEvidence
    if ($null -eq $summary.bfe -or $null -eq $summary.bfe.filterIds) { return $summary }

    $lease = $filtered.lease
    if ($null -eq $lease -or $lease.mode -ne 'filtered' -or $lease.filterCount -ne 6 -or
        !$lease.observedInJobPackageSid -or !$lease.uniqueSid -or !$lease.gateReleased -or
        !$lease.jobEmpty -or !$lease.filtersRemoved) { return $summary }
    if (!$wfp.hostControl -or !$wfp.bindContrast) {
        $summary.state = 'BIND_CONTRAST_UNPROVEN'
        return $summary
    }

    $cases = @('ipv4Tcp', 'ipv6Tcp', 'ipv4Udp', 'ipv6Udp')
    $attributed = [ordered]@{}
    $bfeHits = $summary.bfe.bindHits
    foreach ($key in $cases) {
        $attributed[$key] = $null -ne $bfeHits -and $bfeHits[$key] -gt 0
    }
    if ($attributed.Values -contains $false) {
        try {
            $reader = Join-Path $PSScriptRoot 'WfpSecurityEvents.ps1'
            Assert-NoReparsePath $reader
            . $reader
            $query = @{ FilterIds = @($summary.bfe.filterIds); Start = [datetime] $filtered.startedAt; End = [datetime] $filtered.finishedAt }
            $summary.security = Get-WfpSecurityBindEvidence @query
            if ($summary.security.state -eq 'MATCHED') {
                $securityHits = $summary.security.hits
                foreach ($key in $cases) { $attributed[$key] = $attributed[$key] -or $securityHits.$key -gt 0 }
            }
        } catch { $summary.security = [ordered]@{ state = 'UNAVAILABLE'; hits = $null } }
    }
    $summary.bindCases = $attributed
    if ($attributed.Values -notcontains $false) {
        $summary.state = 'ALL_BIND_DROPS_ATTRIBUTED'
    } elseif ($attributed.Values -contains $true -or
        ($null -ne $summary.bfe.hitsByFilter -and
            ($summary.bfe.hitsByFilter[4] -gt 0 -or $summary.bfe.hitsByFilter[5] -gt 0))) {
        $summary.state = 'PARTIAL_BIND_DROP_ATTRIBUTION'
    } else {
        $summary.state = 'BIND_DENIED_ATTRIBUTION_UNPROVEN'
    }
    return $summary
}

$stage = $null
$stageCleanupSafe = $true
$staticDiagnosticLock = $null
$staticDiagnosticLockHeld = $false
$report = $null
$mxcHash = $null
$mxcDownload = [ordered]@{ state = 'NOT_STARTED'; assetBytes = $null }
$windowsHost = $null
$setupStage = 'HOST_PREREQUISITES'
try {
    if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows) { throw 'Run this setup on native Windows with PowerShell 7.' }
    if ($WfpDiagnostic -and $WfpPairedDiagnostic) { throw 'Select one WFP diagnostic mode.' }
    if ($WfpBfeLab -and !$WfpPairedDiagnostic) { throw 'The BFE lab requires the paired WFP diagnostic.' }
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
    $shell = [Diagnostics.Process]::GetCurrentProcess()
    try { $sessionId = $shell.SessionId }
    finally { $shell.Dispose() }
    $windowsHost = [ordered]@{
        version = [Environment]::OSVersion.Version.ToString()
        updateBuildRevision = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name UBR -ErrorAction SilentlyContinue
        architecture = $arch
        sessionId = $sessionId
        userInteractive = [Environment]::UserInteractive
    }
    if ($sessionId -eq 0 -or !$windowsHost.userInteractive) {
        throw 'Run CLUE-Windows-Supervisor.bat from your signed-in Windows desktop for this canary.'
    }
    if ($WfpDiagnostic -or $WfpPairedDiagnostic) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                throw 'Right-click CLUE-Windows-WFP-Diagnostic.bat and choose Run as administrator.'
            }
        } finally { $identity.Dispose() }
    }
    if ($WfpBfeLab) {
        $setupStage = 'BFE_LAB_PREREQUISITES'
        $bfeLabReader = Join-Path $PSScriptRoot 'WfpBfeLabSetup.ps1'
        Assert-NoReparsePath $bfeLabReader
        . $bfeLabReader
        $bfeLabConfirmation = Read-Host 'Type DISPOSABLE OFFLINE HYPER-V GUEST to confirm the lab VM is isolated and checkpointed'
        Assert-WfpBfeLabEnvironment -Confirmation $bfeLabConfirmation
    }
    if ($WfpPairedDiagnostic) {
        $staticDiagnosticLock = [Threading.Mutex]::new($false, 'Local\CLU-E-StaticDiagnostic-05P')
        try { $staticDiagnosticLockHeld = $staticDiagnosticLock.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $staticDiagnosticLockHeld = $true }
        if (!$staticDiagnosticLockHeld) { throw 'Another CLU-E static diagnostic is running in this session.' }
        $recordReader = Join-Path $PSScriptRoot 'WfpPairedSetup.ps1'
        Assert-NoReparsePath $recordReader
        . $recordReader
        foreach ($priorStage in (Get-ChildItem -LiteralPath $install -Directory -Force -Filter '.setup-*')) {
            if ($priorStage.Name -cnotmatch '^\.setup-[0-9a-f]{32}$' -or
                ($priorStage.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
            foreach ($staticCase in @('static-crash', 'static-double')) {
                $priorPrivate = [IO.Path]::Combine($priorStage.FullName, $staticCase, 'private')
                $priorIntent = Join-Path $priorPrivate 'static-intent.json'
                if (![IO.File]::Exists($priorIntent)) { continue }
                Assert-NoReparsePath $priorIntent
                $reconciled = $false
                try {
                    $prior = Read-WfpPairedRecord (Join-Path $priorPrivate 'static-recovery-result.json')
                    $reconciled = $prior['state'] -ceq 'STATIC_RECOVERY_VERIFIED' -and
                        $prior['jobAbsent'] -eq $true -and $prior['filtersRemoved'] -eq $true
                } catch { }
                if (!$reconciled) {
                    try {
                        $prior = Read-WfpPairedRecord (Join-Path $priorPrivate 'result.json')
                        $reconciled = $prior['jobEmpty'] -eq $true -and $prior['independentRemovalVerified'] -eq $true
                    } catch { }
                }
                if (!$reconciled) { throw 'A previous static diagnostic needs scoped recovery before another run.' }
            }
        }
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
    $sourceNames = @('Supervisor.cs', 'Protocol.cs', 'NativeJob.cs',
        'WfpBootstrapRun.cs', 'WfpContainerIdentity.cs', 'WfpLoopbackLease.cs', 'WfpDropObservation.cs')
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
    if (!(Copy-PinnedInstalledMxc $arch $install $mxc $mxcDownload)) {
        if ($WfpDiagnostic -or $WfpPairedDiagnostic) {
            $mxcDownload.state = 'VERIFIED_X64_CACHE_REQUIRED'
            throw 'The WFP diagnostic requires the previously verified x64 MXC engine under the current Windows account.'
        }
        Get-MxcExecutable $arch $stage $mxc $mxcDownload
    }
    if ((Invoke-ExactExecutable $mxc @('--help') $bin 15) -ne 0) {
        throw 'The signed MXC executor could not start standalone on this Windows installation.'
    }
    $mxcHash = Get-Sha256 $mxc
    $setupStage = 'SUPERVISOR_BUILD_AND_INSTALL'
    $pinSource = Join-Path $stage 'MxcPin.cs'
    $quotedTemp = $qualificationTemp.Replace('"', '""')
    $quotedNode = $node.Replace('"', '""')
    $frameworkReferences = @('mscorlib.dll', 'System.dll', 'System.Core.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
    $compilerBase = @('/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/optimize+', '/langversion:5', '/codepage:65001')
    $diagnosticPins = ''
    if ($WfpPairedDiagnostic) {
        $setupStage = 'PAIRED_DIAGNOSTIC_BUILD'
        foreach ($directory in @('fixture', 'paired\private', 'paired\workspace', 'crash\private', 'crash\workspace',
            'static-crash\private', 'static-crash\workspace', 'static-double\private', 'static-double\workspace',
            'host-net\private', 'host-net\workspace', 'bfe-guard\private', 'bfe-guard\workspace',
            'bfe-lab\private', 'bfe-lab\workspace')) {
            Assert-NoReparsePath (Join-Path $stage $directory) -CreateDirectory
        }
        $fixtureSource = Join-Path $PSScriptRoot 'WfpPairedFixture.cs'
        $hostLoopbackFixtureSource = Join-Path $PSScriptRoot 'WfpHostLoopbackFixture.cs'
        $controllerSource = Join-Path $PSScriptRoot 'WfpPairedSupervisor.cs'
        $staticRecoverySource = Join-Path $PSScriptRoot 'WfpStaticRecovery.cs'
        $bfeWatchSource = Join-Path $PSScriptRoot 'WfpBfeWatch.cs'
        Assert-NoReparsePath $fixtureSource
        Assert-NoReparsePath $hostLoopbackFixtureSource
        Assert-NoReparsePath $controllerSource
        Assert-NoReparsePath $staticRecoverySource
        Assert-NoReparsePath $bfeWatchSource
        $fixture = Join-Path $stage 'fixture\WfpPairedFixture.exe'
        $fixtureArgs = $compilerBase + @('/platform:x64', "/out:$fixture") +
            $frameworkReferences + $fixtureSource + $hostLoopbackFixtureSource
        if ((Invoke-ExactExecutable $csc $fixtureArgs $stage 60) -ne 0) { throw 'Native bind fixture compilation failed.' }
        Assert-NoReparsePath $fixture
        $fixtureHash = Get-Sha256 $fixture
        $quotedStage = $stage.Replace('"', '""')
        $diagnosticPins = @"
    internal const string WfpDiagnosticStage = @"$quotedStage";
    internal const string WfpDiagnosticFixtureSha256 = "$fixtureHash";
"@
    }
    $generatedPin = @"
internal static class MxcPin {
    internal const string Sha256 = "$mxcHash";
    internal const string QualificationTempRoot = @"$quotedTemp";
    internal const string QualificationNodeExe = @"$quotedNode";
$diagnosticPins
}
"@
    [IO.File]::WriteAllText($pinSource, $generatedPin)
    if ($WfpPairedDiagnostic) {
        $controller = Join-Path $bin 'CLU-E-WfpPairedDiagnostic.exe'
        $controllerArgs = $compilerBase + @('/platform:x64', '/main:WfpPairedSupervisor', "/out:$controller", "/reference:$web") +
            $frameworkReferences + $sources + $pinSource + $controllerSource + $staticRecoverySource + $bfeWatchSource
        if ((Invoke-ExactExecutable $csc $controllerArgs $stage 60) -ne 0) { throw 'Native paired diagnostic compilation failed.' }
        Assert-NoReparsePath $controller
        $staticReader = Join-Path $PSScriptRoot 'WfpStaticSetup.ps1'
        Assert-NoReparsePath $staticReader
        . $staticReader
        $hostReader = Join-Path $PSScriptRoot 'WfpHostLoopbackSetup.ps1'
        Assert-NoReparsePath $hostReader
        . $hostReader
        $bfeReader = Join-Path $PSScriptRoot 'WfpBfeGuardSetup.ps1'
        Assert-NoReparsePath $bfeReader
        . $bfeReader

        $setupStage = 'PAIRED_DIAGNOSTIC_EXECUTION'
        Write-Host '[3/4] Running native isolation regressions and the BFE health-loss simulation.'
        $stageCleanupSafe = $false
        $experiment = Invoke-WfpPairedSetup $controller $stage $fixture
        $stageCleanupSafe = $experiment.stageCleanupSafe
        $staticResult = [ordered]@{ state = 'STATIC_GUARDIAN_LOSS_SKIPPED_PRIOR_CLEANUP_UNVERIFIED' }
        if ($stageCleanupSafe) {
            $stageCleanupSafe = $false
            $staticExperiment = Invoke-WfpStaticSetup $controller $stage $fixture
            $stageCleanupSafe = $staticExperiment.stageCleanupSafe
            $staticResult = $staticExperiment.result
        }
        $doubleResult = [ordered]@{ state = 'STATIC_DOUBLE_LOSS_SKIPPED_PRIOR_CLEANUP_UNVERIFIED' }
        if ($stageCleanupSafe) {
            $stageCleanupSafe = $false
            $doubleExperiment = Invoke-WfpStaticSetup $controller $stage $fixture -DoubleLoss
            $stageCleanupSafe = $doubleExperiment.stageCleanupSafe
            $doubleResult = $doubleExperiment.result
        }
        $hostResult = [ordered]@{ state = 'HOST_LOOPBACK_SKIPPED_PRIOR_CLEANUP_UNVERIFIED' }
        if ($stageCleanupSafe) {
            $stageCleanupSafe = $false
            $hostExperiment = Invoke-WfpHostLoopbackSetup $controller $stage $fixture
            $stageCleanupSafe = $hostExperiment.stageCleanupSafe
            $hostResult = $hostExperiment.result
        }
        $bfeResult = [ordered]@{ state = 'BFE_GUARD_SKIPPED_PRIOR_CLEANUP_UNVERIFIED' }
        if ($stageCleanupSafe) {
            $stageCleanupSafe = $false
            $bfeExperiment = Invoke-WfpBfeGuardSetup $controller $stage
            $stageCleanupSafe = $bfeExperiment.stageCleanupSafe
            $bfeResult = $bfeExperiment.result
        }
        $bfeLabResult = [ordered]@{ state = 'BFE_LAB_NOT_REQUESTED' }
        if ($WfpBfeLab) {
            $bfeLabResult.state = 'BFE_LAB_SKIPPED_PRIOR_CLEANUP_UNVERIFIED'
            if ($stageCleanupSafe) {
                $setupStage = 'BFE_LAB_EXECUTION'
                Assert-WfpBfeLabEnvironment -Confirmation $bfeLabConfirmation
                $stageCleanupSafe = $false
                $bfeLab = Invoke-WfpBfeLabSetup $controller $stage
                $stageCleanupSafe = $bfeLab.stageCleanupSafe
                $bfeLabResult = $bfeLab.result
            }
        }
        $payload = [ordered]@{
            schemaVersion = 'clue-mxc-supervisor-diagnostic/1'
            checkedAt = [DateTime]::UtcNow.ToString('o')
            setupStage = 'PAIRED_DIAGNOSTIC_COMPLETED'
            proofAuthorization = $false
            blocker = 'SUPPORTED_INTRA_SANDBOX_LOOPBACK_ENFORCEMENT_REQUIRED'
            windowsHost = $windowsHost
            engineVersion = 'v1.0.1'
            engineSha256 = $mxcHash
            mxcDownload = $mxcDownload
            canaryUiMode = 'CONTAINER_SCOPED_WIN32K'
            wfpDiagnostic = $true
            wfpPairedDiagnostic = $true
            wfpGuardianDiagnostic = $true
            wfpStaticGuardianDiagnostic = $true
            guardianLossQualified = $false
            diagnosticStageRetained = !$stageCleanupSafe
            fixtureSha256 = $fixtureHash
            canaryExitCode = $null
            canaryReport = $null
            wfpPaired = $experiment.paired
            wfpAttribution = $experiment.attribution
            wfpCrash = $experiment.crash
            wfpStaticGuardianLoss = $staticResult
            wfpStaticDoubleLoss = $doubleResult
            wfpHostLoopback = $hostResult
            wfpBfeGuard = $bfeResult
            wfpBfeLab = $bfeLabResult
            bfeRestartQualified = $false
        }
        Write-DiagnosticFile $report $payload
        Write-Host ('[CLU-E paired binds] ' + $experiment.paired.state)
        Write-Host ('[CLU-E WFP attribution] ' + $experiment.attribution.state)
        Write-Host ('[CLU-E exact bind attribution] ' + $experiment.attribution.exactState)
        Write-Host ('[CLU-E abrupt exit] ' + $experiment.crash.state)
        Write-Host ('[CLU-E static guardian loss] ' + $staticResult.state)
        Write-Host ('[CLU-E static double loss] ' + $doubleResult.state)
        Write-Host ('[CLU-E host loopback] ' + $hostResult.state)
        Write-Host ('[CLU-E BFE health guard] ' + $bfeResult.state)
        if ($WfpBfeLab) { Write-Host ('[CLU-E BFE lab] ' + $bfeLabResult.state) }
        if (!$stageCleanupSafe) {
            Write-Host 'The diagnostic stage was retained because cleanup is unverified.'
            foreach ($case in @(
                @{ name = 'static-crash'; result = $staticResult; command = 'recover-retained' },
                @{ name = 'static-double'; result = $doubleResult; command = 'recover-double-retained' }
            )) {
                $intentPath = [IO.Path]::Combine($stage, $case.name, 'private', 'static-intent.json')
                if ([IO.File]::Exists($intentPath) -and !$case.result['recoveryVerified'] -and !$case.result['naturalCleanupVerified']) {
                    Write-Host ('Recovery command for elevated Command Prompt after the diagnostic processes have exited: "' +
                        $controller + '" ' + $case.command)
                }
            }
        }
        Write-Host "[4/4] Diagnostic report: $report"
        exit 0
    }
    $wrapper = Join-Path $bin 'CLU-E-Windows-Supervisor.exe'
    $compilerArgs = $compilerBase + @('/platform:anycpu', "/out:$wrapper", "/reference:$web") + $frameworkReferences + $sources + $pinSource
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
        $canaryArguments = @('tools/p2-windows-supervisor-qualify.mjs', '--output', $stagedReport)
        if ($WfpDiagnostic) { $canaryArguments += '--wfp-diagnostic' }
        $code = Invoke-ExactExecutable $node $canaryArguments $repo 180
    } finally {
        Remove-Item Env:CLU_WINDOWS_SUPERVISOR_PATH, Env:CLU_WINDOWS_SUPERVISOR_SHA256 -ErrorAction SilentlyContinue
    }
    if (!(Test-Path -LiteralPath $stagedReport -PathType Leaf)) { throw 'The native canary runner did not write a diagnostic report.' }
    Assert-NoReparsePath $stagedReport
    $canaryReport = Get-Content -LiteralPath $stagedReport -Raw | ConvertFrom-Json -AsHashtable
    $wfpAttribution = if ($WfpDiagnostic) { Get-WfpAttribution $canaryReport } else { $null }
    $payload = [ordered]@{
        schemaVersion = 'clue-mxc-supervisor-diagnostic/1'
        checkedAt = [DateTime]::UtcNow.ToString('o')
        setupStage = 'CANARIES_COMPLETED'
        proofAuthorization = $false
        blocker = 'SUPPORTED_INTRA_SANDBOX_LOOPBACK_ENFORCEMENT_REQUIRED'
        windowsHost = $windowsHost
        engineVersion = 'v1.0.1'
        engineSha256 = $mxcHash
        mxcDownload = $mxcDownload
        canaryUiMode = 'CONTAINER_SCOPED_WIN32K'
        wfpDiagnostic = [bool] $WfpDiagnostic
        canaryExitCode = $code
        canaryReport = $canaryReport
        wfpAttribution = $wfpAttribution
    }
    Write-DiagnosticFile $report $payload
    if ($WfpDiagnostic) { Write-Host ('[CLU-E WFP attribution] ' + $wfpAttribution.state) }
    Write-Host "[4/4] Diagnostic report: $report"
    Write-Host 'Native proof remains blocked pending a supported intra-sandbox loopback enforcement mechanism.'
    exit $code
} catch {
    $failure = $_.Exception.Message
    Write-Host "CLU-E supervisor setup stopped: $failure"
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
                mxcDownload = $mxcDownload
                canaryUiMode = 'CONTAINER_SCOPED_WIN32K'
                wfpDiagnostic = [bool] ($WfpDiagnostic -or $WfpPairedDiagnostic)
                wfpPairedDiagnostic = [bool] $WfpPairedDiagnostic
                wfpGuardianDiagnostic = [bool] $WfpPairedDiagnostic
                wfpStaticGuardianDiagnostic = [bool] $WfpPairedDiagnostic
                wfpBfeLab = if ($WfpBfeLab) {
                    $labState = if ($failure -cmatch '\ABFE_LAB_[A-Z0-9_]{1,72}\z') { $failure } else { 'BFE_LAB_SETUP_FAILED' }
                    [ordered]@{ state = $labState }
                } else { $null }
                bfeRestartQualified = $false
                diagnosticStageRetained = !$stageCleanupSafe
                canaryExitCode = $null
                canaryReport = $null
                wfpAttribution = $null
            })
            Write-Host "Diagnostic report: $report"
        } catch { Write-Host 'The diagnostic report could not be written.' }
    }
    exit 1
} finally {
    if ($stageCleanupSafe -and $null -ne $stage -and (Test-Path -LiteralPath $stage -PathType Container)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $staticDiagnosticLock) {
        if ($staticDiagnosticLockHeld) { $staticDiagnosticLock.ReleaseMutex() }
        $staticDiagnosticLock.Dispose()
    }
}
