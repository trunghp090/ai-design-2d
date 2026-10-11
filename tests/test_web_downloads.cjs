const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('public/download-manager.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};

function setup({nativeClickError, local = false, views = [], request, images = [], framed = false} = {}) {
  const events = [], elements = [], listeners = {}, downloads = [], fetches = [], timers = new Map();
  const origin = local ? 'http://localhost:8000' : 'https://riengvnapp.cloud';
  const location = {origin, href: origin + '/', protocol: local ? 'http:' : 'https:', hostname: local ? 'localhost' : 'riengvnapp.cloud'};
  let now = 0, timerId = 0;
  class Element {
    constructor(tag) {this.tag = tag; this.style = {}; this.dataset = {}; this.children = []; this.attributes = {}; elements.push(this);}
    append(...children) {for (const child of children) {this.children.push(child); child.parentNode = this; child.removed = false;}}
    appendChild(child) {this.append(child); return child;}
    setAttribute(name, value) {this.attributes[name] = String(value);}
    getAttribute(name) {return this.attributes[name] ?? null;}
    getClientRects() {return this.removed ? [] : [1];}
    querySelectorAll() {return [];}
    remove() {this.removed = true; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);}
  }
  const dispatch = anchor => {
    const event = {target: anchor, defaultPrevented: false, stopped: false,
      preventDefault() {this.defaultPrevented = true;}, stopImmediatePropagation() {this.stopped = true;}};
    for (const callback of listeners.click || []) {callback(event); if (event.stopped) break;}
    return event;
  };
  class Anchor extends Element {
    constructor() {super('a');}
    set href(value) {this.attributes.href = new URL(value, location.href).href;}
    get href() {return this.attributes.href || '';}
    click() {
      const event = dispatch(this);
      if (event.defaultPrevented) return;
      if (nativeClickError && (typeof nativeClickError !== 'function' || nativeClickError(this))) throw Error('Native download blocked');
      events.push('download'); downloads.push({url: this.href, name: this.download, anchor: this});
    }
    hasAttribute(name) {return name === 'download' ? this.download !== undefined : name in this.attributes || name === 'data-native-download' && 'nativeDownload' in this.dataset;}
    closest() {return this;}
  }
  const document = {
    createElement: tag => tag === 'a' ? new Anchor() : new Element(tag), body: new Element('body'),
    addEventListener(type, callback) {(listeners[type] ??= []).push(callback);},
    querySelectorAll: selector => selector === 'img' ? images : views,
  };
  class FileReader {
    readAsDataURL(blob) {events.push('read:' + blob); this.result = 'data:application/octet-stream;base64,YWJj'; this.onload();}
  }
  let objectId = 0;
  class BrowserURL extends URL {}
  BrowserURL.createObjectURL = blob => {events.push('object-url'); return 'blob:' + origin + '/test-' + (++objectId);};
  BrowserURL.revokeObjectURL = url => events.push('revoke:' + url);
  const schedule = (callback, ms) => {const id = ++timerId; timers.set(id, {callback, at: now + ms, ms}); return id;};
  const ctx = {
    window: {top: framed ? {} : undefined, showSaveFilePicker() {throw Error('Native workflow must not use FSA');}}, document, HTMLAnchorElement: Anchor, FileReader,
    location, URL: BrowserURL, Blob, Error, setTimeout: schedule, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {fetches.push({url, options}); if (!request) throw Error('Unexpected fetch: ' + url); return request(url, options);},
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  const advance = milliseconds => {now += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= now) {timers.delete(id); timer.callback();}};
  return {ctx, events, downloads, fetches, document, listeners, timers, dispatch, advance,
    bar: elements.find(el => el.id === 'toolDownloads'), button: elements.find(el => el.tag === 'button'), status: elements.find(el => el.attributes.role === 'status'),
    retryLinks: () => elements.filter(el => el.tag === 'a' && el.href && !el.removed && el.parentNode && el.style.display !== 'none')};
}

for (const local of [false, true]) test('prepared file starts one browser download without FSA or local API (' + (local ? 'local' : 'online') + ')', async () => {
  const state = setup({local});
  const result = await state.ctx.window.saveToolFile(() => new Blob(['image']), 'image.png');
  assert.equal(result, 'downloaded');
  assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].name, 'image.png');
  assert.equal(state.fetches.length, 0);
  assert.doesNotMatch(state.status.textContent, /Đã lưu|hoàn tất/i);
  assert.match(state.status.textContent, /yêu cầu tải|trình duyệt/i);
});

test('blocked automatic click leaves a real retry link and reports ready, not completed', async () => {
  const state = setup({nativeClickError: true});
  assert.equal(await state.ctx.window.saveToolFile(new Blob(['zip']), 'album.zip'), 'ready');
  assert.equal(state.downloads.length, 0);
  const link = state.retryLinks().find(link => link.download === 'album.zip');
  assert.ok(link); assert.match(link.href, /^blob:/);
  assert.match(state.status.textContent, /sẵn sàng|bấm|liên kết/i);
  assert.doesNotMatch(state.status.textContent, /Đã lưu|hoàn tất/i);
});

test('concurrent file factories queue in order instead of dropping later exports', async () => {
  const first = deferred(), order = [], state = setup();
  const one = state.ctx.window.saveToolFile(async () => {order.push('first'); return first.promise;}, 'one.zip');
  const two = state.ctx.window.saveToolFile(() => {order.push('second'); return new Blob(['two']);}, 'two.zip');
  await tick(); assert.deepEqual(order, ['first']); assert.equal(state.downloads.length, 0);
  first.resolve(new Blob(['one']));
  assert.deepEqual(await Promise.all([one, two]), ['downloaded', 'downloaded']);
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(state.downloads.map(item => item.name), ['one.zip', 'two.zip']);
});

test('a rejected preparation reports its error and does not poison queued downloads', async () => {
  const first = deferred(), state = setup();
  const one = state.ctx.window.saveToolFile(() => first.promise, 'bad.zip');
  const failed = assert.rejects(one, /Synthetic packaging error/);
  const two = state.ctx.window.saveToolFile(() => new Blob(['ok']), 'good.zip');
  first.reject(Error('Synthetic packaging error'));
  await failed; assert.equal(await two, 'downloaded');
  assert.deepEqual(state.downloads.map(item => item.name), ['good.zip']);
});

test('each queued file retains its own retry URL for at least a minute', async () => {
  const state = setup();
  await state.ctx.window.saveToolFile(new Blob(['one']), 'one.zip');
  const first = state.downloads[0].url;
  await state.ctx.window.saveToolFile(new Blob(['two']), 'two.zip');
  const links = state.retryLinks();
  assert.ok(links.some(link => link.download === 'one.zip' && link.href === first));
  assert.ok(links.some(link => link.download === 'two.zip'));
  assert.equal(state.events.some(item => item.startsWith('revoke:')), false);
  state.advance(59999);
  assert.equal(state.events.some(item => item.startsWith('revoke:')), false);
  const retry = links.find(link => link.download === 'one.zip');
  retry.click();
  assert.equal(state.downloads.length, 3);
  assert.equal(state.fetches.length, 0);
});

for (const value of ['/gallery/one.png', 'https://riengvnapp.cloud/api/file?id=fixture',
  'blob:https://riengvnapp.cloud/synthetic', 'data:image/png;base64,YWJj']) {
  test('own URL dispatches directly without fetching: ' + value.split(':')[0], async () => {
    const state = setup();
    assert.equal(await state.ctx.window.downloadToolURL(value, 'one.png'), 'downloaded');
    assert.equal(state.downloads.length, 1); assert.equal(state.downloads[0].name, 'one.png');
    assert.equal(state.fetches.length, 0);
  });
}

test('external HTTPS image is fetched once then downloaded as a browser Blob', async () => {
  const state = setup({request: async url => {assert.equal(url, 'https://cdn.example.test/image.jpg'); return {ok: true, blob: async () => new Blob(['image'])};}});
  assert.equal(await state.ctx.window.downloadToolURL('https://cdn.example.test/image.jpg', 'photo.jpg'), 'downloaded');
  assert.equal(state.fetches.length, 1);
  assert.equal(state.downloads.length, 1); assert.match(state.downloads[0].url, /^blob:/);
});

test('unsafe URL schemes, foreign blobs and credentials cannot initiate download or fetch', async () => {
  for (const value of ['javascript:alert(1)', 'file:///tmp/file', 'ftp://evil.test/file',
    'https://user:secret@riengvnapp.cloud/file', 'https://user:secret@cdn.example.test/file',
    'blob:https://evil.test/file', null]) {
    const state = setup();
    await assert.rejects(state.ctx.window.downloadToolURL(value, 'file.png'));
    assert.equal(state.downloads.length, 0); assert.equal(state.fetches.length, 0);
  }
});

test('external fetch failure creates no download and a later queued file still runs', async () => {
  const state = setup({request: async () => ({ok: false})});
  await assert.rejects(state.ctx.window.downloadToolURL('https://cdn.example.test/missing.png', 'missing.png'));
  assert.equal(state.downloads.length, 0);
  assert.equal(await state.ctx.window.saveToolFile(new Blob(['ok']), 'ok.png'), 'downloaded');
  assert.equal(state.downloads.length, 1);
});

test('programmatic download anchors are intercepted exactly once without buffering own URLs', async () => {
  const state = setup();
  const anchor = state.document.createElement('a'); anchor.href = '/file.png'; anchor.download = 'image.png'; anchor.click();
  await tick(); await tick();
  assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].name, 'image.png');
  assert.equal(state.fetches.length, 0);
});

test('trusted anchor event interception dispatches one download and native anchors bypass it', async () => {
  const state = setup();
  const anchor = state.document.createElement('a'); anchor.href = '/file.png'; anchor.download = 'image.png';
  const event = state.dispatch(anchor);
  assert.equal(event.defaultPrevented, true);
  await tick(); await tick(); assert.equal(state.downloads.length, 1);
  const native = state.document.createElement('a'); native.href = '/native.png'; native.download = 'native.png'; native.setAttribute('data-native-download', '');
  native.click(); assert.equal(state.downloads.length, 2); assert.equal(state.fetches.length, 0);
});

for (const kind of ['socialdownload', 'tiktok']) test('floating ' + kind + ' export delegates to the complete album and awaits failure', async () => {
  const work = deferred();
  const view = {id: 'view-' + kind, getClientRects: () => [1], querySelectorAll: () => {throw Error('Must not scan thumbnails');}};
  const state = setup({views: [view]});
  let calls = 0;
  state.ctx.window[kind === 'socialdownload' ? 'downloadSocialAll' : 'downloadTiktokAll'] = () => {calls++; return work.promise;};
  let settled = false;
  const pending = state.button.onclick().then(() => {settled = true;});
  await tick(); assert.equal(calls, 1); assert.equal(settled, false);
  work.reject(Error('Synthetic album error'));
  await pending; assert.match(state.status.textContent, /Synthetic album error/);
  assert.equal(state.downloads.length, 0);
});

test('floating chat-content export delegates to its slide exporter', async () => {
  let calls = 0;
  const view = {id: 'view-chatcontent', getClientRects: () => [1], querySelector: selector => {assert.equal(selector, '#cc-export-all'); return {click() {calls++;}};}, querySelectorAll: () => {throw Error('Must not ZIP previews');}};
  const state = setup({views: [view]});
  await state.button.onclick(); assert.equal(calls, 1); assert.equal(state.fetches.length, 0);
});

test('generic album includes unique full-size visible images only from the active tool', async () => {
  const image = (src, visible = true, size = 1080) => ({getClientRects: () => visible ? [1] : [], naturalWidth: size, naturalHeight: size, src});
  const inactive = {id: 'view-other', getClientRects: () => [], querySelectorAll: () => {throw Error('Inactive images must not be exported');}};
  const active = {id: 'view-setshirt', getClientRects: () => [1], querySelectorAll: () => [image('/one.png'), image('/one.png'), image('/hidden.png', false), image('/tiny.png', true, 100), image('data:image/png;base64,YWJj')]};
  const state = setup({views: [inactive, active], request: async (url, options) => {
    assert.equal(url, '/api/download-zip');
    assert.deepEqual(JSON.parse(options.body).items, [{url: '/one.png', name: 'anh-1'}, {data: 'data:image/png;base64,YWJj', name: 'anh-2'}]);
    return {ok: true, blob: async () => new Blob(['zip'])};
  }});
  await state.button.onclick(); assert.equal(state.fetches.length, 1); assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].name, 'tat-ca-anh.zip');
});

test('an empty active tool reports no images without creating a download', async () => {
  const state = setup({views: [{id: 'view-design', getClientRects: () => [1], querySelectorAll: () => []}]});
  await state.button.onclick(); assert.match(state.status.textContent, /Chưa có ảnh/);
  assert.equal(state.fetches.length, 0); assert.equal(state.downloads.length, 0);
});

test('legacy directDownload option uses the same native queue and sanitized filename', async () => {
  const state = setup();
  assert.equal(await state.ctx.window.saveToolFile(new Blob(['png']), '../bad\r\nname.png', {directDownload: true}), 'downloaded');
  assert.equal(state.downloads.length, 1);
  assert.equal(/[\\/\x00-\x1f\x7f]/.test(state.downloads[0].name), false);
});

test('mixed batch items preserve their snapshot, order and names through one POST and native ZIP', async () => {
  const items = [{id: 'fixture-image-1', name: 'first'}, {url: '/gallery/second.jpg', name: 'second'},
    {data: 'data:image/png;base64,YWJj', name: 'third'}];
  const expected = JSON.parse(JSON.stringify(items));
  const state = setup({request: async (url, options) => {
    assert.equal(url, '/api/download-zip'); assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {items: expected});
    return {ok: true, blob: async () => new Blob(['synthetic ZIP'])};
  }});
  const pending = state.ctx.window.downloadToolFiles(items, 'mixed-images.zip');
  items[0].id = 'changed-after-click'; items.reverse();
  assert.equal(await pending, 'downloaded');
  assert.equal(state.fetches.length, 1); assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].name, 'mixed-images.zip');
  assert.match(state.downloads[0].url, /^blob:/);
});

test('a partial ZIP backend error creates no download and the next queued batch succeeds', async () => {
  let requests = 0;
  const state = setup({request: async () => ++requests === 1
    ? {ok: false, json: async () => ({error: 'Synthetic ZIP missing an image'})}
    : {ok: true, blob: async () => new Blob(['complete ZIP'])}});
  const first = state.ctx.window.downloadToolFiles([{url: '/missing.jpg', name: 'missing'}], 'bad.zip');
  const rejected = assert.rejects(first, /Synthetic ZIP missing an image/);
  const next = state.ctx.window.downloadToolFiles([{id: 'fixture-valid', name: 'valid'}], 'good.zip');
  await rejected; assert.equal(await next, 'downloaded');
  assert.equal(state.fetches.length, 2);
  assert.deepEqual(state.downloads.map(item => item.name), ['good.zip']);
});

test('empty, excessive or malformed batches fail before any ZIP request or native start', async () => {
  for (const items of [null, [], Array.from({length: 101}, () => ({id: 'fixture'})), [{}], [null], ['not an item']]) {
    const state = setup();
    await assert.rejects(state.ctx.window.downloadToolFiles(items, 'invalid.zip'));
    assert.equal(state.fetches.length, 0); assert.equal(state.downloads.length, 0);
  }
});


test('embedded review keeps its bar hidden during normal dispatch but reveals a blocked-download retry', async () => {
  const normal = setup({framed: true});
  assert.equal(normal.bar.parentNode, normal.document.body);
  assert.equal(normal.bar.hidden, true);
  assert.equal(await normal.ctx.window.downloadToolURL('/gallery/one.jpg', 'one.jpg'), 'downloaded');
  assert.equal(normal.bar.hidden, true);
  assert.equal(normal.downloads.length, 1);
  const blocked = setup({framed: true, nativeClickError: true});
  assert.equal(await blocked.ctx.window.downloadToolURL('/gallery/two.jpg', 'two.jpg'), 'ready');
  assert.equal(blocked.bar.hidden, false);
  assert.ok(blocked.retryLinks().some(link => link.download === 'two.jpg'));
  assert.equal(blocked.downloads.length, 0);
});
