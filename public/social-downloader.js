/* Native server attachments keep large videos out of the base64/local-save flow. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const form = el('socialDownloadForm');
  if (!form) return;
  let initialized = false, activeRequest = null, elapsedTimer = null, result = null, previewSession = null;
  let douyinConnected = false, connectionRequest = null;
  const bridgeNonce = crypto.randomUUID(), pendingBridge = new Map();
  function aborted() { const error = Error('Đã huỷ kết nối.'); error.name = 'AbortError'; return error; }
  function connectionStatus(message, state = '') {
    el('socialDownloadConnectionStatus').textContent = message;
    el('socialDownloadConnectionStatus').dataset.state = state;
  }
  function connected(value) {
    douyinConnected = value;
    el('socialDownloadConnectDouyin').textContent = value ? '✓ Douyin đã kết nối' : 'Kết nối Douyin';
  }
  function extensionRequest(type, {signal, timeout = type === 'STATUS' ? 2000 : 6000} = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (data, error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onabort);
        pendingBridge.delete(requestId);
        error ? reject(error) : resolve(data);
      };
      const onabort = () => finish(null, aborted());
      const timer = setTimeout(() => {
        const error = Error('Chưa tìm thấy tiện ích. Cài tiện ích kết nối Douyin một lần rồi tải lại trang tool.');
        error.code = 'EXTENSION_MISSING';
        finish(null, error);
      }, timeout);
      pendingBridge.set(requestId, finish);
      signal?.addEventListener('abort', onabort, {once: true});
      window.postMessage({source: 'aidesign-douyin-page', type, requestId, nonce: bridgeNonce}, location.origin);
    });
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data ||
        data.source !== 'aidesign-douyin-extension' || data.type !== 'RESPONSE' || data.nonce !== bridgeNonce) return;
    const finish = pendingBridge.get(data.requestId);
    if (!finish) return;
    if (data.ok !== true) {
      const error = Error(typeof data.error === 'string' ? data.error.slice(0, 300) : 'Chưa kết nối được Douyin.');
      error.code = data.code;
      finish(null, error);
    } else finish(data);
  });
  function sessionCredentials(data) {
    if (data.loggedIn !== true || typeof data.cookie !== 'string' || !data.cookie || data.cookie.length > 16000 || /[\r\n]/.test(data.cookie) ||
        typeof data.userAgent !== 'string' || !data.userAgent || data.userAgent.length > 512 || /[^\x20-\x7e]/.test(data.userAgent)) {
      throw Error('Phiên Douyin chưa hợp lệ. Đăng nhập Douyin trên Edge rồi kết nối lại.');
    }
    return {douyin_cookie: data.cookie, douyin_user_agent: data.userAgent};
  }
  function disconnectDouyin() {
    connectionRequest?.abort();
    connectionRequest = null;
    connected(false);
    window.postMessage({source: 'aidesign-douyin-page', type: 'DISCONNECT', requestId: crypto.randomUUID(), nonce: bridgeNonce}, location.origin);
    connectionStatus('Đã ngắt kết nối Douyin. Bấm Kết nối Douyin để dùng lại.');
  }
  function connectionError(error) {
    disconnectDouyin();
    connectionStatus(error.message || 'Chưa kết nối được Douyin.', 'error');
    if (error.code === 'EXTENSION_MISSING') el('socialDownloadInstallHelp').open = true;
    if (error.code === 'LOGIN_REQUIRED') connectionStatus('Mở Douyin bên dưới, đăng nhập trên Edge rồi bấm Kết nối Douyin lại.', 'error');
  }
  el('socialDownloadConnectDouyin').addEventListener('click', async () => {
    if (activeRequest || connectionRequest) return;
    const controller = new AbortController();
    connectionRequest = controller;
    el('socialDownloadConnectDouyin').disabled = true;
    connectionStatus('Đang kết nối phiên Douyin trên trình duyệt…');
    try {
      const data = await extensionRequest('CONNECT', {signal: controller.signal});
      if (connectionRequest !== controller) return;
      if (data.loggedIn !== true) throw Error('Đăng nhập Douyin trên Edge rồi kết nối lại.');
      connected(true);
      el('socialDownloadInstallHelp').open = false;
      connectionStatus('Đã kết nối. Dán link và bấm Lấy video / ảnh; tool tự dùng phiên Douyin của bạn.', 'success');
    } catch (error) {
      if (connectionRequest === controller && error.name !== 'AbortError') connectionError(error);
    } finally {
      if (connectionRequest === controller) connectionRequest = null;
      el('socialDownloadConnectDouyin').disabled = !!activeRequest;
    }
  });
  // Detection shares no login data; cookies are read only after a real user action.
  void extensionRequest('STATUS').then(data => {
    if (!connectionRequest && !douyinConnected) connectionStatus('Tiện ích đã sẵn sàng. Bấm Kết nối Douyin để dùng phiên đăng nhập trên Edge.');
  }).catch(() => {});
  const status = (message, state = '') => {
    el('socialDownloadStatus').textContent = message;
    el('socialDownloadStatus').dataset.state = state;
  };
  function inputPlatform(value) {
    const hosts = new Set(['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com', 'www.tiktokv.com', 'douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']);
    for (let candidate of value.match(/https?:\/\/[^\s<>"“”]+/g) || []) {
      candidate = candidate.replace(/[.,;!?)。，；！）\]}']+$/u, '').replace(/^http:/, 'https:');
      if (/[\u0000-\u001f\u007f\\]/.test(candidate)) continue;
      try {
        const url = new URL(candidate);
        if (!hosts.has(url.hostname) || url.port || url.username || url.password) continue;
        return url.hostname.includes('douyin') ? 'douyin' : 'tiktok';
      } catch (_) {}
    }
    return '';
  }
  function localAsset(value) {
    if (typeof value !== 'string' || !value) throw Error('Bài đăng chưa có file tải xuống hợp lệ.');
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/social-download/')) {
      throw Error('Đường dẫn file tải xuống không hợp lệ.');
    }
    return url.href;
  }
  function setBusy(busy) {
    el('socialDownloadResolve').disabled = busy;
    el('socialDownloadInput').readOnly = busy;
    el('socialDownloadDouyinCookie').readOnly = busy;
    el('socialDownloadDouyinUserAgent').readOnly = busy;
    el('socialDownloadConnectDouyin').disabled = busy || !!connectionRequest;
    el('socialDownloadCancel').classList.toggle('hidden', !busy);
    el('socialDownloadProgress').classList.toggle('hidden', !busy);
    form.setAttribute('aria-busy', String(busy));
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    if (busy) {
      const started = Date.now();
      el('socialDownloadElapsed').textContent = '0 giây';
      elapsedTimer = setInterval(() => {
        el('socialDownloadElapsed').textContent = Math.floor((Date.now() - started) / 1000) + ' giây';
      }, 1000);
    }
  }
  function cancel(message = 'Đã huỷ chờ tải. Bạn có thể nhập liên kết khác.') {
    el('socialDownloadDouyinCookie').value = '';
    el('socialDownloadDouyinUserAgent').value = '';
    disconnectDouyin();
    if (!activeRequest) return;
    activeRequest.abort();
    activeRequest = null;
    setBusy(false);
    status(message);
  }
  function downloadLink(url, label) {
    const anchor = document.createElement('a');
    anchor.className = 'btn-ghost sm';
    anchor.href = localAsset(url);
    anchor.download = '';
    anchor.dataset.nativeDownload = '';
    anchor.textContent = label;
    anchor.addEventListener('click', () => status('Đã gửi yêu cầu tải file. Theo dõi tiến trình trong mục tải xuống của trình duyệt.'));
    return anchor;
  }
  function stopPreviews() {
    previewSession?.abort();
    previewSession = null;
  }
  function loadImagePreviews(tasks) {
    const controller = new AbortController();
    previewSession = controller;
    const signal = controller.signal;
    let next = 0;
    const pause = ms => new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, {once: true});
      if (signal.aborted) done();
    });
    async function load(task) {
      const {image, url, label, position, count} = task;
      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
        const loaded = await new Promise(resolve => {
          const finish = success => {
            image.removeEventListener('load', onload);
            image.removeEventListener('error', onerror);
            signal.removeEventListener('abort', onabort);
            resolve(success);
          };
          const onload = () => finish(true);
          const onerror = () => finish(false);
          const onabort = () => { image.removeAttribute('src'); finish(false); };
          image.addEventListener('load', onload, {once: true});
          image.addEventListener('error', onerror, {once: true});
          signal.addEventListener('abort', onabort, {once: true});
          const source = new URL(url);
          if (attempt) source.searchParams.set('_preview_retry', Date.now() + '-' + attempt);
          image.loading = 'eager';
          image.src = source.href;
        });
        if (loaded || signal.aborted) return;
        if (attempt < 2) await pause(attempt === 0 ? 1200 : 3600);
      }
      if (!signal.aborted) {
        image.alt = 'Chưa tải được bản xem trước ảnh ' + (position + 1) + '. Bạn có thể thử nút tải ảnh.';
        label.textContent = 'Ảnh ' + (position + 1) + ' / ' + count + ' · Chưa xem trước';
      }
    }
    async function worker() {
      while (!signal.aborted && next < tasks.length) await load(tasks[next++]);
    }
    // Leave transfer slots available for ZIP export and individual downloads.
    void worker();
    void worker();
  }
  function render(data) {
    if (!data || !['video', 'images'].includes(data.type) || !Array.isArray(data.items) || !data.items.length) {
      throw Error('Không tìm thấy video hoặc ảnh có thể tải từ bài đăng này.');
    }
    // Validate the full result before replacing the currently displayed post.
    data.items.forEach(item => {
      if (!item || !['video', 'image'].includes(item.kind)) throw Error('Dữ liệu file tải xuống không hợp lệ.');
      localAsset(item.download_url);
      localAsset(item.preview_url || item.download_url);
    });
    if (data.type === 'images' && data.zip_url) localAsset(data.zip_url);
    const grid = el('socialDownloadItems');
    const cards = document.createDocumentFragment();
    const imageTasks = [];
    const previewFailed = () => {
      if (result === data && !activeRequest) status('Không tải được bản xem trước. Hãy lấy lại link hoặc thử nút tải file.', 'error');
    };
    data.items.forEach((item, position) => {
      const card = document.createElement('figure');
      const number = document.createElement('span');
      card.className = 'social-download-item';
      card.dataset.index = item.index ?? position + 1;
      if (item.kind === 'video') {
        const video = document.createElement('video');
        video.src = localAsset(item.preview_url || item.download_url);
        video.controls = true;
        video.preload = 'metadata';
        video.playsInline = true;
        video.addEventListener('error', previewFailed);
        card.append(video);
      } else {
        const preview = document.createElement('a');
        preview.className = 'social-download-preview';
        preview.href = localAsset(item.preview_url || item.download_url);
        preview.target = '_blank';
        preview.rel = 'noopener noreferrer';
        preview.setAttribute('aria-label', 'Xem ảnh ' + (position + 1) + ' ở kích thước đầy đủ');
        const image = document.createElement('img');
        image.alt = 'Ảnh ' + (position + 1) + ' trong bài đăng';
        imageTasks.push({image, url: preview.href, label: number, position, count: data.items.length});
        preview.append(image);
        card.append(preview);
      }
      const caption = document.createElement('figcaption');
      number.textContent = item.kind === 'video' ? 'Video' : 'Ảnh ' + (position + 1) + ' / ' + data.items.length;
      caption.append(number, downloadLink(item.download_url, item.kind === 'video' ? '↓ Tải video' : '↓ Tải ảnh'));
      card.append(caption);
      cards.append(card);
    });
    stopPreviews();
    grid.replaceChildren(cards);
    grid.dataset.type = data.type;
    const platform = data.platform === 'douyin' ? 'Douyin' : 'TikTok';
    el('socialDownloadResultTitle').textContent = data.title || (data.type === 'video' ? 'Video ' : 'Bộ ảnh ') + platform;
    el('socialDownloadMeta').textContent = [platform, data.author || '', data.type === 'video' ? 'Video' : data.items.length + ' ảnh'].filter(Boolean).join(' · ');
    const all = el('socialDownloadAll');
    all.classList.toggle('hidden', data.type !== 'images' || !data.zip_url);
    all.removeAttribute('href');
    if (data.type === 'images' && data.zip_url) {
      all.href = localAsset(data.zip_url);
      all.download = '';
      all.textContent = '↓ Tải cả ' + data.items.length + ' ảnh (ZIP)';
    }
    el('socialDownloadEmpty').classList.add('hidden');
    el('socialDownloadResults').classList.remove('hidden');
    result = data;
    status('Đã chuẩn bị ' + (data.type === 'video' ? 'video' : data.items.length + ' ảnh') + '. Chọn file để tải về máy.', 'success');
    if (imageTasks.length) loadImagePreviews(imageTasks);
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (activeRequest || connectionRequest) return;
    const input = el('socialDownloadInput').value.trim();
    if (!input) { status('Dán liên kết TikTok hoặc Douyin trước khi lấy nội dung.', 'error'); el('socialDownloadInput').focus(); return; }
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true);
    status('Đang đọc bài đăng và chuẩn bị file…');
    try {
      const body = {url: input, request_id: crypto.randomUUID()};
      const cookie = el('socialDownloadDouyinCookie').value.trim();
      if (inputPlatform(input) === 'douyin') {
        if (douyinConnected) {
          const session = await extensionRequest('SESSION', {signal: controller.signal});
          if (activeRequest !== controller) return;
          Object.assign(body, sessionCredentials(session));
        } else if (cookie) {
          body.douyin_cookie = cookie;
          const userAgent = el('socialDownloadDouyinUserAgent').value.trim();
          if (userAgent) body.douyin_user_agent = userAgent;
        }
      }
      const response = await fetch('/api/social-download/resolve', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body), signal: controller.signal
      });
      let data;
      try { data = await response.json(); }
      catch (_) { throw Error('Máy chủ chưa trả về dữ liệu hợp lệ. Hãy thử lại.'); }
      if (activeRequest !== controller) return;
      if (!response.ok) throw Error(data.error || 'Không lấy được nội dung. Kiểm tra liên kết rồi thử lại.');
      render(data);
    } catch (error) {
      if (activeRequest !== controller || error.name === 'AbortError') return;
      if (['EXTENSION_MISSING', 'LOGIN_REQUIRED', 'NOT_CONNECTED', 'FAILED'].includes(error.code)) connectionError(error);
      status(error.message || 'Không kết nối được máy chủ. Hãy thử lại.', 'error');
    } finally {
      if (activeRequest === controller) { activeRequest = null; setBusy(false); }
    }
  });
  el('socialDownloadCancel').addEventListener('click', () => cancel());
  el('socialDownloadClear').addEventListener('click', () => {
    cancel();
    stopPreviews();
    result = null;
    el('socialDownloadInput').value = '';
    el('socialDownloadItems').replaceChildren();
    el('socialDownloadResults').classList.add('hidden');
    el('socialDownloadEmpty').classList.remove('hidden');
    el('socialDownloadAll').removeAttribute('href');
    status('');
    el('socialDownloadInput').focus();
  });
  el('socialDownloadAll').addEventListener('click', () => status('Đã gửi yêu cầu tải bộ ảnh ZIP. Theo dõi tiến trình trong mục tải xuống của trình duyệt.'));
  window.downloadSocialAll = () => {
    if (!result) throw Error('Chưa có video hoặc ảnh để tải.');
    const anchor = result.type === 'images' ? el('socialDownloadAll') : el('socialDownloadItems').querySelector('a[data-native-download]');
    if (!anchor?.hasAttribute('href')) throw Error('Chưa có file tải xuống cho bài đăng này.');
    anchor.click();
  };
  window.initSocialDownloader = async () => {
    if (initialized) return;
    initialized = true;
    try {
      const response = await fetch('/api/social-download/config');
      const config = await response.json();
      if (!response.ok) throw Error(config.error || 'Chưa kiểm tra được tính năng tải nội dung.');
      if (config.available === false && !activeRequest && !result) status(config.error || 'Tính năng tải nội dung chưa sẵn sàng trên máy chủ.', 'error');
    } catch (error) {
      initialized = false;
      if (!activeRequest && !result) status(error.message || 'Không kết nối được máy chủ.', 'error');
    }
  };
})();
