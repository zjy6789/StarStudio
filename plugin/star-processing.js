const host=require('./host.js');
const $=id=>document.getElementById(id);
const tools=[
  ['coma','拉长星点修整','调用 Siril 拟合并重建拉长星点；建议在线性星点层上使用。重建改变星形与光度，不是光学恢复或反卷积。默认关闭。',[
    ['strength','修复强度',0,1,.01,.5],['sigma','检测阈值 σ',.05,10,.05,2],['radius','搜索半径（原图像素）',3,50,1,8],['roundness','圆度上限（越小越只修复长星）',.1,.99,.01,.9]]],
  ['reduction','缩星','先调整缩星强度；默认保护暗星与亮星核心。半径按原图像素设置，请在 100% 视图检查小星点；照片尺寸不能代表星点大小。',[
    ['strength','缩星强度',0,1,.01,.35],['radius','收缩半径（原图像素）',.1,8,.1,1],['threshold','暗星保护阈值',0,1,.001,.01],['protect','高光保护起点',.01,1,.01,.8]]],
  ['curve','星点亮度','只调整所选星点，0 EV 为原亮度。高级曲线三个控制点对应输入亮度 25%、50%、75%，可单独保留暗星。',[
    ['exposure','星点亮度（EV）',-3,3,.05,0],['shadows','暗部输出',0,1,.01,.25],['midtones','中间调输出',0,1,.01,.5],['highlights','亮部输出',0,1,.01,.75]]],
  ['color','星点颜色','1 为原饱和度，默认保护亮星核心；只作用于 RGB 星点，不会恢复已经过曝丢失的颜色。',[
    ['saturation','星点颜色（饱和度）',0,2,.01,1],['protect','高光保护起点',.01,1,.01,.85]]],
  ['glow','辉光 / 柔焦','先调整强度与大小，高级选项控制哪些亮星发光。半径为原图像素，按实际星点尺度调整；这是默认关闭的风格效果。',[
    ['strength','发光强度',0,5,.05,1],['radius','光晕半径（原图像素）',.5,120,.5,12],['lower','发光亮度下限',0,1,.01,.2],['upper','发光亮度上限',0,1,.01,1],['softness','阈值过渡宽度',.001,.5,.001,.1],['spread','外晕比例',0,1,.01,.35]]]
];

function setup({run,api,job,status,report,selectedLayer,useActive,value,refresh,currentPage,
  refreshBlendModes=()=>{},starEncoding=(doc,layer)=>host.starEncoding(doc,layer),ensureService=async()=>{},isBusy=()=>false,isUpdatingPickers=()=>false}) {
  let meta=null,last=null,desired=null,timer=null,previewState=null,worker=null,jobID=null;
  let paused=false,modalBusy=false,compositionVersion=0,compositionKey=null,nativeQueue=Promise.resolve(),failedKey=null,runningKey=null;
  let displayed=null,compositionError=null,selectionError=null;
  const applied=[];
  function related(doc,source) {
    const parent=applied.find(record=>record.docID===doc.id && record.layerID===source.id);
    const origin=parent?.originID || source.id;
    return {origin,records:applied.filter(record=>record.docID===doc.id && record.originID===origin)};
  }
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
      size,components:doc.mode===host.constants.DocumentMode.RGB?4:2,sourceKey,starEncoding:starEncoding(doc,layer)};
    const options=settings(),key=sourceKey+':'+info.starEncoding+':'+JSON.stringify(options);
    return {doc,layer,info,options,key,enabled:Object.values(options).some(x=>x.enabled)};
  }
  function background() {
    if(value('processBackground')==null) return null;
    const selected=selectedLayer('processBackground');
    if(selected.layer.id===value('processSource')) throw new Error('背景与星点请选择不同图层。');
    return {...selected,key:selected.doc.activeHistoryState.id};
  }
  function previewHint() {
    const originalName=value('processBackground')==null?'原星点':'原合成';
    $('processCompareLabel').textContent='查看'+originalName;
    let message;
    if(selectionError) message='图层选择无效；'+(displayed?'当前仍为上次完成画面。':'尚未生成预览。')+selectionError;
    else if(!desired) message='选择星点后自动打开全分辨率预览。';
    else if(compositionError) message='预览更新失败；'+(displayed?'当前仍为上次完成画面。':'尚未生成预览。')+compositionError;
    else if(displayed?.sourceKey!==desired.info.sourceKey) message='正在切换来源；当前预览尚未显示所选图层。';
    else if(displayed.composition!==compositionKey) message='正在更新背景与混合；当前仍为上次完成画面。';
    else if($('processOriginal').checked) message='正在查看'+originalName+'：仅绕过星点加工，背景、混合与预览文档保持不变。此勾选只比较，不改变执行参数。';
    else if(!desired.enabled) message='未启用加工，当前显示'+originalName+'。';
    else if(displayed.key===desired.key) message='全分辨率预览已更新，与当前参数一致。';
    else message=(failedKey===desired.key?'当前参数计算失败；':'正在计算新参数；')+(displayed.key?'当前显示上次完成结果。':'当前显示'+originalName+'。');
    $('processPreviewHint').textContent=message;
  }
  function invalidateSelection(error) {
    selectionError=error.message || String(error);compositionError=null;
    ++compositionVersion;compositionKey=null;clearTimeout(timer);cancel();
    updateActions();previewHint();status(selectionError,true);
  }
  function settingsHint() {
    const options=settings(),enabled=[];
    if(options.curve.enabled) enabled.push('星点亮度 '+options.curve.exposure+' EV（含高级曲线）');
    if(options.reduction.enabled) enabled.push('缩星 '+options.reduction.strength+'，半径 '+options.reduction.radius+' 像素');
    if(options.color.enabled) enabled.push('星点颜色 '+options.color.saturation);
    if(options.glow.enabled) enabled.push('辉光 '+options.glow.strength+'，半径 '+options.glow.radius+' 像素');
    if(options.coma.enabled) enabled.push('拉长星点修整 '+options.coma.strength);
    $('processSettingsHint').textContent=enabled.length?'已启用：'+enabled.join('；')+'。':'未启用加工；展开卡片只查看参数。';
  }
  function compose() {
    if(paused || isBusy() || selectionError || !desired || currentPage()!=='process') return Promise.resolve();
    const selected=desired,original=$('processOriginal').checked;
    const result=original || !selected.enabled?null:last?.sourceKey===selected.info.sourceKey?
      {...last.result,width:selected.info.width,height:selected.info.height,components:selected.info.components}:null;
    let backdrop;
    try {backdrop=background();} catch(e) {invalidateSelection(e);return Promise.resolve();}
    const blend=value('processBlend'),key=JSON.stringify([selected.info.sourceKey,result?.image,backdrop?.layer.id,backdrop?.key,blend]);
    if(key===compositionKey) {previewHint();return nativeQueue;}
    compositionKey=key;compositionError=null;
    const version=++compositionVersion;
    const shownKey=result?last.key:null;
    previewHint();
    return native(async()=>{
      if(version!==compositionVersion || paused) return;
      try {
        previewState=await host.canvasStarPreview(previewState,result,meta?.sourceKey===selected.info.sourceKey?meta:selected.info,
          backdrop,blend,api,report,()=>version===compositionVersion && !paused);
        if(version===compositionVersion && !paused) {displayed={sourceKey:selected.info.sourceKey,key:shownKey,composition:key};previewHint();}
      } catch(e) {
        if(version===compositionVersion) compositionKey=null;
        if(!e.stale && version===compositionVersion && !paused) {compositionError=e.message || String(e);status(compositionError,true);previewHint();}
      }
    });
  }
  function cancel() {if(jobID) api('/jobs/'+jobID,undefined,false,'DELETE').catch(()=>{});}
  function schedule() {
    clearTimeout(timer);
    settingsHint();
    if(isUpdatingPickers() || paused || isBusy() || currentPage()!=='process') return;
    try {
      const next=value('processSource')==null?null:selection();
      if(next?.key!==desired?.key) {
        desired=next;failedKey=null;cancel();
        if(next?.enabled) status('参数已变化，正在准备全分辨率预览；当前画面仍为原合成或上次结果。');
      }
      else desired=next;
      if(desired) background();
      if(selectionError) failedKey=null;
      selectionError=null;
      compose();updateActions();previewHint();
      if(desired && (desired.enabled && last?.key!==desired.key || !desired.enabled && (meta || last)))
        if(desired.key!==failedKey) timer=setTimeout(startWorker,180);
      if(!desired && (meta || last || previewState)) timer=setTimeout(startWorker,180);
    } catch(e) {invalidateSelection(e);}
  }
  function defaults() {
    for(const [name,,,specs] of tools) {
      $(name+'Enabled').checked=false;
      for(const [key,,,,,defaultValue] of specs) for(const suffix of ['', '_range']) $('process_'+name+'_'+key+suffix).value=defaultValue;
    }
    curvePlot([0,1]);$('processOriginal').checked=false;
  }
  function reset() {defaults();schedule();}
  function preset(name) {
    defaults();
    $(name+'Enabled').checked=true;
    const amount=name==='reduction'?.25:.6;
    for(const suffix of ['', '_range']) $('process_'+name+'_strength'+suffix).value=amount;
    expand(name);schedule();
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
    const basic=document.createElement('div');
    const advanced=document.createElement('div');advanced.id=name+'Advanced';advanced.className='processAdvanced';
    const toggle=document.createElement('button');toggle.id=name+'AdvancedToggle';toggle.className='processAdvancedToggle';
    toggle.textContent='高级参数 ▾';toggle.setAttribute('aria-expanded','false');
    body.appendChild(basic);body.appendChild(toggle);body.appendChild(advanced);
    const primary={curve:['exposure'],coma:['strength'],reduction:['strength'],glow:['strength','radius'],color:['saturation']}[name];
    if(name==='curve') {const img=document.createElement('img');img.id='processCurve';advanced.appendChild(img);}
    for(const [key,label,min,max,step,defaultValue] of specs) {
      const id='process_'+name+'_'+key;
      const el=document.createElement('div');el.className='param';
      el.innerHTML='<div class="row"><label>'+label+'</label><input id="'+id+'" type="number" class="numeric" min="'+min+'" max="'+max+'" step="'+step+'" value="'+defaultValue+'"></div><input id="'+id+'_range" type="range" min="'+min+'" max="'+max+'" step="'+step+'" value="'+defaultValue+'">';
      (primary.includes(key)?basic:advanced).appendChild(el);
      $(id).addEventListener('change',()=>{$(id+'_range').value=$(id).value;schedule();});
      $(id+'_range').addEventListener('input',()=>{$(id).value=$(id+'_range').value;schedule();});
    }
    toggle.addEventListener('click',()=>{
      const opened=!advanced.classList.contains('expanded');
      advanced.classList.toggle('expanded',opened);toggle.setAttribute('aria-expanded',String(opened));
      toggle.textContent='高级参数'+(opened?' ▴':' ▾');
    });
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
    $('processExecute').disabled=busy || !selected || !!selectionError;
    $('processOriginal').disabled=busy || !selected || !!selectionError;
    $('processBlend').disabled=busy || desired?.info.starEncoding==='gray';
    if(previewState && !host.app.documents.some(d=>d.id===previewState.docID)) {previewState=null;compositionKey=null;displayed=null;}
  }
  async function clearImages() {
    await nativeQueue;
    await remove(last?.result.image);await remove(meta?.id);last=null;meta=null;
  }
  async function process(request,key) {
    const created=await api('/jobs',request);jobID=created.id;
    if(paused || selectionError || currentPage()!=='process' || desired?.key!==key) cancel();
    try {
      while(true) {
        const state=await api('/jobs/'+created.id);
        if(state.state==='done') return state.result;
        if(state.state==='canceled') return null;
        if(state.state==='error') throw new Error(state.error);
        if(!paused && !selectionError && currentPage()==='process' && desired) {report(state.progress);status(state.message || '正在更新全分辨率预览…');}
        await new Promise(resolve=>setTimeout(resolve,150));
      }
    } finally {jobID=null;}
  }
  function startWorker() {
    if(worker || paused || selectionError || isBusy()) return;
    worker=render().catch(e=>{failedKey=runningKey;if(!selectionError && currentPage()==='process' && desired?.key===runningKey) {status(e.message || String(e),true);previewHint();}}).finally(()=>{
      worker=null;
      if(!paused && !selectionError && currentPage()==='process' && desired?.enabled && last?.key!==desired.key && desired.key!==failedKey) timer=setTimeout(startWorker,180);
    });
  }
  async function render() {
    while(!paused && !selectionError && currentPage()==='process' && desired) {
      const target=desired;
      runningKey=target.key;
      if(!target.enabled) {await clearImages();return;}
      if(last?.key===target.key) return;
      await ensureService();
      if(paused || selectionError || currentPage()!=='process' || desired?.key!==target.key) continue;
      if(meta?.sourceKey!==target.info.sourceKey) {
        await clearImages();
        if(paused || selectionError || currentPage()!=='process' || desired?.key!==target.key) continue;
        status('正在读取完整星点图层…');
        meta=await native(()=>host.core.executeAsModal(()=>{
          if(paused || selectionError || currentPage()!=='process' || desired?.key!==target.key) return null;
          return host.upload(target.doc,target.layer,api,report);
        },{commandName:'读取完整星点图层'}));
        if(meta===null) continue;
        meta.sourceKey=target.info.sourceKey;
      }
      if(paused || selectionError || currentPage()!=='process' || desired?.key!==target.key) continue;
      const result=await process({op:'processStars',image:meta.id,settings:target.options,preview:false,scale:1,starEncoding:target.info.starEncoding},target.key);
      if(!result) continue;
      if(paused || selectionError || currentPage()!=='process' || desired?.key!==target.key) {await remove(result.image);continue;}
      const previous=last;
      last={key:target.key,sourceKey:target.info.sourceKey,result};
      await compose();await remove(previous?.result.image);
      if(desired?.key===target.key && !paused && !selectionError) {
        curvePlot(result.curve);
        if(displayed?.key===target.key && displayed.composition===compositionKey) status('全分辨率预览已更新。'+(result.reconstructedStars?' 重建 '+result.reconstructedStars+' 个星点。':''));
      }
      return;
    }
    if(!desired) {
      await clearImages();
      await native(async()=>{
        if(desired || !previewState) return;
        const doc=host.app.documents.find(d=>d.id===previewState.docID);
        if(doc) await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭星点加工预览'});
        previewState=null;compositionKey=null;displayed=null;previewHint();
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
  $('processNatural').addEventListener('click',()=>preset('reduction'));
  $('processSoft').addEventListener('click',()=>preset('glow'));
  $('processExecute').addEventListener('click',()=>run(async()=>{
    const target=selection(),blend=value('processBlend');
    background();
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
      const family=related(target.doc,target.layer);
      const composition=await native(()=>host.applyStarResult({doc:target.doc,source:target.layer,background:backdrop?.layer,
        blend,result,meta,previous:family.records.map(record=>record.rootID)},api,report));
      output=composition.layer;
      applied.push({docID:target.doc.id,originID:family.origin,layerID:output.id,rootID:composition.root.id,
        encoding:target.info.starEncoding,mode:blend,depth:target.doc.bitsPerChannel});
      // Writing a separate output changes source history, but not input pixels.
      const revised=selection();
      if(meta) meta.sourceKey=revised.info.sourceKey;
      if(temporary) {await remove(last?.result.image);last={key:revised.key,sourceKey:revised.info.sourceKey,result};temporary=false;}
      else if(last) {last.key=revised.key;last.sourceKey=revised.info.sourceKey;}
      desired=revised;refresh();
      status('已创建 '+output.name+(backdrop?' 的独立合成组':' 星点层')+'，混合模式与预览一致。已隐藏输入星点和关联的旧结果；其他图层保留原可见性。'+(result?.reconstructedStars?' 重建 '+result.reconstructedStars+' 个星点。':''));
    } finally {
      if(temporary) await remove(result?.image);
    }
  }));
  reset();updateActions();
  return {updateActions,previewDocumentID:()=>previewState?.docID,isModalBusy:()=>modalBusy,
    relationFor(doc,layer) {
      const record=applied.find(item=>item.docID===doc.id && item.layerID===layer.id && item.depth===doc.bitsPerChannel);
      return record?{encoding:record.encoding,mode:record.mode}:null;
    },
    async viewBackground(doc,backdrop,stars) {
      const family=related(doc,stars);
      const root=await native(()=>host.transaction(doc,'查看无星背景',async()=>{
        const copy=await backdrop.duplicate(doc);
        if(copy.allLocked) copy.allLocked=false;
        copy.name='无星背景 · 查看副本';copy.visible=true;copy.blendMode=host.constants.BlendMode.NORMAL;
        await host.archiveLayer(doc,stars);await host.archiveLayer(doc,backdrop);
        for(const record of family.records) {const old=host.findLayer(doc,record.rootID);if(old) await host.archiveLayer(doc,old);}
        if(copy.id!==doc.layers[0].id) copy.move(doc.layers[0],host.constants.ElementPlacement.PLACEBEFORE);
        host.app.activeDocument=doc;return copy;
      }));
      applied.push({docID:doc.id,originID:family.origin,rootID:root.id});
    },
    pageChanged(){if(currentPage()!=='process'){clearTimeout(timer);++compositionVersion;compositionKey=null;cancel();}else schedule();},
    sync(next,old){if(next?.id!==old?.id || next?.history!==old?.history) schedule();},
    async pause(){paused=true;clearTimeout(timer);++compositionVersion;compositionKey=null;cancel();await worker;await nativeQueue;},
    resume(){paused=false;schedule();}};
}
module.exports={setup};
