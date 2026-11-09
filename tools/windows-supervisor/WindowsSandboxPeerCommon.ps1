# Shared by the desktop host and the built-in Windows PowerShell guest.
function Get-PeerHash([string] $Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Get-PeerIdentity {
    $windows = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 5
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $machine = [Environment]::MachineName
        $account = $identity.User.Value
        $boot = $windows.LastBootUpTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        $session = $process.SessionId
        if (!$machine -or !$account -or $boot -cnotmatch '\A[0-9]{15,19}\z' -or $session -le 0) {
            throw 'PEER_IDENTITY_UNVERIFIED'
        }
        return [ordered]@{
            machineSha256 = Get-PeerHash $machine
            accountSha256 = Get-PeerHash $account
            bootUtcTicks = $boot
            sessionId = $session
            sessionSha256 = Get-PeerHash "$machine|$account|$boot|$session"
            sandboxAccount = $identity.Name -match '\\WDAGUtilityAccount$'
        }
    } finally {
        $process.Dispose()
        $identity.Dispose()
    }
}

function Test-PrivatePeerAddress([string] $Text) {
    [Net.IPAddress] $address = $null
    if (![Net.IPAddress]::TryParse($Text, [ref] $address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $address.ToString() -cne $Text) {
        return $false
    }
    $bytes = $address.GetAddressBytes()
    return $bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Read-PeerJson([string] $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'PEER_RECEIPT_TYPE_INVALID'
    }
    $file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($file.Length -lt 2 -or $file.Length -gt 16384) { throw 'PEER_RECEIPT_SIZE_INVALID' }
        $reader = [IO.StreamReader]::new($file, [Text.UTF8Encoding]::new($false, $true), $false, 1024, $true)
        try { return ConvertFrom-Json -InputObject ($reader.ReadToEnd()) }
        finally { $reader.Dispose() }
    } finally { $file.Dispose() }
}

function Write-PeerJson([string] $Path, $Value) {
    $text = $Value | ConvertTo-Json -Depth 12 -Compress
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($text)
    if ($bytes.Length -lt 2 -or $bytes.Length -gt 16384) { throw 'PEER_RECEIPT_SIZE_INVALID' }
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.write-' + [Guid]::NewGuid().ToString('N'))
    $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $file.Write($bytes, 0, $bytes.Length)
        $file.Flush()
    } finally { $file.Dispose() }
    [IO.File]::Move($temporary, $Path)
}

function New-PeerListener([string] $Address) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($Address), 0)
    try {
        $listener.Server.ExclusiveAddressUse = $true
        $listener.Start(4)
        return $listener
    } catch {
        $listener.Stop()
        throw
    }
}

function Read-PeerFrame([Net.Sockets.NetworkStream] $Stream, [string] $Expected) {
    $bytes = [byte[]]::new($Expected.Length)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $offset = 0
    while ($offset -lt $bytes.Length) {
        $left = 1600 - [int] $timer.ElapsedMilliseconds
        if ($left -le 0) { return $false }
        $Stream.ReadTimeout = $left
        $read = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -le 0) { return $false }
        $offset += $read
    }
    return [Text.Encoding]::ASCII.GetString($bytes) -ceq $Expected
}

function Write-PeerFrame([Net.Sockets.NetworkStream] $Stream, [string] $Text) {
    $bytes = [Text.Encoding]::ASCII.GetBytes($Text)
    $Stream.WriteTimeout = 1600
    $Stream.Write($bytes, 0, $bytes.Length)
}

function Get-PeerSocketCode($Failure) {
    for ($depth = 0; $null -ne $Failure -and $depth -lt 6; $depth++) {
        if ($Failure -is [Net.Sockets.SocketException]) {
            $code = [string] $Failure.SocketErrorCode
            if ($code -in @('AccessDenied', 'TimedOut', 'ConnectionRefused', 'ConnectionReset', 'HostUnreachable',
                    'NetworkUnreachable', 'AddressNotAvailable', 'NetworkDown')) { return $code }
            return 'SOCKET_ERROR'
        }
        $Failure = $Failure.InnerException
    }
    return 'SOCKET_OR_FRAME_ERROR'
}

function Invoke-PeerDial([string] $Local, [string] $Remote, [int] $Port, [string] $Nonce, [string] $Lane) {
    $client = [Net.Sockets.TcpClient]::new([Net.Sockets.AddressFamily]::InterNetwork)
    $record = [ordered]@{ state = 'NOT_CONNECTED'; error = $null; localAddress = $null; remoteAddress = $null; remotePort = $null }
    try {
        $client.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Parse($Local), 0))
        $connect = $client.ConnectAsync([Net.IPAddress]::Parse($Remote), $Port)
        if (!$connect.Wait(3500)) {
            $record.error = 'CONNECT_DEADLINE'
            return $record
        }
        $record.localAddress = $client.Client.LocalEndPoint.Address.ToString()
        $record.remoteAddress = $client.Client.RemoteEndPoint.Address.ToString()
        $record.remotePort = $client.Client.RemoteEndPoint.Port
        if ($record.localAddress -cne $Local -or $record.remoteAddress -cne $Remote -or $record.remotePort -ne $Port) {
            $record.state = 'ENDPOINT_UNVERIFIED'
            return $record
        }
        $stream = $client.GetStream()
        $record.state = 'NONCE_UNVERIFIED'
        Write-PeerFrame $stream "CLU-E-PEER/1 $Lane $Nonce"
        if (Read-PeerFrame $stream "CLU-E-PEER/1 $Lane OK $Nonce") { $record.state = 'NONCE_MATCHED' }
    } catch { $record.error = Get-PeerSocketCode $_.Exception }
    finally { $client.Close() }
    return $record
}

function Invoke-PeerAccept([Net.Sockets.TcpListener] $Listener, [string] $Local, [string] $Remote,
    [int] $Port, [string] $Nonce, [string] $Lane, [int] $DeadlineMs) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $record = [ordered]@{ state = 'NO_CONNECTION_OBSERVED'; error = $null; localAddress = $null; remoteAddress = $null; localPort = $null }
    while ($timer.ElapsedMilliseconds -lt $DeadlineMs) {
        if (!$Listener.Pending()) {
            Start-Sleep -Milliseconds 40
            continue
        }
        $client = $Listener.AcceptTcpClient()
        try {
            $record.localAddress = $client.Client.LocalEndPoint.Address.ToString()
            $record.remoteAddress = $client.Client.RemoteEndPoint.Address.ToString()
            $record.localPort = $client.Client.LocalEndPoint.Port
            if ($record.localAddress -cne $Local -or $record.remoteAddress -cne $Remote -or $record.localPort -ne $Port) {
                $record.state = 'ENDPOINT_UNVERIFIED'
                continue
            }
            $stream = $client.GetStream()
            $record.state = 'NONCE_UNVERIFIED'
            $record.error = $null
            if (Read-PeerFrame $stream "CLU-E-PEER/1 $Lane $Nonce") {
                Write-PeerFrame $stream "CLU-E-PEER/1 $Lane OK $Nonce"
                $record.state = 'NONCE_MATCHED'
                return $record
            }
        } catch { $record.error = Get-PeerSocketCode $_.Exception }
        finally { $client.Close() }
    }
    return $record
}
