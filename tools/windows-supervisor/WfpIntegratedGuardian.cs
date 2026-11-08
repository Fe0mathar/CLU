using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// The elevated half owns one WFP lease. The standard supervisor owns the job and workload.
internal static class WfpIntegratedGuardian
{
    private const int ConnectTimeoutMs = 1200000;
    private const int HandshakeTimeoutMs = 20000;
    private const int WorkloadTimeoutMs = 360000;
    private const int AbortDrainTimeoutMs = 8000;
    private const int SampleIntervalMs = 100;
    private const int MaxLineBytes = 96;
    private const ushort LeaseSublayerWeight = 0xFFFE;
    private const uint ProcessDuplicateHandle = 0x0040;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint JobQuery = 0x0004;
    private const uint TokenQuery = 0x0008;
    private const int TokenSessionId = 12;
    private const int TokenElevation = 20;
    private const int TokenIsAppContainer = 29;
    private const uint WaitObject = 0;
    private const uint WaitTimeout = 258;

    internal static string PipeName()
    {
        return "CLU-E-Governed-WFP-" + StageId();
    }

    private static string StageId()
    {
        if (!MxcPin.GovernedWfpIntegration || String.IsNullOrEmpty(MxcPin.ProofAdmissionStage) ||
            Path.GetFileName(MxcPin.ProofAdmissionStage) != "admission")
            throw new InvalidDataException("GUARDIAN_STAGE_PIN_INVALID");
        string outer = Path.GetFileName(Path.GetDirectoryName(MxcPin.ProofAdmissionStage));
        var match = Regex.Match(outer, @"\A\.setup-([a-f0-9]{32})\z", RegexOptions.CultureInvariant);
        if (!match.Success) throw new InvalidDataException("GUARDIAN_STAGE_PIN_INVALID");
        return match.Groups[1].Value;
    }

    internal static int Run()
    {
        NamedPipeServerStream pipe = null;
        OwnedHandle operatorProcess = null;
        OwnedHandle client = null;
        WfpContainerIdentity.OwnedHandle node = null;
        WfpLoopbackLease lease = null;
        WfpBfeWatch bfe = null;
        IntPtr sourceJob = IntPtr.Zero;
        bool removed = false;
        string phase = "PREFLIGHT";
        try
        {
            string image = ProtectedImage();
            using (var imagePin = OpenPinnedImage(image))
            using (var identity = WindowsIdentity.GetCurrent())
            using (var self = Process.GetCurrentProcess())
            {
                if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator) ||
                    TokenValue(identity.Token, TokenElevation) != 1 || identity.User == null)
                    throw new InvalidDataException("GUARDIAN_ELEVATION_REQUIRED");
                if (MxcPin.GovernedWfpOperatorPid < 1) throw new InvalidDataException("GUARDIAN_OPERATOR_PIN_INVALID");
                operatorProcess = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)MxcPin.GovernedWfpOperatorPid);
                if (operatorProcess.IsInvalid) throw LastError();
                RequireStandardToken(operatorProcess, identity.User, self.SessionId);
                string expectedNode = Protocol.CanonicalPath(MxcPin.QualificationNodeExe, false);
                phase = "CONNECT";
                pipe = OpenLocalPipe(PipeName(), identity.User);
                PublishReady(image);
                var pending = pipe.BeginWaitForConnection(null, null);
                var signal = pending.AsyncWaitHandle;
                var connectionClock = Stopwatch.StartNew();
                while (true)
                {
                    if (WaitForSingleObject(operatorProcess, 0) != WaitTimeout)
                        throw new InvalidDataException("GUARDIAN_OPERATOR_EXITED");
                    if (connectionClock.ElapsedMilliseconds >= ConnectTimeoutMs) throw new TimeoutException();
                    if (signal.WaitOne(SampleIntervalMs)) break;
                }
                pipe.EndWaitForConnection(pending);

                phase = "CLIENT_IDENTITY";
                client = OpenClient(pipe, image, identity.User, self.SessionId);
                bfe = new WfpBfeWatch();
                bfe.RequireHealthy();

                phase = "ARM";
                var clock = Stopwatch.StartNew();
                string[] arm = ReadLine(pipe, client, bfe, clock, HandshakeTimeoutMs).Split(' ');
                int nodePid;
                long handle;
                if (arm.Length != 3 || arm[0] != "ARM" ||
                    !Int32.TryParse(arm[1], NumberStyles.None, CultureInfo.InvariantCulture, out nodePid) || nodePid < 1 ||
                    !Int64.TryParse(arm[2], NumberStyles.None, CultureInfo.InvariantCulture, out handle) || handle < 1)
                    throw new InvalidDataException("GUARDIAN_ARM_INVALID");
                sourceJob = new IntPtr(handle);
                byte[] sid;
                using (var query = DuplicateJob(client, sourceJob))
                {
                    node = WfpContainerIdentity.OpenForJob(query.DangerousGetHandle(), nodePid);
                    sid = WfpContainerIdentity.ReadForJob(query.DangerousGetHandle(), node, expectedNode);
                }
                phase = "LEASE_INSTALL";
                bool installationCleanupVerified;
                lease = WfpLoopbackLease.Install(sid, out installationCleanupVerified, LeaseSublayerWeight);
                bfe.RequireHealthy();
                VerifyLiveScope(client, sourceJob, node, expectedNode, sid, lease);
                WriteLine(pipe, "ARMED", client, bfe);

                bool checkedOnce = false;
                while (true)
                {
                    phase = "COMMAND";
                    int deadline = checkedOnce ? HandshakeTimeoutMs + WorkloadTimeoutMs : 2 * HandshakeTimeoutMs;
                    string command = ReadLine(pipe, client, bfe, clock, deadline);
                    if (command == "CHECK")
                    {
                        if (checkedOnce) throw new InvalidDataException("GUARDIAN_DUPLICATE_CHECK");
                        phase = "CHECK";
                        VerifyLiveScope(client, sourceJob, node, expectedNode, sid, lease);
                        WriteLine(pipe, "CHECKED", client, bfe);
                        checkedOnce = true;
                        continue;
                    }
                    if (command != "DRAIN" || !checkedOnce) throw new InvalidDataException("GUARDIAN_COMMAND_INVALID");
                    phase = "DRAIN";
                    using (var query = DuplicateJob(client, sourceJob))
                    {
                        if (NativeJob.ReadJobProcessIds(query.DangerousGetHandle()).Length != 0 ||
                            WaitForSingleObject(node, 0) != WaitObject)
                            throw new InvalidDataException("GUARDIAN_JOB_NOT_DRAINED");
                    }
                    bfe.RequireHealthy();
                    removed = lease.ReleaseAndVerify();
                    if (!removed) throw new InvalidDataException("GUARDIAN_LEASE_REMOVAL_UNVERIFIED");
                    WriteLine(pipe, "REMOVED", client, bfe);
                    return 0;
                }
            }
        }
        catch (Win32Exception error)
        {
            Console.Error.WriteLine("[CLU-E WFP guardian] " + phase + " WIN32_ERROR_" + error.NativeErrorCode);
        }
        catch (TimeoutException)
        {
            Console.Error.WriteLine("[CLU-E WFP guardian] " + phase + " TIMEOUT");
        }
        catch (Exception error)
        {
            string code = Regex.IsMatch(error.Message, @"\A(?:GUARDIAN|WFP|BFE)_[A-Z][A-Z0-9_]{0,72}(?:_0x[0-9A-F]{8})?\z")
                ? error.Message : "REFUSED";
            Console.Error.WriteLine("[CLU-E WFP guardian] " + phase + " " + code);
        }
        finally
        {
            // Disconnect first so the standard supervisor can terminate its own job.
            if (pipe != null) pipe.Dispose();
            if (lease != null && !removed)
            {
                try
                {
                    if (WaitForAbortDrain(client, sourceJob, node)) removed = lease.ReleaseAndVerify();
                }
                catch (Exception) { }
                if (!removed) Console.Error.WriteLine("[CLU-E WFP guardian] ABORT_DRAIN_UNVERIFIED");
            }
            if (node != null) node.Dispose();
            if (client != null) client.Dispose();
            if (operatorProcess != null) operatorProcess.Dispose();
            if (bfe != null) bfe.Dispose();
        }
        return 125;
    }

    private static void VerifyLiveScope(OwnedHandle client, IntPtr sourceJob, WfpContainerIdentity.OwnedHandle node,
        string expectedNode, byte[] sid, WfpLoopbackLease lease)
    {
        using (var query = DuplicateJob(client, sourceJob))
        {
            if (!WfpContainerIdentity.Same(sid, WfpContainerIdentity.ReadForJob(query.DangerousGetHandle(), node, expectedNode)))
                throw new InvalidDataException("GUARDIAN_PACKAGE_IDENTITY_CHANGED");
        }
        WfpLoopbackLease.VerifyExactDynamicInstalled(sid, lease.SublayerKey, lease.FilterKeys, lease.FilterIds, LeaseSublayerWeight);
    }

    private static bool WaitForAbortDrain(OwnedHandle client, IntPtr sourceJob, WfpContainerIdentity.OwnedHandle node)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < AbortDrainTimeoutMs)
        {
            if (WaitForSingleObject(node, SampleIntervalMs) != WaitObject) continue;
            if (WaitForSingleObject(client, 0) == WaitObject) return true;
            try
            {
                using (var query = DuplicateJob(client, sourceJob))
                    if (NativeJob.ReadJobProcessIds(query.DangerousGetHandle()).Length == 0) return true;
            }
            catch (Win32Exception) { }
            Thread.Sleep(SampleIntervalMs);
        }
        return false;
    }

    private static string ProtectedImage()
    {
        string image = Protocol.CanonicalPath(Assembly.GetExecutingAssembly().Location, false);
        string programFiles = Protocol.CanonicalPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), true);
        string digest = Path.GetFileName(Path.GetDirectoryName(image));
        if (!Regex.IsMatch(digest, @"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant) ||
            !String.Equals(image, Path.Combine(programFiles, ".clue-governed-wfp-" + StageId(), digest,
                "CLU-E-Windows-Supervisor.exe"), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("GUARDIAN_INSTALLED_IMAGE_INVALID");
        return image;
    }

    private static FileStream OpenPinnedImage(string image)
    {
        var stream = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            if (stream.Length < 1 || stream.Length > 16L * 1024 * 1024)
                throw new InvalidDataException("GUARDIAN_IMAGE_SIZE_INVALID");
            using (var sha = SHA256.Create())
            {
                string digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (digest != Path.GetFileName(Path.GetDirectoryName(image)))
                    throw new InvalidDataException("GUARDIAN_IMAGE_PIN_MISMATCH");
            }
            return stream;
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static void PublishReady(string image)
    {
        string root = Protocol.CanonicalPath(Path.GetDirectoryName(Path.GetDirectoryName(image)), true);
        string marker = Path.Combine(root, "guardian-listening.txt");
        string temporary = marker + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                byte[] ready = Encoding.ASCII.GetBytes("READY");
                stream.Write(ready, 0, ready.Length);
                stream.Flush(true);
            }
            File.Move(temporary, marker);
        }
        finally { File.Delete(temporary); }
    }

    private static NamedPipeServerStream OpenLocalPipe(string name, SecurityIdentifier operatorSid)
    {
        const uint duplex = 3, firstInstance = 0x00080000, overlapped = 0x40000000;
        const uint rejectRemoteClients = 8;
        // A medium integrity label permits the same operator's filtered token to connect.
        string sddl = "D:P(A;;GA;;;SY)(A;;GRGW;;;" + operatorSid.Value + ")S:(ML;;NW;;;ME)";
        IntPtr descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero)) throw LastError();
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
            var handle = CreateNamedPipeW("\\\\.\\pipe\\" + name, duplex | firstInstance | overlapped, rejectRemoteClients,
                1, 4096, 4096, 1000, ref attributes);
            if (handle.IsInvalid)
            {
                var failure = LastError();
                handle.Dispose();
                throw failure;
            }
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
            catch { handle.Dispose(); throw; }
        }
        finally { LocalFree(descriptor); }
    }

    private static OwnedHandle OpenClient(NamedPipeServerStream pipe, string image, SecurityIdentifier operatorSid, int session)
    {
        uint pid;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid)) throw LastError();
        if (pid == 0 || pid > Int32.MaxValue) throw new InvalidDataException("GUARDIAN_CLIENT_PID_INVALID");
        var process = OpenProcess(ProcessDuplicateHandle | ProcessQueryLimitedInformation | Synchronize, false, pid);
        try
        {
            if (process.IsInvalid) throw LastError();
            RequireLive(process);
            var actual = new StringBuilder(4096);
            uint length = (uint)actual.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, actual, ref length)) throw LastError();
            if (!String.Equals(Protocol.CanonicalPath(actual.ToString(), false), image, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("GUARDIAN_CLIENT_IMAGE_INVALID");
            RequireStandardToken(process, operatorSid, session);
            RequireLive(process);
            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    private static void RequireStandardToken(OwnedHandle process, SecurityIdentifier operatorSid, int session)
    {
        OwnedHandle token;
        if (!OpenProcessToken(process, TokenQuery, out token)) throw LastError();
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
        {
            IntPtr raw = token.DangerousGetHandle();
            if (!operatorSid.Equals(identity.User) || TokenValue(raw, TokenSessionId) != (uint)session ||
                TokenValue(raw, TokenElevation) != 0 || TokenValue(raw, TokenIsAppContainer) != 0)
                throw new InvalidDataException("GUARDIAN_STANDARD_TOKEN_INVALID");
        }
    }

    private static OwnedHandle DuplicateJob(OwnedHandle client, IntPtr sourceJob)
    {
        RequireLive(client);
        OwnedHandle duplicate;
        if (!DuplicateHandle(client, sourceJob, GetCurrentProcess(), out duplicate, JobQuery, false, 0)) throw LastError();
        if (duplicate.IsInvalid)
        {
            duplicate.Dispose();
            throw new InvalidDataException("GUARDIAN_JOB_HANDLE_INVALID");
        }
        return duplicate;
    }

    private static uint TokenValue(IntPtr token, int type)
    {
        uint value, length;
        if (!GetTokenInformation(token, type, out value, 4, out length)) throw LastError();
        if (length != 4) throw new InvalidDataException("GUARDIAN_TOKEN_INFORMATION_INVALID");
        return value;
    }

    private static void RequireLive(OwnedHandle process)
    {
        if (WaitForSingleObject(process, 0) != WaitTimeout) throw new InvalidDataException("GUARDIAN_CLIENT_EXITED");
    }

    private static string ReadLine(NamedPipeServerStream pipe, OwnedHandle client, WfpBfeWatch bfe, Stopwatch clock, int deadline)
    {
        var line = new StringBuilder(MaxLineBytes);
        var next = new byte[1];
        while (line.Length < MaxLineBytes)
        {
            var pending = pipe.BeginRead(next, 0, 1, null, null);
            AwaitSignal(pending.AsyncWaitHandle, client, bfe, clock, deadline);
            if (pipe.EndRead(pending) != 1) throw new EndOfStreamException();
            if (next[0] == 10) return line.ToString();
            if (next[0] < 32 || next[0] > 126) throw new InvalidDataException("GUARDIAN_WIRE_INVALID");
            line.Append((char)next[0]);
        }
        throw new InvalidDataException("GUARDIAN_WIRE_LIMIT");
    }

    private static void WriteLine(NamedPipeServerStream pipe, string line, OwnedHandle client, WfpBfeWatch bfe)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
        var pending = pipe.BeginWrite(bytes, 0, bytes.Length, null, null);
        AwaitSignal(pending.AsyncWaitHandle, client, bfe, Stopwatch.StartNew(), HandshakeTimeoutMs);
        pipe.EndWrite(pending);
    }

    private static void AwaitSignal(WaitHandle signal, OwnedHandle client, WfpBfeWatch bfe, Stopwatch clock, int deadline)
    {
        while (true)
        {
            RequireLive(client);
            bfe.RequireHealthy();
            long remaining = deadline - clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new TimeoutException();
            if (signal.WaitOne((int)Math.Min(SampleIntervalMs, remaining))) return;
        }
    }

    private static Win32Exception LastError() { return new Win32Exception(Marshal.GetLastWin32Error()); }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool Inherit;
    }

    private sealed class OwnedHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public OwnedHandle() : base(true) { }
        protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint version,
        out IntPtr descriptor, IntPtr size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint instances,
        uint outputBuffer, uint inputBuffer, uint timeout, ref SecurityAttributes attributes);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint processId);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern OwnedHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(OwnedHandle process, uint flags, StringBuilder path, ref uint length);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(OwnedHandle process, uint access, out OwnedHandle token);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(IntPtr token, int type, out uint value, uint length, out uint written);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(OwnedHandle source, IntPtr handle, IntPtr target,
        out OwnedHandle duplicate, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
}
