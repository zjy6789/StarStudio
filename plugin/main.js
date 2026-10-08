const host = require('./host.js');
const config = require('./bridge.json');
if (config.url !== 'http://127.0.0.1:8765') throw new Error('服务地址必须为本机 127.0.0.1:8765。');
const $ = id => document.getElementById(id);
const defaults = side => ({type:side==='bp'?'ghs':'asinh', lnD:0, b:0, sp:0, hp:1, lp:0, bp:0, color:'luminance', clipping:'blend'});
let docID = null, layerList = [], loaded = null, busy = false, lastPreview = null, previewTimer, updatingPickers=false;
let currentPage='stack', serviceReady=false, documentSnapshot=null, panelVisible=true;
let fullLoaded=null, previewDocID=null, canvasEnabled=false;
let settingsFile=null, settingsWrite=Promise.resolve();
let stackUI=null, processUI=null;
let pending = {bp:[], sp:[]};
const pickerValues = {};

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
  const doc=isPreview(active?.id)?host.app.documents.find(d=>d.id===docID):active;
  if(!doc) throw new Error('请打开源照片。');
  return host.documentInfo(doc);
}
function isPreview(id) { return id!=null && (id===previewDocID || id===processUI?.previewDocumentID()); }
function pairValid() { return value('background')!=null && value('stars')!=null && value('background')!==value('stars'); }
function refresh(followActive=false) {
  const doc=workingDocument();
  const previous=doc.id===docID;
  layerList=host.layers(doc); docID=doc.id;
  const options=layerList.map(x=>({label:x.name, value:x.id}));
  for (const id of ['source','background','stars','processSource']) {
    const old=previous?value(id):null;
    if(id==='source') {
      const active=doc.activeLayers[0]?.id;
      choose(id,options,followActive?active:options.some(x=>x.value===old)?old:active);
    } else choose(id,[{label:id==='background'?'选择背景图层':'选择星点图层',value:null},...options],options.some(x=>x.value===old)?old:null);
  }
  if (!previous) invalidate();
  $('documentName').textContent=doc.title+' · '+doc.width+' × '+doc.height;
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
  $('mix').disabled=busy || !pairValid();
  $('canvas').disabled=busy || (!loaded && !canvasEnabled);
  if(stackUI) stackUI.updateActions(busy);
  if(processUI) processUI.updateActions(busy);
}
function syncLayers() {
  if (busy) return;
  try {
    if(previewDocID && !host.app.documents.some(d=>d.id===previewDocID)) {
      previewDocID=null;canvasEnabled=false;$('canvas').textContent='在 Photoshop 中预览';
    }
    const next=snapshot(), old=documentSnapshot;
    if (JSON.stringify(next)===JSON.stringify(old)) return;
    documentSnapshot=next;
    if (!next) {
      docID=null; layerList=[]; invalidate();
      for (const id of ['source','background','stars','processSource']) choose(id,[],null);
      $('documentName').textContent='未打开照片'; if(currentPage!=='stack') status('请先打开一张照片。');
      if(processUI) processUI.sync(next,old);
      updateActions(); return;
    }
    const changed=!old || old.id!==next.id;
    refresh(changed || old.active!==next.active);
    if(processUI) processUI.sync(next,old);
    if (loaded && (changed || old.history!==next.history)) invalidate(false);
    if (!pairValid()) invalidate();
    if (changed && currentPage!=='stack') status('选择图层后即可处理。');
    updateActions(); schedulePreview();
  } catch(e) { status(e.message,true); updateActions(); }
}
function useActive(id) {
  refresh();
  const active=workingDocument().activeLayers;
  if (active.length!==1) throw new Error('请只选中一个图层。');
  const index=pickerValues[id].findIndex(x=>x.value===active[0].id);
  if (index<0) throw new Error('请选择像素图层或智能对象。');
  $(id).selectedIndex=index;
  if (id==='background' || id==='stars') invalidate();
}
function invalidate(clearChain=true) {
  for(const pair of [loaded,fullLoaded]) if(pair) for(const meta of [pair.b,pair.s]) api('/images/'+meta.id,undefined,false,'DELETE').catch(()=>{});
  fullLoaded=null;
  loaded=null; if(clearChain) pending={bp:[],sp:[]}; lastPreview=null;
  for (const id of ['mixPreview','backgroundPreview','starsPreview','bh','sh']) $(id).removeAttribute('src');
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
  for(const name of ['stack','separate','process','recombine']) {
    $(name+'Page').classList.toggle('active',name===page);
    $(name+'Tab').classList.toggle('selected',name===page);
    $(name+'Tab').setAttribute('aria-selected',String(name===page));
  }
  syncLayers(); schedulePreview();
  if(page==='stack') status('选择一批照片或文件夹；无需在 Photoshop 中打开素材。');
  if(page==='process') status('选择星点图层，启用需要的功能并展开参数。');
}
async function restoreModelSettings() {
  const folder=await require('uxp').storage.localFileSystem.getDataFolder();
  settingsFile=(await folder.getEntries()).find(x=>x.name==='model-settings.json');
  if (settingsFile) {
    const content=await settingsFile.read();
    if(content) {
      const settings=JSON.parse(content);
      $('executable').value=settings.executable;
      for(const id of ['stride','decomposition']) $(id).selectedIndex=settings[id];
    } else await saveModelSettings();
  } else {
    settingsFile=await folder.createFile('model-settings.json');
    await saveModelSettings();
  }
}
function saveModelSettings() {
  const settings={executable:$('executable').value};
  for(const id of ['stride','decomposition']) settings[id]=value(id);
  settingsWrite=settingsWrite.then(()=>settingsFile.write(JSON.stringify(settings))).catch(e=>status('模型设置保存失败：'+e.message,true));
  return settingsWrite;
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
    if (state.state==='done') return state.result;
    status(state.state==='queued'?'等待本地处理…':(state.message || '本地处理…')+' '+Math.round(state.progress*100)+'%');
    await new Promise(resolve=>setTimeout(resolve, 700));
  }
}
async function run(action) {
  if (busy) return;
  busy=true;
  for (const e of document.querySelectorAll('button,input,sp-picker')) e.disabled=true;
  try { await ensureService(); await action(); }
  catch(e) { status(e.message || String(e), true); console.error(e); }
  finally { busy=false; for (const e of document.querySelectorAll('button,input,sp-picker')) e.disabled=false; updateActions(); }
}
function parameters(side) {
  const result={};
  for (const k of ['lnD','b','sp','hp','lp','bp']) result[k]=Number($(side+'_'+k).value);
  result.type=['ghs','asinh','linear'][value(side+'_type')];
  result.color=['luminance','independent'][value(side+'_color')];
  result.clipping=['blend','clip'][value(side+'_clipping')];
  return result;
}
function reset(side) {
  const d=defaults(side);
  for (const k of ['lnD','b','sp','hp','lp','bp']) { $(side+'_'+k).value=d[k]; $(side+'_'+k+'_range').value=d[k]; }
  $(side+'_type').selectedIndex=side==='bp'?0:1;
  $(side+'_color').selectedIndex=0;
  $(side+'_clipping').selectedIndex=0;
}
function buildControls(side) {
  const root=$(side+'Controls');
  const specs=[['lnD','拉伸因子 ln(D+1)',0,10,.01],['b','局部拉伸强度 b',-5,15,.01],['sp','拐点 SP',0,1,.00001],['hp','高光保护点 HP',0,1,.00001],['bp','黑点 BP',0,.9999,.00001],['lp','阴影保护点 LP',0,1,.00001]];
  for (const [key,label,min,max,step] of specs) {
    const el=document.createElement('div'); el.className='param'+(key==='lp'?' advanced':'');
    el.innerHTML='<div class="row"><label>'+label+'</label><button id="'+side+'_'+key+'_minus">−</button><input id="'+side+'_'+key+'" class="numeric" type="text"><button id="'+side+'_'+key+'_plus">+</button></div><input id="'+side+'_'+key+'_range" type="range" min="'+min+'" max="'+max+'" step="'+step+'">';
    root.appendChild(el);
    const sync=(source,target)=>{ $(target).value=$(source).value; schedulePreview(); };
    $(side+'_'+key).addEventListener('change',()=>sync(side+'_'+key,side+'_'+key+'_range'));
    $(side+'_'+key+'_range').addEventListener('input',()=>sync(side+'_'+key+'_range',side+'_'+key));
    for (const [suffix,sign] of [['minus',-1],['plus',1]]) $(side+'_'+key+'_'+suffix).addEventListener('click',()=>{
      const input=$(side+'_'+key); input.value=Math.max(min,Math.min(max,Number(input.value)+sign*step)).toFixed(5);
      sync(side+'_'+key,side+'_'+key+'_range');
    });
  }
  const options=document.createElement('div'); options.className='advanced';
  options.innerHTML='<label>拉伸类型</label><sp-picker id="'+side+'_type"><sp-menu><sp-menu-item>广义双曲 GHS</sp-menu-item><sp-menu-item>改进 arcsinh</sp-menu-item><sp-menu-item>线性 / 黑点</sp-menu-item></sp-menu></sp-picker><label>颜色模型</label><sp-picker id="'+side+'_color"><sp-menu><sp-menu-item>亮度保持</sp-menu-item><sp-menu-item>RGB 通道独立</sp-menu-item></sp-menu></sp-picker><label>越界修剪模式</label><sp-picker id="'+side+'_clipping"><sp-menu><sp-menu-item>RGB 混合</sp-menu-item><sp-menu-item>直接裁剪</sp-menu-item></sp-menu></sp-picker>';
  root.appendChild(options);
  const eyedropper=document.createElement('label');
  eyedropper.innerHTML='<input type="checkbox" id="'+side+'_pick"> 吸管设置拐点'; root.appendChild(eyedropper);
  $(side+'_type').addEventListener('change', schedulePreview); $(side+'_color').addEventListener('change', schedulePreview);
  $(side+'_clipping').addEventListener('change', schedulePreview);
  reset(side);
}
function histogram(id, channels, curve) {
  const log=$('log').checked;
  const transformed=channels.map(a=>a.map(x=>log?Math.log1p(x):x));
  const peak=Math.max(1,...transformed.flat());
  const colors=channels.length===1?['#ccc']:['#ff5353','#58e579','#5696ff'];
  const path=a=>a.map((v,i)=>(i?'L':'M')+i.toFixed(1)+','+(109-v*108/peak).toFixed(1)).join(' ');
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="512" height="110" viewBox="0 0 256 110" preserveAspectRatio="none"><rect width="256" height="110" fill="#090909"/>';
  for (let x=32;x<256;x+=32) svg+='<path d="M'+x+' 0V110" stroke="#333"/>';
  transformed.forEach((a,i)=>svg+='<path d="'+path(a)+'" fill="none" stroke="'+colors[i]+'"/>');
  svg+='<path d="'+curve.map((v,i)=>(i?'L':'M')+i+','+(109-v*108).toFixed(2)).join(' ')+'" fill="none" stroke="#ffbb73"/></svg>';
  $(id).src='data:image/svg+xml;base64,'+btoa(svg);
}
async function loadPair() {
  const b=selectedLayer('background'), s=selectedLayer('stars');
  if (b.layer.id===s.layer.id) throw new Error('背景与星点必须是不同图层。');
  const started=Date.now(); report(0);
  status('正在读取快速预览…');
  loaded=await host.core.executeAsModal(async()=>({
    b:await host.uploadPreview(b.doc,b.layer,api), s:await host.uploadPreview(s.doc,s.layer,api)
  }),{commandName:'读取背景与星点'});
  loaded.seconds=(Date.now()-started)/1000; report(1);
  documentSnapshot=snapshot();
}
function mixRequest(pair=loaded) {
  if (!pair) throw new Error('请选择背景与星点图层。');
  if (workingDocument().id!==pair.b.docID || value('background')!==pair.b.layerID || value('stars')!==pair.s.layerID) {
    invalidate(); throw new Error('图层选择已变化，请重新选择背景和星点。');
  }
  return {background:pair.b.id, stars:pair.s.id, bp:parameters('bp'), sp:parameters('sp'), bchain:pending.bp, schain:pending.sp, mode:value('mode')===1?'add':'screen'};
}
async function preview() {
  if (!loaded) await loadPair();
  const result=await api('/preview', {...mixRequest(),canvas:canvasEnabled});
  lastPreview=result;
  $('backgroundPreview').src=result.background; $('starsPreview').src=result.stars; $('mixPreview').src=result.mix;
  histogram('bh',result.bh,result.bc); histogram('sh',result.sh,result.sc);
  if(canvasEnabled) previewDocID=await host.canvasPreview(previewDocID,result.canvas,loaded.b,api,report);
  documentSnapshot=snapshot();
  status('快速预览已更新 · 图层读取 '+loaded.seconds.toFixed(2)+' 秒。');
}
function schedulePreview() {
  clearTimeout(previewTimer);
  if (currentPage==='recombine' && docID!==null && !busy && pairValid()) previewTimer=setTimeout(()=>run(preview),350);
}
async function applySide(side) {
  if (!loaded) await loadPair();
  // Store the stretch chain; backend renders both preview and full output from
  // the same chain without altering source Photoshop layers.
  const p=parameters(side);
  pending[side].push(p);
  try { const request=mixRequest(); request[side]=defaults(side); await api('/preview', request); }
  catch(e) { pending[side].pop(); throw e; }
  reset(side); await preview();
}
async function extract() {
  if(!$('executable').value.trim()) throw new Error('请先展开「星点提取模型」，填写 StarNet++ 程序路径。下载与安装步骤见 README。');
  const {doc,layer}=selectedLayer('source');
  const meta=await host.core.executeAsModal(()=>host.upload(doc,layer,api,report),{commandName:'读取源图层'});
  const mode=value('decomposition')===1?'add':'screen';
  const result=await job({op:'extract',image:meta.id,executable:$('executable').value.trim(),stride:[256,128,64][value('stride')],mode});
  let bg,stars;
  await host.transaction(doc,'星点分离',async context=>{
    bg=await host.write(doc,result.background,meta,layer.name+'_starless',api,report,context);
    stars=await host.write(doc,result.stars,meta,layer.name+'_starmask',api,report,context);
    // Separate editable outputs. Keep the star layer hidden so the visible
    // result initially shows the starless background instead of readding stars.
    stars.visible=false;
  });
  refresh();
  choose('background',pickerValues.background,null); choose('stars',pickerValues.stars,null);
  $('mode').selectedIndex=mode==='add'?1:0;
  invalidate(); reset('bp');reset('sp');
  documentSnapshot=snapshot();
  status('已创建 '+bg.name+' 与 '+stars.name+'。重混合时请选择需要处理的两个图层。');
}
async function mix() {
  if(!fullLoaded) {
    const b=selectedLayer('background'),s=selectedLayer('stars');
    if(b.layer.id===s.layer.id) throw new Error('背景与星点必须是不同图层。');
    status('正在读取完整图层，生成最终结果…');
    fullLoaded=await host.core.executeAsModal(async()=>({b:await host.upload(b.doc,b.layer,api,report),s:await host.upload(s.doc,s.layer,api,report)}),{commandName:'读取完整图层'});
  }
  const request=mixRequest(fullLoaded), doc=workingDocument();
  const result=await job({op:'mix',...request});
  await host.transaction(doc,'星点重混合',context=>host.write(doc,result.image,fullLoaded.b,fullLoaded.b.name.replace(/_starless$/,'')+'_recombined',api,report,context));
  refresh(); documentSnapshot=snapshot(); status('已创建新的重混合结果图层。');
}
buildControls('bp'); buildControls('sp');
for (const id of ['decomposition','stride','mode']) $(id).selectedIndex=0;
$('executable').value=config.starnet || '';
for (const page of ['stack','separate','process','recombine']) $(page+'Tab').addEventListener('click',()=>showPage(page));
$('modelOptions').addEventListener('click',()=>$('modelSettings').classList.toggle('expanded'));
for(const id of ['stride','decomposition','executable']) $(id).addEventListener('change',()=>{if(settingsFile) saveModelSettings();});
for (const [id,picker] of [['useBackground','background'],['useStars','stars']]) $(id).addEventListener('click',()=>run(async()=>{
  useActive(picker); if(pairValid()) await preview(); else status('请选择背景和星点两个不同的图层。');
}));
for (const id of ['background','stars']) $(id).addEventListener('change',()=>{
  if (updatingPickers) return;
  if (loaded && value('background')===loaded.b.layerID && value('stars')===loaded.s.layerID) return;
  invalidate(); updateActions(); schedulePreview();
});
$('canvas').addEventListener('click',()=>run(async()=>{
  canvasEnabled=!canvasEnabled;
  if(canvasEnabled) await preview();
  else {
    const doc=host.app.documents.find(d=>d.id===previewDocID);
    if(doc) await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭重混合预览'});
    previewDocID=null;
  }
  $('canvas').textContent=canvasEnabled?'关闭 Photoshop 预览':'在 Photoshop 中预览';
}));
$('extract').addEventListener('click',()=>run(extract)); $('load').addEventListener('click',()=>run(async()=>{invalidate(); await preview();}));
$('preview').addEventListener('click',()=>run(preview)); $('mix').addEventListener('click',()=>run(mix));
$('resetBackground').addEventListener('click',()=>{reset('bp');schedulePreview();}); $('resetStars').addEventListener('click',()=>{reset('sp');schedulePreview();});
$('applyBackground').addEventListener('click',()=>run(()=>applySide('bp'))); $('applyStars').addEventListener('click',()=>run(()=>applySide('sp')));
$('advanced').addEventListener('click',()=>{document.body.classList.toggle('showAdvanced');});
$('mode').addEventListener('change',schedulePreview);
for (const [side,id] of [['bp','backgroundPreview'],['sp','starsPreview']]) $(id).addEventListener('click',event=>{
  if (!$(side+'_pick').checked || !loaded || busy) return;
  run(async()=>{
    if (Number($(side+'_bp').value)!==0) throw new Error('请先应用黑点位移，再使用吸管。');
    const meta=side==='bp'?loaded.b:loaded.s;
    const rect=$(id).getBoundingClientRect();
    const scale=Math.min(rect.width/meta.width,rect.height/meta.height);
    const w=meta.width*scale,h=meta.height*scale;
    const u=(event.clientX-rect.left-(rect.width-w)/2)/w;
    const v=(event.clientY-rect.top-(rect.height-h)/2)/h;
    const sample=await api('/sample',{image:meta.id,u,v,chain:pending[side]});
    $(side+'_sp').value=sample.value.toFixed(5); $(side+'_sp_range').value=sample.value;
    await preview();
  });
});
$('log').addEventListener('change',()=>{if(lastPreview){histogram('bh',lastPreview.bh,lastPreview.bc);histogram('sh',lastPreview.sh,lastPreview.sc);}});
stackUI=require('./stack.js').setup({run,api,job,status});
processUI=require('./star-processing.js').setup({run,api,job,status,report,selectedLayer,useActive,value,refresh,currentPage:()=>currentPage});
syncLayers();
setInterval(syncLayers,800);
document.addEventListener('uxpcommand',event=>{
  if(event.commandId==='uxpshowpanel') {panelVisible=true;syncLayers();run(async()=>{});}
  if(event.commandId==='uxphidepanel') panelVisible=false;
});
setInterval(()=>{if(panelVisible && serviceReady && !busy) api('/health').catch(()=>{serviceReady=false;});},20000);
run(async()=>{await restoreModelSettings();status('选择一批照片或文件夹；无需在 Photoshop 中打开素材。');});
module.exports={api,extract,mix,refresh,loadPair,parameters,defaults};
