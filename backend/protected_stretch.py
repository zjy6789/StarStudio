"""Initial linked stretching for confirmed T4 copies or original linear masters."""
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile

import numpy as np
import tifffile
from .algorithms import stretch_curve, validate_image
from .linear_preparation import KIND, PROFILE, checkpoint, fingerprint, master_data, inspect_master
from .stack_io import linear_profile


@contextmanager
def prepared_data(path):
    path = Path(path).resolve()
    if path.suffix.lower() not in ('.tif', '.tiff'):
        raise ValueError('请选择T4创建的32位范围准备TIFF副本。')
    with tifffile.TiffFile(path) as file:
        if len(file.pages) != 1:
            raise ValueError('拉伸输入必须是单幅RGB TIFF。')
        page = file.pages[0]
        try:
            record = json.loads(page.description or '{}')
        except (ValueError, TypeError) as error:
            raise ValueError('缺少有效的T4来源记录；请使用母版准备生成的原样副本。') from error
        if (not isinstance(record, dict) or record.get('kind') != KIND or record.get('schema') != 1
                or record.get('stage') != 'range-prepared-linear' or record.get('nonlinearStretch') is not False
                or record.get('displayStretch') is not False):
            raise ValueError('输入不是未拉伸的T4范围准备副本；已显影或已拉伸文件不能自动再拉伸。')
        source, mapping = record.get('source'), record.get('mapping')
        if (not isinstance(source, dict) or not isinstance(source.get('path'), str) or not source['path']
                or not isinstance(mapping, dict) or not isinstance(mapping.get('offset'), (int, float))
                or not isinstance(mapping.get('scale'), (int, float)) or not np.isfinite(mapping['offset'])
                or not np.isfinite(mapping['scale']) or mapping['offset'] > 0 or mapping['scale'] < 1):
            raise ValueError('T4来源或范围映射记录不完整；请重新从母版准备。')
        profile, software, orientation = page.tags.get(34675), page.tags.get(305), page.tags.get(274)
        if (not profile or profile.value != linear_profile() or not software
                or software.value != 'Star Studio Linear Preparation' or (orientation and orientation.value != 1)
                or page.dtype.kind != 'f' or page.dtype.itemsize != 4 or len(page.shape) != 3
                or page.shape[2] != 3 or page.photometric != 2 or page.planarconfig != 1
                or not 0 < page.shape[0]*page.shape[1] <= 250_000_000):
            raise ValueError('本页需要原样32位RGB、线性ProPhoto ICC的T4副本；其他来源暂不自动拉伸。')
        if record.get('width') != page.shape[1] or record.get('height') != page.shape[0] or record.get('profile') != PROFILE:
            raise ValueError('T4来源记录与TIFF尺寸或色彩声明不一致；请重新准备。')
    try:
        image = tifffile.memmap(path, mode='r')
    except ValueError as error:
        raise ValueError('需要原样无压缩、无瓦片的T4副本。') from error
    try:
        yield image, record
    finally:
        image._mmap.close()


def curve_parameters(settings, median):
    amount, protection, background = (float(settings.get(k, v)) for k, v in
                                     [('amount', 0), ('protection', .75), ('background', .8)])
    if not all(np.isfinite(v) for v in [amount, protection, background]):
        raise ValueError('拉伸参数必须是有限数值')
    if not 0 <= amount <= 10 or not 0 <= protection <= 1 or not 0 <= background <= 1:
        raise ValueError('提亮程度需在0到10之间；亮星保护、背景亮度需在0到1之间。')
    hp = 1-.7*protection
    return dict(type='asinh', lnD=amount, lp=0, sp=min(float(median), hp)*(1-background), hp=hp, bp=0)


@contextmanager
def input_data(path, kind=None):
    if kind == 'linear-master':
        with master_data(path) as image:
            yield image, None
    else:
        with prepared_data(path) as data:
            yield data


def inspect_input(path, confirmed, progress=lambda x: None, canceled=lambda: False):
    if confirmed is not True:
        raise ValueError('请明确确认所选文件仍未拉伸；这不是对普通照片的自动显影。')
    path = Path(path).resolve()
    if path.suffix.lower() not in ('.tif', '.tiff'):
        raise ValueError('请选择Star Studio导出的32位线性TIFF母版或T4准备副本。')
    with tifffile.TiffFile(path) as file:
        software = file.pages[0].tags.get(305)
        master = software is not None and software.value == 'Star Studio'
    if not master:
        return inspect_prepared(path, confirmed, progress, canceled)
    info = inspect_master(path, progress, canceled)
    checkpoint(canceled)
    with master_data(path) as image:
        h, w, _ = image.shape
        step = max(1, int(np.ceil(np.sqrt(h*w/250_000))))
        sample = image[::step, ::step].astype(np.float64)
        positive = sample.max(axis=2) > 0
        peak = np.abs(sample[positive]).max(axis=1)
        quantiles = np.quantile(peak, [.01, .5, .99], method='linear').tolist() if peak.size else [0., 0., 0.]
    check_source(info)
    checkpoint(canceled)
    suggestion, reason = suggest_stretch(quantiles)
    return dict(info, inputKind='linear-master', minimum=info['stats']['min'], maximum=info['stats']['max'],
                peakQuantiles=quantiles, sampleStep=step, sampleCount=int(peak.size),
                suggestion=suggestion, suggestionReason=reason)


def inspect_prepared(path, confirmed, progress=lambda x: None, canceled=lambda: False):
    if confirmed is not True:
        raise ValueError('请明确确认选择的T4副本仍未拉伸；这不是对普通照片的自动显影。')
    path = Path(path).resolve()
    before = fingerprint(path)
    low, high = 1., 0.
    with prepared_data(path) as (image, record):
        h, w, _ = image.shape
        for y in range(0, h, 128):
            checkpoint(canceled)
            block = image[y:y+128]
            validate_image(block)
            low, high = min(low, float(block.min())), max(high, float(block.max()))
            progress(min(1, (y+128)/h))
        step = max(1, int(np.ceil(np.sqrt(h*w/250_000))))
        peak = np.max(image[::step, ::step], axis=2).astype(np.float64)
        quantiles = np.quantile(peak, [.01, .5, .99], method='linear').tolist()
    if fingerprint(path) != before:
        raise ValueError('读取期间准备副本发生变化，请重新选择。')
    suggestion, reason = suggest_stretch(quantiles)
    return dict(path=str(path), fingerprint=before, width=w, height=h, profile=PROFILE, provenance=record,
                minimum=low, maximum=high, peakQuantiles=quantiles, sampleStep=step,
                sampleCount=int(peak.size), suggestion=suggestion, suggestionReason=reason)


def suggest_stretch(quantiles):
    median = quantiles[1]
    suggestion = dict(amount=0., protection=.75, background=.8)
    reason = '采样中位峰值已不低于0.15；保留0强度，请先核对输入阶段。'
    if 0 < median < .15 and quantiles[2]-quantiles[0] > 1e-7:
        left, right = 0., 10.
        for _ in range(40):
            middle = (left+right)/2
            target = stretch_curve(median, curve_parameters(dict(suggestion, amount=middle), median), dtype=np.float64, clip=False)
            if target < .15:
                left = middle
            else:
                right = middle
        suggestion['amount'] = round(right, 4)
        reason = '自动起点以采样中位峰值约0.15为目标；它不是真实天空背景测量或最佳参数。'
        if right > 9.999:
            reason = '达到提亮上限仍可能偏暗；请手动检查，不会自动裁黑或截断高光。'
    elif median <= 0 or quantiles[2]-quantiles[0] <= 1e-7:
        reason = '采样缺少可靠正值或接近平坦，无法自动建议；保留0强度，可手动观察。'
    return suggestion, reason


def check_source(info):
    if fingerprint(Path(info['path'])) != info['fingerprint']:
        raise ValueError('线性输入文件已变化，请重新读取；不会继续使用旧快照。')


def render_stretch(image, info, output, settings, progress=lambda x: None, canceled=lambda: False):
    check_source(info)
    params = curve_parameters(settings, info['peakQuantiles'][1])
    if image.shape != (info['height'], info['width'], 3):
        raise ValueError('拉伸快照与来源尺寸不符')
    master = info.get('inputKind') == 'linear-master'
    stats = dict(newBlackChannels=0, newWhiteChannels=0, nearWhitePixels=0,
                 originalBlackChannels=0, originalWhiteChannels=0, maxStorageError=0., minimum=1., maximum=0.)
    if master:
        stats.update(negativeChannels=0, aboveOneChannels=0, minimum=float('inf'), maximum=-float('inf'))
    h = image.shape[0]
    for y in range(0, h, 128):
        checkpoint(canceled)
        block = image[y:y+128].astype(np.float64)
        peak = (np.abs(block) if master else block).max(axis=2, keepdims=True)
        if params['lnD'] == 0:
            mapped = block
        else:
            target = stretch_curve(peak, params, dtype=np.float64, clip=False)
            gain = np.divide(target, peak, out=np.ones_like(peak), where=peak > 0)
            mapped = block*gain
        stored = mapped.astype(np.float32)
        if master:
            if (not np.isfinite(stored).all() or np.any((block != 0) & (stored == 0))
                    or np.any(np.signbit(block) != np.signbit(stored))):
                raise ValueError('完整范围拉伸会产生非有限值、非零变零或符号变化；已停止，不裁切或填零。')
            stats['negativeChannels'] += int(np.count_nonzero(stored < 0))
            stats['aboveOneChannels'] += int(np.count_nonzero(stored > 1))
        elif not np.isfinite(stored).all() or np.any(stored < 0) or np.any(stored > 1):
            raise ValueError('曲线未满足有效范围，已停止；不会通过裁切继续。')
        output[y:y+128] = stored
        stats['newBlackChannels'] += int(np.count_nonzero(((block != 0) if master else (block > 0)) & (stored == 0)))
        if not master:
            stats['newWhiteChannels'] += int(np.count_nonzero((block < 1) & (stored == 1)))
        stats['originalBlackChannels'] += int(np.count_nonzero(block == 0))
        stats['originalWhiteChannels'] += int(np.count_nonzero(block == 1))
        stats['nearWhitePixels'] += int(np.count_nonzero(stored.max(axis=2) >= .99))
        stats['maxStorageError'] = max(stats['maxStorageError'], float(np.max(np.abs(mapped-stored))))
        stats['minimum'], stats['maximum'] = min(stats['minimum'], float(stored.min())), max(stats['maximum'], float(stored.max()))
        progress(min(1, (y+128)/h))
    checkpoint(canceled)
    check_source(info)
    return dict(stats=stats, curve=params, settings=settings)


def save_stretch(image, info, details, output, canceled=lambda: False):
    check_source(info)
    output = Path(output).resolve()
    if output.suffix.lower() not in ('.tif', '.tiff'):
        raise ValueError('受保护拉伸副本仅保存32位TIFF。')
    master = info.get('inputKind') == 'linear-master'
    protected_paths = [Path(info['path']).resolve()]
    if not master:
        protected_paths.append(Path(info['provenance']['source']['path']).resolve())
    for protected in protected_paths:
        if output == protected or (output.exists() and protected.exists() and output.samefile(protected)):
            raise ValueError('不能覆盖准备副本或原母版；请选择独立保存位置。')
    if details['stats']['newBlackChannels'] or details['stats']['newWhiteChannels']:
        raise ValueError('当前参数产生新增黑/白端点；请降低提亮程度或增加亮星保护，再预览并应用。')
    nonlinear = details['curve']['lnD'] > 0
    record = dict(kind='starstudio-full-range-stretch' if master else 'starstudio-protected-stretch',
                  schema=1, stage='developed' if nonlinear else 'linear-copy',
                  nonlinearStretch=nonlinear, displayStretch=False, source={'path': info['path'], **info['fingerprint']},
                  curve=details['curve'], settings=details['settings'], precision=details['stats'])
    if master:
        record.update(inputKind='linear-master', zeroPreserved=True, rangeClipped=False, sourceRange=info['stats'])
    else:
        record['preparedProvenance'] = info['provenance']
    with tempfile.TemporaryDirectory(prefix='.starstudio-stretch-', dir=output.parent) as directory:
        checkpoint(canceled)
        temporary = Path(directory)/'output.tif'
        tifffile.imwrite(temporary, image, photometric='rgb', metadata=None, description=json.dumps(record, ensure_ascii=True),
                         iccprofile=linear_profile(), software='Star Studio Protected Stretch', rowsperstrip=32,
                         bigtiff=image.nbytes > 3_500_000_000)
        checkpoint(canceled)
        check_source(info)
        temporary.replace(output)
    return dict(path=str(output), metadata=record)
