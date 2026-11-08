using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal sealed partial class WfpPairedSupervisor
{
    private static int RunEnforcementFaultRecovery(string stageId)
    {
        const string stagePattern = @"\A\.clue-wfp-fault-setup-[a-f0-9]{32}\z";
        if (!Regex.IsMatch(stageId, stagePattern, RegexOptions.CultureInvariant)) return 125;
        DiagnosticImage();
        string current = Protocol.CanonicalPath(MxcPin.WfpDiagnosticStage, true);
        if (!Regex.IsMatch(Path.GetFileName(current), stagePattern, RegexOptions.CultureInvariant) ||
            String.Equals(Path.GetFileName(current), stageId, StringComparison.OrdinalIgnoreCase)) return 125;
        string currentPrivate = StaticPrivateRoot("enforcement-fault");
        bool jobAbsent = false, stagedProcessesAbsent = false;
        bool diagnosticSessionsAbsent = false, diagnosticSublayersAbsent = false;
        string error = null;
        try
        {
            string previous = Protocol.CanonicalPath(Path.Combine(Path.GetDirectoryName(current), stageId), true);
            string previousPrivate = Protocol.CanonicalPath(Path.Combine(previous, "enforcement-fault", "private"), true);
            string job = ReadLegacyFaultJob(previousPrivate);
            using (var bfe = new WfpBfeWatch())
            {
                bfe.RequireHealthy();
                jobAbsent = NativeJob.NamedJobAbsent(job);
                if (!jobAbsent) throw new InvalidDataException("WFP_PRIOR_JOB_PRESENT");
                stagedProcessesAbsent = LegacyFaultProcessesAbsent(previous);
                if (!stagedProcessesAbsent) throw new InvalidDataException("WFP_PRIOR_PROCESS_PRESENT");

                IntPtr engine;
                // The default observer has no CLU-E display name and makes no policy changes.
                CheckRecoveryWfp(RecoveryEngineOpen(null, 10, IntPtr.Zero, IntPtr.Zero, out engine));
                try
                {
                    diagnosticSessionsAbsent = RecoveryObjectsAbsent(engine, FwpmSessionCreateEnumHandle0,
                        FwpmSessionEnum0, FwpmSessionDestroyEnumHandle0, "CLU-E disposable network diagnostic");
                    diagnosticSublayersAbsent = RecoveryObjectsAbsent(engine, FwpmSubLayerCreateEnumHandle0,
                        FwpmSubLayerEnum0, FwpmSubLayerDestroyEnumHandle0, "CLU-E disposable package-only block");
                }
                finally { CheckRecoveryWfp(RecoveryEngineClose(engine)); }
                bfe.RequireHealthy();

                jobAbsent = NativeJob.NamedJobAbsent(job);
                stagedProcessesAbsent = LegacyFaultProcessesAbsent(previous);
                if (!jobAbsent || !stagedProcessesAbsent)
                    throw new InvalidDataException("WFP_PRIOR_PROCESS_STATE_CHANGED");
                if (!diagnosticSessionsAbsent || !diagnosticSublayersAbsent)
                    throw new InvalidDataException("WFP_PRIOR_DIAGNOSTIC_POLICY_PRESENT");
            }
        }
        catch (Exception failure)
        {
            error = Regex.IsMatch(failure.Message, @"\A(?:WFP_PRIOR_[A-Z_]{1,52}(?:_0x[0-9A-F]{8})?|BFE_[A-Z_]{1,40})\z")
                ? failure.Message : "WFP_PRIOR_RECOVERY_REFUSED";
        }
        bool passed = error == null && jobAbsent && stagedProcessesAbsent &&
            diagnosticSessionsAbsent && diagnosticSublayersAbsent;
        WriteNew(Path.Combine(currentPrivate, "reconcile-" + stageId + ".json"), new JavaScriptSerializer().Serialize(new {
            state = passed ? "WFP_PRIOR_DYNAMIC_STAGE_RECONCILED" : "WFP_PRIOR_DYNAMIC_STAGE_UNVERIFIED",
            stageId, error, jobAbsent, stagedProcessesAbsent, diagnosticSessionsAbsent, diagnosticSublayersAbsent,
            proofAuthorization = false,
        }));
        return passed ? 0 : 125;
    }

    private static string ReadLegacyFaultJob(string previousPrivate)
    {
        if (ReadPrivateFaultMarker(Path.Combine(previousPrivate, "fault-launch.txt")) != "CLU-E-WFP-FAULT-1" ||
            ReadPrivateFaultMarker(Path.Combine(previousPrivate, "fault-native-started.txt")) != "STARTED")
            throw new InvalidDataException("WFP_PRIOR_LAUNCH_UNVERIFIED");

        string result = Protocol.CanonicalPath(Path.Combine(previousPrivate, "result.json"), false);
        Dictionary<string, object> record;
        using (var stream = new FileStream(result, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (stream.Length < 2 || stream.Length > 4096)
                throw new InvalidDataException("WFP_PRIOR_RESULT_SIZE_INVALID");
            using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), false))
                record = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 12 }
                    .Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }
        if (record == null || !Object.Equals(record["state"], "WFP_LEASE_OWNER_FAULT_UNVERIFIED") ||
            !Object.Equals(record["error"], "WFP_FAULT_OWNER_NOT_READY") ||
            !Object.Equals(record["proofAuthorization"], false) || !Object.Equals(record["stageCleanupSafe"], false) ||
            !Object.Equals(record["identityVerified"], true) || !Object.Equals(record["ownerStarted"], true) ||
            !Object.Equals(record["ownerTerminationRequested"], false) || !Object.Equals(record["ownerExited"], false) ||
            !Object.Equals(record["bothLeasesPresentBeforeFault"], false) ||
            !Object.Equals(record["faultPhaseReleased"], false) || !Object.Equals(record["faultPhaseCompleted"], false) ||
            !Object.Equals(record["jobEmpty"], true) || !Object.Equals(record["jobAbsent"], true) ||
            !Object.Equals(record["backupRemovalVerified"], true) || !Object.Equals(record["ownerRemovalVerified"], false))
            throw new InvalidDataException("WFP_PRIOR_LEGACY_RESULT_UNSUPPORTED");

        string handoff = ReadPrivateFaultMarker(Path.Combine(previousPrivate, "owner-request.txt"));
        if (handoff == null || !Regex.IsMatch(handoff,
            @"\A[a-f0-9]{32} [1-9][0-9]{0,9} Local\\CLU-E-[a-f0-9]{32} [1-9][0-9]{0,9}\z",
            RegexOptions.CultureInvariant))
            throw new InvalidDataException("WFP_PRIOR_HANDOFF_INVALID");
        string[] parts = handoff.Split(' ');

        // If the old helper published its exact keys, also require their fresh absence.
        string readyPath = Path.Combine(previousPrivate, "owner-ready.txt");
        bool readyPresent = true;
        try { File.GetAttributes(readyPath); }
        catch (FileNotFoundException) { readyPresent = false; }
        if (readyPresent)
        {
            string ready = ReadPrivateFaultMarker(readyPath);
            string[] fields = ready == null ? new string[0] : ready.Split(' ');
            int ownerPid;
            if (fields.Length != 15 || fields[0] != parts[0] ||
                !Int32.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out ownerPid) || ownerPid < 1)
                throw new InvalidDataException("WFP_PRIOR_OWNER_RECEIPT_INVALID");
            var filters = new Guid[6];
            for (int index = 0; index < filters.Length; index++)
                filters[index] = Guid.ParseExact(fields[index + 3], "D");
            if (!WfpLoopbackLease.VerifyExactDynamicAbsent(Guid.ParseExact(fields[2], "D"), filters))
                throw new InvalidDataException("WFP_PRIOR_OWNER_KEYS_PRESENT");
        }
        return parts[2];
    }

    private static bool LegacyFaultProcessesAbsent(string previous)
    {
        var images = new[] {
            Path.Combine(previous, "bin", "CLU-E-WfpPairedDiagnostic.exe"),
            Path.Combine(previous, "bin", "wxc-exec.exe"),
            Path.Combine(previous, "fixture", "WfpPairedFixture.exe"),
        };
        foreach (string image in images)
        {
            var processes = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(image));
            try
            {
                foreach (var process in processes)
                {
                    if (process.HasExited) continue;
                    string actual = Path.GetFullPath(process.MainModule.FileName);
                    if (String.Equals(actual, image, StringComparison.OrdinalIgnoreCase)) return false;
                }
            }
            finally { foreach (var process in processes) process.Dispose(); }
        }
        return true;
    }

    // Both enumerated structures begin with a GUID and FWPM_DISPLAY_DATA0.
    [StructLayout(LayoutKind.Sequential)]
    private struct RecoveryNamedObject
    {
        internal Guid Key;
        internal IntPtr DisplayName, DisplayDescription;
    }

    private delegate uint RecoveryEnumCreate(IntPtr engine, IntPtr template, out IntPtr enumeration);
    private delegate uint RecoveryEnumPage(IntPtr engine, IntPtr enumeration, uint requested, out IntPtr entries, out uint returned);
    private delegate uint RecoveryEnumDestroy(IntPtr engine, IntPtr enumeration);

    private static bool RecoveryObjectsAbsent(IntPtr engine, RecoveryEnumCreate create, RecoveryEnumPage page,
        RecoveryEnumDestroy destroy, string expectedName)
    {
        IntPtr enumeration;
        CheckRecoveryWfp(create(engine, IntPtr.Zero, out enumeration));
        if (enumeration == IntPtr.Zero) throw new InvalidDataException("WFP_PRIOR_ENUM_HANDLE_INVALID");
        try
        {
            const uint pageSize = 64;
            for (int index = 0; index < 64; index++)
            {
                IntPtr entries;
                uint count;
                uint status = page(engine, enumeration, pageSize, out entries, out count);
                try
                {
                    CheckRecoveryWfp(status);
                    if (count > pageSize || (count != 0 && entries == IntPtr.Zero))
                        throw new InvalidDataException("WFP_PRIOR_ENUM_PAGE_INVALID");
                    for (int offset = 0; offset < count; offset++)
                    {
                        IntPtr entry = Marshal.ReadIntPtr(entries, offset * IntPtr.Size);
                        if (entry == IntPtr.Zero) throw new InvalidDataException("WFP_PRIOR_ENUM_ENTRY_INVALID");
                        var item = (RecoveryNamedObject)Marshal.PtrToStructure(entry, typeof(RecoveryNamedObject));
                        IntPtr name = item.DisplayName;
                        if (name != IntPtr.Zero && String.Equals(Marshal.PtrToStringUni(name), expectedName,
                            StringComparison.Ordinal)) return false;
                    }
                    if (count < pageSize) return true;
                }
                finally { if (entries != IntPtr.Zero) RecoveryFreeMemory(ref entries); }
            }
            throw new InvalidDataException("WFP_PRIOR_ENUM_LIMIT");
        }
        finally { CheckRecoveryWfp(destroy(engine, enumeration)); }
    }

    private static void CheckRecoveryWfp(uint status)
    {
        if (status != 0)
            throw new InvalidDataException("WFP_PRIOR_QUERY_0x" + status.ToString("X8", CultureInfo.InvariantCulture));
    }

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode, ExactSpelling = true, EntryPoint = "FwpmEngineOpen0")]
    private static extern uint RecoveryEngineOpen(string serverName, uint authnService, IntPtr authIdentity,
        IntPtr session, out IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true, EntryPoint = "FwpmEngineClose0")]
    private static extern uint RecoveryEngineClose(IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true, EntryPoint = "FwpmFreeMemory0")]
    private static extern void RecoveryFreeMemory(ref IntPtr entries);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSessionCreateEnumHandle0(IntPtr engine, IntPtr template, out IntPtr enumeration);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSessionEnum0(IntPtr engine, IntPtr enumeration, uint requested, out IntPtr entries, out uint count);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSessionDestroyEnumHandle0(IntPtr engine, IntPtr enumeration);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSubLayerCreateEnumHandle0(IntPtr engine, IntPtr template, out IntPtr enumeration);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSubLayerEnum0(IntPtr engine, IntPtr enumeration, uint requested, out IntPtr entries, out uint count);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSubLayerDestroyEnumHandle0(IntPtr engine, IntPtr enumeration);
}
