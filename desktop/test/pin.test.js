'use strict';
// pin.js: scrypt hash, cooldown (5 tries -> 30 s, doubling, persisted), recovery code, peek window.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var h = require('./helpers.js');
var createStore = require('../main/store.js').createStore;
var pinMod = require('../main/pin.js');

function make(dir, clock) {
  var store = createStore({ dir: dir });
  var pin = pinMod.createPin({ store: store, now: function () { return clock.t; } });
  pin.load();
  return pin;
}

test('PIN is stored as an scrypt hash with a per-install salt; verify uses it', function () {
  var dir = h.tmpDir('pin-hash');
  var clock = { t: 1000000 };
  var pin = make(dir, clock);
  assert.strictEqual(pin.hasPin(), false);
  assert.strictEqual(pin.setPin('12a4').ok, false);
  var r = pin.setPin('4821');
  assert.strictEqual(r.ok, true);
  assert.match(r.recoveryCode, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.strictEqual(pin.setPin('9999').ok, false, 'a second setPin is refused');
  var sec = fs.readFileSync(path.join(dir, 'secure.json'), 'utf8');
  assert.ok(sec.indexOf('4821') < 0, 'no plaintext PIN');
  assert.ok(sec.indexOf(r.recoveryCode.replace(/-/g, '')) < 0, 'no plaintext recovery code');
  var j = JSON.parse(sec);
  assert.match(j.salt, /^[0-9a-f]{32}$/, '16-byte salt');
  assert.match(j.pin.hash, /^[0-9a-f]{64}$/);
  assert.strictEqual(pin.verify('4821').ok, true);
  assert.strictEqual(pin.verify('4822').ok, false);
  var other = h.tmpDir('pin-hash2');
  var pin2 = make(other, clock);
  pin2.setPin('4821');
  assert.notStrictEqual(JSON.parse(fs.readFileSync(path.join(other, 'secure.json'), 'utf8')).pin.hash, j.pin.hash, 'salt differs per install');
});

test('5 wrong tries -> 30 s cooldown, then doubling; persisted across restarts', function () {
  var dir = h.tmpDir('pin-cool');
  var clock = { t: 5000000 };
  var pin = make(dir, clock);
  pin.setPin('2468');
  var i, r;
  for (i = 0; i < 4; i++) {
    r = pin.verify('0000');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.cooldownMs, 0);
    assert.strictEqual(r.triesLeft, 4 - i);
  }
  r = pin.verify('0000');
  assert.strictEqual(r.cooldownMs, 30000);
  assert.strictEqual(pin.verify('2468').ok, false, 'even the right PIN waits');
  // Restart: the cooldown survives.
  var again = make(dir, clock);
  assert.ok(again.status().cooldownMs > 29000);
  clock.t += 30001;
  r = again.verify('1111');
  assert.strictEqual(r.cooldownMs, 60000, 'doubled');
  clock.t += 60001;
  r = again.verify('1111');
  assert.strictEqual(r.cooldownMs, 120000);
  clock.t += 120001;
  assert.strictEqual(again.verify('2468').ok, true);
  assert.strictEqual(again.status().triesLeft, 5, 'reset after success');
});

test('recovery code sets a new PIN once and is replaced', function () {
  var dir = h.tmpDir('pin-recover');
  var clock = { t: 9000000 };
  var pin = make(dir, clock);
  var code = pin.setPin('1357').recoveryCode;
  assert.strictEqual(pin.recover('AAAA-AAAA-AAAA', '8642').ok, false);
  var r = pin.recover(code.toLowerCase().replace(/-/g, ' '), '8642');
  assert.strictEqual(r.ok, true, 'case and separators do not matter');
  assert.notStrictEqual(r.recoveryCode, code);
  assert.strictEqual(pin.verify('1357').ok, false);
  assert.strictEqual(pin.verify('8642').ok, true);
  assert.strictEqual(pin.recover(code, '1111').ok, false, 'the old code is used up');
  assert.strictEqual(pin.recover(r.recoveryCode, '7391').ok, true);
});

test('lock state is in memory; peek needs a PIN within 5 minutes', function () {
  var dir = h.tmpDir('pin-peek');
  var clock = { t: 20000000 };
  var pin = make(dir, clock);
  pin.setPin('5821');
  assert.strictEqual(pin.peekAllowed(), true, 'just entered at setup');
  clock.t += pinMod.PEEK_FRESH_MS + 1;
  assert.strictEqual(pin.peekAllowed(), false);
  assert.strictEqual(pin.verify('5821', 'peek').ok, true);
  assert.strictEqual(pin.peekAllowed(), true);
  clock.t += 4 * 60000;
  pin.touchPeek();
  clock.t += 4 * 60000;
  assert.strictEqual(pin.peekAllowed(), true, 'each peek keeps the window open');
  pin.lock();
  assert.strictEqual(pin.isLocked(), true);
  assert.strictEqual(pin.peekAllowed(), false, 'never while locked');
  assert.strictEqual(pin.verify('5821', 'peek').ok, true);
  assert.strictEqual(pin.isLocked(), true, 'a peek PIN does not unlock');
  assert.strictEqual(pin.verify('5821', 'unlock').ok, true);
  assert.strictEqual(pin.isLocked(), false);
  assert.strictEqual(make(dir, clock).isLocked(), false, 'a new process decides the lock itself');
});

test('PINs kids guess first are refused', function () {
  var pin = make(h.tmpDir('pin-weak'), { t: 1 });
  ['0000', '1111', '1234', '4321', '123456', '1212', '2580'].forEach(function (p) {
    assert.deepStrictEqual(pin.setPin(p), { ok: false, error: 'pinWeak' }, p);
  });
  assert.strictEqual(pin.setPin('4821').ok, true);
});
