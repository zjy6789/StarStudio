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

function setup({run,api,job,status,report,selectedLayer,useActive,value,refresh,currentPage}) {
  let meta=null, last=null, timer=null, previewID=null, canvasEnabled=false;
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
  function schedule() {
    clearTimeout(timer);
    if(currentPage()==='process' && value('processSource')!=null) timer=setTimeout(()=>run(preview),500);
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
  function invalidate() {
    clearTimeout(timer);
    for(const key of [meta?.id,last?.image]) if(key) api('/images/'+key,undefined,false,'DELETE').catch(()=>{});
    meta=null;last=null;$('processPreview').removeAttribute('src');updateActions();
  }
  function updateActions(busy=false) {
    const selected=value('processSource')!=null;
    $('processExecute').disabled=busy || !selected;
    $('processPreviewButton').disabled=busy || !selected;
    $('processOriginal').disabled=busy || !last;
    $('processCanvas').disabled=busy || (!last && !canvasEnabled);
    if(previewID && !host.app.documents.some(d=>d.id===previewID)) {
      previewID=null;canvasEnabled=false;$('processCanvas').textContent='在 Photoshop 中预览';
    }
  }
  async function display() {
    if(!last) return;
    const original=$('processOriginal').checked;
    $('processPreview').src=original?meta.original:last.preview;
    if(canvasEnabled) previewID=await host.canvasPreview(previewID,{id:original?meta.id:last.image,width:meta.width,height:meta.height,components:meta.components},meta,api,report,'星点加工');
  }
  async function preview() {
    const {doc,layer}=selectedLayer('processSource');
    if(meta && (meta.docID!==doc.id || meta.layerID!==layer.id)) invalidate();
    if(!meta) {
      status('正在读取星点快速预览…');
      meta=await host.core.executeAsModal(()=>host.uploadPreview(doc,layer,api),{commandName:'读取星点加工预览'});
      const original=await job({op:'processStars',image:meta.id,settings:{},preview:true});
      meta.original=original.preview;await api('/images/'+original.image,undefined,false,'DELETE');
    }
    const result=await job({op:'processStars',image:meta.id,settings:settings(),preview:true,scale:meta.width/doc.width});
    if(last) await api('/images/'+last.image,undefined,false,'DELETE');
    last=result;await display();curvePlot(result.curve);updateActions();
    status('星点预览已更新。'+(result.reconstructedStars?' 重建 '+result.reconstructedStars+' 个星点。':''));
  }
  $('processSource').addEventListener('change',()=>{invalidate();schedule();});
  $('processUseActive').addEventListener('click',()=>run(async()=>{useActive('processSource');invalidate();await preview();}));
  $('processPreviewButton').addEventListener('click',()=>run(preview));
  $('processOriginal').addEventListener('change',()=>run(display));
  $('processReset').addEventListener('click',reset);
  $('processCanvas').addEventListener('click',()=>run(async()=>{
    canvasEnabled=!canvasEnabled;
    if(canvasEnabled) await display();
    else {const doc=host.app.documents.find(d=>d.id===previewID);if(doc) await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭星点加工预览'});previewID=null;}
    $('processCanvas').textContent=canvasEnabled?'关闭 Photoshop 预览':'在 Photoshop 中预览';
  }));
  $('processExecute').addEventListener('click',()=>run(async()=>{
    const {doc,layer}=selectedLayer('processSource');
    const full=await host.core.executeAsModal(()=>host.upload(doc,layer,api,report),{commandName:'读取完整星点图层'});
    let result;
    try {
      result=await job({op:'processStars',image:full.id,settings:settings()});
      const output=await host.transaction(doc,'星点加工',context=>host.write(doc,result.image,full,layer.name+'_processed',api,report,context));
      refresh();status('已创建 '+output.name+'。请在重混合页选择该图层。'+(result.reconstructedStars?' 重建 '+result.reconstructedStars+' 个星点。':''));
    } finally {
      for(const key of [full.id,result?.image]) if(key) await api('/images/'+key,undefined,false,'DELETE');
    }
  }));
  reset();updateActions();
  return {updateActions,previewDocumentID:()=>previewID,sync(next,old){
    if(meta && (!next || next.id!==meta.docID || old?.history!==next.history || value('processSource')!==meta.layerID)) {invalidate();schedule();}
  }};
}
module.exports={setup};
