import io
import json
import subprocess

import numpy as np
import pytest
import tifffile
from astropy.io import fits

from backend.algorithms import starnet, starnet_info


class FakeProcess:
    def __init__(self, code=0, lines=""):
        self.returncode = code
        self.stdout = io.StringIO(lines)
        self.killed = False

    def wait(self, timeout=None):
        assert timeout in (None, 7200)
        return self.returncode

    def kill(self):
        self.killed = True


@pytest.mark.parametrize('channels', [1, 3])
@pytest.mark.parametrize('modern', [False, True])
def test_starnet_interfaces_and_precision(tmp_path, monkeypatch, channels, modern):
    engine = tmp_path / 'engine'
    engine.mkdir()
    exe = engine / ('starnet2.exe' if modern else 'starnet++.exe')
    exe.touch()
    if modern:
        (engine / 'LICENSE.txt').write_text('Test license revision', encoding='utf-8')
    info = starnet_info(exe)
    image = np.random.default_rng(9).uniform(.01, .9, (73, 131, channels)).astype(np.float32)
    progress = []

    def execute(command, **options):
        assert options['cwd'] == (tmp_path if modern else engine)
        assert options['stdout'] == subprocess.PIPE
        if modern:
            assert command[1:-1:2] == ['--input', '--output', '--stride']
            assert command[-1] == '--machine-progress'
            assert command[2] == 'input.fits' and command[4] == 'starless.fits'
            source, output = options['cwd'] / command[2], options['cwd'] / command[4]
            data = fits.getdata(source)
            restored = data[..., None] if channels == 1 else data.transpose(1, 2, 0)
            np.testing.assert_array_equal(restored[:73, :131], image)
            assert restored.shape == (512, 512, channels)
            fits.writeto(output, data * .8)
        else:
            source, output = command[1:3]
            data = tifffile.imread(source)
            restored = data[..., None] if channels == 1 else data
            assert restored.shape == (256, 256, channels)
            np.testing.assert_array_equal(restored[:73, :131], np.rint(image * 65535).astype(np.uint16))
            tifffile.imwrite(output, np.rint(data * .8).astype(np.uint16), metadata=None)
        assert command[-2 if modern else -1] == '128'
        return FakeProcess(0)

    monkeypatch.setattr('backend.algorithms.subprocess.Popen', execute)
    result = starnet(image, tmp_path, exe, 128, progress.append, info.get('license_sha256'))
    np.testing.assert_allclose(result, image * .8, atol=0 if modern else 2 / 65535)
    assert progress == [.05, 1]


def test_revised_license_needs_new_acceptance(tmp_path, monkeypatch):
    exe = tmp_path / 'starnet2.exe'
    exe.touch()
    terms = tmp_path / 'LICENSE.txt'
    terms.write_text('First revision')
    accepted = starnet_info(exe)['license_sha256']
    terms.write_text('Second revision')
    def unexpected(*args, **kwargs):
        pytest.fail('Must not run before acceptance')
    monkeypatch.setattr('backend.algorithms.subprocess.Popen', unexpected)
    for value in [None, accepted]:
        with pytest.raises(ValueError, match='许可'):
            starnet(np.ones((4, 4, 1), dtype=np.float32), tmp_path, exe, license_sha256=value)


@pytest.mark.parametrize('failure', ['exit', 'missing', 'shape', 'nonfinite', 'range', 'depth'])
def test_invalid_modern_outputs_are_rejected(tmp_path, monkeypatch, failure):
    exe = tmp_path / 'starnet2.exe'
    exe.touch()
    (tmp_path / 'LICENSE.txt').write_text('Test license')
    accepted = starnet_info(exe)['license_sha256']
    def execute(command, **options):
        if failure not in ['exit', 'missing']:
            data = fits.getdata(options['cwd'] / command[2]).astype(np.float32)
            if failure == 'shape': data = data[:10]
            if failure == 'nonfinite': data[0, 0] = np.nan
            if failure == 'range': data[0, 0] = 1.1
            if failure == 'depth': data = data.astype(np.uint16)
            fits.writeto(options['cwd'] / command[4], data)
        return FakeProcess(1 if failure == 'exit' else 0)
    monkeypatch.setattr('backend.algorithms.subprocess.Popen', execute)
    with pytest.raises((ValueError, RuntimeError)):
        starnet(np.ones((20, 30, 1), dtype=np.float32), tmp_path, exe, license_sha256=accepted)


def test_modern_progress_provider_and_high_stride_preserve_pixels(tmp_path, monkeypatch):
    exe = tmp_path / 'starnet2.exe'
    exe.touch()
    (tmp_path / 'LICENSE.txt').write_text('Test license')
    image = np.full((512, 700, 3), .25, dtype=np.float32)
    before = image.copy()
    events = ['plain log', '[]', '{broken', json.dumps({'schema': 'starnetastro.cli.progress.v1', 'stage': 'inference', 'percent': 50}),
              json.dumps({'schema': 'starnetastro.cli.progress.v1', 'stage': 'inference', 'percent': 999}),
              json.dumps({'schema': 'starnetastro.cli.progress.v1', 'stage': 'inference', 'percent': 'invalid'}),
              json.dumps({'code': 'inference_backend', 'message': 'Backend: ONNX Runtime (DirectML execution provider)'})]
    def execute(command, **options):
        assert command[-2:] == ['384', '--machine-progress']
        data = fits.getdata(options['cwd'] / command[2])
        fits.writeto(options['cwd'] / command[4], data)
        return FakeProcess(lines='\n'.join(events))
    monkeypatch.setattr('backend.algorithms.subprocess.Popen', execute)
    progress, states = [], []
    result = starnet(image, tmp_path, exe, 384, progress.append, starnet_info(exe)['license_sha256'], states.append)
    np.testing.assert_array_equal(result, before)
    np.testing.assert_array_equal(image, before)
    assert progress == [.05, .475, 1]
    assert any(state.get('provider') == 'DirectML' for state in states)
    assert {'prepareSeconds', 'engineSeconds', 'readSeconds'} <= {key for state in states for key in state}
    assert 'plain log' in (tmp_path / 'starnet.log').read_text()


def test_legacy_rejects_384_before_start(tmp_path, monkeypatch):
    exe = tmp_path / 'starnet++.exe'
    exe.touch()
    def unexpected(*args, **kwargs):
        pytest.fail('Unsupported stride must not start engine')
    monkeypatch.setattr('backend.algorithms.subprocess.Popen', unexpected)
    with pytest.raises(ValueError, match='384'):
        starnet(np.zeros((512, 512, 1), dtype=np.float32), tmp_path, exe, 384)


def test_timeout_terminates_engine_and_drains_log(tmp_path, monkeypatch):
    exe = tmp_path / 'starnet++.exe'
    exe.touch()
    process = FakeProcess(lines='engine timed out')
    def wait(timeout=None):
        if timeout:
            raise subprocess.TimeoutExpired('StarNet', timeout)
        return -1
    process.wait = wait
    monkeypatch.setattr('backend.algorithms.subprocess.Popen', lambda *args, **kwargs: process)
    with pytest.raises(subprocess.TimeoutExpired):
        starnet(np.zeros((512, 512, 1), dtype=np.float32), tmp_path, exe)
    assert process.killed and process.stdout.closed
    assert (tmp_path / 'starnet.log').read_text() == 'engine timed out'
