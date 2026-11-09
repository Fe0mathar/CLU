$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$expectedInput = 'C:\CLU-E-Peer\Input'
$output = 'C:\CLU-E-Peer\Output'
if ($PSScriptRoot -cne $expectedInput -or $env:USERNAME -ine 'WDAGUtilityAccount') {
    Write-Host 'CLU-E Sandbox peer refused the guest path or account.'
    exit 2
}
. (Join-Path $PSScriptRoot 'WindowsSandboxPeerCommon.ps1')

function Read-LivePeerFrame([Net.Sockets.NetworkStream] $Stream) {
    $buffer = [byte[]]::new(('CLU-E-PEER/2 C 000001 ' + ('0' * 64) + "`n").Length)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $offset = 0
    while ($offset -lt $buffer.Length) {
        $remaining = 500 - [int] $clock.ElapsedMilliseconds
        if ($remaining -le 0) { return $null }
        $Stream.ReadTimeout = $remaining
        $count = $Stream.Read($buffer, $offset, $buffer.Length - $offset)
        if ($count -le 0) { return $null }
        $offset += $count
    }
    return [Text.Encoding]::ASCII.GetString($buffer)
}

function Invoke-LivePeer([Net.Sockets.TcpListener] $Listener, [string] $GuestAddress,
    [string] $HostAddress, [int] $GuestPort, [string] $ControlNonce, [string] $ProbeNonce) {
    $controls = [Collections.Generic.List[int]]::new()
    $live = [ordered]@{ controls = @(); finishAck = $false; leakCount = 0; firstLeakSequence = $null }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt 115000) {
        if (!$Listener.Pending()) {
            Start-Sleep -Milliseconds 15
            continue
        }
        $client = $Listener.AcceptTcpClient()
        try {
            if ($client.Client.LocalEndPoint.Address.ToString() -cne $GuestAddress -or
                $client.Client.LocalEndPoint.Port -ne $GuestPort) { continue }
            $stream = $client.GetStream()
            $frame = Read-LivePeerFrame $stream
            if ($frame -cnotmatch '\ACLU-E-PEER/2 ([CLF]) (00000[1-5]) ([a-f0-9]{64})\n\z') { continue }
            $kind = $Matches[1]
            $ordinal = $Matches[2]
            $sequence = [int] $ordinal
            $token = $Matches[3]
            if ($kind -ceq 'L') {
                if ($token -cne $ProbeNonce -or $sequence -gt 4) { continue }
                if ($live.leakCount -eq 0) { $live.firstLeakSequence = $sequence }
                if ($live.leakCount -lt [int]::MaxValue) { $live.leakCount++ }
            } elseif ($token -cne $ControlNonce -or $client.Client.RemoteEndPoint.Address.ToString() -cne $HostAddress) {
                continue
            } elseif ($kind -ceq 'C') {
                if ($sequence -gt 4 -or $sequence -lt $controls.Count -or $sequence -gt ($controls.Count + 1)) { continue }
                if ($sequence -eq ($controls.Count + 1)) { $controls.Add($sequence) }
            } elseif ($sequence -ne 5) {
                continue
            }
            Write-PeerFrame $stream "CLU-E-PEER/2 ACK $kind $ordinal $token`n"
            if ($kind -ceq 'F') {
                $live.finishAck = $true
                break
            }
        } catch { }
        finally { $client.Close() }
    }
    $live.controls = $controls.ToArray()
    return $live
}

$listener = $null
$ruleCreated = $false
$nonce = $null
$report = [ordered]@{
    schemaVersion = 'clue-windows-sandbox-peer-result/1'
    state = 'PEER_REQUEST_UNVERIFIED'
    nonce = $null
    sandboxId = $null
    identity = $null
    guestAddress = $null
    hostAddress = $null
    guestPort = $null
    hostPort = $null
    hostToGuest = $null
    guestToHost = $null
    reverseControl = 'NOT_REQUESTED'
    liveControl = $null
    guestFirewall = 'NOT_ATTEMPTED'
    guestFirewallCleanup = 'NOT_REQUIRED'
}
try {
    $request = Read-PeerJson (Join-Path $PSScriptRoot 'request.json')
    if ($request -isnot [PSCustomObject] -or $request.schemaVersion -cne 'clue-windows-sandbox-peer-request/3' -or
        $request.nonce -isnot [string] -or $request.nonce -cnotmatch '\A[0-9a-f]{64}\z' -or
        $request.probeNonce -isnot [string] -or $request.probeNonce -cnotmatch '\A[0-9a-f]{64}\z' -or
        $request.probeNonce -ceq $request.nonce -or
        $request.sandboxId -isnot [string] -or
        $request.sandboxId -cnotmatch '\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z' -or
        $null -eq $request.PSObject.Properties['hostEndpoint']) {
        throw 'PEER_REQUEST_UNVERIFIED'
    }
    $nonce = $request.nonce
    $report.nonce = $nonce
    $report.sandboxId = $request.sandboxId
    $heartbeat = [ordered]@{
        schemaVersion = 'clue-windows-sandbox-peer-heartbeat/1'
        nonce = $nonce
        sandboxId = $request.sandboxId
    }
    Write-PeerJson (Join-Path $output 'heartbeat.json') $heartbeat
    Write-Host 'CLU-E peer started inside Windows Sandbox.'

    $report.state = 'PEER_IDENTITY_UNVERIFIED'
    $report.identity = Get-PeerIdentity
    if (!$report.identity.sandboxAccount) { throw 'PEER_IDENTITY_UNVERIFIED' }

    $report.state = 'PEER_IPV4_ROUTE_UNVERIFIED'
    $networkWait = [Diagnostics.Stopwatch]::StartNew()
    do {
        $pairs = @(
            foreach ($interface in (Get-NetIPConfiguration -All)) {
                foreach ($gateway in @($interface.IPv4DefaultGateway)) {
                    if ($null -eq $gateway -or !(Test-PrivatePeerAddress $gateway.NextHop)) { continue }
                    foreach ($ip in @($interface.IPv4Address)) {
                        if ($null -ne $ip -and (Test-PrivatePeerAddress $ip.IPAddress) -and $ip.IPAddress -cne $gateway.NextHop) {
                            [PSCustomObject]@{ Guest = $ip.IPAddress; Host = $gateway.NextHop }
                        }
                    }
                }
            }
        )
        if ($pairs.Count -ne 0) { break }
        Start-Sleep -Milliseconds 250
    } while ($networkWait.ElapsedMilliseconds -lt 12000)
    if ($pairs.Count -ne 1) { throw 'PEER_IPV4_ROUTE_UNVERIFIED' }
    $report.guestAddress = $pairs[0].Guest
    $report.hostAddress = $pairs[0].Host
    $endpoint = $request.hostEndpoint
    if ($null -ne $endpoint) {
        $report.reverseControl = 'HOST_ENDPOINT_MISMATCH'
        if ($endpoint -is [PSCustomObject]) {
            $address = $endpoint.PSObject.Properties['address']
            $port = $endpoint.PSObject.Properties['port']
            if (@($endpoint.PSObject.Properties).Count -eq 2 -and $null -ne $address -and $null -ne $port -and
                $address.Value -is [string] -and $address.Value -ceq $report.hostAddress -and
                ($port.Value -is [int] -or $port.Value -is [long]) -and $port.Value -ge 1 -and $port.Value -le 65535) {
                $report.hostPort = [int] $port.Value
                $report.reverseControl = 'ATTEMPTED'
            }
        }
    }

    $report.state = 'PEER_LISTENER_UNAVAILABLE'
    $listener = New-PeerListener $report.guestAddress
    $report.guestPort = $listener.LocalEndpoint.Port
    $ruleName = 'CLU-E-Sandbox-Peer-' + $nonce.Substring(0, 24)
    $report.guestFirewall = 'RULE_UNAVAILABLE'
    try {
        $rule = @{
            Name = $ruleName
            DisplayName = $ruleName
            Direction = 'Inbound'
            Action = 'Allow'
            Enabled = 'True'
            Profile = 'Any'
            Protocol = 'TCP'
            LocalAddress = $report.guestAddress
            RemoteAddress = $report.hostAddress
            LocalPort = $report.guestPort
            Program = Join-Path $PSHOME 'powershell.exe'
            PolicyStore = 'PersistentStore'
        }
        $null = New-NetFirewallRule @rule
        $ruleCreated = $true
        $report.guestFirewall = 'SCOPED_RULE_ADDED'
    } catch { }

    $ready = [ordered]@{
        schemaVersion = 'clue-windows-sandbox-peer-ready/1'
        nonce = $nonce
        sandboxId = $request.sandboxId
        identity = $report.identity
        guestAddress = $report.guestAddress
        hostAddress = $report.hostAddress
        guestPort = $report.guestPort
        hostPort = $report.hostPort
        reverseControl = $report.reverseControl
        guestFirewall = $report.guestFirewall
    }
    Write-PeerJson (Join-Path $output 'peer-ready.json') $ready

    $report.state = 'PEER_TCP_CONTROLS_INCOMPLETE'
    $report.hostToGuest = Invoke-PeerAccept $listener $report.guestAddress $report.hostAddress $report.guestPort $nonce 'HOST' 15000
    if ($report.reverseControl -ceq 'ATTEMPTED') {
        try {
            $report.guestToHost = Invoke-PeerDial $report.guestAddress $report.hostAddress $report.hostPort $nonce 'GUEST'
        } catch {
            $report.guestToHost = [ordered]@{
                state = 'NOT_CONNECTED'
                error = Get-PeerSocketCode $_.Exception
                localAddress = $null
                remoteAddress = $null
                remotePort = $null
            }
        }
    }
    if ($report.hostToGuest.state -cne 'NONCE_MATCHED' -or $null -eq $report.guestToHost -or
        $report.guestToHost.state -cne 'NONCE_MATCHED') { throw 'PEER_TCP_CONTROLS_INCOMPLETE' }
    $report.state = 'PEER_LIVE_CONTROL_INCOMPLETE'
    Write-PeerJson (Join-Path $output 'peer-live-ready.json') ([ordered]@{
        schemaVersion = 'clue-windows-sandbox-peer-live-ready/1'
        nonce = $nonce
        sandboxId = $request.sandboxId
        sessionSha256 = $report.identity.sessionSha256
        hostToGuest = $report.hostToGuest
        guestToHost = $report.guestToHost
    })
    $report.liveControl = Invoke-LivePeer $listener $report.guestAddress $report.hostAddress $report.guestPort $nonce $request.probeNonce
    if ($report.liveControl.finishAck) { $report.state = 'PEER_LIVE_CONTROL_COMPLETED' }
} catch {
    Write-Host "CLU-E Sandbox peer stopped: $($report.state)"
} finally {
    if ($null -ne $listener) { $listener.Stop() }
    if ($ruleCreated) {
        $report.guestFirewallCleanup = 'REMOVAL_UNVERIFIED'
        try {
            Remove-NetFirewallRule -Name $ruleName -PolicyStore PersistentStore -ErrorAction Stop
            if ($null -eq (Get-NetFirewallRule -Name $ruleName -PolicyStore PersistentStore -ErrorAction SilentlyContinue)) {
                $report.guestFirewallCleanup = 'SCOPED_RULE_REMOVED'
            }
        } catch { }
    }
    try { Write-PeerJson (Join-Path $output 'peer-result.json') $report }
    catch { Write-Host 'CLU-E Sandbox peer could not write its mapped result.' }
}
