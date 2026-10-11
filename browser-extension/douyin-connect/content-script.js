/* Isolated world: consent and connection exist only in this document's memory. */
(() => {
  'use strict';
  const ORIGINS = new Set(['https://riengvnapp.cloud', 'http://localhost:8000', 'http://127.0.0.1:8000']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const TYPES = new Set(['STATUS', 'CONNECT', 'SESSION', 'DISCONNECT']);
  if (window.top !== window || !ORIGINS.has(location.origin)) return;
  let nonce = '', connected = false, epoch = 0, active = null;
  let activation = null;
  const seen = new Set();

  function consent(type) {
    activation = {type, expires: Date.now() + 5000};
  }
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const button = event.target?.closest?.('button');
    if (button?.id === 'socialDownloadConnectDouyin') consent('CONNECT');
    if (button?.id === 'socialDownloadResolve') consent('SESSION');
  }, true);
  document.addEventListener('keydown', event => {
    if (event.isTrusted && event.key === 'Enter' && !event.isComposing
        && event.target?.id === 'socialDownloadInput') consent('SESSION');
  }, true);
  document.addEventListener('submit', event => {
    if (event.isTrusted && event.target?.id === 'socialDownloadForm'
        && navigator.userActivation?.isActive) consent('SESSION');
  }, true);

  function respond(request, result) {
    window.postMessage({source: 'aidesign-douyin-extension', type: 'RESPONSE',
      requestId: request.requestId, nonce: request.nonce, version: chrome.runtime.getManifest().version, connected, ...result}, location.origin);
  }
  function failed(request, code = 'FAILED', error = 'Chưa đọc được phiên Douyin. Hãy bấm Lấy video / ảnh để thử lại.') {
    respond(request, {ok: false, code, error});
  }
  function valid(request) {
    return request && typeof request === 'object' && !Array.isArray(request)
      && request.source === 'aidesign-douyin-page' && TYPES.has(request.type)
      && UUID.test(request.requestId || '') && UUID.test(request.nonce || '')
      && Object.keys(request).every(key => ['source', 'type', 'requestId', 'nonce'].includes(key));
  }
  window.addEventListener('message', event => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin || !valid(request)) return;
    if (!nonce && request.type === 'STATUS') nonce = request.nonce;
    if (request.nonce !== nonce || seen.has(request.requestId)) return;
    seen.add(request.requestId);
    if (seen.size > 100) seen.delete(seen.values().next().value);
    if (request.type === 'STATUS') { respond(request, {ok: true}); return; }
    if (request.type === 'DISCONNECT') {
      connected = false;
      activation = null;
      epoch++;
      active = null;
      respond(request, {ok: true});
      return;
    }
    if (!activation || activation.type !== request.type || activation.expires < Date.now() || active) {
      failed(request, 'FAILED', 'Hãy bấm nút Kết nối Douyin hoặc Lấy video / ảnh để tiếp tục.');
      return;
    }
    activation = null;
    const generation = epoch;
    active = request.requestId;
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (generation !== epoch || active !== request.requestId) return;
      active = null;
      if (!result?.ok || result.loggedIn !== true || (request.type === 'SESSION'
          && (typeof result.cookie !== 'string' || !result.cookie || result.cookie.length > 16000
              || /[^\x20-\x7e]/.test(result.cookie)))) {
        if (result?.code === 'LOGIN_REQUIRED') connected = false;
        failed(request, result?.code === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'FAILED',
          result?.code === 'LOGIN_REQUIRED' ? 'Hãy đăng nhập Douyin trong trình duyệt này rồi bấm Lấy video / ảnh lại.' : undefined);
        return;
      }
      if (request.type === 'CONNECT') {
        connected = true;
        respond(request, {ok: true, loggedIn: true});
        return;
      }
      const userAgent = navigator.userAgent;
      if (typeof userAgent !== 'string' || !userAgent || userAgent.length > 512 || /[^\x20-\x7e]/.test(userAgent)) {
        failed(request);
        return;
      }
      connected = true;
      respond(request, {ok: true, cookie: result.cookie, userAgent, loggedIn: true});
    };
    const timer = setTimeout(() => finish(null), 5000);
    try {
      chrome.runtime.sendMessage({source: 'aidesign-douyin-content', type: request.type,
        requestId: request.requestId, nonce}, response => {
        if (chrome.runtime.lastError) { finish(null); return; }
        finish(response);
      });
    } catch (_) { finish(null); }
  });
  window.addEventListener('pagehide', () => {
    connected = false;
    activation = null;
    epoch++;
    active = null;
  });
})();
