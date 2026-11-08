[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int] $SupervisorPid,
    [Parameter(Mandatory = $true)][string] $SupervisorPath,
    [Parameter(Mandatory = $true)][string] $FixturePath,
    [Parameter(Mandatory = $true)][string] $ReadyPath,
    [Parameter(Mandatory = $true)][string] $Workspace,
    [switch] $DoubleLoss
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-CrashReady([string] $Path) {
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $entry) { return $null }
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $entry.Length -lt 1 -or $entry.Length -gt 1024) { throw 'CRASH_READY_FILE_INVALID' }

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 1024) { throw 'CRASH_READY_FILE_INVALID' }
        $reader = [IO.StreamReader]::new($stream)
        try { return ($reader.ReadToEnd() | ConvertFrom-Json -AsHashtable) }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-CrashPath([string] $Path, [bool] $AllowMissingFile, [bool] $DirectoryLeaf = $false) {
    if ($Path -cnotmatch '^[A-Za-z]:\\' -or
        ![string]::Equals([IO.Path]::GetFullPath($Path), $Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CRASH_PATH_INVALID'
    }
    $current = $Path
    $leaf = $true
    while ($null -ne $current) {
        $entry = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -eq $entry) {
            if (!$leaf -or !$AllowMissingFile) { throw 'CRASH_PATH_INVALID' }
        } elseif (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            ($entry.PSIsContainer -ne (!$leaf -or $DirectoryLeaf))) {
            throw 'CRASH_PATH_INVALID'
        }
        $leaf = $false
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Read-CrashEscape([string] $Path, [bool] $FixtureTreeExited) {
    try { $entry = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] {
        if ($FixtureTreeExited) { return $false }
        return $null
    }
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Length -ne 5) {
        return $null
    }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -ne 5) { return $null }
        $reader = [IO.BinaryReader]::new($stream)
        try {
            if ([Text.Encoding]::ASCII.GetString($reader.ReadBytes(5)) -ceq 'BOUND') { return $true }
            return $null
        } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Write-RecoveryAcknowledgement([string] $Path) {
    Assert-CrashPath $Path $true
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::ASCII.GetBytes('VERIFIED')
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $Path)
    } finally { [IO.File]::Delete($temporary) }
}

$report = [ordered]@{
    state = 'STATIC_OBSERVER_PREREQUISITE_FAILED'
    terminationRequested = $false
    supervisorTerminationRequested = $false
    supervisorExited = $false
    supervisorLive = $null
    supervisorLiveBeforeRecovery = $false
    guardianExited = $false
    fixtureTreeExited = $false
    jobMembersObserved = 0
    jobMembersExited = $false
    staticProtectionRetained = $false
    recoveryAcknowledgementWritten = $false
    recoveryExitCode = $null
    filtersRemoved = $false
    samples = 0
    error = $null
    escapeDetected = $null
}
$watch = $null
$image = $null
$intent = $null
$recovery = $null
try {
    if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'STATIC_WINDOWS_REQUIRED' }
    Assert-CrashPath $SupervisorPath $false
    Assert-CrashPath $FixturePath $false
    Assert-CrashPath $ReadyPath $true
    Assert-CrashPath $Workspace $false $true
    $caseRoot = [IO.Path]::GetDirectoryName($Workspace)
    $privateRoot = [IO.Path]::Combine($caseRoot, 'private')
    $ackPath = [IO.Path]::Combine($privateRoot, 'static-recovery-allowed.txt')
    $intentPath = [IO.Path]::Combine($privateRoot, 'static-intent.json')
    $stageRoot = [IO.Path]::GetDirectoryName($caseRoot)
    $caseName = if ($DoubleLoss) { 'static-double' } else { 'static-crash' }
    if (![string]::Equals([IO.Path]::GetFileName($Workspace), 'workspace', [StringComparison]::OrdinalIgnoreCase) -or
        ![string]::Equals([IO.Path]::GetFileName($caseRoot), $caseName, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($stageRoot) -cnotmatch '^\.setup-[0-9a-f]{32}$' -or
        ![string]::Equals([IO.Path]::Combine($privateRoot, 'ready.json'), $ReadyPath,
            [StringComparison]::OrdinalIgnoreCase)) { throw 'STATIC_READY_SCOPE_INVALID' }
    Assert-CrashPath $ackPath $true
    if ($null -ne (Get-Item -LiteralPath $ackPath -Force -ErrorAction SilentlyContinue)) {
        throw 'STATIC_RECOVERY_MARKER_NOT_FRESH'
    }
    if (![string]::Equals([IO.Path]::Combine($stageRoot, 'bin', 'CLU-E-WfpPairedDiagnostic.exe'),
            $SupervisorPath, [StringComparison]::OrdinalIgnoreCase) -or
        ![string]::Equals([IO.Path]::Combine($stageRoot, 'fixture', 'WfpPairedFixture.exe'),
            $FixturePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'STATIC_IMAGE_SCOPE_INVALID' }

    # Keep the exact recovery image open without write or delete sharing through recovery.
    $image = [IO.File]::Open($SupervisorPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($null -eq ('Clue.Diagnostics.WfpStaticCrashWatch' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Clue.Diagnostics
{
    public sealed class WfpStaticCrashWatch : IDisposable
    {
        private const uint QueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x100000;
        private const uint Terminate = 1;
        private const uint WaitSignaled = 0;
        private const uint WaitTimedOut = 258;
        private const uint FilterNotFound = 0x80320003;
        private const uint SublayerNotFound = 0x80320007;
        // Persistent, boot-time, provider context, permit on unavailable callout, or disabled.
        private const uint UnsafeFilterFlags = 1 | 2 | 4 | 16 | 32;
        private readonly bool doubleLoss;
        private readonly IntPtr[] fixtures = new IntPtr[3];
        private IntPtr[] additionalJobMembers = new IntPtr[0];
        private IntPtr supervisor;
        private IntPtr guardian;
        private IntPtr engine;
        private Guid[] filterKeys;

        public WfpStaticCrashWatch(int supervisorPid, string supervisorImage, bool doubleLoss)
        {
            this.doubleLoss = doubleLoss;
            uint access = QueryLimitedInformation | Synchronize;
            if (doubleLoss) access |= Terminate;
            supervisor = OpenExact(supervisorPid, supervisorImage, access);
        }

        public bool SupervisorLive { get { return IsLive(supervisor); } }

        public sealed class Observation
        {
            public string State = "STATIC_PREFLIGHT_UNVERIFIED";
            public bool TerminationRequested;
            public bool SupervisorTerminationRequested;
            public bool SupervisorExited;
            public bool GuardianExited;
            public bool FixtureTreeExited;
            public int JobMembersObserved;
            public bool JobMembersExited;
            public bool StaticProtectionRetained;
            public int Samples;
        }

        public Observation Observe(int guardianPid, string guardianImage, int[] fixturePids,
            string fixtureImage, int[] additionalJobPids, ulong[] filterIds, Guid sublayerKey)
        {
            var evidence = new Observation();
            try
            {
                guardian = OpenExact(guardianPid, guardianImage, QueryLimitedInformation | Synchronize | Terminate);
                for (int index = 0; index < fixtures.Length; index++)
                    fixtures[index] = OpenExact(fixturePids[index], fixtureImage, QueryLimitedInformation | Synchronize);
                additionalJobMembers = new IntPtr[additionalJobPids.Length];
                for (int index = 0; index < additionalJobMembers.Length; index++)
                    additionalJobMembers[index] = OpenExact(additionalJobPids[index], null,
                        QueryLimitedInformation | Synchronize);
                evidence.JobMembersObserved = fixtures.Length + additionalJobMembers.Length;
                if (FwpmEngineOpen0(null, 10, IntPtr.Zero, IntPtr.Zero, out engine) != 0 || engine == IntPtr.Zero)
                    throw new InvalidOperationException("STATIC_WFP_QUERY_UNAVAILABLE");

                filterKeys = new Guid[filterIds.Length];
                if (ReadFilters(filterIds, sublayerKey, true) != filterIds.Length + 1 ||
                    CountLive(fixtures) + CountLive(additionalJobMembers) != evidence.JobMembersObserved ||
                    !SupervisorLive || !IsLive(guardian)) return evidence;
                // The observer retains process handles only. It never opens or duplicates the job handle.
                if (doubleLoss)
                {
                    if (!TerminateProcess(supervisor, 125))
                    {
                        evidence.State = "STATIC_COORDINATOR_TERMINATION_REFUSED";
                        return evidence;
                    }
                    evidence.SupervisorTerminationRequested = true;
                    if (WaitForSingleObject(supervisor, 2000) != WaitSignaled)
                    {
                        evidence.State = "STATIC_COORDINATOR_EXIT_UNCONFIRMED";
                        return evidence;
                    }
                    evidence.SupervisorExited = true;
                    // Reconfirm the fault target and policy after the first kill. A guardian
                    // that already exited or drained the job cannot qualify as a second fault.
                    if (!IsLive(guardian) ||
                        CountLive(fixtures) + CountLive(additionalJobMembers) != evidence.JobMembersObserved ||
                        ReadFilters(filterIds, sublayerKey, false) != filterIds.Length + 1)
                    {
                        evidence.State = "STATIC_DOUBLE_LOSS_SECOND_FAULT_UNVERIFIED";
                        return evidence;
                    }
                }
                if (!TerminateProcess(guardian, 125))
                {
                    evidence.State = "STATIC_GUARDIAN_TERMINATION_REFUSED";
                    return evidence;
                }
                evidence.TerminationRequested = true;
                var timer = Stopwatch.StartNew();
                do
                {
                    evidence.GuardianExited = !IsLive(guardian);
                    evidence.FixtureTreeExited = CountLive(fixtures) == 0;
                    evidence.JobMembersExited = evidence.FixtureTreeExited && CountLive(additionalJobMembers) == 0;
                    int present = ReadFilters(filterIds, sublayerKey, false);
                    evidence.Samples++;
                    if (present != filterIds.Length + 1)
                    {
                        evidence.State = "STATIC_POLICY_LOST_BEFORE_RECOVERY";
                        return evidence;
                    }
                    if (!doubleLoss && !SupervisorLive)
                    {
                        evidence.State = "STATIC_COORDINATOR_EXITED_DURING_OBSERVATION";
                        return evidence;
                    }
                    if (evidence.GuardianExited && evidence.JobMembersExited)
                    {
                        evidence.StaticProtectionRetained = true;
                        evidence.State = "STATIC_POLICY_RETAINED_AFTER_GUARDIAN_EXIT";
                        return evidence;
                    }
                    Thread.Sleep(10);
                } while (timer.ElapsedMilliseconds < 9000);
                evidence.State = "STATIC_FIXTURE_EXIT_UNCONFIRMED";
            }
            catch (Exception failure)
            {
                string message = failure.Message;
                evidence.State = message == "STATIC_WFP_QUERY_UNAVAILABLE" || message == "STATIC_WFP_SCOPE_UNVERIFIED" ||
                    message == "STATIC_PROCESS_IDENTITY_UNVERIFIED" || message == "STATIC_PROCESS_OPEN_FAILED" ||
                    message == "STATIC_PROCESS_WAIT_FAILED" || message == "STATIC_WFP_QUERY_FAILED"
                    ? message : "STATIC_OBSERVATION_FAILED";
            }
            return evidence;
        }

        public bool VerifyRemoved(ulong[] filterIds, Guid sublayerKey)
        {
            var timer = Stopwatch.StartNew();
            do
            {
                if (ReadFilters(filterIds, sublayerKey, false) == 0) return true;
                Thread.Sleep(20);
            } while (timer.ElapsedMilliseconds < 1000);
            return false;
        }

        public bool VerifyRetained(ulong[] filterIds, Guid sublayerKey)
        {
            return SupervisorLive != doubleLoss && !IsLive(guardian) && CountLive(fixtures) == 0 &&
                CountLive(additionalJobMembers) == 0 &&
                ReadFilters(filterIds, sublayerKey, false) == filterIds.Length + 1;
        }

        private static int CountLive(IntPtr[] processes)
        {
            int live = 0;
            foreach (IntPtr handle in processes) if (IsLive(handle)) live++;
            return live;
        }

        private static bool IsLive(IntPtr process)
        {
            uint result = WaitForSingleObject(process, 0);
            if (result == WaitTimedOut) return true;
            if (result == WaitSignaled) return false;
            throw new InvalidOperationException("STATIC_PROCESS_WAIT_FAILED");
        }

        private static IntPtr OpenExact(int processId, string image, uint access)
        {
            IntPtr handle = OpenProcess(access, false, processId);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("STATIC_PROCESS_OPEN_FAILED");
            try
            {
                var name = new StringBuilder(32768);
                int capacity = name.Capacity;
                if ((image != null && (!QueryFullProcessImageNameW(handle, 0, name, ref capacity) ||
                    !String.Equals(Path.GetFullPath(name.ToString()), image, StringComparison.OrdinalIgnoreCase))) ||
                    !IsLive(handle)) throw new InvalidOperationException("STATIC_PROCESS_IDENTITY_UNVERIFIED");
                return handle;
            }
            catch
            {
                CloseHandle(handle);
                throw;
            }
        }

        private int ReadFilters(ulong[] ids, Guid key, bool rememberKeys)
        {
            int count = 0;
            for (int index = 0; index < ids.Length; index++)
            {
                IntPtr value;
                uint code = FwpmFilterGetById0(engine, ids[index], out value);
                try
                {
                    if (code == FilterNotFound) continue;
                    if (code != 0 || value == IntPtr.Zero) throw new InvalidOperationException("STATIC_WFP_QUERY_FAILED");
                    var prefix = Marshal.PtrToStructure<FilterPrefix>(value);
                    if (prefix.FilterKey == Guid.Empty || prefix.SublayerKey != key ||
                        (prefix.Flags & UnsafeFilterFlags) != 0 ||
                        (!rememberKeys && prefix.FilterKey != filterKeys[index]))
                        throw new InvalidOperationException("STATIC_WFP_SCOPE_UNVERIFIED");
                    if (rememberKeys) filterKeys[index] = prefix.FilterKey;
                    count++;
                }
                finally { if (value != IntPtr.Zero) FwpmFreeMemory0(ref value); }
            }

            IntPtr sublayer;
            uint layerCode = FwpmSubLayerGetByKey0(engine, ref key, out sublayer);
            try
            {
                if (layerCode == SublayerNotFound) return count;
                if (layerCode != 0 || sublayer == IntPtr.Zero) throw new InvalidOperationException("STATIC_WFP_QUERY_FAILED");
                var prefix = Marshal.PtrToStructure<ObjectPrefix>(sublayer);
                if (prefix.Key != key || (prefix.Flags & 1) != 0)
                    throw new InvalidOperationException("STATIC_WFP_SCOPE_UNVERIFIED");
                return count + 1;
            }
            finally { if (sublayer != IntPtr.Zero) FwpmFreeMemory0(ref sublayer); }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ObjectPrefix
        {
            public Guid Key;
            public IntPtr DisplayName;
            public IntPtr DisplayDescription;
            public uint Flags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Blob
        {
            public uint Size;
            public IntPtr Data;
        }

        // FWPM_FILTER0 fields through subLayerKey. The remainder is not read.
        [StructLayout(LayoutKind.Sequential)]
        private struct FilterPrefix
        {
            public Guid FilterKey;
            public IntPtr DisplayName;
            public IntPtr DisplayDescription;
            public uint Flags;
            public IntPtr ProviderKey;
            public Blob ProviderData;
            public Guid LayerKey;
            public Guid SublayerKey;
        }

        public void Dispose()
        {
            if (engine != IntPtr.Zero) FwpmEngineClose0(engine);
            if (supervisor != IntPtr.Zero) CloseHandle(supervisor);
            if (guardian != IntPtr.Zero) CloseHandle(guardian);
            foreach (IntPtr fixture in fixtures) if (fixture != IntPtr.Zero) CloseHandle(fixture);
            foreach (IntPtr member in additionalJobMembers) if (member != IntPtr.Zero) CloseHandle(member);
        }

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int processId);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int capacity);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint FwpmEngineOpen0(string server, uint authn, IntPtr identity, IntPtr session, out IntPtr engine);
        [DllImport("fwpuclnt.dll", ExactSpelling = true)]
        private static extern uint FwpmEngineClose0(IntPtr engine);
        [DllImport("fwpuclnt.dll", ExactSpelling = true)]
        private static extern uint FwpmFilterGetById0(IntPtr engine, ulong id, out IntPtr filter);
        [DllImport("fwpuclnt.dll", ExactSpelling = true)]
        private static extern uint FwpmSubLayerGetByKey0(IntPtr engine, ref Guid key, out IntPtr sublayer);
        [DllImport("fwpuclnt.dll", ExactSpelling = true)]
        private static extern void FwpmFreeMemory0(ref IntPtr pointer);
    }
}
'@
    }

    $report.state = 'STATIC_COORDINATOR_IDENTITY_UNVERIFIED'
    $watch = [Clue.Diagnostics.WfpStaticCrashWatch]::new($SupervisorPid, $SupervisorPath, [bool] $DoubleLoss)
    $report.state = 'STATIC_READY_NOT_OBSERVED'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $ready = $null
    while ($clock.ElapsedMilliseconds -lt 10000 -and $watch.SupervisorLive) {
        $ready = Read-CrashReady $ReadyPath
        if ($null -ne $ready) { break }
        Start-Sleep -Milliseconds 20
    }
    if ($null -eq $ready) { throw $report.state }

    $report.state = 'STATIC_READY_INVALID'
    if ($ready -isnot [Collections.IDictionary] -or $ready.Count -ne 6 -or
        ($ready['supervisorPid'] -isnot [int] -and $ready['supervisorPid'] -isnot [long]) -or
        $ready['supervisorPid'] -ne $SupervisorPid -or
        ($ready['guardianPid'] -isnot [int] -and $ready['guardianPid'] -isnot [long]) -or
        $ready['guardianPid'] -lt 1 -or $ready['guardianPid'] -gt [int]::MaxValue -or
        $ready['guardianPid'] -eq $SupervisorPid -or
        $ready['fixturePids'] -isnot [array] -or $ready['fixturePids'].Count -ne 3 -or
        $ready['jobPids'] -isnot [array] -or $ready['jobPids'].Count -lt 3 -or $ready['jobPids'].Count -gt 32 -or
        $ready['filterIds'] -isnot [array] -or $ready['filterIds'].Count -ne 6 -or
        $ready['sublayerKey'] -isnot [string]) { throw $report.state }

    $uniquePids = [Collections.Generic.HashSet[int]]::new()
    $fixturePids = foreach ($fixtureProcessId in $ready['fixturePids']) {
        if (($fixtureProcessId -isnot [int] -and $fixtureProcessId -isnot [long]) -or
            $fixtureProcessId -lt 1 -or $fixtureProcessId -gt [int]::MaxValue -or
            $fixtureProcessId -eq $SupervisorPid -or $fixtureProcessId -eq $ready['guardianPid'] -or
            !$uniquePids.Add([int] $fixtureProcessId)) { throw $report.state }
        [int] $fixtureProcessId
    }
    $uniqueJobPids = [Collections.Generic.HashSet[int]]::new()
    $additionalJobPids = @(foreach ($jobProcessId in $ready['jobPids']) {
        if (($jobProcessId -isnot [int] -and $jobProcessId -isnot [long]) -or
            $jobProcessId -lt 1 -or $jobProcessId -gt [int]::MaxValue -or
            $jobProcessId -eq $SupervisorPid -or $jobProcessId -eq $ready['guardianPid'] -or
            !$uniqueJobPids.Add([int] $jobProcessId)) { throw $report.state }
        if (!$uniquePids.Contains([int] $jobProcessId)) { [int] $jobProcessId }
    })
    if (!$uniqueJobPids.IsSupersetOf($uniquePids)) { throw $report.state }

    $uniqueFilters = [Collections.Generic.HashSet[uint64]]::new()
    $filterIds = foreach ($filterId in $ready['filterIds']) {
        [uint64] $numeric = 0
        if ($filterId -isnot [string] -or $filterId -cnotmatch '^[1-9][0-9]{0,19}$' -or
            ![uint64]::TryParse($filterId, [Globalization.NumberStyles]::None,
                [Globalization.CultureInfo]::InvariantCulture, [ref] $numeric) -or
            !$uniqueFilters.Add($numeric)) { throw $report.state }
        $numeric
    }
    $sublayer = [Guid]::Empty
    if (![Guid]::TryParseExact($ready['sublayerKey'], 'D', [ref] $sublayer) -or $sublayer -eq [Guid]::Empty) {
        throw $report.state
    }

    $report.state = 'STATIC_RECOVERY_INTENT_UNVERIFIED'
    Assert-CrashPath $intentPath $false
    # Keep the published intent readable and immutable until the recovery process finishes.
    $intent = [IO.File]::Open($intentPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($intent.Length -lt 1 -or $intent.Length -gt 8192) { throw $report.state }

    $report.state = 'STATIC_OBSERVER_INVOCATION_FAILED'
    $result = $watch.Observe([int] $ready['guardianPid'], $SupervisorPath, [int[]] $fixturePids,
        $FixturePath, [int[]] $additionalJobPids, [uint64[]] $filterIds, $sublayer)
    $report.state = $result.State
    $report.terminationRequested = $result.TerminationRequested
    $report.supervisorTerminationRequested = $result.SupervisorTerminationRequested
    $report.supervisorExited = $result.SupervisorExited
    $report.guardianExited = $result.GuardianExited
    $report.fixtureTreeExited = $result.FixtureTreeExited
    $report.jobMembersObserved = $result.JobMembersObserved
    $report.jobMembersExited = $result.JobMembersExited
    $report.staticProtectionRetained = $result.StaticProtectionRetained
    $report.samples = $result.Samples
    if (!$result.StaticProtectionRetained) { throw $report.state }

    $report.state = 'STATIC_FIXTURE_ESCAPE_UNVERIFIED'
    $escapeChecks = foreach ($name in @('crash-escape.txt', 'crash-child-escape.txt', 'crash-grandchild-escape.txt')) {
        Read-CrashEscape ([IO.Path]::Combine($Workspace, $name)) $result.FixtureTreeExited
    }
    if (@($escapeChecks).Count -ne 3 -or $escapeChecks -contains $null) {
        throw $report.state
    }
    $report.escapeDetected = $escapeChecks -contains $true
    if ($report.escapeDetected) {
        $report.state = 'STATIC_FIXTURE_BIND_SUCCEEDED'
        throw $report.state
    }
    $report.state = 'STATIC_RETAINED_STATE_CHANGED_BEFORE_RECOVERY'
    if (!$watch.VerifyRetained([uint64[]] $filterIds, $sublayer)) {
        throw $report.state
    }
    $report.supervisorLiveBeforeRecovery = $watch.SupervisorLive

    $report.state = 'STATIC_RECOVERY_AUTHORIZATION_FAILED'
    Write-RecoveryAcknowledgement $ackPath
    $report.recoveryAcknowledgementWritten = $true
    $report.state = 'STATIC_RECOVERY_START_FAILED'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $SupervisorPath
    $start.WorkingDirectory = $stageRoot
    $start.UseShellExecute = $false
    $recoveryMode = if ($DoubleLoss) { 'recover-double' } else { 'recover' }
    $start.ArgumentList.Add($recoveryMode)
    $start.ArgumentList.Add($SupervisorPid.ToString([Globalization.CultureInfo]::InvariantCulture))
    $recovery = [Diagnostics.Process]::Start($start)
    if ($null -eq $recovery) { throw $report.state }

    $report.state = 'STATIC_RECOVERY_EXIT_UNCONFIRMED'
    if (!$recovery.WaitForExit(8000)) { throw $report.state }
    $report.recoveryExitCode = $recovery.ExitCode
    $report.state = 'STATIC_RECOVERY_REFUSED'
    if ($report.recoveryExitCode -ne 0) { throw $report.state }
    $report.state = 'STATIC_FILTER_REMOVAL_UNCONFIRMED'
    $report.filtersRemoved = $watch.VerifyRemoved([uint64[]] $filterIds, $sublayer)
    if (!$report.filtersRemoved) { throw $report.state }
    $report.state = if ($DoubleLoss) { 'STATIC_DOUBLE_LOSS_AND_RECOVERY_OBSERVED' }
        else { 'STATIC_GUARDIAN_LOSS_AND_RECOVERY_OBSERVED' }
} catch {
    if ($_.Exception.Message -cmatch '^(?:STATIC|CRASH)_[A-Z0-9_]{1,90}$') { $report.error = $_.Exception.Message }
} finally {
    if ($null -ne $recovery) { $recovery.Dispose() }
    if ($null -ne $watch) {
        try { $report.supervisorLive = $watch.SupervisorLive } catch { }
        $watch.Dispose()
    }
    if ($null -ne $intent) { $intent.Dispose() }
    if ($null -ne $image) { $image.Dispose() }
}
$report | ConvertTo-Json -Depth 4 -Compress
