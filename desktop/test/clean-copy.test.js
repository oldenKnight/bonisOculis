'use strict';
// exporters/clean-copy.js (exact re-encode, LEDGER D24) on synthetic media only.
// Every source frame carries a 16-bit barcode of its frame index (drawbox per bit), so decoding
// the copy tells exactly which source frames survived. Every audio track is a tone whose
// frequency changes on each whole second (500..1500 Hz), so locating the changes in the copy
// shows where the sound sits against the kept-picture timeline.
// For each source we cut three ranges and assert: zero frames from a cut range survive (both the
// board's definition, frame time inside [start, end], and the stricter "frame shown during the
// range"), every other frame is present once and in order, video timestamps match the kept
// timeline, every tone change of every track is within 40 ms of where it belongs (including the
// junction at each cut), durations match, subtitles are dropped.
// Sources: (a) H.264 MKV, B-frames (-bf 3 -g 48), AAC mono + AC3 5.1 + SRT; (b) open-GOP HEVC MKV
// (when libx265 exists); (c) MPEG-TS starting at 1.4 s; (d) MP4 with a 2 s GOP; (e) MKV and
// (f) MP4 starting at 601.4 s (TS remuxed with -copyts). (a) also covers MKV with a -0.021 s start.
// Times in the cut lists are skip-file times: media time - probed format.start_time.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var h = require('./helpers.js');
var BO = require('../../shared/skipfile.js');
var cc = require('../main/exporters/clean-copy.js');
var encoders = require('../main/exporters/encoders.js');

var FPS = 24;
var BITS = 16;
var SR = 48000;
var TONES = [500, 700, 900, 1100, 1300, 1500];
var HW_HERE = ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox'];
var have = h.haveFfmpeg();
var opts = { skip: have ? false : 'ffmpeg not installed', timeout: 120000 };
var encList = have ? encoders.parseEncoders(childProcess.spawnSync(h.FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout) : {};
var x265 = !!encList.libx265;

function ff(args) {
  var r = childProcess.spawnSync(h.FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-y'].concat(args), { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'ffmpeg ' + args.join(' ') + '\n' + r.stderr);
}

function probeJson(args) {
  var r = childProcess.spawnSync(h.FFPROBE, ['-v', 'error', '-of', 'json'].concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(r.stdout);
}

function barcode() {
  var f = ['drawbox=x=0:y=0:w=320:h=24:color=black:t=fill'];
  var i;
  for (i = 0; i < BITS; i++) { f.push('drawbox=x=' + (20 * i + 2) + ':y=2:w=16:h=20:color=white:t=fill:enable=\'mod(floor(n/' + Math.pow(2, i) + '),2)\''); }
  return f.join(',');
}

function tone(gain) { return gain + '*sin(2*PI*(500+200*mod(floor(t),6))*t)'; }

// (a)-(d). Returns the file path.
function makeSource(dir, kind, seconds) {
  var v = 'testsrc2=s=320x180:r=' + FPS + ':d=' + seconds + ',' + barcode() + '[v]';
  var a1 = 'aevalsrc=\'' + tone(0.5) + '\':s=' + SR + ':d=' + seconds + '[a1]';
  var a6 = 'aevalsrc=\'' + [0.4, 0.4, 0.4, 0.2, 0.4, 0.4].map(tone).join('|') + '\':c=5.1:s=' + SR + ':d=' + seconds + '[a2]';
  var file;
  if (kind === 'mkv') {
    var srt = path.join(dir, 'subs.srt');
    fs.writeFileSync(srt, '1\n00:00:10,000 --> 00:00:16,000\nwords from a cut scene\n\n2\n00:00:25,000 --> 00:00:27,000\nkept words\n');
    file = path.join(dir, 'movie mkv.mkv');
    ff(['-i', srt, '-filter_complex', v + ';' + a1 + ';' + a6, '-map', '[v]', '-map', '[a1]', '-map', '[a2]', '-map', '0:s',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '3', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-c:a:0', 'aac', '-b:a:0', '128k', '-c:a:1', 'ac3', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=spa', '-metadata:s:a:1', 'title=Espanol 5.1', file]);
  } else if (kind === 'hevc') {
    file = path.join(dir, 'movie hevc.mkv');
    ff(['-filter_complex', v + ';' + a1, '-map', '[v]', '-map', '[a1]', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'open-gop=1:keyint=48:min-keyint=48:bframes=4:scenecut=0:log-level=error', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  } else if (kind === 'ts' || kind === 'mkv601' || kind === 'mp4601') {
    // A broadcast-style recording; the 601.4 s ones are remuxed with -copyts, as a TS -> MKV/MP4
    // remux keeps the original timestamps.
    var ts = path.join(dir, kind === 'ts' ? 'movie ts.ts' : 'rec601.ts');
    ff(['-filter_complex', v + ';' + a1, '-map', '[v]', '-map', '[a1]', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '48', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', kind === 'ts' ? '1.4' : '601.4', '-f', 'mpegts', ts]);
    file = ts;
    if (kind !== 'ts') {
      file = path.join(dir, kind === 'mkv601' ? 'movie 601.mkv' : 'movie 601.mp4');
      ff(['-copyts', '-i', ts, '-map', '0', '-c', 'copy', file]);
      fs.unlinkSync(ts);
    }
  } else {
    file = path.join(dir, 'movie mp4.mp4');
    ff(['-filter_complex', v + ';' + a1, '-map', '[v]', '-map', '[a1]', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  }
  return file;
}

function doc(cuts, duration) {
  return BO.newDoc({
    media: { title: 'Coded', duration: duration, fingerprint: { size: 1, oshash: '0000000000000001' } },
    ranges: cuts.map(function (c, i) { return BO.newRange({ id: 'rcut000' + i, start: c[0], end: c[1], category: 'other', action: c[2] || 'skip', review: 'approved' }); }),
    scan: { status: 'complete' }
  });
}

// Decoded frames of the first video stream: [{n (barcode), t (on the file's CLI timeline)}].
function framesOf(file) {
  var j = probeJson(['-show_entries', 'format=start_time', file]);
  var start = parseFloat(j.format.start_time) || 0;
  var pts = probeJson(['-select_streams', 'v:0', '-show_entries', 'frame=pts_time,best_effort_timestamp_time', file]).frames.map(function (f) {
    return parseFloat(f.pts_time !== undefined ? f.pts_time : f.best_effort_timestamp_time) - start;
  });
  var r = childProcess.spawnSync(h.FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'crop=320:24:0:0,format=gray', '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-'], { maxBuffer: 256 * 1024 * 1024 });
  var size = 320 * 24;
  var out = [];
  var i, b, x, y, sum, n;
  for (i = 0; (i + 1) * size <= r.stdout.length; i++) {
    n = 0;
    for (b = 0; b < BITS; b++) {
      sum = 0;
      for (y = 8; y < 16; y++) { for (x = 20 * b + 6; x < 20 * b + 14; x++) { sum += r.stdout[i * size + y * 320 + x]; } }
      if (sum / 64 > 128) { n += Math.pow(2, b); }
    }
    out.push({ n: n, t: pts[i] });
  }
  assert.strictEqual(out.length, pts.length, 'decoded frame count matches ffprobe for ' + path.basename(file));
  return out;
}

// Tone changes of one audio track on the file's CLI timeline (sample 0 = time 0). [{t, from, to}]
function toneChanges(file, track) {
  var r = childProcess.spawnSync(h.FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:' + track, '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(SR),
    '-f', 's16le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  var buf = r.stdout;
  var N = buf.length >> 1;
  var x = new Float64Array(N);
  var i, k, w;
  for (i = 0; i < N; i++) { x[i] = buf.readInt16LE(2 * i) / 32768; }
  var W = 480, HOP = 48;
  var coef = TONES.map(function (f) { return 2 * Math.cos(2 * Math.PI * f / SR); });
  var cls = [];
  for (w = 0; w + W <= N; w += HOP) {
    var energy = 0, best = -1, bestP = 0;
    for (i = w; i < w + W; i++) { energy += x[i] * x[i]; }
    for (k = 0; k < TONES.length; k++) {
      var s1 = 0, s2 = 0, s0;
      for (i = w; i < w + W; i++) { s0 = x[i] + coef[k] * s1 - s2; s2 = s1; s1 = s0; }
      var p = s1 * s1 + s2 * s2 - coef[k] * s1 * s2;
      if (p > bestP) { bestP = p; best = k; }
    }
    cls.push(energy > 1e-3 && bestP > 0.3 * energy * W / 2 ? best : -1);
  }
  var changes = [];
  var cur = -1;
  for (i = 0; i < cls.length; i++) {
    if (cls[i] < 0 || cls[i] === cur) { continue; }
    var stable = true;
    for (k = i; k < Math.min(cls.length, i + 15); k++) { if (cls[k] !== cls[i] && cls[k] !== -1) { stable = false; } }
    if (!stable) { continue; }
    if (cur >= 0) { changes.push({ t: (i * HOP + W / 2) / SR, from: cur, to: cls[i] }); }
    cur = cls[i];
  }
  return { changes: changes, toneAt: function (t) { var j2 = Math.round((t * SR - W / 2) / HOP); return cls[Math.max(0, Math.min(cls.length - 1, j2))]; } };
}

// Independent expectation from the decoded source frames: which frames must go, the kept spans,
// and the output time of any kept source time.
function expectation(src, cuts) {
  var merged = cc.mergeRanges(cuts.map(function (c) { return [c[0], c[1]]; }));
  var step = 1 / FPS;
  var cut = src.map(function (f, i) {
    var end = i + 1 < src.length ? src[i + 1].t : f.t + step;
    return merged.some(function (r) { return f.t <= r[1] && end > r[0]; });
  });
  var spans = [];
  var removed = 0;
  var i = 0;
  var groups = [];
  while (i < src.length) {
    if (!cut[i]) { i++; continue; }
    var j = i;
    while (j + 1 < src.length && cut[j + 1]) { j++; }
    var a = i === 0 ? Math.min(0, src[0].t) : src[i].t;
    var b = j + 1 < src.length ? src[j + 1].t : Infinity;
    groups.push({ a: a, b: b, removedBefore: removed });
    removed += b - a;
    i = j + 1;
  }
  var cur = 0;
  groups.forEach(function (g) { if (g.a > cur) { spans.push([cur, g.a]); } cur = g.b; });
  if (isFinite(cur)) { spans.push([cur, Infinity]); }
  return {
    cut: cut, groups: groups, spans: spans, merged: merged,
    out: function (t) {
      var r = 0;
      groups.forEach(function (g) { if (t >= g.b) { r += g.b - g.a; } });
      return t - r;
    }
  };
}

function check(t, name, srcFile, cuts, res, extra) {
  var src = framesOf(srcFile);
  src.forEach(function (f, i) { assert.strictEqual(f.n, i, name + ': source barcode readable at frame ' + i); });
  var exp = expectation(src, cuts);
  var out = framesOf(res.path);
  var byN = {};
  src.forEach(function (f) { byN[f.n] = f; });
  // 1. Leaks.
  var leakBoard = 0, leakStrict = 0;
  out.forEach(function (f) {
    var s = byN[f.n];
    assert.ok(s, name + ': output frame has a source barcode (' + f.n + ')');
    if (exp.merged.some(function (r) { return s.t >= r[0] && s.t <= r[1]; })) { leakBoard++; }
    if (exp.cut[f.n]) { leakStrict++; }
  });
  // 2. Every kept frame once, in order.
  var keptNs = src.filter(function (f, i) { return !exp.cut[i]; }).map(function (f) { return f.n; });
  var outNs = out.map(function (f) { return f.n; });
  // 3. Video timing against the kept timeline.
  var vErr = 0;
  out.forEach(function (f) { vErr = Math.max(vErr, Math.abs(f.t - exp.out(byN[f.n].t))); });
  // 4. Audio: every tone change of every track.
  var tracks = probeJson(['-select_streams', 'a', '-show_entries', 'stream=index', srcFile]).streams.length;
  var sync = [];
  var worst = 0;
  var tr;
  for (tr = 0; tr < tracks; tr++) {
    var sA = toneChanges(srcFile, tr);
    var oA = toneChanges(res.path, tr);
    var expected = [];
    sA.changes.forEach(function (c) {
      if (exp.spans.some(function (sp) { return c.t > sp[0] + 0.03 && c.t < sp[1] - 0.03; })) { expected.push({ t: exp.out(c.t), kind: 'second' }); }
    });
    exp.groups.forEach(function (g, gi) {
      if (!isFinite(g.b) || g.a <= 0) { return; }
      var before = sA.toneAt(g.a - 0.02), after = sA.toneAt(g.b + 0.02);
      if (before >= 0 && after >= 0 && before !== after) { expected.push({ t: g.a - g.removedBefore, kind: 'cut ' + (gi + 1) }); }
    });
    var matched = {};
    expected.forEach(function (e) {
      var best = null;
      oA.changes.forEach(function (c, ci) { if (best === null || Math.abs(c.t - e.t) < Math.abs(oA.changes[best].t - e.t)) { best = ci; } });
      var err = best === null ? Infinity : oA.changes[best].t - e.t;
      if (best !== null) { matched[best] = true; }
      worst = Math.max(worst, Math.abs(err));
      if (e.kind !== 'second') { sync.push('track ' + tr + ' ' + e.kind + ': ' + (err * 1000).toFixed(1) + ' ms'); }
      assert.ok(Math.abs(err) <= 0.040, name + ' track ' + tr + ' ' + e.kind + ' at ' + e.t.toFixed(3) + ': audio off by ' + (err * 1000).toFixed(1) + ' ms');
    });
    var extraChanges = oA.changes.filter(function (c, ci) { return !matched[ci]; });
    assert.deepStrictEqual(extraChanges, [], name + ' track ' + tr + ': no tone change the kept timeline does not explain (cut sound would add one)');
    assert.ok(expected.length >= 10, name + ' track ' + tr + ': enough tone changes checked (' + expected.length + ')');
  }
  // 5. Durations.
  var keptDur = exp.spans.reduce(function (acc, s) { return acc + (Math.min(s[1], src[src.length - 1].t + 1 / FPS) - s[0]); }, 0);
  var fmt = probeJson(['-show_entries', 'format=duration:stream=codec_type,duration', res.path]);
  var vDur = parseFloat(fmt.streams.filter(function (s) { return s.codec_type === 'video'; })[0].duration);
  var report = name + ': leaked frames ' + leakBoard + ' (in-range) / ' + leakStrict + ' (shown during a range); kept ' + outNs.length + '/' + keptNs.length +
    '; video timing max error ' + (vErr * 1000).toFixed(1) + ' ms; audio max error ' + (worst * 1000).toFixed(1) + ' ms; ' + sync.join(', ') +
    '; duration ' + parseFloat(fmt.format.duration).toFixed(3) + ' vs kept ' + keptDur.toFixed(3) + '; encoder ' + res.encoder;
  t.diagnostic(report);
  assert.strictEqual(leakBoard, 0, name + ': no frame from inside a cut range');
  assert.strictEqual(leakStrict, 0, name + ': no frame shown during a cut range');
  assert.deepStrictEqual(outNs, keptNs, name + ': every kept frame, once, in order');
  assert.ok(vErr <= 0.002, name + ': video timestamps on the kept timeline (' + vErr + ')');
  assert.ok(Math.abs(res.kept - keptDur) <= 0.05, name + ': reported kept ' + res.kept + ' vs ' + keptDur);
  assert.ok(Math.abs(parseFloat(fmt.format.duration) - keptDur) <= 0.06, name + ': file duration ' + fmt.format.duration + ' vs ' + keptDur);
  assert.ok(Math.abs(vDur - outNs.length / FPS) <= 0.06, name + ': video duration ' + vDur);
  if (extra) { extra(fmt); }
}

function run(file, cuts, more, cb) {
  var dir = path.dirname(file);
  var tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  var o = { input: file, doc: doc(cuts, 60), ffmpeg: h.FFMPEG, ffprobe: h.FFPROBE, tmpDir: tmp, threads: 2, candidates: HW_HERE };
  Object.keys(more || {}).forEach(function (k) { o[k] = more[k]; });
  cc.cleanCopy(o, function (err, res) {
    assert.ifError(err);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], 'temp folder emptied');
    cb(res);
  });
}

test('planCuts: frames touched by a range go, boundaries are frame times', function () {
  var frames = [];
  var i;
  for (i = 0; i < 100; i++) { frames.push(i / 10); }
  var p = cc.planCuts([[2.05, 3.0], [9.5, 20]], frames, 10);
  assert.deepStrictEqual(p.cuts.map(function (c) { return [c.first, c.last, c.a, c.b]; }), [[20, 30, 2.0, 3.1], [95, 99, 9.5, Infinity]]);
  assert.ok(Math.abs(p.kept - (10 - 1.1 - 0.5)) < 1e-9, 'kept ' + p.kept);
  assert.strictEqual(p.expectedFrames, 100 - 11 - 5);
  p = cc.planCuts([[0, 0.25]], frames, 10);
  assert.deepStrictEqual([p.cuts[0].first, p.cuts[0].last, p.cuts[0].a, p.cuts[0].b, p.cuts[0].lo, p.cuts[0].aAudio], [0, 2, 0, 0.3, -Infinity, -Infinity]);
  p = cc.planCuts([[4.0, 4.05], [4.1, 4.3]], frames, 10);
  assert.strictEqual(p.cuts.length, 1, 'touching frame groups merge');
  assert.deepStrictEqual([p.cuts[0].first, p.cuts[0].last], [40, 43]);
  p = cc.planCuts([[3.95, 4.0]], frames, 10);
  assert.deepStrictEqual([p.cuts[0].first, p.cuts[0].last], [39, 40], 'the frame on screen when the range starts goes too (fail closed)');
  p = cc.planCuts([[3.33, 3.34]], frames, 10);
  assert.deepStrictEqual([p.cuts[0].first, p.cuts[0].last], [33, 33], 'a range inside one frame still cuts that frame');
  p = cc.planCuts([], frames, 10);
  assert.deepStrictEqual([p.cuts.length, p.kept, p.expectedFrames], [0, 10, 100]);
  // Hundreds of ranges stay a shallow expression.
  var many = [];
  for (i = 0; i < 400; i++) { many.push([i * 0.02 + 0.001, i * 0.02 + 0.005]); }
  var big = [];
  for (i = 0; i < 800; i++) { big.push(i / 100); }
  var g = cc.buildGraph(cc.planCuts(many, big, 8).cuts, 0, [1, 2]);
  var depth = 0, maxDepth = 0;
  g.split('').forEach(function (ch) { if (ch === '(') { depth++; maxDepth = Math.max(maxDepth, depth); } else if (ch === ')') { depth--; } });
  assert.ok(maxDepth < 40, 'nesting depth ' + maxDepth);
});

test('describeEstimate words', function () {
  assert.deepStrictEqual(cc.describeEstimate(50), { key: 'cleancopy.estimate.oneMinute', params: {} });
  assert.deepStrictEqual(cc.describeEstimate(25 * 60 + 40), { key: 'cleancopy.estimate.minutes', params: { n: 25 } });
  assert.deepStrictEqual(cc.describeEstimate(7 * 60), { key: 'cleancopy.estimate.minutes', params: { n: 7 } });
  assert.deepStrictEqual(cc.describeEstimate(95 * 60), { key: 'cleancopy.estimate.hours', params: { h: 1, m: 40 } });
  assert.deepStrictEqual(cc.describeEstimate(0), { key: 'cleancopy.estimate.unknown', params: {} });
});

test('encoder choice: hardware order per OS, dry run rejects encoders this machine cannot run', opts, function (t, done) {
  assert.deepStrictEqual(encoders.candidates('win32', false), ['h264_qsv', 'h264_nvenc', 'h264_amf']);
  assert.deepStrictEqual(encoders.candidates('darwin', false), ['h264_videotoolbox']);
  assert.deepStrictEqual(encoders.candidates('darwin', true), ['hevc_videotoolbox', 'h264_videotoolbox']);
  assert.ok(encList.libx264, 'this ffmpeg has libx264');
  encoders.pick(h.FFMPEG, { candidates: HW_HERE }, function (err, enc) {
    assert.ifError(err);
    // This container has no GPU: listed hardware encoders (h264_nvenc, h264_qsv here) fail the dry run.
    t.diagnostic('listed here: ' + HW_HERE.filter(function (n) { return encList[n]; }).join(', ') + '; chosen: ' + enc.name);
    assert.strictEqual(enc.name, 'libx264');
    assert.strictEqual(enc.hw, false);
    assert.deepStrictEqual(enc.args({ width: 320, height: 180, fps: 24 }).slice(0, 6), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']);
    done();
  });
});

test('(a) H.264 MKV with B-frames, AAC + AC3 5.1 + subtitles', opts, function (t, done) {
  var dir = h.tmpDir('clean-a');
  var src = makeSource(dir, 'mkv', 40);
  var cuts = [[10.3, 14.7], [20.2, 21.1, 'hide'], [33.5, 35.2, 'mute']];
  run(src, cuts, null, function (res) {
    assert.strictEqual(path.basename(res.path), 'movie mkv (bonis oculis clean).mp4');
    assert.strictEqual(path.dirname(res.path), dir, 'next to the source');
    assert.strictEqual(res.container, 'mp4');
    assert.strictEqual(res.subtitlesDropped, 1);
    check(t, '(a) mkv', src, cuts, res, function () {
      var streams = probeJson(['-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language,title', res.path]).streams;
      assert.deepStrictEqual(streams.map(function (s) { return s.codec_type + ':' + s.codec_name + (s.channels ? ':' + s.channels : ''); }),
        ['video:h264', 'audio:aac:1', 'audio:aac:6'], 'all audio tracks as AAC, 5.1 kept, no subtitles');
      assert.deepStrictEqual(streams.slice(1).map(function (s) { return (s.tags || {}).language; }), ['eng', 'spa'], 'track languages kept');
    });
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['movie mkv (bonis oculis clean).mp4', 'movie mkv.mkv', 'subs.srt', 'tmp']);
    done();
  });
});

test('(b) open-GOP HEVC MKV', { skip: !have ? 'ffmpeg not installed' : (x265 ? false : 'no libx265 in this ffmpeg'), timeout: 120000 }, function (t, done) {
  var dir = h.tmpDir('clean-b');
  var src = makeSource(dir, 'hevc', 30);
  var cuts = [[1.9, 2.05], [9.99, 12.0], [21.37, 26.6]];
  run(src, cuts, { keepHevc: true }, function (res) {
    // keepHevc only applies with hevc_videotoolbox (macOS); here it falls back to H.264 in MP4.
    assert.strictEqual(res.container, 'mp4');
    check(t, '(b) hevc open-gop', src, cuts, res);
    done();
  });
});

test('(c) MPEG-TS that starts at 1.4 s', opts, function (t, done) {
  var dir = h.tmpDir('clean-c');
  var src = makeSource(dir, 'ts', 30);
  var start = parseFloat(probeJson(['-show_entries', 'format=start_time', src]).format.start_time);
  assert.ok(Math.abs(start - 1.4) < 0.1, 'fixture starts at ' + start);
  var cuts = [[0, 1.3], [9.0, 10.0], [20.5, 23.0]];
  run(src, cuts, null, function (res) {
    check(t, '(c) ts start ' + start.toFixed(3), src, cuts, res);
    done();
  });
});

test('(d) MP4 with a 2 s GOP, cut to the end', opts, function (t, done) {
  var dir = h.tmpDir('clean-d');
  var src = makeSource(dir, 'mp4', 30);
  var cuts = [[4.0, 6.0], [11.11, 16.3], [27.2, 99]];
  var chosen = path.join(dir, 'chosen');
  fs.mkdirSync(chosen);
  run(src, cuts, { outDir: chosen }, function (res) {
    assert.strictEqual(path.dirname(res.path), chosen, 'chosen folder');
    var copy = path.join(dir, 'copy.mp4');
    fs.renameSync(res.path, copy);
    res.path = copy;
    check(t, '(d) mp4 gop 2s', src, cuts, res);
    done();
  });
});

// Board review 2, N2: Matroska reports its END timestamp as format.duration, so an MKV starting at
// 601.4 s used to fail the duration check (and the library showed 11 minutes for 60 s).
[['(e) MKV starting at 601.4 s', 'mkv601'], ['(f) MP4 starting at 601.4 s', 'mp4601']].forEach(function (c) {
  test(c[0], opts, function (t, done) {
    var dir = h.tmpDir('clean-' + c[1]);
    var src = makeSource(dir, c[1], 30);
    var j = probeJson(['-show_entries', 'format=start_time', src]);
    assert.ok(Math.abs(parseFloat(j.format.start_time) - 601.4) < 0.1, 'fixture starts at ' + j.format.start_time);
    var cuts = [[0, 1.3], [9.0, 10.0], [20.5, 23.0]];
    run(src, cuts, null, function (res) {
      assert.ok(Math.abs(res.kept - (30 - 1.3 - 1.0 - 2.5)) < 0.15, 'kept ' + res.kept);
      check(t, c[0].slice(0, 3) + ' start ' + parseFloat(j.format.start_time).toFixed(3), src, cuts, res);
      done();
    });
  });
});

test('cancel stops the copy and leaves nothing behind', opts, function (t, done) {
  var dir = h.tmpDir('clean-cancel');
  var src = h.testVideo('clean-cancel', 60);
  var copy = path.join(dir, 'movie.mp4');
  fs.copyFileSync(src, copy);
  var tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  var cancelledAt = null;
  var handle = cc.cleanCopy({ input: copy, doc: doc([[3, 5], [8, 9], [12, 13]], 60), ffmpeg: h.FFMPEG, ffprobe: h.FFPROBE, tmpDir: tmp, threads: 1, candidates: [],
    onProgress: function (p) {
      if (p.done > 0 && cancelledAt === null) {
        cancelledAt = p.done;
        assert.ok(fs.readdirSync(dir).some(function (n) { return /\.part$/.test(n); }), 'a partial file exists while encoding');
        handle.cancel();
      }
    } }, function (err) {
    assert.ok(err);
    assert.strictEqual(err.code, 'cancelled');
    assert.ok(cancelledAt !== null, 'cancelled while encoding');
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['movie.mp4', 'tmp']);
    done();
  });
});

test('estimate returns seconds from a sample encode', opts, function (t, done) {
  var src = h.testVideo('clean-estimate', 30);
  cc.estimate({ input: src, doc: doc([[3, 5]], 30), ffmpeg: h.FFMPEG, ffprobe: h.FFPROBE, threads: 2, candidates: [] }, function (err, est) {
    assert.ifError(err);
    assert.strictEqual(typeof est.seconds, 'number');
    assert.ok(est.seconds > 0 && isFinite(est.seconds), 'seconds ' + est.seconds);
    assert.ok(Math.abs(est.kept - 28) < 0.01, 'kept ' + est.kept);
    assert.ok(est.speed > 0);
    assert.strictEqual(est.encoder, 'libx264');
    assert.strictEqual(typeof est.words.key, 'string');
    t.diagnostic('estimate ' + est.seconds + ' s for 28 s kept at ' + est.speed.toFixed(1) + 'x');
    done();
  });
});

// Data for the ETA logic (numbers copied into SPEED_HINTS in clean-copy.js).
test('encode speed: libx264 veryfast at 320x180 and 1280x720 (10 s clips)', opts, function (t, done) {
  var dir = h.tmpDir('clean-speed');
  var sizes = ['320x180', '1280x720'];
  var results = [];
  function next() {
    if (!sizes.length) {
      t.diagnostic('speed ' + results.join('; '));
      done();
      return;
    }
    var s = sizes.shift();
    var file = path.join(dir, 'speed-' + s + '.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=' + s + ':r=24:d=10', '-f', 'lavfi', '-i', 'sine=f=440:d=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    var tmp = path.join(dir, 'tmp-' + s);
    fs.mkdirSync(tmp);
    var t0 = Date.now();
    var encodeStart = null;
    cc.cleanCopy({ input: file, doc: doc([[4, 5]], 10), ffmpeg: h.FFMPEG, ffprobe: h.FFPROBE, tmpDir: tmp, outDir: tmp, threads: 2, candidates: [],
      onProgress: function (p) { if (encodeStart === null) { encodeStart = Date.now(); } } }, function (err, res) {
      assert.ifError(err);
      var wall = (Date.now() - (encodeStart || t0)) / 1000;
      results.push(s + ' ' + (res.kept / wall).toFixed(1) + 'x real time (' + res.kept.toFixed(2) + ' s in ' + wall.toFixed(2) + ' s, total with probing ' +
        ((Date.now() - t0) / 1000).toFixed(2) + ' s)');
      next();
    });
  }
  next();
});
