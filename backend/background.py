"""Conservative plane fitting for explicitly developed photos, not star signals."""
import base64
import io
import numpy as np
from PIL import Image, ImageDraw
from scipy.optimize import least_squares
from .algorithms import validate_image, color_count


def check_cancel(canceled):
    if canceled():
        raise ValueError("背景校正已取消")


def mask_data(mask, shape):
    if mask is None:
        return None
    validate_image(mask)
    if mask.shape != (*shape, 1):
        raise ValueError("选区必须与源图尺寸相同且为单通道")
    return mask[..., 0]


def distribution(points):
    if len(points) < 12:
        raise ValueError("可靠背景样本不足12处；请扩大背景选区、调整主体保护或跳过校正。")
    xy = np.asarray(points, dtype=np.float64)
    design = np.column_stack((np.ones(len(xy)), xy))
    # Do not extrapolate a full-frame plane from a narrow strip or small corner.
    if (np.any(np.ptp(xy, axis=0) < 1) or np.linalg.matrix_rank(design) < 3
            or np.linalg.cond(design) > 15 or np.linalg.det(np.cov(xy.T)) < .008):
        raise ValueError("背景取样过于集中或接近一条直线；请在画面两侧及上下选择分散的天空背景，或跳过校正。")
    return design


def robust_coefficients(design, target, canceled=lambda: False):
    coefficients = []
    for c in range(target.shape[1]):
        check_cancel(canceled)
        initial = np.linalg.lstsq(design, target[:, c], rcond=None)[0]
        residual = design@initial-target[:, c]
        scale = max(1e-7, float(np.median(np.abs(residual-np.median(residual)))*1.4826))
        solution = least_squares(lambda a: design@a-target[:, c], initial,
                                 jac=lambda a: design.copy(), loss="soft_l1", f_scale=scale,
                                 max_nfev=100)
        if not solution.success or not np.all(np.isfinite(solution.x)):
            raise ValueError("背景模型未收敛；请调整背景取样或跳过校正。")
        coefficients.append(solution.x)
    return np.asarray(coefficients).T


def fit_background(image, protection=None, sampling=None, progress=lambda x: None, canceled=lambda: False):
    validate_image(image)
    h, w, _ = image.shape
    if min(h, w) < 32:
        raise ValueError("背景校正需要至少32×32像素的照片")
    protect, sample = mask_data(protection, (h, w)), mask_data(sampling, (h, w))
    n = color_count(image)
    radius = max(2, min(20, min(h, w)//120))
    points, values, pixels = [], [], []
    for y in np.linspace(radius, h-radius-1, min(20, h//(2*radius+1))).astype(int):
        check_cancel(canceled)
        for x in np.linspace(radius, w-radius-1, min(20, w//(2*radius+1))).astype(int):
            area = np.s_[y-radius:y+radius+1, x-radius:x+radius+1]
            patch = image[area]
            valid = patch[..., -1] >= .999 if image.shape[2] != n else np.ones(patch.shape[:2], bool)
            if protect is not None:
                valid &= protect[area] <= .001
            if sample is not None:
                valid &= sample[area] >= .999
            if np.mean(valid) < .9:
                continue
            yy, xx = np.nonzero(valid)
            points.append(((x-radius+xx.mean())/(w-1)*2-1, (y-radius+yy.mean())/(h-1)*2-1))
            values.append(np.median(patch[..., :n][valid], axis=0))
            pixels.append((int(x), int(y)))
        progress(.5*y/h)
    values = np.asarray(values, dtype=np.float64)
    distribution(points)
    # Similar to Siril's automatic bright-region rejection; not a subject detector.
    brightness = np.mean(values, axis=1)
    center = np.median(brightness)
    spread = np.median(np.abs(brightness-center))*1.4826
    accepted = brightness <= center+3*max(spread, 1e-7)
    points = np.asarray(points)
    design = distribution(points[accepted])
    target = values[accepted]
    coefficients = robust_coefficients(design, target, canceled)
    reference = np.median(design@coefficients, axis=0)
    check_cancel(canceled)
    # This thumbnail shows sampling only. Full-resolution model/result goes to PS.
    step = max(1, int(np.ceil(max(h, w)/640)))
    thumb = np.asarray(image[::step, ::step, :n])
    if n == 1:
        thumb = np.repeat(thumb, 3, axis=2)
    if image.shape[2] != n:
        thumb = thumb*image[::step, ::step, -1:]
    preview = Image.fromarray(np.rint(thumb*255).astype(np.uint8))
    draw = ImageDraw.Draw(preview)
    for (x, y), used in zip(pixels, accepted):
        x, y = x/step, y/step
        draw.ellipse((x-2, y-2, x+2, y+2), outline="#55ff88" if used else "#ff9955")
    stream = io.BytesIO()
    preview.save(stream, format="PNG")
    progress(1)
    return {"coefficients": coefficients.tolist(), "reference": reference.tolist(),
            "samples": int(accepted.sum()), "rejected": int((~accepted).sum()),
            "condition": float(np.linalg.cond(design)), "width": w, "height": h,
            "samplingPreview": "data:image/png;base64,"+base64.b64encode(stream.getvalue()).decode()}


def render_background(image, model, output, strength, view="result", progress=lambda x: None, canceled=lambda: False):
    strength = float(strength)
    if not np.isfinite(strength) or not 0 <= strength <= 1 or view not in ("result", "model"):
        raise ValueError("背景校正强度需要在0到1之间，视图必须为结果或模型")
    h, w, _ = image.shape
    n = color_count(image)
    coefs, reference = np.asarray(model["coefficients"]), np.asarray(model["reference"])
    if model["width"] != w or model["height"] != h or coefs.shape != (3, n):
        raise ValueError("背景模型与源图不匹配；请重新生成建议。")
    x = np.linspace(-1, 1, w)[None, :, None]
    below, above, lo, hi = 0, 0, float("inf"), -float("inf")
    for y in range(0, h, 128):
        check_cancel(canceled)
        stop = min(h, y+128)
        yy = (np.arange(y, stop)/(h-1)*2-1)[:, None, None]
        plane = coefs[0]+x*coefs[1]+yy*coefs[2]
        data = plane if view == "model" else image[y:stop, :, :n].astype(np.float64)-strength*(plane-reference)
        if view == "result" and strength == 0:
            data = image[y:stop, :, :n]
        output[y:stop, :, :n] = data
        if image.shape[2] != n:
            output[y:stop, :, n:] = image[y:stop, :, n:]
        colors = output[y:stop, :, :n]
        visible = image[y:stop, :, -1] > 0 if image.shape[2] != n else np.ones(colors.shape[:2], bool)
        colors = colors[visible]
        if colors.size:
            below += int(np.count_nonzero(colors < 0)); above += int(np.count_nonzero(colors > 1))
            lo, hi = min(lo, float(colors.min())), max(hi, float(colors.max()))
        progress(stop/h)
    check_cancel(canceled)
    return {"minimum": lo, "maximum": hi, "negativeChannels": below, "aboveOneChannels": above}
