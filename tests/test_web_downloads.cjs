const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/download-manager.js','utf8');
function setup(picker){
 const events=[];
 class Anchor{click(){events.push('download');}hasAttribute(){return true;}remove(){}}
 const document={createElement:tag=>tag==='a'?new Anchor():{style:{},append(){}},body:{append(){},appendChild(){}},addEventListener(){}};
 const ctx={window:{showSaveFilePicker:picker},document,HTMLAnchorElement:Anchor,location:{protocol:'https:',hostname:'riengvnapp.cloud'},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout(){},fetch(){throw Error('Must not use local-only API online');},Error};
 vm.createContext(ctx);vm.runInContext(source,ctx);return {ctx,events};
}
test('online save writes the chosen file without the macOS API',async()=>{
 const events=[];const {ctx}=setup(async()=>({createWritable:async()=>({write:async blob=>events.push(blob),close:async()=>events.push('closed')})}));
 assert.equal(await ctx.window.saveToolFile('image-data','image.png'),'saved');assert.deepEqual(events,['image-data','closed']);
});
test('online save supports browsers without a file picker',async()=>{
 const {ctx,events}=setup();assert.equal(await ctx.window.saveToolFile('blob','image.png'),'saved');assert.deepEqual(events,['download']);
});
test('cancelling online file picker does not trigger fallback downloads',async()=>{
 const {ctx,events}=setup(async()=>{throw Object.assign(Error(),{name:'AbortError'});});assert.equal(await ctx.window.saveToolFile('blob','image.png'),'cancelled');assert.deepEqual(events,[]);
});
