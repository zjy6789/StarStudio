const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const plain=value=>JSON.parse(JSON.stringify(value));
function panel(options={}) {
  const elements=new Map(),events=new Map(),intervals=new Map(),timeouts=new Map();
  const calls={requests:[],launch:[],writes:[],errors:[],pause:0,resume:0,pages:0,sync:[]};
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
    const classes=new Set((match[0].match(/class="([^"]*)"/)?.[1]||'').split(' '));
    const listeners=new Map(),attributes=new Map(),menu={children:[],appendChild(child){this.children.push(child);},set innerHTML(value){this.children=[];}};
    elements.set(match[1],{value:'',checked:false,selectedIndex:0,disabled:false,tag:match[0].match(/^<([^\s>]+)/)[1],
      classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),
        toggle(name,on){if(on===undefined)on=!classes.has(name);on?classes.add(name):classes.delete(name);}},
      parentElement:{style:{}},setAttribute:(name,value)=>attributes.set(name,value),attributes,menu,
      querySelector:()=>menu,addEventListener(name,action){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(action);},listeners});
  }
  const get=id=>{assert.ok(elements.has(id),'HTML element '+id);return elements.get(id);};
  const layer={id:11,name:'Original',blendMode:'normal'};
  const doc={id:7,width:6000,height:4000,bitsPerChannel:16,title:'Test',layers:[layer],activeLayers:[layer],activeHistoryState:{id:1}};
  const h={get,calls,doc,healthFailures:options.healthFailures||0,online:options.online!==false,
    launchError:options.launchError||'',chosenFile:null,fileGate:null,previewID:null,modalBusy:false};
  const host={app:{documents:options.noDocument?[]:[doc],activeDocument:options.noDocument?null:doc},constants:{BitsPerChannelType:{EIGHT:8,SIXTEEN:16,THIRTYTWO:32},BlendMode:{LINEARDODGE:'linearDodge',LINEARLIGHT:'linearLight'}},
    documentInfo:doc=>doc,layers:doc=>doc.layers.map(layer=>({id:layer.id,name:layer.name,layer})),
    starEncoding:(doc,layer)=>doc.bitsPerChannel===32?'signed':layer?.blendMode==='linearLight'?'gray':'black',
    starBlendModes:doc=>doc.bitsPerChannel===32?['normal','lighten','linearDodge']:['normal','lighten','screen','linearDodge','linearLight'],
    core:{executeAsModal:async action=>action({})},transaction:async(doc,name,action)=>action({}),
    upload:async(doc,layer)=>({id:'input',width:doc.width,height:doc.height,size:doc.bitsPerChannel,components:4,name:layer.name,docID:doc.id,layerID:layer.id}),
    write:async(doc,key,meta,name)=>{const layer={id:20+doc.layers.length,name,visible:true};doc.layers.unshift(layer);doc.activeHistoryState.id++;return layer;},
    setStarBlendMode:(layer,mode)=>{layer.blendMode=mode;}};
  h.host=host;
  const settings={name:'model-settings.json',read:async()=>JSON.stringify(options.saved||{executable:'D:\\engine\\starnet2.exe',stride:1,decomposition:0}),
    write:async value=>calls.writes.push(JSON.parse(value))};
  const storage={getDataFolder:async()=>({getEntries:async()=>[settings]}),
    getFileForOpening:async()=>{if(h.fileGate)await h.fileGate;return h.chosenFile;}};
  const processUI={updateActions(){},pause:async()=>{calls.pause++;},resume:()=>{calls.resume++;},
    isModalBusy:()=>h.modalBusy,previewDocumentID:()=>h.previewID,pageChanged:()=>{calls.pages++;},
    sync:(next,old)=>calls.sync.push({next:plain(next),old:plain(old)})};
  let stackSetups=0,processSetups=0,prepareSetups=0;
  const context={module:{exports:{}},ArrayBuffer,
    console:{log(){},error:(...args)=>calls.errors.push(args)},
    document:{getElementById:get,createElement:()=>({}),
      querySelectorAll:()=>[...elements.values()].filter(e=>['button','input','sp-picker'].includes(e.tag)),
      addEventListener:(name,action)=>events.set(name,action)},
    setInterval:(action,delay)=>{intervals.set(delay,action);return delay;},
    setTimeout:(action,delay)=>{timeouts.set(delay,action);return delay;},
    fetch:async(url,requestOptions)=>{
      const route=new URL(url).pathname;
      calls.requests.push({route,options:plain(requestOptions)});
      if(route==='/health' && (!h.online || h.healthFailures-->0))throw new Error('connection refused');
      if(route==='/starnet-info' && options.modelError)throw new Error(options.modelError);
      if(route==='/jobs')h.jobRequest=JSON.parse(requestOptions.body);
      const data=route==='/starnet-info'?{modern:true,license:'Terms',license_sha256:'revision-1'}:{ok:true,version:'0.6.0'};
      return {ok:true,json:async()=>route==='/jobs'?{id:'extract-job'}:route==='/jobs/extract-job'?{state:'done',progress:1,result:{background:'bg',stars:'stars',provider:'test',starEncoding:h.jobRequest.preserveModelBackground?h.jobRequest.starEncoding:'black'}}:data};
    },
    require:name=>{
      if(name==='./host.js')return host;
      if(name==='./bridge.json')return {url:'http://127.0.0.1:8765',token:'test-token',launcher:'D:\\StarStudio\\Start.exe',starnet:'D:\\engine\\starnet2.exe'};
      if(name==='uxp')return {storage:{localFileSystem:storage},shell:{openPath:async(...args)=>{calls.launch.push(args);return h.launchError;}}};
      if(name==='./stack.js')return {setup:options=>{stackSetups++;h.stackOptions=options;return {updateActions(){}};}};
      if(name==='./linear-preparation.js')return {setup:options=>{prepareSetups++;h.prepareOptions=options;return {updateActions(){},setLastMaster:(file,format)=>{h.lastMaster={file,format};}};}};
      if(name==='./star-processing.js')return {setup:options=>{processSetups++;h.processOptions=options;return processUI;}};
      throw new Error('Unexpected require '+name);
    }
  };
  // Execute the complete entry point, including setup, event bindings and timers.
  vm.runInNewContext(fs.readFileSync('plugin/main.js','utf8'),context);
  h.api=context.module.exports.api;
  h.setups=()=>({stack:stackSetups,process:processSetups,prepare:prepareSetups});
  h.settle=()=>new Promise(setImmediate);
  h.emit=async(id,event='click')=>{for(const listener of get(id).listeners.get(event)||[])await listener();};
  h.command=async commandId=>{events.get('uxpcommand')({commandId});await h.settle();};
  h.tick=async delay=>{assert.ok(intervals.has(delay));intervals.get(delay)();await h.settle();};
  h.timeout=async delay=>{assert.ok(timeouts.has(delay));const action=timeouts.get(delay);timeouts.delete(delay);action();await h.settle();};
  return h;
}

test('the full panel starts on stack, restores model settings, and leaves star/background selection to the user',async()=>{
  const h=panel();await h.settle();
  assert.deepEqual(h.setups(),{stack:1,process:1,prepare:1});assert.equal(h.calls.launch.length,0);
  assert.equal(h.get('stackPage').classList.contains('active'),true);
  assert.equal(h.get('processSource').selectedIndex,0);assert.equal(h.get('processBackground').selectedIndex,0);
  assert.equal(h.processOptions.value('processSource'),null);assert.equal(h.processOptions.value('processBackground'),null);
  assert.equal(h.get('stride').selectedIndex,1);assert.equal(h.get('executable').value,'D:\\engine\\starnet2.exe');
  assert.equal(h.get('extract').disabled,false);assert.match(h.get('documentName').textContent,/6000 × 4000/);
  assert.equal(h.calls.pause,h.calls.resume);assert.equal(h.calls.requests[0].options.headers['X-Star-Token'],'test-token');
  for(const page of ['separate','process','prepare','stack']) {
    await h.emit(page+'Tab');
    for(const name of ['stack','prepare','separate','process']) {
      assert.equal(h.get(name+'Page').classList.contains('active'),name===page);
      assert.equal(h.get(name+'Tab').attributes.get('aria-selected'),String(name===page));
    }
  }
  assert.equal(h.calls.pages,4);
  assert.ok(h.calls.requests.every(request=>['/health','/starnet-info'].includes(request.route)));
});

test('start guidance offers a current-photo path without forcing a stack and works without a document',async()=>{
  const h=panel({noDocument:true,saved:{executable:'',stride:0,decomposition:0}});await h.settle();
  assert.equal(h.get('startCurrent').disabled,true);assert.equal(h.get('photoStage').disabled,true);
  assert.match(h.get('inputHint').textContent,/尚未打开照片/);
  await h.emit('startStack');assert.equal(h.get('stackPage').classList.contains('active'),true);
  h.host.app.documents=[h.doc];h.host.app.activeDocument=h.doc;await h.tick(800);
  assert.equal(h.get('startCurrent').disabled,false);await h.emit('startCurrent');
  assert.equal(h.get('separatePage').classList.contains('active'),true);
  assert.equal(h.get('photoStage').selectedIndex,0);
  await h.emit('startOptions');assert.equal(h.get('startSettings').classList.contains('expanded'),false);
  await h.emit('startOptions');assert.equal(h.get('startSettings').classList.contains('expanded'),true);
});

test('linear preparation has a file workflow without a document and successful copies retain the linear stage',async()=>{
  const h=panel({noDocument:true});await h.settle();await h.emit('prepareTab');
  assert.equal(h.get('preparePage').classList.contains('active'),true);
  assert.match(h.get('status').textContent,/线性TIFF母版/);
  const file={name:'stack.tif',nativePath:'D:\\stack.tif'};
  h.stackOptions.onSaved(file,'tiff32');assert.equal(h.lastMaster.file,file);assert.equal(h.lastMaster.format,'tiff32');
  const prepared={...h.doc,id:9,title:'Prepared linear',bitsPerChannel:32};
  h.host.app.documents.push(prepared);h.host.app.activeDocument=prepared;
  h.prepareOptions.onOpened(prepared);
  assert.equal(h.get('photoStage').selectedIndex,2);
  assert.equal(h.get('processSource').selectedIndex,0);
  assert.equal(h.get('processBackground').selectedIndex,0);
});

test('stage confirmation belongs to the source document and is never inferred from bit depth or a preview',async()=>{
  const h=panel();await h.settle();h.get('photoStage').selectedIndex=1;await h.emit('photoStage','change');
  const other={...h.doc,id:8,title:'Linear master',bitsPerChannel:32};h.host.app.documents.push(other);h.host.app.activeDocument=other;
  await h.tick(800);assert.equal(h.get('photoStage').selectedIndex,0);
  h.get('photoStage').selectedIndex=2;await h.emit('photoStage','change');
  h.previewID=90;h.host.app.documents.push({id:90});h.host.app.activeDocument={id:90};await h.tick(800);
  assert.equal(h.get('photoStage').selectedIndex,2);assert.match(h.get('inputHint').textContent,/来源：Linear master.*加工预览/);
  h.host.app.activeDocument=h.doc;await h.tick(800);assert.equal(h.get('photoStage').selectedIndex,1);
});

test('unconfirmed and linear inputs stop extraction before image upload with concrete next steps',async()=>{
  const h=panel({saved:{executable:'D:\\engine\\starnet2.exe',acceptedLicenses:['revision-1']}});await h.settle();
  await h.emit('extract');assert.match(h.get('status').textContent,/照片阶段.*已显影/);
  h.get('photoStage').selectedIndex=2;await h.emit('photoStage','change');await h.emit('extract');
  assert.match(h.get('status').textContent,/保留母版.*副本/);
  assert.ok(h.calls.requests.every(request=>['/health','/starnet-info'].includes(request.route)));
  assert.equal(h.get('extract').disabled,false);
});

test('optional engine failures explain the next step without blocking stack or existing stars',async()=>{
  const h=panel({modelError:'找不到 StarNet'});await h.settle();
  assert.match(h.get('modelState').textContent,/无法就绪.*其他工具仍可使用/);
  await h.emit('startStack');assert.equal(h.get('stackPage').classList.contains('active'),true);
  await h.emit('processTab');assert.equal(h.get('processPage').classList.contains('active'),true);
  assert.equal(h.get('stackFiles').disabled,false);
  h.get('executable').value='';await h.emit('executable','change');assert.match(h.get('modelState').textContent,/未配置/);
  h.get('photoScene').selectedIndex=1;await h.emit('photoScene','change');await h.settle();
  assert.equal(h.calls.writes.at(-1).photoScene,1);assert.match(h.get('sceneHint').textContent,/保留线性母版/);
});

test('model controls save their state, clear stale license UI, and persist the explicitly accepted license',async()=>{
  const h=panel();await h.settle();
  await h.emit('modelOptions');assert.equal(h.get('modelSettings').classList.contains('expanded'),true);
  h.get('preserveModelBackground').checked=true;await h.emit('preserveModelBackground','change');await h.settle();
  assert.equal(h.get('decomposition').disabled,true);assert.equal(h.calls.writes.at(-1).preserveModelBackground,true);
  h.get('stride').selectedIndex=3;await h.emit('stride','change');await h.settle();assert.equal(h.calls.writes.at(-1).stride,3);
  h.chosenFile={nativePath:'E:\\CPU\\starnet++.exe'};await h.emit('chooseExecutable');
  assert.equal(h.calls.writes.at(-1).executable,h.chosenFile.nativePath);
  assert.equal('engineMode' in h.calls.writes.at(-1),false);
  await h.emit('readModelLicense');assert.equal(h.get('modelLicense').classList.contains('expanded'),true);
  assert.equal(h.get('acceptModelLicense').checked,false);assert.equal(h.get('licenseText').textContent,'Terms');
  h.get('acceptModelLicense').checked=true;await h.emit('acceptModelLicense','change');await h.settle();
  assert.deepEqual(h.calls.writes.at(-1).acceptedLicenses,['revision-1']);
  h.get('executable').value='D:\\new\\starnet2.exe';await h.emit('executable','change');await h.settle();
  assert.equal(h.get('modelLicense').classList.contains('expanded'),false);
  h.chosenFile=null;await h.emit('chooseExecutable');assert.equal(h.get('executable').value,'D:\\new\\starnet2.exe');
});

test('the extraction button enforces the license before image work and restores controls on failure',async()=>{
  const h=panel();await h.settle();await h.emit('extract');
  assert.match(h.get('status').textContent,/阅读引擎许可.*勾选同意/);
  assert.equal(h.get('modelSettings').classList.contains('expanded'),true);
  assert.equal(h.get('licenseText').textContent,'Terms');
  assert.ok(h.calls.requests.every(request=>['/health','/starnet-info'].includes(request.route)));
  assert.equal(h.get('extract').disabled,false);assert.equal(h.calls.pause,h.calls.resume);
  h.get('executable').value='';await h.emit('extract');
  assert.match(h.get('status').textContent,/填写当前引擎程序路径/);
  assert.equal(h.get('chooseExecutable').disabled,false);
});

test('the layer timer follows source edits while an active preview keeps the source document selected',async()=>{
  const h=panel();await h.settle();
  const added={id:12,name:'New stars'};h.doc.layers.push(added);h.doc.activeLayers=[added];h.doc.activeHistoryState.id++;
  await h.tick(800);assert.equal(h.processOptions.value('source'),12);
  assert.equal(h.processOptions.value('processSource'),null);
  h.processOptions.useActive('processSource');assert.equal(h.processOptions.selectedLayer('processSource').layer,added);
  const preview={id:90};h.previewID=90;h.host.app.documents.push(preview);h.host.app.activeDocument=preview;
  await h.tick(800);assert.equal(h.processOptions.selectedLayer('processSource').doc,h.doc);
  const count=h.calls.sync.length;h.modalBusy=true;h.doc.activeHistoryState.id++;
  await h.tick(800);assert.equal(h.calls.sync.length,count);
  h.modalBusy=false;await h.tick(800);assert.equal(h.calls.sync.length,count+1);
  h.host.app.documents=[];h.host.app.activeDocument=null;await h.tick(800);
  assert.equal(h.get('extract').disabled,true);assert.equal(h.get('documentName').textContent,'未打开照片');
  assert.equal(h.get('processSource').menu.children.length,0);
});

test('startup launches on demand and waits for health before enabling actions',async()=>{
  const h=panel({healthFailures:2});await h.settle();
  assert.equal(h.calls.launch.length,1);assert.equal(h.calls.launch[0][0],'D:\\StarStudio\\Start.exe');
  assert.equal(h.get('extract').disabled,true);assert.equal(h.calls.resume,0);
  await h.timeout(500);
  assert.equal(h.get('extract').disabled,false);assert.equal(h.calls.resume,1);
  assert.equal(h.get('stride').selectedIndex,1);assert.equal(h.calls.errors.length,0);
});

test('a launch error restores controls and showing the panel can retry successfully',async()=>{
  const h=panel({healthFailures:1,launchError:'launch denied'});await h.settle();
  assert.match(h.get('status').textContent,/未能启动.*launch denied/);assert.equal(h.get('status').className,'error');
  assert.equal(h.get('chooseExecutable').disabled,false);assert.equal(h.calls.pause,h.calls.resume);
  h.launchError='';h.healthFailures=1;await h.command('uxpshowpanel');
  assert.equal(h.calls.launch.length,2);assert.equal(h.calls.pause,h.calls.resume);
  await h.tick(20000);assert.equal(h.calls.requests.at(-1).route,'/health');
});

test('health polling stops while the panel is hidden, busy, or disconnected and resumes on show',async()=>{
  const h=panel();await h.settle();
  let count=h.calls.requests.length;await h.tick(20000);assert.equal(h.calls.requests.length,count+1);
  await h.command('uxphidepanel');count=h.calls.requests.length;await h.tick(20000);assert.equal(h.calls.requests.length,count);
  await h.command('uxpshowpanel');await h.tick(20000);assert.ok(h.calls.requests.length>count);
  let finish;h.fileGate=new Promise(resolve=>{finish=resolve;});
  const pending=h.emit('chooseExecutable');await h.settle();
  count=h.calls.requests.length;await h.tick(20000);assert.equal(h.calls.requests.length,count);
  finish();await pending;h.fileGate=null;
  h.online=false;await h.tick(20000);count=h.calls.requests.length;
  await h.tick(20000);assert.equal(h.calls.requests.length,count);
  h.online=true;await h.command('uxpshowpanel');count=h.calls.requests.length;
  await h.tick(20000);assert.equal(h.calls.requests.length,count+1);
});

test('startup timeout reports the failure and releases the panel',async()=>{
  const h=panel({online:false});await h.settle();
  for(let retry=0;retry<29;retry++)await h.timeout(500);
  assert.match(h.get('status').textContent,/组件启动失败/);
  assert.equal(h.calls.launch.length,1);assert.equal(h.calls.pause,h.calls.resume);
  assert.equal(h.get('chooseExecutable').disabled,false);
});

for(const [size,preserve,add,blend,encoding] of [[16,false,false,'screen','black'],[16,false,true,'linearDodge','black'],[16,true,false,'linearLight','gray'],[32,false,false,'linearDodge','signed'],[32,true,false,'linearDodge','signed']]) {
  test(`${size}-bit ${preserve?'model correction':add?'additive':'default'} pairs require explicit use and restore their actual relation after renaming`,async()=>{
    const h=panel({saved:{executable:'D:\\engine\\starnet2.exe',acceptedLicenses:['revision-1']}});await h.settle();
    h.doc.bitsPerChannel=size;h.doc.activeHistoryState.id++;await h.tick(800);
    h.get('photoStage').selectedIndex=1;await h.emit('photoStage','change');
    h.get('preserveModelBackground').checked=preserve;h.get('decomposition').selectedIndex=add?1:0;
    await h.emit('extract');
    assert.match(h.get('status').textContent,/分离完成/);
    assert.equal(h.processOptions.value('processSource'),null);assert.equal(h.get('useSeparation').disabled,false);
    const stars=h.doc.layers.find(layer=>layer.name.endsWith('_starmask')),background=h.doc.layers.find(layer=>layer.name.endsWith('_starless'));
    stars.name='Renamed editable stars';background.name='Renamed background';await h.tick(800);
    await h.emit('useSeparation');
    assert.equal(h.processOptions.value('processSource'),stars.id);assert.equal(h.processOptions.value('processBackground'),background.id);
    assert.equal(h.processOptions.value('processBlend'),blend);assert.equal(h.processOptions.starEncoding(h.doc,stars),encoding);
    assert.equal(h.get('processPage').classList.contains('active'),true);
    if(size===32)assert.equal(h.jobRequest.mode,'add');
    if(encoding==='gray')stars.blendMode='screen'; // Known encoding is independent of a user-changed blend mode.
    assert.equal(h.processOptions.starEncoding(h.doc,stars),encoding);
    h.get('processBlend').selectedIndex=0;await h.emit('restoreMatchedBlend');assert.equal(h.processOptions.value('processBlend'),blend);
    h.processOptions.useActive('processSource');await h.tick(800);
    assert.equal(h.processOptions.value('processSource'),11,'Synchronization must preserve a manual source choice');
    h.doc.layers=h.doc.layers.filter(layer=>layer.id!==background.id);h.doc.activeHistoryState.id++;await h.tick(800);
    assert.equal(h.get('useLastSeparation').disabled,true);
    assert.equal(h.processOptions.starEncoding(h.doc,stars),encoding,'Deleting the partner must not erase a known star encoding');
    await h.emit('useLastSeparation');assert.match(h.get('status').textContent,/请手动选择/);
    assert.equal(h.processOptions.value('processSource'),11);
  });
}

test('manual relation restores its blend and encoding without pretending an unknown 32-bit Screen pair is valid',async()=>{
  const h=panel();await h.settle();h.processOptions.useActive('processSource');
  h.processOptions.refreshBlendModes();
  await h.emit('restoreMatchedBlend');assert.match(h.get('status').textContent,/分离关系未知.*确认/);
  h.get('processRelation').selectedIndex=2;await h.emit('processRelation','change');
  assert.equal(h.processOptions.value('processBlend'),'linearDodge');
  h.get('processRelation').selectedIndex=3;await h.emit('processRelation','change');
  assert.equal(h.processOptions.value('processBlend'),'linearLight');assert.equal(h.processOptions.starEncoding(h.doc,h.doc.layers[0]),'gray');
  h.doc.bitsPerChannel=32;h.doc.activeHistoryState.id++;await h.tick(800);
  h.get('processRelation').selectedIndex=1;await h.emit('processRelation','change');
  assert.match(h.get('status').textContent,/32 位不提供滤色/);assert.equal(h.doc.bitsPerChannel,32);
  h.get('processRelation').selectedIndex=2;await h.emit('processRelation','change');
  assert.equal(h.processOptions.value('processBlend'),'linearDodge');
});
