const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/social-download-save.js'), 'utf8');
const MANAGER = fs.readFileSync(path.join(__dirname, '../public/download-manager.js'), 'utf8');
const URL_VALUE = '/api/social-download/file?id=11111111-1111-4111-8111-111111111111&index=0&download=1';
const ORIGIN = 'https://riengvnapp.cloud';
const copy = value => JSON.parse(JSON.stringify(value));

function harness({blocked = false, manager = false, local = false} = {}) {
  const origin = local ? 'http://localhost:8000' : ORIGIN;
  const location = {origin, href: origin + '/', protocol: local ? 'http:' : 'https:', hostname: local ? 'localhost' : 'riengvnapp.cloud'};
  const downloads = [], elements = [], forbidden = [], listeners = new Map();
  class Element {
    constructor(tag) {this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; elements.push(this);}
    append(...children) {for (const child of children) {this.children.push(child); child.parentNode = this;}}
    appendChild(child) {this.append(child); return child;}
    setAttribute(key, value) {this.attributes[key] = String(value);}
    getAttribute(key) {return this.attributes[key] ?? null;}
    remove() {if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.removed = true;}
    getClientRects() {return this.removed ? [] : [1];}
    querySelectorAll() {return [];}
  }
  class Anchor extends Element {
    constructor() {super('a');}
    set href(value) {this.attributes.href = new URL(value, location.href).href;}
    get href() {return this.attributes.href || '';}
    hasAttribute(key) {return key === 'download' ? this.download !== undefined : key in this.attributes || key === 'data-native-download' && 'nativeDownload' in this.dataset;}
    closest() {return this;}
    click() {
      const event = {target: this, defaultPrevented: false, stopped: false,
        preventDefault() {this.defaultPrevented = true;}, stopImmediatePropagation() {this.stopped = true;}};
      for (const callback of listeners.get('click') || []) {callback(event); if (event.stopped) break;}
      if (event.defaultPrevented) return;
      if (blocked) throw Error('Synthetic native click blocked');
      downloads.push({url: this.href, filename: this.download, anchor: this});
    }
  }
  const forbiddenCall = name => () => {forbidden.push(name); throw Error('Unexpected ' + name);};
  const document = {createElement: tag => tag === 'a' ? new Anchor() : new Element(tag), body: new Element('body'),
    addEventListener(type, callback) {const callbacks = listeners.get(type) || []; callbacks.push(callback); listeners.set(type, callbacks);},
    querySelectorAll: () => []};
  const window = {showSaveFilePicker: forbiddenCall('FSA picker'), isSecureContext: !local};
  class BrowserURL extends URL {}
  BrowserURL.createObjectURL = forbiddenCall('Blob buffering');
  BrowserURL.revokeObjectURL = forbiddenCall('Blob buffering');
  const ctx = {window, document, location, URL: BrowserURL, HTMLAnchorElement: Anchor, DOMException, AbortController,
    fetch: forbiddenCall('fetch'), FileReader: forbiddenCall('base64'), setTimeout: () => 1, clearTimeout() {}};
  vm.createContext(ctx);
  if (manager) vm.runInContext(MANAGER, ctx);
  vm.runInContext(SOURCE, ctx);
  return {window, downloads, elements, forbidden, origin};
}

for (const manager of [false, true]) test('media URL starts exactly one native download synchronously (' + (manager ? 'shared manager' : 'standalone') + ')', async () => {
  const state = harness({manager});
  const pending = state.window.saveSocialDownload(URL_VALUE, 'douyin-post-01.mp4');
  assert.equal(state.downloads.length, 1);
  assert.deepEqual(copy(await pending), {status: 'downloaded', filename: 'douyin-post-01.mp4'});
  assert.equal(state.downloads[0].url, ORIGIN + URL_VALUE);
  assert.equal(state.downloads[0].filename, 'douyin-post-01.mp4');
  assert.deepEqual(state.forbidden, []);
});

test('ZIP attachment uses its existing local URL without buffering or FSA', async () => {
  const state = harness();
  const url = '/api/social-download/zip?id=11111111-1111-4111-8111-111111111111';
  assert.deepEqual(copy(await state.window.saveSocialDownload(url, 'douyin-post-images.zip')), {status: 'downloaded', filename: 'douyin-post-images.zip'});
  assert.equal(state.downloads[0].url, ORIGIN + url);
  assert.equal(state.downloads.length, 1); assert.deepEqual(state.forbidden, []);
});

test('same-origin exact file and ZIP paths only; invalid URLs initiate no action', async () => {
  for (const url of ['https://evil.test/api/social-download/file', '/api/social-download/config',
    '/api/social-download/file/extra', '/api/social-download/../other',
    'https://riengvnapp.cloud.evil.test/api/social-download/file',
    'https://user:password@riengvnapp.cloud/api/social-download/file',
    URL_VALUE + '#fragment', URL_VALUE + '\r\n', 'javascript:alert(1)',
    'blob:https://riengvnapp.cloud/fixture', 'data:image/png;base64,YWJj', null]) {
    const state = harness({manager: true});
    await assert.rejects(state.window.saveSocialDownload(url, 'file.mp4'), /Đường dẫn tải file không hợp lệ/);
    assert.deepEqual(state.downloads, []); assert.deepEqual(state.forbidden, []);
  }
});

test('blocked native start reports ready and retains a real link for manual retry', async () => {
  for (const manager of [false, true]) {
    const state = harness({blocked: true, manager});
    const result = await state.window.saveSocialDownload(URL_VALUE, 'file.mp4');
    assert.deepEqual(copy(result), {status: 'ready', filename: 'file.mp4'});
    assert.equal(state.downloads.length, 0);
    assert.ok(state.elements.some(element => element.tag === 'a' && element.href === ORIGIN + URL_VALUE
      && element.download === 'file.mp4' && element.parentNode && !element.removed && element.style.display !== 'none'));
    assert.deepEqual(state.forbidden, []);
  }
});

test('an already aborted request cancels before dispatch and creates no anchor download', async () => {
  const controller = new AbortController(), state = harness({manager: true});
  controller.abort();
  assert.deepEqual(copy(await state.window.saveSocialDownload(URL_VALUE, 'file.mp4', {signal: controller.signal})), {status: 'cancelled'});
  assert.deepEqual(state.downloads, []); assert.deepEqual(state.forbidden, []);
});

test('aborting after dispatch cannot claim a browser download was cancelled', async () => {
  const controller = new AbortController(), state = harness();
  const pending = state.window.saveSocialDownload(URL_VALUE, 'file.mp4', {signal: controller.signal});
  assert.equal(state.downloads.length, 1);
  controller.abort();
  assert.equal(await state.window.cancelSocialDownloadSave(), false);
  assert.deepEqual(copy(await pending), {status: 'downloaded', filename: 'file.mp4'});
  assert.equal(state.downloads.length, 1); assert.deepEqual(state.forbidden, []);
});

test('separate image clicks each dispatch once without an active-save guard dropping later files', async () => {
  const state = harness({manager: true});
  const results = await Promise.all([0, 1, 2].map(index => state.window.saveSocialDownload(
    URL_VALUE.replace('index=0', 'index=' + index), 'photo-' + index + '.jpg')));
  assert.deepEqual(results.map(result => result.status), ['downloaded', 'downloaded', 'downloaded']);
  assert.deepEqual(state.downloads.map(item => item.filename), ['photo-0.jpg', 'photo-1.jpg', 'photo-2.jpg']);
  assert.equal(state.downloads.length, 3); assert.deepEqual(state.forbidden, []);
});

test('filename suggestions contain no paths or controls and use a usable default', async () => {
  const state = harness();
  const result = await state.window.saveSocialDownload(URL_VALUE, '../bad\r\nfile.mp4');
  assert.equal(/[\\/\x00-\x1f\x7f]/.test(result.filename), false);
  assert.equal(state.downloads[0].filename, result.filename);
  const fallback = await state.window.saveSocialDownload(URL_VALUE, '');
  assert.ok(fallback.filename);
});

test('localhost uses the same browser flow without a native macOS dialog or FSA requirement', async () => {
  const state = harness({local: true, manager: true});
  assert.equal((await state.window.saveSocialDownload(URL_VALUE, 'local.mp4')).status, 'downloaded');
  assert.equal(state.downloads[0].url, 'http://localhost:8000' + URL_VALUE);
  assert.deepEqual(state.forbidden, []);
});

test('malformed abort signals fail before starting a native request', async () => {
  const state = harness();
  await assert.rejects(state.window.saveSocialDownload(URL_VALUE, 'file.mp4', {signal: {aborted: false}}));
  assert.deepEqual(state.downloads, []);
});


test('onDispatched runs immediately after one native start and a callback abort cannot retract it', async () => {
  const state = harness({manager: true}), controller = new AbortController();
  let callbacks = 0, seenDownloads, seenFilename;
  const pending = state.window.saveSocialDownload(URL_VALUE, 'file.mp4', {signal: controller.signal,
    onDispatched: details => {
      callbacks++;
      seenDownloads = state.downloads.length;
      seenFilename = details.filename;
      controller.abort();
    }});
  assert.equal(callbacks, 1);
  assert.equal(seenDownloads, 1);
  assert.equal(seenFilename, 'file.mp4');
  assert.equal(controller.signal.aborted, true);
  assert.equal((await pending).status, 'downloaded');
  assert.equal(state.downloads.length, 1);
});

test('ready and pre-aborted outcomes never claim a successful native handoff', async () => {
  let callbacks = 0;
  const blocked = harness({blocked: true});
  assert.equal((await blocked.window.saveSocialDownload(URL_VALUE, 'file.mp4', {onDispatched: () => callbacks++})).status, 'ready');
  const cancelled = harness(), controller = new AbortController(); controller.abort();
  assert.equal((await cancelled.window.saveSocialDownload(URL_VALUE, 'file.mp4', {signal: controller.signal, onDispatched: () => callbacks++})).status, 'cancelled');
  assert.equal(callbacks, 0);
});
