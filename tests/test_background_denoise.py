import numpy as np
import pytest
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from skimage.restoration import denoise_nl_means

from backend.background_denoise import LUMA,noise_model,filter_delta,mix_denoise
from backend.server import Handler,Store
from tests.test_server import wait_for_job


def scene(colors=3):
    rng=np.random.default_rng(113)
    y,x=np.mgrid[:96,:160]
    truth=np.full((96,160,colors),.06,np.float64)
    if colors==3:truth+=np.array([.004,-.002,.008])
    truth+=.012*np.exp(-((x-105)**2/500+(y-60)**2/30))[...,None]
    image=(truth+rng.normal(0,.005,truth.shape)).astype(np.float32)
    return image,truth


def run(image,options,target=None):
    model=noise_model(image,target)
    delta=np.empty((*image.shape[:2],model['colors']),np.float64)
    filter_delta(image,model,delta,options.get('detail',.5),target)
    output=np.empty_like(image)
    stats=mix_denoise(image,model,delta,output,options,target)
    return output,model,stats,delta


def test_known_noise_chroma_improvement_and_original_luminance():
    image,truth=scene()
    output,model,stats,_=run(image,dict(strength=1,detail=.5,mode='chroma'))
    assert .004<model['sigma']<.006
    chroma=lambda a:a-(a@LUMA)[...,None]
    before=np.mean((chroma(image)-chroma(truth))**2)
    after=np.mean((chroma(output)-chroma(truth))**2)
    assert after<before*.25
    np.testing.assert_allclose(output@LUMA,image@LUMA,atol=1e-8,rtol=0)
    assert stats['changedPixels']>0


@pytest.mark.parametrize('colors',[1,3])
def test_joint_reduces_known_noise_and_gray_chroma_is_rejected(colors):
    image,truth=scene(colors)
    output,model,_,delta=run(image,dict(strength=1,mode='joint'))
    assert np.mean((output-truth)**2)<np.mean((image-truth)**2)*.3
    if colors==1:
        with pytest.raises(ValueError,match='灰度'):mix_denoise(image,model,delta,output,{'mode':'chroma'})


def test_tiled_delta_matches_independent_whole_operator_with_no_boundary_spike():
    image,_=scene();model=noise_model(image)
    delta=np.empty(image.shape,np.float64)
    filter_delta(image,model,delta,.5)
    whole=denoise_nl_means(image.astype(np.float64),patch_size=5,patch_distance=5,
        sigma=model['sigma'],h=.6*model['sigma'],fast_mode=True,preserve_range=True,channel_axis=-1)
    np.testing.assert_allclose(image+delta,whole,atol=1e-9,rtol=0)
    assert np.max(abs((image+delta-whole)[:,127:130]))<1e-9


def test_zero_strength_mask_outside_alpha_and_fractional_weights_preserved():
    rgb,_=scene();image=np.concatenate((rgb,np.full((*rgb.shape[:2],1),.5,np.float32)),axis=2)
    image[0,0]=[-0.,np.nextafter(np.float32(0),np.float32(1)),1.5,0]
    target=np.zeros((*rgb.shape[:2],1),np.float32);target[20:85,30:135]=.5
    result,model,_,delta=run(image,dict(strength=.8,mode='joint'),target)
    np.testing.assert_array_equal(result[target[...,0]==0].view(np.uint32),image[target[...,0]==0].view(np.uint32))
    np.testing.assert_array_equal(result[...,3],image[...,3])
    zero=np.empty_like(image);mix_denoise(image,model,delta,zero,dict(strength=0,mode='joint'),target)
    np.testing.assert_array_equal(zero.view(np.uint32),image.view(np.uint32))
    full=np.empty_like(image);mix_denoise(image,model,delta,full,dict(strength=1,mode='joint'),target)
    np.testing.assert_allclose(result[40,60,:3],image[40,60,:3]+.8*(full[40,60,:3]-image[40,60,:3]),atol=1e-8)


def test_transparent_context_is_not_painted_or_allowed_to_bleed_hidden_hdr():
    rgb,_=scene();image=np.concatenate((rgb,np.ones((*rgb.shape[:2],1),np.float32)),axis=2)
    image[30:40,30:40,3]=0;image[30:40,30:40,:3]=1e30
    output,_,_,_=run(image,dict(strength=1,mode='joint'))
    np.testing.assert_array_equal(output[22:48,22:48].view(np.uint32),image[22:48,22:48].view(np.uint32))
    assert np.isfinite(output).all()


def test_constant_noise_free_image_is_identity_and_no_minimum_blur_is_invented():
    image=np.full((64,80,3),.1,np.float32)
    output,model,stats,_=run(image,dict(strength=1,mode='joint'))
    assert model['sigma']==0;assert stats['changedPixels']==0
    np.testing.assert_array_equal(output,image)


@pytest.mark.parametrize('kind',['empty','small','nan','invalid_weight'])
def test_invalid_source_or_scope_fails(kind):
    image,_=scene();target=np.ones((*image.shape[:2],1),np.float32)
    if kind=='empty':target[:]=0
    if kind=='small':target[:]=0;target[1:20,1:20]=1
    if kind=='nan':image[0,0,0]=np.nan
    if kind=='invalid_weight':target[0,0]=1.1
    with pytest.raises(ValueError):noise_model(image,target)


def test_cancel_and_extreme_numerical_span_refuse_instead_of_clipping():
    image,_=scene();model=noise_model(image);delta=np.empty(image.shape,np.float64)
    with pytest.raises(InterruptedError):noise_model(image,canceled=lambda:True)
    with pytest.raises(InterruptedError):filter_delta(image,model,delta,.5,canceled=lambda:True)
    image[50,50]=1e30
    with pytest.raises(ValueError,match='跨度'):filter_delta(image,model,delta,.5)


def test_store_cache_is_float64_private_reused_and_cleaned(tmp_path,monkeypatch):
    image,_=scene();store=Store(tmp_path)
    key=store.create(160,96,3,'denoise-source')
    store.images[key]['data'][:]=image;store.images[key].update(ready=True,rows=96)
    request=dict(op='denoiseFit',image=key,scope='starless',confirmedStarless=True)
    assert wait_for_job(store,store.job(dict(request,confirmedStarless=False)))['state']=='error'
    fitted=wait_for_job(store,store.job(request));assert fitted['state']=='done',fitted
    call=lambda options:wait_for_job(store,store.job(dict(op='denoiseRender',image=key,options=options)))
    first=call(dict(strength=.5,detail=.5,mode='chroma'));assert first['state']=='done',first
    candidate=store.denoise_models[key]['candidate']['image']
    assert store.get(candidate,'denoise-delta').dtype==np.float64
    with pytest.raises(ValueError,match='专用来源'):store.get(candidate)
    import backend.background_denoise as module
    original=module.filter_delta
    monkeypatch.setattr(module,'filter_delta',lambda *args:(_ for _ in ()).throw(AssertionError('must reuse')))
    second=call(dict(strength=.7,detail=.5,mode='joint'));assert second['state']=='done',second
    assert second['result']['filterReused'] is True
    monkeypatch.setattr(module,'filter_delta',original)
    third=call(dict(strength=.7,detail=.8,mode='joint'));assert third['state']=='done',third
    assert candidate not in store.images
    current=store.denoise_models[key]['candidate']['image']
    store.delete(key);assert current not in store.images;assert not store.denoise_models


def test_faint_color_structure_and_sharp_color_step_are_not_averaged_to_background():
    image,truth=scene();y,x=np.mgrid[:96,:160]
    bump=np.exp(-((x-105)**2/500+(y-60)**2/30))
    shift=bump[...,None]*[.01,-.002,.005]
    truth+=shift;image+=shift.astype(np.float32)
    truth[:,125:]+=[.03,-.01,.02];image[:,125:]+=[.03,-.01,.02]
    output,_,_,_=run(image,dict(strength=1,mode='chroma'))
    # R-G contrast in a faint colored filament compared with a nearby blank strip.
    contrast=lambda a:float((a[57:64,99:112,0]-a[57:64,99:112,1]).mean()-(a[25:32,99:112,0]-a[25:32,99:112,1]).mean())
    assert contrast(output)>.7*contrast(truth)
    edge=lambda a:float((a[30:60,128:135,0]-a[30:60,128:135,1]).mean()-(a[30:60,115:122,0]-a[30:60,115:122,1]).mean())
    assert edge(output)>.85*edge(truth)


def test_failed_new_candidate_and_queued_cancel_leave_no_orphan_cache(tmp_path,monkeypatch):
    image,_=scene();store=Store(tmp_path);key=store.create(160,96,3,'denoise-source')
    store.images[key]['data'][:]=image;store.images[key].update(ready=True,rows=96)
    assert wait_for_job(store,store.job(dict(op='denoiseFit',image=key,scope='starless',confirmedStarless=True)))['state']=='done'
    first=wait_for_job(store,store.job(dict(op='denoiseRender',image=key,options={'mode':'chroma'})))
    assert first['state']=='done';before=set(store.images);old=store.denoise_models[key]['candidate']['image']
    import backend.background_denoise as module
    monkeypatch.setattr(module,'filter_delta',lambda *args:(_ for _ in ()).throw(ValueError('probe failure')))
    bad=wait_for_job(store,store.job(dict(op='denoiseRender',image=key,options={'detail':.9})))
    assert bad['state']=='error';assert set(store.images)==before;assert store.denoise_models[key]['candidate']['image']==old
    with store.worker:
        canceled=store.job(dict(op='denoiseRender',image=key,options={'detail':.9}))
        store.jobs[canceled]['cancel']=True
    assert wait_for_job(store,canceled)['state']=='canceled';assert set(store.images)==before


def test_correlated_noise_needs_explicit_model_and_can_improve_known_chroma_error():
    from scipy.ndimage import gaussian_filter
    _,truth=scene();rng=np.random.default_rng(715)
    noise=gaussian_filter(rng.normal(size=truth.shape),sigma=(1.2,1.2,0))
    noise*=.005/noise.std(axis=(0,1),keepdims=True)
    image=(truth+noise).astype(np.float32)
    model=noise_model(image)
    assert model['backgroundSigma']>model['sigma']*3
    correlated=dict(model,sigma=model['backgroundSigma'])
    delta=np.empty_like(image,dtype=np.float64);filter_delta(image,correlated,delta,.5)
    output=np.empty_like(image);mix_denoise(image,correlated,delta,output,dict(strength=1,mode='chroma'))
    chroma=lambda a:a-(a@LUMA)[...,None]
    before=np.mean((chroma(image)-chroma(truth))**2);after=np.mean((chroma(output)-chroma(truth))**2)
    assert after<before*.8
    np.testing.assert_allclose(output@LUMA,image@LUMA,atol=1e-8,rtol=0)


def test_http_float_source_and_private_double_cache_are_type_isolated(tmp_path):
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.store,server.token=Store(tmp_path),'test'
    threading.Thread(target=server.serve_forever,daemon=True).start()
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def api(path,data=None,raw=False):
        body=data if isinstance(data,bytes) else json.dumps(data).encode() if data is not None else None
        request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,body,headers={'X-Star-Token':'test'})
        with opener.open(request) as reply:return reply.read() if raw else json.load(reply)
    try:
        image,_=scene();image[70,70]=[-.1,.2,1.5]
        key=api('/denoise-sources',dict(width=160,height=96,components=3))['id']
        assert api(f'/denoise-sources/{key}?y=0&rows=96',image.tobytes())['ready']
        fit=api('/jobs',dict(op='denoiseFit',image=key,scope='starless',confirmedStarless=True))['id']
        assert wait_for_job(server.store,fit)['state']=='done'
        render=api('/jobs',dict(op='denoiseRender',image=key,options={'strength':.5,'mode':'chroma'}))['id']
        assert wait_for_job(server.store,render)['state']=='done'
        private=server.store.denoise_models[key]['candidate']['image']
        for route in ['images','denoise-sources']:
            with pytest.raises(urllib.error.HTTPError):api(f'/{route}/{private}?y=0&rows=96',raw=True)
        with pytest.raises(urllib.error.HTTPError):api(f'/images/{key}?y=0&rows=96',raw=True)
        np.testing.assert_array_equal(np.frombuffer(api(f'/denoise-sources/{key}?y=0&rows=96',raw=True),dtype='<f4').reshape(image.shape),image)
    finally:server.shutdown();server.server_close()
