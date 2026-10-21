import numpy as np
import pytest
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from backend.sky_color import fit_color, render_color
from backend.server import Handler, Store
from backend.star_processing import luminance
from tests.test_server import wait_for_job


def fixture():
    rng = np.random.default_rng(10)
    image = np.zeros((96, 128, 4), np.float32)
    image[..., :3] = [.06, .04, .03]+rng.normal(0, .0005, (96, 128, 3))
    image[..., 3] = 1
    image[50:75, 35:85, :3] = [.25, .18, .1]
    image[10:13, 10:13, :3] = 1
    sample = np.zeros((96, 128, 1), np.float32)
    sample[:40] = 1
    protection = np.zeros_like(sample)
    return image, sample, protection


def rendered(image, model, options, protection=None, view="result"):
    output = np.empty_like(image)
    stats = render_color(image, model, output, options, protection, view)
    return output, stats


def test_local_background_neutralization_and_constant_offset_not_white_balance():
    image, sample, protection = fixture()
    before = image.copy()
    model = fit_color(image, sample)
    output, stats = rendered(image, model, dict(neutral=1), protection)
    med = np.median(output[:40, :, :3][image[:40, :, :3].max(axis=2)<.95], axis=0)
    assert np.ptp(med) < 3e-5
    np.testing.assert_allclose(output[60, 50, :3]-image[60, 50, :3], model['offset'], atol=2e-8)
    np.testing.assert_array_equal(output[10:13, 10:13], image[10:13, 10:13])
    np.testing.assert_array_equal(output[..., 3], image[..., 3])
    np.testing.assert_array_equal(image, before)
    assert stats['aboveOneChannels'] == 0


def test_zero_effect_and_fully_protected_pixels_are_bit_identical_including_hdr():
    image, sample, protection = fixture()
    image[85, 20] = [-.125, .25, 1.5, .5]
    image[85, 21] = [-0., np.nextafter(np.float32(0), np.float32(1)), np.finfo(np.float32).max, 0]
    model = fit_color(image, sample)
    output, _ = rendered(image, model, {})
    np.testing.assert_array_equal(output.view(np.uint32), image.view(np.uint32))
    output, _ = rendered(image, model, dict(neutral=1, boost=1), np.ones_like(protection))
    np.testing.assert_array_equal(output.view(np.uint32), image.view(np.uint32))
    boosted, _ = rendered(image, model, dict(boost=1))
    np.testing.assert_array_equal(boosted[85, 20:22].view(np.uint32), image[85, 20:22].view(np.uint32))


def test_background_noise_and_bright_cores_protected_while_subject_chroma_increases():
    image, sample, protection = fixture()
    model = fit_color(image, sample)
    result, stats = rendered(image, model, dict(boost=.7, backgroundFactor=3))
    np.testing.assert_array_equal(result[10:13, 10:13], image[10:13, 10:13])
    dark = luminance(image[..., :3]) <= stats['darkThreshold']
    np.testing.assert_array_equal(result[dark], image[dark])
    assert dark[:40].mean() > .99
    assert np.ptp(result[60, 50, :3]) > np.ptp(image[60, 50, :3])
    np.testing.assert_allclose(luminance(result[50:75, 35:85, :3]), luminance(image[50:75, 35:85, :3]), atol=2e-8)
    protection[50:75, 35:85] = 1
    protected, _ = rendered(image, model, dict(boost=1, neutral=1), protection)
    np.testing.assert_array_equal(protected[50:75, 35:85], image[50:75, 35:85])


def test_weight_view_matches_effect_eligibility_and_retains_source_alpha():
    image, sample, protection = fixture()
    image[80, 80] = [-.1, .5, .3, .5]
    image[80, 81] = [.2, .1, .05, 0]
    model = fit_color(image, sample)
    weights, _ = rendered(image, model, dict(boost=.5), view='weights')
    assert weights[60, 50, 0] > 0
    assert weights[80, 80, 0] == weights[80, 81, 0] == 0
    np.testing.assert_array_equal(weights[..., 3], image[..., 3])


def test_neutralizing_blue_cast_cannot_move_dark_noise_into_the_enhancement_gate():
    image, sample, _ = fixture()
    image[..., :3] += np.array([-.04, -.01, .04], np.float32)
    model = fit_color(image, sample)
    neutral, _ = rendered(image, model, dict(neutral=1))
    combined, stats = rendered(image, model, dict(neutral=1, boost=1, backgroundFactor=3))
    dark = luminance(image[..., :3]) <= stats['darkThreshold']
    assert dark[:40].mean() > .99
    # Neutralization raises numerical luminance by much more than background MAD;
    # protection must still be measured against the unchanged input snapshot.
    assert np.median(luminance(neutral[:40, :, :3])) > stats['darkThreshold']
    np.testing.assert_array_equal(combined[dark], neutral[dark])
    assert np.ptp(combined[60, 50, :3]) > np.ptp(neutral[60, 50, :3])


def test_small_sparse_roi_is_not_missed_by_canvas_subsampling_and_outliers_rejected():
    image = np.full((800, 900, 3), [.04, .03, .02], np.float32)
    selection = np.zeros((800, 900, 1), np.float32)
    selection[1:11, 1:11] = 1
    image[2:4, 2:4] = .8
    model = fit_color(image, selection)
    assert model['candidates'] == model['sampled'] == 100
    assert model['rejected'] == 4
    np.testing.assert_allclose(model['median'], [.04, .03, .02])
    selection[:] = 1
    full = fit_color(image, selection)
    assert full['sampled'] <= 200000


@pytest.mark.parametrize('change', ['missing','empty','protected','wrong_shape','gray','nan','transparent'])
def test_invalid_sampling_fails_without_modifying_photo(change):
    image, sample, protection = fixture()
    if change == 'missing': sample = None
    if change == 'empty': sample[:] = 0
    if change == 'protected': protection[:] = 1
    if change == 'wrong_shape': sample = sample[:10]
    if change == 'gray': image = image[..., :1]
    if change == 'nan': image[0, 0, 0] = np.nan
    if change == 'transparent': image[..., 3] = .5
    with pytest.raises(ValueError): fit_color(image, sample, protection)


def test_color_cache_typed_source_cleanup_and_cancel(tmp_path):
    image, sample, protection = fixture()
    store = Store(tmp_path)
    key = store.create(128, 96, 4, 'color-source')
    store.images[key]['data'][:] = image
    store.images[key].update(ready=True, rows=96)
    selection = store.save(sample)
    fit = wait_for_job(store, store.job(dict(op='colorFit', image=key, sampling=selection)))
    assert fit['state'] == 'done', fit
    result = wait_for_job(store, store.job(dict(op='colorRender', image=key, options={'neutral': .5})))
    assert result['state'] == 'done', result
    np.testing.assert_array_equal(store.get(result['result']['image']), rendered(image, fit['result'], {'neutral': .5})[0])
    with pytest.raises(ValueError, match='专用来源'): store.get(key)
    with store.worker:
        canceled = store.job(dict(op='colorRender', image=key, options={}))
        store.jobs[canceled]['cancel'] = True
    assert wait_for_job(store, canceled)['state'] == 'canceled'
    store.delete(key)
    assert not store.color_models
    with pytest.raises(InterruptedError): fit_color(image, sample, canceled=lambda: True)
    with pytest.raises(InterruptedError): render_color(image, fit['result'], np.empty_like(image), {}, canceled=lambda: True)


def test_late_cancel_and_bad_render_release_model_or_output(tmp_path):
    image, sample, _ = fixture()
    flag = []
    with pytest.raises(InterruptedError):
        fit_color(image, sample, progress=lambda x: flag.append(1) if x == 1 else None, canceled=lambda: bool(flag))
    store = Store(tmp_path)
    key = store.create(128, 96, 4, 'color-source')
    store.images[key]['data'][:] = image
    store.images[key].update(ready=True, rows=96)
    selection = store.save(sample)
    assert wait_for_job(store, store.job(dict(op='colorFit', image=key, sampling=selection)))['state'] == 'done'
    before = set(store.images)
    assert wait_for_job(store, store.job(dict(op='colorRender', image=key, options={'boost': 4})))['state'] == 'error'
    assert set(store.images) == before
    assert wait_for_job(store, store.job(dict(op='colorFit', image=key, sampling=store.save(np.zeros_like(sample)))))['state'] == 'error'
    assert key not in store.color_models


@pytest.mark.parametrize('options', [{'neutral': -1}, {'boost': 2}, {'bright': .95}, {'backgroundFactor': float('nan')}])
def test_invalid_settings(options):
    image, sample, _ = fixture()
    with pytest.raises(ValueError): rendered(image, fit_color(image, sample), options)


def test_http_color_route_preserves_float_input_and_rejects_other_purposes(tmp_path):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.store, server.token = Store(tmp_path), 'test'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def api(path, data=None, raw=False):
        body = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path, body, headers={'X-Star-Token':'test'})
        with opener.open(request) as reply: return reply.read() if raw else json.load(reply)
    try:
        image, sample, _ = fixture()
        image[90, 30] = [-.1, .2, 1.5, .5]
        key = api('/color-sources', dict(width=128, height=96, components=4))['id']
        assert api(f'/color-sources/{key}?y=0&rows=96', image.tobytes())['ready']
        np.testing.assert_array_equal(np.frombuffer(api(f'/color-sources/{key}?y=0&rows=96', raw=True), dtype='<f4').reshape(image.shape), image)
        for route in ['images', 'mask-sources']:
            with pytest.raises(urllib.error.HTTPError): api(f'/{route}/{key}?y=0&rows=96', raw=True)
        mask = server.store.save(sample)
        fit = api('/jobs', dict(op='colorFit', image=key, sampling=mask))['id']
        assert wait_for_job(server.store, fit)['state'] == 'done'
        task = api('/jobs', dict(op='colorRender', image=key, options={'neutral':.5}))['id']
        result = wait_for_job(server.store, task)
        assert result['state'] == 'done', result
        pixels = np.frombuffer(api(f"/images/{result['result']['image']}?y=0&rows=96", raw=True), dtype='<f4').reshape(image.shape)
        np.testing.assert_array_equal(pixels[..., 3], image[..., 3])
    finally:
        server.shutdown()
        server.server_close()
