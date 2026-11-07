using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

internal static class Supervisor
{
    private static int Main(string[] args)
    {
        var clock = Stopwatch.StartNew();
        try
        {
            if (args.Length != 2 || args[0] != "--request-file")
                return Refuse("REQUEST_ARGUMENTS_INVALID");

            Request request = Protocol.Read(args[1]);
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
                    using (var file = new FileStream(config, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    using (var writer = new StreamWriter(file, new UTF8Encoding(false)))
                        writer.Write(Protocol.BuildConfig(request));

                    int remaining = request.timeoutMs - (int)Math.Min(clock.ElapsedMilliseconds, Int32.MaxValue);
                    if (remaining < 1) return 124;
                    bool deadlineExpired;
                    int exit = NativeJob.Run(engine, log, config, request.systemRoot, remaining, out deadlineExpired);
                    if (deadlineExpired) return 124;
                    if (exit == 0) return 0;
                    // A protected backend record distinguishes a workload failure from an MXC
                    // startup refusal. Workload stdout/stderr cannot authorize the exit code.
                    if (!WorkloadExitConfirmed(log, exit)) return Refuse("MXC_EXECUTION_REFUSED");
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
            Console.Error.WriteLine("[CLU-E supervisor] WIN32_ERROR_" + error.NativeErrorCode);
            return 125;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[CLU-E supervisor] REFUSED (" + error.GetType().Name + ").");
            return 125;
        }
    }

    private static string Hash(Stream stream)
    {
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static bool WorkloadExitConfirmed(string path, int exit)
    {
        if (!File.Exists(path) || new FileInfo(path).Length > 1024 * 1024) return false;
        bool confirmed = false;
        var serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
        foreach (string line in File.ReadLines(path))
        {
            int offset = line.IndexOf('{');
            if (offset < 0) continue;
            var row = serializer.DeserializeObject(line.Substring(offset)) as System.Collections.Generic.Dictionary<string, object>;
            if (row == null || !row.ContainsKey("event")) continue;
            string name = row["event"] as string;
            if (name == "mxc.EnforcementDegraded" || name == "mxc.ConfigRejected") return false;
            if (name != "mxc.ProcessExited") continue;
            if (!row.ContainsKey("backend") || (row["backend"] as string) != "processcontainer" ||
                !row.ContainsKey("tier") || (row["tier"] as string) != "base-container" ||
                !row.ContainsKey("exit_code") || !(row["exit_code"] is int) || (int)row["exit_code"] != exit)
                return false;
            confirmed = true;
        }
        return confirmed;
    }

    private static int Refuse(string code)
    {
        Console.Error.WriteLine("[CLU-E supervisor] " + code);
        return 125;
    }
}
