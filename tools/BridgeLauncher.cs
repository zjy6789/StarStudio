using System;
using System.Diagnostics;
using System.IO;

class BridgeLauncher {
    [STAThread]
    static void Main() {
        string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
        try {
            string runtime = Path.Combine(root, "runtime", "StarStudioBridge.exe");
            bool packaged = File.Exists(runtime);
            Process.Start(new ProcessStartInfo {
                FileName = packaged ? runtime : Path.Combine(root, ".venv", "Scripts", "pythonw.exe"),
                Arguments = packaged ? "" : "\"" + Path.Combine(root, "tools", "start_bridge.py") + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        } catch (Exception e) {
            File.AppendAllText(Path.Combine(root, "artifacts", "launcher-errors.log"), e.ToString() + Environment.NewLine);
        }
    }
}
