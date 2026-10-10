/* Browser sessions stay transient; media is saved after the user chooses a destination. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const form = el('socialDownloadForm');
  if (!form) return;
  let initialized = false, activeRequest = null, elapsedTimer = null, result = null, previewSession = null;
  let douyinConnected = false, extensionAvailable = false, connectionRequest = null, saveRequest = null;
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
      const error = Error('Phiên Douyin chưa hợp lệ. Đăng nhập Douyin trên Edge rồi thử tải lại.');
      error.code = data.loggedIn === true ? 'FAILED' : 'LOGIN_REQUIRED';
      throw error;
    }
    return {douyin_cookie: data.cookie, douyin_user_agent: data.userAgent};
  }
  function disconnectDouyin() {
    connectionRequest?.abort();
    connectionRequest = null;
    connected(false);
    window.postMessage({source: 'aidesign-douyin-page', type: 'DISCONNECT', requestId: crypto.randomUUID(), nonce: bridgeNonce}, location.origin);
    connectionStatus(extensionAvailable
      ? 'Tiện ích sẵn sàng. Dán link rồi bấm Lấy video / ảnh để tự dùng phiên Douyin trên Edge.'
      : 'Chưa kết nối tiện ích Douyin. Cài tiện ích một lần để tự dùng phiên trên Edge.');
  }
  function connectionError(error) {
    disconnectDouyin();
    connectionStatus(error.message || 'Chưa kết nối được Douyin.', 'error');
    if (error.code === 'EXTENSION_MISSING') el('socialDownloadInstallHelp').open = true;
    if (error.code === 'LOGIN_REQUIRED') connectionStatus('Mở Douyin bên dưới, đăng nhập trên Edge rồi dán link và thử tải lại.', 'error');
  }
  el('socialDownloadConnectDouyin').addEventListener('click', async () => {
    if (activeRequest || saveRequest || connectionRequest) return;
    const controller = new AbortController();
    connectionRequest = controller;
    el('socialDownloadConnectDouyin').disabled = true;
    connectionStatus('Đang kết nối phiên Douyin trên trình duyệt…');
    try {
      const data = await extensionRequest('CONNECT', {signal: controller.signal});
      if (connectionRequest !== controller) return;
      if (data.loggedIn !== true) {
        const error = Error('Đăng nhập Douyin trên Edge rồi thử tải lại.');
        error.code = 'LOGIN_REQUIRED';
        throw error;
      }
      extensionAvailable = true;
      connected(true);
      el('socialDownloadInstallHelp').open = false;
      connectionStatus('Đã kết nối. Dán link và bấm Lấy video / ảnh; tool tự dùng phiên Douyin của bạn.', 'success');
    } catch (error) {
      if (connectionRequest === controller && error.name !== 'AbortError') connectionError(error);
    } finally {
      if (connectionRequest === controller) connectionRequest = null;
      el('socialDownloadConnectDouyin').disabled = !!activeRequest || !!saveRequest;
    }
  });
  // Detection shares no login data; cookies are read only after a real user action.
  const extensionDetection = extensionRequest('STATUS').then(() => {
    extensionAvailable = true;
    if (!connectionRequest && !douyinConnected) connectionStatus('Tiện ích sẵn sàng. Dán link rồi bấm Lấy video / ảnh; tool tự dùng phiên Douyin trên Edge.');
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
    const wasSaving = !!saveRequest;
    const hadWork = !!activeRequest || wasSaving;
    activeRequest?.abort();
    activeRequest = null;
    saveRequest?.abort();
    saveRequest = null;
    window.cancelSocialDownloadSave?.();
    setBusy(false);
    if (hadWork) status(wasSaving ? 'Đã huỷ lưu file.' : message);
  }
  function saveDownload(url, filename) {
    if (activeRequest || connectionRequest || saveRequest) {
      status('Đang xử lý một thao tác. Hãy đợi hoàn tất hoặc bấm Huỷ.');
      return Promise.resolve({status: 'busy'});
    }
    if (typeof window.saveSocialDownload !== 'function') {
      status('Chưa tải được chức năng chọn nơi lưu. Tải lại trang rồi thử lại.', 'error');
      return Promise.resolve({status: 'failed'});
    }
    const controller = new AbortController();
    saveRequest = controller;
    let saving;
    try {
      // This call must stay in the original click stack so the picker can open.
      saving = window.saveSocialDownload(localAsset(url), filename, {signal: controller.signal});
    } catch (error) {
      saveRequest = null;
      status(error.message || 'Không mở được hộp chọn nơi lưu file.', 'error');
      return Promise.resolve({status: 'failed'});
    }
    setBusy(true);
    status('Chọn nơi lưu file. Sau khi bạn chọn, tool sẽ tải và lưu file vào đó.');
    return Promise.resolve(saving).then(outcome => {
      if (!['saved', 'cancelled'].includes(outcome?.status)) throw Error('Chưa xác nhận được file đã lưu. Hãy thử lại.');
      if (saveRequest === controller) status(outcome?.status === 'cancelled' ? 'Đã huỷ lưu file.' : 'Đã lưu file vào nơi bạn chọn.', outcome?.status === 'cancelled' ? '' : 'success');
      return outcome;
    }).catch(error => {
      if (saveRequest === controller) status(error.name === 'AbortError' ? 'Đã huỷ lưu file.' : error.message || 'Không lưu được file. Hãy thử lại.', error.name === 'AbortError' ? '' : 'error');
      return {status: error.name === 'AbortError' ? 'cancelled' : 'failed'};
    }).finally(() => {
      if (saveRequest === controller) { saveRequest = null; setBusy(false); }
    });
  }
  function downloadLink(url, filename, label) {
    const anchor = document.createElement('a');
    anchor.className = 'btn-ghost sm';
    anchor.href = localAsset(url);
    anchor.download = '';
    anchor.dataset.nativeDownload = '';
    anchor.textContent = label;
    anchor.addEventListener('click', event => {
      event.preventDefault();
      return saveDownload(anchor.href, filename);
    });
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
      if (result === data && !activeRequest && !saveRequest) status('Không tải được bản xem trước. Hãy lấy lại link hoặc thử nút tải file.', 'error');
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
      caption.append(number, downloadLink(item.download_url, item.filename, item.kind === 'video' ? '↓ Tải video' : '↓ Tải ảnh'));
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
    if (activeRequest || saveRequest || connectionRequest) return;
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
        if (!extensionAvailable) await extensionDetection;
        if (activeRequest !== controller) return;
        if (extensionAvailable) {
          const session = await extensionRequest('SESSION', {signal: controller.signal});
          if (activeRequest !== controller) return;
          Object.assign(body, sessionCredentials(session));
          connected(true);
          el('socialDownloadInstallHelp').open = false;
          connectionStatus('Đã dùng phiên Douyin trên Edge. Những lần sau chỉ cần dán link rồi bấm Lấy video / ảnh.', 'success');
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
  function zipFilename() {
    return result.platform + '-' + (result.post_id || 'anh-cuon') + '-images.zip';
  }
  el('socialDownloadAll').addEventListener('click', event => {
    event.preventDefault();
    if (!result?.zip_url) return;
    return saveDownload(result.zip_url, zipFilename());
  });
  window.downloadSocialAll = () => {
    if (!result) throw Error('Chưa có video hoặc ảnh để tải.');
    const item = result.items[0];
    const url = result.type === 'images' ? result.zip_url : item.download_url;
    if (!url) throw Error('Chưa có file tải xuống cho bài đăng này.');
    return saveDownload(url, result.type === 'images' ? zipFilename() : item.filename);
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
