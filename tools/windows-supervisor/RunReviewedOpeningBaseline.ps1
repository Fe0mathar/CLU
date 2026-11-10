[CmdletBinding()]
param(
    [switch] $Candidate,
    [string] $OpeningReport,
    [string] $ProofContract,
    [string] $PatchManifest,
    [string] $OfflineCache
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Import only the reviewed helpers. The P03 launcher and its qualification
# script remain byte-pinned by their original manifest.
function Read-ReviewedScript([string] $Path, [string] $Sha256) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 1MB) { throw 'BASELINE_REVIEWED_SCRIPT_UNVERIFIED' }
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $reader = [IO.StreamReader]::new($stream, $utf8, $false, 4096, $true)
        try { $source = $reader.ReadToEnd().Replace("`r`n", "`n") }
        finally { $reader.Dispose() }
        $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($source))).ToLowerInvariant()
        if ($digest -cne $Sha256) { throw 'BASELINE_REVIEWED_SCRIPT_UNVERIFIED' }
        return $source
    } finally { $stream.Dispose() }
}

function Write-PinnedReceipt([string] $Directory, [string] $Name, $Body) {
    $path = Join-Path $Directory $Name
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(($Body | ConvertTo-Json -Depth 16) + "`n")
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    return [pscustomobject]@{ path = $path; sha256 = $sha; lock = Open-PinnedFile $path $sha 1MB }
}

function New-LiveQualification($Reviewed, [string] $Directory, [string] $Commit, [string] $ReviewDigest) {
    $cases = [ordered]@{}
    foreach ($name in $script:reviewedNativeCases) { $cases[$name] = $Reviewed.qualification['cases'][$name] }
    $cases['production-request-admission'] = 'PASS'
    $cases['network-boundary-fault'] = 'PASS'
    $body = [ordered]@{
        schemaVersion = 'clue-windows-supervisor-production-qualification/2'
        checkedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        qualificationScope = 'PRODUCTION_PROOF'
        proofAuthorization = $true
        canaryStatus = 'PASS'
        fixtureRemoved = $true
        supervisorSha256 = $Reviewed.wrapperSha
        supervisorPathSha256 = $Reviewed.wrapperPathSha
        host = $Reviewed.qualification['host']
        cases = $cases
        operatorReview = [ordered]@{
            operation = 'profile-proof-session'
            commit = $Commit
            openingReviewDigest = $ReviewDigest
            networkFaultScope = $script:reviewedFaultScope
            offHostLan = 'NOT_TESTED'
            admissionSha256 = $script:reviewedAdmissionSha
            nativeCanariesSha256 = $script:reviewedCanariesSha
            networkFaultBundleSha256 = $Reviewed.bundleSha
        }
    }
    return Write-PinnedReceipt $Directory 'qualification.json' $body
}

function New-OperationAuthorization([string] $Directory, [string] $Operation, [string] $Commit,
        [string] $ReviewDigest, [string] $QualificationSha256) {
    $body = [ordered]@{
        schemaVersion = 'clue-windows-proof-operation-authorization/1'
        checkedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        operation = $Operation
        commit = $Commit
        reviewDigest = $ReviewDigest
        qualificationSha256 = $QualificationSha256
        authorization = 'APPROVED'
    }
    return Write-PinnedReceipt $Directory 'operator-authorization.json' $body
}

function Invoke-BaselineGit([string] $Git, [string] $Repo, [string] $FixedPath, [string[]] $Arguments) {
    $options = @('--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
        '-c', 'push.recurseSubmodules=no', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0')
    $start = New-ChildStart $Git ($options + $Arguments) $Repo $FixedPath -PilotEnvironment
    $start.Environment['GIT_ALLOW_PROTOCOL'] = ''
    $start.Environment['GIT_NO_LAZY_FETCH'] = '1'
    $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
    return Invoke-Child $start 30000 -Capture
}

function Assert-BaselineCheckout([string] $Git, [string] $Repo, [string] $FixedPath, [string] $Commit) {
    $top = Invoke-BaselineGit $Git $Repo $FixedPath @('rev-parse', '--show-toplevel')
    if (![IO.Path]::GetFullPath($top).Equals($Repo, [StringComparison]::OrdinalIgnoreCase)) { throw 'BASELINE_GIT_ROOT_UNVERIFIED' }
    $head = Invoke-BaselineGit $Git $Repo $FixedPath @('rev-parse', '--verify', 'HEAD^{commit}')
    $index = Invoke-BaselineGit $Git $Repo $FixedPath @('ls-files', '--stage', '-v', '-z')
    if (!$index -or $index.Contains([char] 0xfffd)) { throw 'BASELINE_GIT_INDEX_UNVERIFIED' }
    foreach ($entry in $index.TrimEnd([char] 0).Split([char] 0)) {
        if ($entry -cnotmatch '\AH [0-7]{6} [a-f0-9]{40} 0\t' -or $entry.StartsWith('H 160000 ')) {
            throw 'BASELINE_GIT_INDEX_REQUIRES_REVIEW'
        }
    }
    $configNames = Invoke-BaselineGit $Git $Repo $FixedPath @('config', '--null', '--name-only', '--list')
    if ($configNames.Contains([char] 0xfffd) -or $configNames.Split([char] 0) -match '\Afilter\..+\.(clean|process)\z') {
        throw 'BASELINE_GIT_FILTER_REQUIRES_REVIEW'
    }
    $status = Invoke-BaselineGit $Git $Repo $FixedPath @('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all')
    if ($status -cne '' -or $head -cne $Commit) { throw 'BASELINE_CHECKOUT_CHANGED' }
}

function Read-BaselineChild($Start, $Guardian, [int] $Timeout, [switch] $CaptureDiagnostics) {
    $Start.RedirectStandardOutput = $true
    $Start.RedirectStandardError = $CaptureDiagnostics.IsPresent
    $script:runner = [Diagnostics.Process]::Start($Start)
    if ($null -eq $script:runner) { throw 'BASELINE_CHILD_START_FAILED' }
    $read = $script:runner.StandardOutput.ReadToEndAsync()
    $diagnostics = if ($CaptureDiagnostics) { $script:runner.StandardError.ReadToEndAsync() } else { $null }
    $wait = [Diagnostics.Stopwatch]::StartNew()
    while (!$script:runner.WaitForExit(250)) {
        if ($null -ne $Guardian -and $Guardian.HasExited) { throw 'BASELINE_GUARDIAN_EXITED' }
        if ($wait.ElapsedMilliseconds -ge $Timeout) { throw 'BASELINE_CHILD_TIMEOUT' }
    }
    if (!$read.Wait(10000)) { throw 'BASELINE_CHILD_OUTPUT_UNVERIFIED' }
    $codes = @()
    if ($null -ne $diagnostics) {
        if (!$diagnostics.Wait(10000)) { throw 'BASELINE_CHILD_OUTPUT_UNVERIFIED' }
        $stderr = $diagnostics.GetAwaiter().GetResult()
        if ($stderr) { Write-Host $stderr.TrimEnd() }
        $codes = @([regex]::Matches($stderr, '\bBASELINE_[A-Z0-9_]{1,72}\b') |
            ForEach-Object { $_.Value } | Select-Object -Unique -First 8)
    }
    $output = $read.GetAwaiter().GetResult()
    if (!$output -or $output.Length -gt 1MB) { throw 'BASELINE_CHILD_OUTPUT_UNVERIFIED' }
    $report = ConvertFrom-Json -InputObject $output -AsHashtable -Depth 24
    if ($report -isnot [System.Collections.IDictionary]) { throw 'BASELINE_CHILD_OUTPUT_UNVERIFIED' }
    $exitCode = $script:runner.ExitCode
    $script:runner.Dispose()
    $script:runner = $null
    return [pscustomobject]@{ report = $report; exitCode = $exitCode; diagnosticCodes = $codes }
}

$engineSha = '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a'
$nodeSha = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'
$npmSha = '3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e'
$preludeSha = '334ca86fb237c565f38b17a7b84485c5fc1b603d1b16e07a68a3278cf42a37e9'

# Invoke-Child is also used by the P03 launcher, which owns a disposable checkout.
$script:checkoutOwned = $false
$locks = [Collections.Generic.List[IO.Stream]]::new()
$guardian = $null
$script:runner = $null
$commit = $null
$reviewed = $null
$reviewDigest = $null
$receipt = $null
$authorization = $null
$inspection = $null
$inspectionExitCode = $null
$inspectionDiagnostics = @()
$childOutcome = $null
$baselineExitCode = $null
$reportPath = $null
$runDirectory = $null
$blocker = $null
$phase = 'BASELINE_PREFLIGHT_UNVERIFIED'
$result = 2
$operation = if ($Candidate) { 'live-candidate-proof' } else { 'live-opening-baseline' }
$reportKind = if ($Candidate) { 'LIVE_CANDIDATE_PROOF' } else { 'LIVE_OPENING_BASELINE' }
try {
    if (!$IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::UserInteractive) {
        throw 'BASELINE_INTERACTIVE_WINDOWS_REQUIRED'
    }
    $launcherPath = Join-Path $PSScriptRoot 'RunReviewedProductionRelease.ps1'
    $reviewHelper = Join-Path $PSScriptRoot 'ReviewedProductionQualification.ps1'
    $launcher = Read-ReviewedScript $launcherPath '7db071da20e1c276b52935ca3a33e183837808499c3b3e98f4704f46ed3053d5'
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($launcher, [ref] $tokens, [ref] $errors)
    if ($errors.Count -ne 0) { throw 'BASELINE_REVIEWED_SCRIPT_UNVERIFIED' }
    foreach ($name in @('Assert-ExactPath', 'Assert-ExternalPath', 'Get-Digest', 'Get-PathDigest', 'Open-PinnedFile',
            'Read-Json', 'Assert-ProtectedRoot', 'Assert-InstalledPair', 'Test-ObservedAdmission', 'New-ChildStart', 'Invoke-Child')) {
        $definitions = @($ast.EndBlock.Statements | Where-Object {
                $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name
            })
        if ($definitions.Count -ne 1) { throw 'BASELINE_REVIEWED_SCRIPT_UNVERIFIED' }
        . ([scriptblock]::Create($definitions[0].Extent.Text))
    }
    Assert-ExactPath $launcherPath $false
    Assert-ExactPath $reviewHelper $false

    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    $evidence = Join-Path ([IO.Path]::GetDirectoryName($repo)) 'release-evidence'
    Assert-ExactPath $repo $true
    Assert-ExactPath $programFiles $true
    Assert-ExactPath $evidence $true
    Assert-ExternalPath $evidence $repo $programFiles
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff', [Globalization.CultureInfo]::InvariantCulture)
    $nonce = [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $reportPath = Join-Path $evidence "CLU-E_WINDOWS_$($reportKind)_$stamp-$nonce.json"
    if ($Candidate) {
        foreach ($candidatePath in @($OpeningReport, $ProofContract, $PatchManifest)) {
            if (!$candidatePath -or ![IO.Path]::IsPathFullyQualified($candidatePath)) { throw 'BASELINE_EXTERNAL_PROOF_INPUTS_REQUIRED' }
            Assert-ExactPath $candidatePath $false
            if (!$candidatePath.StartsWith("$evidence\", [StringComparison]::OrdinalIgnoreCase)) {
                throw 'BASELINE_EXTERNAL_PROOF_INPUTS_REQUIRED'
            }
        }
        if ($OfflineCache) {
            if (![IO.Path]::IsPathFullyQualified($OfflineCache)) { throw 'BASELINE_OFFLINE_CACHE_PATH_INVALID' }
            Assert-ExactPath $OfflineCache $true
            Assert-ExternalPath $OfflineCache $repo $programFiles
        }
    } elseif ($OpeningReport -or $ProofContract -or $PatchManifest -or $OfflineCache) {
        throw 'BASELINE_EXTERNAL_PROOF_INPUTS_REQUIRED'
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $operatorSid = $identity.User.Value
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'BASELINE_STANDARD_SESSION_REQUIRED'
        }
    } finally { $identity.Dispose() }
    $sessionId = (Get-Process -Id $PID).SessionId
    if ($sessionId -le 0) { throw 'BASELINE_STANDARD_SESSION_REQUIRED' }

    $phase = 'BASELINE_REVIEWED_EVIDENCE_UNVERIFIED'
    $qualificationHelper = Read-ReviewedScript $reviewHelper '548b8ec60665e63dd794c78a2fb8eb98584a42fb74d1b8f04904f027e6b81a97'
    . ([scriptblock]::Create($qualificationHelper))
    $reviewed = Get-ReviewedProductionEvidence $evidence
    foreach ($lock in $reviewed.locks) { $locks.Add($lock) }
    $wrapperSha = $reviewed.wrapperSha
    $wrapperPathSha = $reviewed.wrapperPathSha
    $admission = $reviewed.admission
    $install = $admission['installation']
    $image = $reviewed.image
    if (!(Test-ObservedAdmission $admission) -or $image -cne $install['wrapperPath'] -or
        $reviewed.qualification['host']['nodeSha256'] -cne $nodeSha) { throw $phase }

    $digestFolder = [IO.Path]::GetDirectoryName($image)
    $protectedRoot = [IO.Path]::GetDirectoryName($digestFolder)
    $leaf = [IO.Path]::GetFileName($protectedRoot)
    if ($leaf -cnotmatch '\A\.clue-proof-production-[a-f0-9]{32}\z' -or
        ![IO.Path]::GetDirectoryName($protectedRoot).Equals($programFiles, [StringComparison]::OrdinalIgnoreCase) -or
        $image -cne (Join-Path (Join-Path $protectedRoot $wrapperSha) 'CLU-E-Windows-Supervisor.exe')) {
        throw 'BASELINE_INSTALLED_IMAGE_PATH_INVALID'
    }
    $phase = 'BASELINE_INSTALLED_IMAGE_UNVERIFIED'
    $engine = Join-Path $digestFolder 'wxc-exec.exe'
    $prelude = Join-Path $protectedRoot 'production-bind-prelude.cjs'
    Assert-InstalledPair $protectedRoot $operatorSid $image $engine $prelude
    $imageLock = Open-PinnedFile $image $wrapperSha 16MB
    $locks.Add($imageLock)
    $engineLock = Open-PinnedFile $engine $engineSha 768MB
    $locks.Add($engineLock)
    $preludeLock = Open-PinnedFile $prelude $preludeSha 1MB
    $locks.Add($preludeLock)

    $phase = 'BASELINE_PROTECTED_BUILD_RECEIPT_UNVERIFIED'
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

    $phase = 'BASELINE_TOOLCHAIN_UNVERIFIED'
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $locks.Add((Open-PinnedFile $node $nodeSha 256MB))
    $nodeDir = [IO.Path]::GetDirectoryName($node)
    $npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    $locks.Add((Open-PinnedFile $npm $npmSha 1MB))
    $git = Join-Path $programFiles 'Git\cmd\git.exe'
    $pwsh = Join-Path $programFiles 'PowerShell\7\pwsh.exe'
    Assert-ExactPath $git $false
    Assert-ExactPath $pwsh $false
    $systemDirectory = [Environment]::SystemDirectory
    $fixedPath = (@($systemDirectory, [IO.Path]::GetDirectoryName($git), [IO.Path]::GetDirectoryName($pwsh), $nodeDir) -join ';')

    $phase = 'BASELINE_CURRENT_HOST_UNVERIFIED'
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
    $hostText = Invoke-Child (New-ChildStart $node @('-e', $hostCheck) $repo $fixedPath -PilotEnvironment) 30000 -Capture
    $currentHost = ConvertFrom-Json -InputObject $hostText -AsHashtable -Depth 4
    $recordedHost = $reviewed.qualification['host']
    foreach ($key in @('hostnameSha256', 'principalSha256', 'platform', 'arch', 'osRelease', 'osVersion', 'nodeVersion')) {
        if ($currentHost[$key] -cne $recordedHost[$key]) { throw $phase }
    }

    $phase = 'BASELINE_GIT_UNVERIFIED'
    $commit = Invoke-BaselineGit $git $repo $fixedPath @('rev-parse', '--verify', 'HEAD^{commit}')
    if ($commit -cnotmatch '\A[a-f0-9]{40}\z') { throw $phase }
    Assert-BaselineCheckout $git $repo $fixedPath $commit

    $phase = 'BASELINE_BUILD_UNVERIFIED'
    $compiler = Join-Path $repo 'node_modules\typescript\bin\tsc'
    $config = Join-Path $repo 'tsconfig.json'
    $scriptName = if ($Candidate) { 'live-candidate-proof.mjs' } else { 'live-opening-baseline.mjs' }
    $script = Join-Path $PSScriptRoot $scriptName
    Assert-ExactPath $compiler $false
    Assert-ExactPath $config $false
    Assert-ExactPath $script $false
    $dist = Join-Path $repo 'dist'
    if (Test-Path -LiteralPath $dist) {
        Assert-ExactPath $dist $true
        if (Get-ChildItem -LiteralPath $dist -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1) {
            throw 'BASELINE_BUILD_OUTPUT_REDIRECTED'
        }
    }
    $runDirectory = Join-Path $evidence "$operation-$stamp-$nonce"
    $null = New-Item -ItemType Directory -Path $runDirectory
    Assert-ExactPath $runDirectory $true
    $buildInfo = Join-Path $runDirectory 'build.tsbuildinfo'
    Write-Host 'Rebuilding the clean live checkout with the verified Windows Node executable.'
    try {
        if ((Invoke-Child (New-ChildStart $node @($compiler, '--project', $config, '--tsBuildInfoFile', $buildInfo) $repo $fixedPath -PilotEnvironment) 300000) -ne 0) {
            throw 'BASELINE_BUILD_FAILED'
        }
    } finally {
        if (Test-Path -LiteralPath $buildInfo -PathType Leaf) { Remove-Item -LiteralPath $buildInfo }
    }
    Assert-BaselineCheckout $git $repo $fixedPath $commit

    $phase = 'BASELINE_REVIEW_UNVERIFIED'
    $inspectArgs = @($script, '--inspect', $commit)
    if ($Candidate) {
        $inspectArgs += @($OpeningReport, $ProofContract, $PatchManifest, (Join-Path $runDirectory 'review-npm-cache'))
        if ($OfflineCache) { $inspectArgs += $OfflineCache }
    }
    $inspectStart = New-ChildStart $node $inspectArgs $repo $fixedPath -PilotEnvironment
    $inspectOutcome = Read-BaselineChild $inspectStart $null 300000 -CaptureDiagnostics
    $inspection = $inspectOutcome.report
    $inspectionExitCode = $inspectOutcome.exitCode
    $inspectionDiagnostics = $inspectOutcome.diagnosticCodes
    if ($inspectionExitCode -ne 0 -or $inspection['state'] -cne 'READY' -or $inspection['sourceCommit'] -cne $commit -or
        $inspection['reviewDigest'] -cnotmatch '\A[a-f0-9]{64}\z' -or
        $inspection['review'] -isnot [System.Collections.IDictionary]) { throw $phase }
    $reviewDigest = $inspection['reviewDigest']
    if ($Candidate) {
        $review = $inspection['review']
        $openingLock = Open-PinnedFile $OpeningReport $review['openingReportSha256'] 1MB
        $locks.Add($openingLock)
        $opening = Read-Json $openingLock
        $locks.Add((Open-PinnedFile $ProofContract $review['proofContractSha256'] 2MB))
        $locks.Add((Open-PinnedFile $PatchManifest $review['patchManifestSha256'] 2MB))
        $candidateSource = Join-Path ([IO.Path]::GetDirectoryName($PatchManifest)) $review['candidateSourceName']
        $locks.Add((Open-PinnedFile $candidateSource $review['candidateSourceSha256'] 16MB))
        $qualificationPath = $opening['qualificationReceipt']
        $qualificationSha = $opening['qualificationReceiptSha256']
        $openingAuthorizationPath = $opening['authorizationReceipt']
        if ($qualificationSha -cne $review['executionBoundary']['qualificationSha256'] -or
            $opening['supervisorSha256'] -cne $wrapperSha -or
            !$qualificationPath.StartsWith("$evidence\", [StringComparison]::OrdinalIgnoreCase) -or
            !$openingAuthorizationPath.StartsWith("$evidence\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'BASELINE_CANDIDATE_QUALIFICATION_UNVERIFIED'
        }
        $receipt = [pscustomobject]@{ path = $qualificationPath; sha256 = $qualificationSha;
            lock = Open-PinnedFile $qualificationPath $qualificationSha 1MB }
        $locks.Add($receipt.lock)
        $locks.Add((Open-PinnedFile $openingAuthorizationPath $opening['authorizationReceiptSha256'] 1MB))
    }

    Write-Host ''
    Write-Host "Supervisor $wrapperSha"
    Write-Host "Committed source $commit"
    Write-Host 'The reviewed supervisor passed production request admission, seven native canaries, and the same-PC network fault test.'
    if ($Candidate) {
        Write-Host 'The candidate runner uses the exact opening boundary and records the verdict in the profile workspace.'
    } else {
        Write-Host 'The live benchmark writes a run into this profile workspace. The launcher invokes the registered opening benchmark only.'
    }
    Write-Host ($inspection['review'] | ConvertTo-Json -Depth 16)
    $verb = if ($Candidate) { 'AUTHORIZE LIVE CANDIDATE' } else { 'QUALIFY LIVE BASELINE' }
    $answer = "$verb $($reviewDigest.Substring(0, 12))"
    $phase = 'BASELINE_OPERATOR_AUTHORIZATION_REQUIRED'
    if ((Read-Host "Type $answer to approve this exact operation") -cne $answer) {
        throw 'BASELINE_OPERATOR_AUTHORIZATION_DECLINED'
    }
    Assert-BaselineCheckout $git $repo $fixedPath $commit
    if (!$Candidate) {
        $receipt = New-LiveQualification $reviewed $runDirectory $commit $reviewDigest
        $locks.Add($receipt.lock)
    }
    $authorization = New-OperationAuthorization $runDirectory $operation $commit $reviewDigest $receipt.sha256
    $locks.Add($authorization.lock)

    $phase = 'BASELINE_PRODUCTION_SESSION_UNVERIFIED'
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class ClueLiveBaselinePipe {
    [DllImport("kernel32.dll", EntryPoint = "WaitNamedPipeW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WaitNamedPipe(string name, uint milliseconds);
    public static int State(string name, uint milliseconds) {
        return WaitNamedPipe(name, milliseconds) ? 0 : Marshal.GetLastWin32Error();
    }
}
'@
    $pipe = "\\.\pipe\CLU-E-Production-Proof-$leaf-$sessionId"
    if ([ClueLiveBaselinePipe]::State($pipe, 1) -ne 2) { throw 'BASELINE_PRODUCTION_SESSION_ALREADY_PRESENT' }
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match '^(COR_|CORECLR_|COMPLUS_|DOTNET_|APPDOMAIN_MANAGER_|DEVPATH$|__COMPAT_LAYER$|OPENAI_API_KEY$)') {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        }
    }
    Write-Host 'Approve the Windows prompt for the verified production supervisor using your current Windows account.'
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
    } catch { throw 'BASELINE_PRODUCTION_SESSION_LAUNCH_FAILED' }
    finally { $env:PATH = $originalPath }
    $wait = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($null -eq $guardian -or $guardian.HasExited) { throw 'BASELINE_GUARDIAN_EXITED' }
        $listening = [ClueLiveBaselinePipe]::State($pipe, 100) -eq 0
        if (!$listening) { Start-Sleep -Milliseconds 75 }
    } while (!$listening -and $wait.ElapsedMilliseconds -lt 10000)
    if (!$listening -or $guardian.HasExited) { throw 'BASELINE_PRODUCTION_SESSION_NOT_READY' }

    $phase = 'BASELINE_NATIVE_RUN_UNVERIFIED'
    $runArgs = @($script, '--run', $commit, $reviewDigest)
    if ($Candidate) {
        $runArgs += @($OpeningReport, $ProofContract, $PatchManifest, (Join-Path $runDirectory 'run-npm-cache'))
        if ($OfflineCache) { $runArgs += $OfflineCache }
    }
    $start = New-ChildStart $node $runArgs $repo $fixedPath -PilotEnvironment
    $start.Environment['CLU_WINDOWS_SUPERVISOR_PATH'] = $image
    $start.Environment['CLU_WINDOWS_SUPERVISOR_SHA256'] = $wrapperSha
    $start.Environment['CLU_WINDOWS_SUPERVISOR_QUALIFICATION'] = $receipt.path
    $start.Environment['CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256'] = $receipt.sha256
    $start.Environment['CLU_PROOF_OPERATOR_AUTHORIZATION'] = $authorization.path
    $start.Environment['CLU_PROOF_OPERATOR_AUTHORIZATION_SHA256'] = $authorization.sha256
    $timeout = if ($Candidate) { 14400000 } else { 7200000 }
    $outcome = Read-BaselineChild $start $guardian $timeout
    $childOutcome = $outcome.report
    $baselineExitCode = $outcome.exitCode
    $boundary = $childOutcome['executionBoundary']
    $validOutcome = if ($Candidate) {
        $childOutcome['disposition'] -cin @('ACCEPT', 'REJECT', 'REVISE', 'INVALID') -and
        $childOutcome['controlArtifactSha256'] -cmatch '\A[a-f0-9]{64}\z' -and
        $childOutcome['candidateArtifactSha256'] -cmatch '\A[a-f0-9]{64}\z' -and
        $childOutcome['verdictArtifactSha256'] -cmatch '\A[a-f0-9]{64}\z'
    } else {
        $childOutcome['measures'] -eq 13 -and $childOutcome['incomplete'] -eq 0 -and
        $childOutcome['artifactSha256'] -cmatch '\A[a-f0-9]{64}\z'
    }
    if ($baselineExitCode -ne 0 -or $childOutcome['state'] -cne 'PASS' -or
        $childOutcome['sourceCommit'] -cne $commit -or $childOutcome['reviewDigest'] -cne $reviewDigest -or
        !$validOutcome -or
        $childOutcome['eventId'] -cnotmatch '\AEVENT-[0-9]+\z' -or
        $childOutcome['eventSha256'] -cnotmatch '\A[a-f0-9]{64}\z' -or
        $boundary -isnot [System.Collections.IDictionary] -or $boundary['kind'] -cne 'windows-supervisor' -or
        $boundary['sha256'] -cne $wrapperSha -or $boundary['qualificationSha256'] -cne $receipt.sha256) { throw $phase }

    $phase = 'BASELINE_POST_RUN_UNVERIFIED'
    Assert-BaselineCheckout $git $repo $fixedPath $commit
    Assert-InstalledPair $protectedRoot $operatorSid $image $engine $prelude
    if ((Get-Digest $imageLock) -cne $wrapperSha -or (Get-Digest $engineLock) -cne $engineSha -or
        (Get-Digest $preludeLock) -cne $preludeSha -or (Get-Digest $receipt.lock) -cne $receipt.sha256 -or
        (Get-Digest $authorization.lock) -cne $authorization.sha256 -or
        $guardian.HasExited) { throw $phase }
    $result = 0
} catch {
    $blocker = $_.Exception.Message
    if ($blocker -cnotmatch '^(?:RELEASE|BASELINE)_[A-Z0-9_]{1,72}$') { $blocker = $phase }
    Write-Host "CLU-E Windows $operation stopped: $blocker"
} finally {
    if ($null -ne $script:runner) {
        try {
            if (!$script:runner.HasExited) {
                $script:runner.Kill($true)
                $null = $script:runner.WaitForExit(30000)
            }
        } catch { }
        $script:runner.Dispose()
    }
    if ($null -ne $guardian) { $guardian.Dispose() }
    foreach ($lock in $locks) { $lock.Dispose() }
    if ($Candidate -and $runDirectory) {
        foreach ($cacheName in @('review-npm-cache', 'run-npm-cache')) {
            $stagedCache = Join-Path $runDirectory $cacheName
            if (Test-Path -LiteralPath $stagedCache) {
                try {
                    Assert-ExactPath $stagedCache $true
                    if (Get-ChildItem -LiteralPath $stagedCache -Force -Recurse |
                        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1) {
                        throw 'BASELINE_STAGED_CACHE_REDIRECTED'
                    }
                    Remove-Item -LiteralPath $stagedCache -Force -Recurse
                } catch {
                    if ($result -eq 0) {
                        $result = 2
                        $blocker = $phase = 'BASELINE_STAGED_CACHE_CLEANUP_UNVERIFIED'
                    }
                    Write-Host "Staged offline cache cleanup was unverified: $stagedCache"
                }
            }
        }
    }

    if ($null -ne $reportPath) {
        $report = [ordered]@{
            schemaVersion = if ($Candidate) { 'clue-windows-live-candidate-proof/1' } else { 'clue-windows-live-opening-baseline/2' }
            checkedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
            state = if ($result -eq 0) { 'PASS' } else { 'BLOCKED' }
            blocker = $blocker
            phase = if ($result -eq 0 -and $Candidate) { 'CANDIDATE_PROOF_COMPLETE' } elseif ($result -eq 0) { 'BASELINE_COMPLETE' } else { $phase }
            sourceCommit = $commit
            reviewDigest = $reviewDigest
            supervisorSha256 = if ($null -eq $reviewed) { $null } else { $reviewed.wrapperSha }
            qualificationReceipt = if ($null -eq $receipt) { $null } else { $receipt.path }
            qualificationReceiptSha256 = if ($null -eq $receipt) { $null } else { $receipt.sha256 }
            authorizationReceipt = if ($null -eq $authorization) { $null } else { $authorization.path }
            authorizationReceiptSha256 = if ($null -eq $authorization) { $null } else { $authorization.sha256 }
            inspectionExitCode = $inspectionExitCode
            inspectionDiagnosticCodes = $inspectionDiagnostics
            inspection = $inspection
            baselineExitCode = $baselineExitCode
            baseline = $childOutcome
        }
        if ($Candidate) {
            $report.Remove('baselineExitCode')
            $report.Remove('baseline')
            $report['candidateExitCode'] = $baselineExitCode
            $report['candidate'] = $childOutcome
        }
        try {
            Assert-ExactPath $evidence $true
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 24) + "`n")
            $stream = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try {
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush($true)
            } finally { $stream.Dispose() }
            Write-Host "Proof report: $reportPath"
        } catch {
            Write-Host 'CLU-E Windows proof runner could not save its report.'
            $result = 2
        }
    }
}
exit $result
