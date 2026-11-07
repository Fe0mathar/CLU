using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class WfpContainerIdentity
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint TokenQuery = 0x0008;
    private const int TokenIsAppContainer = 29;
    private const int TokenAppContainerSid = 31;
    private const int InsufficientBuffer = 122;
    private const uint WaitTimeout = 258;
    private const int PackageSubAuthorityCount = 8;
    private const int PackageSidBytes = 8 + 4 * PackageSubAuthorityCount;

    internal static byte[] ReadForJob(IntPtr job, int pid, string expectedImage)
    {
        if (job == IntPtr.Zero || job == new IntPtr(-1) || pid <= 0)
            throw new InvalidDataException("A valid job and process are required.");

        using (var process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)pid))
        {
            if (process.IsInvalid)
                throw LastError();

            RequireLiveJobProcess(process, job);
            var image = new StringBuilder(4096);
            uint imageLength = (uint)image.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, image, ref imageLength))
                throw LastError();
            if (!String.Equals(Protocol.CanonicalPath(image.ToString(), false), expectedImage,
                StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The bootstrap image does not match the pinned Node executable.");
            OwnedHandle token;
            if (!OpenProcessToken(process, TokenQuery, out token))
                throw LastError();
            using (token)
            {
                if (token.IsInvalid)
                    throw new InvalidDataException("The workload token is unavailable.");

                uint appContainer;
                uint length;
                if (!GetTokenFlag(token, TokenIsAppContainer, out appContainer, 4, out length))
                    throw LastError();
                if (length != 4 || appContainer != 1)
                    throw new InvalidDataException("The workload token is outside an AppContainer.");

                byte[] sid = ReadPackageSid(token);
                RequireLiveJobProcess(process, job);
                return sid;
            }
        }
    }

    internal static bool Same(byte[] a, byte[] b)
    {
        if (a == null || b == null || a.Length != b.Length)
            return false;

        int difference = 0;
        for (int i = 0; i < a.Length; ++i)
            difference |= a[i] ^ b[i];
        return difference == 0;
    }

    private static void RequireLiveJobProcess(OwnedHandle process, IntPtr job)
    {
        bool belongs;
        if (!IsProcessInJob(process, job, out belongs))
            throw LastError();
        if (!belongs || WaitForSingleObject(process, 0) != WaitTimeout)
            throw new InvalidDataException("The workload is outside the live supervisor job.");
    }

    private static byte[] ReadPackageSid(OwnedHandle token)
    {
        uint size;
        bool filled = GetTokenBuffer(token, TokenAppContainerSid, IntPtr.Zero, 0, out size);
        int error = Marshal.GetLastWin32Error();
        if (filled || error != InsufficientBuffer || size < IntPtr.Size + PackageSidBytes || size > 256)
            throw new InvalidDataException("The workload package SID buffer is invalid.");

        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            uint written;
            if (!GetTokenBuffer(token, TokenAppContainerSid, buffer, size, out written))
                throw LastError();

            // TOKEN_APPCONTAINER_INFORMATION contains a single pointer into this buffer.
            if (written > size || written < IntPtr.Size + PackageSidBytes)
                throw new InvalidDataException("The workload package SID length is invalid.");
            IntPtr nativeSid = Marshal.ReadIntPtr(buffer);
            long offset = nativeSid.ToInt64() - buffer.ToInt64();
            if (offset < IntPtr.Size || offset > written - PackageSidBytes)
                throw new InvalidDataException("The workload package SID points outside its token buffer.");

            var sid = new byte[PackageSidBytes];
            Marshal.Copy(nativeSid, sid, 0, sid.Length);
            // Only a concrete package SID is eligible. Authority 15 is APP PACKAGE, and
            // subauthority 2 identifies packages. Built-in groups have only two entries.
            if (sid[0] != 1 || sid[1] != PackageSubAuthorityCount ||
                sid[2] != 0 || sid[3] != 0 || sid[4] != 0 || sid[5] != 0 || sid[6] != 0 || sid[7] != 15 ||
                sid[8] != 2 || sid[9] != 0 || sid[10] != 0 || sid[11] != 0 ||
                !IsValidSid(nativeSid) || GetLengthSid(nativeSid) != PackageSidBytes)
                throw new InvalidDataException("The workload token has an unexpected package SID.");

            return sid;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Win32Exception LastError()
    {
        return new Win32Exception(Marshal.GetLastWin32Error());
    }

    private sealed class OwnedHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public OwnedHandle() : base(true) { }

        protected override bool ReleaseHandle()
        {
            return CloseHandle(handle);
        }
    }

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern OwnedHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);

    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(OwnedHandle process, uint flags,
        StringBuilder path, ref uint length);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(OwnedHandle process, IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint WaitForSingleObject(OwnedHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(OwnedHandle process, uint access, out OwnedHandle token);

    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenFlag(OwnedHandle token, int informationClass, out uint value,
        uint size, out uint required);

    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenBuffer(OwnedHandle token, int informationClass, IntPtr value,
        uint size, out uint required);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsValidSid(IntPtr sid);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetLengthSid(IntPtr sid);
}
