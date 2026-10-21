const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function nativeHost() {
  let id=1;const app={documents:[],activeDocument:null},copies=[],closed=[],opened=[];
  const h={profile:'Star Studio Linear ProPhoto RGB',closed,opened};
  function document(name) {
    const doc={id:id++,name,width:20,height:10,bitsPerChannel:32,mode:'RGB',colorProfileName:h.profile,layers:[],
      duplicate:async(title,merged)=>{assert.equal(merged,true);if(h.duplicateFailure)throw new Error('duplicate failed');return document(title);},
      closeWithoutSaving:async()=>{closed.push(doc.id);app.documents=app.documents.filter(d=>d.id!==doc.id);app.activeDocument=app.documents.at(-1);}};
    function layer(name,background=true) {
      const item={id:id++,isBackgroundLayer:background,visible:true,duplicate:async target=>{const copy=layer(name,false);target.layers.unshift(copy);return copy;},
        move:(relative,position)=>{assert.equal(position,'before');const parent=app.documents.find(d=>d.layers.includes(relative));
          parent.layers.splice(parent.layers.indexOf(item),1);parent.layers.splice(parent.layers.indexOf(relative),0,item);}};
      Object.defineProperty(item,'name',{get:()=>name,set:value=>{if(item.isBackgroundLayer)throw "Error: You cannot change the Background layer's name.";name=value;}});
      return item;
    }
    doc.promoteBackground=()=>{doc.layers[0]=layer(doc.layers[0].name,false);};
    doc.layers.push(layer(name));app.documents.push(doc);app.activeDocument=doc;return doc;
  }
  const retained=document('user work');h.retained=retained;
  const folder={nativePath:'G:/temp/starstudio-stack-owned',entries:[],deleted:false,
    getEntries:async()=>folder.entries,delete:async()=>{assert.equal(folder.entries.length,0);folder.deleted=true;}};
  function file(name) {return {name,nativePath:'G:/results/'+name,copyTo:async target=>{
    assert.equal(target,folder);if(name==='reference'&&h.copyFailure)throw (h.copyFailure===true?new Error('copy failed'):h.copyFailure);
    const copy={name,nativePath:folder.nativePath+'/'+name,delete:async()=>{folder.entries=folder.entries.filter(e=>e!==copy);}};
    folder.entries.push(copy);copies.push(copy);return copy;}};}
  const storage={getTemporaryFolder:async()=>({createFolder:async name=>{assert.match(name,/^starstudio-stack-\d+$/);return folder;}}),
    createSessionToken:entry=>entry.nativePath};
  const action={batchPlay:async commands=>{
    const command=commands[0];
    if(command._obj==='open') {
      const copy=copies.find(c=>c.nativePath===command.null._path);assert.ok(copy,'only independent copies are opened');
      if(h.coalesced){app.activeDocument=retained;return [{}];}
      const doc=document(copy.name);opened.push(doc);if(copy.name==='reference'&&h.invalid)Object.assign(doc,h.invalid);
    } else if(command._obj==='set') {
      assert.equal(command._target[0]._property,'background');
      assert.equal(command._target[1]._id,app.activeDocument.id);
      assert.ok(!opened.includes(app.activeDocument),'only the new output is promoted');
      if(h.promotionFailure)return [{_obj:'error',message:'promotion failed'}];
      const old=app.activeDocument.layers[0];app.activeDocument.promoteBackground();
      assert.notEqual(app.activeDocument.layers[0].id,old.id);h.promoted=true;
    } else {
      assert.equal(command._obj,'select');assert.equal(command.makeVisible,false);
      assert.equal(command._target[0]._id,app.activeDocument.layers[1].id);h.selected=command._target[0]._id;
    }
    return [{}];
  }};
  const photoshop={app,action,core:{executeAsModal:async fn=>fn({})},constants:{BitsPerChannelType:{THIRTYTWO:32},DocumentMode:{RGB:'RGB'},
    BlendMode:{NORMAL:'normal'},ElementPlacement:{PLACEBEFORE:'before'}}};
  const context={module:{exports:{}},require:name=>name==='photoshop'?photoshop:{storage:{localFileSystem:storage}}};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  h.app=app;h.folder=folder;h.run=()=>context.module.exports.openStackLayers(file('sky'),file('reference'),
    {shape:[10,20,3],frames:3,layers:{profile:h.profile}});
  return h;
}

test('layered output retains full-size float inputs and produces an isolated two-layer document',async()=>{
  const h=nativeHost(),result=await h.run(),doc=result.doc;
  assert.equal(doc.width,20);assert.equal(doc.height,10);assert.equal(doc.bitsPerChannel,32);assert.equal(doc.colorProfileName,h.profile);
  assert.equal(h.app.documents.length,2);assert.equal(h.app.documents[0],h.retained);assert.equal(h.app.activeDocument,doc);
  assert.equal(doc.layers.length,2);assert.match(doc.layers[0].name,/单帧.*未堆栈降噪/);assert.equal(doc.layers[0].visible,false);
  assert.equal(doc.layers[0].blendMode,'normal');assert.match(doc.layers[1].name,/3帧/);assert.equal(doc.layers[1].visible,true);
  assert.equal(h.selected,doc.layers[1].id);assert.equal(h.closed.length,2);assert.equal(h.folder.deleted,true);assert.equal(result.cleanupWarning,'');
  assert.equal(h.promoted,true);assert.equal(doc.layers[1].isBackgroundLayer,false);
});

for(const invalid of [{colorProfileName:'sRGB'}, {bitsPerChannel:16}, {width:21}])test(`invalid native layer input ${JSON.stringify(invalid)} closes only owned scratch documents`,async()=>{
  const h=nativeHost();h.invalid=invalid;await assert.rejects(h.run(),/输入尺寸.*颜色配置/);
  assert.equal(h.app.documents.length,1);assert.equal(h.app.activeDocument,h.retained);assert.equal(h.closed.length,2);assert.equal(h.folder.deleted,true);
});

test('an open operation coalescing with existing user work never modifies or closes it',async()=>{
  const h=nativeHost();h.coalesced=true;await assert.rejects(h.run(),/用户文档未修改/);
  assert.equal(h.app.activeDocument,h.retained);assert.equal(h.retained.layers[0].name,'user work');assert.equal(h.closed.length,0);assert.equal(h.folder.deleted,true);
});

for(const failure of ['copyFailure','duplicateFailure','promotionFailure'])test(`${failure} leaves no task copy or partial document`,async()=>{
  const h=nativeHost();h[failure]=true;await assert.rejects(h.run(),/failed/);
  assert.equal(h.app.documents.length,1);assert.equal(h.app.activeDocument,h.retained);assert.equal(h.folder.deleted,true);
});

test('unexpected temporary entries are preserved and a completed result reports cleanup separately',async()=>{
  const h=nativeHost(),unknown={name:'other file'};h.folder.entries.push(unknown);
  const result=await h.run();assert.ok(result.doc);assert.match(result.cleanupWarning,/清理未完成/);
  assert.equal(h.folder.deleted,false);assert.deepEqual(h.folder.entries,[unknown]);assert.equal(h.app.documents.length,2);
});

test('native SDK string rejections retain their reason at the user error boundary',async()=>{
  const h=nativeHost();h.copyFailure='Native copy rejected';await assert.rejects(h.run(),/Native copy rejected/);
  assert.equal(h.folder.deleted,true);assert.equal(h.app.activeDocument,h.retained);
});
