const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const plain=value=>JSON.parse(JSON.stringify(value));
const file=name=>({name,nativePath:'D:\\fixtures\\'+name});
function panel() {
  const elements=new Map(),calls={jobs:[],open:[],closed:[],opened:[],api:[],save:[],status:[]};
  for(const match of fs.readFileSync('plugin/index.html','utf8').matchAll(/id="([^"]+)"/g))elements.set(match[1],{checked:false,disabled:false,listeners:{},addEventListener(name,action){this.listeners[name]=action;}});
  const get=id=>{assert.ok(elements.has(id),id);return elements.get(id);};
  const info={path:'D:\\fixtures\\master.tif',width:6000,height:4000,profile:'Star Studio Linear ProPhoto RGB',
    fingerprint:{bytes:288000000,mtimeNs:'1792323487123456789'},mapping:{offset:-.125,scale:8},stats:{min:-.125,max:4,negativeChannels:3,aboveOneChannels:8},temporaryGB:.536};
  const h={get,calls,file:file('master.tif'),saved:file('copy.tif'),info,failure:null,gate:null,busy:false,sameDocument:false,openError:null};
  h.fitsInfo={...info,color:'mono',rounding:{changedChannels:0,maxAbsError:0}};
  const original={id:7,title:'Existing work'};
  const doc={id:8,bitsPerChannel:32,mode:'RGB',width:6000,height:4000,colorProfileName:info.profile,closeWithoutSaving:async()=>{calls.closed.push(doc.id);host.app.documents=host.app.documents.filter(d=>d.id!==doc.id);}};
  h.doc=doc;
  const host={app:{documents:[original],activeDocument:original},core:{executeAsModal:async action=>action({})},constants:{BitsPerChannelType:{THIRTYTWO:32},DocumentMode:{RGB:'RGB'}}};
  h.host=host;
  const storage={getFileForOpening:async options=>{assert.equal(options.allowMultiple,false);return h.file;},
    getFileForSaving:async(name,options)=>{calls.save.push({name,options:plain(options)});return h.saved;},createSessionToken:entry=>'token:'+entry.nativePath};
  const photoshop={action:{batchPlay:async commands=>{
    calls.open.push(plain(commands));if(h.openError)return [{_obj:'error',message:h.openError}];
    if(h.sameDocument)host.app.activeDocument=original;else {host.app.documents.push(doc);host.app.activeDocument=doc;}return [{}];
  }}};
  const context={module:{exports:{}},document:{getElementById:get},require:name=>name==='./host.js'?host:name==='uxp'?{storage:{localFileSystem:storage}}:photoshop};
  vm.runInNewContext(fs.readFileSync('plugin/linear-preparation.js','utf8'),context);
  h.ui=context.module.exports.setup({isBusy:()=>h.busy,
    run:async action=>{h.busy=true;h.ui.updateActions(true);try{return await action();}finally{h.busy=false;h.ui.updateActions();}},
    api:async(...args)=>{calls.api.push(args);return {};},status:(message,error)=>calls.status.push({message,error}),onOpened:doc=>calls.opened.push(doc.id),
    job:async(request,started)=>{calls.jobs.push(plain(request));started('job'+calls.jobs.length);if(h.gate)await h.gate;if(h.failure)throw h.failure;
      return request.op==='fitsInspect'?plain(h.fitsInfo):request.op==='prepareInspect'?plain(info):{path:h.saved.nativePath,width:info.width,height:info.height,profile:info.profile,metadata:{rounding:{maxAbsError:1e-8,changedChannels:15}}};}
  });
  h.emit=(id,event='click')=>get(id).listeners[event]?.();
  h.select=()=>h.emit('prepareChoose');
  h.confirm=()=>{get('prepareConfirmed').checked=true;return h.emit('prepareConfirmed','change');};
  h.execute=()=>h.emit('prepareExecute');
  return h;
}

test('file-based preparation works with no Photoshop document and requires explicit confirmation',async()=>{
  const h=panel();h.host.app.documents=[];h.host.app.activeDocument=null;
  assert.equal(h.get('prepareExecute').disabled,true);
  await h.select();assert.deepEqual(h.calls.jobs[0],{op:'prepareInspect',path:h.file.nativePath});
  assert.match(h.get('prepareMapping').textContent,/\+ 0.125.*÷ 8/);
  assert.equal(h.get('prepareExecute').disabled,true);assert.equal(h.calls.open.length,0);
  await h.confirm();assert.equal(h.get('prepareExecute').disabled,false);
  await h.execute();
  assert.deepEqual(h.calls.jobs[1],{op:'prepareLinear',path:h.file.nativePath,output:h.saved.nativePath,fingerprint:h.info.fingerprint,confirmedLinear:true});
  assert.equal(h.calls.save[0].name,'master_prepared_linear.tif');
  assert.equal(h.calls.open[0][0].null._path,'token:'+h.saved.nativePath);
  assert.deepEqual(h.calls.opened,[8]);assert.match(h.get('prepareResult').textContent,/仍为线性.*未拉伸/);
  assert.match(h.get('prepareResult').textContent,/15.*1.0000e-8/);
});

test('last master is an explicit shortcut and other stack formats do not qualify',async()=>{
  const h=panel();assert.equal(h.get('prepareUseLast').disabled,true);
  h.ui.setLastMaster(file('result.tif'),'tiff32');assert.equal(h.get('prepareUseLast').disabled,false);
  assert.equal(h.calls.jobs.length,0);
  await h.emit('prepareUseLast');assert.equal(h.calls.jobs[0].path,'D:\\fixtures\\result.tif');
  h.ui.setLastMaster(file('result.dng'),'dng');assert.equal(h.get('prepareUseLast').disabled,true);
  h.busy=true;h.ui.setLastMaster(file('new.tif'),'tiff32');assert.equal(h.get('prepareUseLast').disabled,true);
});

test('dialog cancellations retain the selected original and never create a copy',async()=>{
  const h=panel();await h.select();await h.confirm();h.file=null;await h.select();
  assert.equal(h.get('prepareExecute').disabled,false);assert.equal(h.calls.jobs.length,1);
  h.saved=null;await h.execute();assert.equal(h.calls.jobs.length,1);assert.equal(h.calls.open.length,0);
});

test('new invalid sources clear the old source and confirmation instead of executing the wrong master',async()=>{
  const h=panel();await h.select();await h.confirm();h.file=file('invalid.tif');h.failure=new Error('Wrong ICC');
  await assert.rejects(h.select(),/Wrong ICC/);
  assert.equal(h.get('prepareExecute').disabled,true);assert.equal(h.get('prepareConfirmed').checked,false);
  await assert.rejects(h.execute(),/先检查/);
});

for(const field of ['bitsPerChannel','width','colorProfileName'])test(`opening a copy with mismatched ${field} closes only the newly opened document`,async()=>{
  const h=panel();await h.select();await h.confirm();h.doc[field]=field==='colorProfileName'?'sRGB IEC61966-2.1':16;
  await assert.rejects(h.execute(),/副本已保存.*不匹配/);
  assert.deepEqual(h.calls.closed,[8]);assert.deepEqual(h.calls.opened,[]);
  assert.equal(h.host.app.documents[0].id,7);assert.match(h.get('prepareResult').textContent,/已保存/);
});

test('an already open user document and Photoshop open errors are preserved',async()=>{
  const h=panel();await h.select();await h.confirm();h.sameDocument=true;
  await assert.rejects(h.execute(),/未新开文档/);assert.deepEqual(h.calls.closed,[]);
  h.openError='Cannot open';await assert.rejects(h.execute(),/副本已保存.*Cannot open/);
  assert.deepEqual(h.calls.closed,[]);assert.deepEqual(h.calls.opened,[]);
});

test('cancellation is available during a pending file task and controls recover',async()=>{
  const h=panel();let resolve;h.gate=new Promise(done=>{resolve=done;});
  const pending=h.select();await new Promise(setImmediate);
  assert.equal(h.get('prepareChoose').disabled,true);assert.equal(h.get('prepareCancel').disabled,false);
  await h.emit('prepareCancel');assert.equal(h.calls.api[0][0],'/jobs/job1');assert.equal(h.calls.api[0][3],'DELETE');
  h.failure=new Error('Canceled');resolve();await assert.rejects(pending,/Canceled/);
  assert.equal(h.get('prepareChoose').disabled,false);assert.equal(h.get('prepareCancel').disabled,true);
});

test('FITS import explicitly checks data and confirmations then hands off to the original preparation',async()=>{
  const h=panel();h.file=file('linear.fits');
  assert.equal(h.calls.jobs.length,0);assert.equal(h.get('fitsImport').disabled,true);
  await h.emit('fitsChoose');assert.equal(h.calls.jobs.length,0);await h.emit('fitsCheck');
  assert.deepEqual(h.calls.jobs[0],{op:'fitsInspect',path:h.file.nativePath,color:'unknown'});
  assert.equal(h.get('fitsImport').disabled,true);assert.equal(h.calls.open.length,0);
  h.get('fitsConfirmed').checked=true;await h.emit('fitsConfirmed','change');
  assert.equal(h.get('fitsImport').disabled,false);await h.emit('fitsImport');
  assert.equal(h.calls.save[0].name,'linear_linear_import.tif');assert.equal(h.calls.open.length,0);
  assert.deepEqual(h.calls.jobs[1],{op:'fitsImport',path:h.file.nativePath,output:h.saved.nativePath,color:'unknown',
    fingerprint:h.info.fingerprint,confirmedLinear:true,acceptRounding:false});
  assert.equal(h.get('prepareUseLast').disabled,false);await h.emit('prepareUseLast');
  assert.equal(h.calls.jobs[2].op,'prepareInspect');assert.equal(h.calls.jobs[2].path,h.saved.nativePath);
});

test('FITS color changes invalidate inspection and require fresh confirmation and rounding acceptance',async()=>{
  const h=panel();h.file=file('rgb.fit');h.fitsInfo.color='srgb';h.fitsInfo.rounding={changedChannels:90,maxAbsError:1e-8};
  h.get('fitsColor').selectedIndex=2;await h.emit('fitsChoose');await h.emit('fitsCheck');
  h.get('fitsConfirmed').checked=true;await h.emit('fitsConfirmed','change');
  assert.equal(h.get('fitsImport').disabled,true);await assert.rejects(h.emit('fitsImport'),/舍入/);
  h.get('fitsRounding').checked=true;await h.emit('fitsRounding','change');assert.equal(h.get('fitsImport').disabled,false);
  h.get('fitsColor').selectedIndex=1;await h.emit('fitsColor','change');
  assert.equal(h.get('fitsImport').disabled,true);assert.equal(h.get('fitsConfirmed').checked,false);assert.equal(h.get('fitsRounding').checked,false);
  await h.emit('fitsCheck');assert.equal(h.calls.jobs.at(-1).color,'prophoto');assert.equal(h.get('fitsImport').disabled,true);
});

test('invalid FITS replaces the selected source and cannot silently import the prior file',async()=>{
  const h=panel();h.file=file('good.fits');await h.emit('fitsChoose');await h.emit('fitsCheck');h.get('fitsConfirmed').checked=true;
  h.file=file('bad.fits');await h.emit('fitsChoose');h.failure=new Error('Missing color');await assert.rejects(h.emit('fitsCheck'),/Missing color/);
  assert.equal(h.get('fitsImport').disabled,true);assert.equal(h.get('fitsConfirmed').checked,false);
  h.failure=null;await h.emit('fitsCheck');assert.equal(h.calls.jobs.at(-1).path,h.file.nativePath);
});

test('FITS saving and native opening are separate and reuse the strict RGB32 ICC check',async()=>{
  const h=panel();h.file=file('master.fts');await h.emit('fitsChoose');await h.emit('fitsCheck');h.get('fitsConfirmed').checked=true;
  h.saved=null;await h.emit('fitsImport');assert.equal(h.calls.jobs.length,1);
  h.saved=file('imported.tif');h.get('fitsOpen').checked=true;h.doc.colorProfileName='wrong';
  await assert.rejects(h.emit('fitsImport'),/副本已保存.*不匹配/);
  assert.deepEqual(h.calls.closed,[8]);assert.match(h.get('fitsSummary').textContent,/仍未拉伸/);
  assert.equal(h.get('prepareUseLast').disabled,false);
});
