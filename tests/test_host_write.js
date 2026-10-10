const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');

for(const size of [8,16,32]) for(const n of [1,3]) for(const alpha of [false,true]) for(const cropped of [false,true]) {
  test(`${size}-bit ${n}-channel upload preserves ${alpha?'alpha':'opaque'} ${cropped?'offset pixels':'full width'}`,async()=>{
    const components=n+1,rawComponents=alpha?components:n;
    const actual=cropped?{left:1,top:1,right:3,bottom:2}:{left:0,top:0,right:3,bottom:2};
    const width=actual.right-actual.left,height=actual.bottom-actual.top;
    const divisor=size===8?255:size===16?65535:1;
    const values=Array.from({length:width*height*rawComponents},(_,i)=>size===32?(i-3)/11:((i*17+29)%divisor));
    const raw=size===32?new Float32Array(values):size===16?new Uint16Array(values):new Uint8Array(values);
    const expected=new Float32Array(3*2*components);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const src=(y*width+x)*rawComponents,dst=((y+actual.top)*3+x+actual.left)*components;
      for(let c=0;c<n;c++)expected[dst+c]=raw[src+c]/divisor;
      expected[dst+n]=alpha?raw[src+n]/divisor:1;
    }
    let disposed=false,sent;
    const imaging={getPixels:async options=>{
      assert.equal(options.componentSize,size);assert.equal(options.applyAlpha,false);assert.equal('targetSize' in options,false);
      return {sourceBounds:actual,imageData:{width,height,components:rawComponents,hasAlpha:alpha,colorProfile:'Embedded',
        getData:async()=>raw,dispose:()=>{disposed=true;}}};
    }};
    const constants={BitsPerChannelType:{EIGHT:8,SIXTEEN:16},DocumentMode:{RGB:'RGB'}};
    const context={require:()=>({imaging,constants}),module:{exports:{}},Float32Array,Uint8Array,Uint16Array};
    vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
    const api=async(path,body)=>{
      if(path==='/images')return {id:'source'};
      sent=new Float32Array(body);
    };
    const meta=await context.module.exports.upload({id:23,width:3,height:2,bitsPerChannel:size,mode:n===3?'RGB':'Gray'},
      {id:42,name:'source',boundsNoEffects:actual},api,()=>{});
    assert.deepEqual(sent,expected);assert.equal(disposed,true);assert.equal(meta.size,size);assert.equal(meta.profile,'Embedded');
  });
}

for(const size of [8,16,32]) for(const profile of ['Display P3','Star Studio Linear ProPhoto RGB','Gray Gamma 2.2']) {
  test(`${size}-bit write inherits the target document profile: ${profile}`,async()=>{
    const gray=profile.startsWith('Gray'),components=gray?2:4;
    const floats=new Float32Array(gray?[.125,.5]:size===32?[-.125,.375,1.5,.5]:[.125,.375,.75,.5]);
    const multiplier=size===8?255:65535;
    const expected=size===32?floats:size===8?new Uint8Array(floats.map(x=>Math.round(x*multiplier))):new Uint16Array(floats.map(x=>Math.round(x*multiplier)));
    let disposed=false,written=false;
    const imaging={createImageDataFromBuffer:async(raw,options)=>{
      // Embedded profile descriptions may not be installed/registered by name.
      if(options.colorProfile)throw new Error('Photoshop Error. Code: -26120. Message: Unknown color profile');
      assert.equal(options.colorProfile,'');
      assert.equal(options.colorSpace,gray?'Grayscale':'RGB');
      assert.equal(options.fullRange,true);
      assert.deepEqual(raw,expected);
      return {raw,dispose:()=>{disposed=true;}};
    },putPixels:async(options)=>{
      assert.equal(options.documentID,23);assert.equal(options.layerID,42);
      assert.equal(options.replace,true);
      assert.deepEqual({...options.targetBounds},{left:0,top:0});
      assert.deepEqual(options.imageData.raw,expected);written=true;
    }};
    const context={require:()=>({imaging}),module:{exports:{}},Float32Array,Uint8Array,Uint16Array};
    vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
    const meta={width:1,height:1,components,size,profile,colorSpace:gray?'Grayscale':'RGB',docID:23};
    const layer={id:42};
    const result=await context.module.exports.write({id:23},'result',meta,'starless',async()=>floats.buffer,()=>{},{isCancelled:false},layer);
    assert.equal(result,layer);assert.equal(meta.profile,profile);
    assert.equal(written,true);assert.equal(disposed,true);
  });
}

test('canvas preview keeps an unregistered embedded profile without converting source pixels',async()=>{
  const raw=new Float32Array([.125,.375,.75,.5]);
  const copied={id:2,delete:async()=>{preview.layers.splice(preview.layers.indexOf(copied),1);}};
  const fresh={id:3};
  const preview={id:24,layers:[copied],bitsPerChannel:32,
    resizeCanvas:async(w,h)=>{assert.equal(w,1);assert.equal(h,1);},
    createLayer:async()=>{preview.layers.unshift(fresh);return fresh;}};
  const source={id:23,duplicate:async(name,merged)=>{
    assert.equal(name,'星点重混合预览（缩略）');assert.equal(merged,true);return preview;
  }};
  const app={documents:[source],getColorProfiles:async(space)=>{assert.equal(space,'RGB');return ['sRGB IEC61966-2.1'];},
    createDocument:async()=>{throw new Error('Cannot create a document from an unregistered profile name');}};
  const constants={BitsPerChannelType:{SIXTEEN:16}};
  const imaging={createImageDataFromBuffer:async(buffer,options)=>{
    assert.equal(options.colorProfile,'');assert.equal(buffer.constructor,Uint16Array);
    return {dispose:()=>{}};
  },putPixels:async(options)=>{assert.equal(options.documentID,24);assert.equal(options.layerID,3);}};
  const core={executeAsModal:async(callback)=>callback({isCancelled:false})};
  const context={require:()=>({app,constants,core,imaging}),module:{exports:{}},Float32Array,Uint8Array,Uint16Array};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  const id=await context.module.exports.canvasPreview(null,{id:'result',width:1,height:1},
    {docID:23,components:4,colorSpace:'RGB',profile:'Display P3'},async()=>raw.buffer,()=>{});
  assert.equal(id,24);assert.equal(preview.bitsPerChannel,16);
  assert.deepEqual(preview.layers,[fresh]);assert.equal(source.id,23);
});
