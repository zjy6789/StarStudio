import hashlib
import json
import os

import numpy as np
import pytest
import tifffile

from backend.algorithms import stretch_curve, validate_image
from backend.protected_stretch import inspect_input, inspect_prepared, render_stretch, save_stretch
from backend.server import Store
from backend.stack_io import linear_profile, PROPHOTO_XYZ
from tests.test_protected_stretch import prepared, wait


def master(tmp_path, image=None):
    if image is None:
        level = np.geomspace(1e-5, .5, 1024).reshape(32, 32)
        image = (level[..., None]*[1., .6, .25]).astype('f4')
        image[0, 0] = [-.25, .02, 2.075]
        image[0, 1] = [-.1, -.01, -.0001]
        image[0, 2] = [-0., 0., np.nextafter(np.float32(0), np.float32(1))]
    path = tmp_path/'original.tif'
    tifffile.imwrite(path, image, photometric='rgb', metadata=None,
                     iccprofile=linear_profile(), software='Star Studio')
    return path, image


def render(image, info, settings):
    output = np.empty_like(image)
    return output, render_stretch(image, info, output, settings)


def test_original_zero_signed_values_highlights_and_zero_identity(tmp_path):
    path, image = master(tmp_path)
    before = hashlib.sha256(path.read_bytes()).digest()
    info = inspect_input(path, True)
    assert info['inputKind'] == 'linear-master' and info['minimum'] == -.25
    identity, details = render(image, info, dict(amount=0))
    np.testing.assert_array_equal(identity.view('u4'), image.view('u4'))
    assert details['stats']['maxStorageError'] == 0
    result, details = render(image, info, info['suggestion'])
    assert details['stats']['negativeChannels'] == np.count_nonzero(image < 0)
    assert details['stats']['aboveOneChannels'] > 0 and result.min() < 0
    assert np.array_equal(np.signbit(result), np.signbit(image))
    assert np.all(result[image != 0] != 0)
    assert not details['stats']['newBlackChannels'] and not details['stats']['newWhiteChannels']
    # The legacy bounded algorithms still refuse this output instead of clipping it.
    with pytest.raises(ValueError, match='0..1'):
        validate_image(result)
    assert hashlib.sha256(path.read_bytes()).digest() == before


def test_positive_common_gain_preserves_signed_rgb_and_qualified_xyz_ratios(tmp_path):
    path, image = master(tmp_path)
    info = inspect_input(path, True)
    output, details = render(image, info, dict(amount=4, protection=.8, background=.6))
    a, b = image.astype('f8'), output.astype('f8')
    peak = np.abs(a).max(axis=2, keepdims=True)
    mapped = stretch_curve(peak, details['curve'], dtype=np.float64, clip=False)
    expected = (a*np.divide(mapped, peak, out=np.ones_like(peak), where=peak > 0)).astype('f4')
    np.testing.assert_array_equal(output.view('u4'), expected.view('u4'))
    valid = (a.min(axis=2) > 1e-6) & (a.max(axis=2) < .9)
    xyz, out_xyz = a[valid]@PROPHOTO_XYZ.T, b[valid]@PROPHOTO_XYZ.T
    np.testing.assert_allclose(xyz/xyz.sum(axis=1, keepdims=True),
                               out_xyz/out_xyz.sum(axis=1, keepdims=True), atol=5e-8, rtol=0)
    np.testing.assert_array_equal(render(image, info, dict(amount=4, protection=.8, background=.6))[0], output)


@pytest.mark.parametrize('amount', [0, 1.7, 6, 10])
def test_bounded_master_and_prepared_paths_are_bit_identical(amount, tmp_path):
    levels = np.geomspace(1e-5, 1., 1024).reshape(32, 32)
    original, path, image = prepared(tmp_path, (levels[..., None]*[1., .6, .25]).astype('f4'))
    legacy = inspect_prepared(path, True)
    assert inspect_input(path, True) == legacy
    full = inspect_input(original, True)
    assert full['peakQuantiles'] == legacy['peakQuantiles']
    assert full['suggestion'] == legacy['suggestion']
    settings = dict(amount=amount, protection=.75, background=.8)
    a, _ = render(image, legacy, settings)
    b, _ = render(image, full, settings)
    np.testing.assert_array_equal(a.view('u4'), b.view('u4'))


@pytest.mark.parametrize('level', [-.25, 2.])
def test_uniform_signed_or_hdr_ranges_and_no_false_auto_suggestion(level, tmp_path):
    path, image = master(tmp_path, np.full((4, 4, 3), level, dtype='f4'))
    info = inspect_input(path, True)
    assert info['suggestion']['amount'] == 0
    result, details = render(image, info, dict(amount=3))
    assert details['stats']['minimum'] == float(result.min())
    assert details['stats']['maximum'] == float(result.max())
    if level < 0:
        assert info['sampleCount'] == 0 and result.max() < 0


def test_extreme_finite_values_stay_finite_but_float32_underflow_is_refused(tmp_path):
    maximum, tiny = np.finfo('f4').max, np.nextafter(np.float32(0), np.float32(1))
    path, image = master(tmp_path, np.array([[[maximum, -maximum/2, maximum/4], [-tiny, -0., tiny]]], dtype='f4'))
    info = inspect_input(path, True)
    result, _ = render(image, info, dict(amount=10))
    assert np.isfinite(result).all() and np.array_equal(np.signbit(image), np.signbit(result))
    image[0, 0] = [maximum, tiny, .1]
    with pytest.raises(ValueError, match='非零变零'):
        render(image, info, dict(amount=10))


@pytest.mark.parametrize('invalid', [np.nan, np.inf, -np.inf])
def test_nonfinite_master_and_missing_confirmation_are_not_auto_repaired(invalid, tmp_path):
    path, image = master(tmp_path)
    with pytest.raises(ValueError, match='确认'):
        inspect_input(path, False)
    image[0, 0, 0] = invalid
    tifffile.imwrite(path, image, photometric='rgb', metadata=None, iccprofile=linear_profile(), software='Star Studio')
    with pytest.raises(ValueError, match='NaN/Inf'):
        inspect_input(path, True)


def test_saved_output_has_distinct_provenance_no_repeat_stretch_or_source_overwrite(tmp_path):
    path, image = master(tmp_path)
    before = path.read_bytes()
    info = inspect_input(path, True)
    hardlink = tmp_path/'linked.tif'; os.link(path, hardlink)
    for amount, stage in [(0, 'linear-copy'), (3, 'developed')]:
        result, details = render(image, info, dict(amount=amount))
        for target in [path, hardlink]:
            with pytest.raises(ValueError, match='不能覆盖'):
                save_stretch(result, info, details, target)
        target = tmp_path/f'output-{amount}.tif'
        saved = save_stretch(result, info, details, target)
        with tifffile.TiffFile(target) as file:
            np.testing.assert_array_equal(file.asarray().view('u4'), result.view('u4'))
            assert file.pages[0].dtype == np.float32 and file.pages[0].tags[34675].value == linear_profile()
            record = json.loads(file.pages[0].description)
        assert record == saved['metadata'] and record['stage'] == stage
        assert record['kind'] == 'starstudio-full-range-stretch' and record['zeroPreserved']
        assert not record['rangeClipped'] and 'preparedProvenance' not in record
        assert record['precision']['negativeChannels'] > 0 and record['precision']['aboveOneChannels'] > 0
        with pytest.raises(ValueError, match='未拉伸'):
            inspect_input(target, True)
    assert path.read_bytes() == before


def test_source_change_and_save_cancellation_preserve_existing_output(tmp_path):
    path, image = master(tmp_path)
    info = inspect_input(path, True)
    result, details = render(image, info, dict(amount=3))
    target = tmp_path/'keep.tif'; target.write_bytes(b'keep')
    checks = [False, True]
    with pytest.raises(InterruptedError):
        save_stretch(result, info, details, target, canceled=lambda: checks.pop(0))
    assert target.read_bytes() == b'keep' and not list(tmp_path.glob('.starstudio-stretch-*'))
    with path.open('ab') as file:
        file.write(b'changed')
    with pytest.raises(ValueError, match='变化'):
        save_stretch(result, info, details, target)
    with pytest.raises(ValueError, match='变化'):
        render(image, info, dict(amount=3))
    assert target.read_bytes() == b'keep'


def test_store_master_job_chain_and_canceled_inspection_cleanup(tmp_path, monkeypatch):
    path, image = master(tmp_path)
    store = Store(tmp_path/'cache')
    inspected = wait(store, dict(op='stretchInspect', path=str(path), confirmedLinear=True))
    assert inspected['state'] == 'done', inspected
    info = inspected['result']; source = info['image']
    np.testing.assert_array_equal(store.get(source).view('u4'), image.view('u4'))
    rendered = wait(store, dict(op='stretchRender', image=source, settings=dict(amount=3)))
    assert rendered['state'] == 'done', rendered
    key = rendered['result']['image']
    target = tmp_path/'saved.tif'
    saved = wait(store, dict(op='stretchSave', image=key, output=str(target)))
    assert saved['state'] == 'done', saved
    np.testing.assert_array_equal(tifffile.imread(target).view('u4'), store.get(key).view('u4'))
    store.delete(source)
    assert wait(store, dict(op='stretchSave', image=key, output=str(target)))['state'] == 'error'
    store.delete(key)
    original_save = store.save
    def cancel_after_snapshot(array):
        key = original_save(array)
        next(j for j in store.jobs.values() if j['state'] == 'running')['cancel'] = True
        return key
    monkeypatch.setattr(store, 'save', cancel_after_snapshot)
    canceled = wait(store, dict(op='stretchInspect', path=str(path), confirmedLinear=True))
    assert canceled['state'] == 'canceled' and not store.images and not store.stretch_sources
    assert not list(store.path.glob('*.npy'))


def test_store_underflow_removes_partial_render_cache(tmp_path):
    tiny = np.nextafter(np.float32(0), np.float32(1))
    path, _ = master(tmp_path, np.array([[[np.finfo('f4').max, tiny, .1]]], dtype='f4'))
    store = Store(tmp_path/'cache')
    inspected = wait(store, dict(op='stretchInspect', path=str(path), confirmedLinear=True))
    source = inspected['result']['image']
    failed = wait(store, dict(op='stretchRender', image=source, settings=dict(amount=10)))
    assert failed['state'] == 'error' and list(store.images) == [source]
    assert not store.stretch_results
    store.delete(source)
