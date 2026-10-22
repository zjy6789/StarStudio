import time
import numpy as np
import pytest
from backend.background import fit_background, render_background, distribution
from backend.server import Store


def fixture(n=3):
    y, x = np.mgrid[-1:1:256j, -1:1:320j]
    plane = np.stack([.25+.04*x+.03*y, .3-.03*x+.02*y, .2+.02*x-.04*y], axis=2)[..., :n].astype('f4')
    body = (.12*np.exp(-((x/.25)**2+(y/.4)**2)))[..., None].astype('f4')
    protection = ((x/.65)**2+(y/.9)**2 < 1)[..., None].astype('f4')
    return plane+body, plane, body, protection


def render(image, model, strength=1, view='result'):
    output = np.empty_like(image)
    stats = render_background(image, model, output, strength, view)
    return output, stats


@pytest.mark.parametrize('n', [1, 3])
def test_known_gradient_removed_and_diffuse_body_preserved(n):
    image, plane, body, protection = fixture(n)
    model = fit_background(image, protection)
    result, _ = render(image, model)
    baseline = np.asarray(model['reference'])
    np.testing.assert_allclose(result-body, np.broadcast_to(baseline, result.shape), atol=6e-4)
    np.testing.assert_allclose(np.asarray(model['coefficients'])[1:], [[.04, -.03, .02][:n], [.03, .02, -.04][:n]], atol=5e-4)
    assert model['samples'] >= 12 and model['samplingPreview'].startswith('data:image/png;base64,')


def test_zero_identity_alpha_edges_and_stable_input():
    image, _, _, protection = fixture()
    alpha = np.ones((*image.shape[:2], 1), 'f4')
    alpha[:, :25] = .4;alpha[-20:] = 0
    image = np.concatenate([image, alpha], axis=2)
    image[:, :25, :3] = .99;image[-20:, :, :3] = 0
    original = image.copy()
    model = fit_background(image, protection)
    zero, _ = render(image, model, 0)
    np.testing.assert_array_equal(zero, original)
    full, _ = render(image, model)
    half, _ = render(image, model, .5)
    np.testing.assert_allclose(half[..., :3], (image[..., :3]+full[..., :3])/2, atol=4e-8)
    np.testing.assert_array_equal(full[..., 3], alpha[..., 0])
    np.testing.assert_array_equal(image, original)
    np.testing.assert_allclose(np.asarray(model['coefficients'])[1:], [[.04, -.03, .02], [.03, .02, -.04]], atol=6e-4)


def test_robust_plane_rejects_star_outliers_and_keeps_flat_baseline():
    image, _, _, protection = fixture()
    rng = np.random.default_rng(6)
    for y, x in rng.integers([0, 0], image.shape[:2], size=(1500, 2)):
        image[y, x] = .95
    model = fit_background(image, protection)
    np.testing.assert_allclose(np.asarray(model['coefficients'])[1:], [[.04, -.03, .02], [.03, .02, -.04]], atol=8e-4)
    flat = np.full((96, 128, 3), [.1, .2, .3], 'f4')
    result, _ = render(flat, fit_background(flat))
    np.testing.assert_array_equal(result, flat)


def test_signed_and_highlight_output_is_never_clipped():
    image, _, _, protection = fixture()
    model = fit_background(image, protection)
    image[0, 0] = 1;image[-1, -1] = 0
    output, stats = render(image, model)
    assert stats['negativeChannels'] and stats['aboveOneChannels']
    assert output.min() < 0 and output.max() > 1


def test_sampling_masks_and_distribution_refuse_unsafe_extrapolation():
    image, _, _, protection = fixture()
    for mask in [np.zeros((*image.shape[:2], 1), 'f4'), np.pad(np.ones((12, 12, 1), 'f4'), ((0,244),(0,308),(0,0)))]:
        with pytest.raises(ValueError, match='样本不足|集中'):
            fit_background(image, sampling=mask)
    points = np.column_stack((np.linspace(-1,1,30), np.linspace(-1,1,30)))
    with pytest.raises(ValueError, match='集中|直线'):
        distribution(points)
    selected = np.ones((*image.shape[:2], 1), 'f4')
    selected[100:150, 130:200] = 0
    fitted = fit_background(image, protection, selected)
    assert fitted['samples'] >= 12
    with pytest.raises(ValueError, match='样本不足'):
        fit_background(image, np.ones_like(protection), selected)


@pytest.mark.parametrize('bad', [float('nan'), float('inf'), -.01, 1.01])
def test_bad_pixels_remain_rejected(bad):
    image, _, _, _ = fixture();image[0,0,0] = bad
    with pytest.raises(ValueError, match='0..1' if np.isfinite(bad) else '非有限值'):
        fit_background(image)


@pytest.mark.parametrize('strength', [float('nan'), float('inf'), -.1, 1.1])
def test_bad_strength_rejected(strength):
    image, _, _, protect = fixture()
    with pytest.raises(ValueError, match='强度'):
        render(image, fit_background(image, protect), strength)


def test_invalid_masks_and_cancellation():
    image, _, _, protection = fixture()
    with pytest.raises(ValueError, match='尺寸'):
        fit_background(image, np.zeros((10, 10, 1), 'f4'))
    with pytest.raises(ValueError, match='取消'):
        fit_background(image, canceled=lambda: True)
    model = fit_background(image, protection)
    with pytest.raises(ValueError, match='取消'):
        render_background(image, model, np.empty_like(image), .5, canceled=lambda: True)


def wait(store, request):
    key = store.job(request)
    for _ in range(500):
        job = store.jobs[key]
        if job['state'] not in ('queued', 'running'):
            return job
        time.sleep(.01)
    raise AssertionError(store.jobs[key])


def test_store_model_lifecycle_and_full_resolution_render(tmp_path):
    store = Store(tmp_path)
    image, _, _, protection = fixture()
    source, mask = store.save(image), store.save(protection)
    model_job = wait(store, dict(op='backgroundFit', image=source, protection=mask))
    assert model_job['state'] == 'done', model_job
    model = model_job['result']
    for view in ['model', 'result']:
        job = wait(store, dict(op='backgroundRender', image=source, strength=.6, view=view))
        assert job['state'] == 'done', job
        np.testing.assert_array_equal(store.get(job['result']['image']), render(image, model, .6, view)[0])
        store.delete(job['result']['image'])
    count = len(store.images)
    invalid = wait(store, dict(op='backgroundRender', image=source, strength=2))
    assert invalid['state'] == 'error' and len(store.images) == count
    store.delete(source)
    assert not store.background_models
    store.delete(mask)


def test_canceled_render_does_not_leak_cache(tmp_path, monkeypatch):
    import backend.background as module
    store = Store(tmp_path)
    image, _, _, _ = fixture()
    source = store.save(image)
    assert wait(store, dict(op='backgroundFit', image=source))['state'] == 'done'
    def cancel(*args, **kwargs):
        next(j for j in store.jobs.values() if j['state'] == 'running')['cancel'] = True
        raise ValueError('cancel')
    monkeypatch.setattr(module, 'render_background', cancel)
    assert wait(store, dict(op='backgroundRender', image=source, strength=1))['state'] == 'canceled'
    assert list(store.images) == [source]
    store.delete(source)
