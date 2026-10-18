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
      if(route==='/starnet-info') response={modern:false};
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
