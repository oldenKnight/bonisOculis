'use strict';
// Durable JSON files under userData (brief 4.4 autosave, 4.5 autorecovery).
//
//  - Every write is atomic: <file>.tmp-<pid> is written and fsynced, the current file is copied to
//    <file>.bak, then the tmp file is renamed over the target. A crash leaves either the old or the
//    new file, never half of one.
//  - Every read that fails (missing is fine, unreadable / not JSON / invalid is not) falls back to
//    <file>.bak, restores it, logs it and emits 'recovered' so the UI can say so.
//  - Envelope files (settings.json, library.json, queue.json) are {data, hmac}; the HMAC key lives
//    in secure.json. A mismatch is tamper evidence (PLAN 6): the data is still used, 'tampered' is
//    emitted, and the caller decides what to fail closed on.
// Never throws.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function noop() {}
var silentLog = { debug: noop, info: noop, warn: noop, error: noop };

function createStore(options) {
  var o = options || {};
  var dir = o.dir;
  var log = o.log || silentLog;
  var listeners = { recovered: [], tampered: [] };
  var hmacKey = null;

  function emit(name, payload) {
    var i;
    for (i = 0; i < listeners[name].length; i++) {
      try { listeners[name][i](payload); } catch (e) { log.error('store listener threw', e); }
    }
  }

  function on(name, fn) { if (listeners[name] && typeof fn === 'function') { listeners[name].push(fn); } }

  function full(rel) { return path.join(dir, rel); }

  function mkdirp(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* exists */ } }

  function writeText(rel, text) {
    var file = full(rel);
    var tmp = file + '.tmp-' + process.pid;
    var fd;
    try {
      mkdirp(path.dirname(file));
      fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, file + '.bak'); } catch (e) { log.warn('backup copy failed', rel); }
      }
      fs.renameSync(tmp, file);
      return true;
    } catch (e2) {
      log.error('write failed', rel, e2 && e2.code);
      if (fd) { try { fs.closeSync(fd); } catch (e3) { /* closed */ } }
      try { fs.unlinkSync(tmp); } catch (e4) { /* absent */ }
      return false;
    }
  }

  function writeJson(rel, obj) {
    var text;
    try { text = JSON.stringify(obj, null, 2) + '\n'; } catch (e) { log.error('not serialisable', rel); return false; }
    return writeText(rel, text);
  }

  // check(obj) -> true when acceptable. Returns {ok, value, missing, recovered}.
  function parseFile(file, check) {
    var text, v;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, missing: e && e.code === 'ENOENT' }; }
    try {
      if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); }
      v = JSON.parse(text);
    } catch (e2) { return { ok: false, missing: false }; }
    if (check && !check(v)) { return { ok: false, missing: false }; }
    return { ok: true, value: v };
  }

  function readJson(rel, check) {
    var file = full(rel);
    var main = parseFile(file, check);
    if (main.ok) { return { value: main.value, recovered: false }; }
    var bak = parseFile(file + '.bak', check);
    if (main.missing && !bak.ok) { return { value: null, recovered: false, missing: true }; }
    if (bak.ok) {
      log.warn('restored from backup', rel);
      if (!main.missing) {
        try { fs.copyFileSync(file, file + '.corrupt'); } catch (e) { /* keep going */ }
      }
      writeText(rel, JSON.stringify(bak.value, null, 2) + '\n');
      emit('recovered', { file: rel });
      return { value: bak.value, recovered: true };
    }
    log.error('unreadable and no usable backup', rel);
    if (!main.missing) {
      try { fs.renameSync(file, file + '.corrupt'); } catch (e2) { /* keep going */ }
      emit('recovered', { file: rel, lost: true });
    }
    return { value: null, recovered: true, lost: true };
  }

  function remove(rel) {
    var file = full(rel);
    var ok = true;
    [file, file + '.bak'].forEach(function (f) {
      try { fs.unlinkSync(f); } catch (e) { if (e && e.code !== 'ENOENT') { ok = false; } }
    });
    return ok;
  }

  function setHmacKey(hex) { hmacKey = hex ? Buffer.from(hex, 'hex') : null; }

  function hmac(text) {
    if (!hmacKey) { return ''; }
    return crypto.createHmac('sha256', hmacKey).update(String(text)).digest('hex');
  }

  function hmacOk(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) { return false; }
    try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch (e) { return false; }
  }

  function isEnvelope(v) { return v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'data'); }

  // Envelope = {data, hmac}. Returns the data (or null when missing), never throws.
  function readEnvelope(rel) {
    var r = readJson(rel, isEnvelope);
    var env = r.value;
    if (!env) { return null; }
    var expect = hmac(JSON.stringify(env.data));
    if (hmacKey && !hmacOk(env.hmac, expect)) {
      var bak = parseFile(full(rel) + '.bak', isEnvelope);
      if (bak.ok && hmacOk(bak.value.hmac, hmac(JSON.stringify(bak.value.data)))) {
        log.warn('hmac mismatch; restored backup', rel);
        writeText(rel, JSON.stringify(bak.value, null, 2) + '\n');
        emit('tampered', { file: rel, restored: true });
        return bak.value.data;
      }
      log.warn('hmac mismatch', rel);
      emit('tampered', { file: rel, restored: false });
    }
    return env.data;
  }

  function writeEnvelope(rel, data) {
    return writeJson(rel, { data: data, hmac: hmac(JSON.stringify(data)) });
  }

  return {
    dir: dir,
    full: full,
    on: on,
    readJson: readJson,
    writeJson: writeJson,
    writeText: writeText,
    remove: remove,
    readEnvelope: readEnvelope,
    writeEnvelope: writeEnvelope,
    setHmacKey: setHmacKey,
    hmac: hmac,
    hmacOk: hmacOk
  };
}

module.exports = { createStore: createStore };
