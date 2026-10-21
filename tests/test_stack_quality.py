import base64
import io
import json

import numpy as np
import pytest
import tifffile
from PIL import Image

from backend.stack_quality import coverage_report
from backend.stacking import stack, inspect
from test_stack_layers import sequence


def png(data):
    return Image.open(io.BytesIO(base64.b64decode(data.split(',', 1)[1])))


def brute_area(mask):
    h, w = mask.shape
    return max([0] + [(right-left)*(bottom-top)
                      for top in range(h) for bottom in range(top+1, h+1)
                      for left in range(w) for right in range(left+1, w+1)
                      if mask[top:bottom, left:right].all()])


def test_crop_and_count_png_against_exhaustive_independent_rectangles():
    rng = np.random.default_rng(7231)
    for _ in range(40):
        count = rng.integers(0, 4, (5, 6), dtype=np.uint16)
        report = coverage_report(count, 3)
        np.testing.assert_array_equal(np.asarray(png(report['png'])), count)
        assert report['histogram'] == np.bincount(count.ravel(), minlength=4).tolist()
        assert report['fullPixels'] == np.count_nonzero(count == 3)
        crop = report['crop']
        if crop:
            assert (crop['right']-crop['left'])*(crop['bottom']-crop['top']) == brute_area(count == 3)
            assert (count[crop['top']:crop['bottom'], crop['left']:crop['right']] == 3).all()
        else:
            assert brute_area(count == 3) == 0


def test_full_count_png_preserves_values_above_8_bits_and_uint16_maximum():
    count = np.array([[0, 1, 255], [256, 1024, 65535]], dtype=np.uint16)
    report = coverage_report(count, 65535)
    np.testing.assert_array_equal(np.asarray(png(report['png'])), count)
    assert report['minimum'] == 0 and report['maximum'] == 65535
    assert report['encoding'] == 'png-uint16'
    assert report['kind'] == 'geometric-coverage-before-rejection'


@pytest.mark.parametrize('fill', [1, 3])
def test_empty_or_full_common_coverage(fill):
    report = coverage_report(np.full((4, 7), fill, dtype=np.uint16), 3)
    assert report['totalPixels'] == 28
    assert report['crop'] == ({'left': 0, 'top': 0, 'right': 7, 'bottom': 4} if fill == 3 else None)


def test_cancel_interrupts_report_without_changing_counts():
    count = np.full((50, 70), 3, dtype=np.uint16)
    def cancel():
        raise InterruptedError('cancel report')
    with pytest.raises(InterruptedError, match='cancel report'):
        coverage_report(count, 3, cancel)
    assert (count == 3).all()


@pytest.mark.parametrize('format', ['dng', 'tiff16', 'tiff32', 'fits16', 'fits32'])
@pytest.mark.parametrize('layered', [False, True])
def test_report_does_not_change_master_for_any_output(tmp_path, sequence, format, layered):
    suffix = '.dng' if format == 'dng' else '.fit' if format.startswith('fits') else '.tif'
    results = []
    for enabled in [False, True]:
        folder = tmp_path / str(enabled)
        folder.mkdir()
        result = stack(dict(sequence, format=format, output=str(folder/('master'+suffix)),
                            qualityReport=enabled, referenceGround=layered),
                       tmp_path, lambda _: None, lambda _: None)
        results.append(result)
    if format.startswith('fits'):
        from astropy.io import fits
        images = [fits.getdata(r['output']) for r in results]
    else:
        images = [tifffile.imread(r['output']) for r in results]
    np.testing.assert_array_equal(*images)
    assert 'quality' not in results[0]
    quality = results[1]['quality']
    count = np.asarray(png(quality['png']))
    assert count.shape == (256, 256)
    assert quality['minimum'] == results[1]['coverageMin'] == count.min()
    assert quality['maximum'] == results[1]['coverageMax'] == count.max()
    # The unwarped middle reference contributes everywhere, including the edges.
    assert count.min() == 1 and count.max() == 3
    stored = json.loads((tmp_path/'True'/('master'+suffix+'.json')).read_text(encoding='utf-8'))
    assert stored['quality'] == quality


def test_bad_report_option_is_rejected_before_processing(tmp_path, sequence, monkeypatch):
    from backend import stacking
    monkeypatch.setattr(stacking, 'star_catalog', lambda *_: pytest.fail('must validate first'))
    with pytest.raises(ValueError, match='质量报告'):
        stack(dict(sequence, output=str(tmp_path/'out.tif'), format='tiff32', qualityReport='yes'),
              tmp_path, lambda _: None, lambda _: None)


def test_saved_count_map_matches_independent_integer_translation_footprints(tmp_path, sequence, monkeypatch):
    from backend import stacking
    translations = iter([(4., 2.), (-5., -3.)])
    def known_transform(*_):
        dx, dy = next(translations)
        matrix = np.array([[1., 0., dx], [0., 1., dy], [0., 0., 1.]])
        return matrix, dict(matches=12, rms=0., matrix=matrix.tolist())
    monkeypatch.setattr(stacking, 'register', known_transform)
    result = stack(dict(sequence, qualityReport=True, format='tiff32', output=str(tmp_path/'count.tif')),
                   tmp_path, lambda _: None, lambda _: None)
    expected = np.ones((256, 256), dtype=np.uint16)
    expected[5:254, 7:256] += 1
    expected[:249, :247] += 1
    np.testing.assert_array_equal(np.asarray(png(result['quality']['png'])), expected)
    assert result['quality']['crop'] == dict(left=7, top=5, right=247, bottom=249)


def test_report_cancellation_before_save_cleans_stack_scratch(tmp_path, sequence, monkeypatch):
    from backend import stacking
    def cancel(*_):
        raise InterruptedError('cancel report')
    monkeypatch.setattr(stacking, 'coverage_report', cancel)
    output = tmp_path/'cancel.tif'
    with pytest.raises(InterruptedError, match='cancel report'):
        stack(dict(sequence, qualityReport=True, format='tiff32', output=str(output)),
              tmp_path, lambda _: None, lambda _: None)
    assert not output.exists() and not list(tmp_path.glob('stack-*'))


def test_sigma_counts_geometric_inputs_even_when_a_sample_is_rejected(tmp_path, sequence, monkeypatch):
    from backend import stacking
    from backend.stack_io import write_result
    matrix = np.eye(3)
    monkeypatch.setattr(stacking, 'register', lambda *_: (matrix, dict(matches=12, rms=0., matrix=matrix.tolist())))
    for path, value in zip(sequence['paths'], [.125, .125, 5.]):
        image = tifffile.imread(path)
        image[220, 220] = value
        write_result(path, image, {'space': 'prophoto'}, 'tiff32')
    output = tmp_path/'sigma.tif'
    result = stack(dict(sequence, mode='sigma', qualityReport=True, format='tiff32', output=str(output)),
                   tmp_path, lambda _: None, lambda _: None)
    np.testing.assert_array_equal(tifffile.imread(output)[220, 220], [.125, .125, .125])
    count = np.asarray(png(result['quality']['png']))
    assert count[220, 220] == 3 and (count == 3).all()


@pytest.mark.parametrize('index', [0, 2])
def test_explicit_reference_drives_inspection_and_unwarped_output(tmp_path, sequence, index):
    reference = sequence['paths'][index]
    info = inspect(sequence['paths'], reference)
    assert info['reference'] == index
    result = stack(dict(sequence, reference=reference, referenceGround=True, format='tiff32',
                        output=str(tmp_path/'chosen.tif')), tmp_path, lambda _: None, lambda _: None)
    assert result['reference'] == reference
    np.testing.assert_array_equal(result['alignment'][index]['matrix'], np.eye(3))
    np.testing.assert_array_equal(tifffile.imread(result['layers']['reference']), tifffile.imread(reference))


def test_foreign_reference_is_rejected_before_image_read(tmp_path, sequence, monkeypatch):
    from backend import stacking
    monkeypatch.setattr(stacking, 'read_frame', lambda *_: pytest.fail('must validate first'))
    with pytest.raises(ValueError, match='基准.*所选'):
        inspect(sequence['paths'], str(tmp_path/'not-selected.tif'))
    with pytest.raises(ValueError, match='基准.*所选'):
        stack(dict(sequence, reference=str(tmp_path/'not-selected.tif'), output=str(tmp_path/'out.tif'), format='tiff32'),
              tmp_path, lambda _: None, lambda _: None)


def test_bridge_failure_returns_exact_file_and_partial_records_without_saving(tmp_path, sequence, monkeypatch):
    from backend import stacking
    from backend.server import Store
    from test_server import wait_for_job
    calls = []
    def matching(*_):
        calls.append(True)
        if len(calls) == 2:
            raise ValueError('test correspondence failure')
        return np.eye(3), dict(matches=12, rms=0., matrix=np.eye(3).tolist())
    monkeypatch.setattr(stacking, 'register', matching)
    output = tmp_path/'failure.tif'
    store = Store(tmp_path)
    result = wait_for_job(store, store.job(dict(sequence, op='stack', format='tiff32', output=str(output))))
    assert result['state'] == 'error'
    assert result['failedFile'] == sequence['paths'][2]
    assert [row['file'] for row in result['alignment']] == sequence['paths'][:2]
    assert not output.exists() and not list(tmp_path.glob('stack-*'))
    inspection = wait_for_job(store, store.job(dict(op='stackInspect', paths=sequence['paths'], reference=sequence['paths'][0])))
    assert inspection['result']['reference'] == 0
