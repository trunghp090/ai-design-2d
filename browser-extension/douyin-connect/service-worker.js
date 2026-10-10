/* Reads only the applicable Douyin session after an authorized page request. */
(() => {
  'use strict';
  const ORIGINS = new Set(['https://riengvnapp.cloud', 'http://localhost:8000', 'http://127.0.0.1:8000']);
  const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
  const LOGIN_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_tt']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ERROR = {ok: false, code: 'FAILED', error: 'Chưa kết nối được Douyin. Hãy tải lại trang rồi thử lại.'};

  function validSender(sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || sender.tab.incognito) return false;
    try {
      const url = new URL(sender.url);
      return !url.username && !url.password && ORIGINS.has(url.origin);
    } catch (_) { return false; }
  }

  function session(cookies) {
    if (!Array.isArray(cookies) || cookies.length > 1000) throw Error();
    const pairs = [];
    let loggedIn = false;
    const now = Date.now() / 1000;
    // getAll sorts by longest cookie path, then creation time. Preserve that
    // order and matching duplicate names, as the browser Cookie header does.
    for (const cookie of cookies) {
      if (!cookie || cookie.partitionKey || (cookie.expirationDate !== undefined && cookie.expirationDate <= now)) continue;
      const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : '';
      if (cookie.hostOnly ? domain !== 'www.douyin.com' : !['douyin.com', 'www.douyin.com'].includes(domain)) continue;
      if (typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(cookie.name)) throw Error();
      if (typeof cookie.value !== 'string' || /[^\x21-\x7e]|;/.test(cookie.value)) throw Error();
      if (!cookie.value) continue;
      pairs.push(cookie.name + '=' + cookie.value);
      if (LOGIN_NAMES.has(cookie.name)) loggedIn = true;
    }
    if (!loggedIn) return {ok: false, code: 'LOGIN_REQUIRED', error: 'Hãy đăng nhập Douyin trong trình duyệt này rồi bấm Lấy video / ảnh lại.'};
    const cookie = pairs.join('; ');
    if (cookie.length > 16000) throw Error();
    return {ok: true, cookie, loggedIn: true};
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!validSender(sender) || !message || message.source !== 'aidesign-douyin-content'
        || !['CONNECT', 'SESSION'].includes(message.type) || !UUID.test(message.requestId || '') || !UUID.test(message.nonce || '')
        || Object.keys(message).some(key => !['source', 'type', 'requestId', 'nonce'].includes(key))) return false;
    try {
      chrome.cookies.getAll({url: DETAIL_URL}, cookies => {
        if (chrome.runtime.lastError) { sendResponse(ERROR); return; }
        try {
          const result = session(cookies);
          sendResponse(message.type === 'CONNECT' && result.ok ? {ok: true, loggedIn: true} : result);
        } catch (_) { sendResponse(ERROR); }
      });
    } catch (_) { sendResponse(ERROR); }
    // Works on Edge and older MV3 Chrome versions without Promise listeners.
    return true;
  });
})();
