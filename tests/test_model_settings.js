const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function panel(saved={}) {
  const elements=new Map();
  const get=id=>{
    if(!elements.has(id)) elements.set(id,{value:'',selectedIndex:0,checked:false,classList:{add(){},remove(){}},parentElement:{style:{}}});
    return elements.get(id);
  };
  get('executable').value='D:\\latest\\starnet2.exe';
  let written,info={modern:true,license:'Full terms',license_sha256:'revision-1',installation:{ready:true,modelPath:'model'}};
  const settings={name:'model-settings.json',read:async()=>JSON.stringify(saved),write:async value=>{written=JSON.parse(value);}};
  const context={document:{getElementById:get},console,module:{exports:{}},fetch:async()=>({ok:true,json:async()=>info}),
    require:name=>name==='./bridge.json'?{url:'http://127.0.0.1:8765',starnet:get('executable').value}:
      name==='uxp'?{storage:{localFileSystem:{getDataFolder:async()=>({getEntries:async()=>[settings]})}}}:{} };
  const source=fs.readFileSync('plugin/main.js','utf8');
  vm.runInNewContext(source.slice(0,source.indexOf("\nfor (const id of ['decomposition','stride'])"))+ '\nmodule.exports={restoreModelSettings,saveModelSettings,modelExecutable,readModelLicense,extract};',context);
  return {get,...context.module.exports,written:()=>written,setInfo:value=>{info=value;},revise:()=>{info={...info,license:'Revised terms',license_sha256:'revision-2'};}};
}

test('a CPU path stays selected and the single field can switch to GPU',async()=>{
  const ui=panel({executable:'E:\\old\\starnet++.exe',stride:1,decomposition:0});
  await ui.restoreModelSettings();
  assert.equal(ui.modelExecutable(),'E:\\old\\starnet++.exe');
  ui.get('executable').value='D:\\latest\\starnet2.exe';
  await ui.saveModelSettings();
  assert.equal(ui.written().executable,'D:\\latest\\starnet2.exe');
  assert.equal('engineMode' in ui.written(),false);
  assert.equal('cpuExecutable' in ui.written(),false);
});

test('dual-field settings migrate whichever path was selected',async()=>{
  for(const mode of [0,1]) {
    const ui=panel({executable:'D:\\latest\\starnet2.exe',cpuExecutable:'E:\\cpu\\starnet++.exe',engineMode:mode});
    await ui.restoreModelSettings();
    assert.equal(ui.modelExecutable(),mode===1?'E:\\cpu\\starnet++.exe':'D:\\latest\\starnet2.exe');
  }
});

test('same terms stay accepted after restart, revised terms need acceptance',async()=>{
  const ui=panel({acceptedLicenses:['revision-1']});
  await ui.restoreModelSettings();
  await ui.readModelLicense();
  assert.equal(ui.get('acceptModelLicense').checked,true);
  ui.revise();
  await assert.rejects(ui.extract(),/许可/);
  assert.equal(ui.get('acceptModelLicense').checked,false);
  assert.equal(ui.get('licenseText').textContent,'Revised terms');
});

test('384 selection survives restart, and legacy CPU rejects it before reading Photoshop',async()=>{
  const ui=panel({executable:'E:\\old\\starnet++.exe',stride:3,decomposition:0});
  await ui.restoreModelSettings();
  assert.equal(ui.get('stride').selectedIndex,3);
  await ui.saveModelSettings();
  assert.equal(ui.written().stride,3);
  ui.setInfo({modern:false,product:'StarNet++ v2',installation:{ready:true,modelPath:'model'}});
  await assert.rejects(ui.extract(),/384.*新版/);
});

test('model background preservation is opt-in and the selected state survives restart',async()=>{
  for(const saved of [{}, {preserveModelBackground:true}, {preserveModelBackground:false}]) {
    const ui=panel(saved);await ui.restoreModelSettings();
    assert.equal(ui.get('preserveModelBackground').checked,saved.preserveModelBackground===true);
    ui.get('preserveModelBackground').checked=true;await ui.saveModelSettings();
    assert.equal(ui.written().preserveModelBackground,true);
  }
});
