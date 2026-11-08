$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$inputRoot = 'C:\CLU-E-Fixture\Input'
$outputRoot = 'C:\CLU-E-Fixture\Output'
$utf8 = [Text.UTF8Encoding]::new($false, $true)

function Test-ObjectFields($Value, [string[]] $Required, [string[]] $Optional = @()) {
    if ($Value -isnot [pscustomobject]) { return $false }
    $names = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($name in $Required) {
        if ($name -cnotin $names) { return $false }
    }
    foreach ($name in $names) {
        if ($name -cnotin ($Required + $Optional)) { return $false }
    }
    return $true
}

function Read-FixtureRequest {
    $stream = [IO.File]::Open((Join-Path $inputRoot 'request.json'), [IO.FileMode]::Open,
        [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 2 -or $stream.Length -gt 1024) { throw 'FIXTURE_REQUEST_SIZE_INVALID' }
        $reader = [IO.StreamReader]::new($stream, $utf8, $false)
        try { $request = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }

    if (!(Test-ObjectFields $request @('schemaVersion', 'nonce') @('hostEndpoint')) -or
        $request.schemaVersion -isnot [string] -or
        $request.schemaVersion -cne 'clue-windows-sandbox-fixture-input/1' -or
        $request.nonce -isnot [string] -or $request.nonce -cnotmatch '\A[0-9a-f]{32}\z') {
        throw 'FIXTURE_REQUEST_INVALID'
    }

    $endpoint = $request.PSObject.Properties['hostEndpoint']
    if ($null -ne $endpoint -and $null -ne $endpoint.Value) {
        $value = $endpoint.Value
        [Net.IPAddress] $address = $null
        if (!(Test-ObjectFields $value @('address', 'port')) -or
            $value.address -isnot [string] -or ($value.port -isnot [int] -and $value.port -isnot [long]) -or
            $value.port -lt 1 -or $value.port -gt 65535 -or
            ![Net.IPAddress]::TryParse($value.address, [ref] $address) -or
            $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
            $address.ToString() -cne $value.address) {
            throw 'FIXTURE_ENDPOINT_INVALID'
        }

        $octets = $address.GetAddressBytes()
        $privateAddress = ($octets[0] -eq 10 -or
            ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
            ($octets[0] -eq 192 -and $octets[1] -eq 168))
        if (!$privateAddress) { throw 'FIXTURE_ENDPOINT_INVALID' }
        $remote = [Net.IPEndPoint]::new($address, $value.port)
    } else {
        $remote = $null
    }
    return @{ nonce = $request.nonce; remote = $remote }
}

function Get-SocketError($Exception) {
    while ($null -ne $Exception) {
        if ($Exception -is [Net.Sockets.SocketException]) { return $Exception.SocketErrorCode.ToString() }
        $Exception = $Exception.InnerException
    }
    return 'Unknown'
}

function Measure-InputWrite {
    try {
        $handle = [IO.File]::Open((Join-Path $inputRoot 'write-probe.txt'), [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $handle.Dispose()
        return 'WRITE_SUCCEEDED'
    } catch {
        $failure = $_.Exception
        while ($null -ne $failure) {
            if ($failure -is [UnauthorizedAccessException] -or
                ($failure -is [IO.IOException] -and ($failure.HResult -band 65535) -in @(5, 19, 65))) {
                return 'PROTECTED'
            }
            $failure = $failure.InnerException
        }
        return 'UNVERIFIED'
    }
}

function Measure-LoopbackBind([Net.IPAddress] $Address, [Net.Sockets.SocketType] $Type, [Net.Sockets.ProtocolType] $Protocol) {
    $socket = $null
    try {
        $socket = [Net.Sockets.Socket]::new($Address.AddressFamily, $Type, $Protocol)
        $socket.Bind([Net.IPEndPoint]::new($Address, 0))
        return 'BIND_ALLOWED'
    } catch {
        $code = Get-SocketError $_.Exception
        if ($code -eq 'AccessDenied') { return 'BIND_DENIED' }
        if ($code -in @('AddressFamilyNotSupported', 'AddressNotAvailable', 'ProtocolNotSupported', 'OperationNotSupported')) {
            return 'BIND_UNAVAILABLE'
        }
        return 'BIND_ERROR'
    } finally {
        if ($null -ne $socket) { $socket.Close() }
    }
}

function Measure-HostConnection([Net.IPEndPoint] $Endpoint, [string] $Nonce) {
    if ($null -eq $Endpoint) { return 'NOT_REQUESTED' }
    $client = $null
    $stream = $null
    $connected = $false
    try {
        $client = [Net.Sockets.TcpClient]::new($Endpoint.AddressFamily)
        $operation = $client.ConnectAsync($Endpoint.Address, $Endpoint.Port)
        if (!$operation.Wait(900)) { return 'TIMED_OUT' }
        $connected = $true
        $stream = $client.GetStream()
        $stream.WriteTimeout = 900
        $token = [Text.Encoding]::ASCII.GetBytes($Nonce)
        $stream.Write($token, 0, $token.Length)
        return 'CONNECTION_OBSERVED'
    } catch {
        if ($connected) { return 'CONNECTION_OBSERVED' }
        switch (Get-SocketError $_.Exception) {
            'ConnectionRefused' { return 'REFUSED' }
            'NetworkUnreachable' { return 'UNREACHABLE' }
            'HostUnreachable' { return 'UNREACHABLE' }
            'AddressNotAvailable' { return 'UNREACHABLE' }
            'TimedOut' { return 'TIMED_OUT' }
            'AccessDenied' { return 'DENIED' }
            default { return 'ERROR' }
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $client) { $client.Close() }
    }
}

function Measure-NetworkInventory {
    $result = [ordered]@{
        upNonLoopbackAdapters = $null
        ipv4DefaultRoutes = $null
        ipv6DefaultRoutes = $null
    }
    try {
        $adapters = [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
        $result.upNonLoopbackAdapters = @($adapters | Where-Object {
            $_.NetworkInterfaceType -ne [Net.NetworkInformation.NetworkInterfaceType]::Loopback -and
            $_.OperationalStatus -eq [Net.NetworkInformation.OperationalStatus]::Up
        }).Count
    } catch {}
    try {
        $routes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop)
        $result.ipv4DefaultRoutes = @($routes | Where-Object { $_.DestinationPrefix -ceq '0.0.0.0/0' }).Count
        $result.ipv6DefaultRoutes = @($routes | Where-Object { $_.DestinationPrefix -ceq '::/0' }).Count
    } catch {}
    return $result
}

$request = Read-FixtureRequest
$result = [ordered]@{
    schemaVersion = 'clue-windows-sandbox-fixture-result/1'
    fixtureVersion = 1
    nonce = $request.nonce
    inputWriteState = Measure-InputWrite
    localhost = [ordered]@{
        ipv4Tcp = Measure-LoopbackBind ([Net.IPAddress]::Loopback) Stream Tcp
        ipv6Tcp = Measure-LoopbackBind ([Net.IPAddress]::IPv6Loopback) Stream Tcp
        ipv4Udp = Measure-LoopbackBind ([Net.IPAddress]::Loopback) Dgram Udp
        ipv6Udp = Measure-LoopbackBind ([Net.IPAddress]::IPv6Loopback) Dgram Udp
    }
    hostConnection = Measure-HostConnection $request.remote $request.nonce
    network = Measure-NetworkInventory
}
$data = $utf8.GetBytes(($result | ConvertTo-Json -Depth 4 -Compress))
if ($data.Length -gt 4096) { throw 'FIXTURE_RESULT_SIZE_INVALID' }
$temporary = Join-Path $outputRoot ('result-' + $request.nonce + '.tmp')
$handle = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    try { $handle.Write($data, 0, $data.Length) }
    finally { $handle.Dispose() }
    [IO.File]::Move($temporary, (Join-Path $outputRoot 'result.json'))
} finally {
    [IO.File]::Delete($temporary)
}
