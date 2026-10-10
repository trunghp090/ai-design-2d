const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const directory = path.join(__dirname, '../browser-extension/douyin-connect');
const NONCE = '11111111-1111-4111-8111-111111111111';
const OTHER_NONCE = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://riengvnapp.cloud';
const UA = 'Synthetic-Desktop-Test-Agent/1.0';
let serial = 0;
const uuid = () => '00000000-0000-4000-8000-' + (++serial).toString(16).padStart(12, '0');
const copied = value => JSON.parse(JSON.stringify(value));
const cookie = (name = 'sessionid', value = 'synthetic-test-session', extra = {}) => ({
  name, value, domain: '.douyin.com', path: '/', httpOnly: true, secure: true, hostOnly: false, ...extra,
});

function workerHarness() {
  let listener;
  const calls = [];
  const chrome = {
    runtime: {id: 'synthetic-extension-id', lastError: undefined, onMessage: {addListener: callback => {listener = callback;}}},
    cookies: {getAll: (details, callback) => calls.push({details, callback})},
  };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'service-worker.js'), 'utf8'), {chrome, URL, Date, Set, Error});
  const sender = {id: chrome.runtime.id, frameId: 0, url: ORIGIN + '/', tab: {id: 1, incognito: false}};
  function dispatch(type = 'SESSION', overrides = {}, target = sender) {
    const responses = [];
    const keepOpen = listener({source: 'aidesign-douyin-content', type, requestId: uuid(), nonce: NONCE, ...overrides}, target,
      value => responses.push(copied(value)));
    return {responses, keepOpen};
  }
  return {chrome, calls, dispatch, sender};
}

function contentHarness(origin = ORIGIN) {
  const listeners = {window: new Map(), document: new Map()};
  const posts = [], runtimeRequests = [], timers = new Map();
  let timerID = 0, clock = 1000;
  const add = kind => (event, listener) => {
    if (!listeners[kind].has(event)) listeners[kind].set(event, []);
    listeners[kind].get(event).push(listener);
  };
  const window = {addEventListener: add('window'), postMessage: (value, target) => posts.push({value: copied(value), target})};
  window.top = window;
  const navigator = {userAgent: UA, userActivation: {isActive: false}};
  const chrome = {runtime: {lastError: undefined,
    sendMessage: (value, callback) => runtimeRequests.push({value: copied(value), callback})}};
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'content-script.js'), 'utf8'), {
    window, document: {addEventListener: add('document')}, location: {origin}, navigator, chrome,
    Date: {now: () => clock}, Set, Error,
    setTimeout: (callback, ms) => {const id = ++timerID; timers.set(id, {callback, ms}); return id;},
    clearTimeout: id => timers.delete(id),
  });
  function emit(kind, type, event) {
    for (const listener of listeners[kind].get(type) || []) listener(event);
  }
  function request(type, extra = {}, eventExtra = {}) {
    const value = {source: 'aidesign-douyin-page', type, requestId: uuid(), nonce: NONCE, ...extra};
    emit('window', 'message', {source: window, origin, data: value, ...eventExtra});
    return value;
  }
  function click(id, isTrusted = true) {
    emit('document', 'click', {isTrusted, target: {closest: () => ({id})}});
  }
  function connect() {
    request('STATUS');
    click('socialDownloadConnectDouyin');
    const value = request('CONNECT');
    runtimeRequests.at(-1).callback({ok: true, loggedIn: true});
    return value;
  }
  return {window, navigator, chrome, posts, runtimeRequests, timers, request, click, connect, emit,
    advance: ms => {clock += ms;}};
}

test('manifest limits permissions and content origins and uses MV3 isolated scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.1');
  assert.deepEqual(manifest.permissions, ['cookies']);
  assert.deepEqual(manifest.host_permissions, ['https://www.douyin.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches,
    [ORIGIN + '/*', 'http://localhost:8000/*', 'http://127.0.0.1:8000/*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('worker rejects foreign extensions, origins, frames, incognito and malformed messages without cookie access', () => {
  const state = workerHarness();
  const targets = [{...state.sender, id: 'other-extension'}, {...state.sender, frameId: 1},
    {...state.sender, tab: undefined}, {...state.sender, tab: {incognito: true}},
    {...state.sender, url: 'https://riengvnapp.cloud.evil.test/'},
    {...state.sender, url: 'https://riengvnapp.cloud:8443/'},
    {...state.sender, url: 'http://localhost:8001/'}, {...state.sender, url: 'https://user@riengvnapp.cloud/'}];
  for (const target of targets) assert.equal(state.dispatch('SESSION', {}, target).keepOpen, false);
  for (const extra of [{source: 'other'}, {type: 'STATUS'}, {requestId: 'wrong'}, {nonce: 'wrong'}, {url: 'https://evil.test/'}]) {
    assert.equal(state.dispatch('SESSION', extra).keepOpen, false);
  }
  assert.equal(state.calls.length, 0);
});

test('CONNECT validates login but never returns Cookie or User-Agent', () => {
  const state = workerHarness();
  const request = state.dispatch('CONNECT');
  assert.equal(request.keepOpen, true);
  assert.deepEqual(copied(state.calls[0].details), {url: 'https://www.douyin.com/aweme/v1/web/aweme/detail/'});
  state.calls[0].callback([cookie(), cookie('UIFID_TEMP', 'synthetic-visitor-id')]);
  assert.deepEqual(request.responses, [{ok: true, loggedIn: true}]);
});

test('SESSION includes HttpOnly cookies and current visitor hints with duplicate names preserved in API path order', () => {
  const state = workerHarness();
  const request = state.dispatch();
  state.calls[0].callback([cookie('sessionid', 'synthetic-specific', {path: '/aweme/'}),
    cookie('sessionid', 'synthetic-root'), cookie('UIFID_TEMP', 'synthetic-visitor-id'),
    cookie('msToken', 'Synthetic+Token='), cookie('foreign', 'ignored', {domain: '.evil.test'}),
    cookie('subdomain', 'ignored', {domain: 'other.douyin.com', hostOnly: true}),
    cookie('expired', 'ignored', {expirationDate: 1}),
    cookie('partitioned', 'ignored', {partitionKey: {topLevelSite: ORIGIN}})]);
  assert.deepEqual(request.responses, [{ok: true, loggedIn: true,
    cookie: 'sessionid=synthetic-specific; sessionid=synthetic-root; UIFID_TEMP=synthetic-visitor-id; msToken=Synthetic+Token='}]);
});

test('missing, expired or partitioned login requires login without revealing other cookies', () => {
  for (const cookies of [[], [cookie('UIFID_TEMP', 'synthetic-visitor-id')],
    [cookie('sessionid', 'synthetic', {partitionKey: {topLevelSite: ORIGIN}})],
    [cookie('sessionid', 'synthetic', {expirationDate: 1})]]) {
    const state = workerHarness(), request = state.dispatch();
    state.calls[0].callback(cookies);
    assert.equal(request.responses[0].ok, false);
    assert.equal(request.responses[0].code, 'LOGIN_REQUIRED');
    assert.equal(Object.hasOwn(request.responses[0], 'cookie'), false);
  }
});

test('worker rejects header injection, excessive header and invalid callback without exposing raw errors', () => {
  for (const cookies of [[cookie('bad\r\nHeader', 'synthetic')], [cookie('sessionid', 'synthetic\r\nsecret')],
    [cookie('sessionid', 'synthetic;secret')], [cookie('sessionid', 'x'.repeat(16001))],
    [cookie('sessionid', 'có dấu')], null]) {
    const state = workerHarness(), request = state.dispatch();
    state.calls[0].callback(cookies);
    assert.equal(request.responses[0].ok, false);
    assert.equal(request.responses[0].code, 'FAILED');
    assert.equal(Object.hasOwn(request.responses[0], 'cookie'), false);
  }
  const state = workerHarness(), request = state.dispatch();
  state.chrome.runtime.lastError = {message: 'synthetic-private-error'};
  state.calls[0].callback([]);
  assert.equal(JSON.stringify(request.responses).includes('synthetic-private-error'), false);
});

test('STATUS returns only installation protocol and connection state with no runtime or cookie access', () => {
  const state = contentHarness();
  const request = state.request('STATUS');
  assert.deepEqual(state.posts[0], {target: ORIGIN, value: {
    source: 'aidesign-douyin-extension', type: 'RESPONSE', requestId: request.requestId,
    nonce: NONCE, version: '1.0.1', connected: false, ok: true,
  }});
  assert.equal(state.runtimeRequests.length, 0);
});

test('content rejects wrong origin, window, protocol, nonce, extra data and repeated request IDs', () => {
  const state = contentHarness();
  state.request('STATUS', {}, {origin: 'https://evil.test'});
  state.request('STATUS', {}, {source: {}});
  state.request('STATUS', {source: 'other'});
  state.request('STATUS', {requestId: 'invalid'});
  state.request('STATUS', {cookie: 'synthetic-secret'});
  assert.equal(state.posts.length, 0);
  const first = state.request('STATUS');
  state.request('STATUS', {nonce: OTHER_NONCE});
  state.request('STATUS', {requestId: first.requestId});
  assert.equal(state.posts.length, 1);
  assert.equal(state.runtimeRequests.length, 0);
});

test('CONNECT and SESSION require genuine matching button activation', () => {
  for (const type of ['CONNECT', 'SESSION']) {
    const button = type === 'CONNECT' ? 'socialDownloadConnectDouyin' : 'socialDownloadResolve';
    const wrong = type === 'CONNECT' ? 'socialDownloadResolve' : 'socialDownloadConnectDouyin';
    for (const activation of ['none', 'synthetic', 'wrong', 'expired']) {
      const state = contentHarness();
      state.request('STATUS');
      if (activation === 'synthetic') state.click(button, false);
      if (activation === 'wrong') state.click(wrong);
      if (activation === 'expired') { state.click(button); state.advance(5001); }
      state.request(type);
      assert.equal(state.runtimeRequests.length, 0);
      assert.equal(state.posts.at(-1).value.code, 'FAILED');
      assert.equal(Object.hasOwn(state.posts.at(-1).value, 'cookie'), false);
    }
  }
});

test('a genuine download action obtains a fresh session without a prior CONNECT', () => {
  const state = contentHarness();
  state.request('STATUS');
  state.click('socialDownloadResolve');
  state.request('SESSION');
  assert.equal(state.runtimeRequests.length, 1);
  assert.equal(state.runtimeRequests[0].value.type, 'SESSION');
  assert.equal(state.posts.length, 1);
  state.runtimeRequests[0].callback({ok: true, cookie: 'sessionid=synthetic-first-download', loggedIn: true});
  assert.equal(state.posts.at(-1).value.cookie, 'sessionid=synthetic-first-download');
  assert.equal(state.posts.at(-1).value.connected, true);
  state.request('SESSION');
  assert.equal(state.runtimeRequests.length, 1);
  assert.equal(state.posts.at(-1).value.code, 'FAILED');
});

test('connection returns no secrets; each authorized SESSION obtains current cookie and browser UA', () => {
  const state = contentHarness();
  state.connect();
  const connected = state.posts.at(-1).value;
  assert.equal(connected.connected, true);
  assert.equal(connected.loggedIn, true);
  assert.equal(Object.hasOwn(connected, 'cookie'), false);
  assert.equal(Object.hasOwn(connected, 'userAgent'), false);
  for (const value of ['synthetic-first-session', 'synthetic-fresh-session']) {
    state.click('socialDownloadResolve');
    state.request('SESSION');
    state.runtimeRequests.at(-1).callback({ok: true, cookie: 'sessionid=' + value, loggedIn: true});
    assert.equal(state.posts.at(-1).value.cookie, 'sessionid=' + value);
    assert.equal(state.posts.at(-1).value.userAgent, UA);
  }
  assert.equal(state.runtimeRequests.length, 3);
  state.request('SESSION');
  assert.equal(state.runtimeRequests.length, 3);
});

test('trusted Enter and active trusted form submission authorize sessions; synthetic events do not', () => {
  const state = contentHarness();
  state.connect();
  state.emit('document', 'keydown', {isTrusted: false, key: 'Enter', target: {id: 'socialDownloadInput'}});
  state.emit('document', 'submit', {isTrusted: true, target: {id: 'socialDownloadForm'}});
  state.request('SESSION');
  assert.equal(state.runtimeRequests.length, 1);
  state.emit('document', 'keydown', {isTrusted: true, key: 'Enter', isComposing: false, target: {id: 'socialDownloadInput'}});
  state.request('SESSION');
  state.runtimeRequests.at(-1).callback({ok: true, cookie: 'sessionid=synthetic-enter', loggedIn: true});
  state.navigator.userActivation.isActive = true;
  state.emit('document', 'submit', {isTrusted: true, target: {id: 'socialDownloadForm'}});
  state.request('SESSION');
  assert.equal(state.runtimeRequests.length, 3);
});

test('DISCONNECT drops late CONNECT and SESSION callbacks and clears authorization immediately', () => {
  for (const pendingType of ['CONNECT', 'SESSION']) {
    const state = contentHarness();
    if (pendingType === 'SESSION') state.connect();
    else state.request('STATUS');
    state.click(pendingType === 'CONNECT' ? 'socialDownloadConnectDouyin' : 'socialDownloadResolve');
    const request = state.request(pendingType);
    const pending = state.runtimeRequests.at(-1);
    state.request('DISCONNECT');
    const count = state.posts.length;
    pending.callback({ok: true, cookie: 'sessionid=synthetic-late-secret', loggedIn: true});
    assert.equal(state.posts.length, count);
    assert.equal(state.posts.at(-1).value.connected, false);
    assert.equal(JSON.stringify(state.posts).includes('synthetic-late-secret'), false);
    assert.equal(state.posts.some(post => post.value.requestId === request.requestId), false);
    state.request('SESSION');
    assert.equal(state.posts.at(-1).value.code, 'FAILED');
    const reads = state.runtimeRequests.length;
    state.click('socialDownloadResolve');
    state.request('SESSION');
    assert.equal(state.runtimeRequests.length, reads + 1);
    state.runtimeRequests.at(-1).callback({ok: true, cookie: 'sessionid=synthetic-after-disconnect', loggedIn: true});
    assert.equal(state.posts.at(-1).value.cookie, 'sessionid=synthetic-after-disconnect');
    assert.equal(state.posts.at(-1).value.connected, true);
  }
});

test('worker timeout, pagehide and runtime errors never release stale cookies', () => {
  const timeout = contentHarness();
  timeout.connect();
  timeout.click('socialDownloadResolve');
  timeout.request('SESSION');
  const pending = timeout.runtimeRequests.at(-1);
  [...timeout.timers.values()][0].callback();
  const count = timeout.posts.length;
  pending.callback({ok: true, cookie: 'sessionid=synthetic-late-secret', loggedIn: true});
  assert.equal(timeout.posts.length, count);
  assert.equal(timeout.posts.at(-1).value.code, 'FAILED');
  const hidden = contentHarness();
  hidden.connect();
  hidden.click('socialDownloadResolve');
  hidden.request('SESSION');
  hidden.emit('window', 'pagehide', {});
  hidden.runtimeRequests.at(-1).callback({ok: true, cookie: 'sessionid=synthetic-late-secret', loggedIn: true});
  assert.equal(JSON.stringify(hidden.posts).includes('synthetic-late-secret'), false);
  const error = contentHarness();
  error.request('STATUS');
  error.click('socialDownloadConnectDouyin');
  error.request('CONNECT');
  error.chrome.runtime.lastError = {message: 'synthetic-private-error'};
  error.runtimeRequests.at(-1).callback({ok: true, cookie: 'sessionid=synthetic-secret', loggedIn: true});
  assert.equal(error.posts.at(-1).value.code, 'FAILED');
  assert.equal(JSON.stringify(error.posts).includes('synthetic-private-error'), false);
});

test('login expiry revokes connection and extension remains inert on unsupported origins', () => {
  const state = contentHarness();
  state.connect();
  state.click('socialDownloadResolve');
  state.request('SESSION');
  state.runtimeRequests.at(-1).callback({ok: false, code: 'LOGIN_REQUIRED'});
  assert.equal(state.posts.at(-1).value.code, 'LOGIN_REQUIRED');
  assert.equal(state.posts.at(-1).value.connected, false);
  for (const origin of ['https://evil.test', 'https://riengvnapp.cloud:8443', 'http://localhost:8001']) {
    const unsupported = contentHarness(origin);
    unsupported.request('STATUS');
    unsupported.click('socialDownloadConnectDouyin');
    unsupported.request('CONNECT');
    assert.equal(unsupported.posts.length, 0);
    assert.equal(unsupported.runtimeRequests.length, 0);
  }
});

test('extension source contains no storage, cookie mutation, external listeners, networking or raw logs', () => {
  for (const name of ['service-worker.js', 'content-script.js']) {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.doesNotMatch(source, /chrome\.storage|localStorage|sessionStorage|indexedDB|console\.|fetch\(|XMLHttpRequest|onMessageExternal|cookies\.(set|remove)/);
  }
});
