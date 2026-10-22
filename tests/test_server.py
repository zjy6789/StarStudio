import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
import threading

import numpy as np
import pytest

from backend.server import Store, Handler
from backend.algorithms import combine


def test_extract_defaults_to_external_starnet(tmp_path, monkeypatch):
    calls = []
    def engine(colors, folder, executable, stride, progress, license_sha256, report):
        calls.append((folder, executable, stride, license_sha256))
        report({"provider": "DirectML", "message": "推理", "engineSeconds": 2.5})
        progress(1)
        return colors * .8
    monkeypatch.setattr('backend.server.starnet', engine)
    store = Store(tmp_path)
    image = np.full((8, 12, 4), .4, dtype=np.float32)
    image[..., 3] = .7
    key = store.save(image)
    request = dict(op='extract', image=key, executable='test-starnet.exe', stride=128, license_sha256='accepted')
    job_id = store.job(request)
    deadline = time.monotonic() + 5
    while store.jobs[job_id]['state'] in ('queued', 'running') and time.monotonic() < deadline:
        time.sleep(.01)
    job = store.jobs[job_id]
    assert job['state'] == 'done', job
    assert calls == [(tmp_path / job_id, 'test-starnet.exe', 128, 'accepted')]
    assert job['result']['provider'] == 'DirectML'
    assert job['result']['timings']['engineSeconds'] == 2.5
    b, s = [store.get(job['result'][name]) for name in ('background', 'stars')]
    np.testing.assert_allclose(combine(b, s), image, atol=1e-7)
    np.testing.assert_array_equal(b[..., 3], image[..., 3])
    obsolete = store.job(dict(request, engine='unsupported'))
    deadline = time.monotonic() + 5
    while store.jobs[obsolete]['state'] in ('queued', 'running') and time.monotonic() < deadline:
        time.sleep(.01)
    assert store.jobs[obsolete]['state'] == 'error'
    assert 'StarNet++' in store.jobs[obsolete]['error']
    assert len(calls) == 1


def test_canvas_preview_reuses_storage_and_replaces_changed_size(tmp_path):
    store = Store(tmp_path)
    image = np.full((12, 20, 4), .125, dtype=np.float32)
    key = store.preview(image)
    assert store.preview(image * 2) == key
    np.testing.assert_array_equal(store.get(key), image * 2)
    replacement = store.preview(np.ones((10, 10, 4), dtype=np.float32))
    assert replacement != key
    assert key not in store.images
    assert not (tmp_path / f"{key}.npy").exists()


def wait_for_job(store, key):
    deadline = time.monotonic() + 5
    while store.jobs[key]["state"] in ("queued", "running") and time.monotonic() < deadline:
        time.sleep(.01)
    job = store.jobs[key]
    assert job["state"] not in ("queued", "running"), job
    return job


@pytest.mark.parametrize("payload", [{}, None, [], "extract", 1, {"op": None}, {"op": 1}, {"op": ""}, {"op": "  "}])
def test_malformed_job_is_rejected_before_enqueue(tmp_path, payload):
    store = Store(tmp_path)
    with pytest.raises(ValueError, match="op"):
        store.job(payload)
    assert store.jobs == {}


def test_failed_jobs_finish_and_do_not_block_valid_work(tmp_path):
    store = Store(tmp_path)
    for request in [{"op": "unknown"}, {"op": "extract"}, {"op": "processStars"}]:
        job = wait_for_job(store, store.job(request))
        assert job["state"] == "error", job
        assert job["error"]
    image = np.full((2, 3, 4), .25, dtype=np.float32)
    image[..., 3] = 1
    key = store.save(image)
    job = wait_for_job(store, store.job(dict(op="processStars", image=key, settings={})))
    assert job["state"] == "done", job
    np.testing.assert_array_equal(store.get(job["result"]["image"]), image)


def test_jobs_http_rejects_bad_bodies_and_recovers(tmp_path):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token = "test-token"
    server.store = Store(tmp_path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    def post(body):
        request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/jobs", data=body,
                                         headers={"X-Star-Token": server.token, "Content-Type": "application/json"})
        return urllib.request.urlopen(request, timeout=3)
    try:
        for body in [b"{}", b"null", b"[]", b'"extract"', b'{"op": null}', b'{"op": ""}', b"{invalid"]:
            with pytest.raises(urllib.error.HTTPError) as error:
                post(body)
            assert error.value.code == 400
            assert json.load(error.value)["error"]
        assert server.store.jobs == {}
        image = np.full((2, 3, 4), .25, dtype=np.float32)
        image[..., 3] = 1
        key = server.store.save(image)
        with post(json.dumps(dict(op="processStars", image=key, settings={})).encode()) as response:
            job_id = json.load(response)["id"]
        assert wait_for_job(server.store, job_id)["state"] == "done"
        health = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/health",
                                        headers={"X-Star-Token": server.token})
        with urllib.request.urlopen(health, timeout=3) as response:
            manifest = json.loads((Path(__file__).resolve().parents[1] / "plugin/manifest.json").read_text(encoding="utf-8"))
            assert json.load(response) == {"ok": True, "version": manifest["version"]}
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


def test_starnet_http_endpoints_authenticate_before_inspecting_paths(tmp_path, monkeypatch):
    calls = []
    def inspect(path):
        calls.append(('info', path))
        return {'installation': {'ready': False, 'missing': ['StarNet2_weights.onnx']}}
    def discover(current):
        calls.append(('discover', current))
        return {'executable': None}
    monkeypatch.setattr('backend.server.starnet_info', inspect)
    monkeypatch.setattr('backend.starnet_install.discover_starnet', discover)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.token = 'test-token'
    server.store = Store(tmp_path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def post(path, body, token=None):
        headers = {'Content-Type': 'application/json'}
        if token is not None:
            headers['X-Star-Token'] = token
        request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/{path}',
                                         data=body, headers=headers)
        return opener.open(request, timeout=3)
    try:
        for path in ['starnet-info', 'starnet-discover']:
            for token in [None, 'incorrect-token']:
                with pytest.raises(urllib.error.HTTPError) as error:
                    post(path, b'', token)
                assert error.value.code == 403
                assert json.load(error.value)['error']
        assert calls == []
        with post('starnet-info', b'{"executable":"test-starnet2.exe"}', server.token) as response:
            assert json.load(response)['installation']['ready'] is False
        with post('starnet-discover', b'{"current":"test-starnet++.exe"}', server.token) as response:
            assert json.load(response) == {'executable': None}
        assert calls == [('info', 'test-starnet2.exe'), ('discover', 'test-starnet++.exe')]
        assert server.store.jobs == {}
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


def test_ordinary_upload_distinguishes_nonfinite_and_finite_hdr_without_accepting_or_clipping(tmp_path):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.token = 'test-token'
    server.store = Store(tmp_path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def post(path, payload):
        request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,
            data=payload, headers={'X-Star-Token': server.token})
        return opener.open(request, timeout=3)
    try:
        for value in [float('nan'), float('inf'), -float('inf'), -.125, 1.25]:
            with post('/images', b'{"width":2,"height":1,"components":3}') as response:
                key = json.load(response)['id']
            image = np.full((1, 2, 3), .3, dtype='<f4')
            image[0, 1, 2] = value
            with pytest.raises(urllib.error.HTTPError) as error:
                post(f'/images/{key}?y=0&rows=1', image.tobytes())
            assert error.value.code == 400
            message = json.load(error.value)['error']
            assert ('非有限值' in message) == (not np.isfinite(value))
            assert ('保留原图/母版' in message) == bool(np.isfinite(value))
            entry = server.store.images[key]
            assert entry['ready'] is False and entry['rows'] == 0
            np.testing.assert_array_equal(entry['data'], 0)
            valid = np.array([[[0., .1, 1.], [.25, .5, .75]]], dtype='<f4')
            with post(f'/images/{key}?y=0&rows=1', valid.tobytes()) as response:
                assert json.load(response) == {'ready': True}
            np.testing.assert_array_equal(server.store.get(key).view('u4'), valid.view('u4'))
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


def test_starnet_http_reports_incomplete_installation_and_preserves_current_cpu(tmp_path, monkeypatch):
    modern = tmp_path / 'modern'
    modern.mkdir()
    exe = modern / 'starnet2.exe'
    exe.write_bytes(b'test executable')
    (modern / 'LICENSE.txt').write_text('Test license', encoding='utf-8')
    cpu = tmp_path / 'cpu'
    cpu.mkdir()
    current = cpu / 'starnet++.exe'
    current.write_bytes(b'test executable')
    (cpu / 'starnet2_weights.pb').write_bytes(b'test weights')
    monkeypatch.setattr('backend.starnet_install.known_locations', lambda: [exe])
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.token = 'test-token'
    server.store = Store(tmp_path / 'jobs')
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def post(path, body):
        request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/{path}',
            data=json.dumps(body).encode(), headers={'X-Star-Token': server.token, 'Content-Type': 'application/json'})
        return opener.open(request, timeout=3)
    try:
        with post('starnet-info', {'executable': str(exe)}) as response:
            info = json.load(response)
        assert info['installation']['ready'] is False
        assert info['installation']['missing'] == ['StarNet2_weights.onnx']
        assert info['license'] == 'Test license'
        assert len(info['license_sha256']) == 64
        with post('starnet-discover', {'current': str(current)}) as response:
            selected = json.load(response)
        assert selected['executable'] == str(current)
        assert selected['modern'] is False
        assert selected['preserved'] is True
        assert selected['installation']['ready'] is True
        with pytest.raises(urllib.error.HTTPError) as error:
            post('starnet-info', {'executable': str(tmp_path / 'missing.exe')})
        assert error.value.code == 400
        assert json.load(error.value)['error']
        assert server.store.jobs == {}
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


def test_extract_preserved_model_runs_engine_once_and_returns_signed_values(tmp_path, monkeypatch):
    calls = []
    predicted = np.array([[[.3, .2, .4], [.1, .3, .2]]], dtype=np.float32)
    def engine(*args):
        calls.append(args)
        return predicted.copy()
    monkeypatch.setattr('backend.server.starnet', engine)
    store = Store(tmp_path)
    image = np.array([[[.1, .5, .2, .8], [.4, .1, .3, 1]]], dtype=np.float32)
    key = store.save(image)
    for encoding in ['gray', 'signed']:
        job = wait_for_job(store, store.job(dict(op='extract', image=key,
            preserveModelBackground=True, starEncoding=encoding)))
        assert job['state'] == 'done', job
        assert job['result']['starEncoding'] == encoding
        background = store.get(job['result']['background'])
        stars = store.get(job['result']['stars'])
        np.testing.assert_array_equal(background[..., :3], predicted)
        delta = stars[..., :3]*2-1 if encoding == 'gray' else stars[..., :3]
        np.testing.assert_allclose(predicted+delta, image[..., :3], atol=1e-7)
    assert len(calls) == 2  # Exactly one inference per selected representation.


def test_gray_processing_http_decodes_before_adjusting_stars(tmp_path):
    store = Store(tmp_path)
    signed = np.array([[[-.15, .2, .3, .8], [.1, -.2, .15, 1]]], dtype=np.float32)
    encoded = signed.copy()
    encoded[..., :3] = (signed[..., :3]+1)/2
    key = store.save(encoded)
    job = wait_for_job(store, store.job(dict(op='processStars', image=key,
        starEncoding='gray', settings={'curve': {'enabled': True, 'exposure': 1}}, preview=False)))
    assert job['state'] == 'done', job
    result = store.get(job['result']['image'])
    delta = result[..., :3]*2-1
    negative = signed[..., :3] < 0
    np.testing.assert_allclose(delta[negative], signed[..., :3][negative], atol=6e-8)
    assert np.all(delta[~negative] > signed[..., :3][~negative])
    np.testing.assert_array_equal(result[..., 3], signed[..., 3])


def test_full_processing_returns_curve_without_png(tmp_path):
    store = Store(tmp_path)
    key = store.save(np.full((8, 12, 3), .2, dtype=np.float32))
    job = wait_for_job(store, store.job(dict(op="processStars", image=key,
                                           settings={"curve": {"enabled": True, "midtones": .6}}, preview=False)))
    assert job["state"] == "done", job
    assert "preview" not in job["result"]
    assert len(job["result"]["curve"]) == 256
    assert job["result"]["curve"][128] > .5


def test_canceled_queued_processing_skips_algorithm(tmp_path, monkeypatch):
    store = Store(tmp_path)
    key = store.save(np.full((8, 12, 3), .2, dtype=np.float32))
    def unexpected(*args, **kwargs):
        raise AssertionError("Canceled queued job must not process pixels")
    monkeypatch.setattr("backend.star_processing.process_stars", unexpected)
    with store.worker:
        job_id = store.job(dict(op="processStars", image=key, settings={}))
        store.jobs[job_id]["cancel"] = True
    job = wait_for_job(store, job_id)
    assert job["state"] == "canceled", job
    assert "result" not in job
    assert set(store.images) == {key}


def test_canceled_running_processing_discards_result(tmp_path, monkeypatch):
    store = Store(tmp_path)
    key = store.save(np.full((8, 12, 3), .2, dtype=np.float32))
    started, finish = threading.Event(), threading.Event()
    def process(image, settings, workdir, scale, progress, cache):
        started.set()
        assert finish.wait(3)
        return image.copy(), {"reconstructedStars": 0}
    monkeypatch.setattr("backend.star_processing.process_stars", process)
    job_id = store.job(dict(op="processStars", image=key, settings={}))
    assert started.wait(3)
    store.jobs[job_id]["cancel"] = True
    finish.set()
    job = wait_for_job(store, job_id)
    assert job["state"] == "canceled", job
    assert "result" not in job
    assert set(store.images) == {key}
    assert len(list(tmp_path.glob("*.npy"))) == 1


def test_processing_cache_tracks_one_source_and_releases_deleted_input(tmp_path, monkeypatch):
    store = Store(tmp_path)
    inputs = [store.save(np.full((8, 12, 3), value, dtype=np.float32)) for value in (.2, .4)]
    prior = []
    def process(image, settings, workdir, scale, progress, cache):
        prior.append(cache.get("glow"))
        cache["glow"] = {"halo": image.copy()}
        return image.copy(), {"reconstructedStars": 0}
    monkeypatch.setattr("backend.star_processing.process_stars", process)
    def run(key, scale=1):
        job = wait_for_job(store, store.job(dict(op="processStars", image=key, settings={}, scale=scale)))
        assert job["state"] == "done", job
        store.delete(job["result"]["image"])
    run(inputs[0])
    run(inputs[0])
    run(inputs[1])
    run(inputs[1], .5)
    assert prior[0] is None and prior[1] is not None
    assert prior[2] is None and prior[3] is None
    assert store.processing_cache["source"] == (inputs[1], .5, 'black')
    store.delete(inputs[0])
    assert "glow" in store.processing_cache
    store.delete(inputs[1])
    assert store.processing_cache == {}


def test_component_stays_alive_for_panel_then_exits_without_client(tmp_path):
    root = Path(__file__).resolve().parents[1]
    config = {"token": "lifecycle-test-token"}
    (tmp_path / "plugin").mkdir()
    (tmp_path / "plugin/bridge.json").write_text(json.dumps(config), encoding="utf-8")
    (tmp_path / "plugin/manifest.json").write_bytes((root / "plugin/manifest.json").read_bytes())
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    bootstrap = "import sys; from pathlib import Path; import backend.paths as paths; paths.ROOT=Path(sys.argv.pop(1)); from backend.server import main; main()"
    process = subprocess.Popen([sys.executable, "-c", bootstrap, str(tmp_path), "--port", str(port), "--idle-seconds", "2"],
                               cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    request = urllib.request.Request(f"http://127.0.0.1:{port}/health", headers={"X-Star-Token": config["token"]})
    try:
        for _ in range(40):
            try:
                with urllib.request.urlopen(request, timeout=.2) as response:
                    assert json.load(response)["ok"]
                break
            except OSError:
                time.sleep(.1)
        else:
            raise AssertionError("Test component did not start")
        for body in [b"{}", b"null", b"[]"]:
            bad = urllib.request.Request(f"http://127.0.0.1:{port}/jobs", data=body,
                                         headers={"X-Star-Token": config["token"]})
            with pytest.raises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(bad, timeout=1)
            assert error.value.code == 400
        for _ in range(3):
            time.sleep(.8)
            with urllib.request.urlopen(request, timeout=1) as response:
                assert json.load(response)["ok"]
            assert process.poll() is None
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)


def test_preview_http_keeps_float_pixels_for_photoshop_canvas(tmp_path):
    server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
    server.token="test-token"
    server.store=Store(tmp_path)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    def request(path,body=None):
        raw=json.dumps(body).encode() if body is not None else None
        req=urllib.request.Request(f"http://127.0.0.1:{server.server_port}"+path,data=raw,
            headers={"X-Star-Token":server.token,"Content-Type":"application/json"})
        with urllib.request.urlopen(req,timeout=3) as response:
            return response.read()
    try:
        b=np.full((8,12,4),.137123,dtype=np.float32);b[...,3]=1
        s=np.full_like(b,.056789);s[...,3]=1
        keys=[server.store.save(a) for a in (b,s)]
        body=dict(background=keys[0],stars=keys[1],bp={},sp={},mode="screen",canvas=True)
        response=json.loads(request("/preview",body))
        canvas=response["canvas"]
        assert (canvas["width"],canvas["height"],canvas["components"])==(12,8,4)
        pixels=np.frombuffer(request("/images/"+canvas["id"]+"?y=0&rows=8"),dtype="<f4").reshape(b.shape)
        np.testing.assert_array_equal(pixels,combine(b,s))
        assert json.loads(request("/preview",body))["canvas"]["id"]==canvas["id"]
    finally:
        server.shutdown();server.server_close();thread.join(timeout=3)
