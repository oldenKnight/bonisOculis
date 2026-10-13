'use strict';
// probe.js: duration and start on the skip-file timeline (media time - format.start_time) for
// files that do not start at 0 (board review 2, N2). Ground truth: the latest packet end of any
// stream minus format.start_time, read from the packets themselves.

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var childProcess = require('child_process');
var h = require('./helpers.js');
var probe = require('../main/probe.js');

var opts = { skip: h.haveFfmpeg() ? false : 'ffmpeg not installed', timeout: 60000 };
var SRC = ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac'];

function ff(args) {
  var r = childProcess.spawnSync(h.FFMPEG, ['-nostdin', '-hide_banner', '-v', 'error', '-y'].concat(args), { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

function truth(file) {
  var j = JSON.parse(childProcess.spawnSync(h.FFPROBE, ['-v', 'error', '-show_entries', 'format=start_time:packet=pts_time,duration_time', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout);
  var start = parseFloat(j.format.start_time);
  var end = -Infinity;
  j.packets.forEach(function (p) { var t = parseFloat(p.pts_time) + (parseFloat(p.duration_time) || 0); if (isFinite(t)) { end = Math.max(end, t); } });
  return { start: start, duration: end - start };
}

function fixtures(dir) {
  var f = {};
  f.normal = path.join(dir, 'normal.mp4');
  ff(SRC.concat([f.normal]));
  f.mkvNeg = path.join(dir, 'priming.mkv');
  ff(SRC.concat([f.mkvNeg]));
  f.ts14 = path.join(dir, 'start1.4.ts');
  ff(SRC.concat(['-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', '1.4', '-f', 'mpegts', f.ts14]));
  var ts601 = path.join(dir, 'start601.ts');
  ff(SRC.concat(['-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', '601.4', '-f', 'mpegts', ts601]));
  f.mkv601 = path.join(dir, 'start601.mkv');
  ff(['-copyts', '-i', ts601, '-c', 'copy', f.mkv601]);
  f.mp4601 = path.join(dir, 'start601.mp4');
  ff(['-copyts', '-i', ts601, '-c', 'copy', f.mp4601]);
  return f;
}

test('span: Matroska end timestamp vs other containers', function () {
  assert.deepStrictEqual(probe.span({ format: { format_name: 'matroska,webm', start_time: '601.377', duration: '661.400' } }).duration.toFixed(3), '60.023');
  assert.deepStrictEqual(probe.span({ format: { format_name: 'matroska,webm', start_time: '-0.023', duration: '60.023' } }), { start: -0.023, duration: 60.023 });
  assert.deepStrictEqual(probe.span({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '601.376', duration: '60.024' } }), { start: 601.376, duration: 60.024 });
  assert.deepStrictEqual(probe.span({ format: { format_name: 'mpegts', start_time: 'N/A', duration: 'N/A' }, streams: [{ start_time: '2', duration: '5' }, { start_time: '1', duration: '7' }] }),
    { start: 0, duration: 8 });
  assert.deepStrictEqual(probe.span({}), { start: 0, duration: 0 });
});

test('media(): start and duration match the packets for files that do not start at 0', opts, function (t, done) {
  var dir = h.tmpDir('probe-start');
  var f = fixtures(dir);
  var names = Object.keys(f);
  var lines = [];
  (function next() {
    if (!names.length) { t.diagnostic(lines.join('; ')); done(); return; }
    var name = names.shift();
    probe.media(h.FFPROBE, f[name], function (err, info) {
      assert.ifError(err);
      var tr = truth(f[name]);
      lines.push(name + ' start ' + info.start.toFixed(3) + ' duration ' + info.duration.toFixed(3) + ' (packets ' + tr.duration.toFixed(3) + ')');
      assert.ok(info.hasVideo, name);
      assert.ok(Math.abs(info.start - tr.start) < 1e-6, name + ' start ' + info.start + ' vs ' + tr.start);
      assert.ok(Math.abs(info.duration - tr.duration) <= 0.05, name + ' duration ' + info.duration + ' vs packets ' + tr.duration);
      assert.ok(info.duration > 5.9 && info.duration < 6.2, name + ' is a 6 s file, got ' + info.duration);
      next();
    });
  }());
});
