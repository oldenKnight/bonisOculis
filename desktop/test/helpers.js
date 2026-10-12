'use strict';
// Shared helpers for desktop unit tests: temp folders, synthetic videos (ffmpeg lavfi only; never
// real movie content), and a store/library/skips stack on a temp userData folder.

var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var FFMPEG = process.env.BONIS_FFMPEG || '/usr/bin/ffmpeg';
var FFPROBE = process.env.BONIS_FFPROBE || '/usr/bin/ffprobe';
var BASE = path.join(process.env.BONIS_TEST_DIR || os.tmpdir(), 'bonis-desktop-test');

function haveFfmpeg() { return fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE); }

function tmpDir(name) {
  var d = path.join(BASE, name + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// testsrc2 colour bars, 2 s keyframe interval, sine audio. Cached per (name, seconds).
function testVideo(name, seconds) {
  fs.mkdirSync(BASE, { recursive: true });
  var file = path.join(BASE, name + '-' + seconds + 's.mp4');
  if (fs.existsSync(file)) { return file; }
  var r = childProcess.spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(seconds), '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', file + '.tmp.mp4'], { stdio: 'ignore' });
  if (r.status !== 0) { throw new Error('ffmpeg could not make the test video'); }
  fs.renameSync(file + '.tmp.mp4', file);
  return file;
}

function noopLog() { var n = function () {}; return { debug: n, info: n, warn: n, error: n, child: function () { return noopLog(); } }; }

// store + pin(hmac key) + settings + library + skips on a fresh folder.
function stack(name, opts) {
  var o = opts || {};
  var dir = o.dir || tmpDir(name);
  var store = require('../main/store.js').createStore({ dir: dir });
  var pin = require('../main/pin.js').createPin({ store: store });
  pin.load();
  var settings = require('../main/settings.js').createSettings({ store: store });
  settings.load('en-US');
  if (o.settings) { settings.set(o.settings, false); }
  var library = require('../main/library.js').createLibrary({ store: store, ffprobe: function () { return FFPROBE; } });
  library.load();
  var skips = require('../main/skips.js').createSkips({ store: store, library: library });
  var paths = require('../main/paths.js').createPaths({ isPackaged: false, userData: dir, env: { BONIS_FFMPEG: FFMPEG, BONIS_FFPROBE: FFPROBE } });
  return { dir: dir, store: store, pin: pin, settings: settings, library: library, skips: skips, paths: paths };
}

function fakeAnalyzer(extra) {
  return { cmd: process.execPath, args: [path.join(__dirname, '..', '..', 'tools', 'fake-analyzer.js')].concat(extra || []) };
}

function addVideo(s, file, cb) {
  s.library.add([file], function (err, res) {
    if (err || !res.added.length) { cb(err || new Error('not added: ' + JSON.stringify(res))); return; }
    cb(null, res.added[0]);
  });
}

module.exports = { FFMPEG: FFMPEG, FFPROBE: FFPROBE, haveFfmpeg: haveFfmpeg, tmpDir: tmpDir, testVideo: testVideo, stack: stack, fakeAnalyzer: fakeAnalyzer, addVideo: addVideo, noopLog: noopLog };
