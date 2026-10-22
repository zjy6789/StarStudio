const host=require('./host.js');
const action=require('photoshop').action;
const $=id=>document.getElementById(id);

function snapshot(doc,original,model) {
  host.documentInfo(doc);
  for(const layer of [original,model].filter(Boolean)) {
    if(!doc.layers.some(item=>item.id===layer.id) || layer.isClippingMask || layer.blendMode!==host.constants.BlendMode.NORMAL
        || layer.opacity!==100 || layer.fillOpacity!==100)
      throw new Error('原图与模型参考须为顶层、非剪贴、正常混合、100%不透明度和填充的像素或智能对象；不自动改变来源层。');
  }
  if(model?.id===original.id)throw new Error('模型参考与原图请选择不同图层；没有参考时可留空。');
  const bounds=doc.selection.bounds;
  if(!bounds)throw new Error('请先在源照片选中需要检查的星点区域；比较使用选区外接矩形。');
  const rectangle={left:Math.max(0,Math.floor(bounds.left)),top:Math.max(0,Math.floor(bounds.top)),
    right:Math.min(doc.width,Math.ceil(bounds.right)),bottom:Math.min(doc.height,Math.ceil(bounds.bottom))};
  if(Object.values(rectangle).some(x=>!Number.isFinite(x)) || rectangle.right<=rectangle.left || rectangle.bottom<=rectangle.top)
    throw new Error('选区外接矩形在画布内没有有效范围。');
  const key=JSON.stringify([doc.id,doc.width,doc.height,doc.bitsPerChannel,doc.colorProfileName,doc.activeHistoryState.id,original.id,model?.id,rectangle]);
  return {doc,original,model,bounds:rectangle,key};
}
function checkCopy(source,copy) {
  if(copy.bitsPerChannel!==host.constants.BitsPerChannelType.THIRTYTWO || copy.mode!==source.mode
      || copy.colorProfileName!==source.colorProfileName || copy.width!==source.width || copy.height!==source.height)
    throw new Error('独立副本的位深、颜色配置或尺寸不匹配；原文档未改变。');
}
async function mergedLayer(copy,name) {
  if(copy.layers[0].isBackgroundLayer) {
    const result=await action.batchPlay([{_obj:'set',_target:[{_ref:'layer',_property:'background'},{_ref:'document',_id:copy.id}],to:{_obj:'layer'},_options:{dialogOptions:'dontDisplay'}}],{});
    if(result[0]?._obj==='error')throw new Error(result[0].message);
  }
  const layer=copy.layers[0];layer.name=name;return layer;
}
async function createComparison(source,register=()=>{}) {
  let created;
  const previous=host.app.activeDocument;
  const state=await host.core.executeAsModal(async context=>{
    try {
      if(snapshot(source.doc,source.original,source.model).key!==source.key)throw new Error('来源已变化，请重新创建比较。');
      const copy=created=await source.doc.duplicate('残留检查 · '+source.doc.title,true);register(copy.id);
      const current=await mergedLayer(copy,'当前可见合成快照');
      const original=await source.original.duplicate(copy);original.name='原图快照';
      const model=source.model?await source.model.duplicate(copy):null;
      if(model)model.name='模型背景参考快照';
      copy.bitsPerChannel=host.constants.BitsPerChannelType.THIRTYTWO;
      checkCopy(source.doc,copy);
      const roles={current:current.id,original:original.id,model:model?.id ?? null};
      if(Object.values(roles).filter(id=>id!=null).some(id=>!copy.layers.some(layer=>layer.id===id)))
        throw new Error('副本转换后图层角色失效，已停止比较。');
      for(const layer of copy.layers){layer.blendMode=host.constants.BlendMode.NORMAL;layer.opacity=100;layer.fillOpacity=100;layer.visible=layer.id===current.id;}
      if(context.isCancelled)throw new Error('比较已取消。');
      await copy.crop(source.bounds);await copy.selection.deselect();
      if(copy.width!==source.bounds.right-source.bounds.left || copy.height!==source.bounds.bottom-source.bounds.top)
        throw new Error('比较裁剪尺寸不匹配；未重采样源照片。');
      if(snapshot(source.doc,source.original,source.model).key!==source.key || context.isCancelled)throw new Error('创建期间来源变化或取消，请重新比较。');
      host.app.activeDocument=copy;
      return {docID:copy.id,roles,sourceKey:source.key};
    } catch(error) {
      if(created && host.app.documents.some(doc=>doc.id===created.id))await created.closeWithoutSaving();
      if(previous && host.app.documents.some(doc=>doc.id===previous.id))host.app.activeDocument=previous;
      throw error;
    }
  },{commandName:'创建局部残留比较副本'});
  state.history=created.activeHistoryState.id;return state;
}
async function showComparison(state,role) {
  const doc=host.app.documents.find(item=>item.id===state.docID);
  if(!doc)throw new Error('比较副本已关闭，请重新创建。');
  if(doc.activeHistoryState.id!==state.history)throw new Error('比较副本已有手工编辑；请保留该文档并新建比较，不覆盖手工内容。');
  const id=state.roles[role];
  if(id==null || !doc.layers.some(layer=>layer.id===id))throw new Error('未提供该比较角色；缺失的模型参考不能反推。');
  await host.transaction(doc,'切换残留比较',async()=>{
    for(const layer of doc.layers)layer.visible=layer.id===id;
    host.app.activeDocument=doc;
  });
  state.history=doc.activeHistoryState.id;
}
async function createRepair(source,api,report) {
  let created,selection;
  const previous=host.app.activeDocument;
  return host.core.executeAsModal(async context=>{
    try {
      if(snapshot(source.doc,source.original,source.model).key!==source.key)throw new Error('来源已变化，请重新比较。');
      selection=await host.uploadSelection(source.doc,api,report);
      created=await source.doc.duplicate('局部修补副本 · '+source.doc.title,true);
      created.bitsPerChannel=host.constants.BitsPerChannelType.THIRTYTWO;checkCopy(source.doc,created);
      await mergedLayer(created,'当前合成 · 待手动局部修补');
      await host.applySelection(created,selection,{width:source.doc.width,height:source.doc.height},false,api,report,context);
      if(snapshot(source.doc,source.original,source.model).key!==source.key || context.isCancelled)throw new Error('来源变化或操作取消，未提交修补副本。');
      host.app.activeDocument=created;return created;
    } catch(error) {
      if(created)await created.closeWithoutSaving();
      if(previous && host.app.documents.some(doc=>doc.id===previous.id))host.app.activeDocument=previous;
      throw error;
    } finally {
      if(selection)try{await api('/images/'+selection,undefined,false,'DELETE');}catch(error){console.error(error);}
    }
  },{commandName:'创建保留精确选区的修补副本'});
}

function setup({run,api,status,report,selectedLayer,value,isBusy,isUpdatingPickers=()=>false,onOpened=()=>{}}) {
  let state=null;
  const previews=new Set();
  function current() {
    const {doc,layer}=selectedLayer('residualOriginal');
    const selected=value('residualModel')==null?null:selectedLayer('residualModel');
    if(selected && selected.doc.id!==doc.id)throw new Error('原图与模型须来自同一文档。');
    return snapshot(doc,layer,selected?.layer);
  }
  function validate() {
    const source=current();
    if(!state || state.sourceKey!==source.key || !$('residualConfirmed').checked)throw new Error('来源、选区或角色已变化，请确认并重新创建比较。');
    const doc=host.app.documents.find(item=>item.id===state.docID);
    if(!doc || doc.activeHistoryState.id!==state.history)throw new Error('比较副本已关闭或编辑，请保留已有工作并新建比较。');
    return source;
  }
  function updateActions(busy=isBusy()) {
    let available=false,valid=false;
    try{current();available=true;validate();valid=true;}catch(error){}
    for(const id of ['residualOriginal','residualModel','residualConfirmed'])$(id).disabled=busy;
    $('residualCompare').disabled=busy || !available || !$('residualConfirmed').checked;
    for(const id of ['residualView','residualRepair'])$(id).disabled=busy || !valid;
    $('residualModelView').disabled=state?.roles.model==null;
    for(const id of previews)if(!host.app.documents.some(doc=>doc.id===id))previews.delete(id);
  }
  $('residualOptions').addEventListener('click',()=>$('residualSettings').classList.toggle('collapsed'));
  $('residualCompare').addEventListener('click',()=>run(async()=>{
    if(!$('residualConfirmed').checked)throw new Error('请确认原图与可选模型参考来自同次分离、同一画布。');
    const source=current();state=await createComparison(source,id=>previews.add(id));
    $('residualView').selectedIndex=0;
    const b=source.bounds;
    $('residualSummary').textContent=(b.right-b.left)+' × '+(b.bottom-b.top)+' 原图像素 · 32位独立比较快照 · '+(source.model?'含原图/模型参考/当前合成':'未提供模型参考，仅比较原图/当前合成')+'。原文档未改写；外接矩形只用于观察。';
    status('局部比较已创建；切换角色使用同一文档与显示条件，不自动提亮或修补。');
  }));
  $('residualView').addEventListener('change',()=>run(async()=>{
    validate();await showComparison(state,['current','original','model'][$('residualView').selectedIndex]);
  }));
  $('residualRepair').addEventListener('click',()=>run(async()=>{
    const source=validate(),copy=await createRepair(source,api,report);onOpened(copy,source.doc);
    status('已创建全尺寸32位当前合成副本并保留精确选区。请用PS局部工具手动处理；未自动执行修补，原文档保留。');
  }));
  for(const id of ['residualOriginal','residualModel'])$(id).addEventListener('change',()=>{
    if(isUpdatingPickers())return;
    $('residualConfirmed').checked=false;updateActions();
  });
  $('residualConfirmed').addEventListener('change',()=>updateActions());
  return {updateActions,isPreview:id=>previews.has(id),sync(){updateActions();}};
}
module.exports={setup,snapshot,createComparison,showComparison,createRepair};
