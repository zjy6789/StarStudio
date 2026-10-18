"""Explicit file-based preparation of Star Studio linear float32 TIFF masters.

The ordinary image upload and star algorithms keep their 0..1 contract. This
module preserves the master and writes a separately identified, affine-mapped
float32 copy, including its measured rounding error and unchanged linear ICC.
"""
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import tempfile

import numpy as np
import tifffile

from .stack_io import linear_profile

PROFILE = 'Star Studio Linear ProPhoto RGB'
KIND = 'starstudio-range-prepared'


def checkpoint(canceled):
    if canceled():
        raise InterruptedError('母版准备已取消。')


def fingerprint(path):
    stat = path.stat()
    # Nanosecond timestamps exceed JavaScript's exact integer range.
    return {'bytes': stat.st_size, 'mtimeNs': str(stat.st_mtime_ns)}


@contextmanager
def master_data(path):
    path = Path(path).resolve()
    if path.suffix.lower() not in ('.tif', '.tiff'):
        raise ValueError('首版仅支持 Star Studio 导出的32位线性ProPhoto TIFF母版。')
    with tifffile.TiffFile(path) as file:
        if len(file.pages) != 1:
            raise ValueError('母版必须是单幅RGB TIFF。')
        page = file.pages[0]
        try:
            description = json.loads(page.description or '{}')
        except (ValueError, TypeError):
            description = {}
        if isinstance(description, dict) and description.get('kind') == KIND:
            raise ValueError('这是已准备副本；请使用原线性母版，避免重复准备。')
        profile = page.tags.get(34675)
        software = page.tags.get(305)
        if not profile or profile.value != linear_profile() or not software or software.value != 'Star Studio':
            raise ValueError('请选择 Star Studio 原导出的线性ProPhoto TIFF母版；缺失或其他ICC、外来显影照片暂不支持。')
        if (page.dtype.kind != 'f' or page.dtype.itemsize != 4 or len(page.shape) != 3
                or page.shape[2] != 3 or page.photometric != 2 or page.planarconfig != 1
                or page.shape[0]*page.shape[1] > 250_000_000):
            raise ValueError('首版母版需要32位浮点RGB三通道；不支持灰度、透明通道或其他位深。')
        orientation = page.tags.get(274)
        if orientation and orientation.value != 1:
            raise ValueError('请使用原导出方向的线性母版，暂不自动旋转像素。')
    try:
        data = tifffile.memmap(path, mode='r')
    except ValueError as error:
        raise ValueError('请选择原导出的无压缩、无瓦片线性TIFF母版。') from error
    try:
        yield data
    finally:
        data._mmap.close()


def inspect_master(path, progress=lambda x: None, canceled=lambda: False):
    path = Path(path).resolve()
    before = fingerprint(path)
    low, high, negative, above = math.inf, -math.inf, 0, 0
    with master_data(path) as image:
        height, width, _ = image.shape
        rows = max(1, min(128, 8*1024*1024//(width*3*8)))
        for y in range(0, height, rows):
            checkpoint(canceled)
            block = image[y:y+rows]
            if not np.isfinite(block).all():
                raise ValueError('母版含NaN/Inf（可能是无覆盖边界）；本版需选择完全有限的有效母版，不自动裁剪或填零。')
            low, high = min(low, float(block.min())), max(high, float(block.max()))
            negative += int(np.count_nonzero(block < 0))
            above += int(np.count_nonzero(block > 1))
            progress(min(1, (y+rows)/height))
    if fingerprint(path) != before:
        raise ValueError('检查期间母版发生变化，请重新检查。')
    offset = min(0., low)
    span = max(1., high)-offset
    mantissa, exponent = math.frexp(span)
    scale = math.ldexp(1., exponent-1 if mantissa == .5 else exponent)
    return {'path': str(path), 'width': width, 'height': height, 'profile': PROFILE,
            'fingerprint': before, 'mapping': {'offset': offset, 'scale': scale},
            'stats': {'min': low, 'max': high, 'negativeChannels': negative, 'aboveOneChannels': above},
            'temporaryGB': round(2*height*width*3*4/1024**3, 3)}


def prepare_master(request, progress=lambda x: None, canceled=lambda: False):
    if request.get('confirmedLinear') is not True:
        raise ValueError('请明确确认这是未拉伸的 Star Studio 线性母版。')
    source, output = Path(request['path']).resolve(), Path(request['output']).resolve()
    if source == output or (output.exists() and output.samefile(source)):
        raise ValueError('不能覆盖原母版；请选择另一个文件保存后期副本。')
    if output.suffix.lower() not in ('.tif', '.tiff'):
        raise ValueError('范围准备副本必须保存为32位浮点TIFF。')
    if request.get('fingerprint') != fingerprint(source):
        raise ValueError('母版已变化或尚未检查，请重新检查后再创建副本。')
    info = inspect_master(source, lambda x: progress(.3*x), canceled)
    if info['fingerprint'] != request['fingerprint']:
        raise ValueError('母版已变化，请重新检查。')
    offset, scale = info['mapping']['offset'], info['mapping']['scale']
    error_max, changed, output_low, output_high = 0., 0, math.inf, -math.inf
    with tempfile.TemporaryDirectory(prefix='.starstudio-prepare-', dir=output.parent) as directory:
        folder = Path(directory)
        mapped = None
        try:
            with master_data(source) as image:
                mapped = np.lib.format.open_memmap(folder/'mapped.npy', mode='w+', dtype='<f4', shape=image.shape)
                height, width, _ = image.shape
                rows = max(1, min(128, 8*1024*1024//(width*3*8)))
                for y in range(0, height, rows):
                    checkpoint(canceled)
                    original = image[y:y+rows].astype(np.float64)
                    block = ((original-offset)/scale).astype(np.float32)
                    if not np.isfinite(block).all() or np.any(block < 0) or np.any(block > 1):
                        raise ValueError('范围映射未能满足0..1约定，已停止；没有裁切原母版。')
                    error = np.abs(block.astype(np.float64)*scale+offset-original)
                    error_max = max(error_max, float(error.max()))
                    changed += int(np.count_nonzero(error))
                    output_low, output_high = min(output_low, float(block.min())), max(output_high, float(block.max()))
                    mapped[y:y+rows] = block
                    progress(.3+.5*min(1, (y+rows)/height))
                mapped.flush()
            record = {'kind': KIND, 'schema': 1, 'stage': 'range-prepared-linear',
                      'source': {'path': str(source), **info['fingerprint']},
                      'width': width, 'height': height, 'profile': PROFILE,
                      'profileSHA256': hashlib.sha256(linear_profile()).hexdigest(),
                      'mapping': info['mapping'], 'stats': info['stats'],
                      'rounding': {'changedChannels': changed, 'maxAbsError': error_max,
                                   'maxErrorFractionOfRange': error_max/(max(1., info['stats']['max'])-offset)},
                      'outputRange': [output_low, output_high],
                      'nonlinearStretch': False, 'displayStretch': False}
            checkpoint(canceled)
            target = folder/'prepared.tif'
            tifffile.imwrite(target, mapped, photometric='rgb', metadata=None,
                             description=json.dumps(record, ensure_ascii=True),
                             iccprofile=linear_profile(), software='Star Studio Linear Preparation',
                             rowsperstrip=32, bigtiff=mapped.nbytes > 3_500_000_000)
            progress(.95)
            checkpoint(canceled)
            if fingerprint(source) != info['fingerprint']:
                raise ValueError('处理期间母版发生变化，未提交副本；请重新检查。')
            target.replace(output)
            progress(1)
            return {'path': str(output), 'metadata': record, 'width': width, 'height': height, 'profile': PROFILE}
        finally:
            if mapped is not None:
                mapped._mmap.close()
