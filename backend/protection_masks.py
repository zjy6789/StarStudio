"""Editable coverage weights from known stellar encodings or a selection snapshot."""
import base64
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, maximum_filter
import tifffile


def validate_source(image):
    if image.ndim != 3 or image.shape[2] not in (1, 2, 3, 4) or not np.isfinite(image).all():
        raise ValueError("蒙版来源必须为有限的灰度或 RGB 浮点数据")
    if image.shape[2] in (2, 4) and ((image[..., -1] < 0).any() or (image[..., -1] > 1).any()):
        raise ValueError("蒙版来源透明度必须在0到1之间")


def make_mask(image, options, progress=lambda x: None, canceled=lambda: False):
    mode, encoding = options.get("mode", "stars"), options.get("encoding", "black")
    bits = options.get("bits", 32)
    low, high = float(options.get("low", .002)), float(options.get("high", .02))
    grow, feather = options.get("grow", 2), float(options.get("feather", 1))
    if mode not in ("stars", "outside", "subject") or encoding not in ("black", "gray", "signed"):
        raise ValueError("未知蒙版任务或星点编码")
    if bits not in (8, 16, 32) or (encoding == "gray" and bits == 32):
        raise ValueError("灰底编码仅支持明确的8/16位来源")
    if not (np.isfinite(low) and np.isfinite(high) and 0 <= low < high <= 1e6):
        raise ValueError("星点阈值需要满足0≤起点<完全覆盖≤1000000")
    if isinstance(grow, bool) or not isinstance(grow, int) or not 0 <= grow <= 64 or not np.isfinite(feather) or not 0 <= feather <= 64:
        raise ValueError("扩展需为0到64的整数；柔化需在0到64像素之间")
    if mode == "subject" and image.shape[2] != 1:
        raise ValueError("主体来源必须为单通道选区")
    def check():
        if canceled():
            raise InterruptedError("蒙版生成已取消")
    h, w, c = image.shape
    mask = np.empty((h, w), dtype=np.float32)
    for y in range(0, h, 256):
        check()
        block = image[y:y+256]
        validate_source(block)
        if mode == "subject":
            values = block[..., 0]
            if (values < 0).any() or (values > 1).any():
                raise ValueError("主体选区权重必须在0到1之间")
            mask[y:y+256] = values
        else:
            colors = block[..., :1 if c in (1, 2) else 3]
            signal = colors.max(axis=2)
            if encoding == "gray":
                if (colors < 0).any() or (colors > 1).any():
                    raise ValueError("灰底编码值必须在0到1之间")
                levels = (1 << bits)-1
                neutral = np.float32(round(levels*.5)/levels)
                signal = np.where(signal <= neutral, 0, signal*2-1)
            np.maximum(signal, 0, out=signal)
            if c in (2, 4):
                signal *= block[..., -1]
            np.clip(signal, low, high, out=signal)
            signal -= low
            signal /= high-low
            mask[y:y+256] = signal*signal*(3-2*signal)
        progress(.45*min(h, y+256)/h)
    check()
    if grow:
        maximum_filter(mask, size=2*grow+1, mode="constant", cval=0, output=mask)
    progress(.65)
    check()
    if feather:
        softened = gaussian_filter(mask, sigma=feather, mode="constant", cval=0)
        np.maximum(mask, softened, out=mask)
    check()
    if mode == "outside":
        np.subtract(1, mask, out=mask)
    progress(.9)
    # Display only; the stored mask and exported TIFF retain all float32 weights.
    step = max(1, int(np.ceil(max(w/900, h/600))))
    thumb = Image.fromarray(np.rint(mask[::step, ::step]*255).astype(np.uint8))
    thumb.thumbnail((900, 600))
    buffer = io.BytesIO()
    thumb.save(buffer, format="PNG")
    details = dict(mode=mode, encoding=encoding, bits=bits, low=low, high=high,
                   grow=grow, feather=feather, width=w, height=h,
                   whiteCoverage=float(np.mean(mask, dtype=np.float64)),
                   corePixels=int(np.count_nonzero(mask >= .99)),
                   preview="data:image/png;base64,"+base64.b64encode(buffer.getvalue()).decode())
    check()
    progress(1)
    return mask[..., None], details


def save_mask(image, details, path, canceled=lambda: False):
    output = Path(path).expanduser()
    if output.suffix.lower() not in (".tif", ".tiff"):
        raise ValueError("蒙版副本需要保存为32位灰度TIFF")
    if output.is_symlink() or output.exists():
        raise ValueError("目标已存在，请选择新的蒙版文件名")
    def check():
        if canceled():
            raise InterruptedError("蒙版保存已取消")
    check()
    created = False
    try:
        with output.open("xb") as stream:
            created = True
            metadata = {k: v for k, v in details.items() if k not in ("preview", "image")}
            tifffile.imwrite(stream, image[..., 0], photometric="minisblack", metadata=None,
                             compression=None, bigtiff=image.nbytes > 4_000_000_000,
                             description=json.dumps(dict(kind="StarStudio-coverage-mask", **metadata)))
        check()
    except Exception:
        if created:
            output.unlink()
        raise
    return {"path": str(output.resolve()), "width": image.shape[1], "height": image.shape[0]}
