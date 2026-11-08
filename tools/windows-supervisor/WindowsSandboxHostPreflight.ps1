$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Test-SandboxAlias([string] $Path) {
    try {
        $item = Get-Item -LiteralPath $Path -Force
        return $item -is [IO.FileInfo] -and $item.Length -eq 0 -and
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -and
            $item.LinkType -notin @('SymbolicLink', 'Junction')
    } catch {
        return $false
    }
}

$result = [ordered]@{
    edition = 'UNKNOWN'
    feature = 'UNKNOWN'
    hypervisorPresent = $null
    appVersion = $null
    cliKind = $null
    cliPath = $null
}

try {
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $editionId = (Get-ItemProperty -LiteralPath $key -Name EditionID).EditionID
    if ($editionId -match '^Core(?:N|SingleLanguage|CountrySpecific)?$') {
        $result.edition = 'HOME'
    } elseif ($editionId -match '^(?:Professional(?:Education|Workstation)?N?|EducationN?|EnterpriseS?N?(?:Eval)?|CloudEditionN?)$') {
        $result.edition = 'SUPPORTED'
    }
} catch { }

try {
    $features = @(Get-CimInstance -ClassName Win32_OptionalFeature -Property InstallState `
        -Filter "Name = 'Containers-DisposableClientVM'" -OperationTimeoutSec 5)
    if ($features.Count -eq 0) {
        $result.feature = 'ABSENT'
    } elseif ($features.Count -eq 1) {
        $result.feature = switch ($features[0].InstallState) {
            1 { 'ENABLED' }
            2 { 'DISABLED' }
            3 { 'ABSENT' }
            default { 'UNKNOWN' }
        }
    }
} catch { }

try {
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem -Property HypervisorPresent -OperationTimeoutSec 5
    if ($computer.HypervisorPresent -is [bool]) {
        $result.hypervisorPresent = $computer.HypervisorPresent
    }
} catch { }

$packages = @(
    foreach ($name in @('MicrosoftWindows.WindowsSandbox', 'WindowsSandbox')) {
        try {
            Get-AppxPackage -Name $name | Where-Object {
                $_.Name -ceq $name -and $_.PublisherId -in @('cw5n1h2txyewy', '8wekyb3d8bbwe') -and
                    [string] $_.SignatureKind -in @('Store', 'System') -and
                    $_.PackageFamilyName -ceq ($name + '_' + $_.PublisherId) -and
                    [string] $_.Version -cmatch '\A[0-9]{1,8}(?:\.[0-9]{1,8}){3}\z'
            }
        } catch { }
    }
)
$packages = @($packages | Sort-Object -Property Version -Descending)

if ($packages.Count -gt 0) {
    $result.appVersion = [string] $packages[0].Version
    try {
        $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if ($local) {
            $aliases = Join-Path $local 'Microsoft\WindowsApps'
            foreach ($package in $packages) {
                $alias = Join-Path (Join-Path $aliases $package.PackageFamilyName) 'wsb.exe'
                if (Test-SandboxAlias $alias) {
                    $result.appVersion = [string] $package.Version
                    $result.cliKind = 'PACKAGE_ALIAS'
                    $result.cliPath = $alias
                    break
                }
            }
            if ($null -eq $result.cliPath) {
                $alias = Join-Path $aliases 'wsb.exe'
                if (Test-SandboxAlias $alias) {
                    $result.cliKind = 'USER_ALIAS'
                    $result.cliPath = $alias
                }
            }
        }
    } catch { }
}

if ($null -eq $result.cliPath) {
    try {
        $system = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
        $cli = Get-Item -LiteralPath (Join-Path $system 'wsb.exe') -Force
        if ($cli -is [IO.FileInfo] -and $cli.Length -gt 0 -and
            ($cli.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            $signature = Get-AuthenticodeSignature -LiteralPath $cli.FullName
            if ($signature.Status -eq 'Valid' -and $null -ne $signature.SignerCertificate) {
                $nameType = [Security.Cryptography.X509Certificates.X509NameType]::SimpleName
                $signer = $signature.SignerCertificate.GetNameInfo($nameType, $false)
                if ($signer -in @('Microsoft Windows', 'Microsoft Corporation', 'Microsoft Windows Publisher')) {
                    $result.cliKind = 'SYSTEM32'
                    $result.cliPath = $cli.FullName
                }
            }
        }
    } catch { }
}

# Windows PowerShell 5.1 can redirect through a legacy code page. Write explicit UTF-8.
$bytes = [Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Compress))
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
