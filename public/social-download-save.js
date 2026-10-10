/* Choose the destination while handling the click, then stream into that file. */
(() => {
  'use strict';
  const MAX_BYTES = 300 * 1024 * 1024;
  const WRITE_CHUNK = 64 * 1024;
  let active = null;

  function localURL(value) {
    if (typeof value !== 'string' || !value || value.length > 20000 || /[\x00-\x1f\x7f\\]/.test(value)) {
      throw Error('Đường dẫn tải file không hợp lệ. Hãy lấy lại bài đăng.');
    }
    let url;
    try { url = new URL(value, location.href); }
    catch (_) { throw Error('Đường dẫn tải file không hợp lệ. Hãy lấy lại bài đăng.'); }
    if (url.origin !== location.origin || url.username || url.password || url.hash
        || !['/api/social-download/file', '/api/social-download/zip'].includes(url.pathname)) {
      throw Error('Đường dẫn tải file không hợp lệ. Hãy lấy lại bài đăng.');
    }
    return url.href;
  }
  function suggestedName(value) {
    return (typeof value === 'string' ? value : 'download').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim().slice(0, 180) || 'download';
  }
  function checkAbort(signal) {
    if (signal.aborted) throw new DOMException('Đã huỷ tải file.', 'AbortError');
  }
  function httpError(status) {
    if (status === 401) return 'Phiên đăng nhập đã hết hạn. Đăng nhập lại công cụ rồi thử tải.';
    if (status === 403) return 'Tài khoản chưa được cấp quyền tải file này.';
    if (status === 404 || status === 410) return 'Link tải đã hết hạn. Hãy lấy lại nội dung bài đăng.';
    if (status === 429) return 'Đang tải nhiều file. Đợi một lát rồi thử lại.';
    if (status === 413) return 'File vượt giới hạn tải. Hãy chọn file nhỏ hơn hoặc tải từng ảnh.';
    return 'Chưa tải được file từ máy chủ. Hãy lấy lại bài đăng rồi thử lại.';
  }

  window.cancelSocialDownloadSave = () => {
    if (!active) return false;
    active.abort();
    return true;
  };
  window.saveSocialDownload = async (value, filename, options = {}) => {
    if (active) throw Error('Đang lưu một file. Đợi hoàn tất hoặc huỷ rồi tải file khác.');
    const url = localURL(value);
    if (typeof window.showSaveFilePicker !== 'function' || window.isSecureContext === false) {
      throw Error('Mở tool bằng Edge để chọn nơi lưu. Dùng địa chỉ HTTPS hoặc localhost.');
    }
    const name = suggestedName(filename);
    const controller = new AbortController();
    const outerSignal = options?.signal;
    if (outerSignal && (typeof outerSignal.addEventListener !== 'function' || typeof outerSignal.aborted !== 'boolean')) {
      throw Error('Không tạo được yêu cầu tải. Hãy tải lại trang rồi thử lại.');
    }
    if (outerSignal?.aborted) return {status: 'cancelled'};
    const cancel = () => controller.abort();
    outerSignal?.addEventListener('abort', cancel, {once: true});
    active = controller;
    let writable = null, reader = null, closed = false, stage = 'picker';
    try {
      // No await, fetch or preprocessing can precede the actual picker call.
      const picked = window.showSaveFilePicker({suggestedName: name, id: 'social-download', startIn: 'downloads'});
      const handle = await picked;
      checkAbort(controller.signal);
      stage = 'write';
      writable = await handle.createWritable({keepExistingData: false});
      checkAbort(controller.signal);
      stage = 'fetch';
      const response = await fetch(url, {credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        cache: 'no-store', signal: controller.signal});
      checkAbort(controller.signal);
      if (!response.ok) throw Error(httpError(response.status));
      const contentType = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!/^(?:video\/mp4|image\/(?:jpeg|png|webp|gif|avif)|application\/zip|application\/octet-stream)$/.test(contentType)) {
        throw Error('Máy chủ chưa trả về video, ảnh hoặc ZIP. Hãy lấy lại bài đăng rồi thử lại.');
      }
      const lengthHeader = response.headers.get('Content-Length');
      const expected = lengthHeader === null ? null : /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
      if (expected !== null && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_BYTES)) {
        throw Error('File trống hoặc vượt giới hạn 300 MB. Hãy lấy lại bài đăng hoặc chọn file nhỏ hơn.');
      }
      let bytes = 0;
      async function write(chunk) {
        if (!(chunk instanceof Uint8Array)) throw Error('Dữ liệu file tải xuống không hợp lệ.');
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES || (expected !== null && bytes > expected)) throw Error('File tải chưa hoàn chỉnh hoặc vượt giới hạn 300 MB.');
        for (let offset = 0; offset < chunk.byteLength; offset += WRITE_CHUNK) {
          checkAbort(controller.signal);
          await writable.write(chunk.subarray(offset, Math.min(offset + WRITE_CHUNK, chunk.byteLength)));
        }
      }
      stage = 'stream';
      if (response.body && typeof response.body.getReader === 'function') {
        reader = response.body.getReader();
        while (true) {
          checkAbort(controller.signal);
          const chunk = await reader.read();
          checkAbort(controller.signal);
          if (chunk.done) break;
          await write(chunk.value);
        }
      } else {
        // Legacy response implementations can still write to the chosen file.
        // This fallback never downloads elsewhere or creates a base64 payload.
        const blob = await response.blob();
        checkAbort(controller.signal);
        if (blob.size > MAX_BYTES) throw Error('File vượt giới hạn 300 MB.');
        for (let offset = 0; offset < blob.size; offset += WRITE_CHUNK) {
          checkAbort(controller.signal);
          await write(new Uint8Array(await blob.slice(offset, offset + WRITE_CHUNK).arrayBuffer()));
        }
      }
      checkAbort(controller.signal);
      if (!bytes || (expected !== null && bytes !== expected)) throw Error('File tải chưa hoàn chỉnh. Hãy thử tải lại.');
      stage = 'close';
      await writable.close();
      closed = true;
      return {status: 'saved', filename: handle.name || name, bytes};
    } catch (error) {
      const cancelled = controller.signal.aborted || outerSignal?.aborted || (stage === 'picker' && error?.name === 'AbortError');
      controller.abort();
      if (reader) { try { await reader.cancel(); } catch (_) {} }
      if (writable && !closed) { try { await writable.abort(); } catch (_) {} }
      if (cancelled) return {status: 'cancelled'};
      if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
        throw Error(stage === 'picker'
          ? 'Không mở được cửa sổ chọn nơi lưu. Mở tool bằng Edge rồi bấm nút tải trực tiếp.'
          : 'Chưa có quyền ghi vào file đã chọn. Hãy chọn nơi lưu khác rồi thử lại.');
      }
      if (error?.name === 'QuotaExceededError') throw Error('Không đủ dung lượng tại nơi lưu. Chọn ổ đĩa khác rồi thử lại.');
      if (error?.name === 'AbortError') throw Error('Trình duyệt đã ngắt việc ghi file. Hãy chọn nơi lưu khác rồi thử lại.');
      if (error instanceof TypeError) throw Error('Kết nối bị ngắt hoặc chưa mở được file để ghi. Hãy thử tải lại.');
      throw error instanceof Error ? error : Error('Chưa lưu được file. Hãy chọn nơi lưu rồi thử lại.');
    } finally {
      if (reader) { try { reader.releaseLock(); } catch (_) {} }
      outerSignal?.removeEventListener('abort', cancel);
      if (active === controller) active = null;
    }
  };
})();
