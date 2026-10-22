const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function panel(){
  const elements=new Map(),calls={jobs:[],requests:[],previews:[],applied:[],closed:[],selections:0};
  for(const m of fs.readFileSync('plugin/index.html','utf8').matchAll(/<[^>]+id="([^"]+)"[^>]*>/g))elements.set(m[1],{value:m[0].match(/value="([^"]*)"/)?.[1]||'',selectedIndex:0,checked:false,listeners:{},classList:{toggle(){}},addEventListener(name,fn){this.listeners[name]=fn;}});
  const get=id=>{assert.ok(elements.has(id),id);return elements.get(id);};
  const doc={id:1,width:160,height:96,bitsPerChannel:16,mode:'RGB',activeHistoryState:{id:7}},layer={id:11,name:'background'};
  const h={get,calls,doc,layer,busy:false,stage:'developed'};
  const host={constants:{DocumentMode:{GRAYSCALE:'Gray'}},app:{documents:[doc]},core:{executeAsModal:async fn=>fn({})},
    uploadSelection:async()=>{calls.selections++;return 'selection'+calls.selections;},
    uploadBackground:async(d,l,api)=>{await api('/images',{});await api('/images/source?y=0&rows=96',new ArrayBuffer(0));if(h.readHook)h.readHook();return {id:'source',size:32,components:d.mode==='Gray'?2:4,name:l.name};},
    canvasFloatPreview:async(state,key,meta,title,api,report,label,editable)=>{calls.previews.push({key,meta,title,editable});await api('/images/source?y=0&rows=1',undefined,true);if(key)await api('/images/'+key+'?y=0&rows=1',undefined,true);if(h.previewFailure)throw h.previewFailure;
      if(!host.app.documents.some(d=>d.id===55))host.app.documents.push({id:55,closeWithoutSaving:async()=>{calls.closed.push(55);host.app.documents=host.app.documents.filter(d=>d.id!==55);}});return {docID:55};},
    applyFloatResult:async(meta,key,api,report,options)=>{calls.applied.push({meta,key,options});return {id:99};}};
  const context={module:{exports:{}},document:{getElementById:get},console,require:()=>host};
  vm.runInNewContext(fs.readFileSync('plugin/background-denoise.js','utf8'),context);
  h.ui=context.module.exports.setup({api:async(...args)=>{calls.requests.push(args);return {};},report(){},selectedLayer:()=>({doc:h.doc,layer:h.layer}),isBusy:()=>h.busy,stage:()=>h.stage,isUpdatingPickers:()=>h.updating,status(){},onApplied:d=>{h.applied=d;},
    run:async fn=>{if(h.busy)return;h.busy=true;try{return await fn();}finally{h.busy=false;h.ui.updateActions();}},
    job:async(request,onStart)=>{calls.jobs.push(JSON.parse(JSON.stringify(request)));onStart('job');if(h.gate)await h.gate;if(h.failure)throw h.failure;if(request.op==='denoiseRender'&&h.renderFailure)throw h.renderFailure;
      return request.op==='denoiseFit'?{sigma:h.sigma??.005,patches:5,samplingPreview:'data:patches'}:{image:'result'+calls.jobs.length,stats:{negativeChannels:1,aboveOneChannels:2}};}});
  h.emit=async(id,event='click')=>get(id).listeners[event]();h.capture=()=>h.emit('denoiseCapture');h.generate=()=>h.emit('denoiseGenerate');
  h.confirm=()=>{get('denoiseReviewed').checked=true;h.ui.updateActions();};return h;
}

test('opening tools does not read photos; default requires an explicit background selection',async()=>{
  const h=panel();await h.emit('denoiseOptions');await h.emit('denoiseAdvancedOptions');assert.equal(h.calls.jobs.length,0);assert.equal(h.get('denoiseScope').selectedIndex,0);
  await assert.rejects(h.generate(),/背景作用选区/);assert.equal(h.calls.requests.length,0);
});
test('a target snapshot and RGB default use chroma only, typed source, and a reviewed editable result',async()=>{
  const h=panel();await h.capture();await h.generate();assert.equal(h.calls.jobs[0].target,'selection1');assert.equal(h.calls.jobs[1].options.mode,'chroma');assert.equal(h.calls.jobs[1].options.strength,.5);
  assert.ok(h.calls.requests.some(r=>r[0]==='/denoise-sources'));assert.ok(h.calls.requests.some(r=>r[0]==='/denoise-sources/source?y=0&rows=1'));assert.ok(h.calls.requests.some(r=>r[0].startsWith('/images/result')));
  await assert.rejects(h.emit('denoiseExecute'),/确认/);h.confirm();await h.emit('denoiseExecute');assert.equal(h.calls.applied[0].options.editableBase,true);assert.equal(h.applied.id,99);
});
test('whole starless scope is explicit and does not silently capture a selection',async()=>{
  const h=panel();h.get('denoiseScope').selectedIndex=1;await h.emit('denoiseScope','change');await h.generate();
  assert.equal(h.calls.selections,0);assert.equal(h.calls.jobs[0].scope,'starless');assert.equal(h.calls.jobs[0].confirmedStarless,true);
});
test('strength/detail changes reuse one input and target snapshot; gray defaults to luminance',async()=>{
  const h=panel();await h.capture();await h.generate();h.confirm();h.get('denoiseStrength').value=.8;await h.emit('denoiseStrength','change');
  await assert.rejects(h.emit('denoiseExecute'),/确认/);await h.emit('denoisePreview');assert.equal(h.calls.jobs.filter(j=>j.op==='denoiseFit').length,1);assert.equal(h.calls.selections,1);
  assert.equal(h.calls.jobs.at(-1).options.strength,.8);h.get('denoiseView').selectedIndex=1;await h.emit('denoiseView','change');assert.equal(h.calls.previews.at(-1).key,null);
  h.get('denoiseView').selectedIndex=2;await h.emit('denoiseView','change');assert.equal(h.calls.jobs.at(-1).view,'weights');h.confirm();await h.emit('denoiseExecute');assert.equal(h.calls.applied[0].key,'result3');
  const gray=panel();gray.doc.mode='Gray';await gray.capture();await gray.generate();assert.equal(gray.calls.jobs[1].options.mode,'joint');
});
test('linear stage and changed document/history cannot apply a stale result',async()=>{
  for(const mutate of [h=>h.stage='linear',h=>h.doc.activeHistoryState.id++,h=>h.layer={id:12}]){const h=panel();await h.capture();await h.generate();h.confirm();mutate(h);h.ui.sync();await assert.rejects(h.emit('denoiseExecute'));assert.equal(h.calls.applied.length,0);}
});
test('source changes during read or slow render are rejected, with no current output claim',async()=>{
  const h=panel();await h.capture();h.readHook=()=>h.doc.activeHistoryState.id++;await assert.rejects(h.generate(),/读取期间/);assert.ok(h.calls.requests.some(r=>r[0]==='/denoise-sources/source'&&r[3]==='DELETE'));
  const slow=panel();await slow.capture();await slow.generate();slow.get('denoiseDetail').value=.8;await slow.emit('denoiseDetail','change');let release;slow.gate=new Promise(r=>release=r);const pending=slow.emit('denoisePreview');await new Promise(setImmediate);slow.doc.width++;release();await assert.rejects(pending,/变化/);assert.equal(slow.get('denoiseExecute').disabled,true);
});
test('failed native preview disables apply and can be retried; noise-free input is labeled',async()=>{
  const h=panel();h.sigma=0;await h.capture();await h.generate();assert.match(h.get('denoiseSummary').textContent,/原样/);
  h.get('denoiseStrength').value=.8;await h.emit('denoiseStrength','change');h.previewFailure=new Error('native rejected');await assert.rejects(h.emit('denoisePreview'),/native rejected/);h.confirm();await assert.rejects(h.emit('denoiseExecute'),/当前参数/);
  h.previewFailure=null;await h.emit('denoisePreview');h.confirm();await h.emit('denoiseExecute');assert.equal(h.calls.applied.length,1);
});
test('cancel remains available while fitting and the run lock cannot swallow source invalidation',async()=>{
  const h=panel();await h.capture();let release;h.gate=new Promise(r=>release=r);const pending=h.generate();await new Promise(setImmediate);assert.equal(h.get('denoiseCancel').disabled,false);await h.emit('denoiseCancel');assert.ok(h.calls.requests.some(r=>r[0]==='/jobs/job'&&r[3]==='DELETE'));
  h.failure=new Error('已取消');release();await assert.rejects(pending,/已取消/);assert.equal(h.get('denoiseExecute').disabled,true);
  const ready=panel();await ready.capture();await ready.generate();ready.confirm();ready.busy=true;ready.layer={id:12};await ready.emit('backgroundSource','change');assert.equal(ready.get('denoiseReviewed').checked,false);
});

test('correlated treatment is explicit and confirmation does not carry across source or scope',async()=>{
  const h=panel();await h.capture();await h.generate();assert.equal(h.calls.jobs[1].options.correlated,false);
  h.get('denoiseCorrelated').checked=true;await h.emit('denoiseCorrelated','change');await h.emit('denoisePreview');assert.equal(h.calls.jobs.at(-1).options.correlated,true);
  h.get('denoiseScope').selectedIndex=1;await h.emit('denoiseScope','change');assert.equal(h.get('denoiseCorrelated').checked,false);
  await h.generate();h.get('denoiseCorrelated').checked=true;await h.emit('backgroundSource','change');assert.equal(h.get('denoiseCorrelated').checked,false);
});

test('a refused first render retains valid reference blocks and supports an explicit parameter retry',async()=>{
  const h=panel();await h.capture();h.renderFailure=new Error('numerical range refused');
  await assert.rejects(h.generate(),/numerical range/);assert.equal(h.get('denoisePreview').disabled,false);
  assert.equal(h.calls.requests.some(r=>r[0]==='/denoise-sources/source'&&r[3]==='DELETE'),false);
  h.confirm();await assert.rejects(h.emit('denoiseExecute'),/确认/);
  h.renderFailure=null;h.get('denoiseCorrelated').checked=true;await h.emit('denoiseCorrelated','change');await h.emit('denoisePreview');
  assert.equal(h.calls.jobs.filter(j=>j.op==='denoiseFit').length,1);h.confirm();await h.emit('denoiseExecute');assert.equal(h.calls.applied.length,1);
});
