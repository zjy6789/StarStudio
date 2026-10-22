"""Bounded single-image FITS to linear float TIFF handoff; never edits FITS."""
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import tempfile

from astropy.io import fits
import numpy as np
import tifffile

from .linear_preparation import PROFILE, fingerprint
from .stack_io import PROPHOTO_XYZ, SRGB_XYZ, linear_profile

KIND = 'starstudio-fits-import'


def checkpoint(canceled):
    if canceled():
        raise InterruptedError('FITS导入已取消。')


def digest(path, canceled):
    result = hashlib.sha256()
    with path.open('rb') as file:
        while block := file.read(8*1024*1024):
            checkpoint(canceled)
            result.update(block)
    return result.hexdigest()


@contextmanager
def image_data(path, color):
    if path.suffix.lower() not in ('.fit', '.fits', '.fts'):
        raise ValueError('请选择单张未压缩FITS文件（fit/fits/fts）。')
    with fits.open(path, mode='readonly', memmap=True, do_not_scale_image_data=True, uint=False) as hdus:
        images = [(i, hdu) for i, hdu in enumerate(hdus) if hdu.is_image and hdu.header.get('NAXIS', 0)]
        if len(images) != 1 or isinstance(images[0][1], fits.CompImageHDU):
            raise ValueError('首版只支持一幅未压缩图像；多图像HDU/压缩FITS请先在天文软件中导出单图。')
        index, hdu = images[0]
        hdu.verify('exception')
        header = hdu.header
        if str(header.get('BAYERPAT', '')).strip().upper() not in ('', 'NONE'):
            raise ValueError('这是拜耳阵列；请先在天文软件中完成校准、去马赛克与堆栈。')
        raw = hdu.data
        if raw is None or raw.ndim not in (2, 3) or (raw.ndim == 3 and raw.shape[0] != 3):
            raise ValueError('只支持二维灰度或(3, 高, 宽)三平面RGB；不猜测其他轴布局。')
        height, width = raw.shape[-2:]
        if not (0 < width <= 65536 and 0 < height <= 65536 and width*height <= 250_000_000):
            raise ValueError('FITS尺寸超出当前线性准备范围。')
        if raw.ndim == 3:
            if 'CAMERA' in str(header.get('COLORSPC', '')).upper():
                raise ValueError('相机原生RGB不能直接指定工作ICC；请先在天文软件中转换为已知线性工作RGB。')
            if (str(header.get('CHANNELS', 'RGB')).strip().upper() != 'RGB'
                    or str(header.get('CTYPE3', 'RGB')).strip().upper() not in ('RGB', 'COLOR')):
                raise ValueError('第三轴未明确为RGB；光谱、窄带或其他排列请先完成通道组合。')
            if color not in ('prophoto', 'srgb'):
                raise ValueError('FITS的RGB不说明颜色空间；请明确确认线性ProPhoto或线性sRGB，再重新检查。')
        elif color not in ('unknown', 'prophoto', 'srgb'):
            raise ValueError('未知颜色解释。')
        scale, zero = float(header.get('BSCALE', 1)), float(header.get('BZERO', 0))
        if not math.isfinite(scale) or not math.isfinite(zero) or scale == 0:
            raise ValueError('FITS缩放字段无效，不自动替换BSCALE/BZERO。')
        yield raw, dict(hdu=index, width=width, height=height, bitpix=header['BITPIX'],
                        color='mono' if raw.ndim == 2 else color, bscale=scale, bzero=zero,
                        blank=header.get('BLANK') if raw.dtype.kind in 'iu' else None,
                        headers=[h.header.tostring(sep='\n', endcard=True, padding=False) for h in hdus])


def blocks(raw, info, canceled):
    height = info['height']
    for y in range(0, height, 128):
        checkpoint(canceled)
        stored = raw[y:y+128] if raw.ndim == 2 else np.moveaxis(raw[:, y:y+128], 0, -1)
        if info['blank'] is not None and np.any(stored == info['blank']):
            raise ValueError('FITS含BLANK无效像素；请先在天文软件中明确选择有效区域，不自动填零或裁剪。')
        if stored.dtype.kind in 'iu' and stored.dtype.itemsize == 8 and np.any((stored < -2**53) | (stored > 2**53)):
            raise ValueError('64位整数超出本路径float64精确解码范围，请保留原FITS并先确定转换方案。')
        values = stored.astype(np.float64)
        if info['bscale'] != 1:
            values *= info['bscale']
        if info['bzero'] != 0:
            values += info['bzero']
        if not np.isfinite(values).all():
            raise ValueError('FITS含NaN/Inf或缩放溢出；请选择有限的有效堆栈，不自动修补。')
        if info['color'] == 'mono':
            values = np.repeat(values[..., None], 3, axis=2)
        elif info['color'] == 'srgb':
            values = values @ (np.linalg.inv(PROPHOTO_XYZ) @ SRGB_XYZ).T
        if not np.isfinite(values).all() or np.any(np.abs(values) > np.finfo(np.float32).max):
            raise ValueError('像素超出32位浮点范围；原FITS保留，未裁切或归一化。')
        yield y, values


def inspect_fits(request, progress=lambda x: None, canceled=lambda: False):
    path = Path(request['path']).resolve()
    before = fingerprint(path)
    low, high, negative, above, changed, error_max = math.inf, -math.inf, 0, 0, 0, 0.
    with image_data(path, request.get('color', 'unknown')) as (raw, info):
        for y, values in blocks(raw, info, canceled):
            error = np.abs(values.astype(np.float32).astype(np.float64)-values)
            changed += int(np.count_nonzero(error))
            error_max = max(error_max, float(error.max()))
            low, high = min(low, float(values.min())), max(high, float(values.max()))
            negative += int(np.count_nonzero(values < 0))
            above += int(np.count_nonzero(values > 1))
            progress(.9*min(1, (y+128)/info['height']))
    sha = digest(path, canceled)
    if fingerprint(path) != before:
        raise ValueError('FITS检查期间发生变化，请重新检查。')
    checkpoint(canceled)
    progress(1)
    return dict(path=str(path), fingerprint=dict(before, sha256=sha), profile=PROFILE, **info,
                stats=dict(min=low, max=high, negativeChannels=negative, aboveOneChannels=above),
                rounding=dict(changedChannels=changed, maxAbsError=error_max),
                temporaryGB=round(2*info['width']*info['height']*3*4/1024**3, 3))


def import_fits(request, progress=lambda x: None, canceled=lambda: False):
    if request.get('confirmedLinear') is not True:
        raise ValueError('请确认未拉伸，并确认RGB工作空间解释。')
    source, output = Path(request['path']).resolve(), Path(request['output']).resolve()
    if source == output or (output.exists() and output.samefile(source)):
        raise ValueError('不能覆盖原FITS；请选择独立TIFF。')
    if output.suffix.lower() not in ('.tif', '.tiff'):
        raise ValueError('交接副本必须保存为32位浮点TIFF。')
    info = inspect_fits(request, lambda x: progress(.4*x), canceled)
    if request.get('fingerprint') != info['fingerprint']:
        raise ValueError('FITS已变化或尚未检查；请重新检查当前文件。')
    if info['rounding']['changedChannels'] and request.get('acceptRounding') is not True:
        raise ValueError('转成float32会发生已报告的舍入；请确认接受，原FITS仍保留。')
    with tempfile.TemporaryDirectory(prefix='.starstudio-fits-', dir=output.parent) as directory:
        folder, mapped = Path(directory), None
        try:
            with image_data(source, request.get('color', 'unknown')) as (raw, details):
                mapped = np.lib.format.open_memmap(folder/'rgb.npy', mode='w+', dtype='<f4',
                                                  shape=(info['height'], info['width'], 3))
                for y, values in blocks(raw, details, canceled):
                    mapped[y:y+len(values)] = values
                    progress(.4+.4*min(1, (y+128)/info['height']))
                mapped.flush()
            record = dict(kind=KIND, schema=1, stage='linear', nonlinearStretch=False,
                          source=dict(path=str(source), **info['fingerprint']),
                          input={key: info[key] for key in ('hdu', 'bitpix', 'color', 'bscale', 'bzero', 'headers')},
                          profile=PROFILE, width=info['width'], height=info['height'],
                          stats=info['stats'], rounding=info['rounding'],
                          geometry='FITS array row order retained; no flip/crop/rotation', wcs='archive-only')
            target = folder/'imported.tif'
            tifffile.imwrite(target, mapped, photometric='rgb', metadata=None, iccprofile=linear_profile(),
                             software='Star Studio', description=json.dumps(record, ensure_ascii=True),
                             rowsperstrip=32, bigtiff=mapped.nbytes > 3_500_000_000)
            progress(.95)
            checkpoint(canceled)
            if dict(fingerprint(source), sha256=digest(source, canceled)) != info['fingerprint']:
                raise ValueError('FITS处理期间发生变化；未提交副本，请重新检查。')
            checkpoint(canceled)
            target.replace(output)
            progress(1)
            return dict(path=str(output), width=info['width'], height=info['height'], profile=PROFILE, metadata=record)
        finally:
            if mapped is not None:
                mapped._mmap.close()
