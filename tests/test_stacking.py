import cv2
import numpy as np
import pytest
import tifffile
from PIL import ImageCms

from backend.stack_io import PROPHOTO_XYZ, linear_profile, read_frame, write_result
from backend.stacking import inspect, register, reduce_tile, stack, star_catalog, stationary_points, moving_points, warp_tile


def stars(seed=52, size=384):
    rng = np.random.default_rng(seed)
    y,x = np.mgrid[:size,:size]
    image = np.full((size,size),.04,dtype=np.float32)
    for sx,sy,amplitude in zip(rng.uniform(25,size-25,70),rng.uniform(25,size-25,70),rng.uniform(.15,.7,70)):
        image += (amplitude*np.exp(-((x-sx)**2+(y-sy)**2)/3)).astype(np.float32)
    return np.repeat(image[...,None],3,axis=2)


def test_dng_keeps_float_range_matrix_and_whitebalance(tmp_path):
    a=np.array([[[-.002,.1234567,1.8]]],dtype=np.float32)
    path=tmp_path/'result.dng'
    meta={'space':'camera','matrix':np.linalg.inv(PROPHOTO_XYZ).tolist(),'neutral':[.5,1,.8], 'illuminant':23,'camera':'Test'}
    write_result(path,a,meta,'dng')
    b,metadata=read_frame(path)
    np.testing.assert_array_equal(a,b)
    np.testing.assert_allclose(metadata['matrix'],meta['matrix'],atol=1e-6)
    np.testing.assert_array_equal(metadata['neutral'],meta['neutral'])
    with tifffile.TiffFile(path) as f:
        assert f.pages[0].samplesperpixel==3
        assert f.pages[0].dtype==np.float32
        assert f.pages[0].tags[274].value==1
        assert f.pages[0].tags[254].value==0
        assert 338 not in f.pages[0].tags
        assert f.pages[0].photometric==34892


def test_linear_icc_and_tiff_preserve_precision(tmp_path):
    profile=ImageCms.ImageCmsProfile(__import__('io').BytesIO(linear_profile()))
    assert 'Star Studio Linear ProPhoto' in ImageCms.getProfileDescription(profile)
    a=np.array([[[-.05,.271828,1.5]]],dtype=np.float32)
    path=tmp_path/'output.tif'
    write_result(path,a,{'space':'prophoto'},'tiff32')
    b,_=read_frame(path)
    np.testing.assert_allclose(a,b,atol=4e-5)
    encoding=write_result(path,a,{'space':'prophoto'},'tiff16')
    assert encoding['scale']==1.5 and encoding['clipped']==1
    assert tifffile.imread(path).dtype==np.uint16


def test_natural_sort_middle_reference_and_manual_mask(tmp_path):
    image=stars()
    files=[]
    for name in ['frame10.tif','frame1.tif','frame2.tif']:
        path=tmp_path/name;write_result(path,image,{'space':'prophoto'},'tiff32');files.append(str(path))
    info=inspect(files)
    assert info['name']=='frame2.tif' and info['reference']==1
    catalog=star_catalog(image,[])
    masked=star_catalog(image,[{'radius':.02,'points':[[.5,.5],[.5,1],[1,1],[1,.5]]}])
    assert len(masked)<len(catalog)
    # A whole-image brush must not silently revert to unmasked star points.
    assert len(star_catalog(image,[{'radius':1,'points':[[.5,.5]]}]))==0


def test_landscape_static_lights_are_not_alignment_target():
    rng=np.random.default_rng(74)
    sky=rng.uniform([20,20],[360,200],(40,2));ground=rng.uniform([20,260],[360,360],(35,2))
    reference=np.concatenate([sky,ground]);first=np.concatenate([sky+[10,4],ground]);last=np.concatenate([sky+[-10,-4],ground])
    fixed=stationary_points(reference,first,last)
    assert len(fixed)==len(ground)
    matrix,info=register(moving_points(first,fixed),moving_points(reference,fixed))
    np.testing.assert_allclose(matrix,np.array([[1,0,-10],[0,1,-4],[0,0,1]]),atol=2e-5)
    assert info['rms']<1e-5
    assert len(stationary_points(reference,reference,reference))==0


def test_warp_preserves_values_and_marks_missing_coverage():
    image=np.full((32,40,3),1.5,dtype=np.float32)
    matrix=np.array([[1.,0.,8.],[0.,1.,0.]])
    a,valid=warp_tile(image,matrix,0,32)
    assert not valid[:,:10].any()
    np.testing.assert_allclose(a[valid],1.5,atol=1e-6)
    original,mask=warp_tile(image,np.eye(3)[:2],0,32)
    assert np.shares_memory(original,image) and mask.all()


def test_sigma_removes_outlier_without_zero_padding_bias():
    data=np.array([1.,1.,1.,1.,1.,20.,np.nan],dtype=np.float32).reshape(7,1,1,1)
    assert reduce_tile(data,'median').item()==1
    assert reduce_tile(data,'sigma').item()==1


@pytest.mark.parametrize('mode',['mean','median','sigma','maximum','minimum'])
def test_all_stack_modes_register_and_save(tmp_path,mode):
    original=stars()
    files=[]
    for i in range(3):
        matrix=cv2.getRotationMatrix2D((192,192),(i-1)*.2,1)
        matrix[:,2]+=[(i-1)*4,(i-1)*-3]
        image=cv2.warpAffine(original,matrix,(384,384),flags=cv2.INTER_LANCZOS4)
        path=tmp_path/f'frame{i}.tif';write_result(path,image,{'space':'prophoto'},'tiff32');files.append(str(path))
    output=tmp_path/'stack.tif'
    result=stack({'paths':files,'mode':mode,'format':'tiff32','output':str(output)},tmp_path,lambda _:None,lambda _:None)
    assert result['reference']==files[1]
    assert result['coverageMax']==3 and result['coverageMin']==1
    assert max(a['rms'] for a in result['alignment'])<.15
    actual=tifffile.imread(output)
    np.testing.assert_allclose(actual[40:-40,40:-40],original[40:-40,40:-40],atol=.025)
    assert not list(tmp_path.glob('stack-*'))


def test_cancel_does_not_create_partial_output(tmp_path):
    files=[]
    for i in range(2):
        p=tmp_path/f'{i}.tif';write_result(p,stars(),{'space':'prophoto'},'tiff32');files.append(str(p))
    output=tmp_path/'cancelled.tif'
    with pytest.raises(ValueError,match='取消'):
        stack({'paths':files,'output':str(output),'format':'tiff32'},tmp_path,lambda _:None,lambda _:None,lambda:True)
    assert not output.exists() and not list(tmp_path.glob('stack-*'))
