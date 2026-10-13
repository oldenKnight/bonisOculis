'use strict';
// Runs inside `xvfb-run` (spawned by overlay-x11.test.js): plays the colour bars in a real X11
// window, paused inside a hide range and then after it, captures the screen with ffmpeg x11grab
// and prints {"vo":..., "during":<mean luma>, "after":<mean luma>} as one JSON line.

var childProcess = require('child_process');
var h = require('./harness.js');
var controller = require('../../desktop/main/player-controller.js');

var W = 320;
var H = 180;

function grab() {
  var out = childProcess.spawnSync(h.FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', W + 'x' + H,
    '-i', process.env.DISPLAY, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'
  ], { maxBuffer: 4 * W * H, timeout: 5000 });
  if (out.status !== 0 || !out.stdout || out.stdout.length !== W * H) {
    throw new Error('x11grab failed: ' + String(out.stderr || out.error));
  }
  var sum = 0;
  var i;
  for (i = 0; i < out.stdout.length; i++) { sum += out.stdout[i]; }
  return sum / out.stdout.length;
}

function attempt(vo) {
  var player = controller.createPlayer({
    mpvPath: h.MPV, vo: vo, ao: 'null', observe: ['user-data/bonis'],
    extraArgs: ['--really-quiet', '--pause', '--geometry=' + W + 'x' + H]
  });
  var state = { t: null, bonis: null };
  var waiters = [];
  player.on('property', function (p) {
    if (p.name === 'time-pos') { state.t = p.data; }
    if (p.name === 'user-data/bonis') { state.bonis = p.data; }
    waiters = waiters.filter(function (w) {
      if (w.pred()) { clearTimeout(w.timer); w.resolve(); return false; }
      return true;
    });
  });
  function waitFor(pred, ms, label) {
    return new Promise(function (resolve, reject) {
      if (pred()) { resolve(); return; }
      var w = { pred: pred, resolve: resolve };
      w.timer = setTimeout(function () { reject(new Error('timeout: ' + label)); }, ms);
      waiters.push(w);
    });
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var result = { vo: vo };
  var skip = h.writeSkip('x11', h.standardRanges());
  return new Promise(function (resolve, reject) {
    player.play(h.ensureVideo(), skip, { resumeAt: 22 }, function (err) { if (err) { reject(err); } else { resolve(); } });
  })
    .then(function () {
      return waitFor(function () { return state.t !== null && state.t >= 21.9 && state.bonis && state.bonis.black; }, 4000, 'hidden at 22');
    })
    .then(function () { return delay(600); })
    .then(function () {
      result.during = grab();
      return new Promise(function (resolve) { player.command(['seek', 27, 'absolute+exact'], function () { resolve(); }); });
    })
    .then(function () {
      return waitFor(function () { return state.t >= 26.9 && state.bonis && !state.bonis.black; }, 4000, 'shown at 27');
    })
    .then(function () { return delay(600); })
    .then(function () { result.after = grab(); })
    .then(function () {
      return new Promise(function (resolve) { player.stop(function () { resolve(result); }); });
    }, function (err) {
      return new Promise(function (resolve, reject) { player.stop(function () { reject(err); }); });
    });
}

attempt('x11')
  .catch(function (err) {
    process.stderr.write('vo=x11 failed (' + err.message + '); trying vo=gpu\n');
    return attempt('gpu');
  })
  .then(function (result) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }, function (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
    process.exitCode = 1;
  });
