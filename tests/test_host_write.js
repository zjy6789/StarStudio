const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');

test('full-size float selection writes tiles to the source document in one history step',async()=>{
  const width=1048577,doc={id:31,width,height:2},events=[];
  const imaging={createImageDataFromBuffer:async(data,options)=>{
    assert.equal(options.components,1);assert.equal(options.colorSpace,'Grayscale');assert.equal(options.width,width);assert.equal(options.height,1);
    assert.equal('colorProfile' in options,false);assert.equal(data[0],.75);assert.equal(data.at(-1),.5);
    return {dispose(){events.push('dispose');}};
  },putSelection:async options=>events.push({id:options.documentID,replace:options.replace,top:options.targetBounds.top})};
  const context={module:{exports:{}},Float32Array,require:()=>({imaging,core:{executeAsModal:async action=>action({hostControl:{
    suspendHistory:async()=>{events.push('suspend');return 1;},resumeHistory:async(...args)=>events.push(args)}})}})};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  const api=async(path,body,binary)=>{assert.equal(binary,true);const values=new Float32Array(width).fill(.25);values[width-1]=.5;return values.buffer;};
  await context.module.exports.applySelection(doc,'mask',{width,height:2},true,api,()=>{});
  assert.deepEqual(JSON.parse(JSON.stringify(events)),['suspend',{id:31,replace:true,top:0},'dispose',{id:31,replace:false,top:1},'dispose',[1]]);
});

test('failed selection write disposes data and rolls history back; wrong canvas never writes',async()=>{
  let disposed=0,resume,started=0;
  const context={module:{exports:{}},Float32Array,require:()=>({imaging:{createImageDataFromBuffer:async()=>({dispose(){disposed++;}}),putSelection:async()=>{throw new Error('native rejected');}},
    core:{executeAsModal:async action=>{started++;return action({hostControl:{suspendHistory:async()=>7,resumeHistory:async(...args)=>{resume=args;}}});}}})};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  const apply=context.module.exports.applySelection,api=async()=>new Float32Array([.25]).buffer;
  await assert.rejects(apply({id:1,width:1,height:1},'mask',{width:1,height:1},false,api,()=>{}),/native rejected/);
  assert.equal(disposed,1);assert.deepEqual(resume,[7,false]);
  await assert.rejects(apply({width:2,height:1},'mask',{width:1,height:1},false,api,()=>{}),/尺寸/);assert.equal(started,1);
});

test('a failed float input read deletes its incomplete upload',async()=>{
  const deleted=[],constants={BitsPerChannelType:{EIGHT:8,SIXTEEN:16},DocumentMode:{RGB:'RGB'}};
  const context={module:{exports:{}},require:()=>({constants,imaging:{getPixels:async()=>{throw new Error('read failed');}}}),Float32Array};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  const api=async(path,body,raw,method)=>{if(method==='DELETE')deleted.push(path);else return {id:'temporary'};};
  await assert.rejects(context.module.exports.upload({id:1,width:4,height:4,bitsPerChannel:32,mode:'RGB'},
    {id:2,name:'input',boundsNoEffects:{left:0,top:0,right:4,bottom:4}},api,()=>{}),/read failed/);
  assert.deepEqual(deleted,['/images/temporary']);
});

test('PS selection upload preserves offset coverage and normalizes its actual component size',async()=>{
  let disposed=false,sent;
  const context={module:{exports:{}},Float32Array,require:()=>({imaging:{getSelection:async options=>({sourceBounds:{left:1,top:1,right:3,bottom:3},imageData:{width:2,height:2,componentSize:16,
    getData:async()=>new Uint16Array([65535,0,32768,65535]),dispose:()=>{disposed=true;}}})}})};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  const api=async(path,body)=>{if(path==='/images')return {id:'selection'};sent=new Float32Array(body);};
  const id=await context.module.exports.uploadSelection({id:1,width:4,height:3,selection:{bounds:{left:1,top:1,right:3,bottom:3}}},api,()=>{});
  assert.equal(id,'selection');assert.equal(disposed,true);
  assert.deepEqual(Array.from(sent),Array.from(new Float32Array([0,0,0,0,0,1,0,0,0,32768/65535,1,0])));
  await assert.rejects(context.module.exports.uploadSelection({selection:{bounds:null}},()=>{throw new Error('must not allocate');},()=>{}),/选区/);
});

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
