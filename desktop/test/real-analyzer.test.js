'use strict';
// The REAL analyzer (python3 -m bonis_analyzer.cli, cwd analyzer/) driven by the supervisor on a
// 30 s testsrc2 clip. --scores-from feeds per-second scores instead of the models, so nothing has
// to be downloaded. This guards the contract the fake analyzer cannot: the analyzer cleans its
// work folder when it finishes, so --out must live outside it, or every real scan ends in
// "badOutput" (board review, security/video, blocker 1).

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var h = require('./helpers.js');
var createSupervisor = require('../main/scanner-supervisor.js').createSupervisor;

var ANALYZER = path.join(__dirname, '..', '..', 'analyzer');
var py = childProcess.spawnSync('python3', ['-c', 'import bonis_analyzer.cli'], { cwd: ANALYZER, encoding: 'utf8' });
var skip = !h.haveFfmpeg() ? 'ffmpeg not installed' : (py.status !== 0 ? 'Python analyzer not importable: ' + String(py.stderr).slice(-200) : false);

function waitFor(fn, ms, cb) {
  var start = Date.now();
  (function poll() {
    var v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) { cb(null); return; }
    if (Date.now() - start > ms) { cb(new Error('timed out')); return; }
    setTimeout(poll, 50);
  }());
}

test('a real scan through the supervisor lands in Needs review, then Protected after the review', { skip: skip, timeout: 240000 }, function (t, done) {
  var dir = h.tmpDir('real-analyzer');
  var scores = path.join(dir, 'scores.json');
  fs.writeFileSync(scores, JSON.stringify({ signals: { frames: { nudity: { segments: [[10, 15, 0.95]] } } } }));
  // --scores-from is a scan option, so it has to come after "scan": a POSIX shell wrapper appends it
  // to whatever the supervisor passes. The program run is still the real CLI.
  var command = { cmd: '/bin/sh', args: ['-c', 'exec python3 -m bonis_analyzer.cli "$@" --scores-from "' + scores + '"', 'bonis-analyzer'], cwd: ANALYZER };
  var s = h.stack('real-analyzer-stack', { dir: dir, settings: { analyzerCommand: command, scanOnlyPluggedIn: false, listenSpeech: false } });
  var events = [];
  var spawned = [];
  var stderr = '';
  var sup = createSupervisor({
    store: s.store, library: s.library, skips: s.skips, paths: s.paths, settings: s.settings, restartDelayMs: 10,
    spawn: function (cmd, args, o) {
      spawned.push(args);
      var p = childProcess.spawn(cmd, args, o);
      p.stderr.on('data', function (d) { stderr = (stderr + d).slice(-4000); });
      return p;
    },
    emit: function (name, payload) { events.push({ name: name, payload: payload }); }
  });
  var video = h.testVideo('real', 30);
  h.addVideo(s, video, function (err, id) {
    assert.ifError(err);
    sup.load();
    sup.enqueue(id);
    waitFor(function () { var st = s.library.get(id).status; return st !== 'queued' && st !== 'scanning'; }, 200000, function (e) {
      assert.ifError(e);
      var it = s.library.get(id);
      assert.strictEqual(it.status, 'needsReview', 'status ' + it.status + ' / ' + JSON.stringify(it.attention || null) + '\n' + stderr);
      assert.ok(it.pending >= 1, 'the fed nudity scene is waiting for the parent');
      var args = spawned[0];
      assert.strictEqual(args[args.indexOf('--out') + 1], s.paths.scanOut(id));
      assert.ok(fs.existsSync(s.paths.autoScan(id)), 'automatic result kept outside the work folder');
      assert.ok(!fs.existsSync(s.paths.scanOut(id)));
      var doc = s.skips.load(id).doc;
      assert.strictEqual(doc.scan.status, 'complete');
      var nude = doc.ranges.filter(function (r) { return r.category === 'nudity'; });
      assert.ok(nude.length >= 1 && nude[0].start <= 10 && nude[0].end >= 15, JSON.stringify(doc.ranges));
      assert.ok(fs.existsSync(path.join(s.paths.workDir(id), 'state.json')), 'the analyzer cleaned its own work folder and kept its state');
      assert.ok(events.some(function (ev) { return ev.name === 'toast' && ev.payload.key === 'toast.scanDoneReview'; }));
      var r = s.skips.approve(id, doc.ranges.map(function (x) { return x.id; }));
      assert.ok(r.ok);
      assert.strictEqual(s.library.get(id).status, 'protected');
      sup.shutdown(function () { done(); });
    });
  });
});
