'use strict';
/* Enforcement engine with a fake clock, a fake video and a fake overlay.
 * Key property: after a range (or panic) ends, the video is never left
 * covered or muted, and the user's own mute choice is restored. */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function load() {
  var g = {};
  g.self = g;
  vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'content', 'enforcer.js'), 'utf8'), g);
  return g.BO.enforcer;
}

/* A video whose time advances with the fake clock; seeks may be refused. */
function harness(opts) {
  var o = opts || {};
  var clock = { now: 0, timers: [], seq: 0 };
  var video = { currentTime: o.start || 0, muted: !!o.muted, paused: false, playbackRate: 1 };
  var overlay = { shown: null, show: function (k) { this.shown = k; }, hide: function () { this.shown = null; } };
  var events = [];
  var adapter = {
    video: video,
    blockSeeks: !!o.blockSeeks,
    ad: false,
    currentTime: function () { return video.currentTime; },
    seekTo: function (s) { if (!this.blockSeeks) { video.currentTime = s; } },
    onTimeUpdate: function () { return function () {}; },
    isAdPlaying: function () { return this.ad; }
  };
  function addTimer(fn, ms, repeat) {
    var id = ++clock.seq;
    clock.timers.push({ id: id, at: clock.now + ms, fn: fn, every: repeat ? ms : 0 });
    return id;
  }
  function clearTimer(id) { clock.timers = clock.timers.filter(function (t) { return t.id !== id; }); }
  var E = load().create({
    adapter: adapter,
    overlay: overlay,
    now: function () { return clock.now; },
    setInterval: function (f, ms) { return addTimer(f, ms, true); },
    clearInterval: clearTimer,
    setTimeout: function (f, ms) { return addTimer(f, ms, false); },
    clearTimeout: clearTimer,
    onEvent: function (n, d) { events.push([n, d]); }
  });
  /* advance wall clock by ms in 10 ms steps; video plays when not paused */
  function advance(ms, observe) {
    var end = clock.now + ms, due, i, t;
    while (clock.now < end) {
      clock.now += 10;
      if (!video.paused) { video.currentTime = Math.round((video.currentTime + 0.01 * video.playbackRate) * 1000) / 1000; }
      due = clock.timers.filter(function (x) { return x.at <= clock.now; });
      for (i = 0; i < due.length; i++) {
        t = due[i];
        if (t.every) { t.at += t.every; } else { clearTimer(t.id); }
        t.fn();
      }
      if (observe) { observe(video.currentTime, overlay.shown, video.muted); }
    }
  }
  return { E: E, video: video, overlay: overlay, adapter: adapter, advance: advance, events: events, clock: clock };
}

test('skip: jumps to the range end, covers during the jump, restores after', function () {
  var h = harness({ start: 7.5 }), seen = [];
  h.E.setRanges([{ id: 'a', start: 8, end: 13, action: 'skip', category: 'sex' }]);
  h.E.attach();
  h.advance(2000, function (t, shown, muted) { seen.push([t, shown, muted]); });
  assert.ok(h.video.currentTime > 13 && h.video.currentTime < 15, String(h.video.currentTime));
  seen.forEach(function (s) { assert.ok(!(s[0] >= 8.1 && s[0] < 13), 'never plays inside the range: ' + s[0]); });
  assert.strictEqual(h.overlay.shown, null);
  assert.strictEqual(h.video.muted, false);
  assert.ok(h.events.some(function (e) { return e[0] === 'skipped'; }));
});

test('skip refused by the site: black-out + mute until the end, restored exactly at the end', function () {
  var h = harness({ start: 42, blockSeeks: true }), at;
  h.E.setRanges([{ id: 'k', start: 43, end: 48, action: 'skip', category: 'kissing' }]);
  h.E.attach();
  h.advance(1100);
  assert.strictEqual(h.overlay.shown, 'scene');
  assert.strictEqual(h.video.muted, true);
  h.advance(600);
  assert.ok(h.events.some(function (e) { return e[0] === 'blocked'; }));
  h.advance(5000, function (t, shown, muted) {
    if (t >= 47.5 && t < 47.99) { assert.strictEqual(shown, 'scene', 'still covered at ' + t); assert.strictEqual(muted, true); }
    if (at === undefined && shown === null) { at = t; }
  });
  assert.ok(at >= 48 && at <= 48.03, 'restored at ' + at);
  assert.strictEqual(h.video.muted, false);
  assert.strictEqual(h.overlay.shown, null);
});

test('site sends the time back before the range: never loops, covers when the range plays', function () {
  var h = harness({ start: 42.9 }), seeks = 0;
  h.adapter.seekTo = function () { seeks++; h.video.currentTime = 42.9; };
  h.E.setRanges([{ id: 'k', start: 43, end: 48, action: 'skip', category: 'kissing' }]);
  h.E.attach();
  h.advance(6000, function (t, shown) { if (t >= 43 && t < 48) { assert.strictEqual(shown, 'scene', 'covered at ' + t); } });
  assert.ok(seeks <= 2, 'tried ' + seeks + ' times');
  assert.strictEqual(h.overlay.shown, null);
  assert.strictEqual(h.video.muted, false);
});

test('mute: only muted inside, user mute state restored after', function () {
  var h = harness({ start: 29 }), sawMuted = false;
  h.E.setRanges([{ id: 'm', start: 29.5, end: 32.5, action: 'mute', category: 'language' }]);
  h.E.attach();
  h.advance(4000, function (t, shown, muted) {
    assert.strictEqual(shown, null);
    if (t >= 29.6 && t < 32.4) { assert.strictEqual(muted, true, 'muted at ' + t); sawMuted = true; }
    if (t >= 32.55) { assert.strictEqual(muted, false, 'unmuted at ' + t); }
  });
  assert.ok(sawMuted);
  h = harness({ start: 29, muted: true });
  h.E.setRanges([{ id: 'm', start: 29.5, end: 32.5, action: 'mute', category: 'language' }]);
  h.E.attach();
  h.advance(4000);
  assert.strictEqual(h.video.muted, true, 'a video the user had muted stays muted');
});

test('mute: user unmuting inside a range is undone', function () {
  var h = harness({ start: 30 });
  h.E.setRanges([{ id: 'm', start: 29.5, end: 32.5, action: 'mute' }]);
  h.E.attach();
  h.video.muted = false;
  h.advance(150);
  assert.strictEqual(h.video.muted, true);
});

test('hide and blur become black-out + mute; strongest action wins on overlap', function () {
  var h = harness({ start: 10 });
  h.E.setRanges([{ id: 'h', start: 9, end: 12, action: 'blur' }, { id: 'm', start: 8, end: 20, action: 'mute' }]);
  h.E.attach();
  assert.strictEqual(h.overlay.shown, 'scene');
  assert.strictEqual(h.video.muted, true);
  h.advance(2500);
  assert.strictEqual(h.overlay.shown, null);
  assert.strictEqual(h.video.muted, true);
  h.advance(8000);
  assert.strictEqual(h.video.muted, false);
});

test('range edges: active from start - 0.05, inactive at end', function () {
  var h = harness({ start: 7.96, blockSeeks: true });
  h.video.paused = true;
  h.E.setRanges([{ id: 'a', start: 8, end: 9, action: 'hide' }]);
  h.E.attach();
  assert.strictEqual(h.overlay.shown, 'scene');
  h.video.currentTime = 9;
  h.E.tick();
  assert.strictEqual(h.overlay.shown, null);
  h.video.currentTime = 7.9;
  h.E.tick();
  assert.strictEqual(h.overlay.shown, null);
});

test('panic: covers and mutes at once, second press restores and returns the range', function () {
  var h = harness({ start: 20 }), r;
  h.E.setRanges([]);
  h.E.attach();
  assert.strictEqual(JSON.stringify(h.E.togglePanic()), '{"on":true}');
  assert.strictEqual(h.overlay.shown, 'panic');
  assert.strictEqual(h.video.muted, true);
  h.advance(3000);
  assert.strictEqual(h.overlay.shown, 'panic');
  r = h.E.togglePanic();
  assert.strictEqual(r.on, false);
  assert.strictEqual(r.range.start, 18);
  assert.ok(Math.abs(r.range.end - 23) < 0.02);
  assert.strictEqual(h.overlay.shown, null);
  assert.strictEqual(h.video.muted, false);
});

test('panic inside a mute range: release keeps the range muted, then restores', function () {
  var h = harness({ start: 30 });
  h.E.setRanges([{ id: 'm', start: 29.5, end: 32.5, action: 'mute' }]);
  h.E.attach();
  h.E.togglePanic();
  h.advance(500);
  h.E.togglePanic();
  assert.strictEqual(h.overlay.shown, null);
  assert.strictEqual(h.video.muted, true);
  h.advance(3000);
  assert.strictEqual(h.video.muted, false);
});

test('ads: ranges are not applied while an ad plays', function () {
  var h = harness({ start: 10 });
  h.adapter.ad = true;
  h.E.setRanges([{ id: 'a', start: 9, end: 12, action: 'hide' }]);
  h.E.attach();
  assert.strictEqual(h.overlay.shown, null);
  h.adapter.ad = false;
  h.E.tick();
  assert.strictEqual(h.overlay.shown, 'scene');
});

test('detach restores everything', function () {
  var h = harness({ start: 10 });
  h.E.setRanges([{ id: 'a', start: 9, end: 12, action: 'hide' }]);
  h.E.attach();
  h.E.detach();
  assert.strictEqual(h.overlay.shown, null);
  assert.strictEqual(h.video.muted, false);
});

test('fuzz: random ranges, seeks and panics never leave the video covered or muted outside ranges', function () {
  var seed = 12345, run, h, ranges, i, s, len, actions = ['skip', 'hide', 'mute', 'blur'], panic;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  /* after a jump the cover stays until the next tick or 'seeked' (fail closed): allow 0.2 s */
  function inside(t) { return ranges.some(function (r) { return t >= r.start - 0.05 && t < r.end + 0.2; }); }
  for (run = 0; run < 40; run++) {
    h = harness({ start: rnd() * 5, blockSeeks: rnd() < 0.5, muted: rnd() < 0.2 });
    ranges = [];
    for (i = 0; i < 6; i++) {
      s = Math.round(rnd() * 100) / 2;
      len = 0.5 + Math.round(rnd() * 12) / 2;
      ranges.push({ id: 'r' + i, start: s, end: s + len, action: actions[Math.floor(rnd() * actions.length)] });
    }
    h.E.setRanges(ranges);
    h.E.attach();
    panic = false;
    for (i = 0; i < 30; i++) {
      if (rnd() < 0.15) { h.video.currentTime = Math.round(rnd() * 600) / 10; h.E.tick(); }
      if (rnd() < 0.08) { h.E.togglePanic(); panic = !panic; }
      h.advance(Math.floor(rnd() * 1500) + 10, function (t, shown, muted) {
        if (!panic && !inside(t) && t > 0.2) {
          assert.strictEqual(shown, null, 'run ' + run + ': covered outside ranges at ' + t);
        }
      });
    }
    if (panic) { h.E.togglePanic(); }
    h.video.currentTime = 80;
    h.E.tick();
    assert.strictEqual(h.overlay.shown, null, 'run ' + run);
    assert.strictEqual(h.E.state().mutedByUs, false, 'run ' + run);
  }
});
