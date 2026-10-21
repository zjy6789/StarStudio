const host=require('./host.js');
const fs=require('uxp').storage.localFileSystem;
const $=id=>document.getElementById(id);

function setup({run,api,job,status,report,isBusy,onSource=()=>{},onApplied=()=>{}}) {
  let selected=null,lastPrepared=null,info=null,meta=null,temporary=null,sourceID=null,preview=null;
  let result=null,resultKey=null,shownKey=null,jobID=null,opened=false;
  let temporaryRoot=null,temporaryFile=null;
  const names=['amount','protection','background'];
  function settings() {return Object.fromEntries(names.map(name=>[name,Number($('stretch_'+name).value)]));}
  function currentKey() {return JSON.stringify(settings());}
  async function remove(id) {if(id)try{await api('/images/'+id,undefined,false,'DELETE');}catch(e){console.error(e);}}
  async function closePreview() {
    const doc=host.app.documents.find(d=>d.id===preview?.docID);
    if(doc)await host.core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'关闭临时提亮预览'});
    preview=null;
  }
  async function dropTemporary() {
    if(!temporary)return;
    const normalize=path=>path.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
    const root=normalize(temporaryRoot),target=normalize(temporary.nativePath);
    if(!/^(?:[a-z]:\/|\/)/.test(target) || !target.startsWith(root+'/starstudio-stretch-') || target.split('/').includes('..'))
      throw new Error('临时目录位置异常，已停止清理。');
    const folder=temporary;
    if(temporaryFile) {
      const entries=await folder.getEntries();
      if(entries.some(e=>e.isFile && normalize(e.nativePath)===normalize(temporaryFile.nativePath)))await temporaryFile.delete();
      temporaryFile=null;
    }
    if((await folder.getEntries()).length)throw new Error('临时目录含其他条目，已保留；不会递归删除未知文件。');
    await folder.delete();temporary=null;
  }
  async function clear() {
    const keys=[info?.image,result?.image];info=null;result=null;meta=null;resultKey=null;shownKey=null;opened=false;
    try {
      await closePreview();
      const source=host.app.documents.find(d=>d.id===sourceID);
      if(source)await host.core.executeAsModal(()=>source.closeWithoutSaving(),{commandName:'关闭本次临时线性输入'});
      sourceID=null;await dropTemporary();
    } finally {for(const key of keys)await remove(key);}
  }
  function choose(file) {
    selected=file;$('stretchConfirmed').checked=false;
    $('stretchSummary').textContent=file?file.name+' · 确认仍未拉伸后，读取并建议参数。':'选择母版准备生成的原样TIFF副本。';
    $('stretchState').textContent='尚未应用拉伸；原文件始终保留。';
  }
  async function task(request) {return job(request,id=>{jobID=id;updateActions(true);}).finally(()=>{jobID=null;});}
  function setSettings(values) {for(const name of names)for(const suffix of ['', 'Range'])$('stretch_'+name+suffix).value=values[name];}
  async function openInput() {
    const current=host.app.documents.find(d=>d.id===sourceID);
    if(meta && current) {
      if(current.width!==info.width || current.height!==info.height || current.bitsPerChannel!==host.constants.BitsPerChannelType.THIRTYTWO || current.mode!==host.constants.DocumentMode.RGB || current.colorProfileName!==info.profile)
        throw new Error('临时输入文档的尺寸或颜色已改变，请重新读取准备副本。');
      return;
    }
    if(!info || !selected)throw new Error('请先读取范围准备副本。');
    await dropTemporary();
    const parent=await fs.getTemporaryFolder();temporaryRoot=parent.nativePath;
    temporary=await parent.createFolder('starstudio-stretch-'+Date.now());
    try {
    const copy=await selected.copyTo(temporary);temporaryFile=copy;
    await host.core.executeAsModal(async()=>{
      const before=new Set(Array.from(host.app.documents,d=>d.id));
      const response=await require('photoshop').action.batchPlay([{_obj:'open',null:{_path:fs.createSessionToken(copy),_kind:'local'},_options:{dialogOptions:'dontDisplay'}}],{});
      if(response[0]?._obj==='error')throw new Error(response[0].message);
      const doc=host.app.activeDocument;
      if(before.has(doc.id))throw new Error('未能建立独立的临时输入文档；用户文档未修改。');
      sourceID=doc.id;
      if(doc.width!==info.width || doc.height!==info.height || doc.bitsPerChannel!==host.constants.BitsPerChannelType.THIRTYTWO || doc.mode!==host.constants.DocumentMode.RGB || doc.colorProfileName!==info.profile)
        throw new Error('PS输入尺寸、32位或线性ProPhoto配置不符；请保留嵌入配置后重试。');
      meta={id:info.image,docID:doc.id,width:info.width,height:info.height,components:3,size:32,colorSpace:'RGB',profile:info.profile,name:selected.name};
      onSource(doc);
    },{commandName:'打开独立临时线性输入'});
    } catch(error) {
      const own=host.app.documents.find(d=>d.id===sourceID);sourceID=null;meta=null;
      if(own)await host.core.executeAsModal(()=>own.closeWithoutSaving(),{commandName:'关闭失败的临时输入'});
      await dropTemporary();
      throw error;
    }
  }
  async function load() {
    if(!selected || !$('stretchConfirmed').checked)throw new Error('请选择T4副本，并确认它仍未拉伸。');
    await clear();
    $('stretchFeedback').textContent='';$('stretchState').textContent='正在读取线性副本；尚未应用。';
    try {
      info=await task({op:'stretchInspect',path:selected.nativePath,confirmedLinear:true});
      setSettings(info.suggestion);
      $('stretchSummary').textContent=selected.name+' · '+info.width+' × '+info.height+' · '+info.profile+'\n范围 '+info.minimum+' 至 '+info.maximum+'；原映射 '+JSON.stringify(info.provenance.mapping)+'\n'+info.suggestionReason;
      $('stretchState').textContent='已读取线性快照并建议参数，尚未打开提亮预览，也未应用。';
      status('建议已生成；点击「仅查看提亮」检查，再显式保存并应用。');
    }catch(error){await clear();$('stretchState').textContent='读取失败，未创建当前快照；请核对输入后重新读取。';throw error;}
  }
  async function rendered() {
    if(!info)throw new Error('请先读取线性准备副本。');
    const key=currentKey();
    if(result && resultKey===key){await task({op:'stretchCheck',image:info.image});return result;}
    const next=await task({op:'stretchRender',image:info.image,settings:settings()});
    if(key!==currentKey()){await remove(next.image);throw new Error('参数已变化；请重新预览当前设置。');}
    const previous=result;result=next;resultKey=key;await remove(previous?.image);
    const p=next.curve,s=next.stats;
    $('stretchFeedback').textContent='SP '+p.sp.toPrecision(5)+' · HP '+p.hp.toPrecision(5)+'\n新增黑端点 '+s.newBlackChannels+' / 白端点 '+s.newWhiteChannels+' 个通道；近饱和 '+s.nearWhitePixels+' 像素\n32位存储最大舍入误差 '+s.maxStorageError.toExponential(3)+'。未新增端点不等于无损。';
    return result;
  }
  async function show() {
    try {
      const next=await rendered();
      await openInput();
      const original=$('stretchOriginal').checked;
      preview=await host.canvasFloatPreview(preview,original?null:next.image,meta,original?'原线性输入':'仅查看提亮 · 未应用',api,report,'线性提亮');
      if(!original)shownKey=resultKey;opened=true;
      $('stretchState').textContent=original?'正在比较原线性输入；仍未应用拉伸。':'仅查看提亮（临时副本），原母版与准备文件未改变，尚未应用。';
      status('全分辨率32位提亮预览已更新；保存并应用是独立操作。');
    }catch(error){shownKey=null;$('stretchState').textContent='预览未更新；当前画面可能仍是旧效果，未应用。请核对输入或参数后重试。';throw error;}
  }
  async function execute() {
    if(!result || resultKey!==currentKey() || shownKey!==resultKey)throw new Error('请先查看当前参数的提亮预览，再保存并应用。');
    if(result.stats.newBlackChannels || result.stats.newWhiteChannels)throw new Error('新增黑/白端点，暂不应用；请降低强度或增加亮星保护后重新预览。');
    const output=await fs.getFileForSaving(selected.name.replace(/\.tiff?$/i,'')+'_stretched.tif',{types:['tif','tiff']});
    if(!output)return;
    const normalize=path=>path.replace(/\\/g,'/').toLowerCase();
    if(temporary && normalize(output.nativePath).startsWith(normalize(temporary.nativePath)+'/'))
      throw new Error('请选择临时预览目录之外的位置保存；临时文件会被清理。');
    const saved=await task({op:'stretchSave',image:result.image,output:output.nativePath});
    $('stretchSaved').textContent='已保存32位TIFF：'+saved.path;
    let applied=null;
    try {
      await openInput();await closePreview();
      const doc=await host.applyFloatResult(meta,result.image,api,report,{label:'受保护拉伸',suffix:'_stretched'});
      applied=doc;
      const nonlinear=saved.metadata.nonlinearStretch;
      await clear();
      await host.core.executeAsModal(()=>{host.app.activeDocument=doc;},{commandName:'显示拉伸结果副本'});
      onApplied(doc,nonlinear);
      $('stretchState').textContent=nonlinear?'已应用拉伸：独立文件和PS结果层已创建；原母版与准备副本保留。':'0强度输出为线性恒等副本，未应用非线性拉伸。';
      status(nonlinear?'已保存并创建可撤销的32位拉伸结果层。':'已保存0强度恒等副本，仍标记为线性。');
    }catch(error){
      $('stretchState').textContent=applied?'结果层已创建；临时清理或面板更新未完成，已保存文件仍可使用。':'文件已保存，PS结果层未完成；预览不代表已应用。';
      throw new Error('文件已保存于 '+saved.path+'；'+(applied?'PS结果层已创建，但临时清理或面板更新失败：':'PS结果层未能完成：')+error.message);
    }
  }
  function dirty() {
    $('stretchState').textContent='参数已变化，当前画面仍为上一次预览；未应用到源文件。';
    updateActions();if(opened)return run(show);
  }
  function updateActions(busy=isBusy()) {
    $('stretchUseLast').disabled=busy || !lastPrepared;
    $('stretchLoad').disabled=busy || !selected || !$('stretchConfirmed').checked;
    $('stretchConfirmed').disabled=busy || !selected;
    for(const name of names)for(const suffix of ['', 'Range'])$('stretch_'+name+suffix).disabled=busy || !info;
    for(const id of ['stretchPreview','stretchOriginal','stretchReset'])$(id).disabled=busy || !info;
    $('stretchExecute').disabled=busy || !result || resultKey!==currentKey() || shownKey!==resultKey || !!(result.stats.newBlackChannels || result.stats.newWhiteChannels);
    $('stretchCancel').disabled=!jobID;
  }
  $('stretchChoose').addEventListener('click',()=>run(async()=>{const file=await fs.getFileForOpening({types:['tif','tiff'],allowMultiple:false});if(file){await clear();choose(file);}}));
  $('stretchUseLast').addEventListener('click',()=>run(async()=>{await clear();choose(lastPrepared);}));
  $('stretchLoad').addEventListener('click',()=>run(load));
  $('stretchConfirmed').addEventListener('change',()=>updateActions());
  $('stretchPreview').addEventListener('click',()=>run(show));
  $('stretchOriginal').addEventListener('change',()=>run(show));
  $('stretchExecute').addEventListener('click',()=>run(execute));
  $('stretchReset').addEventListener('click',()=>{setSettings({amount:0,protection:.75,background:.8});return dirty();});
  for(const name of names) {
    $('stretch_'+name).addEventListener('change',()=>{$('stretch_'+name+'Range').value=$('stretch_'+name).value;return dirty();});
    $('stretch_'+name+'Range').addEventListener('input',()=>{$('stretch_'+name).value=$('stretch_'+name+'Range').value;$('stretchState').textContent='参数已变化，松开滑块更新；未应用。';updateActions();});
    $('stretch_'+name+'Range').addEventListener('change',dirty);
  }
  $('stretchCancel').addEventListener('click',()=>{if(jobID)api('/jobs/'+jobID,undefined,false,'DELETE').catch(e=>status(e.message,true));});
  setSettings({amount:0,protection:.75,background:.8});choose(null);updateActions();
  return {updateActions,previewDocumentID:()=>preview?.docID,setLastPrepared:file=>{lastPrepared=file;updateActions();}};
}
module.exports={setup};
