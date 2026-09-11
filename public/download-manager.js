(() => {
  let busy=false;
  const bar=document.createElement('div');
  bar.style.cssText='position:fixed;bottom:16px;right:18px;z-index:9000;background:#fff;color:#222;border:1px solid #ccc;border-radius:12px;padding:10px;box-shadow:0 3px 16px #0002;max-width:360px';
  const button=document.createElement('button');button.className='btn-ghost sm';button.textContent='↓ Tải tất cả ảnh đang xem';
  const status=document.createElement('div');status.style.cssText='font-size:12px;margin-top:5px';
  bar.append(button,status);document.body.append(bar);
  async function save(blob,name){
    if(busy)throw Error('Hãy hoàn tất hộp chọn nơi lưu đang mở.');
    busy=true;button.disabled=true;status.textContent='Đang mở hộp chọn nơi lưu…';
    try{
      const local = location.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
      if (!local) {
        if (typeof window.showSaveFilePicker === 'function') {
          try {
            const handle = await window.showSaveFilePicker({suggestedName:name});
            const writable = await handle.createWritable();
            await writable.write(blob); await writable.close();
          } catch (e) {
            if (e.name === 'AbortError') { status.textContent='Đã huỷ lưu file.'; return 'cancelled'; }
            throw e;
          }
        } else {
          const url=URL.createObjectURL(blob), a=document.createElement('a');
          a.href=url; a.download=name; document.body.appendChild(a);
          original.call(a); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
        }
        status.textContent='✓ Đã chuyển file cho trình duyệt lưu.';
        return 'saved';
      }
      const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});
      const response=await fetch('/api/local-save-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,data})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'Không lưu được file');
      status.textContent=result.status==='saved'?'✓ Đã lưu vào nơi bạn chọn.':'Đã huỷ lưu file.';
      return result.status;
    }catch(e){status.textContent=e.message;throw e;}finally{busy=false;button.disabled=false;}
  }
  window.saveToolFile=save;
  async function saveLink(a){try{const r=await fetch(a.href);if(!r.ok)throw Error('Không đọc được file tải xuống');await save(await r.blob(),a.download||'download.png');}catch(e){status.textContent=e.message;}}
  const original=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download')&&this.href){void saveLink(this);return;}return original.call(this);};
  document.addEventListener('click',e=>{const a=e.target.closest('a[download]');if(a){e.preventDefault();e.stopImmediatePropagation();void saveLink(a);}},true);
  button.onclick=async()=>{
    try{
      const source=[...document.querySelectorAll('[id^="view-"]')].find(x=>x.getClientRects().length);
      if(source?.id==='view-chatcontent'){source.querySelector('#cc-export-all')?.click();return;}
      const images=[...new Set([...((source||document).querySelectorAll('img'))].filter(im=>im.getClientRects().length&&im.naturalWidth>=160&&im.naturalHeight>=160).map(im=>im.currentSrc||im.src))];
      if(!images.length)throw Error('Chưa có ảnh trong phần đang xem.');
      if(images.length>100)throw Error('Phần này có hơn 100 ảnh. Hãy dùng nút tải theo bộ của phần này.');
      status.textContent=`Đang đóng gói ${images.length} ảnh…`;
      const items=await Promise.all(images.map(async(url,i)=>{if(url.startsWith('blob:')){const b=await (await fetch(url)).blob();url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(b);});}return url.startsWith('data:')?{data:url,name:'anh-'+(i+1)}:{url,name:'anh-'+(i+1)};}));
      const r=await fetch('/api/download-zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});
      if(!r.ok)throw Error((await r.json()).error||'Không đóng gói được ảnh');
      await save(await r.blob(),'tat-ca-anh.zip');
    }catch(e){status.textContent=e.message;}
  };
})();
