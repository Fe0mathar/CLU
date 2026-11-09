using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ProductionProofSession
{
    private const int StartTimeoutMs = 12000;
    private const int FaultTimeoutMs = 45000;
    private const string FaultSentinel = "clue-production-fault/1";
    internal const string FaultRoleFile = "production-fault.txt";
    private static readonly Regex RunPattern = new Regex(@"\A[a-f0-9]{32}\z", RegexOptions.CultureInvariant);
    private static readonly Regex InstallPattern = new Regex(@"\A\.clue-proof-production-[a-f0-9]{32}\z", RegexOptions.CultureInvariant);
    private static readonly Regex HashPattern = new Regex(@"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant);

    internal static string RunId { get; private set; }
    internal static int OperatorPid { get; private set; }
    internal static int WrapperPid { get; private set; }
    internal static bool FaultMode { get; private set; }
    internal static bool FaultSupported { get { return MxcPin.ProofProductionAdmission && HashPattern.IsMatch(MxcPin.ProductionFaultProbeSha256); } }
    internal static string InstallRoot { get { return Path.GetDirectoryName(Path.GetDirectoryName(Image())); } }
    internal static string RunRoot { get { return Protocol.CanonicalPath(Path.Combine(InstallRoot, "runs", RunId), true); } }

    internal static string Image()
    {
        string path = Protocol.CanonicalPath(Assembly.GetExecutingAssembly().Location, false);
        string digestDirectory = Path.GetDirectoryName(path);
        string root = Path.GetDirectoryName(digestDirectory);
        string programFiles = Protocol.CanonicalPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), true);
        if (Path.GetFileName(path) != "CLU-E-Windows-Supervisor.exe" ||
            !HashPattern.IsMatch(Path.GetFileName(digestDirectory)) || !InstallPattern.IsMatch(Path.GetFileName(root)) ||
            !String.Equals(Path.GetDirectoryName(root), programFiles, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("PRODUCTION_PROOF_IMAGE_PATH_INVALID");
        return path;
    }

    internal static void SetOperator(string value)
    {
        OperatorPid = ParsePid(value);
    }

    internal static void SetRole(string run, string operatorPid, string wrapperPid)
    {
        SetOperator(operatorPid);
        WrapperPid = ParsePid(wrapperPid);
        SetRun(run);
        if (OperatorPid == WrapperPid) throw new InvalidDataException("PRODUCTION_PROOF_ROLE_INVALID");
        Protocol.CanonicalPath(RunRoot, true);
        FaultMode = ReadFaultRole();
    }

    internal static string Prepare(Request request)
    {
        string image = Image();
        string gate = request.productionGateDirectory;
        FaultMode = request.args.Length > 3 && request.args[3] == FaultSentinel;
        string[] args = FaultMode ? FaultArguments(request, gate) : WorkloadArguments(request, gate);
        int length = Protocol.Quote(request.command).Length;
        foreach (string arg in args) length += 1 + Protocol.Quote(arg).Length;
        if (length >= 32767) throw new InvalidDataException("PRODUCTION_PROOF_COMMAND_LINE_TOO_LONG");
        using (WfpIntegratedGuardian.OpenPinnedImage(image))
        using (var self = Process.GetCurrentProcess())
        {
            SetRun(Guid.NewGuid().ToString("N"));
            WrapperPid = self.Id;
            WfpIntegratedGuardian.RegisterProductionRun(image, self.SessionId, RunId);
            if (ReadFaultRole() != FaultMode) throw new InvalidDataException("PRODUCTION_PROOF_FAULT_ROLE_UNVERIFIED");
        }
        if (!CreateDirectoryW(gate, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Protocol.CanonicalPath(gate, true);
        request.args = args;
        return gate;
    }

    private static string[] WorkloadArguments(Request request, string gate)
    {
        string prelude = ReadPrelude();
        string encodedEnvironment = Convert.ToBase64String(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(request.env)));
        bool npm = request.productionNpmCli != null;
        if (npm) Protocol.CanonicalPath(Path.Combine(request.cwd, "package.json"), false);
        const string launch = @"
runGovernedWfpBindPrelude(process.argv[1]).then(() => {
  const env = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  if (productionNpm) {
    const fs = require('node:fs');
    const path = require('node:path');
    const manifest = path.join(process.cwd(), 'package.json');
    const permitted = ['EACCES', 'EPERM', 'ENOENT'];
    try {
      const info = fs.lstatSync(manifest);
      if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid npm manifest');
      const fd = fs.openSync(manifest, 'r');
      try {
        if (fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) !== 1) throw new Error('Empty npm manifest');
      } finally { fs.closeSync(fd); }
      try {
        if (path.relative(manifest, fs.realpathSync(manifest)) !== '') throw new Error('Aliased npm manifest');
      } catch (error) {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
        env.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main';
        console.error('[CLU-E production npm] PATH_WALK_COMPATIBILITY');
      }
    } catch (error) {
      console.error('[CLU-E production npm] PREFLIGHT_' + (permitted.includes(error.code) ? error.code : 'UNVERIFIED'));
      process.exitCode = 125;
      return;
    }
  }
  const child = require('node:child_process').spawn(process.execPath, process.argv.slice(3), {
    cwd: process.cwd(), env, shell: false, stdio: 'inherit', windowsHide: true
  });
  child.once('error', () => { process.exitCode = 125; });
  child.once('exit', (code) => { process.exitCode = code === null ? 125 : code === 124 || code === 125 ? 1 : code; });
}, () => { process.exitCode = 125; });
";
        var args = new string[request.args.Length + 5];
        args[0] = "-e";
        args[1] = prelude + "\nconst productionNpm = " + (npm ? "true" : "false") + ";\n" + launch;
        args[2] = "--";
        args[3] = gate;
        args[4] = encodedEnvironment;
        Array.Copy(request.args, 0, args, 5, request.args.Length);
        return args;
    }

    private static string[] FaultArguments(Request request, string gate)
    {
        var source = request.args;
        if (!FaultSupported || request.timeoutMs != FaultTimeoutMs || request.productionNpmCli != null ||
            source.Length != 8 || source[0] != "-e" || source[2] != "--" ||
            request.writableRoots.Length != 3 ||
            !Array.Exists(request.readOnlyRoots, root => String.Equals(root, request.cwd, StringComparison.OrdinalIgnoreCase)) ||
            !String.Equals(request.productionWorkspace, Path.Combine(request.fixtureRoot, "temp"), StringComparison.OrdinalIgnoreCase) ||
            !ValidFaultPort(source[4]) || !ValidFaultPeer(source[5]) || !ValidFaultPort(source[6]) || !HashPattern.IsMatch(source[7]))
            throw new InvalidDataException("PRODUCTION_PROOF_FAULT_REQUEST_INVALID");

        string script = source[1];
        if (script.Length < 1 || script.Length > 16384 ||
            Array.Exists(script.ToCharArray(), c => (c < 32 || c > 126) && c != '\n' && c != '\r' && c != '\t'))
            throw new InvalidDataException("PRODUCTION_PROOF_FAULT_SCRIPT_INVALID");
        using (var sha = SHA256.Create())
        {
            string digest = BitConverter.ToString(sha.ComputeHash(Encoding.ASCII.GetBytes(script))).Replace("-", "").ToLowerInvariant();
            if (digest != MxcPin.ProductionFaultProbeSha256)
                throw new InvalidDataException("PRODUCTION_PROOF_FAULT_SCRIPT_PIN_INVALID");
        }
        return new[] { "-e", script + "\nPromise.resolve().then(runProductionFaultProbe).catch(() => { process.exitCode = 125; });",
            "--", gate, source[3], source[4], source[5], source[6], source[7] };
    }

    private static bool ValidFaultPort(string value)
    {
        int port;
        return Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out port) && port > 0 && port <= 65535 &&
            value == port.ToString(CultureInfo.InvariantCulture);
    }

    private static bool ValidFaultPeer(string value)
    {
        IPAddress address;
        if (!IPAddress.TryParse(value, out address) || address.AddressFamily != AddressFamily.InterNetwork || address.ToString() != value)
            return false;
        byte[] peer = address.GetAddressBytes();
        if (peer[0] != 10 && !(peer[0] == 172 && peer[1] >= 16 && peer[1] <= 31) && !(peer[0] == 192 && peer[1] == 168))
            return false;
        bool onSwitch = false;
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            bool defaultSwitch = adapter.OperationalStatus == OperationalStatus.Up &&
                adapter.Name == "vEthernet (Default Switch)" &&
                Regex.IsMatch(adapter.Description, "Hyper-V.*Virtual.*Ethernet", RegexOptions.CultureInvariant);
            foreach (var unicast in adapter.GetIPProperties().UnicastAddresses)
            {
                if (address.Equals(unicast.Address)) return false;
                if (!defaultSwitch || unicast.Address.AddressFamily != AddressFamily.InterNetwork || unicast.IPv4Mask == null) continue;
                byte[] local = unicast.Address.GetAddressBytes();
                byte[] mask = unicast.IPv4Mask.GetAddressBytes();
                uint hostMask = ~(((uint)mask[0] << 24) | ((uint)mask[1] << 16) | ((uint)mask[2] << 8) | mask[3]);
                if (hostMask < 3 || hostMask > 65535 || (hostMask & (hostMask + 1)) != 0) continue;
                bool sameSubnet = true;
                bool hasHostBits = false;
                bool hasNetworkBits = false;
                for (int i = 0; i < peer.Length; i++)
                {
                    sameSubnet &= (peer[i] & mask[i]) == (local[i] & mask[i]);
                    hasHostBits |= (peer[i] & ~mask[i]) != 0;
                    hasNetworkBits |= ((peer[i] ^ 0xff) & ~mask[i]) != 0;
                }
                onSwitch |= sameSubnet && hasHostBits && hasNetworkBits;
            }
        }
        return onSwitch;
    }

    private static bool ReadFaultRole()
    {
        string marker = Path.Combine(RunRoot, FaultRoleFile);
        if (!File.Exists(marker)) return false;
        using (var stream = new FileStream(Protocol.CanonicalPath(marker, false), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (!FaultSupported || stream.Length != 5 || stream.ReadByte() != 'F' || stream.ReadByte() != 'A' ||
                stream.ReadByte() != 'U' || stream.ReadByte() != 'L' || stream.ReadByte() != 'T')
                throw new InvalidDataException("PRODUCTION_PROOF_FAULT_ROLE_UNVERIFIED");
        }
        return true;
    }

    private static string ReadPrelude()
    {
        string path = Protocol.CanonicalPath(Path.Combine(InstallRoot, "production-bind-prelude.cjs"), false);
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var reader = new BinaryReader(stream))
        using (var sha = SHA256.Create())
        {
            if (stream.Length < 1 || stream.Length > 8192) throw new InvalidDataException("PRODUCTION_PROOF_PRELUDE_SIZE_INVALID");
            byte[] bytes = reader.ReadBytes((int)stream.Length);
            if (bytes.Length != stream.Length ||
                BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant() != MxcPin.GovernedWfpPreludeSha256)
                throw new InvalidDataException("PRODUCTION_PROOF_PRELUDE_PIN_INVALID");
            return Encoding.ASCII.GetString(bytes);
        }
    }

    internal static FileStream PinTool(string path, string digest, int maximum)
    {
        var file = new FileStream(Protocol.CanonicalPath(path, false), FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            using (var sha = SHA256.Create())
                if (file.Length < 1 || file.Length > maximum ||
                    BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant() != digest)
                    throw new InvalidDataException("PRODUCTION_PROOF_TOOL_PIN_MISMATCH");
            return file;
        }
        catch
        {
            file.Dispose();
            throw;
        }
    }

    internal static string RegistrationPipe(int session)
    {
        return "CLU-E-Production-Proof-" + Path.GetFileName(InstallRoot) + "-" + session.ToString(CultureInfo.InvariantCulture);
    }

    internal static bool ValidRun(string value) { return value != null && RunPattern.IsMatch(value); }

    private static void SetRun(string value)
    {
        if (!ValidRun(value)) throw new InvalidDataException("PRODUCTION_PROOF_RUN_INVALID");
        RunId = value;
    }

    private static int ParsePid(string value)
    {
        int pid;
        if (!Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid < 1)
            throw new InvalidDataException("PRODUCTION_PROOF_PID_INVALID");
        return pid;
    }

    internal static void CreateRunDirectory(string run)
    {
        if (!ValidRun(run)) throw new InvalidDataException("PRODUCTION_PROOF_RUN_INVALID");
        string parent = Protocol.CanonicalPath(Path.Combine(InstallRoot, "runs"), true);
        string path = Path.Combine(parent, run);
        if (!CreateDirectoryW(path, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Protocol.CanonicalPath(path, true);
    }

    internal static int RendezvousTimeout { get { return StartTimeoutMs; } }

    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(string path, IntPtr attributes);
}

internal static partial class WfpIntegratedGuardian
{
    internal static int RunProductionRegistration()
    {
        string image = ProductionProofSession.Image();
        using (var imagePin = OpenPinnedImage(image))
        using (var identity = WindowsIdentity.GetCurrent())
        using (var self = Process.GetCurrentProcess())
        using (var owner = OpenOperatorProcess(identity, self.SessionId))
        using (var pipe = OpenLocalPipe(ProductionProofSession.RegistrationPipe(self.SessionId), identity.User))
        {
            PublishProductionSessionReady();
            while (WaitForSingleObject(owner, 0) == WaitTimeout)
            {
                var pending = pipe.BeginWaitForConnection(null, null);
                while (!pending.AsyncWaitHandle.WaitOne(SampleIntervalMs))
                    if (WaitForSingleObject(owner, 0) != WaitTimeout) return 0;
                pipe.EndWaitForConnection(pending);
                Process worker = null;
                try
                {
                    using (var client = OpenClient(pipe, image, identity.User, self.SessionId, registration: true))
                    using (var bfe = new WfpBfeWatch())
                    {
                        string run = ReadLine(pipe, client, bfe, Stopwatch.StartNew(), 2000);
                        bool fault = run.StartsWith("FAULT ", StringComparison.Ordinal);
                        if (fault) run = run.Substring(6);
                        uint pid = GetProcessId(client);
                        if (!ProductionProofSession.ValidRun(run) || pid == 0 || pid > Int32.MaxValue ||
                            pid == ProductionProofSession.OperatorPid || (fault && !ProductionProofSession.FaultSupported))
                            throw new InvalidDataException("PRODUCTION_PROOF_REGISTRATION_INVALID");
                        ProductionProofSession.CreateRunDirectory(run);
                        if (fault) PublishProductionMarker(Path.Combine(ProductionProofSession.InstallRoot, "runs", run,
                            ProductionProofSession.FaultRoleFile), "FAULT");
                        var start = new ProcessStartInfo {
                            FileName = image,
                            Arguments = "--production-guardian " + run + " " +
                                ProductionProofSession.OperatorPid.ToString(CultureInfo.InvariantCulture) + " " + pid.ToString(CultureInfo.InvariantCulture),
                            WorkingDirectory = Path.GetDirectoryName(image),
                            UseShellExecute = false,
                            CreateNoWindow = true,
                        };
                        start.EnvironmentVariables.Clear();
                        string systemRoot = Path.GetDirectoryName(Environment.SystemDirectory);
                        start.EnvironmentVariables["SystemRoot"] = systemRoot;
                        start.EnvironmentVariables["WINDIR"] = systemRoot;
                        start.EnvironmentVariables["PATH"] = Environment.SystemDirectory;
                        worker = Process.Start(start);
                        if (worker == null) throw new InvalidDataException("PRODUCTION_PROOF_GUARDIAN_START_FAILED");
                        string marker = Path.Combine(ProductionProofSession.InstallRoot, "runs", run, "guardian-listening.txt");
                        var deadline = Stopwatch.StartNew();
                        while (!File.Exists(marker) && deadline.ElapsedMilliseconds < 8000)
                        {
                            RequireLive(owner);
                            RequireLive(client);
                            if (worker.HasExited) throw new InvalidDataException("PRODUCTION_PROOF_GUARDIAN_EXITED");
                            System.Threading.Thread.Sleep(30);
                        }
                        if (!File.Exists(marker) || worker.HasExited ||
                            new FileInfo(Protocol.CanonicalPath(marker, false)).Length != 5 || File.ReadAllText(marker) != "READY")
                            throw new InvalidDataException("PRODUCTION_PROOF_GUARDIAN_READY_UNVERIFIED");
                        WriteLine(pipe, "READY", client, bfe);
                        // A completed pipe write does not establish that the client read it.
                        if (ReadLine(pipe, client, bfe, Stopwatch.StartNew(), 4000) != "ACK")
                            throw new InvalidDataException("PRODUCTION_PROOF_SESSION_ACK_INVALID");
                        PublishProductionMarker(RegistrationMarker(run), "ACK");
                    }
                }
                catch (Exception) { Console.Error.WriteLine("[CLU-E production proof] registration refused"); }
                finally { pipe.Disconnect(); }
                // The run owns its WFP leases. The registration process never terminates it.
                if (worker != null) using (worker) worker.WaitForExit();
            }
        }
        return 0;
    }

    private static void PublishProductionSessionReady()
    {
        string marker = Path.Combine(ProductionProofSession.InstallRoot, "production-session-ready.txt");
        if (File.Exists(marker))
        {
            string existing = Protocol.CanonicalPath(marker, false);
            if (new FileInfo(existing).Length != 5 || File.ReadAllText(existing) != "READY")
                throw new InvalidDataException("PRODUCTION_PROOF_SESSION_MARKER_INVALID");
            return;
        }
        PublishProductionMarker(marker, "READY");
    }

    private static string RegistrationMarker(string run)
    {
        if (!ProductionProofSession.ValidRun(run)) throw new InvalidDataException("PRODUCTION_PROOF_RUN_INVALID");
        string folder = Protocol.CanonicalPath(Path.Combine(ProductionProofSession.InstallRoot, "runs", run), true);
        return Path.Combine(folder, "registration-confirmed.txt");
    }

    private static void PublishProductionMarker(string marker, string value)
    {
        string temporary = marker + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                byte[] bytes = Encoding.ASCII.GetBytes(value);
                output.Write(bytes, 0, bytes.Length);
                output.Flush(true);
            }
            File.Move(temporary, marker);
        }
        finally { File.Delete(temporary); }
    }

    internal static void RegisterProductionRun(string image, int session, string run)
    {
        using (var identity = WindowsIdentity.GetCurrent())
        using (var pipe = new NamedPipeClientStream(".", ProductionProofSession.RegistrationPipe(session),
            PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification))
        {
            int timeout = ProductionProofSession.RendezvousTimeout;
            try { pipe.Connect(timeout); }
            catch (TimeoutException) { throw new InvalidDataException("PRODUCTION_PROOF_SESSION_CONNECT_TIMEOUT"); }
            uint pid;
            if (!ProductionPipeServerPid(pipe.SafePipeHandle, out pid) || pid == 0 || pid > Int32.MaxValue)
                throw new InvalidDataException("PRODUCTION_PROOF_SESSION_PEER_INVALID");
            using (var peer = OpenBackupPeer((int)pid, image, identity.User, session, true))
            {
                WriteRegistrationLine(pipe, (ProductionProofSession.FaultMode ? "FAULT " : "") + run, timeout,
                    "PRODUCTION_PROOF_SESSION_REQUEST_TIMEOUT");
                var reply = new byte[1];
                var clock = Stopwatch.StartNew();
                foreach (char expected in "READY\n")
                {
                    var read = pipe.BeginRead(reply, 0, reply.Length, null, null);
                    int remaining = timeout - (int)Math.Min(timeout, clock.ElapsedMilliseconds);
                    if (remaining <= 0 || !read.AsyncWaitHandle.WaitOne(remaining) || pipe.EndRead(read) != 1 ||
                        reply[0] != expected) throw new InvalidDataException("PRODUCTION_PROOF_SESSION_READY_UNVERIFIED");
                }
                RequireLive(peer);
                WriteRegistrationLine(pipe, "ACK", 4000, "PRODUCTION_PROOF_SESSION_ACK_TIMEOUT");
                string marker = RegistrationMarker(run);
                clock.Restart();
                while (!File.Exists(marker) && clock.ElapsedMilliseconds < 4000)
                {
                    RequireLive(peer);
                    System.Threading.Thread.Sleep(20);
                }
                if (!File.Exists(marker))
                    throw new InvalidDataException("PRODUCTION_PROOF_SESSION_ACK_UNVERIFIED");
                string physical = Protocol.CanonicalPath(marker, false);
                if (new FileInfo(physical).Length != 3 || File.ReadAllText(physical) != "ACK")
                    throw new InvalidDataException("PRODUCTION_PROOF_SESSION_ACK_INVALID");
                RequireLive(peer);
            }
        }
    }

    private static void WriteRegistrationLine(NamedPipeClientStream pipe, string line, int timeout, string failure)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
        var write = pipe.BeginWrite(bytes, 0, bytes.Length, null, null);
        if (!write.AsyncWaitHandle.WaitOne(timeout)) throw new InvalidDataException(failure);
        pipe.EndWrite(write);
    }

    [DllImport("kernel32.dll", EntryPoint = "GetNamedPipeServerProcessId", ExactSpelling = true, SetLastError = true)]
    private static extern bool ProductionPipeServerPid(SafePipeHandle pipe, out uint pid);
}
