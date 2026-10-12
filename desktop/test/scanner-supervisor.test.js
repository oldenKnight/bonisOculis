'use strict';
// scanner-supervisor.js driven by tools/fake-analyzer.js (PLAN 2.4): progress (throttled), PAUSE
// while the player is open, crash -> restart from the checkpoint -> done, 3 restarts -> Needs
// attention, no restart on exit 2, and the queue surviving a new supervisor object.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var h = require('./helpers.js');
var createSupervisor = require('../main/scanner-supervisor.js').createSupervisor;

var opts = { skip: h.haveFfmpeg() ? false : 'ffmpeg not installed', timeout: 60000 };

function setup(name, extraArgs, settingsPatch) {
  var patch = { analyzerCommand: h.fakeAnalyzer(extraArgs), scanOnlyPluggedIn: true, pauseWhilePlaying: true };
  var k;
  for (k in (settingsPatch || {})) { patch[k] = settingsPatch[k]; }
  var s = h.stack(name, { settings: patch });
  s.events = [];
  s.spawns = [];
  s.lines = [];
  s.spawn = function (cmd, args, o) {
    var p = childProcess.spawn(cmd, args, o);
    var run = [];
    s.lines.push(run);
    s.spawns.push(args);
    p.stdout.on('data', function (d) { String(d).split('\n').forEach(function (l) { if (l.trim()) { run.push(JSON.parse(l)); } }); });
    return p;
  };
  s.make = function (extra) {
    var o = { store: s.store, library: s.library, skips: s.skips, paths: s.paths, settings: s.settings, spawn: s.spawn, restartDelayMs: 10,
      emit: function (name2, payload) { s.events.push({ name: name2, payload: payload, at: Date.now() }); } };
    var k2;
    for (k2 in (extra || {})) { o[k2] = extra[k2]; }
    return createSupervisor(o);
  };
  return s;
}

function waitFor(fn, ms, cb) {
  var start = Date.now();
  (function poll() {
    var v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) { cb(null); return; }
    if (Date.now() - start > ms) { cb(new Error('timed out')); return; }
    setTimeout(poll, 25);
  }());
}

function settled(s, id) {
  return function () { var st = s.library.get(id).status; return st !== 'queued' && st !== 'scanning'; };
}

test('a scan reports progress at most 4 times a second and lands in the library', opts, function (t, done) {
  var s = setup('sup-progress', ['--steps', '40']);
  var video = h.testVideo('sup', 8);
  h.addVideo(s, video, function (err, id) {
    assert.ifError(err);
    var sup = s.make();
    sup.load();
    sup.enqueue(id);
    assert.strictEqual(s.library.get(id).status, 'scanning');
    waitFor(settled(s, id), 30000, function (e) {
      assert.ifError(e);
      var it = s.library.get(id);
      assert.strictEqual(it.status, 'needsReview');
      assert.strictEqual(it.pending, 3);
      var args = s.spawns[0];
      ['scan', '--input', '--work', '--out', '--lang', '--levels', '--stages', '--threads', '--priority'].forEach(function (a) { assert.ok(args.indexOf(a) >= 0, a); });
      assert.strictEqual(args[args.indexOf('--input') + 1], video);
      assert.deepStrictEqual(JSON.parse(args[args.indexOf('--levels') + 1]).nudity, 'strict');
      var progressLines = s.lines[0].filter(function (m) { return m.t === 'progress'; }).length;
      var emits = s.events.filter(function (e) { return e.name === 'scan:progress'; });
      assert.strictEqual(progressLines, 7 * 40, 'seven stages (five plus lm and fusion), 40 steps each');
      assert.ok(emits.length < progressLines / 3, 'throttled: ' + emits.length + ' events for ' + progressLines + ' lines');
      var doc = s.skips.load(id).doc;
      assert.strictEqual(doc.ranges.length, 3);
      assert.strictEqual(doc.scan.status, 'complete');
      assert.ok(doc.history.some(function (x) { return x.event === 'scanned'; }), 'merged with history');
      assert.ok(fs.existsSync(path.join(s.paths.workDir(id), 'thumbs', doc.ranges[0].id + '.jpg')), 'blurred thumbnail made');
      done();
    });
  });
});

test('PAUSE exists while the player is open, and the scan finishes after it closes', opts, function (t, done) {
  var s = setup('sup-pause', ['--slow']);
  h.addVideo(s, h.testVideo('sup', 8), function (err, id) {
    assert.ifError(err);
    var sup = s.make();
    sup.load();
    sup.enqueue(id);
    var pauseFile = path.join(s.paths.workDir(id), 'PAUSE');
    waitFor(function () { return s.lines[0] && s.lines[0].length >= 2; }, 10000, function (e) {
      assert.ifError(e);
      sup.setPlayerOpen(true);
      assert.ok(fs.existsSync(pauseFile), 'PAUSE written when the player opens');
      assert.strictEqual(sup.status().pauseReason, 'player');
      waitFor(function () { return s.lines[0].some(function (m) { return m.t === 'paused'; }); }, 5000, function (e2) {
        assert.ifError(e2);
        var before = s.lines[0].filter(function (m) { return m.t === 'progress'; }).length;
        setTimeout(function () {
          var after = s.lines[0].filter(function (m) { return m.t === 'progress'; }).length;
          assert.strictEqual(after, before, 'no progress while paused');
          sup.setPlayerOpen(false);
          assert.ok(!fs.existsSync(pauseFile), 'PAUSE removed when the player closes');
          waitFor(settled(s, id), 20000, function (e3) {
            assert.ifError(e3);
            assert.ok(s.lines[0].some(function (m) { return m.t === 'resumed'; }));
            assert.strictEqual(s.library.get(id).status, 'needsReview');
            assert.strictEqual(s.spawns.length, 1);
            done();
          });
        }, 500);
      });
    });
  });
});

test('battery power pauses when "only when plugged in" is on', opts, function (t, done) {
  var s = setup('sup-battery', ['--slow']);
  var listeners = {};
  var power = { isOnBatteryPower: function () { return true; }, on: function (ev, fn) { listeners[ev] = fn; } };
  h.addVideo(s, h.testVideo('sup', 8), function (err, id) {
    assert.ifError(err);
    var sup = s.make({ power: power });
    sup.load();
    sup.enqueue(id);
    assert.strictEqual(s.spawns.length, 0, 'does not start on battery');
    assert.strictEqual(sup.status().pauseReason, 'battery');
    listeners['on-ac']();
    waitFor(function () { return s.spawns.length === 1; }, 5000, function (e) {
      assert.ifError(e);
      sup.cancel(id);
      waitFor(function () { return !sup.status().running; }, 5000, function () { done(); });
    });
  });
});

test('a crash restarts from the checkpoint and the scan completes', opts, function (t, done) {
  var s = setup('sup-crash', ['--crash-at', '0.5']);
  h.addVideo(s, h.testVideo('sup', 8), function (err, id) {
    assert.ifError(err);
    var sup = s.make();
    sup.load();
    sup.enqueue(id);
    waitFor(settled(s, id), 30000, function (e) {
      assert.ifError(e);
      assert.strictEqual(s.spawns.length, 2, 'one restart');
      var first = s.lines[0].filter(function (m) { return m.t === 'progress'; }).length;
      var second = s.lines[1].filter(function (m) { return m.t === 'progress'; }).length;
      assert.strictEqual(first + second, 7 * 10, 'the second run continued where the first stopped');
      assert.ok(s.lines[1].some(function (m) { return m.t === 'warn' && /checkpoint/.test(m.msg); }));
      assert.strictEqual(s.library.get(id).status, 'needsReview');
      done();
    });
  });
});

test('after 3 restarts the title needs attention; exit 2 is never restarted', opts, function (t, done) {
  var s = setup('sup-crash3', ['--crash-at', '0.3', '--crash-always']);
  h.addVideo(s, h.testVideo('sup', 8), function (err, id) {
    assert.ifError(err);
    var sup = s.make();
    sup.load();
    sup.enqueue(id);
    waitFor(settled(s, id), 30000, function (e) {
      assert.ifError(e);
      assert.strictEqual(s.spawns.length, 4, 'first run + 3 restarts');
      var it = s.library.get(id);
      assert.strictEqual(it.status, 'needsAttention');
      assert.strictEqual(it.error, 'scanFailed');
      assert.deepStrictEqual(sup.status().queue, []);
      assert.ok(s.events.some(function (ev) { return ev.name === 'toast' && ev.payload.key === 'toast.scanAttention'; }));
      var s2 = setup('sup-code2', ['--fail-code', '2']);
      h.addVideo(s2, h.testVideo('sup', 8), function (err2, id2) {
        assert.ifError(err2);
        var sup2 = s2.make();
        sup2.load();
        sup2.enqueue(id2);
        waitFor(settled(s2, id2), 10000, function (e2) {
          assert.ifError(e2);
          assert.strictEqual(s2.spawns.length, 1, 'bad input is not retried');
          assert.strictEqual(s2.library.get(id2).error, 'badInput');
          done();
        });
      });
    });
  });
});

test('the queue survives a new supervisor (app restart) and resumes', opts, function (t, done) {
  var s = setup('sup-persist', []);
  h.addVideo(s, h.testVideo('sup', 8), function (err, a) {
    assert.ifError(err);
    h.addVideo(s, h.testVideo('sup2', 6), function (err2, b) {
      assert.ifError(err2);
      var sup = s.make();
      sup.load();
      sup.pause();
      sup.enqueue(a);
      sup.enqueue(b);
      assert.strictEqual(s.spawns.length, 0, 'paused by the parent');
      assert.deepStrictEqual(sup.status().queue, [a, b]);
      // "Restart": a new library and supervisor over the same files.
      var library2 = require('../main/library.js').createLibrary({ store: s.store, ffprobe: function () { return h.FFPROBE; } });
      library2.load();
      var skips2 = require('../main/skips.js').createSkips({ store: s.store, library: library2 });
      s.library = library2;
      s.skips = skips2;
      var sup2 = s.make();
      sup2.load();
      assert.deepStrictEqual(sup2.status().queue, [a, b]);
      assert.strictEqual(sup2.status().pauseReason, 'user', 'the parent pause is remembered too');
      assert.strictEqual(library2.get(a).status, 'queued');
      sup2.resume();
      waitFor(function () { return library2.get(a).status === 'needsReview' && library2.get(b).status === 'needsReview'; }, 30000, function (e) {
        assert.ifError(e);
        assert.strictEqual(s.spawns.length, 2);
        assert.deepStrictEqual(sup2.status().queue, []);
        done();
      });
    });
  });
});

test('a rescan keeps the parent\'s decisions (merge)', opts, function (t, done) {
  var s = setup('sup-merge', []);
  h.addVideo(s, h.testVideo('sup', 8), function (err, id) {
    assert.ifError(err);
    var sup = s.make();
    sup.load();
    sup.enqueue(id);
    waitFor(settled(s, id), 20000, function (e) {
      assert.ifError(e);
      var doc = s.skips.load(id).doc;
      s.skips.approve(id, [doc.ranges[0].id]);
      s.skips.reject(id, [doc.ranges[1].id]);
      sup.enqueue(id);
      waitFor(settled(s, id), 20000, function (e2) {
        assert.ifError(e2);
        var after = s.skips.load(id).doc;
        var byId = {};
        after.ranges.forEach(function (r) { byId[r.id] = r; });
        assert.strictEqual(byId[doc.ranges[0].id].review, 'approved');
        assert.strictEqual(byId[doc.ranges[1].id].review, 'rejected');
        assert.strictEqual(after.ranges.filter(function (r) { return r.review === 'pending'; }).length, 1);
        done();
      });
    });
  });
});

test('all five stages by default; thorough and no-speech come from Settings > Scanning', opts, function (t, done) {
  var s = setup('sup-flags', ['--steps', '1']);
  h.addVideo(s, h.testVideo('sup', 8), function (err, id) {
    assert.ifError(err);
    var sup = s.make();
    sup.load();
    sup.enqueue(id);
    waitFor(settled(s, id), 20000, function (e) {
      assert.ifError(e);
      var a = s.spawns[0];
      assert.strictEqual(a[a.indexOf('--stages') + 1], 'subtitles,frames,audio,speech,captions');
      assert.strictEqual(a.indexOf('--thorough'), -1);
      var seen = s.lines[0].filter(function (m) { return m.t === 'stage' && m.status === 'running'; }).map(function (m) { return m.stage; });
      assert.deepStrictEqual(seen, ['subtitles', 'speech', 'frames', 'audio', 'lm', 'captions', 'fusion'], 'the fake speaks every stage name');
      assert.strictEqual(s.settings.set({ thorough: true, listenSpeech: false }, true).ok, true);
      sup.enqueue(id);
      waitFor(function () { return s.spawns.length === 2 && settled(s, id)(); }, 20000, function (e2) {
        assert.ifError(e2);
        var b = s.spawns[1];
        assert.strictEqual(b[b.indexOf('--stages') + 1], 'subtitles,frames,audio,captions', 'speech left out');
        assert.ok(b.indexOf('--thorough') >= 0);
        var seen2 = s.lines[1].filter(function (m) { return m.t === 'stage' && m.status === 'running'; }).map(function (m) { return m.stage; });
        assert.deepStrictEqual(seen2, ['subtitles', 'frames', 'audio', 'lm', 'captions', 'fusion']);
        done();
      });
    });
  });
});
