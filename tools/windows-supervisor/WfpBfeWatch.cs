using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Read-only observation of SCM status. Sampling cannot prove that BFE or WFP
// stayed healthy between samples, and the service PID is not a restart epoch.
internal sealed class WfpBfeWatch : IDisposable
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const uint ScStatusProcessInfo = 0;
    private const uint ServiceRunning = 4;
    private const string Running = "BFE_RUNNING";
    private static readonly uint StatusSize = (uint)Marshal.SizeOf(typeof(ServiceStatusProcess));

    private readonly ServiceHandle service;
    private uint initialProcessId;
    private bool disposed;

    internal WfpBfeWatch()
    {
        using (ServiceHandle manager = OpenSCManagerW(null, null, ScManagerConnect))
        {
            if (manager.IsInvalid)
            {
                State = "BFE_SCM_UNAVAILABLE";
                return;
            }

            service = OpenServiceW(manager, "BFE", ServiceQueryStatus);
        }

        if (service.IsInvalid)
        {
            State = "BFE_SERVICE_UNAVAILABLE";
            return;
        }

        State = ReadProcessId(out initialProcessId);
        InitialRunning = State == Running;
    }

    internal string State { get; private set; }
    internal int Samples { get; private set; }
    internal bool SyntheticFaultObserved { get; private set; }
    internal bool InitialRunning { get; private set; }

    internal void RequireHealthy(bool injectFault = false)
    {
        if (disposed)
            throw new ObjectDisposedException("WfpBfeWatch");

        if (State == Running)
        {
            uint processId;
            State = ReadProcessId(out processId);
            if (State == Running)
            {
                // The disposable canary substitutes only a successful sample of the
                // original PID, so a real read failure or PID change wins instead.
                bool substitute = injectFault && processId == initialProcessId;
                if (substitute)
                    processId = processId == UInt32.MaxValue ? 1u : processId + 1u;
                if (processId != initialProcessId)
                {
                    State = "BFE_PROCESS_CHANGED";
                    SyntheticFaultObserved = substitute;
                }
            }
        }

        if (State != Running)
            throw new InvalidOperationException(State);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (service != null) service.Dispose();
    }

    private string ReadProcessId(out uint processId)
    {
        Samples++;
        processId = 0;
        ServiceStatusProcess status;
        uint needed;
        if (!QueryServiceStatusEx(service, ScStatusProcessInfo, out status, StatusSize, out needed))
            return "BFE_STATUS_UNAVAILABLE";
        if (status.CurrentState != ServiceRunning)
            return "BFE_NOT_RUNNING";
        if (status.ProcessId == 0)
            return "BFE_PROCESS_ID_UNAVAILABLE";

        processId = status.ProcessId;
        return Running;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        internal uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode;
        internal uint ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags;
    }

    private sealed class ServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public ServiceHandle() : base(true) { }
        protected override bool ReleaseHandle() { return CloseServiceHandle(handle); }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern ServiceHandle OpenSCManagerW(string machineName, string databaseName, uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern ServiceHandle OpenServiceW(ServiceHandle manager, string serviceName, uint desiredAccess);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(ServiceHandle service, uint infoLevel, out ServiceStatusProcess status,
        uint bufferSize, out uint bytesNeeded);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr service);
}
