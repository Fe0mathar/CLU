using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static class Supervisor
{
    private static int Main(string[] args)
    {
        var clock = Stopwatch.StartNew();
        string phase = "REQUEST_READ";
        try
        {
            if (MxcPin.GovernedWfpIntegration && args.Length == 1 && args[0] == "--governed-wfp-guardian")
                return WfpIntegratedGuardian.Run();
            if (MxcPin.GovernedWfpIntegration && MxcPin.GovernedWfpOwnerLoss && args.Length == 1 &&
                args[0] == "--governed-wfp-owner-loss-readback")
                return WfpIntegratedGuardian.ReadBackOwnerLoss();
            if (args.Length != 2 || args[0] != "--request-file")
                return Refuse("REQUEST_ARGUMENTS_INVALID");

            Request request = Protocol.Read(args[1]);
            phase = "ENGINE_PIN";
            string install = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string engine = Protocol.CanonicalPath(Path.Combine(install, "wxc-exec.exe"), false);
            Protocol.EnsurePrivatePath(request, engine);
            string directory = Path.GetDirectoryName(request.requestPath);
            string prefix = Path.Combine(directory, "mxc-" + Guid.NewGuid().ToString("N"));
            string config = prefix + ".json";
            string log = prefix + ".log";

            // Keep the pinned image open through process creation and execution.
            using (var image = new FileStream(engine, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (image.Length < 1 || image.Length > 128L * 1024 * 1024 ||
                    !String.Equals(Hash(image), MxcPin.Sha256, StringComparison.Ordinal))
                    return Refuse("MXC_IMAGE_PIN_MISMATCH");

                try
                {
                    phase = "CONFIG_WRITE";
                    using (var file = new FileStream(config, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    using (var writer = new StreamWriter(file, new UTF8Encoding(false)))
                        writer.Write(Protocol.BuildConfig(request));

                    int remaining = request.timeoutMs - (int)Math.Min(clock.ElapsedMilliseconds, Int32.MaxValue);
                    if (remaining < 1) return 124;
                    bool deadlineExpired;
                    phase = "ENGINE_RUN";
                    int exit;
                    if (request.integratedWfp)
                    {
                        var integrated = new WfpIntegratedRun(request);
                        bool lifecycleComplete = false;
                        try
                        {
                            exit = NativeJob.Run(engine, log, config, request.systemRoot, remaining,
                                out deadlineExpired, integrated.Observe, () => lifecycleComplete = integrated.Finish(true));
                        }
                        finally { integrated.Dispose(); }
                        if (!lifecycleComplete) return Refuse("GOVERNED_WFP_INTEGRATION_INCOMPLETE");
                    }
                    else if (request.wfpMode == null)
                        exit = NativeJob.Run(engine, log, config, request.systemRoot, remaining, out deadlineExpired);
                    else
                    {
                        var wfp = new WfpBootstrapRun(request);
                        bool jobEmpty = false;
                        bool lifecycleComplete;
                        try
                        {
                            exit = NativeJob.Run(engine, log, config, request.systemRoot, remaining,
                                out deadlineExpired, wfp.Observe, () => jobEmpty = true);
                        }
                        finally { lifecycleComplete = wfp.Finish(jobEmpty); }
                        if (!lifecycleComplete) return Refuse("WFP_BOOTSTRAP_LIFECYCLE_INCOMPLETE");
                    }
                    if (deadlineExpired) return 124;
                    if (exit == 0) return 0;
                    // A protected backend record distinguishes a workload failure from an MXC
                    // startup refusal. Workload stdout/stderr cannot authorize the exit code.
                    phase = "ENGINE_LOG";
                    string outcome = InspectWorkloadExit(log, exit);
                    if (outcome != "EXIT_CONFIRMED")
                        return Refuse("MXC_EXECUTION_REFUSED ENGINE_EXIT_" + exit + " " + outcome);
                    Console.Error.WriteLine("[CLU-E supervisor] WORKLOAD_EXIT_0x" +
                        unchecked((uint)exit).ToString("X8"));
                    return exit == 124 || exit == 125 ? 1 : exit;
                }
                finally
                {
                    File.Delete(config);
                    File.Delete(log);
                }
            }
        }
        catch (Win32Exception error)
        {
            Console.Error.WriteLine("[CLU-E supervisor] WIN32_ERROR_" + error.NativeErrorCode + " " + phase);
            return 125;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[CLU-E supervisor] REFUSED (" + error.GetType().Name + "). " + phase + " " + LocalSite(error));
            return 125;
        }
    }

    private static string Hash(Stream stream)
    {
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static string LocalSite(Exception error)
    {
        var frames = new StackTrace(error, false).GetFrames();
        if (frames != null)
        {
            foreach (StackFrame frame in frames)
            {
                MethodBase method = frame.GetMethod();
                if (method == null) continue;
                Type owner = method.DeclaringType;
                if ((owner == typeof(Protocol) || owner == typeof(Supervisor) || owner == typeof(NativeJob)) &&
                    Regex.IsMatch(method.Name, @"^[A-Za-z][A-Za-z0-9]{0,63}$"))
                    return owner.Name + "." + method.Name;
            }
        }
        return "SITE_UNAVAILABLE";
    }

    private static string InspectWorkloadExit(string path, int exit)
    {
        if (!File.Exists(path)) return "LOG_UNAVAILABLE";
        if (new FileInfo(path).Length > 1024 * 1024) return "LOG_LIMIT";
        bool confirmed = false;
        var serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
        foreach (string line in File.ReadLines(path))
        {
            // The auxiliary log also contains prose. Only the documented audit prefix starts a record.
            Match record = Regex.Match(line, @"^(?:\[[0-9]{1,20}\] )?(\{""event"":""mxc\..*)$");
            if (!record.Success) continue;
            System.Collections.Generic.Dictionary<string, object> row;
            try
            {
                row = serializer.DeserializeObject(record.Groups[1].Value) as System.Collections.Generic.Dictionary<string, object>;
            }
            catch (ArgumentException) { return "LOG_RECORD_INVALID"; }
            catch (InvalidOperationException) { return "LOG_RECORD_INVALID"; }
            if (row == null || !row.ContainsKey("event")) return "LOG_RECORD_INVALID";
            string name = row["event"] as string;
            if (name == "mxc.EnforcementDegraded") return "ENFORCEMENT_DEGRADED";
            if (name == "mxc.ConfigRejected") return "CONFIG_REJECTED";
            if (name != "mxc.ProcessExited") continue;
            if (!row.ContainsKey("backend") || (row["backend"] as string) != "processcontainer" ||
                !row.ContainsKey("tier") || (row["tier"] as string) != "base-container" ||
                !row.ContainsKey("exit_code") || !(row["exit_code"] is int) || (int)row["exit_code"] != exit)
                return "EXIT_RECORD_MISMATCH";
            confirmed = true;
        }
        return confirmed ? "EXIT_CONFIRMED" : "NO_EXIT_RECORD";
    }

    private static int Refuse(string code)
    {
        Console.Error.WriteLine("[CLU-E supervisor] " + code);
        return 125;
    }
}
