import hashlib

import pytest

from backend import starnet_install


def make_engine(folder, modern=True):
    folder.mkdir(parents=True, exist_ok=True)
    exe = folder / ('starnet2.exe' if modern else 'starnet++.exe')
    exe.write_bytes(b'test executable')
    (folder / ('StarNet2_weights.onnx' if modern else 'starnet2_weights.pb')).write_bytes(b'test weights')
    if modern:
        (folder / 'LICENSE.txt').write_text('Test license', encoding='utf-8')
    return exe


@pytest.mark.parametrize('layout', ['portable', 'bin'])
def test_modern_installation_reports_model_and_exact_license_hash(tmp_path, layout):
    folder = tmp_path if layout == 'portable' else tmp_path / 'bin'
    exe = make_engine(folder)
    model = folder / 'StarNet2_weights.onnx'
    terms = folder / 'LICENSE.txt'
    if layout == 'bin':
        model = tmp_path / 'lib/starnet2/StarNet2_weights.onnx'
        model.parent.mkdir(parents=True)
        (folder / model.name).replace(model)
        terms = (folder / 'LICENSE.txt').replace(tmp_path / 'LICENSE.txt')
    raw = b'\xef\xbb\xbf' + 'StarNet2 \u8bb8\u53ef\r\nRevision 1'.encode('utf-8')
    terms.write_bytes(raw)
    info = starnet_install.starnet_info(exe)
    assert info['modern'] is True
    assert info['product'] == 'StarNet2'
    assert info['minimum_size'] == 512
    assert info['installation'] == dict(ready=True, missing=[], modelPath=str(model), licensePath=str(terms))
    assert info['license'] == raw.decode('utf-8-sig')
    assert info['license_sha256'] == hashlib.sha256(raw).hexdigest()
    revised = raw + b'\r\nRevision 2'
    terms.write_bytes(revised)
    changed = starnet_install.starnet_info(exe)
    assert changed['license_sha256'] == hashlib.sha256(revised).hexdigest()
    assert changed['license_sha256'] != info['license_sha256']


@pytest.mark.parametrize('modern', [False, True])
@pytest.mark.parametrize('empty', [False, True])
def test_missing_or_empty_model_is_reported_as_incomplete(tmp_path, modern, empty):
    exe = make_engine(tmp_path, modern)
    model = tmp_path / ('StarNet2_weights.onnx' if modern else 'starnet2_weights.pb')
    if empty:
        model.write_bytes(b'')
    else:
        model.unlink()
    info = starnet_install.starnet_info(exe)
    assert info['installation']['ready'] is False
    assert info['installation']['missing'] == [model.name]
    assert info['installation']['modelPath'] is None


@pytest.mark.parametrize('empty', [False, True])
def test_missing_or_empty_modern_license_is_reported_as_incomplete(tmp_path, empty):
    exe = make_engine(tmp_path)
    terms = tmp_path / 'LICENSE.txt'
    if empty:
        terms.write_bytes(b'')
    else:
        terms.unlink()
    info = starnet_install.starnet_info(exe)
    assert info['installation']['ready'] is False
    assert info['installation']['missing'] == ['LICENSE.txt']
    assert info['installation']['licensePath'] is None
    assert info['license'] == ''
    assert info['license_sha256'] is None


def test_cpu_installation_does_not_require_modern_license(tmp_path):
    exe = make_engine(tmp_path, False)
    info = starnet_install.starnet_info(exe)
    assert info['modern'] is False
    assert info['product'] == 'StarNet++ v2'
    assert info['minimum_size'] == 256
    assert info['installation'] == dict(ready=True, missing=[],
        modelPath=str(tmp_path / 'starnet2_weights.pb'), licensePath=None)
    assert 'license' not in info and 'license_sha256' not in info


@pytest.mark.parametrize('state', ['missing', 'empty', 'directory', 'renamed'])
def test_unusable_executable_is_rejected(tmp_path, state):
    exe = tmp_path / ('renamed.exe' if state == 'renamed' else 'starnet2.exe')
    if state in ('empty', 'renamed'):
        exe.write_bytes(b'test executable' if state == 'renamed' else b'')
    elif state == 'directory':
        exe.mkdir()
    with pytest.raises(ValueError, match='StarNet|starnet2.exe'):
        starnet_install.starnet_info(exe)


def test_bin_installation_uses_nonempty_fallback_model_and_license(tmp_path):
    exe = make_engine(tmp_path / 'bin')
    (exe.parent / 'StarNet2_weights.onnx').write_bytes(b'')
    (exe.parent / 'LICENSE.txt').write_bytes(b'')
    model = tmp_path / 'lib/starnet2/StarNet2_weights.onnx'
    model.parent.mkdir(parents=True)
    model.write_bytes(b'test weights')
    terms = tmp_path / 'LICENSE.txt'
    terms.write_text('Root license', encoding='utf-8')
    info = starnet_install.starnet_info(exe)
    assert info['installation'] == dict(ready=True, missing=[], modelPath=str(model), licensePath=str(terms))


def test_discovery_preserves_ready_current_cpu_engine(tmp_path, monkeypatch):
    cpu = make_engine(tmp_path / 'cpu', False)
    modern = make_engine(tmp_path / 'modern')
    monkeypatch.setattr(starnet_install, 'known_locations', lambda: [modern])
    result = starnet_install.discover_starnet(str(cpu))
    assert result == dict(executable=str(cpu), product='StarNet++ v2', modern=False,
        installation=starnet_install.starnet_info(cpu)['installation'], preserved=True)


def test_discovery_skips_unusable_and_incomplete_candidates(tmp_path, monkeypatch):
    incomplete = make_engine(tmp_path / 'incomplete')
    (incomplete.parent / 'StarNet2_weights.onnx').unlink()
    empty = tmp_path / 'empty/starnet2.exe'
    empty.parent.mkdir()
    empty.touch()
    complete = make_engine(tmp_path / 'complete')
    monkeypatch.setattr(starnet_install, 'known_locations', lambda: [empty, tmp_path / 'missing.exe', complete])
    result = starnet_install.discover_starnet(str(incomplete))
    assert result['executable'] == str(complete)
    assert result['installation']['ready'] is True
    assert result['preserved'] is False


def test_discovery_checks_each_resolved_candidate_once_and_returns_no_candidate(tmp_path, monkeypatch):
    exe = make_engine(tmp_path / 'incomplete', False)
    (exe.parent / 'starnet2_weights.pb').unlink()
    alias = exe.parent / '..' / exe.parent.name / exe.name
    monkeypatch.setattr(starnet_install, 'known_locations', lambda: [exe, alias, exe])
    checked = []
    inspect = starnet_install.starnet_info
    def record(path):
        checked.append(path)
        return inspect(path)
    monkeypatch.setattr(starnet_install, 'starnet_info', record)
    assert starnet_install.discover_starnet(str(exe)) == dict(executable=None)
    assert checked == [exe]


@pytest.mark.parametrize('current', ['', '  '])
def test_discovery_without_candidates_does_not_select_an_engine(monkeypatch, current):
    monkeypatch.setattr(starnet_install, 'known_locations', lambda: [])
    assert starnet_install.discover_starnet(current) == dict(executable=None)


@pytest.mark.parametrize('current', [None, [], 1])
def test_discovery_rejects_non_string_current_paths(current):
    with pytest.raises(ValueError, match='\u8def\u5f84'):
        starnet_install.discover_starnet(current)
