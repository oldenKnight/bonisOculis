'use strict';
// Real mpv + player/bonis.lua, driven through desktop/main/player-controller.js over IPC.
// Playback runs at --speed=10 with --vo=null --ao=null, so 1 s of wall time = 10 s of media.
// Property changes reach us a few ms after the frame they belong to, so state assertions look
// at the interior of each range (0.3 s of media margin) and at the gaps between ranges.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var h = require('./harness.js');

var skipAll = !h.available();
var opts = { skip: skipAll ? 'mpv or ffmpeg not installed' : false, timeout: 20000 };
var video = null;

function getVideo() {
  if (!video) { video = h.ensureVideo(); }
  return video;
}

function fmt(samples) {
  return samples.slice(0, 5).map(function (s) {
    return s.t.toFixed(2) + '(m=' + s.mute + ',b=' + s.black + ')';
  }).join(' ');
}

function assertNone(rec, lo, hi, label) {
  var bad = rec.between(lo, hi);
  assert.strictEqual(bad.length, 0, label + ': playback reported ' + fmt(bad));
}

function assertAll(rec, lo, hi, pred, label) {
  var inside = rec.between(lo, hi);
  assert.ok(inside.length > 0, label + ': no samples in [' + lo + ', ' + hi + ')');
  var bad = inside.filter(function (s) { return !pred(s); });
  assert.strictEqual(bad.length, 0, label + ': ' + fmt(bad));
}

function vfEmpty(s) { return !s.vf || s.vf.length === 0; }

test('enforces skip, hide, mute and blur and restores everything after each range', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('standard', h.standardRanges());
  return rec.play(getVideo(), skip, {})
    .then(function () { return rec.waitEvent('ended', 15000); })
    .then(function () {
      // skip 10-15: nothing played inside after the start
      assertNone(rec, 10.1, 15, 'skip range');
      assert.ok(rec.between(15, 16).length > 0, 'playback resumed at the skip end');
      // hide 20-25: black + mute inside, restored after
      assertAll(rec, 20.3, 24.7, function (s) { return s.black && s.mute === true; }, 'hide inside');
      assertAll(rec, 25.3, 29.5, function (s) { return !s.black && s.mute === false; }, 'after hide');
      // mute 30-33: mute only
      assertAll(rec, 30.3, 32.7, function (s) { return s.mute === true && !s.black; }, 'mute inside');
      assertAll(rec, 33.3, 39.0, function (s) { return s.mute === false && !s.black; }, 'after mute');
      // blur 40-43: pixelate filter (or hide fallback) + mute; filter removed after
      assertAll(rec, 40.3, 42.7, function (s) {
        return s.mute === true && ((s.vf && s.vf.length === 1 && s.vf[0].label === 'bo-blur') || s.black);
      }, 'blur inside');
      assertAll(rec, 43.3, 59.5, function (s) { return s.mute === false && !s.black && vfEmpty(s); }, 'after blur');
      // rejected (45-50) and action "none" (52-54) ranges are not enforced
      assert.ok(rec.between(46, 49).length > 20, 'rejected range played');
      assert.ok(rec.between(52.3, 53.7).length > 5, 'action none range played');
      var skipped = rec.eventsOf('skipped').map(function (m) { return m.rangeId; });
      assert.deepStrictEqual(skipped, ['rskip0001', 'rhide0001', 'rmute0001', 'rblur0001']);
      var ready = rec.eventsOf('ready')[0];
      assert.strictEqual(ready.ranges, 6);
      assert.strictEqual(ready.enforced, 4);
      // final state at the end of the file
      assert.strictEqual(rec.state.mute, false);
      assert.ok(vfEmpty({ vf: rec.state.vf }));
      assert.strictEqual(rec.state.bonis.black, false);
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

test('a forward seek into a skip range lands at its end', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('seekfwd', h.standardRanges());
  var mark;
  return rec.play(getVideo(), skip, {})
    .then(function () { return rec.waitTime(2); })
    .then(function () {
      mark = rec.samples.length;
      return rec.cmd(['seek', 12, 'absolute+exact']);
    })
    .then(function () {
      return rec.waitSampleAfter(mark, function (s) { return s.t >= 15.2; }, 3000, 'past skip end');
    })
    .then(function () {
      var after = rec.samples.slice(mark);
      // mpv reports the seek target itself (12.0) while seeking; no frame inside is played.
      var bad = after.filter(function (s) { return s.t > 12.001 && s.t < 15; });
      assert.strictEqual(bad.length, 0, 'played inside skip range: ' + fmt(bad));
      assert.ok(after.some(function (s) { return s.t >= 15 && s.t < 15.3; }), 'landed at the range end');
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

test('parent mode: a backward seek into a range is clamped to start - 1', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('seekback', h.standardRanges());
  var mark;
  return rec.play(getVideo(), skip, {})
    .then(function () { return rec.waitTime(17); })
    .then(function () {
      mark = rec.samples.length;
      return rec.cmd(['seek', 12, 'absolute+exact']);
    })
    .then(function () {
      return rec.waitSampleAfter(mark, function (s) { return s.t >= 15 && s.t < 16; }, 4000, 'skip end after clamp');
    })
    .then(function () {
      var after = rec.samples.slice(mark);
      assert.ok(after.some(function (s) { return s.t >= 8.9 && s.t < 9.6; }), 'landed at start - 1: ' + fmt(after));
      var bad = after.filter(function (s) { return s.t > 12.001 && s.t < 15; });
      assert.strictEqual(bad.length, 0, 'played inside: ' + fmt(bad));
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

test('kid mode: a backward seek into a hide range lands at its end', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('kidback', h.standardRanges());
  var mark;
  return rec.play(getVideo(), skip, { kidMode: true })
    .then(function () { return rec.waitTime(27); })
    .then(function () {
      assert.strictEqual(rec.eventsOf('ready')[0].kid, true);
      mark = rec.samples.length;
      return rec.cmd(['seek', 22, 'absolute+exact']);
    })
    .then(function () {
      return rec.waitSampleAfter(mark, function (s) { return s.t >= 25 && s.t < 26; }, 3000, 'hide end');
    })
    .then(function () {
      var after = rec.samples.slice(mark);
      var bad = after.filter(function (s) { return s.t > 22.001 && s.t < 25; });
      assert.strictEqual(bad.length, 0, 'played inside hide range: ' + fmt(bad));
      return h.delay(150);
    })
    .then(function () {
      assert.strictEqual(rec.state.mute, false, 'unmuted after landing');
      assert.strictEqual(rec.state.bonis.black, false, 'uncovered after landing');
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

function expectKidRefusal(skipPath) {
  var rec = h.startRecorder();
  return rec.play(getVideo(), skipPath, { kidMode: true })
    .catch(function () { /* mpv may exit before IPC connects */ })
    .then(function () { return rec.waitEvent('error', 8000, function (e) { return e.exitCode === 3; }); })
    .then(function () {
      var err = rec.eventsOf('error').filter(function (e) { return e.exitCode === 3; })[0];
      assert.strictEqual(err.code, 'kid-refused');
      assert.strictEqual(rec.eventsOf('crashed').length, 0, 'no relaunch on a deliberate refusal');
      assert.ok(rec.samples.every(function (s) { return s.t < 0.5; }), 'did not play');
      assert.strictEqual(rec.player.status().state, 'idle');
    });
}

test('kid mode with a corrupt skip file quits with exit code 3', opts, function () {
  getVideo();
  return expectKidRefusal(h.writeRaw('corrupt', '{"format": "bonis-oculis-skip", "version": 1, "ranges": [ {'));
});

test('kid mode with a missing skip file or an unscanned file quits with exit code 3', opts, function () {
  getVideo();
  return expectKidRefusal(h.uniqueName('missing') + '.bonis.json')
    .then(function () {
      return expectKidRefusal(h.writeSkip('unscanned', [], { scanStatus: 'none' }));
    })
    .then(function () {
      return expectKidRefusal(h.writeRaw('wrongformat', JSON.stringify({ format: 'other', version: 1, ranges: [] })));
    });
});

test('parent mode with a corrupt skip file warns and keeps playing', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeRaw('corrupt-parent', 'not json at all');
  return rec.play(getVideo(), skip, {})
    .then(function () { return rec.waitTime(3); })
    .then(function () {
      var err = rec.eventsOf('error')[0];
      assert.ok(err, 'error event');
      assert.strictEqual(err.code, 'skipfile');
      assert.strictEqual(rec.eventsOf('ready')[0].loaded, false);
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

test('i / o / u keys write marks to the marks file and emit mark events', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('marks', []);
  var marks = h.uniqueName('marks') + '.marks.jsonl';
  var tIn;
  var tOut;
  return rec.play(getVideo(), skip, { marksPath: marks })
    .then(function () { return rec.waitTime(3); })
    .then(function () { tIn = rec.samples[rec.samples.length - 1].t; return rec.cmd(['keypress', 'i']); })
    .then(function () { return rec.waitTime(tIn + 3); })
    .then(function () { tOut = rec.samples[rec.samples.length - 1].t; return rec.cmd(['keypress', 'o']); })
    .then(function () { return rec.waitEvent('mark', 3000); })
    .then(function () {
      var m = rec.eventsOf('mark')[0];
      assert.strictEqual(m.t, 'mark');
      var r = m.range;
      assert.ok(/^r[0-9a-z]{4,16}$/.test(r.id), 'id pattern ' + r.id);
      assert.ok(Math.abs(r.start - tIn) < 1.0, 'start ' + r.start + ' vs ' + tIn);
      assert.ok(Math.abs(r.end - tOut) < 1.0, 'end ' + r.end + ' vs ' + tOut);
      assert.ok(r.end > r.start);
      assert.strictEqual(r.category, 'other');
      assert.strictEqual(r.source, 'manual');
      assert.strictEqual(r.review, 'pending');
      assert.strictEqual(r.action, 'skip');
      assert.strictEqual(r.confidence, 1);
      var lines = h.readLines(marks);
      assert.strictEqual(lines.length, 1);
      assert.deepStrictEqual(lines[0], m);
      return rec.cmd(['keypress', 'u']);
    })
    .then(function () { return rec.waitEvent('mark', 3000, function (m) { return m.t === 'undo'; }); })
    .then(function () {
      var lines = h.readLines(marks);
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[1].t, 'undo');
      assert.strictEqual(lines[1].id, lines[0].range.id);
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

test('marking keys are disabled in kid mode', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('kidmarks', []);
  var marks = h.uniqueName('kidmarks') + '.marks.jsonl';
  return rec.play(getVideo(), skip, { kidMode: true, marksPath: marks })
    .then(function () { return rec.waitTime(2); })
    .then(function () { return rec.cmd(['keypress', 'i']); })
    .then(function () { return rec.waitTime(5); })
    .then(function () { return rec.cmd(['keypress', 'o']); })
    .then(function () { return h.delay(400); })
    .then(function () {
      assert.strictEqual(rec.eventsOf('mark').length, 0);
      assert.strictEqual(fs.existsSync(marks), false);
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

function panicRun(kidMode, endKey) {
  var rec = h.startRecorder();
  var skip = h.writeSkip('panic', []);
  var marks = h.uniqueName('panic') + '.marks.jsonl';
  var tStart;
  var tEnd;
  return rec.play(getVideo(), skip, { kidMode: kidMode, marksPath: marks })
    .then(function () { return rec.waitTime(5); })
    .then(function () { return rec.cmd(['keypress', 'p']); })
    .then(function () { return rec.waitEvent('panic', 3000); })
    .then(function () {
      tStart = rec.eventsOf('panic')[0].at;
      assert.strictEqual(rec.eventsOf('panic')[0].phase, 'start');
      return rec.waitFor(function (r) { return r.state.bonis && r.state.bonis.black && r.state.mute === true; }, 2000, 'cover');
    })
    .then(function () {
      var before = rec.samples[rec.samples.length - 1].t;
      return rec.cmd(['keypress', 'RIGHT']).then(function () {
        return rec.waitFor(function (r) {
          return r.samples.some(function (s) { return s.t >= before + 9.5 && s.t < before + 11; });
        }, 3000, 'RIGHT seeks +10');
      });
    })
    .then(function () {
      assert.ok(rec.samples.filter(function (s) { return s.t > tStart + 0.5; }).length > 0);
      tEnd = rec.samples[rec.samples.length - 1].t;
      return rec.cmd(['keypress', endKey]);
    })
    .then(function () { return rec.waitEvent('panic', 3000, function (m) { return m.phase === 'end'; }); })
    .then(function () { return h.delay(200); })
    .then(function () {
      var end = rec.eventsOf('panic').filter(function (m) { return m.phase === 'end'; })[0];
      var r = end.range;
      assert.ok(Math.abs(r.start - (tStart - 2)) < 0.01, 'start = panic start - 2: ' + r.start + ' vs ' + tStart);
      assert.ok(r.end >= tEnd - 0.2 && r.end < tEnd + 3, 'end near now: ' + r.end + ' vs ' + tEnd);
      assert.strictEqual(r.source, 'panic');
      assert.strictEqual(r.review, 'approved');
      assert.strictEqual(r.action, 'skip');
      assert.strictEqual(r.category, 'other');
      assert.strictEqual(r.confidence, 1);
      var lines = h.readLines(marks);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].t, 'panic');
      assert.deepStrictEqual(lines[0].range, r);
      assert.strictEqual(rec.state.mute, false, 'unmuted after panic');
      assert.strictEqual(rec.state.bonis.black, false, 'uncovered after panic');
      assert.strictEqual(rec.state.bonis.panic, false);
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
}

test('panic key hides and mutes, RIGHT skips ahead, Enter ends with an approved range', opts, function () {
  getVideo();
  return panicRun(false, 'ENTER');
});

test('panic works in kid mode and ends on a second press', opts, function () {
  getVideo();
  return panicRun(true, 'p');
});

test('media.offset shifts every range and marks are stored in the file timeline', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('offset', [h.range('roffset01', 10, 15, 'skip')], { offset: 5 });
  var marks = h.uniqueName('offset') + '.marks.jsonl';
  var tIn;
  return rec.play(getVideo(), skip, { marksPath: marks })
    .then(function () { return rec.waitTime(7); })
    .then(function () { tIn = rec.samples[rec.samples.length - 1].t; return rec.cmd(['keypress', 'i']); })
    .then(function () { return rec.waitTime(10); })
    .then(function () { return rec.cmd(['keypress', 'o']); })
    .then(function () { return rec.waitTime(22, 5000); })
    .then(function () {
      assert.ok(rec.between(11, 14).length > 10, 'original range time plays');
      assertNone(rec, 15.1, 20, 'shifted skip range');
      var m = rec.eventsOf('mark')[0];
      assert.ok(m, 'mark event');
      assert.ok(Math.abs(m.range.start + 5 - tIn) < 1.0, 'mark start stored without offset: ' + m.range.start);
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

test('reload and set-kidmode messages take effect during playback', opts, function () {
  var rec = h.startRecorder();
  var first = h.writeSkip('reload-a', []);
  var second = h.writeSkip('reload-b', [h.range('rreload01', 20, 25, 'skip')]);
  var marks = h.uniqueName('reload') + '.marks.jsonl';
  return rec.play(getVideo(), first, { marksPath: marks })
    .then(function () { return rec.waitTime(3); })
    .then(function () { return rec.cmd(['script-message-to', 'bonis', 'reload', second]); })
    .then(function () { return rec.waitEvent('ready', 3000, function (m) { return m.enforced === 1; }); })
    .then(function () { return rec.cmd(['script-message-to', 'bonis', 'set-kidmode', '1']); })
    .then(function () { return rec.cmd(['keypress', 'i']); })
    .then(function () { return rec.waitTime(27, 5000); })
    .then(function () {
      assertNone(rec, 20.1, 25, 'reloaded skip range');
      assert.strictEqual(rec.eventsOf('mark').length, 0, 'kid mode disabled marking');
      assert.strictEqual(rec.state.bonis.kid, true);
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});

test('resuming inside a hide range is covered from the first frame and restored at its end', opts, function () {
  var rec = h.startRecorder();
  var skip = h.writeSkip('resume', h.standardRanges());
  return rec.play(getVideo(), skip, { resumeAt: 21 })
    .then(function () { return rec.waitTime(27); })
    .then(function () {
      assert.ok(rec.samples[0].t >= 20.9 && rec.samples[0].t < 21.5, 'resumed at 21: ' + rec.samples[0].t);
      assertAll(rec, 0, 24.7, function (s) { return s.black && s.mute === true; }, 'covered on resume');
      assertAll(rec, 25.3, 27, function (s) { return !s.black && s.mute === false; }, 'restored');
    })
    .then(rec.stop, function (err) { return rec.stop().then(function () { throw err; }); });
});
