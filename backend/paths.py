"""Locate resources beside the source checkout or the packaged runtime."""
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(sys.executable).resolve().parent.parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[1]


def siril_path():
    candidates = [ROOT / 'engines/siril/bin/siril-cli.exe',
                  Path(os.environ.get('PROGRAMFILES', r'C:\Program Files')) / 'Siril/bin/siril-cli.exe']
    return next((p for p in candidates if p.is_file()), Path(shutil.which('siril-cli') or candidates[0]))
