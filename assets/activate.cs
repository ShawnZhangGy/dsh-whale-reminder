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
// Build (Windows, no SDK required):
//   cd dsh-whale-reminder\assets
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
//     -nologo -optimize+ -target:winexe -out:activate.exe activate.cs
//
// Keep this file and activate.exe in sync: the executable is what ships.

using System;
using System.Diagnostics;
using System.Net;
using System.Text;

internal static class Program
{
    [STAThread]
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

            if (port.Length > 0)
            {
                string url = "http://127.0.0.1:" + port +
                    "/__whale-reminder/activate?session=" + Uri.EscapeDataString(id);
                try
                {
                    using (var client = new WebClient())
                    {
                        client.Headers[HttpRequestHeader.ContentType] = "application/json";
                        client.Encoding = Encoding.UTF8;
                        client.UploadString(url, "POST", "{}");
                    }
                }
                catch
                {
                    // The Host may be gone, or the port may have moved. Raising
                    // the window below is still worth attempting.
                }
            }

            // Separate concern from delivery: bring the window forward so the
            // person sees the session the Client half is about to open.
            try
            {
                Process.Start(new ProcessStartInfo("dsh://open") { UseShellExecute = true });
            }
            catch { }

            return 0;
        }
        catch
        {
            return 1;
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
