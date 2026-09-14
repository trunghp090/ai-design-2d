const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const source=require('node:fs').readFileSync('public/app.js','utf8');
test('Clone label reflects its dedicated backend model instead of the global default',()=>{
 const els={mode:{value:'cloner',addEventListener(){}},cloneModelStatus:{},clonePromptModel:{}};
 const c={$:id=>els[id],cloneModelConfig:{model:'gpt-image-2',clone_image_model:'gpt-image-2.5-sunburst',clone_image_quality:'high'}};
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function cloneModelLabel('),source.indexOf('fetch("/api/status").then(r => {')),c);
 c.updateCloneModelStatus();assert.match(els.cloneModelStatus.textContent,/GPT Image 2\.5 Sunburst · high/);
 c.cloneModelConfig.clone_image_model='custom-model';c.updateCloneModelStatus();assert.match(els.cloneModelStatus.textContent,/custom-model/);
 els.mode.value='extract';c.updateCloneModelStatus();assert.equal(els.cloneModelStatus.textContent,'Tách gốc · không qua AI');
});
test('Clone correction preserves the original requested name change, even after editing the form',async()=>{
 const els={cloneCheckBtn:{textContent:'Đối chiếu'},cloneCheckNote:{},size:{value:'portrait'},promptInput:{value:'Nội dung đã sửa sau khi tạo'}};
 let sent;
 const c={$:id=>els[id],lastCloneSource:'data:image/png;base64,original',currentDesign:'result',
  lastCloneRequest:{user_prompt:'đổi tên thành NHUNG HỒNG, giữ nguyên font chữ'},
  fetch:async(url,options)=>{sent={url,...JSON.parse(options.body)};return{ok:true,json:async()=>({image:'fixed',differences:[]})};},
  showDesign(){},loadGallery(){}};
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('// AI đối chiếu mẫu gốc vs kết quả'),source.indexOf('/* ---------- chèn chữ sắc nét')),c);
 await els.cloneCheckBtn.onclick();
 assert.equal(sent.url,'/api/clone-check');
 assert.equal(sent.user_prompt,'đổi tên thành NHUNG HỒNG, giữ nguyên font chữ');
 assert.equal(sent.original,'data:image/png;base64,original');
 assert.equal(els.cloneCheckBtn.disabled,false);
});
