'use strict';
// player-service.js with a stand-in player: kid mode fail-closed, marks / undo / panic merged into
// the library skip file at once (with history), the marks file replayed after a crash, resume
// position remembered, scans paused while the player is open.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var h = require('./helpers.js');
var BO = require('../../shared/skipfile.js');
var createPlayerService = require('../main/player-service.js').createPlayerService;

var ITEM = { id: 'dddddddddddddddd', path: null, filename: 'd.mp4', title: 'Delta', size: 10, oshash: 'dddddddddddddddd', status: 'notScanned', duration: 600 };

function fakePlayer(log) {
  return function () {
    var listeners = {};
    var state = 'idle';
    var p = {
      on: function (n, fn) { (listeners[n] = listeners[n] || []).push(fn); return p; },
      emit: function (n, v) { (listeners[n] || []).forEach(function (fn) { fn(v); }); },
      play: function (media, skipfile, opts, cb) { state = 'playing'; log.push({ media: media, skipfile: skipfile, opts: opts, doc: JSON.parse(fs.readFileSync(skipfile, 'utf8')) }); log.player = p; cb(null); },
      stop: function (cb) { state = 'idle'; p.emit('ended', { reason: 'stopped' }); cb(null); },
      status: function () { return { state: state }; }
    };
    return p;
  };
}

function setup(name, doc) {
  var s = h.stack(name);
  var media = path.join(s.dir, 'd.mp4');
  fs.writeFileSync(media, 'not really a video');
  var it = JSON.parse(JSON.stringify(ITEM));
  it.path = media;
  s.store.writeEnvelope('library.json', { version: 1, items: [it] });
  s.library.load();
  if (doc) { s.skips.replace(ITEM.id, doc, false); }
  s.playerOpen = [];
  s.events = [];
  s.log = [];
  s.service = createPlayerService({
    createPlayer: fakePlayer(s.log), paths: s.paths, settings: s.settings, library: s.library, skips: s.skips,
    supervisor: { setPlayerOpen: function (v) { s.playerOpen.push(v); } },
    emit: function (n, p) { s.events.push({ name: n, payload: p }); }
  });
  return s;
}

function protectedDoc() {
  return BO.newDoc({
    media: { title: 'Delta', duration: 600, fingerprint: { size: 10, oshash: ITEM.oshash } },
    ranges: [BO.newRange({ id: 'rdel00001', start: 10, end: 20, category: 'gore', source: 'auto', review: 'approved', confidence: 0.9 })],
    scan: { status: 'complete' }
  });
}

test('kid mode refuses anything but a Protected title', function (t, done) {
  var s = setup('ps-kid', null);
  s.service.play(ITEM.id, { kidMode: true }, function (e, r) {
    assert.deepStrictEqual(r, { ok: false, error: 'kidRefused' });
    assert.strictEqual(s.log.length, 0, 'mpv never started');
    var d = protectedDoc();
    d.ranges[0].review = 'pending';
    s.skips.replace(ITEM.id, d, false);
    s.service.play(ITEM.id, { kidMode: true }, function (e2, r2) {
      assert.strictEqual(r2.error, 'kidRefused', 'pending scenes are not protected yet');
      s.skips.approve(ITEM.id, 'all');
      s.service.play(ITEM.id, { kidMode: true }, function (e3, r3) {
        assert.strictEqual(r3.ok, true);
        assert.strictEqual(s.log[0].opts.kidMode, true);
        assert.deepStrictEqual(s.playerOpen, [true], 'scans pause while playing');
        s.service.stop(function () {
          assert.deepStrictEqual(s.playerOpen, [true, false]);
          done();
        });
      });
    });
  });
});

test('marks, undo and panic are merged into the skip file at once', function (t, done) {
  var s = setup('ps-marks', protectedDoc());
  s.service.play(ITEM.id, {}, function (e, r) {
    assert.strictEqual(r.ok, true);
    var p = s.log.player;
    assert.strictEqual(s.log[0].doc.ranges.length, 1, 'playback file written from the library file');
    p.emit('mark', { t: 'mark', range: { id: 'rmark0001', start: 30, end: 35 } });
    var d = s.skips.load(ITEM.id).doc;
    assert.strictEqual(d.ranges.length, 2);
    assert.strictEqual(d.ranges[1].source, 'manual');
    assert.strictEqual(d.ranges[1].review, 'pending');
    assert.strictEqual(s.library.get(ITEM.id).status, 'needsReview', 'a new mark waits for review');
    p.emit('mark', { t: 'undo', id: 'rmark0001' });
    assert.strictEqual(s.skips.load(ITEM.id).doc.ranges.length, 1);
    p.emit('panic', { t: 'panic', phase: 'start', at: 50 });
    p.emit('panic', { t: 'panic', phase: 'end', at: 54, range: { id: 'rpanic001', start: 48, end: 54 } });
    d = s.skips.load(ITEM.id).doc;
    var panic = d.ranges.filter(function (x) { return x.id === 'rpanic001'; })[0];
    assert.strictEqual(panic.source, 'panic');
    assert.strictEqual(panic.review, 'approved');
    assert.ok(d.history.some(function (x) { return x.event === 'panic' && x.rangeId === 'rpanic001'; }));
    p.emit('timepos', 123.4);
    assert.ok(s.events.some(function (ev) { return ev.name === 'player:event' && ev.payload.type === 'panic' && ev.payload.phase === 'end'; }));
    s.service.stop(function () {
      assert.strictEqual(s.library.get(ITEM.id).resumeAt, 123.4, 'resume position remembered');
      done();
    });
  });
});

test('a marks file left by a crash is merged at the next start', function () {
  var s = setup('ps-recover', protectedDoc());
  var dir = s.paths.playDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ITEM.id + '.marks.jsonl'), [
    JSON.stringify({ t: 'mark', range: { id: 'rlost0001', start: 100, end: 110 } }),
    JSON.stringify({ t: 'mark', range: { id: 'rlost0002', start: 200, end: 210 } }),
    JSON.stringify({ t: 'undo', id: 'rlost0002' }),
    JSON.stringify({ t: 'panic', phase: 'end', at: 300, range: { id: 'rlost0003', start: 298, end: 300 } }),
    '{"t":"mark","range":{"id":"rtorn'
  ].join('\n'));
  assert.strictEqual(s.service.recover(), 2);
  var ids = s.skips.load(ITEM.id).doc.ranges.map(function (r) { return r.id; });
  assert.deepStrictEqual(ids, ['rdel00001', 'rlost0001', 'rlost0003']);
  assert.ok(!fs.existsSync(path.join(dir, ITEM.id + '.marks.jsonl')), 'replayed once');
});

test('library add fingerprints, dedupes by oshash and refuses non-videos', { skip: h.haveFfmpeg() ? false : 'ffmpeg not installed' }, function (t, done) {
  var s = h.stack('lib-add');
  var video = h.testVideo('lib', 4);
  var junk = path.join(s.dir, 'notes.txt');
  fs.writeFileSync(junk, 'hello');
  s.library.add([video, video, junk, path.join(s.dir, 'missing.mkv')], function (e, r) {
    assert.strictEqual(r.added.length, 1);
    assert.deepStrictEqual(r.duplicates, r.added);
    assert.deepStrictEqual(r.failed.map(function (f) { return f.reason; }), ['notVideo', 'notFound']);
    var it = s.library.get(r.added[0]);
    assert.match(it.oshash, /^[0-9a-f]{16}$/);
    assert.strictEqual(it.status, 'notScanned');
    assert.ok(Math.abs(it.duration - 4) < 0.2);
    done();
  });
});

test('JSON export writes the sidecar with an offset and an exported entry', function (t, done) {
  var dir = h.tmpDir('export-json');
  var media = path.join(dir, 'Movie (2001).mkv');
  fs.writeFileSync(media, 'x');
  require('../main/exporters/json.js').exportJson({ doc: protectedDoc(), mediaPath: media, offset: -2.5 }, function (err, file) {
    assert.ifError(err);
    assert.strictEqual(file, path.join(dir, 'Movie (2001).bonis.json'));
    var d = BO.fromJson(fs.readFileSync(file, 'utf8')).doc;
    assert.strictEqual(d.media.offset, -2.5);
    assert.ok(d.history.some(function (x) { return x.event === 'exported'; }));
    assert.ok(d.history.some(function (x) { return x.event === 'offsetChanged'; }));
    require('../main/exporters/edl.js').exportEdl({ doc: d, mediaPath: media }, function (err2, edl) {
      assert.ifError(err2);
      assert.strictEqual(fs.readFileSync(edl, 'utf8'), '7.50 17.50 0\n', 'Kodi times include the offset');
      require('../main/exporters/edl.js').exportEdl({ doc: d, mediaPath: media, dir: path.join(dir, 'nope', 'deeper') }, function (err3) {
        assert.strictEqual(err3.code, 'notWritable');
        done();
      });
    });
  });
});
