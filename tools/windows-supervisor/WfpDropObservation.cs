using System;
using System.Runtime.InteropServices;
using System.Threading;

internal sealed class WfpDropObservation : IDisposable
{
    private const uint RpcAuthnWinnt = 10;
    private const int CollectNetEvents = 0;
    private const int UInt32Value = 3;
    private const int ClassifyDrop = 3;
    private const int BindV4Index = 4;
    private const int BindV6Index = 5;
    private const int Tcp = 6;
    private const int Udp = 17;
    private const int Ipv4 = 0;
    private const int Ipv6 = 1;
    private const int RequiredBindHeaderFlags = 0x103; // IP version, IP protocol, and local address.

    // Windows x64 SDK: FWPM_NET_EVENT5 embeds a 136-byte FWPM_NET_EVENT_HEADER3.
    // Its type follows the header and its pointer union starts at the next 8-byte boundary.
    private const int HeaderFlagsOffset = 8;
    private const int HeaderIpVersionOffset = 12;
    private const int HeaderProtocolOffset = 16;
    private const int HeaderLocalAddressOffset = 20;
    private const int EventTypeOffset = 136;
    private const int EventUnionOffset = 144;

    private readonly object sync = new object();
    private readonly ulong[] ids;
    private readonly int[] bindHits = new int[4];
    private readonly int[] layerHits = new int[6];
    private readonly NetEventCallback callback;
    private GCHandle callbackRoot;
    private IntPtr engine;
    private IntPtr subscription;
    private bool accepting;
    private bool callbackFailed;
    private string status;

    private WfpDropObservation(ulong[] ids)
    {
        this.ids = ids;
        callback = Observe;
        status = "UNAVAILABLE";
    }

    internal static WfpDropObservation Start(ulong[] filterIds)
    {
        var observer = new WfpDropObservation(filterIds == null ? null : (ulong[])filterIds.Clone());
        observer.Open();
        return observer;
    }

    private void Open()
    {
        if (IntPtr.Size != 8 || !BitConverter.IsLittleEndian)
        {
            status = "ABI_UNSUPPORTED";
            return;
        }
        if (!ValidIds(ids))
        {
            status = "FILTER_IDS_INVALID";
            return;
        }
        try
        {
            uint result = FwpmEngineOpen0(null, RpcAuthnWinnt, IntPtr.Zero, IntPtr.Zero, out engine);
            if (result != 0)
            {
                status = Code("EVENTS_OPEN", result);
                return;
            }

            IntPtr option;
            result = FwpmEngineGetOption0(engine, CollectNetEvents, out option);
            try
            {
                if (result != 0)
                {
                    status = Code("EVENTS_OPTION", result);
                    return;
                }
                if (option == IntPtr.Zero || Marshal.ReadInt32(option) != UInt32Value)
                {
                    status = "EVENTS_OPTION_INVALID";
                    return;
                }
                int enabled = Marshal.ReadInt32(option, 8); // x64 FWP_VALUE0 scalar union.
                if (enabled != 1)
                {
                    status = enabled == 0 ? "COLLECTION_DISABLED" : "EVENTS_OPTION_INVALID";
                    return;
                }
            }
            finally { if (option != IntPtr.Zero) FwpmFreeMemory0(ref option); }

            // The callback is rooted independently of the managed owner until Windows
            // confirms it has stopped invoking it, even if RPC cleanup reports a failure.
            callbackRoot = GCHandle.Alloc(callback);
            lock (sync) accepting = true;
            var request = new Subscription();
            result = FwpmNetEventSubscribe4(engine, ref request, callback, IntPtr.Zero, out subscription);
            status = result == 0 && subscription != IntPtr.Zero ? "AVAILABLE" :
                result == 0 ? "EVENTS_HANDLE_INVALID" : Code("EVENTS_SUBSCRIBE", result);
        }
        catch (Exception) { status = "EVENTS_NATIVE_UNAVAILABLE"; }
        finally { if (status != "AVAILABLE") Close(); }
    }

    private static bool ValidIds(ulong[] values)
    {
        if (values == null || values.Length != 6) return false;
        for (int index = 0; index < values.Length; index++)
        {
            if (values[index] == 0) return false;
            for (int previous = 0; previous < index; previous++)
                if (values[previous] == values[index]) return false;
        }
        return true;
    }

    private void Observe(IntPtr context, IntPtr netEvent)
    {
        // Ignore everything except a native classify-drop with one of the live,
        // readback-verified filter IDs. No address, SID, PID or application leaves the callback.
        try
        {
            if (netEvent == IntPtr.Zero || Marshal.ReadInt32(netEvent, EventTypeOffset) != ClassifyDrop) return;
            IntPtr drop = Marshal.ReadIntPtr(netEvent, EventUnionOffset);
            if (drop == IntPtr.Zero) return;
            int layer = Array.IndexOf(ids, unchecked((ulong)Marshal.ReadInt64(drop)));
            if (layer < 0) return;
            int bind = BindIndex(netEvent, layer);
            lock (sync)
            {
                if (!accepting) return;
                if (layerHits[layer] < Int32.MaxValue) layerHits[layer]++;
                if (bind >= 0 && bindHits[bind] < Int32.MaxValue) bindHits[bind]++;
            }
        }
        catch (Exception)
        {
            // Never propagate a managed exception across the BFE callback boundary.
            lock (sync) callbackFailed = true;
        }
    }

    private static int BindIndex(IntPtr netEvent, int layer)
    {
        if (layer != BindV4Index && layer != BindV6Index) return -1;
        if ((Marshal.ReadInt32(netEvent, HeaderFlagsOffset) & RequiredBindHeaderFlags) != RequiredBindHeaderFlags)
            return -1;
        int protocol = Marshal.ReadByte(netEvent, HeaderProtocolOffset);
        if (protocol != Tcp && protocol != Udp) return -1;
        int family = Marshal.ReadInt32(netEvent, HeaderIpVersionOffset);
        if (layer == BindV4Index)
        {
            // WFP represents the UINT32 IPv4 address in host order.
            if (family != Ipv4 || Marshal.ReadInt32(netEvent, HeaderLocalAddressOffset) != 0x7f000001) return -1;
            return protocol == Tcp ? 0 : 2;
        }
        if (family != Ipv6 || Marshal.ReadByte(netEvent, HeaderLocalAddressOffset + 15) != 1) return -1;
        for (int index = 0; index < 15; index++)
            if (Marshal.ReadByte(netEvent, HeaderLocalAddressOffset + index) != 0) return -1;
        return protocol == Tcp ? 1 : 3;
    }

    // Call while the exact filter IDs still exist, after the workload has exited.
    // Zero hits means no matching event was observed in this bounded collection window.
    internal string Finish(out int[] hits)
    {
        if (status == "AVAILABLE" && subscription != IntPtr.Zero)
        {
            // Give asynchronous BFE notification delivery a bounded window.
            try { Thread.Sleep(150); }
            catch (ThreadInterruptedException) { status = "EVENTS_WAIT_INTERRUPTED"; }
        }
        Close();
        lock (sync)
        {
            hits = (int[])bindHits.Clone(); // IPv4 TCP, IPv6 TCP, IPv4 UDP, IPv6 UDP.
            return callbackFailed && status == "AVAILABLE" ? "EVENTS_CALLBACK_FAILED" : status;
        }
    }

    internal int[] LayerHits { get { lock (sync) return (int[])layerHits.Clone(); } }

    public void Dispose() { Close(); }

    private void Close()
    {
        lock (sync) accepting = false;
        try
        {
            // BFE can wait for an active callback. Do not hold sync during either RPC.
            if (subscription != IntPtr.Zero)
            {
                uint result = FwpmNetEventUnsubscribe0(engine, subscription);
                if (result == 0) subscription = IntPtr.Zero;
                else status = Code("EVENTS_UNSUBSCRIBE", result);
            }
        }
        catch (Exception) { status = "EVENTS_UNSUBSCRIBE_UNAVAILABLE"; }
        try
        {
            if (engine != IntPtr.Zero)
            {
                uint result = FwpmEngineClose0(engine);
                if (result == 0)
                {
                    engine = IntPtr.Zero;
                    subscription = IntPtr.Zero;
                }
                else status = Code("EVENTS_CLOSE", result);
            }
        }
        catch (Exception) { status = "EVENTS_CLOSE_UNAVAILABLE"; }
        if (subscription == IntPtr.Zero && callbackRoot.IsAllocated) callbackRoot.Free();
    }

    private static string Code(string operation, uint result) { return operation + "_0X" + result.ToString("X8"); }

    [StructLayout(LayoutKind.Sequential)]
    private struct Subscription
    {
        internal IntPtr Template;
        internal uint Flags;
        internal Guid SessionKey;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void NetEventCallback(IntPtr context, IntPtr netEvent);

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint FwpmEngineOpen0(string server, uint authn, IntPtr identity, IntPtr session, out IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmEngineGetOption0(IntPtr engine, int option, out IntPtr value);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmNetEventSubscribe4(IntPtr engine, ref Subscription request, NetEventCallback callback,
        IntPtr context, out IntPtr subscription);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmNetEventUnsubscribe0(IntPtr engine, IntPtr subscription);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmEngineClose0(IntPtr engine);
    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern void FwpmFreeMemory0(ref IntPtr pointer);
}
