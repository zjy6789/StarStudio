const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const file=name=>({name,isFile:true,nativePath:'D:\\fixtures\\'+name});
const plain=value=>JSON.parse(JSON.stringify(value));
function panel() {
  const elements=new Map(),documentEvents=new Map(),calls={jobs:[],api:[],open:[],save:[],status:[],saved:[],layered:[],opened:[]};
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/id="([^"]+)"/g)) {
    const classes=new Set(),listeners=new Map(),menu={children:[],appendChild(item){this.children.push(item);},set innerHTML(value){this.children=[];}};
    elements.set(match[1],{value:'20',checked:false,selectedIndex:0,disabled:false,
      classList:{contains:name=>classes.has(name),toggle(name){classes.has(name)?classes.delete(name):classes.add(name);}},
      addEventListener(name,action){listeners.set(name,action);},listeners,
      menu,querySelector:()=>menu,
      getBoundingClientRect:()=>({left:10,top:20,width:400,height:400}),
      removeAttribute(name){delete this[name];}});
  }
  const get=id=>{assert.ok(elements.has(id),'HTML element '+id);return elements.get(id);};
  const h={get,calls,files:[file('a.NEF'),file('b.nef'),file('c.nef')],folder:null,
    saved:file('output.dng'),openResult:[{}],failure:null,gate:null,
    inspected:{paths:['D:\\fixtures\\a.NEF','D:\\fixtures\\b.nef','D:\\fixtures\\c.nef'],width:1000,height:500,reference:1,name:'b.nef',cacheGB:2,preview:'data:image/png;base64,test'}};
  const storage={
    getFileForOpening:async options=>{assert.equal(options.allowMultiple,true);assert.ok(options.types.includes('nef'));return h.files;},
    getFolder:async()=>h.folder,
    getFileForSaving:async(name,options)=>{calls.save.push({name,options:plain(options)});return h.saved;},
    getTemporaryFolder:async()=>({createFile:async(name,options)=>{assert.equal(options.overwrite,false);return file(name);}}),
    createSessionToken:entry=>'token:'+entry.nativePath
  };
  const host={core:{executeAsModal:async action=>action({})},openStackLayers:async(...args)=>{
    calls.layered.push(args);if(h.layerFailure)throw h.layerFailure;return {doc:{id:99},cleanupWarning:''};}};
  const photoshop={action:{batchPlay:async commands=>{calls.open.push(plain(commands));return h.openResult;}}};
  const context={module:{exports:{}},document:{getElementById:get,createElement:()=>({}),addEventListener:(name,action)=>documentEvents.set(name,action)},
    btoa:s=>Buffer.from(s).toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
    require:name=>name==='./host.js'?host:name==='uxp'?{storage:{localFileSystem:storage,formats:{binary:'binary'}}}:photoshop};
  vm.runInNewContext(fs.readFileSync('plugin/stack.js','utf8'),context);
  h.ui=context.module.exports.setup({
    run:async action=>{h.ui.updateActions(true);try{return await action();}finally{h.ui.updateActions(false);}},
    api:async(...args)=>{calls.api.push(args);return {};},onSaved:(file,format)=>calls.saved.push({file,format}),
    onLayeredOpened:doc=>{calls.opened.push(doc);},
    status:(message,error)=>calls.status.push({message,error}),
    job:async(request,started)=>{
      calls.jobs.push(plain(request));
      if(request.op==='stackInspect'){
        if(h.inspectFailure)throw h.inspectFailure;
        const inspected=plain(h.inspected);inspected.paths=request.paths;
        inspected.reference=request.reference && !h.ignoreReference?request.paths.indexOf(request.reference):Math.floor(request.paths.length/2);
        inspected.name=request.paths[inspected.reference].split(/[\\/]/).pop();return inspected;
      }
      started('stack-job');
      if(h.gate)await h.gate;
      if(h.failure)throw h.failure;
      if(request.op==='stackCrop')return {output:request.output,format:h.result.format,shape:[6,8,3]};
      return {frames:3,seconds:1.2,encoding:{scale:1},calibration:{warnings:[]},...h.result,
        ...(request.referenceGround && !h.missingLayers?{layers:{depth:32,referenceResampled:false}}:{})};
    }
  });
  h.emit=(id,event='click',data={})=>get(id).listeners.get(event)?.(data);
  h.documentEvent=(name)=>documentEvents.get(name)?.();
  h.select=()=>h.emit('stackFiles');
  h.execute=()=>h.emit('stackExecute');
  return h;
}

test('file and folder inspection filters inputs, selects the middle frame, and keeps selection on cancel',async()=>{
  const h=panel();assert.equal(h.get('stackExecute').disabled,true);
  h.files.push(file('notes.txt'),{name:'nested.nef',isFile:false});
  await h.select();
  assert.deepEqual(h.calls.jobs[0],{op:'stackInspect',paths:h.inspected.paths});
  assert.match(h.get('stackSummary').textContent,/3 张.*第 2 张 b.nef/);
  assert.equal(h.get('stackReference').src,h.inspected.preview);
  assert.equal(h.get('stackExecute').disabled,false);
  h.files=null;await h.select();assert.equal(h.calls.jobs.length,1);
  h.folder={getEntries:async()=>[file('a.NEF'),file('b.nef'),file('c.nef'),file('notes.txt')]};
  await h.emit('stackFolder');assert.deepEqual(h.calls.jobs[1].paths,h.inspected.paths);
  h.folder=null;await h.emit('stackFolder');assert.equal(h.calls.jobs.length,2);
});

test('unsupported or single-image selections fail before inspection',async()=>{
  const h=panel();h.files=[file('only.nef'),file('notes.txt')];
  await assert.rejects(h.select(),/至少两张/);
  assert.equal(h.calls.jobs.length,0);assert.equal(h.get('stackExecute').disabled,true);
});

for(const [index,mode] of ['mean','median','sigma','maximum','minimum'].entries()) {
  test(`stack ${mode} sends the chosen scene and opens only the saved result`,async()=>{
    const h=panel();await h.select();h.get('stackMode').selectedIndex=index;
    h.get('stackScene').selectedIndex=1;h.emit('stackMode','change');
    assert.match(h.get('stackCache').textContent,index===1||index===2?/2 GB/:/逐张累积/);
    await h.execute();
    assert.deepEqual(h.calls.jobs[1],{op:'stack',paths:h.inspected.paths,reference:h.inspected.paths[1],mode,landscape:true,mask:[],format:'dng',qualityReport:true,
      output:h.saved.nativePath,calibration:{dark:[],flat:[],bias:[],darkflat:[],linearTiff:false},photoshopOutput:h.saved.nativePath});
    assert.equal(h.calls.open.length,1);
    assert.equal(h.calls.open[0][0].null._path,'token:'+h.saved.nativePath);
    assert.match(h.calls.status.at(-1).message,/已保存并打开 3 帧/);
    assert.equal(h.get('stackCancel').disabled,true);
  });
}

for(const [index,format] of ['dng','tiff16','tiff32','fits16','fits32'].entries()) {
  test(`${format} saves in the selected format and uses a float TIFF bridge for FITS`,async()=>{
    const h=panel();await h.select();h.get('stackFormat').selectedIndex=index;
    h.emit('stackFormat','change');await h.execute();
    const request=h.calls.jobs[1],extension=format==='dng'?'dng':format.startsWith('fits')?'fit':'tif';
    assert.equal(request.format,format);assert.equal(request.output,h.saved.nativePath);
    assert.equal(h.calls.saved[0].format,format);assert.equal(h.calls.saved[0].file,h.saved);
    assert.deepEqual(h.calls.save[0],{name:'StarStudio_stack.'+extension,options:{types:[extension]}});
    if(format.startsWith('fits')) {
      assert.match(request.photoshopOutput,/StarStudio_stack_\d+\.tif$/);
      assert.notEqual(request.photoshopOutput,request.output);
    } else assert.equal(request.photoshopOutput,request.output);
    assert.equal(h.calls.open[0][0].null._path,'token:'+request.photoshopOutput);
  });
}

test('optional calibration file/folder choices, clearing, and dark-flat dependency reach the stack request',async()=>{
  const h=panel();await h.select();
  h.files=[file('dark.NEF'),file('ignore.txt')];await h.emit('stackDarkFiles');
  h.folder={getEntries:async()=>[file('bias.nef'),{name:'subfolder',isFile:false}]};await h.emit('stackBiasFolder');
  h.files=[file('darkflat.nef')];await h.emit('stackDarkflatFiles');
  await assert.rejects(h.execute(),/平暗场.*平场/);assert.equal(h.calls.save.length,0);
  h.files=null;await h.emit('stackDarkFiles');assert.equal(h.get('stackDarkSummary').textContent,'1 张');
  h.files=[file('flat.nef')];await h.emit('stackFlatFiles');
  h.emit('stackCalibrationOptions');assert.equal(h.get('stackCalibrationSettings').classList.contains('expanded'),true);
  h.get('stackLinearTiff').checked=true;await h.execute();
  assert.deepEqual(h.calls.jobs.at(-1).calibration,{dark:[file('dark.NEF').nativePath],flat:[file('flat.nef').nativePath],
    bias:[file('bias.nef').nativePath],darkflat:[file('darkflat.nef').nativePath],linearTiff:true});
  h.emit('stackDarkClear');assert.equal(h.get('stackDarkSummary').textContent,'未使用');
  assert.equal(h.get('stackDarkClear').disabled,true);
  await h.execute();assert.deepEqual(h.calls.jobs.at(-1).calibration.dark,[]);
});

for(const portrait of [false,true]) test(`mask brush accounts for ${portrait?'horizontal':'vertical'} letterboxing and keeps normalized strokes`,async()=>{
  const h=panel();if(portrait)Object.assign(h.inspected,{width:500,height:1000});
  await h.select();h.get('stackPaint').checked=true;
  const pointer=(x,y)=>({clientX:x,clientY:y,preventDefault(){}});
  h.emit('stackMask','mousedown',pointer(30,40)); // Empty letterbox: ignore.
  h.emit('stackMask','mousemove',pointer(210,220));
  h.emit('stackMask','mousedown',portrait?pointer(160,220):pointer(110,220));
  h.emit('stackMask','mousemove',portrait?pointer(160.01,220):pointer(110.01,220));
  h.emit('stackMask','mousemove',pointer(600,600)); // Clamp to the image edge.
  h.documentEvent('mouseup');h.emit('stackMask','mousemove',pointer(210,220));
  await h.execute();
  assert.deepEqual(h.calls.jobs[1].mask,[{radius:.025,points:[[.25,.5],[1,1]]}]);
  h.emit('stackClearMask');await h.execute();assert.deepEqual(h.calls.jobs[2].mask,[]);
});

test('active stack can be canceled, locks selection, and releases controls after a failed job',async()=>{
  const h=panel();await h.select();let finish;h.gate=new Promise(resolve=>{finish=resolve;});
  h.failure=new Error('已取消');const pending=h.execute();await new Promise(setImmediate);
  assert.equal(h.get('stackCancel').disabled,false);assert.equal(h.get('stackFiles').disabled,true);
  h.get('stackPaint').checked=true;h.emit('stackMask','mousedown',{clientX:210,clientY:220});
  h.emit('stackCancel');await new Promise(setImmediate);
  assert.deepEqual(h.calls.api,[['/jobs/stack-job',undefined,false,'DELETE']]);
  finish();await assert.rejects(pending,/已取消/);
  assert.equal(h.calls.open.length,0);assert.equal(h.get('stackCancel').disabled,true);
  assert.equal(h.get('stackExecute').disabled,false);assert.equal(h.get('stackDarkFiles').disabled,false);
  h.failure=null;h.gate=null;await h.execute();assert.deepEqual(h.calls.jobs.at(-1).mask,[]);
});

test('save dialog cancellation and Photoshop open errors preserve a usable selection',async()=>{
  const h=panel();await h.select();h.saved=null;await h.execute();
  assert.equal(h.calls.jobs.length,1);assert.equal(h.calls.open.length,0);
  h.saved=file('output.dng');h.openResult=[{_obj:'error',message:'Cannot open'}];
  await assert.rejects(h.execute(),/堆栈已保存.*Cannot open/);
  assert.equal(h.get('stackExecute').disabled,false);assert.equal(h.get('stackCancel').disabled,true);
  h.openResult=[{}];await h.execute();assert.match(h.calls.status.at(-1).message,/已保存并打开/);
});

function resultFolder(h) {
  const folder={nativePath:'D:\\results\\StarStudio_stack_new',entries:[],files:[],deleted:false,
    createFile:async name=>{if(h.entryFailure)throw h.entryFailure;const entry={name,isFile:true,nativePath:folder.nativePath+'\\'+name};folder.files.push(entry);return entry;},
    getEntries:async()=>folder.entries,delete:async()=>{assert.equal(folder.entries.length,0);folder.deleted=true;}};
  h.folder={createFolder:async name=>{assert.match(name,/^StarStudio_stack_\d+$/);return folder;}};
  h.get('stackReferenceGround').checked=true;
  return folder;
}

for(const [index,format] of ['dng','tiff16','tiff32','fits16','fits32'].entries()) {
  test(`${format} reference output retains master choice and opens float layers without ACR`,async()=>{
    const h=panel();await h.select();const folder=resultFolder(h);h.get('stackFormat').selectedIndex=index;
    await h.emit('stackReferenceGround','change');assert.match(h.get('stackReferenceGroundHint').textContent,/单帧/);
    await h.execute();const request=h.calls.jobs.at(-1);
    assert.equal(request.referenceGround,true);assert.equal(request.format,format);
    assert.equal(h.calls.save.length,0);assert.equal(h.calls.open.length,0);assert.equal(h.calls.layered.length,1);
    const [sky,reference]=h.calls.layered[0];assert.equal(reference.name,'StarStudio_reference_ground.tif');
    assert.equal(sky.name,format==='tiff32'?'StarStudio_stack.tif':'StarStudio_sky_PS.tif');
    assert.equal(request.photoshopOutput,sky.nativePath);assert.equal(folder.files.length,format==='tiff32'?2:3);
    assert.equal(h.calls.saved[0].file,sky);assert.equal(h.calls.saved[0].format,'tiff32');
    assert.equal(h.calls.opened[0].id,99);assert.equal(folder.deleted,false);
    assert.match(h.calls.status.at(-1).message,/隐藏的单帧参考地景.*蒙版.*没有多帧降噪/s);
  });
}

test('reference-folder cancellation leaves the input selection ready',async()=>{
  const h=panel();await h.select();h.get('stackReferenceGround').checked=true;h.folder=null;
  await h.execute();assert.equal(h.calls.jobs.length,1);assert.equal(h.get('stackExecute').disabled,false);
});

for(const stage of ['entry','job','occupied'])test(`reference output cleans only empty task folders on ${stage} failure`,async()=>{
  const h=panel();await h.select();const folder=resultFolder(h);
  if(stage==='entry')h.entryFailure=new Error('entry failed');else h.failure=new Error('job canceled');
  if(stage==='occupied')folder.entries=[{name:'keep.tif'}];
  await assert.rejects(h.execute(),/failed|canceled/);
  assert.equal(folder.deleted,stage!=='occupied');assert.equal(h.get('stackReferenceGround').disabled,false);
  assert.equal(h.calls.layered.length,0);
});

test('an old component cannot turn an incomplete layer result into successful output',async()=>{
  const h=panel();await h.select();resultFolder(h);h.missingLayers=true;
  await assert.rejects(h.execute(),/分层输出记录不完整.*新版后台/);assert.equal(h.calls.saved.length,0);assert.equal(h.calls.layered.length,0);
});

test('native opening failure reports the preserved output directory and allows retry',async()=>{
  const h=panel();await h.select();const folder=resultFolder(h);h.layerFailure=new Error('native open failed');
  await assert.rejects(h.execute(),/已保存于.*PS分层打开未完成.*native open failed/);
  assert.equal(folder.deleted,false);assert.equal(h.get('stackExecute').disabled,false);
  h.layerFailure=null;await h.execute();assert.equal(h.calls.opened.length,1);
});

function reported(h) {
  h.result={reference:h.inspected.paths[1],alignment:[{file:h.inspected.paths[0],matches:47,rms:.3214}],
    quality:{minimum:1,maximum:3,frames:3,fullPixels:80,totalPixels:100,
      crop:{left:1,top:2,right:9,bottom:8},preview:'data:image/png;base64,preview',
      png:'data:image/png;base64,'+Buffer.from([137,80,78,71,0,255]).toString('base64')}};
}

test('quality report survives a native opening failure and exports full binary counts',async()=>{
  const h=panel();reported(h);await h.select();h.openResult=[{_obj:'error',message:'Cannot open'}];
  await assert.rejects(h.execute(),/Cannot open/);
  assert.match(h.get('stackQualityRows').textContent,/a.NEF.*47.*0.321/);
  assert.match(h.get('stackCoverageHint').textContent,/80.0%.*8 × 6.*尚未裁剪.*Sigma/s);
  assert.equal(h.get('stackCoveragePreview').src,h.result.quality.preview);
  assert.equal(h.get('stackCoverageSave').disabled,false);
  let written;
  h.saved={nativePath:'D:\\coverage.png',write:async(bytes,options)=>{written={bytes:Buffer.from(bytes),options};}};
  await h.emit('stackCoverageSave');assert.deepEqual(written.bytes,Buffer.from([137,80,78,71,0,255]));
  assert.equal(written.options.format,'binary');assert.equal(h.calls.jobs.length,2);
});

test('new input clears stale report while canceled input and export retain it',async()=>{
  const h=panel();reported(h);await h.select();await h.execute();
  h.files=null;await h.select();assert.equal(h.get('stackCoveragePreview').src,h.result.quality.preview);
  h.saved=null;await h.emit('stackCoverageSave');assert.equal(h.get('stackCoverageSave').disabled,false);
  h.files=[file('a.nef'),file('b.nef')];await h.select();
  assert.equal(h.get('stackCoveragePreview').src,undefined);assert.equal(h.get('stackCoverageSave').disabled,true);
});

test('older component has an explicit missing-report message without blocking saved output',async()=>{
  const h=panel();await h.select();await h.execute();
  assert.match(h.get('stackCoverageHint').textContent,/没有返回完整覆盖报告.*更新后台/);
  assert.equal(h.get('stackCoverageSave').disabled,true);assert.equal(h.calls.open.length,1);
});

function paint(h) {
  h.get('stackPaint').checked=true;
  h.emit('stackMask','mousedown',{clientX:210,clientY:220,preventDefault(){}});
  h.documentEvent('mouseup');
}

test('explicit reference reloads the preview and clears only the previous coordinate brush',async()=>{
  const h=panel();await h.select();paint(h);
  h.get('stackReferenceChoice').selectedIndex=0;await h.emit('stackReferenceChoice','change');
  assert.equal(h.calls.jobs.at(-1).reference,h.inspected.paths[0]);
  assert.match(h.get('stackSummary').textContent,/第 1 张 a.NEF/);
  assert.deepEqual(h.get('stackReferenceChoice').menu.children.map(i=>i.textContent),['a.NEF','b.nef','c.nef']);
  await h.execute();assert.equal(h.calls.jobs.at(-1).reference,h.inspected.paths[0]);
  assert.deepEqual(h.calls.jobs.at(-1).mask,[]);
});

test('failed reference read keeps the old reference preview and painted exclusion',async()=>{
  const h=panel();await h.select();paint(h);h.inspectFailure=new Error('decode failed');
  h.get('stackReferenceChoice').selectedIndex=0;
  await assert.rejects(h.emit('stackReferenceChoice','change'),/decode failed/);
  assert.equal(h.get('stackReferenceChoice').selectedIndex,1);assert.match(h.get('stackSummary').textContent,/b.nef/);
  h.inspectFailure=null;await h.execute();
  assert.equal(h.calls.jobs.at(-1).reference,h.inspected.paths[1]);assert.equal(h.calls.jobs.at(-1).mask.length,1);
});

test('an older component silently ignoring a requested reference does not change the active group',async()=>{
  const h=panel();await h.select();h.ignoreReference=true;
  h.get('stackReferenceChoice').selectedIndex=0;
  await assert.rejects(h.emit('stackReferenceChoice','change'),/后台未采用指定基准/);
  assert.equal(h.get('stackReferenceChoice').selectedIndex,1);assert.match(h.get('stackSummary').textContent,/b.nef/);
});

test('failed frame is removed only after explicit action, retains the reference brush and can be restored',async()=>{
  const h=panel();await h.select();paint(h);
  h.failure=Object.assign(new Error('matching failed'),{failedFile:h.inspected.paths[0],alignment:[]});
  await assert.rejects(h.execute(),/matching failed/);
  assert.match(h.get('stackFailedHint').textContent,/a.NEF.*未自动丢帧/);
  assert.equal(h.get('stackExcludeFailed').disabled,false);
  await h.emit('stackExcludeFailed');assert.deepEqual(h.calls.jobs.at(-1).paths,h.inspected.paths.slice(1));
  assert.equal(h.calls.jobs.at(-1).reference,h.inspected.paths[1]);assert.match(h.get('stackExcludedHint').textContent,/已排除 1 张.*原文件保留/);
  h.failure=null;await h.execute();assert.equal(h.calls.jobs.at(-1).mask.length,1);
  assert.deepEqual(h.calls.jobs.at(-1).paths,h.inspected.paths.slice(1));
  await h.emit('stackRestoreFrames');assert.deepEqual(h.calls.jobs.at(-1).paths,h.inspected.paths);
  assert.equal(h.get('stackRestoreFrames').disabled,true);
});

test('excluding a failed reference uses the remaining middle frame and will not drop below two',async()=>{
  const h=panel();await h.select();paint(h);
  h.failure=Object.assign(new Error('bad reference'),{failedFile:h.inspected.paths[1]});
  await assert.rejects(h.execute(),/bad reference/);await h.emit('stackExcludeFailed');
  assert.equal(h.calls.jobs.at(-1).reference,undefined);assert.match(h.get('stackSummary').textContent,/第 2 张 c.nef/);
  h.failure=Object.assign(new Error('bad first'),{failedFile:h.inspected.paths[0]});
  await assert.rejects(h.execute(),/bad first/);assert.deepEqual(h.calls.jobs.at(-1).mask,[]);
  assert.equal(h.get('stackExcludeFailed').disabled,true);
  await assert.rejects(h.emit('stackExcludeFailed'),/至少需要保留两张/);
});

function croppable(h) {
  reported(h);Object.assign(h.result,{output:file('master.dng').nativePath,format:'dng',recordSHA256:'record-digest',
    compositionPreview:'data:image/png;base64,composition'});
  h.result.quality.sourceSHA256='source-digest';
}

test('crop saves only after explicit confirmation and leaves the full report and PS documents alone',async()=>{
  const h=panel();croppable(h);await h.select();await h.execute();
  assert.equal(h.get('stackCoveragePreview').src,h.result.compositionPreview);
  h.get('stackCoverageView').selectedIndex=0;h.emit('stackCoverageView','change');
  assert.equal(h.get('stackCoveragePreview').src,h.result.quality.preview);
  await assert.rejects(h.emit('stackCropSave'),/确认裁剪/);assert.equal(h.calls.jobs.length,2);
  h.get('stackCropConfirmed').checked=true;h.emit('stackCropConfirmed','change');assert.equal(h.get('stackCropSave').disabled,false);
  h.saved=file('crop.dng');await h.emit('stackCropSave');
  assert.deepEqual(h.calls.jobs.at(-1),{op:'stackCrop',source:h.result.output,output:h.saved.nativePath,confirmed:true,
    crop:h.result.quality.crop,sourceSHA256:'source-digest',recordSHA256:'record-digest'});
  assert.equal(h.calls.saved.at(-1).file,h.saved);assert.equal(h.calls.saved.at(-1).format,'dng');
  assert.equal(h.calls.open.length,1);assert.equal(h.calls.layered.length,0);
  assert.equal(h.get('stackCropConfirmed').checked,false);assert.match(h.get('stackCropSaved').textContent,/8 × 6.*完整母版/);
  assert.equal(h.get('stackCoveragePreview').src,h.result.quality.preview);
});

test('canceling the crop picker keeps confirmation and does not start another job',async()=>{
  const h=panel();croppable(h);await h.select();await h.execute();
  h.get('stackCropConfirmed').checked=true;h.saved=null;await h.emit('stackCropSave');
  assert.equal(h.calls.jobs.length,2);assert.equal(h.get('stackCropConfirmed').checked,true);
  assert.equal(h.get('stackCropSave').disabled,false);
});

test('crop cancellation uses the active job and allows a retry without discarding its source report',async()=>{
  const h=panel();croppable(h);await h.select();await h.execute();h.saved=file('crop.dng');
  h.get('stackCropConfirmed').checked=true;let finish;h.gate=new Promise(resolve=>{finish=resolve;});
  h.failure=new Error('crop canceled');const pending=h.emit('stackCropSave');await new Promise(setImmediate);
  assert.equal(h.get('stackCancel').disabled,false);assert.equal(h.get('stackCropConfirmed').disabled,true);
  await h.emit('stackCancel');assert.equal(h.calls.api.at(-1)[0],'/jobs/stack-job');
  finish();await assert.rejects(pending,/crop canceled/);
  assert.equal(h.get('stackCropSave').disabled,false);assert.equal(h.get('stackCancel').disabled,true);
  assert.equal(h.get('stackCoveragePreview').src,h.result.compositionPreview);
});

test('legacy reports can export counts but cannot enable unverified crop writes',async()=>{
  const h=panel();reported(h);await h.select();await h.execute();
  assert.equal(h.get('stackCoverageSave').disabled,false);assert.equal(h.get('stackCropSave').disabled,true);
  assert.match(h.get('stackCropHint').textContent,/缺少母版来源校验/);
  await assert.rejects(h.emit('stackCropSave'),/带来源校验/);
});
