import hashlib
import json
import os
import time

import numpy as np
import pytest
import tifffile

from backend.linear_preparation import inspect_master, prepare_master
from backend.protected_stretch import inspect_prepared, curve_parameters, render_stretch, save_stretch
from backend.server import Store
from backend.stack_io import linear_profile, PROPHOTO_XYZ


def prepared(tmp_path, image=None):
    if image is None:
        levels = np.r_[0., np.geomspace(1e-5, .9, 1022), 1.].reshape(32, 32)
        image = (levels[..., None]*[1., .6, .25]).astype('f4')
    original, output = tmp_path/'master.tif', tmp_path/'prepared.tif'
    tifffile.imwrite(original, image, photometric='rgb', metadata=None, iccprofile=linear_profile(), software='Star Studio')
    prepare_master(dict(path=str(original), output=str(output), confirmedLinear=True,
                        fingerprint=inspect_master(original)['fingerprint']))
    return original, output, tifffile.imread(output)


def render(image, info, settings):
    result = np.empty_like(image)
    details = render_stretch(image, info, result, settings)
    return result, details


def test_inspection_and_suggestion_leave_master_and_prepared_bytes_unchanged(tmp_path):
    master, path, image = prepared(tmp_path)
    before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in [master, path]]
    info = inspect_prepared(path, True)
    assert info['profile'] == 'Star Studio Linear ProPhoto RGB' and info['width'] == 32
    result, details = render(image, info, info['suggestion'])
    assert abs(np.median(result.max(axis=2))-.15) < 1e-4
    assert not details['stats']['newBlackChannels'] and not details['stats']['newWhiteChannels']
    assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in [master, path]] == before
    assert info['provenance']['mapping'] == {'offset': 0., 'scale': 1.}


def test_zero_identity_and_rgb_ratios_xyz_chromaticity(tmp_path):
    _, path, image = prepared(tmp_path)
    info = inspect_prepared(path, True)
    identity, details = render(image, info, dict(amount=0))
    np.testing.assert_array_equal(identity, image)
    assert details['stats']['maxStorageError'] == 0
    output, details = render(image, info, dict(amount=5, protection=.9, background=.7))
    nonblack = image.max(axis=2) > 0
    original_ratios = image[nonblack].astype(np.float64)/image[nonblack].max(axis=1, keepdims=True)
    actual_ratios = output[nonblack].astype(np.float64)/output[nonblack].max(axis=1, keepdims=True)
    np.testing.assert_allclose(actual_ratios, original_ratios, atol=1e-7)
    xyz = image[nonblack].astype(np.float64)@PROPHOTO_XYZ.T
    mapped_xyz = output[nonblack].astype(np.float64)@PROPHOTO_XYZ.T
    np.testing.assert_allclose(xyz/xyz.sum(axis=1, keepdims=True), mapped_xyz/mapped_xyz.sum(axis=1, keepdims=True), atol=5e-8)
    assert details['stats']['maxStorageError'] <= np.finfo(np.float32).eps/2
    np.testing.assert_array_equal(render(image, info, dict(amount=5, protection=.9, background=.7))[0], output)


def test_faint_positive_values_are_not_erased_by_primitive_cancellation(tmp_path):
    _, path, image = prepared(tmp_path)
    image[0,1] = np.nextafter(np.float32(0), np.float32(1))
    # Rewrite a valid prepared fixture with this test pixel, retaining its provenance.
    with tifffile.TiffFile(path) as f:
        description = f.pages[0].description
    tifffile.imwrite(path, image, photometric='rgb', metadata=None, description=description,
                     iccprofile=linear_profile(), software='Star Studio Linear Preparation')
    info = inspect_prepared(path, True)
    result, details = render(image, info, dict(amount=5))
    assert np.all(result[0,1] > 0) and details['stats']['newBlackChannels'] == 0
    assert details['stats']['minimum'] == 0


def test_colorful_highlights_do_not_get_clipped_or_neutralized(tmp_path):
    _, path, image = prepared(tmp_path)
    image[2,3] = [1., .03, .001]
    image[3,4] = [.005, .8, .02]
    info = inspect_prepared(path, True)
    result, details = render(image, info, dict(amount=8, protection=1, background=.8))
    np.testing.assert_array_equal(result[2,3], image[2,3])
    np.testing.assert_allclose(result[3,4]/result[3,4].max(), image[3,4]/image[3,4].max(), atol=1e-8)
    assert not details['stats']['newWhiteChannels']


def test_new_rounded_white_endpoint_is_reported_and_save_refused(tmp_path):
    _, path, image = prepared(tmp_path)
    image[2,3] = np.nextafter(np.float32(1), np.float32(0))
    info = inspect_prepared(path, True)
    result, details = render(image, info, dict(amount=10, protection=0))
    assert details['stats']['newWhiteChannels'] == 3
    target = tmp_path/'output.tif';target.write_bytes(b'previous')
    with pytest.raises(ValueError, match='新增黑/白端点'):
        save_stretch(result, info, details, target)
    assert target.read_bytes() == b'previous'


def test_save_provenance_identity_stage_and_duplicate_stretch_rejection(tmp_path):
    _, path, image = prepared(tmp_path)
    info = inspect_prepared(path, True)
    for amount, stage in [(0, 'linear-copy'), (4, 'developed')]:
        output, details = render(image, info, dict(amount=amount))
        target = tmp_path/f'output-{amount}.tif'
        saved = save_stretch(output, info, details, target)
        with tifffile.TiffFile(target) as f:
            np.testing.assert_array_equal(f.asarray(), output)
            assert f.pages[0].tags[34675].value == linear_profile()
            record = json.loads(f.pages[0].description)
        assert record == saved['metadata'] and record['stage'] == stage
        assert record['preparedProvenance'] == info['provenance'] and not record['displayStretch']
        with pytest.raises(ValueError, match='未拉伸'):
            inspect_prepared(target, True)


def test_confirmation_source_type_and_malformed_provenance_rejected(tmp_path):
    master, path, _ = prepared(tmp_path)
    with pytest.raises(ValueError, match='确认'):
        inspect_prepared(path, False)
    with pytest.raises(ValueError, match='不是未拉伸'):
        inspect_prepared(master, True)
    with tifffile.TiffFile(path) as f:
        data, description = f.asarray(), json.loads(f.pages[0].description)
    description['mapping']['scale'] = float('nan')
    tifffile.imwrite(path, data, photometric='rgb', metadata=None, description=json.dumps(description),
                     iccprofile=linear_profile(), software='Star Studio Linear Preparation')
    with pytest.raises(ValueError, match='映射'):
        inspect_prepared(path, True)


@pytest.mark.parametrize('invalid', ['icc', 'missing-icc', 'integer', 'gray', 'alpha', 'compressed', 'software'])
def test_unsupported_input_layout_and_profile_rejected(invalid, tmp_path):
    _, path, image = prepared(tmp_path)
    with tifffile.TiffFile(path) as f:
        description = f.pages[0].description
    profile, software, photometric = linear_profile(), 'Star Studio Linear Preparation', 'rgb'
    if invalid == 'icc': profile = b'not-the-required-profile'
    if invalid == 'missing-icc': profile = None
    if invalid == 'integer': image = (image*65535).astype('u2')
    if invalid == 'gray': image, photometric = image[..., 0], 'minisblack'
    if invalid == 'alpha': image = np.concatenate([image, np.ones((*image.shape[:2],1), dtype='f4')], axis=2)
    if invalid == 'software': software = 'Photoshop'
    tifffile.imwrite(path, image, photometric=photometric, metadata=None, description=description,
                     iccprofile=profile, software=software, compression='deflate' if invalid == 'compressed' else None)
    with pytest.raises(ValueError, match='本页需要|无压缩'):
        inspect_prepared(path, True)


def test_hdr_mapping_provenance_survives_stretch_without_claiming_original_color_ratios(tmp_path):
    values = np.array([[[-.125, .001, .2], [1., 2., 4.]], [[.01, .02, .03], [.1, .2, .3]]], dtype='f4')
    master, path, image = prepared(tmp_path, values)
    before = master.read_bytes()
    info = inspect_prepared(path, True)
    assert info['provenance']['mapping'] == {'offset': -.125, 'scale': 8.}
    output, details = render(image, info, dict(amount=2))
    target = tmp_path/'stretched.tif'
    saved = save_stretch(output, info, details, target)
    assert saved['metadata']['preparedProvenance']['mapping'] == {'offset': -.125, 'scale': 8.}
    assert master.read_bytes() == before


@pytest.mark.parametrize('bad', [np.nan, np.inf, -.01, 1.01])
def test_invalid_pixels_do_not_get_clipped(bad, tmp_path):
    _, path, image = prepared(tmp_path)
    with tifffile.TiffFile(path) as f:
        description = f.pages[0].description
    image[0,0,0] = bad
    tifffile.imwrite(path, image, photometric='rgb', metadata=None, description=description,
                     iccprofile=linear_profile(), software='Star Studio Linear Preparation')
    with pytest.raises(ValueError, match='0..1'):
        inspect_prepared(path, True)


def test_source_change_original_paths_hardlink_and_cancellation(tmp_path):
    master, path, image = prepared(tmp_path)
    info = inspect_prepared(path, True)
    result, details = render(image, info, dict(amount=4))
    for target in [master, path]:
        with pytest.raises(ValueError, match='不能覆盖'):
            save_stretch(result, info, details, target)
    hard = tmp_path/'hardlink.tif';os.link(path, hard)
    with pytest.raises(ValueError, match='不能覆盖'):
        save_stretch(result, info, details, hard)
    output = tmp_path/'output.tif';output.write_bytes(b'keep')
    checks = [False, True]
    with pytest.raises(InterruptedError):
        save_stretch(result, info, details, output, lambda: checks.pop(0))
    assert output.read_bytes() == b'keep' and not list(tmp_path.glob('.starstudio-stretch-*'))
    with pytest.raises(InterruptedError):
        render_stretch(image, info, np.empty_like(image), dict(amount=4), canceled=lambda: True)
    with path.open('ab') as f:
        f.write(b'changed')
    with pytest.raises(ValueError, match='变化'):
        render(image, info, dict(amount=4))


@pytest.mark.parametrize('settings', [dict(amount=np.nan), dict(amount=11), dict(protection=-.1), dict(background=1.1)])
def test_parameter_contract(settings):
    with pytest.raises(ValueError):
        curve_parameters(settings, .01)


def test_flat_input_explains_no_automatic_suggestion(tmp_path):
    _, path, _ = prepared(tmp_path, np.full((32,32,3), .1, dtype='f4'))
    info = inspect_prepared(path, True)
    assert info['suggestion']['amount'] == 0 and '平坦' in info['suggestionReason']


def wait(store, request):
    key = store.job(request)
    for _ in range(500):
        state = store.jobs[key]
        if state['state'] not in ('queued', 'running'):
            return state
        time.sleep(.01)
    raise AssertionError(state)


def test_store_snapshots_render_output_and_save_contract(tmp_path):
    _, path, image = prepared(tmp_path)
    store = Store(tmp_path/'cache')
    inspected = wait(store, dict(op='stretchInspect', path=str(path), confirmedLinear=True))
    assert inspected['state'] == 'done', inspected
    info = inspected['result'];source = info['image']
    result = wait(store, dict(op='stretchRender', image=source, settings=dict(amount=4)))
    assert result['state'] == 'done', result
    key = result['result']['image']
    expected, _ = render(image, info, dict(amount=4))
    np.testing.assert_array_equal(store.get(key), expected)
    target = tmp_path/'applied.tif'
    saved = wait(store, dict(op='stretchSave', image=key, output=str(target)))
    assert saved['state'] == 'done', saved
    np.testing.assert_array_equal(tifffile.imread(target), expected)
    count = len(store.images)
    bad = wait(store, dict(op='stretchRender', image=source, settings=dict(amount=11)))
    assert bad['state'] == 'error' and len(store.images) == count
    store.delete(source)
    assert wait(store, dict(op='stretchSave', image=key, output=str(target)))['state'] == 'error'
    store.delete(key)
    assert not store.stretch_sources and not store.stretch_results


def test_canceled_render_cleans_partial_output_and_preserves_source(tmp_path, monkeypatch):
    import backend.protected_stretch as module
    _, path, _ = prepared(tmp_path)
    store = Store(tmp_path/'cache')
    inspected = wait(store, dict(op='stretchInspect', path=str(path), confirmedLinear=True))
    assert inspected['state'] == 'done'
    source = inspected['result']['image']
    def cancel(*args, **kwargs):
        next(j for j in store.jobs.values() if j['state'] == 'running')['cancel'] = True
        raise InterruptedError('cancel')
    monkeypatch.setattr(module, 'render_stretch', cancel)
    failed = wait(store, dict(op='stretchRender', image=source, settings=dict(amount=4)))
    assert failed['state'] == 'canceled' and list(store.images) == [source]
    assert not store.stretch_results
    store.delete(source)
