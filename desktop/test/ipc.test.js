'use strict';
// ipc.js: the channel list is closed and matches the handlers; payload shapes are enforced; the
// lock leaves only kid-safe channels; a throwing handler never reaches the renderer; the preload
// forwards exactly the main events.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var ipc = require('../main/ipc.js');
var createHandlers = require('../main/handlers.js').createHandlers;

test('every channel has a handler and every handler a channel', function () {
  var h = createHandlers({ i18n: { t: function (k) { return k; } } });
  assert.deepStrictEqual(Object.keys(h).sort(), Object.keys(ipc.CHANNELS).sort());
});

test('PLAN 2.1 channels are all present', function () {
  ['library:list', 'library:add', 'library:remove', 'scan:queue', 'scan:pause', 'scan:resume', 'scan:cancel', 'scan:status',
    'skip:get', 'skip:save', 'skip:approve', 'skip:reject', 'skip:edit', 'skip:add', 'skip:delete', 'player:play', 'player:stop',
    'player:status', 'pin:set', 'pin:verify', 'pin:lock', 'settings:get', 'settings:set', 'export:json', 'export:edl',
    'export:clean', 'import:json', 'help:open', 'app:version'].forEach(function (c) { assert.ok(ipc.CHANNELS[c], c); });
});

test('payload shapes are checked before any handler runs', function () {
  assert.strictEqual(ipc.validate('nope:x', {}), 'unknownChannel');
  assert.strictEqual(ipc.validate('library:remove', {}), 'missing:id');
  assert.strictEqual(ipc.validate('library:remove', { id: '../../etc' }), 'bad:id');
  assert.strictEqual(ipc.validate('library:remove', { id: '0123456789abcdef', extra: 1 }), 'unexpected:extra');
  assert.strictEqual(ipc.validate('library:remove', 'x'), 'badPayload');
  assert.strictEqual(ipc.validate('library:remove', { id: '0123456789abcdef' }), null);
  assert.strictEqual(ipc.validate('pin:verify', { pin: '12', purpose: 'unlock' }), 'bad:pin');
  assert.strictEqual(ipc.validate('pin:verify', { pin: '1234', purpose: 'other' }), 'bad:purpose');
  assert.strictEqual(ipc.validate('skip:approve', { id: '0123456789abcdef', rangeIds: 'all' }), null);
  assert.strictEqual(ipc.validate('skip:approve', { id: '0123456789abcdef', rangeIds: ['r../x'] }), 'bad:rangeIds');
  assert.strictEqual(ipc.validate('skip:strip', { id: '0123456789abcdef', n: 100000 }), 'bad:n');
  assert.strictEqual(ipc.validate('library:add', { paths: [] }), 'bad:paths');
  assert.strictEqual(ipc.validate('export:clean', { id: '0123456789abcdef', aac: 'yes' }), 'bad:aac');
  assert.strictEqual(ipc.validate('app:state', undefined), null);
});

test('dispatch answers {ok, error, data}, never throws, and honours the lock', function (t, done) {
  var locked = false;
  var calls = [];
  var d = ipc.createIpc({
    'library:list': function (p, c, cb) { calls.push('list'); cb(null, [1]); },
    'library:remove': function () { throw new Error('boom'); },
    'pin:lock': function (p, c, cb) { cb('noPin'); }
  }, { isLocked: function () { return locked; }, log: { warn: function () {}, error: function () {} } });
  d.dispatch('library:list', {}, {}, function (r) {
    assert.deepStrictEqual(r, { ok: true, error: null, data: [1] });
    d.dispatch('library:remove', { id: '0123456789abcdef' }, {}, function (r2) {
      assert.deepStrictEqual(r2, { ok: false, error: 'internal', data: null });
      d.dispatch('pin:lock', {}, {}, function (r3) {
        assert.deepStrictEqual(r3, { ok: false, error: 'noPin', data: null });
        locked = true;
        d.dispatch('pin:lock', {}, {}, function (r4) {
          assert.strictEqual(r4.error, 'locked');
          d.dispatch('library:list', {}, {}, function (r5) {
            assert.strictEqual(r5.ok, true, 'kid-safe channel still served');
            d.dispatch('settings:set', { patch: {} }, {}, function (r6) {
              assert.strictEqual(r6.error, 'locked');
              d.dispatch('skip:get', { id: 'zz' }, {}, function (r7) {
                assert.strictEqual(r7.error, 'badPayload');
                done();
              });
            });
          });
        });
      });
    });
  });
});

test('kid mode reaches only playing, PIN and display channels', function () {
  var kid = Object.keys(ipc.CHANNELS).filter(function (c) { return ipc.CHANNELS[c].kid; }).sort();
  assert.deepStrictEqual(kid, ['app:state', 'app:version', 'library:list', 'library:poster', 'pin:recover', 'pin:status', 'pin:verify',
    'player:play', 'player:status', 'player:stop', 'settings:get']);
});

test('preload exposes only invoke and on, and forwards exactly the main events', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  var m = /var EVENTS = (\[[^\]]*\]);/.exec(src);
  assert.ok(m);
  assert.deepStrictEqual(JSON.parse(m[1].replace(/'/g, '"')), ipc.EVENTS);
  var exposed = /exposeInMainWorld\('bo', \{([\s\S]*)\}\);/.exec(src)[1];
  var keys = exposed.match(/^\s{2}(\w+):/gm).map(function (k) { return k.trim().replace(':', ''); });
  assert.deepStrictEqual(keys, ['invoke', 'on']);
});

test('the window is created with the hardened webPreferences and the page carries the CSP', function () {
  var w = fs.readFileSync(path.join(__dirname, '..', 'main', 'window.js'), 'utf8');
  ['contextIsolation: true', 'sandbox: true', 'nodeIntegration: false', 'webSecurity: true', 'webviewTag: false'].forEach(function (s) { assert.ok(w.indexOf(s) >= 0, s); });
  var html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.indexOf("content=\"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'\"") >= 0);
  assert.ok(!/<script>|<script [^>]*>[^<]/.test(html), 'no inline script');
  assert.ok(!/\sstyle="/.test(html), 'no inline style attributes');
  assert.ok(!/https?:\/\//.test(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), 'no remote URLs');
});
