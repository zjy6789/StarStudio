const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');

test('initialization and reset restore valid, neutral star-processing defaults',()=>{
  const elements=new Map();
  function element() {
    return {value:'',checked:false,disabled:false,children:[],listeners:{},
      classList:{toggle(){},contains(){return false;}},setAttribute(){},
      appendChild(child){this.children.push(child);if(child.id)elements.set(child.id,child);},
      addEventListener(name,action){this.listeners[name]=action;},
      set innerHTML(html){
        for(const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
          const child=element();
          child.value=match[0].match(/value="([^"]+)"/)?.[1]??'';
          elements.set(match[1],child);
        }
      }};
  }
  const document={createElement:element,getElementById(id){
    if(!elements.has(id))elements.set(id,element());return elements.get(id);
  }};
  const context={document,require:()=>({app:{documents:[]}}),module:{exports:{}},
    btoa:s=>Buffer.from(s).toString('base64'),clearTimeout(){},setTimeout(){throw Error('No source selected');}};
  vm.runInNewContext(fs.readFileSync('plugin/star-processing.js','utf8'),context);
  context.module.exports.setup({value:()=>null,currentPage:()=>'process'});
  const defaults={curve:{exposure:0,shadows:.25,midtones:.5,highlights:.75},
    coma:{strength:.5,sigma:2,radius:8,roundness:.9},
    reduction:{strength:.35,radius:1,threshold:.01,protect:.8},
    glow:{strength:1,radius:12,lower:.2,upper:1,softness:.1,spread:.35},
    color:{saturation:1,protect:.85}};
  function check() {
    for(const [name,params] of Object.entries(defaults)) {
      assert.equal(elements.get(name+'Enabled').checked,false);
      for(const [key,expected] of Object.entries(params))for(const suffix of ['', '_range'])
        assert.equal(Number(elements.get('process_'+name+'_'+key+suffix).value),expected,name+'.'+key+suffix);
    }
  }
  check();
  for(const [id,node] of elements)if(id.startsWith('process_'))node.value=999;
  elements.get('glowEnabled').checked=true;
  elements.get('processReset').listeners.click();check();
});
