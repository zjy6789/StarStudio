"""Masked float NLM; original data and alpha never become filter padding."""
import base64
import io

import numpy as np
from astropy.stats import mad_std
from PIL import Image,ImageDraw
from scipy.ndimage import minimum_filter
from skimage.restoration import denoise_nl_means,estimate_sigma

from .algorithms import color_count
from .background import mask_data,robust_coefficients
from .protection_masks import validate_source
from .star_processing import number

TILE,HALO=128,8
LUMA=np.array([.2126,.7152,.0722],dtype=np.float64)
LUMA/=LUMA.sum()


def check(canceled):
    if canceled():raise InterruptedError("背景降噪已取消")


def noise_model(image,target=None,progress=lambda x:None,canceled=lambda:False):
    h,w,c=image.shape;n=color_count(image)
    region=mask_data(target,(h,w))
    valid=region>0 if region is not None else np.ones((h,w),dtype=bool)
    for y in range(0,h,256):
        check(canceled);validate_source(image[y:y+256])
        if c!=n:valid[y:y+256]&=image[y:y+256,:,-1]>0
    yy,xx=np.flatnonzero(valid.any(axis=1)),np.flatnonzero(valid.any(axis=0))
    if not len(yy) or not len(xx) or yy[-1]-yy[0]<31 or xx[-1]-xx[0]<31:
        raise ValueError("请扩大背景选区，至少包含连续32×32可见像素")
    patches=[]
    ys=np.unique(np.linspace(yy[0],yy[-1]-31,min(20,max(1,len(yy)//16))).astype(int))
    xs=np.unique(np.linspace(xx[0],xx[-1]-31,min(20,max(1,len(xx)//16))).astype(int))
    for y in ys:
        check(canceled)
        for x in xs:
            if valid[y:y+32,x:x+32].all():
                patches.append((float(np.median(image[y:y+32,x:x+32,:n])),int(x),int(y)))
        progress(.3+.2*(int(y)-yy[0])/max(1,yy[-1]-yy[0]))
    if not patches:raise ValueError("未找到连续32×32的可靠背景，请扩大选区或选择更平稳的天空")
    selected=sorted(patches)[:min(32,max(1,int(np.ceil(len(patches)/4))))]
    estimates=[];residual_estimates=[]
    py,px=np.mgrid[:32,:32]
    design=np.column_stack((np.ones(1024),px.ravel()/31,py.ravel()/31))
    for i,(_,x,y) in enumerate(selected):
        check(canceled)
        patch=image[y:y+32,x:x+32,:n].astype(np.float64)
        sigma=np.zeros(n,dtype=np.float64)
        varying=np.ptp(patch,axis=(0,1))>0
        if varying.any():sigma[varying]=estimate_sigma(patch[...,varying],channel_axis=-1,average_sigmas=False)
        if not np.isfinite(sigma).all():raise ValueError("背景噪声估计未得到有限值，请重新选择可靠背景")
        residual_sigma=np.zeros(n,dtype=np.float64)
        if varying.any():
            values=patch.reshape(-1,n)[:,varying]
            coefficients=robust_coefficients(design,values)
            residual_sigma[varying]=mad_std(values-design@coefficients,axis=0)
        residual_estimates.append(residual_sigma)
        estimates.append(sigma);progress(.5+.4*(i+1)/len(selected))
    channel_sigma=np.median(estimates,axis=0)
    sigma=float(np.sqrt(np.mean(channel_sigma**2)))
    residual_sigma=np.median(residual_estimates,axis=0)
    background_sigma=max(sigma,float(np.sqrt(np.mean(residual_sigma**2))))
    step=max(1,int(np.ceil(max(h,w)/700)))
    thumb=np.clip(image[::step,::step,:n],0,1)
    if n==1:thumb=np.repeat(thumb,3,axis=2)
    preview=Image.fromarray(np.rint(thumb*255).astype(np.uint8));draw=ImageDraw.Draw(preview)
    for _,x,y in selected:draw.rectangle((x/step,y/step,(x+32)/step,(y+32)/step),outline='#55ff88')
    buffer=io.BytesIO();preview.save(buffer,format='PNG')
    check(canceled);progress(1);check(canceled)
    return dict(width=w,height=h,colors=n,sigma=sigma,backgroundSigma=background_sigma,channelSigma=channel_sigma.tolist(),
                patches=len(selected),candidates=len(patches),targetPixels=int(valid.sum()),
                samplingPreview='data:image/png;base64,'+base64.b64encode(buffer.getvalue()).decode())


def tile_weight(image,region,t,l,b,r,top,left,bottom,right):
    weight=np.array(region[top:bottom,left:right],copy=True) if region is not None else np.ones((bottom-top,right-left),np.float32)
    if image.shape[2] in (2,4):
        guard=minimum_filter(image[t:b,l:r,-1]>0,size=2*HALO+1,mode='nearest')
        weight*=guard[top-t:bottom-t,left-l:right-l]
    return weight


def filter_delta(image,model,output,detail,target=None,progress=lambda x:None,canceled=lambda:False):
    detail=number({'detail':detail},'detail',.5,0,1)
    h,w,c=image.shape;n=color_count(image);region=mask_data(target,(h,w))
    if output.shape!=(h,w,n) or output.dtype!=np.float64:raise ValueError("内部降噪修正缓存必须为完整尺寸float64")
    sigma=model['sigma'];tiles=0
    for top in range(0,h,TILE):
        for left in range(0,w,TILE):
            check(canceled)
            bottom,right=min(h,top+TILE),min(w,left+TILE)
            t,l,b,r=max(0,top-HALO),max(0,left-HALO),min(h,bottom+HALO),min(w,right+HALO)
            output[top:bottom,left:right]=0
            weight=tile_weight(image,region,t,l,b,r,top,left,bottom,right)
            if sigma>0 and np.any(weight>0):
                work=image[t:b,l:r,:n].astype(np.float64)
                if c!=n:work[image[t:b,l:r,-1]<=0]=0
                # Integral patch distances lose significance in extreme ranges.
                if np.ptp(work,axis=(0,1)).max()/sigma>10000:
                    raise ValueError("当前局部数值跨度相对噪声过大，超出快速NLM可靠精度；未应用。请限定更平稳的背景区域并保留母版")
                filtered=denoise_nl_means(np.ascontiguousarray(work[...,0] if n==1 else work),patch_size=5,patch_distance=5,
                    h=.8*(1-.5*detail)*sigma,sigma=sigma,fast_mode=True,preserve_range=True,channel_axis=None if n==1 else -1)
                if n==1:filtered=filtered[...,None]
                delta=filtered[top-t:bottom-t,left-l:right-l]-image[top:bottom,left:right,:n].astype(np.float64)
                if not np.isfinite(delta).all():raise ValueError("降噪修正出现非有限值，未应用")
                output[top:bottom,left:right]=delta;tiles+=1
        progress(min(h,top+TILE)/h)
    check(canceled)
    return dict(filteredTiles=tiles,detail=detail)


def mix_denoise(image,model,delta,output,options,target=None,view='result',progress=lambda x:None,canceled=lambda:False):
    strength=number(options,'strength',.5,0,1);number(options,'detail',.5,0,1)
    mode=options.get('mode','chroma');h,w,c=image.shape;n=color_count(image)
    if mode not in ('chroma','joint') or (n==1 and mode!='joint'):raise ValueError("灰度请使用亮度降噪；RGB可选择仅色噪或联合模式")
    if output.shape!=image.shape or model['width']!=w or model['height']!=h or view not in ('result','weights'):raise ValueError("降噪输出、模型或视图不匹配")
    region=mask_data(target,(h,w))
    lo,hi=float('inf'),-float('inf');negative=above=changed=0
    for top in range(0,h,TILE):
        check(canceled);bottom=min(h,top+TILE)
        block=image[top:bottom];output[top:bottom]=block
        for left in range(0,w,TILE):
            right=min(w,left+TILE)
            t,l,b,r=max(0,top-HALO),max(0,left-HALO),min(h,bottom+HALO),min(w,right+HALO)
            weight=strength*tile_weight(image,region,t,l,b,r,top,left,bottom,right)
            if not model['sigma']:weight[:]=0
            if view=='weights':output[top:bottom,left:right,:n]=weight[...,None]
            elif delta is not None and np.any(weight>0):
                correction=np.array(delta[top:bottom,left:right],copy=True)
                if mode=='chroma':correction-=(correction@LUMA)[...,None]
                active=weight>0;values=image[top:bottom,left:right,:n].astype(np.float64)
                values[active]+=weight[active,None]*correction[active]
                with np.errstate(over='raise',invalid='raise'):output[top:bottom,left:right,:n][active]=values[active]
        colors=output[top:bottom,:,:n]
        if not np.isfinite(colors).all():raise ValueError("降噪结果出现非有限值，未应用")
        visible=block[...,-1]>0 if c!=n else np.ones((bottom-top,w),bool);seen=colors[visible]
        if seen.size:
            lo,hi=min(lo,float(seen.min())),max(hi,float(seen.max()))
            negative+=int((seen<0).sum());above+=int((seen>1).sum())
        changed+=int(np.count_nonzero(np.any(colors!=block[...,:n],axis=2)));progress(bottom/h)
    check(canceled)
    return dict(minimum=lo,maximum=hi,negativeChannels=negative,aboveOneChannels=above,changedPixels=changed)
