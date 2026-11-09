using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static partial class WfpIntegratedGuardian
{
    private const ushort BackupSublayerWeight = 0xFFFD;
    private const uint JobTerminate = 0x0008;
    private const int BackupStartupTimeoutMs = 8000;
    private const int BackupPrimaryTimeoutMs = WorkloadTimeoutMs + 2 * HandshakeTimeoutMs;
    private const int BackupPostLossTimeoutMs = 45000;
    private const string BackupPlanFile = "active-backup-plan.txt";
    private const string BackupPidFile = "active-backup-pid.txt";
    private const string BackupIdsFile = "active-backup-ids.txt";
    private const string BackupReadyFile = "active-backup-ready.txt";
    private const string BackupSurvivedFile = "active-backup-survived.txt";
    private const string BackupCleanupFile = "active-backup-cleanup.txt";
    private const string ProductionDrainFile = "guardian-drain-requested.txt";

    private sealed class BackupKeys
    {
        internal Guid Sublayer;
        internal Guid[] Filters;
        internal ulong[] Ids;
    }

    private sealed class ActiveBackupScope
    {
        internal string Image;
        internal Process Process;
        internal BackupKeys Keys;
    }

    private static ActiveBackupScope StartActiveBackup(string image, int primaryPid, OwnedHandle client, IntPtr sourceJob,
        int nodePid, byte[] sid, WfpLoopbackLease primary, WfpBfeWatch bfe)
    {
        uint wrapperPid = GetProcessId(client);
        if (wrapperPid == 0 || wrapperPid > Int32.MaxValue) throw LastError();
        var keys = new BackupKeys { Sublayer = Guid.NewGuid(), Filters = new Guid[6] };
        for (int index = 0; index < keys.Filters.Length; index++) keys.Filters[index] = Guid.NewGuid();
        if (!WfpLoopbackLease.VerifyExactDynamicAbsent(keys.Sublayer, keys.Filters))
            throw new InvalidDataException("GUARDIAN_BACKUP_PLAN_COLLISION");
        var primaryKeys = new BackupKeys { Sublayer = primary.SublayerKey, Filters = primary.FilterKeys, Ids = primary.FilterIds };
        PublishProtectedMarker(image, BackupPlanFile, String.Join(" ", new[] {
            primaryPid.ToString(CultureInfo.InvariantCulture), wrapperPid.ToString(CultureInfo.InvariantCulture),
            nodePid.ToString(CultureInfo.InvariantCulture), sourceJob.ToInt64().ToString(CultureInfo.InvariantCulture),
            FormatBackupKeys(primaryKeys), FormatBackupIds(primaryKeys.Ids), FormatBackupKeys(keys),
        }));

        string arguments = MxcPin.ProofProductionAdmission ? "--production-backup " + ProductionProofSession.RunId + " " +
            ProductionProofSession.OperatorPid.ToString(CultureInfo.InvariantCulture) + " " +
            ProductionProofSession.WrapperPid.ToString(CultureInfo.InvariantCulture) : "--governed-wfp-active-backup";
        var start = new ProcessStartInfo {
            FileName = image, Arguments = arguments, WorkingDirectory = ProtectedRunRoot(image),
            UseShellExecute = false, CreateNoWindow = true,
        };
        string systemRoot = Path.GetDirectoryName(Environment.SystemDirectory);
        start.EnvironmentVariables.Clear();
        start.EnvironmentVariables["SystemRoot"] = systemRoot;
        start.EnvironmentVariables["WINDIR"] = systemRoot;
        start.EnvironmentVariables["PATH"] = Environment.SystemDirectory;
        Process process = Process.Start(start);
        try
        {
            if (process == null || process.Handle == IntPtr.Zero) throw new InvalidDataException("GUARDIAN_BACKUP_START_FAILED");
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < BackupStartupTimeoutMs)
            {
                if (process.HasExited) throw new InvalidDataException("GUARDIAN_BACKUP_EXITED_BEFORE_READY");
                RequireLive(client);
                bfe.RequireHealthy();
                string ready = ReadProtectedBackupText(image, BackupReadyFile, 5, false);
                if (ready != null)
                {
                    string[] ids = ReadProtectedBackupText(image, BackupIdsFile, 125, true).Split(' ');
                    if (ids.Length != 6) throw new InvalidDataException("GUARDIAN_BACKUP_IDS_INVALID");
                    keys.Ids = ParseBackupIds(ids, 0);
                    var result = new ActiveBackupScope { Image = image, Process = process, Keys = keys };
                    VerifyActiveBackup(result, sid);
                    return result;
                }
                Thread.Sleep(SampleIntervalMs);
            }
            throw new TimeoutException();
        }
        catch
        {
            if (process != null) process.Dispose();
            throw;
        }
    }

    private static void VerifyActiveBackup(ActiveBackupScope backup, byte[] sid)
    {
        if (backup.Process.HasExited) throw new InvalidDataException("GUARDIAN_BACKUP_EXITED");
        if (ReadProtectedBackupText(backup.Image, BackupReadyFile, 5, true) != "READY" ||
            ReadProtectedBackupText(backup.Image, BackupPidFile, 10, true) != backup.Process.Id.ToString(CultureInfo.InvariantCulture))
            throw new InvalidDataException("GUARDIAN_BACKUP_READY_INVALID");
        VerifyBackupKeysInstalled(sid, backup.Keys, BackupSublayerWeight);
        if (backup.Process.HasExited) throw new InvalidDataException("GUARDIAN_BACKUP_EXITED");
    }

    internal static int RunActiveBackup()
    {
        if (!MxcPin.ProofProductionAdmission && (!MxcPin.GovernedWfpActiveLoss || MxcPin.GovernedWfpOwnerLoss)) return 125;
        OwnedHandle job = null;
        WfpContainerIdentity.OwnedHandle node = null;
        WfpLoopbackLease backup = null;
        string image = null;
        bool exactJobVerified = false;
        bool backupRemoved = false;
        string phase = "PREFLIGHT";
        try
        {
            image = ProtectedImage();
            using (var imagePin = OpenPinnedImage(image))
            using (var identity = WindowsIdentity.GetCurrent())
            using (var self = Process.GetCurrentProcess())
            using (var operatorProcess = OpenOperatorProcess(identity, self.SessionId))
            {
                string[] fields = ReadProtectedBackupText(image, BackupPlanFile, 1024, true).Split(' ');
                if (fields.Length != 24) throw new InvalidDataException("GUARDIAN_BACKUP_PLAN_INVALID");
                int primaryPid = ParseBackupPid(fields[0]);
                int wrapperPid = ParseBackupPid(fields[1]);
                int nodePid = ParseBackupPid(fields[2]);
                long source;
                if (primaryPid == wrapperPid || primaryPid == self.Id || wrapperPid == self.Id || nodePid == self.Id ||
                    (MxcPin.ProofProductionAdmission && wrapperPid != ProductionProofSession.WrapperPid) ||
                    !Int64.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out source) || source < 1)
                    throw new InvalidDataException("GUARDIAN_BACKUP_PLAN_INVALID");
                var primaryKeys = ParseBackupKeys(fields, 4);
                primaryKeys.Ids = ParseBackupIds(fields, 11);
                var backupKeys = ParseBackupKeys(fields, 17);
                var disjoint = new HashSet<Guid>(primaryKeys.Filters) { primaryKeys.Sublayer };
                if (disjoint.Contains(backupKeys.Sublayer) || disjoint.Overlaps(backupKeys.Filters))
                    throw new InvalidDataException("GUARDIAN_BACKUP_KEYS_OVERLAP");
                PublishProtectedMarker(image, BackupPidFile, self.Id.ToString(CultureInfo.InvariantCulture));

                phase = "IDENTITY";
                using (var primary = OpenBackupPeer(primaryPid, image, identity.User, self.SessionId, true))
                using (var client = OpenBackupPeer(wrapperPid, image, identity.User, self.SessionId, false))
                using (var bfe = new WfpBfeWatch())
                {
                    string expectedNode = Protocol.CanonicalPath(MxcPin.QualificationNodeExe, false);
                    job = DuplicateJob(client, new IntPtr(source), JobQuery | JobTerminate);
                    node = WfpContainerIdentity.OpenForJob(job.DangerousGetHandle(), nodePid);
                    byte[] sid = WfpContainerIdentity.ReadForJob(job.DangerousGetHandle(), node, expectedNode);
                    exactJobVerified = true;

                    phase = "INSTALL";
                    bfe.RequireHealthy();
                    VerifyBackupKeysInstalled(sid, primaryKeys, LeaseSublayerWeight);
                    if (!WfpLoopbackLease.VerifyExactDynamicAbsent(backupKeys.Sublayer, backupKeys.Filters))
                        throw new InvalidDataException("GUARDIAN_BACKUP_PLAN_COLLISION");
                    bool installationCleanupVerified;
                    backup = WfpLoopbackLease.InstallExactDynamic(sid, backupKeys.Sublayer, backupKeys.Filters,
                        BackupSublayerWeight, out installationCleanupVerified);
                    backupKeys.Ids = backup.FilterIds;
                    VerifyBackupKeysInstalled(sid, backupKeys, BackupSublayerWeight);
                    RequireLive(primary);
                    RequireLive(client);
                    bfe.RequireHealthy();
                    PublishProtectedMarker(image, BackupIdsFile, FormatBackupIds(backupKeys.Ids));
                    PublishProtectedMarker(image, BackupReadyFile, "READY");

                    if (MxcPin.ProofProductionAdmission && !ProductionProofSession.FaultMode)
                    {
                        phase = "PRODUCTION_DRAIN";
                        WaitForProductionDrain(image, primary, client, operatorProcess, job, node, bfe);
                        phase = "PRODUCTION_REMOVE";
                        VerifyBackupKeysInstalled(sid, primaryKeys, LeaseSublayerWeight);
                        VerifyBackupKeysInstalled(sid, backupKeys, BackupSublayerWeight);
                        backupRemoved = backup.ReleaseAndVerify();
                        if (!backupRemoved || !WfpLoopbackLease.VerifyExactDynamicAbsent(backupKeys.Sublayer, backupKeys.Filters))
                            throw new InvalidDataException("GUARDIAN_BACKUP_REMOVAL_UNVERIFIED");
                        bfe.RequireHealthy();
                        PublishProtectedMarker(image, BackupCleanupFile, "REMOVED");
                        return 0;
                    }

                    phase = "PRIMARY_LOSS";
                    WaitForPrimaryLoss(primary, client, operatorProcess, bfe);
                    WaitForPrimaryPolicyAbsence(primaryKeys, backupKeys, client, operatorProcess, job, node, expectedNode, sid, bfe);
                    PublishProtectedMarker(image, BackupSurvivedFile, "SURVIVED");

                    phase = "DRAIN";
                    WaitForExpectedBackupDrain(job, node, client, operatorProcess, bfe);
                    VerifyBackupKeysInstalled(sid, backupKeys, BackupSublayerWeight);
                    if (!WfpLoopbackLease.VerifyExactDynamicAbsent(primaryKeys.Sublayer, primaryKeys.Filters))
                        throw new InvalidDataException("GUARDIAN_PRIMARY_POLICY_PRESENT");
                    backupRemoved = backup.ReleaseAndVerify();
                    if (!backupRemoved || !WfpLoopbackLease.VerifyExactDynamicAbsent(backupKeys.Sublayer, backupKeys.Filters) ||
                        !WfpLoopbackLease.VerifyExactDynamicAbsent(primaryKeys.Sublayer, primaryKeys.Filters))
                        throw new InvalidDataException("GUARDIAN_BACKUP_REMOVAL_UNVERIFIED");
                    bfe.RequireHealthy();
                    PublishProtectedMarker(image, BackupCleanupFile, "REMOVED");
                    return 0;
                }
            }
        }
        catch (Win32Exception error)
        {
            string code = "WIN32_ERROR_" + error.NativeErrorCode.ToString(CultureInfo.InvariantCulture);
            TryPublishProductionFailure(image, ProductionBackupFailureFile, phase, code);
            Console.Error.WriteLine("[CLU-E WFP backup] " + phase + " " + code);
        }
        catch (Exception error)
        {
            string code = Regex.IsMatch(error.Message, @"\A(?:GUARDIAN|WFP|BFE)_[A-Z][A-Z0-9_]{0,72}(?:_0x[0-9A-F]{8})?\z")
                ? error.Message : error is TimeoutException ? "TIMEOUT" : "REFUSED";
            TryPublishProductionFailure(image, ProductionBackupFailureFile, phase, code);
            Console.Error.WriteLine("[CLU-E WFP backup] " + phase + " " + code);
        }
        finally
        {
            // A verified duplicate keeps kill-on-close from draining when the standard process dies.
            // On abnormal exit, take over termination and hold the backup until that exact job drains.
            if (exactJobVerified && !backupRemoved)
            {
                DrainFailedBackupJob(job, node);
                if (backup != null)
                {
                    try { backupRemoved = backup.ReleaseAndVerify(); }
                    catch (Exception) { }
                    if (!backupRemoved) Console.Error.WriteLine("[CLU-E WFP backup] REMOVAL_UNVERIFIED");
                }
            }
            if (node != null) node.Dispose();
            if (job != null) job.Dispose();
        }
        return 125;
    }

    private static void WaitForProductionDrain(string image, OwnedHandle primary, OwnedHandle client,
        OwnedHandle operatorProcess, OwnedHandle job, WfpContainerIdentity.OwnedHandle node, WfpBfeWatch bfe)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < ProductionWorkloadTimeoutMs + 2 * HandshakeTimeoutMs)
        {
            RequireLive(primary);
            RequireLive(client);
            RequireLive(operatorProcess);
            bfe.RequireHealthy();
            string drain = ReadProtectedBackupText(image, ProductionDrainFile, 5, false);
            if (drain != null)
            {
                if (drain != "DRAIN")
                    throw new InvalidDataException("GUARDIAN_BACKUP_PRODUCTION_DRAIN_INVALID");
                WaitForExactProductionDrain(job, node, client, operatorProcess, bfe, primary);
                return;
            }
            Thread.Sleep(SampleIntervalMs);
        }
        throw new TimeoutException();
    }

    private static void WaitForProductionBackupRemoval(ActiveBackupScope backup, OwnedHandle client,
        OwnedHandle operatorProcess, WfpBfeWatch bfe)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < AbortDrainTimeoutMs)
        {
            RequireLive(client);
            RequireLive(operatorProcess);
            bfe.RequireHealthy();
            if (backup.Process.HasExited)
            {
                if (backup.Process.ExitCode != 0 ||
                    ReadProtectedBackupText(backup.Image, BackupCleanupFile, 7, true) != "REMOVED" ||
                    !WfpLoopbackLease.VerifyExactDynamicAbsent(backup.Keys.Sublayer, backup.Keys.Filters))
                    throw new InvalidDataException("GUARDIAN_BACKUP_PRODUCTION_REMOVAL_INVALID");
                return;
            }
            Thread.Sleep(SampleIntervalMs);
        }
        throw new TimeoutException();
    }

    private static OwnedHandle OpenBackupPeer(int pid, string image, SecurityIdentifier sid, int session, bool elevated)
    {
        uint access = ProcessQueryLimitedInformation | Synchronize;
        if (!elevated) access |= ProcessDuplicateHandle;
        var process = OpenProcess(access, false, (uint)pid);
        try
        {
            if (process.IsInvalid) throw LastError();
            RequireLive(process);
            var path = new StringBuilder(4096);
            uint length = (uint)path.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, path, ref length)) throw LastError();
            if (!String.Equals(Protocol.CanonicalPath(path.ToString(), false), image, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("GUARDIAN_BACKUP_PEER_IMAGE_INVALID");
            RequireScopedToken(process, sid, session, elevated);
            RequireLive(process);
            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    private static void WaitForPrimaryLoss(OwnedHandle primary, OwnedHandle client, OwnedHandle operatorProcess, WfpBfeWatch bfe)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < BackupPrimaryTimeoutMs)
        {
            RequireLive(client);
            RequireLive(operatorProcess);
            bfe.RequireHealthy();
            uint wait = WaitForSingleObject(primary, SampleIntervalMs);
            if (wait == WaitTimeout) continue;
            if (wait != WaitObject) throw LastError();
            uint exit;
            if (!GetExitCodeProcess(primary, out exit)) throw LastError();
            if (exit != OwnerLossExitCode) throw new InvalidDataException("GUARDIAN_PRIMARY_EXIT_NOT_INJECTED");
            return;
        }
        throw new TimeoutException();
    }

    private static void WaitForPrimaryPolicyAbsence(BackupKeys primary, BackupKeys backup, OwnedHandle client,
        OwnedHandle operatorProcess, OwnedHandle job, WfpContainerIdentity.OwnedHandle node, string expectedNode,
        byte[] sid, WfpBfeWatch bfe)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < OwnerLossReadbackTimeoutMs)
        {
            RequireLive(client);
            RequireLive(operatorProcess);
            bfe.RequireHealthy();
            if (WfpLoopbackLease.VerifyExactDynamicAbsent(primary.Sublayer, primary.Filters))
            {
                if (!WfpContainerIdentity.Same(sid, WfpContainerIdentity.ReadForJob(job.DangerousGetHandle(), node, expectedNode)))
                    throw new InvalidDataException("GUARDIAN_BACKUP_NODE_IDENTITY_CHANGED");
                VerifyBackupKeysInstalled(sid, backup, BackupSublayerWeight);
                bfe.RequireHealthy();
                return;
            }
            Thread.Sleep(SampleIntervalMs);
        }
        throw new TimeoutException();
    }

    private static void WaitForExpectedBackupDrain(OwnedHandle job, WfpContainerIdentity.OwnedHandle node,
        OwnedHandle client, OwnedHandle operatorProcess, WfpBfeWatch bfe)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < BackupPostLossTimeoutMs)
        {
            RequireLive(client);
            RequireLive(operatorProcess);
            bfe.RequireHealthy();
            if (ExactBackupJobDrained(job, node)) return;
            Thread.Sleep(SampleIntervalMs);
        }
        throw new TimeoutException();
    }

    private static bool ExactBackupJobDrained(OwnedHandle job, WfpContainerIdentity.OwnedHandle node)
    {
        uint wait = WaitForSingleObject(node, 0);
        if (wait == WaitTimeout) return false;
        if (wait != WaitObject) throw LastError();
        return NativeJob.ReadJobProcessIds(job.DangerousGetHandle()).Length == 0;
    }

    private static void DrainFailedBackupJob(OwnedHandle job, WfpContainerIdentity.OwnedHandle node)
    {
        bool reported = false;
        var clock = Stopwatch.StartNew();
        while (true)
        {
            // Never close the backup lease merely because the drain deadline expired.
            TerminateJobObject(job, 125);
            try { if (ExactBackupJobDrained(job, node)) return; }
            catch (Exception) { }
            if (!reported && clock.ElapsedMilliseconds >= AbortDrainTimeoutMs)
            {
                try { Console.Error.WriteLine("[CLU-E WFP backup] ABORT_DRAIN_RETAINED"); }
                catch (Exception) { }
                reported = true;
            }
            Thread.Sleep(250);
        }
    }

    private static void VerifyBackupKeysInstalled(byte[] sid, BackupKeys keys, ushort weight)
    {
        WfpLoopbackLease.VerifyExactDynamicInstalled(sid, keys.Sublayer, keys.Filters, keys.Ids, weight);
    }

    private static string ReadProtectedBackupText(string image, string name, int maximumBytes, bool required)
    {
        string path = Path.Combine(ProtectedRunRoot(image), name);
        if (!required && !File.Exists(path)) return null;
        using (var stream = new FileStream(Protocol.CanonicalPath(path, false), FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var reader = new BinaryReader(stream))
        {
            if (stream.Length < 1 || stream.Length > maximumBytes) throw new InvalidDataException("GUARDIAN_BACKUP_RECORD_SIZE");
            int length = (int)stream.Length;
            byte[] bytes = reader.ReadBytes(length);
            if (bytes.Length != length || Array.Exists(bytes, value => value < 32 || value > 126))
                throw new InvalidDataException("GUARDIAN_BACKUP_RECORD_INVALID");
            return Encoding.ASCII.GetString(bytes);
        }
    }

    private static int ParseBackupPid(string value)
    {
        int pid;
        if (!Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid < 1)
            throw new InvalidDataException("GUARDIAN_BACKUP_PID_INVALID");
        return pid;
    }

    private static BackupKeys ParseBackupKeys(string[] fields, int offset)
    {
        var keys = new Guid[7];
        var unique = new HashSet<Guid>();
        for (int index = 0; index < keys.Length; index++)
        {
            string value = fields[offset + index];
            if (!Guid.TryParseExact(value, "D", out keys[index]) || keys[index].ToString("D") != value ||
                keys[index] == Guid.Empty || !unique.Add(keys[index])) throw new InvalidDataException("GUARDIAN_BACKUP_KEYS_INVALID");
        }
        var filters = new Guid[6];
        Array.Copy(keys, 1, filters, 0, filters.Length);
        return new BackupKeys { Sublayer = keys[0], Filters = filters };
    }

    private static ulong[] ParseBackupIds(string[] fields, int offset)
    {
        var ids = new ulong[6];
        for (int index = 0; index < ids.Length; index++)
            if (!UInt64.TryParse(fields[offset + index], NumberStyles.None, CultureInfo.InvariantCulture, out ids[index]) || ids[index] == 0)
                throw new InvalidDataException("GUARDIAN_BACKUP_IDS_INVALID");
        return ids;
    }

    private static string FormatBackupKeys(BackupKeys keys)
    {
        return keys.Sublayer.ToString("D") + " " + String.Join(" ", Array.ConvertAll(keys.Filters, key => key.ToString("D")));
    }

    private static string FormatBackupIds(ulong[] ids)
    {
        return String.Join(" ", Array.ConvertAll(ids, id => id.ToString(CultureInfo.InvariantCulture)));
    }

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint GetProcessId(OwnedHandle process);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(OwnedHandle process, out uint exitCode);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(OwnedHandle job, uint exitCode);
}
