function Invoke-WfpPriorStageReconciliation([string] $ControllerPath, [string] $Stage, [string] $StageId) {
    $result = [ordered]@{
        stageId = $StageId
        state = 'WFP_PRIOR_DYNAMIC_STAGE_UNVERIFIED'
        controllerExitCode = $null
        error = 'WFP_PRIOR_RECONCILIATION_RECEIPT_UNAVAILABLE'
        jobAbsent = $false
        stagedProcessesAbsent = $false
        diagnosticSessionsAbsent = $false
        diagnosticSublayersAbsent = $false
        proofAuthorization = $false
    }
    if ($StageId -cnotmatch '\A\.clue-wfp-fault-setup-[0-9a-f]{32}\z') {
        throw 'WFP_PRIOR_RECONCILIATION_STAGE_ID_INVALID'
    }
    $checks = @('jobAbsent', 'stagedProcessesAbsent', 'diagnosticSessionsAbsent', 'diagnosticSublayersAbsent')
    $errorPattern = '\A(?:WFP_PRIOR_[A-Z_]{1,52}(?:_0x[0-9A-F]{8})?|BFE_[A-Z_]{1,40})\z'
    $private = [IO.Path]::Combine($Stage, 'enforcement-fault', 'private')
    $receipt = Join-Path $private "reconcile-$StageId.json"
    try {
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $private
        if (Test-Path -LiteralPath $receipt) { throw 'WFP_PRIOR_RECONCILIATION_RECEIPT_ALREADY_EXISTS' }
        $result.controllerExitCode = Invoke-ExactExecutable $ControllerPath @('enforcement-fault-reconcile', $StageId) $Stage 15
        $record = Read-WfpPairedRecord $receipt
        $result.error = 'WFP_PRIOR_RECONCILIATION_RECEIPT_INVALID'
        if ($record['stageId'] -isnot [string] -or $record['stageId'] -cne $StageId -or
            $record['proofAuthorization'] -isnot [bool] -or $record['proofAuthorization'] -or
            $record['state'] -cnotin @('WFP_PRIOR_DYNAMIC_STAGE_RECONCILED', 'WFP_PRIOR_DYNAMIC_STAGE_UNVERIFIED') -or
            !$record.Contains('error') -or ($null -ne $record['error'] -and
                ($record['error'] -isnot [string] -or $record['error'] -cnotmatch $errorPattern)) -or
            @($checks | Where-Object { $record[$_] -isnot [bool] }).Count -ne 0) {
            return $result
        }
        foreach ($key in $checks) { $result[$key] = $record[$key] }
        if ($result.controllerExitCode -eq 0 -and $record['state'] -ceq 'WFP_PRIOR_DYNAMIC_STAGE_RECONCILED' -and
            $null -eq $record['error'] -and @($checks | Where-Object { !$result[$_] }).Count -eq 0) {
            $result.state = 'WFP_PRIOR_DYNAMIC_STAGE_RECONCILED'
            $result.error = $null
        } elseif ($result.controllerExitCode -ne 0 -and $record['state'] -ceq 'WFP_PRIOR_DYNAMIC_STAGE_UNVERIFIED' -and
            $null -ne $record['error']) {
            $result.error = $record['error']
        }
    } catch { }
    return $result
}

function Invoke-WfpEnforcementFaultSetup([string] $ControllerPath, [string] $Stage) {
    $result = [ordered]@{
        state = 'WFP_ENFORCEMENT_FAULT_CONTROLLER_UNAVAILABLE'
        controllerState = $null
        controllerError = $null
        controllerExitCode = $null
        controllerTimedOut = $false
        engineExitCode = $null
        ownerExitCode = $null
        ownerProgress = $null
        ownerError = $null
        ownerNativeErrorCode = $null
        backupSublayerWeightExpected = $null
        ownerSublayerWeightExpected = $null
        backupSublayerWeightObserved = $null
        ownerSublayerWeightObserved = $null
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
            $nativeErrorPattern = '\A[A-Z][A-Z0-9_]{0,84}(?:_0x[0-9A-F]{8})?\z'
            if ($record['error'] -is [string] -and $record['error'] -cmatch $nativeErrorPattern) {
                $result.controllerError = $record['error']
            }
            if ($record['ownerError'] -is [string] -and $record['ownerError'] -cmatch $nativeErrorPattern) {
                $result.ownerError = $record['ownerError']
            }
            if ($record['ownerProgress'] -cin @('STARTUP', 'HANDOFF_READ', 'PARENT_IDENTITY', 'JOB_OPEN',
                'FIXTURE_IDENTITY', 'JOB_CLOSE', 'WFP_INSTALL', 'READY_PUBLISH', 'READY')) {
                $result.ownerProgress = $record['ownerProgress']
            }
            $ownerExitCode = $record['ownerExitCode']
            if (($ownerExitCode -is [int] -or $ownerExitCode -is [long]) -and
                $ownerExitCode -ge [int]::MinValue -and $ownerExitCode -le [int]::MaxValue) {
                $result.ownerExitCode = $ownerExitCode
            }
            $ownerNativeErrorCode = $record['ownerNativeErrorCode']
            if (($ownerNativeErrorCode -is [int] -or $ownerNativeErrorCode -is [long]) -and
                $ownerNativeErrorCode -ge 0 -and $ownerNativeErrorCode -le [uint32]::MaxValue) {
                $result.ownerNativeErrorCode = $ownerNativeErrorCode
            }
            foreach ($key in @('backupSublayerWeightExpected', 'ownerSublayerWeightExpected',
                'backupSublayerWeightObserved', 'ownerSublayerWeightObserved')) {
                $weight = $record[$key]
                if ((Test-WfpNativeNumber $weight) -and $weight -le [uint16]::MaxValue) {
                    $result[$key] = $weight
                }
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
        $weightsVerified = $result.backupSublayerWeightExpected -eq 65533 -and
            $result.ownerSublayerWeightExpected -eq 65534 -and
            $result.backupSublayerWeightObserved -eq 65533 -and $result.ownerSublayerWeightObserved -eq 65534
        if ($result.controllerState -ceq 'WFP_LEASE_OWNER_FAULT_OBSERVED' -and
            $result.controllerExitCode -eq 0 -and $result.engineExitCode -eq 0 -and $result.bfeSamples -ge 2 -and
            $result.ownerExitCode -eq 0xCE06 -and
            $stageCleanupSafe -and $checksPassed -and $weightsVerified -and $control -ceq '0,0,0,0' -and
            $armed -ceq '10013,10013,10013,10013' -and $fault -ceq '10013,10013,10013,10013') {
            $result.state = 'WFP_LEASE_OWNER_FAULT_OBSERVED'
        } else {
            $result.state = 'WFP_ENFORCEMENT_FAULT_EVIDENCE_UNVERIFIED'
        }
    }
    return [ordered]@{ result = $result; stageCleanupSafe = $stageCleanupSafe }
}
