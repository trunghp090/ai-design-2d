const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/social-download-save.js'), 'utf8');
const URL_VALUE = '/api/social-download/file?id=11111111-1111-4111-8111-111111111111&index=0&download=1';
const ORIGIN = 'https://riengvnapp.cloud';
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};

function harness(options = {}) {
  const events = [], chunks = [], fetches = [];
  const data = options.data || new Uint8Array([1, 2, 3, 4]);
  let position = 0;
  const reader = {
    read: async () => {
      events.push('read');
      if (options.read) return options.read(position++);
      return position++ ? {done: true} : {done: false, value: data};
    },
    cancel: async () => {events.push('reader-cancel');},
    releaseLock: () => {events.push('release');},
  };
  const writable = {
    write: async chunk => {events.push('write'); chunks.push(new Uint8Array(chunk)); if (options.write) await options.write(chunk);},
    close: async () => {events.push('close'); if (options.close) await options.close();},
    abort: async () => {events.push('abort'); if (options.abort) await options.abort();},
  };
  const handle = {name: 'chosen-file.mp4', createWritable: async details => {
    events.push('create');
    assert.deepEqual(copy(details), {keepExistingData: false});
    if (options.create) return options.create();
    return writable;
  }};
  const headers = new Map([['Content-Type', 'video/mp4'], ['Content-Length', String(data.byteLength)]]);
  if (options.headers) for (const [key, value] of Object.entries(options.headers)) value === null ? headers.delete(key) : headers.set(key, value);
  const response = {
    ok: options.status === undefined || options.status === 200, status: options.status || 200,
    headers: {get: key => headers.has(key) ? headers.get(key) : null},
    body: options.noStream ? null : {getReader: () => {events.push('reader'); return reader;}},
    blob: async () => {events.push('blob'); return new Blob([data]);},
  };
  const window = {isSecureContext: true, showSaveFilePicker: details => {
    events.push('picker');
    if (options.picker) return options.picker(details, handle);
    return Promise.resolve(handle);
  }};
  vm.runInNewContext(SOURCE, {
    window, location: {origin: ORIGIN, href: ORIGIN + '/'}, URL, DOMException, AbortController, Uint8Array,
    fetch: async (url, settings) => {
      events.push('fetch'); fetches.push({url, settings});
      if (options.fetch) return options.fetch(url, settings, response);
      return response;
    },
  });
  return {window, events, chunks, fetches, reader, writable, handle, response};
}

test('picker is called synchronously before first await, writable or network request', async () => {
  const selected = deferred();
  const state = harness({picker: () => selected.promise});
  const saved = state.window.saveSocialDownload(URL_VALUE, 'douyin-post-01.mp4');
  assert.deepEqual(state.events, ['picker']);
  assert.equal(state.fetches.length, 0);
  selected.resolve(state.handle);
  assert.deepEqual(copy(await saved), {status: 'saved', filename: 'chosen-file.mp4', bytes: 4});
  assert.deepEqual(state.events.slice(0, 3), ['picker', 'create', 'fetch']);
  assert.equal(state.events.filter(event => event === 'close').length, 1);
  assert.equal(state.events.includes('abort'), false);
  const request = state.fetches[0];
  assert.equal(request.url, ORIGIN + URL_VALUE);
  assert.equal(request.settings.credentials, 'same-origin');
  assert.equal(request.settings.mode, 'same-origin');
  assert.equal(request.settings.redirect, 'error');
  assert.equal(request.settings.cache, 'no-store');
  assert.ok(request.settings.signal instanceof AbortSignal);
});

test('same-origin exact file and ZIP paths only; invalid URLs never open picker or fetch', async () => {
  for (const url of ['https://evil.test/api/social-download/file', '/api/social-download/config',
    '/api/social-download/file/extra', '/api/social-download/../other',
    'https://riengvnapp.cloud.evil.test/api/social-download/file',
    'https://user:password@riengvnapp.cloud/api/social-download/file',
    URL_VALUE + '#fragment', URL_VALUE + '\r\n', 'javascript:alert(1)', null]) {
    const state = harness();
    await assert.rejects(state.window.saveSocialDownload(url, 'file.mp4'), /Đường dẫn tải file không hợp lệ/);
    assert.deepEqual(state.events, []);
  }
  const zip = harness({headers: {'Content-Type': 'application/zip'}});
  assert.equal((await zip.window.saveSocialDownload('/api/social-download/zip?id=fixture', 'images.zip')).status, 'saved');
});

test('unsupported API and nonsecure context explain Edge requirement and trigger no fallback network', async () => {
  for (const mode of ['missing', 'insecure']) {
    const state = harness();
    if (mode === 'missing') delete state.window.showSaveFilePicker;
    else state.window.isSecureContext = false;
    await assert.rejects(state.window.saveSocialDownload(URL_VALUE, 'file.mp4'), /Mở tool bằng Edge để chọn nơi lưu/);
    assert.deepEqual(state.events, []);
  }
});

test('cancelled or denied picker never downloads and clears the active guard', async () => {
  const cancelled = harness({picker: () => Promise.reject(new DOMException('cancelled', 'AbortError'))});
  assert.deepEqual(copy(await cancelled.window.saveSocialDownload(URL_VALUE, 'file.mp4')), {status: 'cancelled'});
  assert.deepEqual(cancelled.events, ['picker']);
  assert.equal(cancelled.window.cancelSocialDownloadSave(), false);
  const denied = harness({picker: () => {throw new DOMException('denied', 'SecurityError');}});
  await assert.rejects(denied.window.saveSocialDownload(URL_VALUE, 'file.mp4'), /Mở tool bằng Edge/);
  assert.deepEqual(denied.events, ['picker']);
  assert.equal(denied.window.cancelSocialDownloadSave(), false);
});

test('single active save prevents another picker until the previous operation finishes', async () => {
  const selected = deferred(), state = harness({picker: () => selected.promise});
  const first = state.window.saveSocialDownload(URL_VALUE, 'file.mp4');
  await assert.rejects(state.window.saveSocialDownload(URL_VALUE, 'second.mp4'), /Đang lưu một file/);
  assert.deepEqual(state.events, ['picker']);
  selected.reject(new DOMException('cancelled', 'AbortError'));
  await first;
  assert.equal(state.window.cancelSocialDownloadSave(), false);
});

test('external abort before or during picker does not fetch or open a writable', async () => {
  const before = new AbortController(), immediate = harness();
  before.abort();
  assert.equal((await immediate.window.saveSocialDownload(URL_VALUE, 'file.mp4', {signal: before.signal})).status, 'cancelled');
  assert.deepEqual(immediate.events, []);
  const selected = deferred(), state = harness({picker: () => selected.promise});
  const controller = new AbortController();
  const promise = state.window.saveSocialDownload(URL_VALUE, 'file.mp4', {signal: controller.signal});
  controller.abort();
  selected.resolve(state.handle);
  assert.equal((await promise).status, 'cancelled');
  assert.deepEqual(state.events, ['picker']);
});

test('manual cancel during streaming aborts network and pending file without committing', async () => {
  let state;
  state = harness({write: async () => {assert.equal(state.window.cancelSocialDownloadSave(), true);}});
  const result = await state.window.saveSocialDownload(URL_VALUE, 'file.mp4');
  assert.equal(result.status, 'cancelled');
  assert.equal(state.fetches[0].settings.signal.aborted, true);
  assert.equal(state.events.includes('abort'), true);
  assert.equal(state.events.includes('reader-cancel'), true);
  assert.equal(state.events.includes('close'), false);
  assert.equal(state.window.cancelSocialDownloadSave(), false);
});

test('large response chunks are written in bounded 64 KB slices without blobs or base64', async () => {
  const data = new Uint8Array(150000);
  data[0] = 7; data[data.length - 1] = 9;
  const state = harness({data});
  const result = await state.window.saveSocialDownload(URL_VALUE, 'file.mp4');
  assert.equal(result.bytes, data.length);
  assert.equal(state.chunks.length, 3);
  assert.ok(state.chunks.every(chunk => chunk.byteLength <= 64 * 1024));
  assert.equal(state.chunks[0][0], 7);
  assert.equal(state.chunks.at(-1).at(-1), 9);
  assert.equal(state.events.includes('blob'), false);
});

test('blob fallback happens only after picker, writable and fetch and still uses bounded binary writes', async () => {
  const state = harness({noStream: true, data: new Uint8Array(70000)});
  const result = await state.window.saveSocialDownload(URL_VALUE, 'file.mp4');
  assert.equal(result.bytes, 70000);
  assert.deepEqual(state.events.slice(0, 4), ['picker', 'create', 'fetch', 'blob']);
  assert.equal(state.chunks.length, 2);
  assert.ok(state.chunks.every(chunk => chunk.byteLength <= 65536));
});

test('HTTP errors, non-media response and invalid lengths abort file without saving', async () => {
  const cases = [
    {status: 401, expected: /Đăng nhập lại/}, {status: 410, expected: /Link tải đã hết hạn/},
    {status: 429, expected: /Đang tải nhiều file/}, {status: 413, expected: /vượt giới hạn/},
    {headers: {'Content-Type': 'text/html'}, expected: /Máy chủ chưa trả về/},
    {headers: {'Content-Length': '314572801'}, expected: /vượt giới hạn/},
    {headers: {'Content-Length': 'NaN'}, expected: /File trống/},
    {headers: {'Content-Length': '0'}, expected: /File trống/},
    {headers: {'Content-Length': '5'}, expected: /File tải chưa hoàn chỉnh/},
    {headers: {'Content-Length': '3'}, expected: /File tải chưa hoàn chỉnh/},
  ];
  for (const item of cases) {
    const state = harness(item);
    await assert.rejects(state.window.saveSocialDownload(URL_VALUE, 'file.mp4'), item.expected);
    assert.equal(state.events.includes('abort'), true);
    assert.equal(state.events.includes('close'), false);
    assert.equal(state.window.cancelSocialDownloadSave(), false);
  }
});

test('write failure, unexpected stream abort and failed close never report success or replace file', async () => {
  const cases = [{write: () => {throw new DOMException('quota', 'QuotaExceededError');}, expected: /Không đủ dung lượng/},
    {read: () => {throw new DOMException('unexpected-abort', 'AbortError');}, expected: /Trình duyệt đã ngắt/},
    {close: () => {throw new DOMException('permission', 'NotAllowedError');}, expected: /Chưa có quyền ghi/}];
  for (const item of cases) {
    const state = harness(item);
    await assert.rejects(state.window.saveSocialDownload(URL_VALUE, 'file.mp4'), item.expected);
    assert.equal(state.events.includes('abort'), true);
    assert.equal(state.events.includes('reader-cancel'), true);
    assert.equal(state.window.cancelSocialDownloadSave(), false);
  }
});

test('write permission failure prevents fetch and suggested filename contains no path or control characters', async () => {
  let suggestion;
  const state = harness({picker: (options, handle) => {suggestion = options.suggestedName; return Promise.resolve(handle);},
    create: () => {throw new DOMException('permission', 'NotAllowedError');}});
  await assert.rejects(state.window.saveSocialDownload(URL_VALUE, '../bad\r\nfile.mp4'), /Chưa có quyền ghi/);
  assert.equal(/[\\/\x00-\x1f]/.test(suggestion), false);
  assert.deepEqual(state.events, ['picker', 'create']);
});

test('utility never invokes native download anchors, macOS local-save, object URLs or base64', () => {
  assert.doesNotMatch(SOURCE, /createObjectURL|FileReader|btoa\(|\.click\(|local-save-file|HTMLAnchorElement|base64,/);
});
