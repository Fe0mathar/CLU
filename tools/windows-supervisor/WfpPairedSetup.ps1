function Read-WfpPairedRecord([string] $Path) {
    $Path = [IO.Path]::GetFullPath($Path)
    Assert-NoReparsePath $Path
    $file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($file.Length -lt 2 -or $file.Length -gt 16384) { throw 'WFP diagnostic record size invalid.' }
        $reader = [IO.StreamReader]::new($file, [Text.UTF8Encoding]::new($false, $true))
        try { $record = $reader.ReadToEnd() | ConvertFrom-Json -AsHashtable -Depth 8 }
        finally { $reader.Dispose() }
    } finally { $file.Dispose() }
    if ($record -isnot [System.Collections.IDictionary] -or $record['state'] -isnot [string] -or
        $record['state'] -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$') { throw 'WFP diagnostic record shape invalid.' }
    return $record
}

function Test-WfpNativeNumber($Value) {
    return ($Value -is [int] -or $Value -is [long]) -and $Value -ge 0 -and $Value -le [int]::MaxValue
}

function Get-WfpPairedBindAttribution([System.Collections.IDictionary] $Paired, $SystemAudit) {
    $summary = [ordered]@{ state = 'PAIRED_BIND_CAUSALITY_UNPROVEN'; systemAudit = $SystemAudit; security = $null; bindCases = $null }
    if ($Paired.state -cne 'PAIRED_BIND_CAUSALITY_OBSERVED') { return $summary }

    $summary.state = 'BIND_DENIED_ATTRIBUTION_UNPROVEN'
    $drop = $Paired.dropEvidence
    if ($drop -isnot [System.Collections.IDictionary] -or $drop['filterIds'] -isnot [array] -or
        $drop['filterIds'].Count -ne 6 -or $drop['verifiedSublayerWeight'] -ne 65534) { return $summary }
    $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($id in $drop['filterIds']) {
        [uint64] $numeric = 0
        if ($id -isnot [string] -or $id -cnotmatch '^[1-9][0-9]{0,19}$' -or
            ![uint64]::TryParse($id, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$numeric) -or
            !$unique.Add($id)) { return $summary }
    }

    $keys = @('ipv4Tcp', 'ipv6Tcp', 'ipv4Udp', 'ipv6Udp')
    $cases = [ordered]@{}
    $bfe = $drop['bindHits']
    foreach ($key in $keys) {
        $cases[$key] = $bfe -is [System.Collections.IDictionary] -and (Test-WfpNativeNumber ($bfe[$key])) -and $bfe[$key] -gt 0
    }
    if ($cases.Values -contains $false) {
        try {
            $reader = Join-Path $PSScriptRoot 'WfpSecurityEvents.ps1'
            Assert-NoReparsePath $reader
            . $reader
            $query = @{
                FilterIds = [string[]] $drop['filterIds']
                Start = [datetime] $Paired.filteredStartedAt
                End = [datetime] $Paired.filteredFinishedAt
            }
            $summary.security = Get-WfpSecurityBindEvidence @query
            if ($summary.security.state -ceq 'MATCHED') {
                foreach ($key in $keys) { $cases[$key] = $cases[$key] -or $summary.security.hits.$key -gt 0 }
            }
        } catch { $summary.security = [ordered]@{ state = 'UNAVAILABLE'; hits = $null } }
    }

    $summary.bindCases = $cases
    if ($cases.Values -notcontains $false) { $summary.state = 'ALL_BIND_DROPS_ATTRIBUTED' }
    elseif ($cases.Values -contains $true) { $summary.state = 'PARTIAL_BIND_DROP_ATTRIBUTION' }
    return $summary
}

function Invoke-WfpPairedSetup([string] $ControllerPath, [string] $Stage, [string] $FixturePath) {
    $systemAudit = [ordered]@{ state = 'SYSTEM_POLICY_UNAVAILABLE'; systemFailureEnabled = $null }
    try {
        $auditReader = Join-Path $PSScriptRoot 'WfpBindAuditState.ps1'
        Assert-NoReparsePath $auditReader
        . $auditReader
        $systemAudit = Get-WfpBindAuditState
    } catch { }

    $paired = [ordered]@{
        state = 'PAIRED_CONTROLLER_UNAVAILABLE'; controllerState = $null; controllerError = $null; exitCode = $null; engineExitCode = $null
        identityVerified = $false; independentRemovalVerified = $false; jobEmpty = $false
        phases = [ordered]@{ before = $null; during = $null; after = $null }
        filteredStartedAt = $null; filteredFinishedAt = $null; dropEvidence = $null
    }
    try {
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $FixturePath
        $paired.exitCode = Invoke-ExactExecutable $ControllerPath @('paired') $Stage 30
        $paired.state = 'PAIRED_CONTROLLER_REPORT_UNAVAILABLE'
        $record = Read-WfpPairedRecord ([IO.Path]::Combine($Stage, 'paired', 'private', 'result.json'))
        $paired.controllerState = $record['state']
        if (Test-WfpNativeNumber ($record['engineExitCode'])) { $paired.engineExitCode = $record['engineExitCode'] }
        if ($record['error'] -is [string] -and $record['error'] -cmatch '^[A-Z0-9_]{1,96}$') {
            $paired.controllerError = $record['error']
        }
        foreach ($flag in @('identityVerified', 'independentRemovalVerified', 'jobEmpty')) {
            $paired[$flag] = $record[$flag] -is [bool] -and $record[$flag]
        }
        foreach ($key in @('filteredStartedAt', 'filteredFinishedAt', 'dropEvidence')) { $paired[$key] = $record[$key] }
        $vectors = $record['phases']
        if ($vectors -is [System.Collections.IDictionary]) {
            foreach ($phase in @('before', 'during', 'after')) {
                $vector = $vectors[$phase]
                if ($vector -isnot [array] -or $vector.Count -ne 4) { continue }
                if (@($vector | Where-Object { Test-WfpNativeNumber $_ }).Count -eq 4) { $paired.phases[$phase] = $vector }
            }
        }
        $paired.state = 'PAIRED_BIND_CAUSALITY_UNPROVEN'
        if ($paired.exitCode -eq 0 -and $paired.controllerState -ceq 'PAIRED_BIND_CAUSALITY_OBSERVED' -and
            $paired.identityVerified -and $paired.independentRemovalVerified -and $paired.jobEmpty -and
            ($paired.phases.before -join ' ') -ceq '0 0 0 0' -and
            ($paired.phases.during -join ' ') -ceq '10013 10013 10013 10013' -and
            ($paired.phases.after -join ' ') -ceq '0 0 0 0') {
            $paired.state = 'PAIRED_BIND_CAUSALITY_OBSERVED'
        }
    } catch { }

    $crash = [ordered]@{ state = 'CRASH_CONTROLLER_UNAVAILABLE'; controllerState = $null; controllerError = $null; controllerExitCode = $null }
    $process = $null
    $guardianSettled = $true
    try {
        $observer = Join-Path $PSScriptRoot 'WfpPairedCrash.ps1'
        Assert-NoReparsePath $observer
        Assert-NoReparsePath $ControllerPath
        Assert-NoReparsePath $FixturePath
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $ControllerPath
        $start.WorkingDirectory = $Stage
        $start.UseShellExecute = $false
        $start.ArgumentList.Add('crash')
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $process = [Diagnostics.Process]::Start($start)
        $guardianSettled = $false
        $crash.state = 'CRASH_OBSERVER_UNAVAILABLE'
        $readyPath = [IO.Path]::Combine($Stage, 'crash', 'private', 'ready.json')
        $workspace = [IO.Path]::Combine($Stage, 'crash', 'workspace')
        $observation = @(& $observer -SupervisorPid $process.Id -SupervisorPath $ControllerPath `
            -FixturePath $FixturePath -ReadyPath $readyPath -Workspace $workspace)
        if ($observation.Count -eq 1 -and $observation[0] -is [string] -and $observation[0].Length -le 16384) {
            $record = $observation[0] | ConvertFrom-Json -AsHashtable -Depth 8
            if ($record -is [System.Collections.IDictionary] -and $record['state'] -is [string] -and
                $record['state'] -cmatch '^[A-Z][A-Z0-9_]{0,95}$') { $crash = $record }
        }
    } catch { }
    finally {
        if ($null -ne $process) {
            try {
                $remaining = [Math]::Max(0, 30000 - [int] $clock.ElapsedMilliseconds)
                $forced = !$process.WaitForExit($remaining)
                if ($forced) {
                    $crash['state'] = 'CRASH_CONTROLLER_CLEANUP_UNCONFIRMED'
                    $process.Kill()
                }
                if ($process.WaitForExit(2000)) {
                    $crash['controllerExitCode'] = $process.ExitCode
                    $guardianSettled = $crash['guardianExited'] -eq $true -or
                        (!$forced -and $crash['terminationRequested'] -ne $true -and $process.ExitCode -ne 124)
                }
            } catch { $crash['state'] = 'CRASH_CONTROLLER_CLEANUP_UNCONFIRMED' }
            finally { $process.Dispose() }
        }
        $crash['controllerState'] = $null
        $crash['controllerError'] = $null
        $crash['engineExitCode'] = $null
        $crash['guardianJobEmpty'] = $false
        $crash['guardianSupervisorLossObserved'] = $false
        $crash['guardianAcknowledgementConsumed'] = $false
        $crash['guardianRemovalVerified'] = $false
        try {
            $resultPath = [IO.Path]::Combine($Stage, 'crash', 'private', 'result.json')
            if (!$guardianSettled) {
                $finish = [Diagnostics.Stopwatch]::StartNew()
                while ($finish.ElapsedMilliseconds -lt 8000 -and ![IO.File]::Exists($resultPath)) {
                    Start-Sleep -Milliseconds 25
                }
            }
            $record = Read-WfpPairedRecord $resultPath
            $guardianSettled = $true
            $crash['controllerState'] = $record['state']
            if (Test-WfpNativeNumber ($record['engineExitCode'])) { $crash['engineExitCode'] = $record['engineExitCode'] }
            $crash['guardianJobEmpty'] = $record['jobEmpty'] -is [bool] -and $record['jobEmpty']
            $crash['guardianSupervisorLossObserved'] = $record['supervisorLossObserved'] -is [bool] -and $record['supervisorLossObserved']
            $crash['guardianAcknowledgementConsumed'] = $record['observerAcknowledged'] -is [bool] -and $record['observerAcknowledged']
            $crash['guardianRemovalVerified'] = $record['independentRemovalVerified'] -is [bool] -and $record['independentRemovalVerified']
            if ($record['error'] -is [string] -and $record['error'] -cmatch '^[A-Z0-9_]{1,96}$') {
                $crash['controllerError'] = $record['error']
            }
        } catch { }
    }
    if ($crash['state'] -ceq 'GUARDIAN_CLEANUP_ORDER_OBSERVED' -and
        ($crash['controllerState'] -cne 'GUARDIAN_JOB_EMPTY_RELEASE_VERIFIED' -or
            !$crash['guardianJobEmpty'] -or !$crash['guardianSupervisorLossObserved'] -or
            !$crash['guardianAcknowledgementConsumed'] -or !$crash['guardianRemovalVerified'] -or
            $crash['escapeDetected'] -ne $false)) {
        $crash['state'] = 'GUARDIAN_FINAL_EVIDENCE_UNVERIFIED'
    }
    # Read existing audit events after both tests to allow delivery of paired-run records.
    $attribution = Get-WfpPairedBindAttribution $paired $systemAudit
    return [ordered]@{ paired = $paired; attribution = $attribution; crash = $crash; stageCleanupSafe = $guardianSettled }
}
