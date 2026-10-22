"""Candidate coverage around compact bright sources, never a photo correction."""
import numpy as np
import sep
from scipy.ndimage import distance_transform_edt, gaussian_filter, maximum_filter

from .protection_masks import validate_source

TILE, CONTEXT = 384, 64


def halo_coverage(image, options, progress=lambda x: None, canceled=lambda: False):
    def check():
        if canceled():
            raise InterruptedError('色晕候选检测已取消')
    check()
    validate_source(image)
    if image.shape[2] not in (3, 4):
        raise ValueError('蓝紫晕候选需要已确认编码的RGB星点层；灰度没有可判断的颜色。')
    radius, core = options.get('radius', 12), options.get('core', 3)
    bright = float(options.get('bright', .25))
    low, high = float(options.get('low', .002)), float(options.get('high', .02))
    if (isinstance(radius, bool) or not isinstance(radius, int) or not 1 <= radius <= 64
            or isinstance(core, bool) or not isinstance(core, int) or not 0 <= core < radius
            or not np.isfinite(bright) or not 0 < bright <= 1 or not 0 <= low < high <= 1):
        raise ValueError('色晕半径须为1..64整数、核心为0..外圈之前的整数；相对亮度须>0且≤1、相对色差须0≤起点<完全覆盖≤1。')
    colors = image[..., :3]
    if options.get('encoding', 'black') == 'gray':
        if (colors < 0).any() or (colors > 1).any():
            raise ValueError('灰底星点值必须在0..1内。')
        neutral = np.float32(round(((1 << options.get('bits', 32))-1)*.5)/((1 << options.get('bits', 32))-1))
        positive = np.where(colors <= neutral, 0, colors*2-1)
    else:
        positive = np.maximum(colors, 0)
    alpha = image[..., 3] if image.shape[2] == 4 else None
    if alpha is not None:
        positive[alpha == 0] = 0
    peak = positive.max(axis=2)
    maximum = float(peak.max())
    if maximum == 0:
        raise ValueError('没有可靠的亮星或蓝紫晕候选；原图未修改。')
    # Relative working-RGB excess. This is a candidate, not a true-color diagnosis.
    red, green, blue = np.moveaxis(positive, -1, 0)
    excess = np.maximum(blue-np.maximum(red, green), np.minimum(red, blue)-green)
    # A common peak reference avoids amplifying color ratios in near-zero tails.
    weights = excess.astype(np.float64)/maximum
    np.clip(weights, low, high, out=weights)
    weights -= low
    weights /= high-low
    weights = (weights*weights*(3-2*weights)).astype(np.float32)
    peak /= maximum  # Derived detection data only; never normalize the photograph.
    del positive, red, green, blue, excess
    check()
    height, width = peak.shape
    seeds = np.zeros((height, width), dtype=np.uint8)
    tiles = ((height+TILE-1)//TILE)*((width+TILE-1)//TILE)
    count = 0
    for y in range(0, height, TILE):
        for x in range(0, width, TILE):
            check()
            top, left = max(0, y-CONTEXT), max(0, x-CONTEXT)
            tile = np.ascontiguousarray(peak[top:min(height, y+TILE+CONTEXT), left:min(width, x+TILE+CONTEXT)])
            objects = sep.extract(tile, bright, minarea=3, filter_kernel=None)
            good = (objects['a'] < 32) & (objects['b'] > .3) & (objects['a']/np.maximum(objects['b'], .1) < 2.5) & (objects['flag'] < 8)
            for obj in objects[good]:
                yy, xx = int(round(float(obj['y'])))+top, int(round(float(obj['x'])))+left
                if y <= yy < min(y+TILE, height) and x <= xx < min(x+TILE, width):
                    seeds[yy, xx] = 1
            count += 1
            progress(.1+.55*count/tiles)
    check()
    stars = int(np.count_nonzero(seeds))
    if not stars:
        raise ValueError('没有可靠的紧致亮星候选；可核对星点来源或降低相对亮度门槛，原图未修改。')
    distance = distance_transform_edt(seeds == 0)
    ring = (distance > core) & (distance <= radius)
    weights *= ring
    progress(.75)
    check()
    grow, feather = options.get('grow', 2), options.get('feather', 1)
    if grow:
        maximum_filter(weights, size=2*grow+1, mode='constant', cval=0, output=weights)
    if feather:
        np.maximum(weights, gaussian_filter(weights, sigma=feather, mode='constant', cval=0), out=weights)
    weights *= ring  # Expansion/softening must not re-enter the protected core.
    if alpha is not None:
        weights *= alpha
    check()
    if not np.any(weights > 0):
        raise ValueError('亮星周围未找到所设门槛的蓝紫候选；不应用空选区，原图未修改。')
    progress(1)
    return weights[..., None], dict(candidateStars=stars, bright=bright, radius=radius, core=core,
                                    method='SEP compact bright sources and relative working-RGB excess',
                                    candidateOnly=True)
