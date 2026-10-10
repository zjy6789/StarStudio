"""Local RAW/dark/bias validation. Originals are read-only; results stay ignored."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time

import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend.calibration import Calibration, selected_paths
from backend.demosaic import demosaic
from backend.stack_io import read_sensor_frame, read_frame, preview_png
from backend.stacking import stack
from tools.stack_real_smoke import peak_memory


def digest(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file,'sha256').hexdigest()


def noise(image):
    patch=image[200:800,3000:4000,1].copy()
    high=patch-cv2.GaussianBlur(patch,(0,0),2)
    return float(np.median(np.abs(high-np.median(high)))*1.4826)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('--count',type=int,default=20)
    parser.add_argument('--mode',choices=['mean','sigma','median'],default='mean')
    args=parser.parse_args()
    files=[str(p) for p in sorted((args.source/'1').glob('*.NEF'))][:args.count]
    settings={kind:[str(p) for p in sorted((args.source/folder).glob('*.NEF'))]
              for kind,folder in [('dark','暗场'),('bias','偏置')]}
    if len(files)!=args.count or not all(settings.values()):
        raise ValueError('Requested unique light frames and both calibration sets must exist.')
    folder=ROOT/'artifacts/calibration-validation';folder.mkdir(exist_ok=True)
    sources=files+settings['dark']+settings['bias']
    hashes={path:digest(path) for path in sources}
    started=time.monotonic();phase=[]
    def message(text):
        phase.append({'seconds':round(time.monotonic()-started,2),'message':text})
        print(text,flush=True)
    output=folder/f'real-{args.count}-{args.mode}-calibrated.dng'
    report=stack({'paths':files,'calibration':settings,'mode':args.mode,'landscape':True,
                  'format':'dng','output':str(output)},folder,lambda _:None,message)
    image,meta=read_frame(output)
    stack_noise=noise(image)
    (folder/f'real-{args.count}-{args.mode}-preview.png').write_bytes(base64.b64decode(preview_png(image,meta).split(',')[1]))
    del image
    # Same float demosaicer for before/after; avoids confusing AHD differences with calibration.
    with tempfile.TemporaryDirectory(prefix='diagnostic-',dir=folder) as work:
        with Calibration(settings,selected_paths(settings),work,message,lambda _:None,lambda:False) as cal:
            cal.prepare(report['reference'])
            raw,rawmeta=read_sensor_frame(report['reference'])
            before=demosaic(raw/cal.scale,rawmeta['bayer'])
            uncal_noise=noise(before);del before
            hot=cal.masters['dark']>200
            # Compare each CFA site against its same-color 5x5 neighborhood.
            def excess(data):
                samples=[]
                for y in range(2):
                    for x in range(2):
                        site=data[y::2,x::2].copy()
                        high=site-cv2.medianBlur(site,5)
                        samples.append(high[hot[y::2,x::2]])
                return float(np.median(np.concatenate(samples)))
            hot_before=excess(raw)
            cal.correct(raw,bias=cal.masters['bias'],dark=cal.masters['dark'])
            hot_after=excess(raw);del raw
            reference,_=cal.read_frame(report['reference'])
            reference_noise=noise(reference);del reference
            diagnostics={'hotSensorPixels':int(np.count_nonzero(hot)),
                         'medianHotExcessAduBefore':hot_before,'medianHotExcessAduAfter':hot_after,
                         'uncalibratedReferenceNoiseMAD':uncal_noise,'calibratedReferenceNoiseMAD':reference_noise,
                         'stackNoiseMAD':stack_noise,'stackToCalibratedReferenceNoise':stack_noise/reference_noise}
    assert all(digest(path)==hashes[path] for path in sources),'Source changed during processing'
    results={'report':report,'diagnostics':diagnostics,'sourceHashes':hashes,'sourcesUnchanged':True,
             'peakWorkingSetMiB':peak_memory(),'phase':phase,'temporaryCachesClean':not list(folder.glob('stack-*')) and not list(folder.glob('diagnostic-*'))}
    (folder/f'real-{args.count}-{args.mode}-validation.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in results.items() if k not in {'report','sourceHashes','phase'}},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
