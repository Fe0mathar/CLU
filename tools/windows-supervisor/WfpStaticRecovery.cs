using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// The intent is host-only, run-specific and written before the WFP transaction.
internal static class WfpStaticRecovery
{
    private const string IntentFile = "static-intent.json";
    internal const string ResultFile = "static-recovery-result.json";
    internal const string AcknowledgementFile = "static-recovery-allowed.txt";
    private const uint ProcessQueryAndSynchronize = 0x00101000;
    private const int InvalidParameter = 87;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 8 };

    public sealed class ProcessIdentity
    {
        public int pid { get; set; }
        public string started { get; set; }
    }

    public sealed class Intent
    {
        public int version { get; set; }
        public int sessionId { get; set; }
        public string jobName { get; set; }
        public string packageSid { get; set; }
        public string sublayerKey { get; set; }
        public string[] filterKeys { get; set; }
        public ProcessIdentity coordinator { get; set; }
        public ProcessIdentity guardian { get; set; }
        public ProcessIdentity[] members { get; set; }
    }

    internal static void Publish(string root, string jobName, Process coordinator, byte[] sid, Guid sublayer, Guid[] filters, int[] jobPids)
    {
        using (var self = Process.GetCurrentProcess())
        {
            var members = new ProcessIdentity[jobPids.Length];
            for (int index = 0; index < jobPids.Length; index++)
                members[index] = Identify(jobPids[index]);
            var intent = new Intent {
                version = 1, sessionId = self.SessionId, jobName = jobName, packageSid = Convert.ToBase64String(sid),
                sublayerKey = sublayer.ToString("D"), filterKeys = Array.ConvertAll(filters, id => id.ToString("D")),
                coordinator = Identify(coordinator.Id), guardian = Identify(self.Id), members = members,
            };
            WriteNew(Path.Combine(root, IntentFile), Json.Serialize(intent));
        }
    }

    internal static int Run(string root, string diagnosticImage, int coordinatorPid, bool coordinatorMustBeDead = false)
    {
        try
        {
            // The acknowledgement authorizes only the live diagnostic route. The explicit
            // retained-stage route requires the original coordinator to have exited too.
            if (coordinatorPid != 0 && ReadSmall(root, AcknowledgementFile, 8) != "VERIFIED")
                throw new InvalidDataException("STATIC_OBSERVER_ACK_INVALID");
            var intent = Json.Deserialize<Intent>(ReadSmall(root, IntentFile, 8192));
            using (var self = Process.GetCurrentProcess())
            {
                if (intent == null || intent.version != 1 || intent.sessionId != self.SessionId ||
                    intent.coordinator == null || intent.guardian == null || intent.members == null ||
                    intent.members.Length < 3 || intent.members.Length > 32 || intent.filterKeys == null ||
                    intent.filterKeys.Length != 6 || !Regex.IsMatch(intent.jobName ?? "", @"\ALocal\\CLU-E-[a-f0-9]{32}\z"))
                    throw new InvalidDataException("STATIC_RECOVERY_INTENT_INVALID");
            }

            var processIds = new HashSet<int>();
            foreach (var identity in intent.members)
                if (identity == null || identity.pid < 1 || !processIds.Add(identity.pid) || IsOriginalLive(identity))
                    throw new InvalidDataException("STATIC_JOB_MEMBER_STILL_LIVE_OR_UNVERIFIED");
            if (!processIds.Add(intent.guardian.pid) || !processIds.Add(intent.coordinator.pid) ||
                IsOriginalLive(intent.guardian))
                throw new InvalidDataException("STATIC_GUARDIAN_STILL_LIVE_OR_UNVERIFIED");
            if (coordinatorPid == 0)
            {
                if (IsOriginalLive(intent.coordinator))
                    throw new InvalidDataException("STATIC_COORDINATOR_STILL_LIVE");
            }
            else
            {
                if (intent.coordinator.pid != coordinatorPid ||
                    IsOriginalLive(intent.coordinator, diagnosticImage) == coordinatorMustBeDead)
                    throw new InvalidDataException("STATIC_COORDINATOR_IDENTITY_INVALID");
            }

            var clock = Stopwatch.StartNew();
            while (!NativeJob.NamedJobAbsent(intent.jobName))
            {
                if (clock.ElapsedMilliseconds >= 2000) throw new InvalidDataException("STATIC_NAMED_JOB_STILL_PRESENT");
                Thread.Sleep(25);
            }

            byte[] sid = Convert.FromBase64String(intent.packageSid);
            Guid sublayer = Guid.ParseExact(intent.sublayerKey, "D");
            Guid[] filters = Array.ConvertAll(intent.filterKeys, value => Guid.ParseExact(value, "D"));
            if (!WfpLoopbackLease.RecoverStatic(sid, sublayer, filters))
                throw new InvalidDataException("STATIC_RECOVERY_NOT_VERIFIED");
            string receipt = Path.Combine(root, ResultFile);
            const string evidence = "{\"state\":\"STATIC_RECOVERY_VERIFIED\",\"jobAbsent\":true,\"filtersRemoved\":true}";
            if (!File.Exists(receipt)) WriteNew(receipt, evidence);
            else if (ReadSmall(root, ResultFile, 128) != evidence)
                throw new InvalidDataException("STATIC_RECOVERY_RECEIPT_CONFLICT");
            Console.WriteLine("[CLU-E 05Q] STATIC_RECOVERY_VERIFIED");
            return 0;
        }
        catch (Exception error)
        {
            string code = Regex.IsMatch(error.Message, @"\ASTATIC_[A-Z0-9_]{1,70}\z")
                ? error.Message : "STATIC_RECOVERY_REFUSED";
            Console.Error.WriteLine("[CLU-E 05Q] " + code);
            return 125;
        }
    }

    private static ProcessIdentity Identify(int pid)
    {
        using (var process = OpenProcess(ProcessQueryAndSynchronize, false, pid))
        {
            if (process.IsInvalid || !Live(process)) throw new InvalidDataException("STATIC_PROCESS_IDENTITY_UNVERIFIED");
            return new ProcessIdentity { pid = pid, started = CreationTime(process).ToString(CultureInfo.InvariantCulture) };
        }
    }

    private static bool IsOriginalLive(ProcessIdentity identity, string image = null)
    {
        long started;
        if (identity.pid < 1 || !Int64.TryParse(identity.started, NumberStyles.None, CultureInfo.InvariantCulture, out started) || started <= 0)
            throw new InvalidDataException("STATIC_PROCESS_IDENTITY_INVALID");
        using (var process = OpenProcess(ProcessQueryAndSynchronize, false, identity.pid))
        {
            if (process.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (error == InvalidParameter) return false;
                throw new Win32Exception(error);
            }
            if (!Live(process) || CreationTime(process) != started) return false;
            if (image != null)
            {
                var name = new StringBuilder(4096);
                uint capacity = (uint)name.Capacity;
                if (!QueryFullProcessImageNameW(process, 0, name, ref capacity) ||
                    !String.Equals(Protocol.CanonicalPath(name.ToString(), false), image, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("STATIC_PROCESS_IMAGE_INVALID");
            }
            return Live(process);
        }
    }

    private static bool Live(OwnedProcessHandle process)
    {
        uint outcome = WaitForSingleObject(process, 0);
        if (outcome == 258) return true;
        if (outcome == 0) return false;
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static long CreationTime(OwnedProcessHandle process)
    {
        long created, exited, kernel, user;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return created;
    }

    private static string ReadSmall(string root, string name, int maxBytes)
    {
        string path = Protocol.CanonicalPath(Path.Combine(root, name), false);
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (stream.Length < 1 || stream.Length > maxBytes)
                throw new InvalidDataException("STATIC_MARKER_SIZE_INVALID");
            using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), false))
                return reader.ReadToEnd();
        }
    }

    private static void WriteNew(string path, string value)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        byte[] bytes = new UTF8Encoding(false).GetBytes(value);
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                file.Write(bytes, 0, bytes.Length);
                file.Flush(true);
            }
            File.Move(temporary, path);
        }
        finally { File.Delete(temporary); }
    }

    private sealed class OwnedProcessHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public OwnedProcessHandle() : base(true) { }
        protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern OwnedProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint WaitForSingleObject(OwnedProcessHandle process, uint timeout);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool GetProcessTimes(OwnedProcessHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageNameW(OwnedProcessHandle process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
