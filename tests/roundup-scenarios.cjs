const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('public/roundup.js','utf8');
const fn=src.slice(src.indexOf('function slides(){'),src.indexOf('function scenarioView(){'));
for(const [scenario,expected] of Object.entries({flatlay:['flatlay','flatlay','flatlay'],mixed:['couple','couple','flatlay','solo','flatlay'],people:['couple','couple','solo']})){
 test('preview matches '+scenario+' generation order',()=>{
  const context={state:{scenario,cover:true,paired:true,products:[{scene:'mannequin',label:'A'},{scene:'solo',label:'B'}]}};vm.createContext(context);vm.runInContext(fn,context);
  assert.deepEqual(Array.from(vm.runInContext('slides().map(s=>s.scene)',context)),expected);
 });
}
