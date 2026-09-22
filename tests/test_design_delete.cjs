const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('public/app.js', 'utf8');
const helper = source.slice(source.indexOf('const dsSelected ='), source.indexOf('function dsItemKey'));
function setup(fetch, confirm = () => true) {
  const els = {}, alerts = [];
  const ctx = {dsItems: {a:{gallery:{id:'a'}}, b:{gallery:{id:'b'}}},
    fetch, confirm, alert: x => alerts.push(x), $: id => els[id] ||= {}, dsRender: () => {}};
  vm.createContext(ctx);
  vm.runInContext(helper, ctx);
  els.dsSelectAll.onclick();
  return {ctx, els, alerts};
}
test('bulk deletion stops on server error and keeps failed/unattempted images selected', async () => {
  const calls = [];
  const {ctx, els, alerts} = setup(async url => {
    calls.push(url);
    return calls.length === 1 ? {ok:true,json:async()=>({ok:true})} :
      {ok:false,status:502,json:async()=>{throw Error('Bad Gateway');}};
  });
  await els.dsDeleteSelected.onclick();
  assert.deepEqual(Object.keys(ctx.dsItems), ['b']);
  assert.equal(vm.runInContext('dsSelected.has("b")',ctx), true);
  assert.equal(alerts.length,1);
  assert.equal(vm.runInContext('dsDeleting',ctx),false);
});
test('cancel leaves data intact without sending deletion requests', async () => {
  let calls = 0;
  const {ctx,els} = setup(async()=>{calls++;},()=>false);
  await els.dsDeleteSelected.onclick();
  assert.equal(calls,0);
  assert.equal(Object.keys(ctx.dsItems).length,2);
});
test('bulk deletion sends one request at a time and only selected images', async () => {
  let active = 0, peak = 0, calls = 0;
  const {ctx,els} = setup(async()=>{
    calls++; active++; peak=Math.max(peak,active);
    await new Promise(resolve=>setImmediate(resolve)); active--;
    return {ok:true,json:async()=>({ok:true})};
  });
  ctx.dsItems.unselected={gallery:{id:'unselected'}};
  await els.dsDeleteSelected.onclick();
  assert.equal(peak,1);
  assert.equal(calls,2);
  assert.deepEqual(Object.keys(ctx.dsItems),['unselected']);
});
