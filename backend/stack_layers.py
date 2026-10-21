"""Optional full-float sky/reference files; no new registration or rendering."""
import json
from pathlib import Path
import tempfile
import time

from .stack_io import write_result


def layer_targets(output, format):
    output = Path(output)
    targets = {'master': output,
               'sky': output if format == 'tiff32' else output.parent/'StarStudio_sky_PS.tif',
               'reference': output.parent/'StarStudio_reference_ground.tif',
               'record': output.with_suffix(output.suffix+'.json')}
    if targets['reference'] == output or (format != 'tiff32' and targets['sky'] == output):
        raise ValueError('主文件名与分层附件冲突，请换一个结果名称。')
    if not output.parent.is_dir():
        raise ValueError('分层结果文件夹不存在，请重新选择输出文件夹。')
    for path in targets.values():
        if path.exists() or path.is_symlink():
            raise ValueError(f'分层输出文件已存在：{path}；请使用新的结果文件夹。')
    return targets


def save_layers(targets, image, reference, meta, format, summary, started, check):
    output = targets['master']
    with tempfile.TemporaryDirectory(prefix='.starstudio-layers-', dir=output.parent) as directory:
        work = Path(directory)
        check()
        encoding = write_result(work/output.name, image, meta, format, calibration=summary['calibration'])
        check()
        if targets['sky'] != output:
            write_result(work/targets['sky'].name, image, meta, 'tiff32', calibration=summary['calibration'])
            check()
        write_result(work/targets['reference'].name, reference, meta, 'tiff32', calibration=summary['calibration'])
        check()
        summary.update(encoding=encoding, photoshopOutput=str(targets['sky']),
                       seconds=round(time.monotonic()-started, 2),
                       layers={'sky': str(targets['sky']), 'reference': str(targets['reference']),
                               'referenceSource': summary['reference'], 'referenceFrames': 1,
                               'referenceResampled': False, 'referenceVisible': False,
                               'profile': 'Star Studio Linear ProPhoto RGB', 'depth': 32})
        (work/targets['record'].name).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
        committed = []
        try:
            for path in dict.fromkeys(targets.values()):
                check()
                if path.exists() or path.is_symlink():
                    raise ValueError(f'分层输出文件已存在：{path}；本次未覆盖。')
                # Same-volume rename does not replace an existing file on Windows.
                (work/path.name).rename(path)
                committed.append(path)
            check()
        except BaseException:
            for path in reversed(committed):
                path.unlink()
            raise
    return summary
