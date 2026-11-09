#Requires -Version 7.0
<#
.SYNOPSIS
    Starts, inspects, or stops the dedicated Chromium instance CLUE measures against.

.DESCRIPTION
    CLUE's browser agent attaches; it never launches. Starting a process is process
    execution, and process execution belongs to the host layer with a capability token
    rather than to the analysis plane. This script is that layer's first member.

    Three things it refuses to do, each because the alternative fails quietly:

      It will not use a personal Chrome profile. Attaching a debugger to the browser
      you actually use exposes every logged-in session on the machine to anything that
      can reach the debugging port, and the port has no authentication.

      It will not kill a Chrome it did not start. Matching on the process name would
      close every tab you had open. It matches on the profile directory in the command
      line instead, so only CLUE's own instance is ever touched.

      It will not report success on a launch it has not verified. The DevTools endpoint
      is polled until it answers or the timeout expires, and the exit code reflects
      which happened. A green message that means "we tried" is worse than a red one.

    Measurement flags matter more than they look. Chrome throttles timers in
    unfocused and occluded windows, so a frame-time measurement taken while the window
    is behind an editor is not a measurement of the application. The throttling
    disables below are the difference between a benchmark and a number.

.PARAMETER Executable
    Path to chrome.exe. Match clue.config.yaml -> browser.executable.

.PARAMETER ProfileDir
    Dedicated profile directory. Match browser.profile_dir. Must be outside the Murugan
    repository, outside the CLU repository, and must not be a personal Chrome profile.

.PARAMETER Port
    Remote debugging port, bound to 127.0.0.1 only. Match browser.remote_debugging_port.

.PARAMETER Url
    Page to open. Normally the shadow clone's dev server. CLUE measures the shadow tree;
    pointing this at a canonical dev server measures something CLUE is not reasoning over.

.PARAMETER Status
    Report whether an instance is running and whether the endpoint answers.

.PARAMETER Kill
    Stop the instance started with this profile. Never touches any other Chrome.

.PARAMETER Headless
    Run headless. Off by default: headless WebGPU can differ from windowed, and a
    baseline taken in one mode is not comparable to a patched run taken in the other.

.PARAMETER ProjectId
    Optional active CLU-E Project ID. When any project identity field is supplied, all
    project identity fields are mandatory and are persisted in the dedicated state file.

.PARAMETER TargetRootIdentity
    Exact canonical physical Target Root identity (path:v1:<platform>:<sha256>).

.PARAMETER ProjectProfileHash
    Exact canonical Project Profile hash (profile:v1:<sha256>) for the active generation.

.PARAMETER ProfileGeneration
    Positive Project Profile generation number.

.PARAMETER AllowedOrigin
    Optional exact HTTP(S) origin. Launch is refused when Url is outside this origin.

.PARAMETER Json
    Emit a machine-readable result instead of prose.

.EXAMPLE
    .\launch-test-browser.ps1 -Executable "C:\Program Files\Google\Chrome\Application\chrome.exe" `
        -ProfileDir "F:\CLU\chrome-profile" -Port 9222 -Url "http://localhost:5173" `
        -ProjectId "clu" -TargetRootIdentity "path:v1:win32:<sha256>" `
        -ProjectProfileHash "profile:v1:<sha256>" -ProfileGeneration 1 `
        -AllowedOrigin "http://localhost:5173"

.EXAMPLE
    .\launch-test-browser.ps1 -ProfileDir "F:\CLU\chrome-profile" -Port 9222 -Status -Json
#>

[CmdletBinding(DefaultParameterSetName = 'Launch')]
param(
    [Parameter(ParameterSetName = 'Launch')]
    [string] $Executable = 'C:\Program Files\Google\Chrome\Application\chrome.exe',

    [Parameter(Mandatory = $true)]
    [string] $ProfileDir,

    [ValidateRange(1024, 65535)]
    [int] $Port = 9222,

    [Parameter(ParameterSetName = 'Launch')]
    [string] $Url = 'about:blank',

    [Parameter(ParameterSetName = 'Status')]
    [switch] $Status,

    [Parameter(ParameterSetName = 'Kill')]
    [switch] $Kill,

    [Parameter(ParameterSetName = 'Launch')]
    [switch] $Headless,

    [Parameter(ParameterSetName = 'Launch')]
    [ValidateRange(5, 300)]
    [int] $TimeoutSeconds = 30,

    # Directories the profile must not live inside. The CLI passes the Murugan and CLU
    # roots; a profile inside either would put browser state into a snapshot.
    [string[]] $ForbiddenRoots = @(),

    [ValidatePattern('^[a-z0-9][a-z0-9._-]*$')]
    [string] $ProjectId,

    [ValidatePattern('^path:v1:[a-z0-9._-]+:[0-9a-f]{64}$')]
    [string] $TargetRootIdentity,

    [ValidatePattern('^profile:v1:[0-9a-f]{64}$')]
    [string] $ProjectProfileHash,

    [ValidateRange(1, [int]::MaxValue)]
    [int] $ProfileGeneration,

    [string] $AllowedOrigin,

    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$StateFileName = '.clue-browser.json'

function Assert-ProjectIdentityParameters {
    $provided = @(
        -not [string]::IsNullOrWhiteSpace($ProjectId),
        -not [string]::IsNullOrWhiteSpace($TargetRootIdentity),
        -not [string]::IsNullOrWhiteSpace($ProjectProfileHash),
        $ProfileGeneration -gt 0
    )
    $count = @($provided | Where-Object { $_ }).Count
    if ($count -ne 0 -and $count -ne 4) {
        Write-Result -Status 'error' -ExitCode 2 -Message (
            'ProjectId, TargetRootIdentity, ProjectProfileHash, and ProfileGeneration must be supplied together.'
        )
    }
}

function Assert-AllowedOrigin {
    param([Parameter(Mandatory)] [string] $Target)
    if ([string]::IsNullOrWhiteSpace($AllowedOrigin)) { return }

    try {
        $originUri = [System.Uri]::new($AllowedOrigin)
        $targetUri = [System.Uri]::new($Target)
    }
    catch {
        Write-Result -Status 'error' -ExitCode 2 -Message "Invalid AllowedOrigin or Url: $_"
    }

    if ($originUri.Scheme -notin @('http', 'https') -or
        $targetUri.Scheme -notin @('http', 'https')) {
        Write-Result -Status 'error' -ExitCode 2 -Message (
            'AllowedOrigin and Url must use HTTP or HTTPS.'
        )
    }

    if (-not [string]::IsNullOrEmpty($originUri.UserInfo) -or
        $originUri.AbsolutePath -ne '/' -or
        -not [string]::IsNullOrEmpty($originUri.Query) -or
        -not [string]::IsNullOrEmpty($originUri.Fragment)) {
        Write-Result -Status 'error' -ExitCode 2 -Message (
            'AllowedOrigin must be one pure HTTP(S) origin without credentials, path, query, or fragment.'
        )
    }

    $origin = $originUri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
    $targetOrigin = $targetUri.GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
    if (-not $origin.Equals($targetOrigin, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Result -Status 'error' -ExitCode 2 -Message (
            "Url origin $targetOrigin is outside the governed origin $origin."
        )
    }
}

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

function Write-Result {
    param(
        [Parameter(Mandatory)] [string] $Status,
        [Parameter(Mandatory)] [string] $Message,
        [hashtable] $Data = @{},
        [int] $ExitCode = 0
    )

    if ($Json) {
        $payload = @{ status = $Status; message = $Message } + $Data
        $payload | ConvertTo-Json -Depth 6 -Compress | Write-Output
    }
    else {
        $prefix = switch ($Status) {
            'ok'      { '  OK  ' }
            'warn'    { ' WARN ' }
            'error'   { ' FAIL ' }
            default   { ' INFO ' }
        }
        Write-Output "$prefix $Message"
        foreach ($key in $Data.Keys | Sort-Object) {
            Write-Output ("       {0,-22} {1}" -f $key, $Data[$key])
        }
    }
    exit $ExitCode
}

# ---------------------------------------------------------------------------
# Profile safety
# ---------------------------------------------------------------------------

function Assert-ProfileIsSafe {
    param([Parameter(Mandatory)] [string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        Write-Result -Status 'error' -Message 'ProfileDir is empty.' -ExitCode 2
    }

    $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')

    if ($resolved.Length -le 3 -or $resolved.StartsWith('\\')) {
        Write-Result -Status 'error' -Message "Refusing to use a drive root or network path as a profile: $resolved" -ExitCode 2
    }

    # A debugging port has no authentication. Attaching it to the browser holding your
    # real sessions would expose all of them to anything that can reach localhost.
    $personal = @()
    if ($env:LOCALAPPDATA) {
        $personal += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
        $personal += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
        $personal += (Join-Path $env:LOCALAPPDATA 'BraveSoftware')
    }
    if ($env:APPDATA) { $personal += (Join-Path $env:APPDATA 'Google\Chrome') }

    foreach ($candidate in $personal) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $full = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
        if ($resolved -eq $full -or $resolved.StartsWith("$full\", [StringComparison]::OrdinalIgnoreCase)) {
            Write-Result -Status 'error' -ExitCode 2 -Message (
                "Refusing to open a personal browser profile for remote debugging: $resolved. " +
                'Use a dedicated directory such as F:\CLU\chrome-profile.'
            )
        }
    }

    foreach ($forbidden in $ForbiddenRoots) {
        if ([string]::IsNullOrWhiteSpace($forbidden)) { continue }
        $full = [System.IO.Path]::GetFullPath($forbidden).TrimEnd('\')
        if ($resolved -eq $full -or $resolved.StartsWith("$full\", [StringComparison]::OrdinalIgnoreCase)) {
            Write-Result -Status 'error' -ExitCode 2 -Message (
                "Profile directory is inside a tree CLUE snapshots: $resolved. " +
                'Browser state would become source, and every capture would differ.'
            )
        }
    }

    return $resolved
}

# ---------------------------------------------------------------------------
# Process discovery
# ---------------------------------------------------------------------------

<#
    Finds Chrome processes started with this exact profile.

    Matching on the command line rather than the image name is the whole point: a name
    match would find, and -Kill would close, every browser window on the machine.
#>
function Get-ClueBrowserProcess {
    param([Parameter(Mandatory)] [string] $ResolvedProfile)

    $profileArgument = "--user-data-dir=$ResolvedProfile"

    try {
        Get-CimInstance -ClassName Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop |
            Where-Object {
                if (-not $_.CommandLine) { return $false }
                foreach ($argument in [regex]::Matches($_.CommandLine, '(?:[^\s"]+|"(?:[^"\\]|\\.)*")+')) {
                    if ($argument.Value.Replace('"', '') -eq $profileArgument) { return $true }
                }
                return $false
            }
    }
    catch {
        # Without command lines there is no safe way to tell our browser from yours, so
        # the answer is "none found" rather than a guess.
        @()
    }
}

function Test-DevToolsEndpoint {
    param([int] $EndpointPort, [int] $TimeoutSec = 3)

    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$EndpointPort/json/version" `
            -UseBasicParsing -NoProxy -MaximumRedirection 0 -TimeoutSec $TimeoutSec -ErrorAction Stop
        return ($response.Content | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Test-DebuggerProcessBinding {
    param(
        [Parameter(Mandatory)] [int] $EndpointPort,
        [Parameter(Mandatory)] [int] $ExpectedPid,
        [Parameter(Mandatory)] [bool] $ExpectVisible
    )

    try {
        $owner = Get-Process -Id $ExpectedPid -ErrorAction Stop
        if ($owner.ProcessName -ne 'chrome' -or ($ExpectVisible -and $owner.MainWindowHandle -eq 0)) { return $false }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $EndpointPort -ErrorAction Stop)
        $owned = @($listeners | Where-Object {
            $_.OwningProcess -eq $ExpectedPid -and $_.LocalAddress -in @('127.0.0.1', '::1')
        })
        return $owned.Count -eq $listeners.Count -and @($owned | Where-Object LocalAddress -eq '127.0.0.1').Count -eq 1
    }
    catch { return $false }
}

function Assert-DebuggerProcessBinding {
    param(
        [Parameter(Mandatory)] [object] $State,
        [Parameter(Mandatory)] [int] $EndpointPort
    )
    $statePid = [int](Get-StateField -State $State -Name 'pid')
    $expectVisible = -not [bool](Get-StateField -State $State -Name 'headless')
    if (-not (Test-DebuggerProcessBinding -EndpointPort $EndpointPort -ExpectedPid $statePid -ExpectVisible $expectVisible)) {
        Write-Result -Status 'error' -ExitCode 5 -Message (
            'The debugging listener is not owned exclusively by the expected Chrome process on loopback, or the visible window is unavailable.'
        )
    }
}

function Get-StateField {
    param(
        [object] $State,
        [Parameter(Mandatory)] [string] $Name
    )
    if ($null -eq $State) { return $null }
    $property = $State.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Read-StateFile {
    param([Parameter(Mandatory)] [string] $ResolvedProfile)

    $path = Join-Path $ResolvedProfile $StateFileName
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $state = Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json
    }
    catch {
        Write-Result -Status 'error' -ExitCode 5 -Message (
            "Dedicated browser state is unreadable: $path. Refusing to guess the active project identity."
        )
    }
    $schema = [string](Get-StateField -State $state -Name 'schemaVersion')
    if ($schema -notin @('clue-browser-session/1', 'clue-browser-session/2')) {
        Write-Result -Status 'error' -ExitCode 5 -Message (
            "Unsupported dedicated browser state schema: $schema"
        )
    }
    return $state
}

function Get-CanonicalUriText {
    param([object] $Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try { return ([System.Uri]::new([string]$Value)).AbsoluteUri }
    catch { return [string]$Value }
}

function Get-CanonicalOriginText {
    param([object] $Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try {
        return ([System.Uri]::new([string]$Value)).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
    }
    catch { return [string]$Value }
}

function Assert-StateBinding {
    param(
        [object] $State,
        [Parameter(Mandatory)] [string] $Context,
        [Parameter(Mandatory)] [string] $ResolvedProfile,
        [Parameter(Mandatory)] [int] $EndpointPort,
        [Parameter(Mandatory)] [object[]] $Processes,
        [string] $Target,
        [switch] $VerifyTarget
    )

    if ($null -eq $State) {
        Write-Result -Status 'error' -ExitCode 5 -Message (
            "${Context}: the browser is not bound by a readable CLU-E state file. Refusing to guess identity."
        )
    }

    $mismatches = @()
    $schema = [string](Get-StateField -State $State -Name 'schemaVersion')
    if (-not [string]::IsNullOrWhiteSpace($ProjectId) -and $schema -ne 'clue-browser-session/2') {
        $mismatches += 'schemaVersion'
    }

    $actualProfileRaw = [string](Get-StateField -State $State -Name 'profile')
    try { $actualProfile = [System.IO.Path]::GetFullPath($actualProfileRaw).TrimEnd('\') }
    catch { $actualProfile = $actualProfileRaw }
    if (-not $actualProfile.Equals($ResolvedProfile, [StringComparison]::OrdinalIgnoreCase)) {
        $mismatches += 'profile'
    }

    $actualPort = [int](Get-StateField -State $State -Name 'port')
    if ($actualPort -ne $EndpointPort) { $mismatches += 'port' }

    $statePid = [int](Get-StateField -State $State -Name 'pid')
    $processIds = @($Processes | ForEach-Object { [int]$_.ProcessId })
    if ($statePid -le 0 -or $statePid -notin $processIds) { $mismatches += 'pid' }

    if (-not [string]::IsNullOrWhiteSpace($ProjectId)) {
        $actual = @{
            projectId          = [string](Get-StateField -State $State -Name 'projectId')
            targetRootIdentity = [string](Get-StateField -State $State -Name 'targetRootIdentity')
            projectProfileHash = [string](Get-StateField -State $State -Name 'projectProfileHash')
            profileGeneration  = [int](Get-StateField -State $State -Name 'profileGeneration')
        }
        $expected = @{
            projectId          = $ProjectId
            targetRootIdentity = $TargetRootIdentity
            projectProfileHash = $ProjectProfileHash
            profileGeneration  = $ProfileGeneration
        }
        foreach ($field in @('projectId', 'targetRootIdentity', 'projectProfileHash', 'profileGeneration')) {
            if ([string]$actual[$field] -cne [string]$expected[$field]) { $mismatches += $field }
        }
    }

    if ($VerifyTarget) {
        $actualUrl = Get-CanonicalUriText -Value (Get-StateField -State $State -Name 'url')
        $expectedUrl = Get-CanonicalUriText -Value $Target
        if ($actualUrl -cne $expectedUrl) { $mismatches += 'url' }

        if (-not [string]::IsNullOrWhiteSpace($AllowedOrigin)) {
            $actualOrigin = Get-CanonicalOriginText -Value (Get-StateField -State $State -Name 'allowedOrigin')
            $expectedOrigin = Get-CanonicalOriginText -Value $AllowedOrigin
            if ($actualOrigin -cne $expectedOrigin) { $mismatches += 'allowedOrigin' }
        }
    }

    if ($mismatches.Count -gt 0) {
        Write-Result -Status 'error' -ExitCode 5 -Message (
            "${Context}: dedicated browser binding mismatch in $($mismatches -join ', '). Close the dedicated test window and reopen it for the saved profile."
        ) -Data @{
            expectedProjectId  = $ProjectId
            actualProjectId    = Get-StateField -State $State -Name 'projectId'
            expectedGeneration = if ($ProfileGeneration -gt 0) { $ProfileGeneration } else { $null }
            actualGeneration   = Get-StateField -State $State -Name 'profileGeneration'
            expectedPort       = $EndpointPort
            actualPort         = $actualPort
            statePid           = $statePid
        }
    }
}

function State-ResultData {
    param([object] $State)
    return @{
        projectId          = Get-StateField -State $State -Name 'projectId'
        targetRootIdentity = Get-StateField -State $State -Name 'targetRootIdentity'
        profileHash        = Get-StateField -State $State -Name 'projectProfileHash'
        generation         = Get-StateField -State $State -Name 'profileGeneration'
        allowedOrigin      = Get-StateField -State $State -Name 'allowedOrigin'
        targetUrl          = Get-StateField -State $State -Name 'url'
        statePid           = Get-StateField -State $State -Name 'pid'
        headless           = Get-StateField -State $State -Name 'headless'
        stateSchema        = Get-StateField -State $State -Name 'schemaVersion'
    }
}

function Write-StateFile {
    param(
        [Parameter(Mandatory)] [string] $ResolvedProfile,
        [Parameter(Mandatory)] [int] $ProcessId,
        [Parameter(Mandatory)] [int] $EndpointPort,
        [Parameter(Mandatory)] [string] $Target
    )

    $state = @{
        schemaVersion      = 'clue-browser-session/2'
        pid                = $ProcessId
        port               = $EndpointPort
        url                = $Target
        allowedOrigin      = $AllowedOrigin
        profile            = $ResolvedProfile
        projectId          = $ProjectId
        targetRootIdentity = $TargetRootIdentity
        projectProfileHash = $ProjectProfileHash
        profileGeneration  = if ($ProfileGeneration -gt 0) { $ProfileGeneration } else { $null }
        debugEndpoint       = "127.0.0.1:$EndpointPort"
        executable          = [System.IO.Path]::GetFullPath($Executable)
        headless            = [bool]$Headless
        startedAt           = (Get-Date).ToUniversalTime().ToString('o')
        startedBy           = 'launch-test-browser.ps1'
    }
    $path = Join-Path $ResolvedProfile $StateFileName
    $temp = "$path.tmp.$PID"
    try {
        $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temp -Encoding utf8
        Move-Item -LiteralPath $temp -Destination $path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

Assert-ProjectIdentityParameters
$resolvedProfile = Assert-ProfileIsSafe -Path $ProfileDir

if ($Status) {
    $processes = @(Get-ClueBrowserProcess -ResolvedProfile $resolvedProfile)
    $version = Test-DevToolsEndpoint -EndpointPort $Port
    $state = Read-StateFile -ResolvedProfile $resolvedProfile

    if ($processes.Count -eq 0 -and $null -eq $version) {
        Write-Result -Status 'info' -Message 'No CLUE browser is running.' -ExitCode 1 -Data @{
            profile = $resolvedProfile
            port    = $Port
        }
    }


    if ($processes.Count -eq 0 -and $null -ne $version) {
        Write-Result -Status 'error' -ExitCode 5 -Message (
            'The debugging endpoint answers, but no browser process is bound to the requested dedicated profile. Refusing to adopt an unrelated endpoint.'
        ) -Data @{
            profile = $resolvedProfile
            port    = $Port
            browser = $version.Browser
        }
    }
    if ($null -eq $version) {
        # A process without an endpoint is worse than none: something is holding the
        # profile lock while nothing can attach to it.
        Write-Result -Status 'warn' -ExitCode 1 -Message (
            'A browser is running on this profile but the debugging endpoint does not answer.'
        ) -Data @{
            profile     = $resolvedProfile
            port        = $Port
            processes   = $processes.Count
            firstPid    = $processes[0].ProcessId
        }
    }

    Assert-StateBinding -State $state -Context 'Status' -ResolvedProfile $resolvedProfile -EndpointPort $Port -Processes $processes
    Assert-DebuggerProcessBinding -State $state -EndpointPort $Port
    $data = State-ResultData -State $state
    $data.listenerVerified = $true
    $data.profile = $resolvedProfile
    $data.port = $Port
    $data.processes = $processes.Count
    $data.browser = $version.Browser
    $data.protocol = $version.'Protocol-Version'
    $data.webSocketUrl = $version.webSocketDebuggerUrl
    Write-Result -Status 'ok' -Message 'CLUE browser is running and the endpoint answers.' -Data $data
}

if ($Kill) {
    $processes = @(Get-ClueBrowserProcess -ResolvedProfile $resolvedProfile)
    if ($processes.Count -eq 0) {
        Write-Result -Status 'info' -Message 'Nothing to stop; no browser is using this profile.' -Data @{
            profile = $resolvedProfile
        }
    }

    $state = Read-StateFile -ResolvedProfile $resolvedProfile
    Assert-StateBinding -State $state -Context 'Stop' -ResolvedProfile $resolvedProfile -EndpointPort $Port -Processes $processes
    $stopped = 0
    foreach ($process in $processes) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            $stopped++
        }
        catch {
            Write-Verbose "Could not stop PID $($process.ProcessId): $_"
        }
    }

    $statePath = Join-Path $resolvedProfile $StateFileName
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }

    Write-Result -Status 'ok' -Message "Stopped $stopped process(es) using this profile." -Data @{
        profile = $resolvedProfile
        matched = $processes.Count
        stopped = $stopped
    }
}

# --- Launch ---------------------------------------------------------------

Assert-AllowedOrigin -Target $Url

if (-not (Test-Path -LiteralPath $Executable)) {
    Write-Result -Status 'error' -ExitCode 2 -Message "Chrome executable not found: $Executable"
}

$running = @(Get-ClueBrowserProcess -ResolvedProfile $resolvedProfile)
$existingVersion = Test-DevToolsEndpoint -EndpointPort $Port
if ($running.Count -eq 0 -and $null -ne $existingVersion) {
    Write-Result -Status 'error' -ExitCode 5 -Message (
        'The requested debugging port already belongs to a process outside the dedicated profile. Refusing to attach or claim it.'
    ) -Data @{ profile = $resolvedProfile; port = $Port }
}
if ($running.Count -gt 0) {
    if ($null -ne $existingVersion) {
        $state = Read-StateFile -ResolvedProfile $resolvedProfile
        Assert-StateBinding -State $state -Context 'Reuse' -ResolvedProfile $resolvedProfile -EndpointPort $Port -Processes $running -Target $Url -VerifyTarget
        Assert-DebuggerProcessBinding -State $state -EndpointPort $Port
        $data = State-ResultData -State $state
        $data.listenerVerified = $true
        $data.profile = $resolvedProfile
        $data.port = $Port
        $data.browser = $existingVersion.Browser
        $data.webSocketUrl = $existingVersion.webSocketDebuggerUrl
        Write-Result -Status 'ok' -Message 'Already running; reusing the exact governed instance.' -Data $data
    }
    Write-Result -Status 'error' -ExitCode 3 -Message (
        'A browser already holds this profile but its debugging endpoint does not answer. ' +
        'Stop it with -Kill before launching again.'
    ) -Data @{ profile = $resolvedProfile; port = $Port }
}

if (-not (Test-Path -LiteralPath $resolvedProfile)) {
    New-Item -ItemType Directory -Path $resolvedProfile -Force | Out-Null
}

$arguments = @(
    "--remote-debugging-port=$Port"
    # Bound to loopback explicitly. An unauthenticated debugging port must never be
    # reachable from another machine.
    '--remote-debugging-address=127.0.0.1'
    "--user-data-dir=$resolvedProfile"

    # Measurement fidelity. Chrome throttles timers in unfocused and occluded windows,
    # so without these a frame-time reading taken while the window sits behind an editor
    # measures the throttling rather than the application.
    '--disable-background-timer-throttling'
    '--disable-backgrounding-occluded-windows'
    '--disable-renderer-backgrounding'
    '--disable-ipc-flooding-protection'

    # A measurement profile that asks questions or restores tabs is a scenario that
    # blocks on a modal nobody is there to dismiss.
    '--no-first-run'
    '--no-default-browser-check'
    '--disable-session-crashed-bubble'
    '--hide-crash-restore-bubble'
    '--disable-extensions'
    '--disable-component-update'
    '--no-service-autorun'
    '--disable-features=Translate,MediaRouter,OptimizationHints'
)

if ($Headless) {
    # Recorded in the state file, because a baseline taken headless is not comparable to
    # a patched run taken windowed.
    $arguments += '--headless=new'
}

$arguments += $Url

Write-Verbose "Launching: $Executable $($arguments -join ' ')"

try {
    $start = [System.Diagnostics.ProcessStartInfo]::new($Executable)
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    $process.StandardInput.Close()
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
}
catch {
    Write-Result -Status 'error' -ExitCode 2 -Message "Could not start Chrome: $_"
}

# Verified, not assumed. The endpoint is polled until it answers or the timeout expires,
# and the exit code says which happened.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$version = $null
while ((Get-Date) -lt $deadline) {
    $candidateVersion = Test-DevToolsEndpoint -EndpointPort $Port -TimeoutSec 2
    if ($null -ne $candidateVersion -and (Test-DebuggerProcessBinding -EndpointPort $Port -ExpectedPid $process.Id -ExpectVisible (-not [bool]$Headless))) {
        $version = $candidateVersion
        break
    }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 400
}

if ($null -eq $version) {
    Write-Result -Status 'error' -ExitCode 4 -Message (
        "Chrome started as PID $($process.Id) but a dedicated loopback debugger owned by that process could not be verified. " +
        "Close the dedicated window and check for a port conflict before retrying."
    ) -Data @{ profile = $resolvedProfile; port = $Port; pid = $process.Id }
}

Write-StateFile -ResolvedProfile $resolvedProfile -ProcessId $process.Id -EndpointPort $Port -Target $Url

Write-Result -Status 'ok' -Message 'Dedicated browser running and reachable.' -Data @{
    projectId          = $ProjectId
    targetRootIdentity = $TargetRootIdentity
    profileHash        = $ProjectProfileHash
    generation         = if ($ProfileGeneration -gt 0) { $ProfileGeneration } else { $null }
    listenerVerified   = $true
    statePid           = $process.Id
    targetUrl          = $Url
    pid          = $process.Id
    profile      = $resolvedProfile
    port         = $Port
    url          = $Url
    headless     = [bool] $Headless
    browser      = $version.Browser
    protocol     = $version.'Protocol-Version'
    webSocketUrl = $version.webSocketDebuggerUrl
}
