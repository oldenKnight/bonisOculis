'use strict';
// store.js: atomic writes, .bak recovery, HMAC envelopes (brief 4.4, 4.5; PLAN 6).

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var h = require('./helpers.js');
var createStore = require('../main/store.js').createStore;

test('writes are atomic: no temp file left, the previous version becomes .bak', function () {
  var dir = h.tmpDir('store-atomic');
  var s = createStore({ dir: dir });
  assert.ok(s.writeJson('a/b.json', { v: 1 }));
  assert.ok(!fs.existsSync(path.join(dir, 'a/b.json.bak')), 'no backup before a second write');
  assert.ok(s.writeJson('a/b.json', { v: 2 }));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a/b.json'), 'utf8')), { v: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a/b.json.bak'), 'utf8')), { v: 1 });
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'a')).filter(function (n) { return /tmp/.test(n); }), []);
});

test('a corrupt file is restored from .bak, kept aside, and reported once', function () {
  var dir = h.tmpDir('store-bak');
  var s = createStore({ dir: dir });
  var events = [];
  s.on('recovered', function (e) { events.push(e); });
  s.writeJson('x.json', { good: 1 });
  s.writeJson('x.json', { good: 2 });
  fs.writeFileSync(path.join(dir, 'x.json'), '{"good": 2, "trunc');
  var r = s.readJson('x.json');
  assert.deepStrictEqual(r.value, { good: 1 });
  assert.strictEqual(r.recovered, true);
  assert.deepStrictEqual(events, [{ file: 'x.json' }]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'x.json'), 'utf8')), { good: 1 }, 'restored on disk');
  assert.ok(fs.existsSync(path.join(dir, 'x.json.corrupt')), 'damaged copy kept for diagnosis');
  assert.deepStrictEqual(s.readJson('x.json').value, { good: 1 });
  assert.strictEqual(events.length, 1);
});

test('a check function counts as corruption; missing files are not an error', function () {
  var dir = h.tmpDir('store-check');
  var s = createStore({ dir: dir });
  var events = [];
  s.on('recovered', function (e) { events.push(e); });
  assert.deepStrictEqual(s.readJson('none.json'), { value: null, recovered: false, missing: true });
  s.writeJson('c.json', { ok: true });
  s.writeJson('c.json', { ok: false });
  var r = s.readJson('c.json', function (v) { return v.ok === true; });
  assert.deepStrictEqual(r.value, { ok: true });
  fs.writeFileSync(path.join(dir, 'lost.json'), 'garbage');
  var lost = s.readJson('lost.json');
  assert.strictEqual(lost.value, null);
  assert.strictEqual(lost.lost, true);
  assert.strictEqual(events.length, 2);
});

test('envelopes carry an HMAC; tampering is reported and a valid backup wins', function () {
  var dir = h.tmpDir('store-hmac');
  var s = createStore({ dir: dir });
  s.setHmacKey('11'.repeat(32));
  var tampered = [];
  s.on('tampered', function (e) { tampered.push(e); });
  s.writeEnvelope('settings.json', { lockOnStart: true });
  s.writeEnvelope('settings.json', { lockOnStart: true, lang: 'es-MX' });
  assert.deepStrictEqual(s.readEnvelope('settings.json'), { lockOnStart: true, lang: 'es-MX' });
  var env = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  env.data.lockOnStart = false;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(env));
  assert.deepStrictEqual(s.readEnvelope('settings.json'), { lockOnStart: true }, 'the signed backup is used');
  assert.deepStrictEqual(tampered, [{ file: 'settings.json', restored: true }]);
  // No usable backup: data is used but flagged.
  fs.unlinkSync(path.join(dir, 'settings.json.bak'));
  env = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  env.data.lockOnStart = false;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(env));
  assert.deepStrictEqual(s.readEnvelope('settings.json'), { lockOnStart: false });
  assert.deepStrictEqual(tampered[1], { file: 'settings.json', restored: false });
});

test('settings validate every key and refuse main-only keys from the renderer', function () {
  var dir = h.tmpDir('settings');
  var s = createStore({ dir: dir });
  var settings = require('../main/settings.js').createSettings({ store: s });
  var d = settings.load('es-MX');
  assert.strictEqual(d.lang, 'es-MX');
  assert.strictEqual(d.levels.nudity, 'strict');
  assert.strictEqual(settings.set({ lang: 'fr-FR' }, true).ok, false);
  assert.strictEqual(settings.set({ analyzerCommand: { cmd: 'x' } }, true).error, 'unknownSetting');
  assert.strictEqual(settings.set({ panicKey: 'i' }, true).ok, false, 'marking keys cannot be the panic key');
  var r = settings.set({ preset: 'teens' }, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.levels.implied, 'light');
  var again = require('../main/settings.js').createSettings({ store: s });
  assert.strictEqual(again.load('en-US').preset, 'teens', 'persisted');
});
