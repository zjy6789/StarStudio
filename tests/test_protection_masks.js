const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function panel() {
  const elements=new Map(),calls={jobs:[],uploads:[],selections:0,applied:[],deleted:[],status:[]};
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/<[^>]+id="([^"]+)"[^>]*>/g))
    elements.set(match[1],{value:match[0].match(/value="([^"]*)"/)?.[1] || '',selectedIndex:0,checked:false,disabled:false,listeners:{},classList:{toggle(){}},addEventListener(name,action){this.listeners[name]=action;}});
  const get=id=>{assert.ok(elements.has(id),id);return elements.get(id);};
  const doc={id:1,width:6,height:4,bitsPerChannel:16,activeHistoryState:{id:7}},layer={id:11,name:'stars'};
  const h={get,calls,doc,layer,busy:false,relation:{known:true,encoding:'gray'},saveFile:null};
  const api=async(path,body,raw,method)=>{
    if(method==='DELETE'){calls.deleted.push(path);return;}
    calls.uploads.push(path);return {id:'input'};
  };
  const host={core:{executeAsModal:async action=>action({})},
    upload:async(d,l,api)=>{await api('/images',{});await api('/images/input?y=0&rows=4',new ArrayBuffer(0));if(h.uploadHook)h.uploadHook();return {id:'input',size:d.bitsPerChannel};},
    uploadSelection:async()=>{calls.selections++;return 'selection'+calls.selections;},
    applySelection:async(d,key,meta,invert)=>{calls.applied.push({doc:d.id,key,meta,invert});d.activeHistoryState.id++;}};
  const context={module:{exports:{}},document:{getElementById:get},console,require:name=>name==='./host.js'?host:{storage:{localFileSystem:{getFileForSaving:async()=>h.saveFile}}}};
  vm.runInNewContext(fs.readFileSync('plugin/protection-masks.js','utf8'),context);
  h.ui=context.module.exports.setup({api,report(){},isBusy:()=>h.busy,isUpdatingPickers:()=>h.updating,selectedLayer:()=>{if(!h.layer)throw new Error('no source');return {doc:h.doc,layer:h.layer};},workingDocument:()=>h.doc,starRelation:()=>h.relation,
    status:(...args)=>calls.status.push(args),
    run:async action=>{if(h.busy)return;h.busy=true;try{return await action();}finally{h.busy=false;h.ui.updateActions();}},
    job:async(request,onStart)=>{calls.jobs.push(JSON.parse(JSON.stringify(request)));onStart('job');if(h.gate)await h.gate;if(h.failure)throw h.failure;
      if(request.op==='maskSave')return {path:request.output};return {image:'mask'+calls.jobs.length,width:h.doc.width,height:h.doc.height,preview:'data:mask',whiteCoverage:.1,corePixels:2};}});
  h.emit=async(id,event='click')=>get(id).listeners[event]();
  h.generate=()=>h.emit('maskGenerate');
  h.confirm=()=>{get('maskReviewed').checked=true;h.ui.updateActions();};
  return h;
}

test('collapsed masks do no reading; unknown stars require an explicit encoding relation',async()=>{
  const h=panel();h.ui.updateActions();await h.emit('maskOptions');
  assert.equal(h.calls.jobs.length,0);assert.equal(h.calls.uploads.length,0);assert.equal(h.get('maskApply').disabled,true);
  h.relation.known=false;await assert.rejects(h.generate(),/编码未知/);assert.equal(h.calls.uploads.length,0);
});

test('gray stars keep source bit depth, use only the typed route, and require coverage confirmation',async()=>{
  const h=panel();await h.generate();
  assert.deepEqual(h.calls.uploads,['/mask-sources','/mask-sources/input?y=0&rows=4']);
  assert.equal(h.calls.jobs[0].options.encoding,'gray');assert.equal(h.calls.jobs[0].options.bits,16);
  assert.equal(h.calls.applied.length,0);await assert.rejects(h.emit('maskApply'),/检查/);
  h.confirm();await h.emit('maskApply');assert.equal(h.calls.applied[0].invert,true);assert.equal(h.calls.applied[0].doc,1);
  h.ui.sync();assert.equal(h.get('maskApply').disabled,false); // Our own selection history is allowed.
});

test('outside coverage reuses the stellar snapshot and selects white by default',async()=>{
  const h=panel();await h.generate();h.get('maskMode').selectedIndex=1;await h.emit('maskMode','change');
  assert.equal(h.get('maskInvert').checked,false);assert.equal(h.get('maskReviewed').checked,false);
  await h.generate();assert.equal(h.calls.uploads.length,2);assert.equal(h.calls.jobs.at(-1).options.mode,'outside');
  h.confirm();await h.emit('maskApply');assert.equal(h.calls.applied.at(-1).invert,false);
});

test('subject is an explicit stable selection snapshot; recomputing never reads applied selection',async()=>{
  const h=panel();h.layer=null;h.get('maskMode').selectedIndex=2;await h.emit('maskMode','change');
  await assert.rejects(h.generate(),/读取主体选区/);assert.equal(h.calls.selections,0);
  await h.emit('maskReadSelection');assert.equal(h.calls.selections,1);
  assert.equal(h.calls.jobs[0].options.grow,0);assert.equal(h.calls.jobs[0].options.feather,0);
  h.confirm();await h.emit('maskApply');
  h.get('maskGrow').value=3;await h.emit('maskGrow','change');await h.generate();
  assert.equal(h.calls.selections,1);assert.equal(h.calls.jobs.at(-1).image,'selection1');
  await h.emit('maskReadSelection');assert.equal(h.calls.selections,2);
  assert.ok(h.calls.deleted.includes('/images/selection1'));
});

test('changed parameters or inversion cannot apply an unreviewed result; save keeps coverage convention',async()=>{
  const h=panel();await h.generate();h.confirm();h.get('maskInvert').checked=false;await h.emit('maskInvert','change');
  await assert.rejects(h.emit('maskApply'),/检查/);h.confirm();h.saveFile={nativePath:'D:\\mask.tif'};await h.emit('maskSave');
  assert.equal(h.calls.jobs.at(-1).op,'maskSave');assert.equal(h.calls.jobs.at(-1).image,'mask1');
  assert.equal('invert' in h.calls.jobs.at(-1),false);
  h.get('maskHigh').value=.03;await h.emit('maskHigh','change');
  await assert.rejects(h.emit('maskApply'),/参数/);assert.ok(h.calls.deleted.includes('/images/mask1'));
});

test('source edits during read or generation are rejected and generated storage is released',async()=>{
  const read=panel();read.uploadHook=()=>read.doc.activeHistoryState.id++;
  await assert.rejects(read.generate(),/读取期间/);assert.ok(read.calls.deleted.includes('/mask-sources/input'));
  const h=panel();let release;h.gate=new Promise(resolve=>release=resolve);const pending=h.generate();
  await new Promise(setImmediate);h.doc.activeHistoryState.id++;release();await assert.rejects(pending,/计算期间/);
  assert.ok(h.calls.deleted.includes('/images/mask1'));assert.equal(h.get('maskApply').disabled,true);
});

test('external history, canvas or encoding changes invalidate the prior result',async()=>{
  for(const mutate of [h=>h.doc.activeHistoryState.id++,h=>h.doc.width++,h=>h.relation.encoding='black']) {
    const h=panel();await h.generate();h.confirm();mutate(h);
    await assert.rejects(h.emit('maskApply'),/变化/);h.ui.sync();await new Promise(setImmediate);
    assert.ok(h.calls.deleted.includes('/mask-sources/input'));assert.equal(h.get('maskReviewed').checked,false);
  }
});

test('picker cancellation does not save, and queued cancellation never applies a mask',async()=>{
  const h=panel();await h.generate();h.confirm();await h.emit('maskSave');assert.equal(h.calls.jobs.length,1);
  h.failure=new Error('已取消');await assert.rejects(h.generate(),/已取消/);assert.equal(h.calls.applied.length,0);
});

test('cancel action targets only the current calculation, without changing source selection',async()=>{
  const h=panel();let release;h.gate=new Promise(resolve=>release=resolve);const pending=h.generate();
  await new Promise(setImmediate);assert.equal(h.get('maskCancel').disabled,false);
  await h.emit('maskCancel');assert.ok(h.calls.deleted.includes('/jobs/job'));
  h.failure=new Error('已取消');release();await assert.rejects(pending,/已取消/);assert.equal(h.calls.applied.length,0);
});

test('halo candidates explicitly reuse the stellar snapshot, select white, and require coverage review',async()=>{
  const h=panel();await h.generate();h.get('maskMode').selectedIndex=3;await h.emit('maskMode','change');
  assert.equal(h.get('maskInvert').checked,false);assert.equal(h.calls.jobs.length,1);
  assert.equal(h.get('maskLowLabel').textContent,'相对色差起点');
  await h.generate();assert.equal(h.calls.uploads.length,2);
  const opts=h.calls.jobs.at(-1).options;
  assert.equal(opts.mode,'halos');assert.equal(opts.encoding,'gray');assert.equal(opts.radius,12);assert.equal(opts.core,3);assert.equal(opts.bright,.25);
  await assert.rejects(h.emit('maskApply'),/检查/);
  h.confirm();await h.emit('maskApply');assert.equal(h.calls.applied.at(-1).invert,false);
  assert.match(h.get('maskSummary').textContent,/只是蓝紫候选/);
});

test('halo geometry changes or no-candidate failures invalidate previous approval',async()=>{
  const h=panel();h.get('maskMode').selectedIndex=3;await h.emit('maskMode','change');await h.generate();h.confirm();
  h.get('maskHaloCore').value=4;await h.emit('maskHaloCore','change');
  assert.equal(h.get('maskApply').disabled,true);assert.equal(h.get('maskReviewed').checked,false);
  h.failure=new Error('未找到候选');await assert.rejects(h.generate(),/未找到候选/);
  assert.equal(h.calls.applied.length,0);assert.equal(h.get('maskApply').disabled,true);
});
