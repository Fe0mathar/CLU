using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;

// Compiled separately and admitted only as a hash-pinned disposable MXC workload.
internal static class WfpPairedFixture
{
    private const int RoundWaitMs = 6000;
    private const int CrashLifetimeMs = 30000;

    private static int Main(string[] args)
    {
        if (args.Length != 2 || !Path.IsPathRooted(args[1])) return 2;
        try
        {
            string workspace = Path.GetFullPath(args[1]);
            if (!String.Equals(Path.GetFileName(workspace), "workspace", StringComparison.OrdinalIgnoreCase) ||
                !Directory.Exists(workspace)) return 2;

            if (args[0] == "host-net" || args[0] == "host-net-host")
                return WfpHostLoopbackFixture.Run(args[0], workspace);

            if (args[0] == "paired")
            {
                RunPaired(workspace);
                return 0;
            }
            if (args[0] == "crash" || args[0] == "crash-child" || args[0] == "crash-grandchild")
                RunCrash(workspace, args[0]);
        }
        catch (TimeoutException) { Console.Error.WriteLine("[CLU-E WFP FIXTURE] GATE_TIMEOUT"); }
        catch (InvalidDataException) { Console.Error.WriteLine("[CLU-E WFP FIXTURE] MARKER_INVALID"); }
        catch (Exception) { Console.Error.WriteLine("[CLU-E WFP FIXTURE] WORKLOAD_FAILED"); }
        return 2;
    }

    private static void RunPaired(string workspace)
    {
        PublishPid(workspace, "paired");
        foreach (string round in new[] { "before", "during", "after" })
        {
            string phase = "paired-" + round;
            WaitForGate(workspace, phase, Stopwatch.StartNew(), RoundWaitMs);
            Publish(workspace, phase + "-result.txt", Format(BindMatrix(null)));
        }
        WaitForGate(workspace, "paired-complete", Stopwatch.StartNew(), RoundWaitMs);
    }

    private static void RunCrash(string workspace, string role)
    {
        var clock = Stopwatch.StartNew();
        PublishPid(workspace, role);
        if (role != "crash-grandchild")
        {
            string childRole = role == "crash" ? "crash-child" : "crash-grandchild";
            var start = new ProcessStartInfo {
                FileName = Assembly.GetExecutingAssembly().Location,
                Arguments = childRole + " \"" + workspace + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (Process child = Process.Start(start))
                if (child == null) throw new InvalidOperationException("Cannot start descendant.");
        }

        WaitForGate(workspace, "crash", clock, CrashLifetimeMs);
        bool reportedEscape = false;
        Action recordEscape = () =>
        {
            if (reportedEscape) return;
            Publish(workspace, role + "-escape.txt", "BOUND");
            reportedEscape = true;
        };
        Publish(workspace, role + "-result.txt", Format(BindMatrix(recordEscape)));
        while (clock.ElapsedMilliseconds < CrashLifetimeMs)
        {
            Thread.Sleep(30);
            BindMatrix(recordEscape);
        }
        Console.Error.WriteLine("[CLU-E WFP FIXTURE] CRASH_WATCHDOG_EXPIRED");
    }

    private static int[] BindMatrix(Action bound)
    {
        return new[] {
            Bind(IPAddress.Loopback, SocketType.Stream, ProtocolType.Tcp, bound),
            Bind(IPAddress.IPv6Loopback, SocketType.Stream, ProtocolType.Tcp, bound),
            Bind(IPAddress.Loopback, SocketType.Dgram, ProtocolType.Udp, bound),
            Bind(IPAddress.IPv6Loopback, SocketType.Dgram, ProtocolType.Udp, bound),
        };
    }

    private static int Bind(IPAddress address, SocketType type, ProtocolType protocol, Action bound)
    {
        using (var socket = new Socket(address.AddressFamily, type, protocol))
        {
            // Bind alone exercises resource assignment. Never listen, connect, or send.
            try { socket.Bind(new IPEndPoint(address, 0)); }
            catch (SocketException error)
            {
                if (error.NativeErrorCode < 1 || error.NativeErrorCode > 65535) throw;
                return error.NativeErrorCode;
            }
        }
        if (bound != null) bound();
        return 0;
    }

    private static string Format(int[] result)
    {
        return String.Join(" ", Array.ConvertAll(result, code => code.ToString(CultureInfo.InvariantCulture)));
    }

    private static void PublishPid(string workspace, string role)
    {
        using (Process self = Process.GetCurrentProcess())
            Publish(workspace, role + "-pid.txt", self.Id.ToString(CultureInfo.InvariantCulture));
    }

    private static void WaitForGate(string workspace, string phase, Stopwatch clock, int timeoutMs)
    {
        string path = Path.Combine(workspace, phase + "-go.txt");
        while (clock.ElapsedMilliseconds < timeoutMs)
        {
            if (File.Exists(path))
            {
                using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                    if (input.Length != 2 || input.ReadByte() != 'G' || input.ReadByte() != 'O')
                        throw new InvalidDataException("Invalid gate.");
                return;
            }
            Thread.Sleep(15);
        }
        throw new TimeoutException();
    }

    private static void Publish(string workspace, string name, string value)
    {
        string path = Path.Combine(workspace, name);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        byte[] bytes = Encoding.ASCII.GetBytes(value);
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                file.Write(bytes, 0, bytes.Length);
            File.Move(temporary, path);
        }
        finally { File.Delete(temporary); }
    }
}
