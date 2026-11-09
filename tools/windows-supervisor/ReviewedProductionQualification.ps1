# Dot-sourced by RunReviewedProductionRelease.ps1, which owns the path and file-pin helpers.
$script:reviewedBundleName = 'CLU-E_WINDOWS_PRODUCTION_NETWORK_FAULT_20261109-084702-209-0fdc44c9fc064900a8dd61fcb6a83044.json'
$script:reviewedBundleSha = '679974a0994d37092881d7c2fe20efd097901d48261ae822016992920e16c880'
$script:reviewedAdmissionName = 'CLU-E_WINDOWS_PRODUCTION_ADMISSION_20261109-084702-204-22de21b1.json'
$script:reviewedAdmissionSha = 'bb51e0b33b4639d3aeeb496c66527b0f9a0979572af66dbbea71b4d866abe72f'
$script:reviewedCanariesName = 'P2_WINDOWS_SUPERVISOR_QUALIFICATION_20261109-084702-209-0fdc44c9fc064900a8dd61fcb6a83044.json'
$script:reviewedCanariesSha = '094eaf91124bf79be5bf263c0c84e1d6ab4c0ea7a2d71adae9f072c99c45e098'
$script:reviewedWrapperSha = 'f4fb6034fc446b0ffe20383feaf0704e9aa156d6d31e6dd41bc8d21d86daf59c'
$script:reviewedWrapperPathSha = '537caf4be849a154947cb6811ff75d6fb7c15619741959e5f4b2871004173621'
$script:reviewedFaultScope = 'PRIMARY_OWNER_LOSS_HEALTHY_BFE_SAME_PC_VIRTUAL_IPV4_TCP'
$script:reviewedNativeCases = @('allowed-command', 'filesystem-denied', 'secrets-denied', 'network-denied',
    'descendant-timeout', 'launcher-cancellation', 'tamper-refused')

function Assert-ReviewedNetworkFault([System.Collections.IDictionary] $Bundle) {
    if ($Bundle['schemaVersion'] -cne 'clue-windows-production-network-fault/1' -or
        $Bundle['state'] -cne 'PRODUCTION_NETWORK_FAULT_OBSERVED' -or
        ![object]::Equals($Bundle['proofAuthorization'], $false) -or
        ![object]::Equals($Bundle['qualificationPromotion'], $false) -or
        ![object]::Equals($Bundle['hostFirewallModified'], $false) -or
        $Bundle['productionExecution'] -cne 'FAULT_DRIVER_EXECUTED' -or
        $Bundle['peerType'] -cne 'SAME_PC_WINDOWS_SANDBOX_VIRTUAL_SWITCH' -or
        $Bundle['offHostLan'] -cne 'NOT_TESTED' -or $Bundle['externalNetworkProbe'] -cne 'NOT_RUN' -or
        $Bundle['faultDriverExitCode'] -ne 0 -or $null -ne $Bundle['faultDriverFailure'] -or
        $null -ne $Bundle['failure'] -or $Bundle['stageCleanup'] -cne 'REMOVED' -or
        $Bundle['sandbox']['cleanup'] -cne 'EXACT_SESSION_ABSENT' -or
        $Bundle['guestState'] -cne 'PEER_LIVE_CONTROL_COMPLETED' -or
        $Bundle['guestFirewall']['state'] -cne 'SCOPED_RULE_ADDED' -or
        $Bundle['guestFirewall']['cleanup'] -cne 'SCOPED_RULE_REMOVED') {
        throw 'RELEASE_REVIEWED_NETWORK_FAULT_UNVERIFIED'
    }
    foreach ($lane in @('hostToGuest', 'guestToHost')) {
        if (![object]::Equals($Bundle[$lane]['verified'], $true)) { throw 'RELEASE_REVIEWED_PEER_UNVERIFIED' }
    }
    foreach ($key in @('machineDistinct', 'accountDistinct', 'bootDistinct', 'sessionDistinct')) {
        if (![object]::Equals($Bundle['identity'][$key], $true)) { throw 'RELEASE_REVIEWED_PEER_UNVERIFIED' }
    }
    if (![object]::Equals($Bundle['network']['hostVirtualAdapterVerified'], $true) -or
        ![object]::Equals($Bundle['network']['addressesDistinct'], $true)) { throw 'RELEASE_REVIEWED_PEER_UNVERIFIED' }

    $peer = $Bundle['peerFaultControls']
    if ($peer['controls'] -isnot [array] -or ($peer['controls'] -join ',') -cne '1,2,3,4' -or
        ![object]::Equals($peer['finishAck'], $true) -or $peer['leakCount'] -ne 0 -or
        $null -ne $peer['firstLeakSequence']) { throw 'RELEASE_REVIEWED_PEER_UNVERIFIED' }
    $driver = $Bundle['faultDriver']
    if ($driver['schemaVersion'] -cne 'clue-windows-production-fault-driver/1' -or
        $driver['state'] -cne 'PRODUCTION_NETWORK_FAULT_OBSERVED' -or
        ![object]::Equals($driver['proofAuthorization'], $false) -or
        $driver['scope'] -cne $script:reviewedFaultScope -or
        $driver['supervisorSha256'] -cne $script:reviewedWrapperSha -or
        $null -ne $driver['blocker'] -or $driver['hostLeakCount'] -ne 0 -or $driver['cleanup'] -cne 'REMOVED' -or
        $driver['process']['exit'] -ne 125 -or ![object]::Equals($driver['process']['abortMarker'], $true) -or
        $driver['process']['codes'] -cnotcontains 'ActiveFaultSample GOVERNED_WFP_ACTIVE_OWNER_LOSS_ABORT') {
        throw 'RELEASE_REVIEWED_FAULT_DRIVER_UNVERIFIED'
    }
    foreach ($key in @('requestUnchanged', 'imageReverified', 'peerFinishAck')) {
        if (![object]::Equals($driver[$key], $true)) { throw 'RELEASE_REVIEWED_FAULT_DRIVER_UNVERIFIED' }
    }
    $phases = @('before', 'active', 'fault', 'after')
    for ($index = 0; $index -lt $phases.Length; $index++) {
        $sample = $driver['controls'][$phases[$index]]
        if ($sample['sequence'] -ne ($index + 1) -or ![object]::Equals($sample['host'], $true) -or
            ![object]::Equals($sample['peer'], $true)) { throw 'RELEASE_REVIEWED_CONTROL_UNVERIFIED' }
    }
    $native = $driver['native']
    if ($native['state'] -cne 'PRODUCTION_WFP_ACTIVE_LOSS_OBSERVED') { throw 'RELEASE_REVIEWED_NATIVE_FAULT_UNVERIFIED' }
    foreach ($key in @('verified', 'identityVerified', 'leaseVerified', 'jobEmpty', 'removalVerified',
            'productionBackupVerified', 'ownerExitVerified', 'nodeExited', 'releaseWithheld', 'backupSurvived')) {
        if (![object]::Equals($native[$key], $true)) { throw 'RELEASE_REVIEWED_NATIVE_FAULT_UNVERIFIED' }
    }
    $codes = [ordered]@{
        control = '0,0,0,0'
        armed = '10013,10013,10013,10013'
        active = '10013,10013,10013,10013,10013,10013'
        fault = '10013,10013,10013,10013,10013,10013'
    }
    foreach ($phase in $codes.Keys) {
        if ($native[$phase] -isnot [array] -or ($native[$phase] -join ',') -cne $codes[$phase]) {
            throw 'RELEASE_REVIEWED_NATIVE_FAULT_UNVERIFIED'
        }
    }
}

function Get-ReviewedProductionEvidence([string] $Evidence) {
    $locks = [Collections.Generic.List[IO.Stream]]::new()
    $passed = $false
    try {
        $bundlePath = Join-Path $Evidence $script:reviewedBundleName
        $admissionPath = Join-Path $Evidence $script:reviewedAdmissionName
        $canariesPath = Join-Path $Evidence $script:reviewedCanariesName
        $bundleLock = Open-PinnedFile $bundlePath $script:reviewedBundleSha 1MB
        $locks.Add($bundleLock)
        $bundle = Read-Json $bundleLock
        Assert-ReviewedNetworkFault $bundle
        $inputs = $bundle['inputs']
        if ($inputs['admissionPath'] -cne $admissionPath -or $inputs['admissionSha256'] -cne $script:reviewedAdmissionSha -or
            $inputs['qualificationPath'] -cne $canariesPath -or $inputs['qualificationSha256'] -cne $script:reviewedCanariesSha -or
            $inputs['supervisorSha256'] -cne $script:reviewedWrapperSha -or
            $inputs['supervisorPath'] -isnot [string] -or
            (Get-PathDigest $inputs['supervisorPath']) -cne $script:reviewedWrapperPathSha) {
            throw 'RELEASE_REVIEWED_EVIDENCE_BINDINGS_UNVERIFIED'
        }

        $admissionLock = Open-PinnedFile $admissionPath $script:reviewedAdmissionSha 1MB
        $locks.Add($admissionLock)
        $admission = Read-Json $admissionLock
        if ($admission['installation']['wrapperPath'] -cne $inputs['supervisorPath'] -or
            $admission['installation']['guardianPid'] -ne $inputs['productionRegistrationPid'] -or
            $admission['installation']['operatorPid'] -ne $inputs['expectedOperatorPid'] -or
            ![object]::Equals($admission['productionNetworkFaultDiagnostic'], $true)) {
            throw 'RELEASE_REVIEWED_ADMISSION_UNVERIFIED'
        }

        $canariesLock = Open-PinnedFile $canariesPath $script:reviewedCanariesSha 1MB
        $locks.Add($canariesLock)
        $canaries = Read-Json $canariesLock
        if ($canaries['schemaVersion'] -cne 'clue-console-probe-native-supervisor/1' -or
            $canaries['status'] -cne 'MEASUREMENT_PENDING' -or $canaries['canaryStatus'] -cne 'PASS' -or
            ![object]::Equals($canaries['fixtureRemoved'], $true) -or $null -ne $canaries['blocker'] -or
            $canaries['supervisorSha256'] -cne $script:reviewedWrapperSha -or
            $canaries['supervisorPathSha256'] -cne $script:reviewedWrapperPathSha -or
            $canaries['cases']['measurement-parity'] -cne 'NOT_EXECUTED') {
            throw 'RELEASE_REVIEWED_CANARIES_UNVERIFIED'
        }
        foreach ($name in $script:reviewedNativeCases) {
            if ($canaries['cases'][$name] -cne 'PASS') { throw 'RELEASE_REVIEWED_CANARIES_UNVERIFIED' }
        }
        $hostRecord = $canaries['host']
        foreach ($key in @('hostnameSha256', 'principalSha256', 'nodeSha256')) {
            if ($hostRecord[$key] -cnotmatch '\A[a-f0-9]{64}\z') { throw 'RELEASE_REVIEWED_CANARY_HOST_UNVERIFIED' }
        }
        foreach ($key in @('osRelease', 'osVersion', 'nodeVersion')) {
            if ($hostRecord[$key] -isnot [string] -or !$hostRecord[$key]) { throw 'RELEASE_REVIEWED_CANARY_HOST_UNVERIFIED' }
        }
        if ($hostRecord['platform'] -cne 'win32' -or $hostRecord['arch'] -cne 'x64' -or
            $hostRecord['nodeSha256'] -cne $admission['nodeSha256']) { throw 'RELEASE_REVIEWED_CANARY_HOST_UNVERIFIED' }

        $passed = $true
        return [pscustomobject]@{
            admission = $admission
            qualification = $canaries
            image = $inputs['supervisorPath']
            wrapperSha = $script:reviewedWrapperSha
            wrapperPathSha = $script:reviewedWrapperPathSha
            bundlePath = $bundlePath
            bundleSha = $script:reviewedBundleSha
            locks = $locks
        }
    } finally {
        if (!$passed) { foreach ($lock in $locks) { $lock.Dispose() } }
    }
}

function New-ReviewedProductionQualification($Reviewed, [string] $Evidence, [string] $Commit) {
    if ($Commit -cnotmatch '\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z') { throw 'RELEASE_GIT_HEAD_UNVERIFIED' }
    Write-Host ''
    Write-Host "Supervisor $($Reviewed.wrapperSha)"
    Write-Host "Committed source $Commit"
    Write-Host 'Evidence passed production request admission, seven native canaries, and the live network fault test.'
    Write-Host 'Scope: one primary guardian loss with BFE running, host loopback and the same-PC virtual IPv4 TCP peer.'
    Write-Host 'Physical off-host LAN was untested. The release gates use the committed source shown above.'
    $answer = Read-Host 'Type QUALIFY AND RELEASE to authorize this scope and run the formal gates'
    if ($answer -cne 'QUALIFY AND RELEASE') { throw 'RELEASE_OPERATOR_AUTHORIZATION_DECLINED' }

    $cases = [ordered]@{}
    foreach ($name in $script:reviewedNativeCases) { $cases[$name] = $Reviewed.qualification['cases'][$name] }
    $cases['production-request-admission'] = 'PASS'
    $cases['network-boundary-fault'] = 'PASS'
    $checkedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    $receipt = [ordered]@{
        schemaVersion = 'clue-windows-supervisor-production-qualification/2'
        checkedAt = $checkedAt
        qualificationScope = 'PRODUCTION_PROOF'
        proofAuthorization = $true
        canaryStatus = 'PASS'
        fixtureRemoved = $true
        supervisorSha256 = $Reviewed.wrapperSha
        supervisorPathSha256 = $Reviewed.wrapperPathSha
        host = $Reviewed.qualification['host']
        cases = $cases
        operatorReview = [ordered]@{
            commit = $Commit
            networkFaultScope = $script:reviewedFaultScope
            offHostLan = 'NOT_TESTED'
            admissionSha256 = $script:reviewedAdmissionSha
            nativeCanariesSha256 = $script:reviewedCanariesSha
            networkFaultBundleSha256 = $Reviewed.bundleSha
        }
    }
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes(($receipt | ConvertTo-Json -Depth 16) + "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $pin = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff', [Globalization.CultureInfo]::InvariantCulture)
    $nonce = [Guid]::NewGuid().ToString('N')
    $path = Join-Path $Evidence "P2_WINDOWS_SUPERVISOR_PRODUCTION_QUALIFICATION_$stamp-$nonce.json"
    Assert-ExactPath $Evidence $true
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    $lock = Open-PinnedFile $path $pin 1MB
    return [pscustomobject]@{ path = $path; sha256 = $pin; lock = $lock }
}
