"""Per-user, windowless startup for the installed image-processing component."""
from pathlib import Path
import ctypes
from ctypes import wintypes
import json
import sys
import urllib.request

if not getattr(sys, 'frozen', False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paths import ROOT


def main():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    mutex = kernel.CreateMutexW(None, False, "Local\\AstroStarLayersBridge")
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(mutex)
        return
    try:
        config = json.loads((ROOT / "plugin/bridge.json").read_text(encoding="utf-8"))
        request = urllib.request.Request(config["url"] + "/health", headers={"X-Star-Token": config["token"]})
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                if json.load(response).get("ok"):
                    return
        except OSError:
            pass
        (ROOT / "artifacts").mkdir(exist_ok=True)
        with (ROOT / "artifacts/bridge-background.log").open("a", encoding="utf-8", buffering=1) as log:
            sys.stdout = sys.stderr = log
            sys.path.insert(0, str(ROOT))
            from backend.server import main as serve
            serve()
    finally:
        kernel.CloseHandle(mutex)


if __name__ == "__main__":
    main()
