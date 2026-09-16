(() => {
  let busy = false, preparedUrl = null;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;bottom:16px;right:18px;z-index:9000;background:#fff;color:#222;border:1px solid #ccc;border-radius:12px;padding:10px;box-shadow:0 3px 16px #0002;max-width:360px';
  const button = document.createElement('button');
  button.className = 'btn-ghost sm'; button.textContent = '↓ Tải tất cả ảnh đang xem';
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;margin-top:5px';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const manualLink = document.createElement('a');
  manualLink.style.cssText = 'display:none;margin-top:8px;text-decoration:underline';
  bar.append(button, status, manualLink); document.body.append(bar);
  const original = HTMLAnchorElement.prototype.click;
  const readyLinks = new WeakSet([manualLink]);

  function browserDownload(blob, name) {
    preparedUrl = URL.createObjectURL(blob);
    manualLink.href = preparedUrl; manualLink.download = name;
    manualLink.textContent = '↓ Tải ' + name;
    manualLink.style.display = 'block';
    // Keep a real link available: embedded browsers may block the automatic click.
    try {
      original.call(manualLink);
      status.textContent = 'Đã gửi yêu cầu tải file. Nếu chưa thấy file, bấm liên kết bên dưới.';
      return 'downloaded';
    } catch (_) {
      status.textContent = 'File đã sẵn sàng. Bấm liên kết bên dưới để tải về.';
      return 'ready';
    }
  }

  // A factory lets callers open the picker during the user's click, before fetch/canvas work.
  async function save(blobOrFactory, name, options = {}) {
    if (busy) throw Error('Đang chuẩn bị hoặc lưu file. Vui lòng đợi tác vụ hiện tại hoàn tất.');
    busy = true; button.disabled = true;
    const makeBlob = typeof blobOrFactory === 'function' ? blobOrFactory : () => blobOrFactory;
    name = String(name || 'download.png').replace(/[\\/:*?"<>|]/g, '-').slice(0, 180);
    if (preparedUrl) { URL.revokeObjectURL(preparedUrl); preparedUrl = null; }
    manualLink.style.display = 'none';
    try {
      if (options.directDownload) {
        status.textContent = 'Đang chuẩn bị file…';
        return browserDownload(await makeBlob(), name);
      }
      const local = location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      if (local) {
        status.textContent = 'Đang chuẩn bị file…';
        const blob = await makeBlob();
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        status.textContent = 'Đang mở hộp chọn nơi lưu…';
        const response = await fetch('/api/local-save-file', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, data})});
        const result = await response.json();
        if (!response.ok) throw Error(result.error || 'Không lưu được file');
        status.textContent = result.status === 'saved' ? '✓ Đã lưu vào nơi bạn chọn.' : 'Đã huỷ lưu file.';
        return result.status;
      }

      let handle = null;
      if (typeof window.showSaveFilePicker === 'function') {
        status.textContent = 'Đang mở hộp chọn nơi lưu…';
        try {
          handle = await window.showSaveFilePicker({suggestedName: name});
        } catch (error) {
          if (error.name === 'AbortError') { status.textContent = 'Đã huỷ lưu file.'; return 'cancelled'; }
          // Some embedded browsers expose the API but disallow its use.
          if (!['SecurityError', 'NotAllowedError', 'NotSupportedError'].includes(error.name)) throw error;
        }
      }
      status.textContent = 'Đang chuẩn bị file…';
      const blob = await makeBlob();
      if (!handle) return browserDownload(blob, name);
      status.textContent = 'Đang lưu file…';
      const writable = await handle.createWritable();
      try { await writable.write(blob); await writable.close(); }
      catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
      status.textContent = '✓ Đã lưu vào nơi bạn chọn.';
      return 'saved';
    } catch (error) {
      status.textContent = error.message || 'Không lưu được file.'; throw error;
    } finally { busy = false; button.disabled = false; }
  }
  window.saveToolFile = save;

  async function saveLink(anchor) {
    try {
      await save(async () => {
        const response = await fetch(anchor.href);
        if (!response.ok) throw Error('Không đọc được file tải xuống');
        return response.blob();
      }, anchor.download || 'download.png');
    } catch (error) { status.textContent = error.message; }
  }
  HTMLAnchorElement.prototype.click = function () {
    if (!readyLinks.has(this) && this.hasAttribute('download') && this.href) { void saveLink(this); return; }
    return original.call(this);
  };
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a[download]');
    if (anchor && !readyLinks.has(anchor)) {
      event.preventDefault(); event.stopImmediatePropagation(); void saveLink(anchor);
    }
  }, true);
  button.onclick = async () => {
    try {
      const source = [...document.querySelectorAll('[id^="view-"]')].find(view => view.getClientRects().length);
      if (source?.id === 'view-chatcontent') { source.querySelector('#cc-export-all')?.click(); return; }
      if (source?.id === 'view-tiktok' && typeof window.downloadTiktokAll === 'function') {
        await window.downloadTiktokAll(); return;
      }
      const images = [...new Set([...((source || document).querySelectorAll('img'))]
        .filter(image => image.getClientRects().length && image.naturalWidth >= 160 && image.naturalHeight >= 160)
        .map(image => image.currentSrc || image.src))];
      if (!images.length) throw Error('Chưa có ảnh trong phần đang xem.');
      if (images.length > 100) throw Error('Phần này có hơn 100 ảnh. Hãy dùng nút tải theo bộ của phần này.');
      await save(async () => {
        status.textContent = `Đang đóng gói ${images.length} ảnh…`;
        const items = await Promise.all(images.map(async (sourceUrl, index) => {
          let url = sourceUrl;
          if (url.startsWith('blob:')) {
            const blob = await (await fetch(url)).blob();
            url = await new Promise((resolve, reject) => {
              const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
          return url.startsWith('data:') ? {data: url, name: 'anh-' + (index + 1)} : {url, name: 'anh-' + (index + 1)};
        }));
        const response = await fetch('/api/download-zip', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({items})});
        if (!response.ok) throw Error((await response.json()).error || 'Không đóng gói được ảnh');
        return response.blob();
      }, 'tat-ca-anh.zip');
    } catch (error) { status.textContent = error.message; }
  };
})();
