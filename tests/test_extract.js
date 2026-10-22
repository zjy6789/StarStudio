const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

for(const size of [8,16,32]) for(const preserve of [false,true]) {
  test(`${size}-bit extraction ${preserve?'preserves the model with the matching blend':'keeps the original separation contract'}`,async()=>{
    const elements=new Map(),writes=[],deleted=[],requests=[];
    const get=id=>{
      if(!elements.has(id)) elements.set(id,{value:'',selectedIndex:0,checked:false,
        classList:{add(){},remove(){}},querySelector:()=>({innerHTML:'',appendChild(){}})});
      return elements.get(id);
    };
    get('executable').value='D:\\engine\\starnet++.exe';get('preserveModelBackground').checked=preserve;
    const source={id:11,name:'Original'},doc={id:7,width:3,height:2,bitsPerChannel:size,
      activeLayers:[source],activeHistoryState:{id:1},title:'Test'};
    const constants={BitsPerChannelType:{EIGHT:8,SIXTEEN:16,THIRTYTWO:32},BlendMode:{LINEARDODGE:'linearDodge',LINEARLIGHT:'linearLight'}};
    const host={constants,app:{documents:[doc],activeDocument:doc},documentInfo:()=>doc,layers:()=>[{id:11,name:source.name,layer:source}],
      core:{executeAsModal:async action=>action({})},
      upload:async()=>({id:'input',size,width:3,height:2,components:4}),
      transaction:async(d,label,action)=>action({}),write:async(d,key,meta,name)=>{const layer={key,name,visible:true};writes.push(layer);return layer;},
      setStarBlendMode:(layer,mode)=>{layer.blendMode=mode;},starBlendModes:()=>size===32?['linearDodge']:['screen'],starEncoding:()=>size===32?'signed':'black'};
    const fetch=async(url,options)=>{
      const route=new URL(url).pathname;
      const body=options.body?JSON.parse(options.body):null;
      let response={};
      if(route==='/starnet-info') response={modern:false,installation:{ready:true,modelPath:'model'}};
      if(route==='/jobs') {requests.push(body);response={id:'job'};}
      if(route==='/jobs/job') response={state:'done',progress:1,result:{background:'bg',stars:'stars',provider:'CPU',starEncoding:size===32?'signed':'gray'}};
      if(options.method==='DELETE') deleted.push(route);
      return {ok:true,json:async()=>response};
    };
    const context={module:{exports:{}},document:{getElementById:get,createElement:()=>({})},console,URL,fetch,
      require:name=>name==='./host.js'?host:{url:'http://127.0.0.1:8765',token:'test'}};
    const code=fs.readFileSync('plugin/main.js','utf8');
    vm.runInNewContext(code.slice(0,code.indexOf("\nfor (const id of ['decomposition','stride'])"))+"\nmodule.exports={extract,refresh};",context);
    vm.runInNewContext("photoStages.set(7,'developed');",context);
    context.module.exports.refresh();await context.module.exports.extract();
    assert.equal(requests.length,1);
    assert.equal(requests[0].preserveModelBackground,preserve);
    assert.equal(requests[0].starEncoding,size===32?'signed':'gray');
    assert.deepEqual(writes.map(layer=>layer.name),['Original_starless','Original_starmask']);
    assert.equal(writes[1].visible,false);
    assert.equal(writes[1].blendMode,preserve?(size===32?'linearDodge':'linearLight'):undefined);
    assert.deepEqual(deleted,['/images/input','/images/bg','/images/stars']);
  });
}

function failureHarness(outcome='error',releaseFails=false) {
  const elements=new Map(),images=new Set(),requests=[],deleted=[],writes=[],logs=[];
  const get=id=>{
    if(!elements.has(id))elements.set(id,{value:'',selectedIndex:0,checked:false,
      classList:{add(){},remove(){}},querySelector:()=>({innerHTML:'',appendChild(){}})});
    return elements.get(id);
  };
  get('executable').value='D:\\engine\\starnet++.exe';
  const source={id:11,name:'Original',visible:true};
  const doc={id:7,width:3,height:2,bitsPerChannel:16,activeLayers:[source],activeHistoryState:{id:1},title:'Test'};
  const h={outcome,images,requests,deleted,writes,logs};
  let uploads=0;
  const host={constants:{BitsPerChannelType:{EIGHT:8,SIXTEEN:16,THIRTYTWO:32},BlendMode:{LINEARDODGE:'linearDodge'}},
    app:{documents:[doc],activeDocument:doc},documentInfo:()=>doc,
    layers:()=>[source,...writes].map(layer=>({id:layer.id,name:layer.name,layer})),
    core:{executeAsModal:async action=>action({})},
    upload:async()=>{const id='input'+(++uploads);images.add(id);return {id,size:16,width:3,height:2,components:4};},
    transaction:async(d,label,action)=>action({}),
    write:async(d,key,meta,name)=>{if(h.outcome==='write')throw new Error('Photoshop write failed');
      const layer={id:20+writes.length,name,visible:true};writes.push(layer);return layer;},
    starBlendModes:()=>['screen'],starEncoding:()=>'black'};
  const fetch=async(url,options)=>{
    const path=new URL(url).pathname;
    let response={};
    if(path==='/starnet-info')response={modern:false,installation:{ready:true,modelPath:'model'}};
    if(path==='/jobs'){
      requests.push(JSON.parse(options.body));
      if(h.outcome==='createLost')throw new Error('Job creation reply lost');
      response={id:'job'+requests.length};
    }
    if(path.startsWith('/jobs/')){
      if(h.outcome==='pollLost')throw new Error('Job progress reply lost');
      if(h.outcome==='error')response={state:'error',error:'Engine failed'};
      else if(h.outcome==='canceled')response={state:'canceled'};
      else {
        const result={background:'bg'+requests.length,stars:'stars'+requests.length,provider:'CPU'};
        images.add(result.background);images.add(result.stars);
        response={state:'done',progress:1,result};
      }
    }
    if(options.method==='DELETE'){
      deleted.push(path);
      if(releaseFails)throw new Error('Cleanup failed');
      images.delete(path.slice('/images/'.length));
    }
    return {ok:true,json:async()=>response};
  };
  const context={module:{exports:{}},document:{getElementById:get,createElement:()=>({})},URL,fetch,
    console:{log(){},error:(...args)=>logs.push(args)},
    require:name=>name==='./host.js'?host:{url:'http://127.0.0.1:8765',token:'test'}};
  const code=fs.readFileSync('plugin/main.js','utf8');
  vm.runInNewContext(code.slice(0,code.indexOf("\nfor (const id of ['decomposition','stride'])"))+"\nmodule.exports={extract,refresh};",context);
  vm.runInNewContext("photoStages.set(7,'developed');",context);
  context.module.exports.refresh();h.extract=context.module.exports.extract;
  return h;
}

for(const outcome of ['error','canceled'])test('a terminal '+outcome+' releases its uploaded extraction source',async()=>{
  const h=failureHarness(outcome);
  await assert.rejects(h.extract(),outcome==='error'?/Engine failed/:/处理已取消/);
  assert.deepEqual(h.deleted,['/images/input1']);assert.equal(h.images.size,0);
  assert.equal(h.writes.length,0);assert.equal(h.requests.length,1);
});

for(const outcome of ['createLost','pollLost'])test(outcome+' retains input while the worker terminal state is unknown',async()=>{
  const h=failureHarness(outcome);
  await assert.rejects(h.extract(),/reply lost/);
  assert.deepEqual(h.deleted,[]);assert.equal(h.images.has('input1'),true);
  assert.equal(h.writes.length,0);
});

test('a failed extraction can retry without retaining the previous terminal input',async()=>{
  const h=failureHarness();
  await assert.rejects(h.extract(),/Engine failed/);assert.equal(h.images.size,0);
  h.outcome='done';await h.extract();
  assert.equal(h.requests[1].image,'input2');assert.equal(h.images.size,0);
  assert.equal(h.writes.length,2);assert.equal(h.writes[1].visible,false);
  assert.deepEqual(h.deleted,['/images/input1','/images/input2','/images/bg2','/images/stars2']);
});

test('failure to release a terminal input preserves the original engine error',async()=>{
  const h=failureHarness('error',true);
  await assert.rejects(h.extract(),/Engine failed/);
  assert.deepEqual(h.deleted,['/images/input1']);assert.equal(h.images.has('input1'),true);
  assert.equal(h.logs.length,1);assert.equal(h.writes.length,0);
});

test('a Photoshop write failure still releases the input and both completed extraction outputs',async()=>{
  const h=failureHarness('write');
  await assert.rejects(h.extract(),/Photoshop write failed/);
  assert.deepEqual(h.deleted,['/images/input1','/images/bg1','/images/stars1']);
  assert.equal(h.images.size,0);
});
