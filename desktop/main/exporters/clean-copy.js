'use strict';
// Clean copy for USB / TV (LEDGER D6): a new file with the protected scenes cut out, by stream copy
// (lossless, minutes not hours).
//  1. ffprobe lists the keyframes of the first video stream.
//  2. Kept segments are the gaps between enforced ranges, snapped INWARD to keyframes (keep less:
//     a kept part starts at the first keyframe >= the end of a cut and ends at the last keyframe
//     <= the start of the next cut), so no frame of a cut scene can survive a copy.
//  3. Each kept part: ffmpeg -ss <kf> -to <kf2> -i in -map 0 -c copy -avoid_negative_ts make_zero
//     into userData/tmp; then the concat demuxer joins them (-f concat -safe 0 -c copy).
//  4. Temp parts are deleted in every outcome. Output: "<name> (bonis oculis clean).<ext>" next
//     to the source or in a chosen folder. Optional: audio converted to AAC (off by default).
// Every enforced range is cut, mute ranges too: a copied stream cannot be muted (fail closed).
// Progress is reported per part. Never throws.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var BO = require('../../../shared/skipfile.js');
var probe = require('../probe.js');

var MIN_PART = 0.2;

function noop() {}

// Pure. cuts: [[start, end]] (any order, may overlap); kfs: sorted keyframe times.
function keptSegments(cuts, duration, kfs) {
  var sorted = cuts.map(function (c) { return [Math.max(0, c[0]), Math.min(duration, c[1])]; })
    .filter(function (c) { return c[1] > c[0]; })
    .sort(function (a, b) { return a[0] - b[0]; });
  var merged = [];
  sorted.forEach(function (c) {
    var last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) { last[1] = Math.max(last[1], c[1]); } else { merged.push([c[0], c[1]]); }
  });
  var raw = [];
  var cur = 0;
  merged.forEach(function (c) {
    if (c[0] > cur) { raw.push([cur, c[0], true]); }
    cur = Math.max(cur, c[1]);
  });
  if (cur < duration) { raw.push([cur, duration, false]); }
  var eps = 1e-3;
  var out = [];
  raw.forEach(function (seg) {
    var a = null, b = null, i;
    for (i = 0; i < kfs.length; i++) { if (kfs[i] >= seg[0] - eps) { a = kfs[i]; break; } }
    if (a === null) { return; }
    if (seg[2]) {
      for (i = kfs.length - 1; i >= 0; i--) { if (kfs[i] <= seg[1] + eps) { b = kfs[i]; break; } }
    } else {
      b = duration; // runs to the end of the file, nothing after it to protect
    }
    if (b !== null && b - a >= MIN_PART) { out.push([a, b, seg[2]]); }
  });
  return out.map(function (s) { return { start: s[0], end: s[1], toEnd: !s[2] }; });
}

function uniqueOutput(dir, base, ext) {
  var p = path.join(dir, base + ' (bonis oculis clean)' + ext);
  var n = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, base + ' (bonis oculis clean) ' + n + ext);
    n++;
  }
  return p;
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* best effort */ } }

function concatLine(file) { return "file '" + file.replace(/'/g, "'\\''") + "'\n"; }

// opts: {input, doc, outDir?, aac?, ffmpeg, ffprobe, tmpDir, onProgress?}; cb(err, {path, kept, segments})
// Returns {cancel()}.
function cleanCopy(opts, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var onProgress = opts.onProgress || noop;
  var cancelled = false;
  var proc = null;
  var work = path.join(opts.tmpDir, 'clean-' + crypto.randomBytes(6).toString('hex'));
  var ext = path.extname(opts.input) || '.mkv';
  var finished = false;

  function finish(err, res) {
    if (finished) { return; }
    finished = true;
    rmrf(work);
    done(err, res);
  }

  function fail(code) { var e = new Error(code); e.code = code; finish(e); }

  var handle = {
    cancel: function () {
      cancelled = true;
      if (proc) { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } }
    }
  };

  try { fs.mkdirSync(work, { recursive: true }); } catch (e) { fail('tmpFailed'); return handle; }

  probe.media(opts.ffprobe, opts.input, function (e1, info) {
    if (cancelled) { fail('cancelled'); return; }
    if (e1 || !info || !info.hasVideo || !(info.duration > 0)) { fail('notVideo'); return; }
    proc = probe.keyframes(opts.ffprobe, opts.input, function (e2, kfs) {
      proc = null;
      if (cancelled) { fail('cancelled'); return; }
      if (e2 || !kfs.length) { fail('noKeyframes'); return; }
      var cuts = BO.enforced(opts.doc).map(function (r) { return [r.start, r.end]; });
      var segs = keptSegments(cuts, info.duration, kfs);
      if (!segs.length) { fail('nothingLeft'); return; }
      var parts = [];
      var total = segs.length + 1;
      var i = 0;
      onProgress({ done: 0, total: total });

      function nextPart() {
        if (cancelled) { fail('cancelled'); return; }
        if (i >= segs.length) { joinParts(); return; }
        var s = segs[i];
        var part = path.join(work, 'part-' + ('000' + i).slice(-4) + ext);
        var args = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-ss', s.start.toFixed(6)];
        if (!s.toEnd) { args.push('-to', s.end.toFixed(6)); }
        args = args.concat(['-i', opts.input, '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', part]);
        proc = probe.run(opts.ffmpeg, args, function (e3, code) {
          proc = null;
          if (cancelled) { fail('cancelled'); return; }
          if (e3 || code !== 0) { fail('ffmpegFailed'); return; }
          parts.push(part);
          i++;
          onProgress({ done: i, total: total });
          nextPart();
        });
      }

      function joinParts() {
        var list = path.join(work, 'list.txt');
        try { fs.writeFileSync(list, parts.map(concatLine).join('')); } catch (e4) { fail('tmpFailed'); return; }
        var outDir = opts.outDir || path.dirname(opts.input);
        var target = uniqueOutput(outDir, path.basename(opts.input, ext), ext);
        var partial = target + '.part' + ext;
        var args = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy'];
        if (opts.aac) { args.push('-c:a', 'aac', '-b:a', '192k'); }
        args.push(partial);
        proc = probe.run(opts.ffmpeg, args, function (e5, code) {
          proc = null;
          if (cancelled || e5 || code !== 0) {
            try { fs.unlinkSync(partial); } catch (e6) { /* none */ }
            fail(cancelled ? 'cancelled' : (fs.existsSync(outDir) ? 'ffmpegFailed' : 'notWritable'));
            return;
          }
          try { fs.renameSync(partial, target); } catch (e7) { fail('notWritable'); return; }
          onProgress({ done: total, total: total });
          var kept = segs.reduce(function (acc, s2) { return acc + (s2.end - s2.start); }, 0);
          finish(null, { path: target, kept: kept, segments: segs });
        });
      }

      nextPart();
    });
  });
  return handle;
}

module.exports = { cleanCopy: cleanCopy, keptSegments: keptSegments };
