const host=require('./host.js');
const fs=require('uxp').storage.localFileSystem;
const $=id=>document.getElementById(id);
const extensions=['arw','cr2','cr3','nef','nrw','raf','orf','rw2','pef','srw','dng','raw','tif','tiff','png','jpg','jpeg'];

function setup({run,api,job,status,onSaved=()=>{},onLayeredOpened=()=>{}}) {
  let selection=null, strokes=[], drawing=null, activeJob=null, quality=null;
  let originalPaths=[],failedFile=null,reportResult=null;
  const calibration={dark:[],flat:[],bias:[],darkflat:[]};
  const modes=['mean','median','sigma','maximum','minimum'], formats=['dng','tiff16','tiff32','fits16','fits32'];
  const intents=[['stackMeanIntent',0],['stackRejectIntent',2]], outputs=[['stackRawGoal',0],['stackPluginGoal',2],['stackAstroGoal',4]];
  for(const id of ['stackMode','stackScene']) $(id).selectedIndex=0;
  $('stackFormat').selectedIndex=0;
  function updateActions(busy=false) {
    $('stackExecute').disabled=busy || !selection;
    $('stackCancel').disabled=!activeJob;
    $('stackCoverageSave').disabled=busy || !quality;
    const cropReady=quality?.crop && quality.sourceSHA256 && reportResult?.recordSHA256;
    $('stackCoverageView').disabled=busy || !reportResult?.compositionPreview;
    $('stackCropConfirmed').disabled=busy || !cropReady;
    $('stackCropSave').disabled=busy || !cropReady || !$('stackCropConfirmed').checked;
    $('stackExcludeFailed').disabled=busy || !failedFile || !selection || selection.paths.length<3;
    $('stackRestoreFrames').disabled=busy || !selection || originalPaths.length===selection.paths.length;
    $('stackReferenceChoice').disabled=busy || !selection;
    for(const id of ['stackFiles','stackFolder','stackMode','stackAdvancedOptions','stackScene','stackFormat','stackLinearTiff','stackReferenceGround',...intents.map(x=>x[0]),...outputs.map(x=>x[0])]) $(id).disabled=busy;
    for(const kind of Object.keys(calibration)) {
      const prefix='stack'+kind[0].toUpperCase()+kind.slice(1);
      for(const action of ['Files','Folder','Clear']) $(prefix+action).disabled=busy || (action==='Clear' && !calibration[kind].length);
    }
  }
  function records(rows) {
    return (rows || []).map(row=>row.file.split(/[\\/]/).pop()+
      ' · '+row.matches+' 匹配 · RMS '+row.rms.toFixed(3)+' 像素').join('\n');
  }
  function clearFailure() {failedFile=null;$('stackFailedHint').textContent='';}
  function clearQuality() {
    quality=null;reportResult=null;
    $('stackCropConfirmed').checked=false;$('stackCropHint').textContent='';$('stackCropSaved').textContent='';
    $('stackQualitySummary').textContent='堆栈完成后查看逐帧配准与覆盖情况；不会自动丢帧或裁剪。';
    $('stackQualityRows').textContent='';$('stackCoverageHint').textContent='';
    $('stackCoveragePreview').removeAttribute('src');updateActions(true);
  }
  function showQuality(result) {
    reportResult=result;
    quality=result.quality || null;
    $('stackQualitySummary').textContent='基准：'+result.reference+'；基准帧RMS=0只表示自身对齐，不代表最佳质量。';
    $('stackQualityRows').textContent=records(result.alignment);
    if(!quality) {
      $('stackCoverageHint').textContent='当前组件没有返回完整覆盖报告；已保存的堆栈不受影响，请更新后台组件。';return;
    }
    $('stackCoverageView').selectedIndex=result.compositionPreview?1:0;
    $('stackCoveragePreview').src=result.compositionPreview || quality.preview;
    const crop=quality.crop;
    $('stackCoverageHint').textContent='几何覆盖 '+quality.minimum+'–'+quality.maximum+' / '+quality.frames+' 帧；全部帧共同覆盖 '+
      (100*quality.fullPixels/quality.totalPixels).toFixed(1)+'%。覆盖图亮度表示覆盖比例，青框为共同覆盖裁剪建议。'+
      (crop?'范围 ['+crop.left+', '+crop.top+') 至 ['+crop.right+', '+crop.bottom+')，'+(crop.right-crop.left)+' × '+(crop.bottom-crop.top)+' 像素；尚未裁剪。':'没有全部帧共同覆盖的矩形，不建议自动裁剪。')+
      ' 此计数在Sigma剔除之前累计，不是信噪比或剔除后的样本数。母版保持完整尺寸。';
    $('stackCropHint').textContent=!crop?'没有全部帧共同覆盖的矩形，不能保存建议裁剪副本。':quality.sourceSHA256 && result.recordSHA256
      ? '检查构图后可另存同格式裁剪副本；逐像素复制，原母版保留。16位母版已有的量化不会恢复。'
      : '此报告缺少母版来源校验，不能直接裁剪；请更新组件后重新堆栈。';
  }
  $('stackCoverageView').addEventListener('change',()=>{
    if(quality)$('stackCoveragePreview').src=$('stackCoverageView').selectedIndex===1?reportResult.compositionPreview || quality.preview:quality.preview;
  });
  $('stackCropConfirmed').addEventListener('change',()=>updateActions());
  $('stackCropSave').addEventListener('click',()=>run(async()=>{
    if(!quality?.crop || !quality.sourceSHA256 || !reportResult?.recordSHA256)throw new Error('请先生成带来源校验的覆盖报告。');
    if(!$('stackCropConfirmed').checked)throw new Error('请先查看并确认裁剪范围。');
    const extension=reportResult.output.split('.').pop().toLowerCase();
    const file=await fs.getFileForSaving('StarStudio_stack_crop.'+extension,{types:[extension]});if(!file)return;
    let result;
    try {
      result=await job({op:'stackCrop',source:reportResult.output,output:file.nativePath,confirmed:true,crop:quality.crop,
        sourceSHA256:quality.sourceSHA256,recordSHA256:reportResult.recordSHA256},id=>{activeJob=id;updateActions(true);});
    } finally {activeJob=null;updateActions(true);}
    onSaved(file,result.format);$('stackCropConfirmed').checked=false;
    $('stackCropSaved').textContent='已保存 '+result.shape[1]+' × '+result.shape[0]+' 裁剪副本：'+file.nativePath+'。完整母版和原报告保留。';
    status($('stackCropSaved').textContent);
  }));
  $('stackQualityOptions').addEventListener('click',()=>{
    $('stackQualitySettings').classList.toggle('expanded');
    $('stackQualityOptions').textContent='配准与覆盖报告 '+($('stackQualitySettings').classList.contains('expanded')?'▴':'▾');
  });
  $('stackCoverageSave').addEventListener('click',()=>run(async()=>{
    if(!quality)throw new Error('请先完成堆栈并生成覆盖报告。');
    const file=await fs.getFileForSaving('StarStudio_coverage.png',{types:['png']});if(!file)return;
    const bytes=Uint8Array.from(atob(quality.png.split(',')[1]),c=>c.charCodeAt(0));
    await file.write(bytes.buffer,{format:require('uxp').storage.formats.binary});
    status('已导出完整16位覆盖计数图（每个像素为覆盖帧数）：'+file.nativePath+'；照片母版未修改。');
  }));
  function calibrationHint() {
    const count=Object.values(calibration).reduce((n,paths)=>n+paths.length,0);
    $('stackCalibrationOptions').textContent='校准场（'+(count?count+' 张':'可选')+'） '+($('stackCalibrationSettings').classList.contains('expanded')?'▴':'▾');
    const notes=[];
    if(calibration.darkflat.length && !calibration.flat.length) notes.push('平暗场需同时选择平场。');
    if(calibration.flat.length && !calibration.bias.length && !calibration.darkflat.length) notes.push('未选偏置/平暗场：RAW 使用自带黑电平；线性 TIFF 需确认已去黑电平。');
    if(calibration.dark.length) notes.push('暗场不自动缩放，请匹配亮场曝光、ISO/增益和温度。');
    $('stackCalibrationHint').textContent=notes.join(' ') || '按需选择，未选校准场时使用原有堆栈流程。主校准场在处理时合成，不会打开到 Photoshop。';
  }
  $('stackCalibrationOptions').addEventListener('click',()=>{
    $('stackCalibrationSettings').classList.toggle('expanded');calibrationHint();
  });
  for(const kind of Object.keys(calibration)) {
    const prefix='stack'+kind[0].toUpperCase()+kind.slice(1);
    function showSelection() {
      $(prefix+'Summary').textContent=calibration[kind].length?calibration[kind].length+' 张':'未使用';
      $(prefix+'Summary').title=calibration[kind].map(p=>p.split(/[\\/]/).pop()).join('\n');
      calibrationHint();
    }
    function selectCalibration(entries) {
      const paths=entries.filter(e=>e.isFile && extensions.includes(e.name.split('.').pop().toLowerCase())).map(e=>e.nativePath);
      if(!paths.length) throw new Error('没有支持的校准文件；文件夹只读取当前层级。');
      calibration[kind]=paths;showSelection();
      status('已选择 '+paths.length+' 张校准场；执行堆栈时合成主校准场。');
    }
    $(prefix+'Files').addEventListener('click',()=>run(async()=>{
      const entries=await fs.getFileForOpening({allowMultiple:true,types:extensions});
      if(entries?.length) selectCalibration(entries);
    }));
    $(prefix+'Folder').addEventListener('click',()=>run(async()=>{
      const folder=await fs.getFolder();
      if(folder) selectCalibration(await folder.getEntries());
    }));
    $(prefix+'Clear').addEventListener('click',()=>{calibration[kind]=[];showSelection();updateActions();});
  }
  function formatHint() {
    const selected=$('stackFormat').selectedIndex;
    for(const [id,index] of outputs){$(id).classList.toggle('selected',selected===index);$(id).setAttribute('aria-pressed',String(selected===index));}
    const hints=[
      '实际输出：32 位线性浮点 DNG（已去马赛克）。保留母版；Camera Raw 打开后的阶段和位深由显影设置决定。',
      '实际输出：16 位 TIFF（高级格式）。会量化并将负值截为 0；超范围高光统一缩放。保留完整校准浮点结果请选 DNG 或 32 位格式。',
      '实际输出：32 位线性浮点 TIFF 母版，保留负值和超范围高光，带线性 ProPhoto RGB ICC。尚未拉伸；继续插件流程时先在「母版准备」创建独立后期副本。',
      '实际输出：16 位 FITS（高级格式），BSCALE/BZERO保留正负范围但仍量化；Siril 1.4.2不能完整读取此缩放，请选32位FITS。PS打开未量化的临时32位TIFF。',
      '实际输出：32 位浮点 FITS 科学母版，保留负值、超范围高光及色彩/校准元数据。仍未拉伸；PS通过临时32位TIFF打开结果，后续编辑另存副本，勿覆盖母版。'
    ];
    $('stackFormatHint').textContent=hints[selected];
  }
  $('stackFormat').addEventListener('change',formatHint);
  for(const [id,index] of outputs)$(id).addEventListener('click',()=>{$('stackFormat').selectedIndex=index;formatHint();});
  $('stackAdvancedOptions').addEventListener('click',()=>{
    $('stackAdvancedSettings').classList.toggle('expanded');
    $('stackAdvancedOptions').textContent='高级模式与格式 '+($('stackAdvancedSettings').classList.contains('expanded')?'▴':'▾');
  });
  $('stackReferenceGround').addEventListener('change',()=>{
    $('stackReferenceGroundHint').textContent=$('stackReferenceGround').checked
      ? '执行时选择结果文件夹。保留所选主格式，另存32位天空/参考TIFF；PS打开两层，单帧参考地景默认隐藏。显示后用蒙版融合，参考层没有多帧降噪。'
      : '可选保留中间单帧供PS蒙版融合；参考地景没有多帧降噪，也不会自动融合地平线。';
  });
  function cacheHint() {
    const disk=$('stackMode').selectedIndex===1 || $('stackMode').selectedIndex===2;
    $('stackCache').textContent=selection?(disk?'此模式需要约 '+selection.cacheGB+' GB 磁盘缓存；内存按块使用。':'逐张累积；无需保存全部对齐帧。'):'';
  }
  function modeHint() {
    const selected=$('stackMode').selectedIndex;
    for(const [id,index] of intents){$(id).classList.toggle('selected',selected===index);$(id).setAttribute('aria-pressed',String(selected===index));}
    $('stackModeHint').textContent=[
      '实际模式：均值。逐张累积，用于普通降噪，不自动排除偶发亮线。',
      '当前高级模式：中位数。逐像素取中位数，使用磁盘缓存；可改回上方普通降噪。',
      '实际模式：Sigma 裁剪均值。可能同时排除飞机、卫星和想保留的流星；效果依赖帧数与内容，少量素材优先均值，不替你决定拍摄目标或静默丢帧。',
      '当前高级模式：最大值。仍先对齐星点，不是星轨合成；可改回上方普通降噪。',
      '当前高级模式：最小值。逐像素取最小值，用于特殊目标；普通降噪优先均值。'
    ][selected];
    cacheHint();
  }
  for(const [id,index] of intents)$(id).addEventListener('click',()=>{$('stackMode').selectedIndex=index;modeHint();});
  function overlay() {
    if(!selection) {$('stackMask').removeAttribute('src');return;}
    const w=selection.width,h=selection.height;
    const paths=strokes.map(s=>'<polyline points="'+s.points.map(p=>(p[0]*w).toFixed(1)+','+(p[1]*h).toFixed(1)).join(' ')+'" stroke-width="'+(s.radius*2*Math.max(w,h))+'"/>').join('');
    const dots=strokes.map(s=>s.points.length===1?'<circle cx="'+s.points[0][0]*w+'" cy="'+s.points[0][1]*h+'" r="'+s.radius*Math.max(w,h)+'" fill="#ff574b"/>':'').join('');
    $('stackMask').src='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="'+Math.round(1280*h/w)+'" viewBox="0 0 '+w+' '+h+'"><g opacity=".45" stroke="#ff574b" fill="none" stroke-linecap="round" stroke-linejoin="round">'+paths+dots+'</g></svg>');
  }
  async function inspectSelection(paths,reference,reset=false) {
    const next=await job({op:'stackInspect',paths,...(reference?{reference}:{})});
    if(reference && next.paths[next.reference]!==reference)throw new Error('后台未采用指定基准；请更新处理组件后重试，原输入保持不变。');
    const previous=selection?.paths[selection.reference];
    selection=next;
    if(reset)originalPaths=selection.paths.slice();
    if(reset || previous!==selection.paths[selection.reference]){strokes=[];drawing=null;}
    clearQuality();
    clearFailure();overlay();
    $('stackReference').src=selection.preview;
    $('stackSummary').textContent=selection.paths.length+' 张 · '+selection.width+' × '+selection.height+' · 基准：第 '+(selection.reference+1)+' 张 '+selection.name;
    $('stackNames').textContent=selection.paths.map(p=>p.split(/[\\/]/).pop()).join('  ·  ');
    const menu=$('stackReferenceChoice').querySelector('sp-menu');menu.innerHTML='';
    for(const path of selection.paths){const item=document.createElement('sp-menu-item');item.textContent=path.split(/[\\/]/).pop();menu.appendChild(item);}
    $('stackReferenceChoice').selectedIndex=selection.reference;
    const excluded=originalPaths.filter(path=>!selection.paths.includes(path));
    $('stackExcludedHint').textContent=excluded.length?'已排除 '+excluded.length+' 张：'+excluded.map(p=>p.split(/[\\/]/).pop()).join('、')+'。原文件保留，可撤回。':'';
    cacheHint();updateActions();
  }
  async function select(entries) {
    const paths=entries.filter(e=>e.isFile && extensions.includes(e.name.split('.').pop().toLowerCase())).map(e=>e.nativePath);
    if(paths.length<2) throw new Error('请选择至少两张支持的照片；文件夹只读取当前层级。');
    await inspectSelection(paths,undefined,true);
    formatHint();
    status('已读取中间基准帧。按堆栈目的和下一步选择后执行；已选模式与格式保留。');
  }
  $('stackReferenceChoice').addEventListener('change',()=>{
    if(!selection || $('stackReferenceChoice').selectedIndex===selection.reference)return;
    const reference=selection.paths[$('stackReferenceChoice').selectedIndex];
    if(!reference)return;
    return run(async()=>{
      try {await inspectSelection(selection.paths,reference);status('已更换基准，旧画笔已清除。');}
      finally {$('stackReferenceChoice').selectedIndex=selection.reference;}
    });
  });
  $('stackExcludeFailed').addEventListener('click',()=>run(async()=>{
    if(!failedFile || !selection || !selection.paths.includes(failedFile))throw new Error('没有本组可排除的失败帧。');
    if(selection.paths.length<3)throw new Error('至少需要保留两张素材，不能继续排除；可撤回排除或重新选择素材。');
    const paths=selection.paths.filter(path=>path!==failedFile),reference=selection.paths[selection.reference];
    await inspectSelection(paths,paths.includes(reference)?reference:undefined);
    status('已显式排除失败帧；原文件保留。请检查基准和画笔后重新执行堆栈。');
  }));
  $('stackRestoreFrames').addEventListener('click',()=>run(async()=>{
    if(!selection || originalPaths.length===selection.paths.length)return;
    await inspectSelection(originalPaths,selection.paths[selection.reference]);
    status('已撤回全部排除；原始文件组恢复，请重新执行堆栈。');
  }));
  $('stackFiles').addEventListener('click',()=>run(async()=>{
    const entries=await fs.getFileForOpening({allowMultiple:true,types:extensions});
    if(entries?.length) await select(entries);
  }));
  $('stackFolder').addEventListener('click',()=>run(async()=>{
    const folder=await fs.getFolder();
    if(folder) await select(await folder.getEntries());
  }));
  $('stackMode').addEventListener('change',modeHint);
  $('stackClearMask').addEventListener('click',()=>{strokes=[];drawing=null;overlay();});
  function position(event) {
    const rect=$('stackMask').getBoundingClientRect(), scale=Math.min(rect.width/selection.width,rect.height/selection.height);
    const width=selection.width*scale,height=selection.height*scale;
    return [(event.clientX-rect.left-(rect.width-width)/2)/width,(event.clientY-rect.top-(rect.height-height)/2)/height];
  }
  $('stackMask').addEventListener('mousedown',event=>{
    if(!selection || !$('stackPaint').checked || activeJob) return;
    const p=position(event);
    if(p.some(v=>v<0 || v>1)) return;
    const rect=$('stackMask').getBoundingClientRect();
    const scale=Math.min(rect.width/selection.width,rect.height/selection.height);
    drawing={radius:Number($('stackBrush').value)/2/(scale*Math.max(selection.width,selection.height)),points:[p]};
    strokes.push(drawing);overlay();event.preventDefault();
  });
  $('stackMask').addEventListener('mousemove',event=>{
    if(!drawing) return;
    const p=position(event).map(v=>Math.min(1,Math.max(0,v))),last=drawing.points[drawing.points.length-1];
    if(Math.hypot(p[0]-last[0],p[1]-last[1])<.002) return;
    drawing.points.push(p);overlay();
  });
  document.addEventListener('mouseup',()=>{drawing=null;});
  $('stackMask').addEventListener('mouseleave',()=>{drawing=null;});
  $('stackCancel').addEventListener('click',()=>{
    if(activeJob) api('/jobs/'+activeJob,undefined,false,'DELETE').then(()=>status('正在取消，完成当前读写后停止…')).catch(e=>status(e.message,true));
  });
  $('stackExecute').addEventListener('click',()=>run(async()=>{
    if(!selection) throw new Error('请先选择照片。');
    if(calibration.darkflat.length && !calibration.flat.length) throw new Error('平暗场用于校准平场；请选择平场或清除平暗场。');
    const format=formats[$('stackFormat').selectedIndex],extension=format==='dng'?'dng':format.startsWith('fits')?'fit':'tif';
    const layered=$('stackReferenceGround').checked;
    let folder,file,opening,reference,result;
    try {
    if(layered) {
      status('选择结果文件夹，将创建独立子目录并保留主文件及32位分层素材。');
      const parent=await fs.getFolder();if(!parent)return;
      folder=await parent.createFolder('StarStudio_stack_'+Date.now());
      file=await folder.createFile('StarStudio_stack.'+extension,{overwrite:false});
      opening=format==='tiff32'?file:await folder.createFile('StarStudio_sky_PS.tif',{overwrite:false});
      reference=await folder.createFile('StarStudio_reference_ground.tif',{overwrite:false});
    } else {
      file=await fs.getFileForSaving('StarStudio_stack.'+extension,{types:[extension]});
      if(!file)return;opening=file;
    }
    if(format.startsWith('fits') && !layered) {
      const temporary=await fs.getTemporaryFolder();
      opening=await temporary.createFile('StarStudio_stack_'+Date.now()+'.tif',{overwrite:false});
    }
      clearQuality();
      clearFailure();
      result=await job({op:'stack',paths:selection.paths,reference:selection.paths[selection.reference],mode:modes[$('stackMode').selectedIndex],qualityReport:true,
        landscape:$('stackScene').selectedIndex===1,mask:strokes,format,output:file.nativePath,
        calibration:{...calibration,linearTiff:$('stackLinearTiff').checked},
        photoshopOutput:opening.nativePath,...(layered?{referenceGround:true}:{})},id=>{activeJob=id;updateActions(true);});
    } catch(error) {
      if(error.failedFile && selection.paths.includes(error.failedFile)) {
        failedFile=error.failedFile;
        $('stackFailedHint').textContent='失败：'+failedFile.split(/[\\/]/).pop()+'。未自动丢帧；可更换基准或显式排除后重试。'+(selection.paths.length<3?' 当前仅剩两张，不能继续排除。':'');
        $('stackQualitySummary').textContent='本次堆栈未完成。以下仅是失败前已完成的配准记录，不是堆栈结果。';
        $('stackQualityRows').textContent=records(error.alignment);
      }
      if(folder) {
        let retained=true;
        try {if(!(await folder.getEntries()).length){await folder.delete();retained=false;}}catch(e){console.error(e);}
        if(retained)throw new Error(error.message+'；请检查已保留的本次目录：'+folder.nativePath);
      }
      throw error;
    } finally {activeJob=null;updateActions(true);}
    showQuality(result);
    if(layered && (!result.layers || result.layers.depth!==32 || result.layers.referenceResampled!==false))
      throw new Error('主文件可能已保存于 '+folder.nativePath+'；分层输出记录不完整，请重新打开面板并确认使用新版后台组件。');
    onSaved(layered?opening:file,layered?'tiff32':format);
    status('堆栈已保存，正在 Photoshop 中打开…');
    if(layered) {
      let opened;
      try {opened=await host.openStackLayers(opening,reference,result);}
      catch(error){throw new Error('堆栈与分层素材已保存于 '+folder.nativePath+'；PS分层打开未完成：'+error.message);}
      try {onLayeredOpened(opened.doc);}
      catch(error){throw new Error('分层文档已创建，面板状态更新未完成；文件保留于 '+folder.nativePath+'：'+error.message);}
      status('已保存 '+result.frames+' 帧堆栈与32位分层素材：'+folder.nativePath+'。\nPS已打开天空与隐藏的单帧参考地景。显示参考层并添加蒙版融合；参考层没有多帧降噪。请另存PSD以保留图层。'+(opened.cleanupWarning?'\n'+opened.cleanupWarning:'')+(result.calibration?.warnings?.length?'\n校准提示：'+result.calibration.warnings.join('\n'):''));
      return;
    }
    await host.core.executeAsModal(async()=>{
      const response=await require('photoshop').action.batchPlay([{_obj:'open',null:{_path:fs.createSessionToken(opening),_kind:'local'},_options:{dialogOptions:'dontDisplay'}}],{});
      if(response[0]?._obj==='error') throw new Error('堆栈已保存，但 Photoshop 打开失败：'+response[0].message);
    },{commandName:'打开 Star Studio 堆栈结果'});
    status('已保存并打开 '+result.frames+' 帧堆栈 · '+result.seconds+' 秒。'+(format.startsWith('fits')?'\nFITS 已保存；Photoshop 通过临时 32 位 TIFF 打开完整浮点结果，后续编辑请另存 PSD/TIFF。':'')+(result.encoding.scale!==1?'\n16 位输出缩放比例：'+result.encoding.scale.toFixed(5)+'；见同名 JSON 记录。':'')+(result.encoding.clipped?'\n16 位 TIFF 将 '+result.encoding.clipped+' 个负通道值截为 0；保留完整浮点数据请使用 DNG 或 32 位格式。':'')+(result.calibration?.warnings?.length?'\n校准提示：'+result.calibration.warnings.join('\n'):'')+(result.encoding.quantizationStep?'\n16 位 FITS 量化步长：'+result.encoding.quantizationStep.toExponential(4)+'。':''));
  }));
  calibrationHint();modeHint();formatHint();updateActions();
  return {updateActions};
}
module.exports={setup};
