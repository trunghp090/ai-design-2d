const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const source=require('node:fs').readFileSync('public/app.js','utf8');
function setup(items){
 const els={},inputs=items.map(it=>({checked:!!it._sel})),requests=[],notes=[];
 const c={ttItems:items,ttDeleting:false,document:{querySelectorAll:()=>inputs},
  $:id=>els[id]||=( {dataset:{},classList:{toggle(){}}} ),
  ttNotice:m=>notes.push(m),ttTextedDataURL:async it=>'data:image/png;base64,text-'+it.idx,
  ttSaveFile:async factory=>factory(),
  fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:true,blob:async()=> 'zip'};}
 };
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function ttSaveSelected('),source.indexOf('let ttDeleting = false;')),c);
 vm.runInContext(source.slice(source.indexOf('function ttSetAllSelected('),source.indexOf('function ttRender()')),c);
 return {c,els,inputs,requests,notes};
}
test('download all includes unselected slides in the same order as the carousel',async()=>{
 const {c,requests}=setup([{idx:5,title:'last',image:'last'},{idx:0,title:'hook',image:'hook'},{idx:2,title:'middle',image:'middle'}]);
 await c.ttSaveSelected(false,null,true);
 assert.deepEqual(requests[0].body.items.map(it=>it.name),['hook','middle','last']);
 assert.equal(c.ttItems.every(it=>!it._sel),true,'download-all does not mutate selection');
});
test('selected download excludes other slides and preserves displayed text',async()=>{
 const {c,requests}=setup([{idx:5,title:'last',image:'last',_sel:true,_showText:true,_textedUrl:'data:image/png;base64,with-text'},{idx:0,title:'hook',image:'hook'},{idx:2,title:'middle',image:'middle',_sel:true}]);
 await c.ttSaveSelected(false,null);
 assert.deepEqual(requests[0].body.items.map(it=>it.name),['middle','last-text']);
 assert.equal(requests[0].body.items[1].data,'data:image/png;base64,with-text');
});
test('empty selected download makes no ZIP request; download-all remains enabled',async()=>{
 const {c,els,requests,notes}=setup([{idx:0,image:'a'}]);
 c.ttUpdateSel();await c.ttSaveSelected(true,null);
 assert.equal(requests.length,0);assert.match(notes[0],/Chọn ảnh/);
 assert.equal(els.ttDlTexted.disabled,true);assert.equal(els.ttZipBtn.disabled,false);
});
test('select all updates checkboxes without rebuilding images; partial selection is visible',()=>{
 const {c,els,inputs}=setup([{_sel:true},{_sel:false}]);
 c.ttUpdateSel();assert.equal(els.ttPickAll.indeterminate,true);
 c.ttSetAllSelected(true);assert.equal(inputs.every(x=>x.checked),true);
 assert.equal(els.ttSelCount.textContent,'Đã chọn 2/2');assert.equal(els.ttPickAll.indeterminate,false);
 c.ttSetAllSelected(false);assert.equal(inputs.some(x=>x.checked),false);
 assert.equal(els.ttDlTexted.disabled,true);assert.equal(els.ttZipBtn.disabled,false);
});
