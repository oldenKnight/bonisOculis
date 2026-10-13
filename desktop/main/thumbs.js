'use strict';
// Images for the renderer, as data URLs (the renderer never gets a file path).
//  - range thumbnails: <work>/thumbs/<rangeId>.jpg, written blurred by the analyzer (PLAN 4);
//  - timeline strip: N tiles, extracted with the same blur (boxblur at 160 px) and cached in
//    <work>/strip/; flagged-or-not, a strip tile is never sharp;
//  - library poster (DESIGN 12.1): none before a scan, blurred until the scan proves the frame
//    clean, sharp only when the title is Protected and no range touches the frame;
//  - peek (LEDGER D18): one live frame at 640 px through a pipe, in memory only, never on disk.
//    The caller checks the PIN window and kid mode first.

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var RANGE_ID = /^r[0-9a-z]{4,16}$/;
var BLUR = 'scale=160:-2,boxblur=10:1';
var POSTER_MARGIN = 3;

function noop() {}

function dataUrl(file, mime) {
  try { return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64'); } catch (e) { return null; }
}

function grab(ffmpeg, input, t, vf, outFile, cb) {
  var args = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', input,
    '-frames:v', '1', '-vf', vf, '-q:v', '5', '-update', '1', '-f', 'image2', outFile];
  var p;
  try { p = childProcess.spawn(ffmpeg, args, { stdio: 'ignore', windowsHide: true }); } catch (e) { cb(e); return; }
  p.on('error', function (e2) { cb(e2); });
  p.on('close', function (code) { cb(code === 0 && fs.existsSync(outFile) ? null : new Error('ffmpeg ' + code)); });
}

function createThumbs(options) {
  var o = options || {};
  var paths = o.paths;
  var library = o.library;
  var skips = o.skips;
  var busy = {};

  function rangeThumbs(id, rangeIds) {
    var out = {};
    var dir = path.join(paths.workDir(id), 'thumbs');
    rangeIds.forEach(function (rid) {
      out[rid] = RANGE_ID.test(rid) ? dataUrl(path.join(dir, rid + '.jpg'), 'image/jpeg') : null;
    });
    return out;
  }

  // cb(null, [dataUrl|null]) - tiles at the centre of n equal slices.
  function strip(id, n, cb) {
    var item = library.get(id);
    if (!item || !(item.duration > 0)) { cb(null, []); return; }
    var dir = path.join(paths.workDir(id), 'strip');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
    var key = id + ':' + n;
    if (busy[key]) { busy[key].push(cb); return; }
    busy[key] = [cb];
    var i = 0;
    var out = [];
    function next() {
      if (i >= n) {
        var cbs = busy[key];
        delete busy[key];
        cbs.forEach(function (fn) { fn(null, out); });
        return;
      }
      var file = path.join(dir, n + '-' + i + '.jpg');
      var t = item.duration * (i + 0.5) / n;
      if (fs.existsSync(file)) { out.push(dataUrl(file, 'image/jpeg')); i++; next(); return; }
      grab(paths.ffmpeg(), item.path, t, BLUR, file, function (err) {
        out.push(err ? null : dataUrl(file, 'image/jpeg'));
        i++;
        next();
      });
    }
    next();
  }

  // The poster frame is taken inside the first minute (board security round 2, A10).
  var CLEAR_WINDOW = 60;
  function posterTime(item) { return Math.min(CLEAR_WINDOW - POSTER_MARGIN - 1, Math.max(1, (item.duration || 10) * 0.1)); }

  // A sharp poster is written only when the scan found nothing at all in the first 60 s (and the
  // title is Protected); a scene anywhere in that minute keeps the blurred poster.
  function frameIsClean(doc, t) {
    if (!doc || !doc.ranges) { return false; }
    var off = (doc.media && doc.media.offset) || 0;
    if (t > CLEAR_WINDOW) { return false; }
    return !doc.ranges.some(function (r) { return r.start + off - POSTER_MARGIN < CLEAR_WINDOW; });
  }

  // cb(null, {kind: 'locked'|'blurred'|'cleared', src})
  function poster(id, cb) {
    var item = library.get(id);
    if (!item || item.status === 'notScanned' || item.status === 'queued') { cb(null, { kind: 'locked', src: null }); return; }
    var work = paths.workDir(id);
    try { fs.mkdirSync(work, { recursive: true }); } catch (e) { /* exists */ }
    var t = posterTime(item);
    var blurFile = path.join(work, 'poster-blur.jpg');
    var clearFile = path.join(work, 'poster-clear.jpg');
    var clean = item.status === 'protected' && frameIsClean(skips.load(id).doc, t);
    if (!clean) {
      try { fs.unlinkSync(clearFile); } catch (e2) { /* none */ }
      if (fs.existsSync(blurFile)) { cb(null, { kind: 'blurred', src: dataUrl(blurFile, 'image/jpeg') }); return; }
      grab(paths.ffmpeg(), item.path, t, BLUR, blurFile, function (err) {
        cb(null, { kind: err ? 'locked' : 'blurred', src: err ? null : dataUrl(blurFile, 'image/jpeg') });
      });
      return;
    }
    if (fs.existsSync(clearFile)) { cb(null, { kind: 'cleared', src: dataUrl(clearFile, 'image/jpeg') }); return; }
    grab(paths.ffmpeg(), item.path, t, 'scale=480:-2', clearFile, function (err) {
      cb(null, { kind: err ? 'locked' : 'cleared', src: err ? null : dataUrl(clearFile, 'image/jpeg') });
    });
  }

  // cb(null, dataUrl|null). Memory only.
  function peek(id, t, cb) {
    var done = typeof cb === 'function' ? cb : noop;
    var item = library.get(id);
    if (!item) { done(null, null); return; }
    var chunks = [];
    var size = 0;
    var p;
    var args = ['-nostdin', '-hide_banner', '-v', 'error', '-ss', Math.max(0, t).toFixed(3), '-i', item.path,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
    try { p = childProcess.spawn(paths.ffmpeg(), args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { done(null, null); return; }
    p.stdout.on('data', function (d) {
      size += d.length;
      if (size < 16 * 1024 * 1024) { chunks.push(d); }
    });
    p.on('error', function () { done(null, null); done = noop; });
    p.on('close', function (code) {
      if (code !== 0 || !chunks.length) { done(null, null); return; }
      var buf = Buffer.concat(chunks);
      chunks = null;
      done(null, 'data:image/png;base64,' + buf.toString('base64'));
    });
  }

  return { rangeThumbs: rangeThumbs, strip: strip, poster: poster, peek: peek, frameIsClean: frameIsClean };
}

module.exports = { createThumbs: createThumbs };
