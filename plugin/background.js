const host=require('./host.js');
const $=id=>document.getElementById(id);

function setup({run,api,job,status,report,selectedLayer,useActive,isBusy,stage,onApplied=()=>{},isUpdatingPickers=()=>false}) {
  let meta=null,model=null,sourceKey=null,preview=null,jobID=null,maskOwner=null;
  const masks={},renders={};
  function owner(doc,layer) {return [doc.id,layer.id,doc.width,doc.height].join(':');}
  function key(doc,layer) {return owner(doc,layer)+':'+doc.activeHistoryState.id+':'+doc.bitsPerChannel;}
  async function remove(id) {if(id)try{await api('/images/'+id,undefined,false,'DELETE');}catch(e){console.error(e);}}
  async function closePreview() {
    const doc=host.app.documents.find(d=>d.id===preview?.docID);preview=null;
    if(doc) await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭背景校正临时预览'});
  }
  async function clearModel() {
    model=null;sourceKey=null;$('backgroundReviewed').checked=false;
    $('backgroundSamples').src='';$('backgroundSummary').textContent='请生成建议，检查取样与拟合背景。';
    const previous=[meta?.id,...Object.values(renders).map(x=>x.image)];meta=null;
    for(const view of Object.keys(renders)) delete renders[view];
    await closePreview();for(const id of previous) await remove(id);
  }
  async function clearMasks() {for(const name of Object.keys(masks)){await remove(masks[name]);delete masks[name];}maskOwner=null;maskHint();}
  function maskHint() {$('backgroundMaskHint').textContent=(masks.protection?'已使用主体保护选区。':'未设置主体保护。')+(masks.sampling?'仅在指定背景选区取样。':'自动网格取样。')+' 选区只控制拟合；主体仍减去估计的梯度。';}
  function current() {
    const selected=selectedLayer('backgroundSource');
    if(stage(selected.doc)!=='developed') throw new Error('请先在「照片阶段」确认已显影照片。本页暂不处理未准备的线性HDR母版。');
    return selected;
  }
  function validate() {
    const {doc,layer}=current();
    if(!model || !meta || sourceKey!==key(doc,layer)) throw new Error('源图层或历史已变化，请重新生成背景建议。');
    return {doc,layer};
  }
  async function task(request) {return job(request,id=>{jobID=id;updateActions(true);}).finally(()=>{jobID=null;});}
  function strength() {const amount=Number($('backgroundStrength').value);if(!Number.isFinite(amount)||amount<0||amount>1)throw new Error('强度需要在0到1之间。');return amount;}
  async function rendered(view) {
    const amount=view==='model'?0:strength();
    if(renders[view] && renders[view].strength===amount) return renders[view];
    const next=await task({op:'backgroundRender',image:meta.id,strength:amount,view});
    const previous=renders[view];renders[view]={...next,strength:amount};await remove(previous?.image);
    return renders[view];
  }
  async function show() {
    validate();const view=['result','model','original'][$('backgroundView').selectedIndex] || 'result';
    const result=view==='original'?null:await rendered(view);
    validate();
    preview=await host.canvasBackgroundPreview(preview,result?.image || null,meta,
      view==='model'?'拟合背景（含保留的基线）':'背景校正结果',api,report);
    const stats=result?.stats;
    $('backgroundPreviewHint').textContent=view==='original'?'正在查看本次输入快照；源照片未修改。'
      :view==='model'?'正在查看拟合背景；实际只减去它相对基线的起伏。绿点为参与拟合的样本，橙点为自动排除的亮样本。'
      :'当前强度 '+strength()+' · 完整分辨率32位结果。'+(stats?'范围 '+stats.minimum.toPrecision(5)+' 至 '+stats.maximum.toPrecision(5)+'；保留 '+stats.negativeChannels+' 个负值通道、'+stats.aboveOneChannels+' 个超1通道。':'');
    status('背景预览已更新；检查主体与天空后，可输出独立副本。');
  }
  async function generate() {
    const {doc,layer}=current();await clearModel();
    if(maskOwner && maskOwner!==owner(doc,layer)) await clearMasks();
    try {
      meta=await host.core.executeAsModal(()=>host.uploadBackground(doc,layer,api,report),{commandName:'读取背景浮点输入'});
      sourceKey=key(doc,layer);
      model=await task({op:'backgroundFit',image:meta.id,...masks});
      $('backgroundSamples').src=model.samplingPreview;
      $('backgroundSummary').textContent='一阶稳健平面 · '+model.samples+' 个样本，排除 '+model.rejected+' 个亮样本。请检查绿点是否落在真实背景上；星云满幅时请手动限定背景或跳过。';
      $('backgroundView').selectedIndex=0;await show();
    } catch(error) {await clearModel();throw error;}
  }
  async function capture(name) {
    const {doc,layer}=current();
    if(maskOwner && maskOwner!==owner(doc,layer)) await clearMasks();
    const id=await host.core.executeAsModal(()=>host.uploadSelection(doc,api,report),{commandName:'读取背景取样选区'});
    await clearModel();await remove(masks[name]);masks[name]=id;maskOwner=owner(doc,layer);maskHint();
    status('选区已记录。可取消源照片中的选区后，重新生成建议。');
  }
  async function execute() {
    validate();
    if(!$('backgroundReviewed').checked) throw new Error('请先检查取样和拟合背景，并勾选确认，避免把银河或星云当成光害。');
    const result=await rendered('result');
    validate();
    await closePreview();
    const doc=await host.applyBackgroundResult(meta,result.image,api,report);
    await clearModel();await clearMasks();
    onApplied(doc);
    status('已在独立32位副本中创建校正层，原照片保持不变；可切换保留的原输入或撤销本次输出。');
    return doc;
  }
  function updateActions(busy=isBusy()) {
    let selected=false;try{selected=!!selectedLayer('backgroundSource').layer;}catch(e){}
    for(const id of ['backgroundGenerate','backgroundProtect','backgroundSample','backgroundClear']) $(id).disabled=busy || !selected;
    for(const id of ['backgroundView','backgroundStrength','backgroundStrengthRange','backgroundReviewed','backgroundPreview']) $(id).disabled=busy || !model;
    $('backgroundExecute').disabled=busy || !model || !$('backgroundReviewed').checked;
    $('backgroundCancel').disabled=!jobID;
  }
  $('backgroundStrength').value=.5;$('backgroundStrengthRange').value=.5;$('backgroundView').selectedIndex=0;
  $('backgroundOptions').addEventListener('click',()=>$('backgroundSettings').classList.toggle('expanded'));
  $('backgroundGenerate').addEventListener('click',()=>run(generate));
  $('backgroundPreview').addEventListener('click',()=>run(show));
  $('backgroundExecute').addEventListener('click',()=>run(execute));
  $('backgroundProtect').addEventListener('click',()=>run(()=>capture('protection')));
  $('backgroundSample').addEventListener('click',()=>run(()=>capture('sampling')));
  $('backgroundClear').addEventListener('click',()=>run(async()=>{await clearModel();await clearMasks();}));
  $('backgroundUseActive').addEventListener('click',()=>run(async()=>{useActive('backgroundSource');await clearModel();await clearMasks();}));
  $('backgroundSource').addEventListener('change',()=>{if(!isUpdatingPickers())return run(async()=>{await clearModel();await clearMasks();});});
  $('backgroundView').addEventListener('change',()=>run(show));
  $('backgroundReviewed').addEventListener('change',()=>updateActions());
  $('backgroundStrengthRange').addEventListener('input',()=>{$('backgroundStrength').value=$('backgroundStrengthRange').value;$('backgroundPreviewHint').textContent='强度已变化，当前画面仍为上一次预览；松开滑块后更新。';});
  $('backgroundStrengthRange').addEventListener('change',()=>run(show));
  $('backgroundStrength').addEventListener('change',()=>{$('backgroundStrengthRange').value=$('backgroundStrength').value;return run(show);});
  $('backgroundCancel').addEventListener('click',()=>{if(jobID)api('/jobs/'+jobID,undefined,false,'DELETE').catch(e=>status(e.message,true));});
  maskHint();
  return {updateActions,previewDocumentID:()=>preview?.docID,
    sync(next) {
      if(!meta || isBusy()) return;
      let changed=true;try{const {doc,layer}=selectedLayer('backgroundSource');changed=key(doc,layer)!==sourceKey;}catch(e){}
      if(changed) {model=null;$('backgroundReviewed').checked=false;$('backgroundPreviewHint').textContent='源照片已变化；请重新生成建议，旧预览不能作为当前结果。';updateActions();}
    }};
}
module.exports={setup};
