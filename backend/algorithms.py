"""Float image pipeline. GHS mathematics adapted from Siril (GPL-3.0-or-later)."""
from pathlib import Path
import subprocess
import numpy as np
import tifffile

from .paths import ROOT


def validate_image(image):
    if image.ndim != 3 or image.shape[2] not in (1, 2, 3, 4):
        raise ValueError("需要灰度、灰度+透明度、RGB 或 RGBA 像素")
    if not np.isfinite(image).all() or image.min() < 0 or image.max() > 1:
        raise ValueError("像素必须在 0..1 内；请先将 HDR 图像映射到普通范围")


def color_count(image):
    return 3 if image.shape[2] >= 3 else 1


def starnet(image, workdir, executable, stride=256, progress=lambda x: None):
    exe = Path(executable)
    if not exe.is_file():
        raise ValueError(f"找不到 StarNet: {exe}")
    if stride not in (64, 128, 256):
        raise ValueError("StarNet stride 必须为 64、128 或 256")
    workdir = Path(workdir)
    source, output = workdir / "input.tif", workdir / "starless.tif"
    # v2 CLI requires at least 256px; crop back after reflective edge padding.
    h, w, c = image.shape
    padded = np.pad(image, ((0, max(0, 256-h)), (0, max(0, 256-w)), (0, 0)), mode="reflect")
    encoded = np.rint(padded * 65535).astype(np.uint16)
    tifffile.imwrite(source, encoded[..., 0] if c == 1 else encoded,
                     photometric="minisblack" if c == 1 else "rgb", metadata=None)
    progress(0.05)
    with (workdir / "starnet.log").open("w", encoding="utf-8") as log:
        result = subprocess.run([str(exe), str(source), str(output), str(stride)], cwd=exe.parent,
                                stdout=log, stderr=subprocess.STDOUT, timeout=7200,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode or not output.exists():
        detail = (workdir / "starnet.log").read_text(encoding="utf-8", errors="replace")[-1800:]
        raise RuntimeError(f"StarNet 失败 ({result.returncode}): {detail}")
    data = tifffile.imread(output)
    if data.dtype != np.uint16:
        raise ValueError("StarNet 未返回 16 位 TIFF")
    if data.ndim == 2:
        data = data[..., None]
    if data.shape != padded.shape:
        raise ValueError(f"StarNet 输出尺寸不符: {data.shape}")
    progress(1)
    return data[:h, :w].astype(np.float32) / 65535


def separate(original, background, mode="screen"):
    validate_image(original)
    n = color_count(original)
    if background.shape != original[..., :n].shape:
        raise ValueError("背景尺寸不符")
    # Network can brighten some pixels. Bound the background to the source so
    # the star layer is nonnegative and exactly reconstructs the input.
    bg = np.minimum(np.clip(background, 0, 1), original[..., :n])
    delta = original[..., :n] - bg
    if mode == "screen":
        stars = np.divide(delta, 1-bg, out=np.zeros_like(delta), where=bg < 1)
    elif mode == "add":
        stars = delta
    else:
        raise ValueError("未知分离方式")
    if original.shape[2] != n:
        bg = np.concatenate((bg, original[..., n:]), axis=2)
        stars = np.concatenate((stars, original[..., n:]), axis=2)
    return bg.astype(np.float32), stars.astype(np.float32)


def stretch_curve(x, p):
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

        fl, fh = primitive(lp-sp), primitive(hp-sp)
        sl, sh = slope(sp-lp), slope(hp-sp)
        f0, f1 = fl-lp*sl, fh+(1-hp)*sh
        f = primitive(np.clip(x, lp, hp)-sp)
        f = np.where(x < lp, fl+(x-lp)*sl, np.where(x > hp, fh+(x-hp)*sh, f))
        out = (f-f0)/(f1-f0)
    return np.clip((out-bp)/(1-bp), 0, 1).astype(np.float32)


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
