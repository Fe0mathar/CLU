using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal sealed class WfpIntegratedRun : IDisposable
{
    private const int PipeTimeoutMs = 4000;
    private const int ActivePipeTimeoutMs = 12000;
    private const int MarkerTimeoutMs = 15000;
    private const uint OwnerLossNodeExitTimeoutMs = 5000;
    private const int OwnerLossCleanupTimeoutMs = 25000;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint TokenQuery = 0x0008;
    private const int TokenUser = 1;
    private const int TokenSessionId = 12;
    private const int TokenElevation = 20;
    private const uint WaitObject = 0;
    private const uint WaitTimeout = 258;
    private const uint WaitFailed = 0xFFFFFFFF;

    private readonly Request request;
    private readonly string workspace;
    private readonly string pipeName;
    private readonly ProcessIdentity operatorIdentity;
    private readonly Stopwatch stageClock = Stopwatch.StartNew();
    private readonly byte[] responseByte = new byte[1];

    private enum Phase { NodeStart, Control, Armed, Workload, OwnerLoss, Active, ActiveFault, ActiveFaultSample }
    private Phase phase;
    private int nodePid;
    private int[] control, armed, active, fault;
    private byte[] packageSid;
    private WfpContainerIdentity.OwnedHandle node;
    private WfpContainerIdentity.OwnedHandle guardian;
    private WfpContainerIdentity.OwnedHandle backup;
    private NamedPipeClientStream pipe;
    private IAsyncResult pendingResponse;
    private bool identityVerified, leaseVerified, removalVerified, failed, finished, passed;
    private bool guardianLossDetected, ownerExitVerified, nodeExited, releaseWithheld, ownerLossObserved;
    private bool backupSurvived;
    private bool productionBackupVerified;

    internal WfpIntegratedRun(Request request)
    {
        this.request = request;
        workspace = Protocol.CanonicalPath(request.productionProof
            ? request.productionGateDirectory : Path.Combine(request.fixtureRoot, "workspace"), true);
        pipeName = WfpIntegratedGuardian.PipeName();
        using (var self = OpenProcess(ProcessQueryLimitedInformation, false, GetCurrentProcessId()))
        {
            if (self.IsInvalid) throw LastError();
            operatorIdentity = ReadProcessIdentity(self);
            if (operatorIdentity.Elevated || operatorIdentity.Session == 0)
                throw new InvalidDataException("GOVERNED_WFP_WRAPPER_MUST_BE_STANDARD_USER");
        }
    }

    internal void Observe(IntPtr job)
    {
        try
        {
            if (phase != Phase.Workload && stageClock.ElapsedMilliseconds >= MarkerTimeoutMs)
                throw new TimeoutException("GOVERNED_WFP_STAGE_TIMEOUT");
            switch (phase)
            {
                case Phase.NodeStart:
                    string started = ReadMarker("wfp-start.txt");
                    if (started == null) return;
                    if (!Int32.TryParse(started.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out nodePid) || nodePid < 1)
                        throw new InvalidDataException("GOVERNED_WFP_NODE_PID_INVALID");
                    node = WfpContainerIdentity.OpenForJob(job, nodePid);
                    packageSid = WfpContainerIdentity.ReadForJob(job, node, request.command);
                    identityVerified = true;
                    Release("wfp-control-go.txt");
                    phase = Phase.Control;
                    break;
                case Phase.Control:
                    control = ReadBinds("wfp-control-result.txt");
                    if (control == null) return;
                    RequireBinds(control, 0);
                    RequireSameNode(job);
                    ConnectGuardian();
                    Exchange("ARM " + nodePid.ToString(CultureInfo.InvariantCulture) + " " +
                        job.ToInt64().ToString(CultureInfo.InvariantCulture), "ARMED");
                    RequireSameNode(job);
                    Release("wfp-armed-go.txt");
                    phase = Phase.Armed;
                    break;
                case Phase.Armed:
                    RequireGuardian();
                    armed = ReadBinds("wfp-armed-result.txt");
                    if (armed == null) return;
                    RequireBinds(armed, 10013);
                    RequireSameNode(job);
                    Exchange("CHECK", "CHECKED");
                    RequireSameNode(job);
                    leaseVerified = true;
                    pendingResponse = BeginReadResponse();
                    RequireGuardian();
                    if (MxcPin.GovernedWfpActiveLoss)
                    {
                        RequireReleaseAbsent();
                        ConnectBackup();
                        Release("wfp-active-go.txt");
                        phase = Phase.Active;
                        break;
                    }
                    if (MxcPin.GovernedWfpOwnerLoss)
                    {
                        RequireReleaseAbsent();
                        WriteLine("FAULT");
                        phase = Phase.OwnerLoss;
                        break;
                    }
                    if (request.productionProof)
                    {
                        ConnectBackup();
                        productionBackupVerified = true;
                    }
                    Release("wfp-release-go.txt");
                    phase = Phase.Workload;
                    break;
                case Phase.Workload:
                case Phase.OwnerLoss:
                    RequireGuardian();
                    if (request.productionProof) RequireBackup();
                    return;
                case Phase.Active:
                    RequireGuardian();
                    RequireBackup();
                    active = ReadBinds("wfp-active-result.txt");
                    if (active == null) return;
                    RequireBinds(active, 10013);
                    RequireSameNode(job);
                    RequireReleaseAbsent();
                    WriteLine("FAULT");
                    phase = Phase.ActiveFault;
                    break;
                case Phase.ActiveFault:
                    RequireBackup();
                    uint wait = WaitForSingleObject(guardian, 0);
                    if (wait == WaitTimeout) return;
                    if (wait == WaitFailed) throw LastError();
                    if (wait != WaitObject || !ExactGuardianExit())
                        throw new InvalidDataException("GOVERNED_WFP_OWNER_LOSS_EXIT_UNVERIFIED");
                    ownerExitVerified = true;
                    string survived = ReadProtectedMarker("active-backup-survived.txt");
                    if (survived == null) return;
                    if (survived != "SURVIVED")
                        throw new InvalidDataException("GOVERNED_WFP_ACTIVE_BACKUP_READBACK_INVALID");
                    RequireBackup();
                    RequireSameNode(job);
                    backupSurvived = true;
                    Release("wfp-fault-go.txt");
                    phase = Phase.ActiveFaultSample;
                    break;
                case Phase.ActiveFaultSample:
                    RequireBackup();
                    fault = ReadBinds("wfp-fault-result.txt");
                    if (fault == null) return;
                    RequireBinds(fault, 10013);
                    RequireSameNode(job);
                    RequireReleaseAbsent();
                    guardianLossDetected = true;
                    throw new InvalidDataException("GOVERNED_WFP_ACTIVE_OWNER_LOSS_ABORT");
            }
            stageClock.Restart();
        }
        catch (Exception failure)
        {
            failed = true;
            if (phase == Phase.OwnerLoss)
                guardianLossDetected = failure is InvalidDataException && failure.Message == "GOVERNED_WFP_GUARDIAN_LOST";
            ReportFailure(phase.ToString(), failure);
            throw;
        }
    }

    // Called by NativeJob's drained callback, while its exact job handle still exists.
    internal bool Finish(bool jobEmpty)
    {
        if (finished) return passed;
        finished = true;
        try
        {
            if (MxcPin.GovernedWfpOwnerLoss || MxcPin.GovernedWfpActiveLoss)
            {
                if (guardianLossDetected && jobEmpty) VerifyOwnerLoss();
            }
            else if (!failed && jobEmpty && phase == Phase.Workload)
            {
                RequireGuardian();
                WriteLine("DRAIN");
                if (ReadLine(pendingResponse) != "REMOVED")
                    throw new InvalidDataException("GOVERNED_WFP_REMOVAL_UNVERIFIED");
                if (request.productionProof) AcknowledgeProductionDrain();
                removalVerified = true;
                passed = true;
            }
        }
        catch (IOException failure) { ReportFailure("Drain", failure); }
        catch (InvalidDataException failure) { ReportFailure("Drain", failure); }
        catch (InvalidOperationException failure) { ReportFailure("Drain", failure); }
        catch (TimeoutException failure) { ReportFailure("Drain", failure); }
        catch (Win32Exception failure) { ReportFailure("Drain", failure); }
        finally
        {
            if (request.productionProof && !passed)
            {
                ReportProductionDrainFailure(WfpIntegratedGuardian.ProductionPrimaryFailureFile, "PrimaryDrain");
                ReportProductionDrainFailure(WfpIntegratedGuardian.ProductionBackupFailureFile, "BackupDrain");
            }
            Dispose();
            WriteResult(jobEmpty);
        }
        return passed;
    }

    private void AcknowledgeProductionDrain()
    {
        if (ReadProtectedMarker(WfpIntegratedGuardian.ProductionRemovalFile) != "REMOVED")
            throw new InvalidDataException("GOVERNED_WFP_PROTECTED_REMOVAL_UNVERIFIED");
        WriteLine("ACK");
        uint wait = WaitForSingleObject(guardian, WfpIntegratedGuardian.ProductionDrainAckTimeoutMs);
        if (wait == WaitFailed) throw LastError();
        uint exit;
        if (wait != WaitObject || !GetExitCodeProcess(guardian, out exit) || exit != 0 ||
            ReadProtectedMarker(WfpIntegratedGuardian.ProductionDrainAckFile) != "ACK")
            throw new InvalidDataException("GOVERNED_WFP_DRAIN_ACK_UNVERIFIED");
    }

    private static void ReportProductionDrainFailure(string name, string role)
    {
        try
        {
            string value = ReadProtectedMarker(name, 112);
            if (value == null) return;
            var match = Regex.Match(value.ToUpperInvariant(), @"\A([A-Z_]{1,24}) ([A-Z0-9_]{1,86})\z");
            if (match.Success && value.Length <= 90)
                Console.Error.WriteLine("[CLU-E governed WFP] " + role + " " + match.Groups[1].Value + "_" + match.Groups[2].Value);
        }
        catch (Exception) { }
    }

    private void VerifyOwnerLoss()
    {
        ownerExitVerified = WaitForSingleObject(guardian, PipeTimeoutMs) == WaitObject && ExactGuardianExit();
        // Job accounting and the retained process handle provide separate exit evidence.
        uint nodeWait = WaitForSingleObject(node, OwnerLossNodeExitTimeoutMs);
        int nodeWaitError = nodeWait == WaitFailed ? Marshal.GetLastWin32Error() : 0;
        nodeExited = nodeWait == WaitObject;
        RequireReleaseAbsent();
        releaseWithheld = true;
        if (!ownerExitVerified)
            throw new InvalidDataException("GOVERNED_WFP_OWNER_LOSS_EXIT_UNVERIFIED");

        string name = MxcPin.GovernedWfpActiveLoss ? "active-backup-cleanup.txt" : "owner-loss-cleanup.txt";
        var clock = Stopwatch.StartNew();
        string marker = ReadProtectedMarker(name);
        while (marker == null && clock.ElapsedMilliseconds < OwnerLossCleanupTimeoutMs)
        {
            Thread.Sleep(30);
            marker = ReadProtectedMarker(name);
        }
        if (marker == null) throw new TimeoutException("GOVERNED_WFP_OWNER_LOSS_CLEANUP_TIMEOUT");
        if (marker != "REMOVED") throw new InvalidDataException("GOVERNED_WFP_OWNER_LOSS_CLEANUP_INVALID");
        removalVerified = true;
        if (nodeWait == WaitFailed) throw new Win32Exception(nodeWaitError);
        if (!nodeExited)
            throw new InvalidDataException(nodeWait == WaitTimeout
                ? "GOVERNED_WFP_OWNER_LOSS_NODE_EXIT_TIMEOUT" : "GOVERNED_WFP_OWNER_LOSS_NODE_EXIT_UNVERIFIED");
        ownerLossObserved = true;
    }

    private bool ExactGuardianExit()
    {
        uint exit;
        return GetExitCodeProcess(guardian, out exit) && exit == WfpIntegratedGuardian.OwnerLossExitCode;
    }

    private static string ReadProtectedMarker(string name, int maximumBytes = 16)
    {
        string imageDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string root = MxcPin.ProofProductionAdmission ? ProductionProofSession.RunRoot : Path.GetDirectoryName(imageDirectory);
        string marker = Path.Combine(root, name);
        if (!File.Exists(marker)) return null;
        using (var input = new FileStream(Protocol.CanonicalPath(marker, false), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (input.Length < 1 || input.Length > maximumBytes)
                throw new InvalidDataException("GOVERNED_WFP_PROTECTED_MARKER_INVALID");
            var text = new StringBuilder((int)input.Length);
            for (int i = 0; i < input.Length; i++)
            {
                int value = input.ReadByte();
                if (value < 32 || value > 126)
                    throw new InvalidDataException("GOVERNED_WFP_PROTECTED_MARKER_INVALID");
                text.Append((char)value);
            }
            return text.ToString();
        }
    }

    private void RequireReleaseAbsent()
    {
        string physical = Protocol.CanonicalPath(workspace, true);
        try { File.GetAttributes(Path.Combine(physical, "wfp-release-go.txt")); }
        catch (FileNotFoundException) { return; }
        throw new InvalidDataException("GOVERNED_WFP_RELEASE_GATE_PRESENT");
    }

    public void Dispose()
    {
        if (pipe != null) { pipe.Dispose(); pipe = null; }
        if (guardian != null) { guardian.Dispose(); guardian = null; }
        if (backup != null) { backup.Dispose(); backup = null; }
        if (node != null) { node.Dispose(); node = null; }
    }

    private static void ReportFailure(string phase, Exception failure)
    {
        var native = failure as Win32Exception;
        string code = native != null && native.NativeErrorCode >= 0
            ? "WIN32_ERROR_" + native.NativeErrorCode.ToString(CultureInfo.InvariantCulture)
            : Regex.IsMatch(failure.Message, @"\AGOVERNED_WFP_[A-Z0-9_]{1,62}\z", RegexOptions.CultureInvariant)
                ? failure.Message : failure is TimeoutException ? "TIMEOUT" : "REFUSED";
        Console.Error.WriteLine("[CLU-E governed WFP] " + phase + " " + code);
    }

    private void RequireSameNode(IntPtr job)
    {
        if (!WfpContainerIdentity.Same(packageSid, WfpContainerIdentity.ReadForJob(job, node, request.command)))
            throw new InvalidDataException("GOVERNED_WFP_NODE_IDENTITY_CHANGED");
    }

    private void ConnectGuardian()
    {
        pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification);
        pipe.Connect(PipeTimeoutMs);
        uint pid;
        uint clientPid = GetCurrentProcessId();
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || pid == 0 || pid == clientPid)
            throw new InvalidDataException("GOVERNED_WFP_GUARDIAN_PID_UNVERIFIED");
        guardian = OpenElevatedPeer(pid);
        RequireGuardian();
        // The held handle prevents a recycled PID from becoming the verified peer.
        uint confirmedPid;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out confirmedPid) || confirmedPid != pid)
            throw new InvalidDataException("GOVERNED_WFP_GUARDIAN_IDENTITY_CHANGED");
        RequireGuardian();
    }

    private void ConnectBackup()
    {
        uint pid, primaryPid;
        string value = ReadProtectedMarker("active-backup-pid.txt");
        if (!UInt32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out pid) ||
            pid == 0 || pid == GetCurrentProcessId() ||
            !GetNamedPipeServerProcessId(pipe.SafePipeHandle, out primaryPid) || pid == primaryPid)
            throw new InvalidDataException("GOVERNED_WFP_ACTIVE_BACKUP_PID_INVALID");
        backup = OpenElevatedPeer(pid);
        RequireBackup();
    }

    private WfpContainerIdentity.OwnedHandle OpenElevatedPeer(uint pid)
    {
        var process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, pid);
        try
        {
            if (process.IsInvalid) throw LastError();
            var image = new StringBuilder(4096);
            uint length = (uint)image.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, image, ref length)) throw LastError();
            string expected = Protocol.CanonicalPath(Assembly.GetExecutingAssembly().Location, false);
            var identity = ReadProcessIdentity(process);
            if (!String.Equals(expected, Protocol.CanonicalPath(image.ToString(), false), StringComparison.OrdinalIgnoreCase) ||
                !identity.Elevated || identity.Session != operatorIdentity.Session || !operatorIdentity.User.Equals(identity.User))
                throw new InvalidDataException("GOVERNED_WFP_GUARDIAN_IDENTITY_UNVERIFIED");
            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    private void RequireBackup()
    {
        if (backup == null || backup.IsInvalid || WaitForSingleObject(backup, 0) != WaitTimeout)
            throw new InvalidDataException("GOVERNED_WFP_ACTIVE_BACKUP_LOST");
    }

    private void RequireGuardian()
    {
        if (guardian == null || guardian.IsInvalid || WaitForSingleObject(guardian, 0) != WaitTimeout ||
            pipe == null || !pipe.IsConnected || (pendingResponse != null && pendingResponse.IsCompleted))
            throw new InvalidDataException("GOVERNED_WFP_GUARDIAN_LOST");
    }

    private void Exchange(string command, string expected)
    {
        RequireGuardian();
        WriteLine(command);
        if (ReadLine(null) != expected) throw new InvalidDataException("GOVERNED_WFP_GUARDIAN_RESPONSE_INVALID");
        RequireGuardian();
    }

    private void WriteLine(string line)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
        var pending = pipe.BeginWrite(bytes, 0, bytes.Length, null, null);
        Await(pending, Stopwatch.StartNew());
        pipe.EndWrite(pending);
    }

    private IAsyncResult BeginReadResponse()
    {
        return pipe.BeginRead(responseByte, 0, 1, null, null);
    }

    private string ReadLine(IAsyncResult pending)
    {
        var timeout = Stopwatch.StartNew();
        var line = new StringBuilder();
        while (line.Length < 24)
        {
            if (pending == null) pending = BeginReadResponse();
            Await(pending, timeout);
            if (pipe.EndRead(pending) != 1) throw new IOException("GOVERNED_WFP_GUARDIAN_PIPE_CLOSED");
            pending = null;
            int value = responseByte[0];
            if (value == '\n') return line.ToString();
            if (value < 'A' || value > 'Z') throw new InvalidDataException("GOVERNED_WFP_GUARDIAN_RESPONSE_INVALID");
            line.Append((char)value);
        }
        throw new InvalidDataException("GOVERNED_WFP_GUARDIAN_RESPONSE_TOO_LONG");
    }

    private static void Await(IAsyncResult pending, Stopwatch timeout)
    {
        int limit = MxcPin.GovernedWfpActiveLoss || MxcPin.ProofProductionAdmission ? ActivePipeTimeoutMs : PipeTimeoutMs;
        while (!pending.IsCompleted)
        {
            if (timeout.ElapsedMilliseconds >= limit)
                throw new TimeoutException("GOVERNED_WFP_GUARDIAN_PIPE_TIMEOUT");
            Thread.Sleep(5);
        }
    }

    private string ReadMarker(string name)
    {
        string path = Path.Combine(workspace, name);
        if (!File.Exists(path)) return null;
        try
        {
            using (var input = new FileStream(Protocol.CanonicalPath(path, false), FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (input.Length == 0) return null;
                if (input.Length > 64) throw new InvalidDataException("GOVERNED_WFP_MARKER_TOO_LONG");
                int length = (int)input.Length;
                var result = new StringBuilder(length);
                for (int i = 0; i < length; i++)
                {
                    int value = input.ReadByte();
                    if ((value < '0' || value > '9') && value != ' ' && value != '\t' && value != '\r' && value != '\n')
                        throw new InvalidDataException("GOVERNED_WFP_MARKER_INVALID");
                    result.Append((char)value);
                }
                return result.ToString();
            }
        }
        catch (IOException error)
        {
            // A marker may exist while the bootstrap still has it open for writing.
            int code = Marshal.GetHRForException(error) & 0xffff;
            if (code == 32 || code == 33) return null;
            throw;
        }
    }

    private int[] ReadBinds(string name)
    {
        string text = ReadMarker(name);
        if (text == null) return null;
        string[] parts = text.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 4) throw new InvalidDataException("GOVERNED_WFP_BIND_MARKER_INVALID");
        var values = new int[4];
        for (int i = 0; i < values.Length; i++)
            if (!Int32.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out values[i]))
                throw new InvalidDataException("GOVERNED_WFP_BIND_MARKER_INVALID");
        return values;
    }

    private static void RequireBinds(int[] values, int expected)
    {
        foreach (int value in values)
            if (value != expected) throw new InvalidDataException("GOVERNED_WFP_BIND_OUTCOME_MISMATCH");
    }

    private void Release(string name)
    {
        string physical = Protocol.CanonicalPath(workspace, true);
        WriteNew(Path.Combine(physical, name), "GO");
    }

    private void WriteResult(bool jobEmpty)
    {
        string directory = Protocol.CanonicalPath(Path.GetDirectoryName(request.requestPath), true);
        string path = Path.Combine(directory, "wfp-integration-result.json");
        var serializer = new JavaScriptSerializer { MaxJsonLength = 4096 };
        if (request.productionProof)
        {
            WriteNew(path, serializer.Serialize(new {
                schemaVersion = "clue-windows-production-wfp/1",
                state = passed ? "PRODUCTION_WFP_LIFECYCLE_VERIFIED" : "PRODUCTION_WFP_LIFECYCLE_UNVERIFIED",
                identityVerified, leaseVerified, jobEmpty, removalVerified, control, armed, productionBackupVerified,
                proofAuthorization = false,
            }));
            return;
        }
        if (MxcPin.GovernedWfpActiveLoss)
        {
            WriteNew(path, serializer.Serialize(new {
                schemaVersion = "clue-windows-governed-wfp-active-loss/1",
                state = ownerLossObserved ? "GOVERNED_WFP_ACTIVE_LOSS_OBSERVED" : "GOVERNED_WFP_ACTIVE_LOSS_UNVERIFIED",
                identityVerified, leaseVerified, jobEmpty, removalVerified, control, armed, proofAuthorization = false,
                ownerExitVerified, nodeExited, releaseWithheld, backupSurvived, active, fault,
            }));
            return;
        }
        if (MxcPin.GovernedWfpOwnerLoss)
        {
            WriteNew(path, serializer.Serialize(new {
                schemaVersion = "clue-windows-governed-wfp-owner-loss/1",
                state = ownerLossObserved ? "GOVERNED_WFP_OWNER_LOSS_OBSERVED" : "GOVERNED_WFP_OWNER_LOSS_UNVERIFIED",
                identityVerified, leaseVerified, jobEmpty, removalVerified, control, armed, proofAuthorization = false,
                ownerExitVerified, nodeExited, releaseWithheld,
            }));
            return;
        }
        WriteNew(path, serializer.Serialize(new {
            schemaVersion = "clue-windows-governed-wfp-integration/1",
            state = passed ? "GOVERNED_WFP_LEASE_OBSERVED" : "GOVERNED_WFP_LEASE_UNVERIFIED",
            identityVerified, leaseVerified, jobEmpty, removalVerified, control, armed, proofAuthorization = false,
        }));
    }

    private static void WriteNew(string path, string value)
    {
        using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            output.Write(bytes, 0, bytes.Length);
        }
    }

    private sealed class ProcessIdentity
    {
        internal SecurityIdentifier User;
        internal uint Session;
        internal bool Elevated;
    }

    private static ProcessIdentity ReadProcessIdentity(WfpContainerIdentity.OwnedHandle process)
    {
        WfpContainerIdentity.OwnedHandle token;
        if (!OpenProcessToken(process, TokenQuery, out token)) throw LastError();
        using (token)
        {
            uint elevated, session, size;
            if (token.IsInvalid || !ReadTokenUInt(token, TokenElevation, out elevated, sizeof(uint), out size) ||
                size != sizeof(uint) || elevated > 1)
                throw new InvalidDataException("GOVERNED_WFP_TOKEN_ELEVATION_UNVERIFIED");
            if (!ReadTokenUInt(token, TokenSessionId, out session, sizeof(uint), out size) || size != sizeof(uint))
                throw new InvalidDataException("GOVERNED_WFP_TOKEN_SESSION_UNVERIFIED");
            if (ReadTokenBuffer(token, TokenUser, IntPtr.Zero, 0, out size) || Marshal.GetLastWin32Error() != 122 ||
                size < IntPtr.Size || size > 512)
                throw new InvalidDataException("GOVERNED_WFP_TOKEN_USER_UNVERIFIED");
            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                uint used;
                if (!ReadTokenBuffer(token, TokenUser, buffer, size, out used) || used > size || used < IntPtr.Size)
                    throw new InvalidDataException("GOVERNED_WFP_TOKEN_USER_UNVERIFIED");
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                long offset = sid.ToInt64() - buffer.ToInt64();
                if (offset < IntPtr.Size || offset > used - 8L || !IsValidSid(sid) || GetLengthSid(sid) > used - offset)
                    throw new InvalidDataException("GOVERNED_WFP_TOKEN_USER_UNVERIFIED");
                return new ProcessIdentity { User = new SecurityIdentifier(sid), Session = session, Elevated = elevated == 1 };
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    private static Win32Exception LastError() { return new Win32Exception(Marshal.GetLastWin32Error()); }

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern uint GetCurrentProcessId();

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern WfpContainerIdentity.OwnedHandle OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint WaitForSingleObject(WfpContainerIdentity.OwnedHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool GetExitCodeProcess(WfpContainerIdentity.OwnedHandle process, out uint exitCode);

    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(WfpContainerIdentity.OwnedHandle process, uint flags,
        StringBuilder path, ref uint length);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool OpenProcessToken(WfpContainerIdentity.OwnedHandle process, uint access,
        out WfpContainerIdentity.OwnedHandle token);

    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", ExactSpelling = true, SetLastError = true)]
    private static extern bool ReadTokenUInt(WfpContainerIdentity.OwnedHandle token, int informationClass,
        out uint value, uint size, out uint required);

    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", ExactSpelling = true, SetLastError = true)]
    private static extern bool ReadTokenBuffer(WfpContainerIdentity.OwnedHandle token, int informationClass,
        IntPtr buffer, uint size, out uint required);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern bool IsValidSid(IntPtr sid);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetLengthSid(IntPtr sid);
}
