/* The browser Downloads service streams social media and owns cancellation. */
(() => {
  'use strict';
  function localURL(value) {
    if (typeof value !== 'string' || !value || value.length > 20000 || /[\x00-\x1f\x7f\\]/.test(value)) throw Error('Đường dẫn tải file không hợp lệ. Hãy lấy lại bài đăng.');
    let url;
    try { url = new URL(value, location.href); }
    catch (_) { throw Error('Đường dẫn tải file không hợp lệ. Hãy lấy lại bài đăng.'); }
    if (url.origin !== location.origin || url.username || url.password || url.hash
        || !['/api/social-download/file', '/api/social-download/zip'].includes(url.pathname)) throw Error('Đường dẫn tải file không hợp lệ. Hãy lấy lại bài đăng.');
    if (url.pathname === '/api/social-download/file') url.searchParams.set('download', '1');
    return url.href;
  }
  window.cancelSocialDownloadSave = () => false;
  window.saveSocialDownload = async (value, filename, options = {}) => {
    const url = localURL(value), signal = options?.signal;
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw Error('Không tạo được yêu cầu tải. Hãy tải lại trang rồi thử lại.');
    if (signal?.aborted) return {status: 'cancelled'};
    const name = (typeof filename === 'string' ? filename : 'download').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim().slice(0, 180) || 'download';
    let outcome;
    if (typeof window.downloadToolURL === 'function') {
      outcome = window.downloadToolURL(url, name, {onDispatched: () => options.onDispatched?.({filename: name})});
    } else {
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = name; anchor.setAttribute('data-native-download', '');
      anchor.textContent = '↓ Tải lại ' + name; document.body.append(anchor);
      try { anchor.click(); outcome = 'downloaded'; try { options.onDispatched?.({filename: name}); } catch (_) {} }
      catch (_) { outcome = 'ready'; }
    }
    // An abort after dispatch cannot retract a browser-owned download.
    return {status: await outcome, filename: name};
  };
})();
