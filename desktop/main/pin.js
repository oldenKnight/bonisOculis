'use strict';
// Parent PIN (PLAN 6, LEDGER D17: a deterrent, not a security boundary).
//  - scrypt N=2^15 r=8 p=1, per-install 16-byte salt, compared with timingSafeEqual.
//  - 5 wrong tries -> 30 s cooldown; every further wrong try after a cooldown doubles it (max
//    15 min). Counters persist in secure.json, so restarting the app does not reset them.
//  - A 12-character recovery code is generated at setup, shown once, stored hashed.
//  - Lock state lives in memory only. Peek needs a PIN typed for peeking within the last 5 minutes.
// secure.json also holds the HMAC key used by store.js for settings and library files.
//  - recovery.json (board review A6) keeps a second copy of the recovery code's hash, plus the HMAC
//    key wrapped (AES-256-GCM) with a key derived from the recovery code, signed with that HMAC
//    key. If secure.json disappears while recovery.json exists, the app does not offer a new PIN:
//    it stays locked ("PIN lost") and only the recovery code opens it, restoring the original key.
//    Deleting both files resets the app (documented: the PIN is a deterrent, LEDGER D17); every
//    list then fails its signature and needs the parent's review again.

var crypto = require('crypto');

var FILE = 'secure.json';
var RECOVERY_FILE = 'recovery.json';
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

// PINs kids guess first: one digit repeated, straight runs (1234, 9876), pairs (1212, 1122) and
// the keypad column 2580 / 0852.
var COMMON = ['1212', '1122', '2580', '0852', '6969', '4545', '1004', '2000'];
function isWeak(pin) {
  if (!validPin(pin)) { return true; }
  if (/^(\d)\1+$/.test(pin)) { return true; }
  var up = true, down = true, i;
  for (i = 1; i < pin.length; i++) {
    var d = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (d !== 1) { up = false; }
    if (d !== -1) { down = false; }
  }
  if (up || down) { return true; }
  if (pin.length === 4 && COMMON.indexOf(pin) >= 0) { return true; }
  if (pin.length >= 4 && pin.length % 2 === 0 && pin.slice(0, 2).repeat(pin.length / 2) === pin) { return true; }
  return false;
}

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
  var lost = false;

  function fresh() {
    return { version: 1, hmacKey: crypto.randomBytes(32).toString('hex'), salt: crypto.randomBytes(16).toString('hex'),
      pin: null, recovery: null, failures: 0, cooldownUntil: 0, cooldownMs: 0 };
  }

  function validRecoveryFile(v) {
    var d = v && v.data;
    return !!(d && typeof v.hmac === 'string' && d.recovery && typeof d.recovery.salt === 'string' && typeof d.recovery.hash === 'string' &&
      d.wrap && typeof d.wrap.salt === 'string' && typeof d.wrap.iv === 'string' && typeof d.wrap.tag === 'string' && typeof d.wrap.data === 'string');
  }

  function load() {
    var r = store.readJson(FILE, function (v) { return v && typeof v.hmacKey === 'string'; });
    sec = r.value;
    lost = false;
    if (!sec) {
      sec = fresh();
      var rec = store.readJson(RECOVERY_FILE, validRecoveryFile);
      if (rec.value) {
        // PIN file gone, recovery file present: locked until the recovery code is typed. A
        // throwaway key in memory; nothing else is written meanwhile.
        lost = true;
        locked = true;
        store.setReadOnly(true);
      } else {
        save();
      }
    }
    store.setHmacKey(sec.hmacKey);
    return sec;
  }

  // Nothing is saved while lost: a secure.json with the throwaway key and no PIN would turn into
  // "create a PIN" at the next start.
  function save() { return lost ? false : store.writeJson(FILE, sec); }

  function wrapKey(code) {
    var wsalt = crypto.randomBytes(16);
    var k = crypto.scryptSync(code, wsalt, 32, SCRYPT);
    var iv = crypto.randomBytes(12);
    var c = crypto.createCipheriv('aes-256-gcm', k, iv);
    var data = Buffer.concat([c.update(Buffer.from(sec.hmacKey, 'hex')), c.final()]);
    return { salt: wsalt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
  }

  function unwrapKey(code, w) {
    try {
      var k = crypto.scryptSync(code, Buffer.from(w.salt, 'hex'), 32, SCRYPT);
      var d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(w.iv, 'hex'));
      d.setAuthTag(Buffer.from(w.tag, 'hex'));
      return Buffer.concat([d.update(Buffer.from(w.data, 'hex')), d.final()]).toString('hex');
    } catch (e) { return null; }
  }

  function recoveryHmac(key, data) { return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(data)).digest('hex'); }

  // Written whenever a recovery code is made (code = the plain code, normalised).
  function writeRecoveryFile(code) {
    var data = { version: 1, recovery: sec.recovery, wrap: wrapKey(code) };
    return store.writeJson(RECOVERY_FILE, { data: data, hmac: recoveryHmac(sec.hmacKey, data) });
  }

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
    writeRecoveryFile(code);
    return formatCode(code);
  }

  // First PIN (or a reset after recovery). Returns {ok, recoveryCode}.
  function setPin(pin) {
    if (!validPin(pin)) { return { ok: false, error: 'pinShape' }; }
    if (isWeak(pin)) { return { ok: false, error: 'pinWeak' }; }
    if (lost) { return { ok: false, error: 'pinLost' }; }
    if (hasPin()) { return { ok: false, error: 'pinExists' }; }
    sec.pin = { hash: hash(pin, sec.salt) };
    var code = makeRecovery();
    sec.failures = 0; sec.cooldownMs = 0; sec.cooldownUntil = 0;
    save();
    locked = false;
    return { ok: true, recoveryCode: code };
  }

  // purpose 'unlock' clears kid mode; only 'peek' opens the 5-minute peek window (board A10).
  function verify(pin, purpose) {
    if (!hasPin()) { return { ok: false, error: 'noPin' }; }
    var left = cooldownLeft();
    if (left) { return { ok: false, cooldownMs: left, triesLeft: 0 }; }
    if (!validPin(pin) || !same(hash(pin, sec.salt), sec.pin.hash)) { return fail(); }
    succeed();
    if (purpose === 'peek') { lastPinAt = now(); } else { locked = false; }
    return { ok: true };
  }

  function changePin(oldPin, newPin) {
    var r = verify(oldPin, 'change');
    if (!r.ok) { return r; }
    if (!validPin(newPin)) { return { ok: false, error: 'pinShape' }; }
    if (isWeak(newPin)) { return { ok: false, error: 'pinWeak' }; }
    sec.pin = { hash: hash(newPin, sec.salt) };
    save();
    return { ok: true };
  }

  // PIN file lost: the code must match recovery.json, unwrap the original HMAC key and verify the
  // file's signature with it. Then secure.json is rebuilt with that key and a new PIN.
  function recoverLost(c, newPin) {
    var rec = store.readJson(RECOVERY_FILE, validRecoveryFile).value;
    if (!rec) { return { ok: false, error: 'noPin' }; }
    if (c.length !== CODE_LEN || !same(hash(c, rec.data.recovery.salt), rec.data.recovery.hash)) { return fail(); }
    if (!validPin(newPin)) { return { ok: false, error: 'pinShape' }; }
    if (isWeak(newPin)) { return { ok: false, error: 'pinWeak' }; }
    var key = unwrapKey(c, rec.data.wrap);
    if (!key || !same(recoveryHmac(key, rec.data), rec.hmac)) { return { ok: false, error: 'recoveryDamaged' }; }
    sec = fresh();
    sec.hmacKey = key;
    sec.pin = { hash: hash(newPin, sec.salt) };
    lost = false;
    store.setReadOnly(false);
    store.setHmacKey(key);
    var code = makeRecovery();
    save();
    locked = false;
    return { ok: true, recoveryCode: code, restored: true };
  }

  // Recovery code -> new PIN and a NEW recovery code (the old one is used up).
  function recover(code, newPin) {
    if (lost) {
      var left0 = cooldownLeft();
      if (left0) { return { ok: false, cooldownMs: left0, triesLeft: 0 }; }
      return recoverLost(normaliseCode(code), newPin);
    }
    if (!hasPin() || !sec.recovery) { return { ok: false, error: 'noPin' }; }
    var left = cooldownLeft();
    if (left) { return { ok: false, cooldownMs: left, triesLeft: 0 }; }
    var c = normaliseCode(code);
    if (c.length !== CODE_LEN || !same(hash(c, sec.recovery.salt), sec.recovery.hash)) { return fail(); }
    if (!validPin(newPin)) { return { ok: false, error: 'pinShape' }; }
    if (isWeak(newPin)) { return { ok: false, error: 'pinWeak' }; }
    succeed();
    sec.pin = { hash: hash(newPin, sec.salt) };
    var fresh = makeRecovery();
    save();
    locked = false;
    return { ok: true, recoveryCode: fresh };
  }

  function status() {
    return { hasPin: hasPin(), locked: locked, lost: lost, cooldownMs: cooldownLeft(),
      triesLeft: Math.max(0, MAX_TRIES - (sec.failures || 0)), peekFresh: peekAllowed() };
  }

  function lock() { if (hasPin() || lost) { locked = true; lastPinAt = 0; } return locked; }

  function isLocked() { return locked; }

  function peekAllowed() { return !locked && lastPinAt > 0 && now() - lastPinAt < PEEK_FRESH_MS; }

  // The window is not extended by peeking: the PIN is asked again 5 minutes after it was typed.
  function touchPeek() {}

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
    setLocked: function (v) { locked = lost || (!!v && hasPin()); },
    isLost: function () { return lost; },
    peekAllowed: peekAllowed,
    touchPeek: touchPeek
  };
}

module.exports = {
  createPin: createPin, RECOVERY_FILE: RECOVERY_FILE, validPin: validPin, isWeak: isWeak, normaliseCode: normaliseCode,
  MAX_TRIES: MAX_TRIES, COOLDOWN_MS: COOLDOWN_MS, PEEK_FRESH_MS: PEEK_FRESH_MS, CODE_LEN: CODE_LEN
};
