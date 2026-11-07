using System;
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
    private bool removalVerified;

    private WfpLoopbackLease(IntPtr engine, Guid sublayerKey, Guid[] filterKeys)
    {
        this.engine = engine;
        this.sublayerKey = sublayerKey;
        this.filterKeys = filterKeys;
    }

    internal int Count { get { return filterKeys.Length; } }

    internal static WfpLoopbackLease Install(byte[] packageSid, out bool failureCleanupVerified)
    {
        failureCleanupVerified = false;
        if (packageSid == null || packageSid.Length != 40)
            throw new ArgumentException("The diagnostic requires one unique AppContainer package SID.");
        byte[] expectedSid = (byte[])packageSid.Clone();
        var sid = new SecurityIdentifier(expectedSid, 0);
        if (sid.BinaryLength != expectedSid.Length || !sid.Value.StartsWith("S-1-15-2-", StringComparison.Ordinal))
            throw new ArgumentException("The diagnostic requires one unique AppContainer package SID.");

        var session = new Session {
            Key = Guid.NewGuid(), Flags = DynamicSession, TransactionTimeout = 5000,
            Display = new DisplayData { Name = "CLU-E disposable network diagnostic" },
        };
        IntPtr engine;
        Check(FwpmEngineOpen0(null, RpcAuthnWinnt, IntPtr.Zero, ref session, out engine), "WFP_OPEN");
        Guid sublayerKey = Guid.NewGuid();
        var filterKeys = new Guid[Layers.Length];
        var filterIds = new ulong[Layers.Length];
        var lease = new WfpLoopbackLease(engine, sublayerKey, filterKeys);
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
                Key = sublayerKey, Weight = UInt16.MaxValue,
                Display = new DisplayData { Name = "CLU-E disposable package-only block" },
            };
            Check(FwpmSubLayerAdd0(engine, ref sublayer, IntPtr.Zero), "WFP_SUBLAYER_ADD");
            for (int index = 0; index < Layers.Length; index++)
            {
                filterKeys[index] = Guid.NewGuid();
                var filter = new Filter {
                    Key = filterKeys[index], Flags = ClearActionRight,
                    Display = new DisplayData { Name = "CLU-E disposable package-only block" },
                    LayerKey = Layers[index], SublayerKey = sublayerKey,
                    ConditionCount = 1, Conditions = conditionPointer,
                    Action = new FilterAction { Type = ActionBlock },
                };
                Check(FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out filterIds[index]), "WFP_FILTER_ADD");
            }
            Check(FwpmTransactionCommit0(engine), "WFP_TRANSACTION_COMMIT");
            transaction = false;

            VerifySublayer(engine, sublayerKey);
            for (int index = 0; index < Layers.Length; index++)
                VerifyFilter(engine, filterKeys[index], filterIds[index], Layers[index], sublayerKey, expectedSid);
            return lease;
        }
        catch
        {
            if (transaction) FwpmTransactionAbort0(engine);
            try { failureCleanupVerified = lease.ReleaseAndVerify(); }
            catch { failureCleanupVerified = false; }
            throw;
        }
        finally
        {
            if (conditionPointer != IntPtr.Zero) Marshal.FreeHGlobal(conditionPointer);
            if (pinnedSid.IsAllocated) pinnedSid.Free();
        }
    }

    private static void VerifySublayer(IntPtr engine, Guid key)
    {
        IntPtr result;
        Check(FwpmSubLayerGetByKey0(engine, ref key, out result), "WFP_SUBLAYER_GET");
        try
        {
            if (result == IntPtr.Zero) throw new InvalidOperationException("WFP_SUBLAYER_READBACK_MISSING");
            var layer = (Sublayer)Marshal.PtrToStructure(result, typeof(Sublayer));
            if (layer.Key != key)
                throw new InvalidOperationException("WFP_SUBLAYER_KEY_MISMATCH");
            // Dynamic lifetime is established by the engine session. The documented
            // persistence bit is the sublayer flag that changes that lifetime check.
            if ((layer.Flags & SublayerPersistent) != 0)
                throw new InvalidOperationException("WFP_SUBLAYER_PERSISTENT_0x" + layer.Flags.ToString("X8"));
            if (layer.Weight != UInt16.MaxValue)
                throw new InvalidOperationException("WFP_SUBLAYER_WEIGHT_0x" + layer.Weight.ToString("X8"));
            if (!ProviderUnassigned(layer.ProviderKey))
                throw new InvalidOperationException("WFP_SUBLAYER_PROVIDER_ASSIGNED");
        }
        finally { FwpmFreeMemory0(ref result); }
    }

    private static void VerifyFilter(IntPtr engine, Guid key, ulong id, Guid layer, Guid sublayer, byte[] sid)
    {
        IntPtr result;
        Check(FwpmFilterGetByKey0(engine, ref key, out result), "WFP_FILTER_GET");
        try
        {
            if (result == IntPtr.Zero) throw new InvalidOperationException("WFP_FILTER_READBACK_MISSING");
            var filter = (Filter)Marshal.PtrToStructure(result, typeof(Filter));
            if (filter.Key != key || id == 0 || filter.Id != id || filter.LayerKey != layer || filter.SublayerKey != sublayer)
                throw new InvalidOperationException("WFP_FILTER_IDENTITY_MISMATCH");
            if ((filter.Flags & (ClearActionRight | DisallowedFilterFlags)) != ClearActionRight)
                throw new InvalidOperationException("WFP_FILTER_FLAGS_0x" + filter.Flags.ToString("X8"));
            if (filter.Action.Type != ActionBlock)
                throw new InvalidOperationException("WFP_FILTER_ACTION_0x" + filter.Action.Type.ToString("X8"));
            if (!ProviderUnassigned(filter.ProviderKey))
                throw new InvalidOperationException("WFP_FILTER_PROVIDER_ASSIGNED");
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
        }
        finally { FwpmFreeMemory0(ref result); }
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
        if (engine != IntPtr.Zero)
        {
            if (FwpmEngineClose0(engine) != 0) return false;
            engine = IntPtr.Zero;
        }
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
        removalVerified = absent;
        return removalVerified;
    }

    public void Dispose() { ReleaseAndVerify(); }

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
    private static extern uint FwpmFilterAdd0(IntPtr engine, ref Filter filter, IntPtr descriptor, out ulong id);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmFilterGetByKey0(IntPtr engine, ref Guid key, out IntPtr filter);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern void FwpmFreeMemory0(ref IntPtr pointer);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsValidSid(IntPtr sid);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetLengthSid(IntPtr sid);
}
