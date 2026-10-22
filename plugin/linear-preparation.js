const host=require('./host.js');
const fs=require('uxp').storage.localFileSystem;
const $=id=>document.getElementById(id);

function setup({run,api,job,status,onOpened=()=>{},onPrepared=()=>{},isBusy=()=>false}) {
  let selected=null,lastMaster=null,activeJob=null,fitsFile=null,fitsInfo=null;
  function updateActions(busy=isBusy()) {
    $('prepareChoose').disabled=busy;
    $('prepareUseLast').disabled=busy || !lastMaster;
    $('prepareConfirmed').disabled=busy || !selected;
    $('prepareExecute').disabled=busy || !selected || !$('prepareConfirmed').checked;
    $('prepareCancel').disabled=!activeJob;
    $('fitsChoose').disabled=busy;
    $('fitsCheck').disabled=busy || !fitsFile;
    $('fitsColor').disabled=busy;
    $('fitsConfirmed').disabled=busy || !fitsInfo;
    $('fitsRounding').disabled=busy || !fitsInfo?.rounding.changedChannels;
    $('fitsImport').disabled=busy || !fitsInfo || !$('fitsConfirmed').checked
      || (fitsInfo.rounding.changedChannels>0 && !$('fitsRounding').checked);
  }
  async function task(request) {
    try {return await job(request,id=>{activeJob=id;updateActions(true);});}
    finally {activeJob=null;updateActions(true);}
  }
  async function inspect(file) {
    selected=null;$('prepareConfirmed').checked=false;$('prepareResult').textContent='';
    $('prepareSummary').textContent='正在检查 '+file.name+'…';$('prepareMapping').textContent='';
    const info=await task({op:'prepareInspect',path:file.nativePath});
    selected={file,info};
    $('prepareSummary').textContent=file.name+' · '+info.width+' × '+info.height+' · 32位浮点RGB · '+info.profile;
    const shift=info.mapping.offset<0?' + '+(-info.mapping.offset):' − '+info.mapping.offset;
    $('prepareMapping').textContent='原范围 '+info.stats.min+' … '+info.stats.max+'；负值 '+info.stats.negativeChannels+'，超过1的通道值 '+info.stats.aboveOneChannels+'。\n副本 = (母版'+shift+') ÷ '+info.mapping.scale+'，RGB全图使用同一映射。临时额外空间约 '+info.temporaryGB+' GiB。'+(info.mapping.offset<0?'\n负值需要抬升零点，可能改变颜色比例；原母版保留。':'');
    status('母版检查完成；确认尚未拉伸后，可创建独立副本。');
  }
  async function open(file,result,commandName='打开线性范围准备副本') {
    let opened;
    await host.core.executeAsModal(async()=>{
      const before=new Set(Array.from(host.app.documents,d=>d.id));
      const response=await require('photoshop').action.batchPlay([{_obj:'open',null:{_path:fs.createSessionToken(file),_kind:'local'},_options:{dialogOptions:'dontDisplay'}}],{});
      if(response[0]?._obj==='error') throw new Error('副本已保存，但 Photoshop 打开失败：'+response[0].message);
      const doc=host.app.activeDocument;
      if(!doc || before.has(doc.id)) throw new Error('副本已保存；Photoshop 未新开文档，可能已打开同一文件。请保留已有编辑并手动重新打开保存的副本。');
      if(doc.bitsPerChannel!==host.constants.BitsPerChannelType.THIRTYTWO || doc.mode!==host.constants.DocumentMode.RGB
          || doc.width!==result.width || doc.height!==result.height || doc.colorProfileName!==result.profile) {
        await doc.closeWithoutSaving();
        throw new Error('副本已保存，但 Photoshop 的位深、尺寸或ICC不匹配，已关闭本次新文档。请使用保留嵌入配置的32位RGB方式打开，勿转为工作空间。');
      }
      opened=doc;
    },{commandName});
    onOpened(opened);
  }
  $('prepareChoose').addEventListener('click',()=>run(async()=>{
    const file=await fs.getFileForOpening({types:['tif','tiff'],allowMultiple:false});
    if(file) await inspect(file);
  }));
  $('prepareUseLast').addEventListener('click',()=>run(async()=>{
    if(!lastMaster) throw new Error('本会话尚未保存32位TIFF母版；可先选择已有文件。');
    await inspect(lastMaster);
  }));
  $('prepareConfirmed').addEventListener('change',()=>updateActions());
  $('prepareCancel').addEventListener('click',()=>{
    if(activeJob) api('/jobs/'+activeJob,undefined,false,'DELETE').then(()=>status('正在取消；提交前会保留已有目标文件。')).catch(e=>status(e.message,true));
  });
  $('prepareExecute').addEventListener('click',()=>run(async()=>{
    if(!selected || !$('prepareConfirmed').checked) throw new Error('请先检查文件并确认这是未拉伸的线性母版。');
    const file=await fs.getFileForSaving(selected.file.name.replace(/\.tiff?$/i,'')+'_prepared_linear.tif',{types:['tif','tiff']});
    if(!file) return;
    const result=await task({op:'prepareLinear',path:selected.file.nativePath,output:file.nativePath,
      fingerprint:selected.info.fingerprint,confirmedLinear:true});
    const rounding=result.metadata.rounding;
    $('prepareResult').textContent='已保存 '+file.name+'。范围准备已应用；仍为线性，未拉伸，未启用额外显示提亮。\n浮点舍入改变 '+rounding.changedChannels+' 个通道值，最大重建绝对误差 '+rounding.maxAbsError.toExponential(4)+'。映射与误差已写入TIFF描述；副本不能替代原母版。';
    onPrepared(file);
    await open(file,result);
    status('已创建并打开32位范围准备副本；仍为线性。可到「线性提亮」显式使用刚准备副本，先预览再保存应用。');
  }));
  function fitsColor() {return ['unknown','prophoto','srgb'][$('fitsColor').selectedIndex ?? 0];}
  function invalidateFits() {
    fitsInfo=null;$('fitsConfirmed').checked=false;$('fitsRounding').checked=false;
    $('fitsSummary').textContent=fitsFile?fitsFile.name+' · 确认RGB颜色解释后点击「检查数据」；灰度可直接检查。':'先选择一张未拉伸的FITS堆栈。';
    updateActions();
  }
  async function inspectFits() {
    if(!fitsFile)throw new Error('请先选择FITS文件。');
    invalidateFits();
    $('fitsSummary').textContent='正在检查 '+fitsFile.name+'…';
    let info;
    try {info=await task({op:'fitsInspect',path:fitsFile.nativePath,color:fitsColor()});}
    catch(error){$('fitsSummary').textContent='检查未完成：'+error.message;throw error;}
    fitsInfo=info;
    $('fitsSummary').textContent=fitsFile.name+' · '+info.width+' × '+info.height+' · '+(info.color==='mono'?'灰度→中性RGB':info.color==='srgb'?'线性sRGB→线性ProPhoto':'通道按线性ProPhoto解释')
      +'\n范围 '+info.stats.min+' … '+info.stats.max+'；负值 '+info.stats.negativeChannels+'，超过1的通道值 '+info.stats.aboveOneChannels
      +'。转float32舍入 '+info.rounding.changedChannels+' 个通道值，最大误差 '+info.rounding.maxAbsError.toExponential(4)+'。临时额外空间约 '+info.temporaryGB+' GiB。';
    status('FITS检查完成；确认线性状态和颜色解释后保存，原文件不变。');
  }
  $('fitsOptions').addEventListener('click',()=>$('fitsSettings').classList.toggle('collapsed'));
  $('fitsChoose').addEventListener('click',()=>run(async()=>{
    const file=await fs.getFileForOpening({types:['fit','fits','fts'],allowMultiple:false});
    if(file){fitsFile=file;invalidateFits();}
  }));
  $('fitsCheck').addEventListener('click',()=>run(inspectFits));
  $('fitsColor').addEventListener('change',invalidateFits);
  for(const id of ['fitsConfirmed','fitsRounding'])$(id).addEventListener('change',()=>updateActions());
  $('fitsImport').addEventListener('click',()=>run(async()=>{
    if(!fitsInfo || !$('fitsConfirmed').checked || (fitsInfo.rounding.changedChannels>0 && !$('fitsRounding').checked))
      throw new Error('请重新检查当前FITS，并确认线性、颜色解释和必要的舍入。');
    const file=await fs.getFileForSaving(fitsFile.name.replace(/\.(?:fits|fit|fts)$/i,'')+'_linear_import.tif',{types:['tif','tiff']});
    if(!file)return;
    const result=await task({op:'fitsImport',path:fitsFile.nativePath,output:file.nativePath,color:fitsColor(),
      fingerprint:fitsInfo.fingerprint,confirmedLinear:true,acceptRounding:$('fitsRounding').checked});
    lastMaster=file;
    $('fitsSummary').textContent='已保存 '+file.name+'；32位线性RGB，仍未拉伸，未映射范围。原FITS和头信息保留；可用上方「使用刚保存的32位母版」进入范围准备。';
    if($('fitsOpen').checked)await open(file,result,'打开FITS线性交接副本');
    status('FITS交接副本已保存；原件保留。需要提亮时先创建范围准备副本。');
  }));
  updateActions();
  return {updateActions,setLastMaster(file,format){lastMaster=format==='tiff32'?file:null;updateActions();}};
}
module.exports={setup};
