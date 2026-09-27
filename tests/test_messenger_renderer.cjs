const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {render}=require('../public/messenger-renderer.js');
function canvas(){const calls=[];const c=new Proxy({measureText:t=>({width:[...t].length*23})},{get:(o,k)=>k in o?o[k]:(...args)=>calls.push([k,...args]),set:(o,k,v)=>(o[k]=v,true)});return {getContext:()=>c,calls};}
const state={ratio:'portrait',font:46,theme:'messenger',name:'Em',trim:true};
const text=(side,t)=>({side,kind:'text',text:t,images:[]});
test('consecutive incoming messages group tightly; speaker changes add space',()=>{
 const ms=[text('in','Ủa'),text('in','hai đứa mình nè'),text('out','Bất ngờ chưa?')];
 const r=render(canvas(),state,{messages:ms},[[],[],[]]);
 assert.equal(r.boxes[1].y-r.boxes[0].y-r.boxes[0].height,6);
 assert.equal(r.boxes[2].y-r.boxes[1].y-r.boxes[1].height,24);
 assert.equal(r.overflow,false);
});
test('single portrait image preserves aspect and new-message separator creates space',()=>{
 const ms=[{kind:'image',side:'out'}, {...text('in','Đáng yêu thế'),divider:true}];
 const r=render(canvas(),state,{messages:ms},[[{width:3000,height:4000}],[]]);
 assert.ok(Math.abs(r.boxes[0].width/r.boxes[0].height-.75)<.001);
 assert.equal(r.boxes[1].y-r.boxes[0].y-r.boxes[0].height,98);
});
test('overflow blocks export instead of silently clipping long conversations',()=>{
 const ms=Array.from({length:20},(_,i)=>text(i%2?'in':'out','Một tin nhắn dài cần đọc đầy đủ. '.repeat(5)));
 const r=render(canvas(),state,{messages:ms},ms.map(()=>[]));assert.equal(r.overflow,true);assert.equal(r.height,1920);
});
test('cover contains the entire image unless fill frame is explicitly requested',()=>{
 const c=canvas();render(c,state,{messages:[{kind:'cover'}],imageFit:'contain'},[[{width:2000,height:1000}]]);
 const args=c.calls.find(x=>x[0]==='drawImage');assert.equal(args.length,6);assert.equal(args[4],1080);assert.equal(args[5],540);
});
test('focus mode reserves space for toolbar and menu without overflowing',()=>{
 const c=canvas(),r=render(c,{...state,trim:false},{focus:true,overlay:'Muốn làm bạn thời thơ ấu của anh',messages:[text('out','Gửi em một tấm ảnh hồi bé của anh iii 🥹')]},[[]]);
 assert.equal(r.overflow,false);assert.equal(r.height,1920);assert.ok(c.calls.some(x=>x[0]==='fillText'&&x[1].includes('Trả lời')));
});
test('story templates never reveal product image on opening hook',()=>{
 const scope={window:{}};vm.runInNewContext(fs.readFileSync('public/zalo-scripts.js','utf8'),scope);
 assert.equal(scope.window.ZALO_SCRIPTS.length,22);
 for(const t of scope.window.ZALO_SCRIPTS){assert.equal(t.project.templateId,t.id);assert.equal(t.project.theme,'messenger');assert.ok(t.project.slides[0].messages.every(m=>m.kind==='text'));}
 const lion=scope.window.ZALO_SCRIPTS.find(t=>t.id==='su-tu-cai');assert.ok(lion.project.slides[1].messages.some(m=>m.text.includes('sư tử cái')));
});
