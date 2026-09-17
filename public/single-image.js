(()=>{
const $=id=>document.getElementById(id),files={};let busy=false,requestId=null,timer,resultJob=null,retryId=null;
const assets=[['zip','Túi zip','rieng-zip.png'],['box','Hộp','kraft-box.png'],['tag','Tag cảm ơn','rieng-tag.png']];
$('packaging').innerHTML=assets.map(([key,name,asset])=>`<div class="asset"><label><input type="checkbox" data-accessory="${key}">${name}</label><div class="preview"><img id="preview-${key}" src="/roundup-references/${asset}" alt="${name}"></div><input type="file" accept="image/*" data-file="${key}" aria-label="Tải ảnh ${name}"><button type="button" class="reset" data-reset="${key}">Dùng mẫu đã lưu</button></div>`).join('');
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function refused(text){return /I\s+(?:can(?:not|['’]t)|am unable to|['’]m unable to)\s+(?:assist|help|comply|fulfill|provide|create|generate)|I must decline|I have to decline|tôi không thể (?:hỗ trợ|giúp|thực hiện)/i.test(text);}
function usablePrompt(){return !!$('prompt').value.trim()&&!refused($('prompt').value);}
function lock(value){busy=value;document.querySelectorAll('input,select,textarea,button').forEach(e=>e.disabled=value);if(!value)$('generate').disabled=!files.reference||!usablePrompt();}
function changed(){requestId=null;$('prompt').value='';lock(false);status('Đã cập nhật ảnh. Bấm tạo prompt để kết hợp các chi tiết.');}
async function api(action,body){const response=await fetch('/api/choly-studio/'+action,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await response.json();if(response.status===401){location.href='/auth.html';throw Error('Vui lòng đăng nhập.');}if(!response.ok)throw Error(data.error||'Không kết nối được máy chủ.');return data;}
function payload(){return {aspect:$('aspect').value,provider:$('provider').value,files,environment_description:$('environment-description').value,shirts:$('shirts').value,kol:$('kol').value,male_position:$('male-position').value,accessories:[...document.querySelectorAll('[data-accessory]:checked')].map(e=>e.dataset.accessory),prompt:$('prompt').value,request_id:requestId};}
async function upload(file){if(!file.type.startsWith('image/')||file.size>25*1024*1024)throw Error('Chọn ảnh JPG, PNG hoặc WebP dưới 25 MB.');const image=await createImageBitmap(file);const canvas=document.createElement('canvas'),scale=Math.min(1,2000/Math.max(image.width,image.height));canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);image.close();for(const quality of [.92,.82,.7,.55]){const data=canvas.toDataURL('image/jpeg',quality);if(data.length<4500000)return data;}throw Error('Ảnh quá lớn. Hãy giảm kích thước.');}
function renderFaceLibrary(saved){
 const grid=$('face-library');grid.replaceChildren();
 for(const face of saved.library||[]){
  const button=document.createElement('button');button.type='button';button.className='reset';
  const image=document.createElement('img');image.src=face.thumbnail;image.alt=face.name;image.style.cssText='width:100%;height:90px;object-fit:contain';
  const label=document.createElement('span');label.textContent=face.name;button.append(image,label);
  button.onclick=async()=>{if(busy)return;const slot=$('face-target').value;lock(true);try{const result=await api('single-faces',{slot,face_id:face.id});applySavedFaces(result);changed();$('face-save-note').textContent='✓ Đã chọn '+face.name;}catch(e){status(e.message,true);}finally{lock(false);}};
  grid.append(button);
 }
 if(!grid.children.length)grid.textContent='Chưa có khuôn mặt. Tải ảnh để thêm vào thư viện.';
}
function applySavedFaces(saved){
 for(const key of ['kol','kol_male','kol_female']){if(saved.files?.[key]){files[key]=saved.files[key];$('preview-'+key).src=files[key];$('preview-'+key).hidden=false;}else delete files[key];}
 if(Object.keys(saved.files||{}).length)$('kol').value=saved.kol==='couple'?'couple':'upload';
 updateKol();renderFaceLibrary(saved);
}
$('face-library-upload').onchange=async()=>{
 if(busy)return;const images=[...$('face-library-upload').files],slot=$('face-target').value;lock(true);
 let count=0;try{for(const file of images){const image=await upload(file);const saved=await api('single-faces',{slot,image,name:file.name});applySavedFaces(saved);count++;}if(count)changed();$('face-save-note').textContent='✓ Đã thêm '+count+' khuôn mặt vào thư viện.';}
 catch(e){if(count)changed();status('Đã lưu '+count+' ảnh. '+e.message,true);}finally{$('face-library-upload').value='';lock(false);}
};
document.querySelectorAll('[data-file]').forEach(input=>input.onchange=async()=>{const file=input.files[0];if(!file)return;lock(true);try{const key=input.dataset.file;files[key]=await upload(file);$('preview-'+key).src=files[key];$('preview-'+key).hidden=false;if($('empty-'+key))$('empty-'+key).hidden=true;if(key==='kol')$('kol').value='upload';const check=document.querySelector(`[data-accessory="${key}"]`);if(check)check.checked=true;changed();if(['kol','kol_male','kol_female'].includes(key)){updateKol();lock(true);try{const saved=await api('single-faces',{slot:key,image:files[key],name:file.name});renderFaceLibrary(saved);$('face-save-note').textContent='✓ Đã lưu khuôn mặt vào tài khoản. Lần sau mở lại sẽ tự điền.';}catch(e){$('face-save-note').textContent='Chưa lưu được khuôn mặt: '+e.message+' Bạn vẫn có thể dùng ảnh vừa tải để tạo ảnh.';}}}catch(e){status(e.message,true);}finally{lock(false);}});
document.querySelectorAll('[data-accessory]').forEach(e=>e.onchange=changed);
document.querySelectorAll('[data-reset]').forEach(button=>button.onclick=()=>{const key=button.dataset.reset;delete files[key];document.querySelector(`[data-file="${key}"]`).value='';$('preview-'+key).src='/roundup-references/'+assets.find(a=>a[0]===key)[2];changed();});
function updateKol(){const value=$('kol').value,preview=$('preview-kol'),couple=value==='couple';$('new-person-note').hidden=value!=='new';$('couple-kols').hidden=!couple;$('kol-file').hidden=couple||value==='flatlay'||value==='new';preview.parentElement.hidden=couple||value==='flatlay'||value==='new';preview.hidden=value==='none'||value==='flatlay'||value==='new'||(value==='upload'&&!files.kol);$('empty-kol').hidden=!preview.hidden;if(!preview.hidden&&!couple)preview.src=value==='upload'?files.kol:'/api/choly-studio/identity?role='+value;}
$('kol').onchange=()=>{updateKol();changed();};
$('male-position').onchange=changed;
document.querySelectorAll('[data-reset-kol]').forEach(button=>button.onclick=async()=>{const role=button.dataset.resetKol;lock(true);try{const saved=await api('single-faces',{slot:'kol_'+role,image:null});renderFaceLibrary(saved);delete files['kol_'+role];$('kol-'+role+'-file').value='';$('preview-kol_'+role).src='/api/choly-studio/identity?role='+role;changed();$('face-save-note').textContent='Đã chuyển về KOL mặc định cho mặt này.';}catch(e){status('Chưa đổi được khuôn mặt đã lưu: '+e.message,true);}finally{lock(false);}});
function selectedShirtRoles(){return $('shirts').value==='both'?['male','female']:$('shirts').value==='none'?[]:[$('shirts').value];}
function checkShirts(){for(const role of selectedShirtRoles())if(!files['shirt_'+role])throw Error('Tải ảnh áo '+(role==='male'?'nam':'nữ')+' đã chọn trước.');}
$('shirts').onchange=()=>{for(const role of ['male','female'])$('shirt-'+role+'-panel').hidden=!selectedShirtRoles().includes(role);changed();};
document.querySelectorAll('[data-reset-shirt]').forEach(button=>button.onclick=()=>{const role=button.dataset.resetShirt;delete files['shirt_'+role];$('shirt-'+role+'-file').value='';$('preview-shirt_'+role).removeAttribute('src');$('preview-shirt_'+role).hidden=true;$('empty-shirt_'+role).hidden=false;changed();});
$('environment-description').oninput=()=>{requestId=null;$('prompt').value='';$('generate').disabled=true;};
$('reset-environment').onclick=()=>{delete files.environment;$('environment-file').value='';$('preview-environment').removeAttribute('src');$('preview-environment').hidden=true;$('empty-environment').hidden=false;changed();};
$('provider').onchange=()=>{requestId=null;};
$('aspect').onchange=()=>{requestId=null;status('Đã đổi tỉ lệ ảnh. Lần tạo ảnh tiếp theo sẽ dùng tỉ lệ vừa chọn.');};
$('prompt').oninput=()=>{requestId=null;$('generate').disabled=busy||!files.reference||!usablePrompt();};
$('analyze').onclick=async()=>{if(busy)return;if(!files.reference){status('Tải một ảnh tham chiếu trước.',true);return;}$('prompt').value='';requestId=null;lock(true);status('ChatGPT đang đọc ảnh và viết prompt văn bản tạo ảnh mới…');try{checkShirts();const result=await api('single-prompt',payload());if(refused(result.prompt))throw Error('ChatGPT đã từ chối yêu cầu; chưa tạo prompt hoặc ảnh.');$('prompt').value=result.prompt;requestId=null;status('Prompt đã sẵn sàng. Bạn có thể chỉnh sửa rồi tạo ảnh.');}catch(e){status(e.message,true);}finally{lock(false);}};
function show(job){if(job.items?.length){if(resultJob?.id!==job.id)retryId=null;resultJob=job;$('regenerate').hidden=false;$('regenerate-note').hidden=false;$('regenerate-note').textContent=job.can_regenerate?'Tạo một phiên bản mới từ cùng prompt, KOL, áo, bao bì, model và tỉ lệ.':'Ảnh cũ chưa lưu đầu vào. Có thể tạo lại bằng thiết lập hiện có nếu bạn chưa tải lại trang.';}status(job.error||job.note,!!job.error);if(job.items?.length){const image=job.items[0].image;$('output').src=image;$('output').hidden=false;$('empty-result').hidden=true;$('download').href=image;$('download').hidden=false;}}
async function poll(id){clearTimeout(timer);try{const job=await api('job?id='+encodeURIComponent(id));show(job);if(job.status==='running'){lock(true);timer=setTimeout(()=>poll(id),2500);}else{sessionStorage.removeItem('single-image-job');requestId=null;lock(false);}}catch(e){status(e.message+' Đang kết nối lại…',true);timer=setTimeout(()=>poll(id),5000);}}
$('generate').onclick=async()=>{if(busy)return;if(!files.reference||!usablePrompt()){status('Tải ảnh và tạo prompt trước.',true);return;}lock(true);requestId=requestId||crypto.randomUUID();status('Đang tạo ảnh mới bằng '+$('provider').selectedOptions[0].textContent+'…');try{checkShirts();const job=await api('single-generate',payload());sessionStorage.setItem('single-image-job',job.id);await poll(job.id);}catch(e){status(e.message,true);lock(false);}};
$('regenerate').onclick=async()=>{
 if(busy||!resultJob)return;
 if(!resultJob.can_regenerate){
  if(files.reference&&usablePrompt()){await $('generate').onclick();return;}
  status('Ảnh cũ chưa lưu đầu vào để tạo lại. Hãy tải ảnh đầu vào và dùng nút Tạo ảnh mới.',true);return;
 }
 lock(true);retryId=retryId||crypto.randomUUID();status('Đang tạo lại ảnh với thiết lập của ảnh hoàn thiện…');
 try{const job=await api('single-regenerate',{source_id:resultJob.id,request_id:retryId});sessionStorage.setItem('single-image-job',job.id);await poll(job.id);retryId=null;}
 catch(e){status(e.message,true);lock(false);}
};
(async()=>{lock(true);try{const saved=await api('single-faces');renderFaceLibrary(saved);for(const [key,data] of Object.entries(saved.files||{})){if(!['kol','kol_male','kol_female'].includes(key))continue;files[key]=data;$('preview-'+key).src=data;$('preview-'+key).hidden=false;}if(Object.keys(saved.files||{}).length){$('kol').value=saved.kol==='couple'?'couple':'upload';$('face-save-note').textContent='✓ Đã khôi phục khuôn mặt bạn lưu lần trước.';}updateKol();}catch(e){$('face-save-note').textContent='Chưa tải được khuôn mặt đã lưu: '+e.message;}finally{lock(false);}try{const jobs=(await api('history')).jobs.filter(j=>j.mode==='single');const latest=jobs[0];if(latest)show(latest);const active=jobs.find(j=>j.status==='running');if(active)await poll(active.id);}catch(e){status(e.message,true);}})();
})();
