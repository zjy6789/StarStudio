const host=require('./host.js');
const $=id=>document.getElementById(id);
const tools=[
  ['coma','彗差减少 / 星形修复','调用 Siril 拟合并重建拉长星点；建议在线性星点层上使用。重建改变星形与光度，不恢复真实光学细节。',[
    ['strength','修复强度',0,1,.01,.5],['sigma','检测阈值 σ',.05,10,.05,2],['radius','搜索半径（原图像素）',3,50,1,8],['roundness','圆度上限（越小越只修复长星）',.1,.99,.01,.9]]],
  ['reduction','缩星 / 控星','用圆形形态学核收缩亮度，保留星点色相；阈值保护暗星，高光保护避免亮星核心过度收缩。',[
    ['strength','缩星强度',0,1,.01,.35],['radius','收缩半径（原图像素）',.1,8,.1,1],['threshold','暗星保护阈值',0,1,.001,.01],['protect','高光保护起点',.01,1,.01,.8]]],
  ['curve','亮度曲线','三个控制点对应输入亮度 25%、50%、75%；单调平滑插值，按亮度调整并尽量保留星点色相。',[
    ['exposure','曝光（EV）',-3,3,.05,0],['shadows','暗部输出',0,1,.01,.25],['midtones','中间调输出',0,1,.01,.5],['highlights','亮部输出',0,1,.01,.75]]],
  ['color','星点色彩','调整 RGB 星点饱和度，保护亮星核心；不会恢复已经过曝丢失的颜色。',[
    ['saturation','饱和度',0,2,.01,1],['protect','高光保护起点',.01,1,.01,.85]]],
  ['glow','辉光 / 柔焦','亮度范围选择发光源，柔和阈值与双尺度高斯光晕模拟柔焦镜。作用于星点层，避免星云与地景整体发光。',[
    ['strength','发光强度',0,5,.05,1],['radius','光晕半径（原图像素）',.5,120,.5,12],['lower','发光亮度下限',0,1,.01,.2],['upper','发光亮度上限',0,1,.01,1],['softness','阈值过渡宽度',.001,.5,.001,.1],['spread','外晕比例',0,1,.01,.35]]]
];

function setup({run,api,job,status,report,selectedLayer,useActive,value,refresh,currentPage,
  refreshBlendModes=()=>{},ensureService=async()=>{},isBusy=()=>false,isUpdatingPickers=()=>false}) {
  let meta=null,last=null,desired=null,timer=null,previewState=null,worker=null,jobID=null;
  let paused=false,modalBusy=false,compositionVersion=0,compositionKey=null,nativeQueue=Promise.resolve(),failedKey=null,runningKey=null;
  function settings() {
    const result={};
    for(const [name,,,specs] of tools) {
      result[name]={enabled:$(name+'Enabled').checked};
      for(const [key] of specs) result[name][key]=Number($('process_'+name+'_'+key).value);
    }
    return result;
  }
  function curvePlot(values) {
    const points=values.map((v,i)=>(i*300/(values.length-1)).toFixed(2)+','+(75-v*75).toFixed(2)).join(' ');
    $('processCurve').src='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="75"><path d="M0 75L300 0" stroke="#555"/><polyline points="'+points+'" fill="none" stroke="#8fd2ff" stroke-width="2"/></svg>');
  }
  function native(action) {
    const work=nativeQueue.then(async()=>{
      modalBusy=true;
      try {return await action();} finally {modalBusy=false;}
    });
    nativeQueue=work.catch(()=>{});return work;
  }
  const remove=key=>key?api('/images/'+key,undefined,false,'DELETE').catch(()=>{}):Promise.resolve();
  function selection() {
    const {doc,layer}=selectedLayer('processSource');
    refreshBlendModes();
    const sourceKey=doc.id+':'+layer.id+':'+doc.activeHistoryState.id;
    const size=doc.bitsPerChannel===host.constants.BitsPerChannelType.EIGHT?8:doc.bitsPerChannel===host.constants.BitsPerChannelType.SIXTEEN?16:32;
    const info={docID:doc.id,layerID:layer.id,name:layer.name,width:doc.width,height:doc.height,
      size,components:doc.mode===host.constants.DocumentMode.RGB?4:2,sourceKey,starEncoding:host.starEncoding(doc,layer)};
    const options=settings(),key=sourceKey+':'+info.starEncoding+':'+JSON.stringify(options);
    return {doc,layer,info,options,key,enabled:Object.values(options).some(x=>x.enabled)};
  }
  function background() {
    if(value('processBackground')==null) return null;
    const selected=selectedLayer('processBackground');
    if(selected.layer.id===value('processSource')) throw new Error('背景与星点请选择不同图层。');
    return {...selected,key:selected.doc.activeHistoryState.id};
  }
  function compose() {
    if(paused || isBusy() || !desired || currentPage()!=='process') return Promise.resolve();
    const selected=desired,original=$('processOriginal').checked;
    const result=original || !selected.enabled?null:last?.sourceKey===selected.info.sourceKey?
      {...last.result,width:selected.info.width,height:selected.info.height,components:selected.info.components}:null;
    let backdrop;
    try {backdrop=background();} catch(e) {status(e.message,true);return Promise.resolve();}
    const blend=value('processBlend'),key=JSON.stringify([selected.info.sourceKey,result?.image,backdrop?.layer.id,backdrop?.key,blend]);
    if(key===compositionKey) return nativeQueue;
    compositionKey=key;
    const version=++compositionVersion;
    return native(async()=>{
      if(version!==compositionVersion || paused) return;
      try {
        previewState=await host.canvasStarPreview(previewState,result,meta?.sourceKey===selected.info.sourceKey?meta:selected.info,
          backdrop,blend,api,report,()=>version===compositionVersion && !paused);
      } catch(e) {
        if(version===compositionVersion) compositionKey=null;
        if(!e.stale && version===compositionVersion && !paused) status(e.message || String(e),true);
      }
    });
  }
  function cancel() {if(jobID) api('/jobs/'+jobID,undefined,false,'DELETE').catch(()=>{});}
  function schedule() {
    clearTimeout(timer);
    if(isUpdatingPickers() || paused || isBusy() || currentPage()!=='process') return;
    try {
      const next=value('processSource')==null?null:selection();
      if(next?.key!==desired?.key) {desired=next;failedKey=null;cancel();}
      else desired=next;
      compose();updateActions();
      if(desired && (desired.enabled && last?.key!==desired.key || !desired.enabled && (meta || last)))
        if(desired.key!==failedKey) timer=setTimeout(startWorker,180);
      if(!desired && (meta || last || previewState)) timer=setTimeout(startWorker,180);
    } catch(e) {status(e.message || String(e),true);}
  }
  function reset() {
    for(const [name,,,specs] of tools) {
      $(name+'Enabled').checked=false;
      for(const [key,,,,,defaultValue] of specs) for(const suffix of ['', '_range']) $('process_'+name+'_'+key+suffix).value=defaultValue;
    }
    curvePlot([0,1]);$('processOriginal').checked=false;schedule();
  }
  function expand(name) {
    for(const [other,title] of tools) {
      const opened=other===name;
      $(other+'Details').classList.toggle('expanded',opened);
      $(other+'Disclosure').setAttribute('aria-expanded',String(opened));
      $(other+'Disclosure').textContent=title+(opened?' ▴':' ▾');
    }
  }
  for(const name of ['curve','coma','reduction','glow','color']) {
    const [,title,hint,specs]=tools.find(t=>t[0]===name);
    const box=document.createElement('div');box.className='processTool';
    box.innerHTML='<div class="processToolHeader"><input type="checkbox" id="'+name+'Enabled" aria-label="启用'+title+'"><button id="'+name+'Disclosure" aria-expanded="false">'+title+' ▾</button></div><div id="'+name+'Details" class="processToolBody"><div class="hint">'+hint+'</div></div>';
    $('processTools').appendChild(box);
    const body=$(name+'Details');
    if(name==='curve') {const img=document.createElement('img');img.id='processCurve';body.appendChild(img);}
    for(const [key,label,min,max,step,defaultValue] of specs) {
      const id='process_'+name+'_'+key;
      const el=document.createElement('div');el.className='param';
      el.innerHTML='<div class="row"><label>'+label+'</label><input id="'+id+'" type="number" class="numeric" min="'+min+'" max="'+max+'" step="'+step+'" value="'+defaultValue+'"></div><input id="'+id+'_range" type="range" min="'+min+'" max="'+max+'" step="'+step+'" value="'+defaultValue+'">';
      body.appendChild(el);
      $(id).addEventListener('change',()=>{$(id+'_range').value=$(id).value;schedule();});
      $(id+'_range').addEventListener('input',()=>{$(id).value=$(id+'_range').value;schedule();});
    }
    $(name+'Disclosure').addEventListener('click',()=>{
      expand(body.classList.contains('expanded')?null:name);
    });
    $(name+'Enabled').addEventListener('change',()=>{
      if($(name+'Enabled').checked) expand(name);
      schedule();
    });
  }
  function updateActions(busy=false) {
    const selected=value('processSource')!=null;
    $('processExecute').disabled=busy || !selected;
    $('processOriginal').disabled=busy || !selected;
    $('processBlend').disabled=busy || desired?.info.starEncoding==='gray';
    if(previewState && !host.app.documents.some(d=>d.id===previewState.docID)) {previewState=null;compositionKey=null;}
  }
  async function clearImages() {
    await nativeQueue;
    await remove(last?.result.image);await remove(meta?.id);last=null;meta=null;
  }
  async function process(request,key) {
    const created=await api('/jobs',request);jobID=created.id;
    if(paused || desired?.key!==key) cancel();
    try {
      while(true) {
        const state=await api('/jobs/'+created.id);
        if(state.state==='done') return state.result;
        if(state.state==='canceled') return null;
        if(state.state==='error') throw new Error(state.error);
        if(!paused && desired) {report(state.progress);status(state.message || '正在更新全分辨率预览…');}
        await new Promise(resolve=>setTimeout(resolve,150));
      }
    } finally {jobID=null;}
  }
  function startWorker() {
    if(worker || paused || isBusy()) return;
    worker=render().catch(e=>{failedKey=runningKey;if(desired?.key===runningKey) status(e.message || String(e),true);}).finally(()=>{
      worker=null;
      if(!paused && currentPage()==='process' && desired?.enabled && last?.key!==desired.key && desired.key!==failedKey) timer=setTimeout(startWorker,180);
    });
  }
  async function render() {
    while(!paused && currentPage()==='process' && desired) {
      const target=desired;
      runningKey=target.key;
      if(!target.enabled) {await clearImages();return;}
      if(last?.key===target.key) return;
      await ensureService();
      if(paused || desired?.key!==target.key) continue;
      if(meta?.sourceKey!==target.info.sourceKey) {
        await clearImages();
        status('正在读取完整星点图层…');
        meta=await native(()=>host.core.executeAsModal(()=>host.upload(target.doc,target.layer,api,report),{commandName:'读取完整星点图层'}));
        meta.sourceKey=target.info.sourceKey;
      }
      if(paused || desired?.key!==target.key) continue;
      const result=await process({op:'processStars',image:meta.id,settings:target.options,preview:false,scale:1,starEncoding:target.info.starEncoding},target.key);
      if(!result) continue;
      if(paused || desired?.key!==target.key) {await remove(result.image);continue;}
      const previous=last;
      last={key:target.key,sourceKey:target.info.sourceKey,result};
      await compose();await remove(previous?.result.image);
      curvePlot(result.curve);status('全分辨率预览已更新。'+(result.reconstructedStars?' 重建 '+result.reconstructedStars+' 个星点。':''));
      return;
    }
    if(!desired) {
      await clearImages();
      await native(async()=>{
        if(desired || !previewState) return;
        const doc=host.app.documents.find(d=>d.id===previewState.docID);
        if(doc) await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭星点加工预览'});
        previewState=null;compositionKey=null;
      });
    }
  }
  for(const id of ['processSource','processBackground','processBlend']) $(id).addEventListener('change',schedule);
  for(const [button,picker] of [['processUseActive','processSource'],['processBackgroundUseActive','processBackground']])
    $(button).addEventListener('click',()=>{
      try {useActive(picker);schedule();} catch(e) {status(e.message,true);}
    });
  $('processOriginal').addEventListener('change',compose);
  $('processReset').addEventListener('click',reset);
  $('processExecute').addEventListener('click',()=>run(async()=>{
    const target=selection(),blend=value('processBlend');
    let output,result,temporary=false;
    try {
      if(target.enabled) {
        if(meta?.sourceKey!==target.info.sourceKey) {
          await clearImages();
          meta=await native(()=>host.core.executeAsModal(()=>host.upload(target.doc,target.layer,api,report),{commandName:'读取完整星点图层'}));
          meta.sourceKey=target.info.sourceKey;
        }
        result=last?.key===target.key?last.result:await job({op:'processStars',image:meta.id,settings:target.options,preview:false,scale:1,starEncoding:target.info.starEncoding});
        temporary=result!==last?.result;
      }
      const backdrop=background();
      output=await native(()=>host.transaction(target.doc,'星点加工',async context=>{
        const layer=result?await host.write(target.doc,result.image,meta,target.layer.name+'_processed',api,report,context):await target.layer.duplicate(target.doc);
        if(layer.allLocked) layer.allLocked=false;
        layer.name=target.layer.name+'_processed';layer.visible=true;
        host.setStarBlendMode(layer,blend,target.doc);
        if(backdrop) layer.move(backdrop.layer,host.constants.ElementPlacement.PLACEBEFORE);
        return layer;
      }));
      // Writing a separate output changes source history, but not input pixels.
      const revised=selection();
      if(meta) meta.sourceKey=revised.info.sourceKey;
      if(temporary) {await remove(last?.result.image);last={key:revised.key,sourceKey:revised.info.sourceKey,result};temporary=false;}
      else if(last) {last.key=revised.key;last.sourceKey=revised.info.sourceKey;}
      desired=revised;refresh();
      status('已创建 '+output.name+'，混合模式与预览一致。'+(result?.reconstructedStars?' 重建 '+result.reconstructedStars+' 个星点。':''));
    } finally {
      if(temporary) await remove(result?.image);
    }
  }));
  reset();updateActions();
  return {updateActions,previewDocumentID:()=>previewState?.docID,isModalBusy:()=>modalBusy,
    pageChanged(){if(currentPage()!=='process'){clearTimeout(timer);++compositionVersion;compositionKey=null;cancel();}else schedule();},
    sync(next,old){if(next?.id!==old?.id || next?.history!==old?.history) schedule();},
    async pause(){paused=true;clearTimeout(timer);++compositionVersion;compositionKey=null;cancel();await worker;await nativeQueue;},
    resume(){paused=false;schedule();}};
}
module.exports={setup};
