const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const source=fs.readFileSync('public/social-downloader.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup({imageResult=()=> 'load',hold=false}={}) {
  const elements=new Map(), requests=[], previews=[], active=new Set();
  let peak=0;
  class Element {
    constructor(tag='div') {this.tag=tag;this.dataset={};this.attributes={};this.listeners={};this.children=[];this.value='';this.textContent='';const classes=new Set();this.classList={add: x=>classes.add(x),remove:x=>classes.delete(x),toggle(x,on){on?classes.add(x):classes.delete(x);},contains:x=>classes.has(x)};}
    addEventListener(name,fn,{once=false}={}) {(this.listeners[name]??=[]).push({fn,once});}
    removeEventListener(name,fn) {this.listeners[name]=(this.listeners[name]||[]).filter(item=>item.fn!==fn);}
    async emit(name) {await Promise.all((this.listeners[name]||[]).slice().map(item=>{if(item.once)this.removeEventListener(name,item.fn);return item.fn({preventDefault(){}});}));}
    setAttribute(key,value) {this.attributes[key]=value;}
    removeAttribute(key) {delete this.attributes[key];if(key==='src')active.delete(this);}
    hasAttribute(key) {return key in this.attributes;}
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children=children.flatMap(child=>child.tag==='fragment'?child.children:[child]);}
    focus() {}
    set src(url) {this.attributes.src=url;active.add(this);peak=Math.max(peak,active.size);const attempt={image:this,url};previews.push(attempt);if(!hold)setImmediate(()=>complete(attempt,imageResult(url,previews)));}
    get src() {return this.attributes.src;}
  }
  const complete=(attempt,event)=>{if(!active.has(attempt.image))return;active.delete(attempt.image);void attempt.image.emit(event);};
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  get('socialDownloadInput').value='https://www.douyin.com/note/7620805310613466853';
  const data={platform:'douyin',type:'images',items:Array.from({length:12},(_,index)=>({index,kind:'image',preview_url:'https://example.test/api/social-download/file?id=demo&index='+index,download_url:'https://example.test/api/social-download/file?id=demo&index='+index+'&download=1'})),zip_url:'https://example.test/api/social-download/zip?id=demo'};
  const ctx={document:{getElementById:get,createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment')},window:{},location:{origin:'https://example.test',href:'https://example.test/'},URL,AbortController,crypto:{randomUUID},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,10)),clearTimeout,setInterval,clearInterval,fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>data};}};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const submit=()=>get('socialDownloadForm').emit('submit');
  const drain=async()=>{for(let step=0;step<150;step++){if(previews.length>=12&&!active.size)return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Preview queue did not finish');};
  return {get,requests,previews,active,submit,complete,drain,peak:()=>peak};
}

test('12-image album previews never exceed two concurrent transfers',async()=>{
  const state=setup();await state.submit();await state.drain();
  assert.equal(state.previews.length,12);assert.equal(state.peak(),2);
  assert.equal(state.get('socialDownloadStatus').dataset.state,'success');
});

test('preview errors retry with a fresh URL and do not replace a ZIP download status',async()=>{
  const attempts=new Map();
  const state=setup({imageResult:url=>{const index=new URL(url).searchParams.get('index');const count=(attempts.get(index)||0)+1;attempts.set(index,count);return index==='0'&&count<3||index==='1'?'error':'load';}});
  await state.submit();await state.get('socialDownloadAll').emit('click');
  await state.drain();
  assert.equal(attempts.get('0'),3);assert.equal(attempts.get('1'),3);assert.equal(state.peak(),2);
  const retries=state.previews.filter(item=>new URL(item.url).searchParams.get('index')==='0');
  assert.equal(new Set(retries.map(item=>item.url)).size,3);
  assert.match(state.get('socialDownloadStatus').textContent,/yêu cầu tải bộ ảnh ZIP/);
  const failed=state.get('socialDownloadItems').children[1].children[1].children[0];
  assert.match(failed.textContent,/Chưa xem trước/);
});

test('clearing an album cancels pending previews and prevents later retries',async()=>{
  const state=setup({hold:true});await state.submit();assert.equal(state.previews.length,2);
  await state.get('socialDownloadClear').emit('click');
  state.previews.forEach(item=>state.complete(item,'error'));await tick();await tick();
  assert.equal(state.previews.length,2);assert.equal(state.active.size,0);
  assert.equal(state.get('socialDownloadItems').children.length,0);
});

test('Douyin credentials stay in volatile inputs after success, skip TikTok, and clear explicitly',async()=>{
  const state=setup();const cookie=state.get('socialDownloadDouyinCookie'),agent=state.get('socialDownloadDouyinUserAgent');
  cookie.value='fixture_session=example';agent.value='Fixture Browser';
  await state.submit();assert.equal(cookie.value,'fixture_session=example');assert.equal(agent.value,'Fixture Browser');
  await state.submit();assert.equal(state.requests[1].douyin_cookie,'fixture_session=example');assert.equal(state.requests[1].douyin_user_agent,'Fixture Browser');
  state.get('socialDownloadInput').value='https://vt.tiktok.com/demo/';await state.submit();
  assert.equal(Object.hasOwn(state.requests[2],'douyin_cookie'),false);assert.equal(Object.hasOwn(state.requests[2],'douyin_user_agent'),false);
  await state.get('socialDownloadCancel').emit('click');assert.equal(cookie.value,'');assert.equal(agent.value,'');
  cookie.value='fixture_session=example';agent.value='Fixture Browser';await state.get('socialDownloadClear').emit('click');
  assert.equal(cookie.value,'');assert.equal(agent.value,'');
});
