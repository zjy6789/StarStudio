"""Physical sensor fixtures and independent upstream/file-format checks."""
import json
import struct
import subprocess

import numpy as np
import pytest
import tifffile
from astropy.io import fits
from astropy.nddata import CCDData  # Initialize Astropy before Colour's optional plotting shim.
from colour_demosaicing import demosaicing_CFA_Bayer_Malvar2004

from backend.calibration import Calibration, selected_paths
from backend.demosaic import demosaic
from backend.stack_io import PROPHOTO_XYZ, read_sensor_frame, write_result
from backend.stacking import stack
from backend.paths import siril_path
from tests.test_stacking import stars


def sensor_file(path, signal, black=(512, 520, 520, 530), pattern='RGGB', exposure=20, iso=800, orientation=1, margins=(0,0)):
    """Write actual Bayer DNG codes and an EXIF IFD, read by LibRaw/ExifRead."""
    h, w = signal.shape
    pedestal = np.tile(np.asarray(black).reshape(2, 2), ((h+1)//2, (w+1)//2))[:h, :w]
    codes = np.rint(signal+pedestal).astype(np.uint16)
    rational = lambda values: tuple(x for n in np.asarray(values).ravel() for x in (round(float(n)*1_000_000), 1_000_000))
    tags = [(274,'H',1,orientation,False), (271,'s',0,'Star Studio',False), (272,'s',0,'Test camera',False),
            (50706,'B',4,(1,4,0,0),False), (50707,'B',4,(1,1,0,0),False),
            (50708,'s',0,'Star Studio Test camera',False), (33421,'H',2,(2,2),False),
            (33422,'B',4,tuple('RGB'.index(c) for c in pattern),False),
            (50721,'2i',9,rational(np.linalg.inv(PROPHOTO_XYZ)),False),
            (50728,'2I',3,(1,1,1,1,1,1),False), (50778,'H',1,23,False),
            (50713,'H',2,(2,2),False), (50714,'2I',4,rational(black),False),
            (50717,'I',1,16383,False), (50829,'I',4,(*margins,h,w),False),
            (50719,'I',2,(0,0),False), (50720,'I',2,(w-margins[1],h-margins[0]),False),
            (64999,'I',1,0,False)]
    tifffile.imwrite(path,codes,photometric=32803,metadata=None,extratags=tags,byteorder='<')
    with tifffile.TiffFile(path) as file:
        pointer = file.pages[0].tags[64999].valueoffset
        entry = file.pages[0].tags[64999].offset
    with path.open('r+b') as file:
        file.seek(0,2)
        offset = file.tell()
        # Two EXIF entries; the exposure rational follows the IFD.
        payload = struct.pack('<H',2)+struct.pack('<HHII',33434,5,1,offset+30)
        payload += struct.pack('<HHII',34855,3,1,iso)+struct.pack('<I',0)
        payload += struct.pack('<II',round(exposure*1_000_000),1_000_000)
        file.write(payload)
        file.seek(entry)
        file.write(struct.pack('<H',34665))
        file.seek(pointer)
        file.write(struct.pack('<I',offset))
    return str(path)


def calibrated(tmp_path, light, groups, linear=False):
    settings = dict(groups,linearTiff=linear)
    with Calibration(settings,selected_paths(settings),tmp_path,lambda _:None,lambda _:None,lambda:False) as cal:
        cal.prepare(light)
        result, meta = cal.read_frame(light)
        masters = {k:np.array(v) for k,v in cal.masters.items()}
        return result, meta, masters, cal.summary()


@pytest.mark.parametrize('pattern',['RGGB','BGGR','GRBG','GBRG'])
def test_tiled_demosaic_matches_upstream_at_boundaries(pattern):
    cfa = np.random.default_rng(7).normal(.3,.8,(259,263)).astype(np.float32)
    expected = demosaicing_CFA_Bayer_Malvar2004(cfa,pattern)
    actual = demosaic(cfa,pattern)
    np.testing.assert_allclose(actual,expected,rtol=2e-6,atol=4e-7)
    assert actual.dtype == np.float32 and actual.min() < 0 and actual.max() > 1


@pytest.mark.parametrize('pattern',['RGGB','BGGR','GRBG','GBRG'])
def test_raw_adu_black_levels_and_phase(tmp_path,pattern):
    signal = np.arange(64*66,dtype=np.float32).reshape(64,66)%1100-80
    path = sensor_file(tmp_path/'sensor.dng',signal,pattern=pattern)
    actual, meta = read_sensor_frame(path)
    np.testing.assert_array_equal(actual,signal)
    assert meta['bayer']==pattern and meta['exposure']==20 and meta['iso']==800
    assert meta['black']==[[512,520],[520,530]]


@pytest.mark.parametrize('margins',[(1,0),(0,1),(1,1)])
def test_requested_odd_dng_crop_matches_libraw_visible_pixel_colors(tmp_path,margins):
    import rawpy
    signal=np.arange(64*66,dtype=np.float32).reshape(64,66)%1100-80
    path=sensor_file(tmp_path/'cropped.dng',signal,margins=margins)
    actual,meta=read_sensor_frame(path)
    with rawpy.imread(path) as raw:
        colors=raw.raw_colors_visible
        expected=raw.raw_image_visible.astype(np.float32)-np.asarray(raw.black_level_per_channel)[colors]
        phase=''.join(raw.color_desc[int(i):int(i)+1].decode() for i in colors[:2,:2].ravel())
        # LibRaw rounds these DNG ActiveArea margins to even sensor coordinates.
        assert meta['crop']==[raw.sizes.top_margin,raw.sizes.left_margin]
    assert meta['bayer']==phase
    np.testing.assert_array_equal(actual,expected)


@pytest.mark.parametrize('use_bias,use_dark',[(True,False),(False,True),(True,True)])
def test_raw_no_double_bias_and_preserves_negative_values(tmp_path,use_bias,use_dark):
    y,x = np.mgrid[:64,:66]
    residual = (x%7-3).astype(np.float32)
    thermal = np.full_like(residual,12); thermal[12,20]=600
    truth = (y+x-90).astype(np.float32)
    light = sensor_file(tmp_path/'light.dng',truth+residual+(thermal if use_dark else 0))
    groups={}
    if use_bias:
        groups['bias']=[sensor_file(tmp_path/'bias.dng',residual,exposure=.001)]
    if use_dark:
        groups['dark']=[sensor_file(tmp_path/'dark.dng',residual+thermal)]
    actual,meta,masters,_=calibrated(tmp_path,light,groups)
    expected=demosaicing_CFA_Bayer_Malvar2004(truth/(16383-530),'RGGB')
    np.testing.assert_allclose(actual,expected,atol=2e-9)
    if use_bias and use_dark:
        np.testing.assert_array_equal(masters['dark'],thermal)
    assert actual.min()<0


@pytest.mark.parametrize('use_bias,use_dark,use_flat,use_darkflat',[
    (True,False,False,False),(False,True,False,False),(True,True,False,False),
    (False,False,True,False),(True,False,True,False),(False,True,True,False),
    (True,True,True,False),(False,False,True,True),(True,False,True,True),
    (False,True,True,True),(True,True,True,True)])
def test_calibration_combinations_color_flat_and_tile_means(tmp_path,use_bias,use_dark,use_flat,use_darkflat):
    y,x=np.mgrid[:259,:261]
    response=(1-.4*((y-129)/180)**2-.3*((x-130)/180)**2).astype(np.float32)
    response/=response.mean(dtype=np.float64)
    response=np.repeat(response[...,None],3,axis=2)
    truth=np.full_like(response,.15);truth[0,0]=[-.03,1.7,.3]
    # Flat-only is meaningful for already black-corrected, negligible residual bias.
    bias=np.full_like(response,.004) if use_bias or use_darkflat or (use_dark and not use_flat) else np.zeros_like(response)
    dark=np.full_like(response,.002) if use_dark else np.zeros_like(response)
    light=tmp_path/'light.tif';write_result(light,truth*response+bias+dark,{'space':'prophoto'},'tiff32')
    groups={}
    for kind,data in [('bias',bias),('dark',bias+dark)]:
        if (kind=='bias' and use_bias) or (kind=='dark' and use_dark):
            path=tmp_path/(kind+'.tif');write_result(path,data,{'space':'prophoto'},'tiff32');groups[kind]=[str(path)]
    if use_flat:
        flatdark=bias+(.003 if use_darkflat else 0)
        # Exposure metadata unavailable => unmatched science dark must not be used on flats.
        paths=[]
        for i,brightness in enumerate([.18,.32,.52,.4,.28]):
            path=tmp_path/f'flat{i}.tif'
            data=response*np.array([brightness*.7,brightness,brightness*.5],dtype=np.float32)+flatdark
            write_result(path,data,{'space':'prophoto'},'tiff32');paths.append(str(path))
        groups['flat']=paths
        if use_darkflat:
            path=tmp_path/'darkflat.tif';write_result(path,flatdark,{'space':'prophoto'},'tiff32');groups['darkflat']=[str(path)]
    actual,_,masters,summary=calibrated(tmp_path,str(light),groups,True)
    expected=truth if use_flat else truth*response
    # Darkflat without science bias/dark only corrects the flat, not the light.
    if not use_bias and not use_dark:
        expected=expected+(bias/response if use_flat else bias)
    np.testing.assert_allclose(actual,expected,rtol=3e-6,atol=4e-7)
    assert summary['negativeAndHighlightClipping'] is False
    if use_flat:
        np.testing.assert_allclose(masters['flat'],response,atol=4e-7)


def test_master_sigma_rejects_transient_but_keeps_stable_hot_pixel(tmp_path):
    light=sensor_file(tmp_path/'light.dng',np.full((64,64),1000,dtype=np.float32))
    paths=[]
    for i in range(7):
        data=np.full((64,64),5,dtype=np.float32);data[30,30]=800
        if i==2:data[20,20]=4000
        paths.append(sensor_file(tmp_path/f'dark{i}.dng',data))
    _,_,masters,_=calibrated(tmp_path,light,{'dark':paths})
    assert masters['dark'][20,20]==5 and masters['dark'][30,30]==800


@pytest.mark.parametrize('exposure,iso',[(10,800),(20,1600)])
def test_real_metadata_mismatch_rejected(tmp_path,exposure,iso):
    a=np.full((64,64),100,dtype=np.float32)
    light=sensor_file(tmp_path/'light.dng',a)
    dark=sensor_file(tmp_path/'dark.dng',a,exposure=exposure,iso=iso)
    with pytest.raises(ValueError,match='曝光|ISO'):
        calibrated(tmp_path,light,{'dark':[dark]})
    assert not list(tmp_path.glob('cal-*.npy'))


def test_invalid_flat_and_cancel_cleanup(tmp_path):
    a=np.full((64,64),100,dtype=np.float32)
    light=sensor_file(tmp_path/'light.dng',a)
    flat=sensor_file(tmp_path/'flat.dng',a*0)
    with pytest.raises(ValueError,match='信号不足'):
        calibrated(tmp_path,light,{'flat':[flat]})
    with pytest.raises(ValueError,match='平暗场'):
        selected_paths({'darkflat':[flat]})
    with Calibration({},selected_paths({'bias':[flat]}),tmp_path,lambda _:None,lambda _:None,lambda:True) as cal:
        with pytest.raises(ValueError,match='取消'):cal.prepare(light)
    assert not list(tmp_path.glob('cal-*.npy'))


@pytest.mark.parametrize('orientation,rotation',[(1,0),(3,2),(6,-1),(8,1)])
def test_raw_orientation_after_float_demosaic(tmp_path,orientation,rotation):
    signal=np.arange(64*66,dtype=np.float32).reshape(64,66)%1000-100
    light=sensor_file(tmp_path/'light.dng',signal,orientation=orientation)
    bias=sensor_file(tmp_path/'bias.dng',np.zeros_like(signal),exposure=.001,orientation=orientation)
    actual,_,_,_=calibrated(tmp_path,light,{'bias':[bias]})
    expected=np.rot90(demosaicing_CFA_Bayer_Malvar2004(signal/(16383-530),'RGGB'),rotation)
    np.testing.assert_allclose(actual,expected,atol=2e-8)


@pytest.mark.parametrize('use_bias,use_darkflat',[(False,False),(True,False),(True,True)])
def test_raw_flat_matched_dark_and_darkflat_do_not_double_bias(tmp_path,use_bias,use_darkflat):
    y,x=np.mgrid[:64,:66]
    response=(1-.3*((y-32)/50)**2-.3*((x-33)/50)**2).astype(np.float32)
    bias=np.full_like(response,8);thermal=np.full_like(response,10)
    light=sensor_file(tmp_path/'light.dng',2000*response+bias+thermal)
    dark=sensor_file(tmp_path/'dark.dng',bias+thermal)
    flat=sensor_file(tmp_path/'flat.dng',4000*response+bias+thermal)
    groups={'dark':[dark],'flat':[flat]}
    if use_bias:groups['bias']=[sensor_file(tmp_path/'bias.dng',bias,exposure=.001)]
    if use_darkflat:groups['darkflat']=[sensor_file(tmp_path/'darkflat.dng',bias+thermal)]
    actual,_,masters,_=calibrated(tmp_path,light,groups)
    # Integer sensor fixture adds <= 0.5 ADU quantization to light and flat.
    assert np.max(np.std(actual[4:-4,4:-4],axis=(0,1)))<3e-5
    for y in range(2):
        for x in range(2):assert abs(masters['flat'][y::2,x::2].mean()-1)<1e-6


def test_invalid_input_and_nonpositive_flat_pixel(tmp_path):
    from PIL import Image
    jpeg=tmp_path/'photo.jpg';Image.new('RGB',(64,64)).save(jpeg)
    with pytest.raises(ValueError,match='校准请使用'):read_sensor_frame(jpeg)
    linear=tmp_path/'linear.dng';write_result(linear,np.ones((64,64,3),dtype=np.float32),{'space':'prophoto'},'dng')
    with pytest.raises(ValueError,match='LinearRaw'):read_sensor_frame(linear)
    signal=np.full((64,64),2000,dtype=np.float32)
    light=sensor_file(tmp_path/'light.dng',signal)
    signal[30,30]=-1
    flat=sensor_file(tmp_path/'badflat.dng',signal)
    with pytest.raises(ValueError,match='非正响应'):
        calibrated(tmp_path,light,{'flat':[flat]})


@pytest.mark.parametrize('format',['fits16','fits32'])
@pytest.mark.parametrize('bounds',[(-.02,1.7),(-1e-8,1e-8),(.123,.123)])
def test_fits_independent_roundtrip_scaling_and_metadata(tmp_path,format,bounds):
    image=np.linspace(*bounds,259*17*3,dtype=np.float32).reshape(259,17,3)
    path=tmp_path/'中文 result.fit'
    meta={'space':'prophoto','exposure':20,'iso':3200}
    info=write_result(path,image,meta,format,{'counts':{'bias':36,'dark':30,'flat':0,'darkflat':0}})
    with fits.open(path,memmap=False) as file:
        assert file[0].header['BITPIX']==(16 if format=='fits16' else -32)
        actual=np.moveaxis(file[0].data,0,-1)
        if format=='fits32' or bounds[0]==bounds[1]:np.testing.assert_array_equal(actual,image)
        else:np.testing.assert_allclose(actual,image,rtol=0,atol=info['quantizationStep']/2+np.finfo(np.float32).eps*max(map(abs,bounds)))
        assert file[0].header['NDARK']==30 and file[0].header['EXPTIME']==20
        assert json.loads(file['STARMETA'].data['JSON'][0])['color']==meta
    assert list(tmp_path.iterdir())==[path]


def test_fits_stack_opens_unquantized_float_tiff(tmp_path):
    files=[]
    for i in range(3):
        path=tmp_path/f'light{i}.tif';write_result(path,stars()+.004,{'space':'prophoto'},'tiff32');files.append(str(path))
    bias=tmp_path/'bias.tif';write_result(bias,np.full((384,384,3),.004,dtype=np.float32),{'space':'prophoto'},'tiff32')
    output=tmp_path/'result.fit';opening=tmp_path/'PS result.tif'
    summary=stack({'paths':files,'format':'fits16','output':str(output),'photoshopOutput':str(opening),
                   'calibration':{'bias':[str(bias)],'linearTiff':True}},tmp_path,lambda _:None,lambda _:None)
    actual=tifffile.imread(opening)
    np.testing.assert_allclose(actual,stars(),atol=2e-7)
    assert actual.dtype==np.float32 and summary['calibration']['counts']['bias']==1
    assert not list(tmp_path.glob('stack-*'))


@pytest.mark.skipif(not siril_path().is_file(),reason='Siril CLI not installed')
def test_siril_float_fits_roundtrip_keeps_negative_highlights_and_rgb_axes(tmp_path):
    image=np.linspace(-.02,1.7,32*33*3,dtype=np.float32).reshape(32,33,3)
    write_result(tmp_path/'input.fit',image,{'space':'prophoto'},'fits32')
    script=tmp_path/'roundtrip.ssf'
    script.write_text('requires 1.4.0\nload input.fit\nsave roundtrip\nclose\n',encoding='utf-8')
    result=subprocess.run([str(siril_path()),'-o','-d',str(tmp_path),'-s',str(script)],capture_output=True,timeout=30)
    assert result.returncode==0,result.stdout.decode(errors='replace')
    np.testing.assert_array_equal(np.moveaxis(fits.getdata(tmp_path/'roundtrip.fit'),0,-1),image)
