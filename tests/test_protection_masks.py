import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import numpy as np
import pytest
import tifffile

from backend.protection_masks import make_mask, save_mask
from backend.server import Handler, Store
from tests.test_server import wait_for_job


@pytest.mark.parametrize("bits", [8, 16])
def test_gray_neutral_does_not_protect_entire_canvas(bits):
    levels = (1 << bits)-1
    neutral = np.float32(round(levels*.5)/levels)
    image = np.full((5, 7, 4), neutral, dtype=np.float32)
    image[..., 3] = 1
    image[2, 3, 0] = np.float32((round(levels*.5)+1)/levels)
    before = image.copy()
    mask, _ = make_mask(image, dict(encoding="gray", bits=bits, low=0, high=1, grow=0, feather=0))
    assert np.count_nonzero(mask) == 1
    assert mask[2, 3, 0] > 0
    np.testing.assert_array_equal(image, before)


def test_signed_gray_and_black_positive_signal_agree_without_mutating_source():
    image = np.array([[[-.3, .1, .2, .5], [-.1, -.2, -.3, 1], [9, 3, 4, 0]]], dtype=np.float32)
    before = image.copy()
    options = dict(low=0, high=.2, grow=0, feather=0)
    signed, _ = make_mask(image, dict(options, encoding="signed"))
    assert signed[0, 0, 0] == .5
    assert signed[0, 1, 0] == signed[0, 2, 0] == 0
    gray = image.copy()
    gray[0, 2, :3] = 0
    gray[..., :3] = (gray[..., :3]+1)/2
    encoded, _ = make_mask(gray, dict(options, encoding="gray", bits=16))
    np.testing.assert_allclose(encoded, signed, atol=5e-7)
    np.testing.assert_array_equal(image, before)
    # Finite HDR maximum must saturate coverage without overflowing the mapping.
    with np.errstate(over="raise", invalid="raise"):
        hdr, _ = make_mask(np.full((1, 1, 1), np.finfo(np.float32).max), options)
    assert hdr.item() == 1


def test_subject_fractional_snapshot_and_complement():
    selection = np.array([[[0], [.125], [.5], [1]]], dtype=np.float32)
    mask, details = make_mask(selection, dict(mode="subject", grow=0, feather=0))
    np.testing.assert_array_equal(mask, selection)
    assert details["whiteCoverage"] == float(selection.mean(dtype=np.float64))
    source = np.linspace(0, .03, 99, dtype=np.float32).reshape(9, 11, 1)
    stars, _ = make_mask(source, dict(mode="stars", grow=1, feather=1.5))
    outside, _ = make_mask(source, dict(mode="outside", grow=1, feather=1.5))
    np.testing.assert_array_equal(outside, 1-stars)


def test_growth_retains_core_feather_goes_outward_and_no_edge_wrap():
    image = np.zeros((31, 31, 1), dtype=np.float32)
    image[0, 0] = 1
    mask, _ = make_mask(image, dict(grow=2, feather=1))
    np.testing.assert_array_equal(mask[:3, :3], 1)
    assert 0 < mask[3, 3, 0] < 1
    assert mask[-1, -1, 0] == 0
    assert np.all((mask >= 0) & (mask <= 1))


@pytest.mark.parametrize("components", [1, 2, 3, 4])
def test_gray_rgb_with_or_without_alpha_keep_original_channels(components):
    source = np.full((9, 11, components), .1, dtype=np.float32)
    if components in (2, 4):
        source[..., -1] = .5
    before = source.copy()
    mask, _ = make_mask(source, dict(low=0, high=.1, grow=0, feather=0))
    np.testing.assert_allclose(mask, .5 if components in (2, 4) else 1)
    np.testing.assert_array_equal(source, before)


def test_queued_cancel_does_not_allocate_a_result(tmp_path):
    store = Store(tmp_path)
    key = store.save(np.full((3, 5, 1), .5, dtype=np.float32))
    with store.worker:
        job_id = store.job(dict(op="maskGenerate", image=key, options=dict(mode="subject")))
        store.jobs[job_id]["cancel"] = True
    job = wait_for_job(store, job_id)
    assert job["state"] == "canceled"
    assert list(store.images) == [key]
    assert not store.protection_masks


@pytest.mark.parametrize("options,source", [
    ({"low": .02, "high": .01}, [0]), ({"low": float("nan")}, [0]),
    ({"grow": 1.5}, [0]), ({"grow": True}, [0]), ({"feather": float("inf")}, [0]),
    ({"mode": "unknown"}, [0]), ({"encoding": "gray", "bits": 32}, [0]),
    ({"encoding": "gray", "bits": 16}, [1.1]),
    ({}, [0, 0, 0, 1.1]), ({}, [float("nan")]),
    ({"mode": "subject"}, [.5, .5, .5]), ({"mode": "subject"}, [-.01]),
])
def test_invalid_masks_rejected(options, source):
    with pytest.raises(ValueError):
        make_mask(np.array([[source]], dtype=np.float32), options)


def test_cancel_generation_and_export_cleanup(tmp_path):
    with pytest.raises(InterruptedError):
        make_mask(np.zeros((5, 7, 1), dtype=np.float32), {}, canceled=lambda: True)
    image = np.array([[[0], [np.nextafter(np.float32(0), np.float32(1))], [.12345678], [1]]], dtype=np.float32)
    target = tmp_path/"mask.tif"
    calls = []
    def canceled():
        calls.append(1)
        return len(calls) == 2
    with pytest.raises(InterruptedError):
        save_mask(image, {}, target, canceled)
    assert not target.exists()
    save_mask(image, dict(mode="subject", preview="not persisted"), target)
    with tifffile.TiffFile(target) as f:
        assert f.asarray().dtype == np.float32
        np.testing.assert_array_equal(f.asarray().view(np.uint32), image[..., 0].view(np.uint32))
        assert f.pages[0].photometric == 1
        assert 34675 not in f.pages[0].tags
        assert "preview" not in json.loads(f.pages[0].description)
    before = target.read_bytes()
    with pytest.raises(ValueError, match="已存在"):
        save_mask(image, {}, target)
    assert target.read_bytes() == before


def test_http_float_source_isolated_and_complete_mask_job(tmp_path):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.store, server.token = Store(tmp_path), "test"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def post(path, data):
        raw = data if isinstance(data, bytes) else json.dumps(data).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}"+path, raw, headers={"X-Star-Token": "test"})
        with opener.open(request) as reply:
            return json.load(reply)
    try:
        raw = np.array([[[-.1, .2, 2, 1], [0, .01, 0, 0]]], dtype="<f4")
        shape = dict(width=2, height=1, components=4)
        old = post("/images", shape)["id"]
        with pytest.raises(urllib.error.HTTPError):
            post(f"/images/{old}?y=0&rows=1", raw.tobytes())
        key = post("/mask-sources", shape)["id"]
        assert post(f"/mask-sources/{key}?y=0&rows=1", raw.tobytes())["ready"]
        with pytest.raises(urllib.error.HTTPError):
            post(f"/images/{key}?y=0&rows=1", raw.tobytes())
        with pytest.raises(ValueError, match="专用来源"):
            server.store.get(key)
        rejected = wait_for_job(server.store, server.store.job(dict(op="processStars", image=key, settings={})))
        assert rejected["state"] == "error"
        job = wait_for_job(server.store, server.store.job(dict(op="maskGenerate", image=key, options=dict(encoding="signed", grow=0, feather=0))))
        assert job["state"] == "done", job
        result = job["result"]
        assert server.store.get(result["image"]).shape == (1, 2, 1)
        target = tmp_path/"saved.tif"
        saved = wait_for_job(server.store, server.store.job(dict(op="maskSave", image=result["image"], output=str(target))))
        assert saved["state"] == "done", saved
        np.testing.assert_array_equal(tifffile.imread(target), [[1, 0]])
        np.testing.assert_array_equal(server.store.get(key, "mask-source"), raw)
        server.store.delete(result["image"])
        assert not server.store.protection_masks
    finally:
        server.shutdown()
        server.server_close()
