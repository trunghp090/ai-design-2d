const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('public/photo-studio.js','utf8');
const init=source.slice(source.indexOf('async function init(){'),source.indexOf('\ninit();return'));
const catalog=JSON.parse(fs.readFileSync('resource-seed/photo-studio/catalog.json','utf8'));
function setup(api){
 const elements={};let renderCount=0;
 const c={api,initializing:false,initialized:false,catalog:null,concept:'',mode:'flatlay',wear:false,files:{},draftReady:false,requestId:'',draftKey:'test',
  escape:x=>x,el:id=>elements[id]??={value:'',textContent:'',hidden:false},button(){},concepts(){renderCount++;},history:async()=>{},note(){},
  db:Promise.resolve({transaction:()=>({objectStore:()=>({get:()=>{const r={result:undefined};queueMicrotask(()=>r.onsuccess());return r;}})})})};
 vm.createContext(c);vm.runInContext(init,c);return {c,elements,renders:()=>renderCount};
}
test('failed catalog can retry in the same studio and restores all concepts and shots',async()=>{
 let calls=0;const {c,elements,renders}=setup(async()=>{if(++calls===1)throw Error('Bad gateway');return catalog;});
 await c.init();assert.equal(c.initialized,false);assert.equal(c.initializing,false);assert.equal(elements['catalog-retry'].hidden,false);
 await c.init();assert.equal(c.initialized,true);assert.equal(elements['catalog-retry'].hidden,true);assert.match(elements['catalog-status'].textContent,/45 concept · 5 góc/);assert.ok(renders()>0);
 await c.init();assert.equal(calls,2);
});
test('concurrent opens share one initialization and malformed catalog remains retryable',async()=>{
 let release,calls=0;const {c,elements}=setup(()=>{calls++;return new Promise(r=>release=r);});
 const pending=c.init();await c.init();assert.equal(calls,1);release({concepts:[]});await pending;
 assert.equal(c.initialized,false);assert.equal(elements['catalog-retry'].hidden,false);
});
test('all catalog concepts and five shot reference images exist',()=>{
 for(const concept of catalog.concepts)for(const shot of catalog.shots){
  const suffix=shot.id==='hero'?'':'-'+shot.id;
  assert.ok(fs.existsSync('public/flatlay-concepts/'+concept.id+suffix+'.webp'),concept.id+suffix);
 }
});
