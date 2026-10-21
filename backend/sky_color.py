"""Local visual color edits in the document's working RGB; not photometry."""
import base64
import io

from astropy.stats import mad_std, sigma_clip
import numpy as np
from PIL import Image

from .background import mask_data
from .protection_masks import validate_source
from .star_processing import adjust_color, luminance, number, smooth


def check(canceled):
    if canceled():
        raise InterruptedError("天空校色已取消")


def fit_color(image, sampling, protection=None, progress=lambda x: None, canceled=lambda: False):
    h, w, c = image.shape
    if c not in (3, 4):
        raise ValueError("天空校色需要RGB照片；灰度不会自动转彩色")
    if sampling is None:
        raise ValueError("请先用选区指定可靠天空背景，不自动使用全图")
    sample, protect = mask_data(sampling, (h, w)), mask_data(protection, (h, w))
    def eligible(y, stop):
        block = image[y:stop]
        valid = (sample[y:stop] >= .999) & (block[..., :3].min(axis=2) > 0) & (block[..., :3].max(axis=2) < .95)
        if c == 4:
            valid &= block[..., 3] >= .999
        if protect is not None:
            valid &= protect[y:stop] <= .001
        return valid
    count = 0
    for y in range(0, h, 256):
        check(canceled)
        validate_source(image[y:y+256])
        count += int(eligible(y, y+256).sum())
        progress(.3*min(h, y+256)/h)
    if count < 64:
        raise ValueError("可靠天空取样少于64像素；请扩大选区，避开黑白端点、透明区和被保护主体")
    stride, cursor, parts = max(1, int(np.ceil(count/200000))), 0, []
    for y in range(0, h, 256):
        check(canceled)
        values = image[y:y+256, :, :3][eligible(y, y+256)]
        parts.append(values[(-cursor) % stride::stride].copy())
        cursor += len(values)
        progress(.3+.4*min(h, y+256)/h)
    values = np.concatenate(parts).astype(np.float64)
    clipped = sigma_clip(values, sigma=3, maxiters=5, axis=0, cenfunc="median", stdfunc="mad_std")
    accepted = values[~np.ma.getmaskarray(clipped).any(axis=1)]
    if len(accepted) < 64:
        raise ValueError("异常剔除后可靠背景不足64像素，请重新选择平稳的天空")
    median = np.median(accepted, axis=0)
    lum = luminance(accepted[:, None, :]).ravel()
    check(canceled)
    step = max(1, int(np.ceil(max(h, w)/700)))
    # Positional guide only; color comparisons use the ICC-inheriting PS preview.
    thumb = np.clip(image[::step, ::step, :3], 0, 1).copy()
    selected = sample[::step, ::step] >= .999
    thumb[selected] = thumb[selected]*.6+np.array([.1, 1, .4])*.4
    if protect is not None:
        selected = protect[::step, ::step] > .001
        thumb[selected] = thumb[selected]*.6+np.array([1, .3, .1])*.4
    stream = io.BytesIO()
    Image.fromarray(np.rint(thumb*255).astype(np.uint8)).save(stream, format="PNG")
    progress(1)
    check(canceled)
    return dict(width=w, height=h, median=median.tolist(), offset=(median.mean()-median).tolist(),
                background=float(np.median(lum)), scatter=float(mad_std(lum)),
                candidates=count, sampled=len(values), rejected=len(values)-len(accepted), accepted=len(accepted),
                samplingPreview="data:image/png;base64,"+base64.b64encode(stream.getvalue()).decode())


def render_color(image, model, output, options, protection=None, view="result", progress=lambda x: None, canceled=lambda: False):
    neutral = number(options, "neutral", 0, 0, 1)
    boost = number(options, "boost", 0, 0, 1)
    background_factor = number(options, "backgroundFactor", 2, 0, 5)
    bright = number(options, "bright", .7, .1, .94)
    h, w, c = image.shape
    if c not in (3, 4) or model["width"] != w or model["height"] != h or output.shape != image.shape or view not in ("result", "weights"):
        raise ValueError("颜色模型、视图或输出尺寸不匹配，请重新生成")
    protect = mask_data(protection, (h, w))
    offset = np.asarray(model["offset"], dtype=np.float64)
    dark = float(model["background"])+background_factor*float(model["scatter"])
    transition = max(float(model["scatter"]), .0001)
    negative = above = 0
    lo, hi = float("inf"), -float("inf")
    for y in range(0, h, 128):
        check(canceled)
        stop = min(h, y+128)
        block = image[y:stop]
        rgb = block[..., :3].astype(np.float64)
        source_lum = luminance(rgb)
        visible = block[..., 3] > 0 if c == 4 else np.ones(rgb.shape[:2], dtype=bool)
        weight = 1-smooth((rgb.max(axis=2)-bright)/(.95-bright))
        weight *= visible
        if protect is not None:
            weight *= 1-protect[y:stop]
        output[y:stop] = block
        if neutral:
            active = weight > 0
            rgb[active] += neutral*weight[active, None]*offset
        chroma_weight = weight*smooth((source_lum-dark)/transition)
        eligible = (rgb.min(axis=2) >= 0) & (rgb.max(axis=2) <= 1) & (chroma_weight > 0)
        chroma_weight *= eligible
        if boost and eligible.any():
            selected = rgb[eligible, None, :]
            rgb[eligible] = adjust_color(selected, 1+boost*chroma_weight[eligible, None, None], .85)[:, 0]
        if view == "weights":
            rgb = np.repeat(np.maximum(neutral*weight, boost*chroma_weight)[..., None], 3, axis=2)
            output[y:stop, :, :3] = rgb
        elif neutral or boost:
            active = (neutral*weight > 0) | (boost*chroma_weight*eligible > 0)
            output[y:stop, :, :3][active] = rgb[active]
        colors = output[y:stop, :, :3][visible]
        if colors.size:
            if not np.isfinite(colors).all():
                raise ValueError("颜色结果出现非有限值，未应用")
            negative += int((colors < 0).sum())
            above += int((colors > 1).sum())
            lo, hi = min(lo, float(colors.min())), max(hi, float(colors.max()))
        progress(stop/h)
    check(canceled)
    return dict(minimum=lo, maximum=hi, negativeChannels=negative, aboveOneChannels=above,
                darkThreshold=dark, darkTransition=transition)
