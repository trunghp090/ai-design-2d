const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/app.js', 'utf8');
const poll = source.slice(source.indexOf('let ttPolling = false;'), source.indexOf('/* 🅰️', source.indexOf('let ttPolling = false;')));
function setup(fetch, job = {}) {
  const els = {};
  const c = {ttJobs:[{id:'job',total:5,done:0,finished:false,...job}], ttItems:[], ttPollTimer:1, ttMeta:null,
    fetch, ttAutoBurn:async()=>{}, ttRender(){}, clearInterval(){}, $:id=>els[id] ||= {style:{}}, els};
  vm.createContext(c); vm.runInContext(poll,c); return c;
}
const response = d=>({ok:true,json:async()=>d});
const items = ns=>ns.map(idx=>({idx,title:'Slide '+idx}));
test('overlapping polls do not double advance the cursor or skip slides', async()=>{
  let release, calls=[];
  const c=setup(async url=>{calls.push(url);if(calls.length===1)await new Promise(r=>release=r);return response(calls.length===1?{items:items([1,2]),done:2,count:2}:{items:items([3,4,5]),done:5,count:5,finished:true});});
  const pending=c.ttPollAll(); await c.ttPollAll(); assert.equal(calls.length,1); release(); await pending;
  await c.ttPollAll(); assert.match(calls[1],/have=2$/); assert.equal(c.ttItems.length,5); assert.match(c.els.ttNote.textContent,/Đã tạo đủ 5\/5/);
});
test('completed responses reconcile missing items with a full read',async()=>{
  let calls=[]; const c=setup(async url=>{calls.push(url);return response({items:calls.length===1?items([5]):items([1,2,3,4,5]),count:5,done:5,finished:true});},{have:4});
  await c.ttPollAll(); assert.match(calls[1],/have=0$/); assert.equal(c.ttItems.length,5);
});
test('failed generation shows actual images and preserves errors',async()=>{
  let n=0;const c=setup(async()=>response(++n===1?{items:items([1,2]),count:2,done:3,errors:['Slide 3 thất bại']}:{items:items([5]),count:3,done:5,finished:true,errors:['Slide 4 thất bại']}));
  await c.ttPollAll();await c.ttPollAll();assert.match(c.els.ttNote.textContent,/3\/5/);assert.match(c.els.ttNote.textContent,/Slide 3 thất bại/);assert.match(c.els.ttNote.textContent,/Slide 4 thất bại/);assert.equal(c.els.ttNote.className,'gen-note err');
});
test('network failures retain cursor and can recover',async()=>{
 let n=0;const c=setup(async()=>{if(++n===1)throw Error('Mất kết nối');return response({items:items([1,2,3,4,5]),count:5,done:5,finished:true});});
 await c.ttPollAll();assert.equal(c.ttJobs[0].have,undefined);assert.match(c.els.ttNote.textContent,/Mất kết nối/);await c.ttPollAll();assert.equal(c.ttItems.length,5);
});
