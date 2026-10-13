'use strict';
// Board reviews (product/parent, security/video): fail-closed statuses, whole-title approval kept
// in the signed library index (never read from history), lists changed outside the app or
// imported, the activity log, one enforcement path for player and exports, locking a running
// player, and the renderer's "what will really happen" mirror.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var h = require('./helpers.js');
var BO = require('../../shared/skipfile.js');
var enforce = require('../main/enforce.js');
var libMod = require('../main/library.js');
var createActivity = require('../main/activity.js').createActivity;
var createPlayerService = require('../main/player-service.js').createPlayerService;
var createHandlers = require('../main/handlers.js').createHandlers;
var importJson = require('../main/importers/json.js').importJson;

var ITEM = { id: 'abababababababab', path: null, filename: 'a.mp4', title: 'Alpha', size: 10, oshash: 'abababababababab', status: 'notScanned', duration: 600 };

function doc(ranges, scanStatus) {
  return BO.newDoc({
    media: { title: 'Alpha', duration: 600, fingerprint: { size: 10, oshash: ITEM.oshash } },
    ranges: ranges.map(function (r, i) {
      return BO.newRange({ id: 'rbrd0000' + i, start: r.start, end: r.end, category: r.category || 'gore', source: r.source || 'auto',
        review: r.review || 'pending', confidence: r.confidence === undefined ? 0.9 : r.confidence, action: r.action || 'skip' });
    }),
    scan: { status: scanStatus || 'complete' }
  });
}

function setup(name, d, opts) {
  var s = h.stack(name, opts);
  var media = path.join(s.dir, 'a.mp4');
  fs.writeFileSync(media, 'not really a video');
  var it = JSON.parse(JSON.stringify(ITEM));
  it.path = media;
  s.store.writeEnvelope('library.json', { version: 1, items: [it] });
  s.library.load();
  if (d) { assert.ok(s.skips.replace(ITEM.id, d, false).ok); }
  return s;
}

function status(s) { return s.library.get(ITEM.id).status; }

/* ------------------------------------------------------------------ decision 2: zero findings */

test('a scan that found nothing waits for one parent click; approval lives in the signed index, not in history', function () {
  var s = setup('brd-clean', doc([]));
  var it = s.library.get(ITEM.id);
  assert.strictEqual(it.status, 'needsReview');
  assert.strictEqual(it.cleanPending, true);
  // A forged history entry in the skip file proves nothing.
  var forged = s.skips.load(ITEM.id).doc;
  BO.addHistory(forged, 'approved', null, libMod.CLEAN_APPROVAL);
  s.store.writeJson('library/' + ITEM.id + '.bonis.json', forged);
  s.library.update(ITEM.id, { skipHmac: s.store.hmac(JSON.stringify(forged)) }, true);
  s.library.applyDoc(ITEM.id, s.skips.load(ITEM.id).doc, BO.validate);
  assert.strictEqual(status(s), 'needsReview', 'history text is never trusted');
  var r = s.skips.approveClean(ITEM.id);
  assert.ok(r.ok);
  assert.strictEqual(status(s), 'protected');
  assert.strictEqual(s.library.get(ITEM.id).wholeApproved, true);
  // A new scan result resets it (the supervisor clears wholeApproved before replace).
  s.library.update(ITEM.id, { wholeApproved: false }, true);
  s.skips.replace(ITEM.id, doc([]), false);
  assert.strictEqual(status(s), 'needsReview');
  assert.strictEqual(s.skips.approveClean(ITEM.id).ok, true);
  var p = setup('brd-clean-pending', doc([{ start: 10, end: 20 }]));
  assert.strictEqual(p.skips.approveClean(ITEM.id).error, 'pendingScenes');
});

/* ------------------------------------------------------------------ board A4: tampering */

test('a skip file edited outside the app lands in "Needs review: changed outside" and never Protected', function () {
  var s = setup('brd-tamper', doc([{ start: 10, end: 20, review: 'approved' }]));
  assert.strictEqual(status(s), 'protected');
  var d = s.skips.load(ITEM.id).doc;
  d.ranges = [];
  s.store.writeJson('library/' + ITEM.id + '.bonis.json', d);
  var r = s.skips.load(ITEM.id);
  assert.strictEqual(r.tampered, true);
  s.library.applyDoc(ITEM.id, r.doc, BO.validate);
  var it = s.library.get(ITEM.id);
  assert.strictEqual(it.status, 'needsReview');
  assert.strictEqual(it.outside, 'changed');
  // Further parent edits re-sign the file but do not clear the flag.
  s.skips.addRange(ITEM.id, { start: 30, end: 40, review: 'approved' }, 'added');
  assert.strictEqual(status(s), 'needsReview');
  var tr = s.skips.trust(ITEM.id);
  assert.ok(tr.ok);
  assert.strictEqual(status(s), 'protected');
  assert.strictEqual(s.library.get(ITEM.id).outside, null);
});

test('a library entry without its signature, or a library index that fails its HMAC, is not trusted', function () {
  var s = setup('brd-tamper-lib', doc([{ start: 10, end: 20, review: 'approved' }]));
  // Remove skipHmac and claim Protected, as the review's repro did.
  var env = JSON.parse(fs.readFileSync(path.join(s.dir, 'library.json'), 'utf8'));
  delete env.data.items[0].skipHmac;
  env.data.items[0].status = 'protected';
  fs.writeFileSync(path.join(s.dir, 'library.json'), JSON.stringify(env));
  try { fs.unlinkSync(path.join(s.dir, 'library.json.bak')); } catch (e) { /* none */ }
  var tampered = [];
  s.store.on('tampered', function (ev) { tampered.push(ev.file); });
  s.library.load();
  assert.deepStrictEqual(tampered, ['library.json']);
  var it = s.library.get(ITEM.id);
  assert.strictEqual(it.status, 'needsReview', 'demoted at load');
  assert.strictEqual(it.outside, 'changed');
  var r = s.skips.load(ITEM.id);
  assert.strictEqual(r.tampered, true, 'a missing skipHmac counts as tampered');
  s.library.applyDoc(ITEM.id, r.doc, BO.validate);
  assert.strictEqual(status(s), 'needsReview');
});

test('an unreadable list with no good backup is damaged: Needs attention, onDamaged called', function () {
  var damaged = [];
  var s = setup('brd-damaged', doc([{ start: 10, end: 20, review: 'approved' }]));
  var skips = require('../main/skips.js').createSkips({ store: s.store, library: s.library, onDamaged: function (id) { damaged.push(id); } });
  var f = path.join(s.dir, 'library', ITEM.id + '.bonis.json');
  fs.writeFileSync(f, '{ broken');
  fs.writeFileSync(f + '.bak', '{ broken too');
  var r = skips.load(ITEM.id);
  assert.strictEqual(r.doc, null);
  assert.strictEqual(r.corrupt, true);
  assert.deepStrictEqual(damaged, [ITEM.id]);
});

/* ------------------------------------------------------------------ board A5: imports */

test('an imported skip file arrives pending, flagged "imported", and needs "Use this list for kids"', function () {
  var s = setup('brd-import', null);
  var foreign = doc([{ start: 39, end: 39.5, review: 'approved', source: 'manual' }]);
  foreign.media.fingerprint = { size: 999, oshash: '0123456789abcdef' };
  var r = importJson({ text: JSON.stringify(foreign), library: s.library, skips: s.skips, targetId: ITEM.id });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.match, 'manual');
  var d = s.skips.load(ITEM.id).doc;
  assert.ok(d.ranges.every(function (x) { return x.review === 'pending'; }), 'nothing approved by the file');
  assert.notStrictEqual(d.scan.status, 'complete', 'the file\'s scan status does not count without an exact match');
  var it = s.library.get(ITEM.id);
  assert.strictEqual(it.status, 'needsReview');
  assert.strictEqual(it.outside, 'imported');
  s.skips.approve(ITEM.id, 'all');
  assert.strictEqual(status(s), 'needsReview', 'still waiting for the explicit confirmation');
  assert.ok(s.skips.trust(ITEM.id).ok);
  assert.strictEqual(status(s), 'protected');
});

/* ------------------------------------------------------------------ decision 3: activity log */

test('activity log: append-only JSON lines, newest first, rotated at the limit, unknown types refused', function () {
  var dir = h.tmpDir('brd-activity');
  var n = 0;
  var a = createActivity({ dir: dir, maxLines: 5, now: function () { n++; return '2026-01-01T00:00:0' + (n % 10) + 'Z'; } });
  assert.strictEqual(a.add('nonsense', {}), false);
  var i;
  for (i = 0; i < 7; i++) { assert.ok(a.add('unlock', { mode: 'kid', title: 'T' + i })); }
  assert.ok(fs.existsSync(path.join(dir, 'activity.1.jsonl')), 'rotated');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'activity.jsonl'), 'utf8').trim().split('\n').length, 2);
  var list = a.list();
  assert.strictEqual(list.length, 7);
  assert.strictEqual(list[0].title, 'T6', 'newest first');
  fs.appendFileSync(path.join(dir, 'activity.jsonl'), '{"torn');
  assert.strictEqual(a.list().length, 7, 'a torn last line is skipped');
  var b = createActivity({ dir: dir });
  b.add('panic', { mode: 'kid', title: 'x'.repeat(400) });
  assert.strictEqual(b.list(1)[0].title.length, 300, 'fields are capped');
});

/* ------------------------------------------------------------------ decision 6 + board A8 */

function loadEffective() {
  var win = { BO: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'effective.js'), 'utf8'), { window: win });
  return win.BO.effective;
}

test('the renderer\'s "what will happen" equals the player\'s playback document for every level and setting', function () {
  var eff = loadEffective();
  var cats = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];
  var ranges = [];
  cats.forEach(function (c) {
    [0.3, 0.5, 0.7, 0.9].forEach(function (conf) {
      ['pending', 'approved', 'rejected'].forEach(function (rv) {
        ['skip', 'none', 'mute'].forEach(function (act) {
          ranges.push({ start: ranges.length * 10, end: ranges.length * 10 + 5, category: c, confidence: conf, review: rv, action: act, source: rv === 'approved' && act === 'mute' ? 'manual' : 'auto' });
        });
      });
    });
  });
  var d = doc(ranges);
  ['off', 'light', 'moderate', 'strict'].forEach(function (lvl) {
    [true, false].forEach(function (skipScenes) {
      var levels = {};
      cats.forEach(function (c) { levels[c] = lvl; });
      var st = { levels: levels, skipScenes: skipScenes, nonSkipAction: 'blur' };
      var play = enforce.playbackDoc(d, st);
      play.ranges.forEach(function (pr, i) {
        assert.strictEqual(eff.action(d.ranges[i], st), pr.action, lvl + ' ' + JSON.stringify(d.ranges[i]));
      });
    });
  });
});

test('exports use exactly what the player enforces: the Kodi list equals the playback file', function (t, done) {
  // A pending automatic gore scene stored as "none" with 0.5 confidence (board repro A8): under
  // Strict the player skips it, so the Kodi list must cut it too.
  var d = doc([{ start: 10, end: 20, category: 'gore', confidence: 0.5, action: 'none' }, { start: 40, end: 50, category: 'kissing', confidence: 0.5 },
    { start: 70, end: 80, category: 'language', confidence: 0.95 }, { start: 100, end: 110, review: 'rejected' }]);
  var s = setup('brd-export', d);
  s.settings.set({ levels: { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'light', gore: 'strict', language: 'strict' } }, false);
  var log = [];
  var service = createPlayerService({
    createPlayer: function () {
      return { on: function () {}, play: function (m, f, o, cb) { log.push(JSON.parse(fs.readFileSync(f, 'utf8'))); cb(null); }, stop: function (cb) { cb(null); }, status: function () { return { state: 'playing' }; } };
    },
    paths: s.paths, settings: s.settings, library: s.library, skips: s.skips, supervisor: { setPlayerOpen: function () {} }
  });
  var outDir = h.tmpDir('brd-export-out');
  var dialog = { showOpenDialog: function () { return Promise.resolve({ canceled: false, filePaths: [outDir] }); } };
  var handlers = createHandlers({ electron: { dialog: dialog }, getWindow: function () { return null; }, store: s.store, pin: s.pin, settings: s.settings, library: s.library, skips: s.skips, paths: s.paths, player: service,
    supervisor: {}, log: h.noopLog(), emit: function () {}, i18n: { t: function (k) { return k; } }, versions: {} });
  service.play(ITEM.id, {}, function (e, r) {
    assert.ok(r.ok);
    var playerCuts = BO.enforced(log[0]).map(function (x) { return [x.start, x.end, x.action]; });
    assert.deepStrictEqual(playerCuts.map(function (x) { return x[0]; }), [10, 70], 'gore follows Strict, kissing is below Light, rejected plays');
    var spans = playerCuts.map(function (x) { return [x[0], x[1]]; });
    var steps = [
      function (next) {
        handlers['export:edl']({ id: ITEM.id, dir: outDir }, {}, function (err) { assert.strictEqual(err, 'forbidden', 'only folders chosen in the dialog'); next(); });
      },
      function (next) {
        handlers['export:pickFolder']({}, {}, function (err, picked) { assert.strictEqual(picked.dir, outDir); next(); });
      },
      function (next) {
        handlers['export:edl']({ id: ITEM.id, dir: outDir }, {}, function (err, res) {
          assert.ifError(err);
          var lines = fs.readFileSync(res.path, 'utf8').trim().split('\n').map(function (l) { return l.split(/\s+/).map(Number); });
          assert.deepStrictEqual(lines.map(function (l) { return [l[0], l[1]]; }), spans);
          assert.deepStrictEqual(lines.map(function (l) { return l[2]; }), [0, 1], 'skip cuts, language mutes');
          next();
        });
      },
      function (next) {
        handlers['export:json']({ id: ITEM.id, dir: outDir }, {}, function (err, res) {
          assert.ifError(err);
          var side = JSON.parse(fs.readFileSync(res.path, 'utf8'));
          assert.deepStrictEqual(BO.enforced(side).map(function (x) { return [x.start, x.end]; }), spans);
          next();
        });
      }
    ];
    (function run(i) {
      if (i >= steps.length) { service.stop(function () { done(); }); return; }
      steps[i](function () { run(i + 1); });
    }(0));
  });
});

/* ------------------------------------------------------------------ decisions 1, 3 + board A7 */

function fakePlayer(log) {
  return function () {
    var listeners = {};
    var p = {
      on: function (n, fn) { (listeners[n] = listeners[n] || []).push(fn); return p; },
      emit: function (n, v) { (listeners[n] || []).forEach(function (fn) { fn(v); }); },
      play: function (media, skipfile, opts, cb) { log.push({ opts: opts }); log.player = p; cb(null); },
      stop: function (cb) { p.emit('ended', { reason: 'stopped' }); cb(null); },
      status: function () { return { state: 'playing' }; },
      scriptMessage: function (args, cb) { log.messages = (log.messages || []).concat([args]); cb(null); }
    };
    return p;
  };
}

function service(s, log, events, activity) {
  return createPlayerService({
    createPlayer: fakePlayer(log), paths: s.paths, settings: s.settings, library: s.library, skips: s.skips, activity: activity,
    supervisor: { setPlayerOpen: function () {} }, emit: function (n, p) { events.push({ name: n, payload: p }); }, t: function (k) { return k; }
  });
}

test('parent mode never plays a title without a usable list unless the parent says so', function (t, done) {
  var s = setup('brd-confirm', null);
  var log = [];
  var events = [];
  var acts = createActivity({ dir: s.dir });
  var svc = service(s, log, events, acts);
  svc.play(ITEM.id, {}, function (e, r) {
    assert.deepStrictEqual(r, { ok: false, error: 'needsConfirm', data: { reason: 'notScanned' } });
    assert.strictEqual(log.length, 0, 'mpv never started');
    var pre = svc.preview(ITEM.id);
    assert.strictEqual(pre.data.list, false);
    svc.play(ITEM.id, { unprotected: true }, function (e2, r2) {
      assert.strictEqual(r2.ok, true);
      assert.ok(events.some(function (ev) { return ev.payload && ev.payload.type === 'starting' && ev.payload.unprotected === true; }));
      assert.strictEqual(acts.list()[0].type, 'playUnprotected');
      svc.stop(function () { done(); });
    });
  });
});

test('pre-play preview counts what will happen; a kid-mode panic stays enforced and flags the card', function (t, done) {
  var d = doc([{ start: 10, end: 20, review: 'approved' }, { start: 30, end: 40, category: 'language', review: 'approved', action: 'mute' },
    { start: 50, end: 60, category: 'kissing', confidence: 0.5 }, { start: 70, end: 80, review: 'rejected' }]);
  var s = setup('brd-preview', d);
  s.settings.set({ preset: 'teens' }, false);
  var log = [];
  var events = [];
  var acts = createActivity({ dir: s.dir });
  var svc = service(s, log, events, acts);
  var pv = svc.preview(ITEM.id).data;
  assert.strictEqual(pv.totals.skipped, 1);
  assert.strictEqual(pv.totals.muted, 1);
  assert.strictEqual(pv.totals.letPlay, 1);
  assert.strictEqual(pv.totals.below, 1, 'kissing at 0.5 is below Light');
  s.skips.approve(ITEM.id, 'all');
  svc.play(ITEM.id, { kidMode: true }, function (e, r) {
    assert.ok(r.ok, JSON.stringify(r));
    log.player.emit('panic', { t: 'panic', phase: 'end', at: 90, range: { id: 'rpanic777', start: 88, end: 90 } });
    var it = s.library.get(ITEM.id);
    assert.strictEqual(it.panicUnseen.count, 1);
    assert.strictEqual(it.panicUnseen.mode, 'kid');
    var pr = s.skips.load(ITEM.id).doc.ranges.filter(function (x) { return x.id === 'rpanic777'; })[0];
    assert.strictEqual(pr.review, 'approved');
    assert.strictEqual(pr.note, 'panic.note.kid');
    assert.strictEqual(it.status, 'protected', 'the hidden moment is skipped from now on');
    var a = acts.list()[0];
    assert.strictEqual(a.type, 'panic');
    assert.strictEqual(a.mode, 'kid');
    assert.strictEqual(a.movieTime, 88);
    svc.stop(function () { done(); });
  });
});

test('locking while a parent-mode player is open switches it to kid mode, or stops a title kids cannot play', function (t, done) {
  var s = setup('brd-lock', doc([{ start: 10, end: 20, review: 'approved' }]));
  var log = [];
  var events = [];
  var svc = service(s, log, events);
  svc.play(ITEM.id, {}, function (e, r) {
    assert.ok(r.ok);
    assert.strictEqual(log[0].opts.kidMode, false);
    svc.enterKidMode(function (e2, how) {
      assert.strictEqual(how, 'switched');
      assert.deepStrictEqual(log.messages, [['set-kidmode', '1']]);
      assert.strictEqual(svc.status().kidMode, true);
      assert.ok(events.some(function (ev) { return ev.payload && ev.payload.type === 'kidMode'; }));
      log.player.emit('mark', { t: 'mark', range: { id: 'rkidmark1', start: 30, end: 35 } });
      assert.strictEqual(s.skips.load(ITEM.id).doc.ranges.length, 1, 'marks keys do nothing in kid mode');
      svc.stop(function () {
        // A title with a scene still waiting: lock stops the player.
        s.skips.addRange(ITEM.id, { start: 40, end: 45 }, 'added');
        svc.play(ITEM.id, {}, function (e3, r3) {
          assert.ok(r3.ok);
          svc.enterKidMode(function (e4, how2) {
            assert.strictEqual(how2, 'stopped');
            assert.strictEqual(svc.status().state, 'idle');
            svc.enterKidMode(function (e5, how3) { assert.strictEqual(how3, 'none'); done(); });
          });
        });
      });
    });
  });
});

/* ------------------------------------------------------------------ round 2 */

function handlersFor(s, service, outDir) {
  var dialog = { showOpenDialog: function () { return Promise.resolve({ canceled: false, filePaths: [outDir] }); } };
  return createHandlers({ electron: { dialog: dialog }, getWindow: function () { return null; }, store: s.store, pin: s.pin, settings: s.settings, library: s.library, skips: s.skips,
    paths: s.paths, player: service || { status: function () { return { state: 'idle' }; } }, supervisor: {}, log: h.noopLog(), emit: function () {},
    i18n: { t: function (k) { return k; } }, versions: {}, activity: createActivity({ dir: s.dir }) });
}

test('"For this movie" levels: kept in the library index, used by the player, the preview and the Kodi list alike', function (t, done) {
  // A pending kissing scene at 0.7: Little kids (strict) skips it; a per-movie Light level lets it play.
  var s = setup('brd-movie-levels', doc([{ start: 10, end: 20, category: 'kissing', confidence: 0.7 }, { start: 40, end: 50, category: 'gore', review: 'approved' }]));
  var log = [];
  var svc = service(s, log, []);
  var outDir = h.tmpDir('brd-movie-levels-out');
  var hd = handlersFor(s, svc, outDir);
  assert.strictEqual(svc.preview(ITEM.id).data.totals.skipped, 2);
  var light = { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'light', gore: 'strict', language: 'strict' };
  hd['library:setLevels']({ id: ITEM.id, levels: { nudity: 'loud' } }, {}, function (eBad) {
    assert.strictEqual(eBad, 'badValue');
    hd['library:setLevels']({ id: ITEM.id, levels: light }, {}, function (e, it) {
      assert.ifError(e);
      assert.deepStrictEqual(it.levels, light, 'stored in the library entry');
      assert.strictEqual(s.skips.load(ITEM.id).doc.levels, undefined, 'not in the skip file');
      assert.deepStrictEqual(s.settings.value('levels').kissing, 'strict', 'the usual levels are unchanged');
      var pv = svc.preview(ITEM.id).data;
      assert.strictEqual(pv.perMovie, true);
      assert.strictEqual(pv.totals.below, 1, 'kissing at 0.7 is below Light for this movie');
      svc.play(ITEM.id, {}, function (e2, r) {
        assert.ok(r.ok);
        var cuts = BO.enforced(log[0].doc || JSON.parse(fs.readFileSync(path.join(s.paths.playDir(), ITEM.id + '.play.bonis.json'), 'utf8'))).map(function (x) { return x.start; });
        assert.deepStrictEqual(cuts, [40], 'the player follows the movie\'s own levels');
        svc.stop(function () {
          hd['export:pickFolder']({}, {}, function () {
            hd['export:edl']({ id: ITEM.id, dir: outDir }, {}, function (e3, res) {
              assert.ifError(e3);
              var lines = fs.readFileSync(res.path, 'utf8').trim().split('\n');
              assert.deepStrictEqual(lines.map(function (l) { return Number(l.split(/\s+/)[0]); }), [40], 'and so does the Kodi list');
              hd['library:setLevels']({ id: ITEM.id, levels: null }, {}, function (e4, it2) {
                assert.strictEqual(it2.levels, null, '"Use my usual levels"');
                assert.strictEqual(svc.preview(ITEM.id).data.totals.skipped, 2);
                done();
              });
            });
          });
        });
      });
    });
  });
});

test('the parents card can only say "checked by you" when the parent finished: reviewedAt is set on Protected', function () {
  var s = setup('brd-reviewed', doc([{ start: 10, end: 20 }]));
  assert.strictEqual(s.library.get(ITEM.id).reviewedAt, undefined);
  s.skips.approve(ITEM.id, 'all');
  var it = s.library.get(ITEM.id);
  assert.strictEqual(it.status, 'protected');
  assert.ok(!isNaN(Date.parse(it.reviewedAt)), 'date of the finished review');
});

test('a kid-mode panic flag clears only when the parent opens that scene', function (t, done) {
  var s = setup('brd-panic-seen', doc([{ start: 10, end: 20, review: 'approved' }]));
  var log = [];
  var svc = service(s, log, []);
  var hd = handlersFor(s, svc, h.tmpDir('brd-panic-out'));
  svc.play(ITEM.id, { kidMode: true }, function (e, r) {
    assert.ok(r.ok);
    log.player.emit('panic', { t: 'panic', phase: 'end', at: 90, range: { id: 'rpanic901', start: 88, end: 90 } });
    log.player.emit('panic', { t: 'panic', phase: 'end', at: 120, range: { id: 'rpanic902', start: 118, end: 120 } });
    svc.stop(function () {
      assert.deepStrictEqual(s.library.get(ITEM.id).panicUnseen.rangeIds, ['rpanic901', 'rpanic902']);
      hd['skip:get']({ id: ITEM.id }, {}, function () {
        assert.ok(s.library.get(ITEM.id).panicUnseen, 'opening the review alone keeps the flag');
        hd['skip:seen']({ id: ITEM.id, rangeId: 'rpanic901' }, {}, function () {
          assert.deepStrictEqual(s.library.get(ITEM.id).panicUnseen.rangeIds, ['rpanic902']);
          hd['skip:seen']({ id: ITEM.id, rangeId: 'rpanic902' }, {}, function () {
            assert.strictEqual(s.library.get(ITEM.id).panicUnseen, null);
            done();
          });
        });
      });
    });
  });
});

test('a list damaged on disk while the app runs is noticed when the library is listed', function (t, done) {
  var s = setup('brd-list-check', doc([{ start: 10, end: 20, review: 'approved' }]));
  var damaged = [];
  s.skips = require('../main/skips.js').createSkips({ store: s.store, library: s.library, onDamaged: function (id) {
    damaged.push(id);
    s.library.setStatus(id, 'needsAttention', { error: 'skipCorrupt' });
  } });
  var hd = handlersFor(s, null, h.tmpDir('brd-list-out'));
  hd['library:list']({}, {}, function (e, items) {
    assert.strictEqual(items[0].status, 'protected');
    var f = path.join(s.dir, 'library', ITEM.id + '.bonis.json');
    fs.writeFileSync(f, '{ broken');
    fs.writeFileSync(f + '.bak', '{ broken');
    hd['library:list']({}, {}, function (e2, items2) {
      assert.deepStrictEqual(damaged, [ITEM.id]);
      assert.strictEqual(items2[0].status, 'needsAttention', 'never "Protected" on a damaged list');
      done();
    });
  });
});

test('player crashes go to the activity log', function (t, done) {
  var s = setup('brd-crash-log', doc([{ start: 10, end: 20, review: 'approved' }]));
  var log = [];
  var acts = createActivity({ dir: s.dir });
  var svc = service(s, log, [], acts);
  svc.play(ITEM.id, { kidMode: true }, function () {
    log.player.emit('crashed', { final: true });
    var a = acts.list()[0];
    assert.strictEqual(a.type, 'playerStopped');
    assert.strictEqual(a.mode, 'kid');
    done();
  });
});
