const host = require('./host.js');
const config = require('./bridge.json');
if (config.url !== 'http://127.0.0.1:8765') throw new Error('服务地址必须为本机 127.0.0.1:8765。');
const $ = id => document.getElementById(id);
let docID = null, layerList = [], busy = false, updatingPickers=false;
let currentPage='stack', serviceReady=false, documentSnapshot=null, panelVisible=true;
let settingsFile=null, settingsWrite=Promise.resolve();
let modelInfo=null, acceptedLicenses=[];
let stackUI=null, processUI=null;
const pickerValues = {};
let blendSourceKey=null;

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
function isPreview(id) { return id!=null && id===processUI?.previewDocumentID(); }
function refresh(followActive=false) {
  const doc=workingDocument();
  const previous=doc.id===docID;
  layerList=host.layers(doc); docID=doc.id;
  const options=layerList.map(x=>({label:x.name, value:x.id}));
  for (const id of ['source','processSource','processBackground']) {
    const old=previous?value(id):null;
    if(id==='source') {
      const active=doc.activeLayers[0]?.id;
      choose(id,options,followActive?active:options.some(x=>x.value===old)?old:active);
    } else choose(id,[{label:id==='processBackground'?'不使用背景图层':'选择星点图层',value:null},...options],options.some(x=>x.value===old)?old:null);
  }
  refreshBlendModes(doc);
  $('documentName').textContent=doc.title+' · '+doc.width+' × '+doc.height;
}
function refreshBlendModes(doc) {
  const source=host.layers(doc).find(x=>x.id===value('processSource'))?.layer;
  const encoding=host.starEncoding(doc,source);
  const labels={normal:'正常',lighten:'变亮',screen:'滤色',colorDodge:'颜色减淡',linearDodge:'线性减淡（添加）',lighterColor:'浅色',linearLight:'线性光（灰底修正星点）'};
  const modes=encoding==='gray'?['linearLight']:host.starBlendModes(doc).filter(mode=>mode!=='linearLight');
  const key=doc.id+':'+(source?.id || '');
  let selected=value('processBlend');
  if(key!==blendSourceKey && source?.blendMode===host.constants.BlendMode.LINEARDODGE) selected='linearDodge';
  blendSourceKey=key;
  choose('processBlend',modes.map(mode=>({label:labels[mode],value:mode})),modes.includes(selected)?selected:modes.includes('screen')?'screen':encoding==='gray'?'linearLight':'linearDodge');
  $('processBlend').disabled=busy || encoding==='gray';
  $('processEncodingHint').textContent=encoding==='gray'
    ? '灰底修正星点使用线性光。加工只调整正星点，负差值保留；请保留来源图层的线性光模式。'
    : encoding==='signed'?'32 位浮点保留负差值；修正星点建议使用线性减淡（添加）。':'';
}
function snapshot() {
  if (!host.app.documents.some(d=>!isPreview(d.id))) return null;
  const doc=workingDocument();
  return {id:doc.id, history:doc.activeHistoryState.id,
    layers:JSON.stringify(host.layers(doc).map(x=>[x.id,x.name])),
    active:doc.activeLayers.map(x=>x.id).join(','), width:doc.width, height:doc.height};
}
function updateActions() {
  $('extract').disabled=busy || !layerList.length;
  $('decomposition').disabled=busy || $('preserveModelBackground').checked;
  if(stackUI) stackUI.updateActions(busy);
  if(processUI) processUI.updateActions(busy);
}
function syncLayers() {
  if (busy || processUI?.isModalBusy()) return;
  try {
    const next=snapshot(), old=documentSnapshot;
    if (JSON.stringify(next)===JSON.stringify(old)) return;
    documentSnapshot=next;
    if (!next) {
      docID=null; layerList=[];
      for (const id of ['source','processSource','processBackground']) choose(id,[],null);
      $('documentName').textContent='未打开照片'; if(currentPage!=='stack') status('请先打开一张照片。');
      if(processUI) processUI.sync(next,old);
      updateActions(); return;
    }
    const changed=!old || old.id!==next.id;
    refresh(changed || old.active!==next.active);
    if(processUI) processUI.sync(next,old);
    if (changed && currentPage!=='stack') status('选择图层后即可处理。');
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
  for(const name of ['stack','separate','process']) {
    $(name+'Page').classList.toggle('active',name===page);
    $(name+'Tab').classList.toggle('selected',name===page);
    $(name+'Tab').setAttribute('aria-selected',String(name===page));
  }
  syncLayers();
  if(page==='stack') status('选择一批照片或文件夹；无需在 Photoshop 中打开素材。');
  if(page==='process') status('选择星点图层和可选背景，自动在 Photoshop 中预览。');
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
    } else await saveModelSettings();
  } else {
    settingsFile=await folder.createFile('model-settings.json');
    await saveModelSettings();
  }
}
function saveModelSettings() {
  const settings={executable:$('executable').value,acceptedLicenses};
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
    if (state.state==='error') throw new Error(state.error);
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
  status('读取源图层…');
  const meta=await host.core.executeAsModal(()=>host.upload(doc,layer,api,report),{commandName:'读取源图层'});
  const readSeconds=(Date.now()-started)/1000;
  const mode=value('decomposition')===1?'add':'screen';
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
  documentSnapshot=snapshot();
  const timings=result.timings || {};
  const format=x=>Number(x || 0).toFixed(1)+'秒';
  status('分离完成 · '+result.provider+' · 总计 '+format((Date.now()-started)/1000)+'（读取 '+format(readSeconds)+'，引擎 '+format(timings.engineSeconds)+'，写回 '+format((Date.now()-writeStarted)/1000)+'）。可在星点加工页选择两张图层。');
  console.log('星点分离耗时',JSON.stringify({...timings,uploadSeconds:readSeconds,writeSeconds:(Date.now()-writeStarted)/1000,totalSeconds:(Date.now()-started)/1000}));
}
for (const id of ['decomposition','stride']) $(id).selectedIndex=0;
$('executable').value=config.starnet || '';
for (const page of ['stack','separate','process']) $(page+'Tab').addEventListener('click',()=>showPage(page));
$('modelOptions').addEventListener('click',()=>$('modelSettings').classList.toggle('expanded'));
for(const id of ['stride','decomposition','executable']) $(id).addEventListener('change',()=>{if(settingsFile) saveModelSettings();});
$('preserveModelBackground').addEventListener('change',()=>{updateActions();if(settingsFile) saveModelSettings();});
$('executable').addEventListener('change',()=>{
  modelInfo=null; $('modelLicense').classList.remove('expanded');
});
$('chooseExecutable').addEventListener('click',()=>run(async()=>{
  const file=await require('uxp').storage.localFileSystem.getFileForOpening({types:['exe']});
  if(!file) return;
  $('executable').value=file.nativePath;
  modelInfo=null; $('modelLicense').classList.remove('expanded');
  await saveModelSettings();
}));
$('readModelLicense').addEventListener('click',()=>run(readModelLicense));
$('acceptModelLicense').addEventListener('change',()=>{
  if(!modelInfo?.modern) return;
  acceptedLicenses=acceptedLicenses.filter(x=>x!==modelInfo.license_sha256);
  if($('acceptModelLicense').checked) acceptedLicenses.push(modelInfo.license_sha256);
  if(settingsFile) saveModelSettings();
});
$('extract').addEventListener('click',()=>run(extract));
stackUI=require('./stack.js').setup({run,api,job,status});
processUI=require('./star-processing.js').setup({run,api,job,status,report,selectedLayer,useActive,value,refresh,refreshBlendModes:()=>refreshBlendModes(workingDocument()),ensureService,isBusy:()=>busy,isUpdatingPickers:()=>updatingPickers,currentPage:()=>currentPage});
syncLayers();
setInterval(syncLayers,800);
document.addEventListener('uxpcommand',event=>{
  if(event.commandId==='uxpshowpanel') {panelVisible=true;syncLayers();run(async()=>{});}
  if(event.commandId==='uxphidepanel') panelVisible=false;
});
setInterval(()=>{if(panelVisible && serviceReady && !busy) api('/health').catch(()=>{serviceReady=false;});},20000);
run(async()=>{await restoreModelSettings();status('选择一批照片或文件夹；无需在 Photoshop 中打开素材。');});
module.exports={api,extract,refresh};
