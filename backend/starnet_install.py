"""Read-only checks for the two supported Windows StarNet CLI layouts."""
import hashlib
import os
from pathlib import Path
import re
import shutil

from .paths import ROOT


def present(path):
    return path.is_file() and path.stat().st_size > 0


def starnet_info(executable):
    exe = Path(executable).resolve()
    if not present(exe):
        raise ValueError(f'找不到 StarNet: {exe}（程序不存在或为空，请完整解压）')
    if exe.stem.lower() not in ('starnet2', 'starnet++'):
        raise ValueError('请选择官方 starnet2.exe 或旧版 starnet++.exe，保留原始文件名。')
    modern = exe.stem.lower() == 'starnet2'
    name = 'StarNet2_weights.onnx' if modern else 'starnet2_weights.pb'
    models = [exe.parent/name]
    licenses = [exe.parent/'LICENSE.txt']
    if modern and exe.parent.name.lower() == 'bin':
        models.append(exe.parent.parent/'lib/starnet2'/name)
        licenses.append(exe.parent.parent/'LICENSE.txt')
    model = next((p for p in models if present(p)), None)
    license_file = next((p for p in licenses if present(p)), None) if modern else None
    missing = ([] if model else [name])+(['LICENSE.txt'] if modern and not license_file else [])
    info = dict(modern=modern, product='StarNet2' if modern else 'StarNet++ v2',
                minimum_size=512 if modern else 256,
                installation=dict(ready=not missing, missing=missing,
                                  modelPath=str(model) if model else None,
                                  licensePath=str(license_file) if license_file else None))
    if modern:
        terms = license_file.read_bytes() if license_file else b''
        info.update(license=terms.decode('utf-8-sig'),
                    license_sha256=hashlib.sha256(terms).hexdigest() if terms else None)
    return info


def known_locations():
    modern = [ROOT/'engines/starnet/starnet2.exe', ROOT/'engines/StarNet2/starnet2.exe',
              Path(os.environ.get('ProgramFiles', 'C:/Program Files'))/'StarNet2/bin/starnet2.exe']
    legacy = [ROOT/'engines/starnet/starnet++.exe', Path('D:/StarNetv2CLI_Win/starnet++.exe'),
              Path('C:/StarNetv2CLI_Win/starnet++.exe')]
    for name, paths in [('starnet2.exe', modern), ('starnet++.exe', legacy)]:
        located = shutil.which(name)
        if located:
            paths.append(Path(located))
    for root in [Path('C:/AstroTools'), Path('D:/AstroTools')]:
        paths = list(root.glob('StarNet2*/starnet2.exe'))+list(root.glob('StarNet2*/*/starnet2.exe'))
        modern.extend(sorted(paths, key=lambda p: [int(x) if x.isdigit() else x.casefold()
                                                  for x in re.split(r'(\d+)', str(p))], reverse=True))
    return modern+legacy


def discover_starnet(current=''):
    if not isinstance(current, str):
        raise ValueError('当前程序路径必须是字符串。')
    selected = Path(current).resolve() if current.strip() else None
    locations = ([selected] if selected else [])+known_locations()
    seen = set()
    for path in locations:
        path = Path(path).resolve()
        if path in seen:
            continue
        seen.add(path)
        try:
            info = starnet_info(path)
        except (OSError, ValueError):
            continue
        if info['installation']['ready']:
            return dict(executable=str(path), product=info['product'], modern=info['modern'],
                        installation=info['installation'], preserved=path == selected)
    return dict(executable=None)
