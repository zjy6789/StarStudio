const host=require('./host.js');
const fs=require('uxp').storage.localFileSystem;
const $=id=>document.getElementById(id);
const extensions=['arw','cr2','cr3','nef','nrw','raf','orf','rw2','pef','srw','dng','raw','tif','tiff','png','jpg','jpeg'];

function setup({run,api,job,status}) {
  let selection=null, strokes=[], drawing=null, activeJob=null;
  const calibration={dark:[],flat:[],bias:[],darkflat:[]};
  const modes=['mean','median','sigma','maximum','minimum'], formats=['dng','tiff16','tiff32','fits16','fits32'];
  for(const id of ['stackMode','stackScene']) $(id).selectedIndex=0;
  $('stackFormat').selectedIndex=0;
  function updateActions(busy=false) {
    $('stackExecute').disabled=busy || !selection;
    $('stackCancel').disabled=!activeJob;
    for(const id of ['stackFiles','stackFolder','stackMode','stackScene','stackFormat','stackLinearTiff']) $(id).disabled=busy;
    for(const kind of Object.keys(calibration)) {
      const prefix='stack'+kind[0].toUpperCase()+kind.slice(1);
      for(const action of ['Files','Folder','Clear']) $(prefix+action).disabled=busy || (action==='Clear' && !calibration[kind].length);
    }
  }
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
    const hints=[
      'DNG 保留 32 位浮点；Photoshop 打开位深由 Camera Raw 设置决定。',
      '16 位 TIFF 会量化并将负值截为 0；超范围高光统一缩放。保留完整校准浮点结果请选 DNG 或 32 位格式。',
      '32 位 TIFF 保留负值及超范围高光，带线性 ProPhoto RGB ICC，可直接在 Photoshop 打开。',
      '16 位 FITS 以 BSCALE/BZERO 保留正负范围，仍有量化；Siril 1.4.2 不能完整读取此缩放，需用 Siril 时请选择 32 位 FITS。Photoshop 打开未量化的临时 32 位 TIFF。',
      '32 位 FITS 保留负值、超范围高光及色彩/校准元数据。Photoshop 通过临时 32 位 TIFF 打开结果。'
    ];
    $('stackFormatHint').textContent=hints[$('stackFormat').selectedIndex];
  }
  $('stackFormat').addEventListener('change',formatHint);
  function cacheHint() {
    const disk=$('stackMode').selectedIndex===1 || $('stackMode').selectedIndex===2;
    $('stackCache').textContent=selection?(disk?'此模式需要约 '+selection.cacheGB+' GB 磁盘缓存；内存按块使用。':'逐张累积；无需保存全部对齐帧。'):'';
  }
  function overlay() {
    if(!selection) {$('stackMask').removeAttribute('src');return;}
    const w=selection.width,h=selection.height;
    const paths=strokes.map(s=>'<polyline points="'+s.points.map(p=>(p[0]*w).toFixed(1)+','+(p[1]*h).toFixed(1)).join(' ')+'" stroke-width="'+(s.radius*2*Math.max(w,h))+'"/>').join('');
    const dots=strokes.map(s=>s.points.length===1?'<circle cx="'+s.points[0][0]*w+'" cy="'+s.points[0][1]*h+'" r="'+s.radius*Math.max(w,h)+'" fill="#ff574b"/>':'').join('');
    $('stackMask').src='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="'+Math.round(1280*h/w)+'" viewBox="0 0 '+w+' '+h+'"><g opacity=".45" stroke="#ff574b" fill="none" stroke-linecap="round" stroke-linejoin="round">'+paths+dots+'</g></svg>');
  }
  async function select(entries) {
    const paths=entries.filter(e=>e.isFile && extensions.includes(e.name.split('.').pop().toLowerCase())).map(e=>e.nativePath);
    if(paths.length<2) throw new Error('请选择至少两张支持的照片；文件夹只读取当前层级。');
    selection=await job({op:'stackInspect',paths});
    strokes=[];overlay();
    $('stackReference').src=selection.preview;
    $('stackSummary').textContent=selection.paths.length+' 张 · '+selection.width+' × '+selection.height+' · 基准：第 '+(selection.reference+1)+' 张 '+selection.name;
    $('stackNames').textContent=selection.paths.map(p=>p.split(/[\\/]/).pop()).join('  ·  ');
    $('stackFormat').selectedIndex=0;formatHint();
    cacheHint();updateActions();
    status('已读取中间基准帧。选择模式后执行堆栈。');
  }
  $('stackFiles').addEventListener('click',()=>run(async()=>{
    const entries=await fs.getFileForOpening({allowMultiple:true,types:extensions});
    if(entries?.length) await select(entries);
  }));
  $('stackFolder').addEventListener('click',()=>run(async()=>{
    const folder=await fs.getFolder();
    if(folder) await select(await folder.getEntries());
  }));
  $('stackMode').addEventListener('change',cacheHint);
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
    if(activeJob) api('/jobs/'+activeJob,undefined,false,'DELETE').then(()=>status('正在取消，完成当前解码后停止…')).catch(e=>status(e.message,true));
  });
  $('stackExecute').addEventListener('click',()=>run(async()=>{
    if(!selection) throw new Error('请先选择照片。');
    if(calibration.darkflat.length && !calibration.flat.length) throw new Error('平暗场用于校准平场；请选择平场或清除平暗场。');
    const format=formats[$('stackFormat').selectedIndex],extension=format==='dng'?'dng':format.startsWith('fits')?'fit':'tif';
    const file=await fs.getFileForSaving('StarStudio_stack.'+extension,{types:[extension]});
    if(!file) return;
    let opening=file;
    if(format.startsWith('fits')) {
      const temporary=await fs.getTemporaryFolder();
      opening=await temporary.createFile('StarStudio_stack_'+Date.now()+'.tif',{overwrite:false});
    }
    let result;
    try {
      result=await job({op:'stack',paths:selection.paths,mode:modes[$('stackMode').selectedIndex],
        landscape:$('stackScene').selectedIndex===1,mask:strokes,format,output:file.nativePath,
        calibration:{...calibration,linearTiff:$('stackLinearTiff').checked},
        photoshopOutput:opening.nativePath},id=>{activeJob=id;updateActions(true);});
    } finally {activeJob=null;updateActions(true);}
    status('堆栈已保存，正在 Photoshop 中打开…');
    await host.core.executeAsModal(async()=>{
      const response=await require('photoshop').action.batchPlay([{_obj:'open',null:{_path:fs.createSessionToken(opening),_kind:'local'},_options:{dialogOptions:'dontDisplay'}}],{});
      if(response[0]?._obj==='error') throw new Error('堆栈已保存，但 Photoshop 打开失败：'+response[0].message);
    },{commandName:'打开 Star Studio 堆栈结果'});
    status('已保存并打开 '+result.frames+' 帧堆栈 · '+result.seconds+' 秒。'+(format.startsWith('fits')?'\nFITS 已保存；Photoshop 通过临时 32 位 TIFF 打开完整浮点结果，后续编辑请另存 PSD/TIFF。':'')+(result.encoding.scale!==1?'\n16 位输出缩放比例：'+result.encoding.scale.toFixed(5)+'；见同名 JSON 记录。':'')+(result.encoding.clipped?'\n16 位 TIFF 将 '+result.encoding.clipped+' 个负通道值截为 0；保留完整浮点数据请使用 DNG 或 32 位格式。':'')+(result.calibration?.warnings?.length?'\n校准提示：'+result.calibration.warnings.join('\n'):'')+(result.encoding.quantizationStep?'\n16 位 FITS 量化步长：'+result.encoding.quantizationStep.toExponential(4)+'。':''));
  }));
  calibrationHint();formatHint();updateActions();
  return {updateActions};
}
module.exports={setup};
