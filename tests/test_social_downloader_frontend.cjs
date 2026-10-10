const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const source=fs.readFileSync('public/social-downloader.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup({imageResult=()=> 'load',hold=false,bridge=null,fetchResult=null,saveResult=null}={}) {
  const elements=new Map(), requests=[], previews=[], active=new Set(), bridgeRequests=[], storageWrites=[], timers=new Set(), saves=[], saveCancels=[];
  const windowListeners=new Map();
  let bridgeResponder=bridge;
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
    click() {return this.emit('click');}
    focus() {}
    set href(value) {this.attributes.href=value;}
    get href() {return this.attributes.href;}
    set src(url) {this.attributes.src=url;active.add(this);peak=Math.max(peak,active.size);const attempt={image:this,url};previews.push(attempt);if(!hold)setImmediate(()=>complete(attempt,imageResult(url,previews)));}
    get src() {return this.attributes.src;}
  }
  const complete=(attempt,event)=>{if(!active.has(attempt.image))return;active.delete(attempt.image);void attempt.image.emit(event);};
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  get('socialDownloadInput').value='https://www.douyin.com/note/7620805310613466853';
  const data={platform:'douyin',post_id:'7620805310613466853',type:'images',items:Array.from({length:12},(_,index)=>({index,kind:'image',filename:'douyin-7620805310613466853-'+String(index+1).padStart(2,'0')+'.jpg',preview_url:'https://example.test/api/social-download/file?id=demo&index='+index,download_url:'https://example.test/api/social-download/file?id=demo&index='+index+'&download=1'})),zip_url:'https://example.test/api/social-download/zip?id=demo'};
  const location={origin:'https://example.test',href:'https://example.test/'};
  const storage={setItem:(key,value)=>storageWrites.push([key,value]),getItem:()=>null,removeItem(){},clear(){}};
  const window={
    addEventListener(name,fn){const listeners=windowListeners.get(name)||[];listeners.push(fn);windowListeners.set(name,listeners);},
    removeEventListener(name,fn){windowListeners.set(name,(windowListeners.get(name)||[]).filter(listener=>listener!==fn));},
    postMessage(message,targetOrigin){
      bridgeRequests.push({message,targetOrigin});
      if(bridgeResponder)Promise.resolve(bridgeResponder(message)).then(response=>{
        if(response)setImmediate(()=>void emitMessage(response));
      });
    },
    localStorage:storage,sessionStorage:storage,
    saveSocialDownload(url,filename,options){
      saves.push({url,filename,options});
      return saveResult?saveResult(url,filename,options):Promise.resolve({status:'saved',filename,bytes:16});
    },
    cancelSocialDownloadSave(){saveCancels.push(true);},
  };
  const emitMessage=async(data,{source=window,origin=location.origin}={})=>{
    await Promise.all((windowListeners.get('message')||[]).slice().map(listener=>listener({source,origin,data})));
  };
  const later=(fn,ms)=>{
    const timer=setTimeout(()=>{timers.delete(timer);fn();},Math.min(ms,10));
    timers.add(timer);return timer;
  };
  const clearLater=timer=>{timers.delete(timer);clearTimeout(timer);};
  const ctx={document:{getElementById:get,createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment')},window,location,localStorage:storage,sessionStorage:storage,URL,AbortController,crypto:{randomUUID},setTimeout:later,clearTimeout:clearLater,setInterval,clearInterval,fetch:async(url,options)=>{
    if(options?.body)requests.push(JSON.parse(options.body));
    if(fetchResult)return fetchResult(url,options);
    return {ok:true,json:async()=>url.endsWith('/config')?{available:true}:data};
  }};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const submit=()=>get('socialDownloadForm').emit('submit');
  const ready=async()=>{await tick();await tick();};
  const drain=async()=>{for(let step=0;step<150;step++){await new Promise(resolve=>setTimeout(resolve,2));if(previews.length>=12&&!active.size&&!timers.size)return;}throw Error('Preview queue did not finish');};
  return {get,requests,previews,active,submit,complete,drain,peak:()=>peak,window,elements,
    bridgeRequests,storageWrites,emitMessage,saves,saveCancels,ready,setBridge:responder=>{bridgeResponder=responder;}};
}

function extensionResponse(request,overrides={}) {
  return {source:'aidesign-douyin-extension',type:'RESPONSE',requestId:request.requestId,nonce:request.nonce,
    ok:true,version:'1.0.1',connected:true,loggedIn:true,...overrides};
}

function syntheticExtension() {
  let connected=false,sessionNumber=0;
  return request=>{
    if(request.type==='STATUS')return extensionResponse(request,{connected});
    if(request.type==='DISCONNECT'){connected=false;return null;}
    if(request.type==='CONNECT'){connected=true;return extensionResponse(request);}
    if(request.type==='SESSION'){connected=true;return extensionResponse(request,{cookie:'synthetic-session-'+(++sessionNumber),userAgent:'Synthetic Browser',connected});}
  };
}

function assertCredentialsPrivate(state) {
  for(const element of state.elements.values()) {
    assert.doesNotMatch(String(element.value),/synthetic-(?:session|connect)-/);
    assert.doesNotMatch(String(element.textContent),/synthetic-(?:session|connect)-/);
  }
  assert.deepEqual(state.storageWrites,[]);
}

test('12-image album previews never exceed two concurrent transfers',async()=>{
  const state=setup();await state.submit();await state.drain();
  assert.equal(state.previews.length,12);assert.equal(state.peak(),2);
  assert.equal(state.get('socialDownloadStatus').dataset.state,'success');
});

test('preview errors retry with a fresh URL and do not replace a completed ZIP save status',async()=>{
  const attempts=new Map();
  const state=setup({imageResult:url=>{const index=new URL(url).searchParams.get('index');const count=(attempts.get(index)||0)+1;attempts.set(index,count);return index==='0'&&count<3||index==='1'?'error':'load';}});
  await state.submit();await state.get('socialDownloadAll').emit('click');
  await state.drain();
  assert.equal(attempts.get('0'),3);assert.equal(attempts.get('1'),3);assert.equal(state.peak(),2);
  const retries=state.previews.filter(item=>new URL(item.url).searchParams.get('index')==='0');
  assert.equal(new Set(retries.map(item=>item.url)).size,3);
  assert.match(state.get('socialDownloadStatus').textContent,/Đã lưu file/);
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

test('missing extension opens installation help only after an explicit connection attempt',async()=>{
  const state=setup({hold:true});
  assert.equal(state.bridgeRequests[0].message.type,'STATUS');
  assert.notEqual(state.get('socialDownloadInstallHelp').open,true);
  await state.get('socialDownloadConnectDouyin').emit('click');
  assert.equal(state.get('socialDownloadInstallHelp').open,true);
  assert.equal(state.bridgeRequests.at(-1).message.type,'DISCONNECT');
  assert.match(state.get('socialDownloadConnectionStatus').textContent,/Cài tiện ích/);
  assert.equal(state.requests.length,0);
  assertCredentialsPrivate(state);
});

test('connection confirms login without requesting or displaying credentials',async()=>{
  const state=setup({bridge:syntheticExtension(),hold:true});
  await state.get('socialDownloadConnectDouyin').emit('click');
  assert.equal(state.get('socialDownloadConnectionStatus').dataset.state,'success');
  assert.equal(state.get('socialDownloadConnectDouyin').textContent,'✓ Douyin đã kết nối');
  assert.equal(state.get('socialDownloadInstallHelp').open,false);
  assert.deepEqual(state.bridgeRequests.map(item=>item.message.type),['STATUS','CONNECT']);
  assert.equal(state.requests.length,0);
  assertCredentialsPrivate(state);
});

test('an installed extension automatically reads a fresh session on each Douyin submission',async()=>{
  const state=setup({bridge:syntheticExtension(),hold:true});
  await state.ready();
  assert.deepEqual(state.bridgeRequests.map(item=>item.message.type),['STATUS']);
  assert.equal(state.requests.length,0);
  await state.submit();await state.submit();
  assert.equal(state.requests.length,2);
  assert.equal(state.requests[0].douyin_cookie,'synthetic-session-1');
  assert.equal(state.requests[1].douyin_cookie,'synthetic-session-2');
  assert.equal(state.requests[0].douyin_user_agent,'Synthetic Browser');
  assert.equal(state.requests[1].douyin_user_agent,'Synthetic Browser');
  const sessions=state.bridgeRequests.filter(item=>item.message.type==='SESSION');
  assert.equal(sessions.length,2);
  assert.notEqual(sessions[0].message.requestId,sessions[1].message.requestId);
  assert.equal(state.bridgeRequests.filter(item=>item.message.type==='CONNECT').length,0);
  assert.ok(state.bridgeRequests.every(item=>item.targetOrigin==='https://example.test'));
  assertCredentialsPrivate(state);
});

test('a submit during installation detection waits for STATUS and reads one fresh session',async()=>{
  const state=setup({bridge:syntheticExtension(),hold:true});
  await state.submit();
  assert.deepEqual(state.bridgeRequests.map(item=>item.message.type),['STATUS','SESSION']);
  assert.equal(state.requests[0].douyin_cookie,'synthetic-session-1');
  assertCredentialsPrivate(state);
});

test('cancelling while STATUS is pending prevents later session retrieval',async()=>{
  const state=setup({hold:true});
  const request=state.bridgeRequests[0].message;
  const pending=state.submit();
  await state.get('socialDownloadCancel').emit('click');
  await state.emitMessage(extensionResponse(request,{connected:false}));
  await pending;
  assert.equal(state.bridgeRequests.filter(item=>item.message.type==='SESSION').length,0);
  assert.equal(state.requests.length,0);
  assertCredentialsPrivate(state);
});

test('an installed browser session is never read or sent for TikTok',async()=>{
  const state=setup({bridge:syntheticExtension(),hold:true});
  await state.ready();
  state.get('socialDownloadInput').value='https://vt.tiktok.com/demo/';
  await state.submit();
  assert.equal(state.bridgeRequests.filter(item=>item.message.type==='SESSION').length,0);
  assert.equal(Object.hasOwn(state.requests[0],'douyin_cookie'),false);
  assert.equal(Object.hasOwn(state.requests[0],'douyin_user_agent'),false);
  assertCredentialsPrivate(state);
});

test('clear and cancel discard the browser session but allow the next submit without reconnecting',async()=>{
  for(const control of ['socialDownloadClear','socialDownloadCancel']) {
    const state=setup({bridge:syntheticExtension(),hold:true});
    await state.ready();
    await state.submit();
    await state.get(control).emit('click');
    assert.equal(state.bridgeRequests.at(-1).message.type,'DISCONNECT');
    state.get('socialDownloadInput').value='https://www.douyin.com/note/7620805310613466853';
    await state.submit();
    assert.equal(state.bridgeRequests.filter(item=>item.message.type==='SESSION').length,2);
    assert.equal(state.bridgeRequests.filter(item=>item.message.type==='CONNECT').length,0);
    assert.equal(state.requests[1].douyin_cookie,'synthetic-session-2');
    assertCredentialsPrivate(state);
  }
});

test('cancelling a pending session ignores a late credential response',async()=>{
  const state=setup({bridge:syntheticExtension(),hold:true});
  await state.ready();
  state.setBridge(()=>null);
  const pending=state.submit();
  const session=state.bridgeRequests.at(-1).message;
  assert.equal(session.type,'SESSION');
  await state.get('socialDownloadCancel').emit('click');
  await state.emitMessage(extensionResponse(session,{cookie:'synthetic-session-late',userAgent:'Synthetic Browser'}));
  await pending;
  assert.equal(state.requests.length,0);
  assert.equal(state.get('socialDownloadItems').children.length,0);
  assert.equal(state.get('socialDownloadConnectDouyin').textContent,'Kết nối Douyin');
  assertCredentialsPrivate(state);
});

test('cancelling after session retrieval prevents a late server result from rendering',async()=>{
  let respond;
  const state=setup({bridge:syntheticExtension(),hold:true,fetchResult:()=>new Promise(resolve=>{respond=resolve;})});
  await state.ready();
  const pending=state.submit();
  for(let step=0;step<10&&!respond;step++)await tick();
  assert.equal(state.requests.length,1);
  await state.get('socialDownloadCancel').emit('click');
  respond({ok:true,json:async()=>({platform:'douyin',type:'images',items:[{index:0,kind:'image',
    preview_url:'/api/social-download/file?id=fixture&index=0',download_url:'/api/social-download/file?id=fixture&index=0&download=1'}],zip_url:'/api/social-download/zip?id=fixture'})});
  await pending;
  assert.equal(state.get('socialDownloadItems').children.length,0);
  assert.equal(state.get('socialDownloadConnectDouyin').textContent,'Kết nối Douyin');
  assertCredentialsPrivate(state);
});

test('bridge ignores wrong source, origin, request id and nonce before accepting the matching response',async()=>{
  const state=setup({hold:true});
  let settled=false;
  const pending=state.get('socialDownloadConnectDouyin').emit('click').then(()=>{settled=true;});
  const request=state.bridgeRequests.at(-1).message;
  assert.equal(request.type,'CONNECT');
  const response=extensionResponse(request);
  await state.emitMessage(response,{source:{}});
  await state.emitMessage(response,{origin:'https://evil.example'});
  await state.emitMessage({...response,requestId:randomUUID()});
  await state.emitMessage({...response,nonce:randomUUID()});
  await tick();
  assert.equal(settled,false);
  assert.notEqual(state.get('socialDownloadConnectDouyin').textContent,'✓ Douyin đã kết nối');
  await state.emitMessage(response);
  await pending;
  assert.equal(state.get('socialDownloadConnectDouyin').textContent,'✓ Douyin đã kết nối');
  assertCredentialsPrivate(state);
});

test('extension login failure gives login instructions and sends no server request',async()=>{
  const state=setup({hold:true,bridge:request=>request.type==='CONNECT'?extensionResponse(request,
    {ok:false,code:'LOGIN_REQUIRED',error:'Synthetic login required'}):extensionResponse(request,{connected:false})});
  await state.get('socialDownloadConnectDouyin').emit('click');
  assert.match(state.get('socialDownloadConnectionStatus').textContent,/đăng nhập trên Edge/);
  assert.equal(state.get('socialDownloadConnectDouyin').textContent,'Kết nối Douyin');
  assert.equal(state.bridgeRequests.at(-1).message.type,'DISCONNECT');
  assert.equal(state.requests.length,0);
  assertCredentialsPrivate(state);
});

test('a timed-out session disconnects the extension and rejects a late credential response',async()=>{
  const respond=syntheticExtension();
  const state=setup({hold:true,bridge:request=>request.type==='SESSION'?null:respond(request)});
  await state.ready();
  await state.submit();
  const session=state.bridgeRequests.find(item=>item.message.type==='SESSION').message;
  assert.equal(state.bridgeRequests.at(-1).message.type,'DISCONNECT');
  assert.equal(state.get('socialDownloadConnectDouyin').textContent,'Kết nối Douyin');
  assert.equal(state.get('socialDownloadInstallHelp').open,true);
  assert.equal(state.requests.length,0);
  await state.emitMessage(extensionResponse(session,{cookie:'synthetic-session-late',userAgent:'Synthetic Browser'}));
  assert.equal(state.requests.length,0);
  assert.equal(state.get('socialDownloadItems').children.length,0);
  assertCredentialsPrivate(state);
});

test('a failed session disconnects and retries with fresh credentials on the next submit',async()=>{
  const respond=syntheticExtension();
  let sessionCalls=0;
  const state=setup({hold:true,bridge:request=>request.type==='SESSION'&&++sessionCalls===1
    ?extensionResponse(request,{ok:false,code:'FAILED',error:'Synthetic session failure'})
    :respond(request)});
  await state.ready();
  await state.submit();
  assert.equal(state.bridgeRequests.at(-1).message.type,'DISCONNECT');
  assert.equal(state.get('socialDownloadConnectDouyin').textContent,'Kết nối Douyin');
  assert.equal(state.requests.length,0);
  await state.submit();
  assert.equal(state.bridgeRequests.filter(item=>item.message.type==='SESSION').length,2);
  assert.equal(state.bridgeRequests.filter(item=>item.message.type==='CONNECT').length,0);
  assert.equal(state.requests[0].douyin_cookie,'synthetic-session-1');
  assert.equal(state.requests[0].douyin_user_agent,'Synthetic Browser');
  assertCredentialsPrivate(state);
});

test('an image download opens the save helper synchronously with its actual filename',async()=>{
  let finish;
  const state=setup({hold:true,saveResult:()=>new Promise(resolve=>{finish=resolve;})});
  await state.submit();
  const link=state.get('socialDownloadItems').children[0].children[1].children[1];
  const pending=link.emit('click');
  assert.equal(state.saves.length,1);
  assert.equal(state.saves[0].filename,'douyin-7620805310613466853-01.jpg');
  assert.equal(state.saves[0].url,'https://example.test/api/social-download/file?id=demo&index=0&download=1');
  assert.equal(state.saves[0].options.signal.aborted,false);
  assert.equal(state.get('socialDownloadResolve').disabled,true);
  finish({status:'saved',filename:state.saves[0].filename,bytes:16});
  await pending;
  assert.equal(state.get('socialDownloadResolve').disabled,false);
  assert.equal(state.get('socialDownloadStatus').dataset.state,'success');
});

test('a ZIP download chooses the album filename before awaiting the save result',async()=>{
  let finish;
  const state=setup({hold:true,saveResult:()=>new Promise(resolve=>{finish=resolve;})});
  await state.submit();
  const pending=state.get('socialDownloadAll').emit('click');
  assert.equal(state.saves.length,1);
  assert.equal(state.saves[0].filename,'douyin-7620805310613466853-images.zip');
  assert.equal(state.saves[0].url,'https://example.test/api/social-download/zip?id=demo');
  finish({status:'saved',filename:state.saves[0].filename,bytes:16});
  await pending;
  assert.equal(state.get('socialDownloadStatus').dataset.state,'success');
});

test('cancelling an active save aborts its signal and ignores its late completion',async()=>{
  let finish;
  const state=setup({hold:true,saveResult:()=>new Promise(resolve=>{finish=resolve;})});
  await state.submit();
  const pending=state.get('socialDownloadAll').emit('click');
  await state.get('socialDownloadCancel').emit('click');
  assert.equal(state.saves[0].options.signal.aborted,true);
  assert.equal(state.saveCancels.length,1);
  const cancelled=state.get('socialDownloadStatus').textContent;
  finish({status:'saved',filename:state.saves[0].filename,bytes:16});
  await pending;
  assert.equal(state.get('socialDownloadStatus').textContent,cancelled);
  assert.equal(state.get('socialDownloadResolve').disabled,false);
});

test('dismissing a save dialog finishes without reporting a saved file',async()=>{
  const state=setup({hold:true,saveResult:async()=>({status:'cancelled'})});
  await state.submit();
  await state.get('socialDownloadAll').emit('click');
  assert.notEqual(state.get('socialDownloadStatus').dataset.state,'success');
  assert.match(state.get('socialDownloadStatus').textContent,/huỷ|hủy/i);
  assert.equal(state.get('socialDownloadResolve').disabled,false);
});

test('the global download action invokes the same save helper synchronously',async()=>{
  let finish;
  const state=setup({hold:true,saveResult:()=>new Promise(resolve=>{finish=resolve;})});
  await state.submit();
  const pending=state.window.downloadSocialAll();
  assert.equal(state.saves.length,1);
  assert.equal(state.saves[0].filename,'douyin-7620805310613466853-images.zip');
  finish({status:'saved',filename:state.saves[0].filename,bytes:16});
  await pending;
  assert.equal(state.get('socialDownloadStatus').dataset.state,'success');
});

test('a missing save helper reports an error without starting a native download',async()=>{
  const state=setup({hold:true});
  await state.submit();
  delete state.window.saveSocialDownload;
  await state.get('socialDownloadAll').emit('click');
  assert.equal(state.saves.length,0);
  assert.equal(state.get('socialDownloadStatus').dataset.state,'error');
  assert.match(state.get('socialDownloadStatus').textContent,/chọn nơi lưu/i);
});
