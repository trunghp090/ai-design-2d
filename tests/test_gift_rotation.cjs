const {test}=require('node:test');const assert=require('node:assert/strict');
const {chooseGiftRotation}=require('../public/gift-rotation.js');
const rows=Array.from({length:12},(_,i)=>({key:String(i),productType:'type'+(i%4),brand:'brand'+i}));
test('avoids all previous products when four different types are available',()=>{
 const old=['0','1','2','3'];const next=chooseGiftRotation(rows,[old],old);
 assert.equal(next.length,4);assert.equal(new Set(next.map(g=>g.productType)).size,4);assert.ok(next.every(g=>!old.includes(g.key)));
});
test('exhausts unused products before repeating older products',()=>{
 let history=[],current=[];for(let i=0;i<3;i++){const batch=chooseGiftRotation(rows,history,current).map(g=>g.key);history.push(batch);current=batch;}
 assert.equal(new Set(history.flat()).size,12);
});
test('limited catalog stays within filters without inventing gifts',()=>{
 const small=rows.slice(0,4);const next=chooseGiftRotation(small,[small.map(g=>g.key)],small.map(g=>g.key));assert.equal(next.length,4);assert.ok(next.every(g=>small.includes(g)));
});
