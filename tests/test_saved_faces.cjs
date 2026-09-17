const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const src=fs.readFileSync('public/single-image.js','utf8');
function setup(slot='kol',fail=false){
 const elements={},requests=[],files={};
 const $=id=>elements[id]||(elements[id]={value:'none',textContent:'',parentElement:{}});
 const input={dataset:{file:slot},files:[{}]};
 const ctx={$,files,document:{querySelectorAll:()=>[input],querySelector:()=>null},upload:async()=> 'data:image/png;base64,face',lock(){},changed(){},updateKol(){},status(){},api:async(action,body)=>{requests.push({action,body});if(fail)throw Error('offline');return {};}};
 vm.createContext(ctx);
 vm.runInContext(src.slice(src.indexOf("document.querySelectorAll('[data-file]')"),src.indexOf("document.querySelectorAll('[data-accessory]')")),ctx);
 return {ctx,$,files,requests,input};
}
for(const slot of ['kol','kol_male','kol_female'])test('upload automatically saves '+slot,async()=>{
 const {input,files,requests,$}=setup(slot);await input.onchange();
 assert.equal(requests.length,1);assert.equal(requests[0].action,'single-faces');
 assert.equal(requests[0].body.slot,slot);assert.equal(requests[0].body.image,files[slot]);
 assert.match($('face-save-note').textContent,/Đã lưu/);
});
test('shirt uploads do not enter face storage',async()=>{const {input,requests}=setup('shirt_male');await input.onchange();assert.equal(requests.length,0);});
test('failed autosave keeps uploaded face usable and reports failure',async()=>{const {input,files,$}=setup('kol',true);await input.onchange();assert.ok(files.kol);assert.match($('face-save-note').textContent,/Chưa lưu/);});
test('reopening restores saved face slots and couple selection',async()=>{
 const {ctx,files,$}=setup();ctx.api=async action=>action==='single-faces'?{files:{kol_male:'male',kol_female:'female'},kol:'couple'}:{jobs:[]};
 const start=src.lastIndexOf('(async()=>');
 await vm.runInContext(src.slice(start,src.lastIndexOf('\n})();')),ctx);
 assert.equal(files.kol_male,'male');assert.equal(files.kol_female,'female');
 assert.equal($('kol').value,'couple');assert.equal($('preview-kol_male').src,'male');
 assert.match($('face-save-note').textContent,/khôi phục/);
});
