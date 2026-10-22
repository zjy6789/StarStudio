const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const plain=value=>JSON.parse(JSON.stringify(value));

function harness() {
  const elements=new Map(),calls={duplicate:[],crop:[],closed:[],selection:[],deleted:[],opened:[],promoted:[],modal:0};
  const html=fs.readFileSync('plugin/index.html','utf8');
  for(const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g))
    elements.set(match[1],{value:'',selectedIndex:0,checked:false,disabled:false,listeners:{},classList:{toggle(){}},addEventListener(name,action){this.listeners[name]=action;}});
  const get=id=>{assert.ok(elements.has(id),id);return elements.get(id);};
  const constants={BlendMode:{NORMAL:'normal'},BitsPerChannelType:{THIRTYTWO:32}};
  const h={calls,get,busy:false,depth:0,badICC:false,duplicateFailure:false,cancel:false,modelSelected:true};
  let nextDoc=50,nextLayer=100;
  const app={documents:[],activeDocument:null};
  function layer(id,name) {
    return {id,_name:name,_background:false,blendMode:'normal',opacity:100,fillOpacity:100,visible:false,
      get name(){return this._name;},set name(value){if(this._background)throw new Error('Background must be promoted before rename');this._name=value;},
      get isBackgroundLayer(){return this._background;},set isBackgroundLayer(value){throw new Error('isBackgroundLayer is read-only');},
      pixels:new Float32Array([-.125,.25,1.75]),async duplicate(target){
        assert.equal(h.depth,1);if(h.duplicateFailure)throw new Error('layer duplicate failed');
        const copy=layer(nextLayer++,this.name);copy.pixels=this.pixels.slice();target.layers.push(copy);return copy;
      }};
  }
  const original=layer(1,'Renamed original'),model=layer(2,'No model suffix');original._background=true;
  const source={id:7,title:'Source',width:100,height:80,mode:'RGB',bitsPerChannel:16,colorProfileName:'Custom embedded RGB',
    layers:[original,model],activeHistoryState:{id:10},selection:{bounds:{left:20.2,top:10.7,right:50.1,bottom:36.4}},
    async duplicate(name,merged){
      assert.equal(h.depth,1);calls.duplicate.push({source:this.id,name,merged});
      const current=layer(nextLayer++,'Current visible');current._background=true;
      const copy={id:nextDoc++,title:name,width:this.width,height:this.height,mode:this.mode,bitsPerChannel:this.bitsPerChannel,
        colorProfileName:h.badICC?'Wrong':this.colorProfileName,layers:[current],activeHistoryState:{id:1000},
        selection:{bounds:plain(this.selection.bounds),async deselect(){this.bounds=null;}},
        async crop(bounds){assert.equal(h.depth,1);calls.crop.push(plain(bounds));this.width=bounds.right-bounds.left;this.height=bounds.bottom-bounds.top;this.activeHistoryState.id++;},
        async closeWithoutSaving(){assert.equal(h.depth,1);calls.closed.push(this.id);app.documents=app.documents.filter(doc=>doc.id!==this.id);}};
      app.documents.push(copy);app.activeDocument=copy;return copy;
    }};
  app.documents=[source];app.activeDocument=source;
  const host={app,constants,documentInfo:doc=>doc,
    core:{executeAsModal:async action=>{assert.equal(h.depth,0,'no nested modal');h.depth++;calls.modal++;try{return await action({isCancelled:h.cancel});}finally{h.depth--;}}},
    transaction:async(doc,name,action)=>{const result=await host.core.executeAsModal(action);doc.activeHistoryState.id++;return result;},
    uploadSelection:async doc=>{assert.equal(h.depth,1);calls.selection.push({read:doc.id,bounds:plain(doc.selection.bounds)});return 'precise-selection';},
    applySelection:async(doc,key,meta,invert,api,report,context)=>{assert.equal(h.depth,1);assert.ok(context);calls.selection.push({write:doc.id,key,meta:plain(meta),invert});if(h.selectionFailure)throw new Error('selection write failed');}
  };
  const action={batchPlay:async commands=>{assert.equal(h.depth,1);const id=commands[0]._target[1]._id;
    assert.notEqual(id,source.id);const copy=app.documents.find(doc=>doc.id===id);copy.layers[0]._background=false;calls.promoted.push(id);return [{}];}};
  const context={module:{exports:{}},document:{getElementById:get},console,require:name=>name==='photoshop'?{action}:host};
  vm.runInNewContext(fs.readFileSync('plugin/residual-compare.js','utf8'),context);
  h.module=context.module.exports;h.host=host;h.source=source;h.original=original;h.model=model;
  const api=async(path,body,raw,method)=>{if(method==='DELETE')calls.deleted.push(path);};
  h.ui=h.module.setup({api,report(){},status(){},isBusy:()=>h.busy,
    run:async action=>{h.busy=true;try{return await action();}finally{h.busy=false;h.ui.updateActions();}},
    selectedLayer:id=>({doc:source,layer:id==='residualModel'?model:original}),value:id=>id==='residualModel'?(h.modelSelected?model.id:null):original.id,
    onOpened:(doc,origin)=>calls.opened.push({doc:doc.id,source:origin.id})});
  h.emit=(id,event='click')=>get(id).listeners[event]();
  h.confirm=()=>{get('residualConfirmed').checked=true;return h.emit('residualConfirmed','change');};
  h.compare=()=>h.emit('residualCompare');
  return h;
}

test('opening the disclosure does not read pixels or create documents and real menu has three roles',async()=>{
  const h=harness();h.ui.updateActions();await h.emit('residualOptions');
  assert.equal(h.calls.modal,0);assert.equal(h.calls.duplicate.length,0);assert.equal(h.get('residualCompare').disabled,true);
  const picker=fs.readFileSync('plugin/index.html','utf8').match(/<sp-picker id="residualView">([\s\S]*?)<\/sp-picker>/)[1];
  assert.equal((picker.match(/<sp-menu-item(?:\s|>)/g)||[]).length,3);
  assert.equal((picker.match(/<\/sp-menu-item>/g)||[]).length,3);
});

test('comparison snapshots actual merged visibility and explicit roles in one RGB32 crop without changing sources',async()=>{
  const h=harness(),before=plain(h.source);await h.confirm();await h.compare();
  const copy=h.host.app.activeDocument;
  assert.equal(h.calls.duplicate[0].merged,true);assert.deepEqual(h.calls.crop,[{left:20,top:10,right:51,bottom:37}]);
  assert.equal(copy.width,31);assert.equal(copy.height,27);assert.equal(copy.bitsPerChannel,32);assert.equal(copy.colorProfileName,h.source.colorProfileName);
  assert.equal(copy.layers.length,3);assert.equal(copy.layers.filter(layer=>layer.visible).length,1);
  assert.match(copy.layers.find(layer=>layer.visible).name,/当前可见/);assert.equal(copy.selection.bounds,null);
  assert.equal(h.ui.isPreview(copy.id),true);assert.deepEqual(plain(h.source),before);
  assert.deepEqual(h.calls.promoted,[copy.id]);
  h.get('residualView').selectedIndex=2;await h.emit('residualView','change');
  assert.match(copy.layers.find(layer=>layer.visible).name,/模型/);
  assert.deepEqual(Array.from(copy.layers.find(layer=>layer.visible).pixels),[-.125,.25,1.75]);
  assert.deepEqual(plain(h.source),before);
});

test('missing model remains absent instead of guessing a starless layer',async()=>{
  const h=harness();h.modelSelected=false;await h.confirm();await h.compare();
  const copy=h.host.app.activeDocument;assert.equal(copy.layers.length,2);
  assert.match(h.get('residualSummary').textContent,/未提供模型参考/);assert.equal(h.get('residualModelView').disabled,true);
  h.get('residualView').selectedIndex=2;await assert.rejects(h.emit('residualView','change'),/未提供/);
});

test('layer blend, opacity, groups and empty selections are rejected before duplication',async()=>{
  for(const mutate of [h=>h.original.opacity=50,h=>h.original.fillOpacity=50,h=>h.original.blendMode='screen',h=>h.original.isClippingMask=true,
    h=>h.source.layers=h.source.layers.filter(layer=>layer.id!==h.original.id),h=>h.source.selection.bounds=null]) {
    const h=harness();mutate(h);await h.confirm();await assert.rejects(h.compare());assert.equal(h.calls.duplicate.length,0);
  }
});

test('native failures and cancellation close only the just-created comparison inside its modal',async()=>{
  for(const field of ['badICC','duplicateFailure','cancel']) {
    const h=harness();h[field]=true;await h.confirm();await assert.rejects(h.compare());
    assert.deepEqual(h.calls.closed,[50]);assert.equal(h.calls.modal,1);assert.deepEqual(h.host.app.documents.map(doc=>doc.id),[7]);
    assert.equal(h.host.app.activeDocument.id,7);assert.equal(h.original.isBackgroundLayer,true);
  }
});

test('source history or geometry changes block old views and repair output',async()=>{
  for(const mutate of [h=>h.source.activeHistoryState.id++,h=>h.source.selection.bounds.left++,h=>h.source.width++]) {
    const h=harness();await h.confirm();await h.compare();mutate(h);
    await assert.rejects(h.emit('residualRepair'),/已变化/);assert.equal(h.calls.selection.length,0);
    h.get('residualView').selectedIndex=1;await assert.rejects(h.emit('residualView','change'),/已变化/);
  }
});

test('edited comparison stays open and a new request creates a separate snapshot',async()=>{
  const h=harness();await h.confirm();await h.compare();const old=h.host.app.activeDocument;old.activeHistoryState.id++;
  h.get('residualView').selectedIndex=1;await assert.rejects(h.emit('residualView','change'),/关闭或编辑/);
  await h.compare();assert.notEqual(h.host.app.activeDocument.id,old.id);assert.deepEqual(h.calls.closed,[]);
  assert.equal(h.ui.isPreview(old.id),true);assert.equal(h.ui.isPreview(h.host.app.activeDocument.id),true);
});

test('repair is a full-size independent RGB32 merged copy with the precise selection and cache cleanup',async()=>{
  const h=harness(),before=plain(h.source);await h.confirm();await h.compare();await h.emit('residualRepair');
  const repair=h.host.app.activeDocument;assert.equal(repair.width,100);assert.equal(repair.height,80);assert.equal(repair.bitsPerChannel,32);
  assert.equal(h.calls.crop.length,1);assert.equal(h.calls.selection[0].read,7);
  assert.deepEqual(h.calls.selection[1],{write:51,key:'precise-selection',meta:{width:100,height:80},invert:false});
  assert.deepEqual(h.calls.deleted,['/images/precise-selection']);assert.deepEqual(h.calls.opened,[{doc:51,source:7}]);
  assert.equal(h.ui.isPreview(repair.id),false);assert.deepEqual(plain(h.source),before);
});

test('failed repair selection closes that new copy and retains the existing comparison and source',async()=>{
  const h=harness();await h.confirm();await h.compare();const comparison=h.host.app.activeDocument;
  h.selectionFailure=true;await assert.rejects(h.emit('residualRepair'),/selection write/);
  assert.deepEqual(h.calls.closed,[51]);assert.equal(h.host.app.activeDocument.id,comparison.id);
  assert.deepEqual(h.calls.deleted,['/images/precise-selection']);assert.equal(h.calls.opened.length,0);
});
