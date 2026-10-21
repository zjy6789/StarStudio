const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function panel() {
  const elements=new Map(),calls={jobs:[],api:[],preview:[],applied:[],closed:[],copies:[],deleted:[],status:[],source:[],onApplied:[]};
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/id="([^"]+)"/g))elements.set(match[1],{value:'',checked:false,disabled:false,listeners:{},addEventListener(name,action){this.listeners[name]=action;}});
  const get=id=>{assert.ok(elements.has(id),id);return elements.get(id);};
  const h={get,calls,busy:false,gate:null,clip:false,changed:false,alreadyOpen:false,profile:'Star Studio Linear ProPhoto RGB',applyFailure:null,saveFailure:null};
  const user={id:1,title:'Existing user document'},host={app:{documents:[user],activeDocument:user},constants:{BitsPerChannelType:{THIRTYTWO:32},DocumentMode:{RGB:'RGB'}},core:{executeAsModal:async action=>action({})}};
  function doc(id){const d={id,width:320,height:256,bitsPerChannel:32,mode:'RGB',colorProfileName:h.profile,closeWithoutSaving:async()=>{calls.closed.push(id);host.app.documents=host.app.documents.filter(d=>d.id!==id);host.app.activeDocument=user;}};host.app.documents.push(d);return d;}
  host.canvasFloatPreview=async(state,key,meta,title,api,report,label)=>{calls.preview.push({key,meta,title,label});const d=host.app.documents.find(d=>d.id===300)||doc(300);host.app.activeDocument=d;return {docID:d.id};};
  host.applyFloatResult=async(meta,key,api,report,options)=>{if(h.applyFailure)throw h.applyFailure;calls.applied.push({meta,key,options});const d=doc(400);host.app.activeDocument=d;return d;};
  const selected={name:'prepared.tif',nativePath:'D:\\fixtures\\prepared.tif',copyTo:async folder=>{calls.copies.push(folder.nativePath);const entry={name:'prepared.tif',isFile:true,nativePath:folder.nativePath+'\\prepared.tif',delete:async()=>{folder.entries=folder.entries.filter(e=>e!==entry);}};folder.entries.push(entry);return entry;}};
  h.file=selected;h.output={name:'output.tif',nativePath:'D:\\fixtures\\output.tif'};
  const storage={getFileForOpening:async()=>h.file,getFileForSaving:async()=>h.output,createSessionToken:file=>file.nativePath,
    getTemporaryFolder:async()=>({nativePath:'C:\\UXPTemp',createFolder:async name=>{const folder={nativePath:'C:\\UXPTemp\\'+name,entries:[],getEntries:async()=>folder.entries,delete:async()=>{if(folder.entries.length)throw new Error('Delete on non-empty folder not allowed');calls.deleted.push(folder.nativePath);}};h.temporaryFolder=folder;return folder;}})};
  const photoshop={action:{batchPlay:async()=>{host.app.activeDocument=h.alreadyOpen?user:doc(200);return [{}];}}};
  const info={image:'input',path:selected.nativePath,width:320,height:256,profile:'Star Studio Linear ProPhoto RGB',minimum:0,maximum:1,provenance:{mapping:{offset:-.125,scale:4}},suggestion:{amount:4,protection:.75,background:.8},suggestionReason:'Conservative suggestion'};
  const context={module:{exports:{}},document:{getElementById:get},console,Date,Set,require:name=>name==='./host.js'?host:name==='uxp'?{storage:{localFileSystem:storage}}:photoshop};
  vm.runInNewContext(fs.readFileSync('plugin/protected-stretch.js','utf8'),context);
  h.ui=context.module.exports.setup({isBusy:()=>h.busy,api:async(...args)=>{calls.api.push(args);return {};},report(){},status:(...args)=>calls.status.push(args),
    run:async action=>{if(h.busy)return;h.busy=true;try{return await action();}finally{h.busy=false;h.ui.updateActions();}},
    onSource:d=>calls.source.push(d.id),onApplied:(d,nonlinear)=>calls.onApplied.push({id:d.id,nonlinear,active:host.app.activeDocument.id}),
    job:async(request,started)=>{calls.jobs.push({...request});started('job');if(h.gate)await h.gate;
      if(request.op==='stretchInspect')return info;
      if(h.changed)throw new Error('准备副本已变化');
      if(request.op==='stretchCheck')return {ok:true};
      if(request.op==='stretchRender'){h.lastAmount=request.settings.amount;return {image:'render'+calls.jobs.length,curve:{sp:.001,hp:.475},stats:{newBlackChannels:0,newWhiteChannels:h.clip?1:0,nearWhitePixels:4,maxStorageError:1e-8}};}
      if(h.saveFailure)throw h.saveFailure;
      return {path:h.output.nativePath,metadata:{nonlinearStretch:h.lastAmount>0}};
    }});
  h.emit=(id,event='click')=>get(id).listeners[event]?.();h.choose=()=>h.emit('stretchChoose');h.load=async()=>{get('stretchConfirmed').checked=true;await h.emit('stretchConfirmed','change');await h.emit('stretchLoad');};h.preview=()=>h.emit('stretchPreview');h.execute=()=>h.emit('stretchExecute');h.host=host;
  return h;
}

test('T6 reads only after explicit confirmation, suggests without applying, and works without an open PS document',async()=>{
  const h=panel();h.host.app.documents=[];await h.choose();assert.equal(h.get('stretchLoad').disabled,true);
  await h.load();assert.equal(h.get('stretch_amount').value,4);assert.equal(h.calls.preview.length,0);assert.equal(h.calls.applied.length,0);
  assert.equal(h.get('stretchExecute').disabled,true);assert.match(h.get('stretchState').textContent,/尚未打开.*未应用/);
});

test('preview uses its own file copy and original comparison leaves the current result intact',async()=>{
  const h=panel();await h.choose();await h.load();await h.preview();
  assert.equal(h.calls.copies.length,1);assert.ok(h.calls.copies[0].startsWith('C:\\UXPTemp\\starstudio-stretch-'));
  assert.equal(h.calls.preview[0].meta.size,32);assert.equal(h.calls.preview[0].meta.components,3);assert.equal(h.calls.preview[0].label,'线性提亮');
  const key=h.calls.preview[0].key;h.get('stretchOriginal').checked=true;await h.emit('stretchOriginal','change');
  assert.equal(h.calls.preview.at(-1).key,null);assert.equal(h.calls.jobs.at(-1).op,'stretchCheck');
  await h.execute();assert.equal(h.calls.applied[0].key,key);assert.equal(h.calls.applied[0].options.suffix,'_stretched');
  assert.deepEqual(h.calls.onApplied,[{id:400,nonlinear:true,active:400}]);assert.ok(!h.calls.closed.includes(1));
  assert.ok(h.calls.closed.includes(200)&&h.calls.closed.includes(300));assert.equal(h.calls.deleted.length,1);
  assert.ok(h.calls.api.some(c=>c[0]==='/images/input'&&c[3]==='DELETE'));
});

test('new parameters recompute from the original snapshot and 0 strength output stays linear',async()=>{
  const h=panel();await h.choose();await h.load();await h.preview();await h.emit('stretchReset');
  const request=h.calls.jobs.filter(j=>j.op==='stretchRender').at(-1);assert.equal(request.image,'input');assert.equal(request.settings.amount,0);
  await h.execute();assert.equal(h.calls.onApplied[0].nonlinear,false);assert.match(h.get('stretchState').textContent,/仍|线性恒等/);
});

test('changing parameters while viewing original does not count as inspecting the new processed effect',async()=>{
  const h=panel();await h.choose();await h.load();await h.preview();h.get('stretchOriginal').checked=true;await h.emit('stretchOriginal','change');
  h.get('stretch_amount').value=5;await h.emit('stretch_amount','change');assert.equal(h.get('stretchExecute').disabled,true);
  await assert.rejects(h.execute(),/先查看当前参数/);h.get('stretchOriginal').checked=false;await h.emit('stretchOriginal','change');
  assert.equal(h.get('stretchExecute').disabled,false);
});

test('new black or white endpoints are visible and cannot be saved',async()=>{
  const h=panel();h.clip=true;await h.choose();await h.load();await h.preview();
  assert.equal(h.get('stretchExecute').disabled,true);assert.match(h.get('stretchFeedback').textContent,/白端点 1/);
  await assert.rejects(h.execute(),/新增黑\/白端点/);assert.ok(!h.calls.jobs.some(j=>j.op==='stretchSave'));
});

test('changed files invalidate cached preview reuse and prevent saving',async()=>{
  const h=panel();await h.choose();await h.load();await h.preview();h.changed=true;
  await assert.rejects(h.preview(),/已变化/);await assert.rejects(h.execute(),/当前参数/);
});

test('a same-document Photoshop open never closes or overwrites user work',async()=>{
  const h=panel();await h.choose();await h.load();h.alreadyOpen=true;
  await assert.rejects(h.preview(),/未能建立独立/);assert.equal(h.calls.preview.length,0);assert.ok(!h.calls.closed.includes(1));assert.equal(h.calls.deleted.length,1);
});

test('mismatched PS input is closed without touching user documents',async()=>{
  const h=panel();await h.choose();await h.load();h.profile='Other ICC';
  await assert.rejects(h.preview(),/配置不符/);assert.ok(h.calls.closed.includes(200));assert.ok(!h.calls.closed.includes(1));
});

test('save cancellation preserves the preview and a later PS failure reports the already saved file',async()=>{
  const h=panel();await h.choose();await h.load();await h.preview();h.output=null;await h.execute();assert.equal(h.calls.applied.length,0);
  h.output={nativePath:'D:\\fixtures\\output.tif'};h.applyFailure=new Error('modal failed');
  await assert.rejects(h.execute(),/文件已保存于.*output.tif.*PS结果层未能完成/);assert.match(h.get('stretchSaved').textContent,/output.tif/);
});

test('saving into the private preview directory is refused before a later cleanup can delete it',async()=>{
  const h=panel();await h.choose();await h.load();await h.preview();h.output={nativePath:h.calls.copies[0]+'\\kept.tif'};
  await assert.rejects(h.execute(),/临时预览目录之外/);assert.ok(!h.calls.jobs.some(j=>j.op==='stretchSave'));
});

test('unexpected temporary entries are preserved, caches are released, and an existing PS result is reported honestly',async()=>{
  const h=panel();await h.choose();await h.load();await h.preview();
  const extra={name:'unknown.txt',isFile:true,nativePath:h.temporaryFolder.nativePath+'\\unknown.txt'};h.temporaryFolder.entries.push(extra);
  await assert.rejects(h.execute(),/PS结果层已创建.*其他条目/);
  assert.deepEqual(h.temporaryFolder.entries,[extra]);assert.equal(h.calls.deleted.length,0);
  assert.ok(h.calls.api.some(c=>c[0]==='/images/input'&&c[3]==='DELETE'));assert.match(h.get('stretchState').textContent,/结果层已创建/);
});

test('last prepared copy is explicit and canceled file selection retains the previous choice',async()=>{
  const h=panel();h.ui.setLastPrepared(h.file);assert.equal(h.calls.jobs.length,0);assert.equal(h.get('stretchUseLast').disabled,false);
  await h.emit('stretchUseLast');h.file=null;await h.choose();await h.load();assert.equal(h.calls.jobs[0].path,'D:\\fixtures\\prepared.tif');
});

test('cancel is available during backend work and its UI recovers afterward',async()=>{
  const h=panel();await h.choose();let release;h.gate=new Promise(r=>{release=r;});const pending=h.load();await new Promise(setImmediate);
  assert.equal(h.get('stretchCancel').disabled,false);await h.emit('stretchCancel');assert.ok(h.calls.api.some(c=>c[0]==='/jobs/job'&&c[3]==='DELETE'));
  h.gate=null;release();await pending;assert.equal(h.get('stretchCancel').disabled,true);
});
