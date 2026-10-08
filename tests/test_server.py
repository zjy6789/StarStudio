import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
from http.server import ThreadingHTTPServer
import threading

import numpy as np

from backend.server import Store, Handler
from backend.algorithms import combine


def test_extract_defaults_to_external_starnet(tmp_path, monkeypatch):
    calls = []
    def engine(colors, folder, executable, stride, progress):
        calls.append((folder, executable, stride))
        progress(1)
        return colors * .8
    monkeypatch.setattr('backend.server.starnet', engine)
    store = Store(tmp_path)
    image = np.full((8, 12, 4), .4, dtype=np.float32)
    image[..., 3] = .7
    key = store.save(image)
    request = dict(op='extract', image=key, executable='test-starnet.exe', stride=128)
    job_id = store.job(request)
    deadline = time.monotonic() + 5
    while store.jobs[job_id]['state'] in ('queued', 'running') and time.monotonic() < deadline:
        time.sleep(.01)
    job = store.jobs[job_id]
    assert job['state'] == 'done', job
    assert calls == [(tmp_path / job_id, 'test-starnet.exe', 128)]
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


def test_component_stays_alive_for_panel_then_exits_without_client():
    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / "plugin/bridge.json").read_text(encoding="utf-8"))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    process = subprocess.Popen([sys.executable, "-m", "backend.server", "--port", str(port), "--idle-seconds", "2"],
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
