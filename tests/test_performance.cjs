const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('public/app.js', 'utf8');
function fn(name) { const start=source.indexOf(`async function ${name}()`); return source.slice(start, source.indexOf('\n}\n',start)+2); }
for (const prefix of ['ds','ss','psn']) {
  test(`${prefix}: serialize polling, request deltas, preserve DOM when unchanged`, async()=>{
    const els={}; let calls=[],release,renders=0;
    const ctx={encodeURIComponent, clearInterval(){}, $:id=>els[id] ||= {style:{}}, dsItemKey:it=>it.title,
      fetch:async url=>{calls.push(url);if(calls.length===1)await new Promise(r=>release=r);return {ok:true,json:async()=>({total:3,done:1,items:calls.length===1?[{title:'one'}]:[],errors:[]})};}};
    ctx[prefix+'Jobs']=[{id:'job',total:3,finished:false}];ctx[prefix+'Items']=prefix==='ds'?{}:[];
    ctx[prefix+'Polling']=false;ctx[prefix+'PollTimer']=1;ctx[prefix+'Render']=()=>renders++;
    vm.createContext(ctx);vm.runInContext(fn(prefix+'PollAll'),ctx);
    const p=ctx[prefix+'PollAll']();await ctx[prefix+'PollAll']();assert.equal(calls.length,1);release();await p;
    await ctx[prefix+'PollAll']();assert.match(calls[1],/&have=1$/);assert.equal(renders,1);
    ctx.fetch=async()=>{throw Error('offline');};await ctx[prefix+'PollAll']();assert.equal(ctx[prefix+'Polling'],false);assert.equal(ctx[prefix+'Jobs'][0].have,1);
  });
}
test('image cache evicts old entries and retries failed image loads',async()=>{
  let created=0;
  class Image { set src(src){created++;queueMicrotask(()=>src==='bad'?this.onerror():this.onload());} }
  const start=source.indexOf('const _imgCache =');const end=source.indexOf('\nlet lenaoSlots',start);
  const ctx={Image,Map,Error};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  await ctx.loadImg('same');await ctx.loadImg('same');assert.equal(created,1);
  for(let i=0;i<30;i++)await ctx.loadImg('img'+i);
  assert.equal(vm.runInContext('_imgCache.size',ctx),24);
  await assert.rejects(ctx.loadImg('bad'));await assert.rejects(ctx.loadImg('bad'));assert.equal(created,33);
});
