"""Explicit pixel-code copies of a verified stack's common footprint."""
import base64
import io
import json
from pathlib import Path
import tempfile
import time

import numpy as np
from PIL import Image
import tifffile

from .stack_io import linear_profile
from .stack_quality import coverage_report, file_sha256


def _copy_image(source, target, format, shape, box, check):
    left, top, right, bottom = [box[key] for key in ('left', 'top', 'right', 'bottom')]
    if format.startswith('fits'):
        from astropy.io import fits
        with fits.open(source, do_not_scale_image_data=True) as image:
            data, header = image[0].data, image[0].header.copy()
            expected = 'i' if format == 'fits16' else 'f'
            if header.get('ORIGIN') != 'Star Studio' or data.shape != (3, *shape[:2]) or data.dtype.kind != expected:
                raise ValueError('FITS母版布局或来源不符。')
            scale = {key: header[key] for key in ('BSCALE', 'BZERO') if key in header}
            output = fits.PrimaryHDU(data[:, top:bottom, left:right], header=header)
            check()
            fits.HDUList([output, image['STARMETA'].copy()]).writeto(target)
        if scale:
            with fits.open(target, mode='update', do_not_scale_image_data=True) as output:
                output[0].header.update(scale)
    else:
        with tifffile.TiffFile(source) as image:
            page = image.pages[0]
            dtype = np.dtype('uint16' if format == 'tiff16' else 'float32')
            if len(image.pages) != 1 or page.shape != tuple(shape) or page.dtype != dtype or page.tags[305].value != 'Star Studio':
                raise ValueError('TIFF/DNG母版布局或来源不符。')
            tags, profile = [], None
            if format == 'dng':
                if int(page.photometric) != 34892:
                    raise ValueError('需要本插件三通道线性DNG母版。')
                for code in [274,50706,50707,50708,50721,50728,50778,50717,50714,50730,50719,50720,50936]:
                    tag = page.tags[code]
                    value = (right-left,bottom-top) if code == 50720 else (0,0) if code == 50719 else tag.value
                    tags.append((code,int(tag.dtype),tag.count,value,False))
            else:
                profile = page.tags[34675].value
                if profile != linear_profile():
                    raise ValueError('裁剪母版的线性ICC不符。')
            data = tifffile.memmap(source)
            try:
                check()
                tifffile.imwrite(target, data[top:bottom,left:right], photometric=34892 if format == 'dng' else 'rgb',
                                 planarconfig='contig', extrasamples=False, metadata=None, iccprofile=profile,
                                 extratags=tags, software='Star Studio', rowsperstrip=32, subfiletype=0,
                                 bigtiff=(bottom-top)*(right-left)*shape[2]*dtype.itemsize > 3_500_000_000)
            finally:
                data._mmap.close()
    check()


def crop_stack(request, progress, canceled=lambda: False):
    started = time.monotonic()
    def check():
        if canceled():
            raise InterruptedError('裁剪副本已取消。')
    check()
    if request.get('confirmed') is not True:
        raise ValueError('请先查看并确认裁剪范围。')
    source = Path(request['source']).resolve()
    requested_output = Path(request['output'])
    if requested_output.is_symlink():
        raise ValueError('裁剪目标已存在符号链接，请另选新的文件名。')
    output = requested_output.resolve()
    record = source.with_suffix(source.suffix+'.json')
    if not source.is_file() or not record.is_file():
        raise ValueError('母版或同名记录已移动/删除，请重新生成报告。')
    destination_record = output.with_suffix(output.suffix+'.json')
    for path in (output,destination_record):
        if path.exists() or path.is_symlink():
            raise ValueError('裁剪目标已存在，请另选新的文件名。')
    if not output.parent.is_dir():
        raise ValueError('裁剪输出文件夹不存在。')
    if file_sha256(record,check) != request.get('recordSHA256'):
        raise ValueError('堆栈记录已变化，请重新生成或读取报告。')
    info = json.loads(record.read_text(encoding='utf-8'))
    quality = info.get('quality',{})
    signature = quality.get('sourceSHA256')
    if not signature or signature != request.get('sourceSHA256') or file_sha256(source,check) != signature:
        raise ValueError('母版已变化或缺少来源校验，请重新生成报告。')
    if Path(info['output']).resolve() != source:
        raise ValueError('母版路径与报告来源不符。')
    format = info['format']
    suffixes = { 'dng':{'.dng'}, 'tiff16':{'.tif','.tiff'}, 'tiff32':{'.tif','.tiff'},
                 'fits16':{'.fit','.fits','.fts'}, 'fits32':{'.fit','.fits','.fts'} }
    if format not in suffixes or output.suffix.lower() not in suffixes[format]:
        raise ValueError('裁剪副本须保持母版的保存格式。')
    box = request.get('crop')
    h,w,c = info['shape']
    if (not isinstance(box,dict) or set(box) != {'left','top','right','bottom'}
            or any(type(v) is not int for v in box.values()) or box != quality.get('crop')
            or not (0 <= box['left'] < box['right'] <= w and 0 <= box['top'] < box['bottom'] <= h)):
        raise ValueError('裁剪范围与当前覆盖报告不符。')
    with Image.open(io.BytesIO(base64.b64decode(quality['png'].split(',',1)[1]))) as image:
        count = np.asarray(image)
    clipped_count = count[box['top']:box['bottom'],box['left']:box['right']]
    if count.shape != (h,w) or not (clipped_count == info['frames']).all():
        raise ValueError('裁剪范围不是全部帧共同覆盖的区域。')
    progress(.2)
    with tempfile.TemporaryDirectory(prefix='.starstudio-crop-',dir=output.parent) as directory:
        stage = Path(directory)/output.name
        _copy_image(source,stage,format,info['shape'],box,check)
        progress(.7)
        if file_sha256(source,check) != signature or file_sha256(record,check) != request['recordSHA256']:
            raise ValueError('保存期间来源或记录发生变化，本次未提交。')
        result = {key:value for key,value in info.items() if key not in ('output','shape','encoding','quality','alignment','layers','photoshopOutput','seconds')}
        shift = np.array([[1.,0.,-box['left']],[0.,1.,-box['top']],[0.,0.,1.]])
        result.update(output=str(output),shape=[box['bottom']-box['top'],box['right']-box['left'],c],
                      crop=dict(source=str(source),sourceShape=info['shape'],bounds=box,sourceSHA256=signature,
                                sourceRecordSHA256=request['recordSHA256'],
                                sourceEncoding=info['encoding'],operation='stored-pixel-copy-no-resampling'),
                      encoding=dict(newQuantization=False,clipped=0,scale=info['encoding'].get('scale',1)),
                      alignment=[dict(row,matrix=(shift@np.array(row['matrix'])).tolist()) for row in info['alignment']])
        result['quality'] = coverage_report(clipped_count,info['frames'],check)
        result['quality']['sourceSHA256'] = file_sha256(stage,check)
        result['coverageMin'] = result['quality']['minimum']
        result['coverageMax'] = result['quality']['maximum']
        result['seconds'] = round(time.monotonic()-started,2)
        stage_record = stage.with_suffix(stage.suffix+'.json')
        stage_record.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        committed = []
        try:
            for staged,target in [(stage,output),(stage_record,destination_record)]:
                check()
                if target.exists() or target.is_symlink():
                    raise ValueError('裁剪目标已存在，本次未覆盖。')
                staged.rename(target)
                committed.append(target)
            check()
        except BaseException:
            for path in reversed(committed):
                path.unlink()
            raise
    result['recordSHA256'] = file_sha256(destination_record)
    progress(1)
    return result
