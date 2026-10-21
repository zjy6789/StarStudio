const host=require('./host.js');
const $=id=>document.getElementById(id);

function setup({run,api,job,status,report,selectedLayer,isBusy,stage,onApplied=()=>{},isUpdatingPickers=()=>false}) {
  let meta=null,model=null,sourceKey=null,preview=null,jobID=null,maskOwner=null,shownKey=null;
  const masks={},renders={};
  function owner(doc,layer) {return [doc.id,layer.id,doc.width,doc.height,doc.bitsPerChannel].join(':');}
  function key(doc,layer) {return owner(doc,layer)+':'+doc.activeHistoryState.id;}
  function current() {
    const selected=selectedLayer('backgroundSource');
    if(stage(selected.doc)!=='developed')throw new Error('请先确认照片阶段为已显影；本页不是线性测光校准。');
    if(selected.doc.mode!==host.constants.DocumentMode.RGB)throw new Error('天空校色需要RGB照片；灰度不会自动转彩色。');
    return selected;
  }
  function validate() {const selected=current();if(!meta || !model || sourceKey!==key(selected.doc,selected.layer))throw new Error('颜色来源或历史已变化，请重新读取并生成。');return selected;}
  // Typed float input may be read back only through its own route. Result IDs
  // remain ordinary images; previews use the same exact source snapshot.
  function imageAPI(path,...args) {return api(meta && path.startsWith('/images/'+meta.id+'?')?path.replace('/images/','/color-sources/'):path,...args);}
  async function remove(id,path='/images') {if(id)try{await api(path+'/'+id,undefined,false,'DELETE');}catch(e){console.error(e);}}
  async function closePreview() {
    const doc=host.app.documents.find(d=>d.id===preview?.docID);preview=null;
    if(doc)await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭颜色临时预览'});
  }
  async function clearModel() {
    const old=meta,ids=Object.values(renders).map(x=>x.image);meta=null;model=null;sourceKey=null;shownKey=null;
    for(const view of Object.keys(renders))delete renders[view];
    $('colorReviewed').checked=false;$('colorSamples').src='';$('colorSummary').textContent='请读取指定天空，重新检查颜色建议。';
    await closePreview();await remove(old?.id,'/color-sources');for(const id of ids)await remove(id);
  }
  async function clearMasks() {const ids=Object.values(masks);for(const name of Object.keys(masks))delete masks[name];maskOwner=null;for(const id of ids)await remove(id);hint();}
  function hint() {$('colorMaskHint').textContent=(masks.sampling?'已记录天空取样选区。':'尚未指定天空取样。')+(masks.protection?'已记录主体保护，白区不改色。':'未指定主体保护；可选择地景、银河或星点覆盖进行保护。');}
  function options() {return {neutral:$('colorNeutralEnabled').checked?Number($('colorNeutral').value):0,boost:$('colorBoostEnabled').checked?Number($('colorBoost').value):0,backgroundFactor:Number($('colorBackgroundFactor').value),bright:Number($('colorBright').value)};}
  function renderKey() {return JSON.stringify(options());}
  async function task(request) {try{return await job(request,id=>{jobID=id;updateActions(true);});}finally{jobID=null;}}
  async function rendered(view) {
    const signature=renderKey();
    if(renders[view]?.signature===signature)return renders[view];
    const next=await task({op:'colorRender',image:meta.id,options:options(),view});
    const old=renders[view];renders[view]={...next,signature};await remove(old?.image);return renders[view];
  }
  async function show() {
    validate();const view=['result','original','weights'][$('colorView').selectedIndex] || 'result',signature=renderKey();
    try {
      const result=view==='original'?null:await rendered(view);validate();
      if(signature!==renderKey())throw new Error('颜色参数在计算期间变化，请重新预览。');
      preview=await host.canvasFloatPreview(preview,result?.image || null,meta,view==='weights'?'颜色作用范围':'颜色结果',imageAPI,report,'天空校色',true);
      if(view==='result')shownKey=signature;
      const stats=result?.stats;
      $('colorPreviewHint').textContent=view==='original'?'正在查看原输入快照；原用户文档未改写。':view==='weights'?'白色是调整区域；两种效果的保护范围可能不同，显示当前两者的最大作用权重。'
        :'颜色结果已更新。'+(stats?'数值范围 '+stats.minimum.toPrecision(5)+' 至 '+stats.maximum.toPrecision(5)+'；结果含 '+stats.negativeChannels+' 个负值通道和 '+stats.aboveOneChannels+' 个超1通道，未裁切。':'');
    } catch(error) {shownKey=null;$('colorPreviewHint').textContent='颜色预览未更新，当前可能仍为旧画面；不能作为最新结果应用。';throw error;}
  }
  async function generate() {
    const {doc,layer}=current();
    if(maskOwner!==owner(doc,layer) || !masks.sampling)throw new Error('请先在源照片中选择可靠天空，并点击「用此处作为天空背景」。');
    await clearModel();
    const before=key(doc,layer);
    try {
      const uploadAPI=(path,...args)=>api(path.replace(/^\/images(?=\/|$)/,'/color-sources'),...args);
      meta=await host.core.executeAsModal(()=>host.uploadBackground(doc,layer,uploadAPI,report),{commandName:'读取颜色浮点输入'});
      sourceKey=before;
      if(sourceKey!==key(current().doc,current().layer))throw new Error('读取期间来源变化，请重新生成。');
      model=await task({op:'colorFit',image:meta.id,...masks});validate();
      $('colorSamples').src=model.samplingPreview;
      $('colorSummary').textContent='背景RGB中位数：'+model.median.map(x=>x.toPrecision(4)).join(' / ')+'；可靠候选 '+model.candidates+'，抽样 '+model.sampled+'，剔除 '+model.rejected+'。绿色为指定取样区，橙色为保护区；缩略图只表示位置。';
      $('colorView').selectedIndex=0;await show();
      status('颜色预览已准备；效果默认关闭，请按需启用并检查当前范围。');
    } catch(error) {await clearModel();throw error;}
  }
  async function capture(name) {
    const {doc,layer}=current();
    const before=key(doc,layer);
    const id=await host.core.executeAsModal(()=>host.uploadSelection(doc,api,report),{commandName:'读取颜色'+(name==='sampling'?'天空':'保护')+'选区'});
    if(before!==key(current().doc,current().layer)){await remove(id);throw new Error('读取期间来源变化，请重新读取选区。');}
    await clearModel();if(maskOwner && maskOwner!==owner(doc,layer))await clearMasks();
    await remove(masks[name]);masks[name]=id;maskOwner=owner(doc,layer);hint();status('选区快照已记录；生成建议时从当前源图重新读取，不使用临时预览。');
  }
  async function execute() {
    validate();if(shownKey!==renderKey() || !$('colorReviewed').checked)throw new Error('请先查看并确认当前参数的颜色结果。');
    const result=await rendered('result');validate();await closePreview();
    const doc=await host.applyFloatResult(meta,result.image,imageAPI,report,{label:'天空校色',suffix:'_sky_color',editableBase:true});
    await clearModel();await clearMasks();onApplied(doc);
    status('已在独立32位副本中创建可调效果层；原输入保留，效果层不透明度控制强度。原用户文档不变。');
  }
  function updateActions(busy=isBusy()) {
    let available=false,valid=false;try{current();available=true;validate();valid=true;}catch(e){}
    for(const id of ['colorSample','colorProtect','colorClear','colorGenerate'])$(id).disabled=busy || !available;
    for(const id of ['colorNeutralEnabled','colorNeutral','colorBoostEnabled','colorBoost','colorBackgroundFactor','colorBright'])$(id).disabled=busy;
    for(const id of ['colorPreview','colorView','colorReviewed'])$(id).disabled=busy || !valid;
    $('colorExecute').disabled=busy || !valid || shownKey!==renderKey() || !$('colorReviewed').checked;
    $('colorCancel').disabled=!jobID;
  }
  $('colorView').selectedIndex=0;
  $('colorOptions').addEventListener('click',()=>$('colorSettings').classList.toggle('expanded'));
  $('colorAdvancedOptions').addEventListener('click',()=>$('colorAdvanced').classList.toggle('expanded'));
  $('colorSample').addEventListener('click',()=>run(()=>capture('sampling')));
  $('colorProtect').addEventListener('click',()=>run(()=>capture('protection')));
  $('colorClear').addEventListener('click',()=>run(async()=>{await clearModel();await clearMasks();}));
  $('colorGenerate').addEventListener('click',()=>run(generate));
  $('colorPreview').addEventListener('click',()=>run(show));
  $('colorView').addEventListener('change',()=>run(show));
  $('colorExecute').addEventListener('click',()=>run(execute));
  $('colorReviewed').addEventListener('change',()=>updateActions());
  for(const id of ['colorNeutralEnabled','colorNeutral','colorBoostEnabled','colorBoost','colorBackgroundFactor','colorBright'])$(id).addEventListener('change',()=>{
    $('colorReviewed').checked=false;$('colorPreviewHint').textContent='参数已变化，当前画面仍为旧参数，请更新颜色预览。';updateActions();
  });
  for(const id of ['backgroundSource','backgroundUseActive'])$(id).addEventListener(id==='backgroundSource'?'change':'click',()=>{
    if(isUpdatingPickers())return;
    model=null;shownKey=null;$('colorReviewed').checked=false;$('colorPreviewHint').textContent='来源已切换，请重新指定天空并生成；旧颜色预览不能应用。';
    updateActions();
  });
  $('colorCancel').addEventListener('click',()=>{if(jobID)api('/jobs/'+jobID,undefined,false,'DELETE').catch(e=>status(e.message,true));});
  hint();
  return {updateActions,previewDocumentID:()=>preview?.docID,sync() {
    if(!meta || isBusy())return;try{validate();return;}catch(e){}
    model=null;shownKey=null;$('colorReviewed').checked=false;$('colorPreviewHint').textContent='来源或历史已变化；请重新读取生成，旧颜色预览不能应用。';updateActions();
  }};
}
module.exports={setup};
