const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/roundup.js'),'utf8');
const start=source.indexOf('function zip(files)'),end=source.indexOf("$('zip').onclick",start);
const zip=vm.runInNewContext(source.slice(start,end)+';zip',{TextEncoder,Blob,Uint8Array,DataView});
(async()=>{const b=Buffer.from(await zip([{name:'caption.txt',data:new TextEncoder().encode('Áo đôi Rieng.vn')}]).arrayBuffer());assert.equal(b.readUInt32LE(0),0x04034b50);assert.equal(b.readUInt32LE(b.length-22),0x06054b50);fs.writeFileSync('/tmp/roundup-zip-test.zip',b);console.log('ZIP records passed');})();

const {test}=require('node:test');
const path=require('node:path');
function downloadAdapter(filename,window={}){
  const script=fs.readFileSync(path.join(__dirname,'../public',filename),'utf8');
  const match=/async function download\(blobOrFactory,name\)\{[\s\S]*?\n\s*\}/.exec(script);
  assert.ok(match,'Download adapter exists in '+filename);
  const links=[],urls=[],timers=[];
  const document={body:{append(link){link.appended=true;}},createElement(type){
    assert.equal(type,'a');
    const link={attributes:{},setAttribute(key,value){this.attributes[key]=value;},
      click(){this.clicked=(this.clicked||0)+1;},remove(){this.removed=true;}};
    links.push(link);return link;
  }};
  const urlAPI={createObjectURL(blob){urls.push({blob,revoked:false});return 'blob:synthetic-export';},
    revokeObjectURL(url){assert.equal(url,'blob:synthetic-export');urls.at(-1).revoked=true;}};
  const download=vm.runInNewContext(match[0]+';download',{window,document,URL:urlAPI,setTimeout:fn=>timers.push(fn)});
  return {download,links,urls,timers};
}
for(const filename of ['roundup.js','roundup-review.js','chat-content.js','studio-assistant.js']){
  test(filename+' delegates one unprocessed factory and awaits the shared browser queue',async()=>{
    let calls=0,produced=0,resolve,received;
    const queued=new Promise(done=>{resolve=done;});
    const factory=async()=>{produced++;return new Blob(['synthetic-export']);};
    const state=downloadAdapter(filename,{saveToolFile(input,name){calls++;received={input,name};return queued;}});
    let finished=false;
    const operation=state.download(factory,'export.png').then(result=>{finished=true;return result;});
    await Promise.resolve();
    assert.equal(calls,1);assert.equal(produced,0);assert.equal(finished,false);
    assert.equal(received.input,factory);assert.equal(received.name,'export.png');
    assert.equal(state.links.length,0);assert.equal(state.urls.length,0);
    await received.input();assert.equal(produced,1);
    resolve('ready');assert.equal(await operation,'ready');
    assert.equal(state.links.length,0,'Delegation does not issue a duplicate anchor download');
  });
  test(filename+' falls back to one native anchor without base64 or picker APIs',async()=>{
    let produced=0;
    const blob=new Blob(['synthetic-export']);
    const state=downloadAdapter(filename);
    assert.equal(await state.download(async()=>{produced++;return blob;},'export.zip'),'downloaded');
    assert.equal(produced,1);assert.equal(state.links.length,1);
    assert.equal(state.urls[0].blob,blob);
    const link=state.links[0];
    assert.equal(link.download,'export.zip');assert.equal(link.clicked,1);
    assert.equal(link.attributes['data-native-download'],'');
    assert.equal(link.appended,true);assert.equal(link.removed,true);
    assert.equal(state.timers.length,1);state.timers[0]();assert.equal(state.urls[0].revoked,true);
  });
}

function reviewDownloadHarness(result){
  const elements=Object.fromEntries(['download-all','download-status','grid','status','caption'].map(id=>[id,{textContent:'',disabled:false}]));
  let release,prepared;
  const ready=new Promise(resolve=>{release=resolve;});
  const context=vm.createContext({URL,URLSearchParams,TextEncoder,Blob,Uint8Array,DataView,
    location:{origin:'https://riengvnapp.cloud',search:'?id=synthetic-job'},
    document:{querySelector:selector=>elements[selector.slice(1)]},
    window:{async saveToolFile(factory,name){prepared={blob:await factory(),name};return ready;}},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/roundup-review.js'),'utf8'),context);
  vm.runInContext("reviewJob={total:1,items:[{index:0,image:'/api/roundup/result'}]};imageBytes=async()=>new Uint8Array([1,2,3]);",context);
  return {elements,get prepared(){return prepared;},finish(){release(result);}};
}
test('standalone review ZIP reports browser handoff only after the shared download resolves',async()=>{
  const state=reviewDownloadHarness('downloaded');
  const operation=state.elements['download-all'].onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.prepared.blob.type,'application/zip');
  assert.equal(state.elements['download-all'].disabled,true);
  assert.doesNotMatch(state.elements['download-status'].textContent,/Đã gửi|Đã tải/);
  state.finish();await operation;
  assert.match(state.elements['download-status'].textContent,/Đã gửi ZIP gồm 1 ảnh/);
  assert.equal(state.elements['download-all'].disabled,false);
});
test('standalone review individual image preserves a ready result without claiming completion',async()=>{
  const state=reviewDownloadHarness('ready');
  const button={dataset:{download:'0'},disabled:false};
  const operation=state.elements.grid.onclick({target:{closest:()=>button}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.prepared.blob.type,'image/png');
  assert.equal(button.disabled,true);
  assert.doesNotMatch(state.elements['download-status'].textContent,/Đã gửi|Đã tải/);
  state.finish();await operation;
  assert.match(state.elements['download-status'].textContent,/đã sẵn sàng/);
  assert.doesNotMatch(state.elements['download-status'].textContent,/Đã gửi|Đã tải/);
  assert.equal(button.disabled,false);
});
for(const [filename,mainScript] of [['reference-studio.html','single-image.js'],['roundup-review.html','roundup-review.js']]){
  test(filename+' loads the shared browser download manager before its export controls',()=>{
    const html=fs.readFileSync(path.join(__dirname,'../public',filename),'utf8');
    const manager='<script src="/download-manager.js?v=20261011-browser-downloads"></script>';
    assert.equal(html.split(manager).length-1,1);
    assert.ok(html.indexOf(manager)<html.indexOf('<script src="/'+mainScript));
  });
}
