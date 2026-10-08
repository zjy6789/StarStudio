using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Collections.Generic;

[assembly: AssemblyTitle("Star Studio Setup")]
[assembly: AssemblyDescription("Star Studio Photoshop plugin installer")]
class Setup {
    [STAThread]
    static int Main(string[] args) {
        Application.EnableVisualStyles();
        try {
            bool extractOnly = args.Length == 2 && args[0] == "--extract-only";
            string root = extractOnly ? Path.GetFullPath(args[1]) : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StarStudio");
            if (extractOnly && Directory.Exists(root)) throw new IOException("Extraction target must not exist.");
            if (!extractOnly) {
                string upia = InstallerPath();
                if (!File.Exists(upia)) throw new IOException("Please install Adobe Creative Cloud Desktop and launch Photoshop once before installing Star Studio.\n请先安装 Creative Cloud 桌面应用，并至少启动一次 Photoshop。");
                if (Process.GetProcessesByName("StarStudioBridge").Length > 0) throw new IOException("Close the Star Studio panel and wait 90 seconds before updating.\n请关闭 Star Studio 面板，等待后台组件退出后再更新。");
            }
            Directory.CreateDirectory(root);
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read)) {
                foreach (ZipArchiveEntry entry in zip.Entries) {
                    string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                    if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid package path.");
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                }
            }
            if (extractOnly) return 0;
            var serializer = new JavaScriptSerializer();
            string configPath = Path.Combine(root, "plugin", "bridge.json");
            string token;
            if (File.Exists(configPath)) {
                var previous = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
                token = (string)previous["token"];
            } else {
                byte[] random = new byte[32];
                using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(random);
                token = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
            }
            var config = new Dictionary<string, object> {
                {"url", "http://127.0.0.1:8765"}, {"token", token},
                {"launcher", Path.Combine(root, "tools", "StarStudioLauncher.exe")},
                {"starnet", Path.Combine(root, "engines", "starnet", "starnet++.exe")}
            };
            File.WriteAllText(configPath, serializer.Serialize(config), new UTF8Encoding(false));
            string ccx = Path.Combine(root, "StarStudio.ccx");
            if (File.Exists(ccx)) File.Delete(ccx);
            ZipFile.CreateFromDirectory(Path.Combine(root, "plugin"), ccx);
            var start = new ProcessStartInfo {
                FileName = InstallerPath(), Arguments = "/install \"" + ccx + "\"",
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (Process install = Process.Start(start)) {
                var output = install.StandardOutput.ReadToEndAsync();
                var error = install.StandardError.ReadToEndAsync();
                install.WaitForExit();
                File.WriteAllText(Path.Combine(root, "artifacts", "install.log"), output.Result + error.Result);
                if (install.ExitCode != 0) throw new IOException("Adobe installation failed (" + install.ExitCode + ").\n安装日志：" + Path.Combine(root, "artifacts", "install.log") + "\n可双击 " + ccx + " 使用 Creative Cloud 重试。");
            }
            MessageBox.Show("安装完成。请在 Photoshop → 增效工具 → Star Studio 打开面板。\n首次运行请允许启动本机处理组件。无需开机自启。\n\nInstalled. Open Photoshop → Plugins → Star Studio.", "Star Studio", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        } catch (Exception e) {
            MessageBox.Show(e.Message, "Star Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
    static string InstallerPath() {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles),
            "Adobe", "Adobe Desktop Common", "RemoteComponents", "UPI", "UnifiedPluginInstallerAgent", "UnifiedPluginInstallerAgent.exe");
    }
}
