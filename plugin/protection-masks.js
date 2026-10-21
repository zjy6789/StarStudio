const host=require('./host.js');
const $=id=>document.getElementById(id);

function setup({run,api,job,status,report,selectedLayer,workingDocument,starRelation,isBusy,isUpdatingPickers=()=>false}) {
  let source=null,result=null,renderKey=null,jobID=null;
  function mode() {return ['stars','outside','subject'][$('maskMode').selectedIndex] || 'stars';}
  function current() {
    if(mode()==='subject') return {doc:workingDocument(),layer:null,encoding:'black'};
    const selected=selectedLayer('processSource'),relation=starRelation(selected.doc,selected.layer);
    if(!relation.known) throw new Error('星点编码未知，请先在「手动指定分离关系」确认黑底、相加或灰底关系。');
    return {...selected,encoding:relation.encoding};
  }
  function key({doc,layer,encoding}) {return [doc.id,layer?.id || 0,doc.width,doc.height,doc.bitsPerChannel,doc.activeHistoryState.id,encoding].join(':');}
  function options() {
    const encoding=mode()==='subject'?'black':current().encoding;
    return {mode:mode(),encoding,bits:source?.size || 32,low:Number($('maskLow').value),high:Number($('maskHigh').value),grow:Number($('maskGrow').value),feather:Number($('maskFeather').value)};
  }
  async function remove(id,path='/images') {if(id)try{await api(path+'/'+id,undefined,false,'DELETE');}catch(e){console.error(e);}}
  async function clearResult() {
    const old=result;result=null;renderKey=null;$('maskReviewed').checked=false;$('maskPreview').src='';
    $('maskSummary').textContent='覆盖尚未生成或已变化，请重新生成并检查。';
    await remove(old?.image);
  }
  async function clear() {const old=source;source=null;await clearResult();await remove(old?.id,old?.path);}
  function validate() {
    const selected=current();
    if(!source || key(selected)!==source.key) throw new Error('来源文档、图层或历史已变化，请重新读取并生成蒙版。');
    if(!result || renderKey!==JSON.stringify(options())) throw new Error('蒙版参数已变化，请重新生成覆盖预览。');
    return selected;
  }
  async function task(request) {try{return await job(request,id=>{jobID=id;updateActions(true);});}finally{jobID=null;}}
  async function generate() {
    const selected=current();
    if(source && source.key!==key(selected)) await clear();
    if(!source) {
      if(mode()==='subject') throw new Error('请先在源照片建立主体选区，并点击「读取主体选区」。');
      // Keep encoded 8/16-bit gray neutral intact; never promote or convert the source.
      const uploadAPI=(path,...args)=>api(path.replace(/^\/images(?=\/|$)/,'/mask-sources'),...args);
      const before=key(selected);
      const meta=await host.core.executeAsModal(()=>host.upload(selected.doc,selected.layer,uploadAPI,report),{commandName:'读取保护蒙版星点信号'});
      if(before!==key(current())) {await remove(meta.id,'/mask-sources');throw new Error('读取期间来源变化，请重试。');}
      source={...meta,path:'/mask-sources',key:before};
    }
    await clearResult();
    const requested=JSON.stringify(options());
    const next=await task({op:'maskGenerate',image:source.id,options:options()});
    try {
      if(source.key!==key(current()) || requested!==JSON.stringify(options())) throw new Error('计算期间来源或参数变化，请重新生成。');
      result=next;renderKey=requested;$('maskPreview').src=next.preview;
      $('maskSummary').textContent=next.width+' × '+next.height+' · 白区等效覆盖 '+(next.whiteCoverage*100).toFixed(2)+'% · '+next.corePixels+' 个接近完全覆盖的像素。';
      status('覆盖预览已生成；检查白区及反选设置后，再应用选区或保存蒙版。');
    } catch(error) {await remove(next.image);throw error;}
  }
  async function capture() {
    const selected=current();if(mode()!=='subject') throw new Error('请先选择主体选区来源。');
    const before=key(selected);
    const id=await host.core.executeAsModal(()=>host.uploadSelection(selected.doc,api,report),{commandName:'读取主体保护选区'});
    if(before!==key(current())) {await remove(id);throw new Error('读取期间来源变化，请重试。');}
    await clear();
    source={id,path:'/images',size:32,key:before};
    await generate();
  }
  function hint() {
    const subject=mode()==='subject';
    $('maskSourceHint').textContent=subject?'使用源照片的选区快照；改变选区后需再次点击读取。':'使用上方选择的星点原图层，按已确认关系解码；不包含本页尚未输出的加工效果。'+(mode()==='outside'?'星点外仍可能含星云、地景和残留，不是自动天空识别。':'白色代表星点覆盖。');
    $('maskApplyHint').textContent=$('maskInvert').checked?'应用时选择白区以外，以保护白区。':'应用时选择白色区域，后续编辑作用于白区。';
  }
  function updateActions(busy=isBusy()) {
    let available=false,valid=false;
    try {current();available=true;validate();valid=true;}catch(e){}
    for(const id of ['maskGenerate','maskMode','maskGrow','maskFeather','maskInvert']) $(id).disabled=busy || (!available && id==='maskGenerate');
    for(const id of ['maskLow','maskHigh']) $(id).disabled=busy || mode()==='subject';
    $('maskReadSelection').disabled=busy || mode()!=='subject' || !available;
    $('maskReviewed').disabled=busy || !valid;
    for(const id of ['maskApply','maskSave']) $(id).disabled=busy || !valid || !$('maskReviewed').checked;
    $('maskCancel').disabled=!jobID;
    hint();
  }
  $('maskMode').selectedIndex=0;$('maskInvert').checked=true;
  $('maskOptions').addEventListener('click',()=>$('maskSettings').classList.toggle('expanded'));
  $('maskGenerate').addEventListener('click',()=>run(generate));
  $('maskReadSelection').addEventListener('click',()=>run(capture));
  $('maskApply').addEventListener('click',()=>run(async()=>{
    const {doc}=validate();if(!$('maskReviewed').checked) throw new Error('请先检查并确认覆盖范围。');
    await host.applySelection(doc,result.image,result,$('maskInvert').checked,api,report);
    source.key=key(current());
    status('选区已应用到源照片；图层像素未修改，可用快速蒙版继续编辑或撤销。');
  }));
  $('maskSave').addEventListener('click',()=>run(async()=>{
    validate();if(!$('maskReviewed').checked) throw new Error('请先检查并确认覆盖范围。');
    const file=await require('uxp').storage.localFileSystem.getFileForSaving('StarStudio_'+mode()+'_mask.tif',{types:['tif','tiff']});
    if(!file)return;validate();
    const saved=await task({op:'maskSave',image:result.image,output:file.nativePath});
    status('已保存完整尺寸32位灰度覆盖蒙版：'+saved.path+'；白区与预览相同。');
  }));
  $('maskMode').addEventListener('change',()=>run(async()=>{
    const subject=mode()==='subject';$('maskInvert').checked=mode()!=='outside';
    $('maskGrow').value=subject?0:2;$('maskFeather').value=subject?0:1;
    if(source && (subject!==(source.path==='/images'))) await clear();else await clearResult();
  }));
  for(const id of ['maskLow','maskHigh','maskGrow','maskFeather']) $(id).addEventListener('change',()=>run(clearResult));
  for(const id of ['maskInvert','maskReviewed']) $(id).addEventListener('change',()=>{if(id==='maskInvert')$('maskReviewed').checked=false;updateActions();});
  for(const id of ['processSource','processRelation']) $(id).addEventListener('change',()=>{if(!isUpdatingPickers())return run(clear);});
  $('maskCancel').addEventListener('click',()=>{if(jobID)api('/jobs/'+jobID,undefined,false,'DELETE').catch(e=>status(e.message,true));});
  hint();
  return {updateActions,sync() {
    if(!source || isBusy())return;
    try{if(source.key===key(current()))return;}catch(e){}
    clear().catch(e=>status(e.message,true));
  }};
}
module.exports={setup};
