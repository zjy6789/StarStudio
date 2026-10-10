"""Bounded synthetic capacity checks; not a full-resolution RAW benchmark."""
import json
from pathlib import Path
import shutil
import sys

import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend.stacking import stack
from tests.test_calibration import sensor_file
from tools.stack_smoke import make_materials
from tools.stack_real_smoke import peak_memory


def main():
    folder=ROOT/'artifacts/calibration-validation/capacity';folder.mkdir(parents=True,exist_ok=True)
    originals=make_materials(folder/'originals')
    biases=[sensor_file(folder/f'bias{i}.dng',np.zeros((512,512),dtype=np.float32),
                        black=(512,512,512,512),exposure=.001) for i in range(5)]
    results=[]
    for count,mode in [(50,'median'),(100,'sigma')]:
        batch=folder/str(count);batch.mkdir(exist_ok=True)
        paths=[]
        for i in range(count):
            path=batch/f'frame{i:03d}.dng';shutil.copy2(originals[i%len(originals)],path);paths.append(str(path))
        report=stack({'paths':paths,'calibration':{'bias':biases},'mode':mode,'landscape':True,
                      'format':'dng','output':str(folder/f'{count}-{mode}.dng')},folder,lambda _:None,lambda _:None)
        results.append({'frames':count,'mode':mode,'shape':report['shape'],'seconds':report['seconds'],
                        'maxRms':max(a['rms'] for a in report['alignment']),'cacheClean':not list(folder.glob('stack-*'))})
        print(json.dumps(results[-1]),flush=True)
    result={'runs':results,'peakWorkingSetMiB':peak_memory(),'material':'512x512 Bayer DNG; repeated nine owned synthetic frames, unique filenames'}
    (folder/'validation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')


if __name__=='__main__':main()
