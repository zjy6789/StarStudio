import json

import numpy as np
import pytest
import tifffile

from backend import halo_masks
from backend.protection_masks import make_mask, save_mask
from backend.server import Store
from tests.test_server import wait_for_job


def scene(height=128, width=192, center=(48, 48)):
    y, x = np.mgrid[:height, :width]
    xx, yy = center
    radius = np.hypot(x-xx, y-yy)
    core = .8*np.exp(-radius**2/5)
    halo = .12*np.exp(-(radius-7)**2/4)
    image = np.repeat(core[..., None], 3, axis=2)
    image += halo[..., None]*[.7, 0, 1]
    # A red compact star and a faint diffuse blue object are not halo targets.
    image += (.7*np.exp(-((x-(width-35))**2+(y-45)**2)/5))[..., None]*[1, .25, .1]
    image += (.06*np.exp(-((x-(width-40))**2+(y-(height-28))**2)/100))[..., None]*[.1, .2, 1]
    return np.concatenate((image.astype(np.float32), np.ones((height, width, 1), np.float32)), axis=2), radius


def options(**changes):
    return dict(mode='halos', encoding='black', bits=32, low=.002, high=.02, grow=2, feather=1,
                bright=.25, radius=12, core=3, **changes)


def test_local_halo_core_and_remote_objects_are_preserved_and_source_is_unchanged():
    image, radius = scene()
    before = image.copy()
    mask, details = make_mask(image, options())
    assert mask[48, 55, 0] > .9
    assert np.all(mask[radius <= 3] == 0)
    assert np.all(mask[radius > 12] == 0)
    assert np.all(mask[35:55, -45:-25] == 0)  # Red star.
    assert details['candidateOnly'] is True and details['candidateStars'] == 2
    assert details['mode'] == 'halos' and details['radius'] == 12
    assert np.all((mask >= 0) & (mask <= 1))
    np.testing.assert_array_equal(image.view('u4'), before.view('u4'))


def test_signed_and_gray_encoded_positive_signal_agree_without_negative_correction_leakage():
    image, _ = scene()
    image[:10, :10, :3] = -.25
    signed, _ = make_mask(image, dict(options(), encoding='signed'))
    encoded = image.copy()
    encoded[..., :3] = (encoded[..., :3]+1)/2
    gray, _ = make_mask(encoded, dict(options(), encoding='gray', bits=16))
    np.testing.assert_allclose(gray, signed, atol=3e-5)
    assert np.all(gray[:10, :10] == 0)


def test_invisible_hdr_colors_do_not_create_candidates_and_fractional_alpha_scales_weights():
    image, _ = scene()
    opaque, _ = make_mask(image, options())
    image[..., 3] = .5
    image[:15, :15, :3] = np.finfo(np.float32).max
    image[:15, :15, 3] = 0
    partial, _ = make_mask(image, options())
    np.testing.assert_allclose(partial, opaque*.5, atol=1e-7)
    assert np.all(partial[:15, :15] == 0)


def test_detection_normalization_changes_only_derived_weights_and_supports_hdr():
    image, _ = scene()
    baseline, _ = make_mask(image, options())
    image[..., :3] *= 10
    before = image.copy()
    hdr, _ = make_mask(image, options())
    np.testing.assert_allclose(hdr, baseline, atol=1e-6)
    np.testing.assert_array_equal(image, before)


def test_tiled_detection_equals_single_tile_for_a_star_on_tile_boundary(monkeypatch):
    image, _ = scene(600, 820, (384, 383))
    tiled, _ = make_mask(image, options())
    monkeypatch.setattr(halo_masks, 'TILE', 1000)
    whole, _ = make_mask(image, options())
    np.testing.assert_array_equal(tiled, whole)


@pytest.mark.parametrize('changes', [dict(radius=3, core=3), dict(radius=65), dict(radius=True),
                                    dict(core=-1), dict(bright=0), dict(bright=float('nan')), dict(high=2)])
def test_invalid_geometry_and_thresholds_are_rejected(changes):
    image, _ = scene()
    with pytest.raises(ValueError):
        make_mask(image, dict(options(), **changes))


def test_gray_and_no_candidate_never_generate_an_empty_selection():
    with pytest.raises(ValueError, match='RGB'):
        make_mask(np.ones((64, 64, 1), np.float32), options())
    with pytest.raises(ValueError, match='没有可靠'):
        make_mask(np.zeros((64, 64, 3), np.float32), options())
    image, _ = scene()
    image[..., :3] = image[..., :3].max(axis=2, keepdims=True)
    with pytest.raises(ValueError, match='不应用空选区'):
        make_mask(image, options())


def test_cancel_and_float32_mask_save_preserve_the_input(tmp_path):
    image, _ = scene()
    before = image.copy()
    progress = []
    with pytest.raises(InterruptedError):
        make_mask(image, options(), progress.append, lambda: bool(progress and progress[-1] > .5))
    mask, details = make_mask(image, options())
    output = tmp_path/'halo.tif'
    save_mask(mask, details, output)
    with tifffile.TiffFile(output) as file:
        np.testing.assert_array_equal(file.asarray().view('u4'), mask[..., 0].view('u4'))
        record = json.loads(file.pages[0].description)
    assert record['candidateOnly'] is True and record['mode'] == 'halos'
    np.testing.assert_array_equal(image, before)


def test_job_reuses_mask_source_contract_and_can_save_the_candidate(tmp_path):
    image, _ = scene()
    store = Store(tmp_path/'store')
    h, w, c = image.shape
    key = store.create(w, h, c, 'mask-source')
    store.images[key]['data'][:] = image
    store.images[key].update(ready=True, rows=h)
    state = wait_for_job(store, store.job(dict(op='maskGenerate', image=key, options=options())))
    assert state['state'] == 'done', state
    details = state['result']
    assert details['candidateOnly'] is True
    output = tmp_path/'saved.tif'
    saved = wait_for_job(store, store.job(dict(op='maskSave', image=details['image'], output=str(output))))
    assert saved['state'] == 'done' and output.is_file()
    assert store.images[key]['purpose'] == 'mask-source'
