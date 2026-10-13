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

var opts = { skip: h.available() ? false : 'mpv or ffmpeg not installed', timeout: 30000 };

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
  }, Promise.resolve());
}

// Bounded polling of an mpv property until pred(value) holds.
function pollProp(rec, name, pred, ms, label) {
  var deadline = Date.now() + (ms || 5000);
  function once() {
    return rec.cmd(['get_property', name]).then(function (v) { return v; }, function () { return undefined; })
      .then(function (v) {
        if (pred(v)) { return v; }
        if (Date.now() > deadline) { throw new Error('timeout waiting for ' + (label || name) + ' (last ' + JSON.stringify(v) + ')'); }
        return h.delay(40).then(once);
      });
  }
  return once();
}

// Input barrier: mpv handles injected keys in order, so once a later key's effect (9 = volume -2,
// then 0 = volume +2) is visible, every key sent before it has been handled. No fixed sleeps.
function keyBarrier(rec) {
  var v;
  return rec.cmd(['get_property', 'volume'])
    .then(function (x) { v = x; return rec.cmd(['keypress', '9']); })
    .then(function () { return pollProp(rec, 'volume', function (x) { return x === v - 2; }, 8000, 'barrier key 9'); })
    .then(function () { return rec.cmd(['keypress', '0']); })
    .then(function () { return pollProp(rec, 'volume', function (x) { return x === v; }, 8000, 'barrier key 0'); });
}

function assertUnchanged(rec, keys, label) {
  var before;
  var shotsBefore = shotFiles();
  var pid = rec.player.status().pid;
  return snapshot(rec)
    .then(function (s) { before = s; return pressAll(rec, keys); })
    .then(function () { return keyBarrier(rec); })
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
  var rec = h.startRecorder({ speed: 4, extraArgs: ['--pause'] });
  var skip = h.writeSkip('lockdown', h.standardRanges());
  return rec.play(h.ensureVideo(), skip, { kidMode: true, resumeAt: 22 })
    // paused from the start: time-pos changes once, so poll it rather than wait for samples
    .then(function () { return pollProp(rec, 'time-pos', function (v) { return v >= 21.9 && v < 25; }, 10000, 'paused at 22'); })
    .then(function () { return rec.waitFor(function (r) { return r.state.bonis && r.state.bonis.black; }, 10000, 'hidden'); })
    .then(function () {
      // bundled scripts are not loaded: no console, no stats, no OSC
      return Promise.all(['console', 'stats', 'osc'].map(function (name) {
        return rejected(rec, ['script-message-to', name, 'type', 'set speed 4']);
      }));
    })
    .then(function (results) { assert.deepStrictEqual(results, [true, true, true], 'console/stats/osc not loaded'); })
    .then(function () { return assertUnchanged(rec, KID_JUNK, 'hide range'); })
    .then(function () { return rec.cmd(['keypress', 'p']); })
    .then(function () { return rec.waitFor(function (r) { return r.state.bonis && r.state.bonis.panic; }, 8000, 'panic'); })
    .then(function () { return assertUnchanged(rec, KID_JUNK, 'panic cover'); })
    .then(function () { return rec.cmd(['keypress', 'p']); })
    .then(function () { return rec.waitEvent('panic', 8000, function (m) { return m.phase === 'end'; }); })
    .then(finish(rec)[0], finish(rec)[1]);
});

test('screenshot commands sent over IPC during a hide range write nothing', opts, function () {
  var rec = h.startRecorder({ speed: 4, extraArgs: ['--pause'] });
  var skip = h.writeSkip('shots', h.standardRanges());
  var before = shotFiles();
  return rec.play(h.ensureVideo(), skip, { resumeAt: 22 })
    .then(function () { return rec.waitFor(function (r) { return r.state.bonis && r.state.bonis.black; }, 8000, 'hidden'); })
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
  var rec = h.startRecorder({ speed: 4, extraArgs: ['--pause'] });
  var skip = h.writeSkip('parentkeys', h.standardRanges());
  var vol;
  // press a key, then wait (bounded) until the property shows its effect
  function key(k, name, expected, label) {
    return function () {
      return rec.cmd(['keypress', k]).then(function () {
        return pollProp(rec, name, function (v) { return v === expected; }, 8000, label);
      });
    };
  }
  function bonisState(pred, label) {
    return function () { return rec.waitFor(function (r) { return r.state.bonis && pred(r.state.bonis); }, 8000, label); };
  }
  return rec.play(h.ensureVideo(), skip, { resumeAt: 2 })
    .then(function () { return rec.waitEvent('ready', 8000); })
    .then(function () { return rec.waitFor(function (r) { return r.osd.length > 0; }, 8000, 'start hint'); })
    .then(function () {
      assert.ok(rec.osd.indexOf('Press P to hide the picture at once') >= 0, 'start hint: ' + rec.osd.join(' | '));
      return pollProp(rec, 'pause', function (v) { return v === true; }, 8000, 'starts paused');
    })
    .then(key('SPACE', 'pause', false, 'SPACE resumes'))
    .then(key('SPACE', 'pause', true, 'SPACE pauses'))
    .then(function () { return rec.cmd(['get_property', 'volume']); })
    .then(function (v) { vol = v; return key('9', 'volume', vol - 2, '9 lowers the volume')(); })
    .then(function () { return key('0', 'volume', vol, '0 raises the volume')(); })
    .then(key('f', 'fullscreen', true, 'f enters fullscreen'))
    .then(key('ESC', 'fullscreen', false, 'ESC leaves fullscreen'))
    .then(function () { return keyBarrier(rec); })
    .then(function () {
      assert.strictEqual(rec.eventsOf('ended').length, 0, 'ESC in fullscreen does not quit');
      return rec.cmd(['seek', 21, 'absolute+exact']);
    })
    .then(bonisState(function (b) { return b.black && b.mute; }, 'hide range entered'))
    .then(function () { return rec.cmd(['keypress', 'm']); })
    .then(function () { return rec.waitFor(function (r) { return /Sound stays off/.test(r.osd[r.osd.length - 1] || ''); }, 8000, 'm explained'); })
    .then(function () { return rec.cmd(['get_property', 'mute']); })
    .then(function (v) {
      assert.strictEqual(v, true, 'the range keeps the sound off');
      return rec.cmd(['seek', 27, 'absolute+exact']);
    })
    .then(bonisState(function (b) { return !b.black && !b.mute; }, 'hide range released'))
    .then(function () { return rec.cmd(['get_property', 'mute']); })
    .then(function (v) { assert.strictEqual(v, true, 'the parent chose mute inside the range; kept after it'); })
    .then(key('m', 'mute', false, 'm toggles normally outside ranges'))
    .then(function () { return rec.cmd(['keypress', 'q']).catch(function () {}); })
    .then(function () { return rec.waitEvent('ended', 8000, function (e) { return e.reason === 'closed'; }); })
    .then(finish(rec)[0], finish(rec)[1]);
});

test('the panic hint is shown at start and again after every automatic skip (localised)', opts, function () {
  var rec = h.startRecorder({ speed: 4 });
  var skip = h.writeSkip('hint', h.standardRanges());
  return rec.play(h.ensureVideo(), skip, { lang: 'es', resumeAt: 7 })
    .then(function () { return rec.waitTime(16, 10000); })
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
  var rec = h.startRecorder({ speed: 4 });
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
    // the script handles the message before the barrier keys, which reach it later
    .then(function () { return keyBarrier(rec); })
    .then(function () { return rec.cmd(['get_property', 'user-data/bonis/kid']); })
    .then(function (kid) {
      assert.strictEqual(kid, true, 'set-kidmode 0 is ignored');
      return rec.cmd(['keypress', 'q']).then(function () { return keyBarrier(rec); });
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

// Board review 3, NEW-3: during the 1.5 s between a kid-mode refusal and mpv quitting, the cover
// and mute hold and every key is dead.
// firstFrame: earliest time-pos of a real frame of this file (mpv reports a placeholder 0 before
// the file opens, while the script's pre-file state is still uncovered).
function refusalWindow(file, skip, firstFrame) {
  var rec = h.startRecorder({ speed: 4 });
  var keys = ['SPACE', 'RIGHT', 'RIGHT', 'Shift+RIGHT', 'PGUP', 'UP', 'f', 'm', '0', 'p', 'ENTER'];
  var delivered = 0;
  function inject() {
    return keys.reduce(function (p, k) {
      return p.then(function () { return rec.cmd(['keypress', k]).then(function () { delivered += 1; }, function () {}); });
    }, Promise.resolve()).then(function () { return rec.cmd(['set_property', 'pause', false]).catch(function () {}); });
  }
  return rec.play(file, skip, { kidMode: true })
    .catch(function () { /* exited before IPC */ })
    // inject only once the refusal has started (the player reports why); keys before it are
    // ordinary kid-mode keys (a panic press then is legitimate)
    .then(function () {
      return rec.waitEvent('error', 10000, function (e) {
        return e.source === 'player' && (e.code === 'kid-refused' || e.code === 'timeline');
      });
    })
    .then(inject)
    .then(function () { return rec.waitEvent('error', 10000, function (e) { return e.exitCode === 3; }); })
    .then(function () {
      var firstCover = -1;
      rec.transitions.forEach(function (tr, i) { if (firstCover < 0 && tr.black) { firstCover = i; } });
      assert.ok(firstCover >= 0, 'covered');
      var after = rec.transitions.slice(firstCover);
      var released = after.filter(function (tr) { return !tr.black || !tr.mute; });
      assert.strictEqual(released.length, 0, 'cover or mute released before quit: ' + JSON.stringify(released));
      assert.ok(delivered > 0, 'keys reached mpv during the refusal window');
      var shown = rec.samples.filter(function (sm) { return !sm.black && sm.t >= firstFrame - 0.5; });
      assert.strictEqual(shown.length, 0, 'uncovered frames reported: ' + shown.map(function (sm) { return sm.t; }).join(','));
      assert.strictEqual(rec.eventsOf('panic').length, 0, 'keys are dead');
    });
}

test('kid-mode refusal of a corrupt skip file: covered and muted until mpv quits, keys dead', opts, function () {
  return refusalWindow(h.ensureVideo(), h.writeRaw('refuse-corrupt', '{"format":'), 0);
});

test('kid-mode refusal on a timeline mismatch: covered and muted until mpv quits, keys dead', opts, function () {
  var fx = h.ensureTimelineFixtures()[0];
  return refusalWindow(fx.file, h.writeSkip('refuse-timeline', [h.range('rrefuse01', 10, 15, 'skip')]), fx.start);
});
