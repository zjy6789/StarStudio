const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function panel() {
  const elements=new Map(),calls={jobs:[],previews:[],applied:[],closed:[],requests:[],status:[]};
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/<[^>]+id="([^"]+)"[^>]*>/g))elements.set(match[1],{value:match[0].match(/value="([^"]*)"/)?.[1] || '',checked:false,selectedIndex:0,listeners:{},classList:{toggle(){}},addEventListener(name,fn){this.listeners[name]=fn;}});
  const get=id=>{assert.ok(elements.has(id),id);return elements.get(id);};
  const doc={id:1,width:128,height:96,bitsPerChannel:16,mode:'RGB',activeHistoryState:{id:7}},layer={id:11,name:'photo'};
  const h={get,calls,doc,layer,busy:false,stage:'developed',counter:0};
  const host={constants:{DocumentMode:{RGB:'RGB'}},app:{documents:[doc]},core:{executeAsModal:async fn=>fn({})},
    uploadSelection:async()=>{h.counter++;return 'selection'+h.counter;},
    uploadBackground:async(d,l,api)=>{await api('/images',{});await api('/images/source?y=0&rows=96',new ArrayBuffer(0));if(h.readHook)h.readHook();return {id:'source',docID:d.id,layerID:l.id,size:32,components:4,name:l.name};},
    canvasFloatPreview:async(state,key,meta,title,api,report,label,editable)=>{
      calls.previews.push({key,title,meta,editable});await api('/images/source?y=0&rows=1',undefined,true);
      if(key)await api('/images/'+key+'?y=0&rows=1',undefined,true);
      if(h.previewFailure)throw h.previewFailure;
      const preview={id:55,closeWithoutSaving:async()=>{calls.closed.push(55);host.app.documents=host.app.documents.filter(d=>d.id!==55);}};
      if(!host.app.documents.some(d=>d.id===55))host.app.documents.push(preview);return {docID:55};},
    applyFloatResult:async(meta,key,api,report,options)=>{calls.applied.push({meta,key,options});return {id:99};}};
  const context={module:{exports:{}},document:{getElementById:get},console,require:()=>host};
  vm.runInNewContext(fs.readFileSync('plugin/sky-color.js','utf8'),context);
  h.ui=context.module.exports.setup({api:async(...args)=>{calls.requests.push(args);return {};},report(){},selectedLayer:()=>({doc:h.doc,layer:h.layer}),stage:()=>h.stage,isBusy:()=>h.busy,isUpdatingPickers:()=>h.updating,
    status:(...args)=>calls.status.push(args),onApplied:d=>{h.appliedDocument=d;},
    run:async fn=>{if(h.busy)return;h.busy=true;try{return await fn();}finally{h.busy=false;h.ui.updateActions();}},
    job:async(request,onStart)=>{calls.jobs.push(JSON.parse(JSON.stringify(request)));onStart('job');if(h.gate)await h.gate;if(h.failure)throw h.failure;
      if(request.op==='colorFit')return {median:[.06,.04,.03],candidates:500,sampled:500,rejected:5,samplingPreview:'data:sample'};
      return {image:'result'+calls.jobs.length,stats:{minimum:-.01,maximum:1.2,negativeChannels:2,aboveOneChannels:3}};}});
  h.emit=async(id,event='click')=>get(id).listeners[event]();
  h.generate=()=>h.emit('colorGenerate');h.sample=()=>h.emit('colorSample');
  h.confirm=()=>{get('colorReviewed').checked=true;h.ui.updateActions();};
  return h;
}

test('opening cards enables no color effect and never reads a photo or whole-frame sample',async()=>{
  const h=panel();await h.emit('colorOptions');await h.emit('colorAdvancedOptions');
  assert.equal(h.calls.jobs.length,0);assert.equal(h.get('colorNeutralEnabled').checked,false);assert.equal(h.get('colorBoostEnabled').checked,false);
  await assert.rejects(h.generate(),/指定|选择可靠天空/);assert.equal(h.calls.requests.length,0);
});

test('explicit local sample and protected preview use typed input but normal result IDs',async()=>{
  const h=panel();await h.sample();await h.generate();
  assert.equal(h.calls.jobs[0].sampling,'selection1');assert.equal(h.calls.jobs[1].options.neutral,0);assert.equal(h.calls.jobs[1].options.boost,0);
  assert.equal(h.calls.requests[0][0],'/color-sources');
  assert.ok(h.calls.requests.some(r=>r[0]==='/color-sources/source?y=0&rows=1'));
  assert.ok(h.calls.requests.some(r=>r[0].startsWith('/images/result')));
  assert.equal(h.calls.previews[0].editable,true);assert.equal(h.calls.applied.length,0);
  await assert.rejects(h.emit('colorExecute'),/确认/);h.confirm();await h.emit('colorExecute');
  assert.equal(h.calls.applied[0].options.editableBase,true);assert.equal(h.appliedDocument.id,99);assert.ok(h.calls.closed.includes(55));
});

test('effect changes invalidate confirmation and render from the same snapshot',async()=>{
  const h=panel();await h.sample();await h.generate();h.confirm();
  h.get('colorBoostEnabled').checked=true;await h.emit('colorBoostEnabled','change');
  assert.equal(h.get('colorReviewed').checked,false);await assert.rejects(h.emit('colorExecute'),/确认/);
  await h.emit('colorPreview');assert.equal(h.calls.jobs.at(-1).options.boost,.3);
  assert.equal(h.calls.jobs.filter(x=>x.op==='colorFit').length,1);
  h.get('colorView').selectedIndex=1;await h.emit('colorView','change');assert.equal(h.calls.previews.at(-1).key,null);
  h.get('colorView').selectedIndex=2;await h.emit('colorView','change');assert.equal(h.calls.jobs.at(-1).view,'weights');
  h.confirm();await h.emit('colorExecute');assert.equal(h.calls.applied[0].key,'result3');
});

test('sky and subject selection snapshots remain distinct and capture clears old model',async()=>{
  const h=panel();await h.sample();await h.generate();await h.emit('colorProtect');
  assert.equal(h.get('colorReviewed').checked,false);await h.generate();
  const fit=h.calls.jobs.filter(x=>x.op==='colorFit').at(-1);
  assert.equal(fit.sampling,'selection1');assert.equal(fit.protection,'selection2');
  assert.equal(h.counter,2);await h.emit('colorPreview');assert.equal(h.counter,2);
});

test('source history, layer, and unsupported color/linear stages reject stale output',async()=>{
  for(const mutate of [h=>h.doc.activeHistoryState.id++,h=>h.layer={id:12},h=>h.stage='linear',h=>h.doc.mode='Gray']) {
    const h=panel();await h.sample();await h.generate();h.confirm();mutate(h);h.ui.sync();
    await assert.rejects(h.emit('colorExecute'));assert.equal(h.get('colorExecute').disabled,true);assert.equal(h.calls.applied.length,0);
  }
});

test('source changes during upload or slow render cannot announce or apply a fresh preview',async()=>{
  const h=panel();await h.sample();h.readHook=()=>h.doc.activeHistoryState.id++;
  await assert.rejects(h.generate(),/读取期间/);assert.ok(h.calls.requests.some(r=>r[0]==='/color-sources/source' && r[3]==='DELETE'));
  const slow=panel();await slow.sample();await slow.generate();slow.get('colorNeutralEnabled').checked=true;await slow.emit('colorNeutralEnabled','change');
  let release;slow.gate=new Promise(resolve=>release=resolve);const pending=slow.emit('colorPreview');await new Promise(setImmediate);
  slow.doc.activeHistoryState.id++;release();await assert.rejects(pending,/变化/);assert.equal(slow.get('colorExecute').disabled,true);
});

test('preview failure cannot be applied as current; retry can restore a valid result',async()=>{
  const h=panel();await h.sample();await h.generate();h.get('colorBoostEnabled').checked=true;await h.emit('colorBoostEnabled','change');
  h.previewFailure=new Error('native rejected');await assert.rejects(h.emit('colorPreview'),/native rejected/);h.confirm();
  await assert.rejects(h.emit('colorExecute'),/当前参数/);h.previewFailure=null;await h.emit('colorPreview');h.confirm();await h.emit('colorExecute');
  assert.equal(h.calls.applied.length,1);
});

test('source picker invalidation is synchronous even when the gradient page already owns the run lock',async()=>{
  const h=panel();await h.sample();await h.generate();h.confirm();h.busy=true;h.layer={id:12};
  await h.emit('backgroundSource','change');assert.equal(h.get('colorReviewed').checked,false);
  h.busy=false;await assert.rejects(h.emit('colorExecute'),/变化/);
});

test('cancel stays available during fitting and leaves no applicable result',async()=>{
  const h=panel();await h.sample();let release;h.gate=new Promise(resolve=>release=resolve);const pending=h.generate();
  await new Promise(setImmediate);assert.equal(h.get('colorCancel').disabled,false);await h.emit('colorCancel');
  assert.ok(h.calls.requests.some(r=>r[0]==='/jobs/job' && r[3]==='DELETE'));
  h.failure=new Error('已取消');release();await assert.rejects(pending,/已取消/);assert.equal(h.get('colorExecute').disabled,true);
  assert.ok(h.calls.requests.some(r=>r[0]==='/color-sources/source' && r[3]==='DELETE'));
});
