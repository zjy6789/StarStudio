const host=require('./host.js');
const $=id=>document.getElementById(id);

function setup({run,api,job,status,report,selectedLayer,isBusy,stage,onApplied=()=>{},isUpdatingPickers=()=>false}) {
  let meta=null,model=null,sourceKey=null,preview=null,jobID=null,shownKey=null,target=null,targetOwner=null;
  const renders={};
  function owner(doc,layer){return [doc.id,layer.id,doc.width,doc.height,doc.bitsPerChannel].join(':');}
  function key(doc,layer){return owner(doc,layer)+':'+doc.activeHistoryState.id;}
  function current(){const selected=selectedLayer('backgroundSource');if(stage(selected.doc)!=='developed')throw new Error('本内建路径只验证已显影照片，请先确认照片阶段；不自动处理未准备线性母版。');return selected;}
  function hasTarget(){try{const {doc,layer}=current();return target && targetOwner===owner(doc,layer);}catch(e){return false;}}
  function validate(){const selected=current();if(!meta || !model || sourceKey!==key(selected.doc,selected.layer))throw new Error('降噪来源或历史已变化，请重新读取生成。');return selected;}
  function options(){const gray=meta?meta.components<=2:current().doc.mode===host.constants.DocumentMode.GRAYSCALE;return {strength:Number($('denoiseStrength').value),detail:Number($('denoiseDetail').value),mode:gray || $('denoiseMode').selectedIndex===1?'joint':'chroma',correlated:$('denoiseCorrelated').checked};}
  function renderKey(){return JSON.stringify(options());}
  function imageAPI(path,...args){return api(meta && path.startsWith('/images/'+meta.id+'?')?path.replace('/images/','/denoise-sources/'):path,...args);}
  async function remove(id,path='/images'){if(id)try{await api(path+'/'+id,undefined,false,'DELETE');}catch(e){console.error(e);}}
  async function closePreview(){const doc=host.app.documents.find(d=>d.id===preview?.docID);preview=null;if(doc)await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭降噪临时预览'});}
  async function clearModel(){
    const old=meta,ids=Object.values(renders).map(r=>r.image);meta=null;model=null;sourceKey=null;shownKey=null;
    for(const view of Object.keys(renders))delete renders[view];$('denoiseReviewed').checked=false;$('denoiseCorrelated').checked=false;$('denoiseSamples').src='';
    $('denoiseSummary').textContent='请重新读取背景并检查降噪效果。';await closePreview();await remove(old?.id,'/denoise-sources');for(const id of ids)await remove(id);
  }
  async function task(request){try{return await job(request,id=>{jobID=id;updateActions(true);});}finally{jobID=null;}}
  async function rendered(view){
    const signature=renderKey();if(renders[view]?.signature===signature)return renders[view];
    const next=await task({op:'denoiseRender',image:meta.id,options:options(),view});
    const old=renders[view];renders[view]={...next,signature};await remove(old?.image);return renders[view];
  }
  async function show(){
    validate();const view=['result','original','weights'][$('denoiseView').selectedIndex] || 'result',signature=renderKey();
    try{
      const next=view==='original'?null:await rendered(view);validate();if(signature!==renderKey())throw new Error('计算期间降噪参数变化，请重新预览。');
      preview=await host.canvasFloatPreview(preview,next?.image || null,meta,view==='weights'?'允许降噪范围':'背景降噪结果',imageAPI,report,'背景降噪',true);
      if(view==='result')shownKey=signature;
      $('denoisePreviewHint').textContent=view==='original'?'正在查看同一原输入快照；请在相同显示条件比较。':view==='weights'?'白色允许调整，黑色保留；透明边界邻域不足时保守保留原像素。'
        :'降噪预览已更新。'+(options().mode==='chroma'?'仅调整色噪，保留工作RGB亮度。':'联合模式会改变亮度，请检查暗弱结构。')+(next?.stats?' 结果含 '+next.stats.negativeChannels+' 个负值、'+next.stats.aboveOneChannels+' 个超1通道，未裁切。':'');
    }catch(error){shownKey=null;$('denoisePreviewHint').textContent='降噪预览未更新；当前可能仍为旧画面，不能当作最新结果应用。';throw error;}
  }
  async function generate(){
    const {doc,layer}=current(),whole=$('denoiseScope').selectedIndex===1;
    if(!whole && !hasTarget())throw new Error('请先读取背景作用选区，或明确选择整层无星背景。');
    await clearModel();const before=key(doc,layer);
    try{
      const uploadAPI=(path,...args)=>api(path.replace(/^\/images(?=\/|$)/,'/denoise-sources'),...args);
      meta=await host.core.executeAsModal(()=>host.uploadBackground(doc,layer,uploadAPI,report),{commandName:'读取背景降噪浮点输入'});sourceKey=before;
      if(sourceKey!==key(current().doc,current().layer))throw new Error('读取期间来源变化，请重新生成。');
      model=await task({op:'denoiseFit',image:meta.id,scope:whole?'starless':'selection',target:whole?undefined:target,confirmedStarless:whole});validate();
      $('denoiseSamples').src=model.samplingPreview;$('denoiseSummary').textContent='绿色框为 '+model.patches+' 处背景参考块。若落在星云、地景或纹理上，请修改范围。'+(!model.sigma?' 未估计到高频背景噪声，默认原样输出。':'')+(model.backgroundSigma>3*model.sigma?' 参考块有较多低频变化，默认保留；仅在确认是背景色噪时使用高级相关模式。':'');
      $('denoiseEstimate').textContent='高频估计σ '+model.sigma.toPrecision(5)+'；局部平面残差σ '+(model.backgroundSigma??model.sigma).toPrecision(5)+'。后者可能包含真实结构，不是精确传感器测噪。';
    }catch(error){await clearModel();throw error;}
    // A render can refuse a numerical range even though the fitted snapshot is
    // valid. Keep its reference blocks available for an explicit parameter retry.
    $('denoiseView').selectedIndex=0;await show();status('背景降噪预览已准备；先检查暗弱细节，再确认创建副本。');
  }
  async function capture(){
    const {doc,layer}=current(),before=key(doc,layer);
    const id=await host.core.executeAsModal(()=>host.uploadSelection(doc,api,report),{commandName:'读取背景降噪作用选区'});
    if(before!==key(current().doc,current().layer)){await remove(id);throw new Error('读取期间来源变化，请重新读取。');}
    await clearModel();await remove(target);target=id;targetOwner=owner(doc,layer);$('denoiseScope').selectedIndex=0;
    status('背景范围快照已记录；参数重算不重新读取选区。');
  }
  async function execute(){
    validate();if(shownKey!==renderKey() || !$('denoiseReviewed').checked)throw new Error('请先比较并确认当前参数的降噪结果。');
    const result=await rendered('result');validate();await closePreview();
    const doc=await host.applyFloatResult(meta,result.image,imageAPI,report,{label:'背景降噪',suffix:'_background_denoised',editableBase:true});
    await clearModel();await remove(target);target=null;targetOwner=null;onApplied(doc);
    status('已创建独立32位降噪副本；原输入保留，可调整效果层不透明度。原文档未改写。');
  }
  function updateActions(busy=isBusy()){
    let available=false,valid=false;try{current();available=true;validate();valid=true;}catch(e){}
    for(const id of ['denoiseCapture','denoiseScope','denoiseGenerate'])$(id).disabled=busy || !available;
    for(const id of ['denoiseStrength','denoiseDetail','denoiseMode','denoiseCorrelated'])$(id).disabled=busy;
    for(const id of ['denoisePreview','denoiseView','denoiseReviewed'])$(id).disabled=busy || !valid;
    let signature=null;try{signature=renderKey();}catch(e){}
    $('denoiseExecute').disabled=busy || !valid || shownKey!==signature || !$('denoiseReviewed').checked;
    $('denoiseCancel').disabled=!jobID;
    $('denoiseMaskHint').textContent=$('denoiseScope').selectedIndex===1?'将处理整层无星背景；有地景或星点时请改用背景选区。':hasTarget()?'已记录当前图层的背景范围；选区外保持原像素。':'尚未为当前图层读取背景范围。';
  }
  function dirty(){shownKey=null;$('denoiseReviewed').checked=false;$('denoisePreviewHint').textContent='参数已变化，当前仍为旧画面，请更新预览。';updateActions();}
  $('denoiseScope').selectedIndex=0;$('denoiseMode').selectedIndex=0;$('denoiseView').selectedIndex=0;
  $('denoiseOptions').addEventListener('click',()=>$('denoiseSettings').classList.toggle('expanded'));
  $('denoiseAdvancedOptions').addEventListener('click',()=>$('denoiseAdvanced').classList.toggle('expanded'));
  $('denoiseCapture').addEventListener('click',()=>run(capture));$('denoiseGenerate').addEventListener('click',()=>run(generate));
  $('denoisePreview').addEventListener('click',()=>run(show));$('denoiseView').addEventListener('change',()=>run(show));$('denoiseExecute').addEventListener('click',()=>run(execute));
  $('denoiseReviewed').addEventListener('change',()=>updateActions());
  for(const id of ['denoiseStrength','denoiseDetail','denoiseMode','denoiseCorrelated'])$(id).addEventListener('change',dirty);
  $('denoiseScope').addEventListener('change',()=>{model=null;$('denoiseCorrelated').checked=false;dirty();});
  for(const id of ['backgroundSource','backgroundUseActive'])$(id).addEventListener(id==='backgroundSource'?'change':'click',()=>{if(!isUpdatingPickers()){model=null;$('denoiseCorrelated').checked=false;dirty();}});
  $('denoiseCancel').addEventListener('click',()=>{if(jobID)api('/jobs/'+jobID,undefined,false,'DELETE').catch(e=>status(e.message,true));});
  return {updateActions,previewDocumentID:()=>preview?.docID,sync(){
    if(!meta || isBusy())return;try{validate();return;}catch(e){}
    model=null;shownKey=null;$('denoiseReviewed').checked=false;$('denoiseCorrelated').checked=false;$('denoisePreviewHint').textContent='来源或历史变化，请重新读取生成，旧降噪预览不能应用。';updateActions();
  }};
}
module.exports={setup};
