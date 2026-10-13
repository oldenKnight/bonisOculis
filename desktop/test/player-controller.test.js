'use strict';
// desktop/main/player-controller.js against real mpv (--vo=null --ao=null --speed=10), plus the
// argument builder and desktop/main/log.js rotation. Synthetic media from player/test/harness.js.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var h = require('../../player/test/harness.js');
var controller = require('../main/player-controller.js');
var logModule = require('../main/log.js');

var skipAll = !h.available();
var opts = { skip: skipAll ? 'mpv or ffmpeg not installed' : false, timeout: 20000 };
var video = null;

function getVideo() {
  if (!video) { video = h.ensureVideo(); }
  return video;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function finish(rec) {
  return [rec.stop, function (err) { return rec.stop().then(function () { throw err; }); }];
}

test('buildArgs follows PLAN 2.2 and only asks for copy-back decoding with blur ranges', function () {
  h.ensureVideo();
  var plain = h.writeSkip('args-plain', [h.range('rargs0001', 1, 2, 'skip')]);
  var blur = h.writeSkip('args-blur', [h.range('rargs0002', 1, 2, 'blur')]);
  var rejectedBlur = h.writeSkip('args-rblur', [h.range('rargs0003', 1, 2, 'blur', { review: 'rejected' })]);
  var o = { scriptPath: '/x/bonis.lua', vo: 'null', ao: 'null' };
  function args(skip, options, resumeAt) {
    return controller.buildArgs(o, {
      media: '/movies/-odd, name.mkv', skipfile: skip, marksPath: '/m/a,b.marks.jsonl', options: options || {}
    }, '/tmp/sock', resumeAt);
  }
  var a = args(plain, { kidMode: true, lang: 'es-MX' }, 12.5);
  assert.ok(a.indexOf('--input-ipc-server=/tmp/sock') >= 0);
  assert.ok(a.indexOf('--script=/x/bonis.lua') >= 0);
  assert.ok(a.indexOf('--script-opts-append=bonis-skipfile=' + plain) >= 0);
  assert.ok(a.indexOf('--script-opts-append=bonis-marks=/m/a,b.marks.jsonl') >= 0, 'commas survive');
  assert.ok(a.indexOf('--script-opts-append=bonis-kidmode=1') >= 0);
  assert.ok(a.indexOf('--script-opts-append=bonis-lang=es') >= 0);
  assert.ok(a.indexOf('--hwdec=auto-safe') >= 0);
  ['--input-default-bindings=no', '--input-conf=/x/input.conf', '--no-input-terminal', '--osc=no',
    '--load-scripts=no', '--load-osd-console=no', '--load-stats-overlay=no', '--load-auto-profiles=no',
    '--ytdl=no', '--screenshot-directory=' + path.join('/x/input.conf', 'no-screenshots'),
    '--watch-later-dir=' + path.join('/x/input.conf', 'no-watch-later'),
    '--write-filename-in-watch-later-config=no', '--no-save-position-on-quit', '--no-resume-playback',
    '--keep-open=yes', '--force-window=yes', '--osd-level=1', '--no-config',
    '--title=bonis oculis', '--vo=null', '--ao=null', '--script-opts-append=bonis-resume=12.500'].forEach(function (flag) {
    assert.ok(a.indexOf(flag) >= 0, flag);
  });
  assert.deepStrictEqual(a.slice(-2), ['--', '/movies/-odd, name.mkv']);
  assert.ok(args(blur).indexOf('--hwdec=auto-copy') >= 0);
  assert.ok(args(rejectedBlur).indexOf('--hwdec=auto-safe') >= 0);
  assert.ok(args('').indexOf('--hwdec=auto-safe') >= 0);
  assert.ok(args(plain, { lang: 'en' }).indexOf('--script-opts-append=bonis-kidmode=0') >= 0);
  assert.ok(args(plain).join(' ').indexOf('bonis-resume') < 0, 'no resume unless asked');
  assert.ok(a.join(' ').indexOf('--start') < 0, 'mpv --start is never used (it is on mpv\'s clock)');
  assert.ok(a.join(' ').indexOf('bonis-start=') < 0, 'no start time unless the probe gave one');
  assert.ok(args(plain, { startTime: 601.378 }).indexOf('--script-opts-append=bonis-start=601.378000') >= 0);
  assert.ok(a.indexOf('--save-position-on-quit') < 0, 'never saves a resume file');
});

test('play reports ready and throttled timepos; stop quits mpv gracefully', opts, function () {
  var rec = h.startRecorder({ timeposHz: 4 });
  var skip = h.writeSkip('stop', h.standardRanges());
  var pid;
  var t0;
  var ipcDir = null;
  return rec.play(getVideo(), skip, { marksPath: h.uniqueName('stop') + '.marks.jsonl' })
    .then(function () { return rec.waitEvent('ready', 3000); })
    .then(function () {
      pid = rec.player.status().pid;
      assert.ok(pid > 0);
      if (process.platform !== 'win32') {
        ipcDir = path.dirname(rec.player.status().ipcPath);
        assert.strictEqual(fs.statSync(ipcDir).mode & 511, 448, 'IPC socket directory is private (0700)');
      }
      assert.strictEqual(rec.eventsOf('ready')[0].enforced, 4);
      t0 = Date.now();
      return h.delay(1000);
    })
    .then(function () {
      var tp = rec.events.filter(function (e) { return e.name === 'timepos' && e.at >= t0; });
      assert.ok(tp.length >= 2 && tp.length <= 5, 'about 4 timepos events per second, got ' + tp.length);
      var st = rec.player.status();
      assert.strictEqual(st.state, 'playing');
      assert.ok(st.timePos > 0);
      return rec.stop();
    })
    .then(function () {
      var ended = rec.eventsOf('ended');
      assert.strictEqual(ended[ended.length - 1].reason, 'stopped');
      assert.strictEqual(rec.player.status().state, 'idle');
      assert.strictEqual(rec.player.status().pid, null);
      assert.strictEqual(alive(pid), false, 'mpv process is gone');
      if (ipcDir) { assert.strictEqual(fs.existsSync(ipcDir), false, 'IPC socket directory removed'); }
      assert.strictEqual(rec.eventsOf('crashed').length, 0);
    });
});

test('a crash relaunches exactly once at the last position; a second crash within 60 s stops', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('crash', []);
  var firstPid;
  var secondPid;
  var killedAt;
  var mark;
  return rec.play(getVideo(), skip, {})
    .then(function () { return rec.waitTime(20); })
    .then(function () {
      firstPid = rec.player.status().pid;
      process.kill(firstPid, 'SIGKILL');
      return rec.waitEvent('crashed', 3000);
    })
    .then(function () {
      var c = rec.eventsOf('crashed')[0];
      assert.strictEqual(c.final, false);
      assert.strictEqual(c.relaunching, true);
      killedAt = c.at;
      assert.ok(killedAt >= 20, 'last position ' + killedAt);
      mark = rec.samples.length;
      return rec.waitFor(function (r) { return r.samples.length > mark; }, 5000, 'relaunched playback');
    })
    .then(function () {
      secondPid = rec.player.status().pid;
      assert.ok(secondPid > 0 && secondPid !== firstPid, 'new process');
      var first = rec.samples[mark];
      assert.ok(first.t >= killedAt - 0.1 && first.t < killedAt + 1.5,
        'resumed at ' + first.t + ' (crashed at ' + killedAt + ')');
      assert.strictEqual(rec.player.status().relaunches, 1);
      process.kill(secondPid, 'SIGKILL');
      return rec.waitEvent('crashed', 3000, function (c) { return c.final === true; });
    })
    .then(function () { return h.delay(500); })
    .then(function () {
      var crashes = rec.eventsOf('crashed');
      assert.strictEqual(crashes.length, 2);
      assert.strictEqual(crashes[1].relaunching, false);
      var st = rec.player.status();
      assert.strictEqual(st.state, 'idle');
      assert.strictEqual(st.pid, null);
      assert.strictEqual(st.relaunches, 1, 'exactly one relaunch');
    })
    .then(finish(rec)[0], finish(rec)[1]);
});

test('closing mpv normally ends without a relaunch', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('close', []);
  return rec.play(getVideo(), skip, {})
    .then(function () { return rec.waitTime(2); })
    .then(function () { return rec.cmd(['quit']).catch(function () { /* socket closes */ }); })
    .then(function () { return rec.waitEvent('ended', 3000, function (e) { return e.reason === 'closed'; }); })
    .then(function () {
      assert.strictEqual(rec.eventsOf('crashed').length, 0);
      assert.strictEqual(rec.player.status().state, 'idle');
    });
});

test('reaching the end of the file emits ended with reason eof', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('eof', []);
  return rec.play(getVideo(), skip, { resumeAt: 55 })
    .then(function () { return rec.waitEvent('ended', 5000); })
    .then(function () {
      assert.strictEqual(rec.eventsOf('ended')[0].reason, 'eof');
      assert.strictEqual(rec.player.status().eof, true);
    })
    .then(finish(rec)[0], finish(rec)[1]);
});

test('a missing mpv binary reports an error and never throws', function () {
  var player = controller.createPlayer({ mpvPath: path.join(h.SCRATCH, 'no-such-mpv') });
  var errors = [];
  player.on('error', function (e) { errors.push(e); });
  return new Promise(function (resolve) {
    player.play('/nonexistent.mp4', null, {}, function (err) { resolve(err); });
  }).then(function (err) {
    assert.ok(err, 'callback gets an error');
    assert.strictEqual(errors[0].code, 'spawn-failed');
    assert.strictEqual(player.status().state, 'idle');
    return new Promise(function (resolve) { player.stop(resolve); });
  }).then(function () {
    player.command(['get_property', 'pause'], function (err) { assert.ok(err); });
  });
});

test('log.js writes levelled lines and rotates 5 x maxBytes', function () {
  var dir = h.uniqueName('logs');
  var log = logModule.createLog({ dir: dir, name: 'app', level: 'info', maxBytes: 2000 });
  var i;
  log.debug('hidden');
  for (i = 0; i < 200; i++) { log.info('line', i, { k: 'v' }); }
  log.child('player').error(new Error('boom'));
  var files = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(files, ['app.1.log', 'app.2.log', 'app.3.log', 'app.4.log', 'app.log']);
  files.forEach(function (f) { assert.ok(fs.statSync(path.join(dir, f)).size <= 2000, f); });
  var current = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
  assert.ok(/ERROR \[player\] Error: boom/.test(current));
  assert.ok(current.indexOf('hidden') < 0 && current.indexOf('DEBUG') < 0);
  var notADir = h.uniqueName('plainfile');
  fs.writeFileSync(notADir, 'x');
  var bad = logModule.createLog({ dir: path.join(notADir, 'sub'), name: 'x' });
  bad.error('does not throw');
});
