'use strict';
// Clean copy for USB / TV (LEDGER D6, replaced by D24): a new file with the protected scenes cut
// out, made by an EXACT re-encode in one ffmpeg pass. Stream copy was dropped because a copied
// GOP keeps frames of a cut scene and the parts drift out of sync (board review B2, B3, B4).
//
//  1. ffprobe: streams, format start_time, then the pts of every packet of the video stream
//     (demux only, no decode). Skip ranges are on mpv's timeline, t = pts - format.start_time.
//     ffmpeg runs with -copyts and every threshold gets start_time added, so the filters work
//     on raw timestamps: no -ss, and none of the CLI's own start-time handling (which for
//     MPEG-TS even depends on which streams are decoded). A TS starting at 1.4 s just works.
//  2. planCuts: a frame is cut when ANY part of its display interval [t_k, t_k+1) touches an
//     enforced range (fail closed: up to one more frame, never one less). Each cut becomes
//     [a', b'): its first cut frame to the first kept frame after it. Video and every audio
//     track use these same boundaries, so they cannot drift apart however many cuts there are.
//  3. One filtergraph, written to a file (hundreds of ranges do not fit a command line), with
//     each expression a balanced if(lt()) tree, so a frame costs O(log ranges) to test:
//       video: select='keep(t)', setpts=PTS - removedBefore(T)/TB
//       audio: asetnsamples=256 (5 ms pieces), aselect keeps a piece only if it lies wholly
//              outside every cut, asetpts with the same removedBefore(T), then
//              aresample=async=1 fills the <= 2 pieces of each cut edge with silence so the
//              sound stays sample-locked to the video timeline (no cut sound survives either).
//     Output timestamps are analytic (source time minus removed time), not N/FRAME_RATE, so
//     variable-frame-rate files stay in sync too.
//  4. Before encoding, the first decoded frame's time is compared with the probed timeline
//     (fails closed if they disagree). After encoding, the result's video packet count must not
//     exceed the expected kept frames and its duration must match; otherwise it is deleted.
//  5. Encoder: encoders.js (hardware when it works, else libx264 veryfast crf 20). All audio
//     tracks -> AAC (192k stereo, 64k per channel above, at most 5.1), languages and titles kept.
//     Subtitles, chapters and attachments are left out (they would show cut scenes' text).
//     MP4 (+faststart) for H.264/AAC, MKV when HEVC is kept.
//  6. Progress from -progress pipe:1 (out_time_us) against the kept duration, with an ETA. Low
//     process priority. Cancel kills ffmpeg; the partial file and temp folder go in every outcome.
//
// Never throws. ES5, callbacks only.

var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');
var BO = require('../../../shared/skipfile.js');
var probe = require('../probe.js');
var encoders = require('./encoders.js');

var MIN_KEPT = 0.2;
var AUDIO_PIECE = 256;
var HARD_COMP = 0.005;
var MAX_CHANNELS = 6;
var SAMPLE_SECONDS = 5;
// ETA data, measured 2026-10-13 by the "encode speed" test in desktop/test/clean-copy.test.js:
// the whole pipeline (select/aselect graph + libx264 veryfast crf 20 + AAC), 10 s testsrc2 clips
// at 24 fps, -threads 2, 4-vCPU development container (x86-64, no GPU), ffmpeg 6.1:
//   320x180  : 13.5-15.5x real time      1280x720 : 5.4-5.8x real time
// 1080p has 2.25x the pixels of 720p, so expect ~2.5x real time on such a CPU with 2 threads:
// a 2 h film takes ~50 min without a video chip; Quick Sync / VideoToolbox are several times
// faster. estimate() measures the real machine; these numbers are only a sanity reference.
var SPEED_HINTS = { px320x180: 14, px1280x720: 5.5 };

function noop() {}

function num(x) { return (Math.round(x * 1e6) / 1e6).toFixed(6); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* best effort */ } }

function defaultThreads() { return Math.max(1, Math.floor(((os.cpus() || []).length || 2) / 2)); }

function lowPriority(proc) {
  try { if (proc && proc.pid) { os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW); } } catch (e) { /* not permitted */ }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

// [[start, end]] -> sorted, clamped at 0, overlaps and touches merged.
function mergeRanges(cuts) {
  var sorted = (cuts || []).map(function (c) { return [Math.max(0, +c[0]), +c[1]]; })
    .filter(function (c) { return isFinite(c[0]) && isFinite(c[1]) && c[1] > c[0]; })
    .sort(function (a, b) { return a[0] - b[0]; });
  var merged = [];
  sorted.forEach(function (c) {
    var last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) { last[1] = Math.max(last[1], c[1]); } else { merged.push([c[0], c[1]]); }
  });
  return merged;
}

// First index i with list[i] > x (list sorted ascending).
function upperBound(list, x) {
  var lo = 0, hi = list.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (list[mid] > x) { hi = mid; } else { lo = mid + 1; }
  }
  return lo;
}

function medianStep(times) {
  var d = [];
  var i;
  for (i = 1; i < times.length && d.length < 2000; i++) { if (times[i] > times[i - 1]) { d.push(times[i] - times[i - 1]); } }
  if (!d.length) { return 1 / 25; }
  d.sort(function (a, b) { return a - b; });
  return d[d.length >> 1];
}

// ranges: [[start, end]] on the file timeline; frames: video frame times (any order, may repeat);
// duration: file duration. Returns {cuts: [{first, last, a, aAudio, b, lo, hi}], kept, keptSpans,
// expectedFrames, frameStep}. a/b: first cut frame time / first kept frame time after the cut
// (b = Infinity when the cut runs to the end; a <= 0 when it starts at the first frame).
// lo/hi: midpoints between the outermost cut frames and their kept neighbours (select bounds).
function planCuts(ranges, frames, duration) {
  var all = frames.filter(function (t) { return isFinite(t); }).sort(function (x, y) { return x - y; });
  var times = all.filter(function (t, i) { return i === 0 || t !== all[i - 1]; });
  var n = times.length;
  var step = medianStep(times);
  var end = Math.max(duration || 0, n ? times[n - 1] + step : 0);
  var groups = [];
  mergeRanges(ranges).forEach(function (r) {
    if (!n) { return; }
    // A frame is shown during [t_k, t_k+1); cut it when that touches [r0, r1].
    var first = Math.max(0, upperBound(times, r[0]) - 1);
    var firstEnd = first + 1 < n ? times[first + 1] : times[first] + step;
    if (firstEnd <= r[0]) { first++; }
    var last = upperBound(times, r[1]) - 1;
    if (first >= n || last < first) { return; }
    var prev = groups[groups.length - 1];
    if (prev && first <= prev.last + 1) { prev.last = Math.max(prev.last, last); } else { groups.push({ first: first, last: last }); }
  });
  var cuts = groups.map(function (g) {
    var atStart = g.first === 0;
    var toEnd = g.last + 1 >= n;
    return {
      first: g.first,
      last: g.last,
      a: atStart ? Math.min(0, times[0]) : times[g.first],
      aAudio: atStart ? -Infinity : times[g.first],
      b: toEnd ? Infinity : times[g.last + 1],
      lo: atStart ? -Infinity : (times[g.first - 1] + times[g.first]) / 2,
      hi: toEnd ? Infinity : (times[g.last] + times[g.last + 1]) / 2
    };
  });
  var spans = [];
  var cur = 0;
  cuts.forEach(function (c) {
    if (c.a > cur) { spans.push({ start: cur, end: c.a }); }
    cur = Math.max(cur, c.b);
  });
  if (cur < end) { spans.push({ start: cur, end: end }); }
  var kept = spans.reduce(function (acc, s) { return acc + (s.end - s.start); }, 0);
  var expected = 0;
  var ci = 0;
  all.forEach(function (t) {
    while (ci < cuts.length && t >= cuts[ci].hi) { ci++; }
    if (!(ci < cuts.length && t > cuts[ci].lo && t < cuts[ci].hi)) { expected++; }
  });
  return { cuts: cuts, kept: kept, keptSpans: spans, expectedFrames: expected, frameStep: step };
}

// Balanced if(lt()) tree: values[k] holds for breaks[k-1] <= v < breaks[k]
// (values.length === breaks.length + 1). Each lookup evaluates O(log n) nodes. shift is added to
// every break (file timeline -> the raw timestamps ffmpeg sees with -copyts).
function stepExpr(v, breaks, values, shift) {
  var sh = shift || 0;
  function rec(i, j) {
    var k, same = true;
    for (k = i + 1; k <= j && same; k++) { same = values[k] === values[i]; }
    if (same) { return values[i]; }
    var m = (i + j + 1) >> 1;
    return 'if(lt(' + v + ',' + num(breaks[m - 1] + sh) + '),' + rec(i, m - 1) + ',' + rec(m, j) + ')';
  }
  return rec(0, values.length - 1);
}

// 1 for video frames to keep (select uses t).
function videoKeepExpr(cuts, shift) {
  var breaks = [], values = ['1'];
  cuts.forEach(function (c) {
    if (isFinite(c.lo)) { breaks.push(c.lo); values.push('0'); } else { values[0] = '0'; }
    if (isFinite(c.hi)) { breaks.push(c.hi); values.push('1'); }
  });
  return 'if(isnan(t),0,' + stepExpr('t', breaks, values, shift) + ')';
}

// 1 for audio pieces lying wholly outside every cut (aselect uses t, samples_n, sample_rate).
function audioKeepExpr(cuts, shift) {
  var breaks = [], values = [];
  var open = true;
  cuts.forEach(function (c) {
    if (isFinite(c.aAudio)) {
      values.push('lte(t+samples_n/sample_rate,' + num(c.aAudio + (shift || 0) + 1e-6) + ')');
      breaks.push(c.aAudio);
    }
    values.push('0');
    if (isFinite(c.b)) { breaks.push(c.b); } else { open = false; }
  });
  if (open) { values.push('1'); }
  return 'if(isnan(t),0,' + stepExpr('t', breaks, values, shift) + ')';
}

// Seconds to subtract at raw time T (setpts / asetpts use T): the file start plus what was cut.
function offsetExpr(cuts, shift) {
  var cum = shift || 0;
  var breaks = [], values = [num(cum)];
  cuts.forEach(function (c) {
    if (!isFinite(c.hi)) { return; }
    cum += c.b - c.a;
    breaks.push(c.hi);
    values.push(num(cum));
  });
  return stepExpr('T', breaks, values, shift);
}

// The whole filtergraph. video: absolute stream index; audio: [absolute stream index];
// start: the file's start_time (ffmpeg runs with -copyts, so filters see raw timestamps).
function buildGraph(cuts, video, audio, start) {
  var off = offsetExpr(cuts, start);
  var lines = ['[0:' + video + "]select='" + videoKeepExpr(cuts, start) + "',setpts='round(PTS-(" + off + ")/TB)'[v]"];
  var akeep = audioKeepExpr(cuts, start);
  audio.forEach(function (idx, i) {
    lines.push('[0:' + idx + ']asetnsamples=n=' + AUDIO_PIECE + ":p=0,aselect='" + akeep + "',asetpts='round(PTS-(" + off + ")/TB)'," +
      'aresample=async=1:min_hard_comp=' + HARD_COMP + ':first_pts=0[a' + i + ']');
  });
  return lines.join(';\n') + '\n';
}

function audioBitrate(ch) { return ch <= 1 ? '128k' : (ch <= 2 ? '192k' : (64 * ch) + 'k'); }

function uniqueOutput(dir, base, ext) {
  var p = path.join(dir, base + ' (bonis oculis clean)' + ext);
  var n = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, base + ' (bonis oculis clean) ' + n + ext);
    n++;
  }
  return p;
}

// Words for the confirm dialog: {key, params} for i18n ("about 25 minutes").
function describeEstimate(seconds) {
  if (!(seconds > 0)) { return { key: 'cleancopy.estimate.unknown', params: {} }; }
  var min = seconds / 60;
  if (min < 1.5) { return { key: 'cleancopy.estimate.oneMinute', params: {} }; }
  if (min < 60) { return { key: 'cleancopy.estimate.minutes', params: { n: min < 20 ? Math.round(min) : Math.round(min / 5) * 5 } }; }
  var h = Math.floor(min / 60);
  var m = Math.round((min - h * 60) / 10) * 10;
  if (m === 60) { h++; m = 0; }
  return { key: 'cleancopy.estimate.hours', params: { h: h, m: m } };
}

// ---------------------------------------------------------------------------------------------
// Probing

function rate(s) {
  var m = /^(\d+)\/(\d+)$/.exec(String(s || ''));
  if (!m || +m[2] === 0) { return 0; }
  return +m[1] / +m[2];
}

// cb(err, info) info: {duration, start, video: {...} | null, audio: [...], subtitles: n}
function probeSource(ffprobe, input, cb) {
  return probe.run(ffprobe, ['-v', 'error', '-show_entries',
    'format=start_time,duration:stream=index,codec_type,codec_name,pix_fmt,color_transfer,width,height,avg_frame_rate,r_frame_rate,channels,time_base' +
    ':stream_tags=language,title:stream_disposition=attached_pic', '-of', 'json', input], function (e, code, out) {
    if (e || code !== 0) { cb(e || new Error('ffprobe exit ' + code)); return; }
    var j;
    try { j = JSON.parse(out); } catch (e2) { cb(new Error('ffprobe output')); return; }
    var fmt = (j && j.format) || {};
    var info = { duration: parseFloat(fmt.duration) || 0, start: parseFloat(fmt.start_time) || 0, video: null, audio: [], subtitles: 0 };
    ((j && j.streams) || []).forEach(function (s) {
      var tags = s.tags || {};
      if (s.codec_type === 'video' && !info.video && !(s.disposition && s.disposition.attached_pic)) {
        var pf = String(s.pix_fmt || '');
        info.video = {
          index: s.index, codec: s.codec_name || '', width: s.width || 0, height: s.height || 0,
          fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate), timeBase: rate(s.time_base),
          tenBit: /p(9|10|12|14|16)/.test(pf),
          hdr: s.color_transfer === 'smpte2084' || s.color_transfer === 'arib-std-b67'
        };
      } else if (s.codec_type === 'audio' && s.channels > 0) {
        info.audio.push({ index: s.index, channels: s.channels, language: tags.language || '', title: tags.title || '' });
      } else if (s.codec_type === 'subtitle') {
        info.subtitles++;
      }
    });
    cb(null, info);
  });
}

// Times of every packet of one stream on the CLI timeline (pts - format start). cb(err, [t])
function probeFrames(ffprobe, input, info, cb) {
  var tb = info.video.timeBase;
  return probe.run(ffprobe, ['-v', 'error', '-select_streams', String(info.video.index), '-show_entries', 'packet=pts,dts',
    '-of', 'compact=p=0', input], function (e, code, out) {
    if (e || code !== 0 || !(tb > 0)) { cb(e || new Error('ffprobe exit ' + code)); return; }
    var list = [];
    var missing = 0;
    out.split(/\r?\n/).forEach(function (line) {
      if (!line) { return; }
      var pts = /(?:^|\|)pts=(-?\d+)/.exec(line);
      var dts = /(?:^|\|)dts=(-?\d+)/.exec(line);
      var v = pts ? +pts[1] : (dts ? +dts[1] : NaN);
      if (isFinite(v)) { list.push(v * tb - info.start); } else { missing++; }
    });
    if (!list.length || missing > list.length / 2) { cb(new Error('noTimestamps')); return; }
    cb(null, list);
  });
}

// The first decoded frame must sit on the probed timeline (catches a timestamp mismatch).
// stderr is scanned line by line: a file with many streams prints a long header first.
function checkTimeline(ffmpeg, input, info, times, cb) {
  var found = null;
  var buf = '';
  var done = false;
  var proc;
  function finish() {
    if (done) { return; }
    done = true;
    if (found === null) { cb(false); return; }
    var t = found - info.start;
    var tol = Math.max(0.002, info.video.timeBase || 0);
    cb(times.some(function (x) { return Math.abs(x - t) <= tol; }));
  }
  try {
    proc = childProcess.spawn(ffmpeg, ['-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-threads', '1', '-copyts', '-i', input,
      '-map', '0:' + info.video.index, '-vf', 'showinfo', '-frames:v', '1', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (e) { finish(); return null; }
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', function (d) {
    if (found !== null) { return; }
    buf += d;
    var lines = buf.split(/\r?\n/);
    buf = lines.pop().slice(-4096);
    lines.forEach(function (line) {
      var m = found === null && /Parsed_showinfo.*\bpts_time:\s*(-?[\d.]+)/.exec(line);
      if (m) { found = parseFloat(m[1]); }
    });
  });
  proc.on('error', finish);
  proc.on('close', finish);
  return proc;
}

function verifyOutput(ffprobe, file, plan, cb) {
  return probe.run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets:format=duration',
    '-of', 'json', file], function (e, code, out) {
    var j;
    if (e || code !== 0) { cb('ffprobe'); return; }
    try { j = JSON.parse(out); } catch (e2) { cb('ffprobe output'); return; }
    var count = parseInt(j && j.streams && j.streams[0] && j.streams[0].nb_read_packets, 10);
    var dur = parseFloat(j && j.format && j.format.duration);
    if (!(count > 0) || count > plan.expectedFrames) { cb('frames ' + count + ' > expected ' + plan.expectedFrames); return; }
    if (!(Math.abs(dur - plan.kept) <= Math.max(1, plan.kept * 0.01))) { cb('duration ' + dur + ' vs kept ' + plan.kept); return; }
    cb(null, { frames: count, duration: dur });
  });
}

// Spawns ffmpeg with -progress pipe:1; onTime(seconds) for each out_time_us. cb(err, code, stderrTail)
function runEncode(ffmpeg, args, onTime, cb) {
  var tail = '';
  var buf = '';
  var done = false;
  var proc;
  function finish(e, code) { if (!done) { done = true; cb(e, code, tail); } }
  try {
    proc = childProcess.spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) { finish(e, -1); return null; }
  lowPriority(proc);
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', function (d) {
    buf += d;
    var lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (line) {
      var m = /^out_time_us=(\d+)/.exec(line) || /^out_time_ms=(\d+)/.exec(line);
      if (m) { onTime(+m[1] / 1e6); }
    });
  });
  proc.stderr.on('data', function (d) { tail = (tail + d).slice(-4096); });
  proc.on('error', function (e) { finish(e, -1); });
  proc.on('close', function (code) { finish(null, code); });
  return proc;
}

function audioArgs(audio) {
  var args = [];
  audio.forEach(function (a, i) {
    var ch = Math.min(MAX_CHANNELS, a.channels);
    args.push('-map', '[a' + i + ']', '-c:a:' + i, 'aac', '-b:a:' + i, audioBitrate(ch), '-ac:a:' + i, String(ch));
    if (a.language) { args.push('-metadata:s:a:' + i, 'language=' + a.language); }
    // MKV reads title; MP4 has no track title, players show the handler name instead.
    if (a.title) { args.push('-metadata:s:a:' + i, 'title=' + a.title, '-metadata:s:a:' + i, 'handler_name=' + a.title); }
  });
  return args;
}

// ---------------------------------------------------------------------------------------------
// Public

// opts: {input, doc, outDir?, ffmpeg, ffprobe, tmpDir, threads?, keepHevc?, onProgress?,
//        platform?, candidates? (tests)}  (opts.aac is accepted and ignored: audio is always AAC)
// cb(err, {path, kept, segments, cuts, encoder, hw, container, subtitlesDropped, hdrConverted, frames})
// err.code: cancelled | notVideo | noKeyframes (timeline unusable) | nothingLeft | tmpFailed |
//           notWritable | ffmpegFailed. Returns {cancel()}.
function cleanCopy(opts, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var onProgress = opts.onProgress || noop;
  var threads = String(opts.threads > 0 ? Math.floor(opts.threads) : defaultThreads());
  var cancelled = false;
  var proc = null;
  var finished = false;
  var partial = null;
  var work = path.join(opts.tmpDir, 'clean-' + crypto.randomBytes(6).toString('hex'));

  function finish(err, res) {
    if (finished) { return; }
    finished = true;
    if (partial) { try { fs.unlinkSync(partial); } catch (e) { /* none */ } }
    rmrf(work);
    done(err, res);
  }
  function fail(code, detail) {
    var e = new Error(code);
    e.code = cancelled ? 'cancelled' : code;
    if (detail) { e.detail = detail; }
    finish(e);
  }
  function step(p) { proc = p; }

  var handle = {
    cancel: function () {
      cancelled = true;
      if (proc) { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } } else { setImmediate(function () { fail('cancelled'); }); }
    }
  };

  try { fs.mkdirSync(work, { recursive: true }); } catch (e) { fail('tmpFailed'); return handle; }

  step(probeSource(opts.ffprobe, opts.input, function (e1, info) {
    proc = null;
    if (cancelled) { fail('cancelled'); return; }
    if (e1 || !info || !info.video || !(info.duration > 0)) { fail('notVideo'); return; }
    step(probeFrames(opts.ffprobe, opts.input, info, function (e2, frames) {
      proc = null;
      if (cancelled) { fail('cancelled'); return; }
      if (e2) { fail('noKeyframes', e2.message); return; }
      var ranges = BO.enforced(opts.doc).map(function (r) { return [r.start, r.end]; });
      var plan = planCuts(ranges, frames, info.duration);
      if (plan.kept < MIN_KEPT || plan.expectedFrames < 1) { fail('nothingLeft'); return; }
      encoders.scriptOption(opts.ffmpeg, work, function (e3, scriptArgs) {
        if (cancelled) { fail('cancelled'); return; }
        if (e3) { fail('ffmpegFailed', 'filter script: ' + e3.message); return; }
        var wantHevc = !!opts.keepHevc && info.video.codec === 'hevc';
        encoders.pick(opts.ffmpeg, { platform: opts.platform, candidates: opts.candidates, wantHevc: wantHevc, tenBit: info.video.tenBit }, function (e4, enc) {
          if (cancelled) { fail('cancelled'); return; }
          if (e4) { fail('ffmpegFailed', 'encoder: ' + e4.message); return; }
          step(checkTimeline(opts.ffmpeg, opts.input, info, frames, function (ok) {
            proc = null;
            if (cancelled) { fail('cancelled'); return; }
            if (!ok) { fail('noKeyframes', 'timeline'); return; }
            encode(info, plan, enc, scriptArgs);
          }));
        });
      });
    }));
  }));

  function encode(info, plan, enc, scriptArgs) {
    var graph = path.join(work, 'graph.txt');
    var audioIdx = info.audio.map(function (a) { return a.index; });
    try { fs.writeFileSync(graph, buildGraph(plan.cuts, info.video.index, audioIdx, info.start)); } catch (e) { fail('tmpFailed'); return; }
    var outDir = opts.outDir || path.dirname(opts.input);
    try { fs.accessSync(outDir, fs.constants.W_OK); } catch (e) { fail('notWritable'); return; }
    var mp4 = enc.codec === 'h264';
    var target = uniqueOutput(outDir, path.basename(opts.input, path.extname(opts.input)), mp4 ? '.mp4' : '.mkv');
    partial = target + '.part';
    var args = ['-nostdin', '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5', '-y',
      '-threads', threads, '-copyts', '-i', opts.input].concat(scriptArgs(graph), ['-map', '[v]'],
      enc.args({ width: info.video.width, height: info.video.height, fps: info.video.fps, tenBit: info.video.tenBit }),
      // Keep the analytic timestamps: auto picks CFR for MP4, which duplicates and drops frames, and
      // the default 1/framerate encoder time base would round variable-rate timestamps together.
      ['-fps_mode', 'vfr', '-enc_time_base:v', '1:90000'],
      audioArgs(info.audio), ['-map_metadata', '0', '-map_chapters', '-1', '-threads', threads, '-max_muxing_queue_size', '4096']);
    if (mp4) { args.push('-movflags', '+faststart', '-f', 'mp4'); } else { args.push('-f', 'matroska'); }
    args.push(partial);
    var started = Date.now();
    var last = -1;
    onProgress({ done: 0, total: plan.kept, pct: 0, etaSec: null, encoder: enc.name, hw: enc.hw });
    step(runEncode(opts.ffmpeg, args, function (t) {
      var d = Math.max(0, Math.min(plan.kept, t));
      if (d - last < 0.25 && d < plan.kept) { return; }
      last = d;
      var el = (Date.now() - started) / 1000;
      var eta = d > 0.5 && el > 2 ? Math.max(0, (plan.kept - d) * el / d) : null;
      onProgress({ done: d, total: plan.kept, pct: Math.floor(d / plan.kept * 100), etaSec: eta === null ? null : Math.round(eta), encoder: enc.name, hw: enc.hw });
    }, function (e5, code, tail) {
      proc = null;
      if (cancelled) { fail('cancelled'); return; }
      if (e5 || code !== 0) { fail('ffmpegFailed', tail); return; }
      step(verifyOutput(opts.ffprobe, partial, plan, function (bad, v) {
        proc = null;
        if (cancelled) { fail('cancelled'); return; }
        if (bad) { fail('ffmpegFailed', 'verify: ' + bad); return; }
        try { fs.renameSync(partial, target); } catch (e6) { fail('notWritable'); return; }
        partial = null;
        onProgress({ done: plan.kept, total: plan.kept, pct: 100, etaSec: 0, encoder: enc.name, hw: enc.hw });
        finish(null, {
          path: target, kept: plan.kept, segments: plan.keptSpans, cuts: plan.cuts, frames: v.frames,
          encoder: enc.name, hw: enc.hw, container: mp4 ? 'mp4' : 'mkv',
          subtitlesDropped: info.subtitles, hdrConverted: (info.video.hdr || info.video.tenBit) && !enc.tenBitOut
        });
      }));
    }));
  }

  return handle;
}

// How long the copy will take on this machine: a 5 s sample from the middle of the movie with
// the encoder the copy would use, extrapolated to the kept duration.
// opts: {input, doc, ffmpeg, ffprobe, threads?, keepHevc?, platform?, candidates?, sampleSeconds?}
// cb(err, {seconds, kept, speed, encoder, hw, words: {key, params}, subtitles, hdrConverted}). Returns {cancel()}.
function estimate(opts, cb) {
  var done = typeof cb === 'function' ? cb : noop;
  var proc = null;
  var cancelled = false;
  var finished = false;
  var sample = opts.sampleSeconds > 0 ? opts.sampleSeconds : SAMPLE_SECONDS;
  function finish(err, res) { if (!finished) { finished = true; done(err, res); } }
  function fail(code) { var e = new Error(code); e.code = cancelled ? 'cancelled' : code; finish(e); }
  var handle = { cancel: function () { cancelled = true; if (proc) { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } } } };
  proc = probeSource(opts.ffprobe, opts.input, function (e1, info) {
    proc = null;
    if (cancelled) { fail('cancelled'); return; }
    if (e1 || !info || !info.video || !(info.duration > 0)) { fail('notVideo'); return; }
    var removed = mergeRanges(BO.enforced(opts.doc).map(function (r) { return [r.start, r.end]; }))
      .reduce(function (acc, r) { return acc + Math.max(0, Math.min(info.duration, r[1]) - Math.min(info.duration, r[0])); }, 0);
    var kept = Math.max(0, info.duration - removed);
    encoders.pick(opts.ffmpeg, { platform: opts.platform, candidates: opts.candidates, wantHevc: !!opts.keepHevc && info.video.codec === 'hevc', tenBit: info.video.tenBit }, function (e2, enc) {
      if (cancelled) { fail('cancelled'); return; }
      if (e2) { fail('ffmpegFailed'); return; }
      var len = Math.min(sample, info.duration);
      var from = Math.max(0, info.duration / 2 - len / 2);
      var threads = String(opts.threads > 0 ? Math.floor(opts.threads) : defaultThreads());
      var args = ['-nostdin', '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.25',
        '-threads', threads, '-ss', num(from), '-i', opts.input, '-t', num(len), '-map', '0:' + info.video.index]
        .concat(enc.args({ width: info.video.width, height: info.video.height, fps: info.video.fps, tenBit: info.video.tenBit }));
      info.audio.forEach(function (a, i) { args.push('-map', '0:' + a.index, '-c:a:' + i, 'aac', '-b:a:' + i, audioBitrate(Math.min(MAX_CHANNELS, a.channels)), '-ac:a:' + i, String(Math.min(MAX_CHANNELS, a.channels))); });
      args.push('-threads', threads, '-f', 'null', '-');
      var t0 = Date.now();
      var firstAt = null, firstOut = 0, lastOut = 0;
      proc = runEncode(opts.ffmpeg, args, function (t) {
        if (t > 0 && firstAt === null) { firstAt = Date.now(); firstOut = t; }
        lastOut = t;
      }, function (e3, code) {
        proc = null;
        if (cancelled) { fail('cancelled'); return; }
        if (e3 || code !== 0) { fail('ffmpegFailed'); return; }
        var wall = (Date.now() - t0) / 1000;
        var speed = len / Math.max(0.05, wall);
        // Prefer the rate between the first and the last progress line (leaves out seek and start-up).
        if (firstAt !== null && lastOut - firstOut > len / 3) {
          var w2 = (Date.now() - firstAt) / 1000;
          if (w2 > 0.05) { speed = Math.min(speed * 3, (lastOut - firstOut) / w2); }
        }
        var seconds = Math.round(kept / Math.max(0.01, speed) * 1.05 + 5);
        finish(null, {
          seconds: seconds, kept: kept, speed: speed, encoder: enc.name, hw: enc.hw, words: describeEstimate(seconds),
          subtitles: info.subtitles, hdrConverted: (info.video.hdr || info.video.tenBit) && !enc.tenBitOut
        });
      });
    });
  });
  return handle;
}

module.exports = {
  cleanCopy: cleanCopy, estimate: estimate, planCuts: planCuts, mergeRanges: mergeRanges, buildGraph: buildGraph,
  stepExpr: stepExpr, describeEstimate: describeEstimate, SPEED_HINTS: SPEED_HINTS
};
