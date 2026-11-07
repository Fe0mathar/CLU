using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class NativeJob
{
    private const uint WaitObject = 0;
    private const uint WaitTimeout = 258;
    private const uint KillOnClose = 0x2000;
    private const uint ExtendedStartupInfo = 0x00080000;
    private const uint UnicodeEnvironment = 0x00000400;
    private const uint NoWindow = 0x08000000;
    private const uint UseStdHandles = 0x00000100;
    private const int HandleList = 0x00020002;
    private const int JobList = 0x0002000D;

    internal static int Run(string engine, string log, string config, string systemRoot, int timeout,
        out bool deadlineExpired, Action<IntPtr> observe = null, Action onJobEmpty = null)
    {
        deadlineExpired = false;
        var clock = Stopwatch.StartNew();
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Error();
        IntPtr attributes = IntPtr.Zero;
        IntPtr jobs = IntPtr.Zero;
        IntPtr handles = IntPtr.Zero;
        var stdio = new IntPtr[3];
        var process = new ProcessInfo();
        bool initialized = false;

        try
        {
            var limits = new ExtendedLimit();
            limits.Basic.LimitFlags = KillOnClose;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));

            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            if (bytes == IntPtr.Zero) throw Error();
            attributes = Marshal.AllocHGlobal(bytes);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes));
            initialized = true;

            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(JobList), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));

            IntPtr self = GetCurrentProcess();
            for (int i = 0; i < stdio.Length; i++)
            {
                IntPtr source = GetStdHandle(-10 - i);
                if (source == IntPtr.Zero || source == new IntPtr(-1)) throw Error();
                Check(DuplicateHandle(self, source, self, out stdio[i], 0, true, 2));
            }
            handles = Marshal.AllocHGlobal(IntPtr.Size * stdio.Length);
            Marshal.Copy(stdio, 0, handles, stdio.Length);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(HandleList), handles,
                new IntPtr(IntPtr.Size * stdio.Length), IntPtr.Zero, IntPtr.Zero));

            var startup = new StartupEx();
            startup.Info.Size = (uint)Marshal.SizeOf(typeof(StartupEx));
            startup.Info.Flags = UseStdHandles;
            startup.Info.Input = stdio[0];
            startup.Info.Output = stdio[1];
            startup.Info.Error = stdio[2];
            startup.Attributes = attributes;

            string system32 = Path.Combine(systemRoot, "System32");
            byte[] env = Encoding.Unicode.GetBytes(
                "PATH=" + system32 + "\0SystemRoot=" + systemRoot + "\0WINDIR=" + systemRoot + "\0\0");
            var command = new StringBuilder(Protocol.Quote(engine) + " --log-file " +
                Protocol.Quote(log) + " " + Protocol.Quote(config));
            int remaining = timeout - (int)Math.Min(clock.ElapsedMilliseconds, Int32.MaxValue);
            if (remaining <= 0)
            {
                deadlineExpired = true;
                return 124;
            }
            GCHandle pinned = GCHandle.Alloc(env, GCHandleType.Pinned);
            try
            {
                Check(CreateProcessW(engine, command, IntPtr.Zero, IntPtr.Zero, true,
                    ExtendedStartupInfo | UnicodeEnvironment | NoWindow, pinned.AddrOfPinnedObject(),
                    Path.GetDirectoryName(engine), ref startup, out process));
            }
            finally
            {
                pinned.Free();
            }

            uint wait;
            try
            {
                do
                {
                    remaining = Math.Max(0, timeout - (int)Math.Min(clock.ElapsedMilliseconds, Int32.MaxValue));
                    uint budget = (uint)(observe == null ? remaining : Math.Min(remaining, 30));
                    wait = WaitForSingleObject(process.Process, budget);
                    if (wait != WaitObject && wait != WaitTimeout) throw Error();
                    if (wait == WaitObject || clock.ElapsedMilliseconds >= timeout) break;
                    if (observe != null) observe(job);
                } while (observe != null);
            }
            catch
            {
                Check(TerminateJobObject(job, 125));
                WaitForEmptyJob(job);
                if (onJobEmpty != null) onJobEmpty();
                throw;
            }

            uint exit = 124;
            if (wait == WaitObject) Check(GetExitCodeProcess(process.Process, out exit));
            Check(TerminateJobObject(job, wait == WaitTimeout ? 124U : 125U));
            WaitForEmptyJob(job);
            if (onJobEmpty != null) onJobEmpty();
            deadlineExpired = wait == WaitTimeout;
            return unchecked((int)exit);
        }
        finally
        {
            // The job handle is private to this process. Windows closes it on abrupt cancellation.
            Close(job);
            Close(process.Thread);
            Close(process.Process);
            foreach (IntPtr handle in stdio) Close(handle);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
        }
    }

    private static void WaitForEmptyJob(IntPtr job)
    {
        var clock = Stopwatch.StartNew();
        do
        {
            BasicAccounting value;
            Check(QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero));
            if (value.ActiveProcesses == 0) return;
            Thread.Sleep(20);
        } while (clock.ElapsedMilliseconds < 1000);
        throw new InvalidOperationException("Job cleanup was not observed.");
    }

    private static void Close(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }

    private static Win32Exception Error() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    private static void Check(bool condition) { if (!condition) throw Error(); }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        internal long PerProcessTime, PerJobTime;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        internal BasicLimit Basic;
        internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccounting
    {
        internal long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
        internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal uint Size;
        internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XChars, YChars, FillAttribute, Flags;
        internal ushort ShowWindow, ReservedBytes;
        internal IntPtr ReservedBlock, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupEx
    {
        internal StartupInfo Info;
        internal IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        internal IntPtr Process, Thread;
        internal uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int type, out BasicAccounting value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exit);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr from, IntPtr source, IntPtr to, out IntPtr result,
        uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment,
        string currentDirectory, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
