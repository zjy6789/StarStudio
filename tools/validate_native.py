"""Compare TIFFs exported from the actual Photoshop test document."""
from pathlib import Path
import json
import numpy as np
import tifffile
from backend.algorithms import combine, stretch

root = Path(__file__).resolve().parents[1]
out = root / "artifacts"
def image(tag, index):
    data = tifffile.imread(out / f"ps-{tag}-layer-{index}.tif")
    assert data.dtype == np.uint16 and data.shape == (512, 512, 3)
    return data.astype(np.float32) / 65535

original = image(4, 3)
recombined = image(4, 1)
adjusted = image(5, 1)
expected = combine(image(5, 3), stretch(image(5, 0), dict(type="asinh", lnD=1.5)))
report = {
    "photoshop": "27.1.0 / Photoshop 2026",
    "input": "512x512 RGB 16-bit; StarNet local rgb_test5.tif crop",
    "default_recombine_max_16bit_difference": int(round(float(np.max(np.abs(recombined-original)))*65535)),
    "default_recombine_mean_16bit_difference": float(np.mean(np.abs(recombined-original))*65535),
    "applied_star_asinh_lnD": 1.5,
    "applied_chain_max_normalized_error": float(np.max(np.abs(adjusted-expected))),
    "adjustment_mean_effect": float(np.mean(np.abs(adjusted-recombined))),
    "layers": (out / "ps-5-layers.tsv").read_text(encoding="utf-8").splitlines(),
}
assert report["default_recombine_max_16bit_difference"] <= 4
assert report["applied_chain_max_normalized_error"] < 4/65535
assert report["adjustment_mean_effect"] > .001
(out / "photoshop-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
