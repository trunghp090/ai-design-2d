const assert = require('assert'), fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('public/app.js', 'utf8');
const code = src.slice(src.indexOf('function selectMockupForSide('), src.indexOf('/* ---------- xuất ảnh demo'));
const compose = src.slice(src.indexOf('async function composeMockupSide('), src.indexOf('$("exportMockup").onclick'));
const calls = [];
const context = {
  currentSide: 'front', sides: {front:{bg:'white-front'},back:{bg:'white-back', design:'BACK DESIGN'}},
  mockupCatalog:[{url:'white-front',side:'front',pair:'white'}, {url:'white-back',side:'back',pair:'white'}, {url:'hoodie',side:'front',pair:'hoodie'}],
  snapshotSide(){}, restoreSide(){}, setMockupBg(){}, document:{querySelectorAll:()=>[], createElement:()=>({getContext:()=>({fillRect(){},drawImage:(...v)=>calls.push(v),save(){},translate(){},rotate(){},restore(){}})})},
  loadImg:async src => ({src,naturalWidth:1000,naturalHeight:1200}),
};
vm.createContext(context); vm.runInContext(code + '\n' + compose, context);
vm.runInContext('selectMockupForSide("white-front","front")',context);
assert.equal(context.sides.back.bg,'white-back'); assert.equal(context.sides.back.design,'BACK DESIGN');
vm.runInContext('selectMockupForSide("hoodie","front")',context);
assert.equal(context.sides.back.bg,''); // Never quietly reuse a T-shirt back for a hoodie.
vm.runInContext('selectMockupForSide("white-back","back")',context);
assert.equal(context.sides.front.bg,'white-front');
(async()=>{
 await vm.runInContext('composeMockupSide({bg:"front",active:true,design:"ART",state:{wPct:38,xPct:50,yPct:42,rot:0}})', context);
 assert.deepEqual(calls.map(v=>v[0].src),['front','ART']);
 await assert.rejects(vm.runInContext('composeMockupSide({bg:""})',context));
 calls.length = 0;
 await vm.runInContext('composeMockupSide({bg:"front",layers:[{src:"ONE",state:{wPct:20,xPct:25,yPct:30,rot:0}},{src:"TWO",state:{wPct:30,xPct:60,yPct:70,rot:15}}]})',context);
 assert.deepEqual(calls.map(v=>v[0].src),['front','ONE','TWO']);
 console.log('PASS: matching front/back; preserve separate artwork; no stale unrelated back; compose artwork; missing side rejected.');
})().catch(e=>{console.error(e);process.exitCode=1});
