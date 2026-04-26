// Minimal 7za.exe wrapper used during electron-builder packaging on Windows.
//
// app-builder (the Go binary that electron-builder shells out to) extracts
// winCodeSign-2.6.0.7z to populate its cache. That archive contains macOS
// dylib symlinks. Creating symlinks on Windows requires admin or Developer
// Mode, so the extract fails for two of the ~85 files.
//
// We don't need any of the macOS bits when building Windows installers, so
// this shim intercepts the `7za x ...` invocation and appends `-xr!darwin`,
// telling 7-Zip to skip the entire darwin/ subtree. Other 7za commands pass
// through untouched.
//
// Compiled by scripts/build-7za-shim.mjs and pointed at via the SZA_PATH env
// var that app-builder reads when looking up 7za.

using System;
using System.Diagnostics;

class Program
{
    static int Main(string[] args)
    {
        string real = Environment.GetEnvironmentVariable("WPSYNC_REAL_7ZA");
        if (string.IsNullOrEmpty(real))
        {
            Console.Error.WriteLine("7za-shim: WPSYNC_REAL_7ZA env var must point to the real 7za.exe");
            return 1;
        }

        var psi = new ProcessStartInfo();
        psi.FileName = real;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = false;
        psi.RedirectStandardError = false;

        bool isExtract = args.Length > 0 &&
            (string.Equals(args[0], "x", StringComparison.OrdinalIgnoreCase) ||
             string.Equals(args[0], "e", StringComparison.OrdinalIgnoreCase));

        // Quote each argument; escape embedded quotes by doubling, the way cmd.exe expects.
        var sb = new System.Text.StringBuilder();
        foreach (string arg in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(QuoteArg(arg));
        }
        if (isExtract)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append("-xr!darwin");
        }
        psi.Arguments = sb.ToString();

        try
        {
            var p = Process.Start(psi);
            p.WaitForExit();
            int code = p.ExitCode;
            p.Close();
            // Give Windows a moment to fully release file handles before app-builder
            // tries to rename the just-extracted directory. Without this, the rename
            // intermittently fails with "Access is denied".
            System.Threading.Thread.Sleep(150);
            return code;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("7za-shim: failed to spawn " + real + ": " + ex.Message);
            return 1;
        }
    }

    static string QuoteArg(string arg)
    {
        if (arg.Length == 0) return "\"\"";
        if (arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var s = new System.Text.StringBuilder();
        s.Append('"');
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == '"') s.Append("\\\"");
            else s.Append(c);
        }
        s.Append('"');
        return s.ToString();
    }
}
