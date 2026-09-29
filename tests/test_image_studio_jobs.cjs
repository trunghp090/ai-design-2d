const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/image-studio.js','utf8');
const tracking = source.slice(source.indexOf('  const jobs ='),source.indexOf('  window.initImageStudio'));
function setup(api, stored = {}) {
  const element = () => ({value:'',textContent:'',disabled:false,append(){},replaceChildren(){}});
  const elements = Object.fromEntries(['jobs','run','status','engine','prompt','aspect','count'].map(k=>[k,element()]));
  Object.assign(elements.engine,{value:'gemini_pro'}); elements.prompt.value='First prompt'; elements.aspect.value='1:1'; elements.count.value='1';
  const storage = new Map(Object.entries(stored));
  const c = {api,submitting:false,creations:[],refs:['reference-one'],el:id=>elements[id],document:{createElement:element},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    note:t=>elements.status.textContent=t,render(){},history:async()=>{},AbortSignal,setTimeout};
  vm.createContext(c); vm.runInContext(tracking+'\nthis.jobMap=jobs; this.pollingSet=polling;',c);
  return {c,elements,storage};
}
const event = {preventDefault(){}};
const tick = () => new Promise(resolve=>setImmediate(resolve));
test('two jobs can be submitted before either finishes; each snapshots inputs and completes independently',async()=>{
  const pending = new Map(), sent=[];
  const {c,elements,storage}=setup(async(url,options)=>{
    if(options?.method==='POST'){sent.push(JSON.parse(options.body));return {job_id:'job'+sent.length};}
    return new Promise(resolve=>pending.set(url.split('=')[1],resolve));
  });
  await c.submitGeneration(event);
  assert.equal(elements.run.disabled,false); assert.equal(c.pollingSet.size,1);
  elements.prompt.value='Second prompt'; c.refs.push('reference-two');
  await c.submitGeneration(event);
  assert.equal(elements.run.disabled,false); assert.equal(c.pollingSet.size,2);
  assert.equal(sent[0].prompt,'First prompt'); assert.deepEqual(sent[0].images,['reference-one']);
  assert.equal(sent[1].prompt,'Second prompt'); assert.equal(sent[1].images.length,2);
  assert.equal(JSON.parse(storage.get('image-studio-jobs')).length,2);
  pending.get('job2')({finished:true,total:1,items:[{gallery:{id:'second'},url:'/second.png'}]}); await tick();
  assert.equal(c.jobMap.get('job1').finished,false); assert.equal(c.jobMap.get('job2').finished,true);
  assert.equal(JSON.parse(storage.get('image-studio-jobs'))[0].id,'job1');
  pending.get('job1')({finished:true,total:1,items:[{gallery:{id:'first'},url:'/first.png'}]}); await tick();
  assert.equal(c.creations.length,2); assert.equal(c.pollingSet.size,0); assert.deepEqual(JSON.parse(storage.get('image-studio-jobs')),[]);
});
test('reload restores every pending job; one missing job does not remove another paused job',async()=>{
  const {c,storage}=setup(async url=>{
    if(url.endsWith('missing')) throw Object.assign(new Error('Missing'),{status:404});
    throw Object.assign(new Error('Timeout'),{name:'TimeoutError'});
  },{'image-studio-jobs':JSON.stringify([{id:'missing',label:'Lượt 1'},{id:'slow',label:'Lượt 2'}])});
  c.restoreJobs(); await tick();
  assert.equal(c.jobMap.get('missing').finished,true); assert.equal(c.jobMap.get('slow').paused,true);
  assert.deepEqual(JSON.parse(storage.get('image-studio-jobs')).map(j=>j.id),['slow']);
  c.api=async()=>({finished:true,total:1,items:[],errors:['Provider error']});
  await c.poll('slow'); assert.equal(c.jobMap.get('slow').finished,true); assert.match(c.jobMap.get('slow').status,/Provider error/);
});
test('submission failure unlocks the button without losing other active jobs; legacy job resumes',async()=>{
  const {c,elements,storage}=setup(async(url,options)=>{
    if(options?.method==='POST') throw new Error('Request failed');
    return new Promise(()=>{});
  },{'image-studio-job':'legacy'});
  c.restoreJobs(); await c.submitGeneration(event);
  assert.equal(elements.run.disabled,false); assert.equal(c.jobMap.has('legacy'),true);
  assert.equal(storage.has('image-studio-job'),false); assert.equal(JSON.parse(storage.get('image-studio-jobs'))[0].id,'legacy');
});
test('regenerate uses selected image and original settings, never the current form or references',async()=>{
 let sent,loaded;
 const {c,elements}=setup(async(url,options)=>{
  if(options?.method==='POST'){sent=JSON.parse(options.body);return {job_id:'regen'};}
  return {finished:true,total:1,items:[]};
 });
 c.regenerating=new Set();c.fetch=async src=>{loaded=src;return {ok:true,blob:async()=>({type:'image/png',size:20})};};
 c.FileReader=class {readAsDataURL(){this.result='data:image/png;base64,c291cmNl';this.onload();}};
 const button={disabled:false,textContent:''};
 await c.regenerateImage({prompt:'Original prompt',generation:{engine:'gemini_pro',aspect:'3:4'}},'/gallery/source.png',button);
 assert.equal(loaded,'/gallery/source.png');assert.deepEqual(sent,{prompt:'Original prompt',engine:'gemini_pro',aspect:'3:4',count:1,images:['data:image/png;base64,c291cmNl']});
 assert.equal(elements.prompt.value,'First prompt');assert.deepEqual(c.refs,['reference-one']);assert.equal(button.disabled,false);
});
test('failed source download does not submit a generation and reenables regenerate',async()=>{
 let calls=0;const {c}=setup(async()=>{calls++;});c.regenerating=new Set();c.fetch=async()=>({ok:false});
 const button={disabled:false,textContent:''};
 await c.regenerateImage({prompt:'Original',generation:{engine:'gemini_pro'}},'/missing.png',button);
 assert.equal(calls,0);assert.equal(button.disabled,false);assert.equal(c.regenerating.size,0);
});
