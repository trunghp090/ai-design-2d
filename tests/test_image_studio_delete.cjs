const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/image-studio.js','utf8');
const code=source.slice(source.indexOf('  async function deleteImages'),source.indexOf('  function render()'));
function setup(confirm,api){const c={window:{confirm:()=>confirm},api,selected:new Set(['a','b']),deleted:new Set(),creations:[{id:'a'},{id:'b'}],note(){},render(){}};vm.createContext(c);vm.runInContext(code,c);return c;}
test('cancel preserves every image and sends no delete request',async()=>{let calls=0;const c=setup(false,async()=>calls++);await c.deleteImages(['a']);assert.equal(calls,0);assert.equal(c.creations.length,2);});
test('partial delete keeps failed image selected and removes only confirmed successes',async()=>{const c=setup(true,async url=>{if(url.endsWith('b'))throw Error('Failed');});await c.deleteImages(['a','b']);assert.deepEqual(Array.from(c.creations,x=>x.id),['b']);assert.deepEqual([...c.selected],['b']);assert.deepEqual([...c.deleted],['a']);});
