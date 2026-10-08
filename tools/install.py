"""Build CCX package and configure the loopback service; no StarNet binaries copied."""
from pathlib import Path
import json
import secrets
import zipfile
import subprocess
import sys
import winreg
import os

root = Path(__file__).resolve().parents[1]
(root / 'artifacts').mkdir(exist_ok=True)
run_key = r"Software\Microsoft\Windows\CurrentVersion\Run"
if "--remove-autostart" in sys.argv:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, run_key, 0, winreg.KEY_SET_VALUE) as key:
        try:
            winreg.DeleteValue(key, "AstroStarLayersBridge")
        except FileNotFoundError:
            pass
    print("Per-user background startup removed.")
    raise SystemExit(0)
config = root / "plugin/bridge.json"
if not config.exists():
    config.write_text(json.dumps({"url": "http://127.0.0.1:8765", "token": secrets.token_hex(32)}), encoding="utf-8")
launcher = root / "artifacts/StarLayersBridge.exe"
compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
subprocess.run([str(compiler), "/nologo", "/target:winexe", f"/out:{launcher}", str(root / "tools/BridgeLauncher.cs")], check=True)
settings = json.loads(config.read_text(encoding="utf-8"))
settings["launcher"] = str(launcher)
config.write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")
version = json.loads((root / "plugin/manifest.json").read_text(encoding="utf-8"))["version"]
package = root / f"artifacts/StarStudio-{version}.ccx"
with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as z:
    for path in (root / "plugin").glob("*"):
        if path.is_file():
            z.write(path, path.name)
print(f"Package: {package}")
installer = Path(os.environ['COMMONPROGRAMFILES']) / 'Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.exe'
if installer.exists():
    result = subprocess.run([str(installer), "/install", str(package)], capture_output=True, text=True, errors="replace")
    print(f"UPIA exit={result.returncode}\n{result.stdout}\n{result.stderr}")
    if result.returncode:
        raise SystemExit(result.returncode)
else:
    print("UPIA not found. Open the CCX using Creative Cloud or load plugin/manifest.json with UXP Developer Tool.")

with winreg.OpenKey(winreg.HKEY_CURRENT_USER, run_key, 0, winreg.KEY_SET_VALUE) as key:
    try:
        winreg.DeleteValue(key, "AstroStarLayersBridge")
    except FileNotFoundError:
        pass
print("Login startup removed. The Photoshop panel starts the component on demand.")
