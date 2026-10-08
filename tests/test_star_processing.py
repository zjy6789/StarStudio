import time

import numpy as np
import pytest

from backend.star_processing import SIRIL, process_stars, luminance, curve_values
from backend.server import Store


def star_image(size=192):
    y, x = np.mgrid[:size, :size]
    stars = .65*np.exp(-((x-58)**2/50+(y-47)**2/6.48))
    stars += .12*np.exp(-((x-66)**2/35+(y-49)**2/9))
    stars += .35*np.exp(-((x-133)**2+(y-139)**2)/10)
    rgb = stars[..., None]*np.array([.75, 1, .6])
    return np.concatenate([rgb, np.ones((size, size, 1))], axis=2).astype(np.float32)


@pytest.mark.parametrize('channels', [1, 2, 3, 4])
def test_disabled_edits_identity_and_alpha(tmp_path, channels):
    image = np.random.default_rng(5).random((31, 29, channels), dtype=np.float32)
    image[0] = 0
    original = image.copy()
    result, details = process_stars(image, {}, tmp_path)
    np.testing.assert_array_equal(result, image)
    np.testing.assert_array_equal(image, original)
    assert result.dtype == np.float32
    assert details['reconstructedStars'] == 0


def test_curve_monotone_black_and_hue(tmp_path):
    v = np.linspace(0, 1, 1024, dtype=np.float32)
    curve = dict(enabled=True, shadows=.15, midtones=.62, highlights=.87)
    mapped = curve_values(v, curve)
    assert mapped[0] == 0 and mapped[-1] == 1
    assert np.min(np.diff(mapped)) >= 0
    image = np.array([[[.03, .06, .09, .8], [0, 0, 0, 0]]], dtype=np.float32)
    result, _ = process_stars(image, {'curve': curve}, tmp_path)
    np.testing.assert_allclose(result[0, 0, :3]/result[0, 0, 1], [.5, 1, 1.5], rtol=1e-6)
    np.testing.assert_array_equal(result[..., 3], image[..., 3])
    assert np.max(result[0, 1]) == 0
    with pytest.raises(ValueError, match='暗部'):
        process_stars(image, {'curve': dict(enabled=True, shadows=.8, midtones=.5)}, tmp_path)


def test_reduction_shrinks_and_preserves_hue(tmp_path):
    image = star_image()
    result, _ = process_stars(image, {'reduction': dict(enabled=True, strength=.8, radius=1.5, threshold=0, protect=1)}, tmp_path)
    assert np.sum(result[..., :3]) < np.sum(image[..., :3])*.85
    assert result[47, 58, 1] < image[47, 58, 1]
    np.testing.assert_allclose(result[47, 58, :3]/result[47, 58, 1], [.75, 1, .6], rtol=1e-6)
    np.testing.assert_array_equal(result[..., 3], image[..., 3])


def test_glow_selects_bright_sources_radius_and_range(tmp_path):
    image = np.zeros((192, 192, 4), dtype=np.float32)
    image[..., 3] = 1
    image[48, 48, :3] = [.4, .8, .2]
    image[145, 145, :3] = .1
    options = dict(enabled=True, strength=3, radius=5, lower=.3, upper=1, softness=.01, spread=0)
    result, _ = process_stars(image, {'glow': options}, tmp_path)
    assert result[48, 53, 1] > .003
    assert result[48, 48, 1] > image[48, 48, 1]
    assert result[145, 148, 1] == 0
    wide, _ = process_stars(image, {'glow': dict(options, radius=12)}, tmp_path)
    assert wide[48, 67, 1] > result[48, 67, 1]
    excluded, _ = process_stars(image, {'glow': dict(options, upper=.5)}, tmp_path)
    np.testing.assert_array_equal(excluded, image)
    with pytest.raises(ValueError, match='下限'):
        process_stars(image, {'glow': dict(options, lower=.8, upper=.5)}, tmp_path)


def test_invisible_rgb_does_not_generate_glow(tmp_path):
    image = np.zeros((41, 41, 4), dtype=np.float32)
    image[..., 3] = 1
    image[20, 20] = [1, 1, 1, 0]
    result, _ = process_stars(image, {'glow': dict(enabled=True, lower=.1)}, tmp_path)
    np.testing.assert_array_equal(result, image)


def test_saturation_luminance_and_gamut(tmp_path):
    image = np.array([[[.1, .3, .8, .42]]], dtype=np.float32)
    neutral, _ = process_stars(image, {'color': dict(enabled=True, saturation=0, protect=1)}, tmp_path)
    np.testing.assert_allclose(neutral[..., :3], np.broadcast_to(luminance(image[..., :3])[..., None], (1, 1, 3)))
    colorful, _ = process_stars(image, {'color': dict(enabled=True, saturation=2, protect=1)}, tmp_path)
    np.testing.assert_allclose(luminance(colorful[..., :3]), luminance(image[..., :3]), atol=1e-7)
    assert colorful.min() >= 0 and colorful.max() <= 1
    assert colorful[..., 3] == image[..., 3]


@pytest.mark.skipif(not SIRIL.is_file(), reason='Requires installed Siril 1.4+')
def test_siril_reconstruction_correct_position_roundness_and_float(tmp_path):
    image = star_image()
    result, details = process_stars(image, {'coma': dict(enabled=True, strength=1, radius=8, sigma=1, roundness=.9)}, tmp_path)
    assert details['reconstructedStars'] >= 1
    # The asymmetric, off-center fixture exposes swapped/vertical-flipped coordinates.
    assert np.max(np.abs(result[32:65, 35:90, :3]-image[32:65, 35:90, :3])) > .1
    np.testing.assert_array_equal(result[120:160, 120:160], image[120:160, 120:160])
    def ratio(a):
        a = a[32:65, 35:90, 1].astype(float)
        y, x = np.mgrid[:a.shape[0], :a.shape[1]]
        mx, my = np.sum(a*x)/a.sum(), np.sum(a*y)/a.sum()
        return np.sqrt(np.sum(a*(x-mx)**2)/np.sum(a*(y-my)**2))
    assert abs(ratio(result)-1) < abs(ratio(image)-1)*.3
    np.testing.assert_array_equal(result[..., 3], image[..., 3])
    assert result.dtype == np.float32
    assert not list(tmp_path.iterdir())


def test_processing_job_preview_and_full_match(tmp_path):
    store = Store(tmp_path)
    image = star_image()
    key = store.save(image)
    settings = {'curve': dict(enabled=True, midtones=.62), 'glow': dict(enabled=True, radius=4, lower=.3)}
    ids = [store.job(dict(op='processStars', image=key, settings=settings, preview=preview)) for preview in (True, False)]
    deadline = time.monotonic()+10
    while any(store.jobs[j]['state'] in ('queued', 'running') for j in ids) and time.monotonic() < deadline:
        time.sleep(.02)
    a, b = [store.jobs[j] for j in ids]
    assert a['state'] == b['state'] == 'done', (a, b)
    assert a['result']['preview'].startswith('data:image/png;base64,')
    assert len(a['result']['curve']) == 256
    np.testing.assert_array_equal(store.get(a['result']['image']), store.get(b['result']['image']))
    np.testing.assert_array_equal(store.get(key), image)
