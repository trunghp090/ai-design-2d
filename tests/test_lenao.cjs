const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync('public/app.js','utf8');
const section = src.slice(src.indexOf('const _imgCache ='), src.indexOf('/* =====================================================================\n   TÍNH NĂNG: EXCEL HÀNG LOẠT'));
const elements = new Map();
function el() {return {textContent:'',classList:{add(){},remove(){}},addEventListener(){},checked:true};}
const draws=[];
const ctx = {console, alert:()=>{}, $:id=>{if(!elements.has(id)) elements.set(id,el());return elements.get(id)}, document:{addEventListener(){},createElement:()=>({getContext:()=>({drawImage:(...args)=>draws.push(args)}),toDataURL:()=> 'data:image/png;base64,test'})}, Image:class {constructor(){this.naturalWidth=1000;this.naturalHeight=1000;}set src(v){this.url=v;queueMicrotask(()=>this.onload());}}, fetch:async()=>({ok:true,json:async()=>({items:Object.entries(JSON.parse(fs.readFileSync('mockups/labels.json'))).map(([file,name])=>({url:'/mockups/'+file,name,file}))})})};
vm.createContext(ctx);vm.runInContext(section,ctx);
vm.runInContext('lenaoRenderSlots = () => {};',ctx);
(async()=>{
await vm.runInContext('lenaoInit()',ctx);
const templateCount = Object.keys(JSON.parse(fs.readFileSync('mockups/labels.json'))).length;
assert.equal(vm.runInContext('lenaoSlots.length',ctx),templateCount);
await vm.runInContext('lenaoAddLayers(lenaoSlots[0], [{url:"partA",name:"A"},{url:"partB",name:"B"}])',ctx);
await vm.runInContext('lenaoAddLayers(lenaoSlots[0], [{url:"partC",name:"C"}])',ctx);
assert.equal(vm.runInContext('lenaoSlots[0].layers.length',ctx),3);
vm.runInContext('lenaoSlots[0].layers[1].state.xPct = 25',ctx);
assert.equal(vm.runInContext('lenaoSlots[0].layers[0].state.xPct',ctx),50);
await vm.runInContext('lenaoComposeSlot(lenaoSlots[0])',ctx);
assert.equal(draws.length,4);assert.deepEqual(draws.slice(1).map(x=>x[0].url),['partA','partB','partC']);
vm.runInContext('lenaoSlots[0].layers.splice(1,1); lenaoSync(lenaoSlots[0]);',ctx);
assert.equal(vm.runInContext('lenaoSlots[0].layers.length',ctx),2);
await vm.runInContext('lenaoAddDesigns(["separateA","separateB"])',ctx);
assert.equal(vm.runInContext('lenaoSlots.length',ctx),templateCount * 3);
await vm.runInContext('lenaoApplyAll("replacement")',ctx);
assert.equal(vm.runInContext('lenaoSlots[0].layers.length',ctx),1);
assert.equal(vm.runInContext('lenaoSlots[0].layers[0].design',ctx),'replacement');
console.log('PASS: all catalog templates; additive multi-component upload; independent positions; all layers exported in order; remove one layer; separate batches; replacement compatibility.');
})().catch(e=>{console.error(e);process.exitCode=1});
