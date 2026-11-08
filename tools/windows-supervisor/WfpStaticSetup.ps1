function Invoke-WfpStaticSetup([string] $ControllerPath, [string] $Stage, [string] $FixturePath, [switch] $DoubleLoss) {
    $result = [ordered]@{
        state = 'STATIC_COORDINATOR_UNAVAILABLE'
        observerState = $null
        coordinatorExitCode = $null
        coordinatorTimedOut = $false
        terminationRequested = $null
        supervisorLive = $null
        guardianExited = $null
        fixtureTreeExited = $null
        jobMembersExited = $null
        jobMembersObserved = $null
        staticProtectionRetained = $null
        recoveryAcknowledgementWritten = $null
        recoveryExitCode = $null
        filtersRemoved = $null
        escapeDetected = $null
        samples = $null
        observerError = $null
        recoveryState = $null
        jobAbsent = $false
        recoveryVerified = $false
        naturalCleanupVerified = $false
        recoveryIntentPresent = $null
    }
    $observerFlags = @('terminationRequested', 'supervisorLive', 'guardianExited', 'fixtureTreeExited',
        'jobMembersExited', 'staticProtectionRetained', 'recoveryAcknowledgementWritten', 'filtersRemoved',
        'escapeDetected')
    $caseName = 'static-crash'
    $expectedState = 'STATIC_GUARDIAN_LOSS_AND_RECOVERY_OBSERVED'
    $expectedCoordinatorExit = 0
    if ($DoubleLoss) {
        $caseName = 'static-double'
        $expectedState = 'STATIC_DOUBLE_LOSS_AND_RECOVERY_OBSERVED'
        $expectedCoordinatorExit = 125
        $observerFlags += @('supervisorTerminationRequested', 'supervisorExited')
        $result['supervisorTerminationRequested'] = $null
        $result['supervisorExited'] = $null
    }
    $process = $null
    $coordinatorExited = $false
    $clock = $null
    $private = [IO.Path]::Combine($Stage, $caseName, 'private')
    $workspace = [IO.Path]::Combine($Stage, $caseName, 'workspace')

    try {
        $observer = Join-Path $PSScriptRoot 'WfpStaticCrash.ps1'
        Assert-NoReparsePath $observer
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $FixturePath
        Assert-NoReparsePath $private -CreateDirectory
        Assert-NoReparsePath $workspace -CreateDirectory

        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $ControllerPath
        $start.WorkingDirectory = $Stage
        $start.UseShellExecute = $false
        $start.ArgumentList.Add($caseName)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $process = [Diagnostics.Process]::Start($start)
        if ($null -eq $process) { throw 'STATIC_COORDINATOR_START_FAILED' }

        $result.state = 'STATIC_OBSERVER_EVIDENCE_UNAVAILABLE'
        $readyPath = [IO.Path]::Combine($private, 'ready.json')
        $lines = @(& $observer -SupervisorPid $process.Id -SupervisorPath $ControllerPath `
            -FixturePath $FixturePath -ReadyPath $readyPath -Workspace $workspace -DoubleLoss:$DoubleLoss)
        if ($lines.Count -ne 1 -or $lines[0] -isnot [string] -or $lines[0].Length -gt 16384) {
            throw 'STATIC_OBSERVER_EVIDENCE_INVALID'
        }
        $record = $lines[0] | ConvertFrom-Json -AsHashtable -Depth 8
        if ($record -isnot [System.Collections.IDictionary] -or $record['state'] -isnot [string] -or
            $record['state'] -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$') {
            throw 'STATIC_OBSERVER_EVIDENCE_INVALID'
        }
        $result.observerState = $record['state']
        $result.state = $result.observerState
        foreach ($flag in $observerFlags) {
            if ($record[$flag] -is [bool]) { $result[$flag] = $record[$flag] }
        }
        foreach ($number in @('recoveryExitCode', 'samples', 'jobMembersObserved')) {
            if (Test-WfpNativeNumber ($record[$number])) { $result[$number] = $record[$number] }
        }
        if ($record['error'] -is [string] -and $record['error'] -cmatch '^[A-Z0-9_]{1,96}$') {
            $result.observerError = $record['error']
        }
    } catch { }
    finally {
        if ($null -ne $process) {
            try {
                $remaining = [Math]::Max(0, 45000 - $clock.ElapsedMilliseconds)
                if (!$process.WaitForExit([int] $remaining)) {
                    $result.coordinatorTimedOut = $true
                    # The guardian and recovery process have separate lifetimes. Terminate only the coordinator.
                    $process.Kill()
                }
                $coordinatorExited = $process.WaitForExit(2000)
                if ($coordinatorExited) { $result.coordinatorExitCode = $process.ExitCode }
            } catch { }
            finally { $process.Dispose() }
        }
    }

    if ($null -ne $process) {
        $result.recoveryIntentPresent = [IO.File]::Exists([IO.Path]::Combine($private, 'static-intent.json'))
        try {
            $recovery = Read-WfpPairedRecord ([IO.Path]::Combine($private, 'static-recovery-result.json'))
            $result.recoveryState = $recovery['state']
            $result.jobAbsent = $recovery['jobAbsent'] -is [bool] -and $recovery['jobAbsent']
            $result.recoveryVerified = $result.recoveryState -ceq 'STATIC_RECOVERY_VERIFIED' -and
                $result.jobAbsent -and $recovery['filtersRemoved'] -is [bool] -and $recovery['filtersRemoved']
        } catch { }
        try {
            $natural = Read-WfpPairedRecord ([IO.Path]::Combine($private, 'result.json'))
            $result.naturalCleanupVerified = $natural['jobEmpty'] -is [bool] -and $natural['jobEmpty'] -and
                $natural['independentRemovalVerified'] -is [bool] -and $natural['independentRemovalVerified']
        } catch { }
    }

    $stageCleanupSafe = $null -eq $process -or ($coordinatorExited -and !$result.coordinatorTimedOut -and
        ($result.recoveryVerified -or $result.naturalCleanupVerified))
    if ($result.coordinatorTimedOut) {
        $result.state = 'STATIC_COORDINATOR_TIMEOUT'
    } elseif ($null -ne $process -and !$coordinatorExited) {
        $result.state = 'STATIC_COORDINATOR_EXIT_UNVERIFIED'
    } elseif ($result.observerState -cin @('STATIC_GUARDIAN_LOSS_AND_RECOVERY_OBSERVED', 'STATIC_DOUBLE_LOSS_AND_RECOVERY_OBSERVED') -and
        ($result.observerState -cne $expectedState -or !$result.recoveryVerified -or
            $result.coordinatorExitCode -ne $expectedCoordinatorExit -or
            ($DoubleLoss -and ($result['supervisorTerminationRequested'] -ne $true -or $result['supervisorExited'] -ne $true)) -or
            $result.terminationRequested -ne $true -or $result.guardianExited -ne $true -or
            $result.fixtureTreeExited -ne $true -or $result.jobMembersExited -ne $true -or
            $null -eq $result.jobMembersObserved -or $result.jobMembersObserved -lt 3 -or
            $result.staticProtectionRetained -ne $true -or $result.recoveryAcknowledgementWritten -ne $true -or
            $result.recoveryExitCode -ne 0 -or $result.filtersRemoved -ne $true -or
            $result.escapeDetected -ne $false)) {
        $result.state = 'STATIC_FINAL_EVIDENCE_UNVERIFIED'
    }
    return [ordered]@{ result = $result; stageCleanupSafe = $stageCleanupSafe }
}
