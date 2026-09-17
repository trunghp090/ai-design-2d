const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync('public/single-image.js','utf8');
function setup(){
 const elements={},requests=[];let finish;
 const ctx={busy:false,resultJob:{id:'original',can_regenerate:true},retryId:null,files:{},$:id=>elements[id]||(elements[id]={}),crypto:{randomUUID:()=> 'retry-id'},status(){},lock(value){ctx.busy=value;},sessionStorage:{setItem(){}},poll:async()=>{},api:async(action,body)=>{requests.push({action,body});return new Promise(resolve=>{finish=resolve;});}};
 vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf("$('regenerate').onclick"),src.lastIndexOf('(async()=>')),ctx);
 return {ctx,requests,click:()=>ctx.$('regenerate').onclick(),finish:()=>finish({id:'new'})};
}
test('retry uses displayed job after reload and blocks duplicate clicks',async()=>{
 const {ctx,requests,click,finish}=setup();const first=click();await click();
 assert.equal(requests.length,1);assert.equal(requests[0].action,'single-regenerate');assert.equal(requests[0].body.source_id,'original');
 assert.equal(ctx.busy,true);finish();await first;
});
test('uncertain request reuses the same id when retried',async()=>{
 const {ctx,click}=setup();let calls=[];
 ctx.api=async(action,body)=>{calls.push(body.request_id);throw Error('offline');};
 await click();await click();assert.deepEqual(calls,['retry-id','retry-id']);assert.equal(ctx.busy,false);
});
test('legacy image without inputs reports the limitation without generating',async()=>{
 const {ctx,requests,click}=setup();ctx.resultJob.can_regenerate=false;let message='';ctx.status=text=>message=text;
 await click();assert.equal(requests.length,0);assert.match(message,/Ảnh cũ/);
});
