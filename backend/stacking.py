"""Star registration and bounded-memory, scene-linear stacking."""
import json
import shutil
import tempfile
import time
import warnings
from contextlib import ExitStack
from pathlib import Path

import astroalign
import cv2
import numpy as np
import sep
from scipy.spatial import cKDTree

from .stack_io import ordered_paths, read_frame, preview_png, write_result, RAW_EXTENSIONS
from .calibration import Calibration, selected_paths
from .stack_layers import layer_targets, save_layers

MODES = {'mean', 'median', 'sigma', 'maximum', 'minimum'}
cv2.setNumThreads(min(8, cv2.getNumberOfCPUs()))


def inspect(paths):
    files = ordered_paths(paths)
    index = len(files)//2
    image, meta = read_frame(files[index])
    h, w = image.shape[:2]
    return {'paths':files, 'reference':index, 'name':Path(files[index]).name, 'width':w, 'height':h,
            'raw':all(Path(p).suffix.lower() in RAW_EXTENSIONS for p in files),
            'preview':preview_png(image, meta), 'cacheGB':round(len(files)*h*w*3*4/1024**3, 2)}


def star_catalog(image, strokes):
    """SEP centroids at full resolution; compact sources exclude terrain edges."""
    mono = np.ascontiguousarray(image.mean(axis=2), dtype=np.float32)
    background = sep.Background(mono, bw=64, bh=64)
    mono -= background.back()
    objects = sep.extract(mono, 5., err=background.rms(), minarea=4)
    good = (objects['a'] < 12) & (objects['b'] > .45) & (objects['a']/np.maximum(objects['b'],.1) < 1.8) & (objects['flag'] < 8)
    objects = objects[good]
    objects = objects[np.argsort(objects['flux'])[::-1]]
    points = np.column_stack([objects['x'], objects['y']])
    h, w = image.shape[:2]
    # Brush segments are specified in reference coordinates, and applied to every frame.
    keep = np.ones(len(points), dtype=bool)
    for stroke in strokes:
        radius = float(stroke['radius'])*max(h,w)
        brush = np.asarray(stroke['points'], dtype=float)*[w,h]
        for i, start in enumerate(brush):
            end = brush[min(i+1,len(brush)-1)]
            vector = end-start
            t = np.clip(((points-start)@vector)/max(float(vector@vector),1e-12),0,1)
            distance = np.linalg.norm(points-(start+t[:,None]*vector),axis=1)
            keep &= distance > radius
    return points[keep][:300]


def stationary_points(reference, first, last, tolerance=1.2):
    """Keep only candidates static at both temporal extremes; never mask an immobile sky."""
    if min(len(reference),len(first),len(last)) < 8:
        return np.empty((0,2))
    d1 = cKDTree(first).query(reference)[0]
    d2 = cKDTree(last).query(reference)[0]
    fixed = (d1 < tolerance) & (d2 < tolerance)
    moving = (~fixed) & (np.maximum(d1,d2) > 2*tolerance)
    return reference[fixed] if moving.sum() >= 8 else np.empty((0,2))


def moving_points(points, fixed):
    return points[cKDTree(fixed).query(points)[0] > 1.5] if len(fixed) else points


def register(points, reference):
    if min(len(points),len(reference)) < 6:
        raise ValueError('有效星点不足 6 个；请调整画笔蒙版或更换素材。')
    transform, (source, target) = astroalign.find_transform(points, reference, max_control_points=100)
    # Refine using all detected stars after triangle matching; enforce credible pixel residuals.
    from skimage.transform import estimate_transform
    for _ in range(2):
        distances, indices = cKDTree(reference).query(transform(points))
        good = distances < 2
        if good.sum() >= 6:
            source, target = points[good], reference[indices[good]]
            transform = estimate_transform('similarity', source, target)
    matrix = transform.params
    # A rotating wide sky is projective. Refine star correspondences, never terrain corners.
    distances, indices = cKDTree(reference).query(transform(points))
    good = distances < 8
    if good.sum() >= 12:
        candidate, inliers = cv2.findHomography(points[good],reference[indices[good]],cv2.RANSAC,1.,maxIters=2000,confidence=.995)
        if candidate is not None and inliers.sum() >= 12:
            source = points[good][inliers.ravel().astype(bool)]
            target = reference[indices[good]][inliers.ravel().astype(bool)]
            matrix = candidate
    projected = cv2.perspectiveTransform(source[:,None,:].astype(np.float64),matrix)[:,0]
    residual = np.linalg.norm(projected-target,axis=1)
    rms = float(np.sqrt(np.mean(residual**2)))
    if len(source) < 6 or rms > 1.:
        raise ValueError(f'星点对齐可信度不足：{len(source)} 个匹配，RMS {rms:.2f} 像素。')
    return matrix, {'matches':len(source), 'rms':rms, 'matrix':matrix.tolist()}


def warp_tile(image, matrix, y, rows):
    h, w = image.shape[:2]
    if matrix.shape == (2,3):
        matrix = np.vstack([matrix,[0,0,1]])
    if np.allclose(matrix, np.eye(3), atol=1e-10):
        return image[y:y+rows], np.ones((rows,w),dtype=bool)
    local = matrix.copy()
    local[1] -= y*local[2]
    aligned = cv2.warpPerspective(image,local,(w,rows),flags=cv2.INTER_LANCZOS4,borderMode=cv2.BORDER_CONSTANT)
    inverse = np.linalg.inv(matrix)
    xx = np.arange(w)[None,:]
    yy = np.arange(y,y+rows)[:,None]
    divisor = inverse[2,0]*xx+inverse[2,1]*yy+inverse[2,2]
    sx = (inverse[0,0]*xx+inverse[0,1]*yy+inverse[0,2])/divisor
    sy = (inverse[1,0]*xx+inverse[1,1]*yy+inverse[1,2])/divisor
    valid = (sx >= 3) & (sx < w-4) & (sy >= 3) & (sy < h-4)
    return aligned, valid


def reduce_tile(data, mode):
    """NaN denotes absent coverage; zero-padded edges never darken a stack."""
    if mode == 'median':
        return np.nanmedian(data,axis=0)
    if mode == 'sigma':
        a = data.copy()
        for _ in range(3):
            center = np.nanmedian(a,axis=0)
            mad = np.nanmedian(np.abs(a-center),axis=0)*1.4826
            deviation = np.nanstd(a,axis=0)
            # A zero MAD with at least 3 values indicates a repeated, reliable signal.
            scale = np.where((mad == 0) & (np.sum(np.isfinite(a),axis=0) >= 3),0,np.maximum(mad,deviation*.1))
            a[np.abs(a-center) > 3*scale] = np.nan
        return np.nanmean(a,axis=0,dtype=np.float64).astype(np.float32)
    raise ValueError('未知分块堆栈模式。')


def stack(request, scratch, progress, message, cancelled=lambda:False):
    files = ordered_paths(request['paths'])
    mode = request.get('mode','mean')
    if mode not in MODES:
        raise ValueError('未知堆栈模式。')
    output = Path(request['output']).resolve()
    format = request.get('format','dng')
    if format not in {'dng','tiff16','tiff32','fits16','fits32'}:
        raise ValueError('未知保存格式。')
    suffix = '.dng' if format == 'dng' else '.fit' if format in {'fits16','fits32'} else '.tif'
    if output.suffix.lower() not in ({'.fit','.fits','.fts'} if suffix == '.fit' else {suffix}):
        raise ValueError('输出扩展名与保存格式不一致。')
    settings = request.get('calibration',{})
    groups = selected_paths(settings)
    calibration_files = [p for paths in groups.values() for p in paths]
    inputs = {p.casefold() for p in files+calibration_files}
    if {p.casefold() for p in files} & {p.casefold() for p in calibration_files}:
        raise ValueError('亮场素材不能同时作为校准场，请检查文件选择。')
    if str(output).casefold() in inputs:
        raise ValueError('输出不能覆盖堆栈素材。')
    layered = request.get('referenceGround',False)
    if not isinstance(layered,bool):
        raise ValueError('参考地景选项必须为开关值。')
    layer_files = layer_targets(output,format) if layered else None
    photoshop_output = output
    if format in {'fits16','fits32'} and not layered:
        photoshop_output = Path(request.get('photoshopOutput',output.with_name(output.stem+'_PS.tif'))).resolve()
        if photoshop_output.suffix.lower() != '.tif' or not photoshop_output.parent.is_dir():
            raise ValueError('Photoshop 临时结果需要存在的文件夹与 .tif 扩展名。')
        if str(photoshop_output).casefold() in inputs or photoshop_output.exists():
            raise ValueError(f'供 Photoshop 打开的 TIFF 已存在：{photoshop_output}。请使用另一个输出名称。')
    strokes = request.get('mask',[])
    reference_index = len(files)//2
    started = time.monotonic()
    records = []
    def check():
        if cancelled():
            raise ValueError('堆栈已取消。')
    with tempfile.TemporaryDirectory(prefix='stack-',dir=scratch) as work, ExitStack() as resources:
        work = Path(work)
        calibration = None
        read = read_frame
        if calibration_files:
            calibration = resources.enter_context(Calibration(settings,groups,work,message,progress,cancelled))
            message('准备传感器校准…')
            calibration.prepare(files[reference_index])
            read = calibration.read_frame
        message('读取中间基准帧…')
        reference, meta = read(files[reference_index])
        shape = reference.shape
        h, w, c = shape
        needed = reference.nbytes*(len(files)+3 if mode in {'median','sigma'} else 5)
        if shutil.disk_usage(work).free < needed:
            raise ValueError(f'临时磁盘空间不足；此模式约需 {needed/1024**3:.1f} GB。请释放项目所在磁盘空间或使用均值。')
        catalogs = {reference_index:star_catalog(reference,strokes)}
        fixed = np.empty((0,2))
        if request.get('landscape',False):
            message('识别固定地景特征…')
            for index in {0,len(files)-1}:
                check()
                image, _ = read(files[index])
                if image.shape != shape:
                    raise ValueError(f'照片尺寸不一致：{Path(files[index]).name}')
                catalogs[index] = star_catalog(image,strokes)
                del image
            fixed = stationary_points(catalogs[reference_index],catalogs[0],catalogs[len(files)-1])
        targets = moving_points(catalogs[reference_index],fixed)
        if len(targets) < 6:
            raise ValueError('基准帧有效星点不足，请调整蒙版或检查照片。')
        reference_map = np.lib.format.open_memmap(work/'reference.npy',mode='w+',dtype='<f4',shape=shape)
        reference_map[:] = reference
        del reference
        accumulator = None
        if mode not in {'median','sigma'}:
            accumulator = np.lib.format.open_memmap(work/'accumulator.npy',mode='w+',dtype='<f8' if mode == 'mean' else '<f4',shape=shape)
            accumulator[:] = 0 if mode == 'mean' else -np.inf if mode == 'maximum' else np.inf
        count = np.lib.format.open_memmap(work/'coverage.npy',mode='w+',dtype='<u2',shape=(h,w))
        count[:] = 0
        cached = []
        try:
            for i, path in enumerate(files):
                check()
                message(f'对齐与累积 {i+1}/{len(files)} · {Path(path).name}')
                image, current_meta = (reference_map,meta) if i == reference_index else read(path)
                if image.shape != shape or current_meta['space'] != meta['space']:
                    raise ValueError(f'照片尺寸或颜色空间不一致：{Path(path).name}')
                if meta['space'] == 'camera' and not np.allclose(current_meta['matrix'],meta['matrix'],rtol=.002,atol=.002):
                    raise ValueError('RAW 来源相机或颜色矩阵不一致，请分别堆栈。')
                if i == reference_index:
                    matrix = np.eye(3)
                    detail = {'matches':len(targets),'rms':0.,'matrix':np.eye(3).tolist()}
                else:
                    points = catalogs.get(i)
                    if points is None:
                        points = star_catalog(image,strokes)
                    try:
                        matrix, detail = register(moving_points(points,fixed),targets)
                    except Exception as e:
                        raise ValueError(f'{Path(path).name} 对齐失败：{e}') from e
                records.append({'file':path,**detail})
                aligned = np.lib.format.open_memmap(work/f'frame-{i}.npy',mode='w+',dtype='<f4',shape=shape) if mode in {'median','sigma'} else None
                if aligned is not None:
                    cached.append(Path(aligned.filename))
                for y in range(0,h,128):
                    check()
                    block, valid = warp_tile(image,matrix,y,min(128,h-y))
                    count[y:y+len(block)] += valid
                    if aligned is not None:
                        aligned[y:y+len(block)] = np.where(valid[...,None],block,np.nan)
                    elif mode == 'mean':
                        accumulator[y:y+len(block)] += np.where(valid[...,None],block,0)
                    else:
                        operation = np.maximum if mode == 'maximum' else np.minimum
                        destination = accumulator[y:y+len(block)]
                        operation(destination,block,out=destination,where=valid[...,None])
                    progress(.15+.65*(i+(y+len(block))/h)/len(files))
                if aligned is not None:
                    aligned.flush()
                    aligned._mmap.close()
                del image
            result = np.lib.format.open_memmap(work/'result.npy',mode='w+',dtype='<f4',shape=shape)
            try:
                message('生成浮点堆栈结果…')
                tile_rows = max(1,min(128,128*1024*1024//(len(files)*w*c*4)))
                for y in range(0,h,tile_rows):
                    check()
                    rows = min(tile_rows,h-y)
                    if cached:
                        data = np.empty((len(cached),rows,w,c),dtype=np.float32)
                        for i, path in enumerate(cached):
                            check()
                            a = np.load(path,mmap_mode='r')
                            try:
                                data[i] = a[y:y+rows]
                            finally:
                                a._mmap.close()
                        with warnings.catch_warnings():
                            warnings.simplefilter('ignore',RuntimeWarning)
                            result[y:y+rows] = reduce_tile(data,mode)
                    elif mode == 'mean':
                        result[y:y+rows] = accumulator[y:y+rows]/count[y:y+rows,...,None]
                    else:
                        result[y:y+rows] = accumulator[y:y+rows]
                    progress(.8+.1*(y+rows)/h)
                message('保存堆栈结果…')
                check()
                calibration_info = calibration.summary() if calibration else None
                summary = {'output':str(output),'reference':files[reference_index],'frames':len(files),'mode':mode,
                           'format':format,'shape':list(shape),
                           'fixedFeatures':len(fixed),'coverageMin':int(count.min()),'coverageMax':int(count.max()),
                           'alignment':records,'color':meta,
                           'resampling':'Lanczos4 once; reference is not resampled',
                           'calibration':calibration_info}
                if layered:
                    summary = save_layers(layer_files,result,reference_map,meta,format,summary,started,check)
                else:
                    encoding = write_result(output,result,meta,format,calibration=calibration_info)
                    if format in {'fits16','fits32'}:
                        # Native Photoshop does not read FITS. Preserve the requested
                        # astronomical file and open a full float32 temporary TIFF.
                        check()
                        write_result(photoshop_output,result,meta,'tiff32')
                    summary.update(encoding=encoding,photoshopOutput=str(photoshop_output),seconds=round(time.monotonic()-started,2))
                    output.with_suffix(output.suffix+'.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
                progress(1)
                return summary
            finally:
                result._mmap.close()
        finally:
            if isinstance(locals().get('aligned'),np.memmap) and not aligned._mmap.closed:
                aligned._mmap.close()
            for a in [reference_map,accumulator,count]:
                if a is not None:
                    a._mmap.close()
