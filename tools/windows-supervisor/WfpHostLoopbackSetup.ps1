function Read-WfpHostLoopbackText([string] $Path, [int] $MaximumBytes) {
    Assert-NoReparsePath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes) { throw 'HOST_NET_RECORD_SIZE_INVALID' }
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true))
        try { return $reader.ReadToEnd() }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Read-WfpHostLoopbackError([string] $Path) {
    if (![IO.File]::Exists($Path)) { return $null }
    $code = Read-WfpHostLoopbackText $Path 64
    $match = [regex]::Match($code, '\A(?:PHASE_TIMEOUT|LISTENER_ERROR_([1-9][0-9]{0,4})|FIXTURE_REFUSED)(?:\r?\n)?\z')
    if (!$match.Success -or ($match.Groups[1].Success -and [int] $match.Groups[1].Value -gt 65535)) {
        throw 'HOST_NET_ERROR_CODE_INVALID'
    }
    return $code.TrimEnd([char[]] @("`r", "`n"))
}

function Read-WfpHostLoopbackRecord([string] $Path) {
    $record = (Read-WfpHostLoopbackText $Path 4096) | ConvertFrom-Json -AsHashtable -Depth 6
    if ($record -isnot [System.Collections.IDictionary] -or $record.Count -ne 4) {
        throw 'HOST_NET_RECORD_SHAPE_INVALID'
    }
    foreach ($field in @('ports', 'localControl', 'outbound', 'inbound')) {
        if ($record[$field] -isnot [array] -or $record[$field].Count -ne 4) {
            throw 'HOST_NET_RECORD_LANES_INVALID'
        }
    }
    for ($index = 0; $index -lt 4; $index++) {
        $port = $record['ports'][$index]
        $outcome = $record['outbound'][$index]
        if (!(Test-WfpNativeNumber $port) -or $port -lt 1 -or $port -gt 65535 -or
            $record['localControl'][$index] -isnot [bool] -or $record['inbound'][$index] -isnot [bool] -or
            $outcome -isnot [string] -or
            $outcome -cnotin @('DELIVERED', 'ACCESS_DENIED', 'CONNECTION_REFUSED', 'CONNECTION_RESET', 'TIMED_OUT', 'UNVERIFIED')) {
            throw 'HOST_NET_RECORD_LANE_INVALID'
        }
    }
    return $record
}

function Start-WfpHostLoopbackProcess([string] $Path, [string] $WorkingDirectory, [string[]] $Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Path
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    return [Diagnostics.Process]::Start($start)
}

function Get-WfpHostLoopbackLane([string] $SocketOutcome, [bool] $PeerReceived, [bool] $HostControl) {
    $state = if ($PeerReceived -or $SocketOutcome -ceq 'DELIVERED') { 'DELIVERY_OBSERVED' }
        elseif ($HostControl -and $SocketOutcome -cin @('ACCESS_DENIED', 'CONNECTION_REFUSED', 'CONNECTION_RESET', 'TIMED_OUT')) { 'NO_DELIVERY_OBSERVED' }
        else { 'UNVERIFIED' }
    return [ordered]@{ state = $state; socketOutcome = $SocketOutcome; peerReceived = $PeerReceived }
}

function Invoke-WfpHostLoopbackSetup([string] $ControllerPath, [string] $Stage, [string] $FixturePath) {
    $result = [ordered]@{
        state = 'HOST_NET_LAUNCH_UNAVAILABLE'
        hostExitCode = $null
        hostError = $null
        sandboxError = $null
        controllerExitCode = $null
        controllerState = $null
        controllerError = $null
        controllerEngineExitCode = $null
        controllerIdentityVerified = $false
        controllerJobEmpty = $false
        timedOut = $false
        lanes = $null
    }
    $workspace = [IO.Path]::Combine($Stage, 'host-net', 'workspace')
    $private = [IO.Path]::Combine($Stage, 'host-net', 'private')
    $hostProcess = $null
    $controllerProcess = $null
    $fixtureLock = $null
    $hostExited = $false
    $controllerExited = $false

    try {
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $FixturePath
        Assert-NoReparsePath $workspace -CreateDirectory
        Assert-NoReparsePath $private -CreateDirectory

        $fixtureLock = [IO.File]::Open($FixturePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $hostProcess = Start-WfpHostLoopbackProcess $FixturePath $Stage @('host-net-host', $workspace)
        if ($null -eq $hostProcess) { throw 'HOST_NET_HOST_START_FAILED' }
        $controllerProcess = Start-WfpHostLoopbackProcess $ControllerPath $Stage @('host-net')
        if ($null -eq $controllerProcess) { throw 'HOST_NET_CONTROLLER_START_FAILED' }

        $result.state = 'HOST_NET_EXIT_UNVERIFIED'
        $controllerExited = $controllerProcess.WaitForExit([int] [Math]::Max(0, 23000 - $clock.ElapsedMilliseconds))
        $hostExited = $hostProcess.WaitForExit([int] [Math]::Max(0, 23000 - $clock.ElapsedMilliseconds))
        $result.timedOut = !$controllerExited -or !$hostExited
        if ($result.timedOut) { $result.state = 'HOST_NET_TIMEOUT' }
    } catch { }
    finally {
        if ($null -ne $controllerProcess) {
            try {
                if (!$controllerProcess.HasExited) { $controllerProcess.Kill() }
                $controllerExited = $controllerProcess.WaitForExit(1000)
                if ($controllerExited) { $result.controllerExitCode = $controllerProcess.ExitCode }
            } catch { }
            finally { $controllerProcess.Dispose() }
        }
        if ($null -ne $hostProcess) {
            try {
                if (!$hostProcess.HasExited) { $hostProcess.Kill() }
                $hostExited = $hostProcess.WaitForExit(1000)
                if ($hostExited) { $result.hostExitCode = $hostProcess.ExitCode }
            } catch { }
            finally { $hostProcess.Dispose() }
        }
        if ($null -ne $fixtureLock) { $fixtureLock.Dispose() }
    }

    if ($hostExited) {
        try { $result.hostError = Read-WfpHostLoopbackError ([IO.Path]::Combine($private, 'host-net-host-error.txt')) }
        catch { }
    }
    if ($controllerExited) {
        try { $result.sandboxError = Read-WfpHostLoopbackError ([IO.Path]::Combine($workspace, 'host-net-error.txt')) }
        catch { }
        try {
            $native = Read-WfpPairedRecord ([IO.Path]::Combine($private, 'result.json'))
            $result.controllerState = $native['state']
            if ($native['error'] -is [string] -and $native['error'] -cmatch '\A[A-Z][A-Z0-9_]{0,95}\z') {
                $result.controllerError = $native['error']
            }
            if (Test-WfpNativeNumber ($native['engineExitCode'])) { $result.controllerEngineExitCode = $native['engineExitCode'] }
            $result.controllerIdentityVerified = $native['identityVerified'] -is [bool] -and $native['identityVerified']
            $result.controllerJobEmpty = $native['jobEmpty'] -is [bool] -and $native['jobEmpty']
        } catch { }
    }

    $stageCleanupSafe = ($null -eq $hostProcess -or $hostExited) -and
        ($null -eq $controllerProcess -or ($controllerExited -and $result.controllerJobEmpty))
    if (!$result.timedOut -and $null -ne $controllerProcess -and $null -ne $hostProcess) {
        if (!$stageCleanupSafe) {
            $result.state = 'HOST_NET_CLEANUP_UNVERIFIED'
        } elseif ($result.hostExitCode -ne 0 -or $result.controllerExitCode -ne 0 -or
            $result.controllerEngineExitCode -ne 0 -or !$result.controllerIdentityVerified -or
            $result.controllerState -cne 'HOST_LOOPBACK_FIXTURE_COMPLETED') {
            $result.state = 'HOST_NET_PROCESS_FAILED'
        } else {
            $result.state = 'HOST_NET_RECORD_UNVERIFIED'
            try {
                $hostRecord = Read-WfpHostLoopbackRecord ([IO.Path]::Combine($private, 'host-net-host-result.json'))
                $sandboxRecord = Read-WfpHostLoopbackRecord ([IO.Path]::Combine($workspace, 'host-net-result.json'))
                $lanes = [ordered]@{}
                $laneNames = @('ipv4Tcp', 'ipv6Tcp', 'ipv4Udp', 'ipv6Udp')
                $delivery = $false
                $unverified = $false
                for ($index = 0; $index -lt $laneNames.Count; $index++) {
                    $control = $hostRecord['localControl'][$index]
                    $hostToSandbox = Get-WfpHostLoopbackLane ($hostRecord['outbound'][$index]) ($sandboxRecord['inbound'][$index]) $control
                    $sandboxToHost = Get-WfpHostLoopbackLane ($sandboxRecord['outbound'][$index]) ($hostRecord['inbound'][$index]) $control
                    $lanes[$laneNames[$index]] = [ordered]@{
                        hostControlPassed = $control
                        sandboxLocalControlPassed = $sandboxRecord['localControl'][$index]
                        hostToSandbox = $hostToSandbox
                        sandboxToHost = $sandboxToHost
                    }
                    $delivery = $delivery -or $hostToSandbox.state -ceq 'DELIVERY_OBSERVED' -or $sandboxToHost.state -ceq 'DELIVERY_OBSERVED'
                    $unverified = $unverified -or $hostToSandbox.state -ceq 'UNVERIFIED' -or $sandboxToHost.state -ceq 'UNVERIFIED'
                }
                $result.lanes = $lanes
                $result.state = if ($delivery) { 'HOST_LOOPBACK_DELIVERY_OBSERVED' }
                    elseif ($unverified) { 'HOST_LOOPBACK_ISOLATION_UNVERIFIED' }
                    else { 'HOST_LOOPBACK_ISOLATION_OBSERVED' }
            } catch { }
        }
    }
    return [ordered]@{ result = $result; stageCleanupSafe = $stageCleanupSafe }
}
