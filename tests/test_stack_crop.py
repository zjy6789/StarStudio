import base64
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image

from backend.stack_crop import crop_stack
from backend.stacking import stack
from test_stack_layers import sequence


@pytest.fixture
def saved_stack(tmp_path, sequence, request):
    format = getattr(request, 'param', 'tiff32')
    suffix = '.dng' if format == 'dng' else '.fit' if format.startswith('fits') else '.tif'
    result = stack(dict(sequence, format=format, output=str(tmp_path/('source'+suffix)), qualityReport=True),
                   tmp_path, lambda _: None, lambda _: None)
    return result


def payload(info, output):
    return dict(source=info['output'], output=str(output), confirmed=True, crop=info['quality']['crop'],
                sourceSHA256=info['quality']['sourceSHA256'], recordSHA256=info['recordSHA256'])


def raw_image(path, format):
    if format.startswith('fits'):
        from astropy.io import fits
        with fits.open(path, do_not_scale_image_data=True) as image:
            return np.moveaxis(image[0].data.copy(), 0, -1)
    return tifffile.imread(path)


@pytest.mark.parametrize('saved_stack', ['dng', 'tiff16', 'tiff32', 'fits16', 'fits32'], indirect=True)
def test_crop_keeps_native_stored_pixels_and_color_metadata(tmp_path, saved_stack):
    info = saved_stack
    source = Path(info['output'])
    output = tmp_path/('crop'+source.suffix)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    record_before = Path(str(source)+'.json').read_bytes()
    box = info['quality']['crop']
    result = crop_stack(payload(info, output), lambda _: None, lambda: False)
    np.testing.assert_array_equal(raw_image(output, info['format']),
                                  raw_image(source, info['format'])[box['top']:box['bottom'], box['left']:box['right']])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    assert Path(str(source)+'.json').read_bytes() == record_before
    assert result['shape'] == [box['bottom']-box['top'], box['right']-box['left'], 3]
    assert result['format'] == info['format']
    assert result['crop']['sourceSHA256'] == before
    assert result['encoding']['newQuantization'] is False
    assert result['crop']['sourceEncoding'] == info['encoding']
    if info['format'].startswith('fits'):
        from astropy.io import fits
        with fits.open(source, do_not_scale_image_data=True) as old, fits.open(output, do_not_scale_image_data=True) as new:
            for key in ['BITPIX', 'BSCALE', 'BZERO', 'COLORSPC', 'CHANNELS', 'BUNIT']:
                assert new[0].header.get(key) == old[0].header.get(key)
            np.testing.assert_array_equal(new['STARMETA'].data, old['STARMETA'].data)
    else:
        with tifffile.TiffFile(source) as old, tifffile.TiffFile(output) as new:
            assert new.pages[0].dtype == old.pages[0].dtype
            if info['format'] == 'dng':
                for key in [50706, 50707, 50708, 50721, 50728, 50778, 50717, 50714, 50730, 50936]:
                    assert new.pages[0].tags[key].value == old.pages[0].tags[key].value
                assert new.pages[0].tags[50719].value == (0, 0)
                assert new.pages[0].tags[50720].value == (result['shape'][1], result['shape'][0])
            else:
                assert new.pages[0].tags[34675].value == old.pages[0].tags[34675].value
    count = np.asarray(Image.open(io.BytesIO(base64.b64decode(result['quality']['png'].split(',', 1)[1]))))
    assert count.shape == tuple(result['shape'][:2]) and (count == info['frames']).all()
    shift = np.array([[1, 0, -box['left']], [0, 1, -box['top']], [0, 0, 1]])
    for old, new in zip(info['alignment'], result['alignment']):
        np.testing.assert_array_equal(new['matrix'], shift @ np.array(old['matrix']))
    stored = json.loads(Path(str(output)+'.json').read_text(encoding='utf-8'))
    assert stored['quality'] == result['quality']
    assert 'layers' not in result and not list(tmp_path.glob('.starstudio-crop-*'))


@pytest.mark.parametrize('change', ['source', 'record', 'bounds', 'confirm'])
def test_changed_source_report_or_unconfirmed_crop_is_refused(tmp_path, saved_stack, change):
    output = tmp_path/'crop.tif'
    request = payload(saved_stack, output)
    if change == 'source':
        with open(saved_stack['output'], 'r+b') as f:
            f.seek(-4, 2)
            f.write(b'xxxx')
    elif change == 'record':
        path = Path(saved_stack['output']+'.json')
        path.write_bytes(path.read_bytes()+b' ')
    elif change == 'bounds':
        request['crop'] = dict(left=0, top=0, right=1, bottom=1)
    else:
        request['confirmed'] = False
    with pytest.raises(ValueError, match='变化|确认|范围'):
        crop_stack(request, lambda _: None, lambda: False)
    assert not output.exists() and not Path(str(output)+'.json').exists()


@pytest.mark.parametrize('target', ['image', 'record', 'hardlink'])
def test_existing_targets_are_never_overwritten(tmp_path, saved_stack, target):
    output = tmp_path/'crop.tif'
    if target == 'hardlink':
        output.hardlink_to(saved_stack['output'])
    else:
        (output if target == 'image' else Path(str(output)+'.json')).write_bytes(b'keep')
    protected = output if target != 'record' else Path(str(output)+'.json')
    before = protected.read_bytes()
    with pytest.raises(ValueError, match='已存在'):
        crop_stack(payload(saved_stack, output), lambda _: None, lambda: False)
    assert protected.read_bytes() == before


def test_cancel_and_commit_collision_clean_only_task_outputs(tmp_path, saved_stack, monkeypatch):
    output = tmp_path/'crop.tif'
    with pytest.raises(InterruptedError, match='取消'):
        crop_stack(payload(saved_stack, output), lambda _: None, lambda: True)
    assert not output.exists()
    original = Path.rename
    def collide(path, target):
        if str(target).endswith('.json'):
            Path(target).write_bytes(b'other process')
        return original(path, target)
    monkeypatch.setattr(Path, 'rename', collide)
    with pytest.raises((ValueError, OSError)):
        crop_stack(payload(saved_stack, output), lambda _: None, lambda: False)
    assert not output.exists()
    assert Path(str(output)+'.json').read_bytes() == b'other process'
    assert not list(tmp_path.glob('.starstudio-crop-*'))


def test_late_cancel_and_source_change_do_not_commit_partial_crops(tmp_path, saved_stack, monkeypatch):
    from backend import stack_crop
    output = tmp_path/'late.tif'
    original = Path.rename
    state = {'cancel': False}
    def commit_first(path, target):
        result = original(path, target)
        state['cancel'] = True
        return result
    monkeypatch.setattr(Path, 'rename', commit_first)
    with pytest.raises(InterruptedError, match='取消'):
        crop_stack(payload(saved_stack, output), lambda _: None, lambda: state['cancel'])
    assert not output.exists() and not Path(str(output)+'.json').exists()
    monkeypatch.setattr(Path, 'rename', original)
    copy = stack_crop._copy_image
    def changed(source, *args):
        copy(source, *args)
        with open(source, 'ab') as file:
            file.write(b'external edit')
    monkeypatch.setattr(stack_crop, '_copy_image', changed)
    with pytest.raises(ValueError, match='来源或记录发生变化'):
        crop_stack(payload(saved_stack, output), lambda _: None, lambda: False)
    assert not output.exists() and not list(tmp_path.glob('.starstudio-crop-*'))


def test_crop_bridge_and_source_record_hash_contract(tmp_path, saved_stack):
    from backend.server import Store
    from test_server import wait_for_job
    source = Path(saved_stack['output'])
    assert 'compositionPreview' in saved_stack
    stored = json.loads(Path(str(source)+'.json').read_text(encoding='utf-8'))
    assert 'compositionPreview' not in stored and 'recordSHA256' not in stored
    assert saved_stack['recordSHA256'] == hashlib.sha256(Path(str(source)+'.json').read_bytes()).hexdigest()
    store = Store(tmp_path)
    state = wait_for_job(store, store.job(dict(payload(saved_stack,tmp_path/'bridge.tif'),op='stackCrop')))
    assert state['state'] == 'done' and state['result']['format'] == 'tiff32'


def test_missing_source_has_an_actionable_error(tmp_path, saved_stack):
    source = Path(saved_stack['output'])
    source.rename(tmp_path/'moved.tif')
    with pytest.raises(ValueError, match='移动|删除'):
        crop_stack(payload(saved_stack,tmp_path/'crop.tif'), lambda _: None)


def test_dangling_output_symlink_is_not_followed(tmp_path, saved_stack):
    output,target = tmp_path/'link.tif',tmp_path/'unrequested.tif'
    try:
        output.symlink_to(target)
    except OSError as error:
        pytest.skip('Symlink creation unavailable: '+str(error))
    with pytest.raises(ValueError, match='已存在'):
        crop_stack(payload(saved_stack,output), lambda _: None)
    assert output.is_symlink() and not target.exists()


@pytest.mark.parametrize('format,suffix', [('dng','.dng'),('tiff32','.tif'),('fits32','.fit')])
def test_float_pixel_copy_preserves_negative_zero_subnormals_and_maximum(format,suffix,tmp_path):
    from backend.stack_crop import _copy_image
    from backend.stack_io import write_result
    image = np.zeros((4,4,3),dtype=np.float32)
    image[1,1] = [-0.,np.nextafter(np.float32(0),np.float32(1)),np.finfo(np.float32).max]
    source, output = tmp_path/('source'+suffix),tmp_path/('crop'+suffix)
    write_result(source,image,{'space':'prophoto'},format)
    _copy_image(source,output,format,[4,4,3],dict(left=1,top=1,right=3,bottom=3),lambda:None)
    expected = raw_image(source,format)[1:3,1:3]
    actual = raw_image(output,format)
    assert actual.dtype == expected.dtype and actual.tobytes() == expected.tobytes()
