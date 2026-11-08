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
    private const string FaultScenario = "enforcement-fault";
    private const string FaultHandoffFile = "owner-request.txt";
    private const string FaultReceiptFile = "owner-ready.txt";

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
    private FaultLeaseReceipt faultReceipt;
    private string faultNonce;
    private Stopwatch faultTransition;
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
            All(faultBinds["control"], 0) && All(faultBinds["armed"], AccessDenied) && All(faultBinds["fault"], AccessDenied);
        WriteNew(Path.Combine(privateRoot, "result.json"), json.Serialize(new {
            state = passed ? "WFP_LEASE_OWNER_FAULT_OBSERVED" : "WFP_LEASE_OWNER_FAULT_UNVERIFIED",
            error, engineExitCode, phaseBinds = faultBinds, identityVerified, bothLeasesPresentBeforeFault,
            ownerStarted = faultOwnerStarted, ownerTerminationRequested = faultOwnerTerminationRequested,
            ownerExited = faultOwnerExited, dynamicAbsenceVerified, backupPresentDuringFault, fixtureLiveDuringFault,
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
                faultBackup = WfpLoopbackLease.Install(packageSid, out faultBackupInstallCleanupVerified);
                StartFaultOwner();
                break;
            case 2:
                if (faultOwner.HasExited || faultTransition.ElapsedMilliseconds >= FaultOwnerTransitionMs)
                    throw new InvalidDataException("WFP_FAULT_OWNER_NOT_READY");
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
        using (var self = Process.GetCurrentProcess())
        {
            string pid = self.Id.ToString(CultureInfo.InvariantCulture);
            WriteNew(Path.Combine(privateRoot, FaultHandoffFile), faultNonce + " " + pid + " " + jobName + " " +
                pairedFixturePid.ToString(CultureInfo.InvariantCulture));
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
            if (faultOwner == null || faultOwner.Handle == IntPtr.Zero || faultOwner.HasExited)
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
        WfpLoopbackLease.VerifyExactDynamicInstalled(packageSid, faultReceipt.Sublayer, faultReceipt.Filters, faultReceipt.Ids);
    }

    private void VerifyFaultBackup(IntPtr job)
    {
        VerifyIdentity(job);
        bfeWatch.RequireHealthy();
        WfpLoopbackLease.VerifyExactDynamicInstalled(packageSid, faultBackup.SublayerKey, faultBackup.FilterKeys, faultBackup.FilterIds);
    }

    private bool FinishFaultOwner()
    {
        if (faultOwner == null) return false;
        using (faultOwner)
        {
            if (!faultOwner.HasExited && (!TerminateProcess(faultOwner.Handle, FaultOwnerTerminationCode) ||
                !faultOwner.WaitForExit(FaultOwnerTransitionMs))) return false;
            if (faultReceipt == null) faultReceipt = ReadFaultLeaseReceipt();
            return faultReceipt != null && WfpLoopbackLease.VerifyExactDynamicAbsent(faultReceipt.Sublayer, faultReceipt.Filters);
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
        for (int index = 0; index < 6; index++)
        {
            receipt.Filters[index] = Guid.ParseExact(parts[3 + index], "D");
            receipt.Ids[index] = UInt64.Parse(parts[9 + index], NumberStyles.None, CultureInfo.InvariantCulture);
        }
        return receipt;
    }

    private static int RunEnforcementFaultOwner(string parentText, string nonce)
    {
        int parentPid;
        if (!Int32.TryParse(parentText, NumberStyles.None, CultureInfo.InvariantCulture, out parentPid) || parentPid < 1 ||
            !Regex.IsMatch(nonce, @"\A[a-f0-9]{32}\z", RegexOptions.CultureInvariant)) return 125;
        string diagnostic = DiagnosticImage();
        string ownerRoot = StaticPrivateRoot(FaultScenario);
        string marker = ReadPrivateFaultMarker(Path.Combine(ownerRoot, FaultHandoffFile));
        if (marker == null) return 125;
        var parts = marker.Split(' ');
        int fixturePid;
        if (parts.Length != 4 || parts[0] != nonce || parts[1] != parentText ||
            !Regex.IsMatch(parts[2], @"\ALocal\\CLU-E-[a-f0-9]{32}\z", RegexOptions.CultureInvariant) ||
            !Int32.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out fixturePid) || fixturePid < 1)
            return 125;

        using (var parent = Process.GetProcessById(parentPid))
        {
            if (parent.Handle == IntPtr.Zero || parent.HasExited ||
                !String.Equals(Protocol.CanonicalPath(parent.MainModule.FileName, false), diagnostic, StringComparison.OrdinalIgnoreCase))
                return 125;
            string fixtureImage = Protocol.CanonicalPath(Path.Combine(MxcPin.WfpDiagnosticStage, "fixture", "WfpPairedFixture.exe"), false);
            byte[] sid;
            using (var fixturePin = OpenPinned(fixtureImage, MxcPin.WfpDiagnosticFixtureSha256))
            {
                const uint jobQuery = 0x0004;
                IntPtr job = OpenJobObjectW(jobQuery, false, parts[2]);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try { sid = WfpContainerIdentity.ReadForJob(job, fixturePid, fixtureImage); }
                finally
                {
                    // The owner must never extend the lifetime of the controller's kill-on-close job.
                    if (!CloseHandle(job)) throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            if (parent.HasExited) return 125;
            bool cleanupVerified;
            using (var dynamicLease = WfpLoopbackLease.Install(sid, out cleanupVerified))
            using (var self = Process.GetCurrentProcess())
            {
                if (parent.HasExited) return 125;
                var response = new List<string> { nonce, self.Id.ToString(CultureInfo.InvariantCulture),
                    dynamicLease.SublayerKey.ToString("D") };
                response.AddRange(Array.ConvertAll(dynamicLease.FilterKeys, key => key.ToString("D")));
                response.AddRange(Array.ConvertAll(dynamicLease.FilterIds, id => id.ToString(CultureInfo.InvariantCulture)));
                WriteNew(Path.Combine(ownerRoot, FaultReceiptFile), String.Join(" ", response));
                parent.WaitForExit(FaultDeadlineMs + FaultOwnerTransitionMs);
            }
        }
        return 125;
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
