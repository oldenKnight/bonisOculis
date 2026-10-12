'use strict';
// On-screen check of the hide overlay: real mpv window under Xvfb, captured with ffmpeg x11grab.
// Skipped cleanly when xvfb-run or the x11grab input device is not available.

var test = require('node:test');
var assert = require('node:assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var h = require('./harness.js');

function findXvfbRun() {
  var dirs = (process.env.PATH || '').split(path.delimiter);
  var i;
  for (i = 0; i < dirs.length; i++) {
    if (dirs[i] && fs.existsSync(path.join(dirs[i], 'xvfb-run'))) { return path.join(dirs[i], 'xvfb-run'); }
  }
  return null;
}

function hasX11grab() {
  if (!fs.existsSync(h.FFMPEG)) { return false; }
  var out = childProcess.spawnSync(h.FFMPEG, ['-hide_banner', '-devices'], { encoding: 'utf8', timeout: 5000 });
  return / x11grab /.test(String(out.stdout));
}

var xvfbRun = findXvfbRun();
var reason = !h.available() ? 'mpv or ffmpeg not installed' :
  !xvfbRun ? 'xvfb-run not installed' :
  !hasX11grab() ? 'ffmpeg has no x11grab' : false;

test('hide overlay is black on screen during the range and the picture is back after it', { skip: reason, timeout: 20000 }, function () {
  h.ensureVideo();
  return new Promise(function (resolve, reject) {
    var child = childProcess.spawn(xvfbRun, [
      '-a', '-s', '-screen 0 320x180x24', process.execPath, path.join(__dirname, 'x11-probe.js')
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    var out = '';
    var err = '';
    var timer = setTimeout(function () { child.kill('SIGKILL'); }, 18000);
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { err += d; });
    child.on('error', function (e) { clearTimeout(timer); reject(e); });
    child.on('close', function () {
      clearTimeout(timer);
      var line = out.trim().split('\n').pop();
      var result;
      try { result = JSON.parse(line); } catch (e) { reject(new Error('no probe result: ' + out + err)); return; }
      resolve(result);
    });
  }).then(function (r) {
    assert.ok(!r.error, 'probe failed: ' + r.error);
    assert.ok(r.during < 8, 'mean luminance during hide (vo=' + r.vo + '): ' + r.during);
    assert.ok(r.after > 40, 'mean luminance after hide (vo=' + r.vo + '): ' + r.after);
  });
});
