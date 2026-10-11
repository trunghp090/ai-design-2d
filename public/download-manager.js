/* Hand files to the browser so Downloads owns their progress and destination. */
(() => {
  'use strict';
  if (window.saveToolFile && window.downloadToolURL) return;
  const RETAIN_MS = 10 * 60 * 1000, MAX_BYTES = 300 * 1024 * 1024;
  let queue = Promise.resolve(), pending = 0;
  const original = HTMLAnchorElement.prototype.click, readyLinks = new WeakSet();
  const bar = document.createElement('div');
  bar.id = 'toolDownloads';
  bar.style.cssText = 'position:fixed;bottom:16px;right:18px;z-index:9000;background:#fff;color:#222;border:1px solid #ccc;border-radius:12px;padding:10px;box-shadow:0 3px 16px #0002;max-width:360px';
  const button = document.createElement('button');
  button.className = 'btn-ghost sm'; button.textContent = '↓ Tải tất cả ảnh đang xem';
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;margin-top:5px';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const help = document.createElement('a');
  help.href = '/download-help.html'; help.target = '_blank'; help.rel = 'noopener';
  help.textContent = 'Cách hỏi nơi lưu mỗi lần tải'; help.style.cssText = 'display:block;font-size:12px;margin-top:5px;text-decoration:underline';
  const retries = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = 'Liên kết tải lại'; retries.append(summary);
  retries.style.cssText = 'display:none;font-size:12px;margin-top:8px;max-height:160px;overflow:auto';
  bar.append(button, status, help, retries);
  const framed = window.top && window.top !== window;
  bar.hidden = !!framed;
  document.body.append(bar);

  function filename(value) {
    return String(value || 'download.png').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-').trim().slice(0, 180) || 'download.png';
  }
  function address(value) {
    if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f\\]/.test(value)) throw Error('Đường dẫn tải file không hợp lệ.');
    const url = new URL(value, location.href);
    if (url.username || url.password || !['https:', 'http:', 'blob:', 'data:'].includes(url.protocol)
        || (url.protocol === 'blob:' && url.origin !== location.origin)) throw Error('Đường dẫn tải file không hợp lệ.');
    return url;
  }
  function nativeDownload(url, name, options = {}) {
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename(name); anchor.setAttribute('data-native-download', '');
    anchor.textContent = '↓ Tải lại ' + anchor.download;
    anchor.style.cssText = 'display:block;margin-top:5px;text-decoration:underline';
    readyLinks.add(anchor); retries.append(anchor); retries.style.display = 'block';
    try {
      original.call(anchor);
      status.textContent = 'Đã gửi ' + anchor.download + ' cho trình duyệt. Xem tiến độ và nơi lưu trong Downloads.';
      try { options.onDispatched?.(); } catch (_) {}
      return 'downloaded';
    } catch (_) {
      retries.open = true;
      if (framed) { bar.hidden = false; button.style.display = 'none'; }
      status.textContent = 'File đã sẵn sàng. Bấm liên kết tải lại bên dưới để tải về.';
      return 'ready';
    }
  }
  function browserDownload(blob, name) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_BYTES) throw Error('File trống hoặc vượt giới hạn 300 MB.');
    const url = URL.createObjectURL(blob);
    const outcome = nativeDownload(url, name);
    const link = retries.children[retries.children.length - 1];
    // Each file retains an independent URL while a download or retry can begin.
    setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, RETAIN_MS);
    return outcome;
  }
  window.saveToolFile = (blobOrFactory, name) => {
    const makeBlob = typeof blobOrFactory === 'function' ? blobOrFactory : () => blobOrFactory;
    pending++; button.disabled = true;
    const work = queue.then(async () => {
      status.textContent = 'Đang chuẩn bị file…';
      try { return browserDownload(await makeBlob(), name); }
      catch (error) { status.textContent = error.message || 'Không chuẩn bị được file.'; throw error; }
      finally { pending--; button.disabled = pending > 0; }
    });
    queue = work.catch(() => {});
    return work;
  };
  window.downloadToolURL = (value, name, options = {}) => {
    try {
      const url = address(value);
      if (url.origin === location.origin || ['blob:', 'data:'].includes(url.protocol)) {
        // Keep direct media handoff in the user's click stack, without buffering.
        return Promise.resolve(nativeDownload(url.href, name, options));
      }
      return window.saveToolFile(async () => {
        const response = await fetch(url.href);
        if (!response.ok) throw Error('Không đọc được file tải xuống.');
        return response.blob();
      }, name);
    } catch (error) { return Promise.reject(error); }
  };
  window.downloadToolFiles = (items, name = 'bo-anh.zip') => {
    if (!Array.isArray(items) || !items.length || items.length > 100) return Promise.reject(Error('Chọn từ 1 đến 100 ảnh để tải ZIP.'));
    let snapshot;
    try {
      snapshot = items.map(item => {
        if (!item || typeof item !== 'object' || !(item.id || item.url || item.data)) throw Error('Có ảnh chưa có dữ liệu tải xuống.');
        return {...(item.id ? {id: item.id} : {}), ...(item.url ? {url: item.url} : {}), ...(item.data ? {data: item.data} : {}), name: item.name || 'anh'};
      });
    } catch (error) { return Promise.reject(error); }
    return window.saveToolFile(async () => {
      const response = await fetch('/api/download-zip', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({items: snapshot})});
      if (!response.ok) throw Error((await response.json()).error || 'Không đóng gói được bộ ảnh.');
      return response.blob();
    }, name);
  };
  function saveLink(anchor) {
    void window.downloadToolURL(anchor.href, anchor.download || 'download.png').catch(error => { status.textContent = error.message; });
  }
  HTMLAnchorElement.prototype.click = function () {
    if (!readyLinks.has(this) && !this.hasAttribute('data-native-download') && this.hasAttribute('download') && this.href) { saveLink(this); return; }
    return original.call(this);
  };
  document.addEventListener('click', event => {
    if (event.defaultPrevented) return;
    const anchor = event.target.closest?.('a[download]');
    if (anchor && !readyLinks.has(anchor) && !anchor.hasAttribute('data-native-download')) {
      event.preventDefault(); event.stopImmediatePropagation(); saveLink(anchor);
    }
  }, true);
  button.onclick = async () => {
    try {
      const source = [...document.querySelectorAll('[id^="view-"]')].find(view => view.getClientRects().length);
      if (source?.id === 'view-chatcontent') { source.querySelector('#cc-export-all')?.click(); return; }
      if (source?.id === 'view-socialdownload' && typeof window.downloadSocialAll === 'function') { await window.downloadSocialAll(); return; }
      if (source?.id === 'view-tiktok' && typeof window.downloadTiktokAll === 'function') { await window.downloadTiktokAll(); return; }
      const images = [...new Set([...((source || document).querySelectorAll('img'))]
        .filter(image => image.getClientRects().length && image.naturalWidth >= 160 && image.naturalHeight >= 160)
        .map(image => image.currentSrc || image.src))];
      if (!images.length) throw Error('Chưa có ảnh trong phần đang xem.');
      if (images.length > 100) throw Error('Phần này có hơn 100 ảnh. Hãy dùng nút tải theo bộ của phần này.');
      const items = await Promise.all(images.map(async (sourceUrl, index) => {
        let url = sourceUrl;
        if (url.startsWith('blob:')) {
          const response = await fetch(url);
          if (!response.ok) throw Error('Không đọc được ảnh trong bộ.');
          const blob = await response.blob();
          url = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
        return url.startsWith('data:') ? {data: url, name: 'anh-' + (index + 1)} : {url, name: 'anh-' + (index + 1)};
      }));
      await window.downloadToolFiles(items, 'tat-ca-anh.zip');
    } catch (error) { status.textContent = error.message; }
  };
})();
