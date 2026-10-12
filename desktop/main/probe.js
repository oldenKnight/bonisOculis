'use strict';
// ffprobe helpers: duration + video stream check, keyframe list. Never throws; callbacks only.

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

// cb(err, {duration, hasVideo, width, height})
function media(ffprobe, file, cb) {
  run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json', file], function (e, code, out) {
    if (e || code !== 0) { cb(e || new Error('ffprobe exit ' + code)); return; }
    var j, i, info = { duration: 0, hasVideo: false, width: 0, height: 0 };
    try { j = JSON.parse(out); } catch (e2) { cb(new Error('ffprobe output')); return; }
    info.duration = parseFloat(j && j.format && j.format.duration) || 0;
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
      var v = parseFloat(parts[parts.length - 1]);
      if (parts[0] === 'frame' && isFinite(v)) { list.push(v); }
    });
    list.sort(function (a, b) { return a - b; });
    cb(null, list);
  });
}

module.exports = { run: run, media: media, keyframes: keyframes };
