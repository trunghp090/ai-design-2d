const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const source=require('node:fs').readFileSync('public/app.js','utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const common=between('function autoDownload(', '// NHIỀU LUỒNG:')+between('async function zipDownloadSelected(', '/* =====================================================================');
const handler=id=>{const start=source.indexOf('$("'+id+'").onclick = async () => {');return source.slice(start,source.indexOf('\n};',start)+3);};
const plain=value=>JSON.parse(JSON.stringify(value));
function setup(extra={},download=async()=> 'downloaded') {
  const elements=new Map(),calls=[],alerts=[],anchors=[];
  const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'Tải '+id,disabled:false,querySelectorAll:()=>[],children:[]});return elements.get(id);};
  const ctx={window:{downloadToolFiles(items,name){calls.push({items:plain(items),name});return download(items,name);}},
    $:get,Date:{now:()=>123},alert:message=>alerts.push(message),
    document:{createElement:()=>({dataset:{},click(){anchors.push(this);},remove(){}}),body:{appendChild(){}}},
    fetch:()=>{throw Error('Pass URLs to the central ZIP helper instead of fetching them separately');},...extra};
  vm.createContext(ctx);vm.runInContext(common,ctx);return {ctx,get,calls,alerts,anchors};
}
test('Recolor selected completed images become one ZIP in displayed order',async()=>{
  const state=setup({recolorSel:new Set([2,0,8])});
  state.get('recolorResults').querySelectorAll=()=>[{_cur:'aGVsbG8=',_title:'màu đỏ'},{_cur:'not selected'},
    {_cur:'data:image/png;base64,d29ybGQ=',_title:'màu xanh'}];
  vm.runInContext(handler('recolorDownloadSel'),state.ctx);assert.equal(await state.get('recolorDownloadSel').onclick(),'downloaded');
  assert.deepEqual(state.calls,[{items:[{data:'data:image/png;base64,aGVsbG8=',name:'màu đỏ'},
    {data:'data:image/png;base64,d29ybGQ=',name:'màu xanh'}],name:'recolor-123.zip'}]);
  assert.equal(state.anchors.length,0);assert.deepEqual(state.alerts,[]);
});
test('Batch includes raw base64 and URL sources once while skipping incomplete cards',async()=>{
  const state=setup();state.get('batchResults').querySelectorAll=()=>[
    {_cur:'aGVsbG8=',_name:'tên riêng'},{_cur:'/gallery/completed.png',_name:'ảnh gốc'},{_cur:null,_name:'đang tạo'}];
  vm.runInContext(handler('batchDownloadAll'),state.ctx);await state.get('batchDownloadAll').onclick();
  assert.deepEqual(state.calls,[{items:[{data:'data:image/png;base64,aGVsbG8=',name:'tên riêng'},
    {url:'/gallery/completed.png',name:'ảnh gốc'}],name:'batch-123.zip'}]);assert.equal(state.anchors.length,0);
});
test('Design ZIP keeps gallery URLs without converting them to base64',async()=>{
  const state=setup({dsB64:()=>{throw Error('Must not convert gallery URLs');}});
  state.get('dsResults').querySelectorAll=()=>[{_cur:'aGVsbG8=',_name:'fresh'},{_it:{url:'/gallery/history.png'},_name:'history'},
    {_it:{gallery:{url:'/gallery/another.png'}},_name:'gallery'},{_it:{},_name:'pending'}];
  vm.runInContext(handler('dsDownloadAll'),state.ctx);await state.get('dsDownloadAll').onclick();
  assert.deepEqual(state.calls[0],{items:[{data:'data:image/png;base64,aGVsbG8=',name:'fresh'},
    {url:'/gallery/history.png',name:'history'},{url:'/gallery/another.png',name:'gallery'}],name:'design-123.zip'});
  assert.equal(state.calls.length,1);assert.equal(state.anchors.length,0);
});
test('Lên áo composes selected slots in order before requesting one ZIP',async()=>{
  const resolvers=new Map();let finish;
  const slots=[{design:'first',name:'Áo đầu'},{design:'second',name:'Áo sau'},{design:null,name:'trống'}];
  const state=setup({lenaoSlots:slots,lenaoComposeSlot:slot=>new Promise(resolve=>resolvers.set(slot.name,resolve))},
    ()=>new Promise(resolve=>{finish=resolve;}));
  state.get('lenaoSlots').children=slots.map(()=>({querySelector:()=>({checked:true})}));
  vm.runInContext(handler('lenaoDownloadSel'),state.ctx);const pending=state.get('lenaoDownloadSel').onclick();
  assert.equal(state.get('lenaoDownloadSel').disabled,true);assert.equal(resolvers.has('Áo sau'),false);
  resolvers.get('Áo đầu')('data:image/png;base64,aGVsbG8=');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(state.calls.length,0);
  resolvers.get('Áo sau')('data:image/png;base64,d29ybGQ=');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(state.calls[0],{items:[{data:'data:image/png;base64,aGVsbG8=',name:'Áo đầu_design'},
    {data:'data:image/png;base64,d29ybGQ=',name:'Áo sau_design'}],name:'lenao-123.zip'});
  assert.equal(state.get('lenaoDownloadSel').disabled,true);finish('downloaded');await pending;
  assert.equal(state.get('lenaoDownloadSel').disabled,false);
});
test('Post sends one ordered ZIP and reports a browser request rather than a saved file',async()=>{
  const state=setup({postPicked:['/gallery/first.png','https://cdn.example.test/second.png','data:image/png;base64,dGhpcmQ=']});
  vm.runInContext(between('async function postDownloadAll(', 'function postRenderPreview('),state.ctx);await state.ctx.postDownloadAll();
  assert.deepEqual(state.calls,[{items:[{url:'/gallery/first.png',name:'slide-01'},{url:'https://cdn.example.test/second.png',name:'slide-02'},
    {data:'data:image/png;base64,dGhpcmQ=',name:'slide-03'}],name:'bo-anh-post-123.zip'}]);
  assert.match(state.get('postNote').textContent,/Đã gửi yêu cầu tải ZIP.*Ctrl\+J/);assert.doesNotMatch(state.get('postNote').textContent,/Đã lưu|Đã tải/);
  assert.equal(state.get('postDownloadAll').disabled,false);assert.equal(state.anchors.length,0);
});
test('FB post ZIP includes selected historical URLs and current base64 images',async()=>{
  const button={textContent:'Tải bộ',disabled:false};const state=setup({card:{querySelector:()=>button},
    it:{concept:'Couple',_pick:new Set([0,1,2]),pics:[{url:'/gallery/history.png'},{image:'aGVsbG8='},{image:null},{image:'unselected'}]}});
  vm.runInContext(between('    card.querySelector(".b-dlall").onclick =', '    card.querySelector(".b-delhist").onclick ='),state.ctx);await button.onclick();
  assert.deepEqual(state.calls,[{items:[{url:'/gallery/history.png',name:'Couple-1'},
    {data:'data:image/png;base64,aGVsbG8=',name:'Couple-2'}],name:'fbpost-123.zip'}]);assert.equal(state.anchors.length,0);
});
test('selected ZIP awaits the helper and restores controls on backend rejection',async()=>{
  let reject;const state=setup({},()=>new Promise((resolve,no)=>{reject=no;}));const button=state.get('zip'),label=button.textContent;
  const pending=state.ctx.zipDownloadSelected([{id:'gallery-id',url:'/gallery/original.png',name:'original'}],button);
  assert.equal(button.disabled,true);assert.deepEqual(state.calls[0].items,[{id:'gallery-id',url:'/gallery/original.png',name:'original'}]);
  reject(Error('Ảnh thứ 2 không đọc được; ZIP chưa được xuất.'));await pending;
  assert.match(state.alerts[0],/ZIP chưa được xuất/);assert.equal(button.disabled,false);assert.equal(button.textContent,label);assert.equal(state.anchors.length,0);
});
test('only incomplete images do not produce an empty ZIP request',async()=>{
  const state=setup();state.get('batchResults').querySelectorAll=()=>[{_cur:null},{_cur:''}];
  vm.runInContext(handler('batchDownloadAll'),state.ctx);await state.get('batchDownloadAll').onclick();
  assert.equal(state.calls.length,0);assert.match(state.alerts[0],/Chưa có ảnh hoàn tất/);assert.equal(state.get('batchDownloadAll').disabled,false);
});
test('single download returns the helper promise without creating a duplicate anchor',async()=>{
  const calls=[];let finish;const state=setup({window:{downloadToolURL(url,name){calls.push({url,name});return new Promise(resolve=>{finish=resolve;});}}});
  const pending=state.ctx.autoDownload('aGVsbG8=','design one');assert.equal(typeof pending.then,'function');
  assert.deepEqual(calls,[{url:'data:image/png;base64,aGVsbG8=',name:'design_one.png'}]);assert.equal(state.anchors.length,0);
  finish('downloaded');assert.equal(await pending,'downloaded');
});
test('URL and data-URL single sources are preserved without double base64 prefixes',async()=>{
  const calls=[];const state=setup({window:{downloadToolURL:(url,name)=>{calls.push({url,name});return 'downloaded';}}});
  await state.ctx.autoDownload('/gallery/image.png','history');await state.ctx.autoDownload('data:image/png;base64,aGVsbG8=','data');
  assert.deepEqual(calls.map(call=>call.url),['/gallery/image.png','data:image/png;base64,aGVsbG8=']);assert.equal(state.anchors.length,0);
});

test('URL-only Mix Design uses the shared downloader once instead of opening a preview tab',async()=>{
  const calls=[],button={disabled:false};const state=setup({it:{url:'/gallery/mix.png'},card:{querySelector:()=>button},
    window:{downloadToolURL:(url,name)=>{calls.push({url,name});return 'downloaded';},open:()=>{throw Error('Must download instead of opening preview');}}});
  const start=source.indexOf('    card.querySelector(".b-dl").onclick =',source.indexOf('function mixdRenderResults('));
  vm.runInContext(source.slice(start,source.indexOf('\n',start)),state.ctx);await button.onclick({currentTarget:button});
  assert.deepEqual(calls,[{url:'/gallery/mix.png',name:'mixdesign.png'}]);assert.equal(button.disabled,false);assert.equal(state.anchors.length,0);
});

test('a failed queued single download is visible and restores the button without duplication',async()=>{
  let reject,calls=0;const state=setup({window:{downloadToolURL:()=>{calls++;return new Promise((resolve,no)=>{reject=no;});}}});
  const button={disabled:false};const pending=state.ctx.autoDownloadButton('/gallery/file.png','image',button);
  assert.equal(button.disabled,true);await state.ctx.autoDownloadButton('/gallery/file.png','image',button);assert.equal(calls,1);
  reject(Error('Không đọc được ảnh tải xuống.'));assert.equal(await pending,'failed');
  assert.equal(button.disabled,false);assert.match(state.alerts[0],/Không đọc được ảnh/);assert.equal(state.anchors.length,0);
});
