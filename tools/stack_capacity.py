"""100 small RAW files test capacity only; repeated inputs do not measure SNR."""
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend.stacking import stack
from tools.stack_real_smoke import peak_memory

mode=sys.argv[1]
folder=ROOT/'artifacts/stack-validation'
sources=sorted((folder/'raw').glob('*.dng'))
if not sources:
    raise RuntimeError('Run tools/stack_smoke.py first.')
with tempfile.TemporaryDirectory(prefix='capacity-',dir=folder) as temporary:
    work=Path(temporary)
    paths=[]
    for i in range(100):
        path=work/f'frame{i:03d}.dng'
        shutil.copy2(sources[i%len(sources)],path)
        paths.append(str(path))
    report=stack({'paths':paths,'mode':mode,'landscape':True,'format':'dng',
                  'output':str(work/'result.dng')},work,lambda _:None,lambda _:None)
    result={'frames':report['frames'],'mode':mode,'shape':report['shape'],
            'seconds':report['seconds'],'peakWorkingSetMiB':peak_memory(),
            'purpose':'Capacity only: repeats nine synthetic 512px Bayer RAW frames; not a noise or 24MP speed benchmark.'}
    assert not list(work.glob('stack-*'))
    (folder/f'capacity-{mode}.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result),flush=True)
