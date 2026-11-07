[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [switch]$RequireFormalRelease
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
} else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
}
Set-Location $RepoRoot

$ReleaseDir = Join-Path $RepoRoot 'release'
New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "`n=== $Label ===" -ForegroundColor Cyan
    & $FilePath @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "$Label failed with exit code $code."
    }
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$LogPath
    )
    Write-Host "`n=== $Label ===" -ForegroundColor Cyan
    & $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath | Out-Host
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "$Label failed with exit code $code. See $LogPath"
    }
    return Get-Content -LiteralPath $LogPath -Raw
}

function Require-Path {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Required P1 closure file is missing: $Path"
    }
}

$required = @(
    'package.json',
    'tools/release.mjs',
    'tools/p0-acceptance.mjs',
    'docs/P1_CLOSURE_LEDGER.md',
    'selftest/browser-agent-fetch-policy.test.ts',
    'selftest/clue-dashboard-server-authority.test.ts',
    'selftest/doctor-path-containment.test.ts',
    'selftest/mission-profile-binding.test.ts',
    'selftest/task-event-authority.test.ts',
    'targets/clu/profile.yaml',
    'targets/clu/benchmark/master-benchmark.md'
)
foreach ($relativePath in $required) {
    Require-Path (Join-Path $RepoRoot $relativePath)
}

Write-Host "CLU-E P1 closure root: $RepoRoot" -ForegroundColor Green

Invoke-NativeStep 'TypeScript typecheck' 'npm' @('run', 'typecheck')
Invoke-NativeStep 'Production build' 'npm' @('run', 'build')

$dedicatedTests = @(
    'browser-agent-fetch-policy.test.js',
    'clue-dashboard-server-authority.test.js',
    'doctor-path-containment.test.js',
    'mission-profile-binding.test.js',
    'task-event-authority.test.js'
)
foreach ($testFile in $dedicatedTests) {
    $compiled = Join-Path $RepoRoot (Join-Path 'dist/selftest' $testFile)
    Require-Path $compiled
    Invoke-NativeStep "Dedicated test: $testFile" 'node' @('--test', '--test-force-exit', $compiled)
}

Invoke-NativeStep 'Complete self-test suite' 'npm' @('run', 'selftest')

$package = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$scriptNames = @($package.scripts.PSObject.Properties.Name)
if ($scriptNames -notcontains 'dashboard:verify') {
    throw 'package.json does not declare dashboard:verify; P1 UI closure evidence cannot be produced.'
}
Invoke-NativeStep 'Dashboard verification' 'npm' @('run', 'dashboard:verify')

$doctorBeforePath = Join-Path $ReleaseDir 'P1-doctor-before-ratification.log'
$doctorBefore = Invoke-NativeCapture 'Deep doctor before ratification' 'node' @('dist/src/cli/index.js', 'doctor', '--deep') $doctorBeforePath
if ($doctorBefore -match '(?im)^.*ratification\s+never performed.*$') {
    Write-Host "`nDocumentation ratification is required. Follow the interactive prompt exactly." -ForegroundColor Yellow
    Invoke-NativeStep 'Creator documentation ratification' 'node' @('dist/src/cli/index.js', 'docs', 'ratify')
} else {
    Write-Host 'Documentation pack is already ratified for the installed seal.' -ForegroundColor Green
}

$doctorFinalPath = Join-Path $ReleaseDir 'P1-doctor-final.log'
$doctorFinal = Invoke-NativeCapture 'Deep doctor after ratification' 'node' @('dist/src/cli/index.js', 'doctor', '--deep') $doctorFinalPath
if ($doctorFinal -match '(?im)^.*ratification\s+never performed.*$') {
    throw 'Documentation ratification is still absent after the Creator act.'
}

Invoke-NativeStep 'Regenerate sealed Status report' 'node' @('dist/src/cli/index.js', 'status', 'report')

Write-Host "`n=== Gated exact P1 release ===" -ForegroundColor Cyan
$releaseStartedUtc = [DateTime]::UtcNow
& node 'tools/release.mjs' '--write-root'
$releaseExitCode = $LASTEXITCODE
if (@(0, 1) -notcontains $releaseExitCode) {
    throw "release.mjs failed with unexpected exit code $releaseExitCode."
}

$latestReportFile = Get-ChildItem -LiteralPath $ReleaseDir -Filter '*.report.json' -File |
    Where-Object { $_.LastWriteTimeUtc -ge $releaseStartedUtc.AddSeconds(-2) } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if ($null -eq $latestReportFile) {
    throw "release.mjs produced no new machine report in $ReleaseDir (exit $releaseExitCode)."
}
$releaseReport = Get-Content -LiteralPath $latestReportFile.FullName -Raw | ConvertFrom-Json
$allowedVerdicts = @('RELEASE', 'RELEASE_CANDIDATE')
if ($allowedVerdicts -notcontains [string]$releaseReport.verdict) {
    throw "Release verdict is $($releaseReport.verdict), not RELEASE or RELEASE_CANDIDATE."
}
if ($releaseReport.releaseQualification.portablePass -ne $true) {
    throw 'Exact release portable gates did not pass.'
}
if ($releaseReport.releaseQualification.nativeWindows -ne $true) {
    throw 'The exact release is not qualified by native Windows evidence.'
}
if ($RequireFormalRelease -and $releaseReport.verdict -ne 'RELEASE') {
    throw 'Formal RELEASE was required, but clean Git commit/tree provenance is not proved.'
}

Invoke-NativeStep 'Exact-archive P0 acceptance' 'node' @('tools/p0-acceptance.mjs')
$p0ReportPath = Join-Path $RepoRoot 'p0-acceptance-report.json'
Require-Path $p0ReportPath
$p0Report = Get-Content -LiteralPath $p0ReportPath -Raw | ConvertFrom-Json
if ($p0Report.summary.overallPass -ne $true) {
    throw 'P0 acceptance report does not state overallPass: true.'
}
if ($p0Report.summary.boundToArchive -ne $true -or $p0Report.summary.archiveMatchesTree -ne $true) {
    throw 'P0 acceptance is not bound to an archive that matches the current tree.'
}

Invoke-NativeStep 'Final sealed Status report' 'node' @('dist/src/cli/index.js', 'status', 'report')
$doctorReceiptPath = Join-Path $ReleaseDir 'P1-doctor-closure.log'
$doctorReceipt = Invoke-NativeCapture 'Final P1 deep doctor' 'node' @('dist/src/cli/index.js', 'doctor', '--deep') $doctorReceiptPath
if ($doctorReceipt -match '(?im)^.*ratification\s+never performed.*$') {
    throw 'Final doctor still reports absent documentation ratification.'
}

$manifestPath = Join-Path $RepoRoot 'MANIFEST.txt'
$statusPath = Join-Path $RepoRoot 'clue-status.md'
Require-Path $manifestPath
Require-Path $statusPath

$closureStatus = if ($releaseReport.verdict -eq 'RELEASE') {
    'CLOSED'
} else {
    'CLOSED_WITH_RECORDED_GIT_PROVENANCE_ABSENCE'
}

$receipt = [ordered]@{
    schema = 'clue.p1.closure-receipt/1'
    generated_at = [DateTime]::UtcNow.ToString('o')
    phase = 'P1'
    status = $closureStatus
    release = [ordered]@{
        verdict = [string]$releaseReport.verdict
        report = $latestReportFile.Name
        archive = [string]$releaseReport.archive.file
        sha256 = [string]$releaseReport.archive.sha256
        bytes = [int64]$releaseReport.archive.bytes
        files = [int]$releaseReport.archive.fileCount
        portable_pass = [bool]$releaseReport.releaseQualification.portablePass
        native_windows = [bool]$releaseReport.releaseQualification.nativeWindows
        clean_git_tree = [bool]$releaseReport.releaseQualification.cleanGitTree
    }
    selftest = [ordered]@{
        tests = [int]$releaseReport.smoke.selftest.tests
        passed = [int]$releaseReport.smoke.selftest.passCount
        failed = [int]$releaseReport.smoke.selftest.fail
        skipped = [int]$releaseReport.smoke.selftest.skipped
    }
    p0_acceptance = [ordered]@{
        overall_pass = [bool]$p0Report.summary.overallPass
        items_passed = [int]$p0Report.summary.itemsPassed
        items_total = [int]$p0Report.summary.itemsTotal
        suite_tests = [int]$p0Report.summary.suiteTests
        suite_pass = [int]$p0Report.summary.suitePass
        suite_fail = [int]$p0Report.summary.suiteFail
        archive_matches_tree = [bool]$p0Report.summary.archiveMatchesTree
        archive_sha256 = [string]$p0Report.summary.archiveSha256
    }
    documentation = [ordered]@{
        ratification_verified_by_doctor = $true
        doctor_log = (Split-Path -Leaf $doctorReceiptPath)
        closure_ledger = 'docs/P1_CLOSURE_LEDGER.md'
    }
    generated_documents = [ordered]@{
        manifest = 'MANIFEST.txt'
        manifest_sha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        status = 'clue-status.md'
        status_sha256 = (Get-FileHash -LiteralPath $statusPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    limitations = @($releaseReport.limitations)
    next_phase = 'P2 — seal the evidence epoch, then open the first lock-governed cycle'
}

$receiptJsonPath = Join-Path $ReleaseDir 'P1-CLOSURE-RECEIPT.json'
$receiptMdPath = Join-Path $ReleaseDir 'P1-CLOSURE-RECEIPT.md'
$receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receiptJsonPath -Encoding utf8

$limitationsText = if (@($receipt.limitations).Count -eq 0) {
    '- None.'
} else {
    (@($receipt.limitations) | ForEach-Object { "- $_" }) -join "`n"
}
$receiptMarkdown = @"
# CLU-E P1 Closure Receipt

**Status:** $($receipt.status)  
**Generated:** $($receipt.generated_at)

## Exact release

- Verdict: $($receipt.release.verdict)
- Archive: $($receipt.release.archive)
- SHA-256: $($receipt.release.sha256)
- Files: $($receipt.release.files)
- Bytes: $($receipt.release.bytes)
- Portable gates: $($receipt.release.portable_pass)
- Native Windows: $($receipt.release.native_windows)
- Clean Git tree: $($receipt.release.clean_git_tree)

## Test authority

- Self-tests: $($receipt.selftest.passed)/$($receipt.selftest.tests) passed; $($receipt.selftest.failed) failed; $($receipt.selftest.skipped) skipped
- P0 items: $($receipt.p0_acceptance.items_passed)/$($receipt.p0_acceptance.items_total)
- P0 suite: $($receipt.p0_acceptance.suite_pass)/$($receipt.p0_acceptance.suite_tests) passed; $($receipt.p0_acceptance.suite_fail) failed
- Archive matches tree: $($receipt.p0_acceptance.archive_matches_tree)

## Governance

- Documentation ratification verified by final deep doctor.
- Root MANIFEST.txt and clue-status.md were regenerated.
- The evidence epoch was deliberately **not** sealed by this script.
- No cycle was opened or closed.

## Recorded limitations

$limitationsText

## P2 hand-off

Preserve this receipt together with the archive, machine report, SHA-256 manifests, P0 report and gate log. Then seal the evidence epoch and open the first lock-governed cycle.
"@
Set-Content -LiteralPath $receiptMdPath -Value $receiptMarkdown -Encoding utf8

Write-Host "`nP1 closure receipt written:" -ForegroundColor Green
Write-Host "  $receiptJsonPath"
Write-Host "  $receiptMdPath"
Write-Host "`nP1 status: $closureStatus" -ForegroundColor Green
if ($releaseReport.verdict -eq 'RELEASE_CANDIDATE') {
    Write-Warning 'P1 exact-archive closure passed, but full RELEASE wording remains unavailable until a clean Git commit/tree identifies these exact bytes.'
}
Write-Host 'Do not run epoch seal or cycle commands until the release package has been preserved.' -ForegroundColor Yellow
