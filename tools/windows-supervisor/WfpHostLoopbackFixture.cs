using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

// Two pinned fixture instances exchange bounded localhost challenges across the MXC boundary.
internal static class WfpHostLoopbackFixture
{
    private const string HostRole = "host-net-host";
    private const string SandboxRole = "host-net";
    private const int TokenLength = 32;
    private const int PhaseWaitMs = 5000;
    private const int AttemptWaitMs = 850;
    private const int ServerWaitMs = 200;
    private const string Unverified = "UNVERIFIED";
    private const string Delivered = "DELIVERED";
    private const string TimedOut = "TIMED_OUT";
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

    internal static int Run(string mode, string workspace)
    {
        bool host = mode == HostRole;
        if (!host && mode != SandboxRole) return 2;

        string peer = host ? SandboxRole : HostRole;
        string resultRoot = host ? Path.Combine(Path.GetDirectoryName(workspace), "private") : workspace;
        var receivers = new Receiver[4];
        try
        {
            if (!host)
            {
                using (var self = Process.GetCurrentProcess())
                    Publish(workspace, SandboxRole + "-pid.txt", self.Id.ToString(Invariant));
                WaitMarker(workspace, SandboxRole + "-go.txt", "GO");
            }

            byte[] outboundToken = NewToken();
            byte[] selfToken = NewToken();
            receivers[0] = new Receiver(IPAddress.Loopback, true);
            receivers[1] = new Receiver(IPAddress.IPv6Loopback, true);
            receivers[2] = new Receiver(IPAddress.Loopback, false);
            receivers[3] = new Receiver(IPAddress.IPv6Loopback, false);

            int[] ports = Array.ConvertAll(receivers, receiver => receiver.Port);
            Publish(workspace, mode + "-ready.txt",
                Encoding.ASCII.GetString(outboundToken) + " " + String.Join(" ", Array.ConvertAll(ports, FormatPort)));
            string[] peerReady = WaitRead(workspace, peer + "-ready.txt", 64).Split(' ');
            if (peerReady.Length != 5 || !ValidToken(peerReady[0]))
                throw new InvalidDataException("Invalid peer ready marker.");
            byte[] peerToken = Encoding.ASCII.GetBytes(peerReady[0]);
            if (Same(outboundToken, peerToken) || Same(selfToken, peerToken))
                throw new InvalidDataException("Challenge identity collision.");
            var peerPorts = new int[4];
            for (int index = 0; index < peerPorts.Length; index++)
            {
                int port;
                if (!Int32.TryParse(peerReady[index + 1], NumberStyles.None, Invariant, out port) ||
                    port < 1 || port > 65535 || FormatPort(port) != peerReady[index + 1])
                    throw new InvalidDataException("Invalid peer port.");
                peerPorts[index] = port;
                receivers[index].Start(selfToken, peerToken);
            }

            string[] localAttempts = AttemptAll(receivers, ports, selfToken, null);
            Publish(workspace, mode + "-armed.txt", "ARMED");
            WaitMarker(workspace, peer + "-armed.txt", "ARMED");

            // An equal port in two network namespaces is ambiguous. Report that lane
            // unverified rather than risking an accidental probe of our own listener.
            string[] outbound = AttemptAll(receivers, peerPorts, outboundToken, ports);
            Publish(workspace, mode + "-sent.txt", "SENT");
            WaitMarker(workspace, peer + "-sent.txt", "SENT");
            Thread.Sleep(ServerWaitMs);

            var inbound = new bool[4];
            var controls = new bool[4];
            for (int index = 0; index < receivers.Length; index++)
            {
                receivers[index].Stop();
                inbound[index] = receivers[index].PeerSeen;
                controls[index] = localAttempts[index] == Delivered && receivers[index].ControlSeen;
            }
            string result = "{\"ports\":[" + String.Join(",", Array.ConvertAll(ports, FormatPort)) +
                "],\"localControl\":[" + FormatFlags(controls) + "],\"outbound\":[\"" + String.Join("\",\"", outbound) +
                "\"],\"inbound\":[" + FormatFlags(inbound) + "]}";
            Publish(resultRoot, mode + "-result.json", result);
            return 0;
        }
        catch (TimeoutException) { ReportFailure(resultRoot, mode, "PHASE_TIMEOUT"); }
        catch (SocketException error)
        {
            int code = error.NativeErrorCode;
            ReportFailure(resultRoot, mode, code > 0 && code <= 65535 ?
                "LISTENER_ERROR_" + code.ToString(Invariant) : "FIXTURE_REFUSED");
        }
        catch (Exception) { ReportFailure(resultRoot, mode, "FIXTURE_REFUSED"); }
        finally
        {
            foreach (var receiver in receivers)
                if (receiver != null) receiver.Dispose();
        }
        return 2;
    }

    private static void ReportFailure(string folder, string role, string code)
    {
        Console.Error.WriteLine("[CLU-E HOST LOOPBACK] " + code);
        try { Publish(folder, role + "-error.txt", code); }
        catch (Exception) { }
    }

    private static string[] AttemptAll(Receiver[] receivers, int[] ports, byte[] token, int[] ownPorts)
    {
        var outcome = new string[receivers.Length];
        var workers = new Thread[receivers.Length];
        for (int index = 0; index < receivers.Length; index++)
        {
            int lane = index;
            if (ownPorts != null && ports[lane] == ownPorts[lane])
            {
                outcome[lane] = Unverified;
                continue;
            }
            workers[lane] = new Thread(() => {
                try { outcome[lane] = Probe(receivers[lane].Address, receivers[lane].Tcp, ports[lane], token); }
                catch (Exception) { outcome[lane] = Unverified; }
            }) { IsBackground = true };
            workers[lane].Start();
        }

        var clock = Stopwatch.StartNew();
        foreach (var worker in workers)
            if (worker != null && !worker.Join(Math.Max(0, 3200 - (int)clock.ElapsedMilliseconds)))
                throw new TimeoutException();
        return outcome;
    }

    private static string Probe(IPAddress address, bool tcp, int port, byte[] token)
    {
        using (var socket = NewSocket(address, tcp))
        {
            socket.SendTimeout = AttemptWaitMs;
            socket.ReceiveTimeout = AttemptWaitMs;
            var endpoint = new IPEndPoint(address, port);
            bool tcpConnected = false;
            try
            {
                if (tcp)
                {
                    IAsyncResult connect = socket.BeginConnect(endpoint, null, null);
                    using (var completed = connect.AsyncWaitHandle)
                    {
                        if (!completed.WaitOne(AttemptWaitMs))
                        {
                            socket.Close();
                            return TimedOut;
                        }
                        socket.EndConnect(connect);
                        tcpConnected = true;
                    }
                    if (!SendAll(socket, token)) return Unverified;
                    byte[] reply = ReadStream(socket, AttemptWaitMs);
                    return Same(reply, token) ? Delivered : Unverified;
                }
                socket.Connect(endpoint);
                if (socket.Send(token) != token.Length) return Unverified;
                var response = new byte[TokenLength + 1];
                int read = socket.Receive(response);
                return Same(response, read, token) ? Delivered : Unverified;
            }
            catch (SocketException error)
            {
                // A completed TCP connect cannot count as a denied TCP challenge
                // even if a subsequent write or echo read fails.
                if (tcpConnected) return Unverified;
                if (error.SocketErrorCode == SocketError.AccessDenied) return "ACCESS_DENIED";
                if (error.SocketErrorCode == SocketError.ConnectionRefused) return "CONNECTION_REFUSED";
                if (error.SocketErrorCode == SocketError.ConnectionReset) return "CONNECTION_RESET";
                if (error.SocketErrorCode == SocketError.TimedOut) return TimedOut;
                return Unverified;
            }
        }
    }

    private static bool SendAll(Socket socket, byte[] token)
    {
        var clock = Stopwatch.StartNew();
        int sent = 0;
        while (sent < token.Length)
        {
            int remaining = AttemptWaitMs - (int)clock.ElapsedMilliseconds;
            if (remaining <= 0) return false;
            socket.SendTimeout = remaining;
            int count = socket.Send(token, sent, token.Length - sent, SocketFlags.None);
            if (count <= 0) return false;
            sent += count;
        }
        return true;
    }

    private static byte[] ReadStream(Socket socket, int budget)
    {
        var token = new byte[TokenLength];
        var clock = Stopwatch.StartNew();
        int read = 0;
        while (read < token.Length)
        {
            int remaining = budget - (int)clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new SocketException((int)SocketError.TimedOut);
            socket.ReceiveTimeout = remaining;
            int count = socket.Receive(token, read, token.Length - read, SocketFlags.None);
            if (count == 0) return null;
            read += count;
        }
        return token;
    }

    private static Socket NewSocket(IPAddress address, bool tcp)
    {
        var socket = new Socket(address.AddressFamily, tcp ? SocketType.Stream : SocketType.Dgram,
            tcp ? ProtocolType.Tcp : ProtocolType.Udp);
        try
        {
            if (address.AddressFamily == AddressFamily.InterNetworkV6)
                socket.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.IPv6Only, 1);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private sealed class Receiver : IDisposable
    {
        private readonly Socket socket;
        private Thread worker;
        private volatile bool stopping;
        private volatile bool failed;
        private volatile bool controlSeen;
        private volatile bool peerSeen;

        internal Receiver(IPAddress address, bool tcp)
        {
            Address = address;
            Tcp = tcp;
            socket = NewSocket(address, tcp);
            try
            {
                socket.ExclusiveAddressUse = true;
                socket.Bind(new IPEndPoint(address, 0));
                socket.SendTimeout = ServerWaitMs;
                socket.ReceiveTimeout = ServerWaitMs;
                if (Tcp) socket.Listen(4);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }

        internal IPAddress Address { get; private set; }
        internal bool Tcp { get; private set; }
        internal int Port { get { return ((IPEndPoint)socket.LocalEndPoint).Port; } }
        internal bool ControlSeen { get { return controlSeen; } }
        internal bool PeerSeen { get { return peerSeen; } }

        internal void Start(byte[] own, byte[] peer)
        {
            worker = new Thread(() => Serve(own, peer)) { IsBackground = true };
            worker.Start();
        }

        internal void Stop()
        {
            stopping = true;
            if (worker == null || !worker.Join(1400) || failed)
                throw new InvalidOperationException("Listener did not finish safely.");
        }

        public void Dispose()
        {
            stopping = true;
            socket.Dispose();
            if (worker != null) worker.Join(1000);
        }

        private bool Remember(byte[] data, int length, byte[] own, byte[] peer)
        {
            if (Same(data, length, peer)) { peerSeen = true; return true; }
            if (Same(data, length, own)) { controlSeen = true; return true; }
            return false;
        }

        private void Serve(byte[] own, byte[] peer)
        {
            try
            {
                var packet = new byte[TokenLength + 1];
                while (!stopping)
                {
                    if (!socket.Poll(50000, SelectMode.SelectRead)) continue;
                    if (Tcp)
                    {
                        using (var client = socket.Accept())
                        {
                            try
                            {
                                byte[] challenge = ReadStream(client, ServerWaitMs);
                                if (challenge != null && Remember(challenge, challenge.Length, own, peer))
                                    SendAll(client, challenge);
                            }
                            catch (SocketException error)
                            {
                                if (!ExpectedPeerFailure(error)) throw;
                            }
                        }
                    }
                    else
                    {
                        EndPoint endpoint = new IPEndPoint(Address, 0);
                        int read;
                        try { read = socket.ReceiveFrom(packet, ref endpoint); }
                        catch (SocketException error)
                        {
                            if (error.SocketErrorCode == SocketError.MessageSize) continue;
                            throw;
                        }
                        if (!Remember(packet, read, own, peer)) continue;
                        try { socket.SendTo(packet, 0, read, SocketFlags.None, endpoint); }
                        catch (SocketException error)
                        {
                            if (!ExpectedPeerFailure(error)) throw;
                        }
                    }
                }
            }
            catch (Exception)
            {
                if (!stopping) failed = true;
            }
        }
    }

    private static bool ExpectedPeerFailure(SocketException error)
    {
        return error.SocketErrorCode == SocketError.AccessDenied || error.SocketErrorCode == SocketError.TimedOut ||
            error.SocketErrorCode == SocketError.ConnectionReset || error.SocketErrorCode == SocketError.ConnectionAborted ||
            error.SocketErrorCode == SocketError.ConnectionRefused;
    }

    private static bool Same(byte[] value, byte[] expected)
    {
        return value != null && Same(value, value.Length, expected);
    }

    private static bool Same(byte[] value, int length, byte[] expected)
    {
        if (length != expected.Length) return false;
        int mismatch = 0;
        for (int index = 0; index < length; index++)
            mismatch |= value[index] ^ expected[index];
        return mismatch == 0;
    }

    private static byte[] NewToken()
    {
        var data = new byte[TokenLength / 2];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(data);
        return Encoding.ASCII.GetBytes(BitConverter.ToString(data).Replace("-", "").ToLowerInvariant());
    }

    private static bool ValidToken(string token)
    {
        if (token.Length != TokenLength) return false;
        foreach (char value in token)
            if ((value < '0' || value > '9') && (value < 'a' || value > 'f')) return false;
        return true;
    }

    private static string FormatPort(int port) { return port.ToString(Invariant); }

    private static string FormatFlags(bool[] flags)
    {
        return String.Join(",", Array.ConvertAll(flags, value => value ? "true" : "false"));
    }

    private static void WaitMarker(string folder, string name, string expected)
    {
        if (WaitRead(folder, name, expected.Length) != expected)
            throw new InvalidDataException("Invalid phase marker.");
    }

    private static string WaitRead(string folder, string name, int maxBytes)
    {
        string path = Path.Combine(folder, name);
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < PhaseWaitMs)
        {
            if (File.Exists(path))
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Invalid handshake path.");
                using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (input.Length < 1 || input.Length > maxBytes)
                        throw new InvalidDataException("Invalid handshake size.");
                    using (var reader = new StreamReader(input, Encoding.ASCII, false))
                        return reader.ReadToEnd();
                }
            }
            Thread.Sleep(20);
        }
        throw new TimeoutException();
    }

    private static void Publish(string folder, string name, string content)
    {
        string path = Path.Combine(folder, name);
        string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            byte[] bytes = Encoding.ASCII.GetBytes(content);
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                stream.Write(bytes, 0, bytes.Length);
            File.Move(temp, path);
        }
        finally { File.Delete(temp); }
    }
}
