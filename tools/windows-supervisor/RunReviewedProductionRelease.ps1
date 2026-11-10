[CmdletBinding()]
param([switch] $ProofPilot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$engineSha = '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a'
$nodeSha = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'
$npmSha = '3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e'
$preludeSha = '334ca86fb237c565f38b17a7b84485c5fc1b603d1b16e07a68a3278cf42a37e9'

function Assert-ExactPath([string] $Path, [bool] $Directory) {
    if ($Path.Length -gt 1024 -or $Path -cnotmatch '^[A-Za-z]:\\(?!\\)' -or
        [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'RELEASE_PATH_NOT_CANONICAL' }
    $root = [IO.Path]::GetPathRoot($Path)
    $drive = [IO.DriveInfo]::new($root)
    if (!$drive.IsReady -or $drive.DriveType -notin @('Fixed', 'Removable')) { throw 'RELEASE_LOCAL_DRIVE_REQUIRED' }
    $parts = $Path.Substring($root.Length).Split('\')
    $current = $root
    for ($index = 0; $index -lt $parts.Length; $index++) {
        $part = $parts[$index]
        if (!$part -or $part -match '[ .]$|[<>:"|?*\x00-\x1f]|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)') {
            throw 'RELEASE_PATH_COMPONENT_INVALID'
        }
        $current = Join-Path $current $part
        $item = Get-Item -LiteralPath $current -Force
        $mustBeDirectory = $index -lt $parts.Length - 1 -or $Directory
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $mustBeDirectory) {
            throw 'RELEASE_PATH_IDENTITY_INVALID'
        }
    }
}

function Assert-ExternalPath([string] $Path, [string] $ProjectRoot, [string] $ProgramFiles) {
    foreach ($root in @($ProjectRoot, $ProgramFiles)) {
        if ($Path.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
            $Path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'RELEASE_EXTERNAL_EVIDENCE_REQUIRED'
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

function Get-PathDigest([string] $Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Path)
        return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Open-PinnedFile([string] $Path, [string] $ExpectedSha, [long] $MaximumBytes) {
    Assert-ExactPath $Path $false
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes -or (Get-Digest $stream) -cne $ExpectedSha) {
            throw 'RELEASE_FILE_PIN_MISMATCH'
        }
        $stream.Position = 0
        return $stream
    } catch {
        $stream.Dispose()
        throw
    }
}

function Read-Json([IO.Stream] $Stream, [switch] $PreserveDateStrings) {
    $Stream.Position = 0
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $reader = [IO.StreamReader]::new($Stream, $encoding, $true, 4096, $true)
    try {
        $json = $reader.ReadToEnd()
        if ($PreserveDateStrings -and (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
            return ConvertFrom-Json -InputObject $json -AsHashtable -Depth 48 -DateKind String
        }
        return ConvertFrom-Json -InputObject $json -AsHashtable -Depth 48
    } finally { $reader.Dispose() }
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
        throw 'RELEASE_PROTECTED_ACL_INVALID'
    }
    $bySid = @{}
    foreach ($ace in $expected) { $bySid.Add($ace.SecurityIdentifier.Value, $ace) }
    foreach ($ace in $actual) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or
            $ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.IsCallback -or $ace.OpaqueLength -ne 0) {
            throw 'RELEASE_PROTECTED_ACL_INVALID'
        }
        $sid = $ace.SecurityIdentifier.Value
        if (!$bySid.ContainsKey($sid) -or $ace.AccessMask -ne $bySid[$sid].AccessMask -or $ace.AceFlags -ne $bySid[$sid].AceFlags) {
            throw 'RELEASE_PROTECTED_ACL_INVALID'
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
        $entries.Name -cnotcontains 'wxc-exec.exe') { throw 'RELEASE_INSTALLED_PAIR_INVALID' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Engine
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation') {
        throw 'RELEASE_ENGINE_SIGNATURE_INVALID'
    }
}

function Test-ObservedAdmission($Report) {
    if ($Report -isnot [System.Collections.IDictionary] -or
        $Report['schemaVersion'] -cne 'clue-windows-production-admission/1' -or
        $Report['productionBuildRevision'] -cne '06G3' -or $Report['state'] -cne 'PRODUCTION_ADMISSION_OBSERVED' -or
        ![object]::Equals($Report['proofAuthorization'], $false) -or $Report['executionEnvironment'] -cne 'WINDOWS_HOST' -or
        ![object]::Equals($Report['productionNetworkFaultDiagnostic'], $true) -or
        $Report['cleanup'] -cne 'REMOVED' -or ![object]::Equals($Report['diagnosticStageRetained'], $false) -or
        $Report['workloadExitCode'] -ne 0 -or
        $Report['supervisorSha256'] -cne $wrapperSha -or $Report['engineSha256'] -cne $engineSha -or
        $Report['nodeSha256'] -cne $nodeSha -or $Report['npmCliSha256'] -cne $npmSha -or $Report['productionPreludeSha256'] -cne $preludeSha) {
        return $false
    }
    $install = $Report['installation']
    $observed = $Report['productionAdmission']
    if ($install -isnot [System.Collections.IDictionary] -or $observed -isnot [System.Collections.IDictionary] -or
        $install['layout'] -cne 'PROGRAM_FILES_PRODUCTION_PROOF_CONTENT_ADDRESSED' -or $install['state'] -cne 'VERIFIED' -or
        $install['cleanup'] -cne 'RETAINED_PROTECTED_AUDIT' -or $install['wrapperPath'] -isnot [string] -or
        $install['wrapperSha256'] -cne $wrapperSha -or $install['engineSha256'] -cne $engineSha -or
        ![object]::Equals($install['verifiedBefore'], $true) -or ![object]::Equals($install['verifiedAfter'], $true) -or
        (Get-PathDigest $install['wrapperPath']) -cne $wrapperPathSha -or
        $observed['schemaVersion'] -cne 'clue-windows-production-admission/1' -or
        $observed['state'] -cne 'PRODUCTION_ADMISSION_OBSERVED' -or ![object]::Equals($observed['proofAuthorization'], $false) -or
        ![object]::Equals($observed['stageCleanupSafe'], $true) -or ![object]::Equals($observed['scratchRetained'], $false)) {
        return $false
    }
    $pair = $observed['installedImage']
    $cases = $observed['cases']
    $refusals = $observed['refusals']
    if ($pair -isnot [System.Collections.IDictionary] -or $pair.Count -ne 4 -or
        $pair['wrapperSha256'] -cne $wrapperSha -or $pair['engineSha256'] -cne $engineSha -or
        ![object]::Equals($pair['verifiedBefore'], $true) -or ![object]::Equals($pair['verifiedAfter'], $true) -or
        $cases -isnot [System.Collections.IDictionary] -or $cases.Count -ne 3 -or
        $refusals -isnot [System.Collections.IDictionary] -or $refusals.Count -ne 3) { return $false }
    foreach ($name in @('baseline', 'candidate', 'npmTypecheck')) {
        $case = $cases[$name]
        if ($case -isnot [System.Collections.IDictionary] -or ![object]::Equals($case['passed'], $true) -or
            $case['exitCode'] -ne 0 -or $case['wfp'] -isnot [System.Collections.IDictionary] -or
            ![object]::Equals($case['wfp']['verified'], $true)) { return $false }
    }
    foreach ($name in @('networkOptOut', 'unexpectedEnvironment', 'rootOverlap')) {
        $case = $refusals[$name]
        if ($case -isnot [System.Collections.IDictionary] -or ![object]::Equals($case['passed'], $true) -or
            $case['exitCode'] -ne 125) { return $false }
    }
    return $true
}

function New-ChildStart([string] $File, [string[]] $Arguments, [string] $WorkingDirectory, [string] $ChildPath,
        [switch] $PilotEnvironment) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $File
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    # The production supervisor admits scratch under this host's qualified TEMP root.
    $windowsEnvironment = @('SystemRoot', 'WINDIR', 'ComSpec', 'SystemDrive', 'PATHEXT', 'ProgramFiles',
        'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'USERPROFILE',
        'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'TEMP', 'TMP')
    foreach ($name in @($start.Environment.Keys)) {
        if (($PilotEnvironment -and $name -notin $windowsEnvironment) -or
            $name -match '^(GIT_|NODE_|CLU_WINDOWS_SUPERVISOR_|CLUE_RELEASE_|CLUE_P03_|OPENAI_API_KEY$)') {
            $null = $start.Environment.Remove($name)
        }
    }
    $start.Environment['PATH'] = $ChildPath
    $start.Environment['GIT_NO_REPLACE_OBJECTS'] = '1'
    $start.Environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $start.Environment['GIT_CONFIG_GLOBAL'] = 'NUL'
    return $start
}

function Invoke-Child([Diagnostics.ProcessStartInfo] $Start, [int] $TimeoutMs, [switch] $Capture) {
    if ($Capture) { $Start.RedirectStandardOutput = $true }
    $process = [Diagnostics.Process]::Start($Start)
    if ($null -eq $process) { throw 'RELEASE_CHILD_START_FAILED' }
    if ($script:checkoutOwned) { $script:checkoutCleanupSafe = $false }
    try {
        $read = if ($Capture) { $process.StandardOutput.ReadToEndAsync() } else { $null }
        if (!$process.WaitForExit($TimeoutMs)) {
            $process.Kill($true)
            $null = $process.WaitForExit(30000)
            throw 'RELEASE_CHILD_TIMEOUT'
        }
        if ($script:checkoutOwned) { $script:checkoutCleanupSafe = $true }
        if ($Capture) {
            if ($process.ExitCode -ne 0) { throw 'RELEASE_GIT_IDENTITY_UNVERIFIED' }
            return $read.GetAwaiter().GetResult().Trim()
        }
        return $process.ExitCode
    } finally { $process.Dispose() }
}

function Clear-OwnedCheckout([string] $Path, [string] $Evidence) {
    if (!$Path -or [IO.Path]::GetDirectoryName($Path) -cne $Evidence -or
        [IO.Path]::GetFileName($Path) -cnotmatch '\A\.clue-release-checkout-[0-9a-f]{32}\z') { return $false }
    Assert-ExactPath $Path $true
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Path)
    $entries = 0
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
            if ((++$entries -gt 400000) -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
        }
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
    return !(Test-Path -LiteralPath $Path)
}

function Get-ReleaseGateOutcome([string] $Directory, [string] $Commit, [string] $SupervisorSha256, [int] $ExitCode) {
    Assert-ExactPath $Directory $true
    $reports = @(Get-ChildItem -LiteralPath $Directory -Force -File -Filter '*.report.json' |
        Where-Object { !$_.Name.EndsWith('.candidate.report.json', [StringComparison]::Ordinal) })
    $logs = @(Get-ChildItem -LiteralPath $Directory -Force -File -Filter '*.gates.log')
    if ($reports.Count -gt 1 -or $logs.Count -gt 1) { throw 'RELEASE_GATE_OUTPUT_AMBIGUOUS' }

    $outcome = [ordered]@{
        verdict = 'NO_FINAL_REPORT'
        finalReport = $null
        finalReportSha256 = $null
        gateLog = $null
        releaseArchive = $null
        releaseArchiveSha256 = $null
    }
    if ($logs.Count -eq 1) {
        Assert-ExactPath $logs[0].FullName $false
        $outcome.gateLog = $logs[0].FullName
    }
    if ($reports.Count -eq 0) {
        if ($ExitCode -eq 0) { throw 'RELEASE_GATE_REPORT_MISSING' }
        return $outcome
    }

    $gatePath = $reports[0].FullName
    Assert-ExactPath $gatePath $false
    $reportLock = [IO.File]::Open($gatePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($reportLock.Length -lt 1 -or $reportLock.Length -gt 32MB) { throw 'RELEASE_GATE_REPORT_INVALID' }
        $report = Read-Json $reportLock
        $reportSha = Get-Digest $reportLock
    } finally { $reportLock.Dispose() }
    if ($report -isnot [System.Collections.IDictionary] -or $report['tool'] -cne 'tools/release.mjs' -or
        $report['reportVersion'] -cne '2.0.0' -or $report['verdict'] -cnotin @('RELEASE', 'RELEASE_CANDIDATE', 'BLOCKED') -or
        ($report['verdict'] -ceq 'RELEASE') -ne ($ExitCode -eq 0)) { throw 'RELEASE_GATE_REPORT_INVALID' }
    $outcome.verdict = $report['verdict']
    $outcome.finalReport = $gatePath
    $outcome.finalReportSha256 = $reportSha
    if ($ExitCode -ne 0) { return $outcome }

    $qualification = $report['releaseQualification']
    $tree = $report['tree']
    $archive = $report['archive']
    $native = $report['smoke']['nativeProof']
    if ($qualification -isnot [System.Collections.IDictionary] -or $tree -isnot [System.Collections.IDictionary] -or
        $archive -isnot [System.Collections.IDictionary] -or $tree['commit'] -cne $Commit -or
        ![object]::Equals($tree['archiveBound'], $true) -or ![object]::Equals($tree['dirty'], $false) -or
        $archive['sha256'] -cnotmatch '\A[a-f0-9]{64}\z' -or $logs.Count -ne 1) { throw 'RELEASE_GATE_REPORT_INVALID' }
    foreach ($gate in @('portablePass', 'nativeWindows', 'nativeProofIntegration', 'cleanGitTree', 'formalPass')) {
        if (![object]::Equals($qualification[$gate], $true)) { throw 'RELEASE_GATE_REPORT_INVALID' }
    }
    if ($native -isnot [System.Collections.IDictionary] -or ![object]::Equals($native['pass'], $true) -or
        $native['supervisorSha256'] -cne $SupervisorSha256 -or $native['tests'] -isnot [array] -or
        $native['tests'].Count -ne 5) { throw 'RELEASE_NATIVE_PROOF_UNVERIFIED' }
    foreach ($test in $native['tests']) {
        if ($test['state'] -cne 'PASS') { throw 'RELEASE_NATIVE_PROOF_UNVERIFIED' }
    }
    $name = $reports[0].Name
    $base = $name.Substring(0, $name.Length - '.report.json'.Length)
    if ($archive['file'] -cne "$base.zip" -or $logs[0].Name -cne "$base.gates.log") { throw 'RELEASE_GATE_REPORT_INVALID' }
    $archivePath = Join-Path $Directory $archive['file']
    $archiveLock = Open-PinnedFile $archivePath $archive['sha256'] 1GB
    try {
        if ($archiveLock.Length -ne $archive['bytes']) { throw 'RELEASE_ARCHIVE_SIZE_MISMATCH' }
    } finally { $archiveLock.Dispose() }
    $outcome.releaseArchive = $archivePath
    $outcome.releaseArchiveSha256 = $archive['sha256']
    return $outcome
}

function Assert-P03SourceFile([string] $Path, [string] $ExpectedSha) {
    Assert-ExactPath $Path $false
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt 8MB) { throw 'P03_COMMITTED_PATCH_UNVERIFIED' }
        if ((Get-Digest $stream) -ceq $ExpectedSha) { return }
        # Match the patch verifier's Windows text line-ending allowance.
        $stream.Position = 0
        $copy = [IO.MemoryStream]::new([int] $stream.Length)
        try {
            $stream.CopyTo($copy)
            $text = [Text.UTF8Encoding]::new($false, $true).GetString($copy.ToArray())
        } finally { $copy.Dispose() }
        if (!$text.Contains("`r`n") -or (Get-PathDigest ($text.Replace("`r`n", "`n"))) -cne $ExpectedSha) {
            throw 'P03_COMMITTED_PATCH_UNVERIFIED'
        }
    } finally { $stream.Dispose() }
}

function Get-P03ManifestSha([string] $Checkout) {
    $path = Join-Path $Checkout 'CLU-E-P03-Manifest.json'
    Assert-ExactPath $path $false
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 256KB) { throw 'P03_COMMITTED_PATCH_UNVERIFIED' }
        $manifest = Read-Json $stream
        if ($manifest -isnot [System.Collections.IDictionary] -or $manifest['schemaVersion'] -ne 1 -or
            $manifest['patchId'] -cne 'P03' -or $manifest['gate'] -cne 'native-proof-p03' -or
            $manifest['files'] -isnot [array] -or $manifest['files'].Count -lt 1 -or
            $manifest['baseFiles'] -isnot [array] -or ($manifest['baseFiles'].Count + $manifest['files'].Count) -gt 300) {
            throw 'P03_COMMITTED_PATCH_UNVERIFIED'
        }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in @($manifest['baseFiles']) + @($manifest['files'])) {
            if ($entry -isnot [System.Collections.IDictionary]) { throw 'P03_COMMITTED_PATCH_UNVERIFIED' }
            $file = $entry['path']
            if ($file -isnot [string] -or $file.Length -gt 240 -or
                $file -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._ -]*(?<![. ])(?:/[A-Za-z0-9][A-Za-z0-9._ -]*(?<![. ]))*\z' -or
                $file -match '(?:\A|/)(?:node_modules|dist|workspace|release-evidence)(?:/|\z)' -or
                !$seen.Add($file) -or $entry['sha256'] -cnotmatch '\A[a-f0-9]{64}\z') {
                throw 'P03_COMMITTED_PATCH_UNVERIFIED'
            }
            Assert-P03SourceFile (Join-Path $Checkout ($file.Replace('/', '\'))) $entry['sha256']
        }
        foreach ($file in @('selftest/p03-native-proof-pilot.test.ts', 'tools/windows-supervisor/RunReviewedProductionRelease.ps1',
                'tools/windows-supervisor/ReviewedProductionQualification.ps1')) {
            if (!$seen.Contains($file)) { throw 'P03_COMMITTED_PATCH_UNVERIFIED' }
        }
        return Get-Digest $stream
    } finally { $stream.Dispose() }
}

function Get-P03ProofOutcome([string] $Path, [string] $SupervisorSha256, [string] $QualificationSha256, [int] $ExitCode) {
    if ($ExitCode -ne 0) { throw 'P03_NATIVE_PROOF_FAILED' }
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'P03_NATIVE_EVIDENCE_MISSING' }
    Assert-ExactPath $Path $false
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 256KB) { throw 'P03_NATIVE_EVIDENCE_UNVERIFIED' }
        $report = Read-Json $stream -PreserveDateStrings
        if ($report -isnot [System.Collections.IDictionary] -or
            $report['schemaVersion'] -cne 'clue-p03-native-proof-pilot/1' -or $report['status'] -cne 'passed' -or
            $report['scope'] -cne 'disposable-synthetic-local-target' -or $report['platform'] -cne 'win32' -or
            $report['supervisor'] -isnot [System.Collections.IDictionary] -or
            $report['supervisor']['sha256'] -cne $SupervisorSha256 -or
            $report['supervisor']['qualificationSha256'] -cne $QualificationSha256 -or
            $report['evidenceDigestSha256'] -cnotmatch '\A[a-f0-9]{64}\z' -or $report['cycleStage'] -cne 'SCREENED') {
            throw 'P03_NATIVE_EVIDENCE_UNVERIFIED'
        }
        $verdict = $report['verdict']
        $fixture = $report['fixturePolicy']
        $baseline = $report['baseline']
        $candidate = $report['candidate']
        $canonical = $report['canonical']
        if ($report['configurationMode'] -cne 'legacy-v2' -or $fixture -isnot [System.Collections.IDictionary] -or
            $fixture['patchingMode'] -cne 'NOTIFY' -or ![object]::Equals($fixture['remoteConfigured'], $false) -or
            ![object]::Equals($fixture['backupPushEnabled'], $false) -or ![object]::Equals($fixture['gatewayEnabled'], $false) -or
            $verdict -isnot [System.Collections.IDictionary] -or $verdict['disposition'] -cne 'ACCEPT' -or
            ![object]::Equals($verdict['improvement'], $true) -or $verdict['improvementPct'] -ne 20 -or
            $verdict['greatBookEntryId'] -cnotmatch '\AGBI-[a-f0-9]{32}\z' -or
            $baseline -isnot [System.Collections.IDictionary] -or $baseline['cost'] -ne 100 -or $baseline['guard'] -ne 497 -or
            $candidate -isnot [System.Collections.IDictionary] -or $candidate['cost'] -ne 80 -or $candidate['guard'] -ne 497 -or
            $canonical -isnot [System.Collections.IDictionary] -or ![object]::Equals($canonical['unchanged'], $true) -or
            $canonical['beforeSha256'] -cnotmatch '\A[a-f0-9]{64}\z' -or
            $canonical['beforeSha256'] -cne $canonical['afterSha256']) { throw 'P03_NATIVE_EVIDENCE_UNVERIFIED' }
        return [ordered]@{
            sha256 = Get-Digest $stream
            report = $report
        }
    } finally { $stream.Dispose() }
}

$locks = [Collections.Generic.List[IO.Stream]]::new()
$guardian = $null
$runner = $null
$checkoutParent = $null
$checkoutOwned = $false
$checkoutCleanupSafe = $true
$output = $null
$evidence = $null
$receipt = $null
$reviewed = $null
$commit = $null
$reportPath = $null
$gateOutcome = $null
$gateExit = $null
$patchManifestSha = $null
$pilotFailureStage = $null
$blocker = $null
$result = 2
$phase = 'RELEASE_PREFLIGHT_UNVERIFIED'
$operation = if ($ProofPilot) { 'proof pilot' } else { 'release' }
try {
    if (!$IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::UserInteractive) {
        throw 'RELEASE_INTERACTIVE_WINDOWS_REQUIRED'
    }

    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    $evidence = Join-Path ([IO.Path]::GetDirectoryName($repo)) 'release-evidence'
    Assert-ExactPath $repo $true
    Assert-ExactPath $programFiles $true
    Assert-ExactPath $evidence $true
    Assert-ExternalPath $evidence $repo $programFiles

    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff', [Globalization.CultureInfo]::InvariantCulture)
    $nonce = [Guid]::NewGuid().ToString('N')
    $reportPrefix = if ($ProofPilot) { 'CLU-E_WINDOWS_P03_PROOF_PILOT' } else { 'CLU-E_WINDOWS_REVIEWED_RELEASE' }
    $reportPath = Join-Path $evidence "$($reportPrefix)_$stamp-$($nonce.Substring(0, 8)).json"

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $operatorSid = $identity.User.Value
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'RELEASE_STANDARD_SESSION_REQUIRED'
        }
    } finally { $identity.Dispose() }
    $sessionId = (Get-Process -Id $PID).SessionId
    if ($sessionId -le 0) { throw 'RELEASE_STANDARD_SESSION_REQUIRED' }

    $phase = 'RELEASE_REVIEWED_EVIDENCE_UNVERIFIED'
    $reviewHelper = Join-Path $PSScriptRoot 'ReviewedProductionQualification.ps1'
    Assert-ExactPath $reviewHelper $false
    . $reviewHelper
    $reviewed = Get-ReviewedProductionEvidence $evidence
    foreach ($lock in $reviewed.locks) { $locks.Add($lock) }
    $wrapperSha = $reviewed.wrapperSha
    $wrapperPathSha = $reviewed.wrapperPathSha
    $admission = $reviewed.admission
    $install = $admission['installation']
    $image = $reviewed.image
    if (!(Test-ObservedAdmission $admission) -or $image -cne $install['wrapperPath'] -or
        $reviewed.qualification['host']['nodeSha256'] -cne $nodeSha) {
        throw 'RELEASE_ADMISSION_REPORT_UNVERIFIED'
    }
    $digestFolder = [IO.Path]::GetDirectoryName($image)
    $protectedRoot = [IO.Path]::GetDirectoryName($digestFolder)
    $leaf = [IO.Path]::GetFileName($protectedRoot)
    if ($leaf -cnotmatch '\A\.clue-proof-production-[a-f0-9]{32}\z' -or
        ![IO.Path]::GetDirectoryName($protectedRoot).Equals($programFiles, [StringComparison]::OrdinalIgnoreCase) -or
        $image -cne (Join-Path (Join-Path $protectedRoot $wrapperSha) 'CLU-E-Windows-Supervisor.exe')) {
        throw 'RELEASE_INSTALLED_IMAGE_PATH_INVALID'
    }
    $phase = 'RELEASE_INSTALLED_IMAGE_UNVERIFIED'
    $engine = Join-Path $digestFolder 'wxc-exec.exe'
    $prelude = Join-Path $protectedRoot 'production-bind-prelude.cjs'
    Assert-InstalledPair $protectedRoot $operatorSid $image $engine $prelude
    $imageLock = Open-PinnedFile $image $wrapperSha 16MB
    $locks.Add($imageLock)
    $engineLock = Open-PinnedFile $engine $engineSha 768MB
    $locks.Add($engineLock)
    $preludeLock = Open-PinnedFile $prelude $preludeSha 1MB
    $locks.Add($preludeLock)

    $phase = 'RELEASE_PROTECTED_BUILD_RECEIPT_UNVERIFIED'
    $readyPath = Join-Path $protectedRoot 'ready.json'
    Assert-ExactPath $readyPath $false
    $readyLock = [IO.File]::Open($readyPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $locks.Add($readyLock)
    if ($readyLock.Length -lt 1 -or $readyLock.Length -gt 4096) { throw $phase }
    $ready = Read-Json $readyLock
    if ($ready -isnot [System.Collections.IDictionary] -or $ready.Count -ne 6 -or
        $ready['schemaVersion'] -cne 'clue-proof-production-installed-image/2' -or
        $ready['productionBuildRevision'] -cne '06G3' -or $ready['wrapperSha256'] -cne $wrapperSha -or
        $ready['engineSha256'] -cne $engineSha) { throw $phase }
    foreach ($name in @('guardianPid', 'operatorPid')) {
        $pidValue = $ready[$name]
        if (($pidValue -isnot [int] -and $pidValue -isnot [long]) -or $pidValue -lt 1 -or
            $pidValue -gt [int]::MaxValue -or $pidValue -ne $install[$name]) { throw $phase }
    }
    if ($ready['guardianPid'] -eq $ready['operatorPid']) { throw $phase }

    $phase = 'RELEASE_NODE_INSTALLATION_UNVERIFIED'
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $locks.Add((Open-PinnedFile $node $nodeSha 256MB))
    $nodeDir = [IO.Path]::GetDirectoryName($node)
    $npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    $locks.Add((Open-PinnedFile $npm $npmSha 1MB))

    $phase = 'RELEASE_GIT_UNVERIFIED'
    $git = Join-Path $programFiles 'Git\cmd\git.exe'
    $pwsh = Join-Path $programFiles 'PowerShell\7\pwsh.exe'
    Assert-ExactPath $git $false
    Assert-ExactPath $pwsh $false
    $systemDirectory = [Environment]::SystemDirectory
    $fixedPath = (@($systemDirectory, [IO.Path]::GetDirectoryName($git), [IO.Path]::GetDirectoryName($pwsh), $nodeDir) -join ';')
    $childPath = "$fixedPath;$env:PATH"
    $phase = 'RELEASE_CURRENT_HOST_UNVERIFIED'
    $hostCheck = @'
const { createHash } = require('node:crypto');
const { hostname, release, userInfo, version } = require('node:os');
const hash = value => createHash('sha256').update(value).digest('hex');
const account = userInfo();
process.stdout.write(JSON.stringify({
  hostnameSha256: hash(hostname()),
  principalSha256: hash(account.username + '\0' + account.homedir),
  platform: process.platform, arch: process.arch,
  osRelease: release(), osVersion: version(), nodeVersion: process.version,
}));
'@
    $hostText = Invoke-Child (New-ChildStart $node @('-e', $hostCheck) $repo $childPath) 30000 -Capture
    $currentHost = ConvertFrom-Json -InputObject $hostText -AsHashtable -Depth 4
    $recordedHost = $reviewed.qualification['host']
    foreach ($key in @('hostnameSha256', 'principalSha256', 'platform', 'arch', 'osRelease', 'osVersion', 'nodeVersion')) {
        if ($currentHost[$key] -cne $recordedHost[$key]) { throw $phase }
    }

    $phase = 'RELEASE_GIT_UNVERIFIED'
    $commit = Invoke-Child (New-ChildStart $git @('rev-parse', '--verify', 'HEAD^{commit}') $repo $childPath) 30000 -Capture
    if ($commit -cnotmatch '\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z') { throw 'RELEASE_GIT_HEAD_UNVERIFIED' }

    $phase = 'RELEASE_ISOLATED_CHECKOUT_UNVERIFIED'
    $checkoutParent = Join-Path $evidence ".clue-release-checkout-$nonce"
    if (Test-Path -LiteralPath $checkoutParent) { throw 'RELEASE_CHECKOUT_COLLISION' }
    $null = New-Item -ItemType Directory -Path $checkoutParent
    $checkoutOwned = $true
    Assert-ExactPath $checkoutParent $true
    $checkout = Join-Path $checkoutParent 'source'
    $disabled = Join-Path $checkoutParent 'disabled'
    $null = New-Item -ItemType Directory -Path $disabled
    $attributes = Join-Path $checkoutParent 'empty-attributes'
    [IO.File]::WriteAllBytes($attributes, [byte[]]::new(0))
    $gitSettings = @('-c', 'core.autocrlf=false', '-c', 'core.longpaths=true',
        '-c', "core.hooksPath=$disabled", '-c', "core.attributesFile=$attributes")
    $cloneArgs = $gitSettings + @('clone', '--local', '--no-hardlinks', '--no-checkout', '--no-tags',
        "--template=$disabled", '--', $repo, $checkout)
    if ((Invoke-Child (New-ChildStart $git $cloneArgs $checkoutParent $childPath) 180000) -ne 0) { throw 'RELEASE_CLONE_FAILED' }
    Assert-ExactPath $checkout $true
    foreach ($setting in @(@('core.autocrlf', 'false'), @('core.longpaths', 'true'),
            @('core.hooksPath', $disabled), @('core.attributesFile', $attributes))) {
        if ((Invoke-Child (New-ChildStart $git (@('config', '--local') + $setting) $checkout $childPath) 30000) -ne 0) {
            throw 'RELEASE_CLONE_CONFIG_FAILED'
        }
    }
    if ((Invoke-Child (New-ChildStart $git @('checkout', '--detach', $commit) $checkout $childPath) 180000) -ne 0) {
        throw 'RELEASE_CHECKOUT_FAILED'
    }
    $boundCommit = Invoke-Child (New-ChildStart $git @('rev-parse', '--verify', 'HEAD^{commit}') $checkout $childPath) 30000 -Capture
    $status = Invoke-Child (New-ChildStart $git @('status', '--porcelain', '--untracked-files=all') $checkout $childPath) 30000 -Capture
    if ($boundCommit -cne $commit -or $status -cne '') { throw 'RELEASE_ISOLATED_HEAD_UNVERIFIED' }
    if ($ProofPilot) {
        $phase = 'P03_COMMITTED_PATCH_UNVERIFIED'
        $patchManifestSha = Get-P03ManifestSha $checkout
    }
    Write-Host "Testing committed Git HEAD $($commit.Substring(0, 12)) in an isolated checkout."

    $phase = 'RELEASE_OPERATOR_REVIEW_REQUIRED'
    $receipt = New-ReviewedProductionQualification $reviewed $evidence $commit -ProofPilot:$ProofPilot
    $locks.Add($receipt.lock)

    $phase = 'RELEASE_DEPENDENCY_INSTALL_UNVERIFIED'
    $packageLock = Join-Path $checkout 'package-lock.json'
    Assert-ExactPath $packageLock $false
    $dependencyLock = [IO.File]::Open($packageLock, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($dependencyLock.Length -lt 1 -or $dependencyLock.Length -gt 8MB) { throw 'RELEASE_DEPENDENCY_LOCK_UNVERIFIED' }
        $lockDigest = Get-Digest $dependencyLock
        $dependencyArgs = @($npm, 'ci', '--prefer-offline', '--no-audit', '--no-fund', '--fetch-retries=1',
            '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000', '--fetch-timeout=30000')
        if ((Invoke-Child (New-ChildStart $node $dependencyArgs $checkout $childPath) 900000) -ne 0) {
            throw 'RELEASE_DEPENDENCY_INSTALL_FAILED'
        }
        if ((Get-Digest $dependencyLock) -cne $lockDigest) { throw 'RELEASE_DEPENDENCY_LOCK_CHANGED' }
    } finally { $dependencyLock.Dispose() }
    $status = Invoke-Child (New-ChildStart $git @('status', '--porcelain', '--untracked-files=all') $checkout $childPath) 30000 -Capture
    if ($status -cne '') { throw 'RELEASE_ISOLATED_CHECKOUT_DIRTY' }
    if ($ProofPilot) {
        $phase = 'P03_BUILD_UNVERIFIED'
        $compiler = Join-Path $checkout 'node_modules\typescript\bin\tsc'
        Assert-ExactPath $compiler $false
        Write-Host 'Building the committed P03 checkout.'
        if ((Invoke-Child (New-ChildStart $node @($compiler) $checkout $fixedPath -PilotEnvironment) 300000) -ne 0) {
            throw 'P03_BUILD_FAILED'
        }
    }
    $script = if ($ProofPilot) { Join-Path $checkout 'dist\selftest\p03-native-proof-pilot.test.js' }
        else { Join-Path $checkout 'tools\release.mjs' }
    Assert-ExactPath $script $false

    $phase = 'RELEASE_PRODUCTION_SESSION_UNVERIFIED'
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class ClueGatedReleasePipe {
    [DllImport("kernel32.dll", EntryPoint = "WaitNamedPipeW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WaitNamedPipe(string name, uint milliseconds);
    public static int State(string name, uint milliseconds) {
        return WaitNamedPipe(name, milliseconds) ? 0 : Marshal.GetLastWin32Error();
    }
}
'@
    $pipe = "\\.\pipe\CLU-E-Production-Proof-$leaf-$sessionId"
    if ([ClueGatedReleasePipe]::State($pipe, 1) -ne 2) { throw 'RELEASE_PRODUCTION_SESSION_ALREADY_PRESENT' }
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match '^(COR_|CORECLR_|COMPLUS_|DOTNET_|APPDOMAIN_MANAGER_|DEVPATH$|__COMPAT_LAYER$|OPENAI_API_KEY$)') {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        }
    }
    Write-Host 'Approve the Windows prompt for the verified CLU-E production supervisor using your current Windows account.'
    $originalPath = $env:PATH
    try {
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
    } catch { throw 'RELEASE_PRODUCTION_SESSION_LAUNCH_FAILED' }
    finally { $env:PATH = $originalPath }
    $wait = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($null -eq $guardian -or $guardian.HasExited) { throw 'RELEASE_PRODUCTION_SESSION_EXITED' }
        $listening = [ClueGatedReleasePipe]::State($pipe, 100) -eq 0
        if (!$listening) { Start-Sleep -Milliseconds 75 }
    } while (!$listening -and $wait.ElapsedMilliseconds -lt 10000)
    if (!$listening -or $guardian.HasExited) { throw 'RELEASE_PRODUCTION_SESSION_NOT_READY' }

    $phase = if ($ProofPilot) { 'P03_NATIVE_PROOF_UNVERIFIED' } else { 'RELEASE_FORMAL_GATES_UNVERIFIED' }
    $outputPrefix = if ($ProofPilot) { 'P03' } else { '06L' }
    $output = Join-Path $evidence "$outputPrefix-$stamp-$($nonce.Substring(0, 8))"
    if (Test-Path -LiteralPath $output) { throw 'RELEASE_OUTPUT_COLLISION' }
    $null = New-Item -ItemType Directory -Path $output
    Assert-ExactPath $output $true
    if ($ProofPilot) {
        $pilotReport = Join-Path $output 'native-proof.json'
        $start = New-ChildStart $node @('--test', '--test-reporter=tap', '--test-concurrency=1', $script) $checkout $fixedPath -PilotEnvironment
        $start.Environment['CLUE_P03_NATIVE_PILOT_OUTPUT'] = $pilotReport
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $timeout = 1200000
        Write-Host 'Running the native Windows proof pilot against the disposable target.'
    } else {
        $start = New-ChildStart $node @($script, '--out', $output) $checkout $childPath
        $start.Environment['CLUE_RELEASE_TEST_CONCURRENCY'] = '1'
        $timeout = 7200000
        Write-Host 'Running the formal Windows release gates.'
    }
    $start.Environment['CLU_WINDOWS_SUPERVISOR_PATH'] = $image
    $start.Environment['CLU_WINDOWS_SUPERVISOR_SHA256'] = $wrapperSha
    $start.Environment['CLU_WINDOWS_SUPERVISOR_QUALIFICATION'] = $receipt.path
    $start.Environment['CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256'] = $receipt.sha256
    $runner = [Diagnostics.Process]::Start($start)
    if ($null -eq $runner) {
        if ($ProofPilot) { throw 'P03_NATIVE_PROOF_LAUNCH_FAILED' }
        throw 'RELEASE_FORMAL_GATES_LAUNCH_FAILED'
    }
    $checkoutCleanupSafe = $false
    if ($ProofPilot) {
        $pilotStdout = $runner.StandardOutput.ReadToEndAsync()
        $pilotStderr = $runner.StandardError.ReadToEndAsync()
    }
    if (!$runner.WaitForExit($timeout)) {
        try {
            $runner.Kill($true)
            $null = $runner.WaitForExit(30000)
        } catch { }
        if ($ProofPilot) { throw 'P03_NATIVE_PROOF_TIMEOUT' }
        throw 'RELEASE_FORMAL_GATES_TIMEOUT'
    }
    $gateExit = $runner.ExitCode

    if ($ProofPilot) {
        if (!$pilotStdout.Wait(10000) -or !$pilotStderr.Wait(10000)) { throw 'P03_NATIVE_OUTPUT_UNVERIFIED' }
        $checkoutCleanupSafe = $true
        $stdout = $pilotStdout.GetAwaiter().GetResult()
        $stderr = $pilotStderr.GetAwaiter().GetResult()
        if ($stdout) { Write-Host $stdout.TrimEnd() }
        if ($stderr) { Write-Host $stderr.TrimEnd() }
        if ($gateExit -ne 0) {
            $refusal = [regex]::Match("$stdout`n$stderr", '(?m)^(?:# )?P03_NATIVE_PILOT_REFUSED (qualification|fixture|screening|baseline|proof|verification|journal|cleanup|evidence)\r?$')
            if ($refusal.Success) { $pilotFailureStage = $refusal.Groups[1].Value }
        }
        $phase = 'P03_NATIVE_EVIDENCE_UNVERIFIED'
        $gateOutcome = Get-P03ProofOutcome $pilotReport $wrapperSha $receipt.sha256 $gateExit
        $status = Invoke-Child (New-ChildStart $git @('status', '--porcelain', '--untracked-files=all') $checkout $fixedPath -PilotEnvironment) 30000 -Capture
        if ($status -cne '' -or (Get-P03ManifestSha $checkout) -cne $patchManifestSha) {
            throw 'P03_ISOLATED_CHECKOUT_CHANGED'
        }
    } else {
        $checkoutCleanupSafe = $true
        $phase = 'RELEASE_GATE_OUTCOME_UNVERIFIED'
        $gateOutcome = Get-ReleaseGateOutcome $output $commit $wrapperSha $gateExit
    }
    $phase = 'RELEASE_INSTALLED_IMAGE_AFTER_RUN_UNVERIFIED'
    Assert-InstalledPair $protectedRoot $operatorSid $image $engine $prelude
    if ((Get-Digest $imageLock) -cne $wrapperSha -or (Get-Digest $engineLock) -cne $engineSha -or
        (Get-Digest $preludeLock) -cne $preludeSha -or $guardian.HasExited) { throw $phase }
    $result = $gateExit
    if ($result -ne 0) {
        $phase = 'RELEASE_FORMAL_GATES_BLOCKED'
        $blocker = $phase
    }
} catch {
    $blocker = $_.Exception.Message
    if ($blocker -cnotmatch '^(?:RELEASE|P03)_[A-Z0-9_]{1,72}$') { $blocker = $phase }
    if (!$ProofPilot -and $null -ne $gateOutcome) {
        $gateOutcome.releaseArchive = $null
        $gateOutcome.releaseArchiveSha256 = $null
    }
    Write-Host "CLU-E Windows $operation stopped: $blocker"
    if ($blocker -ceq 'RELEASE_STANDARD_SESSION_REQUIRED') { Write-Host 'Run the launcher from your normal Windows session.' }
} finally {
    if ($null -ne $output -and (Test-Path -LiteralPath $output -PathType Container)) {
        if ($ProofPilot) { Write-Host "Pilot evidence: $output" } else { Write-Host "Release evidence: $output" }
    }
    if ($null -ne $runner) { $runner.Dispose() }
    if ($null -ne $guardian) { $guardian.Dispose() }
    foreach ($lock in $locks) { $lock.Dispose() }
    $checkoutCleanup = 'NOT_CREATED'
    if ($checkoutOwned) {
        $removed = $false
        if ($checkoutCleanupSafe) {
            try { $removed = Clear-OwnedCheckout $checkoutParent $evidence } catch { }
        }
        $checkoutCleanup = if ($removed) { 'REMOVED' } else { 'RETAINED' }
        if (!$removed) { Write-Host "Isolated checkout retained: $checkoutParent" }
    }
    if ($ProofPilot -and $result -eq 0 -and $checkoutCleanup -cne 'REMOVED') {
        $result = 2
        $phase = 'P03_ISOLATED_CHECKOUT_RETAINED'
        $blocker = $phase
    }
    if ($null -ne $reportPath) {
        $report = [ordered]@{
            schemaVersion = if ($ProofPilot) { 'clue-windows-p03-proof-pilot/1' } else { 'clue-windows-reviewed-production-release/1' }
            checkedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
            state = if ($result -ne 0) { 'BLOCKED' } elseif ($ProofPilot) { 'PASS' } else { 'RELEASE' }
            blocker = $blocker
            phase = if ($result -ne 0) { $phase } elseif ($ProofPilot) { 'P03_NATIVE_PROOF_COMPLETE' } else { 'RELEASE_COMPLETE' }
            sourceCommit = $commit
            supervisorSha256 = if ($null -ne $reviewed) { $reviewed.wrapperSha } else { $null }
            faultReport = if ($null -ne $reviewed) { $reviewed.bundlePath } else { $null }
            faultReportSha256 = if ($null -ne $reviewed) { $reviewed.bundleSha } else { $null }
            qualificationReceipt = if ($null -ne $receipt) { $receipt.path } else { $null }
            qualificationReceiptSha256 = if ($null -ne $receipt) { $receipt.sha256 } else { $null }
            isolatedCheckoutCleanup = $checkoutCleanup
        }
        if ($ProofPilot) {
            $report['scope'] = 'disposable-synthetic-local-target'
            $report['patchManifestSha256'] = $patchManifestSha
            $report['nativeExitCode'] = $gateExit
            $report['nativeFailureStage'] = $pilotFailureStage
            $report['nativeProof'] = $gateOutcome
        } else {
            $report['releaseEvidenceDirectory'] = $output
            $report['gateExitCode'] = $gateExit
            $report['gates'] = $gateOutcome
        }
        try {
            Assert-ExactPath $evidence $true
            $depth = if ($ProofPilot) { 24 } else { 8 }
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth $depth) + [Environment]::NewLine)
            $outStream = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try { $outStream.Write($bytes, 0, $bytes.Length) }
            finally { $outStream.Dispose() }
            Write-Host "Send this result report: $reportPath"
        } catch {
            Write-Host "CLU-E Windows $operation could not save the launcher result report."
            if ($result -eq 0) { $result = 2 }
        }
    }
}
exit $result
