import time

import numpy as np
import pytest

from backend.star_processing import SIRIL, process_stars, luminance, curve_values, gaussian_halo
from scipy.ndimage import gaussian_filter
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


@pytest.mark.parametrize('encoding', ['gray', 'signed'])
def test_corrected_stars_keep_negative_signal_and_alpha_during_processing(tmp_path, encoding):
    signed = np.random.default_rng(2).uniform(-.3, .3, (31, 29, 4)).astype(np.float32)
    signed[..., 3] = np.random.default_rng(3).random((31, 29), dtype=np.float32)
    signed[0, :, 3] = 0
    image = signed.copy()
    if encoding == 'gray':
        image[..., :3] = (image[..., :3]+1)/2
    neutral, _ = process_stars(image, {}, tmp_path, encoding=encoding)
    np.testing.assert_array_equal(neutral, image)
    positive = image.copy()
    decoded = image[..., :3]*2-1 if encoding == 'gray' else image[..., :3]
    positive[..., :3] = np.maximum(decoded, 0)
    settings = {'curve': {'enabled': True, 'exposure': .5},
                'glow': {'enabled': True, 'radius': 2, 'lower': .05}}
    expected, _ = process_stars(positive, settings, tmp_path)
    expected[..., :3] += np.minimum(decoded, 0)
    if encoding == 'gray':
        expected[..., :3] = (expected[..., :3]+1)/2
    expected[0] = image[0]
    result, _ = process_stars(image, settings, tmp_path, encoding=encoding)
    np.testing.assert_array_equal(result, expected)
    np.testing.assert_array_equal(result[..., 3], image[..., 3])


@pytest.mark.parametrize('encoding', ['gray', 'signed'])
def test_corrected_processing_rejects_out_of_range_instead_of_truncating(tmp_path, encoding):
    for value in [-1.1, 1.1, float('nan')]:
        image = np.full((2, 3, 3), value, dtype=np.float32)
        with pytest.raises(ValueError):
            process_stars(image, {}, tmp_path, encoding=encoding)


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


@pytest.mark.parametrize('sigma', [.5, 12, 31.875, 32, 120, 360])
@pytest.mark.parametrize('channels', [1, 3])
def test_full_resolution_gaussian_matches_finite_reflected_filter(sigma, channels):
    # Asymmetric edges expose periodic, zero, or whole-sample mirror padding.
    image = np.random.default_rng(17).random((173, 149, channels), dtype=np.float32)
    image[:9, :23] = 0
    image[0, -1] = 1
    image[83, 61] = 1
    expected = gaussian_filter(image, (sigma, sigma, 0), mode='reflect')
    actual = gaussian_halo(image, sigma)
    assert actual.shape == image.shape and actual.dtype == np.float32
    np.testing.assert_allclose(actual, expected, rtol=0, atol=5e-7)


def test_glow_cache_reuses_strength_and_invalidates_upstream(tmp_path, monkeypatch):
    calls = []
    def blur(source, sigma):
        calls.append(sigma)
        return gaussian_halo(source, sigma)
    monkeypatch.setattr('backend.star_processing.gaussian_halo', blur)
    image, cache = star_image(), {}
    settings = {'glow': dict(enabled=True, radius=12, lower=.3, strength=1)}
    first, _ = process_stars(image, settings, tmp_path, cache=cache)
    assert calls == [12, 36]
    halo = cache['glow']['halo']
    settings['glow']['strength'] = 2
    cached, _ = process_stars(image, settings, tmp_path, cache=cache)
    assert calls == [12, 36]
    assert cache['glow']['halo'] is halo
    fresh, _ = process_stars(image, settings, tmp_path)
    np.testing.assert_array_equal(cached, fresh)
    assert np.max(np.abs(first-cached)) > 0
    settings['curve'] = dict(enabled=True, midtones=.62)
    process_stars(image, settings, tmp_path, cache=cache)
    assert cache['glow']['halo'] is not halo
    assert calls == [12, 36]*3
    assert set(cache) == {'glow'}


@pytest.mark.skipif(not SIRIL.is_file(), reason='Requires installed Siril 1.4+')
def test_coma_cache_reuses_detection_for_strength(tmp_path, monkeypatch):
    from backend import star_processing
    run, calls = star_processing.subprocess.run, []
    def tracked(*args, **kwargs):
        calls.append(args[0])
        return run(*args, **kwargs)
    monkeypatch.setattr(star_processing.subprocess, 'run', tracked)
    image, cache = star_image(), {}
    settings = {'coma': dict(enabled=True, strength=.3, radius=8, sigma=1, roundness=.9)}
    process_stars(image, settings, tmp_path, cache=cache)
    correction = cache['coma']['correction']
    settings['coma']['strength'] = .8
    cached, _ = process_stars(image, settings, tmp_path, cache=cache)
    assert len(calls) == 1 and cache['coma']['correction'] is correction
    fresh, _ = process_stars(image, settings, tmp_path)
    np.testing.assert_array_equal(cached, fresh)
    settings['coma']['roundness'] = .8
    process_stars(image, settings, tmp_path, cache=cache)
    assert len(calls) == 3 and cache['coma']['correction'] is not correction


@pytest.mark.parametrize('encoding', ['black', 'gray', 'signed'])
def test_neutral_enabled_controls_preserve_source_and_negative_correction(tmp_path, encoding):
    image = np.random.default_rng(73).random((37, 43, 4), dtype=np.float32)
    if encoding == 'signed':
        image[..., :3] -= .4
    original = image.copy()
    settings = {'coma': dict(enabled=True, strength=0),
                'reduction': dict(enabled=True, strength=0),
                'curve': dict(enabled=True, exposure=0),
                'color': dict(enabled=True, saturation=1),
                'glow': dict(enabled=True, strength=0)}
    result, details = process_stars(image, settings, tmp_path, encoding=encoding)
    # Existing float arithmetic can round neutral colour/encoding operations.
    np.testing.assert_allclose(result, original, rtol=0, atol=1e-7)
    np.testing.assert_array_equal(result[..., 3], original[..., 3])
    np.testing.assert_array_equal(image, original)
    negative = original[..., :3] < (.5 if encoding == 'gray' else 0)
    np.testing.assert_array_equal(result[..., :3][negative], original[..., :3][negative])
    assert details['reconstructedStars'] == 0


@pytest.mark.parametrize('sigma', [.8, 1.5, 3])
def test_natural_control_starting_radius_depends_on_star_pixels_not_canvas_size(tmp_path, sigma):
    patches = []
    for height, width in [(96, 96), (192, 256), (512, 768)]:
        y, x = np.mgrid[:height, :width]
        cy, cx = height//2, width//2
        stars = .9*np.exp(-((x-cx)**2+(y-cy)**2)/(2*sigma*sigma))
        stars += .004*np.exp(-((x-(cx-28))**2+(y-(cy-28))**2)/8)
        image = np.concatenate([np.repeat(stars[..., None], 3, axis=2),
                                np.ones((height, width, 1))], axis=2).astype(np.float32)
        original = image.copy()
        result, _ = process_stars(image, {'reduction': dict(enabled=True, strength=.25,
                                  radius=1, threshold=.01, protect=.8)}, tmp_path)
        before = image[cy-16:cy+17, cx-16:cx+17, :3]
        after = result[cy-16:cy+17, cx-16:cx+17, :3]
        loss = 1-after.sum()/before.sum()
        assert 0 < loss < .25
        assert result[cy, cx, 0] > image[cy, cx, 0]*.75
        np.testing.assert_array_equal(result[cy-34:cy-21, cx-34:cx-21], image[cy-34:cy-21, cx-34:cx-21])
        np.testing.assert_array_equal(result[..., 3], image[..., 3])
        np.testing.assert_array_equal(image, original)
        patches.append(after)
    # Padding a photograph does not justify increasing its morphological radius.
    for patch in patches[1:]:
        np.testing.assert_array_equal(patch, patches[0])
