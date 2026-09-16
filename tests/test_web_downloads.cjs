const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('public/download-manager.js', 'utf8');

function setup({picker, nativeClickError, local = false, views = [], request} = {}) {
  const events = [], elements = [], listeners = {};
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.attributes = {}; elements.push(this); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getClientRects() { return [1]; }
    querySelectorAll() { return []; }
    remove() {}
  }
  class Anchor extends Element {
    constructor() { super('a'); }
    click() { if (nativeClickError) throw nativeClickError; events.push('download'); }
    hasAttribute(name) { return name === 'download' ? this.download !== undefined : name in this.attributes; }
    closest() { return this; }
  }
  const document = {
    createElement: tag => tag === 'a' ? new Anchor() : new Element(tag), body: new Element('body'),
    addEventListener(type, callback) { listeners[type] = callback; },
    querySelectorAll: () => views,
  };
  class FileReader {
    readAsDataURL(blob) { events.push('read:' + blob); this.result = 'data:application/octet-stream;base64,YWJj'; this.onload(); }
  }
  let objectId = 0;
  const ctx = {
    window: {showSaveFilePicker: picker}, document, HTMLAnchorElement: Anchor, FileReader,
    location: local ? {protocol: 'http:', hostname: 'localhost'} : {protocol: 'https:', hostname: 'riengvnapp.cloud'},
    URL: {createObjectURL: () => 'blob:test-' + (++objectId), revokeObjectURL: url => events.push('revoke:' + url)},
    fetch: request || (async () => { throw Error('Must not use local-only API online'); }), Error,
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return {ctx, events, document, listeners, button: elements.find(el => el.tag === 'button'),
    status: elements.find(el => el.attributes.role === 'status'), link: elements.find(el => el.tag === 'a')};
}
const namedError = (name, message = name) => Object.assign(Error(message), {name});

// The download manager is always loaded in production; test this shared path rather than only app.js's fallback.
test('picker opens before delayed ZIP preparation and write', async () => {
  const events = [];
  const {ctx, status, button} = setup({picker: async () => {
    events.push('picker');
    return {createWritable: async () => ({write: async blob => events.push(blob), close: async () => events.push('closed')})};
  }});
  const result = await ctx.window.saveToolFile(async () => {
    events.push('build'); assert.equal(button.disabled, true); assert.match(status.textContent, /chuẩn bị/);
    return 'zip-data';
  }, 'images.zip');
  assert.equal(result, 'saved'); assert.deepEqual(events, ['picker', 'build', 'zip-data', 'closed']);
  assert.equal(button.disabled, false);
});

test('direct Blob callers remain supported without the local macOS endpoint', async () => {
  const events = [];
  const {ctx} = setup({picker: async () => ({createWritable: async () => ({write: async blob => events.push(blob), close: async () => events.push('closed')})})});
  assert.equal(await ctx.window.saveToolFile('image-data', 'image.png'), 'saved');
  assert.deepEqual(events, ['image-data', 'closed']);
});

test('cancelling the picker does not build a ZIP or trigger a fallback download', async () => {
  const {ctx, events, status, button} = setup({picker: async () => { throw namedError('AbortError'); }});
  let builds = 0;
  assert.equal(await ctx.window.saveToolFile(() => { builds++; }, 'images.zip'), 'cancelled');
  assert.equal(builds, 0); assert.deepEqual(events, []); assert.match(status.textContent, /huỷ/); assert.equal(button.disabled, false);
});

test('browser without a picker gets both automatic download and a persistent real link', async () => {
  const {ctx, events, status, link} = setup();
  assert.equal(await ctx.window.saveToolFile(async () => 'blob', 'images.zip'), 'downloaded');
  assert.deepEqual(events, ['download']); assert.match(status.textContent, /yêu cầu tải/);
  assert.equal(link.href, 'blob:test-1'); assert.equal(link.download, 'images.zip'); assert.equal(link.style.display, 'block');
  link.click(); assert.deepEqual(events, ['download', 'download']); // Must not re-enter saveLink / fetch.
});

for (const name of ['SecurityError', 'NotAllowedError', 'NotSupportedError']) {
  test(`${name} from an exposed but unavailable picker falls back after preparing the file`, async () => {
    const order = [];
    const {ctx, events, link} = setup({picker: async () => { order.push('picker'); throw namedError(name); }});
    assert.equal(await ctx.window.saveToolFile(async () => { order.push('build'); return 'blob'; }, 'images.zip'), 'downloaded');
    assert.deepEqual(order, ['picker', 'build']); assert.deepEqual(events, ['download']); assert.equal(link.style.display, 'block');
  });
}

test('blocked automatic download leaves a usable link and reports ready, not saved', async () => {
  const {ctx, link, status} = setup({nativeClickError: namedError('NotAllowedError')});
  assert.equal(await ctx.window.saveToolFile('blob', 'images.zip'), 'ready');
  assert.equal(link.href, 'blob:test-1'); assert.equal(link.download, 'images.zip'); assert.equal(link.style.display, 'block');
  assert.match(status.textContent, /sẵn sàng/); assert.doesNotMatch(status.textContent, /Đã lưu/);
});

test('busy guard prevents another download from building while ZIP preparation is pending', async () => {
  let release, secondBuilt = false;
  const {ctx, events, button} = setup();
  const first = ctx.window.saveToolFile(() => new Promise(resolve => { release = resolve; }), 'first.zip');
  assert.equal(button.disabled, true);
  await assert.rejects(ctx.window.saveToolFile(() => { secondBuilt = true; }, 'second.zip'), /Đang chuẩn bị hoặc lưu/);
  assert.equal(secondBuilt, false); release('blob'); assert.equal(await first, 'downloaded');
  assert.deepEqual(events, ['download']); assert.equal(button.disabled, false);
});

test('write failure aborts the writer and never triggers an automatic duplicate download', async () => {
  const calls = [];
  const {ctx, events, button} = setup({picker: async () => ({createWritable: async () => ({
    write: async () => { throw Error('Disk full'); }, close: async () => calls.push('closed'), abort: async () => calls.push('abort'),
  })})});
  await assert.rejects(ctx.window.saveToolFile('blob', 'images.zip'), /Disk full/);
  assert.deepEqual(calls, ['abort']); assert.deepEqual(events, []); assert.equal(button.disabled, false);
});

test('unknown picker errors remain visible and do not start building', async () => {
  const {ctx, events, status} = setup({picker: async () => { throw Error('Broken picker'); }});
  let built = false;
  await assert.rejects(ctx.window.saveToolFile(() => { built = true; }, 'images.zip'), /Broken picker/);
  assert.equal(built, false); assert.deepEqual(events, []); assert.equal(status.textContent, 'Broken picker');
});

test('local callers still send prepared data to the local save endpoint', async () => {
  const requests = [];
  const {ctx, events} = setup({local: true, picker: () => { throw Error('No browser picker locally'); }, request: async (url, options) => {
    requests.push({url, body: JSON.parse(options.body)}); return {ok: true, json: async () => ({status: 'saved'})};
  }});
  assert.equal(await ctx.window.saveToolFile(async () => 'blob', 'images.zip'), 'saved');
  assert.deepEqual(events, ['read:blob']);
  assert.deepEqual(requests, [{url: '/api/local-save-file', body: {name: 'images.zip', data: 'YWJj'}}]);
});

test('floating TikTok download button delegates to carousel items, including images not loaded in DOM', async () => {
  let calls = 0;
  const view = {id: 'view-tiktok', getClientRects: () => [1], querySelectorAll: () => { throw Error('Must not scan thumbnails'); }};
  const {ctx, button} = setup({views: [view]});
  ctx.window.downloadTiktokAll = async () => { calls++; };
  await button.onclick(); assert.equal(calls, 1);
});

test('floating all-images download opens picker before ZIP request', async () => {
  const order = [];
  const view = {id: 'view-setshirt', getClientRects: () => [1], querySelectorAll: () => [{
    getClientRects: () => [1], naturalWidth: 1080, naturalHeight: 1440, src: '/gallery/one.png',
  }]};
  const {button} = setup({views: [view], picker: async () => { order.push('picker'); return {
    createWritable: async () => ({write: async () => order.push('write'), close: async () => {}}),
  }; }, request: async (url, options) => {
    order.push('fetch'); assert.equal(url, '/api/download-zip');
    assert.deepEqual(JSON.parse(options.body).items, [{url: '/gallery/one.png', name: 'anh-1'}]);
    return {ok: true, blob: async () => 'zip'};
  }});
  await button.onclick(); assert.deepEqual(order, ['picker', 'fetch', 'write']);
});

test('intercepted download links request a picker before fetching the file', async () => {
  const order = [];
  let done;
  const written = new Promise(resolve => { done = resolve; });
  const {document} = setup({picker: async () => { order.push('picker'); return {
    createWritable: async () => ({write: async () => order.push('write'), close: async () => done()}),
  }; }, request: async url => { order.push('fetch'); assert.equal(url, '/file.png'); return {ok: true, blob: async () => 'blob'}; }});
  const anchor = document.createElement('a'); anchor.href = '/file.png'; anchor.download = 'image.png'; anchor.click();
  await written; assert.deepEqual(order, ['picker', 'fetch', 'write']);
});

for (const local of [false, true]) {
  test(`direct demo download skips both pickers (${local ? 'local' : 'online'})`, async () => {
    const {ctx, events, link, button} = setup({local, picker: () => { throw Error('Must not open picker'); }});
    let builds = 0;
    assert.equal(await ctx.window.saveToolFile(async () => { builds++; return 'png'; }, 'mockup-front.png', {directDownload: true}), 'downloaded');
    assert.equal(builds, 1); assert.deepEqual(events, ['download']);
    assert.equal(link.download, 'mockup-front.png'); assert.equal(link.href, 'blob:test-1');
    assert.equal(button.disabled, false);
  });
}
