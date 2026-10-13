'use strict';
// Board review 2, N1: skip files count from the media's probed format.start_time; mpv's time-pos
// does not always (MP4/MOV edit lists, MKV negative start). The same colour bars on four
// timelines must have their ranges fire at the same media times, resume at the same media time,
// and produce marks in skip-file time. A file whose clock cannot be matched is refused in kid mode.

var test = require('node:test');
var assert = require('node:assert');
var h = require('./harness.js');

var opts = { skip: h.available() ? false : 'mpv or ffmpeg not installed', timeout: 20000 };
var fixtures = null;

function getFixtures() {
  if (!fixtures) { fixtures = h.ensureTimelineFixtures(); }
  return fixtures;
}

// Board review 3, NEW-1: wall-clock time from the first frame at or after a skip range's end to
// the script lifting the cover and the mute (both are one user-data change).
function releaseAfterSkip(rec, end, origin) {
  var cover = null;
  var i;
  for (i = 0; i < rec.transitions.length; i++) {
    var tr = rec.transitions[i];
    if (!cover && tr.black && typeof tr.at === 'number' && tr.at < end) { cover = tr; }
    if (cover && tr.wall >= cover.wall && !tr.black && !tr.mute) {
      var landing = rec.samples.filter(function (sm) { return sm.at >= cover.wall && sm.t - origin >= end; })[0];
      if (!landing) { return null; }
      return { landing: landing.t - origin, ms: Math.max(0, tr.wall - landing.at), coverAt: cover.at };
    }
  }
  return null;
}

function finish(rec) {
  return [rec.stop, function (err) { return rec.stop().then(function () { throw err; }); }];
}

function checkFixture(t, name) {
  var fx = getFixtures().filter(function (f) { return f.name.indexOf(name) === 0; })[0];
  // 4x: these runs check timing per fixture, so give the script 4x more wall time to react
  var rec = h.startRecorder({ speed: 4 });
  var skip = h.writeSkip('tl-' + name, [h.range('rtlskip01', 10, 15, 'skip'), h.range('rtlhide01', 20, 25, 'hide')]);
  var marks = h.uniqueName('tl-' + name) + '.marks.jsonl';
  var origin;
  var tIn;
  var tOut;
  function media(s) { return s.t - origin; }
  function last() { return media(rec.samples[rec.samples.length - 1]); }
  function waitMedia(x, ms) {
    return rec.waitFor(function (r) { return r.samples.length && media(r.samples[r.samples.length - 1]) >= x; }, ms || 8000, 'media >= ' + x);
  }
  return rec.play(fx.file, skip, { startTime: fx.start, duration: fx.duration, resumeAt: 7, marksPath: marks })
    .then(function () { return rec.waitFor(function (r) { return r.samples.length > 0; }, 5000, 'first frame'); })
    .then(function () { return rec.cmd(['get_property', 'user-data/bonis-origin']); })
    .then(function (o) {
      origin = o;
      t.diagnostic(name + ': probed start ' + fx.start + ', origin (mpv time-pos - skip-file time) ' + o.toFixed(4) +
        ', first time-pos ' + rec.samples[0].t.toFixed(3));
      var first = media(rec.samples[0]);
      // the script itself measured the first frame within 1 s of 7 (else a timeline error);
      // our first sample can be a little later at 10x under load
      assert.ok(first >= 6.9 && first < 9, 'resumed at skip-file 7: ' + first);
      assert.strictEqual(rec.eventsOf('error').length, 0, 'no timeline error');
      return waitMedia(8);
    })
    .then(function () { tIn = last(); return rec.cmd(['keypress', 'i']); })
    .then(function () { return waitMedia(9.3); })
    .then(function () { tOut = last(); return rec.cmd(['keypress', 'o']); })
    .then(function () { return waitMedia(27); })
    .then(function () {
      var inSkip = rec.samples.filter(function (s) { return media(s) >= 10.3 && media(s) < 15; });
      assert.strictEqual(inSkip.length, 0, 'played inside the skip range at media ' + (inSkip[0] && media(inSkip[0])));
      assert.ok(rec.samples.some(function (s) { return media(s) >= 15 && media(s) < 15.3; }), 'landed at the skip end');
      var x;
      for (x = 20.2; x <= 24.95; x += 0.05) {
        var st = rec.stateAt(x);
        assert.ok(st && st.black && st.mute, 'hidden at media ' + x.toFixed(2) + ': ' + JSON.stringify(st));
      }
      for (x = 25.2; x <= 26.9; x += 0.05) {
        var st2 = rec.stateAt(x);
        assert.ok(st2 && !st2.black && !st2.mute, 'shown at media ' + x.toFixed(2));
      }
      var rel = releaseAfterSkip(rec, 15, origin);
      assert.ok(rel, 'cover lifted after the skip');
      t.diagnostic(name + ': skip covered at ' + rel.coverAt.toFixed(3) + ', landed at ' + rel.landing.toFixed(3) +
        ', cover and mute lifted ' + rel.ms + ' ms after the landing frame');
      assert.ok(rel.ms <= 150, 'cover held ' + rel.ms + ' ms after landing');
      assert.deepStrictEqual(rec.eventsOf('skipped').map(function (m) { return m.rangeId; }), ['rtlskip01', 'rtlhide01'],
        'skipped events; events seen: ' + rec.events.filter(function (e) { return e.name !== 'timepos'; })
          .map(function (e) { return e.name + JSON.stringify(e.data); }).join(' '));
      var m = rec.eventsOf('mark')[0];
      assert.ok(m, 'mark event');
      assert.ok(Math.abs(m.range.start - tIn) < 1.0 && Math.abs(m.range.end - tOut) < 1.0,
        'mark in skip-file time: ' + JSON.stringify(m.range) + ' vs ' + tIn.toFixed(2) + '-' + tOut.toFixed(2));
      var st = rec.player.status();
      assert.ok(st.timePos > 26 && st.timePos < 40, 'controller reports skip-file time: ' + st.timePos);
    })
    .then(finish(rec)[0], finish(rec)[1]);
}

test('MP4 starting at 601.4 s (edit list): ranges, resume and marks on the skip-file timeline', opts, function (t) {
  return checkFixture(t, 'mp4-601');
});

test('MKV with a negative start (-0.021 s): ranges, resume and marks on the skip-file timeline', opts, function (t) {
  return checkFixture(t, 'mkv-neg');
});

test('MPEG-TS starting at 1.4 s: ranges, resume and marks on the skip-file timeline', opts, function (t) {
  return checkFixture(t, 'ts-1.4');
});

test('plain MP4 starting at 0 (control): ranges, resume and marks on the skip-file timeline', opts, function (t) {
  return checkFixture(t, 'mp4-0');
});

test('kid mode refuses a file whose clock does not match (start time unknown), exit code 3', opts, function () {
  var fx = getFixtures()[0];
  var rec = h.startRecorder();
  var skip = h.writeSkip('tl-kidrefuse', [h.range('rtlskip02', 10, 15, 'skip')]);
  return rec.play(fx.file, skip, { kidMode: true })
    .catch(function () { /* may exit before IPC connects */ })
    .then(function () { return rec.waitEvent('error', 8000, function (e) { return e.exitCode === 3; }); })
    .then(function () {
      var codes = rec.eventsOf('error').map(function (e) { return e.code; });
      assert.ok(codes.indexOf('timeline') >= 0, 'timeline error reported: ' + codes.join(','));
      // covered from before the first frame until the refusal
      // (the state published at script start, before any file is open, has no position)
      var shown = rec.transitions.filter(function (st) { return !st.black && typeof st.at === 'number'; });
      assert.strictEqual(shown.length, 0, 'uncovered while playing: ' + JSON.stringify(shown));
      assert.ok(rec.transitions.length > 0 && rec.transitions[rec.transitions.length - 1].black, 'covered at the end');
      assert.strictEqual(rec.eventsOf('crashed').length, 0);
    });
});

test('parent mode warns about a mismatched clock and keeps playing', opts, function () {
  var fx = getFixtures()[0];
  var rec = h.startRecorder();
  var skip = h.writeSkip('tl-parentwarn', []);
  return rec.play(fx.file, skip, {})
    .then(function () { return rec.waitEvent('error', 4000, function (e) { return e.code === 'timeline'; }); })
    .then(function () { return rec.waitFor(function (r) { return r.samples.length > 10; }, 4000, 'playing'); })
    .then(function () { assert.ok(/clock does not match/.test(rec.osd.join(' | ')), rec.osd.join(' | ')); })
    .then(finish(rec)[0], finish(rec)[1]);
});

// ---- Board review 3 ----

function review3() { return h.ensureReview3Fixtures(); }

test('24 fps, range ending 4 ms after a frame start (10.004): lands past it and lifts the cover at once', opts, function (t) {
  var fx = review3().f24;
  var rec = h.startRecorder({ speed: 4 });
  var skip = h.writeSkip('f24', [h.range('rf24skip1', 8, 10.004, 'skip')]);
  return rec.play(fx.file, skip, { startTime: fx.start, duration: fx.duration, resumeAt: 6 })
    .then(function () { return rec.waitTime(12, 8000); })
    .then(function () {
      var inside = rec.samples.filter(function (sm) { return sm.t >= 8.3 && sm.t < 10.004; });
      assert.strictEqual(inside.length, 0, 'played inside: ' + (inside[0] && inside[0].t));
      var rel = releaseAfterSkip(rec, 10.004, 0);
      assert.ok(rel, 'cover lifted');
      t.diagnostic('f24: landed at ' + rel.landing.toFixed(4) + ', cover lifted ' + rel.ms + ' ms after');
      assert.ok(rel.landing >= 10.004 && rel.landing < 10.2, 'landing ' + rel.landing);
      assert.ok(rel.ms <= 150, 'cover held ' + rel.ms + ' ms');
    })
    .then(finish(rec)[0], finish(rec)[1]);
});

function lateFirstFrame(t, key) {
  var fx = review3()[key];
  var rec = h.startRecorder({ speed: 4 });
  var skip = h.writeSkip('late-' + key, [h.range('rlate0001', 10, 15, 'skip')]);
  return rec.play(fx.file, skip, { kidMode: true, startTime: fx.start, duration: fx.duration })
    .then(function () { return rec.waitTime(17, 10000); })
    .then(function () {
      t.diagnostic(key + ': probed start ' + fx.start + ', first time-pos ' + rec.samples[0].t.toFixed(3));
      assert.strictEqual(rec.eventsOf('error').length, 0, 'not refused: ' + JSON.stringify(rec.eventsOf('error')));
      assert.strictEqual(rec.eventsOf('skipped')[0].rangeId, 'rlate0001');
      var inside = rec.samples.filter(function (sm) { return sm.t >= 10.3 && sm.t < 15; });
      assert.strictEqual(inside.length, 0, 'played inside the skip range');
    })
    .then(finish(rec)[0], finish(rec)[1]);
}

test('kid mode plays an MPEG-TS cut mid-GOP (first frame ~1.05 s after start)', opts, function (t) {
  return lateFirstFrame(t, 'mid');
});

test('kid mode plays an MPEG-TS whose audio leads video by 1.5 s', opts, function (t) {
  return lateFirstFrame(t, 'lead');
});

test('with the start unknown the first-frame check stays strict (audio-leads TS refused in kid mode)', opts, function () {
  var fx = review3().lead;
  var rec = h.startRecorder();
  var skip = h.writeSkip('late-unknown', [h.range('rlate0002', 10, 15, 'skip')]);
  return rec.play(fx.file, skip, { kidMode: true })
    .catch(function () {})
    .then(function () { return rec.waitEvent('error', 8000, function (e) { return e.exitCode === 3; }); })
    .then(function () {
      assert.ok(rec.eventsOf('error').some(function (e) { return e.code === 'timeline'; }));
    });
});

test('seek keys move the full distance on the 601 s MP4 (probed duration, not mpv\'s partial one)', opts, function (t) {
  var fx = getFixtures()[0];
  var rec = h.startRecorder({ speed: 1 });
  var skip = h.writeSkip('dur601', []);
  var origin;
  var mark;
  function media(sm) { return sm.t - origin; }
  function landed(lo, hi, label) {
    return rec.waitSampleAfter(mark, function (sm) { return media(sm) >= lo && media(sm) < hi; }, 4000, label);
  }
  return rec.play(fx.file, skip, { startTime: fx.start, duration: fx.duration, resumeAt: 3 })
    .then(function () { return rec.waitFor(function (r) { return r.samples.length > 0; }, 5000, 'first frame'); })
    .then(function () { return rec.cmd(['set_property', 'pause', true]); })
    .then(function () { return rec.cmd(['get_property', 'user-data/bonis-origin']); })
    .then(function (o) {
      origin = o;
      return h.delay(200);
    })
    .then(function () {
      var before = media(rec.samples[rec.samples.length - 1]);
      mark = rec.samples.length;
      return rec.cmd(['keypress', 'RIGHT']).then(function () { return landed(before + 4.9, before + 5.2, 'RIGHT +5'); })
        .then(function () {
          var after = media(rec.samples[rec.samples.length - 1]);
          t.diagnostic('601 s MP4: RIGHT moved ' + (after - before).toFixed(3) + ' s');
          before = after;
          mark = rec.samples.length;
          return rec.cmd(['keypress', 'UP']);
        })
        .then(function () { return landed(fx.duration - 1.0, fx.duration + 0.1, 'UP +60 clamped to the probed end'); })
        .then(function () {
          t.diagnostic('601 s MP4: UP moved ' + (media(rec.samples[rec.samples.length - 1]) - before).toFixed(3) +
            ' s (clamped at the probed duration ' + fx.duration + ')');
        });
    })
    .then(finish(rec)[0], finish(rec)[1]);
});
