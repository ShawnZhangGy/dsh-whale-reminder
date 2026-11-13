// Toast activation handler for dsh-whale-reminder.
//
// Windows starts this executable when someone clicks a notification, passing the
// toast `launch` URI as argv[1]. The port the running Harness listens on is
// argv[2], baked into the registry command when the plugin registered the
// protocol.
//
// Why an executable instead of a script: a `.vbs`/PowerShell handler is started
// with a restricted token on some systems and cannot write to %LOCALAPPDATA%,
// which silently broke the original file-based hand-off. Reporting the click
// over loopback needs no filesystem access at all, so it works regardless of how
// Windows launches the handler.
//
// Why the window is raised HERE and not by the application: Windows only lets a
// process call SetForegroundWindow when that process already owns the
// foreground. The Harness Host is a background child of the Electron main
// process, so its `window.focus()` is refused by the shell (measured:
// SetForegroundWindow returns false, GetLastError 1400). This executable, by
// contrast, was started by the click itself, so it holds the foreground right
// and can hand it to the Harness window.
//
// Build (Windows, no SDK required; keep to C# 5 — the .NET Framework compiler):
//   cd dsh-whale-reminder\\assets
//   C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe ^
//     -nologo -optimize+ -target:winexe -out:activate.exe activate.cs
//
// Keep this file and activate.exe in sync: the executable is what ships.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    // Window state / placement.
    private const int SW_SHOW = 5;
    private const int SW_MINIMIZE = 6;
    private const int SW_RESTORE = 9;
    private const int HWND_TOP = 0;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;

    // Taskbar flash, used only when the raise is refused.
    private const uint FLASHW_ALL = 0x00000003;
    private const uint FLASHW_TIMERNOFG = 0x0000000C;

    private const string MAIN_WINDOW_CLASS = "Chrome_WidgetWin_1";
    private const string HARNESS_EXE = "DeepSeek Harness";

    // ShowWindowAsync only posts a request to the window's owning thread, and
    // this process exits in about a millisecond — so the request is dropped with
    // it. Measured from the shell-launched handler: ShowWindowAsync never
    // restored the window (even with a 12 s retry loop), while SetWindowPlacement
    // restored it synchronously in the same call and kept the maximised state.
    // SETTLE_MS bounds the foreground handover, which really is asynchronous.
    private const int SETTLE_MS = 900;
    private const int RESTORE_MS = 400;
    private const int RESTORE_ATTEMPTS = 6;
    // SWITCH_MS is how long SwitchToThisWindow is given to hand the foreground
    // over. It is a single call, not a retry loop: repeating a raise is what made
    // the window visibly bounce several times on one click.
    private const int SWITCH_MS = 500;
    private const int POLL_MS = 50;

    private const int WM_SYSCOMMAND = 0x0112;
    private const int SC_RESTORE = 0xF120;
    private const int SC_MAXIMIZE = 0xF030;

    private const int SW_SHOWMINIMIZED = 2;
    private const int SW_SHOWMAXIMIZED = 3;
    private const int WPF_RESTORETOMAXIMIZED = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT minPosition;
        public POINT maxPosition;
        public RECT normalPosition;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    // SwitchToThisWindow performs the same handover the taskbar does when a
    // window is clicked. Measured 3/3 on a covered window, where
    // SetForegroundWindow managed 1/3, and it needs no visible state change.
    [DllImport("user32.dll", SetLastError = true)]
    private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    // Synthetic input. Windows trusts injected keystrokes in a way it does not
    // trust SetForegroundWindow, which is the only measured way to release the
    // foreground lock a notification banner holds.
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    private const byte VK_MENU = 0x12;
    private const byte VK_TAB = 0x09;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FLASHWINFO info);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private static int Main(string[] args)
    {
        try
        {
            string uri = args.Length > 0 ? args[0] : string.Empty;
            string port = args.Length > 1 ? args[1] : string.Empty;
            string id = ParseSessionId(uri);

            // The id is the whole point of the click. Without it there is nothing
            // to navigate to, so leave quietly rather than opening the app at a
            // random place.
            if (id == null || id.Length == 0) return 1;

            // Report first so the reply can carry the stored policy (raise with
            // or without stealing the keyboard). Measured: an HTTP round trip of
            // 40-60 ms does not cost the click's foreground permission — the
            // switch below still lands 3/3 with the report in front of it.
            bool stealFocus = true;
            string reply = Report(port, id);
            if (reply == null)
            {
                // The baked-in port can be stale after the application restarted
                // on a new one; the plugin keeps the live port in a small file.
                string current = ReadPortFile();
                if (current != null && current != port) reply = Report(current, id);
            }
            if (reply != null && reply.IndexOf("\"stealFocus\":false", StringComparison.Ordinal) >= 0)
            {
                stealFocus = false;
            }

            IntPtr window = FindHarnessWindow();
            if (window != IntPtr.Zero)
            {
                if (stealFocus) RaiseWithFocus(window);
                else RaiseWithoutFocus(window);
            }
            else
            {
                // Either the application is closed or its window is not the shape
                // we know. The protocol handler in the shell knows how to start
                // it and how to raise an existing window.
                try
                {
                    Process.Start(new ProcessStartInfo("dsh://open") { UseShellExecute = true });
                }
                catch { }
            }

            return 0;
        }
        catch
        {
            return 1;
        }
    }

    // POST the click to the Host and return the response body, or null when the
    // Host is unreachable on that port.
    private static string Report(string port, string id)
    {
        if (string.IsNullOrEmpty(port)) return null;
        try
        {
            string url = "http://127.0.0.1:" + port +
                "/__whale-reminder/activate?session=" + Uri.EscapeDataString(id);
            using (var client = new WebClient())
            {
                client.Headers[HttpRequestHeader.ContentType] = "application/json";
                client.Encoding = Encoding.UTF8;
                return client.UploadString(url, "POST", "{}");
            }
        }
        catch
        {
            return null;
        }
    }

    // The plugin rewrites this file on every start, so a handler whose baked-in
    // port is stale can still find the live one. Reading is enough: the
    // restricted token Windows hands a toast handler blocks writes, not reads.
    private static string ReadPortFile()
    {
        try
        {
            string directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-whale-reminder");
            string path = Path.Combine(directory, "port.txt");
            if (!File.Exists(path)) return null;
            string text = File.ReadAllText(path).Trim();
            int value;
            if (!int.TryParse(text, out value)) return null;
            if (value < 1 || value > 65535) return null;
            return value.ToString();
        }
        catch
        {
            return null;
        }
    }

    // Restore if needed, then claim the foreground. Windows may still refuse; in
    // that case flash the taskbar so the click is not silently lost.
    //
    // A plain SetForegroundWindow from a background process only lands about a
    // third of the time when the window is visible but covered (measured 2/7).
    // Minimising and restoring first makes it reliable (measured 8/8): the
    // restore is what grants the caller the right to change the foreground.
    // SW_RESTORE on an already-visible window would un-maximise it, so the
    // window is only cycled through SW_MINIMIZE when it is not iconic; when it
    // is iconic a plain restore already counts as that transition.
    //
    // Both calls are asynchronous: the window procedure runs on the owning
    // thread, and this process exits in about a millisecond. Without waiting for
    // the state to actually settle, the restore request is dropped when the
    // process goes away — measured as "handler logs success, window stays
    // minimised". So every transition is followed by a bounded poll.
    // Raise the window and take the keyboard.
    //
    // The click that started this process is what makes a foreground change
    // permissible, so the work happens here rather than in the Host, which is a
    // background process and is always refused.
    private static void RaiseWithFocus(IntPtr window)
    {
        try { AllowSetForegroundWindow(-1); } catch { }

        var placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        bool known = GetWindowPlacement(window, ref placement);

        // A minimised window comes back through the same transition its taskbar
        // button performs, and that transition hands the foreground over by
        // itself, so nothing else is attempted here.
        if (IsIconic(window))
        {
            ShowPlacement(window, ref placement, known);
            WaitUntil(window, false, SETTLE_MS);
            if (GetForegroundWindow() == window) return;
        }

        // Covered but visible: one switch, which performs the same handover the
        // taskbar does. Measured 3/3 here, where SetForegroundWindow managed 1/3.
        SwitchToThisWindow(window, true);
        if (WaitForeground(window, SWITCH_MS)) return;

        // One quiet retry. Both calls are attempted together because their
        // return values are unreliable in either direction and only the read-back
        // matters.
        SetForegroundWindow(window);
        BringWindowToTop(window);
        if (WaitForeground(window, SETTLE_MS)) return;

        // Last resort: one quick Alt+Tab. A notification banner keeps the
        // foreground lock for as long as it is on screen, and every silent call
        // is refused while it does (measured: SetForegroundWindow, SwitchToThisWindow,
        // HWND_TOPMOST, minimising the banner and closing it all fail; only a real
        // Alt+Tab releases the lock). The keys are pressed and released without
        // pausing, so the task switcher does not have time to draw.
        AltTabOnce();
        SetForegroundWindow(window);
        if (WaitForeground(window, SETTLE_MS)) return;

        // A refusal ends here as a taskbar flash, and the banner stays in the
        // notification centre for a later click. A minimise/restore cycle is not
        // used: it earns the foreground but makes the window visibly bounce.
        FlashTaskbar(window);
    }

    // Restore a minimised window.
    //
    // SetWindowPlacement restores synchronously and keeps the maximised layout,
    // but from a shell-launched handler it is refused outright (returns false
    // while the window stays minimised). PostMessage(WM_SYSCOMMAND, SC_RESTORE)
    // asks the window's own thread to restore itself, which needs no permission
    // over that process, so it is the fallback that actually lands. Both are
    // attempted, and the outcome is confirmed by polling IsIconic rather than by
    // trusting either return value.
    private static void ShowPlacement(IntPtr window, ref WINDOWPLACEMENT placement, bool known)
    {
        if (known)
        {
            bool maximised = (placement.flags & WPF_RESTORETOMAXIMIZED) != 0 || placement.showCmd == SW_SHOWMAXIMIZED;
            placement.showCmd = maximised ? SW_SHOWMAXIMIZED : SW_RESTORE;
            if (SetWindowPlacement(window, ref placement) && WaitUntil(window, false, SETTLE_MS)) return;
        }

        for (int attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++)
        {
            PostMessage(window, WM_SYSCOMMAND, new IntPtr(SC_RESTORE), IntPtr.Zero);
            if (WaitUntil(window, false, RESTORE_MS)) return;
            ShowWindowAsync(window, SW_RESTORE);
            if (WaitUntil(window, false, RESTORE_MS)) return;
        }
    }

    // Keep the maximised layout. A restore normally returns the window to the
    // layout it had, so this only acts when the two disagree; SC_MAXIMIZE via
    // PostMessage was measured to leave the window at normal size, so the layout
    // is set directly instead.
    private static void EnforceMaximised(IntPtr window, bool maximised)
    {
        if (maximised == IsZoomed(window)) return;

        var placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (!GetWindowPlacement(window, ref placement)) return;
        placement.showCmd = maximised ? SW_SHOWMAXIMIZED : SW_RESTORE;
        SetWindowPlacement(window, ref placement);
    }

    // Wait for the window to actually own the foreground. The return values of
    // the raise calls are not trustworthy in either direction, so the state is
    // read back instead.
    private static bool WaitForeground(IntPtr window, int timeoutMs)
    {
        int waited = 0;
        while (waited < timeoutMs)
        {
            if (GetForegroundWindow() == window) return true;
            System.Threading.Thread.Sleep(POLL_MS);
            waited += POLL_MS;
        }
        return GetForegroundWindow() == window;
    }

    // Bring the window to the top of the z-order without taking the keyboard, so
    // someone typing elsewhere is not interrupted.
    private static void RaiseWithoutFocus(IntPtr window)
    {
        try
        {
            if (IsIconic(window))
            {
                var placement = new WINDOWPLACEMENT();
                placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                bool known = GetWindowPlacement(window, ref placement);
                ShowPlacement(window, ref placement, known);
                WaitUntil(window, false, SETTLE_MS);
            }

            SetWindowPos(
                window,
                new IntPtr(HWND_TOP),
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
        catch { }
    }

    // Poll until the window's minimised state matches what was asked for, or the
    // budget runs out. A no-op when the state is already correct.
    private static bool WaitUntil(IntPtr window, bool iconic, int timeoutMs)
    {
        int waited = 0;
        while (waited < timeoutMs)
        {
            if (IsIconic(window) == iconic) return true;
            System.Threading.Thread.Sleep(POLL_MS);
            waited += POLL_MS;
        }
        return IsIconic(window) == iconic;
    }

    // Press and release Alt+Tab with no dwell, which releases the foreground
    // lock without giving the task switcher time to appear.
    private static void AltTabOnce()
    {
        try
        {
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_TAB, 0, 0, UIntPtr.Zero);
            keybd_event(VK_TAB, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }
        catch { }
    }
    private static void FlashTaskbar(IntPtr window)
    {
        try
        {
            var info = new FLASHWINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
            info.hwnd = window;
            info.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
            info.uCount = 0;
            info.dwTimeout = 0;
            FlashWindowEx(ref info);
        }
        catch { }
    }

    // Locate the Harness window: the visible, titled Electron window owned by the
    // Harness executable. Electron also owns hidden helper windows, so all three
    // filters matter.
    private static IntPtr FindHarnessWindow()
    {
        var found = new List<IntPtr>();
        var titled = new List<IntPtr>();

        try
        {
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                try
                {
                    if (!IsWindowVisible(hWnd)) return true;
                    if (GetWindowTextLength(hWnd) <= 0) return true;

                    var name = new StringBuilder(256);
                    if (GetClassName(hWnd, name, name.Capacity) <= 0) return true;
                    if (name.ToString() != MAIN_WINDOW_CLASS) return true;

                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    string process = ProcessNameOf(pid);
                    if (process == null) return true;
                    if (process.IndexOf(HARNESS_EXE, StringComparison.OrdinalIgnoreCase) < 0) return true;

                    found.Add(hWnd);
                    var title = new StringBuilder(512);
                    if (GetWindowText(hWnd, title, title.Capacity) > 0)
                    {
                        if (title.ToString().IndexOf("DeepSeek Harness", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            titled.Add(hWnd);
                        }
                    }
                }
                catch { }
                return true;
            }, IntPtr.Zero);
        }
        catch
        {
            return IntPtr.Zero;
        }

        if (titled.Count > 0) return titled[0];
        if (found.Count > 0) return found[0];
        return IntPtr.Zero;
    }

    private static string ProcessNameOf(uint pid)
    {
        try
        {
            return Process.GetProcessById((int)pid).ProcessName;
        }
        catch
        {
            return null;
        }
    }

    // Accepts `dsh-whale-reminder://open/<id>` and tolerates a bare id, a query
    // string, or a missing scheme. Rejects anything that is not a plausible
    // session id so a crafted URI cannot smuggle a path or a command.
    private static string ParseSessionId(string uri)
    {
        if (string.IsNullOrEmpty(uri)) return null;
        int i = uri.IndexOf("://", StringComparison.Ordinal);
        if (i >= 0) uri = uri.Substring(i + 3);
        uri = uri.TrimStart('/');
        if (uri.StartsWith("open/", StringComparison.Ordinal)) uri = uri.Substring(5);
        int q = uri.IndexOf('?');
        if (q >= 0) uri = uri.Substring(0, q);
        if (uri.Length == 0 || uri.Length > 200) return null;
        foreach (char c in uri)
        {
            if (!(char.IsLetterOrDigit(c) || c == '_' || c == '.' || c == ':' || c == '-')) return null;
        }
        return uri;
    }
}
