[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $EvidenceRoot,
    [Parameter(Mandatory)][string] $SupervisorPath,
    [Parameter(Mandatory)][string] $SupervisorSha256,
    [Parameter(Mandatory)][string] $AdmissionReportPath,
    [Parameter(Mandatory)][string] $AdmissionReportSha256,
    [Parameter(Mandatory)][string] $QualificationReportPath,
    [Parameter(Mandatory)][string] $QualificationReportSha256,
    [Parameter(Mandatory)][int] $ProductionRegistrationPid,
    [Parameter(Mandatory)][int] $ExpectedOperatorPid,
    [Parameter(Mandatory)][string] $BundleOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'WindowsSandboxPeerCommon.ps1')

function Assert-LocalFolder([string] $Path) {
    if ($Path -cnotmatch '\A[A-Za-z]:\\[^\\]' -or $Path -cne [IO.Path]::GetFullPath($Path)) {
        throw 'WSB_LOCAL_FOLDER_REQUIRED'
    }
    $root = [IO.Path]::GetPathRoot($Path)
    $drive = [IO.DriveInfo]::new($root)
    if (!$drive.IsReady -or $drive.DriveType -notin @('Fixed', 'Removable')) { throw 'WSB_LOCAL_FOLDER_REQUIRED' }
    $current = $root
    foreach ($part in $Path.Substring($root.Length).Split('\')) {
        if ($part -match '[. ]$|[<>:"|?*%\x00-\x1f]|~[0-9]+(?:\.|$)') { throw 'WSB_LOCAL_FOLDER_REQUIRED' }
        $current = Join-Path $current $part
        $folder = Get-Item -LiteralPath $current -Force
        if (!$folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'WSB_LOCAL_FOLDER_REQUIRED'
        }
    }
}

function Open-FaultPinnedFile([string] $Path, [string] $Expected, [long] $MaxBytes) {
    if ($Path -cne [IO.Path]::GetFullPath($Path) -or $Expected -cnotmatch '\A[a-f0-9]{64}\z') {
        throw 'WSB_PRODUCTION_INPUT_UNVERIFIED'
    }
    Assert-LocalFolder ([IO.Path]::GetDirectoryName($Path))
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'WSB_PRODUCTION_INPUT_UNVERIFIED'
    }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) { throw 'WSB_PRODUCTION_INPUT_UNVERIFIED' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($actual -cne $Expected) { throw 'WSB_PRODUCTION_INPUT_UNVERIFIED' }
        $stream.Position = 0
        return $stream
    } catch {
        $stream.Dispose()
        throw
    }
}

function Read-FaultPinnedJson([IO.Stream] $Stream) {
    $reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false, $true), $false, 4096, $true)
    try { return ConvertFrom-Json -InputObject ($reader.ReadToEnd()) -AsHashtable -Depth 30 }
    finally { $reader.Dispose() }
}

function Start-PeerCommand([string] $File, [string[]] $Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $File
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw 'WSB_COMMAND_START_FAILED' }
    return [ordered]@{
        process = $process
        stdout = $process.StandardOutput.ReadToEndAsync()
        stderr = $process.StandardError.ReadToEndAsync()
    }
}

function Complete-PeerCommand($Command, [int] $TimeoutMs) {
    $process = $Command.process
    try {
        if (!$process.WaitForExit($TimeoutMs)) {
            try { $process.Kill() } catch { }
            return [ordered]@{ exitCode = $null; failure = 'COMMAND_TIMEOUT'; text = '' }
        }
        $streams = [Threading.Tasks.Task[]] @($Command.stdout, $Command.stderr)
        if (![Threading.Tasks.Task]::WaitAll($streams, 2000)) {
            return [ordered]@{ exitCode = $null; failure = 'COMMAND_STREAM_DRAIN_TIMEOUT'; text = '' }
        }
        $stdout = $Command.stdout.GetAwaiter().GetResult()
        $stderr = $Command.stderr.GetAwaiter().GetResult()
        if ($stdout.Length -gt 16384 -or $stderr.Length -gt 16384) {
            return [ordered]@{ exitCode = $null; failure = 'COMMAND_OUTPUT_LIMIT'; text = '' }
        }
        return [ordered]@{ exitCode = $process.ExitCode; failure = $null; text = $stdout.Trim() }
    } finally { $process.Dispose() }
}

function Get-WsbInventory([string] $Cli) {
    $command = Complete-PeerCommand (Start-PeerCommand $Cli @('list', '--raw')) 6000
    if ($command.exitCode -ne 0) { throw 'WSB_INVENTORY_UNVERIFIED' }
    $data = ConvertFrom-Json -InputObject $command.text -AsHashtable -Depth 8
    $environments = $data['WindowsSandboxEnvironments']
    if ($environments -isnot [Array] -or $environments.Count -gt 128) { throw 'WSB_INVENTORY_UNVERIFIED' }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $environments) {
        $id = $item['Id']
        if ($id -isnot [string] -or $id -notmatch '\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z' -or !$ids.Add($id)) {
            throw 'WSB_INVENTORY_UNVERIFIED'
        }
    }
    return $ids
}

function Get-WsbStartId([string] $Text) {
    if ($Text -match '\A(?:Windows Sandbox environment started successfully:\r?\n)?Id:[ \t]+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\z') {
        return $Matches[1].ToLowerInvariant()
    }
    try {
        $data = ConvertFrom-Json -InputObject $Text -AsHashtable -Depth 8
        $id = $data['Id']
        if (!$id -and $data['WindowsSandboxEnvironment']) { $id = $data['WindowsSandboxEnvironment']['Id'] }
        if ($id -is [string] -and $id -match '\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z') {
            return $id.ToLowerInvariant()
        }
    } catch { }
    return $null
}

function Get-PeerConfiguration([string] $InputPath, [string] $OutputPath) {
    $inputXml = [Security.SecurityElement]::Escape($InputPath)
    $outputXml = [Security.SecurityElement]::Escape($OutputPath)
    return @"
<Configuration><vGPU>Disable</vGPU><Networking>Enable</Networking><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection><MappedFolders><MappedFolder><HostFolder>$inputXml</HostFolder><SandboxFolder>C:\CLU-E-Peer\Input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>$outputXml</HostFolder><SandboxFolder>C:\CLU-E-Peer\Output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\CLU-E-Peer\Input\WindowsSandboxPeer.ps1</Command></LogonCommand></Configuration>
"@
}

function Read-ExpectedGuest([string] $Path, [string] $Schema, [string] $Nonce, [string] $SandboxId) {
    try {
        if (![IO.File]::Exists($Path)) { return $null }
        $receipt = Read-PeerJson $Path
        if ($receipt.schemaVersion -ceq $Schema -and $receipt.nonce -ceq $Nonce -and $receipt.sandboxId -ceq $SandboxId) {
            return $receipt
        }
    } catch { }
    return $null
}

function Test-PeerPort($Port) {
    return ($Port -is [int] -or $Port -is [long]) -and $Port -ge 1 -and $Port -le 65535
}

function Get-PeerFailure($Exception) {
    for ($depth = 0; $null -ne $Exception.InnerException -and $depth -lt 5; $depth++) {
        $Exception = $Exception.InnerException
    }
    $kind = $Exception.GetType().Name
    if ($kind -cnotmatch '\A[A-Za-z][A-Za-z0-9]{1,63}\z') { $kind = 'UnclassifiedException' }
    return [ordered]@{ kind = $kind; hresult = [int] $Exception.HResult }
}

function Test-OnSubnet([string] $A, [string] $B, [int] $Prefix) {
    if ($Prefix -lt 8 -or $Prefix -gt 30) { return $false }
    $first = [Net.IPAddress]::Parse($A).GetAddressBytes()
    $second = [Net.IPAddress]::Parse($B).GetAddressBytes()
    for ($i = 0; $i -lt $Prefix; $i++) {
        $bit = 7 - ($i % 8)
        $byte = [int] [Math]::Floor($i / 8)
        if ((($first[$byte] -shr $bit) -band 1) -ne (($second[$byte] -shr $bit) -band 1)) { return $false }
    }
    return $true
}

function Copy-GuestIdentity($Identity) {
    foreach ($name in @('machineSha256', 'accountSha256', 'sessionSha256')) {
        if ($Identity.$name -isnot [string] -or $Identity.$name -cnotmatch '\A[0-9a-f]{64}\z') {
            throw 'WSB_GUEST_IDENTITY_UNVERIFIED'
        }
    }
    if ($Identity.bootUtcTicks -isnot [string] -or $Identity.bootUtcTicks -cnotmatch '\A[0-9]{15,19}\z' -or
        ($Identity.sessionId -isnot [int] -and $Identity.sessionId -isnot [long]) -or
        $Identity.sessionId -lt 1 -or $Identity.sessionId -gt [int]::MaxValue -or
        ![object]::Equals($Identity.sandboxAccount, $true)) { throw 'WSB_GUEST_IDENTITY_UNVERIFIED' }
    return [ordered]@{
        machineSha256 = $Identity.machineSha256
        accountSha256 = $Identity.accountSha256
        bootUtcTicks = $Identity.bootUtcTicks
        sessionId = $Identity.sessionId
        sessionSha256 = $Identity.sessionSha256
        sandboxAccount = $true
    }
}

function Copy-GuestLane($Lane, [bool] $IsDial) {
    if ($null -eq $Lane) { return $null }
    if ($Lane.state -cnotin @('NONCE_MATCHED', 'NONCE_UNVERIFIED', 'NO_CONNECTION_OBSERVED', 'NOT_CONNECTED', 'ENDPOINT_UNVERIFIED')) {
        throw 'WSB_GUEST_RESULT_UNVERIFIED'
    }
    $code = $Lane.error
    if ($null -ne $code -and $code -cnotin @('AccessDenied', 'TimedOut', 'ConnectionRefused', 'ConnectionReset',
            'HostUnreachable', 'NetworkUnreachable', 'AddressNotAvailable', 'NetworkDown',
            'CONNECT_DEADLINE', 'SOCKET_ERROR', 'SOCKET_OR_FRAME_ERROR')) { throw 'WSB_GUEST_RESULT_UNVERIFIED' }
    $local = if (Test-PrivatePeerAddress $Lane.localAddress) { $Lane.localAddress } else { $null }
    $remote = if (Test-PrivatePeerAddress $Lane.remoteAddress) { $Lane.remoteAddress } else { $null }
    $port = if ($IsDial) { $Lane.remotePort } else { $Lane.localPort }
    if (!(Test-PeerPort $port)) { $port = $null }
    return [ordered]@{ state = $Lane.state; error = $code; localAddress = $local; remoteAddress = $remote; port = $port }
}

function Clear-PeerStage([string] $Path) {
    Assert-LocalFolder $Path
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Path)
    $entries = 0
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
            if ((++$entries -gt 32) -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
        }
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
    return !(Test-Path -LiteralPath $Path)
}

$stage = $null
$stageOwned = $false
$cli = $null
$start = $null
$attempted = $false
$observedId = $false
$connect = $null
$listener = $null
$hostEndpoint = $null
$reportPath = $null
$pins = [Collections.Generic.List[IO.Stream]]::new()
$report = [ordered]@{
    schemaVersion = 'clue-windows-production-network-fault/1'
    checkedAt = $null
    state = 'WSB_PREFLIGHT_UNVERIFIED'
    proofAuthorization = $false
    qualificationPromotion = $false
    productionExecution = 'NOT_RUN'
    peerType = 'SAME_PC_WINDOWS_SANDBOX_VIRTUAL_SWITCH'
    offHostLan = 'NOT_TESTED'
    hostFirewallModified = $false
    externalNetworkProbe = 'NOT_RUN'
    preflight = $null
    sandbox = [ordered]@{ id = $null; inventory = 'UNVERIFIED'; startExitCode = $null; startFailure = $null;
        returnedId = $null; connectAttempted = $false; connectExitCode = $null; cleanup = 'NOT_REQUIRED' }
    guestHeartbeatObserved = $false
    guestState = $null
    identity = [ordered]@{ host = $null; guest = $null; machineDistinct = $false; accountDistinct = $false;
        bootDistinct = $false; sessionDistinct = $false; numericSessionIdsEqual = $null }
    network = [ordered]@{ hostVirtualAdapterVerified = $false; addressesDistinct = $false;
        hostAddress = $null; guestAddress = $null; hostPort = $null; guestPort = $null }
    requestPublication = [ordered]@{ state = 'NOT_ATTEMPTED'; failure = $null }
    reverseControl = [ordered]@{ binding = 'NOT_ATTEMPTED'; endpoint = $null; bindingFailure = $null;
        eligibility = 'NOT_EVALUATED'; accept = 'NOT_ATTEMPTED'; acceptFailure = $null; guestResult = 'NOT_MEASURED' }
    guestFirewall = [ordered]@{ state = 'NOT_MEASURED'; cleanup = 'NOT_MEASURED' }
    hostToGuest = [ordered]@{ host = $null; guest = $null; verified = $false }
    guestToHost = [ordered]@{ host = $null; guest = $null; verified = $false }
    inputs = [ordered]@{ admissionPath = $AdmissionReportPath; admissionSha256 = $AdmissionReportSha256;
        qualificationPath = $QualificationReportPath; qualificationSha256 = $QualificationReportSha256;
        supervisorPath = $SupervisorPath; supervisorSha256 = $SupervisorSha256;
        productionRegistrationPid = $ProductionRegistrationPid; expectedOperatorPid = $ExpectedOperatorPid }
    peerFaultControls = $null
    faultDriver = $null
    faultDriverExitCode = $null
    faultDriverFailure = $null
    failure = $null
    stageCleanup = 'NOT_REQUIRED'
}

try {
    if (!$IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::UserInteractive) {
        throw 'WSB_INTERACTIVE_WINDOWS_REQUIRED'
    }
    Assert-LocalFolder $EvidenceRoot
    for ($folder = [IO.DirectoryInfo]::new($EvidenceRoot); $null -ne $folder; $folder = $folder.Parent) {
        if (Test-Path -LiteralPath (Join-Path $folder.FullName '.git')) { throw 'WSB_EXTERNAL_EVIDENCE_REQUIRED' }
    }
    if ([IO.Path]::GetDirectoryName($BundleOutput) -cne $EvidenceRoot -or
        [IO.Path]::GetFileName($BundleOutput) -cnotmatch '\ACLU-E_WINDOWS_PRODUCTION_NETWORK_FAULT_[0-9]{8}-[0-9]{6}-[0-9]{3}-[a-f0-9]{32}\.json\z' -or
        (Test-Path -LiteralPath $BundleOutput)) { throw 'WSB_EXTERNAL_EVIDENCE_REQUIRED' }
    $reportPath = $BundleOutput
    $nonceId = [Guid]::NewGuid().ToString('N')

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'WSB_STANDARD_SESSION_REQUIRED'
        }
    } finally { $identity.Dispose() }
    $report.identity.host = Get-PeerIdentity
    if ($report.identity.host.sandboxAccount) { throw 'WSB_PHYSICAL_HOST_SESSION_REQUIRED' }

    $report.state = 'WSB_PRODUCTION_INPUT_UNVERIFIED'
    foreach ($path in @($AdmissionReportPath, $QualificationReportPath)) {
        if ([IO.Path]::GetDirectoryName($path) -cne $EvidenceRoot -or
            [IO.Path]::GetExtension($path) -cne '.json') { throw 'WSB_PRODUCTION_INPUT_UNVERIFIED' }
    }
    $admissionPin = Open-FaultPinnedFile $AdmissionReportPath $AdmissionReportSha256 1MB
    $pins.Add($admissionPin)
    $admission = Read-FaultPinnedJson $admissionPin
    $qualificationPin = Open-FaultPinnedFile $QualificationReportPath $QualificationReportSha256 1MB
    $pins.Add($qualificationPin)
    $qualification = Read-FaultPinnedJson $qualificationPin
    if ($admission['schemaVersion'] -cne 'clue-windows-production-admission/1' -or
        $admission['state'] -cne 'PRODUCTION_ADMISSION_OBSERVED' -or
        ![object]::Equals($admission['proofAuthorization'], $false) -or
        ![object]::Equals($admission['productionNetworkFaultDiagnostic'], $true) -or
        $admission['supervisorSha256'] -cne $SupervisorSha256 -or
        $admission['installation']['wrapperPath'] -cne $SupervisorPath -or
        ![object]::Equals($admission['installation']['verifiedBefore'], $true) -or
        ![object]::Equals($admission['installation']['verifiedAfter'], $true) -or
        $qualification['schemaVersion'] -cne 'clue-console-probe-native-supervisor/1' -or
        $qualification['canaryStatus'] -cne 'PASS' -or $qualification['status'] -cne 'MEASUREMENT_PENDING' -or
        ![object]::Equals($qualification['fixtureRemoved'], $true) -or
        $qualification['supervisorSha256'] -cne $SupervisorSha256 -or
        $qualification['supervisorPathSha256'] -cne (Get-PeerHash $SupervisorPath)) {
        throw 'WSB_PRODUCTION_INPUT_UNVERIFIED'
    }
    foreach ($case in @('allowed-command', 'filesystem-denied', 'secrets-denied', 'network-denied',
            'descendant-timeout', 'launcher-cancellation', 'tamper-refused')) {
        if ($qualification['cases'][$case] -cne 'PASS') { throw 'WSB_PRODUCTION_INPUT_UNVERIFIED' }
    }
    $parent = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -Property ParentProcessId -OperationTimeoutSec 5
    $registration = Get-Process -Id $ProductionRegistrationPid -ErrorAction Stop
    try {
        if ($ExpectedOperatorPid -lt 1 -or $ProductionRegistrationPid -lt 1 -or
            $ExpectedOperatorPid -eq $ProductionRegistrationPid -or $parent.ParentProcessId -ne $ExpectedOperatorPid -or
            $admission['installation']['operatorPid'] -ne $ExpectedOperatorPid -or
            $admission['installation']['guardianPid'] -ne $ProductionRegistrationPid -or
            $registration.HasExited -or $registration.SessionId -ne $report.identity.host.sessionId) {
            throw 'WSB_PRODUCTION_SESSION_UNVERIFIED'
        }
    } finally { $registration.Dispose() }
    $pins.Add((Open-FaultPinnedFile $SupervisorPath $SupervisorSha256 16MB))
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $pins.Add((Open-FaultPinnedFile $node $qualification['host']['nodeSha256'] 256MB))
    if ($admission['nodeSha256'] -cne $qualification['host']['nodeSha256']) { throw 'WSB_PRODUCTION_INPUT_UNVERIFIED' }
    $runner = Join-Path $PSScriptRoot 'RunProductionFault.mjs'
    $item = Get-Item -LiteralPath $runner -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt 131072) { throw 'WSB_PRODUCTION_DRIVER_UNAVAILABLE' }
    $pins.Add([IO.File]::Open($runner, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))

    $preflightScript = Join-Path $PSScriptRoot 'WindowsSandboxHostPreflight.ps1'
    $winPs = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $check = Complete-PeerCommand (Start-PeerCommand $winPs @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $preflightScript)) 20000
    if ($check.exitCode -ne 0) { throw 'WSB_HOST_PREFLIGHT_UNAVAILABLE' }
    $capability = ConvertFrom-Json -InputObject $check.text -AsHashtable -Depth 6
    $report.preflight = [ordered]@{
        edition = $capability['edition']
        feature = $capability['feature']
        hypervisorPresent = $capability['hypervisorPresent']
        appVersion = $capability['appVersion']
        cliKind = $capability['cliKind']
    }
    if ($capability['feature'] -cne 'ENABLED') { throw 'WSB_FEATURE_NOT_ENABLED' }
    if (!$capability['cliPath'] -or $capability['cliKind'] -cnotin @('PACKAGE_ALIAS', 'USER_ALIAS', 'SYSTEM32')) {
        throw 'WSB_CLI_UNAVAILABLE'
    }
    $cli = $capability['cliPath']
    $initial = @(Get-WsbInventory $cli)
    if ($initial.Count -ne 0) {
        $report.sandbox.inventory = 'EXISTING_SESSION'
        throw 'WSB_EXISTING_SESSION'
    }
    $report.sandbox.inventory = 'CLEAR'

    $report.state = 'WSB_STAGE_UNVERIFIED'
    $stage = Join-Path $EvidenceRoot ".clue-wsb-peer-$nonceId"
    if (Test-Path -LiteralPath $stage) { throw 'WSB_STAGE_COLLISION' }
    $null = New-Item -ItemType Directory -Path $stage
    $stageOwned = $true
    $inputPath = Join-Path $stage 'input'
    $outputPath = Join-Path $stage 'output'
    $null = New-Item -ItemType Directory -Path $inputPath
    $null = New-Item -ItemType Directory -Path $outputPath
    Assert-LocalFolder $inputPath
    Assert-LocalFolder $outputPath
    foreach ($name in @('WindowsSandboxPeer.ps1', 'WindowsSandboxPeerCommon.ps1')) {
        $source = Get-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Force
        if ($source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $source.Length -lt 1 -or $source.Length -gt 65536) { throw 'WSB_PEER_SOURCE_UNVERIFIED' }
        [IO.File]::Copy($source.FullName, (Join-Path $inputPath $name), $false)
    }
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $nonceBytes = [byte[]]::new(32)
    $probeBytes = [byte[]]::new(32)
    try {
        $rng.GetBytes($nonceBytes)
        $rng.GetBytes($probeBytes)
    } finally { $rng.Dispose() }
    $nonce = [BitConverter]::ToString($nonceBytes).Replace('-', '').ToLowerInvariant()
    $probeNonce = [BitConverter]::ToString($probeBytes).Replace('-', '').ToLowerInvariant()
    if ($probeNonce -ceq $nonce) { throw 'WSB_REQUEST_NONCE_UNVERIFIED' }
    $id = [Guid]::NewGuid().ToString('D')
    $report.sandbox.id = $id
    # Resolve the optional reverse listener before exposing any folder to Sandbox.
    $report.reverseControl.binding = 'DEFAULT_SWITCH_ADAPTER_UNVERIFIED'
    try {
        $defaultSwitch = @(Get-NetAdapter -Name 'vEthernet (Default Switch)' -IncludeHidden -ErrorAction SilentlyContinue)
        if ($defaultSwitch.Count -eq 1 -and $defaultSwitch[0].Status -eq 'Up' -and
            $defaultSwitch[0].HardwareInterface -eq $false -and
            $defaultSwitch[0].InterfaceDescription -like '*Hyper-V*Virtual*Ethernet*') {
            $report.reverseControl.binding = 'DEFAULT_SWITCH_ADDRESS_UNVERIFIED'
            $bindAddresses = @(Get-NetIPAddress -InterfaceIndex $defaultSwitch[0].InterfaceIndex -AddressFamily IPv4 |
                Where-Object { $_.AddressState -eq 'Preferred' -and (Test-PrivatePeerAddress $_.IPAddress) })
            if ($bindAddresses.Count -eq 1) {
                $report.reverseControl.binding = 'BIND_FAILED'
                $bindAddress = $bindAddresses[0].IPAddress
                $listener = New-PeerListener $bindAddress
                $hostEndpoint = [ordered]@{ address = $bindAddress; port = $listener.LocalEndpoint.Port }
                $report.reverseControl.endpoint = $hostEndpoint
                $report.reverseControl.binding = 'PREBOUND'
            }
        }
    } catch { $report.reverseControl.bindingFailure = Get-PeerFailure $_.Exception }
    $report.state = 'WSB_REQUEST_PUBLICATION_UNVERIFIED'
    try {
        Write-PeerJson (Join-Path $inputPath 'request.json') ([ordered]@{
            schemaVersion = 'clue-windows-sandbox-peer-request/3'; nonce = $nonce; sandboxId = $id; probeNonce = $probeNonce
            hostEndpoint = $hostEndpoint
        })
        $report.requestPublication.state = 'PUBLISHED_BEFORE_LAUNCH'
    } catch {
        $report.requestPublication.state = 'WRITE_FAILED'
        $report.requestPublication.failure = Get-PeerFailure $_.Exception
        throw 'WSB_REQUEST_PUBLICATION_UNVERIFIED'
    }
    $configuration = Get-PeerConfiguration $inputPath $outputPath
    $report.state = 'WSB_START_FAILED'
    $attempted = $true
    Write-Host 'Starting a new disposable Windows Sandbox peer. Leave its window open until the report is saved.'
    $start = Complete-PeerCommand (Start-PeerCommand $cli @('start', '--id', $id, '--config', $configuration, '--raw')) 65000
    $report.sandbox.startExitCode = $start.exitCode
    $report.sandbox.startFailure = $start.failure
    $returned = Get-WsbStartId $start.text
    $report.sandbox.returnedId = if ($null -eq $returned) { 'UNRECOGNIZED' } elseif ($returned -ceq $id) { 'MATCHED' } else { 'DIFFERENT' }
    if ($start.exitCode -ne 0) { throw 'WSB_START_FAILED' }

    $report.state = 'WSB_SESSION_IDENTITY_UNVERIFIED'
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $active = @(Get-WsbInventory $cli)
        if ($active.Count -ne 0) { break }
        Start-Sleep -Milliseconds 350
    }
    $observedId = $active -contains $id
    if (!$observedId -or $active.Count -ne 1 -or $report.sandbox.returnedId -ceq 'DIFFERENT') {
        throw 'WSB_SESSION_IDENTITY_UNVERIFIED'
    }
    $connect = Start-PeerCommand $cli @('connect', '--id', $id)
    $report.sandbox.connectAttempted = $true

    $report.state = 'WSB_GUEST_BOOTSTRAP_UNVERIFIED'
    $heartbeatPath = Join-Path $outputPath 'heartbeat.json'
    $readyPath = Join-Path $outputPath 'peer-ready.json'
    $liveReadyPath = Join-Path $outputPath 'peer-live-ready.json'
    $guestResultPath = Join-Path $outputPath 'peer-result.json'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $ready = $null
    do {
        $heartbeat = Read-ExpectedGuest $heartbeatPath 'clue-windows-sandbox-peer-heartbeat/1' $nonce $id
        $report.guestHeartbeatObserved = $null -ne $heartbeat
        $ready = Read-ExpectedGuest $readyPath 'clue-windows-sandbox-peer-ready/1' $nonce $id
        $guestEarly = Read-ExpectedGuest $guestResultPath 'clue-windows-sandbox-peer-result/1' $nonce $id
        if ($null -ne $ready -or $null -ne $guestEarly) { break }
        Start-Sleep -Milliseconds 150
    } while ($watch.ElapsedMilliseconds -lt 75000)
    if ($null -eq $ready -or !$report.guestHeartbeatObserved) {
        if ($null -ne $guestEarly -and $guestEarly.state -cin @('PEER_REQUEST_UNVERIFIED',
                'PEER_IDENTITY_UNVERIFIED', 'PEER_IPV4_ROUTE_UNVERIFIED', 'PEER_LISTENER_UNAVAILABLE', 'PEER_HOST_ENDPOINT_UNVERIFIED')) {
            $report.guestState = $guestEarly.state
        }
        if ($report.guestHeartbeatObserved) { throw 'WSB_GUEST_ENDPOINT_UNVERIFIED' }
        throw 'WSB_GUEST_BOOTSTRAP_UNVERIFIED'
    }

    $report.state = 'WSB_GUEST_IDENTITY_UNVERIFIED'
    $guestIdentity = Copy-GuestIdentity $ready.identity
    $report.identity.guest = $guestIdentity
    $report.identity.machineDistinct = $guestIdentity.machineSha256 -cne $report.identity.host.machineSha256
    $report.identity.accountDistinct = $guestIdentity.accountSha256 -cne $report.identity.host.accountSha256
    $report.identity.bootDistinct = $guestIdentity.bootUtcTicks -cne $report.identity.host.bootUtcTicks
    $report.identity.sessionDistinct = $guestIdentity.sessionSha256 -cne $report.identity.host.sessionSha256
    $report.identity.numericSessionIdsEqual = $guestIdentity.sessionId -eq $report.identity.host.sessionId
    if (!$report.identity.machineDistinct -or !$report.identity.accountDistinct -or
        !$report.identity.bootDistinct -or !$report.identity.sessionDistinct) { throw 'WSB_GUEST_IDENTITY_UNVERIFIED' }

    $report.state = 'WSB_VIRTUAL_ENDPOINT_UNVERIFIED'
    $hostAddress = $ready.hostAddress
    $guestAddress = $ready.guestAddress
    $guestPort = $ready.guestPort
    if (!(Test-PrivatePeerAddress $hostAddress) -or !(Test-PrivatePeerAddress $guestAddress) -or
        $hostAddress -ceq $guestAddress -or !(Test-PeerPort $guestPort)) { throw 'WSB_VIRTUAL_ENDPOINT_UNVERIFIED' }
    $hostIps = @(Get-NetIPAddress -IPAddress $hostAddress -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred')
    if ($hostIps.Count -ne 1 -or !(Test-OnSubnet $hostAddress $guestAddress $hostIps[0].PrefixLength)) {
        throw 'WSB_HOST_VIRTUAL_ADAPTER_UNVERIFIED'
    }
    $adapter = Get-NetAdapter -InterfaceIndex $hostIps[0].InterfaceIndex -IncludeHidden
    if ($adapter.InterfaceDescription -notlike '*Hyper-V*Virtual*Ethernet*' -or $adapter.HardwareInterface -ne $false) {
        throw 'WSB_HOST_VIRTUAL_ADAPTER_UNVERIFIED'
    }
    $report.network.hostVirtualAdapterVerified = $true
    $report.network.addressesDistinct = $true
    $report.network.hostAddress = $hostAddress
    $report.network.guestAddress = $guestAddress
    $report.network.guestPort = $guestPort
    if ($ready.guestFirewall -cin @('SCOPED_RULE_ADDED', 'RULE_UNAVAILABLE')) {
        $report.guestFirewall.state = $ready.guestFirewall
    }

    $report.state = 'WSB_GUEST_RESULT_UNVERIFIED'
    $hostPort = $null
    $reverseEligible = $false
    $readyReverse = $ready.PSObject.Properties['reverseControl']
    $readyPort = $ready.PSObject.Properties['hostPort']
    if ($null -eq $hostEndpoint) { $report.reverseControl.eligibility = 'NOT_REQUESTED' }
    elseif ($hostEndpoint.address -cne $hostAddress) { $report.reverseControl.eligibility = 'HOST_ENDPOINT_MISMATCH' }
    elseif ($null -eq $readyReverse -or $readyReverse.Value -cne 'ATTEMPTED' -or
        $null -eq $readyPort -or $readyPort.Value -ne $hostEndpoint.port) {
        $report.reverseControl.eligibility = 'GUEST_READY_MISMATCH'
    } else {
        $report.reverseControl.eligibility = 'VERIFIED'
        $hostPort = $hostEndpoint.port
        $report.network.hostPort = $hostPort
        $reverseEligible = $true
    }
    $report.hostToGuest.host = Invoke-PeerDial $hostAddress $guestAddress $guestPort $nonce 'HOST'
    if ($reverseEligible) {
        $report.reverseControl.accept = 'ACCEPT_FAILED'
        try {
            $report.guestToHost.host = Invoke-PeerAccept $listener $hostAddress $guestAddress $hostPort $nonce 'GUEST' 20000
            $report.reverseControl.accept = $report.guestToHost.host.state
        } catch { $report.reverseControl.acceptFailure = Get-PeerFailure $_.Exception }
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $liveReady = Read-ExpectedGuest $liveReadyPath 'clue-windows-sandbox-peer-live-ready/1' $nonce $id
        $guestEarly = Read-ExpectedGuest $guestResultPath 'clue-windows-sandbox-peer-result/1' $nonce $id
        if ($null -ne $liveReady -or $null -ne $guestEarly) { break }
        Start-Sleep -Milliseconds 100
    } while ($watch.ElapsedMilliseconds -lt 12000)
    if ($null -eq $liveReady -or $liveReady.sessionSha256 -cne $guestIdentity.sessionSha256) {
        if ($null -ne $guestEarly -and $guestEarly.state -cin @('PEER_TCP_CONTROLS_INCOMPLETE', 'PEER_LIVE_CONTROL_INCOMPLETE')) {
            $report.guestState = $guestEarly.state
        }
        throw 'WSB_PEER_LIVE_READY_UNVERIFIED'
    }
    $report.guestState = 'PEER_LIVE_READY'
    $guestAccept = Copy-GuestLane $liveReady.hostToGuest $false
    $report.hostToGuest.guest = $guestAccept
    $report.hostToGuest.verified = $report.hostToGuest.host.state -ceq 'NONCE_MATCHED' -and
        $null -ne $guestAccept -and $guestAccept.state -ceq 'NONCE_MATCHED' -and
        $guestAccept.localAddress -ceq $guestAddress -and $guestAccept.remoteAddress -ceq $hostAddress -and $guestAccept.port -eq $guestPort
    $guestDial = Copy-GuestLane $liveReady.guestToHost $true
    $report.guestToHost.guest = $guestDial
    if ($null -ne $guestDial) { $report.reverseControl.guestResult = 'ATTEMPTED' }
    $report.guestToHost.verified = $reverseEligible -and $null -ne $report.guestToHost.host -and
        $report.guestToHost.host.state -ceq 'NONCE_MATCHED' -and
        $null -ne $guestDial -and $guestDial.state -ceq 'NONCE_MATCHED' -and
        $guestDial.localAddress -ceq $guestAddress -and $guestDial.remoteAddress -ceq $hostAddress -and $guestDial.port -eq $hostPort
    if (!$report.hostToGuest.verified -or !$report.guestToHost.verified) { throw 'WSB_PEER_TCP_CONTROLS_UNVERIFIED' }

    $report.state = 'WSB_PRODUCTION_DRIVER_UNVERIFIED'
    $driverPath = Join-Path $stage 'fault-driver.json'
    $driverArgs = @($runner, '--peer', $guestAddress, '--peer-port', ([string] $guestPort), '--control-nonce', $nonce,
        '--probe-nonce', $probeNonce, '--supervisor', $SupervisorPath, '--supervisor-sha', $SupervisorSha256, '--output', $driverPath)
    Write-Host 'Peer controls passed. Exercising the exact Windows supervisor under the production network fault.'
    $driver = Complete-PeerCommand (Start-PeerCommand $node $driverArgs) 100000
    $report.productionExecution = 'FAULT_DRIVER_EXECUTED'
    $report.faultDriverExitCode = $driver.exitCode
    $report.faultDriverFailure = $driver.failure
    if (![IO.File]::Exists($driverPath)) { throw 'WSB_PRODUCTION_DRIVER_UNVERIFIED' }
    $fault = Read-PeerJson $driverPath
    $faultText = $fault | ConvertTo-Json -Depth 24 -Compress
    if ($fault.schemaVersion -cne 'clue-windows-production-fault-driver/1' -or
        $fault.state -cnotin @('PRODUCTION_NETWORK_FAULT_OBSERVED', 'PRODUCTION_NETWORK_FAULT_UNVERIFIED') -or
        $fault.supervisorSha256 -cne $SupervisorSha256 -or
        $fault.scope -cne 'PRIMARY_OWNER_LOSS_HEALTHY_BFE_SAME_PC_VIRTUAL_IPV4_TCP' -or
        ![object]::Equals($fault.proofAuthorization, $false) -or $faultText.Length -gt 10000 -or
        $faultText.Contains($nonce) -or $faultText.Contains($probeNonce)) { throw 'WSB_PRODUCTION_DRIVER_UNVERIFIED' }
    $report.faultDriver = $fault

    $report.state = 'WSB_PEER_LIVE_RESULT_UNVERIFIED'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $guest = Read-ExpectedGuest $guestResultPath 'clue-windows-sandbox-peer-result/1' $nonce $id
        if ($null -ne $guest) { break }
        Start-Sleep -Milliseconds 100
    } while ($watch.ElapsedMilliseconds -lt 6000)
    if ($null -eq $guest -or $guest.state -cnotin @('PEER_LIVE_CONTROL_INCOMPLETE', 'PEER_LIVE_CONTROL_COMPLETED') -or
        $guest.identity.sessionSha256 -cne $guestIdentity.sessionSha256 -or
        $guest.guestAddress -cne $guestAddress -or $guest.hostAddress -cne $hostAddress -or
        $guest.guestPort -ne $guestPort -or $guest.hostPort -ne $hostPort) { throw 'WSB_PEER_LIVE_RESULT_UNVERIFIED' }
    $report.guestState = $guest.state
    if ($guest.guestFirewallCleanup -cin @('SCOPED_RULE_REMOVED', 'REMOVAL_UNVERIFIED', 'NOT_REQUIRED')) {
        $report.guestFirewall.cleanup = $guest.guestFirewallCleanup
    }
    $live = $guest.liveControl
    if ($null -eq $live -or $live.finishAck -isnot [bool] -or $live.controls -isnot [array] -or $live.controls.Count -gt 4 -or
        ($live.leakCount -isnot [int] -and $live.leakCount -isnot [long]) -or $live.leakCount -lt 0 -or
        $live.leakCount -gt [int]::MaxValue) { throw 'WSB_PEER_LIVE_RESULT_UNVERIFIED' }
    for ($index = 0; $index -lt $live.controls.Count; $index++) {
        $sample = $live.controls[$index]
        if (($sample -isnot [int] -and $sample -isnot [long]) -or $sample -ne ($index + 1)) {
            throw 'WSB_PEER_LIVE_RESULT_UNVERIFIED'
        }
    }
    $firstLeak = $live.firstLeakSequence
    if (($live.leakCount -eq 0 -and $null -ne $firstLeak) -or ($live.leakCount -gt 0 -and
        (($firstLeak -isnot [int] -and $firstLeak -isnot [long]) -or $firstLeak -lt 1 -or $firstLeak -gt 4))) {
        throw 'WSB_PEER_LIVE_RESULT_UNVERIFIED'
    }
    $report.peerFaultControls = [ordered]@{ controls = $live.controls; finishAck = $live.finishAck;
        leakCount = $live.leakCount; firstLeakSequence = $firstLeak }
    $report.state = if ($driver.exitCode -eq 0 -and $fault.state -ceq 'PRODUCTION_NETWORK_FAULT_OBSERVED' -and
        [object]::Equals($fault.peerFinishAck, $true) -and $guest.state -ceq 'PEER_LIVE_CONTROL_COMPLETED' -and
        $live.finishAck -and $live.controls.Count -eq 4 -and $live.leakCount -eq 0 -and
        $report.guestFirewall.state -ceq 'SCOPED_RULE_ADDED' -and $report.guestFirewall.cleanup -ceq 'SCOPED_RULE_REMOVED') {
        'PRODUCTION_NETWORK_FAULT_OBSERVED'
    } else {
        'PRODUCTION_NETWORK_FAULT_UNVERIFIED'
    }
} catch {
    $code = $_.Exception.Message
    if ($code -cmatch '\A(?:WSB|PEER)_[A-Z0-9_]{1,70}\z') { $report.state = $code }
    else { $report.failure = Get-PeerFailure $_.Exception }
} finally {
    if ($null -ne $listener) { $listener.Stop() }
    if ($attempted) {
        $report.sandbox.cleanup = 'UNVERIFIED'
        try {
            $remaining = @(Get-WsbInventory $cli)
            if ($remaining -contains $id) {
                $observedId = $true
                $null = Complete-PeerCommand (Start-PeerCommand $cli @('stop', '--id', $id)) 20000
                for ($attempt = 0; $attempt -lt 5; $attempt++) {
                    $remaining = @(Get-WsbInventory $cli)
                    if ($remaining -notcontains $id) { break }
                    Start-Sleep -Milliseconds 400
                }
            }
            if ($remaining -notcontains $id -and ($observedId -or ($null -ne $start -and $start.exitCode -eq 0))) {
                $report.sandbox.cleanup = 'EXACT_SESSION_ABSENT'
            } elseif ($remaining -notcontains $id -and $null -ne $start -and $null -ne $start.exitCode) {
                Start-Sleep -Milliseconds 700
                if (@(Get-WsbInventory $cli) -notcontains $id) { $report.sandbox.cleanup = 'NO_OWNED_SESSION_OBSERVED' }
            }
        } catch { }
        if ($report.sandbox.cleanup -ceq 'UNVERIFIED') { $report.state = 'WSB_SESSION_CLEANUP_UNVERIFIED' }
    }
    if ($null -ne $connect) {
        try { $report.sandbox.connectExitCode = (Complete-PeerCommand $connect 1500).exitCode }
        catch { }
    }
    if ($stageOwned) {
        $report.stageCleanup = 'RETAINED'
        if ($report.sandbox.cleanup -cne 'UNVERIFIED') {
            try { if (Clear-PeerStage $stage) { $report.stageCleanup = 'REMOVED' } } catch { }
        }
        if ($report.stageCleanup -ceq 'RETAINED') { Write-Host "Diagnostic stage retained: $stage" }
    }
    if ($report.state -ceq 'PRODUCTION_NETWORK_FAULT_OBSERVED' -and
        ($report.sandbox.cleanup -cne 'EXACT_SESSION_ABSENT' -or $report.stageCleanup -cne 'REMOVED')) {
        $report.state = 'WSB_STAGE_CLEANUP_UNVERIFIED'
    }
    foreach ($pin in $pins) { $pin.Dispose() }
}

$report.checkedAt = [DateTime]::UtcNow.ToString('o')
if ($null -eq $reportPath) {
    Write-Host "Windows production network fault $($report.state). Evidence directory unavailable."
    exit 2
}
try { Write-PeerJson $reportPath $report }
catch {
    Write-Host "Windows production network fault $($report.state). Could not save the report."
    exit 2
}
Write-Host "Windows production network fault $($report.state)"
Write-Host "Network fault report: $reportPath"
if ($report.state -ceq 'PRODUCTION_NETWORK_FAULT_OBSERVED' -and
    $report.sandbox.cleanup -ceq 'EXACT_SESSION_ABSENT' -and $report.stageCleanup -ceq 'REMOVED') { exit 0 }
exit 1
