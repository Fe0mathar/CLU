using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public sealed class Request
{
    public string requestPath;
    public string command;
    public string[] args;
    public string cwd;
    public string[] readOnlyRoots;
    public string[] writableRoots;
    public IDictionary<string, string> env;
    public int timeoutMs;
    public string systemRoot;
    public string fixtureRoot;
    public string wfpMode;
    public string wfpContainerId;
}

public static class Protocol
{
    private const int MaxRequestBytes = 1024 * 1024;
    private static readonly string[] RequestKeys = {
        "schemaVersion", "command", "args", "cwd", "readOnlyRoots",
        "writableRoots", "env", "timeoutMs", "denyNetwork"
    };
    private static readonly string[] CommonEnvironment = {
        "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP",
        "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"
    };

    public static Request Read(string path)
    {
        var r = new Request();
        r.requestPath = LocalPath(path, false, false);
        var serializer = Serializer();
        string json;
        using (var stream = new FileStream(r.requestPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            Check(stream.Length > 0 && stream.Length <= MaxRequestBytes, "Invalid request size.");
            using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), false))
                json = reader.ReadToEnd();
        }
        CheckUniqueKeys(json, serializer);
        var fields = serializer.DeserializeObject(json) as IDictionary<string, object>;
        Check(fields != null && fields.Count == RequestKeys.Length, "Invalid request fields.");
        foreach (var key in RequestKeys)
            Check(fields.ContainsKey(key), "Missing request field.");
        Check(AsText(fields["schemaVersion"], 64) == "clue-proof-exec/1", "Unsupported request schema.");
        Check(fields["denyNetwork"] is bool && (bool)fields["denyNetwork"], "Network denial is required.");
        Check(fields["timeoutMs"] is int, "Invalid timeout type.");
        r.timeoutMs = (int)fields["timeoutMs"];
        Check(r.timeoutMs == 5000 || r.timeoutMs == 12000, "Invalid qualification timeout.");
        r.readOnlyRoots = ReadRoots(fields["readOnlyRoots"]);
        r.writableRoots = ReadRoots(fields["writableRoots"]);
        foreach (var writable in r.writableRoots)
            foreach (var readOnly in r.readOnlyRoots)
                Check(!Overlaps(writable, readOnly), "Read-only and writable roots overlap.");
        for (int i = 0; i < r.writableRoots.Length; ++i)
            for (int j = i + 1; j < r.writableRoots.Length; ++j)
                Check(!Overlaps(r.writableRoots[i], r.writableRoots[j]), "Writable roots overlap.");
        EnsurePrivatePath(r, r.requestPath);
        r.command = LocalPath(AsText(fields["command"], 4096), false, false);
        Check(Same(Path.GetFileName(r.command), "node.exe") && InRoots(r.command, r.readOnlyRoots),
            "Only the declared read-only Node executable is allowed.");
        r.args = ReadStrings(fields["args"], 256, 32766);
        int commandLineLength = Quote(r.command).Length;
        foreach (var arg in r.args)
            commandLineLength += 1 + Quote(arg).Length;
        Check(commandLineLength < 32767, "Command line exceeds the Windows limit.");
        r.cwd = LocalPath(AsText(fields["cwd"], 4096), true, false);
        Check(InRoots(r.cwd, r.readOnlyRoots) || InRoots(r.cwd, r.writableRoots),
            "Working directory is outside the declared roots.");
        EnsureQualificationFixture(r);
        r.env = ReadEnvironment(r, fields["env"]);
        EnsureQualificationCommand(r);
        return r;
    }

    public static string CanonicalPath(string path, bool directory)
    {
        return LocalPath(path, directory, false);
    }

    public static void EnsurePrivatePath(Request r, string path)
    {
        var privateFile = LocalPath(path, false, true);
        var parent = LocalPath(Path.GetDirectoryName(privateFile), true, false);
        foreach (var root in r.readOnlyRoots)
            Check(!Overlaps(parent, root), "The private request directory overlaps a declared root.");
        foreach (var root in r.writableRoots)
            Check(!Overlaps(parent, root), "The private request directory overlaps a declared root.");
    }

    public static string BuildConfig(Request r)
    {
        var commandLine = new StringBuilder(Quote(r.command));
        foreach (var arg in r.args)
            commandLine.Append(' ').Append(Quote(arg));

        var entries = new List<string>();
        foreach (var pair in r.env)
            entries.Add(pair.Key + "=" + pair.Value);

        var config = Object(
            "version", "1.0.0",
            "containment", "processcontainer",
            "lifecycle", Object("destroyOnExit", true, "preservePolicy", false),
            "process", Object("commandLine", commandLine.ToString(), "cwd", r.cwd,
                "env", entries.ToArray(), "inheritDefaultEnv", false, "timeout", 0),
            "filesystem", Object("readonlyPaths", r.readOnlyRoots, "readwritePaths", r.writableRoots,
                "deniedPaths", new[] { Path.Combine(r.fixtureRoot, "private") }),
            "network", Object("egress", Object("default", "deny"),
                "ingress", Object("default", "deny", "hostLoopback", "deny")),
            // The pinned Node fixture needs Win32k initialization. Keep UI scoped to its job.
            "ui", Object("disable", false, "clipboard", "none", "injection", false),
            "processContainer", Object("ui", Object("isolation", "container",
                "desktopSystemControl", false, "ime", false, "systemSettings", "none")));
        if (r.wfpContainerId != null)
            config.Add("containerId", r.wfpContainerId);
        return Serializer().Serialize(config);
    }

    public static string Quote(string value)
    {
        var output = new StringBuilder().Append('"');
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                ++slashes;
                continue;
            }
            if (character == '"')
                output.Append('\\', 2 * slashes + 1);
            else
                output.Append('\\', slashes);
            output.Append(character);
            slashes = 0;
        }
        return output.Append('\\', 2 * slashes).Append('"').ToString();
    }

    private static void EnsureQualificationFixture(Request r)
    {
        var requestDirectory = Path.GetDirectoryName(r.requestPath);
        var privateDirectory = Path.GetDirectoryName(requestDirectory);
        var fixture = privateDirectory == null ? null : Path.GetDirectoryName(privateDirectory);
        Check(fixture != null && Same(Path.GetFileName(r.requestPath), "request.json") &&
            MatchesTemporaryName(Path.GetFileName(requestDirectory), "request-") &&
            Same(Path.GetFileName(privateDirectory), "private") &&
            MatchesTemporaryName(Path.GetFileName(fixture), "clue-supervisor-qualify-") &&
            Same(Path.GetDirectoryName(fixture), CanonicalPath(MxcPin.QualificationTempRoot, true)),
            "Only the qualification fixture is allowed.");

        r.fixtureRoot = fixture;
        r.systemRoot = LocalPath(Path.GetDirectoryName(Environment.SystemDirectory), true, false);
        Check(Same(r.command, CanonicalPath(MxcPin.QualificationNodeExe, false)),
            "Unexpected qualification Node executable.");
        var nodeRoot = Path.GetDirectoryName(r.command);
        var readOnlyFixture = Path.Combine(fixture, "canonical-fixture");
        var workspace = Path.Combine(fixture, "workspace");
        var candidate = Path.Combine(fixture, "candidate");
        Check(!Overlaps(fixture, nodeRoot) && !Overlaps(fixture, r.systemRoot),
            "Qualification fixture overlaps a runtime root.");
        Check(r.readOnlyRoots.Length == 3 && ContainsExact(nodeRoot, r.readOnlyRoots) &&
            ContainsExact(r.systemRoot, r.readOnlyRoots) && ContainsExact(readOnlyFixture, r.readOnlyRoots),
            "Unexpected qualification read-only roots.");
        Check((r.writableRoots.Length == 1 && Same(r.writableRoots[0], workspace)) ||
            (r.writableRoots.Length == 2 && ContainsExact(workspace, r.writableRoots) &&
                ContainsExact(candidate, r.writableRoots)), "Unexpected qualification writable roots.");
        Check(Same(r.cwd, readOnlyFixture) || (r.writableRoots.Length == 2 && Same(r.cwd, candidate)),
            "Unexpected qualification working directory.");
    }

    private static void EnsureQualificationCommand(Request r)
    {
        Check(r.args.Length >= 3 && r.args[0] == "-e", "Only a qualification canary is allowed.");
        string scriptHash;
        using (var sha = SHA256.Create())
            scriptHash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(r.args[1])))
                .Replace("-", "").ToLowerInvariant();

        // These are the six exact scripts in p2-windows-supervisor-qualify.mjs.
        // Bind variable arguments too, so a fixture can exercise only its own paths.
        var root = r.fixtureRoot;
        var workspace = Path.Combine(root, "workspace");
        var candidate = Path.Combine(root, "candidate");
        var source = Path.Combine(root, "canonical-fixture", "source-canary.txt");
        var outside = Path.Combine(root, "outside");
        var token = r.env["CLU_ALLOWED_CANARY"];
        bool isCandidate = r.writableRoots.Length == 2 && Same(r.cwd, candidate);
        bool isBaseline = r.writableRoots.Length == 1 && !Same(r.cwd, candidate);
        bool valid;
        switch (scriptHash)
        {
            case "57a77dafaeb2854103de4317d6b2c082dbfbc34ab482e9548aedb05b51e08590": // Positive
                valid = (isCandidate || isBaseline) && ArgumentsMatch(r.args, source,
                    isCandidate ? Path.Combine(candidate, "candidate.txt") : Path.Combine(workspace, "baseline.txt"),
                    token, r.cwd, "quoted space \"&|%;^\\") && IsSyntheticFile(source, token);
                break;
            case "333f6df31f90cd83158a3f3121aa8c22799119941a92c123cbca14d114e4b20c": // Filesystem
                valid = isBaseline && ArgumentsMatch(r.args, source, Path.Combine(outside, "private-canary.txt"),
                    Path.Combine(root, "other-workspace", "separate-workspace.txt"),
                    Path.Combine(outside, "fake-credential.txt"),
                    workspace + "\\..\\outside\\private-canary.txt", Path.Combine(outside, "PRIVATE-CANARY.TXT"),
                    source + ":clue-qualification-canary", r.requestPath, Path.Combine(workspace, "filesystem-started.txt")) &&
                    IsSyntheticFile(source, token) && IsSyntheticFile(Path.Combine(outside, "private-canary.txt"), token) &&
                    IsSyntheticFile(Path.Combine(outside, "fake-credential.txt"), token) &&
                    IsSyntheticFile(Path.Combine(root, "other-workspace", "separate-workspace.txt"), token);
                break;
            case "6195e9a4883755e3dd1b494a5607842a6bb044039fd301fdc88d0d5b4bc48beb": // Junction
                var junction = Path.Combine(candidate, "host-alias");
                valid = isCandidate && ArgumentsMatch(r.args, Path.Combine(junction, "private-canary.txt"),
                    Path.Combine(workspace, "junction-started.txt")) &&
                    IsSyntheticFile(Path.Combine(outside, "private-canary.txt"), token) &&
                    (File.GetAttributes(junction) & FileAttributes.ReparsePoint) != 0 &&
                    Same(FinalPath(junction, false), CanonicalPath(outside, true));
                break;
            case "328cece1d8bf740245678ff4cd168249daa655abbe50dadb84b79707dfceda14": // Secrets
                valid = isBaseline && ArgumentsMatch(r.args,
                    "[\"CLU_HOST_ONLY_CANARY\",\"OPENAI_API_KEY\",\"CLU_WINDOWS_SUPERVISOR_PATH\",\"CLU_WINDOWS_SUPERVISOR_SHA256\"]");
                break;
            case "6c5b0e697c7beac6bb966764e0bcca6dc11e18dbe1058c8633fdee5acd5e9d14": // Network
                valid = isBaseline && r.args.Length == 3 && LocalSocketTargets(r.args[2]);
                break;
            case "521598661a74c95b7d4506bf4e1020dc3e13fe97a93bb7a21ce55fca17fea07d": // Descendants
                string name = r.timeoutMs == 5000 ? "deadline" : "cancelled";
                valid = isBaseline && ArgumentsMatch(r.args, Path.Combine(workspace, name + "-pids.json"),
                    Path.Combine(workspace, name + "-started.txt"), Path.Combine(workspace, name + "-survived.txt"), "8000");
                break;
            case "e8dccf1936d54894feef203f93aeb8b0e85808890415b2f775074ed9766de980": // WFP bootstrap
                var mode = r.args[2];
                valid = isBaseline && (mode == "control" || mode == "filtered" || mode == "deadline") &&
                    r.timeoutMs == (mode == "deadline" ? 5000 : 12000) &&
                    ArgumentsMatch(r.args, mode, Path.Combine(workspace, "wfp-" + mode + "-pid.txt"),
                        Path.Combine(workspace, "wfp-" + mode + "-gate.txt"));
                if (valid)
                {
                    r.wfpMode = mode;
                    r.wfpContainerId = "sandbox-" + Guid.NewGuid().ToString("N").Substring(0, 16);
                }
                break;
            default:
                valid = false;
                break;
        }
        Check(valid, "Unexpected qualification canary arguments.");
    }

    private static bool ArgumentsMatch(string[] actual, params string[] expected)
    {
        if (actual.Length != expected.Length + 2)
            return false;
        for (int i = 0; i < expected.Length; ++i)
            if (!String.Equals(actual[i + 2], expected[i], StringComparison.Ordinal))
                return false;
        return true;
    }

    private static bool IsSyntheticFile(string path, string marker)
    {
        path = CanonicalPath(path, false);
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            FileInformation information;
            if (!GetFileInformationByHandle(stream.SafeFileHandle, out information) ||
                information.NumberOfLinks != 1 || stream.Length != marker.Length)
                return false;
            foreach (char expected in marker)
                if (stream.ReadByte() != expected)
                    return false;
            return true;
        }
    }

    private static bool LocalSocketTargets(string json)
    {
        CheckUniqueKeys(json, Serializer());
        var endpoints = Serializer().DeserializeObject(json) as IList;
        if (endpoints == null || endpoints.Count != 2)
            return false;
        var loopback = SocketTarget(endpoints[0]);
        var lan = SocketTarget(endpoints[1]);
        if (!IPAddress.Loopback.Equals(loopback) || lan == null || IPAddress.IsLoopback(lan))
            return false;
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
            foreach (var address in adapter.GetIPProperties().UnicastAddresses)
                if (lan.Equals(address.Address))
                    return true;
        return false;
    }

    private static IPAddress SocketTarget(object value)
    {
        var target = value as IDictionary<string, object>;
        if (target == null || target.Count != 2 || !target.ContainsKey("host") || !target.ContainsKey("port") ||
            !(target["port"] is int) || (int)target["port"] < 1 || (int)target["port"] > 65535)
            return null;
        IPAddress address;
        var host = target["host"] as string;
        return IPAddress.TryParse(host, out address) && address.AddressFamily == AddressFamily.InterNetwork &&
            host == address.ToString() ? address : null;
    }

    private static bool MatchesTemporaryName(string name, string prefix)
    {
        if (name == null || name.Length != prefix.Length + 6 ||
            !name.StartsWith(prefix, StringComparison.Ordinal))
            return false;
        for (int i = prefix.Length; i < name.Length; ++i)
        {
            char c = name[i];
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')))
                return false;
        }
        return true;
    }

    private static IDictionary<string, string> ReadEnvironment(Request r, object value)
    {
        var supplied = value as IDictionary<string, object>;
        Check(supplied != null, "Invalid environment.");
        var source = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in supplied)
            source.Add(pair.Key, AsText(pair.Value, 32766));
        var approved = new List<string>(CommonEnvironment);
        approved.Add("CLU_ALLOWED_CANARY");
        Check(source.Count == approved.Count, "Unexpected environment keys.");
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in approved)
        {
            Check(source.ContainsKey(key), "Missing environment key.");
            env.Add(key, source[key]);
        }

        foreach (var key in new[] { "SystemRoot", "WINDIR" })
            Check(Same(LocalPath(env[key], true, false), r.systemRoot), "Invalid Windows root.");
        Check(InRoots(r.systemRoot, r.readOnlyRoots), "Windows root must be declared read-only.");
        env["SystemRoot"] = r.systemRoot;
        env["WINDIR"] = r.systemRoot;
        env["ComSpec"] = LocalPath(env["ComSpec"], false, false);
        Check(Same(env["ComSpec"], Path.Combine(Environment.SystemDirectory, "cmd.exe")),
            "Invalid command interpreter.");
        Check(env["PATHEXT"] == ".COM;.EXE;.BAT;.CMD", "Invalid executable extensions.");

        var searchPaths = env["PATH"].Split(';');
        var nodeRoot = Path.GetDirectoryName(r.command);
        var systemDirectory = LocalPath(Environment.SystemDirectory, true, false);
        Check(searchPaths.Length == 2 && Same(LocalPath(searchPaths[0], true, false), nodeRoot) &&
            Same(LocalPath(searchPaths[1], true, false), systemDirectory), "Unexpected qualification search path.");
        env["PATH"] = nodeRoot + ";" + systemDirectory;
        var childTemp = Path.Combine(r.fixtureRoot, "workspace", "temp");
        foreach (var key in new[] { "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA" })
        {
            env[key] = LocalPath(env[key], true, false);
            Check(Same(env[key], childTemp), "Unexpected qualification environment directory.");
        }
        var marker = env["CLU_ALLOWED_CANARY"];
        Check(marker.Length == 32, "Invalid canary marker.");
        foreach (char c in marker)
            Check((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'), "Invalid canary marker.");
        return env;
    }

    private static string[] ReadRoots(object value)
    {
        var roots = ReadStrings(value, 64, 4096);
        Check(roots.Length > 0, "Declared roots are required.");
        var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < roots.Length; ++i)
        {
            roots[i] = LocalPath(roots[i], true, false);
            Check(roots[i].Length > 3 && unique.Add(roots[i]), "Invalid or duplicate declared root.");
        }
        return roots;
    }

    private static string[] ReadStrings(object value, int maxItems, int maxLength)
    {
        var array = value as IList;
        Check(array != null && array.Count <= maxItems, "Invalid array.");
        var values = new string[array.Count];
        for (int i = 0; i < array.Count; ++i)
            values[i] = AsText(array[i], maxLength);
        return values;
    }

    private static string AsText(object value, int maxLength)
    {
        var result = value as string;
        Check(result != null && result.Length <= maxLength, "Invalid string.");
        for (int i = 0; i < result.Length; ++i)
        {
            char c = result[i];
            Check(c != '\0' && !Char.IsLowSurrogate(c), "Invalid string character.");
            if (Char.IsHighSurrogate(c))
                Check(++i < result.Length && Char.IsLowSurrogate(result[i]), "Invalid Unicode string.");
        }
        return result;
    }

    private static string LocalPath(string path, bool directory, bool mayBeMissing)
    {
        Check(!String.IsNullOrEmpty(path) && path.Length >= 3 && path.Length <= 4096, "Invalid local path.");
        path = path.Replace('/', '\\');
        Check(((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
            path[1] == ':' && path[2] == '\\', "Only absolute local drive paths are allowed.");
        var components = path.Length == 3 ? new string[0] : path.Substring(3).Split('\\');
        foreach (var part in components)
            CheckComponent(part);
        Check(Same(Path.GetFullPath(path), path), "Path is not canonical.");

        string existing = path.Substring(0, 3);
        CheckAttributes(existing, true);
        bool found = true;
        for (int i = 0; i < components.Length; ++i)
        {
            var next = Path.Combine(existing, components[i]);
            try
            {
                CheckAttributes(next, directory || i < components.Length - 1);
                existing = next;
            }
            catch (FileNotFoundException)
            {
                found = false;
                break;
            }
            catch (DirectoryNotFoundException)
            {
                found = false;
                break;
            }
        }
        Check(found || mayBeMissing, "Path does not exist.");
        Check(Same(FinalPath(existing), existing), "Path aliases are disallowed.");
        return path;
    }

    private static void CheckComponent(string value)
    {
        Check(value.Length > 0 && !value.EndsWith(".", StringComparison.Ordinal) &&
            !value.EndsWith(" ", StringComparison.Ordinal), "Invalid path component.");
        foreach (char c in value)
            Check(c >= 32 && "\"<>:|?*".IndexOf(c) < 0, "Invalid path character.");
        var name = value.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
        Check(name != "CON" && name != "PRN" && name != "AUX" && name != "NUL" &&
            name != "CONIN$" && name != "CONOUT$" &&
            !(name.Length == 4 && (name.StartsWith("COM", StringComparison.Ordinal) ||
                name.StartsWith("LPT", StringComparison.Ordinal)) && "123456789\u00b9\u00b2\u00b3".IndexOf(name[3]) >= 0),
            "Windows device paths are disallowed.");
    }

    private static void CheckAttributes(string path, bool directory)
    {
        var attributes = File.GetAttributes(path);
        Check((attributes & FileAttributes.ReparsePoint) == 0, "Reparse points are disallowed.");
        Check(((attributes & FileAttributes.Directory) != 0) == directory, "Unexpected path type.");
    }

    private static string FinalPath(string path, bool openReparsePoint = true)
    {
        const uint shareAll = 7;
        const uint openExisting = 3;
        uint flags = 0x02000000 | (openReparsePoint ? 0x00200000U : 0U);
        using (var handle = CreateFileW(path, 0, shareAll, IntPtr.Zero, openExisting, flags, IntPtr.Zero))
        {
            if (handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify local path.");
            var buffer = new StringBuilder(4096 + 8);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            Check(length > 0 && length < buffer.Capacity, "Cannot obtain canonical local path.");
            var final = buffer.ToString();
            Check(final.StartsWith("\\\\?\\", StringComparison.Ordinal), "Local drive path required.");
            return final.Substring(4);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string fileName, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path,
        uint size, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
        public uint VolumeSerialNumber, SizeHigh, SizeLow, NumberOfLinks, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

    private static bool Same(string a, string b)
    {
        return String.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    }

    private static bool Within(string path, string root)
    {
        return Same(path, root) || path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    private static bool Overlaps(string a, string b)
    {
        return Within(a, b) || Within(b, a);
    }

    private static bool InRoots(string path, string[] roots)
    {
        foreach (var root in roots)
            if (Within(path, root))
                return true;
        return false;
    }

    private static bool ContainsExact(string path, string[] roots)
    {
        foreach (var root in roots)
            if (Same(path, root))
                return true;
        return false;
    }

    private static void CheckUniqueKeys(string json, JavaScriptSerializer serializer)
    {
        var scopes = new Stack<HashSet<string>>();
        for (int i = 0; i < json.Length; ++i)
        {
            char c = json[i];
            if (c == '{')
            {
                Check(scopes.Count < 16, "Request nesting exceeds the limit.");
                scopes.Push(new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            }
            else if (c == '}')
            {
                Check(scopes.Count > 0, "Unbalanced request object.");
                scopes.Pop();
            }
            else if (c == '"')
            {
                int start = i++;
                while (i < json.Length && json[i] != '"')
                {
                    if (json[i] == '\\')
                        ++i;
                    ++i;
                }
                Check(i < json.Length, "Unterminated request string.");
                int next = i + 1;
                while (next < json.Length && Char.IsWhiteSpace(json[next]))
                    ++next;
                if (next < json.Length && json[next] == ':')
                {
                    var key = serializer.Deserialize<string>(json.Substring(start, i - start + 1));
                    Check(scopes.Count > 0 && scopes.Peek().Add(key), "Duplicate request key.");
                }
            }
            else if (c == '\'')
                throw new InvalidDataException("JSON keys and strings require double quotes.");
        }
        Check(scopes.Count == 0, "Unbalanced request object.");
    }

    private static JavaScriptSerializer Serializer()
    {
        return new JavaScriptSerializer { MaxJsonLength = MaxRequestBytes, RecursionLimit = 16 };
    }

    private static IDictionary<string, object> Object(params object[] values)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < values.Length; i += 2)
            result.Add((string)values[i], values[i + 1]);
        return result;
    }

    private static void Check(bool condition, string message)
    {
        if (!condition)
            throw new InvalidDataException(message);
    }
}
