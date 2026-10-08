"""Linear, color-managed stack I/O. This product includes DNG technology under license by Adobe."""
import base64
import io
import json
import re
import struct
from pathlib import Path
from .paths import ROOT

import numpy as np
from PIL import Image, ImageOps
import tifffile

RAW_EXTENSIONS = {'.arw', '.cr2', '.cr3', '.nef', '.nrw', '.raf', '.orf', '.rw2', '.pef', '.srw', '.dng', '.raw'}
EXTENSIONS = RAW_EXTENSIONS | {'.tif', '.tiff', '.png', '.jpg', '.jpeg'}
PROPHOTO_XYZ = np.array([[.7976749, .1351917, .0313534], [.2880402, .7118741, .0000857], [0, 0, .82521]])
SRGB_XYZ = np.array([[.4360747, .3850649, .1430804], [.2225045, .7168786, .0606169], [.0139322, .0971045, .7141733]])
D50 = np.array([.96422, 1, .82521])


def ordered_paths(paths):
    files = sorted({str(Path(p).resolve()) for p in paths if Path(p).suffix.lower() in EXTENSIONS},
                   key=lambda p: [(1,int(x)) if x.isdigit() else (0,x.casefold()) for x in re.split(r'(\d+)', p)])
    if len(files) < 2:
        raise ValueError('请选择至少两张支持的照片。')
    if any(not Path(p).is_file() for p in files):
        raise ValueError('所选照片不存在。')
    if any(Path(p).suffix.lower() in RAW_EXTENSIONS for p in files) and not all(Path(p).suffix.lower() in RAW_EXTENSIONS for p in files):
        raise ValueError('请将 RAW 与已显影照片分开堆栈。')
    return files


def _srgb_decode(a):
    return np.where(a <= .04045, a / 12.92, ((a + .055) / 1.055) ** 2.4)


def linear_profile():
    """ICC v2 matrix/TRC profile, D50 ProPhoto primaries, gamma 1."""
    fixed = lambda x: struct.pack('>i', round(float(x) * 65536))
    xyz = lambda a: b'XYZ \0\0\0\0' + b''.join(fixed(x) for x in a)
    name = b'Star Studio Linear ProPhoto RGB\0'
    desc = b'desc\0\0\0\0' + struct.pack('>I', len(name)) + name + b'\0' * 78
    tags = {b'desc': desc, b'cprt': b'text\0\0\0\0Star Studio\0', b'wtpt': xyz(D50)}
    for i, c in enumerate([b'r', b'g', b'b']):
        tags[c+b'XYZ'] = xyz(PROPHOTO_XYZ[:, i])
        tags[c+b'TRC'] = b'curv\0\0\0\0' + struct.pack('>IH', 1, 256)
    header = bytearray(128)
    header[8:24] = b'\x02\x10\0\0mntrRGB XYZ '
    header[24:36] = struct.pack('>6H', 2026, 10, 8, 0, 0, 0)
    header[36:40] = b'acsp'
    header[64:68] = struct.pack('>I', 1)
    header[68:80] = b''.join(fixed(x) for x in D50)
    table, data = bytearray(), bytearray()
    offset = 132 + 12*len(tags)
    for sig, value in tags.items():
        table += sig + struct.pack('>II', offset+len(data), len(value))
        data += value + b'\0' * (-len(value) % 4)
    profile = header + struct.pack('>I', len(tags)) + table + data
    profile[0:4] = struct.pack('>I', len(profile))
    return bytes(profile)


def _profile_decode(a, profile):
    """Use RGB ICC matrix/TRC data at source precision; reject unsupported LUT profiles."""
    count = struct.unpack_from('>I', profile, 128)[0]
    tags = {}
    for i in range(count):
        sig, offset, length = struct.unpack_from('>4sII', profile, 132+12*i)
        tags[sig] = profile[offset:offset+length]
    if any(c+b'XYZ' not in tags or c+b'TRC' not in tags for c in [b'r', b'g', b'b']):
        raise ValueError('此 ICC 使用 LUT，暂不支持无精度损失的显影转换；请先导出带 RGB 矩阵配置的 16/32 位 TIFF。')
    matrix = np.column_stack([np.array(struct.unpack_from('>3i', tags[c+b'XYZ'], 8))/65536 for c in [b'r', b'g', b'b']])
    for i, c in enumerate([b'r', b'g', b'b']):
        trc, x = tags[c+b'TRC'], a[..., i]
        if trc[:4] == b'curv':
            n = struct.unpack_from('>I', trc, 8)[0]
            if n == 1:
                a[..., i] = np.sign(x)*np.abs(x)**(struct.unpack_from('>H', trc, 12)[0]/256)
            elif n > 1:
                lut = np.frombuffer(trc, dtype='>u2', count=n, offset=12)/65535
                a[..., i] = np.interp(x, np.linspace(0, 1, n), lut)
        elif trc[:4] == b'para':
            kind = struct.unpack_from('>H', trc, 8)[0]
            p = np.frombuffer(trc, dtype='>i4', offset=12)/65536
            g = p[0]
            if kind == 0:
                a[..., i] = np.maximum(x, 0)**g
            elif kind in (3, 4):
                _, aa, bb, cc, dd, *extra = p
                ee, ff = extra if kind == 4 else (0, 0)
                a[..., i] = np.where(x >= dd, np.maximum(aa*x+bb, 0)**g+ee, cc*x+ff)
            elif kind in (1, 2):
                _, aa, bb, *extra = p
                cc = extra[0] if kind == 2 else 0
                a[..., i] = np.where(x >= -bb/aa, np.maximum(aa*x+bb, 0)**g+cc, cc)
            else:
                raise ValueError('不支持的 ICC 色调曲线。')
        else:
            raise ValueError('不支持的 ICC 色调曲线。')
    return (a @ (np.linalg.inv(PROPHOTO_XYZ) @ matrix).T).astype(np.float32)


def _rationals(tag):
    v = np.asarray(tag.value)
    return v.reshape(-1, 2)[:, 0]/v.reshape(-1, 2)[:, 1] if int(tag.dtype) in (5,10) else np.atleast_1d(v).astype(float)


def _camera_metadata(tags):
    index = 2 if 50722 in tags else 1
    matrix = _rationals(tags[50720+index]).reshape(3,3)
    calibration = _rationals(tags[50722+index]).reshape(3,3) if 50722+index in tags else np.eye(3)
    analog = _rationals(tags[50727]) if 50727 in tags else np.ones(3)
    native = np.diag(analog) @ calibration
    return {'space':'camera','raw':True,'matrix':(native@matrix).tolist(),
            'neutral':(native@_rationals(tags[50728])).tolist(),'camera':str(tags[50708].value),
            'illuminant':int(tags[50777+index].value)}


def read_frame(path):
    path = Path(path)
    dng_meta = None
    if path.suffix.lower() == '.dng':
        with tifffile.TiffFile(path) as f:
            pages = list(f.pages)
            if f.pages[0].pages:
                pages += list(f.pages[0].pages)
            page = next((p for p in pages if int(p.photometric) == 34892 and p.samplesperpixel == 3), None)
            dng_meta = _camera_metadata(f.pages[0].tags)
            if page is not None:
                a = page.asarray().astype(np.float32)
                white = np.asarray(page.tags[50717].value, dtype=float)
                black = _rationals(page.tags[50714]) if 50714 in page.tags else 0
                a = (a-black)/(white-black)
                return a.astype(np.float32), dng_meta
    if path.suffix.lower() in RAW_EXTENSIONS:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            if raw.num_colors != 3:
                raise ValueError('当前 RAW 颜色平面不是 RGB，暂不支持此相机。')
            matrix = np.asarray(dng_meta['matrix']) if dng_meta else raw.rgb_xyz_matrix[:3].copy()
            camera = str(raw.sizes.raw_width)+'x'+str(raw.sizes.raw_height)+' camera RGB'
            illuminant = 21
            if path.suffix.lower() == '.nef':
                with tifffile.TiffFile(path) as f:
                    camera = str(f.pages[0].tags[272].value)
                if abs(np.linalg.det(matrix)) < 1e-8:
                    calibration = json.loads((ROOT/'vendor/stack-camera-calibrations.json').read_text(encoding='utf-8'))['cameras'].get(camera)
                    if calibration:
                        matrix = np.asarray(calibration['matrix'])
                        illuminant = calibration['illuminant']
            wb = np.asarray(raw.camera_whitebalance[:3], dtype=float)
            if np.any(wb <= 0):
                wb = np.asarray(raw.daylight_whitebalance[:3], dtype=float)
            if abs(np.linalg.det(matrix)) < 1e-8 or np.any(wb <= 0):
                raise ValueError('RAW 缺少有效颜色矩阵或白平衡，无法保留可靠颜色。')
            a = raw.postprocess(output_bps=16, gamma=(1, 1), no_auto_bright=True,
                                output_color=rawpy.ColorSpace.raw, user_wb=[1, 1, 1, 1],
                                use_camera_wb=False, use_auto_wb=False, bright=1,
                                adjust_maximum_thr=0, user_sat=raw.white_level,
                                demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD)
            meta = dng_meta or {'space':'camera', 'matrix':matrix.tolist(), 'neutral':(wb[1]/wb).tolist(),
                    'raw':True, 'camera':camera, 'illuminant':illuminant}
            return a.astype(np.float32)/65535, meta
    profile = None
    if path.suffix.lower() in {'.tif', '.tiff'}:
        with tifffile.TiffFile(path) as f:
            p = f.pages[0]
            a = p.asarray()
            if p.planarconfig == 2:
                a = np.moveaxis(a, 0, -1)
            profile = p.tags[34675].value if 34675 in p.tags else None
        if a.dtype.kind == 'u':
            a = a.astype(np.float32)/np.iinfo(a.dtype).max
        else:
            a = a.astype(np.float32)
    else:
        with Image.open(path) as im:
            profile = im.info.get('icc_profile')
            a = np.asarray(ImageOps.exif_transpose(im).convert('RGB'), dtype=np.float32)/255
        if profile is None:
            a = (_srgb_decode(a) @ (np.linalg.inv(PROPHOTO_XYZ) @ SRGB_XYZ).T).astype(np.float32)
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=2)
    if a.ndim != 3 or a.shape[2] not in (3, 4):
        raise ValueError('堆栈仅支持 RGB 或灰度照片。')
    if a.shape[2] == 4:
        if np.any(a[..., 3] != 1):
            raise ValueError('堆栈素材包含透明像素，请使用不透明照片。')
        a = a[..., :3].copy()
    if profile:
        a = _profile_decode(a, profile)
    if not np.isfinite(a).all():
        raise ValueError('照片包含无效像素。')
    return np.ascontiguousarray(a), {'space':'prophoto', 'raw':False}


def camera_to_prophoto(meta):
    matrix = np.asarray(meta['matrix'])
    white = np.linalg.solve(matrix, meta['neutral'])
    white /= white[1]
    bradford = np.array([[.8951, .2664, -.1614], [-.7502, 1.7135, .0367], [.0389, -.0685, 1.0296]])
    adapt = np.linalg.inv(bradford) @ np.diag((bradford@D50)/(bradford@white)) @ bradford
    xyz = np.linalg.inv(matrix)
    scale = (xyz @ np.asarray(meta['neutral']))[1]
    return np.linalg.inv(PROPHOTO_XYZ) @ adapt @ xyz / scale


def preview_png(image, meta, max_size=1280):
    import cv2
    h, w = image.shape[:2]
    a = cv2.resize(image, (max(1, round(w*min(1, max_size/max(h,w)))), max(1, round(h*min(1,max_size/max(h,w))))), interpolation=cv2.INTER_AREA)
    if meta['space'] == 'camera':
        a = a @ camera_to_prophoto(meta).T
    a = a @ (np.linalg.inv(SRGB_XYZ) @ PROPHOTO_XYZ).T
    # Display stretch only; stack pixels are never changed by this preview.
    a = np.arcsinh(np.maximum(a, 0)*20)/np.arcsinh(20)
    a = np.clip(a, 0, 1)
    a = np.where(a <= .0031308, 12.92*a, 1.055*a**(1/2.4)-.055)
    buf = io.BytesIO()
    Image.fromarray(np.rint(a*255).astype(np.uint8)).save(buf, format='PNG')
    return 'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()


def write_result(path, image, meta, format):
    path = Path(path)
    if format not in {'dng', 'tiff16', 'tiff32'}:
        raise ValueError('未知保存格式。')
    temporary = path.with_name(path.name+'.part')
    try:
        if format == 'dng':
            cm = np.asarray(meta['matrix']) if meta['space'] == 'camera' else np.linalg.inv(PROPHOTO_XYZ)
            neutral = meta['neutral'] if meta['space'] == 'camera' else [1,1,1]
            rational = lambda v: tuple(x for n in np.asarray(v).ravel() for x in (round(float(n)*1_000_000),1_000_000))
            tags = [(274,'H',1,1,False), (50706,'B',4,(1,4,0,0),False), (50707,'B',4,(1,4,0,0),False),
                    (50708,'s',0,meta.get('camera','Star Studio Linear ProPhoto'),False),
                    (50721,'2i',9,rational(cm),False), (50728,'2I',3,rational(neutral),False),
                    (50778,'H',1,meta.get('illuminant',23),False), (50717,'I',1,1,False),
                    (50714,'2I',1,(0,1),False), (50730,'2i',1,(0,1),False),
                    (50719,'I',2,(0,0),False), (50720,'I',2,(image.shape[1],image.shape[0]),False),
                    (50936,'s',0,'Star Studio Linear',False)]
            # LinearRaw has three camera color planes, not one gray plane plus two ExtraSamples.
            tifffile.imwrite(temporary, image, photometric=34892, planarconfig='contig', extrasamples=False, metadata=None, extratags=tags,
                             software='Star Studio', rowsperstrip=32, subfiletype=0)
            return_info = {'scale':1, 'clipped':0}
        else:
            a = image
            if meta['space'] == 'camera':
                a = np.lib.format.open_memmap(path.with_name(path.name+'.color.npy'),mode='w+',dtype='<f4',shape=image.shape)
                for y in range(0, image.shape[0], 128):
                    a[y:y+128] = image[y:y+128] @ camera_to_prophoto(meta).T
            scale, clipped = 1., 0
            if format == 'tiff16':
                # One documented global scale retains positive highlight ratios, no per-frame normalization.
                scale = max(1., float(np.max(a)))
                clipped = int(np.count_nonzero(a < 0))
                encoded = np.lib.format.open_memmap(path.with_name(path.name+'.encoded.npy'),mode='w+',dtype='<u2',shape=a.shape)
                for y in range(0, a.shape[0], 128):
                    encoded[y:y+128] = np.rint(np.maximum(a[y:y+128],0)/scale*65535).astype(np.uint16)
            else:
                encoded = a
            tifffile.imwrite(temporary, encoded, photometric='rgb', metadata=None, iccprofile=linear_profile(),
                             software='Star Studio', rowsperstrip=32, bigtiff=image.nbytes > 3_500_000_000)
            return_info = {'scale':scale, 'clipped':clipped}
        temporary.replace(path)
        return return_info
    finally:
        temporary.unlink(missing_ok=True)
        for suffix, array in [('.color.npy',locals().get('a')),('.encoded.npy',locals().get('encoded'))]:
            if isinstance(array, np.memmap) and array is not image:
                array._mmap.close()
            path.with_name(path.name+suffix).unlink(missing_ok=True)
