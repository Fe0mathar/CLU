function Invoke-WfpEnforcementFaultSetup([string] $ControllerPath, [string] $Stage) {
    $result = [ordered]@{
        state = 'WFP_ENFORCEMENT_FAULT_CONTROLLER_UNAVAILABLE'
        controllerState = $null
        controllerError = $null
        controllerExitCode = $null
        controllerTimedOut = $false
        engineExitCode = $null
        bfeSamples = $null
        phaseBinds = [ordered]@{ control = $null; armed = $null; fault = $null }
    }
    $checks = @('identityVerified', 'ownerStarted', 'ownerTerminationRequested', 'ownerExited', 'bothLeasesPresentBeforeFault',
        'dynamicAbsenceVerified', 'backupPresentDuringFault', 'fixtureLiveDuringFault',
        'faultPhaseReleased', 'faultPhaseCompleted', 'bfeHealthy', 'jobEmpty', 'jobAbsent',
        'backupRemovalVerified', 'ownerRemovalVerified', 'stageCleanupSafe')
    foreach ($key in $checks) { $result[$key] = $false }
    $private = [IO.Path]::Combine($Stage, 'enforcement-fault', 'private')
    $launch = Join-Path $private 'fault-launch.txt'
    $receipt = Join-Path $private 'result.json'
    $process = $null
    $controllerExited = $false
    $launchRequested = $false

    try {
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $private
        if ((Test-Path -LiteralPath $launch) -or (Test-Path -LiteralPath $receipt)) {
            throw 'WFP_ENFORCEMENT_FAULT_STAGE_ALREADY_USED'
        }
        $marker = [IO.File]::Open($launch, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::ASCII.GetBytes('CLU-E-WFP-FAULT-1')
            $marker.Write($bytes, 0, $bytes.Length)
            $marker.Flush($true)
        } finally { $marker.Dispose() }

        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $ControllerPath
        $start.WorkingDirectory = $Stage
        $start.UseShellExecute = $false
        $start.ArgumentList.Add('enforcement-fault')
        $launchRequested = $true
        $process = [Diagnostics.Process]::Start($start)
        if ($null -eq $process) { throw 'WFP_ENFORCEMENT_FAULT_CONTROLLER_START_FAILED' }
        $result.state = 'WFP_ENFORCEMENT_FAULT_RECEIPT_UNAVAILABLE'
        if (!$process.WaitForExit(60000)) {
            $result.controllerTimedOut = $true
            # The native controller owns the Job and its disposable lease owner. Do not kill by PID or tree.
            $process.Kill()
        }
        $controllerExited = $process.WaitForExit(2000)
        if ($controllerExited) { $result.controllerExitCode = $process.ExitCode }
    } catch { }
    finally { if ($null -ne $process) { $process.Dispose() } }

    if ($controllerExited -and !$result.controllerTimedOut) {
        try {
            $record = Read-WfpPairedRecord $receipt
            if ($record['proofAuthorization'] -isnot [bool] -or $record['proofAuthorization']) {
                throw 'WFP_ENFORCEMENT_FAULT_RECEIPT_AUTHORITY_INVALID'
            }
            $result.controllerState = $record['state']
            if ($record['error'] -is [string] -and $record['error'] -cmatch '\A[A-Z][A-Z0-9_]{0,95}\z') {
                $result.controllerError = $record['error']
            }
            foreach ($key in $checks) { $result[$key] = $record[$key] -is [bool] -and $record[$key] }
            foreach ($key in @('engineExitCode', 'bfeSamples')) {
                if (Test-WfpNativeNumber ($record[$key])) { $result[$key] = $record[$key] }
            }
            $phaseBinds = $record['phaseBinds']
            if ($phaseBinds -is [System.Collections.IDictionary]) {
                foreach ($phase in @('control', 'armed', 'fault')) {
                    $codes = $phaseBinds[$phase]
                    if ($codes -is [array] -and $codes.Count -eq 4 -and
                        @($codes | Where-Object { !(Test-WfpNativeNumber $_) }).Count -eq 0) {
                        $result.phaseBinds[$phase] = @($codes)
                    }
                }
            }
        } catch { }
    }

    $stageCleanupSafe = !$launchRequested -or ($controllerExited -and !$result.controllerTimedOut -and
        $result.stageCleanupSafe -and $result.jobAbsent)
    if ($result.controllerTimedOut) {
        $result.state = 'WFP_ENFORCEMENT_FAULT_CONTROLLER_TIMEOUT'
    } elseif ($launchRequested -and !$controllerExited) {
        $result.state = 'WFP_ENFORCEMENT_FAULT_CONTROLLER_EXIT_UNVERIFIED'
    } elseif ($null -ne $result.controllerState) {
        $control = $result.phaseBinds.control -join ','
        $armed = $result.phaseBinds.armed -join ','
        $fault = $result.phaseBinds.fault -join ','
        $checksPassed = @($checks | Where-Object { !$result[$_] }).Count -eq 0
        if ($result.controllerState -ceq 'WFP_LEASE_OWNER_FAULT_OBSERVED' -and
            $result.controllerExitCode -eq 0 -and $result.engineExitCode -eq 0 -and $result.bfeSamples -ge 2 -and
            $stageCleanupSafe -and $checksPassed -and $control -ceq '0,0,0,0' -and
            $armed -ceq '10013,10013,10013,10013' -and $fault -ceq '10013,10013,10013,10013') {
            $result.state = 'WFP_LEASE_OWNER_FAULT_OBSERVED'
        } else {
            $result.state = 'WFP_ENFORCEMENT_FAULT_EVIDENCE_UNVERIFIED'
        }
    }
    return [ordered]@{ result = $result; stageCleanupSafe = $stageCleanupSafe }
}
