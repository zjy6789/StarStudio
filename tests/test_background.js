const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function panel() {
  const elements=new Map(),calls={jobs:[],preview:[],applied:[],deleted:[],closed:[],status:[]};
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/id="([^"]+)"/g))elements.set(match[1],{value:'',checked:false,disabled:false,listeners:{},classList:{toggle(){}},addEventListener(name,action){this.listeners[name]=action;}});
  const get=id=>{assert.ok(elements.has(id),id);return elements.get(id);};
  const doc={id:1,width:640,height:480,bitsPerChannel:16,activeHistoryState:{id:7}},layer={id:11,name:'photo'};
  const h={get,calls,doc,layer,busy:false,stage:'developed',gate:null,failure:null};
  const host={app:{documents:[doc],activeDocument:doc},core:{executeAsModal:async action=>action({})},
    uploadBackground:async(d,l)=>({id:'input',docID:d.id,layerID:l.id,size:32,name:l.name,width:d.width,height:d.height}),
    uploadSelection:async()=>'mask'+calls.deleted.length,
    canvasBackgroundPreview:async(state,key,meta,title)=>{calls.preview.push({key,meta,title});const preview={id:55,closeWithoutSaving:async()=>{calls.closed.push(55);host.app.documents=host.app.documents.filter(d=>d.id!==55);}};
      if(!host.app.documents.some(d=>d.id===55))host.app.documents.push(preview);return {docID:55};},
    applyBackgroundResult:async(meta,key)=>{calls.applied.push({meta,key});return {id:99};}};
  const context={module:{exports:{}},document:{getElementById:get},console,require:()=>host};
  vm.runInNewContext(fs.readFileSync('plugin/background.js','utf8'),context);
  const api=async(path,body,raw,method)=>{if(method==='DELETE')calls.deleted.push(path);};
  h.ui=context.module.exports.setup({api,report(){},isBusy:()=>h.busy,isUpdatingPickers:()=>h.updating,stage:()=>h.stage,selectedLayer:()=>({doc:h.doc,layer:h.layer}),useActive(){},
    status:(message,error)=>calls.status.push({message,error}),
    run:async action=>{if(h.busy)return;h.busy=true;try{return await action();}finally{h.busy=false;h.ui.updateActions();}},
    job:async(request,started)=>{calls.jobs.push({...request});started('job');if(h.gate)await h.gate;if(h.failure)throw h.failure;
      return request.op==='backgroundFit'?{samples:88,rejected:2,samplingPreview:'data:image/png;base64,test'}:{image:'render'+calls.jobs.length,stats:{minimum:-.01,maximum:1.01,negativeChannels:4,aboveOneChannels:5}};}
  });
  h.emit=(id,event='click')=>get(id).listeners[event]?.();h.host=host;
  h.generate=()=>h.emit('backgroundGenerate');h.confirm=()=>{get('backgroundReviewed').checked=true;return h.emit('backgroundReviewed','change');};
  return h;
}

test('background requires a developed photo, captures one float source and previews at full size',async()=>{
  const h=panel();h.stage='unknown';await assert.rejects(h.generate(),/已显影/);assert.equal(h.calls.jobs.length,0);
  h.stage='linear';await assert.rejects(h.generate(),/HDR/);h.stage='developed';await h.generate();
  assert.deepEqual(h.calls.jobs.map(j=>j.op),['backgroundFit','backgroundRender']);
  assert.equal(h.calls.preview[0].meta.width,640);assert.equal(h.calls.preview[0].meta.size,32);
  assert.equal(h.get('backgroundExecute').disabled,true);assert.match(h.get('backgroundPreviewHint').textContent,/4.*5/);
});

test('original/model comparison never changes the final corrected result',async()=>{
  const h=panel();await h.generate();const result=h.calls.preview[0].key;
  h.get('backgroundView').selectedIndex=1;await h.emit('backgroundView','change');assert.equal(h.calls.jobs.at(-1).view,'model');
  h.get('backgroundView').selectedIndex=2;await h.emit('backgroundView','change');assert.equal(h.calls.preview.at(-1).key,null);
  await h.confirm();await h.emit('backgroundExecute');
  assert.equal(h.calls.applied[0].key,result);assert.ok(h.calls.closed.includes(55));assert.ok(h.calls.deleted.includes('/images/input'));
});

test('strength recomputes from the stable source, reuses the model, and applies exact preview data',async()=>{
  const h=panel();await h.generate();h.get('backgroundStrength').value=.8;await h.emit('backgroundStrength','change');
  const rendered=h.calls.jobs.at(-1);assert.equal(rendered.op,'backgroundRender');assert.equal(rendered.image,'input');assert.equal(rendered.strength,.8);
  assert.equal(h.calls.jobs.filter(j=>j.op==='backgroundFit').length,1);
  await h.confirm();const latest=h.calls.preview.at(-1).key;await h.emit('backgroundExecute');assert.equal(h.calls.applied[0].key,latest);
});

test('PS protection and sampling remain distinct and changing selection invalidates the old model',async()=>{
  const h=panel();await h.emit('backgroundProtect');await h.emit('backgroundSample');await h.generate();
  assert.ok(h.calls.jobs[0].protection);assert.ok(h.calls.jobs[0].sampling);
  await h.confirm();h.doc.activeHistoryState.id++;h.ui.sync({id:h.doc.id});assert.equal(h.get('backgroundExecute').disabled,true);
  await assert.rejects(h.emit('backgroundExecute'),/变化/);
  h.layer={id:12,name:'other'};await h.emit('backgroundSource','change');await h.generate();
  const fit=h.calls.jobs.filter(j=>j.op==='backgroundFit').at(-1);assert.equal(fit.protection,undefined);assert.equal(fit.sampling,undefined);
});

test('failed fitting releases the source and never enables execution',async()=>{
  const h=panel();h.failure=new Error('insufficient sky');await assert.rejects(h.generate(),/insufficient/);
  assert.ok(h.calls.deleted.includes('/images/input'));assert.equal(h.calls.preview.length,0);assert.equal(h.get('backgroundExecute').disabled,true);
});

test('source edits during a slow render cannot be displayed or applied as current',async()=>{
  const h=panel();await h.generate();let release;h.gate=new Promise(r=>{release=r;});
  h.get('backgroundStrength').value=.8;const updating=h.emit('backgroundStrength','change');
  await new Promise(setImmediate);h.doc.activeHistoryState.id++;h.gate=null;release();
  await assert.rejects(updating,/源图层或历史/);assert.equal(h.calls.preview.length,1);
  await h.confirm();await assert.rejects(h.emit('backgroundExecute'),/源图层或历史/);assert.equal(h.calls.applied.length,0);
});

test('refreshing the layer picker does not erase an existing background model',async()=>{
  const h=panel();await h.generate();h.updating=true;await h.emit('backgroundSource','change');
  await h.confirm();assert.equal(h.get('backgroundExecute').disabled,false);assert.equal(h.calls.deleted.length,0);
});

test('cancel remains available while fitting and an unreviewed model cannot be applied',async()=>{
  const h=panel();let resolve;h.gate=new Promise(r=>{resolve=r;});const pending=h.generate();
  await new Promise(setImmediate);assert.equal(h.get('backgroundCancel').disabled,false);await h.emit('backgroundCancel');
  assert.ok(h.calls.deleted.includes('/jobs/job'));h.gate=null;resolve();await pending;
  await assert.rejects(h.emit('backgroundExecute'),/检查取样/);
});
