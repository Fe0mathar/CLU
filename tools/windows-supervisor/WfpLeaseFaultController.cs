using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

internal sealed partial class WfpPairedSupervisor
{
    private const int FaultDeadlineMs = 45000;
    private const int FaultOwnerTransitionMs = 5000;
    private const uint FaultOwnerTerminationCode = 0xCE06;
    private const uint FaultOwnerCleanupCode = 0xCE07;
    private const ushort FaultBackupSublayerWeight = 0xFFFD;
    private const ushort FaultOwnerSublayerWeight = 0xFFFE;
    private const string FaultScenario = "enforcement-fault";
    private const string FaultHandoffFile = "owner-request.txt";
    private const string FaultReceiptFile = "owner-ready.txt";
    private const string FaultErrorFile = "owner-error.txt";
    private static readonly string[] OwnerPhases = { "STARTUP", "HANDOFF_READ", "PARENT_IDENTITY", "JOB_OPEN",
        "FIXTURE_IDENTITY", "JOB_CLOSE", "WFP_INSTALL", "READY_PUBLISH", "READY" };

    private sealed class FaultLeaseReceipt
    {
        internal Guid Sublayer;
        internal Guid[] Filters;
        internal ulong[] Ids;
    }

    private readonly Dictionary<string, int[]> faultBinds = new Dictionary<string, int[]> {
        { "control", null }, { "armed", null }, { "fault", null },
    };
    private Process faultOwner;
    private WfpLoopbackLease faultBackup;
    private Guid faultOwnerSublayer;
    private Guid[] faultOwnerFilters;
    private FaultLeaseReceipt faultReceipt;
    private string faultNonce;
    private Stopwatch faultTransition;
    private int? ownerExitCode;
    private string ownerProgress, ownerError;
    private uint? ownerNativeErrorCode;
    private ushort? backupSublayerWeightObserved, ownerSublayerWeightObserved;
    private bool faultOwnerStartAttempted, faultOwnerStarted, faultOwnerTerminationRequested, faultOwnerExited;
    private bool faultBackupInstallAttempted, faultBackupInstallCleanupVerified;
    private bool bothLeasesPresentBeforeFault, dynamicAbsenceVerified, backupPresentDuringFault;
    private bool fixtureLiveDuringFault, faultPhaseReleased, faultPhaseCompleted;

    private int RunEnforcementFault()
    {
        if (ReadPrivateFaultMarker(Path.Combine(privateRoot, "fault-launch.txt")) != "CLU-E-WFP-FAULT-1")
            throw new InvalidDataException("WFP_FAULT_LAUNCH_MARKER_INVALID");
        WriteNew(Path.Combine(privateRoot, "fault-native-started.txt"), "STARTED");
        bool expired = false;
        bool jobAbsent = false, backupRemovalVerified = false, ownerRemovalVerified = false;
        try
        {
            var request = CreateRequest();
            request.timeoutMs = FaultDeadlineMs;
            string engine = Protocol.CanonicalPath(Path.Combine(MxcPin.WfpDiagnosticStage, "bin", "wxc-exec.exe"), false);
            Protocol.EnsurePrivatePath(request, engine);
            using (var enginePin = OpenPinned(engine, MxcPin.Sha256))
            using (var fixturePin = OpenPinned(fixture, MxcPin.WfpDiagnosticFixtureSha256))
            {
                bfeWatch = new WfpBfeWatch();
                bfeWatch.RequireHealthy();
                string config = Path.Combine(privateRoot, "policy.json");
                WriteNew(config, Protocol.BuildConfig(request));
                engineExitCode = NativeJob.Run(engine, Path.Combine(privateRoot, "mxc.log"), config, request.systemRoot,
                    FaultDeadlineMs, out expired, ObserveEnforcementFault, () => jobEmpty = true, jobName);
                bfeWatch.RequireHealthy();
            }
        }
        catch (Exception failure)
        {
            if (faultBackupInstallAttempted && faultBackup == null)
                backupSublayerWeightObserved = ReadWeightMismatch(failure.Message);
            error = Regex.IsMatch(failure.Message, @"\A[A-Z][A-Z0-9_]{0,75}(?:_0x[0-9A-F]{8})?\z")
                ? failure.Message : "ENFORCEMENT_FAULT_NATIVE_REFUSAL";
        }
        finally
        {
            try { ownerRemovalVerified = FinishFaultOwner(); }
            catch (Exception) { }
            try { jobAbsent = NativeJob.NamedJobAbsent(jobName); }
            catch (Exception) { }
            try
            {
                if (faultBackup != null && jobEmpty && jobAbsent)
                    backupRemovalVerified = faultBackup.ReleaseAndVerify();
            }
            catch (Exception) { }
            if (bfeWatch != null)
            {
                try { bfeWatch.RequireHealthy(); }
                catch (Exception) { }
            }
            if (processes != null)
                foreach (var process in processes)
                    if (process != null) process.Dispose();
        }

        bool bfeHealthy = bfeWatch != null && bfeWatch.InitialRunning && bfeWatch.State == "BFE_RUNNING";
        int bfeSamples = bfeWatch == null ? 0 : bfeWatch.Samples;
        if (bfeWatch != null) bfeWatch.Dispose();
        bool stageCleanupSafe = jobAbsent && (!faultOwnerStartAttempted || ownerRemovalVerified) &&
            (!faultBackupInstallAttempted || backupRemovalVerified || faultBackupInstallCleanupVerified);
        bool passed = !expired && error == null && engineExitCode == 0 && identityVerified &&
            faultOwnerStarted && faultOwnerTerminationRequested && faultOwnerExited && bothLeasesPresentBeforeFault &&
            dynamicAbsenceVerified && backupPresentDuringFault && fixtureLiveDuringFault && faultPhaseReleased &&
            faultPhaseCompleted && bfeHealthy && jobEmpty && jobAbsent && ownerRemovalVerified && backupRemovalVerified &&
            backupSublayerWeightObserved == FaultBackupSublayerWeight && ownerSublayerWeightObserved == FaultOwnerSublayerWeight &&
            All(faultBinds["control"], 0) && All(faultBinds["armed"], AccessDenied) && All(faultBinds["fault"], AccessDenied);
        WriteNew(Path.Combine(privateRoot, "result.json"), json.Serialize(new {
            state = passed ? "WFP_LEASE_OWNER_FAULT_OBSERVED" : "WFP_LEASE_OWNER_FAULT_UNVERIFIED",
            error, engineExitCode, phaseBinds = faultBinds, identityVerified, bothLeasesPresentBeforeFault,
            ownerStarted = faultOwnerStarted, ownerTerminationRequested = faultOwnerTerminationRequested,
            ownerExited = faultOwnerExited, ownerExitCode, ownerProgress, ownerError, ownerNativeErrorCode,
            backupSublayerWeightExpected = FaultBackupSublayerWeight, backupSublayerWeightObserved,
            ownerSublayerWeightExpected = FaultOwnerSublayerWeight, ownerSublayerWeightObserved,
            dynamicAbsenceVerified, backupPresentDuringFault, fixtureLiveDuringFault,
            faultPhaseReleased, faultPhaseCompleted, bfeHealthy, bfeSamples, jobEmpty, jobAbsent, backupRemovalVerified,
            ownerRemovalVerified, stageCleanupSafe, proofAuthorization = false,
        }));
        return passed ? 0 : expired ? 124 : 125;
    }

    private void ObserveEnforcementFault(IntPtr job)
    {
        bfeWatch.RequireHealthy();
        switch (step)
        {
            case 0:
                int pid = ReadPid(FaultScenario);
                if (pid == 0) return;
                PinProcesses(job, new[] { pid });
                pairedFixturePid = pid;
                identityVerified = true;
                ReleaseGate(FaultScenario + "-control");
                break;
            case 1:
                if (!ReadFaultBinds("control", 0)) return;
                VerifyIdentity(job);
                faultBackupInstallAttempted = true;
                faultBackup = WfpLoopbackLease.Install(packageSid, out faultBackupInstallCleanupVerified, FaultBackupSublayerWeight);
                backupSublayerWeightObserved = faultBackup.VerifiedSublayerWeight;
                StartFaultOwner();
                break;
            case 2:
                if (faultOwner.HasExited)
                    throw new InvalidDataException("WFP_FAULT_OWNER_EXITED_BEFORE_READY");
                if (faultTransition.ElapsedMilliseconds >= FaultOwnerTransitionMs)
                    throw new InvalidDataException("WFP_FAULT_OWNER_READY_TIMEOUT");
                faultReceipt = ReadFaultLeaseReceipt();
                if (faultReceipt == null) return;
                VerifyBothFaultLeases(job);
                bothLeasesPresentBeforeFault = true;
                ReleaseGate(FaultScenario + "-armed");
                break;
            case 3:
                if (!ReadFaultBinds("armed", AccessDenied)) return;
                VerifyBothFaultLeases(job);
                if (faultOwner.HasExited || !TerminateProcess(faultOwner.Handle, FaultOwnerTerminationCode))
                    throw new InvalidDataException("WFP_FAULT_OWNER_TERMINATION_FAILED");
                faultOwnerTerminationRequested = true;
                faultTransition.Restart();
                break;
            case 4:
                if (faultTransition.ElapsedMilliseconds >= FaultOwnerTransitionMs)
                    throw new InvalidDataException("WFP_FAULT_OWNER_ABSENCE_UNVERIFIED");
                if (!faultOwner.HasExited) return;
                if (faultOwner.ExitCode != FaultOwnerTerminationCode)
                    throw new InvalidDataException("WFP_FAULT_OWNER_EXIT_NOT_INJECTED");
                faultOwnerExited = true;
                if (!WfpLoopbackLease.VerifyExactDynamicAbsent(faultReceipt.Sublayer, faultReceipt.Filters)) return;
                dynamicAbsenceVerified = true;
                VerifyFaultBackup(job);
                ReleaseGate(FaultScenario + "-fault");
                faultPhaseReleased = true;
                break;
            case 5:
                if (!ReadFaultBinds("fault", AccessDenied)) return;
                if (!WfpLoopbackLease.VerifyExactDynamicAbsent(faultReceipt.Sublayer, faultReceipt.Filters))
                    throw new InvalidDataException("WFP_FAULT_OWNER_POLICY_REAPPEARED");
                VerifyFaultBackup(job);
                backupPresentDuringFault = true;
                fixtureLiveDuringFault = true;
                faultPhaseCompleted = true;
                ReleaseGate(FaultScenario + "-complete");
                break;
            default:
                return;
        }
        step++;
    }

    private bool ReadFaultBinds(string phase, int expected)
    {
        int[] codes = ReadCodes(FaultScenario + "-" + phase);
        if (codes == null) return false;
        faultBinds[phase] = codes;
        if (!All(codes, expected)) throw new InvalidDataException("WFP_FAULT_BIND_OUTCOME_MISMATCH");
        return true;
    }

    private void StartFaultOwner()
    {
        faultNonce = Guid.NewGuid().ToString("N");
        faultOwnerSublayer = Guid.NewGuid();
        faultOwnerFilters = new Guid[6];
        for (int index = 0; index < faultOwnerFilters.Length; index++) faultOwnerFilters[index] = Guid.NewGuid();
        if (!WfpLoopbackLease.VerifyExactDynamicAbsent(faultOwnerSublayer, faultOwnerFilters))
            throw new InvalidDataException("WFP_FAULT_OWNER_PLAN_COLLISION");
        using (var self = Process.GetCurrentProcess())
        {
            string pid = self.Id.ToString(CultureInfo.InvariantCulture);
            var plan = new List<string> { faultNonce, pid, jobName, pairedFixturePid.ToString(CultureInfo.InvariantCulture),
                faultOwnerSublayer.ToString("D") };
            plan.AddRange(Array.ConvertAll(faultOwnerFilters, key => key.ToString("D")));
            WriteNew(Path.Combine(privateRoot, FaultHandoffFile), String.Join(" ", plan));
            faultOwnerStartAttempted = true;
            var start = new ProcessStartInfo {
                FileName = DiagnosticImage(),
                Arguments = "enforcement-fault-owner " + pid + " " + faultNonce,
                WorkingDirectory = privateRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            string systemRoot = Path.GetDirectoryName(Environment.SystemDirectory);
            start.EnvironmentVariables.Clear();
            start.EnvironmentVariables["PATH"] = Environment.SystemDirectory;
            start.EnvironmentVariables["SystemRoot"] = systemRoot;
            start.EnvironmentVariables["WINDIR"] = systemRoot;
            faultOwner = Process.Start(start);
            if (faultOwner == null || faultOwner.Handle == IntPtr.Zero)
                throw new InvalidDataException("WFP_FAULT_OWNER_START_FAILED");
            faultOwnerStarted = true;
            faultTransition = Stopwatch.StartNew();
        }
    }

    private void VerifyBothFaultLeases(IntPtr job)
    {
        var backupKeys = new HashSet<Guid>(faultBackup.FilterKeys) { faultBackup.SublayerKey };
        if (faultOwner.HasExited || backupKeys.Contains(faultReceipt.Sublayer) || backupKeys.Overlaps(faultReceipt.Filters))
            throw new InvalidDataException("WFP_FAULT_LEASE_IDENTITIES_INVALID");
        VerifyFaultBackup(job);
        VerifyFaultSublayer(faultReceipt.Sublayer, faultReceipt.Filters, faultReceipt.Ids,
            FaultOwnerSublayerWeight, ref ownerSublayerWeightObserved);
    }

    private void VerifyFaultBackup(IntPtr job)
    {
        VerifyIdentity(job);
        bfeWatch.RequireHealthy();
        VerifyFaultSublayer(faultBackup.SublayerKey, faultBackup.FilterKeys, faultBackup.FilterIds,
            FaultBackupSublayerWeight, ref backupSublayerWeightObserved);
    }

    private void VerifyFaultSublayer(Guid sublayer, Guid[] filters, ulong[] ids, ushort expected, ref ushort? observed)
    {
        observed = null;
        try { observed = WfpLoopbackLease.VerifyExactDynamicInstalled(packageSid, sublayer, filters, ids, expected); }
        catch (InvalidOperationException failure)
        {
            observed = ReadWeightMismatch(failure.Message);
            throw;
        }
    }

    private static ushort? ReadWeightMismatch(string message)
    {
        var match = Regex.Match(message, @"\AWFP_SUBLAYER_WEIGHT_0x([0-9A-F]{8})\z", RegexOptions.CultureInvariant);
        ushort weight;
        return match.Success && UInt16.TryParse(match.Groups[1].Value, NumberStyles.AllowHexSpecifier,
            CultureInfo.InvariantCulture, out weight) ? (ushort?)weight : null;
    }

    private bool FinishFaultOwner()
    {
        if (faultOwner == null) return false;
        using (faultOwner)
        {
            if (!faultOwner.HasExited)
            {
                if (!TerminateProcess(faultOwner.Handle, FaultOwnerCleanupCode) && !faultOwner.HasExited) return false;
                if (!faultOwner.WaitForExit(FaultOwnerTransitionMs)) return false;
            }
            faultOwnerExited = true;
            ownerExitCode = faultOwner.ExitCode;
            try { ReadFaultOwnerDiagnostics(faultOwner.Id); }
            catch (Exception) { ownerError = "OWNER_STATUS_UNVERIFIED"; }
            return WfpLoopbackLease.VerifyExactDynamicAbsent(faultOwnerSublayer, faultOwnerFilters);
        }
    }

    private FaultLeaseReceipt ReadFaultLeaseReceipt()
    {
        string marker = ReadPrivateFaultMarker(Path.Combine(privateRoot, FaultReceiptFile));
        if (marker == null) return null;
        var parts = marker.Split(' ');
        if (parts.Length != 15 || parts[0] != faultNonce || parts[1] != faultOwner.Id.ToString(CultureInfo.InvariantCulture))
            throw new InvalidDataException("WFP_FAULT_OWNER_RECEIPT_INVALID");
        var receipt = new FaultLeaseReceipt { Sublayer = Guid.ParseExact(parts[2], "D"), Filters = new Guid[6], Ids = new ulong[6] };
        if (receipt.Sublayer != faultOwnerSublayer)
            throw new InvalidDataException("WFP_FAULT_OWNER_RECEIPT_PLAN_MISMATCH");
        for (int index = 0; index < 6; index++)
        {
            receipt.Filters[index] = Guid.ParseExact(parts[3 + index], "D");
            if (receipt.Filters[index] != faultOwnerFilters[index])
                throw new InvalidDataException("WFP_FAULT_OWNER_RECEIPT_PLAN_MISMATCH");
            receipt.Ids[index] = UInt64.Parse(parts[9 + index], NumberStyles.None, CultureInfo.InvariantCulture);
        }
        return receipt;
    }

    private static int RunEnforcementFaultOwner(string parentText, string nonce)
    {
        int parentPid;
        if (!Int32.TryParse(parentText, NumberStyles.None, CultureInfo.InvariantCulture, out parentPid) || parentPid < 1 ||
            !Regex.IsMatch(nonce, @"\A[a-f0-9]{32}\z", RegexOptions.CultureInvariant)) return 125;
        string ownerRoot = StaticPrivateRoot(FaultScenario);
        string statusPrefix;
        using (var self = Process.GetCurrentProcess()) statusPrefix = nonce + " " + self.Id.ToString(CultureInfo.InvariantCulture);
        Action<string> progress = phase => WriteNew(Path.Combine(ownerRoot, "owner-progress-" + phase + ".txt"), statusPrefix + " " + phase);
        try
        {
            progress("STARTUP");
            string diagnostic = DiagnosticImage();
            progress("HANDOFF_READ");
            string marker = ReadPrivateFaultMarker(Path.Combine(ownerRoot, FaultHandoffFile));
            if (marker == null) throw new InvalidDataException("WFP_FAULT_OWNER_HANDOFF_MISSING");
            var parts = marker.Split(' ');
            int fixturePid;
            if (parts.Length != 11 || parts[0] != nonce || parts[1] != parentText ||
                !Regex.IsMatch(parts[2], @"\ALocal\\CLU-E-[a-f0-9]{32}\z", RegexOptions.CultureInvariant) ||
                !Int32.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out fixturePid) || fixturePid < 1)
                throw new InvalidDataException("WFP_FAULT_OWNER_HANDOFF_INVALID");
            Guid sublayer = Guid.ParseExact(parts[4], "D");
            var filters = new Guid[6];
            for (int index = 0; index < filters.Length; index++) filters[index] = Guid.ParseExact(parts[5 + index], "D");

            progress("PARENT_IDENTITY");
            using (var parent = Process.GetProcessById(parentPid))
            {
                if (parent.Handle == IntPtr.Zero || parent.HasExited ||
                    !String.Equals(Protocol.CanonicalPath(parent.MainModule.FileName, false), diagnostic, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("WFP_FAULT_OWNER_PARENT_IDENTITY_INVALID");
                progress("JOB_OPEN");
                const uint jobQuery = 0x0004;
                IntPtr job = OpenJobObjectW(jobQuery, false, parts[2]);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                byte[] sid;
                try
                {
                    progress("FIXTURE_IDENTITY");
                    string fixtureImage = Protocol.CanonicalPath(Path.Combine(MxcPin.WfpDiagnosticStage, "fixture", "WfpPairedFixture.exe"), false);
                    using (var fixturePin = OpenPinned(fixtureImage, MxcPin.WfpDiagnosticFixtureSha256))
                        sid = WfpContainerIdentity.ReadForJob(job, fixturePid, fixtureImage);
                }
                finally
                {
                    // The owner must never extend the lifetime of the controller's kill-on-close job.
                    if (!CloseHandle(job))
                    {
                        int failureCode = Marshal.GetLastWin32Error();
                        progress("JOB_CLOSE");
                        throw new Win32Exception(failureCode);
                    }
                }
                progress("JOB_CLOSE");
                if (parent.HasExited) throw new InvalidDataException("WFP_FAULT_OWNER_PARENT_EXITED");
                progress("WFP_INSTALL");
                bool cleanupVerified;
                using (var dynamicLease = WfpLoopbackLease.InstallExactDynamic(sid, sublayer, filters,
                    FaultOwnerSublayerWeight, out cleanupVerified))
                {
                    if (parent.HasExited) throw new InvalidDataException("WFP_FAULT_OWNER_PARENT_EXITED");
                    progress("READY_PUBLISH");
                    var response = new List<string> { statusPrefix, dynamicLease.SublayerKey.ToString("D") };
                    response.AddRange(Array.ConvertAll(dynamicLease.FilterKeys, key => key.ToString("D")));
                    response.AddRange(Array.ConvertAll(dynamicLease.FilterIds, id => id.ToString(CultureInfo.InvariantCulture)));
                    WriteNew(Path.Combine(ownerRoot, FaultReceiptFile), String.Join(" ", response));
                    progress("READY");
                    parent.WaitForExit(FaultDeadlineMs + FaultOwnerTransitionMs);
                }
            }
        }
        catch (Exception failure)
        {
            try { WriteFaultOwnerError(ownerRoot, statusPrefix, failure); }
            catch (Exception) { }
        }
        return 125;
    }

    private static void WriteFaultOwnerError(string root, string prefix, Exception failure)
    {
        string code = "OWNER_UNEXPECTED_FAILURE";
        uint? nativeCode = null;
        var win32 = failure as Win32Exception;
        if (win32 != null)
        {
            code = "OWNER_WIN32_ERROR";
            nativeCode = unchecked((uint)win32.NativeErrorCode);
        }
        else
        {
            var match = Regex.Match(failure.Message, @"\A(WFP_[A-Z][A-Z0-9_]{0,70})(?:_0x([0-9A-F]{8}))?\z", RegexOptions.CultureInvariant);
            if (match.Success)
            {
                code = match.Groups[1].Value;
                if (match.Groups[2].Success)
                    nativeCode = UInt32.Parse(match.Groups[2].Value, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            }
        }
        WriteNew(Path.Combine(root, FaultErrorFile), prefix + " " + code + " " +
            (nativeCode.HasValue ? nativeCode.Value.ToString(CultureInfo.InvariantCulture) : "NONE"));
    }

    private void ReadFaultOwnerDiagnostics(int ownerPid)
    {
        string prefix = faultNonce + " " + ownerPid.ToString(CultureInfo.InvariantCulture);
        foreach (string phase in OwnerPhases)
        {
            string marker = ReadPrivateFaultMarker(Path.Combine(privateRoot, "owner-progress-" + phase + ".txt"));
            if (marker == null) continue;
            if (marker != prefix + " " + phase) throw new InvalidDataException("WFP_FAULT_OWNER_PROGRESS_INVALID");
            ownerProgress = phase;
        }
        string failure = ReadPrivateFaultMarker(Path.Combine(privateRoot, FaultErrorFile));
        if (failure == null) return;
        var parts = failure.Split(' ');
        if (parts.Length != 4 || parts[0] + " " + parts[1] != prefix ||
            !Regex.IsMatch(parts[2], @"\A(?:OWNER_(?:WIN32_ERROR|UNEXPECTED_FAILURE)|WFP_[A-Z][A-Z0-9_]{0,70})\z", RegexOptions.CultureInvariant))
            throw new InvalidDataException("WFP_FAULT_OWNER_ERROR_INVALID");
        uint code;
        if (parts[3] != "NONE")
        {
            if (!UInt32.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out code))
                throw new InvalidDataException("WFP_FAULT_OWNER_ERROR_INVALID");
            ownerNativeErrorCode = code;
        }
        ownerError = parts[2];
        if (ownerError == "WFP_SUBLAYER_WEIGHT" && ownerNativeErrorCode.HasValue && ownerNativeErrorCode.Value <= UInt16.MaxValue)
            ownerSublayerWeightObserved = (ushort)ownerNativeErrorCode.Value;
    }

    private static string ReadPrivateFaultMarker(string path)
    {
        if (!File.Exists(path)) return null;
        using (var stream = new FileStream(Protocol.CanonicalPath(path, false), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (stream.Length < 1 || stream.Length > 512) throw new InvalidDataException("WFP_FAULT_PRIVATE_MARKER_SIZE");
            using (var reader = new StreamReader(stream, Encoding.ASCII, false)) return reader.ReadToEnd();
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
}
