const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/roundup.js'),'utf8');
const start=source.indexOf('function zip(files)'),end=source.indexOf("$('zip').onclick",start);
const zip=vm.runInNewContext(source.slice(start,end)+';zip',{TextEncoder,Blob,Uint8Array,DataView});
(async()=>{const b=Buffer.from(await zip([{name:'caption.txt',data:new TextEncoder().encode('Áo đôi Rieng.vn')}]).arrayBuffer());assert.equal(b.readUInt32LE(0),0x04034b50);assert.equal(b.readUInt32LE(b.length-22),0x06054b50);fs.writeFileSync('/tmp/roundup-zip-test.zip',b);console.log('ZIP records passed');})();
