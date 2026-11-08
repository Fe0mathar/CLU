# Filtering Platform Connection includes Security event 5159 (blocked bind).
# https://learn.microsoft.com/windows/win32/fwp/auditing-and-logging
function Get-WfpBindAuditState {
    $result = [ordered]@{
        state = 'SYSTEM_POLICY_UNAVAILABLE'
        source = 'AuditQuerySystemPolicy'
        subcategoryGuid = '0CCE9226-69AE-11D9-BED3-505054503030'
        systemFailureEnabled = $null
        win32Error = $null
    }

    if (![Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
        return $result
    }

    try {
        if ($null -eq ('CluE.Wfp.BindAuditPolicy' -as [type])) {
            Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CluE.Wfp
{
    public static class BindAuditPolicy
    {
        private static readonly Guid ObjectAccessCategory = new Guid("6997984A-797A-11D9-BED3-505054503030");

        [StructLayout(LayoutKind.Sequential)]
        private struct AuditPolicyInformation
        {
            public Guid Subcategory;
            public uint Flags;
            public Guid Category;
        }

        [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool AuditQuerySystemPolicy(ref Guid subcategory, uint count, out IntPtr information);

        [DllImport("advapi32.dll", ExactSpelling = true)]
        private static extern void AuditFree(IntPtr buffer);

        public static bool Query(Guid subcategory, out uint flags, out int nativeError)
        {
            flags = 0;
            nativeError = 0;
            IntPtr buffer;
            bool success = AuditQuerySystemPolicy(ref subcategory, 1, out buffer);
            if (!success) nativeError = Marshal.GetLastWin32Error();

            try
            {
                if (!success || buffer == IntPtr.Zero) return false;
                var policy = Marshal.PtrToStructure<AuditPolicyInformation>(buffer);
                if (policy.Subcategory != subcategory || policy.Category != ObjectAccessCategory) return false;
                flags = policy.Flags;
                return true;
            }
            finally
            {
                if (buffer != IntPtr.Zero) AuditFree(buffer);
            }
        }
    }
}
'@
        }

        [uint32] $flags = 0
        [int] $nativeError = 0
        if (![CluE.Wfp.BindAuditPolicy]::Query([guid] $result.subcategoryGuid, [ref] $flags, [ref] $nativeError)) {
            if ($nativeError -gt 0) { $result.win32Error = $nativeError }
            return $result
        }

        # These are system-policy flags. Per-user policy or event delivery can differ.
        switch ($flags) {
            0 { $result.state = 'SYSTEM_POLICY_UNSPECIFIED' }
            { $_ -in 1, 4 } {
                $result.state = 'SYSTEM_FAILURE_DISABLED'
                $result.systemFailureEnabled = $false
            }
            { $_ -in 2, 3 } {
                $result.state = 'SYSTEM_FAILURE_ENABLED'
                $result.systemFailureEnabled = $true
            }
            default { $result.state = 'SYSTEM_POLICY_UNRECOGNIZED' }
        }
    } catch { }

    return $result
}
