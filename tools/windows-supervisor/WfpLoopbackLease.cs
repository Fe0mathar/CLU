using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;

// This lease is for disposable diagnostics. Its owner must observe the actual unique
// fixture package SID and keep that fixture stopped until installation is verified.
internal sealed class WfpLoopbackLease : IDisposable
{
    private const uint RpcAuthnWinnt = 10;
    private const uint DynamicSession = 1;
    private const uint ClearActionRight = 8;
    private const uint SublayerPersistent = 0x01;
    private const ushort FixtureSublayerWeight = 0xFFFE;
    // Persistent, boot-time, provider context, permit-if-unregistered, disabled.
    private const uint DisallowedFilterFlags = 0x37;
    private const uint ActionBlock = 0x00001001;
    private const int MatchEqual = 0;
    private const int SidValue = 13;
    private const uint FilterNotFound = 0x80320003;
    private const uint SublayerNotFound = 0x80320007;

    private static readonly Guid PackageId = new Guid("71bc78fa-f17c-4997-a602-6abb261f351c");
    private static readonly Guid[] Layers = {
        new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"), // ALE_AUTH_CONNECT_V4
        new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4"), // ALE_AUTH_CONNECT_V6
        new Guid("e1cd9fe7-f4b5-4273-96c0-592e487b8650"), // ALE_AUTH_RECV_ACCEPT_V4
        new Guid("a3b42c97-9f04-4672-b87e-cee9c483257f"), // ALE_AUTH_RECV_ACCEPT_V6
        new Guid("1247d66d-0b60-4a15-8d44-7155d0f53a0c"), // ALE_RESOURCE_ASSIGNMENT_V4
        new Guid("55a650e1-5f0a-4eca-a653-88f53b26aa8c"), // ALE_RESOURCE_ASSIGNMENT_V6
    };

    private IntPtr engine;
    private readonly Guid sublayerKey;
    private readonly Guid[] filterKeys;
    private readonly ulong[] filterIds;
    private readonly byte[] staticPackageSid;
    private bool removalVerified;

    private WfpLoopbackLease(IntPtr engine, Guid sublayerKey, Guid[] filterKeys, ulong[] filterIds,
        byte[] staticPackageSid)
    {
        this.engine = engine;
        this.sublayerKey = sublayerKey;
        this.filterKeys = filterKeys;
        this.filterIds = filterIds;
        this.staticPackageSid = staticPackageSid;
    }

    internal int Count { get { return filterKeys.Length; } }
    internal ulong[] FilterIds { get { return (ulong[])filterIds.Clone(); } }
    internal Guid SublayerKey { get { return sublayerKey; } }
    internal ushort VerifiedSublayerWeight { get; private set; }

    internal void VerifyInstalled(byte[] packageSid)
    {
        if (engine == IntPtr.Zero || engine == new IntPtr(-1))
            throw new InvalidOperationException("WFP_LEASE_ENGINE_NOT_OPEN");
        byte[] expectedSid = ValidatePackageSid(packageSid);
        string staticName = staticPackageSid == null ? null : StaticObjectName(sublayerKey);
        ushort weight = ReadSublayer(engine, sublayerKey, staticName, false).Value;
        for (int index = 0; index < Layers.Length; index++)
            ReadFilter(engine, filterKeys[index], filterIds[index], Layers[index], sublayerKey,
                expectedSid, staticName, false);
        VerifiedSublayerWeight = weight;
    }

    internal static WfpLoopbackLease Install(byte[] packageSid, out bool failureCleanupVerified)
    {
        return Install(packageSid, null, out failureCleanupVerified);
    }

    internal static WfpLoopbackLease InstallStatic(byte[] packageSid, Action<Guid, Guid[]> publishRecoveryKeys,
        out bool failureCleanupVerified)
    {
        if (publishRecoveryKeys == null) throw new ArgumentNullException("publishRecoveryKeys");
        return Install(packageSid, publishRecoveryKeys, out failureCleanupVerified);
    }

    private static WfpLoopbackLease Install(byte[] packageSid, Action<Guid, Guid[]> publishRecoveryKeys,
        out bool failureCleanupVerified)
    {
        failureCleanupVerified = false;
        byte[] expectedSid = ValidatePackageSid(packageSid);
        bool staticLifetime = publishRecoveryKeys != null;
        Guid sublayerKey = Guid.NewGuid();
        var filterKeys = new Guid[Layers.Length];
        for (int index = 0; index < filterKeys.Length; index++) filterKeys[index] = Guid.NewGuid();
        if (staticLifetime)
        {
            // Publish the exact recovery intent before making any WFP changes.
            publishRecoveryKeys(sublayerKey, (Guid[])filterKeys.Clone());
        }

        string staticName = staticLifetime ? StaticObjectName(sublayerKey) : null;
        var display = new DisplayData { Name = staticName ?? "CLU-E disposable package-only block" };
        IntPtr engine = OpenEngine(!staticLifetime);
        var filterIds = new ulong[Layers.Length];
        var lease = new WfpLoopbackLease(engine, sublayerKey, filterKeys, filterIds,
            staticLifetime ? expectedSid : null);
        bool transaction = false;
        IntPtr conditionPointer = IntPtr.Zero;
        GCHandle pinnedSid = new GCHandle();
        try
        {
            pinnedSid = GCHandle.Alloc(expectedSid, GCHandleType.Pinned);
            var condition = new FilterCondition {
                Key = PackageId, Match = MatchEqual,
                Value = new Value { Type = SidValue, Data = pinnedSid.AddrOfPinnedObject() },
            };
            conditionPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FilterCondition)));
            Marshal.StructureToPtr(condition, conditionPointer, false);

            Check(FwpmTransactionBegin0(engine, 0), "WFP_TRANSACTION_BEGIN");
            transaction = true;
            var sublayer = new Sublayer {
                Key = sublayerKey, Weight = FixtureSublayerWeight,
                Display = display,
            };
            Check(FwpmSubLayerAdd0(engine, ref sublayer, IntPtr.Zero), "WFP_SUBLAYER_ADD");
            for (int index = 0; index < Layers.Length; index++)
            {
                var filter = new Filter {
                    Key = filterKeys[index], Flags = ClearActionRight,
                    Display = display,
                    LayerKey = Layers[index], SublayerKey = sublayerKey,
                    ConditionCount = 1, Conditions = conditionPointer,
                    Action = new FilterAction { Type = ActionBlock },
                };
                Check(FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out filterIds[index]), "WFP_FILTER_ADD");
            }
            Check(FwpmTransactionCommit0(engine), "WFP_TRANSACTION_COMMIT");
            transaction = false;

            lease.VerifyInstalled(expectedSid);
            return lease;
        }
        catch
        {
            if (transaction) FwpmTransactionAbort0(engine);
            try
            {
                // If a static commit may have happened, retain any installed policy until
                // the caller proves the job is empty and explicitly reconciles the journal.
                failureCleanupVerified = staticLifetime
                    ? lease.CloseEngine() && VerifyAbsent(sublayerKey, filterKeys)
                    : lease.ReleaseAndVerify();
            }
            catch { failureCleanupVerified = false; }
            throw;
        }
        finally
        {
            if (conditionPointer != IntPtr.Zero) Marshal.FreeHGlobal(conditionPointer);
            if (pinnedSid.IsAllocated) pinnedSid.Free();
        }
    }

    private static byte[] ValidatePackageSid(byte[] packageSid)
    {
        if (packageSid == null || packageSid.Length != 40)
            throw new ArgumentException("The diagnostic requires one unique AppContainer package SID.");
        byte[] copy = (byte[])packageSid.Clone();
        var sid = new SecurityIdentifier(copy, 0);
        if (sid.BinaryLength != copy.Length || !sid.Value.StartsWith("S-1-15-2-", StringComparison.Ordinal))
            throw new ArgumentException("The diagnostic requires one unique AppContainer package SID.");
        return copy;
    }

    private static string StaticObjectName(Guid sublayerKey)
    {
        return "CLU-E disposable static loopback " + sublayerKey.ToString("D");
    }

    private static IntPtr OpenEngine(bool dynamicLifetime)
    {
        var session = new Session {
            Key = Guid.NewGuid(), Flags = dynamicLifetime ? DynamicSession : 0u, TransactionTimeout = 5000,
            Display = new DisplayData { Name = "CLU-E disposable network diagnostic" },
        };
        IntPtr engine;
        Check(FwpmEngineOpen0(null, RpcAuthnWinnt, IntPtr.Zero, ref session, out engine), "WFP_OPEN");
        return engine;
    }

    private static ushort? ReadSublayer(IntPtr engine, Guid key, string staticName, bool allowMissing)
    {
        IntPtr result;
        uint status = FwpmSubLayerGetByKey0(engine, ref key, out result);
        try
        {
            if (allowMissing && status == SublayerNotFound) return null;
            Check(status, "WFP_SUBLAYER_GET");
            if (result == IntPtr.Zero) throw new InvalidOperationException("WFP_SUBLAYER_READBACK_MISSING");
            var layer = (Sublayer)Marshal.PtrToStructure(result, typeof(Sublayer));
            if (layer.Key != key)
                throw new InvalidOperationException("WFP_SUBLAYER_KEY_MISMATCH");
            if ((layer.Flags & SublayerPersistent) != 0)
                throw new InvalidOperationException("WFP_SUBLAYER_PERSISTENT_0x" + layer.Flags.ToString("X8"));
            if (layer.Weight != FixtureSublayerWeight)
                throw new InvalidOperationException("WFP_SUBLAYER_WEIGHT_0x" + layer.Weight.ToString("X8"));
            if (!ProviderUnassigned(layer.ProviderKey))
                throw new InvalidOperationException("WFP_SUBLAYER_PROVIDER_ASSIGNED");
            VerifyStaticMarker(layer.Display, layer.ProviderData, staticName);
            return layer.Weight;
        }
        finally { if (result != IntPtr.Zero) FwpmFreeMemory0(ref result); }
    }

    private static ulong? ReadFilter(IntPtr engine, Guid key, ulong? expectedId, Guid layer, Guid sublayer,
        byte[] sid, string staticName, bool allowMissing)
    {
        IntPtr result;
        uint status = FwpmFilterGetByKey0(engine, ref key, out result);
        try
        {
            if (allowMissing && status == FilterNotFound) return null;
            Check(status, "WFP_FILTER_GET");
            if (result == IntPtr.Zero) throw new InvalidOperationException("WFP_FILTER_READBACK_MISSING");
            var filter = (Filter)Marshal.PtrToStructure(result, typeof(Filter));
            if (filter.Key != key || filter.Id == 0 || (expectedId.HasValue && filter.Id != expectedId.Value) ||
                filter.LayerKey != layer || filter.SublayerKey != sublayer)
                throw new InvalidOperationException("WFP_FILTER_IDENTITY_MISMATCH");
            if ((filter.Flags & (ClearActionRight | DisallowedFilterFlags)) != ClearActionRight)
                throw new InvalidOperationException("WFP_FILTER_FLAGS_0x" + filter.Flags.ToString("X8"));
            if (filter.Action.Type != ActionBlock)
                throw new InvalidOperationException("WFP_FILTER_ACTION_0x" + filter.Action.Type.ToString("X8"));
            if (!ProviderUnassigned(filter.ProviderKey))
                throw new InvalidOperationException("WFP_FILTER_PROVIDER_ASSIGNED");
            VerifyStaticMarker(filter.Display, filter.ProviderData, staticName);
            if (filter.ConditionCount != 1 || filter.Conditions == IntPtr.Zero)
                throw new InvalidOperationException("WFP_FILTER_CONDITION_SHAPE");
            var condition = (FilterCondition)Marshal.PtrToStructure(filter.Conditions, typeof(FilterCondition));
            IntPtr observedSid = condition.Value.Data;
            if (condition.Key != PackageId || condition.Match != MatchEqual || condition.Value.Type != SidValue ||
                observedSid == IntPtr.Zero || !IsValidSid(observedSid) || GetLengthSid(observedSid) != sid.Length)
                throw new InvalidOperationException("WFP_PACKAGE_SCOPE_READBACK_MISMATCH");
            var bytes = new byte[sid.Length];
            Marshal.Copy(observedSid, bytes, 0, bytes.Length);
            for (int index = 0; index < sid.Length; index++)
                if (bytes[index] != sid[index]) throw new InvalidOperationException("WFP_PACKAGE_SCOPE_READBACK_MISMATCH");
            return filter.Id;
        }
        finally { if (result != IntPtr.Zero) FwpmFreeMemory0(ref result); }
    }

    private static void VerifyStaticMarker(DisplayData display, Blob data, string staticName)
    {
        if (staticName != null && (!String.Equals(display.Name, staticName, StringComparison.Ordinal) || data.Size != 0))
            throw new InvalidOperationException("WFP_STATIC_OWNER_MISMATCH");
    }

    private static bool ProviderUnassigned(IntPtr provider)
    {
        return provider == IntPtr.Zero || (Guid)Marshal.PtrToStructure(provider, typeof(Guid)) == Guid.Empty;
    }

    // Call after terminating and observing the exact fixture tree. The independent
    // session cannot mistake an invalid old handle for successful policy removal.
    internal bool ReleaseAndVerify()
    {
        if (removalVerified) return true;
        if (!CloseEngine()) return false;
        removalVerified = staticPackageSid == null
            ? VerifyAbsent(sublayerKey, filterKeys)
            : RecoverStatic(staticPackageSid, sublayerKey, filterKeys);
        return removalVerified;
    }

    private bool CloseEngine()
    {
        if (engine != IntPtr.Zero)
        {
            if (FwpmEngineClose0(engine) != 0) return false;
            engine = IntPtr.Zero;
        }
        return true;
    }

    // Only call after independent evidence shows the entire recorded job has exited.
    // The GUIDs and SID must come from the trusted run journal, never from the workload.
    internal static bool RecoverStatic(byte[] packageSid, Guid sublayerKey, Guid[] filterKeys)
    {
        byte[] sid = ValidatePackageSid(packageSid);
        if (sublayerKey == Guid.Empty || filterKeys == null || filterKeys.Length != Layers.Length)
            throw new ArgumentException("WFP_STATIC_RECOVERY_KEYS_INVALID");
        var keys = (Guid[])filterKeys.Clone();
        var unique = new HashSet<Guid> { sublayerKey };
        foreach (Guid key in keys)
            if (key == Guid.Empty || !unique.Add(key))
                throw new ArgumentException("WFP_STATIC_RECOVERY_KEYS_INVALID");

        string staticName = StaticObjectName(sublayerKey);
        IntPtr recovery = OpenEngine(false);
        bool transaction = false;
        bool closed;
        try
        {
            // Verify scope and delete within one write transaction so a concurrent WFP
            // change cannot substitute an object between readback and deletion.
            Check(FwpmTransactionBegin0(recovery, 0), "WFP_STATIC_RECOVERY_BEGIN");
            transaction = true;
            bool layerPresent = ReadSublayer(recovery, sublayerKey, staticName, true).HasValue;
            int filterCount = 0;
            for (int index = 0; index < Layers.Length; index++)
                if (ReadFilter(recovery, keys[index], null, Layers[index], sublayerKey, sid, staticName, true).HasValue)
                    filterCount++;

            if (layerPresent && filterCount == keys.Length)
            {
                foreach (Guid filterKey in keys)
                {
                    Guid key = filterKey;
                    Check(FwpmFilterDeleteByKey0(recovery, ref key), "WFP_STATIC_FILTER_DELETE");
                }
                Guid layerKey = sublayerKey;
                Check(FwpmSubLayerDeleteByKey0(recovery, ref layerKey), "WFP_STATIC_SUBLAYER_DELETE");
            }
            else if (layerPresent || filterCount != 0)
            {
                throw new InvalidOperationException("WFP_STATIC_RECOVERY_PARTIAL_SET");
            }

            Check(FwpmTransactionCommit0(recovery), "WFP_STATIC_RECOVERY_COMMIT");
            transaction = false;
        }
        finally
        {
            if (transaction) FwpmTransactionAbort0(recovery);
            closed = FwpmEngineClose0(recovery) == 0;
        }
        return closed && VerifyAbsent(sublayerKey, keys);
    }

    private static bool VerifyAbsent(Guid sublayerKey, Guid[] filterKeys)
    {
        IntPtr observer;
        if (FwpmEngineOpenWithoutSession(null, RpcAuthnWinnt, IntPtr.Zero, IntPtr.Zero, out observer) != 0) return false;
        bool absent = true;
        try
        {
            foreach (Guid filterKey in filterKeys)
            {
                if (filterKey == Guid.Empty) continue;
                Guid key = filterKey;
                IntPtr result;
                uint status = FwpmFilterGetByKey0(observer, ref key, out result);
                if (result != IntPtr.Zero) FwpmFreeMemory0(ref result);
                if (status != FilterNotFound) absent = false;
            }
            Guid layerKey = sublayerKey;
            IntPtr layer;
            uint layerStatus = FwpmSubLayerGetByKey0(observer, ref layerKey, out layer);
            if (layer != IntPtr.Zero) FwpmFreeMemory0(ref layer);
            if (layerStatus != SublayerNotFound) absent = false;
        }
        finally { if (FwpmEngineClose0(observer) != 0) absent = false; }
        return absent;
    }

    public void Dispose()
    {
        if (staticPackageSid == null) ReleaseAndVerify();
        else CloseEngine();
    }

    private static void Check(uint status, string operation)
    {
        if (status != 0) throw new InvalidOperationException(operation + "_0x" + status.ToString("X8"));
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayData
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string Name;
        [MarshalAs(UnmanagedType.LPWStr)] internal string Description;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Session
    {
        internal Guid Key;
        internal DisplayData Display;
        internal uint Flags, TransactionTimeout, ProcessId;
        internal IntPtr Sid, Username;
        internal int KernelMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Blob
    {
        internal uint Size;
        internal IntPtr Bytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Sublayer
    {
        internal Guid Key;
        internal DisplayData Display;
        internal uint Flags;
        internal IntPtr ProviderKey;
        internal Blob ProviderData;
        internal ushort Weight;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Value
    {
        internal int Type;
        internal IntPtr Data;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FilterCondition
    {
        internal Guid Key;
        internal int Match;
        internal Value Value;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FilterAction
    {
        internal uint Type;
        internal Guid Key;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct FilterContext
    {
        [FieldOffset(0)] internal ulong Raw;
        [FieldOffset(0)] internal Guid Key;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Filter
    {
        internal Guid Key;
        internal DisplayData Display;
        internal uint Flags;
        internal IntPtr ProviderKey;
        internal Blob ProviderData;
        internal Guid LayerKey, SublayerKey;
        internal Value Weight;
        internal uint ConditionCount;
        internal IntPtr Conditions;
        internal FilterAction Action;
        internal FilterContext Context;
        internal IntPtr Reserved;
        internal ulong Id;
        internal Value EffectiveWeight;
    }

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint FwpmEngineOpen0(string server, uint authn, IntPtr identity, ref Session session, out IntPtr engine);
    [DllImport("fwpuclnt.dll", EntryPoint = "FwpmEngineOpen0", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint FwpmEngineOpenWithoutSession(string server, uint authn, IntPtr identity, IntPtr session, out IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmEngineClose0(IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmTransactionCommit0(IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmTransactionAbort0(IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSubLayerAdd0(IntPtr engine, ref Sublayer sublayer, IntPtr descriptor);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSubLayerGetByKey0(IntPtr engine, ref Guid key, out IntPtr sublayer);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine, ref Guid key);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmFilterAdd0(IntPtr engine, ref Filter filter, IntPtr descriptor, out ulong id);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmFilterGetByKey0(IntPtr engine, ref Guid key, out IntPtr filter);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern void FwpmFreeMemory0(ref IntPtr pointer);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsValidSid(IntPtr sid);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetLengthSid(IntPtr sid);
}
