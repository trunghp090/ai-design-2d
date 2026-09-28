const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/chat-content.js','utf8');
const helpers=source.slice(source.indexOf('  const parts='),source.indexOf('  function partEditor'));
const validation=source.slice(source.indexOf('  function validate(d)'),source.indexOf("  $('open').onclick"));
const api=vm.runInNewContext(`(()=>{${helpers}${validation};return {flatten,validate};})()`);
const text={kind:'text',side:'out',time:'20:01',text:'Xin chào\n🎁',images:[],divider:true,heart:true};
const project=m=>({version:1,name:'Em',ratio:'portrait',font:46,header:false,avatar:'',slides:[{messages:[m]}]});
test('nested attachments inherit sender and preserve order with one divider and reaction',()=>{
 const m={...text,components:[{kind:'file',text:'',images:[],fileName:'áo.pdf',fileSize:123},{kind:'text',text:'Em xem nhé',images:[]}]};
 const rows=api.flatten([m]);assert.deepEqual(Array.from(rows,r=>r.kind),['text','file','text']);assert.ok(rows.every(r=>r.side==='out'));assert.equal(rows[1].divider,false);assert.equal(rows[0].heart,false);assert.equal(rows[2].heart,true);assert.equal(m.components.length,2);assert.equal(api.validate(project(m)).slides[0].messages.length,1);
});
test('saved nested components reject malformed images and nested covers',()=>{
 assert.throws(()=>api.validate(project({...text,components:[{kind:'image',text:'',images:['https://invalid']}]})));
 assert.throws(()=>api.validate(project({...text,components:[{kind:'cover',text:'',images:[]}]})));
});
test('legacy projects still open without converting text or line breaks',()=>{assert.equal(api.validate(project(text)).slides[0].messages[0].text,'Xin chào\n🎁');});
