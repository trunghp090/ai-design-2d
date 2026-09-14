const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const s=require('node:fs').readFileSync('public/app.js','utf8');
const code=s.slice(s.indexOf('async function ttSaveFile('),s.indexOf('function ttSaveSelected('));
function setup(picker){const els={},notes=[];const c={window:{showSaveFilePicker:picker},$:id=>els[id]||={style:{}},ttNotice:m=>notes.push(m),notes,els};vm.createContext(c);vm.runInContext(code,c);return c;}
test('asks save location before building file; writes after selection',async()=>{
 const events=[];const c=setup(async()=>{events.push('picker');return {name:'x.png',createWritable:async()=>({write:async()=>events.push('write'),close:async()=>events.push('close')})};});
 await c.ttSaveFile(async()=>{events.push('build');return 'blob';},'x','png');assert.deepEqual(events,['picker','build','write','close']);
});
test('cancel never builds or writes',async()=>{const c=setup(async()=>{throw Object.assign(Error(),{name:'AbortError'});});let built=false;await c.ttSaveFile(async()=>built=true,'x','png');assert.equal(built,false);});
test('unsupported browser offers manual preparation without automatic download',async()=>{const c=setup();let built=false;await c.ttSaveFile(async()=>built=true,'x','zip');assert.equal(built,false);assert.equal(c.els.ttSaveHelp.style.display,'block');assert.equal(typeof c.els.ttPrepareSave.onclick,'function');});
test('shared manager receives lazy ZIP work before it runs',async()=>{
 const c=setup(),events=[],button={dataset:{},textContent:'Tải ZIP',disabled:false};
 c.ttUpdateSel=()=>{};
 c.window.saveToolFile=async(makeBlob,name)=>{
  assert.equal(typeof makeBlob,'function');assert.equal(name,'bo-anh.zip');
  events.push('picker');await makeBlob();return 'saved';
 };
 await c.ttSaveFile(async()=>events.push('build'),'bo-anh','zip',button);
 assert.deepEqual(events,['picker','build']);assert.equal(button.disabled,false);
 assert.match(c.notes.at(-1),/Đã lưu/);
});
test('shared manager cancellation never builds ZIP and restores its button',async()=>{
 const c=setup(),button={dataset:{},textContent:'Tải ZIP',disabled:false};let built=false;
 c.ttUpdateSel=()=>{};c.window.saveToolFile=async()=> 'cancelled';
 await c.ttSaveFile(async()=>built=true,'bo-anh','zip',button);
 assert.equal(built,false);assert.equal(button.disabled,false);assert.equal(button.textContent,'Tải ZIP');
 assert.match(c.notes.at(-1),/huỷ/);
});
