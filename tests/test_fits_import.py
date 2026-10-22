import hashlib
import json
import time

from astropy.io import fits
import numpy as np
import pytest
import tifffile

from backend.fits_import import inspect_fits, import_fits
from backend.linear_preparation import inspect_master, prepare_master
from backend.server import Store
from backend.stack_io import linear_profile, PROPHOTO_XYZ, SRGB_XYZ


def source(tmp_path, data, cards=None):
    path = tmp_path/'source.fits'
    fits.PrimaryHDU(data).writeto(path, overwrite=True)
    with fits.open(path, mode='update', do_not_scale_image_data=True) as hdus:
        for name, value in (cards or {}).items():
            hdus[0].header[name] = value
    return path


def request(path, color='unknown'):
    return dict(path=str(path), color=color)


def inspected(path, tmp_path, color='unknown'):
    req = request(path, color)
    info = inspect_fits(req)
    return dict(req, fingerprint=info['fingerprint'], output=str(tmp_path/'import.tif'),
                confirmedLinear=True, acceptRounding=True), info


def test_float32_gray_bits_headers_original_hash_and_existing_prepare_chain(tmp_path):
    data = np.array([[-.125, -0., .5], [1., 2., np.nextafter(np.float32(0), np.float32(1))]], dtype='>f4')
    path = source(tmp_path, data, {'CTYPE1': 'RA---TAN', 'CRPIX1': 2, 'HISTORY': 'original processing'})
    original = path.read_bytes()
    req, info = inspected(path, tmp_path)
    assert info['rounding']['changedChannels'] == 0
    result = import_fits(req)
    with tifffile.TiffFile(result['path']) as file:
        output = file.asarray()
        expected = np.repeat(data.astype('<f4')[..., None], 3, axis=2)
        assert np.array_equal(output.view('u4'), expected.view('u4'))
        assert file.pages[0].tags[34675].value == linear_profile()
        record = json.loads(file.pages[0].description)
    assert record['stage'] == 'linear' and record['wcs'] == 'archive-only'
    assert 'RA---TAN' in record['input']['headers'][0] and 'original processing' in record['input']['headers'][0]
    assert record['source']['sha256'] == hashlib.sha256(original).hexdigest()
    master = inspect_master(result['path'])
    prepared = prepare_master(dict(path=result['path'], output=str(tmp_path/'prepared.tif'),
                                  confirmedLinear=True, fingerprint=master['fingerprint']))
    assert prepared['metadata']['stage'] == 'range-prepared-linear'
    assert path.read_bytes() == original


def test_scaled_int16_decodes_in_double_before_float32_and_reports_rounding(tmp_path):
    data = np.array([[-32768, -123], [0, 32767]], dtype=np.int16)
    path = source(tmp_path, data, {'BSCALE': .000000913578, 'BZERO': -.1432754892})
    req, info = inspected(path, tmp_path)
    truth = data.astype(np.float64)*.000000913578-.1432754892
    expected = np.repeat(truth[..., None], 3, axis=2).astype(np.float32)
    assert info['rounding']['changedChannels'] > 0
    assert info['rounding']['maxAbsError'] == np.abs(expected[..., 0].astype(np.float64)-truth).max()
    with pytest.raises(ValueError, match='舍入'):
        import_fits(dict(req, acceptRounding=False))
    assert not (tmp_path/'import.tif').exists()
    result = import_fits(req)
    assert np.array_equal(tifffile.imread(result['path']), expected)
    assert result['metadata']['input']['bscale'] == .000000913578


def test_three_plane_rgb_preserves_plane_order_and_linear_srgb_conversion(tmp_path):
    rgb = np.array([[[-2., .3], [.4, .5]], [[1.3, .6], [.7, .8]], [[.1, .2], [.3, 2.]]], dtype=np.float32)
    path = source(tmp_path, rgb, {'CHANNELS': 'RGB'})
    with pytest.raises(ValueError, match='颜色空间'):
        inspect_fits(request(path))
    req, _ = inspected(path, tmp_path, 'prophoto')
    result = import_fits(req)
    assert np.array_equal(tifffile.imread(result['path']), np.moveaxis(rgb, 0, -1))
    req, _ = inspected(path, tmp_path, 'srgb')
    result = import_fits(req)
    truth = np.moveaxis(rgb, 0, -1).astype(np.float64) @ (np.linalg.inv(PROPHOTO_XYZ) @ SRGB_XYZ).T
    assert np.array_equal(tifffile.imread(result['path']), truth.astype(np.float32))
    assert np.min(tifffile.imread(result['path'])) < 0 and np.max(tifffile.imread(result['path'])) > 1


def test_empty_primary_one_image_extension_and_table_headers(tmp_path):
    path = tmp_path/'extension.fit'
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(np.ones((4, 7), dtype=np.float64)),
                  fits.BinTableHDU.from_columns([fits.Column(name='CATALOG', format='J', array=[123])])]).writeto(path)
    req, info = inspected(path, tmp_path)
    result = import_fits(req)
    assert info['hdu'] == 1 and len(info['headers']) == 3
    assert 'CATALOG' in result['metadata']['input']['headers'][2]


@pytest.mark.parametrize('data,cards,message', [
    (np.ones((2, 4, 5), dtype='f4'), {}, '轴布局'),
    (np.ones((1, 3, 4, 5), dtype='f4'), {}, '轴布局'),
    (np.ones((4, 5), dtype='f4'), {'BAYERPAT': 'RGGB'}, '拜耳'),
    (np.ones((3, 4, 5), dtype='f4'), {'COLORSPC': 'CAMERA'}, '相机原生'),
    (np.ones((3, 4, 5), dtype='f4'), {'CHANNELS': 'BGR'}, '第三轴'),
    (np.ones((3, 4, 5), dtype='f4'), {'CTYPE3': 'FREQ'}, '第三轴'),
    (np.array([[0, -99]], dtype='i2'), {'BLANK': -99}, 'BLANK'),
    (np.array([[1., np.nan]], dtype='f4'), {}, 'NaN'),
    (np.array([[1., np.inf]], dtype='f4'), {}, 'NaN'),
    (np.array([[1e100]], dtype='f8'), {}, '32位浮点范围'),
    (np.array([[2**53+1]], dtype='i8'), {}, '64位整数'),
    (np.ones((4, 5), dtype='f4'), {'BSCALE': 0}, '缩放'),
])
def test_unsupported_inputs_fail_without_output(tmp_path, data, cards, message):
    path = source(tmp_path, data, cards)
    with pytest.raises(ValueError, match=message):
        inspect_fits(request(path, 'prophoto'))
    assert not (tmp_path/'import.tif').exists()


def test_multi_image_and_compressed_fits_are_explicitly_rejected(tmp_path):
    path = tmp_path/'multiple.fts'
    fits.HDUList([fits.PrimaryHDU(np.ones((4, 5))), fits.ImageHDU(np.ones((4, 5)))]).writeto(path)
    with pytest.raises(ValueError, match='多图像'):
        inspect_fits(request(path))
    path = tmp_path/'compressed.fits'
    fits.HDUList([fits.PrimaryHDU(), fits.CompImageHDU(np.ones((4, 5)))]).writeto(path)
    with pytest.raises(ValueError, match='压缩'):
        inspect_fits(request(path))


def test_confirmation_source_changes_overwrite_and_cancellation_preserve_files(tmp_path):
    path = source(tmp_path, np.ones((512, 8), dtype='f4'))
    req, _ = inspected(path, tmp_path)
    for invalid, message in [(dict(confirmedLinear=False), '确认'), (dict(output=str(path)), '覆盖'),
                             (dict(fingerprint={}), '重新检查')]:
        with pytest.raises(ValueError, match=message):
            import_fits(dict(req, **invalid))
    output = tmp_path/'import.tif'
    output.write_bytes(b'previous target')
    progress = []
    with pytest.raises(InterruptedError):
        import_fits(req, progress.append, lambda: bool(progress and progress[-1] >= .95))
    assert output.read_bytes() == b'previous target'
    assert not list(tmp_path.glob('.starstudio-fits-*'))
    with fits.open(path, mode='update') as hdus:
        hdus[0].data[0, 0] = 2
    with pytest.raises(ValueError, match='重新检查'):
        import_fits(req)
    assert output.read_bytes() == b'previous target'


def test_source_changed_during_write_does_not_commit(tmp_path):
    path = source(tmp_path, np.ones((256, 4), dtype='f4'))
    req, _ = inspected(path, tmp_path)
    def progress(value):
        if value == .95:
            with path.open('ab') as file:
                file.write(b'changed')
    with pytest.raises(ValueError, match='处理期间发生变化'):
        import_fits(req, progress)
    assert not (tmp_path/'import.tif').exists()
    assert not list(tmp_path.glob('.starstudio-fits-*'))


def test_job_import_cancel_and_ordinary_upload_contract_stay_separate(tmp_path):
    path = source(tmp_path, np.full((8, 8), -1, dtype='f4'))
    req, _ = inspected(path, tmp_path)
    store = Store(tmp_path/'bridge')
    def wait(key):
        deadline = time.monotonic()+10
        while store.jobs[key]['state'] in ('queued', 'running') and time.monotonic() < deadline:
            time.sleep(.01)
        return store.jobs[key]
    result = wait(store.job(dict(op='fitsImport', **req)))
    assert result['state'] == 'done', result
    assert not store.images
    with store.worker:
        key = store.job(dict(op='fitsInspect', **request(path)))
        store.jobs[key]['cancel'] = True
    assert wait(key)['state'] == 'canceled'
