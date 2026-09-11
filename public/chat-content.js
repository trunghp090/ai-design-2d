(() => {
  'use strict';
  const root = document.getElementById('view-chatcontent');
  root.innerHTML = `
    <div class="cc-heading"><div><span class="cc-eyebrow">CONTENT STUDIO / ZALO</span><h1>Một cuộc trò chuyện. Một câu chuyện.</h1><p>Dựng hội thoại, ghép ảnh khách gửi và thành phẩm thành bộ content của bạn.</p></div><div class="cc-actions"><button class="btn-ghost" id="cc-save">Lưu bản dự án</button><button class="btn-ghost" id="cc-open">Mở dự án</button><input id="cc-project-file" type="file" accept="application/json" hidden><button class="btn-primary sm" id="cc-export">↓ Xuất PNG</button></div></div>
    <div class="cc-grid">
      <section class="cc-panel"><h2><span class="cc-step">01</span>Thiết lập hội thoại</h2>
        <label for="cc-name">Tên người trò chuyện</label><input id="cc-name" class="input" maxlength="60" value="Khách hàng">
        <label for="cc-avatar">Avatar khách hàng</label><input class="cc-file" type="file" id="cc-avatar" accept="image/*"><button class="btn-ghost sm" id="cc-clear-avatar" style="margin-top:8px">Bỏ avatar</button>
        <div class="cc-row"><div><label for="cc-ratio">Khung hình</label><select id="cc-ratio" class="input"><option value="portrait">9:16 · Story / TikTok</option><option value="feed">4:5 · Bài đăng</option><option value="square">1:1 · Vuông</option></select></div><div><label for="cc-font">Cỡ chữ</label><input id="cc-font" class="input" type="number" min="24" max="52" value="36"></div></div>
        <label class="cc-check"><input type="checkbox" id="cc-header" checked> Hiện thanh tên hội thoại</label><label class="cc-check"><input type="checkbox" id="cc-trim"> Cắt gọn theo đoạn hội thoại</label>
        <hr style="border:0;border-top:1px solid var(--line);margin:22px 0"><h2><span class="cc-step">02</span><span id="cc-editor-title">Thêm tin nhắn</span></h2>
        <div class="cc-row"><div><label for="cc-side">Người gửi</label><select id="cc-side" class="input"><option value="in">Khách · bên trái</option><option value="out">Shop · bên phải</option></select></div><div><label for="cc-time">Giờ gửi</label><input id="cc-time" class="input" type="time" value="21:03"></div></div>
        <label for="cc-kind">Loại nội dung</label><select id="cc-kind" class="input"><option value="text">Tin nhắn văn bản</option><option value="image">Ảnh / album ảnh</option><option value="cover">Ảnh tràn khung (slide thành phẩm)</option></select>
        <div id="cc-text-fields"><label for="cc-text">Nội dung tin nhắn</label><textarea id="cc-text" class="input" rows="4" maxlength="1800" placeholder="Shop ghép hộ em 2 ảnh này với được kh ạ"></textarea></div>
        <div id="cc-image-fields" hidden><label for="cc-images">Chọn tối đa 4 ảnh (ảnh tràn khung: 1 ảnh)</label><input class="cc-file" id="cc-images" type="file" accept="image/*" multiple><div id="cc-thumbs" class="cc-media-thumbs"></div><p class="hint">Ảnh trong hội thoại được ghép thành album; ảnh tràn khung sẽ được cắt vừa khung.</p></div>
        <label class="cc-check"><input id="cc-heart" type="checkbox"> Thả tim</label><label class="cc-check" id="cc-hd-label" hidden><input id="cc-hd" type="checkbox" checked> Hiện nhãn HD</label>
        <div class="cc-actions" style="margin-top:18px"><button class="btn-primary sm" id="cc-add">+ Thêm tin nhắn</button><button class="btn-ghost sm" id="cc-cancel" hidden>Hủy sửa</button></div>
        <div id="cc-notice" class="cc-notice" role="status" aria-live="polite"></div>
      </section>
      <section class="cc-stage"><div class="cc-stage-head"><span>XEM TRƯỚC TRỰC TIẾP</span><span id="cc-dimensions">1080 × 1920</span></div><div id="cc-slides" class="cc-slides"></div><div class="cc-canvas-wrap"><canvas id="cc-canvas" width="1080" height="1920" aria-label="Bản xem trước hội thoại"></canvas></div><p class="cc-preview-note">PNG xuất ra giống bản xem trước · 1080 px<br>Bản nháp tự lưu trên trình duyệt này.</p><div id="cc-overflow" class="cc-notice error" role="status"></div></section>
      <section class="cc-panel"><h2><span class="cc-step">03</span>Kịch bản & slide</h2><div class="cc-actions"><button class="btn-ghost sm" id="cc-new-slide">+ Slide</button><button class="btn-ghost sm" id="cc-copy-slide">Nhân đôi</button><button class="btn-ghost sm" id="cc-delete-slide">Xóa slide</button></div><p class="hint" style="margin:14px 0">Chọn tin nhắn để sửa. Dùng ↑ ↓ để đổi thứ tự.</p><div id="cc-list" class="cc-list"></div><p class="hint">Gợi ý: yêu cầu của khách → ảnh tham khảo → bản thiết kế → phản hồi → ảnh thành phẩm.</p></section>
    </div>`;
  // Match the two-column Content hội thoại setup in AI Influencer Studio.
  const left = root.querySelector('.cc-grid > .cc-panel');
  const stage = root.querySelector('.cc-stage');
  const scriptPanel = root.querySelector('.cc-grid > .cc-panel:last-child');
  const editorArchive = document.createElement('div'); editorArchive.hidden = true;
  let editorNode = left.querySelector('hr');
  while (editorNode) { const next = editorNode.nextSibling; editorArchive.append(editorNode); editorNode = next; }
  root.append(editorArchive);
  left.querySelector('h2').innerHTML = 'Thiết lập hội thoại <small>Áp dụng cả bộ</small>';
  const avatarPreview = document.createElement('div'); avatarPreview.id = 'cc-avatar-preview'; avatarPreview.className = 'cc-avatar-preview';
  left.insertBefore(avatarPreview, left.querySelector('label'));
  const leftStack = document.createElement('div'); leftStack.className = 'cc-left-stack';
  left.before(leftStack); leftStack.append(left, scriptPanel);
  scriptPanel.querySelector('h2').innerHTML = '<span id="cc-slide-title">Slide 1</span><span class="cc-actions"><button class="btn-ghost sm" id="cc-slide-back" aria-label="Chuyển slide về trước">←</button><button class="btn-ghost sm" id="cc-slide-forward" aria-label="Chuyển slide về sau">→</button></span>';
  scriptPanel.querySelector('.hint').remove();
  const slideName = document.createElement('div');
  slideName.innerHTML = '<label for="cc-slide-name">Tên slide</label><input id="cc-slide-name" class="input" maxlength="50" placeholder="Ví dụ: Khách gửi ảnh"><p class="hint">Sửa trực tiếp từng tin nhắn bên dưới.</p>';
  scriptPanel.querySelector('#cc-list').before(slideName);
  const addButtons = document.createElement('div'); addButtons.className = 'cc-row cc-inline-add';
  addButtons.innerHTML = '<button class="btn-ghost" id="cc-add-customer">＋ Tin khách</button><button class="btn-ghost" id="cc-add-shop">＋ Tin shop</button>';
  scriptPanel.querySelector('#cc-list').before(addButtons);
  const slides = root.querySelector('#cc-slides'); root.querySelector('.cc-grid').before(slides);
  const footer = document.createElement('div'); footer.className = 'cc-preview-footer';
  footer.innerHTML = '<div class="cc-preview-nav"><button class="btn-ghost sm" id="cc-prev" aria-label="Slide trước">←</button><span id="cc-page-number"></span><button class="btn-ghost sm" id="cc-next" aria-label="Slide tiếp theo">→</button></div>';
  stage.append(footer); footer.append(root.querySelector('#cc-overflow'), root.querySelector('#cc-notice'), root.querySelector('#cc-export'));
  root.querySelector('.cc-heading h1').textContent = 'CONTENT HỘI THOẠI';
  root.querySelector('.cc-heading p').textContent = 'Kể câu chuyện từ tin nhắn đến thành phẩm. Soạn và xuất ảnh theo phong cách Zalo.';
  // Keep project settings accessible without pushing the script below the fold.
  const settingsDisclosure = document.createElement('details');
  settingsDisclosure.className = 'cc-settings';
  const settingsSummary = document.createElement('summary');
  settingsSummary.innerHTML = '<span>Thiết lập hội thoại</span><small>Tên, avatar, khung hình & cỡ chữ</small>';
  settingsDisclosure.append(settingsSummary);
  left.querySelector('h2').remove();
  left.before(settingsDisclosure); settingsDisclosure.append(left);
  scriptPanel.classList.add('cc-script-panel');
  root.querySelector('.cc-heading h1').textContent = 'Content Zalo';
  root.querySelector('.cc-heading p').textContent = 'Soạn tin nhắn bên trái · Xem thành phẩm bên phải · Xuất ảnh khi hoàn tất.';
  const $ = id => document.getElementById('cc-' + id);
  const seed = () => ({version:1,name:'Khách hàng',avatar:'',ratio:'portrait',font:36,header:true,slides:[{messages:[
    {side:'in',kind:'text',text:'Vâng shop đợi em chọn ảnh anh nhà đã nhen',time:'21:03',heart:false,images:[]},
    {side:'out',kind:'text',text:'Dạ b ạ',time:'21:08',heart:false,images:[]},
    {side:'in',kind:'text',text:'Shop ghép hộ em 2 ảnh này với được kh ạ',time:'21:37',heart:false,images:[]},
    {side:'out',kind:'text',text:'Shop gửi e nha',time:'21:40',heart:true,images:[]}
  ]}]});
  let state=seed(), slide=0, editing=-1, pending=[], revision=0, overflow=false, db=null, saveQueue=Promise.resolve();
  const notice = (s, error=false) => { $('notice').textContent=s; $('notice').classList.toggle('error',error); };
  const messages=()=>state.slides[slide].messages;
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const templates = window.ZALO_SCRIPTS || [];
  const templateDrafts = new Map();
  let selectionRevision = 0;
  const workspace = document.createElement('div'); workspace.id='cc-workspace'; workspace.hidden=true;
  root.querySelector('.cc-grid').before(workspace);
  workspace.append(slides,root.querySelector('.cc-grid'));
  const library=document.createElement('section');library.className='cc-library';library.id='cc-library';
  library.innerHTML='<div class="cc-library-bar"><div><h2>Chọn một câu chuyện</h2><p>20 kịch bản hội thoại · Chọn mẫu rồi thêm ảnh của bạn.</p></div><input id="cc-script-search" class="input" placeholder="Tìm kịch bản, dịp tặng…" aria-label="Tìm kịch bản"></div><div class="cc-actions"><button id="cc-resume" class="btn-ghost sm" hidden>Tiếp tục bản nháp</button><button id="cc-blank" class="btn-ghost sm">＋ Hội thoại trống</button></div><p id="cc-library-status" class="cc-library-status" role="status"></p><div id="cc-template-grid" class="cc-template-grid"></div>';
  workspace.before(library);
  const workhead=document.createElement('div');workhead.className='cc-template-workhead';
  workhead.innerHTML='<button id="cc-library-back" class="btn-ghost">← Danh sách kịch bản</button><h2 id="cc-template-title"></h2>';
  workspace.prepend(workhead);
  const photoPanel=document.createElement('div');photoPanel.className='cc-template-photos';photoPanel.id='cc-template-photos';
  photoPanel.innerHTML='<div><label for="cc-source-files">1. Ảnh khách gửi</label><input id="cc-source-files" class="cc-file" type="file" accept="image/*" multiple><small id="cc-source-hint"></small><div id="cc-source-preview"></div></div><div><label for="cc-result-files">2. Ảnh thành phẩm</label><input id="cc-result-files" class="cc-file" type="file" accept="image/*"><small>Dùng chung cho tin shop gửi mẫu và slide thành phẩm.</small><div id="cc-result-preview"></div></div>';
  workhead.after(photoPanel);
  const captionPanel=document.createElement('div');captionPanel.className='cc-template-caption';captionPanel.id='cc-template-caption';
  captionPanel.innerHTML='<label for="cc-caption">Caption của bài</label><textarea id="cc-caption" class="input" rows="3"></textarea><button id="cc-copy-caption" class="btn-ghost sm">Copy caption</button>';
  workspace.append(captionPanel);
  root.querySelector('.cc-heading p').textContent='Chọn kịch bản → thêm ảnh khách và thành phẩm → xuất bộ hội thoại.';
  function libraryView(open){
    workspace.hidden=!open;library.hidden=open;$('save').hidden=!open;
    $('resume').hidden=!state.templateId&&!state.caption&&!state.slides.some(s=>s.messages.some(m=>m.images.length));
  }
  function templatePhotos(){
    for(const slot of ['source','result']){
      const entry=state.slides.flatMap(s=>s.messages).find(m=>m.slot===slot);
      $(slot+'-preview').innerHTML=(entry?.images||[]).map(src=>`<img src="${esc(src)}" alt="Ảnh ${slot==='source'?'khách gửi':'thành phẩm'}">`).join('');
    }
  }
  function openWorkspace(){
    const template=templates.find(t=>t.id===state.templateId);
    $('template-title').textContent=template?.title||'Hội thoại của bạn';
    $('source-hint').textContent=template?template.photoHint+' · tối đa 4 ảnh.':'';
    photoPanel.hidden=!template;captionPanel.hidden=!template;
    $('caption').value=state.caption||'';
    $('source-files').value='';$('result-files').value='';templatePhotos();libraryView(true);
  }
  function renderTemplates(){
    const q=$('script-search').value.toLocaleLowerCase('vi').trim();
    const matches=templates.filter(t=>(t.title+' '+t.category).toLocaleLowerCase('vi').includes(q));
    $('template-grid').innerHTML=matches.map(t=>`<button class="cc-template-card" data-template="${esc(t.id)}"><span>${String(templates.indexOf(t)+1).padStart(2,'0')} / ${esc(t.category)}</span><strong>${esc(t.title)}</strong><small>${esc(t.photoHint)} + ảnh thành phẩm</small><small>3 slide · Xem hội thoại →</small></button>`).join('');
    $('library-status').textContent=matches.length?matches.length+' kịch bản sẵn sàng':'Không có kịch bản phù hợp.';
  }
  async function selectTemplate(id){
    const template=templates.find(t=>t.id===id);if(!template)return;
    const token=++selectionRevision;
    templateDrafts.set(state.templateId||'manual',JSON.parse(JSON.stringify(state)));
    await saveQueue.catch(()=>{});
    let saved=templateDrafts.get(id);
    if(!saved&&db)saved=await new Promise(resolve=>{const r=db.transaction('drafts').objectStore('drafts').get('script:'+id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);});
    if(token!==selectionRevision)return;
    state=saved?validate(saved):JSON.parse(JSON.stringify({...template.project,caption:template.caption}));
    slide=0;resetEditor();settings();openWorkspace();update();
    notice('Đã mở kịch bản. Thêm ảnh ở hai ô phía trên; lời thoại có thể sửa trực tiếp.');
  }
  $('template-grid').onclick=e=>{const b=e.target.closest('[data-template]');if(b)selectTemplate(b.dataset.template).catch(e=>{$('library-status').textContent=e.message;});};
  $('script-search').oninput=renderTemplates;
  $('library-back').onclick=()=>{++selectionRevision;persist();libraryView(false);};
  $('resume').onclick=()=>{openWorkspace();settings();update();};
  $('blank').onclick=()=>{++selectionRevision;templateDrafts.set(state.templateId||'manual',JSON.parse(JSON.stringify(state)));state={...seed(),slides:[{messages:[]}]};slide=0;resetEditor();settings();openWorkspace();update();};
  for(const slot of ['source','result'])$(slot+'-files').onchange=async e=>{
    const files=[...e.target.files],target=state;if(!files.length)return;
    try{
      if(files.length>(slot==='source'?4:1))throw Error(slot==='source'?'Chọn tối đa 4 ảnh khách gửi.':'Chọn 1 ảnh thành phẩm.');
      const photos=await Promise.all(files.map(readFile));
      for(const m of target.slides.flatMap(s=>s.messages).filter(m=>m.slot===slot))m.images=photos.slice(0,m.kind==='cover'?1:4);
      if(target!==state)return;
      templatePhotos();update();notice('Đã đặt ảnh vào đúng các slide của kịch bản.');
    }catch(err){notice(err.message,true);}
    e.target.value='';
  };
  $('caption').oninput=()=>{state.caption=$('caption').value;persist();};
  $('copy-caption').onclick=async()=>{try{await navigator.clipboard.writeText(state.caption||'');notice('Đã copy caption.');}catch{notice('Chọn và sao chép caption trong ô phía trên.',true);}};
  renderTemplates();libraryView(false);
  function persist(){
    const snapshot=JSON.parse(JSON.stringify(state));
    templateDrafts.set(snapshot.templateId||'manual',snapshot);
    saveQueue=saveQueue.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
      if(!db){notice('Chưa lưu tự động được. Hãy dùng Lưu bản dự án.',true);resolve();return;}
      const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(snapshot,'current');
      tx.objectStore('drafts').put(snapshot,'script:'+(snapshot.templateId||'manual'));
      tx.oncomplete=resolve;tx.onerror=()=>{notice('Không đủ chỗ lưu nháp. Hãy tải bản dự án về máy.',true);reject(tx.error);};
    }));
    saveQueue.catch(()=>{});
  }
  function settings(){for(const k of ['name','ratio','font']) $(k).value=state[k];$('header').checked=state.header;$('trim').checked=!!state.trim;}
  function resetEditor(){editing=-1;pending=[];$('text').value='';$('images').value='';$('thumbs').innerHTML='';$('add').textContent='+ Thêm tin nhắn';$('editor-title').textContent='Thêm tin nhắn';$('cancel').hidden=true;}
  function kindFields(){const media=$('kind').value!=='text';$('text-fields').hidden=media;$('image-fields').hidden=!media;$('hd-label').hidden=!media;}
  function thumbs(){ $('thumbs').innerHTML=pending.map(src=>`<img src="${esc(src)}" alt="Ảnh đã chọn">`).join(''); }
  function list(){
    $('slides').innerHTML=state.slides.map((s,i)=>`<button class="cc-slide ${i===slide?'active':''}" data-slide="${i}">${String(i+1).padStart(2,'0')} <span>${esc(s.title||'Slide '+(i+1))}</span></button>`).join('');
    $('slide-title').textContent='Slide '+(slide+1);
    $('slide-name').value=state.slides[slide].title||'';
    $('page-number').textContent=`${slide+1} / ${state.slides.length}`;
    for(const k of ['prev','slide-back'])$(k).disabled=slide===0;
    for(const k of ['next','slide-forward'])$(k).disabled=slide===state.slides.length-1;
    $('avatar-preview').innerHTML=state.avatar?`<img src="${esc(state.avatar)}" alt="Avatar khách hàng">`:esc(state.name.trim()[0]||'K');
    $('list').innerHTML=messages().map((m,i)=>`<article class="cc-message cc-message-${m.side}" data-message="${i}">
      <div class="cc-message-head"><small><span class="cc-sender-dot"></span>${m.side==='in'?'KHÁCH':'SHOP'} <span class="cc-message-number">/ Tin ${i+1}</span></small><div class="cc-actions"><button data-move="${i}" data-delta="-1" ${i===0?'disabled':''} aria-label="Đưa tin ${i+1} lên">↑</button><button data-move="${i}" data-delta="1" ${i===messages().length-1?'disabled':''} aria-label="Đưa tin ${i+1} xuống">↓</button><button data-delete="${i}" aria-label="Xóa tin ${i+1}">Xóa</button></div></div>
      <div class="cc-row"><select class="input" data-field="side" aria-label="Người gửi tin ${i+1}"><option value="in" ${m.side==='in'?'selected':''}>Khách · bên trái</option><option value="out" ${m.side==='out'?'selected':''}>Shop · bên phải</option></select><input class="input" type="time" data-field="time" aria-label="Giờ tin ${i+1}" value="${esc(m.time)}"></div>
      <select class="input cc-message-kind" data-field="kind" aria-label="Loại tin ${i+1}"><option value="text" ${m.kind==='text'?'selected':''}>Tin nhắn văn bản</option><option value="image" ${m.kind==='image'?'selected':''}>Ảnh / album ảnh</option><option value="cover" ${m.kind==='cover'?'selected':''}>Ảnh toàn khung</option></select>
      ${m.kind==='text'?`<textarea class="input" rows="3" maxlength="1800" data-field="text" aria-label="Nội dung tin ${i+1}" placeholder="Nhập tin nhắn…">${esc(m.text)}</textarea>`:`<label>Đính kèm ${m.kind==='cover'?'1':'1–4'} ảnh<input class="cc-file" type="file" accept="image/*" ${m.kind==='cover'?'':'multiple'} data-upload="${i}" aria-label="Ảnh tin ${i+1}"></label><div class="cc-media-thumbs">${m.images.map((src,j)=>`<div><img src="${esc(src)}" alt="Đính kèm ${j+1}"><button data-remove-image="${i}" data-image="${j}" aria-label="Bỏ ảnh ${j+1} tin ${i+1}">×</button></div>`).join('')}</div>`}
      <details class="cc-message-options"><summary>Hiển thị thêm${m.heart?' · ♥':''}${m.kind==='image'&&m.hd?' · HD':''}</summary><label class="cc-check"><input type="checkbox" data-field="heart" ${m.heart?'checked':''}>Hiện biểu tượng thả tim</label>
      ${m.kind==='image'?`<label class="cc-check"><input type="checkbox" data-field="hd" ${m.hd?'checked':''}>Hiện nhãn HD</label>`:''}</details>
    </article>`).join('')||'<p class="cc-empty">Thêm tin nhắn đầu tiên cho câu chuyện.</p>';
  }
  const imageCache=new Map();
  function loadImage(src){if(!src)return Promise.resolve(null);if(!imageCache.has(src))imageCache.set(src,new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>{imageCache.delete(src);reject(new Error('Không đọc được ảnh. Hãy chọn lại ảnh.'));};im.src=src;}));return imageCache.get(src);}
  function round(ctx,x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}}
  function crop(ctx,im,x,y,w,h){const k=Math.max(w/im.width,h/im.height),sw=w/k,sh=h/k;ctx.drawImage(im,(im.width-sw)/2,(im.height-sh)/2,sw,sh,x,y,w,h);}
  function wrap(ctx,text,max){const lines=[];for(const para of text.split('\n')){let line='';for(const word of para.split(' ')){const candidate=line?line+' '+word:word;if(ctx.measureText(candidate).width<=max){line=candidate;continue;}if(line)lines.push(line);line='';for(const ch of word){if(ctx.measureText(line+ch).width>max&&line){lines.push(line);line='';}line+=ch;}}lines.push(line);}return lines;}
  async function draw(){
    const token=++revision, snapshot=JSON.parse(JSON.stringify(state)), ms=snapshot.slides[slide].messages;
    const W=1080,H={portrait:1920,feed:1350,square:1080}[snapshot.ratio];
    const buffer=document.createElement('canvas');buffer.width=W;buffer.height=H;const c=buffer.getContext('2d');
    const imgs=await Promise.all(ms.map(m=>Promise.all((m.images||[]).map(loadImage))));const avatar=await loadImage(snapshot.avatar);
    if(token!==revision)return;
    c.fillStyle='#e3e7f0';c.fillRect(0,0,W,H);let y=40;const font=Number(snapshot.font),lineH=font*1.38;
    const avatarAt=(x,yy)=>{c.save();c.beginPath();c.arc(x+30,yy+30,30,0,Math.PI*2);c.clip();if(avatar)crop(c,avatar,x,yy,60,60);else{c.fillStyle='#899d88';c.fillRect(x,yy,60,60);c.fillStyle='#fff';c.font='25px Arial';c.textAlign='center';c.fillText((snapshot.name.trim()[0]||'K').toUpperCase(),x+30,yy+39);c.textAlign='left';}c.restore();};
    if(snapshot.header&&!ms.some(m=>m.kind==='cover')){c.fillStyle='#fff';c.fillRect(0,0,W,126);c.fillStyle='#252a34';c.font='46px Arial';c.fillText('‹',30,75);avatarAt(80,30);c.font='bold 30px Arial';c.fillText(snapshot.name,160,57,740);c.font='22px Arial';c.fillStyle='#87909a';c.fillText('Đang hoạt động',160,91);c.fillText('•••',985,70);y=162;}
    for(let i=0;i<ms.length;i++){
      const m=ms[i], incoming=m.side==='in';
      if(m.kind==='cover'){if(imgs[i][0])crop(c,imgs[i][0],0,0,W,H);else{c.fillStyle='#87909a';c.font='36px Arial';c.fillText('Chọn ảnh thành phẩm',70,160);}y=H-35;continue;}
      let w,h,lines=[];c.font=`${font}px Arial`;
      if(m.kind==='text'){lines=wrap(c,m.text,790);w=Math.min(870,Math.max(180,...lines.map(l=>c.measureText(l).width+52)));h=lines.length*lineH+38+(m.time?38:0);}
      else{w=imgs[i].length===1?Math.min(820,880*imgs[i][0].width/imgs[i][0].height):820;h=imgs[i].length===0?340:imgs[i].length===1?Math.min(880,Math.max(260,w*imgs[i][0].height/imgs[i][0].width)):imgs[i].length===2?490:740;}
      const x=incoming?110:W-w-32;if(incoming)avatarAt(28,y);
      if(m.kind==='text'){round(c,x,y,w,h,24,incoming?'#ffffff':'#cff0fc',incoming?'#d6d9df':'#b4d2dc');c.fillStyle='#16191d';c.font=`${font}px Arial`;lines.forEach((l,j)=>c.fillText(l,x+26,y+28+font+j*lineH));if(m.time){c.fillStyle='#969ca1';c.font='25px Arial';c.fillText(m.time,x+26,y+h-18);}}
      else{round(c,x,y,w,h,24,'#fff','#bdced6');c.save();c.beginPath();c.roundRect(x+2,y+2,w-4,h-4,22);c.clip();const n=imgs[i].length;imgs[i].forEach((im,j)=>{const cols=n===1?1:2,rows=n>2?2:1;const cw=w/cols,ch=h/rows;crop(c,im,x+(j%cols)*cw+2,y+Math.floor(j/cols)*ch+2,cw-4,ch-4);});c.restore();if(!imgs[i].length){c.fillStyle='#87909a';c.font='30px Arial';c.fillText('Chọn ảnh cho tin nhắn này',x+35,y+80);}if(m.hd){round(c,x+15,y+15,62,39,9,'#0006');c.fillStyle='white';c.font='bold 25px Arial';c.fillText('HD',x+25,y+43);}}
      if(m.heart){round(c,x+w-55,y+h-20,54,50,25,'#fff','#d6d9df');c.fillStyle='#ed647d';c.font='32px Arial';c.fillText('♥',x+w-44,y+h+16);}
      y+=h+28+(m.heart?16:0);
    }
    overflow=y>H-10;$('overflow').textContent=overflow?'Nội dung vượt khung. Hãy chuyển bớt tin sang slide mới hoặc giảm cỡ chữ trước khi xuất.':'';
    const outputH=snapshot.trim&&!ms.some(m=>m.kind==='cover')?Math.min(H,Math.ceil(y+12)):H;
    root.querySelector('.cc-stage').style.setProperty('--cc-aspect',W/outputH);$('dimensions').textContent=`${W} × ${outputH}`;const canvas=$('canvas');canvas.width=W;canvas.height=outputH;canvas.getContext('2d').drawImage(buffer,0,0);
  }
  function update(){list();draw().catch(e=>notice(e.message,true));persist();}
  async function readFile(file){if(!file.type.startsWith('image/'))throw Error('Vui lòng chọn file ảnh.');if(file.size>25*1024*1024)throw Error('Mỗi ảnh tối đa 25 MB.');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});const im=await loadImage(data);const cvs=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(im.width,im.height));cvs.width=Math.round(im.width*scale);cvs.height=Math.round(im.height*scale);cvs.getContext('2d').drawImage(im,0,0,cvs.width,cvs.height);imageCache.delete(data);return cvs.toDataURL('image/png');}
  $('images').onchange=async e=>{try{const files=[...e.target.files];if(files.length>4)throw Error('Chọn tối đa 4 ảnh mỗi album.');pending=await Promise.all(files.map(readFile));thumbs();notice('Ảnh đã sẵn sàng. Bấm thêm hoặc lưu tin nhắn.');}catch(e){notice(e.message,true);}};
  $('avatar').onchange=async e=>{if(!e.target.files[0])return;try{state.avatar=await readFile(e.target.files[0]);update();}catch(e){notice(e.message,true);}};
  $('clear-avatar').onclick=()=>{state.avatar='';$('avatar').value='';update();};
  for(const k of ['name','ratio','font','header','trim'])$(k).oninput=()=>{state[k]=(k==='header'||k==='trim')?$(k).checked:k==='font'?Math.max(24,Math.min(52,Number($(k).value)||36)):$(k).value;update();};
  $('kind').onchange=kindFields;$('cancel').onclick=()=>{resetEditor();list();};
  $('add').onclick=()=>{
    const kind=$('kind').value;if(kind==='text'&&!$('text').value.trim())return notice('Nhập nội dung tin nhắn trước nhé.',true);
    if(kind!=='text'&&!pending.length)return notice('Chọn ảnh trước nhé.',true);
    const remaining=messages().filter((_,i)=>i!==editing);
    if((kind==='cover'&&remaining.length)||(kind!=='cover'&&remaining.some(m=>m.kind==='cover')))return notice('Ảnh tràn khung cần một slide riêng. Bấm + Slide để thêm.',true);
    const m={side:$('side').value,kind,text:$('text').value.trim(),time:$('time').value,images:kind==='text'?[]:pending.slice(0,kind==='cover'?1:4),heart:$('heart').checked,hd:$('hd').checked};
    if(editing<0)messages().push(m);else messages()[editing]=m;resetEditor();notice('Đã cập nhật hội thoại.');update();
  };
  function edit(i){editing=i;const m=messages()[i];for(const k of ['side','kind','text','time'])$(k).value=m[k]||'';for(const k of ['heart','hd'])$(k).checked=!!m[k];pending=[...m.images];thumbs();kindFields();$('add').textContent='Lưu thay đổi';$('editor-title').textContent=`Sửa tin nhắn ${i+1}`;$('cancel').hidden=false;list();}
  $('list').onclick=e=>{
    const del=e.target.closest('[data-delete]'),move=e.target.closest('[data-move]'),remove=e.target.closest('[data-remove-image]');
    if(del){messages().splice(+del.dataset.delete,1);update();}
    else if(move){const i=+move.dataset.move,j=i+(+move.dataset.delta);if(j>=0&&j<messages().length){[messages()[i],messages()[j]]=[messages()[j],messages()[i]];update();}}
    else if(remove){messages()[+remove.dataset.removeImage].images.splice(+remove.dataset.image,1);update();}
  };
  $('list').oninput=e=>{
    const field=e.target.dataset.field,row=e.target.closest('[data-message]');if(!field||!row)return;
    const m=messages()[+row.dataset.message];
    if(field==='kind'){
      if((e.target.value==='cover'&&messages().length>1)||(e.target.value!=='cover'&&messages().some((x,i)=>i!==+row.dataset.message&&x.kind==='cover'))){e.target.value=m.kind;return notice('Ảnh toàn khung cần một slide riêng. Bấm + Slide để thêm.',true);}
      m.kind=e.target.value;if(m.kind==='cover')m.images=m.images.slice(0,1);update();
    }else{m[field]=e.target.type==='checkbox'?e.target.checked:e.target.value;if(field==='side'){row.classList.toggle('cc-message-in',m.side==='in');row.classList.toggle('cc-message-out',m.side==='out');row.querySelector('.cc-message-head small').innerHTML=`<span class="cc-sender-dot"></span>${m.side==='in'?'KHÁCH':'SHOP'} <span class="cc-message-number">/ Tin ${+row.dataset.message+1}</span>`;}if(field==='heart'||field==='hd')row.querySelector('.cc-message-options summary').textContent=`Hiển thị thêm${m.heart?' · ♥':''}${m.kind==='image'&&m.hd?' · HD':''}`;draw().catch(e=>notice(e.message,true));persist();}
  };
  $('list').onchange=async e=>{
    if(e.target.dataset.upload===undefined)return;
    const m=messages()[+e.target.dataset.upload],files=[...e.target.files];if(!files.length)return;
    try{if(files.length>(m.kind==='cover'?1:4))throw Error('Số ảnh vượt giới hạn của tin nhắn.');const images=await Promise.all(files.map(readFile));m.images=images;update();notice('Đã cập nhật ảnh.');}catch(err){notice(err.message,true);}
  };
  function addInline(side){if(messages().some(m=>m.kind==='cover'))return notice('Slide ảnh toàn khung không chứa tin nhắn. Hãy thêm slide mới.',true);messages().push({side,kind:'text',text:'',time:'21:03',heart:false,hd:true,images:[]});update();}
  $('add-customer').onclick=()=>addInline('in');$('add-shop').onclick=()=>addInline('out');
  $('slide-name').oninput=()=>{state.slides[slide].title=$('slide-name').value;const active=$('slides').querySelector('.active span');if(active)active.textContent=$('slide-name').value||'Slide '+(slide+1);persist();};
  function step(n){const next=slide+n;if(next<0||next>=state.slides.length)return;slide=next;update();}
  $('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);
  function moveSlide(n){const next=slide+n;if(next<0||next>=state.slides.length)return;[state.slides[slide],state.slides[next]]=[state.slides[next],state.slides[slide]];slide=next;update();}
  $('slide-back').onclick=()=>moveSlide(-1);$('slide-forward').onclick=()=>moveSlide(1);
  $('slides').onclick=e=>{const b=e.target.closest('[data-slide]');if(b){slide=+b.dataset.slide;resetEditor();update();}};
  $('new-slide').onclick=()=>{state.slides.push({messages:[]});slide=state.slides.length-1;resetEditor();update();};
  $('copy-slide').onclick=()=>{state.slides.splice(slide+1,0,JSON.parse(JSON.stringify(state.slides[slide])));slide++;resetEditor();update();};
  $('delete-slide').onclick=()=>{if(!confirm('Xóa slide hiện tại và các tin nhắn trong slide?'))return;state.slides.splice(slide,1);if(!state.slides.length)state.slides.push({messages:[]});slide=Math.min(slide,state.slides.length-1);resetEditor();update();};
  function download(blob,name){
    const reader=new FileReader();
    reader.onload=()=>{
      let link=root.querySelector('#cc-download-ready');
      if(!link){link=document.createElement('a');link.id='cc-download-ready';link.className='btn-ghost sm';$('export').after(link);}
      link.href=reader.result;link.download=name;link.textContent='Tải lại '+name;link.click();
    };
    reader.onerror=()=>notice('Không tạo được tệp tải xuống. Vui lòng xuất lại.',true);
    reader.readAsDataURL(blob);
  }
  $('export').onclick=async()=>{try{if(messages().some(m=>m.kind!=='text'&&!m.images.length))throw Error('Hãy chọn ảnh cho các tin ảnh trước khi xuất.');if(!messages().length||messages().some(m=>m.kind==='text'&&!m.text.trim()))throw Error('Hãy nhập nội dung hoặc xóa tin nhắn trống trước khi xuất.');await draw();if(overflow)return notice('Chưa xuất: nội dung đang vượt khung. Hãy tách slide hoặc giảm cỡ chữ.',true);const blob=await new Promise(resolve=>$('canvas').toBlob(resolve,'image/png'));if(!blob)throw Error('Không tạo được PNG.');download(blob,`content-zalo-${String(slide+1).padStart(2,'0')}.png`);notice('Đã xuất PNG của slide hiện tại.');}catch(e){notice(e.message,true);}};
  function zipImages(files){
    const enc=new TextEncoder(),parts=[],directory=[];let offset=0;
    const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
    for(const file of files){
      const name=enc.encode(file.name),data=file.data;let crc=0xffffffff;
      for(const b of data)crc=table[(crc^b)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
      const local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
      lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(12,33,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);local.set(name,30);
      const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);central.set(name,46);
      parts.push(local,data);directory.push(central);offset+=local.length+data.length;
    }
    const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,directory.reduce((n,x)=>n+x.length,0),true);ev.setUint32(16,offset,true);
    return new Blob([...parts,...directory,end],{type:'application/zip'});
  }
  const exportAll=document.createElement('button');exportAll.id='cc-export-all';exportAll.className='btn-primary';exportAll.textContent='↓ Tải tất cả ảnh (ZIP)';$('export').after(exportAll);
  exportAll.onclick=async()=>{
    const originalSlide=slide;root.inert=true;exportAll.disabled=true;
    try{
      const files=[];
      for(let i=0;i<state.slides.length;i++){
        slide=i;const ms=messages();
        if(!ms.length||ms.some(m=>m.kind==='text'?!m.text.trim():!m.images.length))throw Error(`Slide ${i+1} còn nội dung hoặc ảnh trống.`);
        notice(`Đang xuất ảnh ${i+1}/${state.slides.length}…`);await draw();
        if(overflow)throw Error(`Slide ${i+1} vượt khung. Hãy tách nội dung trước khi tải.`);
        const blob=await new Promise(resolve=>$('canvas').toBlob(resolve,'image/png'));
        if(!blob)throw Error(`Không tạo được ảnh slide ${i+1}.`);
        files.push({name:`content-zalo-${String(i+1).padStart(2,'0')}.png`,data:new Uint8Array(await blob.arrayBuffer())});
      }
      root.inert=false;download(zipImages(files),'content-zalo-tat-ca-anh.zip');notice(`Đã đóng gói ${files.length} ảnh. Chọn nơi lưu trong hộp thoại macOS.`);
    }catch(e){notice(e.message,true);}finally{slide=originalSlide;root.inert=false;exportAll.disabled=false;await draw();}
  };
  $('save').onclick=()=>download(new Blob([JSON.stringify(state)],{type:'application/json'}),'content-zalo-project.json');
  function validate(d){
    const img=s=>typeof s==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
    if(!d||d.version!==1||typeof d.name!=='string'||d.name.length>60||!['portrait','feed','square'].includes(d.ratio)||!Number.isFinite(d.font)||d.font<24||d.font>52||typeof d.header!=='boolean'||(d.avatar!==''&&!img(d.avatar))||!Array.isArray(d.slides)||!d.slides.length||d.slides.length>100)throw Error('File dự án không hợp lệ.');
    for(const s of d.slides){if(s.title!==undefined&&(typeof s.title!=='string'||s.title.length>50))throw Error('Tên slide không hợp lệ.');if(!Array.isArray(s.messages)||s.messages.length>100)throw Error('Slide không hợp lệ.');for(const m of s.messages){if(!['in','out'].includes(m.side)||!['text','image','cover'].includes(m.kind)||typeof m.text!=='string'||m.text.length>1800||typeof m.time!=='string'||!/^$|^\d{2}:\d{2}$/.test(m.time)||!Array.isArray(m.images)||m.images.length>4||!m.images.every(img)||(m.kind==='cover'&&(s.messages.length!==1||m.images.length>1)))throw Error('Tin nhắn trong dự án không hợp lệ.');}}return d;
  }
  $('open').onclick=()=>$('project-file').click();
  $('project-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>80*1024*1024)throw Error('File dự án tối đa 80 MB.');const imported=validate(JSON.parse(await f.text()));await Promise.all([imported.avatar,...imported.slides.flatMap(s=>s.messages.flatMap(m=>m.images))].filter(Boolean).map(loadImage));state=imported;slide=0;resetEditor();settings();openWorkspace();update();notice('Đã mở dự án.');}catch(e){notice(e.message,true);}e.target.value='';};
  settings();list();draw().catch(e=>notice(e.message,true));
  // Avoid a late draft load overwriting edits made during database startup.
  let interacted=false;root.addEventListener('input',()=>{interacted=true;},{once:true});root.addEventListener('click',()=>{interacted=true;},{once:true});
  const request=indexedDB.open('ai-design-content-studio',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
  request.onsuccess=()=>{db=request.result;const r=db.transaction('drafts').objectStore('drafts').get('current');r.onsuccess=()=>{if(r.result&&!interacted){try{state=validate(r.result);$('resume').hidden=false;settings();list();draw().catch(e=>notice(e.message,true));}catch{notice('Bản nháp cũ không đọc được. Có thể mở bản dự án đã tải về.',true);}}};};request.onerror=()=>notice('Trình duyệt không cho lưu nháp. Hãy dùng Lưu bản dự án.',true);
window.zaloStudio = { async applyDraft(draft) {
    validate(draft);
    if (db) { const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(JSON.parse(JSON.stringify(state)),'before-assistant'); }
    await Promise.all(draft.slides.flatMap(s=>s.messages.flatMap(m=>m.images)).map(loadImage));
    state=draft;slide=0;settings();resetEditor();openWorkspace();update();return true;
  }};
})();
