"""Optional CCD/CMOS calibration using ccdproc, before registration/demosaicing.

Workflow follows Astropy's CCD reduction guide and Siril's CFA calibration.
Masters are built once with ccdproc.Combiner; disk caches and small tiles bound
memory. All subtraction/division uses ccdproc, not an independent replacement.
"""
from pathlib import Path

import numpy as np

from .demosaic import demosaic
from .stack_io import read_sensor_frame, EXTENSIONS

KINDS = {'bias':'偏置场','dark':'暗场','flat':'平场','darkflat':'平暗场'}


def selected_paths(request):
    groups = {}
    for kind in KINDS:
        paths = sorted({str(Path(p).resolve()) for p in request.get(kind,[])})
        if any(not Path(p).is_file() or Path(p).suffix.lower() not in EXTENSIONS for p in paths):
            raise ValueError(f'{KINDS[kind]}包含不存在或不支持的文件。')
        groups[kind] = paths
    if groups['darkflat'] and not groups['flat']:
        raise ValueError('平暗场用于校准平场；请选择平场，或清除平暗场。')
    return groups


class Calibration:
    def __init__(self, settings, groups, work, message, progress, cancelled):
        self.groups = groups
        self.linear_tiff = bool(settings.get('linearTiff',False))
        self.work, self.message, self.progress, self.cancelled = Path(work), message, progress, cancelled
        self.maps, self.masters, self.warnings, self.records = [], {}, [], {}
        self.completed = 0
        self.total = sum(map(len,groups.values()))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        for array in reversed(self.maps):
            if not array._mmap.closed:
                array._mmap.close()

    def check(self):
        if self.cancelled():
            raise ValueError('堆栈已取消。')

    def warn(self, text):
        if text not in self.warnings:
            self.warnings.append(text)

    def mapped(self, name, shape):
        array = np.lib.format.open_memmap(self.work/name,mode='w+',dtype='<f4',shape=shape)
        self.maps.append(array)
        return array

    def compatible(self, meta, other, name):
        for key in ['sensorShape','bayer','sensorSize','crop','space']:
            if meta.get(key) != other.get(key):
                raise ValueError(f'{name}的传感器尺寸、裁切或颜色排列与基准不匹配。')
        if meta.get('model') and other.get('model') and meta['model'] != other['model']:
            raise ValueError(f'{name}的相机型号与基准不匹配。')
        if meta['space'] == 'camera' and not np.allclose(meta['matrix'],other['matrix'],rtol=.002,atol=.002):
            raise ValueError(f'{name}的相机色彩矩阵与基准不匹配。')
        if meta['bayer'] and not np.isclose(meta['white'],other['white'],rtol=1e-6):
            raise ValueError(f'{name}的 RAW 采样范围与基准不匹配，请使用相同 RAW 位深/拍摄模式的校准场。')
        if meta.get('iso') and other.get('iso'):
            if meta['iso'] != other['iso']:
                raise ValueError(f'{name}的 ISO 与基准不匹配；请分组处理或更换校准场。')
        else:
            self.warn('部分文件没有可读取的 ISO；请确认亮场与校准场使用相同 ISO/增益。')

    def matched_exposure(self, meta, other, name):
        left, right = meta.get('exposure'), other.get('exposure')
        if left and right:
            if not np.isclose(left,right,rtol=.01,atol=1e-6):
                raise ValueError(f'{name}曝光 {right:g} 秒与素材 {left:g} 秒不匹配；本流程不缩放暗场，请使用匹配暗场。')
            return True
        self.warn('部分文件没有可读取的曝光；请确认暗场匹配亮场、平暗场匹配平场。本流程不自动缩放暗场。')
        return False

    def normalize_flat(self, data):
        # Independent CFA sites avoid baking the flat illuminant into star colors.
        # Normalize flats only; never normalize the exposures of science frames.
        slices = [(slice(y,None,2),slice(x,None,2)) for y in range(2) for x in range(2)] if data.ndim == 2 else [(slice(None),slice(None),c) for c in range(3)]
        for sl in slices:
            plane = data[sl]
            mean = float(np.mean(plane,dtype=np.float64))
            if not np.isfinite(mean) or mean <= 0:
                raise ValueError('平场去偏置后的有效信号不足，请重新拍摄或检查校准场。')
            plane /= mean

    def correct(self, data, bias=None, dark=None, flat=None):
        from astropy.nddata import CCDData
        from astropy import units as u
        from ccdproc import subtract_bias, subtract_dark, flat_correct
        for y in range(0,len(data),128):
            self.check()
            tile = slice(y,y+128)
            ccd = CCDData(data[tile],unit=u.adu)
            if bias is not None:
                ccd = subtract_bias(ccd,CCDData(bias[tile],unit=u.adu),add_keyword=False)
            if dark is not None:
                ccd = subtract_dark(ccd,CCDData(dark[tile],unit=u.adu),
                                    data_exposure=1*u.s,dark_exposure=1*u.s,scale=False,add_keyword=False)
            if flat is not None:
                # Already normalized globally by CFA site; tile-local means would
                # erase vignetting. No divisor floor, clipping or negative clamp.
                ccd = flat_correct(ccd,CCDData(flat[tile],unit=u.adu),norm_value=1.,add_keyword=False)
            data[tile] = ccd.data
        return data

    def build_master(self, kind):
        from astropy.nddata import CCDData
        from ccdproc import Combiner
        paths = self.groups[kind]
        cache = []
        self.records[kind] = []
        first_meta = None
        try:
            for i,path in enumerate(paths):
                self.check()
                self.message(f'准备{KINDS[kind]} {i+1}/{len(paths)} · {Path(path).name}')
                data, meta = read_sensor_frame(path,self.linear_tiff)
                self.compatible(self.meta,meta,Path(path).name)
                if first_meta is not None:
                    if kind in {'dark','darkflat'}:
                        self.matched_exposure(first_meta,meta,KINDS[kind])
                else:
                    first_meta = meta
                if kind == 'dark':
                    self.matched_exposure(self.meta,meta,'暗场')
                    self.correct(data,bias=self.masters.get('bias'))
                elif kind == 'flat':
                    if self.masters.get('darkflat') is not None:
                        self.matched_exposure(meta,self.master_meta['darkflat'],'平暗场')
                        self.correct(data,dark=self.masters['darkflat'])
                    elif self.groups['dark'] and meta.get('exposure') and self.master_meta['dark'].get('exposure') and np.isclose(meta['exposure'],self.master_meta['dark']['exposure'],rtol=.01,atol=1e-6):
                        self.correct(data,bias=self.masters.get('bias'),dark=self.masters['dark'])
                        self.warn('平场与暗场曝光一致，已同时将暗场用于平场校准。')
                    else:
                        self.correct(data,bias=self.masters.get('bias'))
                        if not self.groups['bias']:
                            self.warn('平场未使用拍摄的偏置场，采用 RAW 自带黑电平（TIFF 采用已去黑电平的声明）；若存在残余偏置纹理，请补拍偏置场。')
                        if meta.get('exposure',0) >= 1:
                            self.warn('平场曝光达到 1 秒或以上；若热信号不可忽略，建议添加匹配曝光的平暗场。')
                    if meta['saturated']/data.size > .001:
                        raise ValueError(f'平场 {Path(path).name} 有过多饱和像素，请使用未过曝的平场。')
                    self.normalize_flat(data)
                if not np.isfinite(data).all():
                    raise ValueError(f'{Path(path).name} 校准数据包含无效值。')
                mapped = self.mapped(f'cal-{kind}-{i}.npy',data.shape)
                mapped[:] = data
                mapped.flush()
                cache.append(mapped)
                del data
                self.records[kind].append({'file':path,'acquisition':meta})
                self.completed += 1
                self.progress(.15*self.completed/max(1,2*self.total))
            self.message(f'合成{KINDS[kind]}主校准场…')
            master = self.mapped(f'master-{kind}.npy',tuple(self.meta['sensorShape']))
            # Combiner allocates data, masks and uncertainty arrays. Keep the
            # input cube below 32 MiB rather than loading a whole RAW sequence.
            rows = max(1,min(128,32*1024*1024//(len(paths)*int(np.prod(master.shape[1:]))*8)))
            for y in range(0,len(master),rows):
                self.check()
                frames = [CCDData(a[y:y+rows],unit='adu') for a in cache]
                combiner = Combiner(frames,dtype=np.float64)
                if len(frames) >= 5:
                    combiner.sigma_clipping(low_thresh=3,high_thresh=3,func='median',dev_func='mad_std')
                combined = combiner.average_combine()
                if np.any(combined.mask) or not np.isfinite(combined.data).all():
                    raise ValueError(f'{KINDS[kind]}主校准场存在没有有效样本的像素。')
                master[y:y+rows] = combined.data
                self.progress(.15*(self.completed+len(paths)*min(1,(y+rows)/len(master)))/max(1,2*self.total))
            self.completed += len(paths)
            if kind == 'flat':
                self.normalize_flat(master)
                invalid = int(np.count_nonzero(master <= 0))
                if invalid:
                    raise ValueError(f'主平场有 {invalid} 个非正响应像素，无法可靠相除；请更换平场或检查偏置/平暗场，未自动抹除或补造这些像素。')
            if len(paths) < 5:
                self.warn(f'{KINDS[kind]}仅 {len(paths)} 张，使用均值合成；增加校准帧可减少主校准场引入的随机噪声。')
            self.master_meta[kind] = first_meta
            self.masters[kind] = master
        finally:
            for a in cache:
                a._mmap.close()
                Path(a.filename).unlink(missing_ok=True)

    def prepare(self, reference_path):
        self.reference_path = str(Path(reference_path).resolve())
        self.reference, self.meta = read_sensor_frame(reference_path,self.linear_tiff)
        self.master_meta = {}
        needed = self.reference.nbytes*(max(map(len,self.groups.values()))+len(KINDS)+2)
        import shutil
        if shutil.disk_usage(self.work).free < needed:
            raise ValueError(f'校准缓存约需 {needed/1024**3:.1f} GB，请释放临时磁盘空间。')
        self.warn('相机温度通常无法从通用 RAW/EXIF 可靠读取；请自行确认暗场/平暗场与拍摄时温度接近。')
        for kind in ['bias','dark','darkflat','flat']:
            if self.groups[kind]:
                self.build_master(kind)
        self.scale = max(1.,self.meta['white']-float(np.max(self.meta['black']))) if self.meta['bayer'] else 1.

    def read_frame(self, path):
        self.check()
        if str(Path(path).resolve()) == self.reference_path and self.reference is not None:
            data, meta = self.reference, self.meta.copy()
            self.reference = None
        else:
            data, meta = read_sensor_frame(path,self.linear_tiff)
        self.compatible(self.meta,meta,Path(path).name)
        if self.groups['dark']:
            self.matched_exposure(meta,self.master_meta['dark'],'暗场')
        self.correct(data,bias=self.masters.get('bias'),dark=self.masters.get('dark'),flat=self.masters.get('flat'))
        if meta['bayer']:
            data /= self.scale  # One fixed reference ADU scale for all science frames.
            data = demosaic(data,meta['bayer'],self.cancelled)
            if meta['flip'] == 3:
                data = np.rot90(data,2)
            elif meta['flip'] == 5:
                data = np.rot90(data,1)
            elif meta['flip'] == 6:
                data = np.rot90(data,-1)
        if not np.isfinite(data).all():
            raise ValueError(f'{Path(path).name} 校准后包含无效像素。')
        meta['demosaic'] = 'Colour Malvar2004 float32' if meta['bayer'] else 'already linear RGB'
        return np.ascontiguousarray(data),meta

    def summary(self):
        return {'frames':self.records,'counts':{k:len(v) for k,v in self.groups.items()},
                'warnings':self.warnings,'darkScaling':False,'referenceAduScale':self.scale,
                'blackLevel':'per-frame RAW metadata subtracted; measured bias is residual after metadata black level',
                'masterMethod':'ccdproc 2.5.1 float64 mean; >=5 frames: median/MAD 3-sigma clipping, one pass',
                'flatNormalization':'each CFA site / RGB channel; no science-frame exposure normalization',
                'order':'sensor black level -> bias/dark -> flat -> float demosaic -> orientation -> star alignment',
                'negativeAndHighlightClipping':False}
