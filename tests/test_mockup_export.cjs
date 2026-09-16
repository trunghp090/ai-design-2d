const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('public/app.js', 'utf8');
const handler = app.slice(app.indexOf('$("exportMockup").onclick'), app.indexOf('$("previewMockupPair").onclick'));
function setup(save, encode = true) {
  const button = {}, events = [], alerts = [];
  const ctx = {window: {saveToolFile: save}, $: () => button, currentSide: 'front',
    sides: {front: {bg: 'shirt', layers: [{src: 'art', state: {wPct: 38}}]}},
    snapshotSide() { events.push('snapshot'); }, alert: message => alerts.push(message),
    composeMockupSide: async side => {
      events.push(['compose', side]);
      return {toBlob(callback, type) { assert.equal(type, 'image/png'); callback(encode ? 'png-blob' : null); }};
    },
  };
  vm.createContext(ctx); vm.runInContext(handler, ctx);
  return {ctx, button, events, alerts};
}
test('mockup requests direct download and freezes artwork and side', async () => {
  let prepare, finish, filename;
  const {ctx, button, events, alerts} = setup((factory, name, options) => {
    assert.equal(options.directDownload, true);
    prepare = factory; filename = name;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = button.onclick();
  assert.equal(typeof prepare, 'function'); assert.deepEqual(events, ['snapshot']);
  assert.equal(button.disabled, true);
  await button.onclick(); assert.deepEqual(events, ['snapshot']);
  ctx.currentSide = 'back'; ctx.sides.front.layers[0].src = 'changed';
  assert.equal(await prepare(), 'png-blob');
  assert.equal(events[1][1].layers[0].src, 'art'); assert.equal(filename, 'mockup-front.png');
  finish('saved'); await pending;
  assert.equal(button.disabled, false); assert.deepEqual(alerts, []);
});
test('PNG failure is visible and restores export button', async () => {
  const {button, alerts} = setup(async factory => factory(), false);
  await button.onclick(); assert.match(alerts[0], /Không tạo được ảnh PNG/); assert.equal(button.disabled, false);
});
test('missing garment is rejected before save dialog', async () => {
  const {ctx, button, alerts} = setup(() => { throw Error('Picker must not open'); });
  ctx.sides.front.bg = '';
  await button.onclick(); assert.match(alerts[0], /Chưa có phôi/); assert.equal(button.disabled, false);
});
