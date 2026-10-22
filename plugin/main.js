const host = require('./host.js');
const config = require('./bridge.json');
if (config.url !== 'http://127.0.0.1:8765') throw new Error('服务地址必须为本机 127.0.0.1:8765。');
const $ = id => document.getElementById(id);
let docID = null, layerList = [], busy = false, updatingPickers=false;
let currentPage='stack', serviceReady=false, documentSnapshot=null, panelVisible=true;
let settingsFile=null, settingsWrite=Promise.resolve();
let modelInfo=null, acceptedLicenses=[];
let stackUI=null, processUI=null, prepareUI=null, backgroundUI=null, stretchUI=null, maskUI=null, colorUI=null, denoiseUI=null;
const pickerValues = {};
let blendSourceKey=null;
const photoStages=new Map();
const stages=['unknown','developed','linear'];
const layerPairs=new Map();

function separationPair(doc,starID) {
  const pairs=layerPairs.get(doc.id) || [];
  const pair=starID==null?pairs[pairs.length-1]:pairs.find(p=>p.starID===starID);
  if(!pair || pair.width!==doc.width || pair.height!==doc.height || pair.depth!==doc.bitsPerChannel) return null;
  const items=host.layers(doc);
  // Losing the background invalidates the shortcut, not the surviving star encoding.
  return items.some(l=>l.id===pair.starID)&&(starID!=null || items.some(l=>l.id===pair.backgroundID))?pair:null;
}
function starRelation(doc,layer) {
  const index=$('processRelation').selectedIndex;
  if(index===1 && doc.bitsPerChannel===host.constants.BitsPerChannelType.THIRTYTWO)
    throw new Error('32 位不提供滤色混合；请使用实际以相加方式分离的星点，保留原文档位深。');
  if(index===3 && doc.bitsPerChannel===host.constants.BitsPerChannelType.THIRTYTWO)
    throw new Error('灰底修正仅用于 8/16 位；32 位请选择浮点相加关系。');
  if(index>0) return {encoding:index===3?'gray':doc.bitsPerChannel===host.constants.BitsPerChannelType.THIRTYTWO?'signed':'black',mode:index===1?'screen':index===3?'linearLight':'linearDodge',known:true};
  const pair=layer?separationPair(doc,layer.id):null;
  if(pair) return {encoding:pair.encoding,mode:pair.encoding==='gray'?'linearLight':pair.mode==='add'?'linearDodge':'screen',known:true};
  const processed=layer?processUI?.relationFor?.(doc,layer):null;
  if(processed) return {...processed,known:true};
  const encoding=host.starEncoding(doc,layer);
  return {encoding,mode:encoding==='gray'?'linearLight':doc.bitsPerChannel===host.constants.BitsPerChannelType.THIRTYTWO?'linearDodge':'screen',known:false};
}
async function useSeparation() {
  const doc=workingDocument(),pair=separationPair(doc);
  if(!pair) throw new Error('刚分离的图层已删除、文档已变化或本会话没有记录，请手动选择。');
  refresh();
  for(const [id,layerID] of [['processSource',pair.starID],['processBackground',pair.backgroundID]])
    $(id).selectedIndex=pickerValues[id].findIndex(item=>item.value===layerID);
  $('processRelation').selectedIndex=0;
  refreshBlendModes(doc,true);showPage('process');
}

function inputState() {
  const doc=host.app.documents.find(d=>d.id===docID);
  $('startCurrent').disabled=busy || !doc;
  $('photoStage').disabled=busy || !doc;
  $('photoStage').selectedIndex=Math.max(0,stages.indexOf(photoStages.get(docID) || 'unknown'));
  $('inputHint').textContent=doc
    ? '来源：'+doc.title+'。'+(isPreview(host.app.activeDocument?.id)?'当前查看临时预览，来源仍为这张文档。':'去星前请确认照片阶段；已有星点可在加工页手动选择。')
    : '尚未打开照片。可先在 Photoshop 打开已显影照片，或从多张原片堆栈开始。';
  $('sceneHint').textContent=$('photoScene').selectedIndex===1
    ? '保留线性母版；去星前先在副本完成显影。已有星点和无星背景可直接手动带入加工。'
    : '天空对齐不保护地景清晰度；地景精修仍可使用 Photoshop 蒙版。';
}
function modelState(error='') {
  $('modelState').textContent=!modelExecutable()?'StarNet 未配置；仍可堆栈和加工已有星点层。'
    : error?'StarNet 无法就绪：'+error+'。请完整解压官方 CLI 并重新选择程序；其他工具仍可使用。'
    : !modelInfo?'StarNet 尚未检查；选择程序后自动检查。'
    : modelInfo.modern&&!acceptedLicenses.includes(modelInfo.license_sha256)?'StarNet 程序已找到，许可待确认。展开模型设置，查看并同意许可。'
    : 'StarNet 程序与许可已就绪；模型及设备将在实际执行时由引擎检查。';
}
async function checkModel() {
  const executable=modelExecutable();modelInfo=null;modelState();
  if(!executable) return;
  try {
    const info=await api('/starnet-info',{executable});
    if(modelExecutable()!==executable) return;
    modelInfo=info;modelState();
  } catch(e) {if(modelExecutable()===executable) modelState(e.message);}
}

function status(message, error=false) { $('status').textContent=message; $('status').className=error?'error':''; }
function report(x) { $('progress').value=x; }
async function api(path, body, binary=false, method='GET') {
  const options = {method,headers:{'X-Star-Token':config.token}};
  if (body!==undefined) {
    options.method='POST';
    options.headers['Content-Type']=body instanceof ArrayBuffer?'application/octet-stream':'application/json';
    options.body=body instanceof ArrayBuffer?body:JSON.stringify(body);
  }
  const r = await fetch(config.url+path, options);
  if (!r.ok) { let e; try { e=await r.json(); } catch(_) { e={error:'HTTP '+r.status}; } throw new Error(e.error); }
  return binary?r.arrayBuffer():r.json();
}
function choose(id, values, selected) {
  const index=Math.max(0, values.findIndex(v=>v.value===selected));
  if(JSON.stringify(pickerValues[id])===JSON.stringify(values) && $(id).selectedIndex===index) return;
  updatingPickers=true;
  try {
  pickerValues[id]=values;
  const menu=$(id).querySelector('sp-menu');
  menu.innerHTML='';
  for (const value of values) { const item=document.createElement('sp-menu-item'); item.textContent=value.label; menu.appendChild(item); }
  $(id).selectedIndex=index;
  } finally { updatingPickers=false; }
}
function value(id) { const values=pickerValues[id]; return values?values[$(id).selectedIndex]?.value:$(id).selectedIndex; }
function selectedLayer(id) {
  const doc=workingDocument();
  if (doc.id!==docID) refresh();
  const layer=host.layers(doc).find(x=>x.id===value(id));
  if (!layer) throw new Error('请选择一个像素图层或智能对象。');
  return {doc, layer:layer.layer};
}
function workingDocument() {
  const active=host.app.activeDocument;
  const doc=isPreview(active?.id) || processUI?.isModalBusy()?host.app.documents.find(d=>d.id===docID):active;
  if(!doc) throw new Error('请打开源照片。');
  return host.documentInfo(doc);
}
function isPreview(id) { return id!=null && (id===processUI?.previewDocumentID() || id===backgroundUI?.previewDocumentID() || id===stretchUI?.previewDocumentID() || id===colorUI?.previewDocumentID() || id===denoiseUI?.previewDocumentID()); }
function refresh(followActive=false) {
  const doc=workingDocument();
  const previous=doc.id===docID;
  layerList=host.layers(doc); docID=doc.id;
  const options=layerList.map(x=>({label:x.name, value:x.id}));
  for (const id of ['source','processSource','processBackground','backgroundSource']) {
    const old=previous?value(id):null;
    if(id==='source') {
      const active=doc.activeLayers[0]?.id;
      choose(id,options,followActive?active:options.some(x=>x.value===old)?old:active);
    } else choose(id,[{label:id==='processBackground'?'不使用背景图层':id==='backgroundSource'?'选择照片或背景图层':'选择星点图层',value:null},...options],options.some(x=>x.value===old)?old:null);
  }
  refreshBlendModes(doc);
  $('documentName').textContent=doc.title+' · '+doc.width+' × '+doc.height;
  inputState();
}
function refreshBlendModes(doc,restore=false) {
  const source=host.layers(doc).find(x=>x.id===value('processSource'))?.layer;
  const key=doc.id+':'+(source?.id || '');
  if(key!==blendSourceKey) $('processRelation').selectedIndex=0;
  const relation=starRelation(doc,source),encoding=relation.encoding;
  const labels={normal:'正常',lighten:'变亮',screen:'滤色',colorDodge:'颜色减淡',linearDodge:'线性减淡（添加）',lighterColor:'浅色',linearLight:'线性光（灰底修正星点）'};
  const modes=encoding==='gray'?['linearLight']:host.starBlendModes(doc).filter(mode=>mode!=='linearLight');
  let selected=value('processBlend');
  if(restore || key!==blendSourceKey) selected=relation.known?relation.mode:source?.blendMode===host.constants.BlendMode.LINEARDODGE?'linearDodge':relation.mode;
  blendSourceKey=key;
  choose('processBlend',modes.map(mode=>({label:labels[mode],value:mode})),modes.includes(selected)?selected:modes.includes('screen')?'screen':encoding==='gray'?'linearLight':'linearDodge');
  $('processBlend').disabled=busy || encoding==='gray';
  $('processEncodingHint').textContent=encoding==='gray'
    ? '灰底修正星点使用线性光。加工只调整正星点，负差值保留；请保留来源图层的线性光模式。'
    : encoding==='signed'?'32 位浮点保留负差值；修正星点建议使用线性减淡（添加）。':'';
  $('processPairHint').textContent=source?(relation.known?'已确认分离关系；可恢复匹配混合。':'外来星点来源关系未知；可在「分离关系」指定滤色、相加或灰底修正。')+' 仍可手动选择其他星点和背景。':'手动选择星点与可选背景，或显式使用刚分离的结果。';
}
function snapshot() {
  if (!host.app.documents.some(d=>!isPreview(d.id))) return null;
  const doc=workingDocument();
  return {id:doc.id, history:doc.activeHistoryState.id,
    layers:JSON.stringify(host.layers(doc).map(x=>[x.id,x.name])),
    active:doc.activeLayers.map(x=>x.id).join(','), width:doc.width, height:doc.height};
}
function updateActions() {
  inputState();
  const doc=host.app.documents.find(d=>d.id===docID),pair=doc?separationPair(doc):null;
  for(const id of ['useSeparation','useLastSeparation','viewStarless']) $(id).disabled=busy || !pair;
  $('restoreMatchedBlend').disabled=busy || value('processSource')==null;
  $('extract').disabled=busy || !layerList.length;
  const float=doc?.bitsPerChannel===host.constants.BitsPerChannelType.THIRTYTWO;
  if(float) $('decomposition').selectedIndex=1;
  $('decomposition').disabled=busy || $('preserveModelBackground').checked || float;
  $('decompositionHint').textContent=float?'32 位使用相加差值，与可用的线性减淡（添加）匹配；不降低位深。':'';
  if(stackUI) stackUI.updateActions(busy);
  if(processUI) processUI.updateActions(busy);
  if(prepareUI) prepareUI.updateActions(busy);
  if(backgroundUI) backgroundUI.updateActions(busy);
  if(stretchUI) stretchUI.updateActions(busy);
  if(maskUI) maskUI.updateActions(busy);
  if(colorUI) colorUI.updateActions(busy);
  if(denoiseUI) denoiseUI.updateActions(busy);
}
function syncLayers() {
  if (busy || processUI?.isModalBusy()) return;
  try {
    const next=snapshot(), old=documentSnapshot;
    if (JSON.stringify(next)===JSON.stringify(old)) {inputState();return;}
    documentSnapshot=next;
    if (!next) {
      docID=null; layerList=[];
      for (const id of ['source','processSource','processBackground','backgroundSource']) choose(id,[],null);
      $('documentName').textContent='未打开照片'; if(!['stack','prepare','stretch'].includes(currentPage)) status('请先打开一张照片。');
      if(processUI) processUI.sync(next,old);
      if(backgroundUI) backgroundUI.sync(next,old);
      if(maskUI) maskUI.sync(next,old);
      if(colorUI) colorUI.sync(next,old);
      if(denoiseUI) denoiseUI.sync(next,old);
      updateActions(); return;
    }
    const changed=!old || old.id!==next.id;
    refresh(changed || old.active!==next.active);
    if(processUI) processUI.sync(next,old);
    if(backgroundUI) backgroundUI.sync(next,old);
    if(maskUI) maskUI.sync(next,old);
    if(colorUI) colorUI.sync(next,old);
    if(denoiseUI) denoiseUI.sync(next,old);
    if (changed && !['stack','prepare','stretch'].includes(currentPage)) status('选择图层后即可处理。');
    updateActions();
  } catch(e) { status(e.message,true); updateActions(); }
}
function useActive(id) {
  refresh();
  const active=workingDocument().activeLayers;
  if (active.length!==1) throw new Error('请只选中一个图层。');
  const index=pickerValues[id].findIndex(x=>x.value===active[0].id);
  if (index<0) throw new Error('请选择像素图层或智能对象。');
  $(id).selectedIndex=index;
}
async function ensureService() {
  try { await api('/health'); serviceReady=true; return; } catch(e) { serviceReady=false; }
  status('正在准备图像处理…');
  const error=await require('uxp').shell.openPath(config.launcher,'启动星点处理组件，仅在使用插件期间后台运行，不会设置开机自启。');
  if(error) throw new Error('未能启动图像处理组件：'+error);
  for(let i=0;i<30;i++) {
    try { await api('/health'); serviceReady=true; return; }
    catch(e) { if(i===29) throw new Error('图像处理组件启动失败，请检查 artifacts/bridge-background.log。'); }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
}
function showPage(page) {
  currentPage=page;
  for(const name of ['stack','prepare','stretch','background','separate','process']) {
    $(name+'Page').classList.toggle('active',name===page);
    $(name+'Tab').classList.toggle('selected',name===page);
    $(name+'Tab').setAttribute('aria-selected',String(name===page));
  }
  syncLayers();
  if(page==='stack') status('选择一批照片或文件夹；无需在 Photoshop 中打开素材。');
  if(page==='prepare') status('选择未拉伸的 Star Studio 32位线性TIFF母版，先检查范围，再创建独立副本。');
  if(page==='stretch') status('选择T4准备副本，建议参数后仅预览；保存并应用是独立操作。');
  if(page==='process') status('选择星点图层和可选背景，自动在 Photoshop 中预览。');
  if(page==='background') status('选择已显影照片或无星背景，生成建议并检查主体保护。');
  processUI?.pageChanged();
}
async function restoreModelSettings() {
  const folder=await require('uxp').storage.localFileSystem.getDataFolder();
  settingsFile=(await folder.getEntries()).find(x=>x.name==='model-settings.json');
  if (settingsFile) {
    const content=await settingsFile.read();
    if(content) {
      const settings=JSON.parse(content);
      const executable=settings.engineMode===1 && settings.cpuExecutable?settings.cpuExecutable:settings.executable;
      if(executable) $('executable').value=executable;
      acceptedLicenses=settings.acceptedLicenses || [];
      for(const id of ['stride','decomposition']) $(id).selectedIndex=settings[id];
      $('preserveModelBackground').checked=settings.preserveModelBackground===true;
      $('photoScene').selectedIndex=settings.photoScene===1?1:0;
    } else await saveModelSettings();
  } else {
    settingsFile=await folder.createFile('model-settings.json');
    await saveModelSettings();
  }
}
function saveModelSettings() {
  const settings={executable:$('executable').value,acceptedLicenses};
  settings.photoScene=$('photoScene').selectedIndex;
  for(const id of ['stride','decomposition']) settings[id]=value(id);
  settings.preserveModelBackground=$('preserveModelBackground').checked;
  settingsWrite=settingsWrite.then(()=>settingsFile.write(JSON.stringify(settings))).catch(e=>status('模型设置保存失败：'+e.message,true));
  return settingsWrite;
}
function modelExecutable() {
  return $('executable').value.trim();
}
async function readModelLicense() {
  modelInfo=await api('/starnet-info',{executable:modelExecutable()});
  $('licenseText').textContent=modelInfo.license || '此 CPU 兼容版沿用原发行包许可，请阅读引擎目录中的 LICENSE。';
  $('acceptModelLicense').checked=acceptedLicenses.includes(modelInfo.license_sha256);
  $('acceptModelLicense').parentElement.style.display=modelInfo.modern?'block':'none';
  $('modelLicense').classList.add('expanded');
  modelState();
  return modelInfo;
}
async function job(request, started=()=>{}) {
  // A native file dialog can outlast the component's idle timeout.
  await ensureService();
  const {id}=await api('/jobs', request);
  started(id);
  while(true) {
    const state=await api('/jobs/'+id);
    report(state.progress);
    if (state.state==='error') {
      const error=new Error(state.error);
      if(state.failedFile){error.failedFile=state.failedFile;error.alignment=state.alignment || [];}
      throw error;
    }
    if (state.state==='canceled') throw new Error('处理已取消。');
    if (state.state==='done') return state.result;
    status(state.state==='queued'?'等待本地处理…':(state.message || '本地处理…')+' '+Math.round(state.progress*100)+'%');
    await new Promise(resolve=>setTimeout(resolve, 700));
  }
}
async function run(action) {
  if (busy) return;
  busy=true;
  for (const e of document.querySelectorAll('button,input,sp-picker')) e.disabled=true;
  try { await processUI?.pause(); await ensureService(); await action(); }
  catch(e) { status(e.message || String(e), true); console.error(e); }
  finally { busy=false; for (const e of document.querySelectorAll('button,input,sp-picker')) e.disabled=false; updateActions(); processUI?.resume(); }
}
async function extract() {
  if(!modelExecutable()) throw new Error('请先展开「星点提取模型」，填写当前引擎程序路径。下载与安装步骤见 README。');
  modelInfo=await api('/starnet-info',{executable:modelExecutable()});
  if(modelInfo.modern && !acceptedLicenses.includes(modelInfo.license_sha256)) {
    $('modelSettings').classList.add('expanded');
    await readModelLicense();
    throw new Error('请阅读引擎许可并勾选同意，然后执行星点分离。');
  }
  const stride=[256,128,64,384][value('stride')];
  if(!modelInfo.modern && stride===384) throw new Error('384 步长需要新版 StarNet2；使用旧版 CPU 引擎时请选择 256、128 或 64。');
  const started=Date.now();
  const {doc,layer}=selectedLayer('source');
  const stage=photoStages.get(doc.id) || 'unknown';
  if(stage!=='developed') {
    $('startSettings').classList.add('expanded');
    throw new Error(stage==='linear'
      ? '当前是线性堆栈母版。请保留母版，在 Camera Raw / Photoshop 的副本中完成显影后，确认「已显影照片」再去星。'
      : '请先在「照片阶段」确认这是已显影照片。不能仅凭 16/32 位判断线性；确认不会修改照片像素。');
  }
  status('读取源图层…');
  const meta=await host.core.executeAsModal(()=>host.upload(doc,layer,api,report),{commandName:'读取源图层'});
  const readSeconds=(Date.now()-started)/1000;
  const mode=meta.size===32 || value('decomposition')===1?'add':'screen';
  const preserveModelBackground=$('preserveModelBackground').checked;
  const starEncoding=meta.size===32?'signed':'gray';
  const result=await job({op:'extract',image:meta.id,executable:modelExecutable(),license_sha256:modelInfo.license_sha256,stride,mode,preserveModelBackground,starEncoding});
  const writeStarted=Date.now();
  status('写回背景和星点图层…');
  let bg,stars;
  try {
  await host.transaction(doc,'星点分离',async context=>{
    bg=await host.write(doc,result.background,meta,layer.name+'_starless',api,report,context);
    stars=await host.write(doc,result.stars,meta,layer.name+'_starmask',api,report,context);
    if(preserveModelBackground) host.setStarBlendMode(stars,result.starEncoding==='signed'?'linearDodge':'linearLight',doc);
    // Separate editable outputs. Keep the star layer hidden so the visible
    // result initially shows the starless background instead of readding stars.
    stars.visible=false;
  });
  } finally {
    for(const key of [meta.id,result.background,result.stars]) {
      try { await api('/images/'+key,undefined,false,'DELETE'); } catch(e) { console.error('释放分离缓存失败',e); }
    }
  }
  refresh();
  const pairs=layerPairs.get(doc.id) || [];
  pairs.push({docID:doc.id,sourceID:layer.id,starID:stars.id,backgroundID:bg.id,mode,
    encoding:preserveModelBackground?starEncoding:meta.size===32?'signed':'black',
    width:doc.width,height:doc.height,depth:doc.bitsPerChannel});
  layerPairs.set(doc.id,pairs);updateActions();
  documentSnapshot=snapshot();
  const timings=result.timings || {};
  const format=x=>Number(x || 0).toFixed(1)+'秒';
  status('分离完成 · '+result.provider+' · 总计 '+format((Date.now()-started)/1000)+'（读取 '+format(readSeconds)+'，引擎 '+format(timings.engineSeconds)+'，写回 '+format((Date.now()-writeStarted)/1000)+'）。可点击「使用刚分离的星点与背景」，或继续手动选层。');
  console.log('星点分离耗时',JSON.stringify({...timings,uploadSeconds:readSeconds,writeSeconds:(Date.now()-writeStarted)/1000,totalSeconds:(Date.now()-started)/1000}));
}
for (const id of ['decomposition','stride']) $(id).selectedIndex=0;
$('photoStage').selectedIndex=0;$('photoScene').selectedIndex=0;
$('processRelation').selectedIndex=0;
$('processRelationOptions').addEventListener('click',()=>$('processRelationSettings').classList.toggle('expanded'));
$('useSeparation').addEventListener('click',()=>run(useSeparation));
$('useLastSeparation').addEventListener('click',()=>run(useSeparation));
$('restoreMatchedBlend').addEventListener('click',()=>{
  try {
    const {doc,layer}=selectedLayer('processSource');
    if(!starRelation(doc,layer).known) throw new Error('此图层的分离关系未知，请先展开「手动指定分离关系」确认。');
    refreshBlendModes(doc,true);processUI.pageChanged();
  } catch(e) {status(e.message,true);}
});
$('processRelation').addEventListener('change',()=>{
  try {refreshBlendModes(workingDocument(),true);processUI.pageChanged();} catch(e) {status(e.message,true);}
});
$('viewStarless').addEventListener('click',()=>run(async()=>{
  const doc=workingDocument(),pair=separationPair(doc);
  if(!pair) throw new Error('图层关联已失效，请手动选择无星背景。');
  const items=host.layers(doc);
  await processUI.viewBackground(doc,items.find(l=>l.id===pair.backgroundID).layer,items.find(l=>l.id===pair.starID).layer);
  status('正在查看无星背景；其他未选择的图层保留原可见性。');
}));
$('startOptions').addEventListener('click',()=>{
  const expanded=!$('startSettings').classList.contains('expanded');
  $('startSettings').classList.toggle('expanded',expanded);
  $('startOptions').setAttribute('aria-expanded',String(expanded));
  $('startOptions').textContent='开始与照片状态 '+(expanded?'▴':'▾');
});
$('startCurrent').addEventListener('click',()=>showPage('separate'));
$('startStack').addEventListener('click',()=>showPage('stack'));
$('photoStage').addEventListener('change',()=>{
  if(docID!=null) photoStages.set(docID,stages[$('photoStage').selectedIndex] || 'unknown');
  inputState();
});
$('photoScene').addEventListener('change',()=>{inputState();if(settingsFile) saveModelSettings();});
$('executable').value=config.starnet || '';
for (const page of ['stack','prepare','stretch','background','separate','process']) $(page+'Tab').addEventListener('click',()=>showPage(page));
$('modelOptions').addEventListener('click',()=>$('modelSettings').classList.toggle('expanded'));
for(const id of ['stride','decomposition','executable']) $(id).addEventListener('change',()=>{if(settingsFile) saveModelSettings();});
$('preserveModelBackground').addEventListener('change',()=>{updateActions();if(settingsFile) saveModelSettings();});
$('executable').addEventListener('change',()=>{
  modelInfo=null; $('modelLicense').classList.remove('expanded');
  checkModel();
});
$('chooseExecutable').addEventListener('click',()=>run(async()=>{
  const file=await require('uxp').storage.localFileSystem.getFileForOpening({types:['exe']});
  if(!file) return;
  $('executable').value=file.nativePath;
  modelInfo=null; $('modelLicense').classList.remove('expanded');
  await saveModelSettings();
  await checkModel();
}));
$('readModelLicense').addEventListener('click',()=>run(readModelLicense));
$('acceptModelLicense').addEventListener('change',()=>{
  if(!modelInfo?.modern) return;
  acceptedLicenses=acceptedLicenses.filter(x=>x!==modelInfo.license_sha256);
  if($('acceptModelLicense').checked) acceptedLicenses.push(modelInfo.license_sha256);
  modelState();
  if(settingsFile) saveModelSettings();
});
$('extract').addEventListener('click',()=>run(extract));
stretchUI=require('./protected-stretch.js').setup({run,api,job,status,report,isBusy:()=>busy,onSource:doc=>{photoStages.set(doc.id,'linear');refresh();documentSnapshot=snapshot();},onApplied:(doc,nonlinear)=>{photoStages.set(doc.id,nonlinear?'developed':'linear');refresh();documentSnapshot=snapshot();}});
prepareUI=require('./linear-preparation.js').setup({run,api,job,status,isBusy:()=>busy,onPrepared:file=>stretchUI.setLastPrepared(file),onOpened:doc=>{photoStages.set(doc.id,'linear');refresh();}});
backgroundUI=require('./background.js').setup({run,api,job,status,report,selectedLayer,useActive,isBusy:()=>busy,isUpdatingPickers:()=>updatingPickers,stage:doc=>photoStages.get(doc.id) || 'unknown',onApplied:doc=>{photoStages.set(doc.id,'developed');refresh();documentSnapshot=snapshot();}});
stackUI=require('./stack.js').setup({run,api,job,status,onSaved:(file,format)=>prepareUI.setLastMaster(file,format),onLayeredOpened:doc=>{photoStages.set(doc.id,'linear');refresh();documentSnapshot=snapshot();}});
processUI=require('./star-processing.js').setup({run,api,job,status,report,selectedLayer,useActive,value,refresh,starEncoding:(doc,layer)=>starRelation(doc,layer).encoding,refreshBlendModes:()=>refreshBlendModes(workingDocument()),ensureService,isBusy:()=>busy,isUpdatingPickers:()=>updatingPickers,currentPage:()=>currentPage});
maskUI=require('./protection-masks.js').setup({run,api,job,status,report,selectedLayer,workingDocument,starRelation,isBusy:()=>busy,isUpdatingPickers:()=>updatingPickers});
colorUI=require('./sky-color.js').setup({run,api,job,status,report,selectedLayer,isBusy:()=>busy,isUpdatingPickers:()=>updatingPickers,stage:doc=>photoStages.get(doc.id) || 'unknown',onApplied:doc=>{photoStages.set(doc.id,'developed');refresh();documentSnapshot=snapshot();}});
denoiseUI=require('./background-denoise.js').setup({run,api,job,status,report,selectedLayer,isBusy:()=>busy,isUpdatingPickers:()=>updatingPickers,stage:doc=>photoStages.get(doc.id) || 'unknown',onApplied:doc=>{photoStages.set(doc.id,'developed');refresh();documentSnapshot=snapshot();}});
syncLayers();
setInterval(syncLayers,800);
document.addEventListener('uxpcommand',event=>{
  if(event.commandId==='uxpshowpanel') {panelVisible=true;syncLayers();run(async()=>{});}
  if(event.commandId==='uxphidepanel') panelVisible=false;
});
setInterval(()=>{if(panelVisible && serviceReady && !busy) api('/health').catch(()=>{serviceReady=false;});},20000);
run(async()=>{await restoreModelSettings();inputState();await checkModel();status('处理当前照片，或从多张原片开始；也可直接使用页签。');});
module.exports={api,extract,refresh};
