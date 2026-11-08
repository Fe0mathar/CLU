[CmdletBinding()]
param(
    [string] $InstallRoot,
    [string] $EvidenceRoot,
    [switch] $WfpDiagnostic,
    [switch] $WfpPairedDiagnostic,
    [switch] $WfpBfeLab,
    [switch] $ProofAdmissionDiagnostic,
    [switch] $ReviewedWorkloadDiagnostic,
    [switch] $GovernedWorkloadDiagnostic,
    [switch] $InstalledGovernedWorkloadDiagnostic,
    [switch] $InstalledGovernedWfpDiagnostic,
    [switch] $InstalledGovernedWfpOwnerLossDiagnostic,
    [switch] $WfpEnforcementFaultDiagnostic
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

function Write-DiagnosticFile([string] $Path, [System.Collections.IDictionary] $Report, [int] $MaximumBytes = 0) {
    $encoded = $Report | ConvertTo-Json -Depth 20
    $bytes = [Text.Encoding]::UTF8.GetBytes($encoded + "`n")
    if ($MaximumBytes -gt 0 -and $bytes.Length -gt $MaximumBytes) { throw 'Diagnostic report exceeded its size limit.' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Clear-ProofAdmissionStage([string] $Path, [bool] $Safe, [int] $MaximumEntries = 1024) {
    if (!$Path) { return 'NOT_REQUIRED' }
    if (!$Safe) { return 'RETAINED_UNVERIFIED' }
    try {
        Assert-NoReparsePath $Path
        # Enumerate only real directories so an unexpected junction can never redirect cleanup.
        $pending = [Collections.Generic.Stack[string]]::new()
        $pending.Push($Path)
        $entries = 0
        while ($pending.Count -gt 0) {
            foreach ($entry in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
                $entries++
                if ($entries -gt $MaximumEntries) { return 'RETAINED_UNVERIFIED' }
                if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { return 'RETAINED_UNVERIFIED' }
                if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
            }
        }
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        if (!(Test-Path -LiteralPath $Path)) { return 'REMOVED' }
    } catch { }
    return 'RETAINED_UNVERIFIED'
}

function Assert-InstalledGovernedImages([string] $Directory, [string] $WrapperSha256, [string] $EngineSha256) {
    Assert-NoReparsePath $Directory
    $wrapper = Join-Path $Directory 'CLU-E-Windows-Supervisor.exe'
    $engine = Join-Path $Directory 'wxc-exec.exe'
    $entries = @(Get-ChildItem -LiteralPath $Directory -Force)
    if ((Split-Path -Leaf $Directory) -cne $WrapperSha256 -or $entries.Count -ne 2 -or
        $entries.Name -cnotcontains 'CLU-E-Windows-Supervisor.exe' -or $entries.Name -cnotcontains 'wxc-exec.exe' -or
        @($entries | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }).Count -ne 0) {
        throw 'The diagnostic installation does not contain exactly its two pinned images.'
    }
    Assert-NoReparsePath $wrapper
    Assert-NoReparsePath $engine
    if ((Get-Sha256 $wrapper) -cne $WrapperSha256 -or (Get-Sha256 $engine) -cne $EngineSha256) {
        throw 'The installed diagnostic image hash does not match its pin.'
    }
    Assert-MicrosoftSignature $engine
}

function Clear-InstalledGovernedImages([string] $OwnedDirectory, [string] $StageCleanup,
    [string] $WrapperSha256, [string] $EngineSha256) {
    if (!$OwnedDirectory) { return 'NOT_REQUIRED' }
    if ($StageCleanup -cne 'REMOVED') { return 'RETAINED_UNVERIFIED' }
    try {
        Assert-InstalledGovernedImages $OwnedDirectory $WrapperSha256 $EngineSha256
        # This path belongs to the successful exclusive move. Never delete unknown entries.
        [IO.File]::Delete((Join-Path $OwnedDirectory 'CLU-E-Windows-Supervisor.exe'))
        [IO.File]::Delete((Join-Path $OwnedDirectory 'wxc-exec.exe'))
        [IO.Directory]::Delete($OwnedDirectory, $false)
        if (!(Test-Path -LiteralPath $OwnedDirectory)) { return 'REMOVED' }
    } catch { }
    return 'RETAINED_UNVERIFIED'
}

function Close-InstalledGovernedHandles([Collections.Generic.List[IO.FileStream]] $Handles) {
    foreach ($handle in $Handles) { $handle.Dispose() }
    $Handles.Clear()
}

function Invoke-InstalledGovernedWfpBuild([string] $Stage, [string] $Node, [string] $NodeSha256,
    [string] $NpmCliSha256, [string] $QualificationTemp, [string] $EngineSha256, [string] $OperatorSid,
    [int] $OperatorSessionId, [switch] $OwnerLoss) {
    $script:admissionInstallation.buildFailure = 'WFP_BUILD_LAUNCHER_PREFLIGHT'
    $stageName = Split-Path -Leaf $Stage
    if ($stageName -cnotmatch '\A\.setup-([a-f0-9]{32})\z') { throw 'The WFP workload stage identity is invalid.' }
    $runId = $Matches[1]
    $programFiles = Get-LocalPath ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))
    Assert-NoReparsePath $programFiles
    $protectedRoot = Join-Path $programFiles ".clue-governed-wfp-$runId"
    if (Test-Path -LiteralPath $protectedRoot) { throw 'The protected governed WFP run already exists.' }
    $pwsh = Join-Path $programFiles 'PowerShell\7\pwsh.exe'
    $builder = Join-Path $PSScriptRoot 'InstalledGovernedWfpBuild.ps1'
    Assert-NoReparsePath $pwsh
    Assert-NoReparsePath $builder
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $builder), '-Stage', ('"{0}"' -f $Stage), '-Node', ('"{0}"' -f $Node),
        '-NodeSha256', $NodeSha256, '-NpmCliSha256', $NpmCliSha256, '-QualificationTemp', ('"{0}"' -f $QualificationTemp),
        '-EngineSha256', $EngineSha256, '-OperatorSid', $OperatorSid, '-OperatorSessionId', [string] $OperatorSessionId,
        '-OperatorPid', [string] $PID)
    if ($OwnerLoss) { $arguments += '-OwnerLoss' }
    $script:admissionInstallation.buildFailure = 'WFP_BUILD_LAUNCHER_SCRIPT_PIN'
    $builderHandle = [IO.File]::Open($builder, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $process = $null
    try {
        if ($builderHandle.Length -lt 1 -or $builderHandle.Length -gt 1048576) { throw 'The WFP builder size is invalid.' }
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        $reader = [IO.StreamReader]::new($builderHandle, $encoding, $false, 4096, $true)
        try { $canonical = $encoding.GetBytes($reader.ReadToEnd().Replace("`r`n", "`n")) }
        finally { $reader.Dispose() }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $builderDigest = [BitConverter]::ToString($sha.ComputeHash($canonical)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($builderDigest -cne '079407576cfea282345ed9773a5fffb84cd9973ead1e8aba2f5b1d0c848951f5') { throw 'The governed WFP builder source pin does not match.' }
        Write-Host 'Approve the Windows elevation prompt for the protected supervisor build and WFP guardian.'
        $script:admissionInstallation.buildFailure = 'WFP_BUILD_LAUNCHER_START_FAILED'
        try { $process = Start-Process -FilePath $pwsh -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru }
        catch {
            $failure = $_.Exception
            for ($depth = 0; $depth -lt 4 -and $null -ne $failure; $depth++) {
                if ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 1223) {
                    $script:admissionInstallation.buildFailure = 'WFP_BUILD_ELEVATION_CANCELLED'
                    break
                }
                $failure = $failure.InnerException
            }
            throw
        }
        if ($null -eq $process) { throw 'The elevated governed WFP builder did not start.' }
        $ready = Join-Path $protectedRoot 'ready.json'
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $builderExited = $false
        while (![IO.File]::Exists($ready) -and $clock.ElapsedMilliseconds -lt 120000) {
            try { $builderExited = $process.HasExited } catch { }
            if ($builderExited) { break }
            Start-Sleep -Milliseconds 100
        }
        if (![IO.File]::Exists($ready)) {
            try { $builderExited = $process.HasExited } catch { }
            $script:admissionInstallation.buildFailure = if ($builderExited) {
                $builderExitCode = $null
                try { $builderExitCode = $process.ExitCode } catch { }
                if ($null -eq $builderExitCode) { 'WFP_BUILD_EXIT_STATUS_UNAVAILABLE' }
                else {
                    switch ($builderExitCode) {
                        0 { 'WFP_BUILD_READY_RECEIPT_MISSING' }
                        41 { 'WFP_BUILD_PREFLIGHT' }
                        42 { 'WFP_BUILD_OPERATOR_TOKEN' }
                        43 { 'WFP_BUILD_INPUT_IMAGES' }
                        44 { 'WFP_BUILD_PROTECTED_ROOT' }
                        45 { 'WFP_BUILD_SOURCE_PINS' }
                        46 { 'WFP_BUILD_COMPILER_FAILED' }
                        47 { 'WFP_BUILD_COMPILER_TIMEOUT' }
                        48 { 'WFP_BUILD_INSTALLED_IMAGES' }
                        49 { 'WFP_BUILD_GUARDIAN_START' }
                        50 { 'WFP_BUILD_READY_PUBLICATION' }
                        default { 'WFP_BUILD_UNCLASSIFIED_EXIT' }
                    }
                }
            } else { 'WFP_BUILD_READY_TIMEOUT' }
            throw ('The elevated governed WFP build did not publish its protected ready receipt. ' + $script:admissionInstallation.buildFailure)
        }
        $script:admissionInstallation.buildFailure = 'WFP_BUILD_READY_RECEIPT_INVALID'
        $dacl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;RC;;;OW)(A;OICI;0x1200a9;;;$OperatorSid)"
        Assert-WfpFaultStageAcl $protectedRoot $dacl
        Assert-NoReparsePath $ready
        $receiptItem = Get-Item -LiteralPath $ready -Force
        if ($receiptItem.PSIsContainer -or $receiptItem.Length -lt 2 -or $receiptItem.Length -gt 4096) {
            throw 'The protected governed WFP ready receipt has an invalid size or type.'
        }
        $receipt = [IO.File]::ReadAllText($ready) | ConvertFrom-Json -AsHashtable -Depth 4
        $readySchema = if ($OwnerLoss) {
            'clue-governed-wfp-owner-loss-installed-image/1'
        } else { 'clue-governed-wfp-installed-image/1' }
        if ($receipt -isnot [System.Collections.IDictionary] -or $receipt.Count -ne 4 -or
            $receipt['schemaVersion'] -cne $readySchema -or
            $receipt['wrapperSha256'] -isnot [string] -or $receipt['wrapperSha256'] -cnotmatch '\A[a-f0-9]{64}\z' -or
            $receipt['engineSha256'] -cne $EngineSha256 -or
            ($receipt['guardianPid'] -isnot [int] -and $receipt['guardianPid'] -isnot [long]) -or
            $receipt['guardianPid'] -le 0 -or $receipt['guardianPid'] -gt [int]::MaxValue) {
            throw 'The protected governed WFP ready receipt failed validation.'
        }
        $script:admissionInstallation.buildFailure = $null
        return [ordered]@{
            programFiles = $programFiles
            root = $protectedRoot
            directory = Join-Path $protectedRoot $receipt['wrapperSha256']
            dacl = $dacl
            wrapperSha256 = $receipt['wrapperSha256']
            guardianPid = $receipt['guardianPid']
        }
    } finally {
        if ($null -ne $process) { $process.Dispose() }
        $builderHandle.Dispose()
    }
}

function Write-StagedProofDiagnosticReport([string] $Path, [string] $State, $ExitCode) {
    $payload = [ordered]@{
        schemaVersion = if ($script:InstalledGovernedWfpOwnerLossDiagnostic) {
            'clue-windows-governed-wfp-owner-loss-diagnostic/1'
        } elseif ($script:InstalledGovernedWfpDiagnostic) {
            'clue-windows-governed-wfp-diagnostic/1'
        } elseif ($script:InstalledGovernedWorkloadDiagnostic) {
            'clue-windows-installed-governed-workload-diagnostic/1'
        } elseif ($script:GovernedWorkloadDiagnostic) {
            'clue-windows-governed-workload-diagnostic/1'
        } elseif ($script:ReviewedWorkloadDiagnostic) {
            'clue-windows-reviewed-workload-diagnostic/1'
        } else { 'clue-windows-proof-admission-diagnostic/1' }
        checkedAt = [DateTime]::UtcNow.ToString('o')
        state = $State
        setupStage = $script:setupStage
        proofAuthorization = $false
        executionEnvironment = 'WINDOWS_HOST'
        windowsHost = $script:windowsHost
        engineVersion = 'v1.0.1'
        engineSha256 = $script:mxcHash
        mxcDownload = $script:mxcDownload
        nodeSha256 = $script:admissionNodeHash
        supervisorSha256 = $script:admissionSupervisorHash
    }
    if ($script:operatorWorkloadDiagnostic) {
        $payload.bootstrapSha256 = $script:admissionFixtureHash
        $payload.runnerSha256 = $script:admissionRunnerHash
        $payload.workloadExitCode = $ExitCode
        if ($script:governedWorkloadDiagnosticSelected) {
            $payload.npmCliSha256 = $script:admissionNpmCliHash
            $payload.governedWorkload = $script:admissionResult
        } else {
            $payload.reviewedWorkload = $script:admissionResult
        }
    } else {
        $payload.fixtureSha256 = $script:admissionFixtureHash
        $payload.fixtureExitCode = $ExitCode
        $payload.fixture = $script:admissionResult
    }
    $payload.cleanup = $script:admissionCleanup
    $payload.diagnosticStageRetained = $script:admissionCleanup -eq 'RETAINED_UNVERIFIED'
    if ($script:InstalledGovernedWorkloadDiagnostic -or $script:governedWfpDiagnosticSelected) {
        $payload.installation = $script:admissionInstallation
        $payload.offHostLan = 'NOT_TESTED'
        $payload.productionLoopbackEnforcement = 'UNQUALIFIED'
        $payload.bfeRestartQualified = $false
    }
    $maximumBytes = if ($script:governedWorkloadDiagnosticSelected) { 131072 } else { 65536 }
    Write-DiagnosticFile $Path $payload $maximumBytes
}

function Assert-WfpFaultStageAcl([string] $Path, [string] $Dacl) {
    try { Assert-NoReparsePath $Path }
    catch { throw 'WFP_STAGE_ACL_PATH_UNVERIFIED' }
    try {
        # Read the Windows descriptor before any managed ACL canonicalization.
        if ($null -eq ('ClueWfpFaultAclNative' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ClueWfpFaultAclNative
{
    private const uint DaclSecurityInformation = 4;
    private const int InsufficientBuffer = 122;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileSecurityW(string path, uint information,
        [Out] byte[] descriptor, uint length, out uint needed);

    public static byte[] Read(string path)
    {
        uint needed;
        if (GetFileSecurityW(path, DaclSecurityInformation, null, 0, out needed) ||
            Marshal.GetLastWin32Error() != InsufficientBuffer || needed < 20 || needed > 16384)
            throw new InvalidOperationException();
        var bytes = new byte[needed];
        if (!GetFileSecurityW(path, DaclSecurityInformation, bytes, (uint)bytes.Length, out needed))
            throw new InvalidOperationException();
        return bytes;
    }
}
'@
        }
        $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([ClueWfpFaultAclNative]::Read($Path), 0)
    } catch { throw 'WFP_STAGE_ACL_READ_UNAVAILABLE' }
    if (!($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)) {
        throw 'WFP_STAGE_ACL_UNPROTECTED'
    }
    $actual = $descriptor.DiscretionaryAcl
    if (!($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or $null -eq $actual) {
        throw 'WFP_STAGE_ACL_MISSING'
    }
    $expected = [Security.AccessControl.RawSecurityDescriptor]::new($Dacl).DiscretionaryAcl
    if ($actual.Count -ne $expected.Count) { throw 'WFP_STAGE_ACL_ACE_COUNT_MISMATCH' }

    # Every expected ACE is a plain explicit allow. Their order and ACL header encoding
    # can vary without changing access. The exact trustees, masks and flags must match.
    $expectedBySid = @{}
    foreach ($ace in $expected) { $expectedBySid[$ace.SecurityIdentifier.Value] = $ace }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($ace in $actual) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or
            $ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.IsCallback -or $ace.OpaqueLength -ne 0) {
            throw 'WFP_STAGE_ACL_UNSUPPORTED_ACE'
        }
        $sid = $ace.SecurityIdentifier.Value
        if (!$expectedBySid.ContainsKey($sid)) { throw 'WFP_STAGE_ACL_UNEXPECTED_TRUSTEE' }
        if (!$seen.Add($sid)) { throw 'WFP_STAGE_ACL_DUPLICATE_TRUSTEE' }
        $required = $expectedBySid[$sid]
        if ($ace.AceFlags -ne $required.AceFlags) { throw 'WFP_STAGE_ACL_ACE_FLAGS_MISMATCH' }
        if ($ace.AccessMask -ne $required.AccessMask) { throw 'WFP_STAGE_ACL_ACCESS_MASK_MISMATCH' }
    }
}

function New-WfpFaultStage([string] $Path, [string] $Dacl) {
    if (Test-Path -LiteralPath $Path) { throw 'The WFP diagnostic stage already exists.' }
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm($Dacl, [Security.AccessControl.AccessControlSections]::Access)
    $null = [IO.FileSystemAclExtensions]::CreateDirectory($security, $Path)
    Assert-WfpFaultStageAcl $Path $Dacl
}

function Copy-WfpFaultPinnedInputs([string] $SourceRoot, [string] $DestinationRoot, [System.Collections.IDictionary] $Hashes) {
    Assert-NoReparsePath $DestinationRoot -CreateDirectory
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    foreach ($entry in $Hashes.GetEnumerator()) {
        $source = Join-Path $SourceRoot $entry.Key
        Assert-NoReparsePath $source
        $stream = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ($stream.Length -lt 1 -or $stream.Length -gt 1048576) {
                throw "WFP diagnostic source has an invalid size: $($entry.Key)"
            }
            $bytes = [byte[]]::new([int] $stream.Length)
            for ($offset = 0; $offset -lt $bytes.Length; $offset += $read) {
                $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
                if ($read -eq 0) { throw "WFP diagnostic source changed during read: $($entry.Key)" }
            }
        } finally { $stream.Dispose() }
        $canonical = $encoding.GetBytes($encoding.GetString($bytes).Replace("`r`n", "`n"))
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha.ComputeHash($canonical)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($digest -cne $entry.Value) { throw "WFP diagnostic source pin mismatch: $($entry.Key)" }
        $destination = Join-Path $DestinationRoot $entry.Key
        $copy = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $copy.Write($canonical, 0, $canonical.Length) }
        finally { $copy.Dispose() }
    }
}

function Write-WfpEnforcementFaultReport([string] $Path, [string] $State) {
    Write-DiagnosticFile $Path ([ordered]@{
        schemaVersion = 'clue-windows-wfp-enforcement-fault-diagnostic/1'
        checkedAt = [DateTime]::UtcNow.ToString('o')
        state = $State
        setupStage = $script:setupStage
        stageAclMismatch = $script:wfpFaultStageAclMismatch
        priorStageReconciliation = $script:wfpFaultPriorStageReconciliation
        blockedPriorStageId = $script:wfpFaultBlockedPriorStageId
        proofAuthorization = $false
        bfeRestartQualified = $false
        hostTraffic = 'NOT_TESTED'
        offHostLan = 'NOT_TESTED'
        phaseBindOrder = @('ipv4Tcp', 'ipv6Tcp', 'ipv4Udp', 'ipv6Udp')
        productionBlockers = @('PRODUCTION_LOOPBACK_ENFORCEMENT_UNQUALIFIED', 'NO_INDEPENDENT_LAN_PEER')
        windowsHost = $script:windowsHost
        engineVersion = 'v1.0.1'
        engineSha256 = $script:mxcHash
        mxcDownload = $script:mxcDownload
        controllerSha256 = $script:wfpFaultControllerHash
        fixtureSha256 = $script:wfpFaultFixtureHash
        enforcementFault = $script:wfpFaultResult
        cleanup = $script:wfpFaultCleanup
        diagnosticStageRetained = $script:wfpFaultCleanup -ceq 'RETAINED_UNVERIFIED'
    }) 32768
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
$admissionNodeHash = $null
$admissionSupervisorHash = $null
$admissionFixtureHash = $null
$admissionRunnerHash = $null
$admissionNpmCli = $null
$admissionNpmCliHash = $null
$admissionCleanup = 'NOT_REQUIRED'
$admissionCleanupAttempted = $false
$governedWfpDiagnosticSelected = $InstalledGovernedWfpDiagnostic -or $InstalledGovernedWfpOwnerLossDiagnostic
$governedWorkloadDiagnosticSelected = $GovernedWorkloadDiagnostic -or $InstalledGovernedWorkloadDiagnostic -or $governedWfpDiagnosticSelected
$admissionCleanupMaximumEntries = if ($governedWorkloadDiagnosticSelected) { 50000 } else { 1024 }
$admissionExitCode = $null
$admissionResult = $null
$admissionOwnedInstallation = $null
$admissionProtectedInstallation = $null
$admissionOperatorSid = $null
$admissionWfpPreludePath = $null
$admissionWfpPreludeHash = $null
$admissionInstallationHandles = [Collections.Generic.List[IO.FileStream]]::new()
$admissionInstallationCleanupAttempted = $false
$admissionInstallation = [ordered]@{
    layout = if ($governedWfpDiagnosticSelected) { 'PROGRAM_FILES_GOVERNED_WFP_CONTENT_ADDRESSED' } else { 'INSTALLED_DIAGNOSTICS_CONTENT_ADDRESSED' }
    state = 'NOT_ATTEMPTED'
    wrapperSha256 = $null
    engineSha256 = $null
    verifiedBefore = $false
    verifiedAfter = $false
    cleanup = 'NOT_REQUIRED'
}
if ($governedWfpDiagnosticSelected) { $admissionInstallation.buildFailure = $null }
if ($InstalledGovernedWfpOwnerLossDiagnostic) { $admissionInstallation.ownerLossCleanupVerified = $false }
$wfpFaultResult = $null
$wfpFaultControllerHash = $null
$wfpFaultFixtureHash = $null
$wfpFaultStageAclMismatch = $null
$wfpFaultPriorStageReconciliation = @()
$wfpFaultBlockedPriorStageId = $null
$wfpFaultCleanup = 'NOT_REQUIRED'
$wfpFaultCleanupAttempted = $false
$setupStage = 'HOST_PREREQUISITES'
$operatorWorkloadDiagnostic = $ReviewedWorkloadDiagnostic -or $governedWorkloadDiagnosticSelected
$stagedProofDiagnostic = $ProofAdmissionDiagnostic -or $operatorWorkloadDiagnostic
$stagedWfpDiagnostic = $WfpPairedDiagnostic -or $WfpEnforcementFaultDiagnostic
$setupFailureState = $null
try {
    if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows) { throw 'Run this setup on native Windows with PowerShell 7.' }
    if ($WfpDiagnostic -and $WfpPairedDiagnostic) { throw 'Select one WFP diagnostic mode.' }
    if ($WfpBfeLab -and !$WfpPairedDiagnostic) { throw 'The BFE lab requires the paired WFP diagnostic.' }
    if ($ProofAdmissionDiagnostic -and ($WfpDiagnostic -or $WfpPairedDiagnostic -or $WfpBfeLab)) {
        throw 'Run the proof admission diagnostic separately from the WFP diagnostics.'
    }
    if ($ReviewedWorkloadDiagnostic -and ($ProofAdmissionDiagnostic -or $WfpDiagnostic -or $WfpPairedDiagnostic -or $WfpBfeLab)) {
        throw 'Run the reviewed workload diagnostic separately from other diagnostics.'
    }
    if ($GovernedWorkloadDiagnostic -and ($ReviewedWorkloadDiagnostic -or $ProofAdmissionDiagnostic -or
        $WfpDiagnostic -or $WfpPairedDiagnostic -or $WfpBfeLab)) {
        throw 'Run the governed workload diagnostic separately from other diagnostics.'
    }
    if ($InstalledGovernedWorkloadDiagnostic -and ($GovernedWorkloadDiagnostic -or $ReviewedWorkloadDiagnostic -or
        $ProofAdmissionDiagnostic -or $WfpDiagnostic -or $WfpPairedDiagnostic -or $WfpBfeLab -or
        $WfpEnforcementFaultDiagnostic)) {
        throw 'Run the installed governed workload diagnostic separately from other diagnostics.'
    }
    if ($governedWfpDiagnosticSelected -and ($InstalledGovernedWorkloadDiagnostic -or $GovernedWorkloadDiagnostic -or
        $ReviewedWorkloadDiagnostic -or $ProofAdmissionDiagnostic -or $WfpDiagnostic -or $WfpPairedDiagnostic -or
        $WfpBfeLab -or $WfpEnforcementFaultDiagnostic)) {
        throw 'Run the installed governed WFP diagnostic separately from other diagnostics.'
    }
    if ($InstalledGovernedWfpOwnerLossDiagnostic -and $InstalledGovernedWfpDiagnostic) {
        throw 'Run the governed WFP owner-loss diagnostic separately from the regular governed WFP diagnostic.'
    }
    if ($WfpEnforcementFaultDiagnostic -and ($stagedProofDiagnostic -or $WfpDiagnostic -or
        $WfpPairedDiagnostic -or $WfpBfeLab)) {
        throw 'Run the WFP enforcement fault diagnostic separately from other diagnostics.'
    }
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
    $report = if ($WfpEnforcementFaultDiagnostic) {
        Join-Path $evidence "CLU-E_WINDOWS_WFP_ENFORCEMENT_FAULT_$stamp.json"
    } elseif ($InstalledGovernedWfpOwnerLossDiagnostic) {
        Join-Path $evidence "CLU-E_WINDOWS_GOVERNED_WFP_OWNER_LOSS_$stamp.json"
    } elseif ($governedWfpDiagnosticSelected) {
        Join-Path $evidence "CLU-E_WINDOWS_GOVERNED_WFP_$stamp.json"
    } elseif ($InstalledGovernedWorkloadDiagnostic) {
        Join-Path $evidence "CLU-E_WINDOWS_INSTALLED_GOVERNED_WORKLOAD_$stamp.json"
    } elseif ($GovernedWorkloadDiagnostic) {
        Join-Path $evidence "CLU-E_WINDOWS_GOVERNED_WORKLOAD_$stamp.json"
    } elseif ($ReviewedWorkloadDiagnostic) {
        Join-Path $evidence "CLU-E_WINDOWS_REVIEWED_WORKLOAD_$stamp.json"
    } elseif ($ProofAdmissionDiagnostic) {
        Join-Path $evidence "CLU-E_WINDOWS_PROOF_ADMISSION_$stamp.json"
    } else { Join-Path $evidence "CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_$stamp.json" }
    if (!$operatorWorkloadDiagnostic -and !$WfpEnforcementFaultDiagnostic) { Assert-NoReparsePath $install -CreateDirectory }

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
    if ($WfpDiagnostic -or $stagedWfpDiagnostic) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            if ($WfpEnforcementFaultDiagnostic) { $windowsHost.elevated = $elevated }
            if (!$elevated) {
                if ($WfpEnforcementFaultDiagnostic) {
                    $setupFailureState = 'WFP_ENFORCEMENT_FAULT_REQUIRES_ADMINISTRATOR'
                    throw 'Right-click CLUE-Windows-WFP-Enforcement-Fault.bat and choose Run as administrator.'
                }
                throw 'Right-click CLUE-Windows-WFP-Diagnostic.bat and choose Run as administrator.'
            }
        } finally { $identity.Dispose() }
        if ($WfpEnforcementFaultDiagnostic) { Assert-NoReparsePath $install -CreateDirectory }
    }
    if ($WfpBfeLab) {
        $setupStage = 'BFE_LAB_PREREQUISITES'
        $bfeLabReader = Join-Path $PSScriptRoot 'WfpBfeLabSetup.ps1'
        Assert-NoReparsePath $bfeLabReader
        . $bfeLabReader
        $bfeLabConfirmation = Read-Host 'Type DISPOSABLE OFFLINE HYPER-V GUEST to confirm the lab VM is isolated and checkpointed'
        Assert-WfpBfeLabEnvironment -Confirmation $bfeLabConfirmation
    }
    if ($stagedWfpDiagnostic) {
        $staticDiagnosticLock = [Threading.Mutex]::new($false, 'Local\CLU-E-StaticDiagnostic-05P')
        try { $staticDiagnosticLockHeld = $staticDiagnosticLock.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $staticDiagnosticLockHeld = $true }
        if (!$staticDiagnosticLockHeld) { throw 'Another CLU-E static diagnostic is running in this session.' }
    }
    if ($WfpPairedDiagnostic) {
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
    if ($WfpEnforcementFaultDiagnostic) {
        $setupStage = 'WFP_ENFORCEMENT_FAULT_PREREQUISITES'
        Write-Host '[1/4] Checking the Windows WFP enforcement fault diagnostic prerequisites.'
    }
    if ($stagedProofDiagnostic) {
        if ($InstalledGovernedWfpOwnerLossDiagnostic) {
            Write-Host '[1/4] Checking the governed Windows WFP owner-loss diagnostic prerequisites.'
        } elseif ($governedWfpDiagnosticSelected) {
            Write-Host '[1/4] Checking the governed Windows WFP diagnostic prerequisites.'
        } elseif ($InstalledGovernedWorkloadDiagnostic) {
            Write-Host '[1/4] Checking the installed governed Windows workload diagnostic prerequisites.'
        } elseif ($governedWorkloadDiagnosticSelected) {
            Write-Host '[1/4] Checking the governed Windows workload diagnostic prerequisites.'
        } elseif ($ReviewedWorkloadDiagnostic) {
            Write-Host '[1/4] Checking the reviewed Windows workload diagnostic prerequisites.'
        } else {
            Write-Host '[1/4] Checking the Windows proof admission diagnostic prerequisites.'
        }
        Remove-Item Env:NODE_OPTIONS, Env:NODE_PATH, Env:NODE_COMPILE_CACHE, Env:NODE_V8_COVERAGE, Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            $windowsHost.elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            if ($governedWfpDiagnosticSelected) { $admissionOperatorSid = $identity.User.Value }
        } finally { $identity.Dispose() }
        if ($operatorWorkloadDiagnostic) {
            if ($windowsHost.elevated) {
                if ($InstalledGovernedWfpOwnerLossDiagnostic) {
                    $setupFailureState = 'GOVERNED_WFP_OWNER_LOSS_REQUIRES_STANDARD_USER'
                    throw 'Open the governed WFP owner-loss launcher from normal Windows Explorer without Run as administrator.'
                }
                if ($governedWfpDiagnosticSelected) {
                    $setupFailureState = 'GOVERNED_WFP_REQUIRES_STANDARD_USER'
                    throw 'Open the governed WFP launcher from normal Windows Explorer without Run as administrator.'
                }
                if ($InstalledGovernedWorkloadDiagnostic) {
                    $setupFailureState = 'INSTALLED_GOVERNED_WORKLOAD_REQUIRES_STANDARD_USER'
                    throw 'Open the installed governed workload launcher from normal Windows Explorer without Run as administrator.'
                }
                if ($governedWorkloadDiagnosticSelected) {
                    $setupFailureState = 'GOVERNED_WORKLOAD_REQUIRES_STANDARD_USER'
                    throw 'Open the governed workload launcher from normal Windows Explorer without Run as administrator.'
                }
                $setupFailureState = 'REVIEWED_WORKLOAD_REQUIRES_STANDARD_USER'
                throw 'Open the reviewed workload launcher from normal Windows Explorer without Run as administrator.'
            }
            Assert-NoReparsePath $install -CreateDirectory
        }
    }
    $node = ''
    if (!$WfpEnforcementFaultDiagnostic) {
        $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $nodeResult = @(& $node -p "require('node:fs').realpathSync.native(process.execPath)")
        if ($LASTEXITCODE -ne 0 -or $nodeResult.Count -ne 1) { throw 'Could not resolve the selected native Node executable.' }
        $node = Get-LocalPath $nodeResult[0]
        Assert-NoReparsePath $node
        if ($stagedProofDiagnostic) {
            $admissionNodeHash = Get-Sha256 $node
            if ($governedWorkloadDiagnosticSelected) {
                $setupStage = 'GOVERNED_WORKLOAD_NPM_PREREQUISITE'
                $admissionNpmCli = Get-LocalPath (Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js')
                Assert-NoReparsePath $admissionNpmCli
                $admissionNpmItem = Get-Item -LiteralPath $admissionNpmCli -Force
                if ($admissionNpmItem.PSIsContainer -or $admissionNpmItem.Length -lt 1 -or $admissionNpmItem.Length -gt 1048576) {
                    throw 'The governed workload requires the npm CLI installed beside Node.'
                }
                $admissionNpmCliHash = Get-Sha256 $admissionNpmCli
            }
        } else {
            $npm = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
            if (!(Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'Install Node.js with npm, then reopen this launcher.' }
            if (!(Test-Path -LiteralPath (Join-Path $repo 'node_modules\typescript\bin\tsc') -PathType Leaf)) {
                throw 'Run npm.cmd ci in the CLU-E project, then reopen this launcher.'
            }
        }
    }

    $systemRoot = if ($WfpEnforcementFaultDiagnostic) {
        Split-Path -Parent ([Environment]::SystemDirectory)
    } else { $env:SystemRoot }
    $framework = Join-Path $systemRoot 'Microsoft.NET\Framework64\v4.0.30319'
    $csc = Join-Path $framework 'csc.exe'
    $web = Join-Path $systemRoot 'Microsoft.NET\assembly\GAC_MSIL\System.Web.Extensions\v4.0_4.0.0.0__31bf3856ad364e35\System.Web.Extensions.dll'
    if (!(Test-Path -LiteralPath $csc -PathType Leaf) -or !(Test-Path -LiteralPath $web -PathType Leaf)) {
        throw 'The Windows .NET Framework 4.x C# compiler and System.Web.Extensions are required.'
    }
    if ($WfpEnforcementFaultDiagnostic) {
        Assert-NoReparsePath $csc
        Assert-NoReparsePath $web
    }
    $sourceNames = @('Supervisor.cs', 'Protocol.cs', 'NativeJob.cs', 'WfpBootstrapRun.cs',
        'WfpContainerIdentity.cs', 'WfpLoopbackLease.cs', 'WfpDropObservation.cs', 'WfpBfeWatch.cs',
        'WfpIntegratedRun.cs', 'WfpIntegratedGuardian.cs')
    $sources = foreach ($sourceName in $sourceNames) {
        $source = Join-Path $PSScriptRoot $sourceName
        Assert-NoReparsePath $source
        $source
    }

    foreach ($key in @('OPENAI_API_KEY', 'CLU_WINDOWS_SUPERVISOR_PATH', 'CLU_WINDOWS_SUPERVISOR_SHA256',
        'CLU_WINDOWS_SUPERVISOR_QUALIFICATION', 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256')) {
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    }
    $qualificationTemp = ''
    if (!$WfpEnforcementFaultDiagnostic) {
        $env:PATH = (Split-Path -Parent $node) + ';' + (Join-Path $env:SystemRoot 'System32') + ';' + $env:PATH
        $tempResult = @(& $node -p "require('node:fs').realpathSync.native(require('node:os').tmpdir())")
        if ($LASTEXITCODE -ne 0 -or $tempResult.Count -ne 1) { throw 'Node could not resolve its native qualification temp root.' }
        $qualificationTemp = Get-LocalPath $tempResult[0]
        Assert-NoReparsePath $qualificationTemp
    }

    if (!$stagedProofDiagnostic -and !$WfpEnforcementFaultDiagnostic) {
        $setupStage = 'CLUE_BUILD'
        Write-Host '[1/4] Building CLU-E and checking supervisor prerequisites.'
        if ((Invoke-ExactExecutable $node @($npm, 'run', 'build') $repo) -ne 0) { throw 'CLU-E build failed.' }
    }

    $setupStage = 'MXC_RELEASE_VERIFICATION'
    Write-Host '[2/4] Verifying the pinned Microsoft MXC release and building the CLU-E supervisor.'
    $diagnosticSourceRoot = $PSScriptRoot
    if ($WfpEnforcementFaultDiagnostic) {
        $faultStageRoot = Get-LocalPath ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))
        Assert-NoReparsePath $faultStageRoot
        $stage = Join-Path $faultStageRoot ('.clue-wfp-fault-setup-' + [Guid]::NewGuid().ToString('N'))
        if ((Test-Inside $repo $stage) -or (Test-Inside $stage $repo) -or
            (Test-Inside $evidence $stage) -or (Test-Inside $stage $evidence) -or
            (Test-Inside $install $stage) -or (Test-Inside $stage $install)) {
            throw 'Keep the protected WFP diagnostic stage separate from the project, cache and evidence.'
        }
        # OWNER RIGHTS suppresses the owner's implicit WRITE_DAC for a filtered token.
        $faultStageDacl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;RC;;;OW)'
        $setupStage = 'WFP_ENFORCEMENT_FAULT_STAGE_ACL'
        New-WfpFaultStage $stage $faultStageDacl
        $setupStage = 'MXC_RELEASE_VERIFICATION'
        $diagnosticSourceRoot = Join-Path $stage 'trusted-source'
        $faultSourceSha256 = [ordered]@{
            # Pinned canonical UTF-8/LF sources. See the patch manifest for raw payload hashes.
            'NativeJob.cs' = '11db6d635accb80083b198aa2c78a49fb6b3f7952011946e4fda430e95e2618d'
            'Protocol.cs' = '5cb1fe80aa78cc8f8f0ecc9f6fa7a5a4c5de22bd82901d44e5525794f2f9194a'
            'Supervisor.cs' = 'c1445035f33a21ab09179124e19925c3fba775f3d4899656a06c7593237c8ce2'
            'WfpBfeWatch.cs' = '6fa8d9c9f7865a35783082f11fb210a64f28705b8f63431c016288a34fc5ab4c'
            'WfpBootstrapRun.cs' = '92bfb701d33f672bc3788c3d67a74d0bc7baf96d11f41597989e4c869e74f990'
            'WfpContainerIdentity.cs' = 'adf701f021cba2cf6de73660e8f890ce18fa1de690cbf227059154e41442bb34'
            'WfpDropObservation.cs' = 'f9131d325ce6f30d77840d2f786b1ca2898e82338156aa98b7cb3f8c0946510b'
            'WfpEnforcementFaultSetup.ps1' = '620d31ba73e6fbd2c01f930b373ddcec555cc5bb34856e31c6981f923a16df4c'
            'WfpFaultRecovery.cs' = 'f14116dcab8e4888253e314e099c30d7d93ed938a00fc7b6d510dc836b553536'
            'WfpHostLoopbackFixture.cs' = 'bc0e7b99bab9723a2b0de32ec787dac04d5748f11b4cd844ac5e370495e38285'
            'WfpIntegratedRun.cs' = '813d3e74991c9aa4ed2b03b7a66164ca6328b54484b24a2a5d9dc2e6e75f01bf'
            'WfpIntegratedGuardian.cs' = 'dc5cc80ceb0cc9929ff883aaffeb9e24394f2367695c06b93175e6c7288b4400'
            'WfpLeaseFaultController.cs' = 'd42b820a23fcb38b8e0234e84bcf631c7bed29b71e230057fc358e91b511ba99'
            'WfpLoopbackLease.cs' = '22f6da4c0a380763e00c17892b10452c3746a42c346e63467e997d077e60c9d0'
            'WfpPairedFixture.cs' = '7b0f9ffb806860cdb6a775f4756fe72a21805e79ff6dbc15955c6fea2d081c7d'
            'WfpPairedSetup.ps1' = '6f9c22fc24a32db27944a32af5a8593c8e85695b783a4b79b3ac22feccd6249d'
            'WfpPairedSupervisor.cs' = '51776524b9a2e5b968efce39bb6cfd1d6f9cde4b2175db1fca67b38796f75c15'
            'WfpStaticRecovery.cs' = '3deae31a6212bfb98926c3e0a541ac15eeff9cc0d4c1a26510112f659c90dc03'
        }
        Copy-WfpFaultPinnedInputs $PSScriptRoot $diagnosticSourceRoot $faultSourceSha256
        $sources = foreach ($sourceName in $sourceNames) { Join-Path $diagnosticSourceRoot $sourceName }
        . (Join-Path $diagnosticSourceRoot 'WfpPairedSetup.ps1')
    } else {
        $stage = Join-Path $install ('.setup-' + [Guid]::NewGuid().ToString('N'))
        Assert-NoReparsePath $stage -CreateDirectory
    }
    $bin = Join-Path $stage 'bin'
    Assert-NoReparsePath $bin -CreateDirectory
    $mxc = Join-Path $bin 'wxc-exec.exe'
    if (!(Copy-PinnedInstalledMxc $arch $install $mxc $mxcDownload)) {
        if ($stagedProofDiagnostic) {
            $mxcDownload.state = 'VERIFIED_X64_CACHE_REQUIRED'
            if ($governedWorkloadDiagnosticSelected) {
                throw 'The governed workload diagnostic requires the previously verified x64 MXC engine under the current Windows account.'
            }
            if ($ReviewedWorkloadDiagnostic) {
                throw 'The reviewed workload diagnostic requires the previously verified x64 MXC engine under the current Windows account.'
            }
            throw 'The proof admission diagnostic requires the previously verified x64 MXC engine under the current Windows account.'
        }
        if ($WfpDiagnostic -or $stagedWfpDiagnostic) {
            $mxcDownload.state = 'VERIFIED_X64_CACHE_REQUIRED'
            throw 'The WFP diagnostic requires the previously verified x64 MXC engine under the current Windows account.'
        }
        Get-MxcExecutable $arch $stage $mxc $mxcDownload
    }
    if (!$stagedProofDiagnostic -and !$WfpEnforcementFaultDiagnostic -and
        (Invoke-ExactExecutable $mxc @('--help') $bin 15) -ne 0) {
        throw 'The signed MXC executor could not start standalone on this Windows installation.'
    }
    $mxcHash = Get-Sha256 $mxc
    $setupStage = 'SUPERVISOR_BUILD_AND_INSTALL'
    $pinSource = Join-Path $stage 'MxcPin.cs'
    $quotedTemp = $qualificationTemp.Replace('"', '""')
    $quotedNode = $node.Replace('"', '""')
    $quotedAdmissionStage = ''
    $admissionScriptPin = ''
    $admissionReviewedPin = 'false'
    $admissionGovernedPin = 'false'
    $admissionNpmCliPin = ''
    if ($stagedProofDiagnostic) {
        $setupStage = if ($governedWfpDiagnosticSelected) {
            'GOVERNED_WFP_STAGE_PREPARATION'
        } elseif ($InstalledGovernedWorkloadDiagnostic) {
            'INSTALLED_GOVERNED_WORKLOAD_BUILD'
        } elseif ($governedWorkloadDiagnosticSelected) {
            'GOVERNED_WORKLOAD_BUILD'
        } elseif ($ReviewedWorkloadDiagnostic) { 'REVIEWED_WORKLOAD_BUILD' } else { 'PROOF_ADMISSION_BUILD' }
        $admissionStage = Join-Path $stage 'admission'
        Assert-NoReparsePath $admissionStage -CreateDirectory
        $quotedAdmissionStage = $admissionStage.Replace('"', '""')
        $admissionFixtureSource = if ($governedWorkloadDiagnosticSelected) {
            $admissionGovernedPin = 'true'
            $admissionNpmCliPin = $admissionNpmCliHash
            Join-Path $PSScriptRoot 'GovernedWorkloadBootstrap.cjs'
        } elseif ($ReviewedWorkloadDiagnostic) {
            $admissionReviewedPin = 'true'
            Join-Path $PSScriptRoot 'ReviewedWorkloadBootstrap.cjs'
        } else { Join-Path $PSScriptRoot 'ProofAdmissionFixture.cjs' }
        Assert-NoReparsePath $admissionFixtureSource
        $admissionFixtureHash = Get-Sha256 $admissionFixtureSource
        $admissionScriptPin = $admissionFixtureHash
    }
    $frameworkReferences = @('mscorlib.dll', 'System.dll', 'System.Core.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
    $compilerBase = @('/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/optimize+', '/langversion:5', '/codepage:65001')
    $diagnosticPins = ''
    if ($stagedWfpDiagnostic) {
        $diagnosticDirectories = if ($WfpEnforcementFaultDiagnostic) {
            $setupStage = 'WFP_ENFORCEMENT_FAULT_BUILD'
            @('fixture', 'enforcement-fault\private', 'enforcement-fault\workspace')
        } else {
            $setupStage = 'PAIRED_DIAGNOSTIC_BUILD'
            @('fixture', 'paired\private', 'paired\workspace', 'crash\private', 'crash\workspace',
                'static-crash\private', 'static-crash\workspace', 'static-double\private', 'static-double\workspace',
                'host-net\private', 'host-net\workspace', 'bfe-guard\private', 'bfe-guard\workspace',
                'bfe-lab\private', 'bfe-lab\workspace')
        }
        foreach ($directory in $diagnosticDirectories) {
            Assert-NoReparsePath (Join-Path $stage $directory) -CreateDirectory
        }
        $fixtureSource = Join-Path $diagnosticSourceRoot 'WfpPairedFixture.cs'
        $hostLoopbackFixtureSource = Join-Path $diagnosticSourceRoot 'WfpHostLoopbackFixture.cs'
        $controllerSource = Join-Path $diagnosticSourceRoot 'WfpPairedSupervisor.cs'
        $staticRecoverySource = Join-Path $diagnosticSourceRoot 'WfpStaticRecovery.cs'
        $leaseFaultSource = Join-Path $diagnosticSourceRoot 'WfpLeaseFaultController.cs'
        $faultRecoverySource = Join-Path $diagnosticSourceRoot 'WfpFaultRecovery.cs'
        Assert-NoReparsePath $fixtureSource
        Assert-NoReparsePath $hostLoopbackFixtureSource
        Assert-NoReparsePath $controllerSource
        Assert-NoReparsePath $staticRecoverySource
        Assert-NoReparsePath $leaseFaultSource
        Assert-NoReparsePath $faultRecoverySource
        $fixture = Join-Path $stage 'fixture\WfpPairedFixture.exe'
        $fixtureArgs = $compilerBase + @('/platform:x64', "/out:$fixture") +
            $frameworkReferences + $fixtureSource + $hostLoopbackFixtureSource
        if ((Invoke-ExactExecutable $csc $fixtureArgs $stage 60) -ne 0) { throw 'Native bind fixture compilation failed.' }
        Assert-NoReparsePath $fixture
        $fixtureHash = Get-Sha256 $fixture
        if ($WfpEnforcementFaultDiagnostic) { $wfpFaultFixtureHash = $fixtureHash }
        $quotedStage = $stage.Replace('"', '""')
        $faultModePin = if ($WfpEnforcementFaultDiagnostic) { 'true' } else { 'false' }
        $diagnosticPins = @"
    internal const string WfpDiagnosticStage = @"$quotedStage";
    internal const string WfpDiagnosticFixtureSha256 = "$fixtureHash";
    internal const bool WfpEnforcementFaultEnabled = $faultModePin;
"@
    }
    $generatedPin = @"
internal static class MxcPin {
    internal const string Sha256 = "$mxcHash";
    internal const string QualificationTempRoot = @"$quotedTemp";
    internal const string QualificationNodeExe = @"$quotedNode";
    internal const string ProofAdmissionStage = @"$quotedAdmissionStage";
    internal const string ProofAdmissionScriptSha256 = "$admissionScriptPin";
    internal const bool ProofAdmissionReviewedWorkload = $admissionReviewedPin;
    internal const bool ProofAdmissionGovernedWorkload = $admissionGovernedPin;
    internal const string ProofAdmissionNpmCliSha256 = "$admissionNpmCliPin";
    internal const bool GovernedWfpIntegration = false;
    internal const bool GovernedWfpOwnerLoss = false;
    internal const string GovernedWfpPreludeSha256 = "";
    internal const int GovernedWfpOperatorPid = 0;
$diagnosticPins
}
"@
    [IO.File]::WriteAllText($pinSource, $generatedPin)
    if ($stagedProofDiagnostic) {
        if ($governedWfpDiagnosticSelected) {
            $setupStage = 'GOVERNED_WFP_PROTECTED_BUILD'
            $admissionInstallation.buildFailure = 'WFP_BUILD_LAUNCHER_PREFLIGHT'
            $admissionWfpPreludePath = Join-Path $PSScriptRoot 'GovernedWfpBindPrelude.cjs'
            Assert-NoReparsePath $admissionWfpPreludePath
            $admissionWfpPreludeHash = Get-Sha256 $admissionWfpPreludePath
            $stageCleanupSafe = $false
            $admissionInstallation.state = 'BUILD_REQUESTED'
            $protectedImage = Invoke-InstalledGovernedWfpBuild $stage $node $admissionNodeHash $admissionNpmCliHash $qualificationTemp $mxcHash $admissionOperatorSid $sessionId -OwnerLoss:$InstalledGovernedWfpOwnerLossDiagnostic
            $admissionInstallation.buildFailure = 'WFP_BUILD_INSTALLED_IMAGE_VERIFICATION'
            $admissionProtectedInstallation = $protectedImage.directory
            $admissionSupervisorHash = $protectedImage.wrapperSha256
            $admissionSupervisor = Join-Path $admissionProtectedInstallation 'CLU-E-Windows-Supervisor.exe'
            $mxc = Join-Path $admissionProtectedInstallation 'wxc-exec.exe'
            $admissionInstallation.wrapperSha256 = $admissionSupervisorHash
            $admissionInstallation.engineSha256 = $mxcHash
            $admissionInstallation.guardianPid = $protectedImage.guardianPid
            $admissionInstallation.state = 'PROTECTED_READY'
            $admissionInstallation.cleanup = 'RETAINED_PROTECTED_AUDIT'
            foreach ($image in @($admissionSupervisor, $mxc)) {
                Assert-NoReparsePath $image
                $admissionInstallationHandles.Add([IO.File]::Open($image, [IO.FileMode]::Open,
                    [IO.FileAccess]::Read, [IO.FileShare]::Read))
            }
            Assert-InstalledGovernedImages $admissionProtectedInstallation $admissionSupervisorHash $mxcHash
            $admissionInstallation.verifiedBefore = $true
            $admissionInstallation.buildFailure = $null
            $env:ProgramFiles = $protectedImage.programFiles
        } else {
            $admissionSupervisor = Join-Path $bin 'CLU-E-Windows-Supervisor.exe'
            $admissionArgs = $compilerBase + @('/platform:anycpu', '/main:Supervisor', "/out:$admissionSupervisor", "/reference:$web") +
                $frameworkReferences + $sources + $pinSource
            if ((Invoke-ExactExecutable $csc $admissionArgs $stage 60) -ne 0) { throw 'Staged diagnostic supervisor compilation failed.' }
            Assert-NoReparsePath $admissionSupervisor
            $admissionSupervisorHash = Get-Sha256 $admissionSupervisor
        }
        if ($InstalledGovernedWorkloadDiagnostic) {
            $setupStage = 'INSTALLED_GOVERNED_WORKLOAD_INSTALLATION'
            $admissionInstallation.wrapperSha256 = $admissionSupervisorHash
            $admissionInstallation.engineSha256 = $mxcHash
            $installationRoot = Join-Path $install 'installed-diagnostics'
            Assert-NoReparsePath $installationRoot -CreateDirectory
            $destination = Join-Path $installationRoot $admissionSupervisorHash
            if (Test-Path -LiteralPath $destination) {
                $admissionInstallation.state = 'COLLISION_REFUSED'
                $setupFailureState = 'INSTALLED_GOVERNED_WORKLOAD_INSTALLATION_COLLISION'
                throw 'The installed diagnostic destination already exists.'
            }
            # Directory.Move rejects an existing destination, including one created after the check.
            [IO.Directory]::Move($bin, $destination)
            $admissionOwnedInstallation = $destination
            $admissionInstallation.state = 'OWNED'
            $admissionSupervisor = Join-Path $destination 'CLU-E-Windows-Supervisor.exe'
            $mxc = Join-Path $destination 'wxc-exec.exe'
            foreach ($image in @($admissionSupervisor, $mxc)) {
                Assert-NoReparsePath $image
                $admissionInstallationHandles.Add([IO.File]::Open($image, [IO.FileMode]::Open,
                    [IO.FileAccess]::Read, [IO.FileShare]::Read))
            }
            Assert-InstalledGovernedImages $destination $admissionSupervisorHash $mxcHash
            $admissionInstallation.verifiedBefore = $true
        }
        if ($governedWorkloadDiagnosticSelected) {
            $admissionRunner = Join-Path $repo 'tools\p2-windows-governed-workload-diagnostic.mjs'
            $admissionSchema = 'clue-windows-governed-workload/1'
            $admissionSuccess = if ($InstalledGovernedWfpOwnerLossDiagnostic) {
                'GOVERNED_WORKLOAD_OWNER_LOSS_OBSERVED'
            } else { 'GOVERNED_WORKLOAD_OBSERVED' }
            $admissionTimeout = 1200
            if ($InstalledGovernedWfpOwnerLossDiagnostic) {
                $admissionLabel = 'CLU-E governed WFP owner loss'
                $setupStage = 'GOVERNED_WFP_OWNER_LOSS_EXECUTION'
            } elseif ($governedWfpDiagnosticSelected) {
                $admissionLabel = 'CLU-E governed WFP workload'
                $setupStage = 'GOVERNED_WFP_WORKLOAD_EXECUTION'
            } elseif ($InstalledGovernedWorkloadDiagnostic) {
                $admissionLabel = 'CLU-E installed governed workload'
                $setupStage = 'INSTALLED_GOVERNED_WORKLOAD_EXECUTION'
            } else {
                $admissionLabel = 'CLU-E governed workload'
                $setupStage = 'GOVERNED_WORKLOAD_EXECUTION'
            }
        } elseif ($ReviewedWorkloadDiagnostic) {
            $admissionRunner = Join-Path $repo 'tools\p2-windows-reviewed-workload-diagnostic.mjs'
            $admissionSchema = 'clue-windows-reviewed-workload/1'
            $admissionSuccess = 'REVIEWED_WORKLOADS_OBSERVED'
            $admissionTimeout = 420
            $admissionLabel = 'CLU-E reviewed workload'
            $setupStage = 'REVIEWED_WORKLOAD_EXECUTION'
        } else {
            $admissionRunner = Join-Path $repo 'tools\p2-windows-proof-admission-diagnostic.mjs'
            $admissionSchema = 'clue-windows-proof-admission-fixture/1'
            $admissionSuccess = 'PRODUCTION_SHAPED_FIXTURES_OBSERVED'
            $admissionTimeout = 220
            $admissionLabel = 'CLU-E proof admission'
        }
        Assert-NoReparsePath $admissionRunner
        if ($operatorWorkloadDiagnostic) { $admissionRunnerHash = Get-Sha256 $admissionRunner }
        $admissionOutput = Join-Path $stage 'admission-result.json'
        if ($InstalledGovernedWfpOwnerLossDiagnostic) {
            Write-Host '[3/4] Running the reviewed Windows workload up to the protected WFP owner-loss fault gate.'
        } elseif ($governedWfpDiagnosticSelected) {
            Write-Host '[3/4] Reviewing and running the Windows workload as the standard user with the protected WFP guardian.'
        } elseif ($InstalledGovernedWorkloadDiagnostic) {
            Write-Host '[3/4] Running the reviewed Windows workload through the verified installed diagnostic image.'
        } elseif ($governedWorkloadDiagnosticSelected) {
            Write-Host '[3/4] Preparing reviewed source and offline dependency inputs for the governed Windows workload.'
        } elseif ($ReviewedWorkloadDiagnostic) {
            Write-Host '[3/4] Preparing dashboard snapshots for operator review and Windows workload tests.'
        } else {
            $setupStage = 'PROOF_ADMISSION_EXECUTION'
            Write-Host '[3/4] Running production-shaped baseline and candidate fixture requests on Windows.'
        }
        $admissionRunnerArgs = @($admissionRunner, '--stage', $admissionStage,
            '--supervisor', $admissionSupervisor, '--output', $admissionOutput)
        if ($InstalledGovernedWfpOwnerLossDiagnostic) {
            $admissionRunnerArgs += @('--installed-wfp-owner-loss', $admissionSupervisorHash, $mxcHash)
        } elseif ($governedWfpDiagnosticSelected) {
            $admissionRunnerArgs += @('--installed-wfp', $admissionSupervisorHash, $mxcHash)
        } elseif ($InstalledGovernedWorkloadDiagnostic) {
            $admissionRunnerArgs += @('--installed', $admissionSupervisorHash, $mxcHash)
        }
        $stageCleanupSafe = $false
        $admissionExitCode = Invoke-ExactExecutable $node $admissionRunnerArgs $repo $admissionTimeout
        Assert-NoReparsePath $admissionOutput
        $admissionOutputItem = Get-Item -LiteralPath $admissionOutput -Force
        $admissionMaximumReportBytes = if ($operatorWorkloadDiagnostic) { 65536 } else { 32768 }
        if ($admissionOutputItem.PSIsContainer -or $admissionOutputItem.Length -lt 1 -or
            $admissionOutputItem.Length -gt $admissionMaximumReportBytes) {
            throw 'Staged diagnostic runner report has an invalid size or type.'
        }
        $admissionRead = [IO.File]::ReadAllText($admissionOutput) | ConvertFrom-Json -AsHashtable -Depth 12
        if ($admissionRead -isnot [System.Collections.IDictionary] -or
            $admissionRead['schemaVersion'] -cne $admissionSchema -or
            $admissionRead['proofAuthorization'] -isnot [bool] -or $admissionRead['proofAuthorization'] -ne $false -or
            $admissionRead['stageCleanupSafe'] -isnot [bool] -or
            $admissionRead['state'] -isnot [string] -or $admissionRead['state'] -cnotmatch '\A[A-Z][A-Z0-9_]{1,79}\z' -or
            (!$operatorWorkloadDiagnostic -and (!$admissionRead.Contains('cases') -or !$admissionRead.Contains('refusals'))) -or
            $admissionExitCode -notin @(0, 1) -or
            ($admissionExitCode -eq 0) -ne ($admissionRead['state'] -ceq $admissionSuccess) -or
            ($admissionExitCode -eq 0 -and !$admissionRead['stageCleanupSafe'])) {
            throw 'Staged diagnostic runner report failed contract validation.'
        }
        if ($InstalledGovernedWorkloadDiagnostic -or $governedWfpDiagnosticSelected) {
            $installedImage = $admissionRead['installedImage']
            if ($installedImage -isnot [System.Collections.IDictionary] -or $installedImage.Count -ne 4 -or
                $installedImage['wrapperSha256'] -cne $admissionSupervisorHash -or
                $installedImage['engineSha256'] -cne $mxcHash -or
                $installedImage['verifiedBefore'] -isnot [bool] -or !$installedImage['verifiedBefore'] -or
                $installedImage['verifiedAfter'] -isnot [bool] -or !$installedImage['verifiedAfter']) {
                throw 'The governed workload did not verify the exact installed diagnostic images before and after execution.'
            }
            $installedDirectory = if ($governedWfpDiagnosticSelected) { $admissionProtectedInstallation } else { $admissionOwnedInstallation }
            if ($governedWfpDiagnosticSelected) { Assert-WfpFaultStageAcl $protectedImage.root $protectedImage.dacl }
            Assert-InstalledGovernedImages $installedDirectory $admissionSupervisorHash $mxcHash
            $admissionInstallation.verifiedAfter = $true
            $admissionInstallation.state = 'VERIFIED'
        }
        if ($governedWfpDiagnosticSelected) {
            Assert-NoReparsePath $admissionWfpPreludePath
            if ((Get-Sha256 $admissionWfpPreludePath) -cne $admissionWfpPreludeHash) {
                throw 'The pinned governed WFP prelude changed during execution.'
            }
            if ($admissionExitCode -eq 0) {
                $broker = $admissionRead['brokerConformance']
                if ($broker -isnot [System.Collections.IDictionary] -or
                    $broker['stagedWfpPreludeSha256'] -cne $admissionWfpPreludeHash -or
                    $broker['cases'] -isnot [System.Collections.IDictionary] -or
                    $broker['cases']['candidate'] -isnot [System.Collections.IDictionary]) {
                    throw 'The governed WFP broker evidence did not match the pinned prelude.'
                }
                $wfp = $broker['cases']['candidate']['wfpIntegration']
                $wfpSchema = 'clue-windows-governed-wfp-integration/1'
                $wfpSuccess = 'GOVERNED_WFP_LEASE_OBSERVED'
                $wfpChecks = @('identityVerified', 'leaseVerified', 'jobEmpty', 'removalVerified')
                if ($InstalledGovernedWfpOwnerLossDiagnostic) {
                    $wfpSchema = 'clue-windows-governed-wfp-owner-loss/1'
                    $wfpSuccess = 'GOVERNED_WFP_OWNER_LOSS_OBSERVED'
                    $wfpChecks += @('ownerExitVerified', 'nodeExited', 'releaseWithheld')
                }
                if ($wfp -isnot [System.Collections.IDictionary] -or
                    $wfp['schemaVersion'] -cne $wfpSchema -or $wfp['state'] -cne $wfpSuccess -or
                    $wfp['proofAuthorization'] -isnot [bool] -or $wfp['proofAuthorization'] -or
                    @($wfpChecks | Where-Object { $wfp[$_] -isnot [bool] -or !$wfp[$_] }).Count -ne 0 -or
                    $wfp['control'] -isnot [array] -or $wfp['control'].Count -ne 4 -or
                    $wfp['armed'] -isnot [array] -or $wfp['armed'].Count -ne 4 -or
                    @($wfp['control'] + $wfp['armed'] | Where-Object { $_ -isnot [int] -and $_ -isnot [long] }).Count -ne 0 -or
                    ($wfp['control'] -join ',') -cne '0,0,0,0' -or
                    ($wfp['armed'] -join ',') -cne '10013,10013,10013,10013') {
                    throw 'The governed WFP integration receipt did not verify the loopback lease and cleanup.'
                }
                if ($InstalledGovernedWfpOwnerLossDiagnostic) {
                    $cleanupMarker = Join-Path $protectedImage.root 'owner-loss-cleanup.txt'
                    Assert-NoReparsePath $cleanupMarker
                    $cleanupItem = Get-Item -LiteralPath $cleanupMarker -Force
                    if ($cleanupItem.PSIsContainer -or $cleanupItem.Length -ne 7 -or
                        [IO.File]::ReadAllText($cleanupMarker, [Text.Encoding]::ASCII) -cne 'REMOVED') {
                        throw 'The protected WFP owner-loss cleanup marker failed validation.'
                    }
                    $admissionInstallation.ownerLossCleanupVerified = $true
                }
            }
        }
        if (!$operatorWorkloadDiagnostic) { $stageCleanupSafe = $admissionRead['stageCleanupSafe'] }
        foreach ($admissionPinnedPath in @($node, $admissionSupervisor, $mxc, $admissionFixtureSource)) {
            Assert-NoReparsePath $admissionPinnedPath
        }
        if ((Get-Sha256 $node) -cne $admissionNodeHash -or
            (Get-Sha256 $admissionSupervisor) -cne $admissionSupervisorHash -or
            (Get-Sha256 $mxc) -cne $mxcHash -or
            (Get-Sha256 $admissionFixtureSource) -cne $admissionFixtureHash) {
            throw 'A pinned staged diagnostic input changed during execution.'
        }
        if ($operatorWorkloadDiagnostic) {
            Assert-NoReparsePath $admissionRunner
            if ((Get-Sha256 $admissionRunner) -cne $admissionRunnerHash) {
                if ($governedWorkloadDiagnosticSelected) { throw 'The governed workload diagnostic runner changed during execution.' }
                throw 'The reviewed workload diagnostic runner changed during execution.'
            }
            if ($governedWorkloadDiagnosticSelected) {
                Assert-NoReparsePath $admissionNpmCli
                if ((Get-Sha256 $admissionNpmCli) -cne $admissionNpmCliHash) {
                    throw 'The pinned governed workload npm CLI changed during execution.'
                }
            }
            $stageCleanupSafe = $admissionRead['stageCleanupSafe'] -and
                (!$InstalledGovernedWfpOwnerLossDiagnostic -or $admissionInstallation.ownerLossCleanupVerified)
        }
        $admissionResult = $admissionRead
        $admissionCleanup = Clear-ProofAdmissionStage $stage $stageCleanupSafe $admissionCleanupMaximumEntries
        $admissionCleanupAttempted = $true
        if ($governedWfpDiagnosticSelected) { Close-InstalledGovernedHandles $admissionInstallationHandles }
        if ($InstalledGovernedWorkloadDiagnostic) {
            Close-InstalledGovernedHandles $admissionInstallationHandles
            $admissionInstallation.cleanup = Clear-InstalledGovernedImages $admissionOwnedInstallation $admissionCleanup $admissionSupervisorHash $mxcHash
            $admissionInstallationCleanupAttempted = $true
        }
        $setupStage = if ($InstalledGovernedWfpOwnerLossDiagnostic) {
            'GOVERNED_WFP_OWNER_LOSS_FINISHED'
        } elseif ($governedWfpDiagnosticSelected) {
            'GOVERNED_WFP_WORKLOAD_FINISHED'
        } elseif ($InstalledGovernedWorkloadDiagnostic) {
            'INSTALLED_GOVERNED_WORKLOAD_FINISHED'
        } elseif ($governedWorkloadDiagnosticSelected) {
            'GOVERNED_WORKLOAD_FINISHED'
        } elseif ($ReviewedWorkloadDiagnostic) { 'REVIEWED_WORKLOAD_FINISHED' } else { 'PROOF_ADMISSION_FINISHED' }
        $admissionState = if ($InstalledGovernedWfpOwnerLossDiagnostic -and $admissionExitCode -eq 0) {
            'GOVERNED_WFP_OWNER_LOSS_OBSERVED'
        } elseif ($governedWfpDiagnosticSelected -and $admissionExitCode -eq 0) {
            'GOVERNED_WFP_WORKLOAD_OBSERVED'
        } elseif ($InstalledGovernedWorkloadDiagnostic -and $admissionExitCode -eq 0) {
            'INSTALLED_GOVERNED_WORKLOAD_OBSERVED'
        } else { $admissionResult['state'] }
        $admissionProcessExit = $admissionExitCode
        if ($admissionCleanup -eq 'RETAINED_UNVERIFIED') {
            $admissionState = if ($InstalledGovernedWfpOwnerLossDiagnostic) {
                'GOVERNED_WFP_OWNER_LOSS_STAGE_CLEANUP_UNVERIFIED'
            } elseif ($governedWfpDiagnosticSelected) {
                'GOVERNED_WFP_STAGE_CLEANUP_UNVERIFIED'
            } elseif ($InstalledGovernedWorkloadDiagnostic) {
                'INSTALLED_GOVERNED_WORKLOAD_STAGE_CLEANUP_UNVERIFIED'
            } elseif ($governedWorkloadDiagnosticSelected) {
                'GOVERNED_WORKLOAD_STAGE_CLEANUP_UNVERIFIED'
            } elseif ($ReviewedWorkloadDiagnostic) {
                'REVIEWED_WORKLOAD_STAGE_CLEANUP_UNVERIFIED'
            } else { 'PROOF_ADMISSION_STAGE_CLEANUP_UNVERIFIED' }
            $admissionProcessExit = 1
            Write-Host 'The diagnostic stage was retained because cleanup is unverified.'
        } elseif ($InstalledGovernedWorkloadDiagnostic -and $admissionInstallation.cleanup -ceq 'RETAINED_UNVERIFIED') {
            $admissionState = 'INSTALLED_GOVERNED_WORKLOAD_INSTALLATION_CLEANUP_UNVERIFIED'
            $admissionProcessExit = 1
            Write-Host 'The installed diagnostic images were retained because cleanup is unverified.'
        }
        Write-StagedProofDiagnosticReport $report $admissionState $admissionExitCode
        Write-Host "[$admissionLabel] $admissionState"
        Write-Host "[4/4] Diagnostic report: $report"
        exit $admissionProcessExit
    }
    if ($stagedWfpDiagnostic) {
        $controller = Join-Path $bin 'CLU-E-WfpPairedDiagnostic.exe'
        $controllerArgs = $compilerBase + @('/platform:x64', '/main:WfpPairedSupervisor', "/out:$controller", "/reference:$web") +
            $frameworkReferences + $sources + $pinSource + $controllerSource + $staticRecoverySource +
            $leaseFaultSource + $faultRecoverySource
        if ((Invoke-ExactExecutable $csc $controllerArgs $stage 60) -ne 0) { throw 'Native paired diagnostic compilation failed.' }
        Assert-NoReparsePath $controller
        if ($WfpEnforcementFaultDiagnostic) {
            $wfpFaultControllerHash = Get-Sha256 $controller
            $faultReader = Join-Path $diagnosticSourceRoot 'WfpEnforcementFaultSetup.ps1'
            Assert-NoReparsePath $faultReader
            . $faultReader
            $setupStage = 'WFP_ENFORCEMENT_FAULT_PRIOR_STAGE_RECONCILIATION'
            $seenPriorStages = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            foreach ($priorStage in (Get-ChildItem -LiteralPath $faultStageRoot -Directory -Force -Filter '.clue-wfp-fault-setup-*')) {
                if ($priorStage.FullName -ieq $stage -or $priorStage.Name -cnotmatch '\A\.clue-wfp-fault-setup-[0-9a-f]{32}\z') { continue }
                $wfpFaultBlockedPriorStageId = $priorStage.Name
                $setupStage = 'WFP_ENFORCEMENT_FAULT_PRIOR_STAGE_ACL'
                Assert-WfpFaultStageAcl $priorStage.FullName $faultStageDacl
                $setupStage = 'WFP_ENFORCEMENT_FAULT_PRIOR_STAGE_RECONCILIATION'
                $priorFault = [IO.Path]::Combine($priorStage.FullName, 'enforcement-fault', 'private')
                try { $priorPrivateItem = Get-Item -LiteralPath $priorFault -Force -ErrorAction Stop }
                catch [System.Management.Automation.ItemNotFoundException] { continue }
                if (!$priorPrivateItem.PSIsContainer) { throw 'The previous WFP fault stage private directory is unverified.' }
                Assert-NoReparsePath $priorFault
                $priorFaultLaunch = Join-Path $priorFault 'fault-launch.txt'
                try { $priorLaunchItem = Get-Item -LiteralPath $priorFaultLaunch -Force -ErrorAction Stop }
                catch [System.Management.Automation.ItemNotFoundException] {
                    if ([IO.File]::Exists((Join-Path $priorFault 'fault-native-started.txt')) -or
                        [IO.File]::Exists((Join-Path $priorFault 'result.json'))) {
                        throw 'The previous WFP fault stage launch marker is missing.'
                    }
                    continue
                }
                if ($priorLaunchItem.PSIsContainer) { throw 'The previous WFP fault stage launch marker is unverified.' }
                if (!$seenPriorStages.Add($priorStage.Name) -or $seenPriorStages.Count -gt 8) {
                    throw 'The number or identity of previous WFP fault stages is unverified.'
                }
                Assert-NoReparsePath $priorFaultLaunch
                $priorFaultResult = Read-WfpPairedRecord (Join-Path $priorFault 'result.json')
                if ($priorFaultResult['proofAuthorization'] -isnot [bool] -or $priorFaultResult['proofAuthorization'] -or
                    $priorFaultResult['stageCleanupSafe'] -isnot [bool] -or $priorFaultResult['jobAbsent'] -isnot [bool]) {
                    throw 'The previous WFP fault stage receipt is unverified.'
                }
                if ($priorFaultResult['stageCleanupSafe'] -and $priorFaultResult['jobAbsent']) { continue }
                $priorReconciliation = Invoke-WfpPriorStageReconciliation $controller $stage $priorStage.Name
                $wfpFaultPriorStageReconciliation += $priorReconciliation
                if ($priorReconciliation.state -cne 'WFP_PRIOR_DYNAMIC_STAGE_RECONCILED') {
                    throw 'A previous WFP enforcement fault diagnostic still needs scoped cleanup verification.'
                }
            }
            $wfpFaultBlockedPriorStageId = $null
            $setupStage = 'WFP_ENFORCEMENT_FAULT_EXECUTION'
            Write-Host '[3/4] Testing loss of the disposable WFP lease owner with an independent backup lease.'
            $stageCleanupSafe = $false
            $faultExperiment = Invoke-WfpEnforcementFaultSetup $controller $stage
            $wfpFaultResult = $faultExperiment.result
            $setupStage = 'WFP_ENFORCEMENT_FAULT_POSTRUN_STAGE_ACL'
            Assert-WfpFaultStageAcl $stage $faultStageDacl
            $setupStage = 'WFP_ENFORCEMENT_FAULT_EXECUTION'
            foreach ($faultInput in @($controller, $fixture, $mxc)) { Assert-NoReparsePath $faultInput }
            if ((Get-Sha256 $controller) -cne $wfpFaultControllerHash -or
                (Get-Sha256 $fixture) -cne $wfpFaultFixtureHash -or (Get-Sha256 $mxc) -cne $mxcHash) {
                throw 'A pinned WFP enforcement fault input changed during execution.'
            }
            $stageCleanupSafe = $faultExperiment.stageCleanupSafe
            $wfpFaultCleanup = Clear-ProofAdmissionStage $stage $stageCleanupSafe
            $wfpFaultCleanupAttempted = $true
            $setupStage = 'WFP_ENFORCEMENT_FAULT_FINISHED'
            $faultState = $wfpFaultResult.state
            if ($wfpFaultCleanup -ceq 'RETAINED_UNVERIFIED') {
                $faultState = 'WFP_ENFORCEMENT_FAULT_STAGE_CLEANUP_UNVERIFIED'
                Write-Host "The diagnostic stage was retained because cleanup is unverified: $stage"
            }
            Write-WfpEnforcementFaultReport $report $faultState
            Write-Host ('[CLU-E WFP enforcement fault] ' + $faultState)
            Write-Host "[4/4] Diagnostic report: $report"
            if ($faultState -ceq 'WFP_LEASE_OWNER_FAULT_OBSERVED') { exit 0 }
            exit 1
        }
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
    if ($WfpEnforcementFaultDiagnostic -and $failure -cmatch '\AWFP_STAGE_ACL_[A-Z0-9_]{1,48}\z') {
        $wfpFaultStageAclMismatch = $failure
    }
    Write-Host "CLU-E supervisor setup stopped: $failure"
    if ($stagedProofDiagnostic -and !$admissionCleanupAttempted) {
        $admissionCleanup = Clear-ProofAdmissionStage $stage $stageCleanupSafe $admissionCleanupMaximumEntries
    }
    if ($InstalledGovernedWorkloadDiagnostic -and !$admissionInstallationCleanupAttempted) {
        Close-InstalledGovernedHandles $admissionInstallationHandles
        $admissionInstallation.cleanup = Clear-InstalledGovernedImages $admissionOwnedInstallation $admissionCleanup $admissionSupervisorHash $mxcHash
    }
    if ($WfpEnforcementFaultDiagnostic -and !$wfpFaultCleanupAttempted) {
        $wfpFaultCleanup = Clear-ProofAdmissionStage $stage $stageCleanupSafe
    }
    if ($null -ne $report -and !(Test-Path -LiteralPath $report)) {
        try {
            Assert-NoReparsePath (Split-Path -Parent $report)
            if ($stagedProofDiagnostic) {
                $admissionResult = $null
                $admissionFailure = if ($setupFailureState) { $setupFailureState } else { $setupStage + '_FAILED' }
                Write-StagedProofDiagnosticReport $report $admissionFailure $admissionExitCode
                Write-Host "Diagnostic report: $report"
                exit 1
            }
            if ($WfpEnforcementFaultDiagnostic) {
                $faultFailure = if ($setupFailureState) { $setupFailureState } else { $setupStage + '_FAILED' }
                Write-WfpEnforcementFaultReport $report $faultFailure
                Write-Host "Diagnostic report: $report"
                exit 1
            }
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
    if ($InstalledGovernedWorkloadDiagnostic -or $governedWfpDiagnosticSelected) {
        Close-InstalledGovernedHandles $admissionInstallationHandles
    }
    if (!$stagedProofDiagnostic -and !$WfpEnforcementFaultDiagnostic -and $stageCleanupSafe -and
        $null -ne $stage -and (Test-Path -LiteralPath $stage -PathType Container)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $staticDiagnosticLock) {
        if ($staticDiagnosticLockHeld) { $staticDiagnosticLock.ReleaseMutex() }
        $staticDiagnosticLock.Dispose()
    }
}
