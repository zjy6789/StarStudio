"""Real engine and HTTP smoke test using the installed StarNet sample."""
from pathlib import Path
import argparse
import json
import sys
import time
import urllib.request
import numpy as np
import tifffile
from PIL import Image
root=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from backend.algorithms import combine

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sample', type=Path, required=True, help='Your RGB 16-bit TIFF sample (not distributed)')
parser.add_argument('--starnet', type=Path, required=True, help='Legacy v2 starnet++.exe with its complete engine directory')
args=parser.parse_args()
config=json.loads((root/'plugin/bridge.json').read_text())
def api(path, body=None, binary=False):
    headers={'X-Star-Token':config['token']}
    if body is not None:
        body=body if isinstance(body,bytes) else json.dumps(body).encode()
        headers['Content-Type']='application/octet-stream' if binary else 'application/json'
    request=urllib.request.Request(config['url']+path,data=body,headers=headers)
    with urllib.request.urlopen(request,timeout=60) as r:
        data=r.read()
    return data if binary and body is None else json.loads(data)
def job(r):
    key=api('/jobs',r)['id']
    while True:
        state=api('/jobs/'+key)
        if state['state']=='error': raise RuntimeError(state['error'])
        if state['state']=='done': return state['result']
        time.sleep(1)
def download(key, shape):
    return np.frombuffer(api('/images/'+key+'?y=0&rows='+str(shape[0]),binary=True),dtype='<f4').reshape(shape)
def save(name,a):
    tifffile.imwrite(root/'artifacts'/f'{name}.tif',np.rint(a[...,:3]*65535).astype(np.uint16),photometric='rgb',metadata=None)
    Image.fromarray(np.rint(a[...,:3]*255).astype(np.uint8)).save(root/'artifacts'/f'{name}.png')

source=tifffile.imread(args.sample)
print('Sample',source.shape,source.dtype,flush=True)
source=source[:512,:512].astype(np.float32)/65535
a=np.concatenate((source,np.ones((*source.shape[:2],1),dtype=np.float32)),axis=2)
h,w,c=a.shape
key=api('/images',dict(width=w,height=h,components=c))['id']
for y in range(0,h,128):
    rows=min(128,h-y)
    api(f'/images/{key}?y={y}&rows={rows}',a[y:y+rows].tobytes(),True)
save('PS-test-input',a)
metrics={}
for engine in ['starnet']:
    start=time.monotonic()
    output=job(dict(op='extract',image=key,engine=engine,mode='screen',executable=str(args.starnet)))
    b,s=download(output['background'],a.shape),download(output['stars'],a.shape)
    reconstructed=combine(b,s,'screen')
    error=float(np.max(np.abs(reconstructed-a)))
    assert error<2e-7
    assert float(s[...,:3].max())>.03
    default=dict(lnD=0,sp=0,hp=1,bp=0,type='ghs')
    request=dict(background=output['background'],stars=output['stars'],bp=default,sp={**default,'type':'asinh'},mode='screen')
    mixed=download(job(dict(op='mix',**request))['image'],a.shape)
    assert np.max(np.abs(mixed-a))<2e-7
    preview=api('/preview',request)
    assert preview['mix'].startswith('data:image/png;base64,')
    changed={**request,'bp':dict(default,lnD=1.5),'sp':dict(default,type='asinh',lnD=.3,bp=.005)}
    adjusted=download(job(dict(op='mix',**changed))['image'],a.shape)
    assert np.mean(np.abs(adjusted-a))>.001
    save(engine+'-starless',b);save(engine+'-starmask',s);save(engine+'-recombined',mixed);save(engine+'-adjusted',adjusted)
    metrics[engine]=dict(seconds=round(time.monotonic()-start,2),max_reconstruction_error=error,mean_star_signal=float(s[...,:3].mean()))
    print(engine,metrics[engine],flush=True)
(root/'artifacts/engine-validation.json').write_text(json.dumps(metrics,indent=2))
print('Real engines + HTTP full pipeline passed',flush=True)
