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
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

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

            // Report the click first: the reply carries the policy the person
            // chose (raise the window with or without stealing the keyboard).
            // Default to stealing focus so a reply we cannot read still lands on
            // the useful side.
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
    private static void RaiseWithFocus(IntPtr window)
    {
        try
        {
            if (IsIconic(window))
            {
                ShowWindowAsync(window, SW_RESTORE);
            }
            else
            {
                ShowWindowAsync(window, SW_MINIMIZE);
                ShowWindowAsync(window, SW_RESTORE);
            }
        }
        catch { }

        bool raised = false;
        try
        {
            raised = SetForegroundWindow(window);
        }
        catch { }

        if (!raised)
        {
            try
            {
                BringWindowToTop(window);
                raised = SetForegroundWindow(window);
            }
            catch { }
        }

        if (!raised) FlashTaskbar(window);
    }

    // Bring the window to the top of the z-order without taking the keyboard, so
    // someone typing elsewhere is not interrupted.
    private static void RaiseWithoutFocus(IntPtr window)
    {
        try
        {
            ShowWindowAsync(window, SW_SHOW);
            SetWindowPos(
                window,
                new IntPtr(HWND_TOP),
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
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
