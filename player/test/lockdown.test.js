'use strict';
// The player is locked down: mpv runs with --input-default-bindings=no and no bundled scripts, so
// only the keys bonis.lua binds do anything. Junk keys are injected over IPC (as a child pressing
// keys in the window would) inside a hide range and inside a panic cover, and nothing may change:
// no screenshot file, no console, no speed/filter/track/zoom/colour change, no seek, no quit.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var h = require('./harness.js');

var opts = { skip: h.available() ? false : 'mpv or ffmpeg not installed', timeout: 20000 };

var PROPS = ['speed', 'vf', 'af', 'sid', 'aid', 'vid', 'video-zoom', 'video-pan-x', 'video-pan-y',
  'contrast', 'brightness', 'gamma', 'saturation', 'sub-delay', 'audio-delay', 'sub-pos',
  'sub-visibility', 'secondary-sub-visibility', 'sub-scale', 'sub-ass-override', 'panscan',
  'video-aspect-override', 'ontop', 'loop-file', 'ab-loop-a', 'ab-loop-b', 'osd-level', 'deinterlace',
  'hwdec', 'edition', 'volume', 'mute', 'pause', 'fullscreen', 'time-pos', 'playlist-pos',
  'window-scale', 'user-data/bonis/black', 'user-data/bonis/mute', 'user-data/bonis/panic'];

// Every default mpv key that is not part of the bonis key set (see player/README.md).
var JUNK = ['s', 'S', 'Ctrl+s', 'Alt+s', '`', 'SHARP', '_', 'T', 'O', 'P', 'v', 'V', 'Alt+v', 'j', 'J',
  'z', 'Z', 'x', '[', ']', '{', '}', 'BS', '<', '>', 'l', 'L', 'A', 'C', 'r', 'R', 't', 'I', 'D', 'd',
  'e', 'E', 'w', 'W', 'F', 'G', '1', '2', '3', '4', '5', '6', '7', '8', 'Alt+0', 'Alt+1', 'Alt+2',
  'Alt+LEFT', 'Alt+RIGHT', 'Alt+UP', 'Alt+DOWN', 'Alt++', 'Alt+-', 'Alt+BS', 'Ctrl+LEFT', 'Ctrl+RIGHT',
  'Shift+Ctrl+LEFT', 'Shift+Ctrl+RIGHT', 'Ctrl++', 'Ctrl+-', 'Ctrl+h', 'Ctrl+w', 'Ctrl+c', 'Q',
  'Shift+BS', 'Shift+Ctrl+BS', '.', ',', '!', '@', '/', '*', 'DEL', 'F8', 'F9', 'MBTN_RIGHT',
  'MBTN_BACK', 'MBTN_FORWARD', 'WHEEL_UP', 'WHEEL_DOWN', 'WHEEL_LEFT', 'WHEEL_RIGHT', 'POWER', 'STOP',
  'PLAY', 'PAUSE', 'PLAYPAUSE', 'PLAYONLY', 'NEXT', 'PREV', 'FORWARD', 'REWIND', 'VOLUME_UP',
  'VOLUME_DOWN', 'MUTE', 'ZOOMIN', 'ZOOMOUT', 'a', 'b', 'c', 'g', 'h', 'k', 'n', 'y'];
// In kid mode these do nothing either (quit, close, marks); ESC only leaves fullscreen.
var KID_JUNK = JUNK.concat(['q', 'ESC', 'CLOSE_WIN', 'i', 'o', 'u']);

function shotFiles() {
  var dirs = [process.cwd(), os.tmpdir(), h.SCRATCH, path.dirname(h.MPV)];
  var found = [];
  dirs.forEach(function (d) {
    var names = [];
    try { names = fs.readdirSync(d); } catch (e) { names = []; }
    names.forEach(function (n) { if (/^mpv-shot/.test(n)) { found.push(path.join(d, n)); } });
  });
  return found.sort();
}

function snapshot(rec) {
  var out = {};
  return PROPS.reduce(function (p, name) {
    return p.then(function () {
      return rec.cmd(['get_property', name]).then(function (v) { out[name] = v; }, function (e) { out[name] = 'ERR ' + e.message; });
    });
  }, Promise.resolve()).then(function () { return out; });
}

function pressAll(rec, keys) {
  return keys.reduce(function (p, key) {
    return p.then(function () { return rec.cmd(['keypress', key]).catch(function () { /* unknown key name */ }); });
  }, Promise.resolve()).then(function () { return h.delay(400); });
}

function assertUnchanged(rec, keys, label) {
  var before;
  var shotsBefore = shotFiles();
  var pid = rec.player.status().pid;
  return snapshot(rec)
    .then(function (s) { before = s; return pressAll(rec, keys); })
    .then(function () { return snapshot(rec); })
    .then(function (after) {
      assert.deepStrictEqual(after, before, label + ': a junk key changed a property');
      assert.deepStrictEqual(shotFiles(), shotsBefore, label + ': a screenshot file appeared');
      assert.strictEqual(rec.player.status().pid, pid, label + ': mpv quit or restarted');
      assert.strictEqual(rec.eventsOf('ended').length, 0, label + ': playback ended');
      assert.strictEqual(rec.eventsOf('mark').length, 0, label + ': a mark was made');
    });
}

function rejected(rec, args) {
  return rec.cmd(args).then(function () { return false; }, function () { return true; });
}

function finish(rec) {
  return [rec.stop, function (err) { return rec.stop().then(function () { throw err; }); }];
}

test('kid mode: only the bonis keys work, inside a hide range and inside a panic cover', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('lockdown', h.standardRanges());
  return rec.play(h.ensureVideo(), skip, { kidMode: true, resumeAt: 21 })
    .then(function () { return rec.waitFor(function (r) { return r.state.bonis && r.state.bonis.black; }, 3000, 'hidden'); })
    .then(function () { return rec.cmd(['set_property', 'pause', true]); })
    .then(function () { return h.delay(200); })
    .then(function () {
      // bundled scripts are not loaded: no console, no stats, no OSC
      return Promise.all(['console', 'stats', 'osc'].map(function (name) {
        return rejected(rec, ['script-message-to', name, 'type', 'set speed 4']);
      }));
    })
    .then(function (results) { assert.deepStrictEqual(results, [true, true, true], 'console/stats/osc not loaded'); })
    .then(function () { return assertUnchanged(rec, KID_JUNK, 'hide range'); })
    .then(function () { return rec.cmd(['keypress', 'p']); })
    .then(function () { return rec.waitFor(function (r) { return r.state.bonis && r.state.bonis.panic; }, 3000, 'panic'); })
    .then(function () { return assertUnchanged(rec, KID_JUNK, 'panic cover'); })
    .then(function () { return rec.cmd(['keypress', 'p']); })
    .then(function () { return rec.waitEvent('panic', 3000, function (m) { return m.phase === 'end'; }); })
    .then(finish(rec)[0], finish(rec)[1]);
});

test('screenshot commands sent over IPC during a hide range write nothing', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('shots', h.standardRanges());
  var before = shotFiles();
  return rec.play(h.ensureVideo(), skip, { resumeAt: 21 })
    .then(function () { return rec.waitFor(function (r) { return r.state.bonis && r.state.bonis.black; }, 3000, 'hidden'); })
    .then(function () { return rec.cmd(['set_property', 'pause', true]); })
    .then(function () {
      return Promise.all([['screenshot'], ['screenshot', 'video'], ['screenshot', 'window'],
        ['screenshot', 'subtitles']].map(function (args) { return rejected(rec, args); }));
    })
    .then(function (results) {
      assert.deepStrictEqual(results, [true, true, true, true], 'every screenshot command fails');
      assert.deepStrictEqual(shotFiles(), before, 'no screenshot file anywhere');
    })
    .then(finish(rec)[0], finish(rec)[1]);
});

test('parent keys: SPACE, 9/0, f/ESC, m (range mute wins and the choice is kept), q quits', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('parentkeys', h.standardRanges());
  var vol;
  function prop(name) { return rec.cmd(['get_property', name]); }
  function key(k) { return function () { return rec.cmd(['keypress', k]).then(function () { return h.delay(150); }); }; }
  return rec.play(h.ensureVideo(), skip, { resumeAt: 2 })
    .then(function () { return rec.waitEvent('ready', 3000); })
    .then(function () { return rec.waitFor(function (r) { return r.osd.length > 0; }, 3000, 'start hint'); })
    .then(function () {
      assert.ok(rec.osd.indexOf('Press P to hide the picture at once') >= 0, 'start hint: ' + rec.osd.join(' | '));
      return rec.cmd(['set_property', 'pause', true]);
    })
    .then(key('SPACE')).then(function () { return prop('pause'); })
    .then(function (v) { assert.strictEqual(v, false, 'SPACE resumes'); })
    .then(key('SPACE')).then(function () { return prop('pause'); })
    .then(function (v) { assert.strictEqual(v, true, 'SPACE pauses'); return prop('volume'); })
    .then(function (v) { vol = v; })
    .then(key('9')).then(function () { return prop('volume'); })
    .then(function (v) { assert.strictEqual(v, vol - 2, '9 lowers the volume'); })
    .then(key('0')).then(function () { return prop('volume'); })
    .then(function (v) { assert.strictEqual(v, vol, '0 raises the volume'); })
    .then(key('f')).then(function () { return prop('fullscreen'); })
    .then(function (v) { assert.strictEqual(v, true, 'f enters fullscreen'); })
    .then(key('ESC')).then(function () { return prop('fullscreen'); })
    .then(function (v) {
      assert.strictEqual(v, false, 'ESC leaves fullscreen');
      assert.strictEqual(rec.eventsOf('ended').length, 0, 'ESC in fullscreen does not quit');
      return rec.cmd(['seek', 21, 'absolute+exact']);
    })
    .then(function () { return h.delay(300); })
    .then(key('m')).then(function () { return prop('mute'); })
    .then(function (v) {
      assert.strictEqual(v, true, 'the range keeps the sound off');
      assert.ok(/Sound stays off/.test(rec.osd[rec.osd.length - 1]), 'm explains: ' + rec.osd[rec.osd.length - 1]);
      return rec.cmd(['seek', 27, 'absolute+exact']);
    })
    .then(function () { return h.delay(300); })
    .then(function () { return prop('mute'); })
    .then(function (v) { assert.strictEqual(v, true, 'the parent chose mute inside the range; kept after it'); })
    .then(key('m')).then(function () { return prop('mute'); })
    .then(function (v) { assert.strictEqual(v, false, 'm toggles normally outside ranges'); })
    .then(function () { return rec.cmd(['keypress', 'q']).catch(function () {}); })
    .then(function () { return rec.waitEvent('ended', 3000, function (e) { return e.reason === 'closed'; }); })
    .then(finish(rec)[0], finish(rec)[1]);
});

test('the panic hint is shown at start and again after every automatic skip (localised)', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('hint', h.standardRanges());
  return rec.play(h.ensureVideo(), skip, { lang: 'es', resumeAt: 7 })
    .then(function () { return rec.waitTime(16); })
    .then(function () {
      assert.strictEqual(rec.osd[0], 'Presiona P para ocultar la imagen');
      assert.ok(rec.osd.indexOf('Escena omitida\nPresiona P para ocultar la imagen') >= 0, rec.osd.join(' | '));
    })
    .then(finish(rec)[0], finish(rec)[1]);
});

function watchLaterFiles() {
  var home = os.homedir();
  var dirs = [path.join(home, '.local', 'state', 'mpv', 'watch_later'), path.join(home, '.config', 'mpv', 'watch_later'),
    path.join(home, '.mpv', 'watch_later'), path.join(path.dirname(h.MPV), 'watch_later'), path.join(process.cwd(), 'watch_later')];
  if (process.env.XDG_STATE_HOME) { dirs.push(path.join(process.env.XDG_STATE_HOME, 'mpv', 'watch_later')); }
  if (process.env.APPDATA) { dirs.push(path.join(process.env.APPDATA, 'mpv', 'watch_later')); }
  var found = [];
  dirs.forEach(function (d) {
    var names = [];
    try { names = fs.readdirSync(d); } catch (e) { names = []; }
    names.forEach(function (n) {
      var st = fs.statSync(path.join(d, n));
      found.push(path.join(d, n) + '@' + st.mtimeMs);
    });
  });
  return found.sort();
}

test('no resume (watch-later) file can be written, and kid mode cannot be switched off', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('watchlater', h.standardRanges());
  var before = watchLaterFiles();
  var pid;
  return rec.play(h.ensureVideo(), skip, { kidMode: true, resumeAt: 2 })
    .then(function () { return rec.waitTime(3); })
    .then(function () {
      pid = rec.player.status().pid;
      return rec.cmd(['write-watch-later-config']).catch(function () { /* refused is fine too */ });
    })
    .then(function () { return rec.cmd(['script-message-to', 'bonis', 'set-kidmode', '0']); })
    .then(function () { return h.delay(200); })
    .then(function () { return rec.cmd(['get_property', 'user-data/bonis/kid']); })
    .then(function (kid) {
      assert.strictEqual(kid, true, 'set-kidmode 0 is ignored');
      return rec.cmd(['keypress', 'q']).then(function () { return h.delay(300); });
    })
    .then(function () {
      assert.strictEqual(rec.player.status().pid, pid, 'q still does nothing in kid mode');
      assert.strictEqual(rec.eventsOf('ended').length, 0);
      return rec.stop();
    })
    .then(function () {
      assert.deepStrictEqual(watchLaterFiles(), before, 'no watch-later file written or changed');
    }, function (err) { return rec.stop().then(function () { throw err; }); });
});
