const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const s=fs.readFileSync('public/app.js','utf8');
const helper=s.slice(s.indexOf('function pastedDesignFiles'),s.indexOf('// gắn CHUỘT PHẢI'));
const mockup=s.slice(s.indexOf('async function mkPasteDesign'),s.indexOf('function mkRenderComponents'));
const shirt=s.slice(s.indexOf('async function lenaoPasteFiles'),s.indexOf('function lenaoApplyLayer'));
function setup(){
 const events=[],calls=[],els={};
 const ctx={navigator:{},currentSide:'front',lenaoPasteTarget:null,lenaoPasteBound:false,
 $:id=>els[id] ||= {classList:{contains:()=>false}},stage:{addEventListener(){}},document:{addEventListener:(type,cb)=>events.push(cb)},
 mkUploadComponents:async(files,side)=>calls.push({files,side}),lenaoUploadLayers:async(files,slot)=>calls.push({files,slot}),lenaoSetPasteTarget:slot=>ctx.lenaoPasteTarget=slot};
 vm.createContext(ctx);vm.runInContext(helper+mockup+shirt,ctx);ctx.lenaoBindPaste();
 return {ctx,events,calls,els};
}
function event(files){return {target:{},clipboardData:{items:files.map(file=>({type:file.type,getAsFile:()=>file}))},preventDefault(){this.defaultPrevented=true;}};}
test('mockup keyboard paste keeps all image files and the current side',async()=>{
 const {ctx,events,calls}=setup();ctx.currentSide='back';const e=event([{type:'image/png'},{type:'image/webp'}]);await events[0](e);assert.equal(calls[0].side,'back');assert.equal(calls[0].files.length,2);assert.equal(e.defaultPrevented,true);
});
test('mockup clipboard button freezes side while permission is pending',async()=>{
 const {ctx,calls}=setup();let release;ctx.navigator.clipboard={read:()=>new Promise(r=>release=r)};
 const pending=ctx.mkPasteDesign();ctx.currentSide='back';release([{types:['image/png'],getType:async()=>({type:'image/png'})}]);await pending;assert.equal(calls[0].side,'front');
});
test('Lên áo defaults to all and can target one shirt',async()=>{
 const {ctx,events,calls}=setup();await events[1](event([{type:'image/png'}]));assert.equal(calls[0].slot,null);
 const slot={name:'shirt'};ctx.lenaoPasteTarget=slot;await events[1](event([{type:'image/png'}]));assert.equal(calls[1].slot,slot);
});
test('paste does not interfere with text editing, hidden views or an already handled event',async()=>{
 const {events,calls,els,ctx}=setup();for(const cb of events){let e=event([{type:'image/png'}]);e.target.isContentEditable=true;await cb(e);e=event([{type:'image/png'}]);e.defaultPrevented=true;await cb(e);}
 ctx.$('rpane-mockup').classList.contains=()=>true;await events[0](event([{type:'image/png'}]));ctx.$('view-lenao').classList.contains=()=>true;await events[1](event([{type:'image/png'}]));assert.equal(calls.length,0);
});
test('clipboard unavailable leaves keyboard fallback and selects all-shirts mode',async()=>{
 const {ctx,els}=setup();ctx.lenaoPasteTarget={};await ctx.$('lenaoPasteAll').onclick();assert.equal(ctx.lenaoPasteTarget,null);assert.match(els.lenaoNote.textContent,/Ctrl\/Cmd\+V/);
});
