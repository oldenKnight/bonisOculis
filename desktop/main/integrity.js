'use strict';
// "Verified at first app run" (analyzer/models/manifest.json notes; board review A9): on the
// first start of each app version, every bundled model and binary is hashed in the background and
// compared with the hashes that shipped with it:
//   <resources>/models/manifest.json        {files: [{file, sha256, size}]}
//   <resources>/bin/binaries.lock.json      {files: {relPath: {sha256, size}}}  (written by
//                                           tools/fetch-binaries.js from packaging/binaries.json pins)
//   <resources>/player/player.lock.json     {files: {'bonis.lua': {sha256, size}}} (tools/make-player-lock.js)
// It runs again when the version or the resources folder changes, and on demand (Settings › About).
// A damaged model or scanning program stops scans; a damaged mpv or bonis.lua stops the player
// (board security round 2, N3): blocks(result) says which.
// Low priority: one file at a time, 1 MiB reads with a pause between them. The result is stored
// in settings (integrity) so it runs once per version. A file that does not match makes the app
// say "Needs attention: a bundled file is damaged" with its name. A file listed in the manifest
// but not shipped (electron-builder filters some) is counted as missing, not damaged. Never throws.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function noop() {}

function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) { return null; }
  var n = path.normalize(rel);
  if (n.split(/[\\/]/).indexOf('..') >= 0) { return null; }
  return n;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// -> [{label, file, sha256, size}]
function targets(resources) {
  var out = [];
  var m = readJson(path.join(resources, 'models', 'manifest.json'));
  if (m && Array.isArray(m.files)) {
    m.files.forEach(function (f) {
      var rel = f && safeRel(f.file);
      if (rel && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) {
        out.push({ label: 'models/' + rel, file: path.join(resources, 'models', rel), sha256: f.sha256, size: typeof f.size === 'number' ? f.size : null });
      }
    });
  }
  var lock = readJson(path.join(resources, 'bin', 'binaries.lock.json'));
  if (lock && lock.files && typeof lock.files === 'object') {
    Object.keys(lock.files).forEach(function (k) {
      var rel = safeRel(k);
      var f = lock.files[k];
      if (rel && f && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) {
        out.push({ label: 'bin/' + rel.replace(/\\/g, '/'), file: path.join(resources, 'bin', rel), sha256: f.sha256, size: typeof f.size === 'number' ? f.size : null });
      }
    });
  }
  var pl = readJson(path.join(resources, 'player', 'player.lock.json'));
  if (pl && pl.files && pl.files['bonis.lua'] && /^[0-9a-f]{64}$/.test(pl.files['bonis.lua'].sha256 || '')) {
    out.push({ label: 'player/bonis.lua', file: path.join(resources, 'player', 'bonis.lua'), sha256: pl.files['bonis.lua'].sha256, size: pl.files['bonis.lua'].size || null });
  }
  return out;
}

// What a damaged file stops: {scan, play}. Scans need the models and ffmpeg/ffprobe/whisper; the
// player needs mpv (and its bundle) and bonis.lua.
function blocks(result) {
  var out = { scan: false, play: false };
  ((result && result.damaged) || []).forEach(function (d) {
    var f = String(d.file || '');
    if (/^models\//.test(f) || /^bin\/(ffmpeg|ffprobe|whisper)/.test(f)) { out.scan = true; }
    if (/^player\//.test(f) || /^bin\/mpv/.test(f) || /^bin\/d3dcompiler/.test(f)) { out.play = true; }
  });
  return out;
}

// cb(err, hex). Reads chunkBytes at a time, waiting pauseMs between reads.
function hashFile(file, chunkBytes, pauseMs, cb) {
  var h = crypto.createHash('sha256');
  var buf = Buffer.alloc(chunkBytes);
  var pos = 0;
  fs.open(file, 'r', function (err, fd) {
    if (err) { cb(err); return; }
    function step() {
      fs.read(fd, buf, 0, chunkBytes, pos, function (e, n) {
        if (e) { fs.close(fd, noop); cb(e); return; }
        if (!n) { fs.close(fd, noop); cb(null, h.digest('hex')); return; }
        h.update(n === chunkBytes ? buf : buf.subarray(0, n));
        pos += n;
        if (pauseMs > 0) { setTimeout(step, pauseMs); } else { setImmediate(step); }
      });
    }
    step();
  });
}

// opts: {resources, settings, version, log, onDamaged(result), chunkBytes?, pauseMs?, now?}
function createIntegrity(opts) {
  var o = opts || {};
  var log = o.log || { info: noop, warn: noop, error: noop };
  var chunk = o.chunkBytes || 1024 * 1024;
  var pause = typeof o.pauseMs === 'number' ? o.pauseMs : 2;
  var now = o.now || function () { return new Date().toISOString(); };
  var running = false;
  var stopped = false;

  function last() { return o.settings.value('integrity'); }

  function needed() {
    var r = last();
    return !r || r.version !== o.version || r.resources !== o.resources;
  }

  // cb(null, result|null). force: run even when this version was already checked.
  function run(force, cb) {
    var done = typeof cb === 'function' ? cb : noop;
    if (running || (!force && !needed())) { done(null, null); return; }
    var list = targets(o.resources);
    if (!list.length) { log.info('integrity: nothing to check'); done(null, null); return; }
    running = true;
    var res = { version: o.version, resources: o.resources, at: null, checked: 0, missing: 0, damaged: [] };
    var i = 0;
    function next() {
      if (stopped) { running = false; done(null, null); return; }
      if (i >= list.length) {
        running = false;
        res.at = now();
        o.settings.set({ integrity: res }, false);
        if (res.damaged.length) {
          log.warn('integrity: damaged', res.damaged.length);
          if (o.onDamaged) { try { o.onDamaged(res); } catch (e) { log.error('onDamaged', e); } }
        } else {
          log.info('integrity: ok', res.checked);
        }
        done(null, res);
        return;
      }
      var t = list[i++];
      fs.stat(t.file, function (se, st) {
        if (se) { res.missing++; next(); return; }
        if (t.size !== null && st.size !== t.size) { res.checked++; res.damaged.push({ file: t.label, reason: 'size' }); next(); return; }
        hashFile(t.file, chunk, pause, function (he, hex) {
          res.checked++;
          if (he) { res.damaged.push({ file: t.label, reason: 'unreadable' }); } else if (hex !== t.sha256) { res.damaged.push({ file: t.label, reason: 'mismatch' }); }
          next();
        });
      });
    }
    next();
  }

  return { run: run, needed: needed, last: last, stop: function () { stopped = true; }, targets: function () { return targets(o.resources); } };
}

module.exports = { createIntegrity: createIntegrity, targets: targets, hashFile: hashFile, blocks: blocks };
