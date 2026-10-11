const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const s=require('node:fs').readFileSync('public/app.js','utf8');
const code=s.slice(s.indexOf('async function ttSaveFile('),s.indexOf('function ttSaveSelected('));
function setup(save){
  const notes=[],anchors=[],revoked=[];
  const ctx={window:{saveToolFile:save,showSaveFilePicker:()=>{throw Error('Must use browser downloads');}},
    document:{createElement:()=>({dataset:{},click(){anchors.push(this);},remove(){}}),body:{appendChild(){}}},
    URL:{createObjectURL:()=> 'blob:prepared',revokeObjectURL:url=>revoked.push(url)},setTimeout:fn=>fn(),
    ttNotice:(message,error)=>notes.push({message,error:!!error}),ttUpdateSel(){}};
  vm.createContext(ctx);vm.runInContext(code,ctx);return {ctx,notes,anchors,revoked};
}
test('TikTok manager receives one lazy file and reports a native browser request',async()=>{
  const events=[];const state=setup(async(factory,name)=>{events.push('queue');assert.equal(name,'bo-anh.zip');await factory();return 'downloaded';});
  const button={dataset:{},textContent:'Tải ZIP',disabled:false};
  assert.equal(await state.ctx.ttSaveFile(async()=>{events.push('build');return 'zip';},'bo-anh','zip',button),'downloaded');
  assert.deepEqual(events,['queue','build']);assert.equal(state.anchors.length,0);
  assert.match(state.notes.at(-1).message,/Đã gửi yêu cầu tải.*Ctrl\+J/);assert.doesNotMatch(state.notes.at(-1).message,/Đã lưu/);
  assert.equal(button.disabled,false);assert.equal(button.textContent,'Tải ZIP');
});
test('TikTok fallback builds once and makes one native download without a picker',async()=>{
  const state=setup();let built=0;
  assert.equal(await state.ctx.ttSaveFile(async()=>{built++;return 'png';},'x','png'),'downloaded');
  assert.equal(built,1);assert.equal(state.anchors.length,1);
  assert.equal(state.anchors[0].href,'blob:prepared');assert.equal(state.anchors[0].download,'x.png');
  assert.equal(state.anchors[0].dataset.nativeDownload,'');assert.deepEqual(state.revoked,['blob:prepared']);
  assert.match(state.notes.at(-1).message,/Đã gửi yêu cầu tải/);
});
test('TikTok ready outcome never claims the file was downloaded or saved',async()=>{
  const state=setup(async()=> 'ready');const button={dataset:{},textContent:'Tải ZIP',disabled:false};
  assert.equal(await state.ctx.ttSaveFile(async()=> 'zip','x','zip',button),'ready');
  assert.match(state.notes.at(-1).message,/File đã sẵn sàng.*liên kết tải/);assert.doesNotMatch(state.notes.at(-1).message,/Đã lưu|Đã gửi/);
  assert.equal(button.disabled,false);assert.equal(state.anchors.length,0);
});
test('TikTok preparation failure restores controls without starting a native download',async()=>{
  const state=setup();const button={dataset:{},textContent:'Tải ZIP',disabled:false};
  await state.ctx.ttSaveFile(async()=>{throw Error('Không tạo được ZIP');},'x','zip',button);
  assert.equal(state.anchors.length,0);assert.equal(button.disabled,false);assert.equal(button.textContent,'Tải ZIP');
  assert.deepEqual(state.notes.at(-1),{message:'Không tạo được ZIP',error:true});
});
test('TikTok ignores a second click while its first request is pending',async()=>{
  let finish,calls=0;const state=setup(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const button={dataset:{},textContent:'Tải ZIP',disabled:false};
  const pending=state.ctx.ttSaveFile(async()=> 'zip','x','zip',button);
  await state.ctx.ttSaveFile(async()=> 'zip','x','zip',button);assert.equal(calls,1);
  finish('downloaded');await pending;assert.equal(button.disabled,false);
});
