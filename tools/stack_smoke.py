"""Owned synthetic star/landscape RAW material and numerical stack validation."""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import tifffile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend.stack_io import PROPHOTO_XYZ, read_frame
from backend.stacking import stack


def make_materials(folder, frames=9, size=512):
    folder.mkdir(parents=True,exist_ok=True)
    rng=np.random.default_rng(783)
    y,x=np.mgrid[:size,:size]
    sky=np.full((size,size),.025,dtype=np.float32)
    for sx,sy,flux in zip(rng.uniform(30,size-30,90),rng.uniform(30,size*.65,90),rng.uniform(.08,.5,90)):
        sky+=(flux*np.exp(-((x-sx)**2+(y-sy)**2)/5)).astype(np.float32)
    ground=np.zeros_like(sky)
    ground[y>size*.72]=.04
    for sx,sy in rng.uniform([30,size*.8],[size-30,size-30],(40,2)):
        ground+=(.45*np.exp(-((x-sx)**2+(y-sy)**2)/5)).astype(np.float32)
    paths=[]
    cm=np.linalg.inv(PROPHOTO_XYZ)
    rational=lambda v:tuple(z for n in np.asarray(v).ravel() for z in (round(float(n)*1_000_000),1_000_000))
    tags=[(274,'H',1,1,False),(50706,'B',4,(1,4,0,0),False),(50707,'B',4,(1,1,0,0),False),
          (50708,'s',0,'Star Studio Synthetic Bayer',False),(33421,'H',2,(2,2),False),
          (33422,'B',4,(0,1,1,2),False),(50721,'2i',9,rational(cm),False),(50728,'2I',3,(1,1,1,1,1,1),False),
          (50778,'H',1,23,False),(50714,'2I',1,(512,1),False),(50717,'I',1,16383,False),
          (50719,'I',2,(0,0),False),(50720,'I',2,(size,size),False)]
    for i in range(frames):
        t=i-frames//2
        transform=cv2.getRotationMatrix2D((size/2,size/2),t*.08,1)
        transform[:,2]+=[t*2,t*.6]
        a=cv2.warpAffine(sky,transform,(size,size),flags=cv2.INTER_LANCZOS4)+ground
        a+=rng.normal(0,.005,a.shape).astype(np.float32)
        # Three distinct Bayer channels, 14-bit sensor codes with black pedestal.
        rgb=np.stack([a*.85,a,a*.7],axis=2)
        bayer=np.empty(a.shape,dtype=np.uint16)
        for yy,xx,channel in [(0,0,0),(0,1,1),(1,0,1),(1,1,2)]:
            bayer[yy::2,xx::2]=np.rint(np.clip(rgb[yy::2,xx::2,channel],0,1)*(16383-512)+512).astype(np.uint16)
        path=folder/f'frame{i+1:03d}.dng'
        tifffile.imwrite(path,bayer,photometric=32803,metadata=None,extratags=tags,software='Star Studio test material')
        paths.append(str(path))
    return paths


def main():
    folder=ROOT/'artifacts/stack-validation'
    files=make_materials(folder/'raw')
    reports=[]
    for format in ['dng','tiff32','tiff16']:
        output=folder/('RAW-stack.'+('dng' if format=='dng' else format+'.tif'))
        report=stack({'paths':files,'mode':'mean','landscape':True,'format':format,'output':str(output)},folder,
                     lambda _:None,lambda s:print(s,flush=True))
        reports.append(report)
    # Readback verifies real LibRaw CFA decoding, exact floating output and noise improvement.
    reference,_=read_frame(files[len(files)//2])
    result,_=read_frame(reports[0]['output'])
    region=(slice(353,364),slice(30,482),1)
    values={'referenceNoise':float(reference[region].std()),'stackNoise':float(result[region].std()),
            'floatOutputType':str(tifffile.imread(reports[0]['output']).dtype),'reports':reports}
    (folder/'validation.json').write_text(json.dumps(values,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in values.items() if k!='reports'},ensure_ascii=False))


if __name__=='__main__':main()
