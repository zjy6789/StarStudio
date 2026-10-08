"""Star-layer edits using Siril synthesis, SciPy curves and OpenCV morphology.

Bloom's quadratic soft knee is adapted from Keijiro Takahashi's MIT KinoBloom;
see vendor/KINOBLOOM-LICENSE.txt. Pixels remain float32 throughout.
"""
from pathlib import Path
import subprocess
import tempfile
import re

import cv2
import numpy as np
import tifffile
from scipy.interpolate import PchipInterpolator
from scipy.ndimage import gaussian_filter

from .algorithms import color_count, validate_image

from .paths import siril_path

SIRIL = siril_path()


def number(options, key, default, low, high):
    value = float(options.get(key, default))
    if not np.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{key} 必须在 {low}..{high} 之间。')
    return value


def luminance(rgb):
    return rgb[..., 0] if rgb.shape[2] == 1 else rgb @ np.array([.2126, .7152, .0722], dtype=np.float32)


def smooth(t):
    t = np.clip(t, 0, 1)
    return t*t*(3-2*t)


def bounded_color(rgb):
    # Per-pixel common scale protects hue when an edit exceeds the ordinary range.
    return np.maximum(rgb, 0)/np.maximum(1, np.max(rgb, axis=2, keepdims=True))


def curve_values(values, curve):
    if not curve.get('enabled'):
        return values
    anchors = [0]+[number(curve, k, d, 0, 1) for k, d in [('shadows', .25), ('midtones', .5), ('highlights', .75)]]+[1]
    if np.any(np.diff(anchors) < 0):
        raise ValueError('亮度曲线需满足：暗部 ≤ 中间调 ≤ 亮部。')
    exposure = number(curve, 'exposure', 0, -3, 3)
    return PchipInterpolator([0, .25, .5, .75, 1], anchors)(np.clip(values*2**exposure, 0, 1)).astype(np.float32)


def round_stars(rgb, options, workdir, scale):
    """Use the installed GPL Siril, changing only detected elongated-star regions."""
    if not SIRIL.is_file():
        raise ValueError('彗差减少需要 Siril 1.4 或以上；本机未找到 siril-cli.exe。')
    radius = max(3, round(number(options, 'radius', 8, 3, 50)*scale))
    sigma = number(options, 'sigma', 2, .05, 10)
    roundness = number(options, 'roundness', .9, .1, .99)
    with tempfile.TemporaryDirectory(prefix='star-shape-', dir=workdir) as folder:
        folder = Path(folder)
        a = rgb[..., 0] if rgb.shape[2] == 1 else rgb
        tifffile.imwrite(folder/'input.tif', a, photometric='minisblack' if a.ndim == 2 else 'rgb', metadata=None)
        commands = (f'requires 1.4.0\nsetcpu 8\nload input.tif\n'
                    f'setfindstar reset -radius={radius} -sigma={sigma:g} -roundness=0.05 '
                    f'-maxR={roundness:g} -convergence=3 -gaussian -relax=on\n'
                    'findstar -out=stars.tsv\nsynthstar\nsavetif32 output\nclose\n')
        (folder/'process.ssf').write_text(commands, encoding='utf-8')
        result = subprocess.run([str(SIRIL), '-o', '-d', str(folder), '-s', str(folder/'process.ssf')],
                                capture_output=True, timeout=600,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        log = result.stdout.decode('utf-8', errors='replace')
        if result.returncode or not (folder/'output.tif').exists():
            detail = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', log)[-1200:]
            raise ValueError('Siril 未能重建星形；请降低检测阈值或调整搜索半径。\n'+detail)
        model = tifffile.imread(folder/'output.tif')
        if model.ndim == 2:
            model = model[..., None]
        if model.shape != rgb.shape or model.dtype != np.float32 or not np.isfinite(model).all():
            raise ValueError('Siril 星形输出不是对应尺寸的 32 位浮点图像。')
        # Siril exports top-left image coordinates (verified against an asymmetric fixture).
        stars = []
        for line in (folder/'stars.tsv').read_text(encoding='utf-8').splitlines():
            if not line or line.startswith('#'):
                continue
            columns = line.split('\t')
            stars.append([float(columns[k]) for k in (5, 6, 7, 8)])
        if not stars:
            raise ValueError('未检测到符合圆度条件的星点；请调整圆度上限或检测阈值。')
        mask = np.zeros(rgb.shape[:2], dtype=np.float32)
        h, w = mask.shape
        for x, y, fx, fy in stars:
            radius = max(3., 2*max(fx, fy))
            x0, x1 = max(0, int(x-radius)), min(w, int(x+radius)+1)
            y0, y1 = max(0, int(y-radius)), min(h, int(y+radius)+1)
            yy, xx = np.mgrid[y0:y1, x0:x1]
            distance = np.hypot(xx-x, yy-y)/radius
            mask[y0:y1, x0:x1] = np.maximum(mask[y0:y1, x0:x1], 1-smooth((distance-.6)/.4))
        strength = number(options, 'strength', .5, 0, 1)
        return rgb+(model-rgb)*(mask*strength)[..., None], len(stars)


def eroded_luminance(lum, radius):
    def erode(r):
        if r == 0:
            return lum
        y, x = np.mgrid[-r:r+1, -r:r+1]
        kernel = (x*x+y*y <= r*r).astype(np.uint8)
        return cv2.erode(lum, kernel, borderType=cv2.BORDER_REFLECT_101)
    low = int(np.floor(radius))
    return erode(low)*(1-(radius-low))+erode(low+1)*(radius-low)


def process_stars(image, settings, workdir, scale=1., progress=lambda x: None):
    validate_image(image)
    if not np.isfinite(scale) or not 0 < scale <= 1:
        raise ValueError('无效预览比例。')
    n = color_count(image)
    rgb = image[..., :n].copy()
    alpha = image[..., n:] if image.shape[2] != n else None
    visible = alpha[..., 0] > 0 if alpha is not None else np.ones(rgb.shape[:2], dtype=bool)
    rgb[~visible] = 0  # Invisible RGB must not bleed into neighboring star halos.
    details = {'reconstructedStars': 0}
    coma = settings.get('coma', {})
    if coma.get('enabled') and number(coma, 'strength', .5, 0, 1) > 0:
        rgb, details['reconstructedStars'] = round_stars(rgb, coma, workdir, scale)
    progress(.25)
    reduction = settings.get('reduction', {})
    if reduction.get('enabled'):
        amount = number(reduction, 'strength', .35, 0, 1)
        radius = number(reduction, 'radius', 1, .1, 8)*scale
        threshold = number(reduction, 'threshold', .01, 0, 1)
        protect = number(reduction, 'protect', .8, .01, 1)
        lum = luminance(rgb)
        weight = smooth((lum-threshold)/.03)*(1-smooth((lum-protect)/max(1-protect, .001)))
        target = lum+(eroded_luminance(lum, radius)-lum)*weight*amount
        rgb *= np.divide(target, lum, out=np.ones_like(lum), where=lum > 1e-12)[..., None]
    progress(.4)
    curve = settings.get('curve', {})
    if curve.get('enabled'):
        lum = luminance(rgb)
        target = curve_values(lum, curve)
        rgb = bounded_color(rgb*np.divide(target, lum, out=np.ones_like(lum), where=lum > 1e-12)[..., None])
    progress(.55)
    color = settings.get('color', {})
    if color.get('enabled') and n == 3:
        saturation = number(color, 'saturation', 1, 0, 2)
        protect = number(color, 'protect', .85, .01, 1)
        lum = luminance(rgb)[..., None]
        sat = 1+(saturation-1)*(1-smooth((lum-protect)/max(1-protect, .001)))
        delta = (rgb-lum)*sat
        # Fit chroma to gamut by a common factor, preserving luminance and hue.
        allowance = np.where(delta >= 0, (1-lum)/np.maximum(delta, 1e-12), lum/np.maximum(-delta, 1e-12))
        rgb = lum+delta*np.minimum(1, np.min(allowance, axis=2, keepdims=True))
    progress(.7)
    glow = settings.get('glow', {})
    if glow.get('enabled'):
        strength = number(glow, 'strength', 1, 0, 5)
        radius = number(glow, 'radius', 12, .5, 120)*scale
        lower = number(glow, 'lower', .2, 0, 1)
        upper = number(glow, 'upper', 1, 0, 1)
        softness = number(glow, 'softness', .1, .001, .5)
        spread = number(glow, 'spread', .35, 0, 1)
        if lower >= upper:
            raise ValueError('辉光亮度下限必须小于上限。')
        brightness = np.max(rgb, axis=2)
        # KinoBloom frag_prefilter quadratic soft knee, operating in document values.
        knee = softness
        rq = np.clip(brightness-lower+knee, 0, 2*knee)
        selected = np.maximum(rq*rq/(4*knee), brightness-lower)/np.maximum(brightness, 1e-5)
        if upper < 1:
            selected *= 1-smooth((brightness-upper)/softness)
        source = rgb*selected[..., None]
        if alpha is not None:
            source *= alpha
        halo = gaussian_filter(source, (radius, radius, 0), mode='reflect')*(1-spread)
        if spread:
            halo += gaussian_filter(source, (3*radius, 3*radius, 0), mode='reflect')*spread
        # Soft screen-like blend avoids hard clipping original bright star cores.
        rgb += (1-rgb)*(-np.expm1(-strength*halo))
    progress(.95)
    output = image.copy()
    output[..., :n] = np.where(visible[..., None], np.clip(rgb, 0, 1), image[..., :n])
    progress(1)
    return output, details
