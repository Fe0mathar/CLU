function Assert-WfpBfeLabEnvironment([string] $Confirmation) {
    if ($Confirmation -cne 'DISPOSABLE OFFLINE HYPER-V GUEST') {
        throw 'BFE_LAB_CONFIRMATION_REQUIRED'
    }

    try {
        $systems = @(Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop)
        $adapters = @(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetAdapter -ErrorAction Stop)
    } catch {
        throw 'BFE_LAB_ENVIRONMENT_UNVERIFIED'
    }

    if ($systems.Count -ne 1 -or
        $systems[0].Manufacturer -cne 'Microsoft Corporation' -or $systems[0].Model -cne 'Virtual Machine' -or
        $systems[0].HypervisorPresent -isnot [bool] -or !$systems[0].HypervisorPresent) {
        throw 'BFE_LAB_HYPER_V_GUEST_REQUIRED'
    }

    # The unfiltered CIM class includes hidden adapters. An offline guest can have none.
    foreach ($adapter in $adapters) {
        $status = $adapter.InterfaceOperationalStatus
        if ($status -eq 1) { throw 'BFE_LAB_NETWORK_ADAPTER_UP' }
        if ($null -eq $status -or $status -notin @(2, 6, 7)) {
            throw 'BFE_LAB_ADAPTER_STATE_UNVERIFIED'
        }
    }
}

function Invoke-WfpBfeLabSetup([string] $ControllerPath, [string] $Stage) {
    $result = [ordered]@{
        state = 'BFE_LAB_LAUNCH_UNAVAILABLE'
        controllerState = $null
        controllerError = $null
        controllerExitCode = $null
        controllerTimedOut = $false
        readyObserved = $false
        bfeStoppedObserved = $false
        bfeRecoveredObserved = $false
        serviceObservationFailed = $false
        identityVerified = $false
        jobEmpty = $false
        independentRemovalVerified = $false
        escapeObserved = $null
        bfeGuard = $null
    }
    $private = [IO.Path]::Combine($Stage, 'bfe-lab', 'private')
    $ready = Join-Path $private 'bfe-ready.txt'
    $recovered = Join-Path $private 'bfe-recovered.txt'
    $receipt = Join-Path $private 'result.json'
    $process = $null
    $service = $null
    $controllerExited = $false
    $deadlineMs = 120000

    try {
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $private
        foreach ($path in @($ready, $recovered, $receipt)) {
            if (Test-Path -LiteralPath $path) { throw 'BFE_LAB_STAGE_ALREADY_USED' }
        }

        $result.state = 'BFE_LAB_SERVICE_UNAVAILABLE'
        $service = Get-Service -Name 'BFE' -ErrorAction Stop
        $service.Refresh()
        if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
            $result.state = 'BFE_LAB_SERVICE_NOT_RUNNING_AT_START'
            throw $result.state
        }

        $result.state = 'BFE_LAB_LAUNCH_UNAVAILABLE'
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $ControllerPath
        $start.WorkingDirectory = $Stage
        $start.UseShellExecute = $false
        $start.ArgumentList.Add('bfe-lab')
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $process = [Diagnostics.Process]::Start($start)
        if ($null -eq $process) { throw 'BFE_LAB_CONTROLLER_START_FAILED' }

        $result.state = 'BFE_LAB_READY_UNAVAILABLE'
        while (!$process.HasExited -and $clock.ElapsedMilliseconds -lt 12000) {
            if ([IO.File]::Exists($ready)) {
                Assert-NoReparsePath $ready
                $marker = [IO.File]::Open($ready, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                try {
                    if ($marker.Length -ne 5) { throw 'BFE_LAB_READY_INVALID' }
                    foreach ($byte in [Text.Encoding]::ASCII.GetBytes('READY')) {
                        if ($marker.ReadByte() -ne $byte) { throw 'BFE_LAB_READY_INVALID' }
                    }
                } finally { $marker.Dispose() }
                $result.readyObserved = $true
                break
            }
            Start-Sleep -Milliseconds 25
        }

        if ($result.readyObserved -and !$process.HasExited) {
            $result.state = 'BFE_LAB_STOP_NOT_OBSERVED'
            Write-Host '[CLU-E BFE lab] READY. Use the prepared second administrator shell in this offline guest now.'
            Write-Host 'Wait for the stop to be observed here before restoring the guest services.'
            do {
                try {
                    $service.Refresh()
                    $status = $service.Status
                    if ($status -eq [System.ServiceProcess.ServiceControllerStatus]::Stopped -and !$result.bfeStoppedObserved) {
                        $result.bfeStoppedObserved = $true
                        $result.state = 'BFE_LAB_RECOVERY_NOT_OBSERVED'
                        Write-Host '[CLU-E BFE lab] STOPPED observed. Restore the guest services now.'
                    } elseif ($status -eq [System.ServiceProcess.ServiceControllerStatus]::Running -and
                        $result.bfeStoppedObserved -and !$result.bfeRecoveredObserved) {
                        $temporary = Join-Path $private ('bfe-recovered-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                        try {
                            $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                            try {
                                $bytes = [Text.Encoding]::ASCII.GetBytes('RECOVERED')
                                $file.Write($bytes, 0, $bytes.Length)
                            } finally { $file.Dispose() }
                            [IO.File]::Move($temporary, $recovered)
                        } finally {
                            if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
                        }
                        $result.bfeRecoveredObserved = $true
                        $result.state = 'BFE_LAB_RECEIPT_UNAVAILABLE'
                        Write-Host '[CLU-E BFE lab] RUNNING observed. Waiting for independent cleanup verification.'
                    }
                } catch {
                    $result.serviceObservationFailed = $true
                }
                if ($process.HasExited) { break }
                Start-Sleep -Milliseconds 25
            } while ($clock.ElapsedMilliseconds -lt $deadlineMs)
        }
    } catch { }
    finally {
        if ($null -ne $process) {
            try {
                $remaining = [int] [Math]::Max(0, $deadlineMs - $clock.ElapsedMilliseconds)
                if (!$process.WaitForExit($remaining)) {
                    $result.controllerTimedOut = $true
                    # Only the process started here is terminated. Its native Job owns the fixtures.
                    $process.Kill()
                }
                $controllerExited = $process.WaitForExit(2000)
                if ($controllerExited) { $result.controllerExitCode = $process.ExitCode }
            } catch { }
            finally { $process.Dispose() }
        }
        if ($null -ne $service) { $service.Dispose() }
    }

    if ($controllerExited) {
        try {
            $record = Read-WfpPairedRecord $receipt
            $result.controllerState = $record['state']
            if ($record['error'] -is [string] -and $record['error'] -cmatch '\A[A-Z][A-Z0-9_]{0,95}\z') {
                $result.controllerError = $record['error']
            }
            foreach ($key in @('identityVerified', 'jobEmpty', 'independentRemovalVerified')) {
                $result[$key] = $record[$key] -is [bool] -and $record[$key]
            }
            if ($record['escapeObserved'] -is [bool]) { $result.escapeObserved = $record['escapeObserved'] }

            $guard = $record['bfeGuard']
            if ($guard -is [System.Collections.IDictionary]) {
                $state = $null
                if ($guard['state'] -is [string] -and $guard['state'] -cmatch '\A[A-Z][A-Z0-9_]{0,95}\z') {
                    $state = $guard['state']
                }
                $samples = $null
                if (Test-WfpNativeNumber ($guard['samples'])) { $samples = $guard['samples'] }
                $result.bfeGuard = [ordered]@{ state = $state; samples = $samples }
                foreach ($key in @('initialRunning', 'syntheticFaultObserved', 'latched', 'gateReleased',
                    'fixtureBindDenied', 'terminationVerified', 'policyRetainedAtCleanup', 'cleanupVerifiedFresh')) {
                    $result.bfeGuard[$key] = if ($guard[$key] -is [bool]) { $guard[$key] } else { $null }
                }
            }
        } catch { }
    }

    $guard = $result.bfeGuard
    $stageCleanupSafe = $null -eq $process -or ($controllerExited -and !$result.controllerTimedOut -and
        $result.jobEmpty -and $result.independentRemovalVerified -and $null -ne $guard -and
        $guard.cleanupVerifiedFresh -eq $true -and $result.escapeObserved -eq $false)
    if ($result.escapeObserved -eq $true) {
        $result.state = 'BFE_LAB_ESCAPE_OBSERVED'
    } elseif ($result.controllerTimedOut) {
        $result.state = 'BFE_LAB_CONTROLLER_TIMEOUT'
    } elseif ($null -ne $process -and !$controllerExited) {
        $result.state = 'BFE_LAB_CONTROLLER_EXIT_UNVERIFIED'
    } elseif ($result.serviceObservationFailed) {
        $result.state = 'BFE_LAB_SERVICE_OBSERVATION_UNVERIFIED'
    } elseif ($result.readyObserved -and $result.bfeStoppedObserved -and $result.bfeRecoveredObserved -and
        $null -ne $result.controllerState) {
        if ($result.controllerState -ceq 'BFE_LAB_CANCELLATION_OBSERVED' -and $result.controllerExitCode -eq 125 -and
            $result.identityVerified -and $stageCleanupSafe -and $null -ne $guard -and $guard.samples -ge 2 -and
            $guard.state -cin @('BFE_NOT_RUNNING', 'BFE_STATUS_UNAVAILABLE', 'BFE_PROCESS_CHANGED', 'BFE_PROCESS_ID_UNAVAILABLE') -and
            $guard.initialRunning -eq $true -and $guard.syntheticFaultObserved -eq $false -and $guard.latched -eq $true -and
            $guard.gateReleased -eq $true -and $guard.fixtureBindDenied -eq $true -and $guard.terminationVerified -eq $true) {
            $result.state = 'BFE_LAB_CANCELLATION_OBSERVED'
        } else {
            $result.state = 'BFE_LAB_EVIDENCE_UNVERIFIED'
        }
    }
    return [ordered]@{ result = $result; stageCleanupSafe = $stageCleanupSafe }
}
