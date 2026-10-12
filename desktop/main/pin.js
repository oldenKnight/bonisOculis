'use strict';
// Parent PIN (PLAN 6, LEDGER D17: a deterrent, not a security boundary).
//  - scrypt N=2^15 r=8 p=1, per-install 16-byte salt, compared with timingSafeEqual.
//  - 5 wrong tries -> 30 s cooldown; every further wrong try after a cooldown doubles it (max
//    15 min). Counters persist in secure.json, so restarting the app does not reset them.
//  - A 12-character recovery code is generated at setup, shown once, stored hashed.
//  - Lock state lives in memory only. Peek needs a PIN entered within the last 5 minutes.
// secure.json also holds the HMAC key used by store.js for settings and library files.

var crypto = require('crypto');

var FILE = 'secure.json';
var SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
var KEYLEN = 32;
var MAX_TRIES = 5;
var COOLDOWN_MS = 30000;
var COOLDOWN_MAX_MS = 15 * 60 * 1000;
var PEEK_FRESH_MS = 5 * 60 * 1000;
var CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0 O 1 I L: easy to copy by hand
var CODE_LEN = 12;

function hash(secret, saltHex) {
  return crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), KEYLEN, SCRYPT).toString('hex');
}

function same(aHex, bHex) {
  var a = Buffer.from(String(aHex || ''), 'hex');
  var b = Buffer.from(String(bHex || ''), 'hex');
  if (a.length !== b.length || a.length === 0) { return false; }
  return crypto.timingSafeEqual(a, b);
}

function validPin(pin) { return typeof pin === 'string' && /^[0-9]{4,6}$/.test(pin); }

function normaliseCode(code) { return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); }

function newRecoveryCode() {
  var bytes = crypto.randomBytes(CODE_LEN);
  var s = '';
  var i;
  for (i = 0; i < CODE_LEN; i++) { s += CODE_ALPHABET.charAt(bytes[i] % CODE_ALPHABET.length); }
  return s;
}

function formatCode(code) { return code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8, 12); }

function createPin(options) {
  var o = options || {};
  var store = o.store;
  var now = o.now || function () { return Date.now(); };
  var sec = null;
  var locked = false;
  var lastPinAt = 0;

  function load() {
    var r = store.readJson(FILE, function (v) { return v && typeof v.hmacKey === 'string'; });
    sec = r.value;
    if (!sec) {
      sec = { version: 1, hmacKey: crypto.randomBytes(32).toString('hex'), salt: crypto.randomBytes(16).toString('hex'),
        pin: null, recovery: null, failures: 0, cooldownUntil: 0, cooldownMs: 0 };
      save();
    }
    store.setHmacKey(sec.hmacKey);
    return sec;
  }

  function save() { return store.writeJson(FILE, sec); }

  function hasPin() { return !!(sec && sec.pin && sec.pin.hash); }

  function cooldownLeft() {
    var left = (sec.cooldownUntil || 0) - now();
    return left > 0 ? left : 0;
  }

  function fail() {
    sec.failures = (sec.failures || 0) + 1;
    if (sec.failures >= MAX_TRIES) {
      sec.cooldownMs = sec.cooldownMs ? Math.min(sec.cooldownMs * 2, COOLDOWN_MAX_MS) : COOLDOWN_MS;
      sec.cooldownUntil = now() + sec.cooldownMs;
    }
    save();
    var left = cooldownLeft();
    return { ok: false, cooldownMs: left, triesLeft: left ? 0 : Math.max(0, MAX_TRIES - sec.failures) };
  }

  function succeed() {
    if (sec.failures || sec.cooldownMs || sec.cooldownUntil) {
      sec.failures = 0; sec.cooldownMs = 0; sec.cooldownUntil = 0;
      save();
    }
  }

  function makeRecovery() {
    var code = newRecoveryCode();
    var salt = crypto.randomBytes(16).toString('hex');
    sec.recovery = { salt: salt, hash: hash(code, salt) };
    return formatCode(code);
  }

  // First PIN (or a reset after recovery). Returns {ok, recoveryCode}.
  function setPin(pin) {
    if (!validPin(pin)) { return { ok: false, error: 'pinShape' }; }
    if (hasPin()) { return { ok: false, error: 'pinExists' }; }
    sec.pin = { hash: hash(pin, sec.salt) };
    var code = makeRecovery();
    sec.failures = 0; sec.cooldownMs = 0; sec.cooldownUntil = 0;
    save();
    locked = false;
    lastPinAt = now();
    return { ok: true, recoveryCode: code };
  }

  // purpose 'unlock' clears kid mode; 'peek' only refreshes the peek timer.
  function verify(pin, purpose) {
    if (!hasPin()) { return { ok: false, error: 'noPin' }; }
    var left = cooldownLeft();
    if (left) { return { ok: false, cooldownMs: left, triesLeft: 0 }; }
    if (!validPin(pin) || !same(hash(pin, sec.salt), sec.pin.hash)) { return fail(); }
    succeed();
    lastPinAt = now();
    if (purpose !== 'peek') { locked = false; }
    return { ok: true };
  }

  function changePin(oldPin, newPin) {
    var r = verify(oldPin, 'change');
    if (!r.ok) { return r; }
    if (!validPin(newPin)) { return { ok: false, error: 'pinShape' }; }
    sec.pin = { hash: hash(newPin, sec.salt) };
    save();
    return { ok: true };
  }

  // Recovery code -> new PIN and a NEW recovery code (the old one is used up).
  function recover(code, newPin) {
    if (!hasPin() || !sec.recovery) { return { ok: false, error: 'noPin' }; }
    var left = cooldownLeft();
    if (left) { return { ok: false, cooldownMs: left, triesLeft: 0 }; }
    var c = normaliseCode(code);
    if (c.length !== CODE_LEN || !same(hash(c, sec.recovery.salt), sec.recovery.hash)) { return fail(); }
    if (!validPin(newPin)) { return { ok: false, error: 'pinShape' }; }
    succeed();
    sec.pin = { hash: hash(newPin, sec.salt) };
    var fresh = makeRecovery();
    save();
    locked = false;
    lastPinAt = now();
    return { ok: true, recoveryCode: fresh };
  }

  function status() {
    return { hasPin: hasPin(), locked: locked, cooldownMs: cooldownLeft(),
      triesLeft: Math.max(0, MAX_TRIES - (sec.failures || 0)), peekFresh: peekAllowed() };
  }

  function lock() { if (hasPin()) { locked = true; lastPinAt = 0; } return locked; }

  function isLocked() { return locked; }

  function peekAllowed() { return !locked && lastPinAt > 0 && now() - lastPinAt < PEEK_FRESH_MS; }

  // Each peek keeps the 5-minute window open ("again after 5 minutes without one").
  function touchPeek() { if (peekAllowed()) { lastPinAt = now(); } }

  return {
    load: load,
    hasPin: hasPin,
    setPin: setPin,
    verify: verify,
    changePin: changePin,
    recover: recover,
    status: status,
    lock: lock,
    isLocked: isLocked,
    setLocked: function (v) { locked = !!v && hasPin(); },
    peekAllowed: peekAllowed,
    touchPeek: touchPeek
  };
}

module.exports = {
  createPin: createPin, validPin: validPin, normaliseCode: normaliseCode,
  MAX_TRIES: MAX_TRIES, COOLDOWN_MS: COOLDOWN_MS, PEEK_FRESH_MS: PEEK_FRESH_MS, CODE_LEN: CODE_LEN
};
