"""Read-only geometric coverage diagnostics; never edit or crop stack pixels."""
import base64
import io

import numpy as np
from PIL import Image, ImageDraw


def _png(image):
    with io.BytesIO() as buffer:
        image.save(buffer, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')


def coverage_report(count, frames, check=lambda: None):
    h, w = count.shape
    heights = np.zeros(w, dtype=np.int32)
    histogram = np.zeros(frames+1, dtype=np.int64)
    crop, area = None, 0
    for y in range(h):
        check()
        row = np.asarray(count[y])
        histogram += np.bincount(row, minlength=frames+1)
        heights = (heights+1)*(row == frames)
        stack = []
        # Equal-height plateaus need one stack entry, not a Python loop per pixel.
        starts = np.r_[0, np.flatnonzero(heights[1:] != heights[:-1])+1, w]
        for x in starts:
            value = int(heights[x]) if x < w else 0
            left = int(x)
            while stack and stack[-1][1] > value:
                start, height = stack.pop()
                candidate = height*(int(x)-start)
                if candidate > area:
                    area = candidate
                    crop = dict(left=start, top=y+1-height, right=int(x), bottom=y+1)
                left = start
            if value and (not stack or stack[-1][1] < value):
                stack.append((left, value))
    check()
    full = _png(Image.fromarray(np.asarray(count)))
    # Display-only nearest sampling; the separate uint16 PNG above is full size.
    step = max(1, int(np.ceil(max(h, w)/960)))
    display = np.rint(np.asarray(count[::step, ::step], dtype=np.float64)*255/frames).astype(np.uint8)
    preview = Image.fromarray(display).convert('RGB')
    if crop:
        ImageDraw.Draw(preview).rectangle((crop['left']/step, crop['top']/step,
                                          (crop['right']-1)/step, (crop['bottom']-1)/step),
                                         outline=(0, 220, 220), width=2)
    check()
    occupied = np.flatnonzero(histogram)
    return dict(kind='geometric-coverage-before-rejection', encoding='png-uint16',
                frames=frames, width=w, height=h, minimum=int(occupied[0]), maximum=int(occupied[-1]),
                histogram=histogram.tolist(), totalPixels=h*w, fullPixels=int(histogram[frames]),
                crop=crop, png=full, preview=_png(preview))
