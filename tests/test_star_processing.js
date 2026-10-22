const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');

test('initialization and reset restore valid, neutral star-processing defaults',()=>{
  const elements=new Map();
  function element() {
    return {value:'',checked:false,disabled:false,children:[],listeners:{},
      classList:{toggle(){},contains(){return false;}},setAttribute(){},
      appendChild(child){this.children.push(child);if(child.id)elements.set(child.id,child);},
      addEventListener(name,action){this.listeners[name]=action;},
      set innerHTML(html){
        for(const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
          const child=element();
          child.value=match[0].match(/value="([^"]+)"/)?.[1]??'';
          elements.set(match[1],child);
        }
      }};
  }
  const document={createElement:element,getElementById(id){
    if(!elements.has(id))elements.set(id,element());return elements.get(id);
  }};
  const context={document,require:()=>({app:{documents:[]}}),module:{exports:{}},
    btoa:s=>Buffer.from(s).toString('base64'),clearTimeout(){},setTimeout(){throw Error('No source selected');}};
  vm.runInNewContext(fs.readFileSync('plugin/star-processing.js','utf8'),context);
  context.module.exports.setup({value:()=>null,currentPage:()=>'process'});
  const defaults={curve:{exposure:0,shadows:.25,midtones:.5,highlights:.75},
    coma:{strength:.5,sigma:2,radius:8,roundness:.9},
    reduction:{strength:.35,radius:1,threshold:.01,protect:.8},
    glow:{strength:1,radius:12,lower:.2,upper:1,softness:.1,spread:.35},
    color:{saturation:1,protect:.85}};
  function check() {
    for(const [name,params] of Object.entries(defaults)) {
      assert.equal(elements.get(name+'Enabled').checked,false);
      for(const [key,expected] of Object.entries(params))for(const suffix of ['', '_range'])
        assert.equal(Number(elements.get('process_'+name+'_'+key+suffix).value),expected,name+'.'+key+suffix);
    }
  }
  check();
  for(const [id,node] of elements)if(id.startsWith('process_'))node.value=999;
  elements.get('glowEnabled').checked=true;
  elements.get('processReset').listeners.click();check();
});

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

function processingHarness(setupOverrides={}) {
  const elements=new Map(),timers=new Map(),calls={uploads:[],jobs:[],native:[],deleted:[],unsafeDeletes:[],outputs:[],status:[]};
  const values={processSource:null,processBackground:null,processBlend:'screen'};
  const jobs=new Map(),images=new Set();
  let timerID=0,imageID=0,busy=false,ui;
  function connect(node) {node.connected=true;for(const child of node.children)connect(child);}
  function element() {
    const classes=new Set();
    return {value:'',checked:false,disabled:false,listeners:{},children:[],connected:false,
      set id(id){this._id=id;elements.set(id,this);},get id(){return this._id;},
      classList:{toggle(name,enabled){if(enabled===undefined)enabled=!classes.has(name);enabled?classes.add(name):classes.delete(name);},contains:name=>classes.has(name)},
      setAttribute(){},appendChild(child){this.children.push(child);if(this.connected)connect(child);},
      addEventListener(name,action){this.listeners[name]=action;},
      set innerHTML(html){for(const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)){const child=element();child.id=match[1];child.value=match[0].match(/value="([^"]+)"/)?.[1]??'';this.appendChild(child);}}};
  }
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/id="([^"]+)"/g)) {const node=element();node.id=match[1];connect(node);}
  const document={createElement:element,getElementById:id=>elements.get(id)?.connected?elements.get(id):null};
  const doc={id:7,width:6000,height:4000,bitsPerChannel:'sixteen',mode:'rgb',activeHistoryState:{id:1}};
  function outputLayer() {
    const output={id:100+calls.outputs.length,allLocked:false,duplicate:async()=>outputLayer(),move(layer,placement){this.placedBefore=layer.id;this.placement=placement;}};
    calls.outputs.push(output);doc.activeHistoryState.id++;return output;
  }
  const layers=new Map([11,12,13].map(id=>[id,{id,name:'Layer '+id,duplicate:async()=>outputLayer()}]));
  const host={constants:{BitsPerChannelType:{EIGHT:'eight',SIXTEEN:'sixteen'},DocumentMode:{RGB:'rgb'},ElementPlacement:{PLACEBEFORE:'before'}},
    app:{documents:[doc]},core:{executeAsModal:async action=>action({})},
    upload:async(source,layer)=>{
      const meta={id:'input'+(++imageID),width:source.width,height:source.height,components:4,size:16,colorSpace:'RGB',profile:'Display P3',docID:source.id,layerID:layer.id,name:layer.name};
      calls.uploads.push(meta);images.add(meta.id);return meta;
    },
    canvasStarPreview:async(state,result,meta,backdrop,blend,api,report,isCurrent)=>{
      assert.equal(isCurrent(),true);
      if(result){assert.equal(result.width,doc.width);assert.equal(result.height,doc.height);assert.equal(result.components,4);assert.equal(images.has(result.image),true);}
      calls.native.push({result,meta:{...meta},background:backdrop?.layer.id??null,blend});
      if(!state){const preview={id:90,closeWithoutSaving:async()=>{host.app.documents=host.app.documents.filter(d=>d.id!==90);}};host.app.documents.push(preview);state={docID:preview.id};}
      return state;
    },
    transaction:async(source,name,action)=>action({}),write:async(source,key,meta)=>{assert.equal(images.has(key),true);return outputLayer();},
    starEncoding(source,layer){return source.bitsPerChannel==='thirtytwo'?'signed':layer.blendMode==='linearLight'?'gray':'black';},
    setStarBlendMode(layer,blend){layer.blendMode=blend;}};
  host.applyStarResult=async({doc,source,background,blend,result,meta,previous})=>{
    const layer=result?await host.write(doc,result.image,meta):await source.duplicate(doc);
    layer.name=source.name+'_processed';layer.visible=true;host.setStarBlendMode(layer,blend);
    if(background)layer.move(background,host.constants.ElementPlacement.PLACEBEFORE);
    calls.applied??=[];calls.applied.push({source:source.id,background:background?.id,previous});
    return {layer,root:layer};
  };
  const harness={elements,timers,calls,values,jobs,images,doc,host,layers,cancelDelayed:false,createGate:null,pollGate:null};
  async function api(path,body,binary,method='GET') {
    calls.api??=[];calls.api.push({path,method:body!==undefined?'POST':method});
    if(path==='/images' || path==='/star-sources') {const id='input'+(++imageID);images.add(id);return {id};}
    if(path==='/jobs') {
      const id='job'+(calls.jobs.length+1),entry={id,state:'running',progress:.25,request:body};
      calls.jobs.push(entry);jobs.set(id,entry);
      const gate=harness.createGate;harness.createGate=null;if(gate)await gate.promise;
      return {id};
    }
    if(path.startsWith('/jobs/')) {
      const entry=jobs.get(path.slice(6));assert.ok(entry,path);
      if(method==='DELETE'){entry.cancel=true;if(!harness.cancelDelayed && !['done','error'].includes(entry.state))entry.state='canceled';return entry;}
      const gate=harness.pollGate;harness.pollGate=null;if(gate)await gate.promise;
      return {state:entry.state,progress:entry.progress,result:entry.result,error:entry.error};
    }
    if((path.startsWith('/images/') || path.startsWith('/star-sources/')) && method==='DELETE') {
      const key=path.split('/')[2];
      if(calls.jobs.some(j=>j.request.image===key && ['running','queued'].includes(j.state)))calls.unsafeDeletes.push(key);
      images.delete(key);calls.deleted.push(key);return {ok:true};
    }
    throw new Error('Unexpected API '+method+' '+path);
  }
  const selectedLayer=id=>{const layer=layers.get(values[id]);if(!layer)throw new Error('No selected layer');return {doc,layer};};
  const context={document,require:()=>host,module:{exports:{}},btoa:s=>Buffer.from(s).toString('base64'),
    setTimeout(action,delay){const id=++timerID;timers.set(id,{action,delay});return id;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(fs.readFileSync('plugin/star-processing.js','utf8'),context);
  const options={api,status:(message,error)=>calls.status.push({message,error}),report(){},selectedLayer,
    useActive:id=>{values[id]=11;},value:id=>values[id],refresh(){},currentPage:()=>'process',ensureService:async()=>{},isBusy:()=>busy,
    job:async request=>{const {id}=await api('/jobs',request);harness.finish(id);return jobs.get(id).result;},
    run:async action=>{
      busy=true;for(const el of elements.values())el.disabled=true;
      try{await ui.pause();await action();}finally{busy=false;for(const el of elements.values())el.disabled=false;ui.updateActions();ui.resume();}
    },...setupOverrides};
  ui=context.module.exports.setup(options);harness.ui=ui;
  harness.emit=(id,event,value)=>{if(value!==undefined){if(id in values)values[id]=value;else document.getElementById(id).value=value;}return document.getElementById(id).listeners[event]?.();};
  harness.flush=async()=>{await new Promise(setImmediate);};
  harness.tick=async delay=>{
    for(const [id,timer] of [...timers])if(timer.delay===delay){timers.delete(id);timer.action();}
    await harness.flush();
  };
  harness.finish=(id,state='done')=>{
    const entry=jobs.get(id);entry.state=state;
    if(state==='done'){entry.result={image:'result'+id,curve:[0,.5,1],reconstructedStars:0};images.add(entry.result.image);}
  };
  harness.enableGlow=async()=>{
    harness.emit('processSource','change',11);elements.get('glowEnabled').checked=true;harness.emit('glowEnabled','change');await harness.tick(180);
  };
  return harness;
}

test('gray correction layers send their encoding and retain Linear Light in preview and output',async()=>{
  const h=processingHarness();h.layers.get(11).blendMode='linearLight';h.values.processBlend='linearLight';
  await h.enableGlow();
  assert.equal(h.calls.jobs[0].request.starEncoding,'gray');
  assert.equal(h.elements.get('processBlend').disabled,true);
  h.finish(h.calls.jobs[0].id);await h.tick(150);await h.flush();
  assert.equal(h.calls.native.at(-1).blend,'linearLight');
  await h.emit('processExecute','click');await h.flush();
  assert.equal(h.calls.outputs.at(-1).blendMode,'linearLight');
});

test('signed star input uses its dedicated upload and cleanup route in preview and direct apply',async()=>{
  for(const direct of [false,true]) {
    const h=processingHarness();
    h.doc.bitsPerChannel='thirtytwo';
    let input;
    h.host.upload=async(doc,layer,api)=>{const {id}=await api('/images',{width:1,height:1,components:4});input=id;return {id,size:32};};
    h.values.processSource=11;h.elements.get('glowEnabled').checked=true;
    if(direct) await h.emit('processExecute','click');
    else {h.emit('glowEnabled','change');await h.tick(180);}
    assert.equal(h.calls.api[0].path,'/star-sources');
    if(!direct){h.finish(h.calls.jobs[0].id);await h.tick(150);await h.ui.pause();}
    h.values.processSource=null;h.ui.resume();await h.tick(180);await h.flush();
    assert.ok(h.calls.api.some(r=>r.path==='/star-sources/'+input&&r.method==='DELETE'));
  }
});

test('selecting stars opens original native full-resolution preview without reading pixels or running the backend',async()=>{
  const h=processingHarness();h.emit('processSource','change',11);await h.flush();
  assert.equal(h.calls.native.length,1);
  assert.equal(h.calls.native[0].result,null);
  assert.equal(h.calls.native[0].meta.width,6000);assert.equal(h.calls.native[0].meta.height,4000);assert.equal(h.calls.native[0].meta.size,16);
  assert.equal(h.ui.previewDocumentID(),90);assert.equal(h.calls.uploads.length,0);assert.equal(h.calls.jobs.length,0);
});

test('coalesced edits render full pixels; background and blend changes reuse the result; reset immediately shows original',async()=>{
  const h=processingHarness();h.emit('processSource','change',11);h.elements.get('glowEnabled').checked=true;h.emit('glowEnabled','change');
  for(const strength of [1.1,1.2,1.3])h.emit('process_glow_strength_range','input',strength);
  await h.tick(180);
  assert.equal(h.calls.jobs.length,1);assert.equal(h.calls.uploads.length,1);
  const request=h.calls.jobs[0].request;assert.equal(request.preview,false);assert.equal(request.scale,1);assert.equal(request.settings.glow.strength,1.3);
  for(const id of ['processSource','processBackground','processBlend','process_glow_strength_range'])assert.equal(h.elements.get(id).disabled,false,id);
  h.finish('job1');await h.tick(150);
  assert.equal(h.calls.native.at(-1).result.image,'resultjob1');
  h.emit('processBackground','change',12);h.emit('processBlend','change','linearDodge');await h.flush();
  assert.equal(h.calls.native.at(-1).background,12);assert.equal(h.calls.native.at(-1).blend,'linearDodge');
  assert.equal(h.calls.jobs.length,1);assert.equal(h.calls.uploads.length,1);
  h.emit('processReset','click');await h.flush();assert.equal(h.calls.native.at(-1).result,null);
  await h.tick(180);assert.equal(h.images.size,0);assert.deepEqual(h.calls.unsafeDeletes,[]);
});

test('changing edits during processing cancels old work and retains its input until terminal; only latest settings render',async()=>{
  const h=processingHarness();h.cancelDelayed=true;await h.enableGlow();
  h.emit('process_glow_strength_range','input',1.5);h.emit('process_glow_strength_range','input',2);await h.tick(180);
  assert.equal(h.jobs.get('job1').cancel,true);assert.equal(h.calls.jobs.length,1);assert.equal(h.images.has('input1'),true);
  assert.equal(h.calls.deleted.includes('input1'),false);
  h.finish('job1','canceled');await h.tick(150);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.jobs[1].request.settings.glow.strength,2);assert.equal(h.calls.uploads.length,1);
  h.finish('job2');await h.tick(150);
  assert.equal(h.calls.native.at(-1).result.image,'resultjob2');assert.deepEqual(h.calls.unsafeDeletes,[]);
  assert.equal(h.calls.native.some(call=>call.result?.image==='resultjob1'),false);
});

test('source switch shows new original immediately and deletes stale result and input before uploading the next source',async()=>{
  const h=processingHarness();await h.enableGlow();h.finish('job1');await h.tick(150);
  h.emit('processSource','change',13);await h.flush();
  assert.equal(h.calls.native.at(-1).result,null);assert.equal(h.calls.native.at(-1).meta.layerID,13);
  await h.tick(180);
  assert.deepEqual(h.calls.deleted,['resultjob1','input1']);assert.equal(h.calls.uploads[1].layerID,13);
  h.finish('job2');await h.tick(150);assert.deepEqual(h.calls.unsafeDeletes,[]);
});

test('clearing selection waits for canceled worker before freeing input and closing preview',async()=>{
  const h=processingHarness();h.cancelDelayed=true;await h.enableGlow();
  h.emit('processSource','change',null);await h.tick(180);
  assert.equal(h.jobs.get('job1').cancel,true);assert.equal(h.images.has('input1'),true);assert.equal(h.ui.previewDocumentID(),90);
  h.finish('job1','canceled');await h.tick(150);
  assert.equal(h.images.size,0);assert.equal(h.ui.previewDocumentID(),undefined);assert.deepEqual(h.calls.unsafeDeletes,[]);
});

test('changes while creating a job cancel the returned old job rather than publishing stale work',async()=>{
  const h=processingHarness();h.createGate=deferred();const gate=h.createGate;await h.enableGlow();
  h.emit('process_glow_strength_range','input',2);gate.resolve();await h.flush();
  assert.equal(h.jobs.get('job1').cancel,true);assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.jobs[1].request.settings.glow.strength,2);
  h.finish('job2');await h.tick(150);assert.equal(h.calls.native.at(-1).result.image,'resultjob2');assert.deepEqual(h.calls.unsafeDeletes,[]);
});

test('an old job error does not suppress newer settings, and current failures do not retry endlessly',async()=>{
  const h=processingHarness();h.cancelDelayed=true;h.pollGate=deferred();const gate=h.pollGate;await h.enableGlow();
  h.jobs.get('job1').state='error';h.jobs.get('job1').error='old invalid settings';h.emit('process_glow_strength_range','input',2);
  gate.resolve();await h.flush();await h.tick(180);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.jobs[1].request.settings.glow.strength,2);
  h.jobs.get('job2').state='error';h.jobs.get('job2').error='current failed';await h.tick(150);await h.tick(180);await h.tick(180);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.status.at(-1).message,'current failed');
});

test('final processed layer reuses matching full result and inherits chosen native blend and background placement',async()=>{
  const h=processingHarness();await h.enableGlow();h.finish('job1');await h.tick(150);
  h.emit('processBackground','change',12);h.emit('processBlend','change','lighten');await h.flush();
  await h.emit('processExecute','click');await h.flush();
  assert.equal(h.calls.jobs.length,1);assert.equal(h.calls.uploads.length,1);assert.equal(h.calls.outputs.length,1);
  const output=h.calls.outputs[0];assert.equal(output.blendMode,'lighten');assert.equal(output.placedBefore,12);assert.equal(output.visible,true);assert.equal(output.name,'Layer 11_processed');
  await h.tick(180);assert.equal(h.calls.jobs.length,1,'Output creation must not invalidate unchanged source pixels');assert.deepEqual(h.calls.unsafeDeletes,[]);
});

test('source history changes invalidate uploaded pixels even when layer selection remains the same',async()=>{
  const h=processingHarness();await h.enableGlow();h.finish('job1');await h.tick(150);
  h.doc.activeHistoryState.id=2;h.ui.sync({id:7,history:2},{id:7,history:1});await h.flush();
  assert.equal(h.calls.native.at(-1).result,null);assert.equal(h.calls.native.at(-1).meta.sourceKey,'7:11:2');
  await h.tick(180);assert.equal(h.calls.uploads.length,2);assert.equal(h.calls.jobs[1].request.image,'input2');
  assert.deepEqual(h.calls.deleted,['resultjob1','input1']);h.finish('job2');await h.tick(150);
});

test('native readers finish or cancel before stale image buffers are deleted',async()=>{
  const h=processingHarness(),native=h.host.canvasStarPreview,gate=deferred();
  h.host.canvasStarPreview=async(...args)=>{
    if(args[1]?.image==='resultjob1'){
      await gate.promise;
      if(!args.at(-1)()){const error=new Error('Native preview superseded');error.stale=true;throw error;}
    }
    return native(...args);
  };
  await h.enableGlow();h.finish('job1');await h.tick(150);
  h.emit('processSource','change',13);await h.tick(180);
  assert.equal(h.images.has('input1'),true);assert.equal(h.images.has('resultjob1'),true);assert.deepEqual(h.calls.deleted,[]);
  gate.resolve();await h.flush();await h.tick(180);
  assert.deepEqual(h.calls.deleted,['resultjob1','input1']);assert.equal(h.calls.uploads[1].layerID,13);assert.deepEqual(h.calls.unsafeDeletes,[]);
  h.finish('job2');await h.tick(150);
});

test('delayed duplicate picker changes do not cancel an unchanged pending native preview',async()=>{
  const h=processingHarness(),native=h.host.canvasStarPreview,gate=deferred();let callbacks=0;
  h.host.canvasStarPreview=async(...args)=>{callbacks++;await gate.promise;assert.equal(args.at(-1)(),true,'An unchanged composition must remain current');return native(...args);};
  h.emit('processSource','change',11);await h.flush();
  h.emit('processSource','change',11);h.emit('processBlend','change','screen');h.emit('processBackground','change',null);await h.flush();
  gate.resolve();await h.flush();
  assert.equal(callbacks,1);assert.equal(h.calls.native.length,1);assert.equal(h.ui.previewDocumentID(),90);assert.equal(h.calls.status.some(x=>x.error),false);
});

test('changing advanced blend still refreshes its summary and native preview without recomputing pixels',async()=>{
  const seen=[];
  const h=processingHarness({refreshBlendModes:()=>seen.push(h.values.processBlend)});
  h.emit('processSource','change',11);await h.flush();
  h.emit('processBlend','change','lighten');await h.flush();
  assert.equal(seen.at(-1),'lighten');assert.equal(h.calls.native.at(-1).blend,'lighten');
  assert.equal(h.values.processSource,11);assert.equal(h.calls.jobs.length,0);assert.equal(h.calls.uploads.length,0);
});

test('executing before the changed-settings preview completes adopts the actual final result in the preview cache',async()=>{
  const h=processingHarness();await h.enableGlow();h.finish('job1');await h.tick(150);
  h.emit('process_glow_strength_range','input',2);
  await h.emit('processExecute','click');await h.flush();
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.jobs[1].request.settings.glow.strength,2);
  assert.equal(h.calls.native.at(-1).result.image,'resultjob2');assert.equal(h.images.has('resultjob2'),true);assert.equal(h.images.has('resultjob1'),false);
  await h.tick(180);assert.equal(h.calls.jobs.length,2);assert.deepEqual(h.calls.unsafeDeletes,[]);
});

test('the new preview tab is never selected as the source while native creation is pending or after creation',()=>{
  const source={id:7},preview={id:90},other={id:8};
  const host={app:{activeDocument:preview,documents:[source,preview,other]},documentInfo:doc=>doc};
  const context={require:name=>name==='./host.js'?host:{url:'http://127.0.0.1:8765'},document:{},module:{exports:{}}};
  const code=fs.readFileSync('plugin/main.js','utf8').split("for (const id of ['decomposition','stride'])")[0];
  vm.runInNewContext(code,context);
  vm.runInNewContext('docID=7;processUI={isModalBusy:()=>true,previewDocumentID:()=>undefined};',context);
  assert.equal(vm.runInNewContext('workingDocument()',context).id,7);
  vm.runInNewContext('processUI={isModalBusy:()=>false,previewDocumentID:()=>90};',context);
  assert.equal(vm.runInNewContext('workingDocument()',context).id,7);
  host.app.activeDocument=other;
  assert.equal(vm.runInNewContext('workingDocument()',context).id,8);
  host.app.activeDocument=preview;host.app.documents=[preview];
  assert.equal(vm.runInNewContext('snapshot()',context),null);
});

test('repeated applications replace their own earlier results even after switching background or selecting an earlier output',async()=>{
  const h=processingHarness();await h.enableGlow();h.finish('job1');await h.tick(150);
  await h.emit('processExecute','click');await h.flush();
  const first=h.calls.outputs[0];h.layers.set(first.id,first);
  h.emit('processBackground','change',12);await h.flush();await h.emit('processExecute','click');await h.flush();
  const second=h.calls.outputs[1];
  assert.deepEqual(Array.from(h.calls.applied[1].previous),[first.id]);
  h.emit('processSource','change',first.id);await h.flush();
  // Neutral application avoids another worker while still testing output lineage.
  h.emit('processReset','click');await h.flush();await h.emit('processExecute','click');await h.flush();
  assert.deepEqual(Array.from(h.calls.applied[2].previous),[first.id,second.id]);
});

test('opening basic and advanced controls never enables effects or submits a job',async()=>{
  const h=processingHarness();h.emit('processSource','change',11);await h.flush();
  h.emit('reductionDisclosure','click');h.emit('reductionAdvancedToggle','click');
  assert.equal(h.elements.get('reductionDetails').classList.contains('expanded'),true);
  assert.equal(h.elements.get('reductionAdvanced').classList.contains('expanded'),true);
  assert.equal(h.elements.get('reductionEnabled').checked,false);
  await h.tick(180);assert.equal(h.calls.jobs.length,0);
  h.elements.get('reductionEnabled').checked=true;h.emit('reductionEnabled','change');
  h.emit('process_reduction_strength_range','input',.6);h.emit('process_reduction_radius','change',1.7);
  await h.tick(180);
  assert.equal(h.calls.jobs[0].request.settings.reduction.strength,.6);
  assert.equal(h.calls.jobs[0].request.settings.reduction.radius,1.7);
  assert.equal(Number(h.elements.get('process_reduction_strength').value),.6);
  assert.equal(Number(h.elements.get('process_reduction_radius_range').value),1.7);
  h.finish('job1');await h.tick(150);
});

test('presets replace settings explicitly, expose their pixel radii and reset returns to the original',async()=>{
  const h=processingHarness();h.emit('processSource','change',11);await h.flush();
  h.emit('processNatural','click');await h.tick(180);
  const natural=h.calls.jobs[0].request.settings;
  assert.deepEqual(Object.entries(natural).filter(([,s])=>s.enabled).map(([k])=>k),['reduction']);
  assert.equal(natural.reduction.strength,.25);assert.equal(natural.reduction.radius,1);
  assert.match(h.elements.get('processSettingsHint').textContent,/缩星.*1.*像素/);
  h.finish('job1');await h.tick(150);
  h.emit('processSoft','click');await h.tick(180);
  const soft=h.calls.jobs[1].request.settings;
  assert.deepEqual(Object.entries(soft).filter(([,s])=>s.enabled).map(([k])=>k),['glow']);
  assert.equal(soft.glow.strength,.6);assert.equal(soft.glow.radius,12);
  assert.match(h.elements.get('processSettingsHint').textContent,/辉光.*12.*像素/);
  h.finish('job2');await h.tick(150);
  h.emit('processReset','click');await h.flush();
  assert.equal(h.calls.native.at(-1).result,null);
  assert.match(h.elements.get('processSettingsHint').textContent,/未启用/);
  assert.equal(h.elements.get('processOriginal').checked,false);
});

test('comparison retains the same backdrop and blend, reuses pixels and labels a pending result honestly',async()=>{
  const h=processingHarness();h.emit('processBackground','change',12);await h.enableGlow();
  h.finish('job1');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
  assert.equal(h.elements.get('processCompareLabel').textContent,'查看原合成');
  h.emit('process_glow_strength_range','input',2);await h.flush();
  assert.match(h.elements.get('processPreviewHint').textContent,/上次/);
  h.elements.get('processOriginal').checked=true;h.emit('processOriginal','change');await h.flush();
  assert.equal(h.calls.native.at(-1).result,null);
  assert.equal(h.calls.native.at(-1).background,12);assert.equal(h.calls.native.at(-1).blend,'screen');
  assert.match(h.elements.get('processPreviewHint').textContent,/原合成/);
  h.elements.get('processOriginal').checked=false;h.emit('processOriginal','change');await h.flush();
  assert.equal(h.calls.native.at(-1).result.image,'resultjob1');
  assert.match(h.elements.get('processPreviewHint').textContent,/上次/);
  await h.tick(180);h.finish('job2');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.uploads.length,1);
});

test('a superseded native render cannot announce that the latest parameters are ready',async()=>{
  const h=processingHarness(),native=h.host.canvasStarPreview,gate=deferred();
  h.host.canvasStarPreview=async(...args)=>{
    if(args[1]?.image==='resultjob1') {
      await gate.promise;
      if(!args.at(-1)()){const error=new Error('Superseded');error.stale=true;throw error;}
    }
    return native(...args);
  };
  await h.enableGlow();h.finish('job1');await h.tick(150);
  h.emit('process_glow_strength_range','input',2);await h.flush();
  gate.resolve();await h.flush();
  assert.doesNotMatch(h.calls.status.at(-1).message,/已更新/);
  assert.doesNotMatch(h.elements.get('processPreviewHint').textContent,/已更新/);
  await h.tick(180);h.finish('job2');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
});

test('failed native preview updates keep the previous picture labeled as failed and can retry',async()=>{
  const h=processingHarness(),native=h.host.canvasStarPreview;
  h.emit('processSource','change',11);await h.flush();
  h.host.canvasStarPreview=async()=>{throw new Error('Native write failed');};
  h.emit('processBlend','change','linearDodge');await h.flush();
  assert.match(h.elements.get('processPreviewHint').textContent,/更新失败.*Native write failed/);
  assert.equal(h.calls.status.at(-1).error,true);
  h.host.canvasStarPreview=native;h.emit('processBlend','change','linearDodge');await h.flush();
  assert.match(h.elements.get('processPreviewHint').textContent,/未启用加工/);
});

test('an invalid background stops pixel work and cannot be applied before the selection is corrected',async()=>{
  const h=processingHarness();
  h.emit('processSource','change',11);await h.flush();
  h.emit('processBackground','change',11);
  h.elements.get('glowEnabled').checked=true;h.emit('glowEnabled','change');await h.tick(180);
  assert.match(h.elements.get('processPreviewHint').textContent,/选择无效.*背景与星点/);
  assert.equal(h.elements.get('processExecute').disabled,true);
  assert.equal(h.elements.get('processOriginal').disabled,true);
  assert.equal(h.calls.uploads.length,0);assert.equal(h.calls.jobs.length,0);
  await assert.rejects(h.emit('processExecute','click'),/背景与星点请选择不同图层/);
  assert.equal(h.calls.uploads.length,0);assert.equal(h.calls.jobs.length,0);assert.equal(h.calls.outputs.length,0);
});

test('an invalid background cancels pending processing without restarting or deleting its live source',async()=>{
  const h=processingHarness();h.cancelDelayed=true;await h.enableGlow();
  h.emit('processBackground','change',11);await h.flush();
  assert.equal(h.jobs.get('job1').cancel,true);
  await h.tick(180);assert.equal(h.calls.jobs.length,1);assert.equal(h.images.has('input1'),true);
  h.finish('job1','canceled');await h.tick(150);await h.tick(180);
  assert.equal(h.calls.jobs.length,1);assert.deepEqual(h.calls.unsafeDeletes,[]);
  h.emit('processBackground','change',12);await h.flush();await h.tick(180);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.jobs[1].request.image,'input1');
  assert.equal(h.calls.uploads.length,1);h.finish('job2');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
  assert.equal(h.elements.get('processExecute').disabled,false);
});

test('correcting an invalid background restores the cached result and never publishes a superseded composition',async()=>{
  const h=processingHarness(),native=h.host.canvasStarPreview,gate=deferred();
  await h.enableGlow();h.finish('job1');await h.tick(150);
  h.host.canvasStarPreview=async(...args)=>{
    if(args[3]?.layer.id===13) {
      await gate.promise;
      if(!args.at(-1)()){const error=new Error('Superseded');error.stale=true;throw error;}
    }
    return native(...args);
  };
  h.emit('processBackground','change',13);await h.flush();
  h.emit('processBackground','change',11);await h.flush();gate.resolve();await h.flush();
  assert.match(h.elements.get('processPreviewHint').textContent,/选择无效/);
  assert.doesNotMatch(h.elements.get('processPreviewHint').textContent,/已更新/);
  h.emit('processBackground','change',12);await h.flush();await h.tick(180);
  assert.equal(h.calls.native.at(-1).result.image,'resultjob1');
  assert.equal(h.calls.native.at(-1).background,12);
  assert.equal(h.calls.jobs.length,1);assert.equal(h.calls.uploads.length,1);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
});

test('invalid selection while a job is being created cancels that job as soon as its id arrives',async()=>{
  const h=processingHarness(),gate=deferred();h.createGate=gate;h.cancelDelayed=true;
  await h.enableGlow();h.emit('processBackground','change',11);await h.flush();
  gate.resolve();await h.flush();assert.equal(h.jobs.get('job1').cancel,true);
  h.finish('job1','canceled');await h.tick(150);await h.tick(180);
  assert.equal(h.calls.jobs.length,1);assert.deepEqual(h.calls.unsafeDeletes,[]);
  assert.match(h.elements.get('processPreviewHint').textContent,/选择无效/);
});

test('a result completing before cancellation is discarded when the background selection is invalid',async()=>{
  const h=processingHarness(),gate=deferred();h.pollGate=gate;
  await h.enableGlow();h.finish('job1');h.emit('processBackground','change',11);await h.flush();
  gate.resolve();await h.flush();await h.tick(180);
  assert.equal(h.images.has('resultjob1'),false);assert.equal(h.images.has('input1'),true);
  assert.equal(h.calls.jobs.length,1);assert.deepEqual(h.calls.unsafeDeletes,[]);
  assert.match(h.elements.get('processPreviewHint').textContent,/选择无效/);
  h.emit('processBackground','change',12);await h.flush();await h.tick(180);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.uploads.length,1);
});

test('execution rechecks background after processing and releases its unused result if that layer disappeared',async()=>{
  let h;
  h=processingHarness({job:async()=>{
    h.layers.delete(12);h.images.add('finished');return {image:'finished',curve:[0,1]};
  }});
  h.values.processSource=11;h.values.processBackground=12;h.elements.get('glowEnabled').checked=true;
  await assert.rejects(h.emit('processExecute','click'),/No selected layer/);
  assert.equal(h.calls.outputs.length,0);assert.equal(h.images.has('finished'),false);
  assert.equal(h.images.has('input1'),true);assert.ok(h.calls.deleted.includes('finished'));
});

test('leaving the processing page while starting the service skips uploads until returning',async()=>{
  let page='process';const gate=deferred();
  const h=processingHarness({currentPage:()=>page,ensureService:()=>gate.promise});
  await h.enableGlow();page='stack';h.ui.pageChanged();gate.resolve();await h.flush();
  assert.equal(h.calls.uploads.length,0);assert.equal(h.calls.jobs.length,0);
  page='process';h.ui.pageChanged();await h.tick(180);
  assert.equal(h.calls.uploads.length,1);assert.equal(h.calls.jobs.length,1);
  h.finish('job1');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
});

test('a full layer upload finishing after page exit stays reusable without starting obsolete work',async()=>{
  let page='process';const h=processingHarness({currentPage:()=>page}),gate=deferred(),upload=h.host.upload;
  h.host.upload=async(...args)=>{const result=await upload(...args);await gate.promise;return result;};
  await h.enableGlow();page='stack';h.ui.pageChanged();gate.resolve();await h.flush();
  assert.equal(h.calls.jobs.length,0);assert.equal(h.images.has('input1'),true);
  assert.deepEqual(h.calls.deleted,[]);
  page='process';h.ui.pageChanged();await h.tick(180);
  assert.equal(h.calls.uploads.length,1);assert.equal(h.calls.jobs[0].request.image,'input1');
  h.finish('job1');await h.tick(150);assert.deepEqual(h.calls.unsafeDeletes,[]);
});

test('a task id arriving after page exit is canceled without reporting progress on another page',async()=>{
  let page='process';const h=processingHarness({currentPage:()=>page}),gate=deferred();
  h.createGate=gate;h.cancelDelayed=true;await h.enableGlow();
  page='stack';h.ui.pageChanged();const statusCount=h.calls.status.length;
  gate.resolve();await h.flush();
  assert.equal(h.jobs.get('job1').cancel,true);
  assert.equal(h.calls.status.length,statusCount);assert.equal(h.images.has('input1'),true);
  assert.equal(h.calls.jobs.length,1);
  h.finish('job1','canceled');await h.tick(150);await h.tick(180);
  assert.equal(h.calls.jobs.length,1);assert.deepEqual(h.calls.unsafeDeletes,[]);
  page='process';h.ui.pageChanged();await h.tick(180);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.uploads.length,1);
  h.finish('job2');await h.tick(150);
});

test('a task completing before page-exit cancellation is discarded and returning restarts automatically',async()=>{
  let page='process';const h=processingHarness({currentPage:()=>page}),gate=deferred();
  h.pollGate=gate;await h.enableGlow();h.finish('job1');
  page='stack';h.ui.pageChanged();const displayed=h.calls.native.length,statusCount=h.calls.status.length;
  gate.resolve();await h.flush();await h.tick(180);
  assert.equal(h.images.has('resultjob1'),false);assert.equal(h.images.has('input1'),true);
  assert.equal(h.calls.native.length,displayed);assert.equal(h.calls.status.length,statusCount);
  page='process';h.ui.pageChanged();await h.tick(180);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.uploads.length,1);
  h.finish('job2');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
});

test('an old processing error arriving after page exit does not overwrite another tool status',async()=>{
  let page='process';const h=processingHarness({currentPage:()=>page}),gate=deferred();
  h.pollGate=gate;await h.enableGlow();
  page='stack';h.ui.pageChanged();
  h.jobs.get('job1').state='error';h.jobs.get('job1').error='Old page failure';
  const statusCount=h.calls.status.length;
  gate.resolve();await h.flush();
  assert.equal(h.calls.status.length,statusCount);assert.deepEqual(h.calls.unsafeDeletes,[]);
  page='process';h.ui.pageChanged();h.emit('process_glow_strength_range','input',2);await h.tick(180);
  assert.equal(h.calls.jobs.length,2);assert.equal(h.calls.uploads.length,1);
  h.finish('job2');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
});

test('page exit while old native readers finish skips the next source upload',async()=>{
  let page='process';const h=processingHarness({currentPage:()=>page}),gate=deferred(),native=h.host.canvasStarPreview;
  await h.enableGlow();h.finish('job1');await h.tick(150);
  h.host.canvasStarPreview=async(...args)=>{
    await gate.promise;
    if(!args.at(-1)()){const error=new Error('Superseded');error.stale=true;throw error;}
    return native(...args);
  };
  h.emit('processBackground','change',13);await h.flush();
  h.emit('processSource','change',12);await h.tick(180);
  page='stack';h.ui.pageChanged();gate.resolve();await h.flush();
  assert.equal(h.calls.uploads.length,1);assert.equal(h.calls.jobs.length,1);
  assert.deepEqual(h.calls.deleted,['resultjob1','input1']);assert.deepEqual(h.calls.unsafeDeletes,[]);
  page='process';h.ui.pageChanged();await h.tick(180);
  assert.equal(h.calls.uploads.length,2);assert.equal(h.calls.uploads[1].layerID,12);
  h.finish('job2');await h.tick(150);
});

test('an upload waiting to enter the modal callback checks the page before reading pixels',async()=>{
  let page='process';const h=processingHarness({currentPage:()=>page}),gate=deferred();
  h.host.core.executeAsModal=async action=>{await gate.promise;return action({});};
  await h.enableGlow();page='stack';h.ui.pageChanged();gate.resolve();await h.flush();
  assert.equal(h.calls.uploads.length,0);assert.equal(h.calls.jobs.length,0);
  page='process';h.ui.pageChanged();await h.tick(180);
  assert.equal(h.calls.uploads.length,1);assert.equal(h.calls.jobs.length,1);
  h.finish('job1');await h.tick(150);
  assert.match(h.elements.get('processPreviewHint').textContent,/已更新/);
});
