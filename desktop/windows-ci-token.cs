// CI only: start the same user's validation with administrator membership disabled.
// No password, alternate account, system policy change or PostgreSQL bypass.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class SiWindowsCiToken {
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved; public string desktop; public string title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public ushort showWindow, reservedSize; public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor, uint size, out uint needed);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    static IntPtr validationProcess;
    public static uint ExitCode() { uint code; Check(GetExitCodeProcess(validationProcess, out code), "GetExitCodeProcess"); return code; }
    public static void Close() { if (validationProcess != IntPtr.Zero) { CloseHandle(validationProcess); validationProcess = IntPtr.Zero; } }
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disabledCount, SidAndAttributes[] disabled, uint deletedCount, IntPtr deleted, uint restrictedCount, IntPtr restricted, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr value, int size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static IntPtr Sid(string text) {
        var sid = new SecurityIdentifier(text); var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
        var memory = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, memory, bytes.Length); return memory;
    }
    public static void GrantDesktopAccess() {
        // Hosted runners can grant their interactive desktop only to Administrators.
        // Grant only this existing logon user; never Everyone or another account.
        var user = WindowsIdentity.GetCurrent().User;
        foreach (var handle in new[] { GetProcessWindowStation(), GetThreadDesktop(GetCurrentThreadId()) }) {
            uint information = 4, needed;
            GetUserObjectSecurity(handle, ref information, null, 0, out needed);
            var bytes = new byte[needed];
            Check(GetUserObjectSecurity(handle, ref information, bytes, needed, out needed), "GetUserObjectSecurity");
            var descriptor = new CommonSecurityDescriptor(false, false, bytes, 0);
            descriptor.DiscretionaryAcl.AddAccess(AccessControlType.Allow, user, 0x10000000, InheritanceFlags.None, PropagationFlags.None);
            bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
            Check(SetUserObjectSecurity(handle, ref information, bytes), "SetUserObjectSecurity");
        }
    }
    public static uint Start(string executable, string arguments, string cwd) {
        IntPtr original = IntPtr.Zero, token = IntPtr.Zero, owner = IntPtr.Zero, label = IntPtr.Zero;
        var admins = Sid("S-1-5-32-544"); var powerUsers = Sid("S-1-5-32-547"); var medium = Sid("S-1-16-8192");
        var user = Sid(WindowsIdentity.GetCurrent().User.Value);
        try {
            Check(OpenProcessToken(GetCurrentProcess(), 0xF01FF, out original), "OpenProcessToken");
            var disabled = new[] { new SidAndAttributes { Sid = admins }, new SidAndAttributes { Sid = powerUsers } };
            Check(CreateRestrictedToken(original, 1, 2, disabled, 0, IntPtr.Zero, 0, IntPtr.Zero, out token), "CreateRestrictedToken");
            owner = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(owner, user);
            Check(SetTokenInformation(token, 4, owner, IntPtr.Size), "SetTokenOwner");
            var integrity = new SidAndAttributes { Sid = medium, Attributes = 0x20 };
            int labelSize = Marshal.SizeOf(typeof(SidAndAttributes)); label = Marshal.AllocHGlobal(labelSize);
            Marshal.StructureToPtr(integrity, label, false);
            Check(SetTokenInformation(token, 25, label, labelSize + 12), "SetTokenIntegrityLevel");
            var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), flags = 1, showWindow = 0 };
            ProcessInfo process;
            Check(CreateProcessAsUser(token, executable, new StringBuilder("\"" + executable + "\" " + arguments), IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, cwd, ref startup, out process), "CreateProcessAsUser");
            CloseHandle(process.thread); validationProcess = process.process; return process.pid;
        } finally {
            if (token != IntPtr.Zero) CloseHandle(token); if (original != IntPtr.Zero) CloseHandle(original);
            foreach (var memory in new[] { admins, powerUsers, medium, user, owner, label }) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
        }
    }
}
