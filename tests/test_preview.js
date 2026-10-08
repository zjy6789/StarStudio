const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');

for(const size of [8,16,32]) test(`${size}-bit preview preserves values, alpha and cache bounds`,async()=>{
  const divisor=size===8?255:size===16?65535:1;
  const raw=size===8?new Uint8Array([255,128,0,128]):size===16?new Uint16Array([65535,32768,0,32768]):new Float32Array([1,.5,0,.5]);
  let disposed=false,uploaded;
  const constants={BitsPerChannelType:{EIGHT:8,SIXTEEN:16},DocumentMode:{RGB:'RGB'}};
  const imaging={getPixels:async options=>{
    // PS 27.1 rejects forcing 16-bit source pixels through the 32-bit conversion.
    assert.equal(options.componentSize,size);
    assert.deepEqual({...options.targetSize},{width:1600,height:1067});
    return {level:1,sourceBounds:{left:3.75,top:3.75},imageData:{width:1,height:1,components:4,hasAlpha:true,colorProfile:'sRGB IEC61966-2.1',
      getData:async options=>{assert.equal(options.fullRange,true);return raw;},dispose:()=>{disposed=true;}}};
  }};
  const context={require:()=>({constants,imaging}),module:{exports:{}},Float32Array,Uint8Array,Uint16Array};
  vm.runInNewContext(fs.readFileSync('plugin/host.js','utf8'),context);
  const api=async(path,body)=>{if(path==='/images')return{id:'preview'};uploaded=new Float32Array(body);};
  const meta=await context.module.exports.uploadPreview({id:1,width:6000,height:4000,bitsPerChannel:size,mode:'RGB'},{id:2,name:'background'},api);
  assert.equal(meta.width,1600);assert.equal(meta.height,1067);
  const offset=(2*1600+2)*4;
  for(let c=0;c<4;c++)assert.ok(Math.abs(uploaded[offset+c]-raw[c]/divisor)<1e-7);
  assert.equal(uploaded[3],0);assert.equal(disposed,true);
});
