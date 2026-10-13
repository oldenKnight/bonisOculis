'use strict';
// ffprobe helpers: duration + video stream check, keyframe list. Never throws; callbacks only.
//
// Timeline convention (one place in the desktop code; clean-copy.js repeats it):
//   skip-file time = media time - probed format.start_time
// i.e. 0 is the file's first timestamp, as ffmpeg and ffprobe count it. mpv's time-pos may
// include start_time (it does not rebase MP4/MOV, nor MKV with a negative start); the player
// compensates, the skip file never does.
// duration is the length of that timeline (last end - start_time), NOT the container's raw
// format.duration: Matroska reports its end timestamp there, so an MKV starting at 601.4 s
// with 60 s of video says 661.4 (board review 2, N2). See span().

var childProcess = require('child_process');

function run(bin, args, cb) {
  var out = '';
  var err = '';
  var done = false;
  var proc;
  function finish(e, code) {
    if (done) { return; }
    done = true;
    cb(e, code, out, err);
  }
  try {
    proc = childProcess.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) { finish(e, -1); return null; }
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', function (d) { out += d; });
  proc.stderr.on('data', function (d) { if (err.length < 8192) { err += d; } });
  proc.on('error', function (e) { finish(e, -1); });
  proc.on('close', function (code) { finish(null, code); });
  return proc;
}

// Entries span() needs; add them to any -show_entries that wants a duration.
var SPAN_ENTRIES = 'format=format_name,start_time,duration:stream=start_time,duration';

// Pure. ffprobe JSON (format + streams) -> {start, duration} on the skip-file timeline.
//  - Matroska/WebM: format.duration is the segment duration, which counts from timestamp 0, so
//    it is the end timestamp: subtract a positive start. (A negative start, e.g. -0.021 s of AAC
//    priming, is already included: measured 60.023 for -0.023 .. 60.0.)
//  - Others (MP4/MOV, MPEG-TS, ...): format.duration is already end - start.
//  - No format duration: the latest stream end (start + duration) - start.
function span(j) {
  var fmt = (j && j.format) || {};
  var start = parseFloat(fmt.start_time);
  if (!isFinite(start)) { start = 0; }
  var raw = parseFloat(fmt.duration);
  var duration = 0;
  if (isFinite(raw) && raw > 0) {
    duration = /matroska|webm/.test(String(fmt.format_name || '')) ? raw - Math.max(0, start) : raw;
  } else {
    ((j && j.streams) || []).forEach(function (st) {
      var s0 = parseFloat(st.start_time), d = parseFloat(st.duration);
      if (isFinite(s0) && isFinite(d)) { duration = Math.max(duration, s0 + d - start); }
    });
  }
  return { start: start, duration: duration > 0 ? duration : 0 };
}

// cb(err, {duration, start, hasVideo, width, height}) duration/start: see span().
function media(ffprobe, file, cb) {
  run(ffprobe, ['-v', 'error', '-show_entries', SPAN_ENTRIES + ',codec_type,width,height',
    '-of', 'json', file], function (e, code, out) {
    if (e || code !== 0) { cb(e || new Error('ffprobe exit ' + code)); return; }
    var j, i, info = { duration: 0, start: 0, hasVideo: false, width: 0, height: 0 };
    try { j = JSON.parse(out); } catch (e2) { cb(new Error('ffprobe output')); return; }
    var sp = span(j);
    info.duration = sp.duration;
    info.start = sp.start;
    var streams = (j && j.streams) || [];
    for (i = 0; i < streams.length; i++) {
      if (streams[i].codec_type === 'video' && !info.hasVideo) {
        info.hasVideo = true;
        info.width = streams[i].width || 0;
        info.height = streams[i].height || 0;
      }
    }
    cb(null, info);
  });
}

// Keyframe times of the first video stream, sorted. cb(err, [seconds])
function keyframes(ffprobe, file, cb) {
  return run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries',
    'frame=pts_time', '-of', 'csv', file], function (e, code, out) {
    if (e || code !== 0) { cb(e || new Error('ffprobe exit ' + code)); return; }
    var list = [];
    out.split(/\r?\n/).forEach(function (line) {
      var parts = line.split(',');
      var v = parseFloat(parts[1]);
      if (parts[0] === 'frame' && isFinite(v)) { list.push(v); }
    });
    list.sort(function (a, b) { return a - b; });
    cb(null, list);
  });
}

module.exports = { run: run, media: media, keyframes: keyframes, span: span, SPAN_ENTRIES: SPAN_ENTRIES };
