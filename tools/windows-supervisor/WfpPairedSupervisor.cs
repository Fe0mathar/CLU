using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// This separate entry point only runs the two fixed diagnostic modes in its compiled-in staging tree.
internal sealed class WfpPairedSupervisor
{
    private const int AccessDenied = 10013;
    private const int DeadlineMs = 25000;
    private static readonly string[] CrashRoles = { "crash", "crash-child", "crash-grandchild" };
    private readonly string mode, root, workspace, privateRoot, fixture;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly Dictionary<string, int[]> phases = new Dictionary<string, int[]> {
        { "before", null }, { "during", null }, { "after", null },
    };
    private WfpContainerIdentity.OwnedHandle[] processes;
    private byte[] packageSid;
    private WfpLoopbackLease lease;
    private WfpDropObservation dropObservation;
    private object dropEvidence;
    private string filteredStartedAt, filteredFinishedAt, error;
    private int? engineExitCode;
    private bool identityVerified, removalVerified, jobEmpty, crashReady, pairedComplete;
    private int step;

    private WfpPairedSupervisor(string mode)
    {
        this.mode = mode;
        string stage = Protocol.CanonicalPath(MxcPin.WfpDiagnosticStage, true);
        root = Protocol.CanonicalPath(Path.Combine(stage, mode), true);
        workspace = Protocol.CanonicalPath(Path.Combine(root, "workspace"), true);
        privateRoot = Protocol.CanonicalPath(Path.Combine(root, "private"), true);
        fixture = Protocol.CanonicalPath(Path.Combine(stage, "fixture", "WfpPairedFixture.exe"), false);
    }

    private static int Main(string[] args)
    {
        if (args.Length != 1 || (args[0] != "paired" && args[0] != "crash")) return 125;
        try { return new WfpPairedSupervisor(args[0]).Run(); }
        catch (Exception)
        {
            Console.Error.WriteLine("[CLU-E 05N3] CONTROLLER_STARTUP_REFUSED");
            return 125;
        }
    }

    private int Run()
    {
        string state = "CONTROLLER_REFUSED";
        int result = 125;
        try
        {
            string engine = Protocol.CanonicalPath(Path.Combine(MxcPin.WfpDiagnosticStage, "bin", "wxc-exec.exe"), false);
            var request = CreateRequest();
            Protocol.EnsurePrivatePath(request, engine);
            using (var enginePin = OpenPinned(engine, MxcPin.Sha256))
            using (var fixturePin = OpenPinned(fixture, MxcPin.WfpDiagnosticFixtureSha256))
            {
                string config = Path.Combine(privateRoot, "policy.json");
                string log = Path.Combine(privateRoot, "mxc.log");
                WriteNew(config, Protocol.BuildConfig(request));
                bool expired;
                int exit = NativeJob.Run(engine, log, config, request.systemRoot, DeadlineMs, out expired,
                    mode == "paired" ? (Action<IntPtr>)ObservePaired : ObserveCrash, () => jobEmpty = true);
                engineExitCode = exit;
                if (mode == "paired")
                {
                    bool passed = !expired && exit == 0 && pairedComplete &&
                        All(phases["before"], 0) && All(phases["during"], AccessDenied) && All(phases["after"], 0) &&
                        identityVerified && removalVerified && jobEmpty;
                    state = passed ? "PAIRED_BIND_CAUSALITY_OBSERVED" : "PAIRED_BIND_CAUSALITY_UNPROVEN";
                    result = passed ? 0 : expired ? 124 : 1;
                }
                else
                {
                    state = expired && !crashReady ? "CRASH_READY_TIMEOUT" : "CRASH_FIXTURE_EXITED_WITHOUT_INJECTION";
                    result = expired ? 124 : 1;
                }
            }
        }
        catch (Exception failure)
        {
            error = Regex.IsMatch(failure.Message, @"^[A-Z][A-Z0-9_]{0,75}(?:_0x[0-9A-F]{8})?$")
                ? failure.Message.ToUpperInvariant() : "CONTROLLER_NATIVE_REFUSAL";
        }
        finally
        {
            if (dropObservation != null) dropObservation.Dispose();
            if (lease != null && jobEmpty)
            {
                try { removalVerified = lease.ReleaseAndVerify(); }
                catch (Exception) { removalVerified = false; }
            }
            if (processes != null)
                foreach (var process in processes)
                    if (process != null) process.Dispose();
            WriteNew(Path.Combine(privateRoot, "result.json"), json.Serialize(new {
                state, error, engineExitCode, phases, filteredStartedAt, filteredFinishedAt, dropEvidence,
                identityVerified, independentRemovalVerified = removalVerified, jobEmpty,
            }));
        }
        return result;
    }

    private Request CreateRequest()
    {
        string system = Protocol.CanonicalPath(Path.GetDirectoryName(Environment.SystemDirectory), true);
        string system32 = Path.Combine(system, "System32");
        string runtimeDirectory = Path.GetDirectoryName(fixture);
        return new Request {
            requestPath = Path.Combine(privateRoot, "request.json"),
            command = fixture,
            args = new[] { mode, workspace },
            cwd = workspace,
            readOnlyRoots = new[] { runtimeDirectory, system },
            writableRoots = new[] { workspace },
            env = new Dictionary<string, string> {
                { "PATH", system32 }, { "SystemRoot", system }, { "WINDIR", system },
                { "TEMP", workspace }, { "TMP", workspace }, { "USERPROFILE", workspace },
                { "APPDATA", workspace }, { "LOCALAPPDATA", workspace },
            },
            timeoutMs = DeadlineMs,
            systemRoot = system,
            fixtureRoot = root,
            wfpContainerId = "sandbox-" + Guid.NewGuid().ToString("N").Substring(0, 16),
        };
    }

    private void ObservePaired(IntPtr job)
    {
        if (step == 0)
        {
            int pid = ReadPid("paired");
            if (pid == 0) return;
            PinProcesses(job, new[] { pid });
            ReleaseGate("paired-before");
        }
        else if (step == 1)
        {
            phases["before"] = ReadCodes("paired-before");
            if (phases["before"] == null) return;
            VerifyIdentity(job);
            if (!All(phases["before"], 0)) throw new InvalidDataException("PAIRED_BASELINE_BIND_FAILED");
            Install();
            dropObservation = WfpDropObservation.Start(lease.FilterIds);
            filteredStartedAt = Now();
            ReleaseGate("paired-during");
        }
        else if (step == 2)
        {
            phases["during"] = ReadCodes("paired-during");
            if (phases["during"] == null) return;
            filteredFinishedAt = Now();
            VerifyIdentity(job);
            CaptureDrops();
            removalVerified = lease.ReleaseAndVerify();
            if (!removalVerified) throw new InvalidDataException("PAIRED_FILTER_REMOVAL_UNVERIFIED");
            ReleaseGate("paired-after");
        }
        else if (step == 3)
        {
            phases["after"] = ReadCodes("paired-after");
            if (phases["after"] == null) return;
            VerifyIdentity(job);
            identityVerified = true;
            ReleaseGate("paired-complete");
            pairedComplete = true;
        }
        else return;
        step++;
    }

    private void ObserveCrash(IntPtr job)
    {
        if (crashReady) return;
        var pids = Array.ConvertAll(CrashRoles, ReadPid);
        if (Array.IndexOf(pids, 0) >= 0) return;
        if (step == 0)
        {
            PinProcesses(job, pids);
            Install();
            ReleaseGate("crash");
            step++;
        }
        foreach (string role in CrashRoles)
        {
            int[] codes = ReadCodes(role);
            if (codes == null) return;
            if (!All(codes, AccessDenied)) throw new InvalidDataException("CRASH_DESCENDANT_BIND_NOT_DENIED");
        }
        VerifyIdentity(job);
        identityVerified = true;
        using (var supervisor = Process.GetCurrentProcess())
        {
            WriteNew(Path.Combine(privateRoot, "ready.json"), json.Serialize(new {
                supervisorPid = supervisor.Id, fixturePids = pids,
                filterIds = FilterIdStrings(), sublayerKey = lease.SublayerKey.ToString("D"),
            }));
        }
        crashReady = true;
    }

    private void Install()
    {
        bool cleanupVerified;
        lease = WfpLoopbackLease.Install(packageSid, out cleanupVerified);
        if (lease.Count != 6) throw new InvalidDataException("WFP_FILTER_COUNT_INVALID");
    }

    private void CaptureDrops()
    {
        int[] bind;
        string status = dropObservation.Finish(out bind);
        dropEvidence = new {
            filterIds = FilterIdStrings(),
            verifiedSublayerWeight = lease.VerifiedSublayerWeight,
            state = status,
            hitsByFilter = dropObservation.LayerHits,
            bindHits = new { ipv4Tcp = bind[0], ipv6Tcp = bind[1], ipv4Udp = bind[2], ipv6Udp = bind[3] },
        };
        dropObservation = null;
    }

    private string[] FilterIdStrings()
    {
        return Array.ConvertAll(lease.FilterIds, id => id.ToString(CultureInfo.InvariantCulture));
    }

    private void PinProcesses(IntPtr job, int[] pids)
    {
        if (new HashSet<int>(pids).Count != pids.Length) throw new InvalidDataException("FIXTURE_PID_REUSED");
        processes = new WfpContainerIdentity.OwnedHandle[pids.Length];
        for (int index = 0; index < pids.Length; index++)
            processes[index] = WfpContainerIdentity.OpenForJob(job, pids[index]);
        packageSid = WfpContainerIdentity.ReadForJob(job, processes[0], fixture);
        VerifyIdentity(job);
    }

    private void VerifyIdentity(IntPtr job)
    {
        foreach (var process in processes)
            if (!WfpContainerIdentity.Same(packageSid, WfpContainerIdentity.ReadForJob(job, process, fixture)))
                throw new InvalidDataException("FIXTURE_PACKAGE_SID_CHANGED");
    }

    private int ReadPid(string role)
    {
        string value = ReadMarker(role + "-pid.txt");
        if (value == null) return 0;
        int pid;
        if (!Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid < 1)
            throw new InvalidDataException("FIXTURE_PID_INVALID");
        return pid;
    }

    private int[] ReadCodes(string role)
    {
        string value = ReadMarker(role + "-result.txt");
        if (value == null) return null;
        if (!Regex.IsMatch(value, @"\A[0-9]{1,5}(?: [0-9]{1,5}){3}\z"))
            throw new InvalidDataException("FIXTURE_CODES_INVALID");
        return Array.ConvertAll(value.Split(' '), code => Int32.Parse(code, CultureInfo.InvariantCulture));
    }

    private string ReadMarker(string file)
    {
        string path = Path.Combine(workspace, file);
        if (!File.Exists(path)) return null;
        using (var stream = new FileStream(Protocol.CanonicalPath(path, false), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (stream.Length < 1 || stream.Length > 32) throw new InvalidDataException("FIXTURE_MARKER_SIZE");
            using (var reader = new StreamReader(stream, Encoding.ASCII, false))
                return reader.ReadToEnd();
        }
    }

    private void ReleaseGate(string role)
    {
        WriteNew(Path.Combine(workspace, role + "-go.txt"), "GO");
    }

    private static bool All(int[] codes, int expected)
    {
        return codes != null && Array.TrueForAll(codes, code => code == expected);
    }

    private static string Now() { return DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture); }

    private static FileStream OpenPinned(string path, string expected)
    {
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            if (stream.Length < 1 || stream.Length > 128L * 1024 * 1024)
                throw new InvalidDataException("DIAGNOSTIC_IMAGE_SIZE");
            using (var sha = SHA256.Create())
            {
                string hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (hash != expected) throw new InvalidDataException("DIAGNOSTIC_IMAGE_PIN_MISMATCH");
            }
            return stream;
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static void WriteNew(string path, string content)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(file, new UTF8Encoding(false)))
                writer.Write(content);
            File.Move(temporary, path);
        }
        finally { File.Delete(temporary); }
    }
}
