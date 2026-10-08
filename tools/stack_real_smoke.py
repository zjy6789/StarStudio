"""Validate copied real RAW material without changing the photographer's originals."""
import ctypes
from ctypes import wintypes
import base64
import json
from pathlib import Path
import sys

import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend.stack_io import read_frame, preview_png, write_result
from backend.stacking import stack


def peak_memory():
    class Counters(ctypes.Structure):
        _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(k,ctypes.c_size_t) for k in
            ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage',
             'QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
    kernel=ctypes.WinDLL('kernel32');kernel.GetCurrentProcess.restype=wintypes.HANDLE
    info=Counters();info.cb=ctypes.sizeof(info)
    query=ctypes.WinDLL('psapi').GetProcessMemoryInfo
    query.argtypes=[wintypes.HANDLE,ctypes.c_void_p,wintypes.DWORD]
    query(kernel.GetCurrentProcess(),ctypes.byref(info),info.cb)
    return round(info.PeakWorkingSetSize/1024**2,1)


def main():
    folder=ROOT/'artifacts/stack-validation'
    paths=[str(p) for p in sorted((folder/'real-raw').glob('*.NEF'))]
    result=stack({'paths':paths,'mode':'mean','landscape':True,'format':'dng',
                  'output':str(folder/'real-stack.dng')},folder,lambda _:None,lambda s:print(s,flush=True))
    peak=peak_memory()
    image,meta=read_frame(result['output'])
    for fmt in ['tiff32','tiff16']:
        write_result(folder/('real-stack-'+fmt+'.tif'),image,meta,fmt)
    (folder/'real-stack-preview.png').write_bytes(base64.b64decode(preview_png(image,meta).split(',')[1]))
    reference,_=read_frame(result['reference'])
    # Same star-sparse sky region; robust high-pass MAD separates noise from broad sky gradients.
    def noise(a):
        patch=a[200:800,3000:4000,1].copy()
        high=patch-cv2.GaussianBlur(patch,(0,0),2)
        return float(np.median(np.abs(high-np.median(high)))*1.4826)
    measurements={'peakWorkingSetMiB':peak,'referenceNoiseMAD':noise(reference),'stackNoiseMAD':noise(image),
                  'noiseMethod':'green channel high-pass MAD; y200:800 x3000:4000, Gaussian sigma2',
                  'maxAlignmentRMS':max(a['rms'] for a in result['alignment']),'report':result}
    (folder/'real-validation.json').write_text(json.dumps(measurements,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in measurements.items() if k!='report'},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
