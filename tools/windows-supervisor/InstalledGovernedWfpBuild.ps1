[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Stage,
    [Parameter(Mandatory)] [string] $Node,
    [Parameter(Mandatory)] [string] $NodeSha256,
    [Parameter(Mandatory)] [string] $NpmCliSha256,
    [Parameter(Mandatory)] [string] $QualificationTemp,
    [Parameter(Mandatory)] [string] $EngineSha256,
    [Parameter(Mandatory)] [string] $OperatorSid,
    [Parameter(Mandatory)] [int] $OperatorSessionId,
    [Parameter(Mandatory)] [int] $OperatorPid
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LocalExactPath([string] $Path, [bool] $Directory) {
    if ($Path.Length -gt 1024 -or $Path -notmatch '^[A-Za-z]:\\(?!\\)' -or
        [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'WFP_BUILD_PATH_NOT_CANONICAL' }
    $root = [IO.Path]::GetPathRoot($Path)
    $drive = [IO.DriveInfo]::new($root)
    if (!$drive.IsReady -or $drive.DriveType -notin @('Fixed', 'Removable')) { throw 'WFP_BUILD_DRIVE_INVALID' }
    $parts = $Path.Substring($root.Length).Split('\')
    $current = $root
    for ($index = 0; $index -lt $parts.Length; $index++) {
        $part = $parts[$index]
        if (!$part -or $part -match '[ .]$|[<>:"|?*\x00-\x1f]|^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)') {
            throw 'WFP_BUILD_PATH_COMPONENT_INVALID'
        }
        $current = Join-Path $current $part
        $item = Get-Item -LiteralPath $current -Force
        $mustBeDirectory = $index -lt $parts.Length - 1 -or $Directory
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $mustBeDirectory) {
            throw 'WFP_BUILD_PATH_IDENTITY_INVALID'
        }
    }
}

function Assert-Image([string] $Path, [string] $Sha256, [int64] $MaximumBytes, [switch] $Microsoft) {
    Assert-LocalExactPath $Path $false
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Length -lt 1 -or $item.Length -gt $MaximumBytes -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) {
        throw 'WFP_BUILD_IMAGE_PIN_MISMATCH'
    }
    if ($Microsoft) {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Microsoft Corporation') {
            throw 'WFP_BUILD_ENGINE_SIGNATURE_INVALID'
        }
    }
}

function Copy-PinnedSource([string] $Name, [string] $Pin, [string] $Destination) {
    $file = Join-Path $PSScriptRoot $Name
    Assert-LocalExactPath $file $false
    $inputStream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($inputStream.Length -lt 1 -or $inputStream.Length -gt 1048576) { throw 'WFP_BUILD_SOURCE_SIZE_INVALID' }
        $bytes = [byte[]]::new([int] $inputStream.Length)
        for ($offset = 0; $offset -lt $bytes.Length; $offset += $read) {
            $read = $inputStream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -eq 0) { throw 'WFP_BUILD_SOURCE_SHORT_READ' }
        }
    } finally { $inputStream.Dispose() }
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $canonical = $encoding.GetBytes($encoding.GetString($bytes).Replace("`r`n", "`n"))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = [BitConverter]::ToString($sha.ComputeHash($canonical)).Replace('-', '').ToLowerInvariant()
        if ($digest -cne $Pin) { throw "WFP_BUILD_SOURCE_PIN_MISMATCH $Name" }
        if ($Name.EndsWith('.cjs', [StringComparison]::Ordinal)) {
            return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
        }
    } finally { $sha.Dispose() }
    $output = [IO.File]::Open((Join-Path $Destination $Name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $output.Write($canonical, 0, $canonical.Length) }
    finally { $output.Dispose() }
}

function Assert-ProtectedRoot([string] $Path, [string] $Dacl) {
    Assert-LocalExactPath $Path $true
    $section = [Security.AccessControl.AccessControlSections]::Access
    $security = [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($Path), $section)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
    $expected = [Security.AccessControl.RawSecurityDescriptor]::new($Dacl).DiscretionaryAcl
    $actual = $descriptor.DiscretionaryAcl
    if (!$security.AreAccessRulesProtected -or $null -eq $actual -or $actual.Count -ne $expected.Count) {
        throw 'WFP_BUILD_PROTECTED_ACL_INVALID'
    }
    $bySid = @{}
    foreach ($ace in $expected) { $bySid.Add($ace.SecurityIdentifier.Value, $ace) }
    foreach ($ace in $actual) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or
            $ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.IsCallback -or $ace.OpaqueLength -ne 0) {
            throw 'WFP_BUILD_PROTECTED_ACE_INVALID'
        }
        $sid = $ace.SecurityIdentifier.Value
        if (!$bySid.ContainsKey($sid) -or $ace.AccessMask -ne $bySid[$sid].AccessMask -or $ace.AceFlags -ne $bySid[$sid].AceFlags) {
            throw 'WFP_BUILD_PROTECTED_ACE_INVALID'
        }
        $bySid.Remove($sid)
    }
}

try {
    if (!$IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or $OperatorSessionId -le 0 -or $OperatorPid -le 0 -or
        ![Environment]::UserInteractive) { throw 'WFP_BUILD_INTERACTIVE_WINDOWS_REQUIRED' }
    if ($OperatorSid.Length -gt 128 -or $OperatorSid -cnotmatch '\AS-1(?:-[0-9]{1,15}){2,16}\z' -or
        [Security.Principal.SecurityIdentifier]::new($OperatorSid).Value -cne $OperatorSid -or
        $NodeSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $NpmCliSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
        $EngineSha256 -cne '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a') {
        throw 'WFP_BUILD_ARGUMENTS_INVALID'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($identity.User.Value -cne $OperatorSid -or
            !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'WFP_BUILD_SAME_ACCOUNT_ELEVATION_REQUIRED'
        }
    } finally { $identity.Dispose() }
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try {
        if ($self.SessionId -ne $OperatorSessionId) { throw 'WFP_BUILD_OPERATOR_SESSION_MISMATCH' }
    } finally { $self.Dispose() }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class ClueGovernedWfpOperator
{
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int kind,
        out uint value, uint length, out uint written);
    public static bool Verify(IntPtr process, string sid)
    {
        SafeAccessTokenHandle token;
        if (!OpenProcessToken(process, 8, out token)) return false;
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
        {
            uint elevated, written;
            return identity.User.Value == sid && GetTokenInformation(token, 20, out elevated, 4, out written) &&
                written == 4 && elevated == 0;
        }
    }
}
'@
    $operator = [Diagnostics.Process]::GetProcessById($OperatorPid)
    try {
        if ($operator.SessionId -ne $OperatorSessionId -or $operator.HasExited -or
            ![ClueGovernedWfpOperator]::Verify($operator.Handle, $OperatorSid)) {
            throw 'WFP_BUILD_OPERATOR_TOKEN_INVALID'
        }
        Assert-LocalExactPath $Stage $true
        $stageName = Split-Path -Leaf $Stage
        if ($stageName -cnotmatch '\A\.setup-([a-f0-9]{32})\z') { throw 'WFP_BUILD_STAGE_ID_INVALID' }
        $runId = $Matches[1]
        $admission = Join-Path $Stage 'admission'
        $stageEngine = Join-Path $Stage 'bin\wxc-exec.exe'
        Assert-LocalExactPath $admission $true
        Assert-LocalExactPath $QualificationTemp $true
        if ((Split-Path -Leaf $Node) -ine 'node.exe') { throw 'WFP_BUILD_NODE_PATH_INVALID' }
        Assert-Image $Node $NodeSha256 134217728
        $npm = Join-Path (Split-Path -Parent $Node) 'node_modules\npm\bin\npm-cli.js'
        Assert-Image $npm $NpmCliSha256 1048576
        Assert-Image $stageEngine $EngineSha256 134217728 -Microsoft

        $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
        Assert-LocalExactPath $programFiles $true
        $protectedRoot = Join-Path $programFiles ".clue-governed-wfp-$runId"
        $dacl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;RC;;;OW)(A;OICI;0x1200a9;;;$OperatorSid)"
        if (Test-Path -LiteralPath $protectedRoot) { throw 'WFP_BUILD_PROTECTED_STAGE_COLLISION' }
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetSecurityDescriptorSddlForm($dacl, [Security.AccessControl.AccessControlSections]::Access)
        $null = [IO.FileSystemAclExtensions]::CreateDirectory($security, $protectedRoot)
        Assert-ProtectedRoot $protectedRoot $dacl
        $sourceDir = Join-Path $protectedRoot 'sources'
        $bin = Join-Path $protectedRoot 'bin'
        $null = [IO.Directory]::CreateDirectory($sourceDir)
        $null = [IO.Directory]::CreateDirectory($bin)
        $engine = Join-Path $bin 'wxc-exec.exe'
        [IO.File]::Copy($stageEngine, $engine, $false)
        Assert-Image $engine $EngineSha256 134217728 -Microsoft
        $sourcePins = [ordered]@{
            'Supervisor.cs' = '11fc51e50823a80edcb99ff93bc808c8026e687e01bb061bbb0e272c3157e6f3'
            'Protocol.cs' = '5cb1fe80aa78cc8f8f0ecc9f6fa7a5a4c5de22bd82901d44e5525794f2f9194a'
            'NativeJob.cs' = '11db6d635accb80083b198aa2c78a49fb6b3f7952011946e4fda430e95e2618d'
            'WfpBootstrapRun.cs' = '92bfb701d33f672bc3788c3d67a74d0bc7baf96d11f41597989e4c869e74f990'
            'WfpContainerIdentity.cs' = 'adf701f021cba2cf6de73660e8f890ce18fa1de690cbf227059154e41442bb34'
            'WfpLoopbackLease.cs' = '22f6da4c0a380763e00c17892b10452c3746a42c346e63467e997d077e60c9d0'
            'WfpDropObservation.cs' = 'f9131d325ce6f30d77840d2f786b1ca2898e82338156aa98b7cb3f8c0946510b'
            'WfpBfeWatch.cs' = '6fa8d9c9f7865a35783082f11fb210a64f28705b8f63431c016288a34fc5ab4c'
            'WfpIntegratedRun.cs' = '330e5be0f639f99aefb9ecb87ed29fe3d894fd5ca68c5ecb9292ab5e9a5e7c1d'
            'WfpIntegratedGuardian.cs' = '40b513253d0b1740469ec3604cbb75063a900379ed5b1b2fad203d0753bbd4c5'
            'GovernedWorkloadBootstrap.cjs' = '1350631e94c3fa7ce45a74ca298d5e8bea6b983fab1c0c465be97b90bf871ae6'
            'GovernedWfpBindPrelude.cjs' = '2951a6d40a48426c31dd678c74d0d89627f7ea1638898cf1e1c7c3161d907f65'
        }
        $sources = foreach ($source in $sourcePins.Keys) {
            if ($source.EndsWith('.cs', [StringComparison]::Ordinal)) {
                Copy-PinnedSource $source $sourcePins[$source] $sourceDir
                Join-Path $sourceDir $source
            }
        }
        $bootstrapHash = Copy-PinnedSource 'GovernedWorkloadBootstrap.cjs' $sourcePins['GovernedWorkloadBootstrap.cjs'] $sourceDir
        $preludeHash = Copy-PinnedSource 'GovernedWfpBindPrelude.cjs' $sourcePins['GovernedWfpBindPrelude.cjs'] $sourceDir
        $pinSource = Join-Path $sourceDir 'MxcPin.cs'
        $generatedPin = @"
internal static class MxcPin {
    internal const string Sha256 = "$EngineSha256";
    internal const string QualificationTempRoot = @"$QualificationTemp";
    internal const string QualificationNodeExe = @"$Node";
    internal const string ProofAdmissionStage = @"$admission";
    internal const string ProofAdmissionScriptSha256 = "$bootstrapHash";
    internal const bool ProofAdmissionReviewedWorkload = false;
    internal const bool ProofAdmissionGovernedWorkload = true;
    internal const string ProofAdmissionNpmCliSha256 = "$NpmCliSha256";
    internal const bool GovernedWfpIntegration = true;
    internal const string GovernedWfpPreludeSha256 = "$preludeHash";
    internal const int GovernedWfpOperatorPid = $OperatorPid;
}
"@
        [IO.File]::WriteAllText($pinSource, $generatedPin)
        $systemRoot = Split-Path -Parent ([Environment]::SystemDirectory)
        $framework = Join-Path $systemRoot 'Microsoft.NET\Framework64\v4.0.30319'
        $csc = Join-Path $framework 'csc.exe'
        $web = Join-Path $systemRoot 'Microsoft.NET\assembly\GAC_MSIL\System.Web.Extensions\v4.0_4.0.0.0__31bf3856ad364e35\System.Web.Extensions.dll'
        Assert-LocalExactPath $csc $false
        Assert-LocalExactPath $web $false
        $wrapper = Join-Path $bin 'CLU-E-Windows-Supervisor.exe'
        $compiler = [Diagnostics.ProcessStartInfo]::new()
        $compiler.FileName = $csc
        $compiler.WorkingDirectory = $protectedRoot
        $compiler.UseShellExecute = $false
        $references = @('mscorlib.dll', 'System.dll', 'System.Core.dll') | ForEach-Object {
            $reference = Join-Path $framework $_
            Assert-LocalExactPath $reference $false
            '/reference:' + $reference
        }
        $compilerArgs = @('/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/optimize+', '/langversion:5',
            '/codepage:65001', '/platform:anycpu', '/main:Supervisor', "/out:$wrapper", "/reference:$web") +
            $references + $sources + $pinSource
        foreach ($argument in $compilerArgs) { $compiler.ArgumentList.Add($argument) }
        $compiler.Environment.Clear()
        $compiler.Environment['SystemRoot'] = $systemRoot
        $compiler.Environment['WINDIR'] = $systemRoot
        $compiler.Environment['PATH'] = [Environment]::SystemDirectory
        $compiler.Environment['TEMP'] = $protectedRoot
        $compiler.Environment['TMP'] = $protectedRoot
        $build = [Diagnostics.Process]::Start($compiler)
        try {
            if (!$build.WaitForExit(60000)) { $build.Kill(); throw 'WFP_BUILD_COMPILER_TIMEOUT' }
            if ($build.ExitCode -ne 0) { throw 'WFP_BUILD_COMPILER_FAILED' }
        } finally { $build.Dispose() }
        Assert-LocalExactPath $wrapper $false
        if (@(Get-ChildItem -LiteralPath $bin -Force).Count -ne 2) { throw 'WFP_BUILD_IMAGE_LAYOUT_INVALID' }
        $wrapperHash = (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant()
        $destination = Join-Path $protectedRoot $wrapperHash
        [IO.Directory]::Move($bin, $destination)
        $wrapper = Join-Path $destination 'CLU-E-Windows-Supervisor.exe'
        $engine = Join-Path $destination 'wxc-exec.exe'
        Assert-Image $wrapper $wrapperHash 134217728
        Assert-Image $engine $EngineSha256 134217728 -Microsoft
        Assert-ProtectedRoot $protectedRoot $dacl
        if ($operator.HasExited) { throw 'WFP_BUILD_OPERATOR_EXITED' }

        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $wrapper
        $start.WorkingDirectory = $destination
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.ArgumentList.Add('--governed-wfp-guardian')
        $start.Environment.Clear()
        $start.Environment['SystemRoot'] = $systemRoot
        $start.Environment['WINDIR'] = $systemRoot
        $start.Environment['PATH'] = [Environment]::SystemDirectory
        $guardian = [Diagnostics.Process]::Start($start)
        try {
            $listening = Join-Path $protectedRoot 'guardian-listening.txt'
            $clock = [Diagnostics.Stopwatch]::StartNew()
            while (![IO.File]::Exists($listening) -and $clock.ElapsedMilliseconds -lt 8000 -and
                !$guardian.HasExited -and !$operator.HasExited) {
                Start-Sleep -Milliseconds 50
            }
            if ($guardian.HasExited -or $operator.HasExited -or ![IO.File]::Exists($listening)) {
                throw 'WFP_BUILD_GUARDIAN_START_FAILED'
            }
            Assert-LocalExactPath $listening $false
            if ((Get-Item -LiteralPath $listening -Force).Length -ne 5 -or
                [IO.File]::ReadAllText($listening, [Text.Encoding]::ASCII) -cne 'READY') {
                throw 'WFP_BUILD_GUARDIAN_MARKER_INVALID'
            }
            $receipt = [ordered]@{
                schemaVersion = 'clue-governed-wfp-installed-image/1'
                wrapperSha256 = $wrapperHash
                engineSha256 = $EngineSha256
                guardianPid = $guardian.Id
            }
            $ready = Join-Path $protectedRoot 'ready.json'
            $temporary = Join-Path $protectedRoot ('ready-' + [Guid]::NewGuid().ToString('N') + '.tmp')
            $bytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress))
            $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) }
            finally { $file.Dispose() }
            [IO.File]::Move($temporary, $ready)
        } finally { $guardian.Dispose() }
    } finally { $operator.Dispose() }
    exit 0
} catch {
    Write-Host ('CLU-E governed WFP build stopped. ' + $_.Exception.Message)
    exit 1
}
