const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const s=require('node:fs').readFileSync('public/app.js','utf8');
const code=s.slice(s.indexOf('let ttDeleting = false;'),s.indexOf('function ttInit()'));
function setup(confirmed=true){
 const els={}; const c={ttItems:[{gallery:{id:'ok'}},{gallery:{id:'fail'}}],confirm:()=>confirmed,ttUpdateSel(){},ttRender(){},$:id=>els[id]||=( {} ),fetch:async url=>({ok:!url.includes('fail'),json:async()=>({ok:true})}),els};vm.createContext(c);vm.runInContext(code,c);return c;
}
test('delete removes successful targets and preserves failed and unselected images',async()=>{
 const c=setup();const keep={title:'keep'};c.ttItems.push(keep);await c.ttDeleteImages(c.ttItems.slice(0,2));assert.equal(c.ttItems.length,2);assert.equal(c.ttItems[0].gallery.id,'fail');assert.equal(c.ttItems[1],keep);assert.match(c.els.ttNote.textContent,/Còn 1 ảnh/);
});
test('cancel preserves all images',async()=>{const c=setup(false);await c.ttDeleteImages(c.ttItems);assert.equal(c.ttItems.length,2);});
