"""Reference-ground output uses the calibrated middle snapshot without warping."""
import hashlib
import json
from pathlib import Path
import time

import cv2
import numpy as np
import pytest
import tifffile

from backend.stack_io import linear_profile, read_frame, write_result
from backend.stacking import stack


@pytest.fixture
def sequence(tmp_path):
    size = 256
    y, x = np.mgrid[:size, :size]
    sky = np.zeros((size, size), np.float32)
    rng = np.random.default_rng(441)
    for sx, sy, flux in zip(rng.uniform(18, 238, 65), rng.uniform(18, 155, 65), rng.uniform(.2, .6, 65)):
        sky += (flux*np.exp(-((x-sx)**2+(y-sy)**2)/2)).astype(np.float32)
    terrain = np.where(y > 175, .05+(x % 23)/180+(y % 13)/110, .025).astype(np.float32)
    paths = []
    for i in range(3):
        shifted = cv2.warpAffine(sky, np.array([[1., 0., (i-1)*5], [0., 1., (i-1)*2]]), (size, size))
        image = np.repeat((shifted+terrain)[..., None], 3, axis=2)
        image[210, 130] = [-.003, 1.8, .125]
        path = tmp_path/f'light{i}.tif'
        write_result(path, image, {'space': 'prophoto'}, 'tiff32')
        paths.append(str(path))
    request = {'paths': paths, 'mode': 'mean', 'landscape': True,
               'mask': [{'radius': .18, 'points': [[0, .9], [1, .9]]}]}
    return request


@pytest.mark.parametrize('format,extension', [('dng', 'dng'), ('tiff16', 'tif'), ('tiff32', 'tif'),
                                               ('fits16', 'fit'), ('fits32', 'fit')])
def test_all_master_formats_keep_full_float_sky_and_unwarped_reference(tmp_path, sequence, format, extension):
    before = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in sequence['paths']}
    folder = tmp_path/format
    folder.mkdir()
    output = folder/('stack.'+extension)
    result = stack(dict(sequence, format=format, output=str(output), referenceGround=True),
                   tmp_path, lambda _: None, lambda _: None)
    layers = result['layers']
    assert output.is_file() and result['format'] == format
    assert layers['referenceSource'] == sequence['paths'][1] and layers['referenceFrames'] == 1
    assert layers['referenceResampled'] is False and layers['referenceVisible'] is False
    assert result['photoshopOutput'] == layers['sky']
    sky, ground = [tifffile.imread(layers[k]) for k in ['sky', 'reference']]
    assert sky.dtype == ground.dtype == np.float32
    assert sky.shape == ground.shape == (256, 256, 3)
    for kind in ['sky', 'reference']:
        with tifffile.TiffFile(layers[kind]) as f:
            assert f.pages[0].tags[34675].value == linear_profile()
    reference, _ = read_frame(sequence['paths'][1])
    np.testing.assert_array_equal(ground, reference)
    assert ground.min() < 0 and ground.max() > 1
    baseline = tmp_path/f'baseline-{format}.tif'
    stack(dict(sequence, format='tiff32', output=str(baseline)), tmp_path, lambda _: None, lambda _: None)
    np.testing.assert_array_equal(sky, tifffile.imread(baseline))
    assert sky[210, 130, 1] != ground[210, 130, 1]  # Terrain moves in sky stacking only.
    if format == 'tiff32':
        assert layers['sky'] == str(output)
    assert json.loads(output.with_suffix(output.suffix+'.json').read_text(encoding='utf-8'))['layers'] == layers
    assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == before[p] for p in before)
    assert not list(folder.glob('.starstudio-layers-*'))


def test_existing_reference_output_is_rejected_before_processing(tmp_path, sequence, monkeypatch):
    from backend import stacking
    output = tmp_path/'result.tif'
    protected = tmp_path/'StarStudio_reference_ground.tif'
    protected.write_bytes(b'other user data')
    monkeypatch.setattr(stacking, 'star_catalog', lambda *_: pytest.fail('must validate destination before matching'))
    with pytest.raises(ValueError, match='已存在'):
        stack(dict(sequence, format='tiff32', output=str(output), referenceGround=True),
              tmp_path, lambda _: None, lambda _: None)
    assert protected.read_bytes() == b'other user data' and not output.exists()


@pytest.mark.parametrize('failure', ['write', 'cancel_write', 'cancel_commit', 'collision', 'rename'])
def test_layer_save_failure_preserves_other_files_and_removes_own_partial_outputs(tmp_path, monkeypatch, failure):
    from backend import stack_layers
    targets = stack_layers.layer_targets(tmp_path/'master.dng', 'dng')
    image = np.full((3, 4, 3), .12, np.float32)
    preserved = tmp_path/'keep.txt'
    preserved.write_bytes(b'keep')
    cancelled = False
    write, rename = stack_layers.write_result, Path.rename
    def writing(path, *args, **kwargs):
        nonlocal cancelled
        if Path(path).name == targets['reference'].name:
            if failure == 'write':
                raise OSError('disk full')
            if failure == 'collision':
                targets['reference'].write_bytes(b'new external file')
        result = write(path, *args, **kwargs)
        if failure == 'cancel_write':
            cancelled = True
        return result
    def renaming(path, destination):
        nonlocal cancelled
        if Path(destination) == targets['sky'] and failure == 'rename':
            raise OSError('rename failed')
        result = rename(path, destination)
        if failure == 'cancel_commit':
            cancelled = True
        return result
    def check():
        if cancelled:
            raise ValueError('已取消')
    monkeypatch.setattr(stack_layers, 'write_result', writing)
    monkeypatch.setattr(Path, 'rename', renaming)
    with pytest.raises((ValueError, OSError)):
        stack_layers.save_layers(targets, image, image, {'space': 'prophoto'}, 'dng',
                                 {'calibration': None, 'reference': 'middle.raw'}, time.monotonic(), check)
    assert preserved.read_bytes() == b'keep'
    for path in set(targets.values()):
        if failure == 'collision' and path == targets['reference']:
            assert path.read_bytes() == b'new external file'
        else:
            assert not path.exists()
    assert not list(tmp_path.glob('.starstudio-layers-*'))


def test_camera_reference_reuses_color_transform_without_stretch_or_quantization(tmp_path):
    from backend.stack_io import camera_to_prophoto, PROPHOTO_XYZ
    from backend.stack_layers import layer_targets, save_layers
    image = np.array([[[-.02, .12, 1.5], [.2, .4, .7]]], dtype=np.float32)
    reference = image*.75
    meta = {'space': 'camera', 'matrix': np.linalg.inv(PROPHOTO_XYZ).tolist(), 'neutral': [.8, 1., .7]}
    targets = layer_targets(tmp_path/'master.dng', 'dng')
    result = save_layers(targets, image, reference, meta, 'dng',
                         {'calibration': {'counts': {'dark': 2, 'bias': 2}}, 'reference': 'middle.raw'},
                         time.monotonic(), lambda: None)
    np.testing.assert_array_equal(tifffile.imread(targets['master']), image)
    np.testing.assert_array_equal(tifffile.imread(targets['reference']), (reference@camera_to_prophoto(meta).T).astype(np.float32))
    np.testing.assert_array_equal(tifffile.imread(targets['sky']), (image@camera_to_prophoto(meta).T).astype(np.float32))
    assert result['calibration']['counts'] == {'dark': 2, 'bias': 2}
