"""Float image pipeline. GHS mathematics adapted from Siril (GPL-3.0-or-later)."""
from pathlib import Path
import json
import subprocess
import threading
import time
import numpy as np
import tifffile

from .paths import ROOT
from .starnet_install import starnet_info


def validate_image(image):
    if image.ndim != 3 or image.shape[2] not in (1, 2, 3, 4):
        raise ValueError("需要灰度、灰度+透明度、RGB 或 RGBA 像素")
    if not np.isfinite(image).all() or image.min() < 0 or image.max() > 1:
        raise ValueError("像素必须在 0..1 内；请先将 HDR 图像映射到普通范围")


def color_count(image):
    return 3 if image.shape[2] >= 3 else 1


def starnet(image, workdir, executable, stride=256, progress=lambda x: None, license_sha256=None,
            report=lambda state: None):
    started = time.perf_counter()
    report({"message": "准备引擎输入…"})
    info = starnet_info(executable)
    exe = Path(executable).resolve()
    if not info['installation']['ready']:
        raise ValueError('StarNet缺少文件：'+'、'.join(info['installation']['missing'])+'；请完整解压官方包后重试。')
    if info["modern"] and license_sha256 != info["license_sha256"]:
        raise ValueError("请在星点提取模型中阅读并同意当前 StarNet2 许可后再执行。")
    validate_image(image)
    if stride not in ((64, 128, 256, 384) if info["modern"] else (64, 128, 256)):
        raise ValueError("384 步长需要新版 StarNet2；旧版请选择 256、128 或 64")
    workdir = Path(workdir).resolve()
    suffix = ".fits" if info["modern"] else ".tif"
    source, output = workdir / ("input" + suffix), workdir / ("starless" + suffix)
    # The current CLI needs 512px; legacy v2 needs 256px. Crop after padding.
    h, w, c = image.shape
    size = info["minimum_size"]
    padded = np.pad(image, ((0, max(0, size-h)), (0, max(0, size-w)), (0, 0)), mode="reflect") if h < size or w < size else image
    if info["modern"]:
        from astropy.io import fits
        fits.writeto(source, padded[..., 0] if c == 1 else padded.transpose(2, 0, 1), overwrite=True)
        # CFITSIO in the Windows CLI cannot open Unicode absolute paths.
        # Relative names work inside a Unicode job directory; weights and DLLs
        # are located beside the executable by the official CLI itself.
        command = [str(exe), "--input", source.name, "--output", output.name, "--stride", str(stride), "--machine-progress"]
    else:
        encoded = np.rint(padded * 65535).astype(np.uint16)
        tifffile.imwrite(source, encoded[..., 0] if c == 1 else encoded,
                         photometric="minisblack" if c == 1 else "rgb", metadata=None)
        command = [str(exe), str(source), str(output), str(stride)]
    progress(0.05)
    report({"prepareSeconds": time.perf_counter()-started, "message": "启动 StarNet 推理…"})
    engine_started = time.perf_counter()
    with (workdir / "starnet.log").open("w", encoding="utf-8") as log:
        result = subprocess.Popen(command, cwd=workdir if info["modern"] else exe.parent,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                  encoding="utf-8", errors="replace",
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        def read_log():
            for line in result.stdout:
                log.write(line)
                log.flush()
                if not info["modern"]:
                    continue
                try:
                    event = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("schema") == "starnetastro.cli.progress.v1" and event.get("stage") == "inference":
                    percent = event.get("percent")
                    if isinstance(percent, (int, float)) and np.isfinite(percent) and 0 <= percent <= 100:
                        progress(.05 + .85*percent/100)
                elif event.get("code") == "inference_backend":
                    backend = str(event.get("message", ""))
                    provider = next((name for name in ("DirectML", "CUDA", "CPU") if name.lower() in backend.lower()), "未知")
                    report({"provider": provider, "message": "StarNet 推理（"+provider+"）…"})
                elif event.get("code") == "output":
                    report({"message": "引擎保存结果…"})
        reader = threading.Thread(target=read_log, daemon=True)
        reader.start()
        try:
            result.wait(timeout=7200)
        except subprocess.TimeoutExpired:
            result.kill()
            result.wait()
            raise
        finally:
            reader.join()
            result.stdout.close()
    report({"engineSeconds": time.perf_counter()-engine_started, "message": "读取引擎结果…"})
    read_started = time.perf_counter()
    if result.returncode or not output.exists():
        detail = (workdir / "starnet.log").read_text(encoding="utf-8", errors="replace")[-1800:]
        raise RuntimeError(f"StarNet 失败 ({result.returncode}): {detail}")
    if info["modern"]:
        data = fits.getdata(output)
        if data.dtype.kind != "f" or data.dtype.itemsize != 4:
            raise ValueError("StarNet2 未返回 32 位浮点 FITS")
        data = data.astype(np.float32)
        if data.ndim == 3:
            data = data.transpose(1, 2, 0)
    else:
        data = tifffile.imread(output)
        if data.dtype != np.uint16:
            raise ValueError("StarNet 未返回 16 位 TIFF")
        data = data.astype(np.float32) / 65535
    if data.ndim == 2:
        data = data[..., None]
    if data.shape != padded.shape:
        raise ValueError(f"StarNet 输出尺寸不符: {data.shape}")
    validate_image(data)
    report({"readSeconds": time.perf_counter()-read_started})
    progress(1)
    return data[:h, :w]


def separate(original, background, mode="screen", preserve_model=False, star_encoding="gray"):
    validate_image(original)
    n = color_count(original)
    if background.shape != original[..., :n].shape:
        raise ValueError("背景尺寸不符")
    # Network can brighten some pixels. Bound the background to the source so
    # the star layer is nonnegative and exactly reconstructs the input.
    if preserve_model:
        validate_image(background)
        bg = background
    else:
        bg = np.minimum(np.clip(background, 0, 1), original[..., :n])
    delta = original[..., :n] - bg
    if preserve_model:
        if star_encoding not in ("gray", "signed"):
            raise ValueError("未知修正星点编码")
        # Preserve negative corrections instead of reimposing the source's
        # dark, colored star edges on the model background. Integer Photoshop
        # layers use a 50% gray offset with Linear Light; float32 uses addition.
        stars = (delta+1)/2 if star_encoding == "gray" else delta
    elif mode == "screen":
        stars = np.divide(delta, 1-bg, out=np.zeros_like(delta), where=bg < 1)
    elif mode == "add":
        stars = delta
    else:
        raise ValueError("未知分离方式")
    if original.shape[2] != n:
        bg = np.concatenate((bg, original[..., n:]), axis=2)
        stars = np.concatenate((stars, original[..., n:]), axis=2)
    return bg.astype(np.float32), stars.astype(np.float32)


def _asinh_interval(start, delta):
    """asinh(start+delta)-asinh(start), stable for tiny positive deltas."""
    end = start+delta
    denominator = end*np.hypot(1, start)+start*np.hypot(1, end)
    ratio = np.divide(end+start, denominator, out=np.ones_like(end), where=denominator != 0)
    return np.where(start*end >= 0, np.arcsinh(delta*ratio), np.arcsinh(end)-np.arcsinh(start))


def stretch_curve(x, p, *, dtype=np.float32, clip=True):
    """Siril GHS/modified arcsinh, normalized protected tangent segments.

    lnD is the user-facing ln(D+1). BP shift is AFTER stretching, as in Siril
    star recomposition. LP <= SP <= HP defines the protected end regions.
    """
    d, b = float(p.get("lnD", 0)), float(p.get("b", 0))
    lp, sp, hp, bp = (float(p.get(k, v)) for k, v in (("lp", 0), ("sp", 0), ("hp", 1), ("bp", 0)))
    kind = p.get("type", "ghs")
    if not all(np.isfinite(v) for v in (d, b, lp, sp, hp, bp)):
        raise ValueError("拉伸参数必须为有限数值")
    if not (0 <= d <= 10 and -5 <= b <= 15 and 0 <= lp <= sp <= hp <= 1 and 0 <= bp < 1):
        raise ValueError("需要 0≤LP≤SP≤HP≤1，BP<1，ln(D+1)∈[0,10]，b∈[-5,15]")
    if kind not in ("ghs", "asinh", "linear"):
        raise ValueError("未知拉伸类型")
    x = np.asarray(x, dtype=np.float64)
    D = np.expm1(d)
    if D < 1e-7 or kind == "linear":
        out = x
    else:
        def primitive(t):
            u = np.abs(t)
            if kind == "asinh":
                f = np.arcsinh(D*u)
            elif abs(b) < 1e-8:
                f = -np.expm1(-D*u)
            elif b > 0:
                f = -np.expm1(-np.log1p(D*b*u)/b)
            elif abs(b+1) < 1e-8:
                f = np.log1p(D*u)
            else:
                beta = -b
                f = np.expm1(((beta-1)/beta)*np.log1p(D*beta*u))/(beta-1)
            return np.sign(t)*f

        def slope(u):
            if kind == "asinh":
                return D / np.sqrt(1+(D*u)**2)
            if abs(b) < 1e-8:
                return D*np.exp(-D*u)
            if b > 0:
                return D*(1+D*b*u)**(-(b+1)/b)
            return D*(1+D*(-b)*u)**(1/b)

        sl, sh = slope(sp-lp), slope(hp-sp)
        if kind == "asinh":
            # Integrate from zero using nonnegative intervals. Subtracting two
            # almost equal primitives used to erase very faint positive input.
            span = _asinh_interval(D*(lp-sp), np.asarray(D*(hp-lp)))
            f = lp*sl+_asinh_interval(D*(lp-sp), D*(np.clip(x, lp, hp)-lp))
            f = np.where(x < lp, x*sl, np.where(x > hp, lp*sl+span+(x-hp)*sh, f))
            out = f/(lp*sl+span+(1-hp)*sh)
        else:
            fl, fh = primitive(lp-sp), primitive(hp-sp)
            f0, f1 = fl-lp*sl, fh+(1-hp)*sh
            f = primitive(np.clip(x, lp, hp)-sp)
            f = np.where(x < lp, fl+(x-lp)*sl, np.where(x > hp, fh+(x-hp)*sh, f))
            out = (f-f0)/(f1-f0)
    out = (out-bp)/(1-bp)
    return (np.clip(out, 0, 1) if clip else out).astype(dtype)


def stretch(image, p):
    validate_image(image)
    n = color_count(image)
    rgb = image[..., :n]
    color = p.get("color", "luminance")
    clipping = p.get("clipping", "blend")
    if color not in ("luminance", "independent"):
        raise ValueError("未知颜色模型")
    if clipping not in ("blend", "clip"):
        raise ValueError("未知修剪模式")
    if n == 1 or color == "independent":
        result = stretch_curve(rgb, p)
    else:
        lum = np.sum(rgb * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32), axis=2, keepdims=True)
        mapped = stretch_curve(lum, p)
        result = rgb * np.divide(mapped, lum, out=np.zeros_like(lum), where=lum > 0)
        # RGB blend clipping: blend toward the target neutral luminance until
        # the brightest component fits, preserving luminance over hard clipping.
        if clipping == "blend":
            peak = result.max(axis=2, keepdims=True)
            t = np.divide(1-mapped, peak-mapped, out=np.ones_like(peak), where=peak > 1)
            result = np.where(peak > 1, mapped + t*(result-mapped), result)
        result = np.clip(result, 0, 1)
    if image.shape[2] != n:
        result = np.concatenate((result, image[..., n:]), axis=2)
    return result.astype(np.float32)


def combine(background, stars, mode="screen"):
    if background.shape != stars.shape:
        raise ValueError("背景与星点必须尺寸、颜色通道一致")
    validate_image(background)
    validate_image(stars)
    n = color_count(background)
    b, s = background[..., :n], stars[..., :n]
    if mode == "screen":
        result = b+s-b*s
    elif mode == "add":
        result = np.minimum(b+s, 1)
    else:
        raise ValueError("未知混合方式")
    if background.shape[2] != n:
        result = np.concatenate((result, np.maximum(background[..., n:], stars[..., n:])), axis=2)
    return result.astype(np.float32)
