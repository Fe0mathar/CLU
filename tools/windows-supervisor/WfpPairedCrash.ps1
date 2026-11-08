[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int] $SupervisorPid,
    [Parameter(Mandatory = $true)][string] $SupervisorPath,
    [Parameter(Mandatory = $true)][string] $FixturePath,
    [Parameter(Mandatory = $true)][string] $ReadyPath,
    [Parameter(Mandatory = $true)][string] $Workspace
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

$failure = 'CRASH_OBSERVER_PREREQUISITE_FAILED'
$watch = $null
try {
    if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'CRASH_OBSERVER_WINDOWS_REQUIRED' }
    Assert-CrashPath $SupervisorPath $false
    Assert-CrashPath $FixturePath $false
    Assert-CrashPath $ReadyPath $true
    Assert-CrashPath $Workspace $false $true
    $caseRoot = [IO.Path]::GetDirectoryName($Workspace)
    $privateRoot = [IO.Path]::Combine($caseRoot, 'private')
    $jobEmptyPath = [IO.Path]::Combine($privateRoot, 'job-empty.txt')
    $releaseVerifiedPath = [IO.Path]::Combine($privateRoot, 'release-verified.txt')
    $stageRoot = [IO.Path]::GetDirectoryName($caseRoot)
    if (![string]::Equals([IO.Path]::GetFileName($Workspace), 'workspace', [StringComparison]::OrdinalIgnoreCase) -or
        ![string]::Equals([IO.Path]::GetFileName($caseRoot), 'crash', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($stageRoot) -cnotmatch '^\.setup-[0-9a-f]{32}$' -or
        ![string]::Equals([IO.Path]::Combine($privateRoot, 'ready.json'), $ReadyPath,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CRASH_READY_SCOPE_INVALID'
    }
    Assert-CrashPath $jobEmptyPath $true
    Assert-CrashPath $releaseVerifiedPath $true
    if (![string]::Equals([IO.Path]::Combine($stageRoot, 'bin', 'CLU-E-WfpPairedDiagnostic.exe'),
            $SupervisorPath, [StringComparison]::OrdinalIgnoreCase) -or
        ![string]::Equals([IO.Path]::Combine($stageRoot, 'fixture', 'WfpPairedFixture.exe'),
            $FixturePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CRASH_IMAGE_SCOPE_INVALID'
    }

    if ($null -eq ('Clue.Diagnostics.WfpGuardianCrashWatch' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Clue.Diagnostics
{
    public sealed class WfpGuardianCrashWatch : IDisposable
    {
        private const uint QueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x100000;
        private const uint Terminate = 1;
        private const uint WaitSignaled = 0;
        private const uint WaitTimedOut = 258;
        private const uint FilterNotFound = 0x80320003;
        private const uint SublayerNotFound = 0x80320007;
        private IntPtr supervisor;

        public WfpGuardianCrashWatch(int processId, string image)
        {
            supervisor = OpenExact(processId, image, QueryLimitedInformation | Synchronize | Terminate);
        }

        public bool SupervisorLive { get { return IsLive(supervisor); } }

        public sealed class Evidence
        {
            public string state = "CRASH_PREFLIGHT_UNVERIFIED";
            public bool terminationRequested;
            public Preflight preflight = new Preflight();
            public bool supervisorExited;
            public bool guardianExited;
            public bool fixtureTreeExited;
            public bool filtersRemoved;
            public string jobEmptyMarkerState = "NOT_OBSERVED";
            public bool orderedObservationVerified;
            public bool releaseAcknowledgementWritten;
            public string observedOrdering = "NOT_OBSERVED";
            public int samples;
            public string error;
        }

        public sealed class Preflight
        {
            public bool supervisorLive;
            public bool guardianLive;
            public int liveFixtureProcesses;
            public int liveFilters;
            public bool sublayerPresent;
        }

        public Evidence Observe(int guardianPid, string guardianImage, int[] fixturePids, string fixtureImage,
            ulong[] filterIds, Guid sublayerKey, string jobEmptyPath, string releaseVerifiedPath)
        {
            var evidence = new Evidence();
            var fixtures = new IntPtr[3];
            IntPtr guardian = IntPtr.Zero;
            IntPtr engine = IntPtr.Zero;
            try
            {
                guardian = OpenExact(guardianPid, guardianImage, QueryLimitedInformation | Synchronize);
                for (int index = 0; index < fixtures.Length; index++)
                    fixtures[index] = OpenExact(fixturePids[index], fixtureImage, QueryLimitedInformation | Synchronize);

                if (FwpmEngineOpen0(null, 10, IntPtr.Zero, IntPtr.Zero, out engine) != 0 || engine == IntPtr.Zero)
                {
                    evidence.state = "CRASH_WFP_QUERY_UNAVAILABLE";
                    return evidence;
                }

                FilterState initial = ReadFilters(engine, filterIds, sublayerKey);
                evidence.preflight.liveFilters = initial.Count;
                evidence.preflight.sublayerPresent = initial.SublayerPresent;
                evidence.preflight.liveFixtureProcesses = CountLive(fixtures);
                evidence.preflight.supervisorLive = SupervisorLive;
                evidence.preflight.guardianLive = IsLive(guardian);
                if (!initial.AllPresent || evidence.preflight.liveFixtureProcesses != fixtures.Length ||
                    !evidence.preflight.supervisorLive || !evidence.preflight.guardianLive) return evidence;
                evidence.jobEmptyMarkerState = ReadMarker(jobEmptyPath, "EMPTY");
                if (evidence.jobEmptyMarkerState != "MISSING" || ReadMarker(releaseVerifiedPath, "VERIFIED") != "MISSING")
                {
                    evidence.state = "GUARDIAN_MARKERS_NOT_FRESH";
                    return evidence;
                }

                // This is the retained handle to the exact freshly spawned diagnostic supervisor.
                // The observer owns only process handles. It never duplicates the kill-on-close job handle.
                if (!TerminateProcess(supervisor, 125))
                {
                    evidence.state = "CRASH_TERMINATION_REFUSED";
                    return evidence;
                }
                evidence.terminationRequested = true;

                bool filterLossBeforeTreeExit = false;
                bool filterLossBeforeAck = false;
                var elapsed = Stopwatch.StartNew();
                do
                {
                    evidence.supervisorExited = !SupervisorLive;
                    bool guardianLiveBefore = IsLive(guardian);
                    if (evidence.jobEmptyMarkerState == "MISSING")
                        evidence.jobEmptyMarkerState = ReadMarker(jobEmptyPath, "EMPTY");
                    int liveBefore = CountLive(fixtures);
                    FilterState filters = ReadFilters(engine, filterIds, sublayerKey);
                    int liveAfter = CountLive(fixtures);
                    evidence.samples++;
                    evidence.guardianExited = !IsLive(guardian);
                    evidence.fixtureTreeExited = liveAfter == 0;
                    evidence.filtersRemoved = filters.AllAbsent;

                    // The guardian's whole-job marker supplements independent checks of all tracked
                    // fixture handles and exact WFP policy before the observer authorizes release.
                    if (!filters.AllPresent && liveAfter > 0) filterLossBeforeTreeExit = true;
                    if (!filters.AllPresent && !evidence.releaseAcknowledgementWritten) filterLossBeforeAck = true;
                    if (!evidence.releaseAcknowledgementWritten && !filterLossBeforeAck && !filterLossBeforeTreeExit &&
                        evidence.supervisorExited && guardianLiveBefore && !evidence.guardianExited &&
                        evidence.jobEmptyMarkerState == "VERIFIED" && liveBefore == 0 && filters.AllPresent)
                    {
                        evidence.orderedObservationVerified = true;
                        WriteReleaseAcknowledgement(releaseVerifiedPath);
                        evidence.releaseAcknowledgementWritten = true;
                    }
                    evidence.observedOrdering = filterLossBeforeTreeExit ? "FILTER_LOSS_BEFORE_TREE_EXIT_OBSERVED"
                        : evidence.orderedObservationVerified ? "JOB_EMPTY_BEFORE_FILTER_REMOVAL_OBSERVED" : "UNRESOLVED";

                    if (evidence.supervisorExited && evidence.guardianExited && evidence.fixtureTreeExited && evidence.filtersRemoved) break;
                    Thread.Sleep(2);
                } while (elapsed.ElapsedMilliseconds < 9000);

                if (filterLossBeforeTreeExit)
                    evidence.state = "CRASH_ORDER_UNSAFE_OR_CONFLICTING";
                else if (!evidence.supervisorExited || !evidence.guardianExited || !evidence.fixtureTreeExited || !evidence.filtersRemoved)
                    evidence.state = "GUARDIAN_CLEANUP_INCOMPLETE";
                else if (evidence.orderedObservationVerified && evidence.releaseAcknowledgementWritten && !filterLossBeforeAck)
                    evidence.state = "GUARDIAN_CLEANUP_ORDER_OBSERVED";
                else if (evidence.jobEmptyMarkerState == "MISSING")
                    evidence.state = "GUARDIAN_JOB_EMPTY_MARKER_MISSING";
                else if (evidence.jobEmptyMarkerState != "VERIFIED")
                    evidence.state = "GUARDIAN_JOB_EMPTY_MARKER_UNVERIFIED";
                else
                    evidence.state = "GUARDIAN_CLEANUP_ORDER_UNRESOLVED";
            }
            catch (Exception failure)
            {
                evidence.state = evidence.terminationRequested
                    ? "CRASH_OBSERVATION_FAILED_AFTER_TERMINATION" : "CRASH_PREFLIGHT_OBSERVATION_FAILED";
                if (Regex.IsMatch(failure.Message, @"^CRASH_[A-Z0-9_]{1,90}$")) evidence.error = failure.Message;
            }
            finally
            {
                if (engine != IntPtr.Zero) FwpmEngineClose0(engine);
                if (guardian != IntPtr.Zero) CloseHandle(guardian);
                foreach (IntPtr process in fixtures) if (process != IntPtr.Zero) CloseHandle(process);
            }
            return evidence;
        }

        private static string ReadMarker(string path, string expected)
        {
            try
            {
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return "INVALID";
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (stream.Length != expected.Length) return "INVALID";
                    foreach (char character in expected)
                        if (stream.ReadByte() != character) return "INVALID";
                    return "VERIFIED";
                }
            }
            catch (FileNotFoundException) { return "MISSING"; }
            catch (IOException) { return "UNAVAILABLE"; }
            catch (UnauthorizedAccessException) { return "UNAVAILABLE"; }
        }

        private static void WriteReleaseAcknowledgement(string path)
        {
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] bytes = Encoding.ASCII.GetBytes("VERIFIED");
                    stream.Write(bytes, 0, bytes.Length);
                }
                File.Move(temporary, path);
            }
            finally { File.Delete(temporary); }
        }

        private static int CountLive(IntPtr[] processes)
        {
            int count = 0;
            foreach (IntPtr process in processes) if (IsLive(process)) count++;
            return count;
        }

        private static bool IsLive(IntPtr process)
        {
            uint result = WaitForSingleObject(process, 0);
            if (result == WaitTimedOut) return true;
            if (result == WaitSignaled) return false;
            throw new InvalidOperationException("CRASH_PROCESS_WAIT_FAILED");
        }

        private static IntPtr OpenExact(int processId, string image, uint access)
        {
            IntPtr handle = OpenProcess(access, false, processId);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("CRASH_PROCESS_OPEN_FAILED");
            try
            {
                var name = new StringBuilder(32768);
                int capacity = name.Capacity;
                if (!QueryFullProcessImageNameW(handle, 0, name, ref capacity) ||
                    !String.Equals(Path.GetFullPath(name.ToString()), image, StringComparison.OrdinalIgnoreCase) ||
                    !IsLive(handle))
                    throw new InvalidOperationException("CRASH_PROCESS_IDENTITY_UNVERIFIED");
                return handle;
            }
            catch
            {
                CloseHandle(handle);
                throw;
            }
        }

        private struct FilterState
        {
            public int Count;
            public bool SublayerPresent;
            public bool AllPresent { get { return Count == 6 && SublayerPresent; } }
            public bool AllAbsent { get { return Count == 0 && !SublayerPresent; } }
        }

        private static FilterState ReadFilters(IntPtr engine, ulong[] ids, Guid key)
        {
            var state = new FilterState();
            foreach (ulong id in ids)
            {
                IntPtr value;
                uint code = FwpmFilterGetById0(engine, id, out value);
                try
                {
                    if (code == 0 && value != IntPtr.Zero) state.Count++;
                    else if (code != FilterNotFound) throw new InvalidOperationException("CRASH_FILTER_QUERY_FAILED");
                }
                finally { if (value != IntPtr.Zero) FwpmFreeMemory0(ref value); }
            }

            IntPtr sublayer;
            uint layerCode = FwpmSubLayerGetByKey0(engine, ref key, out sublayer);
            try
            {
                state.SublayerPresent = layerCode == 0 && sublayer != IntPtr.Zero;
                if (!state.SublayerPresent && layerCode != SublayerNotFound)
                    throw new InvalidOperationException("CRASH_SUBLAYER_QUERY_FAILED");
            }
            finally { if (sublayer != IntPtr.Zero) FwpmFreeMemory0(ref sublayer); }
            return state;
        }

        public void Dispose()
        {
            if (supervisor != IntPtr.Zero)
            {
                CloseHandle(supervisor);
                supervisor = IntPtr.Zero;
            }
        }

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int processId);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
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

    $failure = 'CRASH_SUPERVISOR_IDENTITY_UNVERIFIED'
    $watch = [Clue.Diagnostics.WfpGuardianCrashWatch]::new($SupervisorPid, $SupervisorPath)
    $failure = 'CRASH_READY_NOT_OBSERVED'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $ready = $null
    while ($clock.ElapsedMilliseconds -lt 10000 -and $watch.SupervisorLive) {
        $ready = Read-CrashReady $ReadyPath
        if ($null -ne $ready) { break }
        Start-Sleep -Milliseconds 20
    }
    if ($null -eq $ready) { throw $failure }

    $failure = 'CRASH_READY_INVALID'
    if ($ready -isnot [Collections.IDictionary] -or $ready.Count -ne 5 -or
        ($ready['supervisorPid'] -isnot [int] -and $ready['supervisorPid'] -isnot [long]) -or
        $ready['supervisorPid'] -ne $SupervisorPid -or
        ($ready['guardianPid'] -isnot [int] -and $ready['guardianPid'] -isnot [long]) -or
        $ready['guardianPid'] -lt 1 -or $ready['guardianPid'] -gt [int]::MaxValue -or
        $ready['guardianPid'] -eq $SupervisorPid -or
        $ready['fixturePids'] -isnot [array] -or $ready['fixturePids'].Count -ne 3 -or
        $ready['filterIds'] -isnot [array] -or $ready['filterIds'].Count -ne 6 -or
        $ready['sublayerKey'] -isnot [string]) { throw $failure }

    $uniquePids = [Collections.Generic.HashSet[int]]::new()
    $fixturePids = foreach ($fixtureProcessId in $ready['fixturePids']) {
        if (($fixtureProcessId -isnot [int] -and $fixtureProcessId -isnot [long]) -or
            $fixtureProcessId -lt 1 -or $fixtureProcessId -gt [int]::MaxValue -or
            $fixtureProcessId -eq $SupervisorPid -or $fixtureProcessId -eq $ready['guardianPid'] -or
            !$uniquePids.Add([int] $fixtureProcessId)) { throw $failure }
        [int] $fixtureProcessId
    }

    $uniqueFilters = [Collections.Generic.HashSet[uint64]]::new()
    $filterIds = foreach ($filterId in $ready['filterIds']) {
        [uint64] $numeric = 0
        if ($filterId -isnot [string] -or $filterId -cnotmatch '^[1-9][0-9]{0,19}$' -or
            ![uint64]::TryParse($filterId, [Globalization.NumberStyles]::None,
                [Globalization.CultureInfo]::InvariantCulture, [ref] $numeric) -or
            !$uniqueFilters.Add($numeric)) { throw $failure }
        $numeric
    }

    $sublayer = [Guid]::Empty
    if (![Guid]::TryParseExact($ready['sublayerKey'], 'D', [ref] $sublayer) -or $sublayer -eq [Guid]::Empty) {
        throw $failure
    }

    $failure = 'CRASH_OBSERVER_INVOCATION_FAILED'
    $result = $watch.Observe([int] $ready['guardianPid'], $SupervisorPath, [int[]] $fixturePids,
        $FixturePath, [uint64[]] $filterIds, $sublayer, $jobEmptyPath, $releaseVerifiedPath)
    $escapeMarkers = [ordered]@{ parent = $null; child = $null; grandchild = $null }
    foreach ($role in @('parent', 'child', 'grandchild')) {
        $marker = if ($role -eq 'parent') { 'crash-escape.txt' } else { 'crash-' + $role + '-escape.txt' }
        try { $escapeMarkers[$role] = Read-CrashEscape (Join-Path $Workspace $marker) $result.fixtureTreeExited }
        catch { $escapeMarkers[$role] = $null }
    }
    $escapeDetected = if ($escapeMarkers.Values -contains $true) { $true }
        elseif ($escapeMarkers.Values -contains $null) { $null }
        else { $false }
    if ($escapeDetected) { $result.state = 'CRASH_FIXTURE_BIND_SUCCEEDED' }
    [ordered]@{
        state = $result.state
        terminationRequested = $result.terminationRequested
        preflight = $result.preflight
        supervisorExited = $result.supervisorExited
        guardianExited = $result.guardianExited
        fixtureTreeExited = $result.fixtureTreeExited
        filtersRemoved = $result.filtersRemoved
        jobEmptyMarkerState = $result.jobEmptyMarkerState
        orderedObservationVerified = $result.orderedObservationVerified
        releaseAcknowledgementWritten = $result.releaseAcknowledgementWritten
        observedOrdering = $result.observedOrdering
        samples = $result.samples
        error = $result.error
        escapeDetected = $escapeDetected
        escapeMarkers = $escapeMarkers
    } | ConvertTo-Json -Depth 4 -Compress
} catch {
    [ordered]@{
        state = $failure
        terminationRequested = $false
        preflight = $null
        supervisorExited = $null
        guardianExited = $null
        fixtureTreeExited = $null
        filtersRemoved = $null
        jobEmptyMarkerState = 'NOT_OBSERVED'
        orderedObservationVerified = $false
        releaseAcknowledgementWritten = $false
        observedOrdering = 'NOT_OBSERVED'
        samples = 0
        error = $(if ($_.Exception.Message -cmatch '^CRASH_[A-Z0-9_]{1,90}$') { $_.Exception.Message })
        escapeDetected = $null
        escapeMarkers = $null
    } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $watch) { $watch.Dispose() }
}
