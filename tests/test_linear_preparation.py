import hashlib
import json
import time

import numpy as np
import pytest
import tifffile

from backend.algorithms import validate_image
from backend.linear_preparation import inspect_master, prepare_master
from backend.stack_io import linear_profile, write_result
from backend.server import Store


def master(tmp_path, values=None):
    values = np.array([[[-.125, .001, .25], [1, 2, 4]],
                       [[0, .01, .5], [.1, .4, .8]]], dtype=np.float32) if values is None else values
    path = tmp_path/'linear_master.tif'
    write_result(path, values, {'space': 'prophoto'}, 'tiff32')
    return path, values


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def request(path, output, **kwargs):
    return dict(path=str(path), output=str(output), confirmedLinear=True,
                fingerprint=inspect_master(path)['fingerprint'], **kwargs)


def test_hdr_master_has_independent_entry_and_explicit_common_mapping(tmp_path):
    path, image = master(tmp_path)
    original = digest(path)
    with pytest.raises(ValueError):
        validate_image(image)
    info = inspect_master(path)
    assert info['mapping'] == {'offset': -.125, 'scale': 8.0}
    assert info['stats']['negativeChannels'] == 1
    assert info['stats']['aboveOneChannels'] == 2
    assert info['width'] == 2 and info['height'] == 2
    output = tmp_path/'prepared.tif'
    result = prepare_master(request(path, output))
    actual = tifffile.imread(output)
    expected = ((image.astype(np.float64)+.125)/8).astype(np.float32)
    np.testing.assert_array_equal(actual, expected)
    assert actual.dtype == np.float32 and actual.min() >= 0 and actual.max() <= 1
    assert digest(path) == original
    with tifffile.TiffFile(output) as f:
        assert f.pages[0].tags[34675].value == linear_profile()
        metadata = json.loads(f.pages[0].description)
    assert metadata == result['metadata']
    assert metadata['stage'] == 'range-prepared-linear'
    assert metadata['nonlinearStretch'] is False and metadata['displayStretch'] is False
    error = np.abs(actual.astype(np.float64)*8-.125-image)
    assert metadata['rounding']['maxAbsError'] == error.max()
    assert metadata['rounding']['changedChannels'] == np.count_nonzero(error)
    with pytest.raises(ValueError, match='已准备'):
        inspect_master(output)


@pytest.mark.parametrize('high', [1., 2., 2.5, 4., 8.])
def test_positive_mapping_uses_exact_binary_scale_and_keeps_rgb_ratios(tmp_path, high):
    image = np.array([[[.125, .25, .5], [0, .75, high]]], dtype=np.float32)
    path, _ = master(tmp_path, image)
    output = tmp_path/'prepared.tif'
    result = prepare_master(request(path, output))
    actual = tifffile.imread(output)
    scale = result['metadata']['mapping']['scale']
    assert scale == 2**np.ceil(np.log2(high))
    np.testing.assert_array_equal(actual.astype(np.float64)*scale, image)
    assert result['metadata']['rounding']['maxAbsError'] == 0
    if high == 1:
        np.testing.assert_array_equal(actual, image)


def test_extreme_finite_float32_range_and_rounding_are_reported(tmp_path):
    limit = np.finfo(np.float32).max
    image = np.array([[[-limit, limit, 1e-20], [0, .5, -.5]]], dtype=np.float32)
    path, _ = master(tmp_path, image)
    result = prepare_master(request(path, tmp_path/'prepared.tif'))
    actual = tifffile.imread(result['path'])
    assert np.isfinite(actual).all() and actual.min() >= 0 and actual.max() <= 1
    assert result['metadata']['rounding']['changedChannels'] > 0
    assert result['metadata']['rounding']['maxAbsError'] > 0


@pytest.mark.parametrize('value', [np.nan, np.inf, -np.inf])
def test_nonfinite_pixels_are_rejected_without_substitution(tmp_path, value):
    image = np.full((2, 3, 3), .1, dtype=np.float32)
    image[1, 1, 0] = value
    path, _ = master(tmp_path, image)
    before = digest(path)
    with pytest.raises(ValueError, match='NaN|Inf'):
        inspect_master(path)
    assert digest(path) == before


@pytest.mark.parametrize('case', ['profile', 'missing-profile', 'uint16', 'alpha', 'gray', 'producer', 'compressed'])
def test_unsupported_sources_are_rejected_before_output(tmp_path, case):
    path = tmp_path/'unsupported.tif'
    data = np.ones((3, 5, 4 if case == 'alpha' else 3), dtype=np.uint16 if case == 'uint16' else np.float32)
    if case == 'gray':
        data = data[..., 0]
    profile = None if case == 'missing-profile' else linear_profile().replace(b'Star Studio', b'Other Space') if case == 'profile' else linear_profile()
    tifffile.imwrite(path, data, photometric='minisblack' if case == 'gray' else 'rgb',
                     iccprofile=profile, software='Photoshop' if case == 'producer' else 'Star Studio',
                     compression='deflate' if case == 'compressed' else None, metadata=None)
    with pytest.raises(ValueError):
        inspect_master(path)
    assert not list(tmp_path.glob('*prepared*'))


def test_confirmation_changed_source_and_source_output_are_guarded(tmp_path):
    path, image = master(tmp_path)
    output = tmp_path/'prepared.tif'
    req = request(path, output)
    with pytest.raises(ValueError, match='确认'):
        prepare_master(dict(req, confirmedLinear=False))
    with pytest.raises(ValueError, match='母版'):
        prepare_master(dict(req, output=str(path)))
    link = tmp_path/'hardlink.tif'
    link.hardlink_to(path)
    with pytest.raises(ValueError, match='母版'):
        prepare_master(dict(req, output=str(link)))
    write_result(path, image*.9, {'space': 'prophoto'}, 'tiff32')
    with pytest.raises(ValueError, match='变化|重新检查'):
        prepare_master(req)
    assert not output.exists()


def test_cancel_before_commit_preserves_existing_target_and_cleans_scratch(tmp_path):
    path, _ = master(tmp_path, np.full((256, 16, 3), 1.5, dtype=np.float32))
    output = tmp_path/'prepared.tif'
    output.write_bytes(b'previous target')
    progress = []
    with pytest.raises(InterruptedError):
        prepare_master(request(path, output), progress.append, lambda: bool(progress and progress[-1] > .3))
    assert output.read_bytes() == b'previous target'
    assert not list(tmp_path.glob('.starstudio-prepare-*'))


def test_job_contract_handles_preparation_and_cancel_without_loosening_upload(tmp_path):
    path, image = master(tmp_path)
    store = Store(tmp_path/'bridge')
    def wait(key):
        deadline = time.monotonic()+10
        while store.jobs[key]['state'] in ('queued', 'running') and time.monotonic() < deadline:
            time.sleep(.01)
        return store.jobs[key]
    inspected = wait(store.job(dict(op='prepareInspect', path=str(path))))
    assert inspected['state'] == 'done', inspected
    prepared = wait(store.job(dict(op='prepareLinear', **request(path, tmp_path/'prepared.tif'))))
    assert prepared['state'] == 'done', prepared
    assert prepared['result']['metadata']['stats']['min'] == float(image.min())
    with store.worker:
        key = store.job(dict(op='prepareInspect', path=str(path)))
        store.jobs[key]['cancel'] = True
    assert wait(key)['state'] == 'canceled'
