function Invoke-WfpBfeGuardSetup([string] $ControllerPath, [string] $Stage) {
    $result = [ordered]@{
        state = 'BFE_GUARD_LAUNCH_UNAVAILABLE'
        controllerState = $null
        controllerError = $null
        controllerExitCode = $null
        controllerTimedOut = $false
        readyObserved = $false
        injectionWritten = $false
        identityVerified = $false
        jobEmpty = $false
        independentRemovalVerified = $false
        bfeGuard = $null
    }
    $private = [IO.Path]::Combine($Stage, 'bfe-guard', 'private')
    $ready = Join-Path $private 'bfe-ready.txt'
    $inject = Join-Path $private 'bfe-inject.txt'
    $receipt = Join-Path $private 'result.json'
    $process = $null
    $controllerExited = $false
    $deadlineMs = 30000

    try {
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $private
        foreach ($path in @($ready, $inject, $receipt)) {
            if (Test-Path -LiteralPath $path) { throw 'BFE_GUARD_STAGE_ALREADY_USED' }
        }

        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $ControllerPath
        $start.WorkingDirectory = $Stage
        $start.UseShellExecute = $false
        $start.ArgumentList.Add('bfe-guard')
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $process = [Diagnostics.Process]::Start($start)
        if ($null -eq $process) { throw 'BFE_GUARD_CONTROLLER_START_FAILED' }

        $result.state = 'BFE_GUARD_READY_UNAVAILABLE'
        while (!$process.HasExited -and $clock.ElapsedMilliseconds -lt 12000) {
            if ([IO.File]::Exists($ready)) {
                Assert-NoReparsePath $ready
                $marker = [IO.File]::Open($ready, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                try {
                    if ($marker.Length -ne 5) { throw 'BFE_GUARD_READY_INVALID' }
                    $bytes = [byte[]]::new(5)
                    if ($marker.Read($bytes, 0, $bytes.Length) -ne $bytes.Length -or
                        [Text.Encoding]::ASCII.GetString($bytes) -cne 'READY') { throw 'BFE_GUARD_READY_INVALID' }
                } finally { $marker.Dispose() }
                $result.readyObserved = $true
                break
            }
            Start-Sleep -Milliseconds 25
        }

        if ($result.readyObserved -and !$process.HasExited) {
            $result.state = 'BFE_GUARD_INJECTION_UNAVAILABLE'
            $temporary = Join-Path $private ('bfe-inject-' + [Guid]::NewGuid().ToString('N') + '.tmp')
            try {
                $marker = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try {
                    $bytes = [Text.Encoding]::ASCII.GetBytes('INJECT')
                    $marker.Write($bytes, 0, $bytes.Length)
                } finally { $marker.Dispose() }
                [IO.File]::Move($temporary, $inject)
                $result.injectionWritten = $true
            } finally {
                if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
            }
            $result.state = 'BFE_GUARD_RECEIPT_UNAVAILABLE'
        }
    } catch { }
    finally {
        if ($null -ne $process) {
            try {
                $remaining = [int] [Math]::Max(0, $deadlineMs - $clock.ElapsedMilliseconds)
                if (!$process.WaitForExit($remaining)) {
                    $result.controllerTimedOut = $true
                    # Terminate only the exact process started here. Native job lifetime handles its fixtures.
                    $process.Kill()
                }
                $controllerExited = $process.WaitForExit(2000)
                if ($controllerExited) { $result.controllerExitCode = $process.ExitCode }
            } catch { }
            finally { $process.Dispose() }
        }
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
                    'fixtureBindDenied', 'terminationVerified', 'policyRetainedAtCleanup')) {
                    $result.bfeGuard[$key] = if ($guard[$key] -is [bool]) { $guard[$key] } else { $null }
                }
            }
        } catch { }
    }

    $stageCleanupSafe = $null -eq $process -or ($controllerExited -and !$result.controllerTimedOut -and
        $result.jobEmpty -and $result.independentRemovalVerified)
    if ($result.controllerTimedOut) {
        $result.state = 'BFE_GUARD_CONTROLLER_TIMEOUT'
    } elseif ($null -ne $process -and !$controllerExited) {
        $result.state = 'BFE_GUARD_CONTROLLER_EXIT_UNVERIFIED'
    } elseif ($null -ne $result.controllerState) {
        $guard = $result.bfeGuard
        if ($result.controllerState -ceq 'BFE_GUARD_CANCELLATION_OBSERVED' -and $result.controllerExitCode -eq 125 -and
            $result.readyObserved -and $result.injectionWritten -and $result.identityVerified -and $stageCleanupSafe -and
            $null -ne $guard -and $guard.state -ceq 'BFE_PROCESS_CHANGED' -and $guard.samples -ge 2 -and
            $guard.initialRunning -eq $true -and $guard.syntheticFaultObserved -eq $true -and $guard.latched -eq $true -and
            $guard.gateReleased -eq $true -and $guard.fixtureBindDenied -eq $true -and $guard.terminationVerified -eq $true -and
            $guard.policyRetainedAtCleanup -eq $true) {
            $result.state = 'BFE_GUARD_CANCELLATION_OBSERVED'
        } else {
            $result.state = 'BFE_GUARD_EVIDENCE_UNVERIFIED'
        }
    }
    return [ordered]@{ result = $result; stageCleanupSafe = $stageCleanupSafe }
}
