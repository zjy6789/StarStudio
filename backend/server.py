"""Authenticated loopback bridge for Photoshop UXP (no remote service)."""
import argparse
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import urlparse, parse_qs
import uuid
import numpy as np
from PIL import Image
from .algorithms import ROOT, validate_image, color_count, starnet, starnet_info, separate, stretch, combine

VERSION = json.loads((ROOT / "plugin/manifest.json").read_text(encoding="utf-8"))["version"]


def sequence(image, chain, current):
    for p in chain:
        image = stretch(image, p)
    return stretch(image, current)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.mkdir(parents=True, exist_ok=True)
        self.images, self.jobs = {}, {}
        self.worker = threading.Lock()
        self.preview_key = None
        self.processing_cache = {}
        self.background_models = {}
        self.stretch_sources, self.stretch_results = {}, {}
        self.protection_masks = {}
        self.color_models = {}
        self.denoise_models = {}

    def create(self, w, h, c, purpose="image", *, dtype="<f4"):
        if not (0 < w <= 65536 and 0 < h <= 65536 and w*h <= 250_000_000 and c in (1, 2, 3, 4)):
            raise ValueError("无效图像尺寸")
        key = uuid.uuid4().hex
        a = np.lib.format.open_memmap(self.path / f"{key}.npy", mode="w+", dtype=dtype, shape=(h, w, c))
        self.images[key] = {"data": a, "rows": 0, "ready": False, "purpose": purpose}
        return key

    def get(self, key, purpose="image"):
        entry = self.images[key]
        if entry["purpose"] != purpose:
            raise ValueError("专用来源不能用于普通图像作业")
        if not entry["ready"]:
            raise ValueError("图像上传尚未完成")
        return entry["data"]

    def save(self, image):
        h, w, c = image.shape
        key = self.create(w, h, c)
        self.images[key]["data"][:] = image
        self.images[key]["data"].flush()
        self.images[key].update(ready=True, rows=h)
        return key

    def preview(self, image):
        key = self.preview_key
        if key and self.images[key]["data"].shape == image.shape:
            self.images[key]["data"][:] = image
            self.images[key]["data"].flush()
        else:
            if key:
                self.delete(key)
            self.preview_key = key = self.save(image)
        return key

    def delete(self, key):
        self.protection_masks.pop(key, None)
        self.color_models.pop(key, None)
        denoise = self.denoise_models.pop(key, None)
        if denoise and denoise.get("candidate"):
            self.delete(denoise["candidate"]["image"])
        self.background_models.pop(key, None)
        self.stretch_sources.pop(key, None)
        self.stretch_results.pop(key, None)
        entry = self.images.pop(key)
        entry["data"]._mmap.close()
        (self.path / f"{key}.npy").unlink()
        if self.processing_cache.get("source", (None,))[0] == key:
            self.processing_cache.clear()

    def job(self, request):
        if not isinstance(request, dict) or not isinstance(request.get("op"), str) or not request["op"].strip():
            raise ValueError("作业请求必须为对象，且包含非空字符串 op")
        operation = request["op"]
        key = uuid.uuid4().hex
        job = {"id": key, "state": "queued", "progress": 0}
        self.jobs[key] = job

        def run():
            try:
                with self.worker:
                    job["state"] = "running"
                    def progress(x):
                        job["progress"] = round(float(x), 3)
                    if operation in ("stack", "stackInspect"):
                        from .stacking import stack, inspect
                        if operation == "stackInspect":
                            job["message"] = "读取基准帧预览…"
                            job["result"] = inspect(request["paths"],request.get("reference"))
                        else:
                            def message(text):
                                job["message"] = text
                            job["result"] = stack(request,self.path,progress,message,lambda:job.get("cancel",False))
                    elif operation == "stackCrop":
                        from .stack_crop import crop_stack
                        job["message"] = "校验母版并保存裁剪副本…"
                        job["result"] = crop_stack(request,progress,lambda:job.get("cancel",False))
                    elif operation in ("fitsInspect", "fitsImport"):
                        from .fits_import import inspect_fits, import_fits
                        job["message"] = "检查单张FITS数据…" if operation == "fitsInspect" else "保存独立32位线性TIFF…"
                        canceled = lambda: job.get("cancel", False)
                        job["result"] = (inspect_fits(request, progress, canceled) if operation == "fitsInspect"
                                         else import_fits(request, progress, canceled))
                    elif operation in ("prepareInspect", "prepareLinear"):
                        from .linear_preparation import inspect_master, prepare_master
                        job["message"] = "检查线性母版…" if operation == "prepareInspect" else "创建独立的32位范围准备副本…"
                        canceled = lambda: job.get("cancel", False)
                        job["result"] = (inspect_master(request["path"], progress, canceled) if operation == "prepareInspect"
                                         else prepare_master(request, progress, canceled))
                    elif operation in ("stretchInspect", "stretchCheck", "stretchRender", "stretchSave"):
                        from .protected_stretch import inspect_prepared, prepared_data, check_source, render_stretch, save_stretch
                        canceled = lambda: job.get("cancel", False)
                        job["message"] = {"stretchInspect": "读取线性准备副本并建议参数…", "stretchCheck": "检查准备副本是否变化…",
                                          "stretchRender": "计算受保护拉伸…", "stretchSave": "保存独立32位拉伸副本…"}[operation]
                        if operation == "stretchInspect":
                            info = inspect_prepared(request["path"], request.get("confirmedLinear"), progress, canceled)
                            image_id = None
                            try:
                                with prepared_data(info["path"]) as (image, record):
                                    image_id = self.save(image)
                                check_source(info)
                                if canceled():
                                    raise InterruptedError("读取已取消")
                                self.stretch_sources[image_id] = info
                                job["result"] = dict(info, image=image_id)
                            except Exception:
                                if image_id:
                                    self.delete(image_id)
                                raise
                        elif operation == "stretchCheck":
                            if request["image"] not in self.stretch_sources:
                                raise ValueError("线性来源快照已失效，请重新读取准备副本。")
                            check_source(self.stretch_sources[request["image"]])
                            job["result"] = {"ok": True}
                        elif operation == "stretchRender":
                            source_id = request["image"]
                            if source_id not in self.stretch_sources:
                                raise ValueError("线性来源快照已失效，请重新读取准备副本。")
                            source, info = self.get(source_id), self.stretch_sources[source_id]
                            output_id = self.create(source.shape[1], source.shape[0], 3)
                            try:
                                entry = self.images[output_id]
                                details = render_stretch(source, info, entry["data"], request["settings"], progress, canceled)
                                entry["data"].flush()
                                entry.update(ready=True, rows=source.shape[0])
                                self.stretch_results[output_id] = dict(source=source_id, details=details)
                                job["result"] = dict(details, image=output_id)
                            except Exception:
                                self.delete(output_id)
                                raise
                        else:
                            result_id = request["image"]
                            result = self.stretch_results.get(result_id)
                            if not result or result["source"] not in self.stretch_sources:
                                raise ValueError("拉伸结果或来源已失效，请重新预览后保存。")
                            job["result"] = save_stretch(self.get(result_id), self.stretch_sources[result["source"]],
                                                         result["details"], request["output"], canceled)
                    elif operation in ("backgroundFit", "backgroundRender"):
                        from .background import fit_background, render_background
                        image_id = request["image"]
                        image = self.get(image_id)
                        canceled = lambda: job.get("cancel", False)
                        job["message"] = "生成背景取样与稳健平面…" if operation == "backgroundFit" else "渲染完整尺寸背景预览…"
                        if operation == "backgroundFit":
                            self.background_models.pop(image_id, None)
                            model = fit_background(image,
                                self.get(request["protection"]) if request.get("protection") else None,
                                self.get(request["sampling"]) if request.get("sampling") else None, progress, canceled)
                            self.background_models[image_id] = model
                            job["result"] = model
                        else:
                            if image_id not in self.background_models:
                                raise ValueError("背景模型已失效，请重新生成建议。")
                            output_id = self.create(image.shape[1], image.shape[0], image.shape[2])
                            try:
                                entry = self.images[output_id]
                                stats = render_background(image, self.background_models[image_id], entry["data"],
                                                          request["strength"], request.get("view", "result"), progress, canceled)
                                entry["data"].flush()
                                entry.update(ready=True, rows=image.shape[0])
                                job["result"] = {"image": output_id, "stats": stats}
                            except Exception:
                                self.delete(output_id)
                                raise
                    elif operation in ("denoiseFit", "denoiseRender"):
                        from .background_denoise import noise_model, filter_delta, mix_denoise
                        from .star_processing import number
                        image_id = request["image"]
                        image = self.get(image_id, "denoise-source")
                        canceled = lambda: job.get("cancel", False)
                        if canceled():raise InterruptedError("背景降噪已取消")
                        if operation == "denoiseFit":
                            previous = self.denoise_models.pop(image_id, None)
                            if previous and previous.get("candidate"):
                                self.delete(previous["candidate"]["image"])
                            scope, target = request.get("scope", "selection"), request.get("target")
                            if scope == "selection" and not target:
                                raise ValueError("请先读取背景作用选区")
                            if scope not in ("selection", "starless") or (scope == "starless" and request.get("confirmedStarless") is not True):
                                raise ValueError("整层处理需明确确认为无星背景")
                            target = target if scope == "selection" else None
                            job["message"] = "估计背景局部噪声…"
                            model = noise_model(image, self.get(target) if target else None, progress, canceled)
                            self.denoise_models[image_id] = dict(model=model, target=target)
                            job["result"] = model
                        else:
                            if image_id not in self.denoise_models:
                                raise ValueError("噪声模型已失效，请重新读取生成")
                            entry = self.denoise_models[image_id];options = request["options"]
                            detail = number(options, "detail", .5, 0, 1)
                            strength = number(options, "strength", .5, 0, 1)
                            correlated = options.get("correlated", False)
                            if not isinstance(correlated, bool):raise ValueError("相关色噪选项必须为布尔值")
                            model = dict(entry["model"], sigma=entry["model"]["backgroundSigma"] if correlated else entry["model"]["sigma"])
                            if options.get("mode", "chroma") not in ("chroma", "joint") or (color_count(image) == 1 and options.get("mode", "chroma") != "joint"):
                                raise ValueError("灰度请使用亮度降噪；RGB可选择仅色噪或联合模式")
                            view = request.get("view", "result")
                            target = self.get(entry["target"]) if entry["target"] else None
                            cached = entry.get("candidate")
                            reused = bool(cached and cached["detail"] == detail and cached["sigma"] == model["sigma"])
                            computed = False
                            if strength and model["sigma"] and view == "result" and not reused:
                                job["message"] = "按背景小块计算NLM；取消在当前块完成后生效…"
                                candidate_id = self.create(image.shape[1], image.shape[0], color_count(image), "denoise-delta", dtype="<f8")
                                try:
                                    candidate = self.images[candidate_id]
                                    details = filter_delta(image, model, candidate["data"], detail, target, lambda x:progress(.85*x), canceled)
                                    candidate["data"].flush();candidate.update(ready=True, rows=image.shape[0])
                                    entry["candidate"] = dict(image=candidate_id, sigma=model["sigma"], **details)
                                except Exception:
                                    self.delete(candidate_id);raise
                                if cached:self.delete(cached["image"])
                                cached = entry["candidate"];computed = True
                            job["message"] = "混合完整尺寸降噪预览…"
                            output_id = self.create(image.shape[1], image.shape[0], image.shape[2])
                            try:
                                output = self.images[output_id]
                                stats = mix_denoise(image, model, self.get(cached["image"], "denoise-delta") if cached else None,
                                    output["data"], options, target, view, lambda x:progress(.85+.15*x if computed else x), canceled)
                                output["data"].flush();output.update(ready=True, rows=image.shape[0])
                                job["result"] = dict(image=output_id, stats=stats, filterReused=reused)
                            except Exception:
                                self.delete(output_id);raise
                    elif operation in ("colorFit", "colorRender"):
                        from .sky_color import fit_color, render_color
                        image_id = request["image"]
                        image = self.get(image_id, "color-source")
                        canceled = lambda: job.get("cancel", False)
                        if operation == "colorFit":
                            self.color_models.pop(image_id, None)
                            job["message"] = "分析指定天空背景颜色…"
                            protection = request.get("protection")
                            model = fit_color(image, self.get(request["sampling"]), self.get(protection) if protection else None, progress, canceled)
                            self.color_models[image_id] = dict(model=model, protection=protection)
                            job["result"] = model
                        else:
                            job["message"] = "计算完整尺寸受保护颜色…"
                            if image_id not in self.color_models:
                                raise ValueError("颜色模型已失效，请重新生成取样建议")
                            cached = self.color_models[image_id]
                            output_id = self.create(image.shape[1], image.shape[0], image.shape[2])
                            try:
                                entry = self.images[output_id]
                                stats = render_color(image, cached["model"], entry["data"], request["options"],
                                                     self.get(cached["protection"]) if cached["protection"] else None,
                                                     request.get("view", "result"), progress, canceled)
                                entry["data"].flush()
                                entry.update(ready=True, rows=image.shape[0])
                                job["result"] = dict(image=output_id, stats=stats)
                            except Exception:
                                self.delete(output_id)
                                raise
                    elif operation in ("maskGenerate", "maskSave"):
                        from .protection_masks import make_mask, save_mask
                        canceled = lambda: job.get("cancel", False)
                        if operation == "maskGenerate":
                            job["message"] = "生成完整尺寸保护蒙版…"
                            options = request["options"]
                            purpose = "image" if options.get("mode") == "subject" else "mask-source"
                            image, details = make_mask(self.get(request["image"], purpose), options, progress, canceled)
                            output_id = self.save(image)
                            if canceled():
                                self.delete(output_id)
                                raise InterruptedError("蒙版生成已取消")
                            self.protection_masks[output_id] = details
                            job["result"] = dict(details, image=output_id)
                        else:
                            job["message"] = "保存32位灰度蒙版副本…"
                            image_id = request["image"]
                            if image_id not in self.protection_masks:
                                raise ValueError("蒙版结果已失效，请重新生成")
                            job["result"] = save_mask(self.get(image_id), self.protection_masks[image_id], request["output"], canceled)
                    elif operation == "processStars":
                        from .star_processing import process_stars, curve_values
                        if job.get("cancel"):
                            job["state"] = "canceled"
                            return
                        job["message"] = "正在加工星点…"
                        scale = float(request.get("scale", 1))
                        encoding = request.get("starEncoding", "black")
                        source = (request["image"], scale, encoding)
                        if self.processing_cache.get("source") != source:
                            self.processing_cache.clear()
                            self.processing_cache["source"] = source
                        options = {"encoding": encoding} if encoding != "black" else {}
                        output, details = process_stars(self.get(request["image"]), request["settings"],
                                                       self.path, scale, progress, self.processing_cache, **options)
                        if job.get("cancel"):
                            job["state"] = "canceled"
                            return
                        job["result"] = {"image": self.save(output), **details,
                                         "curve": curve_values(np.linspace(0, 1, 256), request["settings"].get("curve", {})).tolist()}
                        if request.get("preview"):
                            import base64
                            rgb = output[..., :color_count(output)].copy()
                            if output.shape[2] != rgb.shape[2]:
                                rgb *= output[..., -1:]
                            if rgb.shape[2] == 1:
                                rgb = np.repeat(rgb, 3, axis=2)
                            buffer = io.BytesIO()
                            Image.fromarray(np.rint(rgb*255).astype(np.uint8)).save(buffer, format="PNG")
                            job["result"]["preview"] = "data:image/png;base64,"+base64.b64encode(buffer.getvalue()).decode()
                        if job.get("cancel"):
                            self.delete(job.pop("result")["image"])
                            job["state"] = "canceled"
                            return
                    elif operation == "extract":
                        original = self.get(request["image"])
                        validate_image(original)
                        colors = np.asarray(original[..., :color_count(original)])
                        if request.get("engine", "starnet") != "starnet":
                            raise ValueError("星点分离仅支持 StarNet++；请在星点提取模型中配置程序位置。")
                        folder = self.path / key
                        folder.mkdir()
                        timings = {}
                        def engine_report(state):
                            timings.update({name: value for name, value in state.items() if name.endswith("Seconds")})
                            job.update({name: value for name, value in state.items() if name in ("message", "provider")})
                        bg = starnet(colors, folder, request.get("executable", str(ROOT / "engines/starnet/starnet++.exe")),
                                     int(request.get("stride", 256)), progress, request.get("license_sha256"), engine_report)
                        job["message"] = "生成背景和星点图层…"
                        separate_started = time.perf_counter()
                        preserve_model = request.get("preserveModelBackground", False)
                        encoding = request.get("starEncoding", "gray") if preserve_model else "black"
                        bg, stars = separate(original, bg, request.get("mode", "screen"), preserve_model, encoding)
                        job["result"] = {"background": self.save(bg), "stars": self.save(stars),
                                         "starEncoding": encoding,
                                         "timings": timings, "provider": job.get("provider", "CPU（旧版）")}
                        timings["separateSeconds"] = time.perf_counter()-separate_started
                    elif operation == "mix":
                        b = self.get(request["background"])
                        s = self.get(request["stars"])
                        if b.shape != s.shape:
                            raise ValueError("图层尺寸或通道不一致")
                        result = np.empty_like(b)
                        for y in range(0, b.shape[0], 128):
                            result[y:y+128] = combine(sequence(b[y:y+128], request.get("bchain", []), request["bp"]),
                                                     sequence(s[y:y+128], request.get("schain", []), request["sp"]), request["mode"])
                            progress(min(1, (y+128)/b.shape[0]))
                        job["result"] = {"image": self.save(result)}
                    else:
                        raise ValueError("未知操作")
                    job.update(state="done", progress=1)
            except Exception as e:
                if operation in ("fitsInspect", "fitsImport", "denoiseFit", "denoiseRender", "colorFit", "colorRender", "maskGenerate", "maskSave", "stackCrop", "processStars", "prepareInspect", "prepareLinear", "backgroundFit", "backgroundRender", "stretchInspect", "stretchRender", "stretchSave") and job.get("cancel"):
                    job["state"] = "canceled"
                else:
                    if operation == "stack" and getattr(e,"failed_file",None):
                        job.update(failedFile=e.failed_file,alignment=e.alignment)
                    job.update(state="error", error=str(e))
        threading.Thread(target=run, daemon=True).start()
        return key


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Do not log tokens, image bytes, or full query strings.
        print(f"{self.command} {urlparse(self.path).path} {args[1] if len(args)>1 else ''}", flush=True)

    def reply(self, data, status=200, kind="application/json"):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8") if kind == "application/json" else data
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Star-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.end_headers()

    def do_GET(self):
        self.handle_api()

    def do_POST(self):
        self.handle_api()

    def do_DELETE(self):
        self.handle_api()

    def handle_api(self):
        if not secrets.compare_digest(self.headers.get("X-Star-Token", ""), self.server.token):
            self.reply({"error": "本地服务认证失败"}, 403)
            return
        try:
            self.server.last_activity = time.monotonic()
            store = self.server.store
            path = urlparse(self.path)
            parts = path.path.strip("/").split("/")
            q = {k: v[0] for k, v in parse_qs(path.query).items()}
            if self.command == "GET" and parts == ["health"]:
                self.reply({"ok": True, "version": VERSION})
                return
            length = int(self.headers.get("Content-Length", 0))
            if length < 0 or length > 64*1024*1024:
                raise ValueError("请求过大，请分块上传")
            body = self.rfile.read(length) if self.command == "POST" else b""
            image_purposes = {"images": "image", "mask-sources": "mask-source", "color-sources": "color-source", "denoise-sources": "denoise-source"}
            if self.command == "POST" and len(parts) == 1 and parts[0] in image_purposes:
                r = json.loads(body)
                self.reply({"id": store.create(int(r["width"]), int(r["height"]), int(r["components"]),
                                              image_purposes[parts[0]])})
            elif len(parts) == 2 and parts[0] in image_purposes:
                key = parts[1]
                purpose = image_purposes[parts[0]]
                if store.images[key]["purpose"] != purpose:
                    raise ValueError("图像来源类型与入口不符")
                if self.command == "POST":
                    entry = store.images[key]
                    a = entry["data"]
                    y, rows = int(q["y"]), int(q["rows"])
                    if entry["ready"] or y != entry["rows"] or rows <= 0 or y+rows > a.shape[0]:
                        raise ValueError("图像块必须按顺序完整上传")
                    if len(body) != rows*a.shape[1]*a.shape[2]*4:
                        raise ValueError("图像块字节数不符")
                    block = np.frombuffer(body, dtype="<f4").reshape(rows, a.shape[1], a.shape[2])
                    if purpose != "image":
                        from .protection_masks import validate_source
                        validate_source(block)
                    else:
                        validate_image(block)
                    a[y:y+rows] = block
                    entry["rows"] += rows
                    entry["ready"] = entry["rows"] == a.shape[0]
                    if entry["ready"]:
                        a.flush()
                    self.reply({"ready": entry["ready"]})
                elif self.command == "GET":
                    a = store.get(key, purpose)
                    y, rows = int(q.get("y", 0)), int(q.get("rows", 128))
                    if y < 0 or rows <= 0 or y+rows > a.shape[0] or rows*a.shape[1]*a.shape[2]*4 > 64*1024*1024:
                        raise ValueError("无效图像块范围")
                    self.reply(a[y:y+rows].tobytes(), kind="application/octet-stream")
                elif self.command == "DELETE":
                    store.delete(key)
                    self.reply({"ok": True})
            elif self.command == "POST" and parts == ["starnet-info"]:
                self.reply(starnet_info(json.loads(body)["executable"]))
            elif self.command == "POST" and parts == ["jobs"]:
                self.reply({"id": store.job(json.loads(body))})
            elif len(parts) == 2 and parts[0] == "jobs" and self.command in ("GET", "DELETE"):
                if self.command == "DELETE":
                    store.jobs[parts[1]]["cancel"] = True
                self.reply(store.jobs[parts[1]])
            elif self.command == "POST" and parts == ["preview"]:
                r = json.loads(body)
                b, s = store.get(r["background"]), store.get(r["stars"])
                step = max(1, int(np.ceil(max(b.shape[:2])/1600)))
                b, s = sequence(b[::step, ::step], r.get("bchain", []), r["bp"]), sequence(s[::step, ::step], r.get("schain", []), r["sp"])
                mix = combine(b, s, r["mode"])
                def png(a):
                    import base64
                    rgb = a[..., :color_count(a)]
                    if rgb.shape[2] == 1:
                        rgb = np.repeat(rgb, 3, axis=2)
                    f = io.BytesIO()
                    Image.fromarray(np.rint(rgb*255).astype(np.uint8)).save(f, format="PNG")
                    return "data:image/png;base64," + base64.b64encode(f.getvalue()).decode()
                def hist(a):
                    n = color_count(a)
                    visible = a[..., n] > 0 if n != a.shape[2] else np.ones(a.shape[:2], dtype=bool)
                    return [np.histogram(a[..., k][visible], bins=256, range=(0, 1))[0].tolist() for k in range(n)]
                canvas = {"id":store.preview(mix), "width":mix.shape[1], "height":mix.shape[0], "components":mix.shape[2]} if r.get("canvas") else None
                self.reply({"background": png(b), "stars": png(s), "mix": png(mix), "canvas":canvas,
                            "bh": hist(b), "sh": hist(s),
                            "bc": stretch_curve_list(r["bp"]), "sc": stretch_curve_list(r["sp"])})
            elif self.command == "POST" and parts == ["sample"]:
                r = json.loads(body)
                a = store.get(r["image"])
                x, y = int(float(r["u"])*a.shape[1]), int(float(r["v"])*a.shape[0])
                if not (0 <= x < a.shape[1] and 0 <= y < a.shape[0]):
                    raise ValueError("请在图像范围内取样")
                a = sequence(a[max(0,y-1):y+2,max(0,x-1):x+2], r.get("chain", []), {})
                n = color_count(a)
                visible = a[..., n]>0 if n!=a.shape[2] else np.ones(a.shape[:2], dtype=bool)
                if not visible.any():
                    raise ValueError("取样位置是透明区域")
                rgb = a[..., :n][visible].mean(axis=0)
                lum = float(rgb[0] if n==1 else rgb @ np.array([.2126,.7152,.0722]))
                self.reply({"value": lum})
            else:
                self.reply({"error": "路径不存在"}, 404)
        except (ValueError, KeyError, TypeError, OSError) as e:
            self.reply({"error": str(e)}, 400)
        except Exception as e:
            self.reply({"error": str(e)}, 500)


def stretch_curve_list(p):
    from .algorithms import stretch_curve
    return stretch_curve(np.linspace(0, 1, 256), p).tolist()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--idle-seconds", type=float, default=90)
    args = parser.parse_args()
    config = json.loads((ROOT / "plugin/bridge.json").read_text(encoding="utf-8"))
    folder = ROOT / "artifacts/jobs" / time.strftime("%Y%m%d-%H%M%S")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.token = config["token"]
    server.store = Store(folder)
    server.last_activity = time.monotonic()
    def idle_exit():
        while True:
            time.sleep(min(5, args.idle_seconds))
            working = any(j["state"] in ("running", "queued") for j in server.store.jobs.values())
            if not working and time.monotonic()-server.last_activity > args.idle_seconds:
                print("Panel disconnected; stopping idle component.", flush=True)
                server.shutdown()
                return
    threading.Thread(target=idle_exit, daemon=True).start()
    print(f"Star Layers bridge listening on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
    server.server_close()


if __name__ == "__main__":
    main()
