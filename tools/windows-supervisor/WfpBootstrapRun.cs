using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal sealed class WfpBootstrapRun
{
    private readonly Request request;
    private WfpLoopbackLease lease;
    private WfpDropObservation dropObservation;
    private ulong[] verifiedFilterIds;
    private bool observed;
    private bool released;
    private bool unique;
    private bool installAttempted;
    private bool installFailureCleanupVerified;
    private int filterCount;

    internal WfpBootstrapRun(Request request)
    {
        this.request = request;
    }

    internal void Observe(IntPtr job)
    {
        if (released || !File.Exists(request.args[3])) return;
        string marker;
        try
        {
            string path = Protocol.CanonicalPath(request.args[3], false);
            using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (input.Length < 1) return; // Node may still be writing the marker.
                if (input.Length > 10) throw new InvalidDataException("WFP_PID_MARKER_INVALID");
                using (var text = new StreamReader(input, Encoding.ASCII)) marker = text.ReadToEnd();
            }
        }
        catch (IOException)
        {
            return; // Retry the bounded wait if the writer has the file open.
        }
        int pid;
        if (!Int32.TryParse(marker, NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid < 1)
            throw new InvalidDataException("WFP_PID_MARKER_INVALID");

        byte[] packageSid = WfpContainerIdentity.ReadForJob(job, pid, request.command);
        observed = true;
        string fingerprint;
        using (var sha = SHA256.Create())
            fingerprint = BitConverter.ToString(sha.ComputeHash(packageSid)).Replace("-", "").ToLowerInvariant();
        string folder = Path.Combine(request.fixtureRoot, "private");
        if (request.wfpMode != "control")
            RequireDifferentSid(folder, "control", fingerprint);
        if (request.wfpMode == "deadline")
            RequireDifferentSid(folder, "filtered", fingerprint);
        unique = true;
        WriteNew(Path.Combine(folder, "wfp-" + request.wfpMode + "-sid.txt"), fingerprint);

        if (request.wfpMode != "control")
        {
            try
            {
                installAttempted = true;
                lease = WfpLoopbackLease.Install(packageSid, out installFailureCleanupVerified);
                filterCount = lease.Count;
                if (filterCount != 6) throw new InvalidOperationException("WFP_FILTER_COUNT_INVALID");
                if (request.wfpMode == "filtered")
                {
                    verifiedFilterIds = lease.FilterIds;
                    dropObservation = WfpDropObservation.Start(verifiedFilterIds);
                }
            }
            catch (InvalidOperationException error)
            {
                if (Regex.IsMatch(error.Message, @"^WFP_[A-Z0-9_]{1,70}(?:_0x[0-9A-F]{8})?$"))
                    Console.Error.WriteLine("[CLU-E WFP ERROR] " + error.Message);
                throw;
            }
        }

        // The pinned fixture has not opened sockets. It can proceed once the filter
        // transaction and readback have succeeded for its actual package SID.
        WriteNew(request.args[4], "GO");
        released = true;
    }

    internal bool Finish(bool jobEmpty)
    {
        bool filtersRemoved = !installAttempted || installFailureCleanupVerified;
        try
        {
            if (verifiedFilterIds != null)
            {
                Console.Error.WriteLine("[CLU-E WFP IDS] " +
                    lease.VerifiedSublayerWeight.ToString(CultureInfo.InvariantCulture) + " " +
                    String.Join(" ", Array.ConvertAll(verifiedFilterIds, id => id.ToString(CultureInfo.InvariantCulture))));
            }
            if (dropObservation != null)
            {
                int[] bindHits;
                string state = dropObservation.Finish(out bindHits);
                Console.Error.WriteLine("[CLU-E WFP DROPS] " + state + " " +
                    String.Join(" ", Array.ConvertAll(dropObservation.LayerHits, count => count.ToString(CultureInfo.InvariantCulture))) + " " +
                    String.Join(" ", Array.ConvertAll(bindHits, count => count.ToString(CultureInfo.InvariantCulture))));
            }
        }
        finally
        {
            if (lease != null)
            {
                try { filtersRemoved = lease.ReleaseAndVerify(); }
                catch { filtersRemoved = false; }
            }
        }
        Console.Error.WriteLine("[CLU-E WFP] " + request.wfpMode + " " + Bit(observed) + " " +
            filterCount + " " + Bit(released) + " " + Bit(jobEmpty) + " " +
            Bit(filtersRemoved) + " " + Bit(unique));
        return observed && released && jobEmpty && filtersRemoved && unique;
    }

    private static string Bit(bool value) { return value ? "1" : "0"; }

    private static void RequireDifferentSid(string folder, string mode, string sid)
    {
        string path = Protocol.CanonicalPath(Path.Combine(folder, "wfp-" + mode + "-sid.txt"), false);
        if (new FileInfo(path).Length != 64) throw new InvalidDataException("WFP_SID_PREMISE_MISSING");
        string previous = File.ReadAllText(path, Encoding.ASCII);
        if (!Regex.IsMatch(previous, @"^[a-f0-9]{64}$") || String.Equals(previous, sid, StringComparison.Ordinal))
            throw new InvalidDataException("WFP_PACKAGE_IDENTITY_REUSED");
    }

    private static void WriteNew(string path, string value)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(value);
        // Flush the complete file before publishing its name to the waiting fixture.
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                output.Write(bytes, 0, bytes.Length);
            File.Move(temporary, path);
        }
        finally { File.Delete(temporary); }
    }
}
