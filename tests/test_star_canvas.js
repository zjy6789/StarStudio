const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');

function setup(size=16) {
  let nextID=10;
  const operations=[],writes=[],history=[];
  const constants={BitsPerChannelType:{EIGHT:8,SIXTEEN:16,THIRTYTWO:32},
    LayerKind:{NORMAL:'pixel',SMARTOBJECT:'smartObject'},
    BlendMode:{NORMAL:'normal',LIGHTEN:'lighten',SCREEN:'screen',COLORDODGE:'colorDodge',LINEARDODGE:'linearDodge',LIGHTERCOLOR:'lighterColor',LINEARLIGHT:'linearLight'},
    ElementPlacement:{PLACEBEFORE:'placeBefore'}};
  const app={documents:[],activeDocument:null};
  function layer(doc,name,kind='pixel') {
    const item={id:nextID++,name,kind,visible:false,opacity:75,blendMode:'normal',
      delete:async()=>{operations.push('delete');doc.layers.splice(doc.layers.indexOf(item),1);},
      duplicate:async target=>{
        operations.push('copyLayer');
        const copy=layer(target,item.name,item.kind);copy.opacity=item.opacity;
        target.layers.unshift(copy);app.activeDocument=target;return copy;
      },
      move:(relative,where)=>{
        assert.equal(where,'placeBefore');doc.layers.splice(doc.layers.indexOf(item),1);
        doc.layers.splice(doc.layers.indexOf(relative),0,item);
      }};
    return item;
  }
  function document(name) {
    const doc={id:nextID++,name,width:2048,height:8,bitsPerChannel:size,profile:'Unregistered embedded ICC',layers:[],
      createLayer:async options=>{const fresh=layer(doc,options.name);doc.layers.unshift(fresh);app.activeDocument=doc;return fresh;},
      duplicate:async(name,merged)=>{
        operations.push('copyDocument');assert.equal(merged,true);
        const copy=document(name);copy.layers.push(layer(copy,'copied composite'));app.activeDocument=copy;return copy;
      },
      closeWithoutSaving:async()=>{operations.push('closeDocument');app.documents.splice(app.documents.indexOf(doc),1);}};
    app.documents.push(doc);return doc;
  }
  const source=document('source'),original=layer(source,'stars','smartObject'),backdrop=layer(source,'background');
  source.layers.push(original,backdrop);app.activeDocument=source;
  const core={executeAsModal:async action=>action({isCancelled:false,hostControl:{
    suspendHistory:async({documentID})=>{
      const doc=app.documents.find(d=>d.id===documentID);
      const snapshot={doc,layers:doc.layers.slice(),properties:doc.layers.map(l=>({...l}))};history.push(snapshot);return snapshot;
    },
    resumeHistory:async(snapshot,commit)=>{
      operations.push(commit===false?'rollback':'commit');
      if(commit===false){snapshot.doc.layers=snapshot.layers;for(let i=0;i<snapshot.layers.length;i++)Object.assign(snapshot.layers[i],snapshot.properties[i]);}
    }
  }})};
  const imaging={getPixels:async()=>{throw new Error('Native composition must not read pixels.');},
    createImageDataFromBuffer:async(raw,options)=>{
      assert.equal(options.colorProfile,'');assert.equal(options.fullRange,true);
      return {raw,options,dispose:()=>{operations.push('dispose');}};
    },putPixels:async options=>{writes.push(options);}};
  const context={require:()=>({app,core,imaging,constants}),module:{exports:{}},Float32Array,Uint8Array,Uint16Array};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  const host=context.module.exports;
  let reads=0;
  const api=async(path)=>{
    reads++;
    const rows=Number(new URL('http://localhost'+path).searchParams.get('rows'));
    const buffer=new Float32Array(source.width*rows*4);
    buffer.set(size===32?[-.125,.375,1.5,.5]:[.125,.375,.75,.5]);
    return buffer.buffer;
  };
  const meta={docID:source.id,layerID:original.id,width:source.width,height:source.height,size,components:4,colorSpace:'RGB',profile:source.profile};
  const background={doc:source,layer:backdrop,key:'history0'};
  const result={image:'processed',width:source.width,height:source.height,components:4};
  return {host,app,source,original,backdrop,document,layer,meta,background,result,api,operations,writes,history,reads:()=>reads};
}

test('original preview opens at source resolution with native stars/background and embedded ICC',async()=>{
  const h=setup(32),sourceLayers=h.source.layers.slice();
  const state=await h.host.canvasStarPreview(null,null,h.meta,h.background,'linearDodge',h.api,()=>{});
  const doc=h.app.documents.find(d=>d.id===state.docID);
  assert.equal(doc.width,2048);assert.equal(doc.height,8);assert.equal(doc.bitsPerChannel,32);
  assert.equal(doc.profile,h.source.profile);assert.equal(h.app.activeDocument,doc);
  assert.equal(doc.layers.length,2);assert.equal(doc.layers[0].blendMode,'linearDodge');
  assert.equal(doc.layers[1].blendMode,'normal');assert.ok(doc.layers.every(l=>l.visible));
  assert.deepEqual(h.source.layers,sourceLayers);assert.equal(h.original.visible,false);
  assert.equal(h.original.blendMode,'normal');assert.equal(state.sourceDocID,h.source.id);
  assert.equal(h.reads(),0);assert.equal(h.writes.length,0);
});

for(const size of [8,16,32]) test(`${size}-bit processed preview retains depth and writes full-resolution pixels`,async()=>{
  const h=setup(size);
  const state=await h.host.canvasStarPreview(null,h.result,h.meta,h.background,'lighten',h.api,()=>{});
  const doc=h.app.documents.find(d=>d.id===state.docID);
  assert.equal(doc.bitsPerChannel,size);assert.equal(doc.width,h.source.width);
  assert.equal(doc.layers[0].kind,'pixel');assert.equal(h.writes.length,1);
  const written=h.writes[0].imageData;
  assert.equal(written.options.width,2048);assert.equal(written.options.height,8);
  assert.equal(written.raw.constructor,size===8?Uint8Array:size===16?Uint16Array:Float32Array);
  if(size===32)assert.deepEqual(Array.from(written.raw.slice(0,4)),[-.125,.375,1.5,.5]);
  assert.equal(h.source.layers.length,2);assert.equal(state.image,'processed');
});

test('background and blend switches reuse processed pixels and keep the active source tab',async()=>{
  const h=setup();
  let state=await h.host.canvasStarPreview(null,h.result,h.meta,h.background,'lighten',h.api,()=>{});
  const alternate=h.layer(h.source,'other background');h.source.layers.push(alternate);
  h.app.activeDocument=h.source;
  state=await h.host.canvasStarPreview(state,h.result,h.meta,{doc:h.source,layer:alternate,key:'history1'},'screen',h.api,()=>{});
  const doc=h.app.documents.find(d=>d.id===state.docID);
  assert.equal(h.reads(),1);assert.equal(h.writes.length,1);
  assert.equal(h.operations.filter(op=>op==='copyDocument').length,1);
  assert.equal(h.app.activeDocument,h.source);assert.equal(doc.layers.length,2);
  assert.equal(doc.layers[0].blendMode,'screen');
  state=await h.host.canvasStarPreview(state,h.result,h.meta,null,'colorDodge',h.api,()=>{});
  assert.equal(doc.layers.length,1);assert.equal(h.reads(),1);
});

test('switching to original or another star layer uses native duplication without backend reads',async()=>{
  const h=setup();
  let state=await h.host.canvasStarPreview(null,h.result,h.meta,null,'screen',h.api,()=>{});
  state=await h.host.canvasStarPreview(state,null,h.meta,null,'screen',h.api,()=>{});
  const doc=h.app.documents.find(d=>d.id===state.docID),firstID=state.starLayerID;
  const alternate=h.layer(h.source,'other stars');h.source.layers.push(alternate);
  state=await h.host.canvasStarPreview(state,null,{...h.meta,layerID:alternate.id},null,'lighten',h.api,()=>{});
  assert.equal(h.reads(),1);assert.equal(doc.layers.length,1);
  assert.notEqual(state.starLayerID,firstID);assert.equal(state.image,null);
  assert.equal(h.operations.filter(op=>op==='copyDocument').length,1);
});

test('a stale asynchronous pixel update rolls back only preview changes',async()=>{
  const h=setup();
  const state=await h.host.canvasStarPreview(null,null,h.meta,h.background,'lighten',h.api,()=>{});
  const doc=h.app.documents.find(d=>d.id===state.docID),originalPreviewLayers=doc.layers.slice();
  let current=true;
  await assert.rejects(h.host.canvasStarPreview(state,h.result,h.meta,h.background,'screen',async path=>{
    const response=await h.api(path);current=false;return response;
  },()=>{},()=>current),error=>error.stale===true);
  assert.deepEqual(doc.layers,originalPreviewLayers);
  assert.equal(state.image,null);assert.equal(h.source.layers.length,2);
  assert.ok(h.operations.includes('rollback'));
});

test('32-bit unsupported blend modes reject without converting either document',async()=>{
  const h=setup(32);
  assert.deepEqual(Array.from(h.host.starBlendModes(h.source)),['normal','lighten','linearDodge','lighterColor']);
  await assert.rejects(h.host.canvasStarPreview(null,null,h.meta,h.background,'screen',h.api,()=>{}),/32 位/);
  assert.equal(h.app.documents.length,1);assert.equal(h.source.bitsPerChannel,32);
  assert.equal(h.original.blendMode,'normal');assert.equal(h.reads(),0);
});

test('scaled results reject before creating or changing any Photoshop document',async()=>{
  const h=setup();
  await assert.rejects(h.host.canvasStarPreview(null,{...h.result,width:1600},h.meta,null,'lighten',h.api,()=>{}),/完整分辨率/);
  assert.equal(h.app.documents.length,1);assert.equal(h.operations.length,0);
});

test('gray corrected stars keep Linear Light and remain recognizable after a rename',async()=>{
  const h=setup(16);h.original.blendMode='linearLight';h.original.name='User renamed stars';
  assert.equal(h.host.starEncoding(h.source,h.original),'gray');
  const state=await h.host.canvasStarPreview(null,null,h.meta,h.background,'linearLight',h.api,()=>{});
  const preview=h.app.documents.find(doc=>doc.id===state.docID);
  assert.equal(preview.layers.find(layer=>layer.id===state.starLayerID).blendMode,'linearLight');
  assert.equal(h.host.starEncoding(h.source,h.backdrop),'black');
  const float=setup(32);assert.equal(float.host.starEncoding(float.source,float.original),'signed');
});
