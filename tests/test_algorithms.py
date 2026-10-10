import numpy as np
import pytest
from backend.algorithms import separate, combine, stretch, stretch_curve, validate_image
from backend.server import Store, sequence


@pytest.mark.parametrize("mode", ["add", "screen"])
@pytest.mark.parametrize("channels", [1, 2, 3, 4])
def test_separation_round_trip_including_saturated_and_brightened_pixels(mode, channels):
    original = np.random.default_rng(41).random((37, 53, channels), dtype=np.float32)
    original[0] = 1
    original[1] = 0
    n = 3 if channels>=3 else 1
    predicted = original[..., :n] + np.random.default_rng(8).uniform(-.4, .2, (37, 53, n))
    b, s = separate(original, predicted, mode)
    np.testing.assert_allclose(combine(b, s, mode), original, atol=1.2e-7)
    assert b.min()>=0 and s.min()>=0 and b.max()<=1 and s.max()<=1


@pytest.mark.parametrize('encoding', ['gray', 'signed'])
@pytest.mark.parametrize('channels', [1, 2, 3, 4])
def test_preserved_model_background_retains_negative_corrections(encoding, channels):
    original = np.random.default_rng(41).random((37, 53, channels), dtype=np.float32)
    n = 3 if channels >= 3 else 1
    predicted = np.random.default_rng(8).random((37, 53, n), dtype=np.float32)
    before = original.copy()
    b, s = separate(original, predicted, preserve_model=True, star_encoding=encoding)
    np.testing.assert_array_equal(b[..., :n], predicted)
    delta = s[..., :n]*2-1 if encoding == 'gray' else s[..., :n]
    assert delta.min() < 0 and delta.max() > 0
    np.testing.assert_allclose(b[..., :n]+delta, original[..., :n], atol=1.2e-7)
    if channels != n:
        np.testing.assert_array_equal(b[..., n:], original[..., n:])
        np.testing.assert_array_equal(s[..., n:], original[..., n:])
    np.testing.assert_array_equal(original, before)


def test_preserved_model_rejects_invalid_output_instead_of_clipping():
    original = np.full((2, 3, 3), .2, dtype=np.float32)
    with pytest.raises(ValueError, match='0..1'):
        separate(original, np.full_like(original, 1.1), preserve_model=True)
    with pytest.raises(ValueError, match='编码'):
        separate(original, original, preserve_model=True, star_encoding='unknown')


@pytest.mark.parametrize("kind", ["ghs", "asinh"])
@pytest.mark.parametrize("b", [-5, -1.00001, -1, -.01, 0, .01, 1, 15])
def test_stretch_endpoints_monotonicity_and_protected_segments(kind, b):
    x = np.linspace(0, 1, 10001)
    y = stretch_curve(x, dict(type=kind, b=b, lnD=3, lp=.1, sp=.3, hp=.8))
    assert y[0]==pytest.approx(0,abs=1e-7) and y[-1]==pytest.approx(1,abs=1e-7)
    assert np.isfinite(y).all() and np.all(np.diff(y)>=-1e-7)
    # Verify linearity against the chord; allow one float32 ULP near white.
    for segment in (y[:900], y[8100:]):
        chord = np.linspace(float(segment[0]), float(segment[-1]), len(segment))
        np.testing.assert_allclose(segment, chord, atol=6e-8, rtol=0)


def test_siril_log_special_case_and_black_point_after_stretch():
    x=np.linspace(0,1,301)
    d=np.expm1(2)
    expected=np.log1p(d*x)/np.log1p(d)
    actual=stretch_curve(x, dict(type="ghs", b=-1, lnD=2, bp=.1))
    np.testing.assert_allclose(actual,np.clip((expected-.1)/.9,0,1),atol=1e-7)


def test_asinh_zero_symmetry_formula():
    x=np.linspace(0,1,301); d=np.expm1(3)
    np.testing.assert_allclose(stretch_curve(x,dict(type="asinh",lnD=3)),np.arcsinh(d*x)/np.arcsinh(d),atol=1e-7)


def test_default_stretch_preserves_alpha_and_color():
    a=np.random.default_rng(0).random((20,30,4),dtype=np.float32)
    np.testing.assert_allclose(stretch(a,{}),a,atol=1e-7)
    b=stretch(a,dict(lnD=3))
    np.testing.assert_array_equal(b[...,3],a[...,3])
    assert np.isfinite(b).all() and b.min()>=0 and b.max()<=1


def test_invalid_contracts_rejected():
    with pytest.raises(ValueError): stretch_curve([0,.2],dict(sp=.8,hp=.5))
    with pytest.raises(ValueError): stretch_curve([0,.2],dict(bp=1))
    with pytest.raises(ValueError): stretch_curve([0,.2],dict(lnD=float("nan")))
    with pytest.raises(ValueError): validate_image(np.ones((2,3,3))*1.1)


def test_rgb_blend_and_direct_clipping_have_distinct_color_results():
    a=np.array([[[.8,.1,.1]]],dtype=np.float32)
    blend=stretch(a,dict(lnD=4,clipping="blend"))
    clip=stretch(a,dict(lnD=4,clipping="clip"))
    assert blend.min()>=0 and blend.max()<=1
    assert np.max(np.abs(blend-clip))>.1
    with pytest.raises(ValueError): stretch(a,dict(clipping="unknown"))


def test_applied_chain_retains_stretch_at_full_resolution(tmp_path):
    a=np.random.default_rng(1).random((7,9,4),dtype=np.float32)
    p=dict(type="asinh",lnD=1.5)
    store=Store(tmp_path); key=store.save(a)
    np.testing.assert_allclose(sequence(store.get(key),[p],{}),stretch(a,p),atol=1e-7)
