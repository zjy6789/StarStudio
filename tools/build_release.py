"""Build a self-contained Windows installer without installing or launching Photoshop."""
import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'
BUILD = ROOT / 'build'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'StarStudio-build'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def compiler():
    return Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'


def compile_cs(source, output, extra=()):
    subprocess.run([str(compiler()), '/nologo', '/target:winexe', f'/out:{output}',
                    *extra, str(ROOT / 'tools' / source)], check=True)


def archive(source, target):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for file in sorted(source.rglob('*')):
            if file.is_file():
                z.write(file, file.relative_to(source).as_posix())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', default='v0.20.0-beta.1')
    parser.add_argument('--skip-freeze', action='store_true', help='Reuse an existing frozen runtime')
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('Build the Windows release on Windows x64 with Python 3.12.')
    version = json.loads((ROOT / 'plugin/manifest.json').read_text(encoding='utf-8'))['version']
    if not args.tag.startswith('v' + version):
        parser.error('Release tag must match plugin manifest version.')
    DIST.mkdir(exist_ok=True)
    BUILD.mkdir(exist_ok=True)
    if not args.skip_freeze:
        subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
                        '--onedir', '--windowed', '--name', 'StarStudioBridge',
                        '--paths', str(ROOT), '--distpath', str(BUILD / 'frozen'),
                        '--workpath', str(BUILD / 'pyinstaller'), '--specpath', str(BUILD),
                        '--collect-all', 'rawpy', '--hidden-import', 'pywt',
                        '--additional-hooks-dir', str(ROOT / 'tools/hooks'),
                        '--exclude-module', 'pytest', '--exclude-module', 'pip',
                        '--exclude-module', 'tkinter', '--exclude-module', 'matplotlib',
                        '--exclude-module', 'colour', '--exclude-module', 'colour_demosaicing',
                        str(ROOT / 'tools/bridge_entry.py')], check=True, cwd=ROOT)
    stage = BUILD / ('StarStudio-' + args.tag[1:])
    if stage.exists():
        # The only recursive removal is this known staging directory under build/.
        if stage.resolve().parent != BUILD.resolve():
            raise ValueError('Unsafe staging path')
        shutil.rmtree(stage)
    stage.mkdir()
    shutil.copytree(BUILD / 'frozen/StarStudioBridge', stage / 'runtime')
    shutil.copytree(ROOT / 'plugin', stage / 'plugin', ignore=shutil.ignore_patterns('bridge.json'))
    for folder in ('tools', 'artifacts', 'engines', 'licenses', 'vendor'):
        (stage / folder).mkdir(parents=True, exist_ok=True)
    (stage / 'artifacts/README.txt').write_text('Local logs and temporary image data. No autostart.\n')
    shutil.copytree(ROOT / 'docs', stage / 'docs')
    for name in ('LICENSE', 'README.md', 'THIRD_PARTY.md', 'VALIDATION.md', 'CHANGELOG.md'):
        shutil.copy2(ROOT / name, stage / name)
    shutil.copy2(ROOT / 'engines/README.md', stage / 'engines/README.md')
    for name in ('KINOBLOOM-LICENSE.txt', 'COLOUR-DEMOSAICING-LICENSE.txt', 'siril-ght.c', 'stack-camera-calibrations.json'):
        shutil.copy2(ROOT / 'vendor' / name, stage / 'vendor' / name)
    compile_cs('BridgeLauncher.cs', stage / 'tools/StarStudioLauncher.exe')

    # Retain each installed runtime dependency's original license/notices, including
    # native libraries mentioned in wheel licenses. Development-only packages excluded.
    excluded = {'pip', 'pytest', 'iniconfig', 'pluggy', 'colorama', 'pygments', 'colour-science', 'colour-demosaicing'}
    components = []
    components.append({'name': 'Python', 'version': sys.version.split()[0], 'source': 'https://www.python.org/downloads/'})
    base = Path(sys.base_prefix)
    python_license = next((p for p in (base / 'LICENSE_PYTHON.txt', base / 'LICENSE.txt') if p.is_file()), None)
    if python_license:
        shutil.copy2(python_license, stage / 'licenses/PYTHON-LICENSE.txt')
    else:
        (stage / 'licenses/PYTHON-LICENSE.txt').write_bytes(fetch(
            f'https://raw.githubusercontent.com/python/cpython/v{sys.version.split()[0]}/LICENSE'))
    # A build using Conda Python also has independently licensed support DLLs.
    native = {'python', 'openssl', 'libffi', 'bzip2', 'liblzma', 'libexpat', 'expat',
              'libzlib', 'zlib', 'ucrt', 'vc14_runtime'}
    for record in (base / 'conda-meta').glob('*.json'):
        details = json.loads(record.read_text(encoding='utf-8'))
        if details['name'] in native:
            location = Path(details['link']['source']) / 'info/licenses'
            if not location.is_dir():
                raise FileNotFoundError('Missing native library licenses: ' + details['name'])
            shutil.copytree(location, stage / 'licenses/native' / details['name'])
            components.append({'name': details['name'], 'version': details['version'],
                               'license': details.get('license'), 'source': details.get('url', '')})
    for distribution in sorted(metadata.distributions(), key=lambda d: d.metadata['Name'].lower()):
        name = distribution.metadata['Name']
        if name.lower() in excluded:
            continue
        components.append({'name': name, 'version': distribution.version,
                           'source': f'https://pypi.org/project/{name}/{distribution.version}/'})
        for file in distribution.files or []:
            if '.dist-info/' in str(file) and any(word in str(file).lower() for word in ('license', 'copying', 'notice', 'authors')):
                destination = stage / 'licenses' / str(file)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(distribution.locate_file(file), destination)
    import rawpy
    libraw_version = '.'.join(map(str, rawpy.libraw_version))
    sources = DIST / ('StarStudio-' + args.tag[1:] + '-third-party-sources.zip')
    source_index = []
    # Include the actual LGPL source releases beside the binary download. rawpy's
    # source archive also carries the build scripts for its bundled LibRaw binding.
    with zipfile.ZipFile(sources, 'w', zipfile.ZIP_DEFLATED) as z:
        for package in ('sep', 'rawpy'):
            package_version = metadata.version(package)
            info = json.loads(fetch(f'https://pypi.org/pypi/{package}/{package_version}/json'))
            source = next(f for f in info['urls'] if f['packagetype'] == 'sdist')
            data = fetch(source['url'])
            if hashlib.sha256(data).hexdigest() != source['digests']['sha256']:
                raise ValueError('Source checksum mismatch: ' + package)
            z.writestr(source['filename'], data)
            source_index.append({'file': source['filename'], 'url': source['url'], 'sha256': hashlib.sha256(data).hexdigest()})
        url = f'https://www.libraw.org/data/LibRaw-{libraw_version}.tar.gz'
        data = fetch(url)
        z.writestr(f'LibRaw-{libraw_version}.tar.gz', data)
        source_index.append({'file': f'LibRaw-{libraw_version}.tar.gz', 'url': url, 'sha256': hashlib.sha256(data).hexdigest()})
        z.writestr('sources.json', json.dumps(source_index, indent=2))
    (stage / 'licenses/components.json').write_text(json.dumps(components, indent=2), encoding='utf-8')
    (stage / 'licenses/sources.json').write_text(json.dumps(source_index, indent=2), encoding='utf-8')
    (stage / 'licenses/README.txt').write_text(
        'Star Studio source and build scripts: https://github.com/zjy6789/StarStudio\n'
        'Corresponding LGPL sources: the third-party-sources.zip asset on the same release.\n'
        'rawpy/LibRaw and SEP can be modified/rebuilt; use the documented source setup\n'
        'or rebuild this runtime. No license prevents debugging these modifications.\n'
        'Other dependency versions and upstream download pages: components.json.\n', encoding='utf-8')
    payload = BUILD / 'payload.zip'
    archive(stage, payload)
    setup = DIST / ('StarStudio-' + args.tag[1:] + '-Windows-x64-Setup.exe')
    compile_cs('Setup.cs', setup, ['/reference:System.IO.Compression.dll',
               '/reference:System.IO.Compression.FileSystem.dll', '/reference:System.Web.Extensions.dll',
               '/reference:System.Windows.Forms.dll', f'/resource:{payload},payload.zip'])
    checksums = DIST / 'SHA256SUMS.txt'
    assets = [setup, sources]
    checksums.write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in assets), encoding='utf-8')
    print(json.dumps({'tag': args.tag, 'assets': [{'name': p.name, 'bytes': p.stat().st_size} for p in assets]}, indent=2))


if __name__ == '__main__':
    main()
