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

// Chromium checks permissions against the cookie's own canonical origin, not
// only the URL passed to getAll. A non-Secure cookie has an http canonical URL.
// https://github.com/chromium/chromium/blob/main/extensions/browser/api/cookies/cookies_helpers.cc
// https://github.com/chromium/chromium/blob/main/net/cookies/cookie_util.cc
function cookieOriginAllowed(item, hostPermissions) {
  const host = item.domain.replace(/^\./, '').toLowerCase();
  const origin = (item.secure ? 'https://' : 'http://') + host;
  return hostPermissions.some(pattern => new URL(pattern).origin === origin);
}

function cookieMatchesRequest(item, address) {
  const url = new URL(address), host = item.domain.replace(/^\./, '').toLowerCase();
  return (!item.secure || url.protocol === 'https:')
    && (url.hostname === host || (!item.hostOnly && url.hostname.endsWith('.' + host)));
}

function workerHarness({hostPermissions = null} = {}) {
  let listener;
  const calls = [];
  const chrome = {
    runtime: {id: 'synthetic-extension-id', lastError: undefined, onMessage: {addListener: callback => {listener = callback;}}},
    cookies: {getAll: (details, callback) => calls.push({details, callback: items => callback(hostPermissions
      ? items.filter(item => cookieOriginAllowed(item, hostPermissions) && cookieMatchesRequest(item, details.url))
      : items)})},
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

function contentHarness(origin = ORIGIN, registeredVersion = '1.0.3') {
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
  const chrome = {runtime: {lastError: undefined, getManifest: () => ({version: registeredVersion}),
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
  assert.equal(manifest.version, '1.0.3');
  assert.deepEqual(manifest.permissions, ['cookies']);
  assert.deepEqual(manifest.host_permissions, ['https://douyin.com/*', 'http://douyin.com/*',
    'https://www.douyin.com/*', 'http://www.douyin.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches,
    [ORIGIN + '/*', 'http://localhost:8000/*', 'http://127.0.0.1:8000/*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('cookie host permissions cover root and www canonical origins for both Secure attributes only', () => {
  const {host_permissions: permissions} = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const domain of ['.douyin.com', 'www.douyin.com']) {
    for (const secure of [true, false]) {
      assert.equal(cookieOriginAllowed(cookie('sessionid', 'synthetic', {domain, secure}), permissions), true,
        domain + ' Secure=' + secure);
    }
  }
  for (const domain of ['other.douyin.com', '.live.douyin.com', 'v.douyin.com', '.iesdouyin.com',
    '.tiktok.com', 'douyin.com.evil.test', 'evildouyin.com', '.evil.test']) {
    for (const secure of [true, false]) {
      assert.equal(cookieOriginAllowed(cookie('sessionid', 'synthetic', {domain, secure}), permissions), false,
        domain + ' Secure=' + secure);
    }
  }
  assert.ok(permissions.every(pattern => /^https?:\/\/(?:www\.)?douyin\.com\/\*$/.test(pattern)));
});

test('SESSION sees a root or www login cookie after the browser canonical-origin permission filter', () => {
  const {host_permissions: hostPermissions} = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const domain of ['.douyin.com', 'www.douyin.com']) {
    for (const secure of [true, false]) {
      const state = workerHarness({hostPermissions}), request = state.dispatch();
      const login = cookie('sessionid', 'synthetic-login', {domain, secure, hostOnly: domain === 'www.douyin.com'});
      state.calls[0].callback([login, cookie('foreign', 'synthetic-foreign', {domain: '.evil.test'}),
        cookie('other-subdomain', 'synthetic-other', {domain: 'other.douyin.com', hostOnly: true})]);
      assert.deepEqual(request.responses, [{ok: true, loggedIn: true, cookie: 'sessionid=synthetic-login'}],
        domain + ' Secure=' + secure);
      assert.equal(state.calls[0].details.url, 'https://www.douyin.com/aweme/v1/web/aweme/detail/');
    }
  }
});

test('the old www-only HTTPS permission hides root-domain and non-Secure login cookies', () => {
  for (const extra of [{domain: '.douyin.com', secure: true}, {domain: '.douyin.com', secure: false},
    {domain: 'www.douyin.com', secure: false, hostOnly: true}]) {
    const state = workerHarness({hostPermissions: ['https://www.douyin.com/*']}), request = state.dispatch();
    state.calls[0].callback([cookie('sessionid', 'synthetic-login', extra)]);
    assert.equal(request.responses[0].ok, false);
    assert.equal(request.responses[0].code, 'LOGIN_REQUIRED');
    assert.equal(Object.hasOwn(request.responses[0], 'cookie'), false);
  }
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

test('missing, empty, expired or partitioned login requires login without revealing other cookies', () => {
  for (const cookies of [[], [cookie('UIFID_TEMP', 'synthetic-visitor-id')],
    [cookie('sessionid', ''), cookie('sessionid_ss', ''), cookie('sid_tt', '')],
    [cookie('sessionid', 'synthetic', {partitionKey: {topLevelSite: ORIGIN}})],
    [cookie('sessionid', 'synthetic', {expirationDate: 1})]]) {
    const state = workerHarness(), request = state.dispatch();
    state.calls[0].callback(cookies);
    assert.equal(request.responses[0].ok, false);
    assert.equal(request.responses[0].code, 'LOGIN_REQUIRED');
    assert.equal(Object.hasOwn(request.responses[0], 'cookie'), false);
  }
});

test('worker preserves ASCII spaces and quoted JSON cookie values without rewriting them', () => {
  const state = workerHarness(), request = state.dispatch();
  state.calls[0].callback([cookie('sessionid', 'synthetic login'), cookie('preferences', 'a b'),
    cookie('display', '{"theme": "light"}'), cookie('token', 'Synthetic+Token=')]);
  assert.deepEqual(request.responses, [{ok: true, loggedIn: true,
    cookie: 'sessionid=synthetic login; preferences=a b; display={"theme": "light"}; token=Synthetic+Token='}]);
});

test('unsupported preference cookies are skipped without discarding or exposing a valid login', () => {
  for (const extra of [cookie('bad\r\nHeader', 'synthetic-private'), cookie('device(mode)', 'synthetic-private'),
    cookie('preferences', 'synthetic-private\r\nInjected'), cookie('preferences', 'synthetic-private;Injected'),
    cookie('preferences', 'có dấu'), cookie('preferences', null), cookie('x'.repeat(257), 'synthetic-private')]) {
    const state = workerHarness(), request = state.dispatch();
    state.calls[0].callback([cookie(), extra]);
    assert.deepEqual(request.responses, [{ok: true, loggedIn: true, cookie: 'sessionid=synthetic-test-session'}]);
    assert.equal(JSON.stringify(request.responses).includes('synthetic-private'), false);
  }
});

test('invalid authentication cookies fail closed with a safe SESSION_INVALID diagnosis', () => {
  for (const name of ['sessionid', 'sessionid_ss', 'sid_tt']) {
    for (const value of ['synthetic-private\r\nInjected', 'synthetic-private;Injected', 'có dấu', '\0', '\x7f', 123]) {
      const state = workerHarness(), request = state.dispatch();
      state.calls[0].callback([cookie(), cookie(name, value)]);
      assert.equal(request.responses[0].ok, false);
      assert.equal(request.responses[0].code, 'SESSION_INVALID');
      assert.equal(typeof request.responses[0].error, 'string');
      assert.equal(Object.hasOwn(request.responses[0], 'cookie'), false);
      assert.equal(JSON.stringify(request.responses).includes('synthetic-private'), false);
    }
  }
});

test('excessive headers and malformed cookie arrays have distinct safe diagnoses', () => {
  for (const [items,code] of [
    [[cookie('sessionid', 'x'.repeat(16001))], 'SESSION_TOO_LARGE'],
    [null, 'SESSION_INVALID'], [{}, 'SESSION_INVALID'], [Array(1001).fill(cookie()), 'SESSION_INVALID'],
  ]) {
    const state = workerHarness(), request = state.dispatch();
    state.calls[0].callback(items);
    assert.equal(request.responses[0].ok, false);
    assert.equal(request.responses[0].code, code);
    assert.equal(typeof request.responses[0].error, 'string');
    assert.equal(Object.hasOwn(request.responses[0], 'cookie'), false);
    assert.ok(request.responses[0].error.length < 300);
  }
});

test('cookie API errors and exceptions report COOKIE_API_FAILED without raw errors', () => {
  const callback = workerHarness(), request = callback.dispatch();
  callback.chrome.runtime.lastError = {message: 'synthetic-private-error'};
  callback.calls[0].callback([]);
  const exception = workerHarness();
  exception.chrome.cookies.getAll = () => {throw Error('synthetic-private-error');};
  const thrown = exception.dispatch();
  for (const response of [request.responses[0],thrown.responses[0]]) {
    assert.equal(response.ok, false);
    assert.equal(response.code, 'COOKIE_API_FAILED');
    assert.equal(Object.hasOwn(response, 'cookie'), false);
    assert.equal(response.error.includes('synthetic-private-error'), false);
  }
  assert.equal(request.responses[0].error, thrown.responses[0].error);
});

test('STATUS returns only installation protocol and connection state with no runtime or cookie access', () => {
  const state = contentHarness();
  const request = state.request('STATUS');
  assert.deepEqual(state.posts[0], {target: ORIGIN, value: {
    source: 'aidesign-douyin-extension', type: 'RESPONSE', requestId: request.requestId,
    nonce: NONCE, version: '1.0.3', connected: false, ok: true,
  }});
  assert.equal(state.runtimeRequests.length, 0);
});

test('edited content source reports the registered manifest version until the extension reloads', () => {
  const state = contentHarness(ORIGIN, '1.0.1');
  state.request('STATUS');
  assert.equal(state.posts[0].value.version, '1.0.1');
  assert.equal(state.posts[0].value.connected, false);
  assert.equal(Object.hasOwn(state.posts[0].value, 'cookie'), false);
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
  assert.equal(timeout.posts.at(-1).value.code, 'BRIDGE_TIMEOUT');
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
  assert.equal(error.posts.at(-1).value.code, 'BRIDGE_UNAVAILABLE');
  assert.equal(JSON.stringify(error.posts).includes('synthetic-private-error'), false);
});

test('content forwards only fixed safe worker diagnoses without raw errors or session data', () => {
  for (const code of ['LOGIN_REQUIRED', 'SESSION_INVALID', 'SESSION_TOO_LARGE', 'COOKIE_API_FAILED']) {
    const state = contentHarness();
    state.request('STATUS');
    state.click('socialDownloadResolve');
    state.request('SESSION');
    state.runtimeRequests.at(-1).callback({ok: false, code, error: 'synthetic-private-error',
      cookie: 'sessionid=synthetic-private-secret', userAgent: 'synthetic-private-agent'});
    const response = state.posts.at(-1).value;
    assert.equal(response.ok, false);
    assert.equal(response.code, code);
    assert.equal(response.connected, false);
    assert.equal(typeof response.error, 'string');
    assert.ok(response.error.length > 0 && response.error.length < 300);
    assert.equal(Object.hasOwn(response, 'cookie'), false);
    assert.equal(Object.hasOwn(response, 'userAgent'), false);
    assert.equal(JSON.stringify(response).includes('synthetic-private'), false);
  }
});

test('unknown or malformed worker error codes safely become SESSION_INVALID', () => {
  for (const code of ['FAILED', '__proto__', 'constructor', 'synthetic-private-code',
    {toString: 1, valueOf: 2}, ['COOKIE_API_FAILED'], null, 123]) {
    const state = contentHarness();
    state.request('STATUS');
    state.click('socialDownloadResolve');
    state.request('SESSION');
    state.runtimeRequests.at(-1).callback({ok: false, code, error: 'synthetic-private-error'});
    const response = state.posts.at(-1).value;
    assert.equal(response.ok, false);
    assert.equal(response.code, 'SESSION_INVALID');
    assert.equal(typeof response.error, 'string');
    assert.equal(JSON.stringify(response).includes('synthetic-private'), false);
  }
});

test('missing runtime responses and thrown bridge errors become BRIDGE_UNAVAILABLE', () => {
  for (const value of [undefined, null]) {
    const state = contentHarness();
    state.request('STATUS');
    state.click('socialDownloadResolve');
    state.request('SESSION');
    state.runtimeRequests.at(-1).callback(value);
    assert.equal(state.posts.at(-1).value.code, 'BRIDGE_UNAVAILABLE');
    assert.equal(Object.hasOwn(state.posts.at(-1).value, 'cookie'), false);
  }
  const thrown = contentHarness();
  thrown.request('STATUS');
  thrown.click('socialDownloadResolve');
  thrown.chrome.runtime.sendMessage = () => {throw Error('synthetic-private-error');};
  thrown.request('SESSION');
  assert.equal(thrown.posts.at(-1).value.code, 'BRIDGE_UNAVAILABLE');
  assert.equal(JSON.stringify(thrown.posts).includes('synthetic-private-error'), false);
});

test('malformed runtime replies and browser user agents fail closed with SESSION_INVALID', () => {
  for (const result of [{}, [], 'synthetic-private-data', {ok: 'true'},
    {ok: true, loggedIn: false}, {ok: true, loggedIn: true, cookie: ''},
    {ok: true, loggedIn: true, cookie: 'synthetic-private\r\nHeader'},
    {ok: true, loggedIn: true, cookie: 'x'.repeat(16001)}]) {
    const state = contentHarness();
    state.request('STATUS');
    state.click('socialDownloadResolve');
    state.request('SESSION');
    state.runtimeRequests.at(-1).callback(result);
    assert.equal(state.posts.at(-1).value.code, 'SESSION_INVALID');
    assert.equal(Object.hasOwn(state.posts.at(-1).value, 'cookie'), false);
    assert.equal(JSON.stringify(state.posts).includes('synthetic-private'), false);
  }
  for (const userAgent of ['', 'x'.repeat(513), 'synthetic-private\r\nHeader', 'có dấu', 123]) {
    const state = contentHarness();
    state.navigator.userAgent = userAgent;
    state.request('STATUS');
    state.click('socialDownloadResolve');
    state.request('SESSION');
    state.runtimeRequests.at(-1).callback({ok: true, loggedIn: true, cookie: 'sessionid=synthetic-private-secret'});
    assert.equal(state.posts.at(-1).value.code, 'SESSION_INVALID');
    assert.equal(Object.hasOwn(state.posts.at(-1).value, 'cookie'), false);
    assert.equal(JSON.stringify(state.posts).includes('synthetic-private'), false);
  }
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
